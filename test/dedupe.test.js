import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe, dedupeById, mergeRecords, sameEntity } from "../src/dedupe.js";

const rec = (overrides) => ({
  id: "p1",
  name: "Dr. A Kumar",
  phone: null,
  isMobile: false,
  website: "",
  rating: null,
  reviewCount: 0,
  matchedQueries: [],
  matchedTerms: [],
  ...overrides,
});

test("same place id from several queries collapses to one record", () => {
  const out = dedupe([
    rec({ matchedQueries: ["doctor in Saharsa, Bihar"], matchedTerms: ["doctor"] }),
    rec({ matchedQueries: ["clinic in Saharsa, Bihar"], matchedTerms: ["clinic"] }),
    rec({ matchedQueries: ["doctor in Saharsa, Bihar"], matchedTerms: ["doctor"] }),
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].matchedQueries, [
    "doctor in Saharsa, Bihar",
    "clinic in Saharsa, Bihar",
  ]);
  assert.deepEqual(out[0].matchedTerms, ["doctor", "clinic"]);
});

test("different ids sharing a phone merge, keeping the higher review count", () => {
  const out = dedupe([
    rec({ id: "p1", name: "Kumar Clinic", phone: "+919876543210", reviewCount: 3, matchedQueries: ["a"] }),
    rec({ id: "p2", name: "Dr. A Kumar", phone: "+919876543210", reviewCount: 40, matchedQueries: ["b"] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "p2");
  assert.equal(out[0].name, "Dr. A Kumar");
  assert.equal(out[0].reviewCount, 40);
  assert.deepEqual(out[0].matchedQueries, ["a", "b"]);
});

test("a shared phone does not merge different practices", () => {
  const out = dedupe([
    rec({ id: "p1", name: "Sunshine Hospital", phone: "+917000012345", reviewCount: 53 }),
    rec({ id: "p2", name: "Dr.Rahul Verma", phone: "+917000012345", reviewCount: 4 }),
    rec({ id: "p3", name: "Sunshine Hospital Saharsa", phone: "+917000012345", reviewCount: 2 }),
  ]);
  assert.deepEqual(out.map((r) => r.id), ["p1", "p2"]);
});

test("sameEntity compares the distinguishing words of two names", () => {
  const same = (a, b) => sameEntity({ name: a }, { name: b });
  assert.equal(same("Kumar Clinic", "Dr. A Kumar"), true);
  assert.equal(same("DR S N ROY MULTI-SPECIALITY CLINIC", "DR S N ROY'S SKIN AND MULTI-SPECIALITY CLINIC"), true);
  assert.equal(same("Dr S N Roy", "Dr R K Roy"), false);
  assert.equal(same("Surya Hospital", "Dr Ramesh Kumar (Surya Hospital)"), false);
  assert.equal(same("Child Clinic", "child clinic"), true);
  assert.equal(same("Health Care Centre", "Nursing Home"), false);
});

test("records without a phone are never merged with each other", () => {
  const out = dedupe([rec({ id: "p1" }), rec({ id: "p2" }), rec({ id: "p3", phone: "" })]);
  assert.equal(out.length, 3);
});

test("different ids and phones stay separate", () => {
  const out = dedupe([
    rec({ id: "p1", phone: "+919876543210" }),
    rec({ id: "p2", phone: "+919876543211" }),
  ]);
  assert.equal(out.length, 2);
});

test("mergeRecords fills fields the winner lacks and keeps the first on a tie", () => {
  const merged = mergeRecords(
    rec({ id: "p1", reviewCount: 10, website: "" }),
    rec({ id: "p2", reviewCount: 2, website: "https://example.com", rating: 4.2, phone: "+919876543210", isMobile: true })
  );
  assert.equal(merged.id, "p1");
  assert.equal(merged.website, "https://example.com");
  assert.equal(merged.rating, 4.2);
  assert.equal(merged.phone, "+919876543210");
  assert.equal(merged.isMobile, true);

  const tie = mergeRecords(rec({ id: "first", reviewCount: 5 }), rec({ id: "second", reviewCount: 5 }));
  assert.equal(tie.id, "first");
});

test("dedupeById does not merge on phone", () => {
  const out = dedupeById([
    rec({ id: "p1", phone: "+919876543210" }),
    rec({ id: "p2", phone: "+919876543210" }),
  ]);
  assert.equal(out.length, 2);
});

test("input records are not mutated", () => {
  const a = rec({ matchedQueries: ["a"] });
  const b = rec({ matchedQueries: ["b"] });
  dedupe([a, b]);
  assert.deepEqual(a.matchedQueries, ["a"]);
  assert.deepEqual(b.matchedQueries, ["b"]);
});
