#!/usr/bin/env node
// Exercise the real chat and message-action JSX with the real paging and pin
// helpers. The small React/DOM stand-in models commits, not browser layout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const Babel = createRequire(import.meta.url)(fileURLToPath(new URL("../src/babel.min.js", import.meta.url)));
const compile = path => Babel.transform(source(path), { presets: ["react"] }).code;
const chatCode = compile("src/design/chat/chat-view.jsx");
const actionCode = compile("src/design/chat/message-actions.jsx");

// Slots follow hook call order, and changed effects clean up before re-running.
// A commit attaches refs before layout effects, then runs passive effects;
// state updates schedule another commit, rather than rendering inside a setter.
function reactHarness() {
  const slots = [];
  let cursor = 0, dirty = false, layout = [], effects = [], tree = null;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const React = {
    Fragment: Symbol("Fragment"),
    memo: component => component,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[index];
      return [slot.value, value => {
        const next = typeof value === "function" ? value(slot.value) : value;
        if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; return (slots[index] ??= { current: initial }); },
    useMemo(fn, deps) {
      const index = cursor++;
      if (!slots[index] || changed(slots[index].deps, deps)) slots[index] = { deps, value: fn() };
      return slots[index].value;
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) { queueEffect(effects, fn, deps); },
    useLayoutEffect(fn, deps) { queueEffect(layout, fn, deps); },
  };
  function queueEffect(queue, fn, deps) {
    const index = cursor++, previous = slots[index];
    if (!previous || changed(previous.deps, deps)) queue.push(() => {
      previous?.cleanup?.();
      slots[index] = { deps, cleanup: fn() };
    });
  }
  function commit(render, attach = () => {}) {
    let iterations = 0;
    do {
      assert.ok(++iterations <= 20, "render updates must settle");
      dirty = false;
      cursor = 0;
      layout = [];
      effects = [];
      tree = render();
      attach(tree);
      for (const run of layout) run();
      for (const run of effects) run();
    } while (dirty);
    return tree;
  }
  function unmount() { for (const slot of slots) slot?.cleanup?.(); }
  return { React, commit, unmount, get tree() { return tree; } };
}

function nodes(root, predicate) {
  const matches = [];
  function visit(node) {
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (!node || typeof node !== "object") return;
    if (predicate(node)) matches.push(node);
    for (const child of node.children ?? []) visit(child);
  }
  visit(root);
  return matches;
}
const byClass = (tree, name) => nodes(tree, node => node.props?.className?.split(" ").includes(name));
const buttons = tree => nodes(tree, node => node.type === "button");
function click(button) {
  assert.ok(button && !button.props.disabled, "control must be enabled");
  button.props.onClick();
}

function chatHarness(messages) {
  const h = reactHarness();
  const window = {
    UserBubble() {}, AssistantBubble() {}, ToolCard() {}, AskBubble() {},
    RetryRow() {}, GoalRow() {}, ApprovalRow() {}, Icon() {}, TOOL_META: {},
    OMP_TURN_STATUS: { isHidden: () => false },
    matchMedia: () => ({ matches: false }),
  };
  const scope = { window, React: h.React, ResizeObserver: class { observe() {} disconnect() {} } };
  for (const file of ["src/app/conversation-navigation.js", "src/app/scroll-pin.js", "src/app/chat-collapse.js"]) {
    runInNewContext(source(file), scope);
  }
  runInNewContext(chatCode, scope);
  let props = { messages, foldModes: { thinking: "open", tool: "open" }, collapseOverrides: {} };
  let top = 0;
  const scrolls = [];
  const scroll = {
    scrollHeight: 10000, clientHeight: 400,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    querySelector(selector) {
      const match = /^\[data-msg-idx="(\d+)"\]$/.exec(selector);
      const index = match && Number(match[1]);
      if (!match || !rendered().some(node => node.props.idx === index)) return null;
      return { scrollIntoView: options => scrolls.push({ index, block: options.block }) };
    },
  };
  const rendered = () => nodes(h.tree, node => node.type === window.UserBubble || node.type === window.AssistantBubble);
  const ids = () => rendered().map(node => node.props.msg._id);
  const render = () => h.commit(() => window.ChatView(props), tree => {
    const [viewport] = byClass(tree, "chat-scroll");
    viewport.props.ref.current = scroll;
  });
  render();
  return {
    get tree() { return h.tree; }, ids, scroll, scrolls, render,
    update(next) { props = { ...props, ...next }; render(); },
    pageButton(direction) {
      const [pager] = byClass(h.tree, "chat-history-page");
      return buttons(pager)[direction < 0 ? 0 : 1];
    },
    unmount: h.unmount,
  };
}

const history = (length = 420, userIndex = 12) => Array.from({ length }, (_, i) => ({
  _id: `message-${i}`, kind: i === userIndex ? "user" : "assistant",
}));
const idRange = (start, end) => Array.from({ length: end - start }, (_, i) => `message-${start + i}`);

test("chat pages a long transcript in both directions without losing messages", () => {
  const ui = chatHarness(history());
  assert.deepEqual(ui.ids(), idRange(260, 420));
  assert.equal(ui.pageButton(1).props.disabled, true);
  const seenEarlier = new Set(ui.ids());
  while (!ui.pageButton(-1).props.disabled) {
    const before = ui.ids();
    click(ui.pageButton(-1));
    ui.render();
    const after = ui.ids();
    assert.ok(after.length <= 160);
    assert.ok(after.some(id => before.includes(id)) || after.at(-1) === `message-${Number(before[0].slice(8)) - 1}`);
    assert.equal(ui.scrolls.at(-1).index, Number(after[0].slice(8)));
    for (const id of after) seenEarlier.add(id);
  }
  assert.deepEqual(ui.ids(), idRange(0, 160));
  assert.equal(seenEarlier.size, 420);
  for (const id of idRange(0, 420)) assert.ok(seenEarlier.has(id), `earlier pages must include ${id}`);
  const seenLater = new Set(ui.ids());
  while (!ui.pageButton(1).props.disabled) {
    const before = ui.ids();
    click(ui.pageButton(1));
    ui.render();
    const after = ui.ids();
    assert.equal(Number(after[0].slice(8)), Number(before.at(-1).slice(8)) + 1);
    assert.equal(ui.scrolls.at(-1).index, Number(after[0].slice(8)));
    assert.equal(ui.scrolls.at(-1).block, "start");
    for (const id of after) seenLater.add(id);
  }
  assert.equal(seenLater.size, 420);
  for (const id of idRange(0, 420)) assert.ok(seenLater.has(id), `later pages must include ${id}`);
  ui.unmount();
});

test("last user and external minimap requests reveal and scroll to old messages", () => {
  const ui = chatHarness(history());
  assert.ok(!ui.ids().includes("message-12"));
  click(byClass(ui.tree, "chat-jump-user")[0]);
  ui.render();
  assert.ok(ui.ids().includes("message-12"));
  assert.equal(ui.scrolls.at(-1).index, 12);
  assert.equal(ui.scrolls.at(-1).block, "center");
  assert.ok(!ui.ids().includes("message-300"));
  ui.update({ scrollRequest: { id: "message-300" } });
  assert.ok(ui.ids().includes("message-300"));
  assert.equal(ui.scrolls.at(-1).index, 300);
  ui.update({ scrollRequest: { id: "message-4" } });
  assert.ok(ui.ids().includes("message-4"));
  assert.equal(ui.scrolls.at(-1).index, 4);
  const count = ui.scrolls.length;
  ui.update({ scrollRequest: { id: "message-4" } });
  assert.equal(ui.scrolls.length, count + 1, "a repeated request still scrolls");
  assert.equal(ui.scrolls.at(-1).index, 4);
  const page = ui.ids();
  ui.update({ scrollRequest: { id: "missing-message" } });
  assert.deepEqual(ui.ids(), page);
  assert.equal(ui.scrolls.length, count + 1, "an unknown target must not scroll");
  ui.unmount();
});

test("manual unpinning keeps the page being read as live output grows", () => {
  const messages = history();
  const ui = chatHarness(messages);
  const initial = ui.ids();
  ui.scroll.scrollTop = 9000;
  byClass(ui.tree, "chat-scroll")[0].props.onScroll();
  ui.render();
  assert.ok(byClass(ui.tree, "chat-jump-latest").length);
  ui.update({ messages: [...messages, ...idRange(420, 460).map(_id => ({ _id, kind: "assistant" }))] });
  assert.deepEqual(ui.ids(), initial, "new output must not evict the message at the top of the page");
  assert.equal(ui.scroll.scrollTop, 9000, "unpinning keeps the reader's scroll position");
  click(byClass(ui.tree, "chat-jump-latest")[0]);
  ui.render();
  assert.deepEqual(ui.ids(), idRange(300, 460));
  assert.equal(ui.scroll.scrollTop, ui.scroll.scrollHeight - ui.scroll.clientHeight);
  assert.equal(byClass(ui.tree, "chat-jump-latest").length, 0);
  ui.unmount();
});

function actionHarness(overrides = {}) {
  const h = reactHarness();
  const frames = [];
  let focusCount = 0;
  const window = { Icon() {} };
  runInNewContext(actionCode, { window, React: h.React, requestAnimationFrame: fn => frames.push(fn) });
  let props = { entryId: "saved-entry", ...overrides };
  const render = () => h.commit(() => window.MessageActions(props), tree => {
    for (const node of nodes(tree, n => n.type === "button" && n.props.ref)) {
      node.props.ref.current = { focus() { focusCount++; } };
    }
  });
  render();
  return {
    get tree() { return h.tree; }, render,
    update(next) { props = { ...props, ...next }; render(); },
    primary() { return buttons(byClass(h.tree, "message-actions-buttons")[0]); },
    confirmation() { return nodes(h.tree, node => node.props?.role === "group")[0]; },
    frame() { while (frames.length) frames.shift()(); },
    get focusCount() { return focusCount; },
    unmount: h.unmount,
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("rewind is confirmed and cancellation or Escape never moves the conversation", () => {
  const calls = [];
  const ui = actionHarness({ onRewind: id => { calls.push(id); return { ok: true }; }, onFork: () => ({ ok: true }) });
  click(ui.primary()[0]);
  ui.render();
  assert.ok(ui.confirmation());
  assert.deepEqual(calls, []);
  assert.ok(ui.primary().every(button => button.props.disabled));
  click(buttons(ui.confirmation())[0]);
  ui.render();
  ui.frame();
  assert.equal(ui.confirmation(), undefined);
  assert.equal(ui.focusCount, 1);
  assert.deepEqual(calls, []);
  click(ui.primary()[0]);
  ui.render();
  let prevented = false, stopped = false;
  ui.tree.props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  ui.render();
  ui.frame();
  assert.equal(ui.confirmation(), undefined);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(ui.focusCount, 2);
  assert.deepEqual(calls, []);
  ui.unmount();
});

test("busy and pending actions prevent concurrent moves, including rapid activation", async () => {
  const move = deferred(), calls = [];
  const ui = actionHarness({ conversationBusy: true, onRewind: id => { calls.push(["rewind", id]); return move.promise; }, onFork: id => { calls.push(["fork", id]); return move.promise; } });
  assert.ok(ui.primary().every(button => button.props.disabled));
  ui.primary()[1].props.onClick(); // even a queued activation must honor busy
  assert.deepEqual(calls, []);
  ui.update({ conversationBusy: false });
  click(ui.primary()[0]);
  ui.render();
  const confirm = buttons(ui.confirmation())[1];
  click(confirm);
  confirm.props.onClick(); // second event before React has committed the disabled state
  assert.deepEqual(calls, [["rewind", "saved-entry"]]);
  ui.render();
  assert.ok(ui.primary().every(button => button.props.disabled));
  assert.ok(buttons(ui.confirmation()).every(button => button.props.disabled));
  ui.tree.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  ui.render();
  assert.ok(ui.confirmation(), "Escape cannot dismiss an in-flight rewind");
  move.resolve({ ok: true });
  await flush();
  ui.render();
  assert.equal(ui.confirmation(), undefined);
  assert.ok(ui.primary().every(button => !button.props.disabled));
  ui.unmount();
});

test("a refused rewind closes confirmation and can be retried", async () => {
  let attempts = 0;
  const ui = actionHarness({ onRewind: async () => ++attempts === 1
    ? { ok: false, error: "rewind refused" }
    : { ok: true } });
  click(ui.primary()[0]);
  ui.render();
  click(buttons(ui.confirmation())[1]);
  await flush();
  ui.render();
  assert.equal(ui.confirmation(), undefined);
  assert.equal(nodes(ui.tree, node => node.props?.role === "alert")[0].children[0], "rewind refused");
  assert.equal(ui.primary()[0].props.disabled, false);
  click(ui.primary()[0]);
  ui.render();
  assert.ok(ui.confirmation());
  assert.equal(nodes(ui.tree, node => node.props?.role === "alert").length, 0);
  click(buttons(ui.confirmation())[1]);
  await flush();
  ui.render();
  assert.equal(attempts, 2);
  assert.equal(ui.confirmation(), undefined);
  assert.equal(ui.primary()[0].props.disabled, false);
  ui.unmount();
});

test("backend refusal and rejection surface errors and restore usable controls", async () => {
  const refused = deferred(), rejected = deferred();
  let attempts = 0;
  const ui = actionHarness({ onFork: () => (++attempts === 1 ? refused.promise : rejected.promise) });
  click(ui.primary()[0]);
  ui.render();
  assert.equal(ui.primary()[0].props.disabled, true);
  refused.resolve({ ok: false, error: "backend refused this move" });
  await flush();
  ui.render();
  let alerts = nodes(ui.tree, node => node.props?.role === "alert");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].children[0], "backend refused this move");
  assert.equal(ui.primary()[0].props.disabled, false);
  click(ui.primary()[0]);
  ui.render();
  assert.equal(nodes(ui.tree, node => node.props?.role === "alert").length, 0);
  rejected.reject(new Error("transport failed"));
  await flush();
  ui.render();
  alerts = nodes(ui.tree, node => node.props?.role === "alert");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].children[0], "transport failed");
  assert.equal(ui.primary()[0].props.disabled, false);
  assert.equal(attempts, 2);
  ui.unmount();
});
