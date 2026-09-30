import { test } from "node:test";
import assert from "node:assert/strict";
import { townCentre, cellCircle, childCells, maxCellsPerTown } from "../src/nearby.js";
import { createPlacesClient } from "../src/placesClient.js";
import { cacheKey } from "../src/cache.js";
import { config } from "../src/config.js";

test("townCentre is the median position and ignores outliers", () => {
  const places = [
    { lat: 12.93, lng: 77.62 },
    { lat: 12.94, lng: 77.63 },
    { lat: 12.95, lng: 77.61 },
    { lat: 12.96, lng: 77.64 },
    { lat: 28.6, lng: 77.2 },
    { lat: null, lng: null },
  ];
  assert.deepEqual(townCentre(places, 3), { lat: 12.95, lng: 77.62 });
  assert.equal(townCentre(places.slice(0, 2), 3), null);
  assert.equal(townCentre([], 1), null);
});

test("cellCircle covers the whole square", () => {
  const circle = cellCircle({ lat: 12.9351929, lng: 77.62448069, halfSide: 3000, depth: 0 });
  assert.equal(circle.radius, 4243);
  assert.deepEqual(circle.center, { latitude: 12.9351929, longitude: 77.6244807 });
});

test("childCells are four quarter squares around the parent centre", () => {
  const parent = { lat: 12.9, lng: 77.6, halfSide: 2000, depth: 1 };
  const children = childCells(parent);
  assert.equal(children.length, 4);
  for (const child of children) {
    assert.equal(child.halfSide, 1000);
    assert.equal(child.depth, 2);
  }
  const mean = (key) => children.reduce((sum, c) => sum + c[key], 0) / 4;
  assert.ok(Math.abs(mean("lat") - parent.lat) < 1e-9);
  assert.ok(Math.abs(mean("lng") - parent.lng) < 1e-9);
  assert.equal(new Set(children.map((c) => `${c.lat},${c.lng}`)).size, 4);
  // 1000 m north-south is about 0.009 degrees.
  assert.ok(Math.abs(Math.abs(children[0].lat - parent.lat) - 0.00898) < 0.0001);
});

test("maxCellsPerTown counts every level of the split", () => {
  assert.equal(maxCellsPerTown(0), 1);
  assert.equal(maxCellsPerTown(2), 21);
});

const memoryCache = () => {
  const store = new Map();
  return {
    key: cacheKey,
    has: async (key) => store.has(key),
    get: async (key) => store.get(key) ?? null,
    set: async (key, entry) => void store.set(key, entry),
  };
};
const places = (n, prefix) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

function gridClient(responses, overrides = {}) {
  const calls = [];
  const client = createPlacesClient({
    apiKey: "test-key",
    api: config.api,
    nearby: { ...config.nearby, maxDepth: 1 },
    cache: memoryCache(),
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return ok(responses.shift());
    },
    ...overrides,
  });
  return { client, calls };
}

test("searchNearbyGrid does not split a circle that is not full", async () => {
  const { client, calls } = gridClient([{ places: places(7, "a") }]);
  const result = await client.searchNearbyGrid({ lat: 12.93, lng: 77.62 });
  assert.equal(result.hits.length, 7);
  assert.deepEqual([result.cells, result.saturated, result.truncated], [1, 0, false]);
  assert.equal(calls[0].url, config.nearby.endpoint);
  assert.deepEqual(calls[0].body.includedTypes, config.nearby.includedTypes);
  assert.equal(calls[0].body.maxResultCount, 20);
  assert.equal(calls[0].body.locationRestriction.circle.radius, 4243);
  assert.equal(calls[0].headers["X-Goog-FieldMask"].includes("nextPageToken"), false);
});

test("searchNearbyGrid splits a full circle and reports cells still full", async () => {
  const { client, calls } = gridClient([
    { places: places(20, "root") },
    { places: places(20, "nw") },
    { places: places(3, "ne") },
    {},
    { places: places(1, "se") },
  ]);
  const result = await client.searchNearbyGrid({ lat: 12.93, lng: 77.62 });
  assert.equal(calls.length, 5);
  assert.equal(result.hits.length, 44);
  assert.deepEqual([result.cells, result.saturated, result.truncated], [5, 1, false]);
  assert.equal(calls[1].body.locationRestriction.circle.radius, 2122);
});

test("searchNearbyGrid keeps what it has when --max-calls runs out, and caches", async () => {
  const cache = memoryCache();
  const first = gridClient([{ places: places(20, "root") }, { places: places(2, "nw") }], {
    cache,
    maxCalls: 2,
  });
  const partial = await first.client.searchNearbyGrid({ lat: 12.93, lng: 77.62 });
  assert.equal(partial.hits.length, 22);
  assert.equal(partial.truncated, true);

  const second = gridClient([{}, {}, {}], { cache });
  const full = await second.client.searchNearbyGrid({ lat: 12.93, lng: 77.62 });
  assert.equal(second.calls.length, 3);
  assert.equal(second.client.stats.cacheHits, 2);
  assert.deepEqual([full.hits.length, full.cells, full.truncated], [22, 5, false]);
});
