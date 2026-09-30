import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlacesClient, MaxCallsError, ApiError, backoffDelay } from "../src/placesClient.js";
import { cacheKey } from "../src/cache.js";
import { config } from "../src/config.js";

/** In-memory stand-in for the disk cache. */
function memoryCache() {
  const store = new Map();
  return {
    store,
    key: cacheKey,
    has: async (key) => store.has(key),
    get: async (key) => store.get(key) ?? null,
    set: async (key, entry) => void store.set(key, entry),
  };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, message = "boom") => ({
  ok: false,
  status,
  text: async () => JSON.stringify({ error: { message } }),
});

/** Fetch stub that replays queued responses and records request bodies. */
function stubFetch(responses) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push({ body: JSON.parse(init.body), headers: init.headers });
    return responses.shift();
  };
  return { fetchImpl, calls };
}

const client = (overrides) =>
  createPlacesClient({
    apiKey: "test-key",
    api: config.api,
    cache: memoryCache(),
    sleep: async () => {},
    ...overrides,
  });

test("follows nextPageToken up to three pages and sends the field mask", async () => {
  const { fetchImpl, calls } = stubFetch([
    ok({ places: [{ id: "1" }], nextPageToken: "t1" }),
    ok({ places: [{ id: "2" }], nextPageToken: "t2" }),
    ok({ places: [{ id: "3" }], nextPageToken: "t3" }),
  ]);
  const c = client({ fetchImpl });
  const hits = await c.searchText("doctor in Saharsa, Bihar");

  assert.deepEqual(hits.map((h) => h.place.id), ["1", "2", "3"]);
  assert.equal(c.stats.apiCalls, 3);
  assert.deepEqual(calls[0].body, {
    textQuery: "doctor in Saharsa, Bihar",
    regionCode: "IN",
    languageCode: "en",
    pageSize: 20,
  });
  assert.equal(calls[1].body.pageToken, "t1");
  assert.equal(calls[0].headers["X-Goog-Api-Key"], "test-key");
  assert.equal(calls[0].headers["X-Goog-FieldMask"], config.api.fieldMask.join(","));
});

test("a second run is served entirely from cache", async () => {
  const cache = memoryCache();
  const first = stubFetch([ok({ places: [{ id: "1" }], nextPageToken: "t1" }), ok({ places: [{ id: "2" }] })]);
  await client({ fetchImpl: first.fetchImpl, cache }).searchText("q");

  const second = stubFetch([]);
  const c = client({ fetchImpl: second.fetchImpl, cache });
  const hits = await c.searchText("q");
  assert.equal(hits.length, 2);
  assert.equal(c.stats.apiCalls, 0);
  assert.equal(c.stats.cacheHits, 2);
});

test("retries 429 and 5xx, then succeeds", async () => {
  const { fetchImpl } = stubFetch([fail(429), fail(503), ok({ places: [{ id: "1" }] })]);
  const c = client({ fetchImpl });
  const hits = await c.searchText("q");
  assert.equal(hits.length, 1);
  assert.equal(c.stats.apiCalls, 3);
  assert.equal(c.stats.retries, 2);
});

test("gives up after five retries", async () => {
  const { fetchImpl } = stubFetch(Array.from({ length: 6 }, () => fail(500)));
  const c = client({ fetchImpl });
  await assert.rejects(c.searchText("q"), ApiError);
  assert.equal(c.stats.apiCalls, 6);
});

test("does not retry a bad key and marks it fatal", async () => {
  const { fetchImpl } = stubFetch([fail(400, "API key not valid. Please pass a valid API key.")]);
  const c = client({ fetchImpl });
  await assert.rejects(c.searchText("q"), (err) => err instanceof ApiError && err.fatal);
  assert.equal(c.stats.apiCalls, 1);
});

test("--max-calls stops before the request is sent", async () => {
  const { fetchImpl, calls } = stubFetch([ok({ places: [{ id: "1" }], nextPageToken: "t1" })]);
  const c = client({ fetchImpl, maxCalls: 1 });
  await assert.rejects(c.searchText("q"), MaxCallsError);
  assert.equal(calls.length, 1);
  assert.equal(c.stats.apiCalls, 1);
});

test("refetches page one when a cached page token has expired", async () => {
  const cache = memoryCache();
  await cache.set(cacheKey("q"), {
    textQuery: "q",
    pageToken: null,
    fetchedAt: "2026-01-01T00:00:00.000Z",
    response: { places: [{ id: "old" }], nextPageToken: "stale" },
  });
  const { fetchImpl } = stubFetch([
    fail(400, "Invalid page token"),
    ok({ places: [{ id: "1" }], nextPageToken: "fresh" }),
    ok({ places: [{ id: "2" }] }),
  ]);
  const c = client({ fetchImpl, cache });
  const hits = await c.searchText("q");
  assert.deepEqual(hits.map((h) => h.place.id), ["1", "2"]);
});

test("backoffDelay grows exponentially, is jittered and capped", () => {
  assert.equal(backoffDelay(0, 1000, 30000, () => 0), 500);
  assert.equal(backoffDelay(0, 1000, 30000, () => 1), 1000);
  assert.equal(backoffDelay(3, 1000, 30000, () => 1), 8000);
  assert.equal(backoffDelay(10, 1000, 30000, () => 1), 30000);
});
