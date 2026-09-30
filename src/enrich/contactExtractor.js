/**
 * @module enrich/contactExtractor
 * Pulls published email addresses and phone numbers out of a practice's
 * own web page. Favours precision: anything that looks like a placeholder,
 * a vendor address or a stray digit string is dropped.
 */

import { normalizePhone } from "../normalize.js";

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi;

/** File extensions that make "logo@2x.png" look like an email. */
const ASSET_TLD_RE = /\.(png|jpe?g|gif|webp|svg|css|js|json|ico|woff2?|ttf|map)$/i;

/** Website builders, trackers and template placeholders. */
const JUNK_EMAIL_DOMAINS = [
  "example.com", "example.org", "domain.com", "email.com", "yourdomain.com",
  "yoursite.com", "website.com", "company.com", "mail.com", "test.com",
  "sentry.io", "sentry-next.wixpress.com", "wixpress.com", "wix.com",
  "godaddy.com", "grexa.site", "grexa.com", "ueni.com", "ueniweb.com",
  "getmy.clinic", "wordpress.com", "wordpress.org", "w3.org", "schema.org",
  "googlemail.invalid", "github.com", "users.noreply.github.com",
];

/** Staff addresses of site-builder and clinic-software vendors. */
const VENDOR_RE = /remedo|grexa|ueni|godaddy|wix|healthplix|practo/i;

const JUNK_LOCAL_RE = /^(your|you|name|user|username|email|mail|someone|test|abc|xyz|noreply|no-reply|donotreply)(name|email|mail)?$/i;

/**
 * Decode the few HTML entities that hide "@" and "." in addresses.
 * @param {string} html
 * @returns {string}
 */
function decodeEntities(html) {
  return html
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&commat;/gi, "@")
    .replace(/&period;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ");
}

/**
 * Decode a Cloudflare email-protection string (data-cfemail / #hash).
 * @param {string} hex
 * @returns {string}
 */
export function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return out;
}

/**
 * Whether an address is a real, usable-looking email rather than a
 * placeholder, an asset file name or a vendor address.
 * @param {string} email Lower-cased.
 * @returns {boolean}
 */
export function isPlausibleEmail(email) {
  if (email.length > 100 || ASSET_TLD_RE.test(email)) return false;
  const [local, domain] = email.split("@");
  if (!local || !domain || domain.includes("..") || local.includes("..")) return false;
  if (JUNK_LOCAL_RE.test(local) || VENDOR_RE.test(email)) return false;
  if (JUNK_EMAIL_DOMAINS.some((junk) => domain === junk || domain.endsWith(`.${junk}`))) {
    return false;
  }
  // Hashes used as tracking ids, e.g. 9f86d081884c7d65@...
  if (/^[0-9a-f]{16,}$/.test(local)) return false;
  return true;
}

/**
 * Emails published in a page, lower-cased and deduplicated, in page order.
 * Reads mailto: links, plain text, JSON-LD and Cloudflare-protected links.
 * @param {string} html
 * @returns {string[]}
 */
export function extractEmails(html) {
  const source = decodeEntities(String(html ?? ""));
  const found = [];

  for (const match of source.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) {
    found.push(decodeCfEmail(match[1]));
  }
  for (const match of source.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) {
    found.push(decodeCfEmail(match[1]));
  }
  for (const match of source.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    let address = match[1];
    try {
      address = decodeURIComponent(address);
    } catch {
      // keep the raw value
    }
    found.push(...address.split(","));
  }
  found.push(...(source.match(EMAIL_RE) ?? []));

  const emails = found
    .map((e) => e.trim().toLowerCase().replace(/^[.\-_]+|[.\-_]+$/g, ""))
    .filter((e) => /^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(e))
    .filter(isPlausibleEmail);
  return [...new Set(emails)];
}

/**
 * Visible text of a page: scripts, styles and tags removed.
 * @param {string} html
 * @returns {string}
 */
function visibleText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

/**
 * Indian phone numbers published in a page, as E.164, deduplicated, in
 * page order. Reads tel: links, JSON-LD "telephone" values and mobile
 * numbers in the visible text. Landlines are only taken from tel: links
 * and JSON-LD, where there is no doubt the digits are a phone number.
 * @param {string} html
 * @returns {string[]}
 */
export function extractPhones(html) {
  const source = String(html ?? "");
  const candidates = [];

  for (const match of source.matchAll(/(?:tel:|wa\.me\/|phone=)([+\d][\d\s().%-]{8,20})/gi)) {
    candidates.push(match[1].replace(/%20/g, " "));
  }
  for (const match of source.matchAll(/"telephone"\s*:\s*"([^"]{8,25})"/gi)) {
    candidates.push(match[1]);
  }
  const text = visibleText(source);
  for (const match of text.matchAll(/(?<![\d+])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g)) {
    candidates.push(match[0]);
  }

  const phones = candidates.map((c) => normalizePhone(c)).filter(Boolean);
  return [...new Set(phones)];
}

/**
 * Same-site links worth following for contact details.
 * @param {string} html
 * @param {string} baseUrl URL the page was fetched from.
 * @param {number} limit
 * @returns {string[]} Absolute URLs without fragments.
 */
export function contactLinks(html, baseUrl, limit) {
  const base = new URL(baseUrl);
  const links = [];
  for (const match of String(html ?? "").matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const [, href, label] = match;
    let url;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || url.hostname !== base.hostname) continue;
    if (!/contact|about|reach|appointment|location|enquir/i.test(`${url.pathname} ${label}`)) continue;
    url.hash = "";
    const clean = url.toString();
    if (clean !== base.toString() && !links.includes(clean)) links.push(clean);
    if (links.length >= limit) break;
  }
  return links;
}
