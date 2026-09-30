import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSegment, selectSegment, whatsappLink, callListRows } from "../src/segment.js";
import { websiteStatus } from "../src/enrich/index.js";
import { parseVerified } from "../src/enrich/verified.js";
import { config } from "../src/config.js";

const lead = (id, overrides) => ({
  id,
  name: `Dr. Example ${id}`,
  entityType: "individual_doctor",
  specialty: "GP/Physician",
  town: "Koramangala",
  priority: "C",
  address: "1st Main, Koramangala, Bengaluru 560034",
  mapsUrl: "https://maps.google.com/?cid=1",
  phone: "+919876543210",
  phoneType: "mobile",
  isMobile: true,
  phoneSharedWith: 0,
  phoneConfidence: "medium",
  email: "",
  emailConfidence: "",
  reviewCount: 3,
  websiteStatus: "none",
  ...overrides,
});

test("websiteStatus classifies a lead's website link", () => {
  const sites = config.sites;
  assert.equal(websiteStatus("", sites, false), "none");
  assert.equal(websiteStatus("https://www.facebook.com/clinic", sites, false), "platform_link");
  assert.equal(websiteStatus("https://my-clinic.ueniweb.com/", sites, true), "free_site_builder");
  assert.equal(websiteStatus("https://clinic.example/", sites, true), "own_site");
  assert.equal(websiteStatus("https://clinic.example/", sites, false), "not_loading");
  assert.equal(websiteStatus("https://clinic.example/", sites, null), "not_checked");
});

test("selectSegment applies only the filters that are set", () => {
  const leads = [
    lead("a", { reviewCount: 3, websiteStatus: "none" }),
    lead("b", { reviewCount: 9, websiteStatus: "own_site" }),
    lead("c", { reviewCount: 10, websiteStatus: "platform_link" }),
    lead("d", { reviewCount: 0, websiteStatus: "not_loading" }),
    lead("e", { reviewCount: 50, websiteStatus: "free_site_builder" }),
  ];
  const ids = (filter) => selectSegment(leads, filter).map((l) => l.id);
  assert.deepEqual(ids({ reviewsUnder: 10 }), ["a", "b", "d"]);
  assert.deepEqual(ids({ weakWebsite: true }), ["a", "c", "d", "e"]);
  assert.deepEqual(ids({ reviewsUnder: 10, weakWebsite: true }), ["a", "d"]);
  assert.deepEqual(ids({}), ["a", "b", "c", "d", "e"]);
  assert.equal(hasSegment({}), false);
  assert.equal(hasSegment({ reviewsUnder: 10 }), true);
  assert.equal(hasSegment({ weakWebsite: true }), true);
});

test("whatsappLink is only given for mobiles", () => {
  assert.equal(whatsappLink(lead("a")), "https://wa.me/919876543210");
  assert.equal(whatsappLink(lead("a", { phone: "+918023456789", isMobile: false })), "");
  assert.equal(whatsappLink(lead("a", { phone: null, isMobile: false })), "");
});

test("callListRows puts reachable leads first and keeps earlier verified rows", () => {
  const verified = parseVerified(
    "id,name,phone,email,consent,status,verifiedAt,notes\n" +
      "b,Dr B,,b@example.org,yes,confirmed,2026-10-02,\n" +
      "old,Dr Old,,,,remove,,closed"
  );
  const rows = callListRows(
    [
      lead("nophone", { phone: null, isMobile: false, phoneType: "", reviewCount: 9 }),
      lead("landline", { phone: "+918023456789", isMobile: false, phoneType: "landline" }),
      lead("a", { reviewCount: 2 }),
      lead("b", { reviewCount: 8 }),
    ],
    verified
  );
  assert.deepEqual(rows.map((r) => r.id), ["b", "a", "landline", "nophone", "old"]);
  assert.equal(rows[0].whatsappLink, "https://wa.me/919876543210");
  assert.equal(rows[0].email, "b@example.org");
  assert.equal(rows[0].status, "confirmed");
  assert.equal(rows[1].status, "");
  assert.equal(rows[2].whatsappLink, "");
  assert.equal(rows[3].foundPhone, "");
  assert.equal(rows[4].status, "remove");
});
