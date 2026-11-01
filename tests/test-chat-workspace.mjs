#!/usr/bin/env node
// Exercise the real JSX with a small React stand-in, as in test-browser-runtime.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const Babel = require("../src/babel.min.js");
const source = readFileSync(new URL("../src/design/chat-workspace.jsx", import.meta.url), "utf8");
const compiled = Babel.transform(source, { presets: ["react"] }).code;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness({ tabs = [], bridge: overrides = {} } = {}) {
  const slots = [];
  let index = 0;
  let effects = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) }; },
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = { value: initial };
      return [slots[slot].value, value => { slots[slot].value = typeof value === "function" ? value(slots[slot].value) : value; }];
    },
    useRef(initial) { const slot = index++; return slots[slot] ??= { current: initial }; },
    useEffect(fn, deps) {
      const slot = index++;
      if (!slots[slot] || deps.some((v, i) => !Object.is(v, slots[slot].deps[i]))) {
        effects.push(() => { slots[slot]?.cleanup?.(); slots[slot] = { deps, cleanup: fn() }; });
      }
    },
  };
  const calls = [];
  const bridge = {
    scratchFiles: async () => [{ path: "work/report.txt", bytes: 42 }],
    scratchUsage: async () => ({ bytes: 42, files: 1, complete: true }),
    exportScratchFile: async (...args) => { calls.push(["export", ...args]); return true; },
    promoteChat: async (...args) => { calls.push(["promote", ...args]); return "new-tab"; },
    deleteChat: async (...args) => { calls.push(["delete", ...args]); },
    ...overrides,
  };
  const listeners = new Map();
  const window = {
    Icon: () => null, OMP_UPDATER: { formatBytes: n => `${n} B` },
    OMP_TURN_STATUS: { isBusyRunState: s => s === "running" },
    useModalFocus() {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  runInNewContext(compiled, { window, React, document: {} });
  let closed = 0, changed = 0;
  const props = { chat: { id: "chat-1", name: "My chat" }, tabs, activeId: "tab-1", voiceActive: false, bridge,
    onClose: () => { closed++; }, onChanged: () => { changed++; } };
  const render = () => {
    index = 0; effects = [];
    const tree = window.ChatWorkspace(props);
    for (const effect of effects) effect();
    return tree;
  };
  const all = tree => {
    const result = [];
    const visit = node => { if (!node || typeof node !== "object") return; result.push(node); node.children?.forEach(visit); };
    visit(tree);
    return result;
  };
  const text = node => typeof node === "string" ? node : (node?.children || []).map(text).join("");
  const button = (tree, label) => all(tree).find(n => n.type === "button" && (n.props["aria-label"] === label || text(n) === label));
  return { render, all, text, button, props, calls, listeners, closed: () => closed, changed: () => changed };
}

test("closed workspace lists usage and exports a chosen relative file", async () => {
  const h = harness();
  h.render(); await flush();
  let tree = h.render();
  assert.match(h.text(tree), /42 B · 1 regular file/);
  assert.match(h.text(tree), /Closing a chat tab keeps its workspace/);
  await h.button(tree, "Export work/report.txt").props.onClick();
  assert.deepEqual(h.calls, [["export", "chat-1", "work/report.txt"]]);
  tree = h.render();
  assert.match(h.text(tree), /Exported work\/report.txt/);
});

test("deletion requires a closed tab and explicit second confirmation", async () => {
  const h = harness({ tabs: [{ id: "tab-1", scratchId: "chat-1", name: "My chat", runState: "idle" }] });
  h.render(); await flush();
  let tree = h.render();
  assert.equal(h.button(tree, "delete workspace…").props.disabled, true);
  h.props.tabs = [];
  tree = h.render();
  h.button(tree, "delete workspace…").props.onClick();
  tree = h.render();
  assert.deepEqual(h.calls, []);
  await h.button(tree, "delete workspace permanently").props.onClick();
  assert.deepEqual(h.calls, [["delete", "chat-1"]]);
  assert.equal(h.changed(), 1);
  assert.equal(h.closed(), 1);
});

test("busy chats cannot export, promote or delete; incomplete scans are identified", async () => {
  const h = harness({ tabs: [{ id: "tab-1", scratchId: "chat-1", runState: "running" }], bridge: {
    scratchUsage: async () => ({ bytes: 100, files: 2, complete: false }),
  } });
  h.render(); await flush();
  const tree = h.render();
  assert.match(h.text(tree), /At least 100 B · 2 regular files \(scan incomplete\)/);
  assert.equal(h.button(tree, "Export work/report.txt").props.disabled, true);
  assert.equal(h.button(tree, "promote to project…").props.disabled, true);
  assert.equal(h.button(tree, "delete workspace…").props.disabled, true);
  await h.button(tree, "promote to project…").props.onClick();
  assert.deepEqual(h.calls, []);
});

test("promotion cancellation keeps the manager open; successful copy closes it", async () => {
  let result = null;
  const h = harness({ bridge: { promoteChat: async () => result } });
  h.render(); await flush();
  await h.button(h.render(), "promote to project…").props.onClick();
  assert.equal(h.closed(), 0);
  result = "new-tab";
  await h.button(h.render(), "promote to project…").props.onClick();
  assert.equal(h.closed(), 1);
  assert.equal(h.changed(), 2);
});

test("file scan failure is visible without inventing an empty workspace", async () => {
  const h = harness({ bridge: { scratchFiles: async () => { throw new Error("scan limit exceeded"); } } });
  h.render(); await flush();
  const tree = h.render();
  assert.match(h.text(tree), /Could not list files: scan limit exceeded/);
  assert.doesNotMatch(h.text(tree), /No regular files in this workspace/);
});

test("Escape closes the workspace manager without reaching the app keymap", () => {
  const h = harness();
  h.render();
  const event = { key: "Escape", prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  h.listeners.get("keydown")(event);
  assert.equal(h.closed(), 1);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test("active voice disables workspace actions even when the turn is idle", async () => {
  const h = harness({ tabs: [{ id: "tab-1", scratchId: "chat-1", runState: "idle" }] });
  h.props.voiceActive = true;
  h.render(); await flush();
  const tree = h.render();
  assert.equal(h.button(tree, "Export work/report.txt").props.disabled, true);
  assert.equal(h.button(tree, "promote to project…").props.disabled, true);
});
