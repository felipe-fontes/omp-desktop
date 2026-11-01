#!/usr/bin/env node
// Consumer-visible conversation navigation regressions: saved history, live
// refreshes and supported conversation moves through the real bridge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = path => readFileSync(join(root, "src", path), "utf8");
let passed = 0;
async function check(label, run) {
  try { await run(); } catch (error) { console.error(`FAILED: ${label}`); throw error; }
  passed++;
}
const user = (text, timestamp, entryId) => ({ role: "user", content: [{ type: "text", text }], timestamp, ...(entryId ? { entryId } : {}) });
const answer = (text, timestamp, entryId) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp, ...(entryId ? { entryId } : {}) });
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const listeners = new Map(), journal = new Map(), commands = [], histories = new Map();
  const timeout = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; };
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, setTimeout: timeout, clearTimeout, queueMicrotask, TextEncoder });
  ctx.window = ctx;
  ctx.timeNow = () => "00:00";
  for (const file of ["constants", "slash-commands", "subagents", "background-tasks", "agent-context", "agent-context-sync", "cache-usage", "stream-delta", "session-title", "session-prefs", "message-queue", "ask-dialog", "approval", "approval-mode", "turn-status", "goal", "extension-widgets", "live-voice", "transcript-merge", "prompt-history", "project-nav", "live-context"]) {
    vm.runInContext(source(`app/${file}.js`), ctx, { filename: file });
  }
  vm.runInContext(source("design/tweaks/use-tweaks.js"), ctx, { filename: "use-tweaks.js" });
  vm.runInContext(source("adapter.js"), ctx, { filename: "adapter.js" });
  vm.runInContext(source("live.js"), ctx, { filename: "live.js" });
  let snapshot;
  ctx.OMP_BRIDGE.onUpdate(value => { snapshot = value; });
  function emit(id, frame) {
    const entries = journal.get(id) ?? [];
    const envelope = { seq: entries.length + 1, text: JSON.stringify(frame) };
    entries.push(envelope);
    journal.set(id, entries);
    listeners.get(`agent://line/${id}`)?.({ payload: envelope });
  }
  function reply(command, data, success = true, error) {
    emit(command.sessionId, { type: "response", command: command.type, id: command.id, success, data, error });
  }
  let readHistory = file => Promise.resolve(histories.get(file) ?? { messages: [], fork: null });
  let moveState = { isStreaming: false, isCompacting: false, isSettled: true };
  let scratchRow = null;
  ctx.__TAURI__ = {
    core: { async invoke(name, args) {
      if (name === "scratch_create") return scratchRow = { id: "history-chat", path: "/private/chats/history-chat", profile: args.profile, name: null, sessionFile: null };
      if (name === "scratch_list") return scratchRow ? [scratchRow] : [];
      if (name === "scratch_update") {
        if (args.name != null) scratchRow.name = args.name;
        if (args.sessionFile) scratchRow.sessionFile = args.sessionFile;
        return true;
      }
      if (name === "start_session") return { approvalMode: "write", path: args.args.cwd, workspace: null };
      if (name === "replay_events") return { dropped: false, events: (journal.get(args.sessionId) ?? []).filter(e => e.seq > args.afterSeq) };
      if (name === "conversation_history") return readHistory(args.sessionFile);
      if (name === "send_command") {
        const command = { ...JSON.parse(args.json), sessionId: args.sessionId };
        commands.push(command);
        if (command.type === "negotiate_protocol" || command.type === "set_ask_dialog") queueMicrotask(() => reply(command, null));
        if (command.type === "get_state" && command.id?.startsWith("conversation-state-")) queueMicrotask(() => reply(command, moveState));
      }
      return null;
    } },
    event: { async listen(name, callback) {
      listeners.set(name, callback);
      return () => { if (listeners.get(name) === callback) listeners.delete(name); };
    } },
  };
  const bridge = {
    ...ctx.OMP_BRIDGE,
    async openSession(cwd) {
      const opened = ctx.OMP_BRIDGE.openSession(cwd);
      await ctx.OMP_BRIDGE.startConversationSetup(snapshot.conversationSetup.id, null);
      return opened;
    },
  };
  return { ctx, bridge, emit, reply, commands, histories,
    setMoveState: value => { moveState = value; },
    readHistory: fn => { readHistory = fn; }, snapshot: () => snapshot };
}

await check("long conversations keep their earliest prompt across refresh and tab switches", async () => {
  const h = harness();
  const a = await h.bridge.openSession("/tmp/navigation-a");
  const history = Array.from({ length: 180 }, (_, i) => [user(`prompt ${i}`, i * 2 + 1), answer(`answer ${i}`, i * 2 + 2)]).flat();
  h.emit(a, { type: "response", command: "get_messages", success: true, data: { messages: history } });
  assert.equal(h.snapshot().messages[0].text, "prompt 0");
  assert.equal(h.snapshot().messages.at(-1).blocks[0].text, "answer 179");
  const b = await h.bridge.openSession("/tmp/navigation-b");
  await h.bridge.activateSession(a);
  h.emit(a, { type: "response", command: "get_messages", success: true, data: { messages: history.slice(-4) } });
  assert.equal(h.snapshot().messages[0].text, "prompt 0");
  assert.equal(h.snapshot().messages.filter(m => m.kind === "user").length, 180);
  assert.notEqual(a, b);
});

await check("saved history restores pre-compaction turns and entry IDs without duplicating live boundaries", async () => {
  const h = harness();
  const id = await h.bridge.openSession("/tmp/navigation-compacted");
  const file = "/sessions/current.jsonl";
  const compact = { role: "compactionSummary", entryId: "c1", summary: "Earlier work", tokensBefore: 120000, timestamp: 5, firstKeptEntryId: "u2" };
  const rpcSummary = { role: "compactionSummary", summary: "Earlier work", tokensBefore: 120000, timestamp: 5 };
  h.histories.set(file, { messages: [user("original question", 1, "u1"), answer("original answer", 2, "a1"), user("kept question", 3, "u2"), answer("kept answer", 4, "a2"), compact, user("continue", 6, "u3"), answer("continued", 7, "a3")], fork: { number: 2, parentSession: "/sessions/original.jsonl" } });
  h.emit(id, { type: "response", command: "get_messages", success: true, data: { messages: [rpcSummary, user("kept question", 3), answer("kept answer", 4), user("continue", 6), answer("continued", 7)] } });
  h.emit(id, { type: "response", command: "get_state", success: true, data: { sessionFile: file, messageCount: 2 } });
  await tick();
  let messages = h.snapshot().messages;
  assert.equal(messages[0].text, "original question");
  assert.deepEqual(Array.from(messages, m => m.entryId), ["u1", "a1", "u2", "a2", "c1", "u3", "a3"]);
  assert.equal(messages[4].kind, "compact");
  assert.equal(messages[4].tokensBefore, 120000);
  assert.equal(messages[4].ts, undefined, "desktop compaction rows never claim an omp message timestamp");
  assert.equal(h.snapshot().sessions.find(s => s.id === id).fork.number, 2);
  h.emit(id, { type: "response", command: "get_messages", success: true, data: { messages: [rpcSummary, user("kept question", 3), answer("kept answer", 4), user("continue", 6), answer("continued", 7)] } });
  messages = h.snapshot().messages;
  assert.equal(messages.filter(m => m.kind === "compact").length, 1);
  assert.equal(messages.find(m => m.text === "continue").entryId, "u3", "a context refresh keeps the saved action target");
});

await check("repository-free chats keep history and workspace identity through rewind", async () => {
  const h = harness();
  const id = await h.bridge.openChat();
  const file = "/sessions/scratch.jsonl", child = "/sessions/scratch-rewound.jsonl";
  const compact = { role: "compactionSummary", summary: "Earlier chat", tokensBefore: 110000, timestamp: 3 };
  h.histories.set(file, { messages: [user("original chat request", 1, "u1"), answer("original chat answer", 2, "a1"), compact, user("continue", 4, "u2")], fork: null });
  h.emit(id, { type: "response", command: "get_messages", success: true, data: { messages: [compact, user("continue", 4)] } });
  h.emit(id, { type: "response", command: "get_state", success: true, data: { sessionFile: file, messageCount: 2 } });
  await tick();
  assert.equal(h.snapshot().messages[0].text, "original chat request");
  assert.equal(h.snapshot().sessions.find(tab => tab.id === id).scratchId, "history-chat");
  const rewind = h.bridge.branchAt("u1");
  await tick();
  h.reply(h.commands.findLast(command => command.type === "branch"), { text: "original chat request" });
  assert.equal((await rewind).text, "original chat request");
  h.histories.set(child, { messages: [], fork: { number: 1, parentSession: file } });
  h.emit(id, { type: "response", command: "get_state", success: true, data: { sessionFile: child, messageCount: 0 } });
  await tick();
  const tab = h.snapshot().sessions.find(session => session.id === id);
  assert.equal(tab.scratchId, "history-chat", "rewind must not turn a repository-free chat into a project tab");
  assert.equal(tab.path, "/private/chats/history-chat");
  assert.equal(tab.fork.number, 1);
  assert.equal(h.snapshot().messages.length, 0);
});

await check("automatic compaction keeps the earlier transcript and one visible boundary", async () => {
  const h = harness();
  const id = await h.bridge.openSession("/tmp/navigation-live-compaction");
  h.emit(id, { type: "response", command: "get_messages", success: true, data: { messages: [user("before", 1), answer("earlier answer", 2)] } });
  h.emit(id, { type: "auto_compaction_start", action: "context-full", reason: "threshold" });
  const pendingId = h.snapshot().messages.at(-1)._id;
  assert.equal(h.snapshot().messages.at(-1).status, "pending");
  assert.equal(h.snapshot().conversationBusy, true);
  h.emit(id, { type: "auto_compaction_end", action: "context-full", result: { summary: "Saved summary", tokensBefore: 110000, firstKeptEntryId: "u1" }, aborted: false });
  const compact = h.snapshot().messages.at(-1);
  assert.deepEqual([compact.kind, compact.status, compact._id, compact.tokensBefore], ["compact", "done", pendingId, 110000]);
  assert.equal(h.snapshot().conversationBusy, false);
  h.emit(id, { type: "response", command: "get_messages", success: true, data: { messages: [{ role: "compactionSummary", summary: "Saved summary", tokensBefore: 110000, timestamp: 5 }] } });
  assert.equal(h.snapshot().messages[0].text, "before");
  assert.equal(h.snapshot().messages.filter(m => m.kind === "compact").length, 1);
  h.emit(id, { type: "auto_compaction_start", action: "context-full", reason: "idle" });
  h.emit(id, { type: "auto_compaction_end", action: "context-full", skipped: true });
  assert.equal(h.snapshot().messages.filter(m => m.kind === "compact").length, 1, "a skipped compaction is not a boundary");
});

await check("late saved reads never replace a different tab and read failures keep live history", async () => {
  const h = harness();
  const a = await h.bridge.openSession("/tmp/navigation-stale-a");
  let release;
  h.readHistory(() => new Promise(resolve => { release = resolve; }));
  h.emit(a, { type: "response", command: "get_state", success: true, data: { sessionFile: "/sessions/a.jsonl", messageCount: 1 } });
  const b = await h.bridge.openSession("/tmp/navigation-stale-b");
  release({ messages: [user("belongs to a", 1, "u1")], fork: { number: 9, parentSession: "a-parent" } });
  await tick();
  assert.equal(h.snapshot().activeSessionId, b);
  assert.equal(h.snapshot().messages.some(m => m.text === "belongs to a"), false);
  h.readHistory(() => Promise.reject(new Error("unreadable saved file")));
  h.emit(b, { type: "response", command: "get_messages", success: true, data: { messages: [user("keep this live prompt", 2)] } });
  h.emit(b, { type: "response", command: "get_state", success: true, data: { sessionFile: "/sessions/b.jsonl", messageCount: 1 } });
  await tick();
  assert.equal(h.snapshot().messages[0].text, "keep this live prompt");
  assert.equal(h.snapshot().historyError, "unreadable saved file");
  h.readHistory(() => Promise.resolve({ messages: [user("saved earlier", 1, "old"), user("keep this live prompt", 2, "new")], fork: null }));
  await h.bridge.refreshConversationHistory();
  assert.equal(h.snapshot().historyError, null);
  assert.equal(h.snapshot().messages[0].text, "saved earlier");
});

await check("rewind and fork refuse active work and serialize pending conversation changes", async () => {
  const h = harness();
  const id = await h.bridge.openSession("/tmp/navigation-moves");
  h.emit(id, { type: "response", command: "get_messages", success: true, data: { messages: [user("chosen question", 1, "u1"), answer("old answer", 2, "a1")] } });
  for (const busy of [{ isStreaming: true }, { isCompacting: true }, { isSettled: false }, { hasPendingAsyncWork: true }]) {
    h.emit(id, { type: "response", command: "get_state", success: true, data: busy });
    assert.equal((await h.bridge.branchAt("u1")).ok, false);
    assert.equal((await h.bridge.forkAt("a1")).ok, false);
  }
  assert.equal(h.commands.some(c => c.type === "branch" || c.type === "fork"), false);
  h.emit(id, { type: "response", command: "get_state", success: true, data: { isStreaming: false } });
  const rewind = h.bridge.branchAt("u1");
  assert.equal(h.snapshot().conversationBusy, true);
  assert.equal((await h.bridge.forkAt("a1")).ok, false);
  await tick();
  const branch = h.commands.findLast(c => c.type === "branch");
  h.reply(branch, { cancelled: true, text: "chosen question" });
  assert.equal((await rewind).cancelled, true);
  assert.equal(h.snapshot().messages[0].text, "chosen question", "cancelled rewind keeps the active conversation");
  assert.equal(h.snapshot().conversationBusy, false);
  const fork = h.bridge.forkAt("a1");
  await tick();
  h.reply(h.commands.findLast(c => c.type === "fork"), null, false, "session busy");
  assert.equal((await fork).error, "session busy");
  assert.equal(h.snapshot().messages.at(-1).blocks[0].text, "old answer");
});

await check("a fresh native state prevents a rewind racing an admitted turn", async () => {
  const h = harness();
  const id = await h.bridge.openSession("/tmp/navigation-admitted");
  h.emit(id, { type: "response", command: "get_messages", success: true, data: { messages: [user("keep", 1, "u1")] } });
  h.setMoveState({ isStreaming: false, isSettled: false, queuedMessageCount: 1 });
  const result = await h.bridge.branchAt("u1");
  assert.equal(result.ok, false);
  assert.equal(h.commands.some(command => command.type === "branch"), false);
  assert.equal(h.snapshot().messages[0].text, "keep");
  assert.equal(h.snapshot().conversationMoving, false);
});

await check("a successful rewind retains its draft's owning tab and selected images", async () => {
  const h = harness();
  const a = await h.bridge.openSession("/tmp/navigation-draft-a");
  const prompt = user("re-ask this", 1, "u1");
  prompt.content.push({ type: "image", data: "saved-image", mimeType: "image/png" });
  h.emit(a, { type: "response", command: "get_messages", success: true, data: { messages: [prompt, answer("old answer", 2, "a1")] } });
  const rewind = h.bridge.branchAt("u1");
  await tick();
  const command = h.commands.findLast(c => c.type === "branch");
  await h.bridge.openSession("/tmp/navigation-draft-b");
  h.reply(command, { cancelled: false, text: "re-ask this" });
  await h.bridge.activateSession(a);
  const result = await rewind;
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, a);
  assert.equal(result.text, "re-ask this");
  assert.equal(result.images[0].data, "saved-image");
  assert.equal(h.snapshot().messages.length, 0, "the old transcript cannot leak into the new file before reload");
});

await check("late saved history cannot replace the latest request's cache usage", async () => {
  const h = harness();
  const id = await h.bridge.openSession("/tmp/navigation-cache");
  const earlier = { ...answer("earlier", 1, "a1"), provider: "local", model: "earlier", usage: { input: 10, output: 1, cacheRead: 90, cacheWrite: 0 } };
  h.emit(id, { type: "response", command: "get_messages", success: true, data: { messages: [earlier] } });
  let release;
  h.readHistory(() => new Promise(resolve => { release = resolve; }));
  h.emit(id, { type: "response", command: "get_state", success: true, data: { sessionFile: "/sessions/cache.jsonl", messageCount: 1 } });
  await tick();
  const latest = { ...answer("latest", 2, "a2"), provider: "local", model: "latest", usage: { input: 20, output: 2, cacheRead: 180, cacheWrite: 0 } };
  h.emit(id, { type: "message_end", message: latest });
  release({ messages: [earlier], fork: null });
  await tick();
  assert.equal(h.snapshot().ctx.cacheUsage.model, "latest");
  assert.equal(h.snapshot().ctx.cacheUsage.usage.cacheRead, 180);
});

await check("saved tool status is honest and cannot overwrite a complete live result", () => {
  const h = harness();
  const call = { role: "assistant", timestamp: 2, entryId: "a1", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "false" } }] };
  const saved = h.ctx.adaptAgentMessages([user("run", 1, "u1"), call, { role: "toolResult", toolCallId: "call-1", isError: true }], { savedHistory: true });
  const card = saved.find(m => m.kind === "tool");
  assert.equal(card.status, "recorded");
  assert.equal(card.isError, true);
  assert.equal(card.historyOmittedOutput, true);
  const live = { ...card, status: "ok", historyOmittedOutput: false, outputText: "complete output", _id: 42 };
  const merged = h.ctx.OMP_TRANSCRIPT.mergeTranscript([live], [card]);
  assert.equal(merged[0].outputText, "complete output");
  assert.equal(merged[0]._id, 42);
});

const navigationWindow = {};
vm.runInNewContext(source("app/conversation-navigation.js"), { window: navigationWindow });
const nav = navigationWindow.OMP_CONVERSATION_NAV;
await check("every historical target, including an old last user prompt, has a bounded rendered page", () => {
  const messages = Array.from({ length: 420 }, (_, index) => ({ _id: index + 1, kind: index === 3 ? "user" : "assistant" }));
  assert.equal(nav.lastUserIndex(messages), 3);
  for (const index of [0, 3, 159, 160, 300, 419]) {
    const range = nav.pageRange(messages, nav.anchorFor(messages, messages[index]._id));
    assert.ok(range.start <= index && range.end > index);
    assert.ok(range.end - range.start <= nav.PAGE_SIZE);
  }
  assert.equal(nav.pageRange(messages).end, messages.length);
  const expanded = [{ _id: -1, kind: "user" }, ...messages];
  const anchor = nav.anchorFor(messages, messages[160]._id);
  const range = nav.pageRange(expanded, anchor);
  assert.equal(expanded[range.start]._id, anchor, "a saved-history prepend does not shift the page's stable anchor");
  assert.equal(nav.lastUserIndex([{ kind: "user" }, { kind: "user", agent: true }]), 0);
});
await check("consecutive earlier and later pages cover every message without gaps", () => {
  const messages = Array.from({ length: 420 }, (_, index) => ({ _id: index + 1 }));
  let page = nav.pageRange(messages);
  while (page.start > 0) {
    const previous = nav.pageRange(messages, nav.adjacentPageAnchor(messages, page, -1));
    assert.ok(previous.start < page.start);
    assert.ok(previous.end >= page.start);
    page = previous;
  }
  while (page.end < messages.length) {
    const next = nav.pageRange(messages, nav.adjacentPageAnchor(messages, page, 1));
    assert.equal(next.start, page.end);
    assert.ok(next.end > page.end);
    page = next;
  }
});

await check("answers, reasoning-only turns and tool-call updates have distinct minimap roles", () => {
  assert.equal(nav.minimapKind({ kind: "assistant", thought: "reasoning", blocks: [] }), "reasoning");
  assert.equal(nav.minimapKind({ kind: "assistant", thought: "reasoning", blocks: [{ type: "text", text: "answer" }], stopReason: "stop" }), "answer");
  assert.equal(nav.minimapKind({ kind: "assistant", blocks: [{ type: "text", text: "checking" }], stopReason: "toolUse" }), "update");
  assert.equal(nav.minimapKind({ kind: "assistant", blocks: [{ type: "text", text: "failed" }], failure: {} }), "failure");
  assert.equal(nav.minimapKind({ kind: "user" }), "user");
});

console.log(`test-conversation-navigation: ${passed} checks passed`);
