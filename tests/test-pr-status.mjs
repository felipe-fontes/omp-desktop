#!/usr/bin/env node
// Behavioral regression tests for the shared PR presentation model.
// Run: node tests/test-pr-status.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = {};
new Function("window", readFileSync(join(root, "src/app/pr-automation.js"), "utf8"))(win);
// eslint-disable-next-line no-new-func
new Function(
  "window",
  readFileSync(join(root, "src/app/pr-status.js"), "utf8"),
)(win);
const P = win.OMP_PR_STATUS;

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

const snapshot = (extra = {}) => ({
  isDraft: false,
  number: 42,
  url: "https://github.com/Owner/Repo/pull/42",
  title: "PR",
  repository: "Owner/Repo",
  branch: "feature",
  head: "abc123",
  additions: 2,
  deletions: 1,
  checks: [],
  failedChecks: [],
  threads: [],
  ...extra,
});
const status = (extra = {}, fields = {}) => ({
  snapshot: snapshot(extra),
  loading: false,
  discoveryError: null,
  ...fields,
});
const thread = (id) => ({ id, updatedAt: "2026-10-27T00:00:00Z" });
const failedCheck = (id) => ({ id });
const ci = (state, name = "check") => ({
  name, state, url: "https://github.com/checks/1",
});

check("no known PR, including an in-flight lookup, has no indicator", () => {
  assert.equal(P.present(null), null);
  assert.equal(P.present({ snapshot: null, loading: false }), null);
  assert.equal(P.present({ snapshot: null, loading: true }), null);
  assert.equal(P.aggregate([null, { snapshot: null, loading: true }]), null);
});

check("an open PR reports its identity and no-check state", () => {
  const model = P.present(status());
  assert.equal(model.glyph, "open");
  assert.equal(model.label, "Open");
  assert.equal(model.checksState, "none");
  assert.equal(model.description, "Open pull request #42; No checks");
  assert.equal(model.lifecycleDescription, "Open pull request #42 (Owner/Repo)");
  assert.equal(model.threadCount, 0);
});

check("individual checks project pending, completed and failed CI", () => {
  for (const [checks, expected, description] of [
    [[ci("queued")], "pending", /Checks pending/],
    [[ci("running")], "pending", /Checks pending/],
    [[ci("success")], "success", /Checks passed/],
    [[ci("neutral")], "unknown", /Check results unknown/],
  ]) {
    const model = P.present(status({ checks }));
    assert.equal(model.checksState, expected);
    assert.match(model.description, description);
  }
  const model = P.present(status({
    checks: [ci("running", "test"), ci("failure", "lint")],
    failedChecks: [failedCheck("f")],
  }));
  assert.equal(model.checksState, "pending");
  assert.equal(model.failedCount, 1);
  assert.equal(model.tone, "failure");
  assert.match(model.checksDescription, /Checks pending; 1 failed check/);
});

check("draft and ready PRs retain different shapes when CI fails", () => {
  for (const [isDraft, glyph, label] of [
    [false, "open", "Open"], [true, "draft", "Draft"],
  ]) {
    const model = P.present(status({
      isDraft, checks: [ci("failure")], failedChecks: [failedCheck("c1")],
    }));
    assert.equal(model.glyph, glyph);
    assert.equal(model.label, label);
    assert.equal(model.tone, "failure");
    assert.equal(model.failedCount, 1);
    assert.match(model.description, /1 failed check/);
  }
});

check("actionable review thread identities are deduplicated", () => {
  const model = P.present(status({ threads: [thread("one"), thread("one"), thread("two")] }));
  assert.equal(model.threadCount, 2);
  assert.match(model.description, /2 unresolved review threads/);
  assert.doesNotMatch(P.present(status()).description, /review thread/);
});

check("failed refreshes retain and label the last known PR", () => {
  const model = P.present(status({ checks: [ci("success")] }, { discoveryError: "GitHub offline" }));
  assert.equal(model.glyph, "open");
  assert.equal(model.stale, true);
  assert.match(model.lifecycleDescription, /Last known.*Open pull request #42/);
  assert.match(model.refreshDescription, /GitHub offline/);
  assert.match(model.description, /stale/i);
  assert.equal(P.present({ snapshot: null, loading: false, discoveryError: "Offline" }), null);
  assert.equal(P.present(status({ checks: [ci("running")] }, { loading: true })).stale, false);
});

check("duplicate PR reports deduplicate feedback and preserve draft and CI attention", () => {
  const first = status({
    repository: "Owner/Repo", checks: [ci("failure", "a"), ci("failure", "b")],
    failedChecks: [failedCheck("a"), failedCheck("b")],
    threads: [thread("x"), thread("y")],
  });
  const second = status({
    repository: "owner/repo", isDraft: true, checks: [ci("queued"), ci("failure", "a")],
    failedChecks: [failedCheck("a")], threads: [thread("x"), thread("y")],
  });
  const model = P.aggregate([first, second]);
  assert.equal(model.prCount, 1);
  assert.equal(model.glyph, "draft");
  assert.equal(model.tone, "failure");
  assert.equal(model.checksState, "failure");
  assert.equal(model.failedCount, 2);
  assert.equal(model.threadCount, 2);
  assert.deepEqual(P.aggregate([second, first]), model);
});

check("fresh duplicates supersede stale feedback while preserving error details", () => {
  const stale = status({
    checks: [ci("failure")], failedChecks: [failedCheck("old")], threads: [thread("old")],
  }, { discoveryError: "Refresh failed" });
  const fresh = status({ checks: [ci("success")], threads: [thread("current")] });
  const model = P.aggregate([stale, fresh]);
  assert.equal(model.tone, "open");
  assert.equal(model.checksState, "success");
  assert.equal(model.failedCount, 0);
  assert.equal(model.threadCount, 1);
  assert.equal(model.stale, true);
  assert.match(model.description, /Refresh failed/);
});

check("different PRs and settled no-PR members produce mixed groups", () => {
  const ready = status({ number: 42, repository: "owner/repo" });
  const draft = status({ number: 43, repository: "owner/repo", isDraft: true });
  const otherRepo = status({ number: 42, repository: "owner/other" });
  const model = P.aggregate([draft, ready, otherRepo]);
  assert.equal(model.prCount, 3);
  assert.equal(model.glyph, "mixed");
  assert.match(model.description, /Draft pull request #43/);
  assert.match(model.description, /owner\/other/);
  assert.deepEqual(P.aggregate([otherRepo, ready, draft]), model);
  const mixed = P.aggregate([ready, { snapshot: null, loading: false, discoveryError: null }]);
  assert.equal(mixed.glyph, "mixed");
  assert.equal(mixed.prCount, 1);
  assert.match(mixed.description, /1 conversation without a pull request/);
});

check("unsettled and errored members do not imply no PR", () => {
  const known = status();
  const unresolved = [null, undefined, {}, { loading: false }, { snapshot: null },
    { snapshot: null, loading: true, discoveryError: null }];
  assert.deepEqual(P.aggregate([known, ...unresolved]), P.present(known));
  const errored = P.aggregate([known, { snapshot: null, loading: false, discoveryError: "Offline" }]);
  assert.equal(errored.glyph, "open");
  assert.equal(errored.stale, true);
  assert.doesNotMatch(errored.description, /without a pull request/);
});

check("mixed PR attention combines failures, reviews and stale errors", () => {
  const failed = status({
    number: 1, checks: [ci("failure")], failedChecks: [failedCheck("f")],
    threads: [thread("a"), thread("shared")],
  });
  const pending = status({
    number: 2, checks: [ci("running")], threads: [thread("shared"), thread("b")],
  });
  const model = P.aggregate([pending, failed, { snapshot: null, discoveryError: "Offline" }]);
  assert.equal(model.glyph, "mixed");
  assert.equal(model.tone, "failure");
  assert.equal(model.checksState, "failure");
  assert.equal(model.failedCount, 1);
  assert.equal(model.threadCount, 3);
  assert.equal(model.stale, true);
  assert.match(model.description, /Checks pending/);
  assert.match(model.description, /Offline/);
});

check("presentation does not mutate canonical snapshots", () => {
  const input = [status({
    checks: [ci("failure")], failedChecks: [failedCheck("c")], threads: [thread("t")],
  })];
  const before = structuredClone(input);
  P.present(input[0]);
  P.aggregate(input);
  assert.deepEqual(input, before);
});

// Render the real JSX with a small hook stand-in. The tree and event handlers,
// rather than source text, are the contract under test.
const Babel = createRequire(import.meta.url)(join(root, "src/babel.min.js"));
const uiCode = ["pr-status.jsx", "pr-automation-card.jsx", "tab-group-chip.jsx"].map((file) =>
  Babel.transform(readFileSync(join(root, "src/design", file), "utf8"), { presets: ["react"] }).code,
);
function uiHarness() {
  const slots = [];
  let cursor = 0;
  const React = {
    Fragment: "fragment",
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    isValidElement: (value) => !!value && typeof value === "object" && "type" in value,
    cloneElement: (value, props) => ({ ...value, props: { ...value.props, ...props } }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next) => {
        slots[index] = typeof next === "function" ? next(slots[index]) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useId: () => "status-tooltip",
    useEffect: () => {},
  };
  const window = {
    OMP_PR_STATUS: P,
    OMP_PROJECT_NAV: { projectPath: (tab) => tab.workspace?.projectPath || tab.path },
    Icon: () => null,
    PrChecks: () => null,
    PrAutomationMenu: () => null,
    usePopoverDismiss: () => {},
    innerWidth: 1000,
    innerHeight: 700,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const document = { body: {}, addEventListener: () => {}, removeEventListener: () => {} };
  const ReactDOM = { createPortal: (element) => element };
  for (const code of uiCode) {
    runInNewContext(code, { window, document, React, ReactDOM, setTimeout, clearTimeout });
  }
  const render = (component, props) => {
    cursor = 0;
    const tree = component(props);
    for (const element of nodes(tree)) {
      if (element.props.ref) {
        element.props.ref.current = {
          getBoundingClientRect: () => ({ left: 20, right: 40, top: 30, bottom: 50 }),
        };
      }
    }
    return tree;
  };
  return { window, render };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object" || !tree.type) return [];
  return [tree, ...nodes(tree.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" ? text(tree.children) : "";
}
function byClass(tree, name) {
  return nodes(tree).find((element) => element.props.className?.split(" ").includes(name));
}
const cardStatus = (fields = {}) => ({
  snapshot: null, localChanges: null, localError: null, loading: false,
  discoveryError: null, enabled: false, status: "", ...fields,
});

check("identity and feedback modes render separate accessible semantic details", () => {
  const h = uiHarness();
  const model = P.present(status({
    checks: [ci("running"), ci("failure")], failedChecks: [failedCheck("f")], threads: [thread("one")],
  }, { discoveryError: "Network down" }));
  const icon = h.render(h.window.PrStatus, { model, mode: "icon" });
  assert.match(text(icon), /#42/);
  assert.equal(nodes(icon).filter((node) => node.type === h.window.StatusDetail).length, 1);
  const badges = h.render(h.window.PrStatus, { model, mode: "badges" });
  assert.doesNotMatch(text(badges), /#42/);
  assert.match(text(badges), /×1/);
  const details = nodes(badges).filter((node) => node.type === h.window.StatusDetail);
  assert.equal(details.length, 3);
  assert.ok(details.some((node) => /failed check/.test(node.props.text)));
  assert.ok(details.some((node) => /1 unresolved review thread/.test(node.props.text)));
  assert.equal(details.filter((node) => /Network down/.test(node.props.text)).length, 1);
  const mixed = P.aggregate([status({ number: 1 }), status({ number: 2 })]);
  assert.match(text(h.render(h.window.PrStatus, { model: mixed })), /2 PRs/);
  assert.equal(h.render(h.window.PrStatus, { status: { snapshot: null, discoveryError: "Offline" } }), null);
});

check("PR identity stays visible without badges for non-failing CI and no review feedback", () => {
  const h = uiHarness();
  for (const checks of [[], [ci("neutral")], [ci("queued")], [ci("running")], [ci("success")]]) {
    const model = P.present(status({ checks }));
    const full = h.render(h.window.PrStatus, { model });
    assert.ok(byClass(full, "pr-status-identity"));
    assert.equal(byClass(full, "pr-status-ci"), undefined);
    assert.equal(byClass(full, "pr-status-review"), undefined);
    const badges = h.render(h.window.PrStatus, { model, mode: "badges" });
    assert.equal(nodes(badges).filter(node => node.type === h.window.StatusDetail).length, 0);
    const withReview = h.render(h.window.PrStatus, {
      model: P.present(status({ checks, threads: [thread("review")] })),
    });
    assert.equal(byClass(withReview, "pr-status-ci"), undefined);
    assert.ok(byClass(withReview, "pr-status-review"));
  }
});

check("review detail preserves its button action", () => {
  const h = uiHarness();
  let opened = 0;
  const open = P.present(status({
    checks: [ci("failure")], failedChecks: [failedCheck("f")], threads: [thread("one")],
  }));
  const tree = h.render(h.window.PrStatus, { model: open, mode: "badges", onReview: () => opened++ });
  const review = byClass(tree, "pr-status-review");
  assert.equal(review.type, "button");
  assert.match(review.props["aria-label"], /1 unresolved review thread; open review discussion/);
  review.props.onClick();
  assert.equal(opened, 1);
  let action = h.render(h.window.StatusDetail, { text: "Open review discussion", children: review });
  assert.equal(action.props.tabIndex, undefined);
  action.props.onFocus();
  action = h.render(h.window.StatusDetail, { text: "Open review discussion", children: review });
  assert.equal(byClass(action, "pr-status-review").props["aria-describedby"], "status-tooltip");
  byClass(action, "pr-status-review").props.onClick();
  assert.equal(opened, 2);
});

check("status details show a portal on focus and isolate navigation gestures", () => {
  const h = uiHarness();
  const props = { text: "Full branch name", className: "branch", children: "main" };
  let detail = h.render(h.window.StatusDetail, props);
  assert.equal(detail.props.tabIndex, 0);
  assert.equal(detail.props["data-no-reorder"], true);
  assert.equal(detail.props.title, "");
  let stopped = 0, prevented = 0;
  const event = { stopPropagation: () => stopped++, preventDefault: () => prevented++, key: "Enter" };
  detail.props.onPointerDown(event);
  detail.props.onMouseDown(event);
  detail.props.onAuxClick(event);
  detail.props.onClick(event);
  detail.props.onDoubleClick(event);
  detail.props.onKeyDown(event);
  assert.equal(stopped, 6);
  assert.equal(prevented, 1);
  detail.props.onFocus();
  detail = h.render(h.window.StatusDetail, props);
  const tooltip = nodes(detail).find((node) => node.props.role === "tooltip");
  assert.equal(text(tooltip), "Full branch name");
  assert.equal(detail.props["aria-describedby"], tooltip.props.id);
  detail.props.onBlur();
  detail = h.render(h.window.StatusDetail, props);
  assert.equal(nodes(detail).some((node) => node.props.role === "tooltip"), false);
  detail.props.onMouseEnter();
  detail = h.render(h.window.StatusDetail, props);
  assert.equal(text(nodes(detail).find((node) => node.props.role === "tooltip")), "Full branch name");
  detail.props.onKeyDown({ key: "Escape", stopPropagation: () => stopped++ });
  detail = h.render(h.window.StatusDetail, props);
  assert.equal(nodes(detail).some((node) => node.props.role === "tooltip"), false);
});

check("worktree identity names the actual checkout without a branch icon", () => {
  const h = uiHarness();
  const tab = {
    path: "/worktrees/task", branch: "feature/task",
    workspace: { worktree: true, projectPath: "/projects/app", baseRef: "main" },
  };
  const detail = h.render(h.window.WorktreeIndicator, { tab });
  assert.equal(detail.type, h.window.StatusDetail);
  assert.equal(text(detail), "Worktree");
  assert.match(detail.props.text, /Source project: \/projects\/app/);
  assert.match(detail.props.text, /Working folder: \/worktrees\/task/);
  assert.match(detail.props.text, /Branch: feature\/task/);
  assert.match(detail.props.text, /Selected base: main/);
  assert.equal(nodes(detail).some((node) => node.type === h.window.Icon), false);
  assert.equal(h.render(h.window.WorktreeIndicator, { tab: { path: "/projects/app" } }), null);
});

check("local-only changes remain available without GitHub", () => {
  const h = uiHarness();
  let opened = 0;
  const tree = h.render(h.window.PrAutomationCard, {
    automation: cardStatus({ ghMissing: true, localChanges: { changed: 2 } }),
    bridge: {}, onOpenChanges: () => opened++,
  });
  assert.match(text(tree), /2 changed files/);
  assert.doesNotMatch(text(tree), /No open pull request/);
  byClass(tree, "pr-changes-local-link").props.onClick();
  assert.equal(opened, 1);
  const truncated = h.render(h.window.PrAutomationCard, {
    automation: cardStatus({ ghMissing: true, localChanges: { changed: 100, truncated: true } }),
    bridge: {},
  });
  assert.match(text(truncated), /At least 100 changed files/);
});

check("current PR uses the owner's CI progress component and action menu", () => {
  const h = uiHarness();
  const checks = [{ name: "test", state: "running", url: "https://github.com/checks/1" }];
  const props = {
    automation: cardStatus({ snapshot: snapshot({
      title: "Current PR", additions: 2, deletions: 1, checks,
    }) }),
    bridge: {},
  };
  let tree = h.render(h.window.PrAutomationCard, props);
  assert.match(text(tree), /Current PR/);
  const progress = nodes(tree).find((node) => node.type === h.window.PrChecks);
  assert.equal(progress.props.checks, checks);
  byClass(tree, "pr-changes-more").props.onClick();
  tree = h.render(h.window.PrAutomationCard, props);
  const menu = nodes(tree).find((node) => node.type === h.window.PrAutomationMenu);
  assert.equal(menu.props.automation, props.automation);
});

console.log(`pr-status: ${passed} checks passed`);
