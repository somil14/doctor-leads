/**
 * @module enrich/verified
 * Manually verified contact details. A rep confirms a lead by phone or
 * WhatsApp and records the result in data/verified.csv; those values
 * override everything collected automatically, on every run.
 */

import { readFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { normalizePhone } from "../normalize.js";
import { phoneType } from "./phoneVerify.js";
import { emailType } from "./emailVerify.js";

/** Columns a rep fills in. Any other column in the file is ignored. */
export const VERIFIED_FIELDS = ["phone", "email", "consent", "status", "verifiedAt", "notes"];

/** Accepted `status` values. */
export const STATUSES = ["", "confirmed", "wrong_number", "remove"];

const EMAIL_SYNTAX_RE = /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

/**
 * @typedef {object} VerifiedRow
 * @property {string} id Google place id.
 * @property {string} name Copied from the sheet, for the reader's benefit only.
 * @property {string} phone
 * @property {string} email
 * @property {string} consent e.g. "yes" when the doctor agreed to be contacted by email.
 * @property {string} status One of {@link STATUSES}.
 * @property {string} verifiedAt Date of the check.
 * @property {string} notes
 */

/**
 * Parse verified.csv content. Rows with no id or nothing filled in are
 * dropped; when an id appears twice the later row wins.
 * @param {string} text CSV with a header row.
 * @returns {Map<string, VerifiedRow>} Keyed by place id.
 */
export function parseVerified(text) {
  const rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  const byId = new Map();
  for (const row of rows) {
    const id = (row.id ?? "").trim();
    if (!id) continue;
    const entry = { id, name: (row.name ?? "").trim() };
    for (const field of VERIFIED_FIELDS) entry[field] = (row[field] ?? "").trim();
    entry.status = entry.status.toLowerCase();
    const filled = ["phone", "email", "consent", "status"].some((f) => entry[f] !== "");
    if (filled) byId.set(id, entry);
  }
  return byId;
}

/**
 * Load verified.csv; a missing file is an empty set.
 * @param {string} file
 * @returns {Promise<Map<string, VerifiedRow>>}
 */
export async function loadVerified(file) {
  try {
    return parseVerified(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
}

/**
 * Apply verified rows to enriched leads.
 * @param {object[]} leads
 * @param {Map<string, VerifiedRow>} verified
 * @returns {{leads: object[], removed: object[], warnings: string[]}}
 *   `removed` are leads a rep marked "remove"; `warnings` list rows whose
 *   values could not be used.
 */
export function applyVerified(leads, verified) {
  const kept = [];
  const removed = [];
  const warnings = [];

  for (const lead of leads) {
    const row = verified.get(lead.id);
    if (!row) {
      kept.push(lead);
      continue;
    }
    if (!STATUSES.includes(row.status)) {
      warnings.push(`${lead.name}: unknown status "${row.status}" ignored`);
    }
    if (row.status === "remove") {
      removed.push({ ...lead, reason: "verified_remove" });
      continue;
    }

    const out = { ...lead, consent: row.consent, verifiedAt: row.verifiedAt };

    if (row.phone) {
      const phone = normalizePhone(row.phone);
      if (phone) {
        if (out.phone && out.phone !== phone && !out.altPhones.includes(out.phone)) {
          out.altPhones = [...out.altPhones, out.phone];
        }
        out.phone = phone;
        out.altPhones = out.altPhones.filter((p) => p !== phone);
        out.phoneType = phoneType(phone);
        out.isMobile = out.phoneType === "mobile";
        out.phoneSource = "verified";
        out.phoneConfidence = "verified";
      } else {
        warnings.push(`${lead.name}: verified phone "${row.phone}" is not a valid Indian number`);
      }
    } else if (row.status === "confirmed" && out.phone) {
      out.phoneSource = "verified";
      out.phoneConfidence = "verified";
    } else if (row.status === "wrong_number") {
      out.phone = null;
      out.phoneType = "";
      out.isMobile = false;
      out.phoneSource = "";
      out.phoneConfidence = "";
    }

    if (row.email) {
      if (EMAIL_SYNTAX_RE.test(row.email)) {
        const email = row.email.toLowerCase();
        if (out.email && out.email !== email && !out.altEmails.includes(out.email)) {
          out.altEmails = [...out.altEmails, out.email];
        }
        out.email = email;
        out.altEmails = out.altEmails.filter((e) => e !== email);
        out.emailType = emailType(email, out.name);
        out.emailSource = "verified";
        out.emailConfidence = "verified";
      } else {
        warnings.push(`${lead.name}: verified email "${row.email}" is not a valid address`);
      }
    }
    kept.push(out);
  }
  return { leads: kept, removed, warnings };
}

/**
 * Rows of the verification sheet: every current lead with its collected
 * contacts alongside the rep's columns, pre-filled from verified.csv, plus
 * any verified rows for leads no longer in the output. Saving the filled
 * sheet as data/verified.csv therefore never loses earlier work.
 * @param {object[]} leads Leads after verified rows were applied.
 * @param {Map<string, VerifiedRow>} verified
 * @returns {object[]}
 */
export function verificationSheet(leads, verified) {
  const repColumns = (row) =>
    Object.fromEntries(VERIFIED_FIELDS.map((f) => [f, row?.[f] ?? ""]));
  const rows = leads.map((lead) => ({
    id: lead.id,
    name: lead.name,
    specialty: lead.specialty,
    town: lead.town,
    priority: lead.priority,
    mapsUrl: lead.mapsUrl,
    foundPhone: lead.phone ?? "",
    phoneConfidence: lead.phoneConfidence,
    foundEmail: lead.email,
    emailConfidence: lead.emailConfidence,
    ...repColumns(verified.get(lead.id)),
  }));
  const current = new Set(leads.map((l) => l.id));
  for (const row of verified.values()) {
    if (!current.has(row.id)) rows.push({ id: row.id, name: row.name, ...repColumns(row) });
  }
  return rows;
}
