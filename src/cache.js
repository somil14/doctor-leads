/**
 * @module cache
 * Disk cache of raw Places API responses, one JSON file per request,
 * keyed by sha1(query + pageToken).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";

/**
 * @typedef {object} CacheEntry
 * @property {string} textQuery
 * @property {string | null} pageToken
 * @property {string} fetchedAt ISO timestamp of the original API call.
 * @property {object} response Raw API response body.
 */

/**
 * @typedef {object} Cache
 * @property {(textQuery: string, pageToken?: string | null) => string} key
 * @property {(key: string) => Promise<boolean>} has
 * @property {(key: string) => Promise<CacheEntry | null>} get
 * @property {(key: string, entry: CacheEntry) => Promise<void>} set
 */

/**
 * Cache key for a request.
 * @param {string} textQuery
 * @param {string | null} [pageToken]
 * @returns {string} sha1 hex digest.
 */
export function cacheKey(textQuery, pageToken = null) {
  return createHash("sha1")
    .update(textQuery + (pageToken ?? ""))
    .digest("hex");
}

/**
 * Create a cache rooted at `dir`. The directory is created on first write.
 * @param {string} dir
 * @returns {Cache}
 */
export function createCache(dir) {
  const fileFor = (key) => path.join(dir, `${key}.json`);

  return {
    key: cacheKey,

    async has(key) {
      try {
        await access(fileFor(key));
        return true;
      } catch {
        return false;
      }
    },

    async get(key) {
      try {
        return JSON.parse(await readFile(fileFor(key), "utf8"));
      } catch (err) {
        // Missing or corrupt entries are treated as a miss and refetched.
        if (err.code === "ENOENT" || err instanceof SyntaxError) return null;
        throw err;
      }
    },

    async set(key, entry) {
      await mkdir(dir, { recursive: true });
      await writeFile(fileFor(key), JSON.stringify(entry, null, 2));
    },
  };
}
