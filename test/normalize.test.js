import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone,
  isMobileNumber,
  inTargetArea,
  filterReason,
  toRecord,
  extractTown,
} from "../src/normalize.js";

const TOWNS = [
  "Saharsa",
  "Simri Bakhtiyarpur",
  "Sonbarsa",
  "Mahishi",
  "Kahara",
  "Madhepura",
  "Supaul",
  "Birpur",
];
const DISTRICTS = ["Saharsa", "Madhepura", "Supaul"];
const ALIASES = { Kahara: ["Kahra"] };
const RULES = {
  allowedDistricts: DISTRICTS,
  towns: TOWNS,
  townAliases: ALIASES,
  allowedPinPrefixes: ["852", "8543"],
};

test("normalizePhone handles the formats Google returns", () => {
  assert.equal(normalizePhone("+91 98765 43210"), "+919876543210");
  assert.equal(normalizePhone("098765 43210"), "+919876543210");
  assert.equal(normalizePhone("98765-43210"), "+919876543210");
  assert.equal(normalizePhone("91 98765 43210"), "+919876543210");
  assert.equal(normalizePhone("06478 223 344"), "+916478223344");
  assert.equal(normalizePhone("+91 6478 223 344"), "+916478223344");
});

test("normalizePhone rejects numbers that are not 10-digit Indian numbers", () => {
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("1800 123 4567"), null);
  assert.equal(normalizePhone("+1 650 253 0000"), null);
});

test("isMobileNumber flags +91[6-9] numbers", () => {
  assert.equal(isMobileNumber("+919876543210"), true);
  assert.equal(isMobileNumber("+916201234567", "+91 62012 34567"), true);
  assert.equal(isMobileNumber("+919876543210", "098765 43210"), true);
  assert.equal(isMobileNumber("+911123456789"), false);
  assert.equal(isMobileNumber(null), false);
});

test("isMobileNumber does not flag local landlines whose STD code starts with 6", () => {
  assert.equal(isMobileNumber("+916478223344", "+91 6478 223 344"), false);
  assert.equal(isMobileNumber("+916476222333", "06476 222333"), false);
});

test("filterReason keeps operational places in an allowed district", () => {
  const place = {
    businessStatus: "OPERATIONAL",
    formattedAddress: "Gangjala, SAHARSA, Bihar 852201, India",
  };
  assert.equal(filterReason(place, RULES), null);
  assert.equal(
    filterReason({ ...place, businessStatus: "CLOSED_PERMANENTLY" }, RULES),
    "not_operational"
  );
  assert.equal(filterReason({ formattedAddress: "Saharsa" }, RULES), "not_operational");
  assert.equal(
    filterReason({ ...place, formattedAddress: "Boring Road, Patna, Bihar" }, RULES),
    "outside_allowed_districts"
  );
});

test("toRecord flattens a place and tolerates missing fields", () => {
  const record = toRecord(
    {
      id: "abc",
      displayName: { text: "Dr. A Kumar" },
      formattedAddress: "Saharsa, Bihar 852201, India",
      nationalPhoneNumber: "098765 43210",
      internationalPhoneNumber: "+91 98765 43210",
      rating: 4.5,
      userRatingCount: 12,
      location: { latitude: 25.88, longitude: 86.6 },
      types: ["doctor", "health"],
      googleMapsUri: "https://maps.google.com/?cid=1",
    },
    { textQuery: "doctor in Saharsa, Bihar", term: "doctor", fetchedAt: "2026-01-01T00:00:00.000Z" }
  );
  assert.equal(record.phone, "+919876543210");
  assert.equal(record.isMobile, true);
  assert.equal(record.reviewCount, 12);
  assert.equal(record.lat, 25.88);
  assert.deepEqual(record.matchedQueries, ["doctor in Saharsa, Bihar"]);
  assert.deepEqual(record.matchedTerms, ["doctor"]);
  assert.equal(record.searchTown, "");
  assert.equal(
    toRecord({ id: "y" }, { textQuery: "q", term: "", town: "Supaul", fetchedAt: "now" }).searchTown,
    "Supaul"
  );
  assert.deepEqual(
    toRecord({ id: "y" }, { textQuery: "q", term: "", fetchedAt: "now" }).matchedTerms,
    []
  );

  const bare = toRecord({ id: "x" }, { textQuery: "q", term: "t", fetchedAt: "now" });
  assert.equal(bare.name, "");
  assert.equal(bare.phone, null);
  assert.equal(bare.isMobile, false);
  assert.equal(bare.reviewCount, 0);
  assert.equal(bare.website, "");
});

test("extractTown prefers the specific town over the district name", () => {
  assert.equal(
    extractTown("Main Road, Simri Bakhtiyarpur, Saharsa, Bihar 852127, India", TOWNS, DISTRICTS),
    "Simri Bakhtiyarpur"
  );
  assert.equal(extractTown("Gangjala, Saharsa, Bihar 852201, India", TOWNS, DISTRICTS), "Saharsa");
  assert.equal(extractTown("Ward 4, Birpur, Supaul, Bihar", TOWNS, DISTRICTS), "Birpur");
});

test("extractTown ignores town names that are only part of a road name", () => {
  assert.equal(extractTown("Supaul Road, Saharsa, Bihar 852201", TOWNS, DISTRICTS), "Saharsa");
  assert.equal(extractTown("Saharsa Road, Madhepura, Bihar 852113", TOWNS, DISTRICTS), "Madhepura");
  assert.equal(extractTown("Sonbarsa Road, Saharsa 852201, Bihar", TOWNS, DISTRICTS), "Saharsa");
});

test("extractTown falls back to a partial match, then Unknown", () => {
  assert.equal(extractTown("Sonbarsa Raj, Bihar 852129", TOWNS, DISTRICTS), "Sonbarsa");
  assert.equal(extractTown("Boring Road, Patna, Bihar", TOWNS, DISTRICTS), "Unknown");
  assert.equal(extractTown("", TOWNS, DISTRICTS), "Unknown");
});

test("inTargetArea accepts a listed town with a local PIN when the district is missing", () => {
  assert.equal(inTargetArea("Ward 5, Batraha, Kahra, Bihar 852201", RULES), true);
  assert.equal(inTargetArea("Main Road, Birpur, Bihar 854340, India", RULES), true);
  assert.equal(inTargetArea("Station Rd, SUPAUL, Bihar", RULES), true);
});

test("inTargetArea rejects same-named towns elsewhere and unlisted places", () => {
  assert.equal(inTargetArea("Sonbarsa, Sitamarhi Rd, Bihar 843317", RULES), false);
  assert.equal(inTargetArea("Birpur, Begusarai Rd, Bihar", RULES), false);
  assert.equal(inTargetArea("Some Village, Bihar 852201", RULES), false);
  assert.equal(inTargetArea("Boring Road, Patna, Bihar 800001", RULES), false);
});

test("inTargetArea accepts an area PIN prefix on its own", () => {
  const rules = { ...RULES, areaPinPrefixes: ["852"] };
  assert.equal(inTargetArea("Main Rd, Some Village, Bihar 852201", rules), true);
  assert.equal(inTargetArea("Main Rd, Some Village, Bihar 854301", rules), false);
  assert.equal(inTargetArea("Main Rd, Some Village, Bihar", rules), false);
});

test("extractTown understands alternate spellings", () => {
  assert.equal(
    extractTown("Ward 5, Batraha, Kahra, Bihar 852201", TOWNS, DISTRICTS, ALIASES),
    "Kahara"
  );
  assert.equal(
    extractTown("Kahara kuti, Saharsa, Kahra, Bihar 852201", TOWNS, DISTRICTS, ALIASES),
    "Kahara"
  );
});
