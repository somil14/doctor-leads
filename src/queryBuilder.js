/**
 * @module queryBuilder
 * Builds the towns × terms query matrix and resolves CLI subset selections.
 */

import { ConfigError } from "./config.js";

/**
 * @typedef {object} Query
 * @property {string} term Search term, e.g. "pediatrician".
 * @property {string} town Town searched, e.g. "Saharsa".
 * @property {string} textQuery Text sent to the API: "<term> in <town>, <state>".
 */

/**
 * Build one query per town × term combination.
 * @param {{towns: string[], terms: string[], state: string}} input
 * @returns {Query[]}
 */
export function buildQueries({ towns, terms, state }) {
  const queries = [];
  for (const town of towns) {
    for (const term of terms) {
      queries.push({ term, town, textQuery: `${term} in ${town}, ${state}` });
    }
  }
  return queries;
}

/**
 * Upper bound on API calls for a set of queries (every query paging fully).
 * @param {number} queryCount
 * @param {number} maxPages
 * @returns {number}
 */
export function estimateMaxCalls(queryCount, maxPages) {
  return queryCount * maxPages;
}

/**
 * Resolve a comma-separated CLI value against the configured list,
 * case-insensitively. Returns the full list when no value was given.
 * @param {string | undefined} raw Value of --towns / --terms.
 * @param {string[]} allowed Values from config.
 * @param {string} flag Flag name used in error messages.
 * @returns {string[]} Selected values, spelled as in config.
 * @throws {ConfigError} when a value is not in the configured list.
 */
export function selectSubset(raw, allowed, flag) {
  if (raw === undefined) return allowed;
  const wanted = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) {
    throw new ConfigError(`${flag} needs at least one value (comma-separated)`);
  }
  const byLower = new Map(allowed.map((a) => [a.toLowerCase(), a]));
  const selected = [];
  const unknown = [];
  for (const item of wanted) {
    const match = byLower.get(item.toLowerCase());
    if (!match) unknown.push(item);
    else if (!selected.includes(match)) selected.push(match);
  }
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown value(s) for ${flag}: ${unknown.join(", ")}\n  Allowed: ${allowed.join(", ")}`
    );
  }
  return selected;
}
