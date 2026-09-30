import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { relevanceReason } from "../src/enrich/relevance.js";
import { phoneType, annotatePhones } from "../src/enrich/phoneVerify.js";
import {
  extractEmails,
  extractPhones,
  contactLinks,
  decodeCfEmail,
} from "../src/enrich/contactExtractor.js";
import {
  createSiteFetcher,
  robotsAllows,
  siteKind,
  hostOf,
} from "../src/enrich/siteFetcher.js";
import { emailType, isFreemail, createMxChecker } from "../src/enrich/emailVerify.js";
import { phoneConfidence, emailConfidence } from "../src/enrich/confidence.js";
import { enrichLeads } from "../src/enrich/index.js";
import { parseVerified, applyVerified, verificationSheet } from "../src/enrich/verified.js";
import { config } from "../src/config.js";

const rec = (name, extra = {}) => ({ name, types: [], primaryType: "", ...extra });

test("relevanceReason drops listings that are not medical", () => {
  const drop = [
    rec("Koshi Interior House", { primaryType: "general_contractor" }),
    rec("Laptop Care Saharsa", { primaryType: "electronics_store" }),
    rec("Green Leaf Kitchen (Restaurant)", { primaryType: "indian_restaurant" }),
    rec("Authorized appliance service center", { primaryType: "health", types: ["health"] }),
    rec("Shanti Kunj", { primaryType: "health", types: ["health", "service"] }),
  ];
  for (const record of drop) assert.equal(relevanceReason(record), "not_medical", record.name);
});

test("relevanceReason keeps medical names and medical types", () => {
  const keep = [
    rec("Dr. G S Singh", { primaryType: "housing_complex" }),
    rec("LAXMI NURSING HOME", { primaryType: "health" }),
    rec("Jan Seva Sadan", { primaryType: "health", types: ["medical_clinic", "health"] }),
    rec("Jeevan Jyoti", { primaryType: "hospital" }),
    rec("Sharma (Dr. A K Sharma)", { primaryType: "health" }),
    rec("Rainbow Children's Centre"),
  ];
  for (const record of keep) assert.equal(relevanceReason(record), null, record.name);
});

test("phoneType follows the Indian numbering plan", () => {
  assert.equal(phoneType("+919812345678"), "mobile");
  assert.equal(phoneType("+916201234567"), "mobile");
  assert.equal(phoneType("+916478211111"), "landline");
  assert.equal(phoneType("+915551234567"), "invalid");
  assert.equal(phoneType(null), "");
});

test("annotatePhones counts listings sharing a number", () => {
  const out = annotatePhones([
    { id: "a", phone: "+917000012345", isMobile: true },
    { id: "b", phone: "+917000012345", isMobile: true },
    { id: "c", phone: "+916478211111", isMobile: true },
    { id: "d", phone: null, isMobile: false },
  ]);
  assert.deepEqual(out.map((r) => r.phoneSharedWith), [1, 1, 0, 0]);
  assert.deepEqual(out.map((r) => r.isMobile), [true, true, false, false]);
  assert.equal(out[2].phoneType, "landline");
});

test("extractEmails reads mailto links, text, entities and Cloudflare protection", () => {
  const html = `
    <a href="mailto:Dr.Kumar@Example-Clinic.in?subject=Hi">Mail</a>
    <p>Write to info&#64;example-clinic.in or drkumar.saharsa@gmail.com.</p>
    <a href="/cdn-cgi/l/email-protection#1a73747c755a7f627b776a767f37797673747379347374">[email&#160;protected]</a>
    <script type="application/ld+json">{"email":"care@example-clinic.in"}</script>`;
  assert.deepEqual(extractEmails(html), [
    "info@example-clinic.in",
    "dr.kumar@example-clinic.in",
    "drkumar.saharsa@gmail.com",
    "care@example-clinic.in",
  ]);
  assert.equal(decodeCfEmail("1a73747c755a7f627b776a767f37797673747379347374"), "info@example-clinic.in");
});

test("extractEmails drops placeholders, assets and vendor addresses", () => {
  const html = `
    <img src="logo@2x.png"> <script src="jquery@3.6.0.min.js"></script>
    your@email.com name@domain.com info@example.com support@grexa.site
    9f86d081884c7d659a2feaa0c55ad015@sentry.io user@website.com
    staff.remedo@gmail.com`;
  assert.deepEqual(extractEmails(html), []);
});

test("extractPhones reads tel links, JSON-LD and mobiles in visible text", () => {
  const html = `
    <a href="tel:+91-6478-211111">Call</a>
    <p>Appointments: 98123 45678, +91 62012 34567</p>
    <script>var id = 9876543210123; var n = "9999999999";</script>
    <script type="application/ld+json">{"telephone":"+91 98000 11122"}</script>
    <p>Reg no 123456789012345</p>`;
  assert.deepEqual(extractPhones(html), [
    "+916478211111",
    "+919800011122",
    "+919812345678",
    "+916201234567",
  ]);
});

test("contactLinks returns same-site contact and about pages only", () => {
  const html = `
    <a href="/contact-us">Contact</a> <a href="about.html#team">About</a>
    <a href="/services">Services</a> <a href="https://facebook.com/contact">FB</a>
    <a href="/page7">Reach us</a> <a href="/contact-us">Contact</a>`;
  assert.deepEqual(contactLinks(html, "https://clinic.in/", 3), [
    "https://clinic.in/contact-us",
    "https://clinic.in/about.html",
    "https://clinic.in/page7",
  ]);
});

test("siteKind separates practice sites from shared platforms", () => {
  const skip = config.sites.skipHosts;
  assert.equal(siteKind("https://www.drkumar.in/", skip), "own");
  assert.equal(siteKind("https://my-clinic.ueniweb.com", skip), "own");
  assert.equal(siteKind("https://m.facebook.com/page", skip), "platform");
  assert.equal(siteKind("https://www.eka.care/doctor/x", skip), "platform");
  assert.equal(siteKind("", skip), "none");
  assert.equal(siteKind("not a url", skip), "none");
  assert.equal(hostOf("http://WWW.Example.in/x"), "example.in");
});

test("robotsAllows applies the longest matching rule for the right agent", () => {
  const robots = `
    User-agent: *
    Disallow: /private/
    Allow: /private/contact
    Disallow: /*.pdf$

    User-agent: doctor-leads
    Disallow: /`;
  assert.equal(robotsAllows(robots, "/", "somebot"), true);
  assert.equal(robotsAllows(robots, "/private/x", "somebot"), false);
  assert.equal(robotsAllows(robots, "/private/contact", "somebot"), true);
  assert.equal(robotsAllows(robots, "/files/a.pdf", "somebot"), false);
  assert.equal(robotsAllows(robots, "/contact", "doctor-leads"), false);
  assert.equal(robotsAllows("", "/anything", "doctor-leads"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow:", "/x", "doctor-leads"), true);
});

/** Fetch stub serving a fixed set of pages. */
function stubSite(pages) {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const body = pages[url];
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      headers: { get: () => "text/html; charset=utf-8" },
      text: async () => body ?? "",
    };
  };
  return { fetchImpl, requested };
}

test("fetchSite follows contact links, obeys robots.txt and caches", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "doctor-leads-"));
  try {
    const pages = {
      "https://clinic.in/robots.txt": "User-agent: *\nDisallow: /about",
      "https://clinic.in/": '<a href="/contact">Contact</a> <a href="/about">About</a>',
      "https://clinic.in/contact": "<p>mail: dr@clinic.in</p>",
      "https://clinic.in/about": "<p>secret</p>",
    };
    const first = stubSite(pages);
    const fetcher = createSiteFetcher({
      sites: config.sites,
      cacheDir,
      fetchImpl: first.fetchImpl,
      sleep: async () => {},
    });
    const result = await fetcher.fetchSite("https://clinic.in/");
    assert.deepEqual(result.map((p) => p.url), ["https://clinic.in/", "https://clinic.in/contact"]);
    assert.equal(first.requested.includes("https://clinic.in/about"), false);
    assert.equal(fetcher.stats.blocked, 1);
    assert.equal(fetcher.stats.requests, 3);

    const second = stubSite(pages);
    const again = createSiteFetcher({
      sites: config.sites,
      cacheDir,
      fetchImpl: second.fetchImpl,
      sleep: async () => {},
    });
    assert.equal((await again.fetchSite("https://clinic.in/")).length, 2);
    assert.deepEqual(second.requested, []);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("fetchSite returns nothing for a site that disallows everything or is down", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "doctor-leads-"));
  try {
    const { fetchImpl } = stubSite({
      "https://closed.in/robots.txt": "User-agent: *\nDisallow: /",
      "https://closed.in/": "<p>a@closed.in</p>",
    });
    const fetcher = createSiteFetcher({ sites: config.sites, cacheDir, fetchImpl, sleep: async () => {} });
    assert.deepEqual(await fetcher.fetchSite("https://closed.in/"), []);
    assert.deepEqual(await fetcher.fetchSite("https://down.in/"), []);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("emailType tells role, named and other addresses apart", () => {
  assert.equal(emailType("info@clinic.in", "Dr. Arun Bhardwaj"), "role");
  assert.equal(emailType("contact.us@clinic.in", "Dr. Arun Bhardwaj"), "role");
  assert.equal(emailType("drarunbhardwaj@gmail.com", "Dr. Arun Bhardwaj (General Physician)"), "named");
  assert.equal(emailType("sunrise2019@gmail.com", "Dr. Arun Bhardwaj"), "other");
  assert.equal(
    emailType("abcsaharsa@gmail.com", "Koshi Medical College, Saharsa", ["Saharsa", "Bihar"]),
    "other"
  );
  assert.equal(isFreemail("x@gmail.com"), true);
  assert.equal(isFreemail("x@clinic.in"), false);
});

test("the MX checker classifies domains and caches lookups", async () => {
  let calls = 0;
  const dnsError = (code) => Object.assign(new Error(code), { code });
  const check = createMxChecker({
    resolveMxImpl: async (domain) => {
      calls++;
      if (domain === "good.in") return [{ exchange: "mx.good.in" }];
      if (domain === "nullmx.in") return [{ exchange: "." }];
      if (domain === "timeout.in") throw dnsError("ETIMEOUT");
      throw dnsError("ENODATA");
    },
    resolve4Impl: async (domain) => {
      if (domain === "aonly.in") return ["1.2.3.4"];
      throw dnsError("ENOTFOUND");
    },
  });
  assert.equal(await check("a@good.in"), "ok");
  assert.equal(await check("b@good.in"), "ok");
  assert.equal(calls, 1);
  assert.equal(await check("a@nullmx.in"), "no_mail_server");
  assert.equal(await check("a@aonly.in"), "ok");
  assert.equal(await check("a@gone.in"), "no_mail_server");
  assert.equal(await check("a@timeout.in"), "unknown");
});

test("phoneConfidence weighs corroboration, sharing and thin listings", () => {
  const base = { phone: "+919812345678", phoneType: "mobile", phoneSharedWith: 0, reviewCount: 50 };
  assert.equal(phoneConfidence({ ...base, phoneSource: "google+website", sitePhoneCount: 1 }), "high");
  assert.equal(phoneConfidence({ ...base, phoneSource: "google" }), "medium");
  assert.equal(phoneConfidence({ ...base, phoneSource: "google", reviewCount: 2 }), "low");
  assert.equal(phoneConfidence({ ...base, phoneSource: "google", sitePhoneCount: 2 }), "low");
  assert.equal(phoneConfidence({ ...base, phoneSource: "google+website", phoneSharedWith: 2 }), "low");
  assert.equal(phoneConfidence({ ...base, phoneSource: "google", phoneType: "invalid" }), "low");
  assert.equal(phoneConfidence({ ...base, phoneSource: "website", sitePhoneCount: 1 }), "medium");
  assert.equal(phoneConfidence({ ...base, phoneSource: "website", sitePhoneCount: 5 }), "low");
  assert.equal(phoneConfidence({ ...base, phoneSource: "verified", phoneSharedWith: 3 }), "verified");
  assert.equal(phoneConfidence({ ...base, phone: null, phoneSource: "" }), "");
});

test("emailConfidence weighs the mail server, the domain and the address type", () => {
  const base = { email: "a@clinic.in", emailSource: "https://clinic.in/", mx: "ok" };
  assert.equal(emailConfidence({ ...base, emailType: "role", domainMatchesSite: true }), "high");
  assert.equal(emailConfidence({ ...base, emailType: "named", domainMatchesSite: false }), "high");
  assert.equal(emailConfidence({ ...base, emailType: "other", domainMatchesSite: false }), "medium");
  assert.equal(emailConfidence({ ...base, emailType: "role", domainMatchesSite: true, siteShared: true }), "low");
  assert.equal(emailConfidence({ ...base, mx: "unknown", emailType: "named", domainMatchesSite: true }), "low");
  assert.equal(emailConfidence({ ...base, emailSource: "verified", mx: "unknown" }), "verified");
  assert.equal(emailConfidence({ email: "" }), "");
});

const lead = (overrides) => ({
  id: "p1",
  name: "Dr. Arun Bhardwaj",
  phone: "+919800011122",
  phoneType: "mobile",
  isMobile: true,
  phoneSharedWith: 0,
  reviewCount: 100,
  website: "https://drarun.test/",
  specialty: "GP/Physician",
  town: "Saharsa",
  priority: "A",
  mapsUrl: "https://maps.google.com/?cid=1",
  ...overrides,
});

test("enrichLeads cross-checks phones and picks the best published email", async () => {
  const sitePages = {
    "https://drarun.test/": [
      { url: "https://drarun.test/", html: '<a href="tel:+919800011122">Call</a> info@drarun.test drarun@gmail.com dead@nomail.in' },
    ],
    "https://other.in/": [
      { url: "https://other.in/", html: "Call 98123 45678 or 62012 34567" },
    ],
  };
  const fetched = [];
  const out = await enrichLeads(
    [
      lead({}),
      lead({ id: "p2", name: "Dr. No Phone", phone: null, phoneType: "", isMobile: false, website: "https://other.in/" }),
      lead({ id: "p3", name: "Dr. Facebook", website: "https://facebook.com/dr", reviewCount: 2 }),
    ],
    {
      fetchSite: async (url) => {
        fetched.push(url);
        return sitePages[url] ?? [];
      },
      checkMx: async (email) => (email.endsWith("@nomail.in") ? "no_mail_server" : "ok"),
      sites: config.sites,
    }
  );

  assert.deepEqual(fetched.sort(), ["https://drarun.test/", "https://other.in/"]);

  assert.equal(out[0].phoneSource, "google+website");
  assert.equal(out[0].phoneConfidence, "high");
  assert.equal(out[0].email, "drarun@gmail.com");
  assert.equal(out[0].emailType, "named");
  assert.equal(out[0].emailConfidence, "high");
  assert.equal(out[0].emailSource, "https://drarun.test/");
  assert.deepEqual(out[0].altEmails, ["info@drarun.test"]);

  assert.equal(out[1].phone, "+919812345678");
  assert.equal(out[1].phoneSource, "website");
  assert.equal(out[1].isMobile, true);
  assert.equal(out[1].phoneConfidence, "medium");
  assert.deepEqual(out[1].altPhones, ["+916201234567"]);
  assert.equal(out[1].email, "");

  assert.equal(out[2].phoneSource, "google");
  assert.equal(out[2].phoneConfidence, "low");
  assert.equal(out[2].email, "");
});

test("enrichLeads works without website fetching", async () => {
  const [out] = await enrichLeads([lead({})], {
    fetchSite: null,
    checkMx: async () => "ok",
    sites: config.sites,
  });
  assert.equal(out.phoneSource, "google");
  assert.equal(out.phoneConfidence, "medium");
  assert.equal(out.email, "");
});

const enriched = (overrides) => ({
  ...lead({}),
  phoneSource: "google",
  phoneConfidence: "medium",
  altPhones: [],
  email: "",
  emailType: "",
  emailSource: "",
  emailConfidence: "",
  altEmails: [],
  verifiedAt: "",
  consent: "",
  ...overrides,
});

test("parseVerified keeps only rows a rep filled in", () => {
  const verified = parseVerified(
    [
      "id,name,foundPhone,phone,email,consent,status,verifiedAt,notes",
      "p1,Dr A,+919800011122,98123 45678,dr.a@gmail.com,yes,Confirmed,2026-10-02,spoke to doctor",
      "p2,Dr B,,,,,,,",
      ",No id,,9999999999,,,,,",
      "p3,Dr C,,,,,remove,,closed down",
    ].join("\n")
  );
  assert.deepEqual([...verified.keys()], ["p1", "p3"]);
  assert.equal(verified.get("p1").status, "confirmed");
  assert.equal(verified.get("p1").phone, "98123 45678");
});

test("applyVerified overrides collected contacts and records consent", () => {
  const verified = parseVerified(
    [
      "id,phone,email,consent,status,verifiedAt,notes",
      "p1,98123 45678,Dr.A@Gmail.com,yes,confirmed,2026-10-02,",
      "p2,,,,confirmed,2026-10-03,",
      "p3,,,,wrong_number,2026-10-03,",
      "p4,,,,remove,,not a doctor",
      "p5,12345,not-an-email,,,,",
    ].join("\n")
  );
  const result = applyVerified(
    ["p1", "p2", "p3", "p4", "p5", "p6"].map((id) => enriched({ id, email: "info@drarun.test" })),
    verified
  );
  const byId = Object.fromEntries(result.leads.map((l) => [l.id, l]));

  assert.equal(byId.p1.phone, "+919812345678");
  assert.equal(byId.p1.phoneConfidence, "verified");
  assert.deepEqual(byId.p1.altPhones, ["+919800011122"]);
  assert.equal(byId.p1.email, "dr.a@gmail.com");
  assert.equal(byId.p1.emailConfidence, "verified");
  assert.deepEqual(byId.p1.altEmails, ["info@drarun.test"]);
  assert.equal(byId.p1.consent, "yes");
  assert.equal(byId.p1.verifiedAt, "2026-10-02");

  assert.equal(byId.p2.phone, "+919800011122");
  assert.equal(byId.p2.phoneConfidence, "verified");
  assert.equal(byId.p3.phone, null);
  assert.equal(byId.p3.phoneConfidence, "");

  assert.deepEqual(result.removed.map((l) => [l.id, l.reason]), [["p4", "verified_remove"]]);
  assert.equal(byId.p5.phone, "+919800011122");
  assert.equal(byId.p5.phoneConfidence, "medium");
  assert.equal(result.warnings.length, 2);
  assert.equal(byId.p6.phoneConfidence, "medium");
});

test("verificationSheet keeps earlier verified rows, including removed leads", () => {
  const verified = parseVerified(
    "id,name,phone,email,consent,status,verifiedAt,notes\n" +
      "p1,Dr A,9812345678,,yes,confirmed,2026-10-02,\n" +
      "gone,Dr Gone,,,,remove,,closed"
  );
  const sheet = verificationSheet([enriched({ id: "p1" }), enriched({ id: "p2" })], verified);
  assert.equal(sheet.length, 3);
  assert.equal(sheet[0].name, "Dr. Arun Bhardwaj");
  assert.equal(sheet[0].phone, "9812345678");
  assert.equal(sheet[0].foundPhone, "+919800011122");
  assert.equal(sheet[1].phone, "");
  assert.equal(sheet[1].status, "");
  assert.deepEqual([sheet[2].id, sheet[2].name, sheet[2].status], ["gone", "Dr Gone", "remove"]);
});
