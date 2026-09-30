/**
 * @module enrich/siteFetcher
 * Polite fetcher for a practice's own website: obeys robots.txt, fetches a
 * handful of pages per site, pauses between pages and caches every
 * response on disk. Shared platforms (Facebook, booking portals,
 * directories) are never fetched.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contactLinks } from "./contactExtractor.js";

/**
 * Host of a URL without "www.", or null when the URL is unusable.
 * @param {string} url
 * @returns {string | null}
 */
export function hostOf(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Whether a website link points at the practice's own site (fetchable) or
 * at a shared platform (skipped).
 * @param {string} url
 * @param {string[]} skipHosts
 * @returns {"own" | "platform" | "none"}
 */
export function siteKind(url, skipHosts) {
  const host = hostOf(url ?? "");
  if (!host) return "none";
  const shared = skipHosts.some((skip) => host === skip || host.endsWith(`.${skip}`));
  return shared ? "platform" : "own";
}

/**
 * Whether robots.txt lets a user agent fetch a path. Uses the rules for
 * the named agent when present, otherwise those for "*"; the longest
 * matching rule wins and Allow wins a tie.
 * @param {string} robotsTxt
 * @param {string} pathname
 * @param {string} agent Product token, e.g. "doctor-leads".
 * @returns {boolean}
 */
export function robotsAllows(robotsTxt, pathname, agent) {
  /** @type {Map<string, Array<{allow: boolean, path: string}>>} */
  const groups = new Map();
  let current = [];
  let lastWasAgent = false;
  for (const rawLine of String(robotsTxt ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!lastWasAgent) current = [];
      current.push(value.toLowerCase());
      for (const name of current) if (!groups.has(name)) groups.set(name, []);
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      for (const name of current) groups.get(name).push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const rules = groups.get(agent.toLowerCase()) ?? groups.get("*") ?? [];
  let verdict = true;
  let longest = -1;
  for (const rule of rules) {
    if (rule.path === "") continue;
    const pattern = new RegExp(
      "^" +
        rule.path
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\\\$$/, "$")
    );
    if (!pattern.test(pathname)) continue;
    if (rule.path.length > longest || (rule.path.length === longest && rule.allow)) {
      longest = rule.path.length;
      verdict = rule.allow;
    }
  }
  return verdict;
}

/**
 * @typedef {object} SitePage
 * @property {string} url
 * @property {number} status HTTP status, or 0 when the request failed.
 * @property {string} html Empty unless the page is 200 text/html.
 * @property {string} fetchedAt ISO timestamp.
 * @property {string} [error]
 */

/**
 * @typedef {object} SiteStats
 * @property {number} requests HTTP requests sent.
 * @property {number} cacheHits Pages served from disk.
 * @property {number} blocked Pages skipped because of robots.txt.
 * @property {number} failed Requests that errored or returned non-200.
 */

/**
 * Create a site fetcher.
 * @param {object} options
 * @param {import("../config.js").SitesConfig} options.sites
 * @param {string} options.cacheDir Directory for cached pages.
 * @param {typeof fetch} [options.fetchImpl] Injectable for tests.
 * @param {(ms: number) => Promise<unknown>} [options.sleep] Injectable for tests.
 * @returns {{fetchSite: (startUrl: string) => Promise<SitePage[]>, stats: SiteStats}}
 */
export function createSiteFetcher({ sites, cacheDir, fetchImpl = fetch, sleep = delay }) {
  /** @type {SiteStats} */
  const stats = { requests: 0, cacheHits: 0, blocked: 0, failed: 0 };
  const agentToken = sites.userAgent.split(/[/\s]/)[0];
  const fileFor = (url) =>
    path.join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`);

  /**
   * GET one URL, from cache when present. Failures are cached too, so a
   * dead site is not retried on every run.
   * @param {string} url
   * @param {{accept?: string, optional?: boolean}} [options] `optional`
   *   pages (robots.txt) are not counted as failures when missing.
   * @returns {Promise<SitePage & {fromCache: boolean}>}
   */
  async function get(url, { accept = "text/html", optional = false } = {}) {
    try {
      const cached = JSON.parse(await readFile(fileFor(url), "utf8"));
      stats.cacheHits++;
      return { ...cached, fromCache: true };
    } catch {
      // not cached
    }

    /** @type {SitePage} */
    const page = { url, status: 0, html: "", fetchedAt: new Date().toISOString() };
    stats.requests++;
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": sites.userAgent, Accept: `${accept},*/*;q=0.5` },
        redirect: "follow",
        signal: AbortSignal.timeout(sites.timeoutMs),
      });
      page.status = res.status;
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && /text\/|html|xml/i.test(type)) {
        page.html = (await res.text()).slice(0, sites.maxBytes);
      }
    } catch (err) {
      page.error = err.message;
    }
    if (page.status !== 200 && !optional) stats.failed++;

    await mkdir(cacheDir, { recursive: true });
    await writeFile(fileFor(url), JSON.stringify(page));
    return { ...page, fromCache: false };
  }

  /**
   * Fetch a practice website: the listed page plus a few same-site
   * contact/about pages it links to.
   * @param {string} startUrl
   * @returns {Promise<SitePage[]>} Pages that returned HTML; empty when the
   *   site is unreachable or disallows fetching.
   */
  async function fetchSite(startUrl) {
    let origin;
    try {
      origin = new URL(startUrl).origin;
    } catch {
      return [];
    }

    const robots = await get(`${origin}/robots.txt`, { accept: "text/plain", optional: true });
    // A server error on robots.txt means "do not fetch" by convention.
    if (robots.status >= 500) return [];
    // A missing robots.txt means no restrictions; HTML served in its place
    // (soft 404) is not a robots file.
    const robotsTxt = robots.status === 200 && !/<html/i.test(robots.html) ? robots.html : "";
    const allowed = (url) => robotsAllows(robotsTxt, new URL(url).pathname, agentToken);

    const pages = [];
    const queue = [startUrl];
    const seen = new Set();
    let lastWasLive = !robots.fromCache;

    while (queue.length > 0 && seen.size < sites.maxPagesPerSite) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      if (!allowed(url)) {
        stats.blocked++;
        continue;
      }
      if (lastWasLive) await sleep(sites.delayMs);
      const page = await get(url);
      lastWasLive = !page.fromCache;
      if (page.status !== 200 || !page.html) continue;
      pages.push(page);
      if (pages.length === 1) {
        queue.push(...contactLinks(page.html, url, sites.maxPagesPerSite - 1));
      }
    }
    return pages;
  }

  return { fetchSite, stats };
}
