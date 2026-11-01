#!/usr/bin/env node
// Public bridge lifecycle: isolated chat ownership, retention and promotion recovery.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const root = new URL("../", import.meta.url);
const source = path => readFileSync(new URL(path, root), "utf8");
function harness({ boot = false } = {}) {
  const listeners = new Map(), rows = new Map(), journal = new Map(), states = new Map(), retained = new Map();
  let destination = null, failProject = false, closeFailure = false, n = 0;
  const seed = { id: "chat-1", path: "/private/chats/chat-1/workspace", profile: "default", name: "Restored chat", sessionFile: "/default/restored.jsonl" };
  if (boot) { rows.set(seed.id, seed); n = 1; }
  let releaseRestoreLookup, restoreLookupStarted;
  const restoreLookupReady = new Promise(resolve => { restoreLookupStarted = resolve; });
  const w = {
    OMP_SLASH: { LOCAL_COMMANDS: [] },
    OMP_SUBAGENTS: { emptySubagents: () => ({}), subscriptionLevelFor: () => "progress", mergeSnapshots: () => ({}) },
    OMP_QUEUE: { EMPTY_QUEUE: {}, fromSnapshot: () => ({}) }, OMP_GOAL: { UNKNOWN: {}, fromSnapshot: () => ({}) }, OMP_EXT_WIDGETS: { EMPTY: {} },
    OMP_TRANSCRIPT: {}, OMP_PROMPT_HISTORY: { DEFAULT_LIMIT: 100 },
    OMP_SESSION_PREFS: { fromTweaks: () => ({ restoreTabs: true }), closeGuardArmed: () => false },
    OMP_TWEAKS_STORE: { read: () => ({}) },
    OMP_TURN_STATUS: { runStateOf: s => s.isStreaming ? "running" : "idle", isBusyRunState: s => s === "running", retryCleared: m => m, retryAttempting: m => m },
    DEFAULT_PROFILE_ID: "default", INTENT_FRAMING: () => "", timeNow: () => "00:00",
    buildCtx: () => ({}),
  };
  for (const path of ["src/app/live-voice.js", "src/app/live-context.js", "src/app/approval-mode.js", "src/app/project-nav.js", "src/app/session-title.js"]) new Function("window", source(path))(w);
  const timeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  let snapshot;
  function emit(id, frame) {
    if (frame.command === "get_state" && frame.success) states.set(id, frame.data);
    const events = journal.get(id) || [];
    const event = { seq: events.length + 1, text: JSON.stringify(frame) };
    events.push(event); journal.set(id, events);
    listeners.get(`agent://line/${id}`)?.({ payload: event });
  }
  w.__TAURI__ = {
    core: { async invoke(command, args) {
      if (command === "list_profiles") return { profiles: [{ id: "default", name: "default" }, { id: "work", name: "Work" }] };
      if (command === "create_profile") return { id: "work", name: "Work" };
      if (command === "open_tabs_load") return { tabs: [{ path: seed.path, profile: seed.profile, sessionFile: seed.sessionFile, name: seed.name, scratchId: seed.id }], active: 0, skipped: [] };
      if (command === "take_pending_open_projects") return [];
      if (command === "scratch_create") {
        const id = `chat-${++n}`, row = { id, path: `/private/chats/${id}/workspace`, profile: args.profile, name: null, sessionFile: null };
        rows.set(id, row); return { ...row };
      }
      if (command === "scratch_for_profile") {
        const source = rows.get(args.id);
        let target = [...rows.values()].find(r => r.path === source.path && r.profile === args.profile);
        if (!target) {
          target = { id: `chat-${++n}`, path: source.path, profile: args.profile, name: null, sessionFile: null };
          rows.set(target.id, target);
        }
        return { ...target };
      }
      if (command === "scratch_list") {
        const result = () => [...rows.values()].filter(r => r.profile === args.profile).map(r => ({ ...r }));
        if (boot && !releaseRestoreLookup) {
          return new Promise(resolve => { releaseRestoreLookup = () => resolve(result()); restoreLookupStarted(); });
        }
        return result();
      }
      if (command === "scratch_update") { Object.assign(rows.get(args.id), { name: args.name, sessionFile: args.sessionFile }); return true; }
      if (command === "scratch_delete") {
        const row = rows.get(args.id);
        if (row.sessionFile) retained.set(row.sessionFile, row);
        rows.delete(args.id); return;
      }
      if (command === "scratch_restore_history") {
        const existing = [...rows.values()].find(row => row.sessionFile === args.sessionFile && row.profile === args.profile);
        if (existing) return { id: existing.id, path: existing.path };
        const old = retained.get(args.sessionFile);
        if (!old || old.profile !== args.profile) return null;
        const id = `chat-${++n}`, row = { ...old, id, path: `/private/chats/${id}/workspace` };
        rows.set(id, row);
        return { id, path: row.path };
      }
      if (command === "scratch_pick_project") return !!destination;
      if (command === "scratch_promote") return destination;
      if (command === "scratch_promote_session") return rows.get(args.id).sessionFile ? "/sessions/promoted.jsonl" : null;
      if (command === "close_tab") { if (closeFailure) throw new Error("shell could not stop"); journal.delete(args.sessionId); return; }
      if (command === "stop_session") { journal.delete(args.sessionId); return; }
      if (command === "start_session") {
        if (failProject && args.args.cwd === destination) throw new Error("project spawn failed");
        states.set(args.args.sessionId, { sessionFile: args.args.resume });
        return "write";
      }
      if (command === "replay_events") return { dropped: false, events: journal.get(args.sessionId) || [] };
      if (command === "send_command") {
        const cmd = JSON.parse(args.json);
        if (cmd.type === "get_state") queueMicrotask(() => emit(args.sessionId, { type: "response", command: cmd.type, id: cmd.id, success: true, data: states.get(args.sessionId) || {} }));
        if (cmd.type === "fork") {
          states.set(args.sessionId, { ...states.get(args.sessionId), sessionFile: "/sessions/snapshot.jsonl" });
          queueMicrotask(() => emit(args.sessionId, { type: "response", command: cmd.type, id: cmd.id, success: true, data: { cancelled: false } }));
        }
        if (["negotiate_protocol", "set_ask_dialog"].includes(cmd.type)) queueMicrotask(() => emit(args.sessionId, { type: "response", command: cmd.type, id: cmd.id, success: true, data: {} }));
      }
      return null;
    } },
    event: { async listen(name, fn) { listeners.set(name, fn); return () => { if (listeners.get(name) === fn) listeners.delete(name); }; } },
  };
  const transport = w.__TAURI__;
  if (!boot) delete w.__TAURI__;
  const document = { documentElement: { classList: { add() {} } }, readyState: "loading", addEventListener() {} };
  new Function("window", "setTimeout", "clearTimeout", "document", source("src/live.js"))(w, timeout, clearTimeout, document);
  w.__TAURI__ = transport;
  w.OMP_BRIDGE.onUpdate(s => { snapshot = s; });
  return { bridge: w.OMP_BRIDGE, rows, snapshot: () => snapshot, emit,
    seed, restoreLookupReady, releaseRestore: () => releaseRestoreLookup(),
    busy: value => { emit(snapshot.activeSessionId, { type: value ? "turn_start" : "turn_end" }); }, promoteTo: value => { destination = value; },
    failProject: () => { failProject = true; }, failClose: () => { closeFailure = true; } };
}
let passed = 0;
async function check(name, run) { try { await run(); passed++; } catch (error) { console.error(`FAILED: ${name}`); throw error; } }
await check("new chats are isolated ordinary sessions and closing retains reopenable workspaces", async () => {
  const h = harness();
  const a = await h.bridge.openChat(), b = await h.bridge.openChat();
  const tabs = h.snapshot().sessions;
  assert.notEqual(tabs[0].path, tabs[1].path);
  assert.equal(tabs[0].name, "New chat");
  const row = (await h.bridge.listChats())[0];
  await h.bridge.closeSession(a);
  assert.equal(h.rows.has(row.id), true);
  const reopened = await h.bridge.openScratchChat(row);
  assert.equal(h.snapshot().sessions.find(t => t.id === reopened).path, row.path);
  assert.equal(h.snapshot().sessions.find(t => t.id === b).scratchId, tabs[1].scratchId);
  assert.equal(await h.bridge.openScratchChat(row), reopened, "reopening focuses, never starts a duplicate owner");
});
await check("canceling promotion preserves the exact tab identity used by drafts and attachments", async () => {
  const h = harness(); const original = await h.bridge.openChat();
  const row = (await h.bridge.listChats())[0];
  assert.equal(await h.bridge.promoteChat(row.id), null);
  assert.equal(h.snapshot().sessions.length, 1);
  assert.equal(h.snapshot().sessions[0].scratchId, row.id);
  assert.equal(h.snapshot().sessions[0].id, original);
  assert.equal(h.rows.has(row.id), true);
});
await check("promotion moves navigation to Projects and keeps a detached recovery workspace", async () => {
  const h = harness(); await h.bridge.openChat();
  const row = (await h.bridge.listChats())[0];
  h.promoteTo("/projects/new-project");
  const id = await h.bridge.promoteChat(row.id);
  const tab = h.snapshot().sessions.find(t => t.id === id);
  assert.equal(tab.path, "/projects/new-project");
  assert.equal(tab.scratchId, null);
  assert.equal(h.rows.get(row.id).sessionFile, null);
  assert.equal(h.rows.has(row.id), true);
});
await check("failed project startup recovers the original scratch chat", async () => {
  const h = harness(); await h.bridge.openChat();
  const row = (await h.bridge.listChats())[0];
  h.promoteTo("/projects/refused"); h.failProject();
  await assert.rejects(h.bridge.promoteChat(row.id), /project spawn failed/);
  assert.equal(h.snapshot().sessions.length, 1);
  assert.equal(h.snapshot().sessions[0].scratchId, row.id);
  assert.equal(h.rows.has(row.id), true);
});
await check("busy chats cannot be promoted or deleted", async () => {
  const h = harness(); await h.bridge.openChat();
  const row = (await h.bridge.listChats())[0];
  h.busy(true);
  await assert.rejects(h.bridge.deleteChat(row.id), /Stop this chat/);
  await assert.rejects(h.bridge.promoteChat(row.id), /Stop this chat/);
  assert.equal(h.snapshot().sessions.length, 1);
  assert.equal(h.rows.has(row.id), true);
});
await check("failed writer shutdown prevents workspace deletion", async () => {
  const h = harness(); await h.bridge.openChat();
  const row = (await h.bridge.listChats())[0]; h.failClose();
  await assert.rejects(h.bridge.deleteChat(row.id), /shell could not stop/);
  assert.equal(h.rows.has(row.id), true);
  assert.equal(h.snapshot().sessions.length, 1);
});
await check("explicit deletion closes its owner and removes only that workspace", async () => {
  const h = harness(); await h.bridge.openChat(); await h.bridge.openChat();
  const [a, b] = await h.bridge.listChats();
  await h.bridge.deleteChat(a.id);
  assert.equal(h.rows.has(a.id), false);
  assert.equal(h.rows.has(b.id), true);
  assert.deepEqual(h.snapshot().sessions.map(t => t.scratchId), [b.id]);
});
await check("title and transcript identity survive closing immediately after a state frame", async () => {
  const h = harness(); const tab = await h.bridge.openChat();
  h.emit(tab, { type: "response", command: "get_state", success: true, data: { sessionFile: "/sessions/original.jsonl", sessionName: "Retained research" } });
  await h.bridge.closeSession(tab);
  const row = (await h.bridge.listChats())[0];
  assert.equal(row.name, "Retained research");
  assert.equal(row.sessionFile, "/sessions/original.jsonl");
  const reopened = await h.bridge.openScratchChat(row);
  assert.equal(h.snapshot().sessions.find(t => t.id === reopened).sessionFile, "/sessions/original.jsonl");
});
await check("promoted projects resume migrated history rather than the scratch session file", async () => {
  const h = harness(); const tab = await h.bridge.openChat();
  h.emit(tab, { type: "response", command: "get_state", success: true, data: { sessionFile: "/sessions/original.jsonl", sessionName: "Research" } });
  const row = (await h.bridge.listChats())[0];
  h.promoteTo("/projects/research");
  const promoted = await h.bridge.promoteChat(row.id);
  assert.equal(h.snapshot().sessions.find(t => t.id === promoted).sessionFile, "/sessions/promoted.jsonl");
  assert.equal(h.rows.get(row.id).sessionFile, "/sessions/original.jsonl", "the original history survives native migration of its independent fork");
  assert.equal(promoted, tab, "promotion preserves tab-local drafts and plan state");
});
await check("concurrent reopen requests share one owner of a chat's history", async () => {
  const h = harness(); const first = await h.bridge.openChat();
  const row = (await h.bridge.listChats())[0];
  await h.bridge.closeSession(first);
  const [a, b] = await Promise.all([h.bridge.openScratchChat(row), h.bridge.openScratchChat(row)]);
  assert.equal(a, b);
  assert.equal(h.snapshot().sessions.length, 1);
});
await check("chat profile switches share files but preserve each profile's own conversation", async () => {
  const h = harness(); await h.bridge.createProfile("Work");
  const tab = await h.bridge.openChat();
  h.emit(tab, { type: "response", command: "get_state", success: true, data: { sessionFile: "/default/original.jsonl", sessionName: "Default research" } });
  const original = (await h.bridge.listChats())[0];
  assert.equal((await h.bridge.switchSessionProfile(tab, "work")).ok, true);
  const workTab = h.snapshot().sessions.find(t => t.id === tab);
  assert.equal(workTab.profile, "work");
  assert.equal(workTab.path, original.path);
  assert.notEqual(workTab.scratchId, original.id);
  assert.equal(workTab.sessionFile, null);
  h.emit(tab, { type: "response", command: "get_state", success: true, data: { sessionFile: "/work/research.jsonl", sessionName: "Work research" } });
  const work = (await h.bridge.listChats())[0];
  assert.equal((await h.bridge.switchSessionProfile(tab, "default")).ok, true);
  assert.equal(h.snapshot().sessions[0].scratchId, original.id);
  assert.equal(h.snapshot().sessions[0].sessionFile, "/default/original.jsonl");
  assert.equal(h.rows.get(work.id).sessionFile, "/work/research.jsonl");
  const other = await h.bridge.openScratchChat(work);
  assert.equal(h.snapshot().sessions.length, 2);
  assert.equal((await h.bridge.switchSessionProfile(tab, "work")).ok, true);
  assert.equal(h.snapshot().activeSessionId, other, "an already-open profile variant is focused, not duplicated");
  assert.equal(h.snapshot().sessions.length, 2);
});
await check("retained history from a deleted workspace resumes in a valid replacement chat", async () => {
  const h = harness(); const tab = await h.bridge.openChat();
  h.emit(tab, { type: "response", command: "get_state", success: true, data: { sessionFile: "/default/retained.jsonl", sessionName: "Retained history" } });
  const old = (await h.bridge.listChats())[0];
  await h.bridge.closeSession(tab);
  await h.bridge.deleteChat(old.id);
  const session = { path: "/default/retained.jsonl", cwd: old.path, title: "Retained history" };
  const [a, b] = await Promise.all([h.bridge.resumeSession(session), h.bridge.resumeSession(session)]);
  assert.equal(a, b);
  const reopened = h.snapshot().sessions[0];
  assert.notEqual(reopened.path, old.path);
  assert.notEqual(reopened.scratchId, old.id);
  assert.equal(reopened.sessionFile, session.path);
  assert.equal(reopened.profile, "default");
  assert.equal(h.snapshot().sessions.length, 1);
});
await check("startup restore and a concurrent sidebar open share one scratch history owner", async () => {
  const h = harness({ boot: true });
  await h.restoreLookupReady;
  const opening = h.bridge.openScratchChat(h.seed);
  h.releaseRestore();
  const id = await opening;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.snapshot().sessions.length, 1);
  assert.equal(h.snapshot().sessions[0].id, id);
  assert.equal(h.snapshot().sessions[0].sessionFile, h.seed.sessionFile);
});
console.log(`scratch-chats: ${passed} checks passed`);
