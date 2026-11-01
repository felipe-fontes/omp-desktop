#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const window = {};
for (const name of ["evidence-model", "evidence-proof"])
  new Function(
    "window",
    readFileSync(new URL(`../src/app/${name}.js`, import.meta.url), "utf8"),
  )(window);
const M = window.OMP_EVIDENCE_MODEL;
const P = window.OMP_EVIDENCE_PROOF;
const fp = (dirtyDigest = null) => ({
  complete: true,
  head: "abc",
  dirtyDigest,
});
const asset = (id = "output") => ({
  id,
  mime: "text/plain",
  name: "result.txt",
});
function fixture() {
  const view = M.initial();
  const requirement = {
    id: "criterion",
    text: "Export contains exactly the filtered orders",
    kind: "test",
    required: true,
    revision: 1,
  };
  const outcome = {
    id: "goal",
    title: "Export respects filters",
    requirements: [requirement],
  };
  view.outcomes.push(outcome);
  view.currentFingerprint = fp();
  return { view, outcome, requirement };
}
function proof(fields = {}) {
  return {
    id: "proof",
    outcomeId: "goal",
    requirementId: "criterion",
    requirementRevision: 1,
    title: "Filtered export",
    kind: "test",
    result: "passed",
    summary: "Compared exported order IDs",
    finding: {
      expected: "Only orders 4 and 7",
      observed: "CSV contains orders 4 and 7",
    },
    artifact: asset(),
    source: { type: "agent" },
    fingerprint: fp(),
    review: { decision: "unreviewed" },
    at: "2026-10-30T12:00:00Z",
    ...fields,
  };
}

test("command completion without a behavioral comparison cannot demonstrate a goal", () => {
  const { view, outcome } = fixture();
  view.receipts.push({
    id: "receipt",
    exitCode: 0,
    isError: false,
    preview: "command complete",
  });
  view.records.push(
    proof({
      finding: undefined,
      artifact: null,
      source: { type: "agent", receiptId: "receipt" },
      beforeFingerprint: fp(),
    }),
  );
  const goal = P.goal(view, outcome);
  assert.equal(goal.demonstrated, false);
  assert.equal(goal.criteria[0].demonstrated, false);
  assert.equal(goal.gaps[0].recordId, "proof");
  assert.equal(goal.best.check.state, "passed");
});

test("a scoped current finding has proof without implying acceptance or a review obligation", () => {
  const { view, outcome } = fixture();
  view.records.push(proof());
  const goal = P.goal(view, outcome);
  assert.equal(goal.demonstrated, true);
  assert.equal(goal.demonstratedCount, 1);
  assert.equal(goal.best.review.state, "unreviewed");
  assert.equal(goal.reviewRequested, false);
  assert.equal(P.summary(view).demonstrated, 1);
  assert.equal(view.records[0].review.decision, "unreviewed");
});

test("an observed artifact and a claimed pass without inspectable support both leave a gap", () => {
  const { view, outcome } = fixture();
  view.records.push(proof({ result: "observed" }));
  assert.equal(P.goal(view, outcome).demonstrated, false);
  view.records[0] = proof({ artifact: null });
  const goal = P.goal(view, outcome);
  assert.equal(goal.demonstrated, false);
  assert.equal(goal.criteria[0].state, "available");
  assert.equal(goal.gaps[0].requirementId, "criterion");
});

test("later current proof is primary but cannot erase unresolved failed history", () => {
  const { view, outcome } = fixture();
  view.records.push(
    proof({
      id: "failed",
      result: "failed",
      reason: "Order 9 leaked into the CSV",
    }),
    proof({ id: "current" }),
  );
  const goal = P.goal(view, outcome);
  assert.equal(goal.best.record.id, "current");
  assert.equal(goal.state, "attention");
  assert.equal(goal.demonstrated, false);
  assert.deepEqual(
    goal.gaps.map((gap) => gap.recordId),
    ["failed"],
  );
});

test("mixed-revision proof identifies the outdated capture while retaining the current finding", () => {
  const { view, outcome } = fixture();
  view.records.push(
    proof({ id: "old", fingerprint: fp("old") }),
    proof({ id: "current" }),
  );
  const goal = P.goal(view, outcome);
  assert.equal(goal.state, "attention");
  assert.equal(goal.best.record.id, "current");
  assert.equal(goal.best.freshness.state, "current");
  assert.equal(goal.gaps[0].recordId, "old");
  assert.equal(goal.gaps[0].state, "stale");
});

test("explicitly rejected history remains inspectable without blocking applicable later proof", () => {
  const { view, outcome } = fixture();
  view.records.push(
    proof({
      id: "wrong-project",
      result: "failed",
      review: { decision: "rejected", reason: "Wrong project" },
    }),
    proof({ id: "current" }),
  );
  const goal = P.goal(view, outcome);
  assert.equal(goal.demonstrated, true);
  assert.equal(
    goal.records.find((item) => item.record.id === "wrong-project").review
      .state,
    "rejected",
  );
  assert.equal(goal.gaps.length, 0);
});

test("scope removal and accepted exceptions never become demonstrated requirements", () => {
  const { view, outcome, requirement } = fixture();
  view.records.push(proof());
  requirement.waiver = {
    actor: "user",
    reason: "Explicitly excluded from this release",
  };
  assert.equal(P.goal(view, outcome).demonstrated, false);
  assert.equal(P.goal(view, outcome).criteria[0].exception, true);
  assert.equal(P.summary(view).exceptions, 1);
  requirement.retired = true;
  const goal = P.goal(view, outcome);
  assert.equal(goal.demonstrated, false);
  assert.equal(goal.criteria.length, 0);
  assert.equal(goal.best, null);
  assert.equal(goal.removedCount, 1);
  assert.equal(P.summary(view).removed, 1);
  assert.equal(view.records[0].id, "proof");
});

test("a review request is explicit and acceptance does not refresh old proof", () => {
  const { view, outcome } = fixture();
  view.records.push(proof({ reviewRequested: true }));
  assert.equal(P.goal(view, outcome).reviewRequested, true);
  assert.equal(P.summary(view).reviewRequested, 1);
  view.records[0].review = { decision: "accepted" };
  view.currentFingerprint = fp("changed");
  const goal = P.goal(view, outcome);
  assert.equal(goal.reviewRequested, false);
  assert.equal(goal.best.review.state, "accepted");
  assert.equal(goal.best.freshness.state, "stale");
  assert.equal(goal.demonstrated, false);
});

test("unlinked goal proof cannot silently satisfy a criterion or another goal", () => {
  const { view, outcome } = fixture();
  view.records.push(proof({ requirementId: null, requirementRevision: null }));
  assert.equal(P.goal(view, outcome).demonstrated, false);
  assert.equal(P.goal(view, outcome).criteria[0].records.length, 0);
  view.records[0] = proof({ outcomeId: "another-goal" });
  assert.equal(P.goal(view, outcome).best, null);
  assert.equal(P.goal(view, outcome).demonstrated, false);
});

test("known artifact load failures create an actionable gap without mutating the ledger", () => {
  const { view, outcome } = fixture();
  view.records.push(proof());
  const options = { unavailableArtifactIds: new Set(["output"]) };
  const goal = P.goal(view, outcome, options);
  assert.equal(goal.state, "attention");
  assert.equal(goal.gaps[0].recordId, "proof");
  assert.equal(view.records[0].result, "passed");
  assert.equal(P.goal(view, outcome).demonstrated, true);
});

test("linked execution captures participate in availability and missing receipts stay explicit", () => {
  const { view, outcome } = fixture();
  const image = { ...asset("receipt-image"), mime: "image/png" };
  view.receipts.push({
    id: "receipt",
    isError: false,
    exitCode: 0,
    artifact: image,
  });
  view.records.push(
    proof({
      artifact: null,
      source: { type: "agent", receiptId: "receipt" },
      beforeFingerprint: fp(),
    }),
  );
  assert.equal(P.goal(view, outcome).best.artifact.id, "receipt-image");
  const options = { unavailableArtifactIds: new Set(["receipt-image"]) };
  assert.equal(P.goal(view, outcome, options).state, "attention");
  view.receipts = [];
  assert.equal(P.goal(view, outcome).state, "attention");
});

test("unknown source and changed criteria cannot inherit a current comparison", () => {
  const { view, outcome, requirement } = fixture();
  view.records.push(proof());
  view.currentFingerprint = null;
  assert.equal(P.goal(view, outcome).best.freshness.state, "unknown");
  assert.equal(P.goal(view, outcome).demonstrated, false);
  view.currentFingerprint = fp();
  requirement.revision++;
  assert.equal(P.goal(view, outcome).demonstrated, false);
  assert.equal(P.goal(view, outcome).best.freshness.state, "stale");
});

test("outcome-level failures remain goal gaps and retired captures never become primary proof", () => {
  const { view, outcome, requirement } = fixture();
  view.records.push(
    proof(),
    proof({
      id: "unscoped-failure",
      requirementId: null,
      requirementRevision: null,
      result: "failed",
      reason: "Export did not finish",
    }),
  );
  assert.equal(P.goal(view, outcome).state, "attention");
  assert.equal(P.goal(view, outcome).gaps[0].recordId, "unscoped-failure");
  requirement.retired = true;
  assert.equal(
    P.goal(view, outcome).records.some((item) => item.record.id === "proof"),
    false,
  );
  assert.equal(
    view.records.some((item) => item.id === "proof"),
    true,
  );
});

test("missing optional proof does not block required behavior or demand user review", () => {
  const { view, outcome } = fixture();
  outcome.requirements.push({
    id: "optional",
    text: "Large export",
    kind: "test",
    required: false,
    revision: 1,
  });
  view.records.push(proof());
  const goal = P.goal(view, outcome);
  assert.equal(goal.demonstrated, true);
  assert.equal(goal.gaps.length, 0);
  assert.equal(goal.reviewRequested, false);
});

test("references and output-less executions never count as behavioral proof", () => {
  const { view, outcome } = fixture();
  view.receipts.push({ id: "empty", exitCode: 0, isError: false, preview: "" });
  for (const fields of [
    { fileRef: { path: "/nonexistent.csv" } },
    { url: "https://example.invalid/unfetched-output" },
    { source: { type: "agent", receiptId: "empty" }, beforeFingerprint: fp() },
  ]) {
    view.records = [proof({ artifact: null, ...fields })];
    assert.equal(P.goal(view, outcome).demonstrated, false);
    assert.equal(P.goal(view, outcome).criteria[0].demonstrated, false);
  }
  view.receipts[0].preview = "Compared exported IDs: exactly 4 and 7";
  assert.equal(P.goal(view, outcome).demonstrated, true);
});

test("rejected proof remains an explicit gap when only a weaker observation remains", () => {
  const { view, outcome, requirement } = fixture();
  view.records.push(
    proof({ id: "observation", result: "observed" }),
    proof({
      id: "rejected",
      at: "2026-10-30T12:01:00Z",
      reviewRequested: true,
      review: {
        decision: "rejected",
        reason: "The recording omits the resulting state",
      },
    }),
  );
  const criterion = P.criterion(view, outcome, requirement);
  const goal = P.goal(view, outcome);
  assert.equal(criterion.state, "attention");
  assert.equal(goal.state, "attention");
  assert.equal(goal.demonstrated, false);
  assert.equal(goal.reviewRequested, false);
  assert.equal(goal.records.length, 2);
  assert.equal(goal.gaps[0].recordId, "rejected");
  assert.equal(goal.gaps[0].state, "rejected");
  assert.ok(
    goal.gaps[0].text.includes("The recording omits the resulting state"),
  );
});

test("resetting an explicit rejection restores applicable proof without changing the capture", () => {
  const { view, outcome } = fixture();
  const rejected = proof({
    review: { decision: "rejected", reason: "Inspect again" },
  });
  view.records.push(rejected);
  assert.equal(P.goal(view, outcome).gaps[0].recordId, rejected.id);
  rejected.review = { decision: "unreviewed" };
  assert.equal(P.goal(view, outcome).demonstrated, true);
  assert.equal(P.goal(view, outcome).gaps.length, 0);
  assert.equal(rejected.artifact.id, "output");
});
