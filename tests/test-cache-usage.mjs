#!/usr/bin/env node
// Regression script for src/app/cache-usage.js.
// Run: node tests/test-cache-usage.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({ console });
ctx.window = ctx;
vm.runInContext(
  readFileSync(join(root, "src/app/cache-usage.js"), "utf8"),
  ctx,
  { filename: "app/cache-usage.js" },
);
const { fromUsage, fromMessage, fromMessages } = ctx.OMP_CACHE_USAGE;
// The result is created in the vm realm, so compare plain objects.
const plain = (value) =>
  value === null ? null : JSON.parse(JSON.stringify(value));

let passed = 0;
function check(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`FAILED: ${label}`);
    throw err;
  }
  passed++;
}

check(
  "hit ratio weights prompt tokens, including writes but excluding output",
  () => {
    assert.deepEqual(
      plain(
        fromUsage({
          input: 100,
          output: 1000,
          cacheRead: 600,
          cacheWrite: 300,
          cost: { cacheRead: 0.006, cacheWrite: 0.015, total: 0.1 },
        }),
      ),
      {
        input: 100,
        output: 1000,
        cacheRead: 600,
        cacheWrite: 300,
        promptTokens: 1000,
        hitRate: 0.6,
        cost: { cacheRead: 0.006, cacheWrite: 0.015, total: 0.1 },
      },
    );
  },
);

check(
  "persisted Anthropic usage uses its raw token fields without inventing costs",
  () => {
    assert.deepEqual(
      plain(
        fromUsage({
          input_tokens: 40,
          output_tokens: 900,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        }),
      ),
      {
        input: 40,
        output: 900,
        cacheRead: 50,
        cacheWrite: 10,
        promptTokens: 100,
        hitRate: 0.5,
        cost: { cacheRead: null, cacheWrite: null, total: null },
      },
    );
  },
);

check("no cache counters means no data, not a miss", () => {
  for (const usage of [
    null,
    undefined,
    {},
    { input: 100, output: 3 },
    { cacheRead: -1, cacheWrite: NaN },
  ]) {
    assert.equal(fromUsage(usage), null);
  }
});

check(
  "a zero normalized read counter yields a zero-percent recorded read share",
  () => {
    assert.deepEqual(
      plain(fromUsage({ input: 20, output: 5, cacheRead: 0, cacheWrite: 80 })),
      {
        input: 20,
        output: 5,
        cacheRead: 0,
        cacheWrite: 80,
        promptTokens: 100,
        hitRate: 0,
        cost: { cacheRead: null, cacheWrite: null, total: null },
      },
    );
  },
);

check("zero prompt tokens have no defined hit ratio", () => {
  assert.deepEqual(
    plain(fromUsage({ input: 0, output: 10, cacheRead: 0, cacheWrite: 0 })),
    {
      input: 0,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      promptTokens: 0,
      hitRate: null,
      cost: { cacheRead: null, cacheWrite: null, total: null },
    },
  );
});

check("a missing or invalid prompt component never produces a ratio", () => {
  for (const usage of [
    { output: 5, cacheRead: 10, cacheWrite: 20 },
    { input: 2, output: 5, cacheRead: 10 },
    { input: 2, output: 5, cacheWrite: 20 },
    { input: -1, output: 5, cacheRead: 10, cacheWrite: 20 },
    { input: 2, output: 5, cacheRead: Infinity, cacheWrite: 20 },
    { input: 2, output: 5, cacheRead: 10, cacheWrite: "20" },
  ]) {
    const result = fromUsage(usage);
    assert.notEqual(result, null);
    assert.equal(result.promptTokens, null);
    assert.equal(result.hitRate, null);
  }
  assert.deepEqual(
    plain(
      fromUsage({
        input: -1,
        output: Infinity,
        cacheRead: 10,
        cacheWrite: NaN,
      }),
    ),
    {
      input: null,
      output: null,
      cacheRead: 10,
      cacheWrite: null,
      promptTokens: null,
      hitRate: null,
      cost: { cacheRead: null, cacheWrite: null, total: null },
    },
  );
});

check("nonfinite sums are not reported as prompt totals or ratios", () => {
  const result = fromUsage({
    input: Number.MAX_VALUE,
    cacheRead: Number.MAX_VALUE,
    cacheWrite: 0,
  });
  assert.equal(result.promptTokens, null);
  assert.equal(result.hitRate, null);
});

check(
  "zero costs are retained and unavailable or invalid costs stay unknown",
  () => {
    assert.deepEqual(
      plain(
        fromUsage({
          cacheRead: 0,
          cost: { cacheRead: 0, cacheWrite: -1, total: Infinity },
        }),
      ).cost,
      { cacheRead: 0, cacheWrite: null, total: null },
    );
    assert.deepEqual(
      plain(fromUsage({ cacheWrite: 0, cost: { cacheWrite: 0, total: 0 } }))
        .cost,
      { cacheRead: null, cacheWrite: 0, total: 0 },
    );
  },
);

const assistant = (
  usage,
  timestamp,
  content = [{ type: "text", text: "reply" }],
) => ({ role: "assistant", usage, timestamp, content });
const rawUsage = (read) => ({
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: 0,
});

check(
  "the latest assistant can be tool-call-only; user and tool results are ignored",
  () => {
    const result = fromMessages([
      assistant(rawUsage(20), 1),
      { role: "user", timestamp: 2, usage: rawUsage(999) },
      assistant(rawUsage(90), 3, [
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      ]),
      { role: "toolResult", timestamp: 4, usage: rawUsage(999) },
    ]);
    assert.equal(result.usage.cacheRead, 90);
    assert.equal(result.usage.promptTokens, 100);
    assert.equal(result.usage.hitRate, 0.9);
  },
);

check(
  "unreported latest usage retains its provider, not an earlier provider's metrics",
  () => {
    const report = fromMessages([
      {
        ...assistant(rawUsage(90), 1),
        provider: "anthropic",
        model: "previous-model",
      },
      {
        ...assistant(undefined, 2),
        provider: "google",
        model: "current-request-model",
      },
    ]);
    assert.equal(report.usage, null);
    assert.equal(report.source, "missing");
    assert.equal(report.provider, "google");
    assert.equal(report.model, "current-request-model");
  },
);

check("transcript order wins over out-of-order timestamps", () => {
  const result = fromMessages([
    assistant(rawUsage(10), 500),
    assistant(rawUsage(30), 100),
  ]);
  assert.equal(result.usage.cacheRead, 30);
  assert.equal(result.usage.promptTokens, 40);
  assert.equal(result.usage.hitRate, 0.75);
});

check("empty and assistant-free transcripts have no cache usage", () => {
  assert.equal(fromMessages([]), null);
  assert.equal(fromMessages(null), null);
  assert.equal(
    fromMessages([
      { role: "user", usage: rawUsage(90) },
      { role: "toolResult" },
    ]),
    null,
  );
});

check(
  "custom providers expose normalized cache usage without an allowlist",
  () => {
    const report = fromMessage({
      role: "assistant",
      provider: "custom-gateway",
      model: "custom-model",
      usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0 },
    });
    assert.equal(report.source, "omp");
    assert.equal(report.usage.hitRate, 0.9);
    assert.equal(report.provider, "custom-gateway");
    assert.equal(report.model, "custom-model");
  },
);

check(
  "unrecognized cache metadata identifies a desktop format gap, not provider support",
  () => {
    const report = fromMessage({
      role: "assistant",
      provider: "future-provider",
      model: "future-model",
      usage: {
        custom_stats: { cached_prefix_tokens: 75 },
        cost: { cacheRead: 1 },
      },
    });
    assert.equal(report.source, "unrecognized");
    assert.equal(report.usage, null);
    assert.deepEqual(Array.from(report.fields), [
      "custom_stats.cached_prefix_tokens",
    ]);
  },
);

check(
  "zero counters are recorded usage while null counters remain unavailable",
  () => {
    const recorded = fromMessage({
      role: "assistant",
      usage: { input: 20, cacheRead: 0, cacheWrite: 0 },
    });
    const missing = fromMessage({
      role: "assistant",
      usage: {
        input: 20,
        cacheRead: null,
        cacheWrite: null,
        cost: { cacheRead: 1 },
      },
    });
    assert.equal(recorded.source, "omp");
    assert.equal(recorded.usage.hitRate, 0);
    assert.equal(missing.source, "missing");
    assert.equal(missing.usage, null);
    assert.deepEqual(Array.from(missing.fields), []);
  },
);

console.log(`cache-usage: ${passed} checks passed`);
