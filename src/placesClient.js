/**
 * @module placesClient
 * Thin client for the Google Places API (New) Text Search endpoint with
 * disk caching, pagination, retry with exponential backoff and a hard
 * cap on the number of HTTP requests.
 */

import { setTimeout as delay } from "node:timers/promises";

/** Error returned by the API (or the network) after retries are exhausted. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, fatal?: boolean}} [details] `fatal` means no
   *   other request can succeed either (bad key, API disabled, billing).
   */
  constructor(message, { status, fatal = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.fatal = fatal;
  }
}

/** Thrown when a request would exceed the --max-calls budget. */
export class MaxCallsError extends Error {
  /** @param {number} maxCalls */
  constructor(maxCalls) {
    super(`--max-calls limit of ${maxCalls} reached`);
    this.name = "MaxCallsError";
  }
}

/**
 * Backoff before retry number `attempt` (0-based): full jitter over an
 * exponentially growing window.
 * @param {number} attempt
 * @param {number} baseMs
 * @param {number} maxMs
 * @param {() => number} [random]
 * @returns {number} Milliseconds to sleep.
 */
export function backoffDelay(attempt, baseMs, maxMs, random = Math.random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Pull a readable message out of a Google API error body.
 * @param {string} text Raw response body.
 * @returns {string}
 */
function errorMessage(text) {
  try {
    return JSON.parse(text).error?.message ?? text;
  } catch {
    return text;
  }
}

/**
 * @typedef {object} PlaceHit
 * @property {object} place Raw place object from the API.
 * @property {string} fetchedAt ISO timestamp of the API call that returned it.
 */

/**
 * @typedef {object} ClientStats
 * @property {number} apiCalls HTTP requests sent (including retries).
 * @property {number} cacheHits Pages served from disk.
 * @property {number} retries Requests repeated after 429/5xx/network errors.
 */

/**
 * Create a Text Search client.
 * @param {object} options
 * @param {string} options.apiKey
 * @param {import("./config.js").ApiConfig} options.api
 * @param {import("./cache.js").Cache} options.cache
 * @param {number} [options.maxCalls] Hard stop on HTTP requests.
 * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
 * @param {(ms: number) => Promise<unknown>} [options.sleep] Injectable for tests.
 * @returns {{searchText: (textQuery: string) => Promise<PlaceHit[]>, stats: ClientStats}}
 */
export function createPlacesClient({
  apiKey,
  api,
  cache,
  maxCalls = Infinity,
  fetchImpl = fetch,
  sleep = delay,
}) {
  /** @type {ClientStats} */
  const stats = { apiCalls: 0, cacheHits: 0, retries: 0 };

  const headers = {
    "Content-Type": "application/json",
    "X-Goog-Api-Key": apiKey,
    "X-Goog-FieldMask": api.fieldMask.join(","),
  };

  /**
   * POST one request, retrying on 429/5xx/network errors.
   * @param {object} body
   * @returns {Promise<object>} Parsed response body.
   */
  async function request(body) {
    for (let attempt = 0; ; attempt++) {
      if (stats.apiCalls >= maxCalls) throw new MaxCallsError(maxCalls);
      stats.apiCalls++;

      let res;
      try {
        res = await fetchImpl(api.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(api.timeoutMs),
        });
      } catch (err) {
        if (attempt >= api.maxRetries) {
          throw new ApiError(`Network error: ${err.message}`);
        }
        stats.retries++;
        await sleep(backoffDelay(attempt, api.backoffBaseMs, api.backoffMaxMs));
        continue;
      }

      if (res.ok) return res.json();

      const message = errorMessage(await res.text());
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < api.maxRetries) {
        stats.retries++;
        await sleep(backoffDelay(attempt, api.backoffBaseMs, api.backoffMaxMs));
        continue;
      }
      // An invalid key comes back as 400, a disabled API or billing as 403.
      const fatal =
        res.status === 401 || res.status === 403 || /API key not valid/i.test(message);
      throw new ApiError(`Places API ${res.status}: ${message}`, {
        status: res.status,
        fatal,
      });
    }
  }

  /**
   * Fetch one page, from cache when present.
   * @param {string} textQuery
   * @param {string | null} pageToken
   * @param {{refresh?: boolean}} [options] `refresh` bypasses the cache read.
   * @returns {Promise<import("./cache.js").CacheEntry & {fromCache: boolean}>}
   */
  async function fetchPage(textQuery, pageToken, { refresh = false } = {}) {
    const key = cache.key(textQuery, pageToken);
    if (!refresh) {
      const hit = await cache.get(key);
      if (hit) {
        stats.cacheHits++;
        return { ...hit, fromCache: true };
      }
    }

    if (pageToken) await sleep(api.pageDelayMs);
    const body = {
      textQuery,
      regionCode: api.regionCode,
      languageCode: api.languageCode,
      pageSize: api.pageSize,
    };
    if (pageToken) body.pageToken = pageToken;

    const response = await request(body);
    const entry = {
      textQuery,
      pageToken,
      fetchedAt: new Date().toISOString(),
      response,
    };
    await cache.set(key, entry);
    return { ...entry, fromCache: false };
  }

  /**
   * Run a text query and follow nextPageToken up to `api.maxPages` pages.
   * @param {string} textQuery
   * @returns {Promise<PlaceHit[]>}
   */
  async function searchText(textQuery) {
    let refreshFirstPage = false;
    for (;;) {
      /** @type {PlaceHit[]} */
      const hits = [];
      let pageToken = null;
      let firstPageFromCache = false;
      let restart = false;

      for (let page = 0; page < api.maxPages; page++) {
        let entry;
        try {
          entry = await fetchPage(textQuery, pageToken, {
            refresh: refreshFirstPage && page === 0,
          });
        } catch (err) {
          // A cached first page carries a page token that has since expired
          // (e.g. an earlier run stopped at --max-calls). Refetch page one
          // once to get a live token.
          const staleToken =
            err instanceof ApiError &&
            err.status === 400 &&
            !err.fatal &&
            page > 0 &&
            firstPageFromCache &&
            !refreshFirstPage;
          if (!staleToken) throw err;
          refreshFirstPage = true;
          restart = true;
          break;
        }
        if (page === 0) firstPageFromCache = entry.fromCache;

        for (const place of entry.response.places ?? []) {
          hits.push({ place, fetchedAt: entry.fetchedAt });
        }
        pageToken = entry.response.nextPageToken ?? null;
        if (!pageToken) break;
      }

      if (!restart) return hits;
    }
  }

  return { searchText, stats };
}
