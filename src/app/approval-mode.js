/* ═════════════════════════════════════════════════════════════════════
   approval-mode.js — omp's tool approval mode (`--approval-mode`) as the
   desktop chooses it: a global default plus a per-project override, both
   stored in Rust (`approval_mode.rs`, `approval_mode_get` returns the
   `{ default, projects }` view). Pure decisions only:
     - which mode a tab's folder resolves to (`effectiveFor`),
     - what the toolbar's approvals button shows (`statusCell`),
     - which open tabs a change restarts now / once idle (`restartPlan`),
     - the project rows of the mode editor (`projectRows`).
   live.js runs the restarts (`_applyApprovalModes`, `_respawnSession`);
   the mode editor (approvals panel and Settings → Approvals) and the
   toolbar's approvals button render from these.
   Details: docs/architecture/approval-mode.md.
   ═════════════════════════════════════════════════════════════════════ */
(function () {
  const MODES = Object.freeze([
    Object.freeze({ value: "always-ask", label: "always ask", warn: false,
      blurb: "the agent asks before every file change and every command. Only reads run on their own. \"Allow for this session\" / \"Always allow in this project\" on a prompt still work." }),
    Object.freeze({ value: "write",      label: "write",      warn: false,
      blurb: "the agent edits files on its own and asks before shell commands and anything else that runs code. Reads never ask." }),
    Object.freeze({ value: "yolo",       label: "yolo",       warn: true,
      blurb: "every tool runs without asking, shell commands included. omp's own stop for dangerous commands (rm -rf /, fork bombs, …) is skipped too. Your standing rules are kept but never needed here." }),
  ]);
  const DEFAULT_MODE = "write";

  /** Exactly one of omp's kebab-case mode strings (`"Write"` is not one). */
  function isMode(s) {
    return MODES.some(m => m.value === s);
  }

  /** Display label of a mode; an unknown string is shown as itself. */
  function labelOf(mode) {
    return MODES.find(m => m.value === mode)?.label ?? mode;
  }

  /** Actual checkout override first, then its verified source project, then
   *  the global default. Paths are canonicalized by the native workspace. */
  function effectiveFor(view, path, sourcePath = null) {
    if (!view) return DEFAULT_MODE;
    const own = path ? view.projects?.[path] : undefined;
    if (isMode(own)) return own;
    const source = sourcePath ? view.projects?.[sourcePath] : undefined;
    if (isMode(source)) return source;
    return isMode(view.default) ? view.default : DEFAULT_MODE;
  }

  function effectiveForTab(view, entry) {
    return effectiveFor(view, entry?.path || null,
      entry?.workspace?.projectPath || entry?.sourceProjectPath || null);
  }

  /** Toolbar approvals button for a tab: `running` is the label of the mode its omp
   *  runs (`approvalMode`, null until the first spawn resolves — then the
   *  target stands in), `target` the label of what its folder resolves to;
   *  `pending` while they differ (a change waiting for the tab to go idle).
   *  `label` is the one-line form (`running ⇢ target` when pending).
   *  `warn` follows the target, so yolo turns amber as soon as it is chosen. */
  function statusCell(view, entry) {
    const effective = effectiveForTab(view, entry);
    const running = isMode(entry?.approvalMode) ? entry.approvalMode : null;
    const pending = running !== null && running !== effective;
    const target = labelOf(effective);
    const shown = labelOf(running ?? effective);
    return {
      label: pending ? `${shown} ⇢ ${target}` : shown,
      running: shown,
      target,
      warn: effective === "yolo",
      pending,
    };
  }

  /** Tabs whose running mode differs from what their folder now resolves
   *  to: `now` for idle ones, `later` for busy ones (restarted when they
   *  next go idle). A failed tab has no process, and a tab with no
   *  running mode yet is still spawning — neither needs a restart. */
  function restartPlan(view, sessions) {
    const { isBusyRunState } = window.OMP_TURN_STATUS; // late-bound: turn-status.js loads after this file
    const now = [];
    const later = [];
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!isMode(s?.approvalMode) || s.approvalMode === effectiveForTab(view, s)) continue;
      if (s.runState === "failed") continue;
      (s.workspacePreparing || s.workspaceConfiguring || isBusyRunState(s.runState) ? later : now).push(s.id);
    }
    return { now, later };
  }

  /** The mode editor's project rows: the active tab's folder first (when
   *  there is one, override or not), then every other project with an
   *  override, by path. `value` is the override or the literal `"default"`
   *  (the segment that removes it); `active` marks the tab's folder. */
  function projectRows(view, activePath) {
    const rows = [];
    const own = activePath ? view?.projects?.[activePath] : undefined;
    if (activePath) rows.push({ path: activePath, value: isMode(own) ? own : "default", active: true });
    const others = Object.entries(view?.projects ?? {})
      .filter(([path, mode]) => path !== activePath && isMode(mode))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [path, mode] of others) rows.push({ path, value: mode, active: false });
    return rows;
  }

  window.OMP_APPROVAL_MODE = Object.freeze({
    MODES, DEFAULT_MODE, isMode, labelOf, effectiveFor, effectiveForTab, statusCell, restartPlan, projectRows,
  });
})();
