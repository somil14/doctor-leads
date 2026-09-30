/**
 * @module config
 * Default configuration for doctor-leads, optional local overrides, and
 * startup validation of the configuration and the process environment.
 */

import { readFileSync } from "node:fs";

/** Optional local overrides, read from the directory the tool is run in. */
export const LOCAL_CONFIG_FILE = "./config.local.json";

/**
 * @typedef {object} ApiConfig
 * @property {string} endpoint Places API (New) Text Search URL.
 * @property {string[]} fieldMask Fields requested via X-Goog-FieldMask.
 * @property {string} regionCode
 * @property {string} languageCode
 * @property {number} pageSize Results per page (max 20).
 * @property {number} maxPages Pages followed per query (max 3).
 * @property {number} concurrency Queries in flight at once.
 * @property {number} pageDelayMs Pause before requesting a follow-up page.
 * @property {number} maxRetries Retries on 429/5xx/network errors.
 * @property {number} backoffBaseMs First backoff ceiling; doubles per retry.
 * @property {number} backoffMaxMs Upper bound for a single backoff sleep.
 * @property {number} timeoutMs Per-request timeout.
 */

/**
 * @typedef {object} SitesConfig
 * @property {string} userAgent Sent with every website request.
 * @property {number} maxPagesPerSite Pages fetched per practice website.
 * @property {number} concurrency Websites fetched at once.
 * @property {number} delayMs Pause between pages of the same website.
 * @property {number} timeoutMs Per-request timeout.
 * @property {number} maxBytes HTML kept per page.
 * @property {string[]} skipHosts Hosts that are never fetched.
 */

/**
 * @typedef {object} Config
 * @property {string[]} towns
 * @property {string} state
 * @property {string[]} searchTerms
 * @property {string[]} allowedDistricts Post-filter applied to the address.
 * @property {Record<string, string[]>} townAliases Alternate spellings per town.
 * @property {string[]} allowedPinPrefixes PIN prefixes accepted with a town match.
 * @property {string} cacheDir
 * @property {string} outputDir
 * @property {string} verifiedFile CSV of manually verified contact details.
 * @property {SitesConfig} sites
 * @property {ApiConfig} api
 */

/** @type {Config} */
export const config = {
  towns: ["Koramangala", "Indiranagar", "Jayanagar", "Whitefield", "Malleshwaram"],
  state: "Karnataka",
  searchTerms: [
    "doctor",
    "clinic",
    "hospital",
    "nursing home",
    "physician",
    "MBBS doctor",
    "general physician",
    "pediatrician",
    "gynecologist",
    "orthopedic doctor",
    "ENT doctor",
    "dermatologist",
    "diabetologist",
    "cardiologist",
    "chest physician",
  ],
  allowedDistricts: ["Bengaluru", "Bangalore"],
  // Spellings Google uses in addresses for the towns above.
  townAliases: {
    Malleshwaram: ["Malleswaram"],
  },
  // An address with no district name still passes when it names a listed
  // town and its PIN starts with one of these (560 = Bengaluru). Keeps out
  // same-named places elsewhere.
  allowedPinPrefixes: ["560"],
  cacheDir: "./cache",
  outputDir: "./output",
  verifiedFile: "./data/verified.csv",
  sites: {
    userAgent: "doctor-leads/1.0 (contact-page lookup; respects robots.txt)",
    maxPagesPerSite: 4,
    concurrency: 3,
    delayMs: 1000,
    timeoutMs: 10000,
    maxBytes: 1000000,
    // Shared platforms and directories: never fetched, and a link to one
    // is not evidence about the practice's own contact details.
    skipHosts: [
      "facebook.com",
      "instagram.com",
      "youtube.com",
      "youtu.be",
      "twitter.com",
      "x.com",
      "linkedin.com",
      "wa.me",
      "whatsapp.com",
      "google.com",
      "goo.gl",
      "g.page",
      "linktr.ee",
      "eka.care",
      "healthplix.com",
      "practo.com",
      "justdial.com",
      "lybrate.com",
      "sulekha.com",
      "indiamart.com",
    ],
  },
  api: {
    endpoint: "https://places.googleapis.com/v1/places:searchText",
    fieldMask: [
      "places.id",
      "places.displayName",
      "places.formattedAddress",
      "places.nationalPhoneNumber",
      "places.internationalPhoneNumber",
      "places.websiteUri",
      "places.rating",
      "places.userRatingCount",
      "places.types",
      "places.primaryType",
      "places.location",
      "places.businessStatus",
      "places.googleMapsUri",
      "nextPageToken",
    ],
    regionCode: "IN",
    languageCode: "en",
    pageSize: 20,
    maxPages: 3,
    concurrency: 2,
    pageDelayMs: 1000,
    maxRetries: 5,
    backoffBaseMs: 1000,
    backoffMaxMs: 30000,
    timeoutMs: 30000,
  },
};

/** Thrown for any invalid configuration, environment or CLI input. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && v.trim() !== "")
  );
}

/**
 * Validate a config object. Collects every problem and reports them together.
 * @param {Config} cfg
 * @throws {ConfigError} listing each invalid setting.
 */
export function validateConfig(cfg) {
  const problems = [];
  for (const key of ["towns", "searchTerms", "allowedDistricts"]) {
    if (!isNonEmptyStringArray(cfg[key])) {
      problems.push(`config.${key} must be a non-empty array of non-empty strings`);
    }
  }
  if (typeof cfg.state !== "string" || cfg.state.trim() === "") {
    problems.push("config.state must be a non-empty string");
  }
  if (!isNonEmptyStringArray(cfg.allowedPinPrefixes)) {
    problems.push("config.allowedPinPrefixes must be a non-empty array of PIN prefixes");
  }
  for (const [town, aliases] of Object.entries(cfg.townAliases ?? {})) {
    if (!cfg.towns?.includes(town)) {
      problems.push(`config.townAliases has "${town}", which is not in config.towns`);
    }
    if (!isNonEmptyStringArray(aliases)) {
      problems.push(`config.townAliases["${town}"] must be a non-empty array of strings`);
    }
  }
  const sites = cfg.sites ?? {};
  if (typeof sites.userAgent !== "string" || sites.userAgent.trim() === "") {
    problems.push("config.sites.userAgent must be a non-empty string");
  }
  if (!Array.isArray(sites.skipHosts)) {
    problems.push("config.sites.skipHosts must be an array of host names");
  }
  for (const key of ["maxPagesPerSite", "concurrency", "delayMs", "timeoutMs", "maxBytes"]) {
    if (!Number.isInteger(sites[key]) || sites[key] < 0) {
      problems.push(`config.sites.${key} must be a non-negative integer`);
    }
  }
  for (const key of ["cacheDir", "outputDir", "verifiedFile"]) {
    if (typeof cfg[key] !== "string" || cfg[key].trim() === "") {
      problems.push(`config.${key} must be a non-empty path string`);
    }
  }

  const api = cfg.api ?? {};
  if (typeof api.endpoint !== "string" || !api.endpoint.startsWith("https://")) {
    problems.push("config.api.endpoint must be an https URL");
  }
  if (!isNonEmptyStringArray(api.fieldMask)) {
    problems.push("config.api.fieldMask must be a non-empty array of field names");
  }
  const ranges = {
    pageSize: [1, 20],
    maxPages: [1, 3],
    concurrency: [1, 10],
    pageDelayMs: [0, 60000],
    maxRetries: [0, 10],
    backoffBaseMs: [1, 60000],
    backoffMaxMs: [1, 300000],
    timeoutMs: [1000, 300000],
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = api[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`config.api.${key} must be an integer between ${min} and ${max}`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
}

/** Settings a local config file may override. */
const OVERRIDABLE = [
  "towns",
  "state",
  "searchTerms",
  "allowedDistricts",
  "townAliases",
  "allowedPinPrefixes",
  "cacheDir",
  "outputDir",
  "verifiedFile",
  "api",
  "sites",
];

/**
 * Merge local overrides into a base config. `api` and `sites` are merged
 * key by key; every other setting is replaced whole.
 * @param {Config} base
 * @param {object} overrides
 * @returns {Config}
 * @throws {ConfigError} on a setting that cannot be overridden.
 */
export function mergeConfig(base, overrides) {
  const unknown = Object.keys(overrides).filter((key) => !OVERRIDABLE.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown setting(s) in local config: ${unknown.join(", ")}\n  Allowed: ${OVERRIDABLE.join(", ")}`
    );
  }
  const merged = { ...base, ...overrides };
  for (const key of ["api", "sites"]) {
    if (overrides[key] !== undefined) merged[key] = { ...base[key], ...overrides[key] };
  }
  return merged;
}

/**
 * The config for this run: the defaults above, with any settings from a
 * local JSON file laid over them. The file is optional and git-ignored, so
 * a private target area never has to be committed.
 * @param {string} [file]
 * @returns {Config}
 * @throws {ConfigError} when the file exists but is not valid.
 */
export function loadConfig(file = LOCAL_CONFIG_FILE) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return config;
    throw new ConfigError(`Could not read ${file}: ${err.message}`);
  }
  let overrides;
  try {
    overrides = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err.message}`);
  }
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new ConfigError(`${file} must contain a JSON object`);
  }
  return mergeConfig(config, overrides);
}

/**
 * Read and validate the API key from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{apiKey: string}}
 * @throws {ConfigError} when the key is missing or still the placeholder.
 */
export function loadEnv(env = process.env) {
  const apiKey = (env.GOOGLE_PLACES_API_KEY ?? "").trim();
  if (apiKey === "" || apiKey === "your-key-here") {
    throw new ConfigError(
      "GOOGLE_PLACES_API_KEY is not set. Copy .env.example to .env and add a key " +
        "from a Google Cloud project with \"Places API (New)\" enabled."
    );
  }
  return { apiKey };
}
