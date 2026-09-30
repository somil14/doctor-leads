/**
 * @module export
 * Writes the CSV/JSON outputs and prints the console summary.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createObjectCsvWriter } from "csv-writer";
import { SPECIALTIES } from "./classify.js";

/** Column order of doctors_<YYYYMMDD>.csv (and keys of the JSON rows). */
export const COLUMNS = [
  "id",
  "name",
  "entityType",
  "specialty",
  "town",
  "address",
  "phone",
  "isMobile",
  "website",
  "rating",
  "reviewCount",
  "lat",
  "lng",
  "mapsUrl",
  "matchedQueries",
  "priority",
  "fetchedAt",
  "phoneType",
  "phoneSource",
  "phoneConfidence",
  "phoneSharedWith",
  "altPhones",
  "email",
  "emailType",
  "emailSource",
  "emailConfidence",
  "altEmails",
  "verifiedAt",
  "consent",
  "websiteStatus",
];

/** Column order of call_list_<YYYYMMDD>.csv. */
export const CALL_LIST_COLUMNS = [
  "id",
  "name",
  "entityType",
  "specialty",
  "town",
  "address",
  "reviewCount",
  "websiteStatus",
  "mapsUrl",
  "foundPhone",
  "phoneType",
  "phoneConfidence",
  "phoneSharedWith",
  "whatsappLink",
  "foundEmail",
  "phone",
  "email",
  "consent",
  "status",
  "verifiedAt",
  "notes",
];

/** Column order of verification_sheet_<YYYYMMDD>.csv. */
export const SHEET_COLUMNS = [
  "id",
  "name",
  "specialty",
  "town",
  "priority",
  "mapsUrl",
  "foundPhone",
  "phoneConfidence",
  "foundEmail",
  "emailConfidence",
  "phone",
  "email",
  "consent",
  "status",
  "verifiedAt",
  "notes",
];

const EXCLUDED_COLUMNS = [
  "id",
  "name",
  "reason",
  "primaryType",
  "address",
  "phone",
  "reviewCount",
  "mapsUrl",
  "matchedQueries",
];

/**
 * Local date as YYYYMMDD, used in output file names.
 * @param {Date} [date]
 * @returns {string}
 */
export function dateStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Pick the output columns from a record, in order.
 * @param {object} record
 * @param {string[]} columns
 * @returns {object}
 */
function pick(record, columns) {
  return Object.fromEntries(columns.map((c) => [c, record[c] ?? ""]));
}

/**
 * Write rows to a CSV file; list values are joined with " | ".
 * @param {string} file
 * @param {string[]} columns
 * @param {object[]} records
 * @returns {Promise<void>}
 */
async function writeCsv(file, columns, records) {
  const writer = createObjectCsvWriter({
    path: file,
    header: columns.map((id) => ({ id, title: id })),
  });
  const rows = records.map((record) => {
    const row = pick(record, columns);
    for (const [key, value] of Object.entries(row)) {
      if (Array.isArray(value)) row[key] = value.join(" | ");
    }
    return row;
  });
  await writer.writeRecords(rows);
}

/**
 * Write doctors_<date>.csv, doctors_<date>.json, excluded_<date>.csv and
 * verification_sheet_<date>.csv.
 * @param {object} input
 * @param {object[]} input.leads Fully enriched lead records.
 * @param {object[]} input.excluded Records left out, each with a `reason`.
 * @param {object[]} input.sheet Rows of the verification sheet.
 * @param {object[] | null} [input.callList] Rows of the call list; null writes none.
 * @param {string} input.outputDir
 * @param {Date} [input.date]
 * @returns {Promise<{csv: string, json: string, excludedCsv: string, sheetCsv: string, callListCsv: string | null}>} Paths written.
 */
export async function writeOutputs({
  leads,
  excluded,
  sheet,
  callList = null,
  outputDir,
  date = new Date(),
}) {
  await mkdir(outputDir, { recursive: true });
  const stamp = dateStamp(date);
  const paths = {
    csv: path.join(outputDir, `doctors_${stamp}.csv`),
    json: path.join(outputDir, `doctors_${stamp}.json`),
    excludedCsv: path.join(outputDir, `excluded_${stamp}.csv`),
    sheetCsv: path.join(outputDir, `verification_sheet_${stamp}.csv`),
    callListCsv: callList ? path.join(outputDir, `call_list_${stamp}.csv`) : null,
  };
  await writeCsv(paths.csv, COLUMNS, leads);
  await writeFile(
    paths.json,
    JSON.stringify(leads.map((r) => pick(r, COLUMNS)), null, 2)
  );
  await writeCsv(paths.excludedCsv, EXCLUDED_COLUMNS, excluded);
  await writeCsv(paths.sheetCsv, SHEET_COLUMNS, sheet);
  if (callList) await writeCsv(paths.callListCsv, CALL_LIST_COLUMNS, callList);
  return paths;
}

/**
 * Count records by a key.
 * @param {object[]} records
 * @param {string} key
 * @returns {Record<string, number>}
 */
function countBy(records, key) {
  const counts = {};
  for (const record of records) {
    counts[record[key]] = (counts[record[key]] ?? 0) + 1;
  }
  return counts;
}

/**
 * Print the run summary: town × specialty table, priority counts,
 * contact quality, exclusions and API usage.
 * @param {object} input
 * @param {object[]} input.leads
 * @param {object[]} input.excluded
 * @param {string[]} input.towns Row order for the table.
 * @param {import("./placesClient.js").ClientStats} input.stats
 * @param {{total: number, skipped: number, failed: number}} input.queries
 * @param {import("./enrich/siteFetcher.js").SiteStats | null} input.siteStats
 *   Null when website lookups were skipped.
 */
export function printSummary({ leads, excluded, towns, stats, queries, siteStats }) {
  const specialties = SPECIALTIES.filter((s) => leads.some((r) => r.specialty === s));
  const townRows = [...towns, "Unknown"].filter((t) => leads.some((r) => r.town === t));

  const table = {};
  for (const town of townRows) {
    const inTown = leads.filter((r) => r.town === town);
    const row = {};
    for (const specialty of specialties) {
      row[specialty] = inTown.filter((r) => r.specialty === specialty).length;
    }
    row.Total = inTown.length;
    table[town] = row;
  }
  const totals = {};
  for (const specialty of specialties) {
    totals[specialty] = leads.filter((r) => r.specialty === specialty).length;
  }
  totals.Total = leads.length;
  table.Total = totals;

  console.log(`\nLeads by town × specialty (${leads.length} total)`);
  if (leads.length > 0) console.table(table);

  const priority = countBy(leads, "priority");
  console.log(
    `Priority:  A=${priority.A ?? 0}  B=${priority.B ?? 0}  C=${priority.C ?? 0}`
  );

  const levels = (key) => {
    const counts = countBy(leads, key);
    return ["verified", "high", "medium", "low"]
      .map((level) => `${level}=${counts[level] ?? 0}`)
      .join("  ");
  };
  const withPhone = leads.filter((r) => r.phone).length;
  const withEmail = leads.filter((r) => r.email).length;
  const shared = leads.filter((r) => r.phoneSharedWith > 0).length;
  console.log(`Phones:    ${withPhone} of ${leads.length}  (${levels("phoneConfidence")})`);
  console.log(`           ${shared} on a number shared with another listing`);
  console.log(`Emails:    ${withEmail} of ${leads.length}  (${levels("emailConfidence")})`);

  const reasons = countBy(excluded, "reason");
  const reasonText = Object.entries(reasons)
    .map(([reason, count]) => `${reason}=${count}`)
    .join("  ");
  console.log(`Excluded:  ${excluded.length}${reasonText ? `  (${reasonText})` : ""}`);

  console.log(
    `Queries:   ${queries.total} run` +
      (queries.skipped ? `, ${queries.skipped} cut short by --max-calls` : "") +
      (queries.failed ? `, ${queries.failed} failed` : "")
  );
  console.log(
    `API calls: ${stats.apiCalls}` + (stats.retries ? ` (${stats.retries} retries)` : "")
  );
  console.log(`Cache hits: ${stats.cacheHits}`);
  console.log(
    siteStats
      ? `Websites:  ${siteStats.requests} pages fetched, ${siteStats.cacheHits} from cache, ` +
          `${siteStats.failed} failed, ${siteStats.blocked} blocked by robots.txt`
      : "Websites:  skipped (--skip-sites)"
  );
}
