#!/usr/bin/env node
// Consumer-visible deferred-workspace lifecycle, folder adoption and safe close.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const own = (value) => JSON.parse(JSON.stringify(value));
const options = {
  baseRef: "refs/heads/main",
  baseCommit: "a".repeat(40),
  worktree: true,
  acknowledgeShared: false,
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

const metadataCommands = new Set([
  "get_session_stats", "get_state", "get_messages", "get_entries",
  "get_available_models", "get_available_commands", "negotiate_protocol",
  "set_model", "cycle_model", "cycle_thinking_level",
  "get_available_thinking_levels", "set_thinking_level",
  "get_login_providers", "login", "set_ask_dialog",
  "set_subagent_subscription", "get_subagents", "get_subagent_messages",
  "set_auto_compaction", "set_auto_retry", "dictation_start", "dictation_stop",
]);

function harness({
  savedSessions = [],
  workspaceInfo = null,
  watchChangeDuringStart,
  model = null,
  thinkingLevel = null,
  metadataSessionFile = null,
  nonGit = false,
  cycledModel = { provider: "example", id: "cycled", name: "Cycled" },
  cycledThinkingLevel = "high",
} = {}) {
  const window = { OMP_TWEAKS_STORE: { read: () => ({}) } };
  const timers = new Set();
  const scope = {
    window,
    console: { log() {}, warn() {}, error() {} },
    atob,
    Uint8Array,
    TextDecoder,
    TextEncoder,
    setTimeout(fn, delay) {
      const timer = setTimeout(fn, delay);
      timer.unref();
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
      timers.delete(timer);
    },
  };
  for (const file of [
    "app/constants.js",
    "app/marked-setup.js",
    "app/slash-commands.js",
    "app/subagents.js",
    "app/background-tasks.js",
    "app/agent-context.js",
    "app/agent-context-sync.js",
    "app/session-title.js",
    "app/session-prefs.js",
    "app/message-queue.js",
    "app/ask-dialog.js",
    "app/approval.js",
    "app/approval-mode.js",
    "app/turn-status.js",
    "app/goal.js",
    "app/extension-widgets.js",
    "app/live-voice.js",
    "app/live-context.js",
    "app/cache-usage.js",
    "app/stream-delta.js",
    "app/transcript-merge.js",
    "app/prompt-history.js",
    "app/project-nav.js",
    "adapter.js",
    "live.js",
  ])
    runInNewContext(source(`src/${file}`), scope, { filename: file });
  const listeners = new Map(),
    bindings = new Map(),
    workspaceBindings = new Map(),
    branches = new Map(),
    deferred = new Map(),
    prepared = new Map(),
    processStates = new Map(),
    changeable = new Set(),
    taskStarted = new Set(),
    shells = new Set(),
    commands = [];
  const cycleHolds = new Map(), promptStates = [], cancelledThrough = new Map();
  const profileList = [
    { id: "default", name: "Local" },
    { id: "work", name: "Work account" },
    { id: "personal", name: "Personal" },
  ];
  let snapshot,
    starts = 0,
    failure = null,
    hold = null,
    creations = 0;
  let closeFailure = null;
  let closeHold = null;
  let stopHold = null;
  let stopFailure = null;
  let selectionHold = null;
  let namingHold = null, cancelNaming = null, admissionHold = null, namingFailure = null;
  let approvalMode = "write";
  const bridge = window.OMP_BRIDGE;
  bridge.onUpdate((next) => {
    snapshot = own(next);
  });
  window.__TAURI__ = {
    event: {
      async listen(name, callback) {
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    },
    core: {
      async invoke(command, args) {
        commands.push({ command, args: args === undefined ? null : own(args) });
        switch (command) {
          case "list_profiles":
            return { profiles: profileList, startupId: "default" };
          case "approval_mode_set_default":
            approvalMode = args.mode;
            return { default: approvalMode, projects: {} };
          case "rename_profile": {
            const profile = profileList.find((p) => p.id === args.id);
            profile.name = args.name;
            return profile;
          }
          case "list_saved_sessions":
            return savedSessions.filter(
              (session) =>
                (!args.profile || session.profile_id === args.profile) &&
                (!args.cwd || session.cwd === args.cwd),
            );
          case "start_session": {
            starts++;
            const request = args.args;
            if (
              !profileList.some(
                (p) => p.id === (request.profile || "default"),
              )
            )
              throw new Error(`unknown profile: ${request.profile}`);
            const id = request.sessionId;
            if (request.deferredWorkspace) {
              deferred.set(id, own(request.deferredWorkspace));
              changeable.add(id);
            }
            if (!request.firstPrompt && !request.deferredWorkspace && deferred.has(id) && prepared.has(id))
              throw new Error("retry the first prompt to use the prepared workspace");
            let path = request.cwd;
            let workspace = workspaceBindings.get(id) ??
              (request.resume && path.startsWith("/isolated/")
                ? { projectPath: "/source", baseRef: null, baseCommit: null, worktree: true }
                : null);
            if (request.firstPrompt) {
              const selected = deferred.get(id);
              if (!selected) throw new Error("No deferred workspace");
              if (!Number.isInteger(request.firstPrompt.attempt) || request.firstPrompt.attempt < 1)
                throw new Error("Missing first-prompt attempt");
              if (admissionHold) await admissionHold;
              if (request.firstPrompt.attempt <= (cancelledThrough.get(id) ?? 0))
                throw new Error("Workspace preparation cancelled");
              if (namingHold) {
                const cancelled = await Promise.race([
                  namingHold.then(() => false),
                  new Promise(resolve => { cancelNaming = { id, attempt: request.firstPrompt.attempt, cancel: () => resolve(true) }; }),
                ]);
                cancelNaming = null;
                if (cancelled) throw new Error("Workspace preparation cancelled");
              }
              if (namingFailure) throw new Error(namingFailure);
              if (!prepared.has(id)) {
                const target = selected.worktree ? `/isolated/${id}` : request.cwd;
                prepared.set(id, target);
                if (selected.worktree) creations++;
              }
              taskStarted.add(id);
              path = prepared.get(id);
              if (hold) await hold;
              if (failure) throw new Error(failure);
              workspace = {
                projectPath: request.cwd,
                baseRef: selected.baseRef ?? options.baseRef,
                baseCommit: selected.baseCommit ?? options.baseCommit,
                worktree: !!selected.worktree,
              };
              deferred.delete(id);
            }
            if (workspace) workspaceBindings.set(id, workspace);
            processStates.set(id, {
              model,
              thinkingLevel,
              sessionFile: request.deferredWorkspace ? metadataSessionFile : null,
            });
            bindings.set(id, path);
            branches.set(
              path,
              path.startsWith("/isolated/")
                ? workspace?.baseRef === "refs/heads/topic"
                  ? "feat/topic-task"
                  : "feat/isolated"
                : "main",
            );
            return {
              approvalMode,
              path,
              workspace,
              deferredWorkspace: deferred.get(id) ?? null,
            };
          }
          case "start_git_watch": {
            const branch = branches.get(args.path) ?? null;
            if (watchChangeDuringStart !== undefined) {
              branches.set(args.path, watchChangeDuringStart);
              listeners.get(`git://branch/${args.sessionId}`)?.({
                payload: watchChangeDuringStart,
              });
            }
            return { branch, root: args.path };
          }
          case "stop_session":
            if (stopHold) await stopHold;
            if (stopFailure) throw new Error(stopFailure);
            processStates.delete(args.sessionId);
            return null;
          case "conversation_workspace_cancel":
            cancelledThrough.set(args.sessionId, Math.max(cancelledThrough.get(args.sessionId) ?? 0, args.attempt));
            if (cancelNaming?.id === args.sessionId && cancelNaming.attempt <= args.attempt) cancelNaming.cancel();
            return null;
          case "conversation_workspace_set_deferred": {
            if (shells.has(args.sessionId))
              throw new Error("close the terminal before changing the workspace");
            if (!changeable.has(args.sessionId) || taskStarted.has(args.sessionId))
              throw new Error("workspace cannot change after a task has started");
            const selected = own(args.workspace);
            if (selected.worktree) {
              deferred.set(args.sessionId, selected);
              workspaceBindings.delete(args.sessionId);
              if (selectionHold) await selectionHold;
              return { workspace: null, deferredWorkspace: selected };
            }
            deferred.delete(args.sessionId);
            if (selectionHold) await selectionHold;
            const workspace = {
              projectPath: bindings.get(args.sessionId),
              baseRef: selected.baseRef,
              baseCommit: selected.baseCommit,
              worktree: false,
            };
            workspaceBindings.set(args.sessionId, workspace);
            return { workspace, deferredWorkspace: null };
          }
          case "replay_events":
            return { dropped: false, events: [] };
          case "session_status":
            return null;
          case "conversation_workspace_inspect":
            return {
              path: args.path,
              projectPath: args.path.startsWith("/isolated/")
                ? "/source"
                : args.path,
              repoRoot: nonGit ? null : args.path,
              currentBranch: nonGit ? null : "main",
              head: nonGit ? null : "a".repeat(40),
              branches: nonGit ? [] : [
                { name: "main", refName: "refs/heads/main", commit: "a".repeat(40), remote: false },
                { name: "topic", refName: "refs/heads/topic", commit: "b".repeat(40), remote: false },
              ],
              defaults: null,
            };
          case "recent_projects_touch":
          case "recent_projects_list":
            return [];
          case "worktree_storage_close_info":
            return workspaceInfo;
          case "close_tab":
            if (closeHold) await closeHold;
            if (closeFailure) throw new Error(closeFailure);
            bindings.delete(args.sessionId);
            workspaceBindings.delete(args.sessionId);
            processStates.delete(args.sessionId);
            deferred.delete(args.sessionId);
            prepared.delete(args.sessionId);
            changeable.delete(args.sessionId);
            taskStarted.delete(args.sessionId);
            shells.delete(args.sessionId);
            return null;
          case "terminal_open":
            if (deferred.has(args.sessionId))
              throw new Error("choose or prepare the conversation workspace before opening a terminal");
            shells.add(args.sessionId);
            return { instance: 1, shell: "/bin/sh", state: "running", exitCode: null };
          case "workspace_switch_branch":
            branches.set(args.path, args.name);
            for (const [id, path] of bindings) {
              if (path === args.path)
                listeners.get(`git://branch/${id}`)?.({ payload: args.name });
            }
            return null;
          case "git_browser_status":
            return {
              repo: {
                branch: branches.get(args.path) ?? null,
              },
            };
          case "list_project_files":
            return args.cwd.startsWith("/isolated/")
              ? ["isolated-only.txt"]
              : ["source-only.txt"];
          case "send_command": {
            const frame = JSON.parse(args.json);
            const processState = processStates.get(args.sessionId);
            if (!processState) throw new Error("no running agent");
            if (frame.type === "login") {
              Promise.resolve(cycleHolds.get("login")).then(() => {
                listeners.get(`agent://line/${args.sessionId}`)?.({
                  payload: { text: JSON.stringify({ type: "response", command: "login", id: frame.id, success: true, data: {} }) },
                });
              });
              return null;
            }
            if (frame.type === "cycle_model" || frame.type === "cycle_thinking_level") {
              if (!processStates.has(args.sessionId)) throw new Error("no running agent");
              Promise.resolve(cycleHolds.get(frame.type)).then(() => {
                const current = processStates.get(args.sessionId);
                if (!current) return;
                let data;
                if (frame.type === "cycle_model") {
                  current.model = cycledModel;
                  data = { model: cycledModel };
                } else {
                  current.thinkingLevel = cycledThinkingLevel;
                  data = { level: cycledThinkingLevel };
                }
                listeners.get(`agent://line/${args.sessionId}`)?.({
                  payload: { text: JSON.stringify({
                    type: "response", command: frame.type, id: frame.id, success: true, data,
                  }) },
                });
              });
              return null;
            }
            if (frame.type === "set_model")
              processState.model = { id: frame.modelId, provider: frame.provider, name: frame.modelId };
            if (frame.type === "set_thinking_level")
              processState.thinkingLevel = frame.level;
            const data = frame.type === "get_state"
              ? { ...(processState.model ? { model: processState.model } : {}),
                  ...(processState.thinkingLevel ? { thinkingLevel: processState.thinkingLevel } : {}),
                  ...(processState.sessionFile ? { sessionFile: processState.sessionFile } : {}) }
              : frame.type === "set_model" ? processState.model : {};
            if (!metadataCommands.has(frame.type)) {
              if (deferred.has(args.sessionId))
                throw new Error("choose or prepare the conversation workspace before starting a task");
              taskStarted.add(args.sessionId);
            }
            if (frame.type === "prompt")
              promptStates.push({ sessionId: args.sessionId, message: frame.message, model: own(processState.model), thinkingLevel: processState.thinkingLevel });
            if (frame.type === "set_thinking_level")
              queueMicrotask(() =>
                listeners.get(`agent://line/${args.sessionId}`)?.({
                  payload: { text: JSON.stringify({ type: "thinking_level_changed", thinkingLevel: frame.level }) },
                }),
              );
            if (frame.id || frame.type === "set_model")
              queueMicrotask(() =>
                listeners.get(`agent://line/${args.sessionId}`)?.({
                  payload: {
                    text: JSON.stringify({
                      type: "response",
                      command: frame.type,
                      id: frame.id,
                      success: true,
                      data,
                    }),
                  },
                }),
              );
            return null;
          }
          default:
            return null;
        }
      },
    },
  };
  return {
    bridge,
    get snapshot() {
      return snapshot;
    },
    get starts() {
      return starts;
    },
    get creations() {
      return creations;
    },
    get commands() {
      return commands;
    },
    get promptStates() {
      return promptStates;
    },
    hasProcess(id) {
      return processStates.has(id);
    },
    fail(message) {
      failure = message;
    },
    hold(promise) {
      hold = promise;
    },
    holdNaming(promise) {
      namingHold = promise;
    },
    failNaming(message) {
      namingFailure = message;
    },
    holdAdmission(promise) {
      admissionHold = promise;
    },
    cancelAttempt(sessionId, attempt) {
      return window.__TAURI__.core.invoke("conversation_workspace_cancel", { sessionId, attempt });
    },
    holdStop(promise) {
      stopHold = promise;
    },
    failStop(message) {
      stopFailure = message;
    },
    holdCycle(command, promise) {
      cycleHolds.set(command, promise);
    },
    holdSelection(promise) {
      selectionHold = promise;
    },
    failClose(message) {
      closeFailure = message;
    },
    holdClose(promise) {
      closeHold = promise;
    },
    gitChanged(sessionId, branch) {
      branches.set(bindings.get(sessionId), branch);
      listeners.get(`git://branch/${sessionId}`)?.({ payload: branch });
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

const calls = (h, command) =>
  h.commands.filter((entry) => entry.command === command).map((entry) => entry.args);
const prompts = (h) =>
  calls(h, "send_command")
    .map(({ sessionId, json }) => ({ sessionId, frame: JSON.parse(json) }))
    .filter(({ frame }) => frame.type === "prompt");

test("a fresh project opens in normal chat before its first worktree prompt", async () => {
  const h = harness();
  try {
    const opening = h.bridge.openSession("/source", "work");
    await flush();
    assert.equal(h.snapshot.conversationSetup, null);
    const id = await opening;
    assert.equal(h.snapshot.activeSessionId, id);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.equal(h.snapshot.sessions[0].profile, "work");
    assert.equal(h.snapshot.sessions[0].branch, "main");
    assert.equal(h.snapshot.sessions[0].deferredWorkspace.worktree, true);
    const [start] = calls(h, "start_session");
    assert.equal(start.args.sessionId, id);
    assert.equal(start.args.cwd, "/source");
    assert.ok(start.args.deferredWorkspace);
    assert.equal(start.args.firstPrompt, undefined);
    assert.equal(h.creations, 0);
    assert.deepEqual(prompts(h), []);
    assert.deepEqual(own(await h.bridge.listFiles("")), ["source-only.txt"]);
  } finally {
    h.close();
  }
});

for (const restartKind of ["profile", "approval"]) {
  test(`a pending workspace survives a ${restartKind} restart before its first prompt`, async () => {
    const h = harness({
      model: { provider: "example", id: "original", name: "Original" },
      thinkingLevel: "low",
      metadataSessionFile: "/metadata/not-a-task-session.jsonl",
    });
    try {
      await h.bridge.renameProfile("work", "Work account");
      const id = await h.bridge.openSession("/source", "default");
      await flush();
      assert.equal(h.snapshot.sessions[0].sessionFile, "/metadata/not-a-task-session.jsonl");
      const chosen = { provider: "example", id: "chosen", name: "Chosen" };
      h.bridge.setModel(chosen);
      await h.bridge.setThinkingLevel("high");
      await flush();
      const restartAt = h.commands.length;
      if (restartKind === "profile") {
        assert.equal((await h.bridge.switchSessionProfile(id, "work")).ok, true);
        assert.equal(h.snapshot.sessions[0].profile, "work");
      } else {
        const result = await h.bridge.setApprovalModeDefault("yolo");
        assert.equal(result.ok, true);
        assert.deepEqual(own(result.restarted), [id]);
        assert.equal(h.snapshot.sessions[0].approvalMode, "yolo");
      }
      await flush();
      assert.equal(h.snapshot.activeSessionId, id);
      assert.equal(h.snapshot.sessions.length, 1);
      assert.equal(h.snapshot.sessions[0].path, "/source");
      assert.ok(h.snapshot.sessions[0].deferredWorkspace);
      assert.equal(h.creations, 0);
      assert.deepEqual(prompts(h), []);
      const starts = calls(h, "start_session");
      assert.equal(starts.length, 2);
      assert.equal(starts[1].args.sessionId, id);
      assert.equal(starts[1].args.resume, null);
      assert.equal(starts[1].args.firstPrompt, undefined);
      assert.equal(starts[1].args.deferredWorkspace, undefined);
      const afterRestart = h.commands.slice(restartAt);
      const restartIndex = afterRestart.findIndex((entry) => entry.command === "start_session");
      const frames = afterRestart
        .slice(restartIndex + 1)
        .filter((entry) => entry.command === "send_command" && entry.args.sessionId === id)
        .map((entry) => JSON.parse(entry.args.json));
      const modelIndex = frames.findIndex((frame) =>
        frame.type === "set_model" && frame.provider === chosen.provider && frame.modelId === chosen.id);
      const thinkingIndex = frames.findIndex((frame) =>
        frame.type === "set_thinking_level" && frame.level === "high");
      assert.ok(restartIndex >= 0 && modelIndex >= 0 && modelIndex < thinkingIndex);
      assert.equal(h.snapshot.model?.id, chosen.id);
      assert.equal(h.snapshot.thinkingLevel, "high");
      assert.equal(await h.bridge.send("Complete the pending task", []), true);
      assert.equal(h.snapshot.sessions[0].id, id);
      assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
      assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
      assert.equal(h.starts, 3);
      assert.equal(h.creations, 1);
      const lastStart = calls(h, "start_session")[2].args;
      assert.equal(lastStart.sessionId, id);
      assert.equal(lastStart.firstPrompt.text, "Complete the pending task");
      assert.deepEqual(own(lastStart.firstPrompt.model), { provider: chosen.provider, id: chosen.id });
      assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
        [[id, "Complete the pending task"]]);
    } finally {
      h.close();
    }
  });

  test(`a Local-ready workspace ignores metadata resume on ${restartKind} restart`, async () => {
    const h = harness({
      model: { provider: "example", id: "original", name: "Original" },
      thinkingLevel: "low",
      metadataSessionFile: "/metadata/not-a-task-session.jsonl",
    });
    try {
      await h.bridge.renameProfile("work", "Work account");
      const id = await h.bridge.openSession("/source", "default");
      await flush();
      assert.equal(h.snapshot.sessions[0].sessionFile, "/metadata/not-a-task-session.jsonl");
      assert.equal((await h.bridge.setConversationWorkspace(id, {
        ...options, worktree: false, acknowledgeShared: true,
      })).ok, true);
      assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
      assert.equal(h.snapshot.sessions[0].workspace.worktree, false);
      const chosen = { provider: "example", id: "chosen", name: "Chosen" };
      h.bridge.setModel(chosen);
      await h.bridge.setThinkingLevel("high");
      await flush();
      assert.equal(h.snapshot.model?.id, chosen.id);
      assert.equal(h.snapshot.thinkingLevel, "high");
      const restartAt = h.commands.length;
      if (restartKind === "profile") {
        assert.equal((await h.bridge.switchSessionProfile(id, "work")).ok, true);
        assert.equal(h.snapshot.sessions[0].profile, "work");
      } else {
        const result = await h.bridge.setApprovalModeDefault("yolo");
        assert.equal(result.ok, true);
        assert.deepEqual(own(result.restarted), [id]);
        assert.equal(h.snapshot.sessions[0].approvalMode, "yolo");
      }
      await flush();
      const starts = calls(h, "start_session");
      assert.equal(starts.length, 3);
      assert.equal(starts[2].args.sessionId, id);
      assert.equal(starts[2].args.resume, null);
      assert.equal(starts[2].args.firstPrompt, undefined);
      assert.equal(starts[2].args.deferredWorkspace, undefined);
      assert.equal(h.snapshot.activeSessionId, id);
      assert.equal(h.snapshot.sessions[0].path, "/source");
      assert.equal(h.snapshot.sessions[0].workspace.worktree, false);
      assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
      assert.equal(h.creations, 0);
      assert.deepEqual(prompts(h), []);
      const afterRestart = h.commands.slice(restartAt);
      const restartIndex = afterRestart.findIndex((entry) => entry.command === "start_session");
      const frames = afterRestart.slice(restartIndex + 1)
        .filter((entry) => entry.command === "send_command" && entry.args.sessionId === id)
        .map((entry) => JSON.parse(entry.args.json));
      const modelIndex = frames.findIndex((frame) =>
        frame.type === "set_model" && frame.provider === chosen.provider && frame.modelId === chosen.id);
      const thinkingIndex = frames.findIndex((frame) =>
        frame.type === "set_thinking_level" && frame.level === "high");
      assert.ok(restartIndex >= 0 && modelIndex >= 0 && modelIndex < thinkingIndex);
      assert.equal(h.snapshot.model?.id, chosen.id);
      assert.equal(h.snapshot.thinkingLevel, "high");
      assert.equal(await h.bridge.send("Continue in the local checkout", []), true);
      assert.equal(h.starts, 3);
      assert.equal(h.creations, 0);
      assert.equal(h.snapshot.sessions[0].path, "/source");
      assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
        [[id, "Continue in the local checkout"]]);
    } finally {
      h.close();
    }
  });
}

test("non-Git folders send directly without creating an isolated workspace", async () => {
  const h = harness({ nonGit: true });
  try {
    const id = await h.bridge.openSession("/folder", "default");
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal(await h.bridge.send("Explain this folder", []), true);
    assert.equal(h.starts, 1);
    assert.equal(h.creations, 0);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Explain this folder"]]);
  } finally {
    h.close();
  }
});

test("empty first prompts do not prepare a checkout or send a command", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    assert.equal(await h.bridge.send("   ", []), false);
    assert.equal(h.snapshot.activeSessionId, id);
    assert.ok(h.snapshot.sessions[0].deferredWorkspace);
    assert.equal(h.starts, 1);
    assert.equal(h.creations, 0);
    assert.deepEqual(prompts(h), []);
    assert.equal(await h.bridge.send("Fix the failing build", []), true);
    assert.equal(h.creations, 1);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Fix the failing build"]]);
  } finally {
    h.close();
  }
});

test("choosing a different base creates the selected isolated branch on first prompt", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    const selection = {
      ...options,
      baseRef: "refs/heads/topic",
      baseCommit: "b".repeat(40),
      worktree: true,
    };
    const editing = h.bridge.configureConversationWorkspace(id);
    const request = h.snapshot.conversationSetup;
    assert.equal(h.bridge.cancelConversationSetup(request.id), true);
    assert.equal(await editing, null);
    assert.equal(h.starts, 1);
    assert.equal(h.creations, 0);
    const selecting = h.bridge.configureConversationWorkspace(id);
    const selected = await h.bridge.startConversationSetup(
      h.snapshot.conversationSetup.id, selection,
    );
    assert.equal(selected.ok, true);
    assert.equal(await selecting, id);
    assert.equal(h.starts, 2);
    assert.equal(h.creations, 0);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.equal(h.snapshot.sessions[0].branch, "main");
    assert.equal(await h.bridge.send("Work on the topic branch", []), true);
    assert.equal(h.snapshot.sessions[0].id, id);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.equal(h.snapshot.sessions[0].branch, "feat/topic-task");
    assert.equal((await h.bridge.gitBrowserStatus()).value.repo.branch, "feat/topic-task");
    assert.deepEqual(own(await h.bridge.listFiles("")), ["isolated-only.txt"]);
    assert.equal(h.creations, 1);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Work on the topic branch"]]);
  } finally {
    h.close();
  }
});

test("choosing the current checkout sends directly without creating a worktree", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    assert.equal((await h.bridge.setConversationWorkspace(id, {
      ...options,
      worktree: false,
      acknowledgeShared: true,
    })).ok, true);
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal(await h.bridge.send("Work in this checkout", []), true);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.equal((await h.bridge.gitBrowserStatus()).value.repo.branch, "main");
    assert.deepEqual(own(await h.bridge.listFiles("")), ["source-only.txt"]);
    assert.equal(h.starts, 2);
    assert.equal(h.creations, 0);
    assert.equal((await h.bridge.setConversationWorkspace(id, options)).ok, false);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Work in this checkout"]]);
  } finally {
    h.close();
  }
});

test("Local choice stays busy through its source restart and preserves model and thinking", async () => {
  const h = harness({ model: { provider: "example", id: "original" }, thinkingLevel: "low" });
  let release;
  try {
    const id = await h.bridge.openSession("/source", "default");
    const chosen = { provider: "example", id: "chosen", name: "Chosen" };
    h.bridge.setModel(chosen);
    await h.bridge.setThinkingLevel("high");
    await flush();
    h.holdStop(new Promise(resolve => { release = resolve; }));
    const selecting = h.bridge.setConversationWorkspace(id, { ...options, worktree: false, acknowledgeShared: true });
    await flush();
    assert.equal(h.snapshot.sessions[0].workspaceConfiguring, true);
    assert.equal(h.starts, 1);
    assert.equal(await h.bridge.send("Do not race the restart", []), false);
    assert.equal((await h.bridge.liveStart()).ok, false);
    assert.equal((await h.bridge.terminalOpen(id, 80, 24)).ok, false);
    assert.deepEqual(prompts(h), []);
    h.holdStop(null);
    release();
    assert.equal((await selecting).ok, true);
    assert.equal(h.snapshot.sessions[0].workspaceConfiguring, false);
    assert.equal(h.snapshot.sessions[0].workspace.worktree, false);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.equal(h.starts, 2);
    assert.equal(h.creations, 0);
    assert.equal(calls(h, "start_session")[1].args.firstPrompt, undefined);
    assert.equal(await h.bridge.send("Work locally", []), true);
    assert.equal(h.promptStates.at(-1).model.id, chosen.id);
    assert.equal(h.promptStates.at(-1).thinkingLevel, "high");
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]), [[id, "Work locally"]]);
  } finally {
    release?.();
    h.close();
  }
});

test("a failed choice restart blocks tasks until workspace options are retried", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    const local = { ...options, worktree: false, acknowledgeShared: true };
    h.failStop("stop refused");
    const failed = await h.bridge.setConversationWorkspace(id, local);
    assert.equal(failed.ok, false);
    assert.match(h.snapshot.sessions[0].workspaceError, /stop refused.*retry workspace options/i);
    assert.equal(h.snapshot.sessions[0].workspaceRestartRequired, true);
    assert.equal(await h.bridge.send("Keep this draft", []), false);
    assert.equal((await h.bridge.goalStart("Do not start", 1000, [])).ok, false);
    assert.equal((await h.bridge.liveStart()).ok, false);
    assert.equal((await h.bridge.terminalOpen(id, 80, 24)).ok, false);
    assert.deepEqual(prompts(h), []);
    h.failStop(null);
    assert.equal((await h.bridge.setConversationWorkspace(id, local)).ok, true);
    assert.equal(h.snapshot.sessions[0].workspaceRestartRequired, false);
    assert.equal(await h.bridge.send("Keep this draft", []), true);
    assert.equal(h.creations, 0);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]), [[id, "Keep this draft"]]);
  } finally {
    h.close();
  }
});


test("workspace changes and first-prompt restarts wait for an in-flight sign-in", async () => {
  const h = harness();
  let release;
  try {
    const id = await h.bridge.openSession("/source", "default");
    h.holdCycle("login", new Promise(resolve => { release = resolve; }));
    const login = h.bridge.login("example");
    await flush();
    const selected = await h.bridge.setConversationWorkspace(id, { ...options, worktree: false, acknowledgeShared: true });
    assert.equal(selected.ok, false);
    assert.match(selected.error, /signing in/i);
    assert.equal(await h.bridge.send("Wait for login", []), false);
    assert.equal(h.starts, 1);
    assert.deepEqual(calls(h, "stop_session"), []);
    assert.deepEqual(calls(h, "conversation_workspace_set_deferred"), []);
    release();
    await login;
    assert.equal((await h.bridge.setConversationWorkspace(id, { ...options, worktree: false, acknowledgeShared: true })).ok, true);
    assert.equal(await h.bridge.send("Work after login", []), true);
    assert.equal(h.creations, 0);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]), [[id, "Work after login"]]);
  } finally {
    release?.();
    h.close();
  }
});


test("Local can be changed back to Worktree before the first task, but not afterward", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    const local = { ...options, worktree: false, acknowledgeShared: true };
    assert.equal((await h.bridge.setConversationWorkspace(id, local)).ok, true);
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal((await h.bridge.setConversationWorkspace(id, options)).ok, true);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.equal(h.snapshot.sessions[0].deferredWorkspace.worktree, true);
    assert.equal(h.starts, 3);
    assert.equal(h.creations, 0);
    assert.equal(await h.bridge.send("Implement the isolated change", []), true);
    assert.equal(h.snapshot.sessions.length, 1);
    assert.equal(h.snapshot.sessions[0].id, id);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal(h.creations, 1);
    assert.equal((await h.bridge.setConversationWorkspace(id, local)).ok, false);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.equal(h.starts, 4);
    assert.equal(h.creations, 1);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Implement the isolated change"]]);
  } finally {
    h.close();
  }
});

test("in-flight workspace selection blocks source tasks and terminal until the selected worktree is ready", async () => {
  const h = harness();
  let release;
  try {
    const id = await h.bridge.openSession("/source", "default");
    const local = { ...options, worktree: false, acknowledgeShared: true };
    assert.equal((await h.bridge.setConversationWorkspace(id, local)).ok, true);
    const worktree = {
      ...options,
      baseRef: "refs/heads/topic",
      baseCommit: "b".repeat(40),
    };
    h.holdSelection(new Promise((resolve) => { release = resolve; }));
    const selecting = h.bridge.setConversationWorkspace(id, worktree);
    await flush();
    assert.equal(calls(h, "conversation_workspace_set_deferred").length, 2);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal(await h.bridge.send("Do not start a source task", []), false);
    assert.equal(await h.bridge.steer("Do not steer", []), false);
    assert.equal(await h.bridge.followUp("Do not queue", []), false);
    assert.equal((await h.bridge.goalStart("Do not start a goal", 1000, [])).ok, false);
    assert.equal((await h.bridge.terminalOpen(id, 80, 24)).ok, false);
    assert.deepEqual(
      calls(h, "send_command")
        .map(({ json }) => JSON.parse(json).type)
        .filter((type) => !metadataCommands.has(type)),
      [],
    );
    assert.deepEqual(calls(h, "terminal_open"), []);
    assert.equal(h.starts, 2);
    assert.equal(h.creations, 0);
    release();
    assert.equal((await selecting).ok, true);
    assert.equal(h.snapshot.sessions[0].deferredWorkspace.worktree, true);
    assert.equal(await h.bridge.send("Work on the selected topic", []), true);
    assert.equal(h.snapshot.sessions[0].id, id);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.equal(h.snapshot.sessions[0].branch, "feat/topic-task");
    assert.equal(h.starts, 4);
    assert.equal(h.creations, 1);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Work on the selected topic"]]);
  } finally {
    release?.();
    h.close();
  }
});

test("a running Local terminal prevents changing the workspace", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    assert.equal((await h.bridge.terminalOpen(id, 80, 24)).ok, false);
    assert.equal((await h.bridge.setConversationWorkspace(id, {
      ...options, worktree: false, acknowledgeShared: true,
    })).ok, true);
    assert.equal((await h.bridge.terminalOpen(id, 80, 24)).ok, true);
    const refused = await h.bridge.setConversationWorkspace(id, options);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /terminal/i);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal(h.creations, 0);
    assert.deepEqual(prompts(h), []);
  } finally {
    h.close();
  }
});

test("an isolated conversation exposes its own branch and files instead of its source checkout", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    assert.equal(await h.bridge.send("Isolate the requested feature", []), true);
    assert.equal(h.snapshot.sessions.length, 1);
    assert.equal(h.snapshot.activeSessionId, id);
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.equal(h.snapshot.sessions[0].workspace.projectPath, "/source");
    assert.equal(h.snapshot.sessions[0].branch, "feat/isolated");
    assert.equal(
      (await h.bridge.gitBrowserStatus()).value.repo.branch,
      "feat/isolated",
    );
    assert.deepEqual(own(await h.bridge.listFiles("")), ["isolated-only.txt"]);
    const focused = await h.bridge.openProject(`/isolated/${id}`);
    assert.equal(focused, id);
    assert.equal(await h.bridge.openProject("/source"), id);
    assert.equal(
      h.snapshot.conversationSetup,
      null,
      "selecting the source project must reuse its worktree conversation",
    );
    assert.equal(h.starts, 2, "focusing either folder must not start another process");
    assert.equal(h.creations, 1);
  } finally {
    h.close();
  }
});

test("detached tabs follow branch creation, same-branch Git changes and detach without reopening", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    assert.equal(await h.bridge.send("Create a branch for this feature", []), true);
    h.gitChanged(id, null);
    assert.equal(h.snapshot.sessions[0].branch, null);
    h.gitChanged(id, "feat/semantic-task");
    assert.equal(h.snapshot.sessions[0].branch, "feat/semantic-task");
    const revision = h.snapshot.sessions[0].gitRevision;
    h.gitChanged(id, "feat/semantic-task");
    assert.equal(h.snapshot.sessions[0].branch, "feat/semantic-task");
    assert.equal(h.snapshot.sessions[0].gitRevision, revision + 1);
    h.gitChanged(id, null);
    assert.equal(h.snapshot.sessions[0].branch, null);
    assert.equal(h.snapshot.sessions[0].gitRevision, revision + 2);
    assert.equal(h.starts, 2);
  } finally {
    h.close();
  }
});

test("Git branch switching waits until the deferred workspace is ready", async () => {
  const h = harness();
  let releaseStop, releaseStart;
  try {
    const id = await h.bridge.openSession("/source", "default");
    const pending = await h.bridge.gitSwitchBranch("topic", false);
    assert.equal(pending.ok, false);
    assert.equal(h.snapshot.sessions[0].branch, "main");
    assert.deepEqual(calls(h, "workspace_switch_branch"), []);
    h.holdStop(new Promise((resolve) => { releaseStop = resolve; }));
    h.hold(new Promise((resolve) => { releaseStart = resolve; }));
    const sending = h.bridge.send("Prepare the branch work", []);
    await flush();
    assert.equal(h.snapshot.sessions[0].workspacePreparing, true);
    assert.equal((await h.bridge.gitSwitchBranch("topic", false)).ok, false);
    assert.deepEqual(calls(h, "workspace_switch_branch"), []);
    releaseStop();
    await flush();
    assert.equal(h.snapshot.sessions[0].workspacePreparing, true);
    assert.equal((await h.bridge.gitSwitchBranch("topic", false)).ok, false);
    assert.deepEqual(calls(h, "workspace_switch_branch"), []);
    releaseStart();
    assert.equal(await sending, true);
    assert.equal((await h.bridge.gitSwitchBranch("topic", false)).ok, true);
    assert.deepEqual(calls(h, "workspace_switch_branch"), [
      { path: `/isolated/${id}`, name: "topic", remote: false },
    ]);
    assert.equal(h.snapshot.sessions[0].branch, "topic");
    assert.equal((await h.bridge.gitBrowserStatus()).value.repo.branch, "topic");
    assert.equal(h.creations, 1);
  } finally {
    releaseStop?.();
    releaseStart?.();
    h.close();
  }
});

test("a branch event during initial inspection is not lost or overwritten by its stale result", async () => {
  const h = harness({ watchChangeDuringStart: "feat/after-inspection" });
  try {
    const id = await h.bridge.openSession("/source", "default");
    assert.equal(await h.bridge.send("Inspect the branch", []), true);
    assert.equal(
      h.snapshot.sessions.find((session) => session.id === id).branch,
      "feat/after-inspection",
    );
  } finally {
    h.close();
  }
});

test("a failed first-prompt spawn keeps the tab pending and retries the same prepared checkout", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    h.fail("Agent could not start: disk full");
    assert.equal(await h.bridge.send("Repair the storage bug", []), false);
    assert.equal(h.snapshot.sessions.length, 1);
    assert.equal(h.snapshot.activeSessionId, id);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.ok(h.snapshot.sessions[0].deferredWorkspace);
    assert.match(h.snapshot.sessions[0].workspaceError, /disk full/);
    assert.deepEqual(prompts(h), []);
    assert.equal(h.creations, 1);
    assert.equal(h.hasProcess(id), false, "native refuses to replace a retained checkout with the source");
    assert.match(h.snapshot.sessions[0].workspaceError, /retry the first prompt/i);
    h.fail(null);
    assert.equal(await h.bridge.send("Repair the storage bug", []), true);
    assert.equal(h.snapshot.sessions.length, 1);
    assert.equal(h.snapshot.sessions[0].id, id);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal(h.creations, 1);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Repair the storage bug"]]);
    assert.deepEqual(calls(h, "start_session").map(({ args }) => args.sessionId),
      [id, id, id, id]);
  } finally {
    h.close();
  }
});

test("naming failure restores metadata controls and preserves preferences for a single checkout on retry", async () => {
  const h = harness({ model: { provider: "example", id: "original", name: "Original" }, thinkingLevel: "low" });
  try {
    const id = await h.bridge.openSession("/source", "default");
    const chosen = { provider: "example", id: "chosen", name: "Chosen" };
    h.bridge.setModel(chosen);
    await h.bridge.setThinkingLevel("high");
    await flush();
    h.failNaming("Naming model unavailable");
    assert.equal(await h.bridge.send("Implement the retained draft", []), false);
    await flush();
    assert.equal(h.hasProcess(id), true);
    assert.equal(h.snapshot.activeSessionId, id);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.ok(h.snapshot.sessions[0].deferredWorkspace);
    assert.match(h.snapshot.sessions[0].workspaceError, /naming model unavailable/i);
    assert.equal(h.snapshot.model.id, chosen.id);
    assert.equal(h.snapshot.thinkingLevel, "high");
    assert.equal(h.creations, 0);
    assert.deepEqual(prompts(h), []);
    const starts = calls(h, "start_session");
    assert.equal(starts.length, 3);
    assert.equal(starts[1].args.firstPrompt.attempt, 1);
    assert.equal(starts[2].args.sessionId, id);
    assert.equal(starts[2].args.cwd, "/source");
    assert.equal(starts[2].args.firstPrompt, undefined);
    assert.equal(starts[2].args.deferredWorkspace, undefined);
    assert.equal(starts[2].args.workspace, undefined);
    assert.equal(starts[2].args.resume, null);
    const next = { provider: "example", id: "replacement", name: "Replacement" };
    h.bridge.setModel(next);
    await h.bridge.setThinkingLevel("medium");
    await h.bridge.login("example");
    await flush();
    assert.equal(h.snapshot.model.id, next.id);
    assert.equal(h.snapshot.thinkingLevel, "medium");
    h.failNaming(null);
    assert.equal(await h.bridge.send("Implement the retained draft", []), true);
    assert.equal(h.creations, 1);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.deepEqual(own(calls(h, "start_session").at(-1).args.firstPrompt.model), { provider: next.provider, id: next.id });
    assert.equal(h.promptStates.at(-1).model.id, next.id);
    assert.equal(h.promptStates.at(-1).thinkingLevel, "medium");
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]), [[id, "Implement the retained draft"]]);
  } finally {
    h.close();
  }
});


test("first send prepares once, restores model and thinking, and sends each prompt once", async () => {
  const model = { provider: "example", id: "model-a", name: "Model A" };
  const h = harness({ model, thinkingLevel: "high" });
  let release, releaseStop;
  try {
    const id = await h.bridge.openSession("/source", "work");
    await flush();
    h.holdStop(new Promise((resolve) => { releaseStop = resolve; }));
    h.hold(new Promise((resolve) => { release = resolve; }));
    const sending = h.bridge.send("Visible prompt", [], "Raw task description");
    await flush();
    assert.equal(calls(h, "stop_session").length, 1);
    assert.equal(h.starts, 1, "the replacement must await native stop completion");
    assert.equal(h.creations, 0);
    releaseStop();
    await flush();
    assert.equal(h.snapshot.sessions[0].workspacePreparing, true);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.ok(h.snapshot.sessions[0].deferredWorkspace);
    assert.deepEqual(prompts(h), []);
    assert.equal(await h.bridge.send("Do not duplicate", []), false);
    assert.equal(h.creations, 1);
    const starts = calls(h, "start_session");
    assert.equal(starts.length, 2);
    assert.equal(starts[1].args.sessionId, id);
    assert.equal(starts[1].args.firstPrompt.text, "Raw task description");
    assert.deepEqual(own(starts[1].args.firstPrompt.model), {
      provider: model.provider,
      id: model.id,
    });
    const stopIndex = h.commands.findIndex((entry) =>
      entry.command === "stop_session" && entry.args.sessionId === id);
    const restartIndex = h.commands.findIndex((entry) =>
      entry.command === "start_session" && entry.args.args.firstPrompt);
    assert.ok(stopIndex >= 0 && stopIndex < restartIndex);
    release();
    assert.equal(await sending, true);
    assert.equal(h.snapshot.sessions[0].workspacePreparing, false);
    assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);
    assert.equal(await h.bridge.send("Follow-up", []), true);
    assert.equal(h.starts, 2);
    assert.equal(h.creations, 1);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Visible prompt"], [id, "Follow-up"]]);
    const frames = calls(h, "send_command")
      .filter(({ sessionId }) => sessionId === id)
      .map(({ json }) => JSON.parse(json));
    const modelIndex = frames.findIndex((frame) =>
      frame.type === "set_model" && frame.provider === model.provider && frame.modelId === model.id);
    const thinkingIndex = frames.findIndex((frame) =>
      frame.type === "set_thinking_level" && frame.level === "high");
    const promptIndex = frames.findIndex((frame) =>
      frame.type === "prompt" && frame.message === "Visible prompt");
    assert.ok(modelIndex >= 0 && modelIndex < thinkingIndex && thinkingIndex < promptIndex);
  } finally {
    release?.();
    releaseStop?.();
    h.close();
  }
});

for (const heldPhase of ["stop", "first-prompt start"]) {
  for (const closeFirst of [true, false]) {
    test(`closing during ${heldPhase} cancels the send when ${closeFirst ? "close" : "preparation"} settles first`, async () => {
      const h = harness();
      let releaseWork, releaseClose;
      try {
        const id = await h.bridge.openSession("/source", "default");
        assert.equal(h.hasProcess(id), true);
        const workGate = new Promise((resolve) => { releaseWork = resolve; });
        if (heldPhase === "stop") h.holdStop(workGate);
        else h.hold(workGate);
        const sending = h.bridge.send("Do not send after close", []);
        await flush();
        assert.equal(h.snapshot.sessions[0].workspacePreparing, true);
        assert.equal(h.starts, heldPhase === "stop" ? 1 : 2);
        if (!closeFirst)
          h.holdClose(new Promise((resolve) => { releaseClose = resolve; }));
        const closing = h.bridge.closeSessionGuarded(id);
        await flush();
        assert.equal(h.snapshot.closeConfirm, null);
        assert.equal(h.snapshot.worktreeCloseConfirm, null);
        assert.deepEqual(calls(h, "worktree_storage_close_info"), []);
        assert.ok(calls(h, "close_tab").some((args) => args.sessionId === id));
        if (closeFirst) {
          assert.equal(await closing, true);
          assert.deepEqual(h.snapshot.sessions, []);
          releaseWork();
          assert.equal(await sending, false);
        } else {
          releaseWork();
          assert.equal(await sending, false);
          assert.deepEqual(prompts(h), []);
          releaseClose();
          assert.equal(await closing, true);
        }
        await flush();
        assert.deepEqual(prompts(h), []);
        assert.deepEqual(h.snapshot.sessions, []);
        assert.equal(h.snapshot.activeSessionId, null);
        assert.equal(h.hasProcess(id), false);
      } finally {
        releaseWork?.();
        releaseClose?.();
        h.close();
      }
    });
  }
}

for (const cancelMethod of ["abort", "composer"]) {
  test(`${cancelMethod} before source stop prevents a late first-prompt start`, async () => {
    const h = harness();
    let releaseStop;
    try {
      const id = await h.bridge.openSession("/source", "default");
      h.holdStop(new Promise(resolve => { releaseStop = resolve; }));
      const sending = h.bridge.send("Cancelled before naming", [{ type: "image", data: "draft" }]);
      await flush();
      assert.equal(calls(h, "stop_session").length, 1);
      if (cancelMethod === "abort") assert.equal(await h.bridge.abort(), true);
      else assert.equal(h.bridge.cancelWorkspacePreparation(id), true);
      await flush();
      assert.deepEqual(calls(h, "conversation_workspace_cancel"), [{ sessionId: id, attempt: 1 }]);
      h.holdStop(null);
      releaseStop();
      assert.equal(await sending, false);
      assert.equal(h.starts, 2, "the metadata source is restored");
      assert.equal(calls(h, "start_session").filter(({ args }) => args.firstPrompt).length, 0);
      assert.equal(h.snapshot.sessions[0].deferredWorkspace.worktree, true);
      assert.equal(h.snapshot.sessions[0].path, "/source");
      assert.equal(h.creations, 0);
      assert.deepEqual(prompts(h), []);
      assert.equal(await h.bridge.send("Retry after cancellation", []), true);
      assert.equal(h.creations, 1);
      assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]), [[id, "Retry after cancellation"]]);
    } finally {
      releaseStop?.();
      h.close();
    }
  });
}

test("cancel while native naming is held stops it and restores a retryable metadata source", async () => {
  const h = harness();
  try {
    const id = await h.bridge.openSession("/source", "default");
    h.holdNaming(new Promise(() => {}));
    const sending = h.bridge.send("Cancel during naming", []);
    await flush();
    assert.equal(calls(h, "start_session").filter(({ args }) => args.firstPrompt).length, 1);
    assert.equal(h.creations, 0);
    assert.equal(h.bridge.cancelWorkspacePreparation(id), true);
    assert.equal(await sending, false);
    assert.deepEqual(calls(h, "conversation_workspace_cancel"), [{ sessionId: id, attempt: 1 }]);
    assert.equal(h.snapshot.sessions[0].path, "/source");
    assert.equal(h.snapshot.sessions[0].deferredWorkspace.worktree, true);
    assert.equal(h.hasProcess(id), true);
    assert.deepEqual(prompts(h), []);
    h.holdNaming(null);
    assert.equal(await h.bridge.send("Retry after naming stopped", []), true);
    assert.equal(h.creations, 1);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]), [[id, "Retry after naming stopped"]]);
  } finally {
    h.close();
  }
});

test("an overtaking cancel blocks its start but an older cancel cannot stop a retry", async () => {
  const h = harness();
  let releaseAdmission, releaseNaming;
  try {
    const id = await h.bridge.openSession("/source", "default");
    h.holdAdmission(new Promise(resolve => { releaseAdmission = resolve; }));
    const first = h.bridge.send("First attempt", []);
    await flush();
    assert.equal(calls(h, "start_session").at(-1).args.firstPrompt.attempt, 1);
    assert.equal(h.bridge.cancelWorkspacePreparation(id), true);
    await flush();
    h.holdAdmission(null);
    releaseAdmission();
    assert.equal(await first, false);
    assert.equal(h.creations, 0);
    assert.equal(h.hasProcess(id), true);

    h.holdNaming(new Promise(resolve => { releaseNaming = resolve; }));
    const retry = h.bridge.send("Second attempt", []);
    await flush();
    assert.equal(calls(h, "start_session").at(-1).args.firstPrompt.attempt, 2);
    await h.cancelAttempt(id, 1);
    assert.equal(h.snapshot.sessions[0].workspacePreparing, true);
    assert.deepEqual(prompts(h), []);
    releaseNaming();
    assert.equal(await retry, true);
    assert.equal(h.creations, 1);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]), [[id, "Second attempt"]]);
  } finally {
    releaseAdmission?.();
    releaseNaming?.();
    h.close();
  }
});



test("aborting a pending first send suppresses its prompt and a later send reuses the checkout", async () => {
  const h = harness();
  let release;
  try {
    const id = await h.bridge.openSession("/source", "default");
    h.hold(new Promise((resolve) => { release = resolve; }));
    const sending = h.bridge.send("Cancelled work", []);
    await flush();
    h.bridge.abort();
    release();
    assert.equal(await sending, false);
    assert.deepEqual(prompts(h), []);
    assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
    assert.equal(await h.bridge.send("Proceed instead", []), true);
    assert.equal(h.creations, 1);
    assert.equal(h.starts, 2);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[id, "Proceed instead"]]);
  } finally {
    release?.();
    h.close();
  }
});

for (const interrupted of ["failed stop", "cancelled preparation"]) {
  test(`cycling model and thinking after ${interrupted} settles before a retry`, async () => {
    const model = { provider: "example", id: "original", name: "Original" };
    const cycledModel = { provider: "example", id: "new-model", name: "New Model" };
    const h = harness({ model, thinkingLevel: "low", cycledModel, cycledThinkingLevel: "high" });
    let releaseStart, releaseModel, releaseThinking;
    try {
      const id = await h.bridge.openSession("/source", "default");
      await flush();
      if (interrupted === "failed stop") {
        h.failStop("stop refused");
        assert.equal(await h.bridge.send("First attempt", []), false);
        assert.match(h.snapshot.sessions[0].workspaceError, /stop refused/);
        assert.ok(h.snapshot.sessions[0].deferredWorkspace);
        h.failStop(null);
      } else {
        h.hold(new Promise(resolve => { releaseStart = resolve; }));
        const first = h.bridge.send("First attempt", []);
        await flush();
        assert.equal(h.creations, 1);
        await h.bridge.abort();
        releaseStart();
        assert.equal(await first, false);
        assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
      }
      assert.equal(h.hasProcess(id), true);
      assert.deepEqual(prompts(h), []);

      h.holdCycle("cycle_model", new Promise(resolve => { releaseModel = resolve; }));
      h.holdCycle("cycle_thinking_level", new Promise(resolve => { releaseThinking = resolve; }));
      h.bridge.cycleModel();
      h.bridge.cycleThinking();
      const stopsBeforeRetry = calls(h, "stop_session").length;
      const startsBeforeRetry = h.starts;
      const retry = h.bridge.send("Retry with updated preferences", []);
      await flush();
      assert.equal(calls(h, "stop_session").length, stopsBeforeRetry);
      assert.equal(h.starts, startsBeforeRetry);
      assert.deepEqual(prompts(h), []);

      releaseModel();
      await flush();
      assert.equal(calls(h, "stop_session").length, stopsBeforeRetry);
      assert.equal(h.starts, startsBeforeRetry);
      assert.deepEqual(prompts(h), [], "one pending preference still blocks the task");
      releaseThinking();
      assert.equal(await retry, true);

      if (interrupted === "failed stop") {
        const firstPrompt = calls(h, "start_session").at(-1).args.firstPrompt;
        assert.equal(firstPrompt.text, "Retry with updated preferences");
        assert.deepEqual(own(firstPrompt.model), { provider: cycledModel.provider, id: cycledModel.id });
      } else {
        assert.equal(h.starts, startsBeforeRetry, "retry uses the prepared target");
      }
      assert.equal(h.creations, 1);
      assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
      assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
        [[id, "Retry with updated preferences"]]);
      assert.deepEqual(h.promptStates.map(({ sessionId, message, model, thinkingLevel }) =>
        [sessionId, message, model?.provider, model?.id, thinkingLevel]),
      [[id, "Retry with updated preferences", cycledModel.provider, cycledModel.id, "high"]]);
    } finally {
      releaseStart?.();
      releaseModel?.();
      releaseThinking?.();
      h.close();
    }
  });
}

for (const method of ["send", "steer"]) {
  for (const rejection of ["false", "throw"]) {
    test(`${method} rechecks a ${rejection} guard after first-prompt preparation and keeps the checkout for retry`, async () => {
      const h = harness();
      let release, allowed = true, refused = 0;
      try {
        const id = await h.bridge.openSession("/source", "default");
        h.hold(new Promise(resolve => { release = resolve; }));
        const canSend = () => {
          if (allowed) return true;
          refused++;
          if (rejection === "throw") throw new Error("remote access revoked");
          return false;
        };
        const sending = h.bridge[method]("Blocked remote message", undefined, "Raw remote task", canSend);
        await flush();
        assert.equal(h.starts, 2);
        assert.equal(h.creations, 1);
        assert.equal(calls(h, "start_session")[1].args.firstPrompt.text, "Raw remote task");
        assert.equal(h.snapshot.sessions[0].workspacePreparing, true);
        assert.deepEqual(prompts(h), []);

        allowed = false;
        release();
        const result = await sending.then(value => ({ value }), error => ({ error }));
        if (result.error) {
          assert.equal(rejection, "throw");
          assert.match(result.error.message, /remote access revoked/);
        } else {
          assert.equal(result.value, false);
        }
        assert.ok(refused > 0, "the guard must be rechecked after preparation");
        const taskFrames = calls(h, "send_command")
          .map(({ json }) => JSON.parse(json))
          .filter(frame => ["prompt", "steer", "follow_up"].includes(frame.type));
        assert.deepEqual(taskFrames, []);
        assert.equal(h.snapshot.sessions[0].id, id);
        assert.equal(h.snapshot.sessions[0].path, `/isolated/${id}`);
        assert.equal(h.snapshot.sessions[0].workspacePreparing, false);
        assert.equal(h.snapshot.sessions[0].deferredWorkspace, null);

        assert.equal(await h.bridge.send("Retry in the prepared checkout", []), true);
        assert.equal(h.creations, 1);
        assert.equal(h.starts, 2);
        assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
          [[id, "Retry in the prepared checkout"]]);
      } finally {
        release?.();
        h.close();
      }
    });
  }

  test(`${method} delivers a still-authorized first prompt after preparation`, async () => {
    const h = harness();
    let release, guardCalls = 0;
    try {
      const id = await h.bridge.openSession("/source", "default");
      h.hold(new Promise(resolve => { release = resolve; }));
      const sending = h.bridge[method]("Allowed remote message", undefined, "Raw allowed task", () => {
        guardCalls++;
        return true;
      });
      await flush();
      assert.equal(calls(h, "start_session")[1].args.firstPrompt.text, "Raw allowed task");
      assert.deepEqual(prompts(h), []);
      release();
      assert.equal(await sending, true);
      assert.ok(guardCalls > 0);
      assert.deepEqual(prompts(h).map(({ sessionId, frame }) =>
        [sessionId, frame.message, frame.streamingBehavior ?? null]),
      [[id, "Allowed remote message", method === "steer" ? "steer" : null]]);
      assert.equal(h.creations, 1);
    } finally {
      release?.();
      h.close();
    }
  });
}

test("switching tabs during preparation never sends the original prompt to the new tab", async () => {
  const h = harness();
  let release;
  try {
    const origin = await h.bridge.openSession("/source", "default");
    h.hold(new Promise((resolve) => { release = resolve; }));
    const sending = h.bridge.send("Origin only", []);
    await flush();
    const other = await h.bridge.resumeSession({
      path: "/saved/other.jsonl",
      profile_id: "default",
      cwd: "/other",
      title: "Other",
    });
    assert.equal(h.snapshot.activeSessionId, other);
    release();
    assert.equal(await sending, false);
    assert.deepEqual(prompts(h), []);
    assert.equal(h.snapshot.activeSessionId, other);
    await h.bridge.activateSession(origin);
    assert.equal(await h.bridge.send("Resume on origin", []), true);
    assert.deepEqual(prompts(h).map(({ sessionId, frame }) => [sessionId, frame.message]),
      [[origin, "Resume on origin"]]);
    assert.equal(h.creations, 1);
  } finally {
    release?.();
    h.close();
  }
});

test("resuming a saved worktree conversation reuses its folder without another setup", async () => {
  const h = harness();
  try {
    const id = await h.bridge.resumeSession({
      path: "/saved/conversation.jsonl",
      profile_id: "default",
      cwd: "/isolated/existing",
      title: "Existing task",
    });
    assert.equal(h.snapshot.conversationSetup, null);
    assert.equal(h.snapshot.sessions[0].id, id);
    assert.equal(h.snapshot.sessions[0].path, "/isolated/existing");
    assert.equal(h.snapshot.sessions[0].name, "Existing task");
    assert.equal(h.snapshot.sessions[0].workspace.projectPath, "/source");
    assert.equal(h.snapshot.sessions[0].workspace.worktree, true);
    assert.equal(
      h.snapshot.sessions[0].workspace.baseRef,
      null,
      "history does not invent an unrecorded base",
    );
    assert.equal(await h.bridge.openProject("/source"), id);
    assert.equal(
      (await h.bridge.gitBrowserStatus()).value.repo.branch,
      "feat/isolated",
    );
    assert.equal(h.starts, 1);
  } finally {
    h.close();
  }
});

test("History lists all profiles while preserving the active conversation and project scope", async () => {
  const savedSessions = [
    {
      path: "/saved/local.jsonl",
      cwd: "/shared",
      title: "Local task",
      profile_id: "default",
      profile_name: "Local",
    },
    {
      path: "/saved/work.jsonl",
      cwd: "/shared",
      title: "Work task",
      profile_id: "work",
      profile_name: "Work account",
    },
    {
      path: "/saved/personal.jsonl",
      cwd: "/personal",
      title: "Personal task",
      profile_id: "personal",
      profile_name: "Personal",
    },
  ];
  const h = harness({ savedSessions });
  try {
    await h.bridge.renameProfile("work", "Work account");
    const active = await h.bridge.openSession("/shared", "work");
    const listed = own(await h.bridge.listSavedSessions());
    assert.deepEqual(listed, savedSessions);
    assert.equal(h.snapshot.activeSessionId, active);
    assert.equal(
      h.snapshot.sessions.find((tab) => tab.id === active).profile,
      "work",
    );
    assert.deepEqual(
      own(await h.bridge.listSavedSessions("/shared")),
      savedSessions.filter((session) => session.cwd === "/shared"),
    );
    assert.equal(h.starts, 1);
  } finally {
    h.close();
  }
});

test("History restores the row's profile and worktree, then focuses the same conversation", async () => {
  const h = harness();
  try {
    await h.bridge.renameProfile("work", "Work account");
    const work = await h.bridge.openSession("/source", "work");
    const saved = {
      path: "/saved/personal.jsonl",
      cwd: "/isolated/personal",
      title: "Personal task",
      profile_id: "personal",
    };
    const personal = await h.bridge.resumeSession(saved);
    const tab = h.snapshot.sessions.find((session) => session.id === personal);
    assert.equal(tab.profile, "personal");
    assert.equal(tab.path, "/isolated/personal");
    assert.equal(tab.workspace.projectPath, "/source");
    assert.equal(h.snapshot.conversationSetup, null);
    assert.equal(h.snapshot.activeSessionId, personal);
    assert.equal(
      h.snapshot.sessions.find((session) => session.id === work).profile,
      "work",
    );
    await h.bridge.activateSession(work);
    assert.equal(await h.bridge.resumeSession(saved), personal);
    assert.equal(h.snapshot.activeSessionId, personal);
    assert.equal(h.starts, 2);
    await h.bridge.activateSession(work);
    const local = await h.bridge.resumeSession({
      path: "/saved/local.jsonl",
      cwd: "/source",
      title: "Local task",
      profile_id: "default",
    });
    assert.equal(
      h.snapshot.sessions.find((session) => session.id === local).profile,
      "default",
    );
  } finally {
    h.close();
  }
});

test("History rejects missing or deleted profiles without replacing the active conversation", async () => {
  const h = harness();
  try {
    const active = await h.bridge.resumeSession({
      path: "/saved/local.jsonl",
      cwd: "/source",
      title: "Local task",
      profile_id: "default",
    });
    for (const profile of [undefined, "removed"]) {
      await assert.rejects(
        h.bridge.resumeSession({
          path: "/saved/stale.jsonl",
          cwd: "/other",
          profile_id: profile,
        }),
        /originating profile|unknown profile/,
      );
      assert.equal(h.snapshot.activeSessionId, active);
      assert.deepEqual(
        h.snapshot.sessions.map((session) => session.id),
        [active],
      );
      assert.equal(h.snapshot.sessions[0].profile, "default");
    }
  } finally {
    h.close();
  }
});

test("concurrent history resumes share one tab and agent", async () => {
  const h = harness();
  try {
    const session = {
      path: "/saved/conversation.jsonl",
      profile_id: "default",
      cwd: "/isolated/existing",
      title: "Existing task",
    };
    const [first, second] = await Promise.all([
      h.bridge.resumeSession(session),
      h.bridge.resumeSession(session),
    ]);
    assert.equal(second, first);
    assert.equal(h.snapshot.sessions.length, 1);
    assert.equal(h.starts, 1);
    assert.equal(h.snapshot.sessions[0].path, session.cwd);
  } finally {
    h.close();
  }
});

test("project-default editing never starts an agent", async () => {
  const h = harness();
  try {
    const configured = h.bridge.configureProjectWorkspace("/source", "default");
    const request = h.snapshot.conversationSetup;
    assert.equal(request.configure, true);
    assert.equal(
      (await h.bridge.startConversationSetup(request.id, options)).ok,
      false,
    );
    assert.equal(h.starts, 0);
    assert.equal(h.snapshot.sessions.length, 0);
    h.bridge.cancelConversationSetup(request.id);
    assert.equal(await configured, null);
    assert.equal(h.starts, 0);
  } finally {
    h.close();
  }
});

const storedWorkspace = {
  id: "workspace-1",
  path: "/isolated/existing",
  projectPath: "/source",
  profile: "default",
  pinned: false,
  state: "present",
  excludedCaches: ["node_modules"],
};
const storedConversation = {
  path: "/saved/conversation.jsonl",
  cwd: storedWorkspace.path,
  profile_id: "default",
  title: "Retained work",
};

test("cancelling the worktree close question leaves the conversation open", async () => {
  const h = harness({ workspaceInfo: storedWorkspace });
  try {
    const id = await h.bridge.resumeSession(storedConversation);
    const closing = h.bridge.closeSessionGuarded(id);
    await flush();
    assert.equal(h.snapshot.worktreeCloseConfirm.path, storedWorkspace.path);
    assert.deepEqual(
      h.snapshot.sessions.map((session) => session.id),
      [id],
    );
    await h.bridge.resolveWorktreeClose("cancel");
    assert.equal(await closing, false);
    assert.equal(h.snapshot.worktreeCloseConfirm, null);
    assert.equal(h.snapshot.activeSessionId, id);
    assert.deepEqual(
      h.snapshot.sessions.map((session) => session.path),
      [storedWorkspace.path],
    );
  } finally {
    h.close();
  }
});

test("a failed restore-point close keeps the tab and permits a safe Keep retry", async () => {
  const h = harness({ workspaceInfo: storedWorkspace });
  try {
    const id = await h.bridge.resumeSession(storedConversation);
    h.failClose("Restore point verification failed: disk full");
    const closing = h.bridge.closeSessionGuarded(id);
    await flush();
    assert.equal(await h.bridge.resolveWorktreeClose("snapshotRemove"), false);
    assert.match(
      h.snapshot.worktreeCloseConfirm.error,
      /verification failed: disk full/,
    );
    assert.equal(h.snapshot.worktreeCloseConfirm.busy, false);
    assert.deepEqual(
      h.snapshot.sessions.map((session) => session.id),
      [id],
    );
    assert.equal(h.snapshot.activeSessionId, id);
    h.failClose(null);
    assert.equal(await h.bridge.resolveWorktreeClose("keep"), true);
    assert.equal(await closing, true);
    assert.deepEqual(h.snapshot.sessions, []);
    assert.equal(h.snapshot.worktreeCloseConfirm, null);
  } finally {
    h.close();
  }
});

test("the tab stays visible until native close commits and busy close cannot be cancelled", async () => {
  const h = harness({ workspaceInfo: storedWorkspace });
  let release;
  try {
    const id = await h.bridge.resumeSession(storedConversation);
    h.holdClose(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const closing = h.bridge.closeSessionGuarded(id);
    await flush();
    const committing = h.bridge.resolveWorktreeClose("snapshotRemove");
    await flush();
    assert.equal(h.snapshot.worktreeCloseConfirm.busy, true);
    assert.deepEqual(
      h.snapshot.sessions.map((session) => session.id),
      [id],
    );
    assert.equal(await h.bridge.resolveWorktreeClose("cancel"), false);
    assert.equal(h.snapshot.worktreeCloseConfirm.busy, true);
    release();
    assert.equal(await committing, true);
    assert.equal(await closing, true);
    assert.deepEqual(h.snapshot.sessions, []);
  } finally {
    release?.();
    h.close();
  }
});
