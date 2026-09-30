import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config, mergeConfig, loadConfig, validateConfig, loadEnv, ConfigError } from "../src/config.js";

test("the default config is valid", () => {
  assert.doesNotThrow(() => validateConfig(config));
});

test("validateConfig reports every problem at once", () => {
  assert.throws(
    () => validateConfig({ ...config, towns: [], state: "", townAliases: { Nowhere: ["X"] } }),
    (err) =>
      err instanceof ConfigError &&
      /config\.towns/.test(err.message) &&
      /config\.state/.test(err.message) &&
      /Nowhere/.test(err.message)
  );
});

test("mergeConfig replaces area settings and merges api and sites key by key", () => {
  const merged = mergeConfig(config, {
    towns: ["Mysuru"],
    townAliases: { Mysuru: ["Mysore"] },
    api: { concurrency: 1 },
  });
  assert.deepEqual(merged.towns, ["Mysuru"]);
  assert.deepEqual(merged.townAliases, { Mysuru: ["Mysore"] });
  assert.equal(merged.api.concurrency, 1);
  assert.equal(merged.api.endpoint, config.api.endpoint);
  assert.equal(merged.state, config.state);
  assert.deepEqual(config.towns.includes("Mysuru"), false);
});

test("mergeConfig rejects settings it does not know", () => {
  assert.throws(() => mergeConfig(config, { twons: ["Mysuru"] }), ConfigError);
});

test("loadConfig uses defaults without a file and reports a broken one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "doctor-leads-"));
  try {
    assert.equal(loadConfig(path.join(dir, "missing.json")), config);

    const good = path.join(dir, "good.json");
    await writeFile(good, JSON.stringify({ towns: ["Mysuru"], state: "Karnataka" }));
    assert.deepEqual(loadConfig(good).towns, ["Mysuru"]);

    const bad = path.join(dir, "bad.json");
    await writeFile(bad, "{ towns: ");
    assert.throws(() => loadConfig(bad), ConfigError);

    const list = path.join(dir, "list.json");
    await writeFile(list, "[]");
    assert.throws(() => loadConfig(list), ConfigError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadEnv requires a real key", () => {
  assert.deepEqual(loadEnv({ GOOGLE_PLACES_API_KEY: " abc " }), { apiKey: "abc" });
  assert.throws(() => loadEnv({}), ConfigError);
  assert.throws(() => loadEnv({ GOOGLE_PLACES_API_KEY: "your-key-here" }), ConfigError);
});
