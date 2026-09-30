#!/usr/bin/env node
/**
 * @module index
 * CLI entry point for doctor-leads: parses flags, runs the Places API
 * queries, processes the results and writes the outputs.
 */

import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import pLimit from "p-limit";

import { loadConfig, validateConfig, loadEnv, ConfigError, LOCAL_CONFIG_FILE } from "./config.js";
import { buildQueries, estimateMaxCalls, selectSubset } from "./queryBuilder.js";
import { createCache } from "./cache.js";
import { createPlacesClient, MaxCallsError } from "./placesClient.js";
import { filterReason, toRecord, extractTown } from "./normalize.js";
import { dedupe, dedupeById } from "./dedupe.js";
import {
  classifySpecialty,
  exclusionReason,
  detectEntityType,
  computePriority,
} from "./classify.js";
import { writeOutputs, printSummary } from "./export.js";
import { relevanceReason } from "./enrich/relevance.js";
import { annotatePhones } from "./enrich/phoneVerify.js";
import { createSiteFetcher } from "./enrich/siteFetcher.js";
import { createMxChecker } from "./enrich/emailVerify.js";
import { enrichLeads } from "./enrich/index.js";
import { loadVerified, applyVerified, verificationSheet } from "./enrich/verified.js";
import { townCentre, maxCellsPerTown } from "./nearby.js";
import { hasSegment, selectSegment, callListRows } from "./segment.js";

/** @type {import("./config.js").Config} Set once at startup by main(). */
let config;

const HELP = `doctor-leads — doctors, clinics and hospitals via Google Places API (New)

Usage: doctor-leads [options]

Options:
  --dry-run        Print the query count and estimated max API calls, then exit
  --towns <list>   Comma-separated subset of configured towns
  --terms <list>   Comma-separated subset of configured search terms
  --max-calls <N>  Stop making API calls after N requests (0 = cache only)
  --nearby         Also sweep each town with Nearby Search (extra API calls)
  --skip-sites     Do not fetch practice websites for emails and phone checks
  --reviews-under <N>  Call list: only leads with fewer than N reviews
  --weak-website       Call list: only leads with no working website of their own
  -h, --help       Show this help

Examples:
  doctor-leads --dry-run
  doctor-leads --towns "Koramangala,Indiranagar" --terms "pediatrician,gynecologist"
  doctor-leads --max-calls 50
  doctor-leads --max-calls 0        # reprocess cached data, no API spend
  doctor-leads --max-calls 0 --reviews-under 10 --weak-website   # write a call list
`;

/**
 * Parse and validate CLI flags.
 * @param {string[]} argv
 * @returns {{help: boolean, dryRun: boolean, nearby: boolean, skipSites: boolean, towns: string[], terms: string[], maxCalls: number, reviewsUnder: number | undefined, weakWebsite: boolean}}
 * @throws {ConfigError} on unknown flags or invalid values.
 */
function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean", default: false },
        "skip-sites": { type: "boolean", default: false },
        nearby: { type: "boolean", default: false },
        "reviews-under": { type: "string" },
        "weak-website": { type: "boolean", default: false },
        towns: { type: "string" },
        terms: { type: "string" },
        "max-calls": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    throw new ConfigError(`${err.message}\nRun with --help for usage.`);
  }

  let maxCalls = Infinity;
  if (values["max-calls"] !== undefined) {
    maxCalls = Number(values["max-calls"]);
    if (!Number.isInteger(maxCalls) || maxCalls < 0) {
      throw new ConfigError("--max-calls must be a non-negative integer");
    }
  }

  let reviewsUnder;
  if (values["reviews-under"] !== undefined) {
    reviewsUnder = Number(values["reviews-under"]);
    if (!Number.isInteger(reviewsUnder) || reviewsUnder < 1) {
      throw new ConfigError("--reviews-under must be a positive integer");
    }
  }
  if (values["weak-website"] && values["skip-sites"]) {
    throw new ConfigError("--weak-website needs the website check; remove --skip-sites");
  }

  return {
    help: values.help,
    dryRun: values["dry-run"],
    nearby: values.nearby,
    reviewsUnder,
    weakWebsite: values["weak-website"],
    skipSites: values["skip-sites"],
    towns: selectSubset(values.towns, config.towns, "--towns"),
    terms: selectSubset(values.terms, config.searchTerms, "--terms"),
    maxCalls,
  };
}

/**
 * Print what a run would cost without calling the API.
 * @param {import("./queryBuilder.js").Query[]} queries
 * @param {{towns: string[], terms: string[], nearby: boolean}} selection
 * @param {import("./cache.js").Cache} cache
 */
async function dryRun(queries, { towns, terms, nearby }, cache) {
  const cached = (
    await Promise.all(queries.map((q) => cache.has(cache.key(q.textQuery))))
  ).filter(Boolean).length;
  const uncached = queries.length - cached;

  console.log("Dry run — no API calls made.");
  console.log(`Towns (${towns.length}): ${towns.join(", ")}`);
  console.log(`Terms (${terms.length}): ${terms.join(", ")}`);
  console.log(`Total queries: ${queries.length} (${towns.length} towns × ${terms.length} terms)`);
  console.log(
    `Estimated max API calls: ${estimateMaxCalls(queries.length, config.api.maxPages)} ` +
      `(${config.api.maxPages} pages × ${queries.length} queries)`
  );
  console.log(
    `Already cached: ${cached} queries → at most ` +
      `${estimateMaxCalls(uncached, config.api.maxPages)} new calls for the remaining ${uncached}`
  );
  if (nearby) {
    const perTown = maxCellsPerTown(config.nearby.maxDepth);
    console.log(
      `Nearby sweep: 1 to ${perTown} calls per town → at most ${perTown * towns.length} ` +
        `more for ${towns.length} towns (billed as Nearby Search, a separate SKU)`
    );
  }
}

/**
 * Sweep each selected town with Nearby Search, centred on the town's
 * configured centre or on the median position of its Text Search results.
 * A derived centre is saved in the cache directory and reused, so later
 * runs sweep the same circles and hit the cache even when the set of
 * results has changed.
 * @param {ReturnType<typeof createPlacesClient>} client
 * @param {string[]} towns
 * @param {Array<{place: object}>} textHits
 * @returns {Promise<Array<{place: object, fetchedAt: string, query: import("./queryBuilder.js").Query}>>}
 */
async function nearbySweep(client, towns, textHits) {
  const located = [];
  for (const { place } of textHits) {
    if (filterReason(place, config)) continue;
    located.push({
      town: extractTown(
        place.formattedAddress,
        config.towns,
        config.allowedDistricts,
        config.townAliases
      ),
      lat: place.location?.latitude ?? null,
      lng: place.location?.longitude ?? null,
    });
  }

  const centresFile = path.join(config.cacheDir, "town-centres.json");
  let saved = {};
  try {
    saved = JSON.parse(await readFile(centresFile, "utf8"));
  } catch {
    // none saved yet
  }

  console.log("\nNearby sweep…");
  const hits = [];
  for (const town of towns) {
    const centre =
      config.townCenters[town] ??
      saved[town] ??
      townCentre(located.filter((p) => p.town === town), config.nearby.minSamples);
    if (centre && !config.townCenters[town] && !saved[town]) {
      saved[town] = centre;
      await mkdir(config.cacheDir, { recursive: true });
      await writeFile(centresFile, JSON.stringify(saved, null, 2));
    }
    if (!centre) {
      console.warn(
        `  ${town}: skipped, too few Text Search results to place its centre ` +
          "(set config.townCenters to sweep it)"
      );
      continue;
    }
    let result;
    try {
      result = await client.searchNearbyGrid(centre);
    } catch (err) {
      console.error(`  ${town}: nearby sweep failed — ${err.message}`);
      if (err.fatal) break;
      continue;
    }
    const query = { term: "", town, textQuery: `nearby search around ${town}` };
    for (const hit of result.hits) hits.push({ ...hit, query });
    console.log(
      `  ${town}: ${result.cells} circles → ${result.hits.length} places` +
        (result.saturated ? `, ${result.saturated} circles still full at the smallest size` : "") +
        (result.truncated ? " (stopped at --max-calls)" : "")
    );
  }
  return hits;
}

/**
 * Turn raw hits into final leads plus the excluded list.
 * @param {Array<{place: object, fetchedAt: string, query: import("./queryBuilder.js").Query}>} hits
 * @returns {{leads: object[], excluded: object[]}}
 */
function processHits(hits) {
  const kept = [];
  const rejected = [];
  for (const { place, fetchedAt, query } of hits) {
    const record = toRecord(place, {
      textQuery: query.textQuery,
      term: query.term,
      town: query.town,
      fetchedAt,
    });
    const reason = filterReason(place, config);
    if (reason) rejected.push({ ...record, reason });
    else kept.push(record);
  }

  const leads = [];
  const excluded = dedupeById(rejected);
  for (const record of annotatePhones(dedupe(kept))) {
    const reason = exclusionReason(record) ?? relevanceReason(record);
    if (reason) {
      excluded.push({ ...record, reason });
      continue;
    }
    const specialty = classifySpecialty(record);
    const addressTown = extractTown(
      record.address,
      config.towns,
      config.allowedDistricts,
      config.townAliases
    );
    leads.push({
      ...record,
      entityType: detectEntityType(record.name),
      specialty,
      // A village address names no listed town; file it under the town
      // whose search found it.
      town: addressTown === "Unknown" && record.searchTown ? record.searchTown : addressTown,
      priority: computePriority(specialty, record.reviewCount),
    });
  }

  const priorityOrder = { A: 0, B: 1, C: 2 };
  leads.sort(
    (a, b) =>
      priorityOrder[a.priority] - priorityOrder[b.priority] ||
      b.reviewCount - a.reviewCount ||
      a.name.localeCompare(b.name)
  );
  return { leads, excluded };
}

/**
 * Enrich leads with website contacts and confidence levels, then apply
 * the manually verified overrides.
 * @param {object[]} leads
 * @param {{skipSites: boolean}} options
 * @returns {Promise<{leads: object[], removed: object[], sheet: object[], verified: Map<string, object>, siteStats: object | null}>}
 */
async function enrich(leads, { skipSites }) {
  const fetcher = skipSites
    ? null
    : createSiteFetcher({ sites: config.sites, cacheDir: `${config.cacheDir}/sites` });
  if (fetcher) console.log("\nChecking practice websites for contact details…");

  const enriched = await enrichLeads(leads, {
    fetchSite: fetcher?.fetchSite ?? null,
    checkMx: createMxChecker(),
    sites: config.sites,
    placeWords: [...config.towns, ...config.allowedDistricts, config.state],
  });

  const verified = await loadVerified(config.verifiedFile);
  const result = applyVerified(enriched, verified);
  for (const warning of result.warnings) console.warn(`verified.csv: ${warning}`);
  if (verified.size > 0) {
    console.log(`Applied ${verified.size} verified rows from ${config.verifiedFile}`);
  }
  return {
    leads: result.leads,
    removed: result.removed,
    sheet: verificationSheet(result.leads, verified),
    verified,
    siteStats: fetcher?.stats ?? null,
  };
}

/** Run the CLI. */
async function main() {
  config = loadConfig();
  validateConfig(config);
  if (existsSync(LOCAL_CONFIG_FILE)) console.log(`Using local config ${LOCAL_CONFIG_FILE}`);
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(HELP);
    return;
  }

  const queries = buildQueries({ towns: cli.towns, terms: cli.terms, state: config.state });
  const cache = createCache(config.cacheDir);

  if (cli.dryRun) {
    await dryRun(queries, cli, cache);
    return;
  }

  const { apiKey } = loadEnv();
  const client = createPlacesClient({
    apiKey,
    api: config.api,
    nearby: config.nearby,
    cache,
    maxCalls: cli.maxCalls,
  });

  console.log(
    `Running ${queries.length} queries (${cli.towns.length} towns × ${cli.terms.length} terms), ` +
      `concurrency ${config.api.concurrency}` +
      (Number.isFinite(cli.maxCalls) ? `, max ${cli.maxCalls} API calls` : "")
  );

  const limit = pLimit(config.api.concurrency);
  const hits = [];
  const failures = [];
  let skipped = 0;
  let fatal = null;
  let done = 0;

  await Promise.all(
    queries.map((query) =>
      limit(async () => {
        if (fatal) return;
        try {
          const results = await client.searchText(query.textQuery);
          for (const hit of results) hits.push({ ...hit, query });
          done++;
          console.log(
            `[${done}/${queries.length}] ${query.textQuery} → ${results.length} places`
          );
        } catch (err) {
          if (err instanceof MaxCallsError) skipped++;
          else if (err.fatal) fatal ??= err;
          else {
            failures.push(query);
            console.error(`Failed: ${query.textQuery} — ${err.message}`);
          }
        }
      })
    )
  );

  if (fatal) {
    console.error(`\nStopped: ${fatal.message}`);
    console.error(
      "Check that the key is valid, \"Places API (New)\" is enabled and billing is active."
    );
    process.exitCode = 1;
    if (hits.length === 0) return;
  }
  if (skipped > 0) {
    console.warn(
      `\n--max-calls ${cli.maxCalls} reached: ${skipped} queries not fully fetched. ` +
        "Re-run to continue; finished pages are cached."
    );
  }

  if (cli.nearby && !fatal) hits.push(...(await nearbySweep(client, cli.towns, hits)));

  const processed = processHits(hits);
  const { leads, removed, sheet, verified, siteStats } = await enrich(processed.leads, cli);
  const excluded = [...processed.excluded, ...removed];
  const segment = hasSegment(cli) ? selectSegment(leads, cli) : null;
  const paths = await writeOutputs({
    leads,
    excluded,
    sheet,
    callList: segment && callListRows(segment, verified),
    outputDir: config.outputDir,
  });

  printSummary({
    leads,
    excluded,
    towns: config.towns,
    stats: client.stats,
    queries: { total: queries.length, skipped, failed: failures.length },
    siteStats,
  });
  console.log(`\nWrote ${paths.csv}`);
  console.log(`Wrote ${paths.json}`);
  console.log(`Wrote ${paths.excludedCsv}`);
  console.log(`Wrote ${paths.sheetCsv}`);
  if (segment) {
    const reachable = segment.filter((lead) => lead.phone).length;
    console.log(
      `Wrote ${paths.callListCsv} (${segment.length} leads, ${reachable} with a phone)`
    );
  }
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
