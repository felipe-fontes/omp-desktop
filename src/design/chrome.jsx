/* ═════════════════════════════════════════════════════════════════════
   chrome.jsx — window chrome, tabs, status bar
   - WindowChrome (traffic lights, title)
   - TabBar
   - StatusBar
   ═════════════════════════════════════════════════════════════════════ */

const { Icon, DEFAULT_PROFILE_ID, TabGroupChip, TabRunDot, TabLabel, RenameField, WorktreeIndicator, BranchMenu: _CH_BranchMenu } = window;
const { groupTabs } = window.OMP_PROJECT_NAV;

// Thin wrappers around the shared `OMP_KEYMAP.hintFor`/`hintKeyFor` — same
// guard and rationale as composer.jsx's copy (kept local rather than a
// third file to import from; see composer.jsx's doc comment for why the
// registry-not-loaded fallback can't move into keymap.js itself).
function hintFor(actionId, fallback) {
  return window.OMP_KEYMAP ? window.OMP_KEYMAP.hintFor(actionId) : fallback;
}

// ── Platform detection ────────────────────────────────────────────────
const IS_WIN = typeof navigator !== "undefined" &&
  (navigator.userAgent.includes("Windows") || navigator.platform.startsWith("Win"));

// ── Window chrome ─────────────────────────────────────────────────────
function WindowChrome({ project, prStatus, onConfigureProject }) {
  const sourcePath = project.scratchId ? null : window.OMP_PROJECT_NAV.projectPath(project);
  const projectName = sourcePath ? window.OMP_PROJECT_NAV.basename(sourcePath) : project.name;
  const titlePr = window.OMP_PR_STATUS.present(prStatus);
  const nativeMac = document.documentElement.classList.contains("native-macos");
  return (
    <div className="chrome" data-tauri-drag-region={nativeMac ? "false" : true}>
      {/* Native macOS traffic lights belong to NSWindow, not the webview. */}
      {!IS_WIN && !nativeMac && (
        <div className="chrome-lights">
          <span className="light red" />
          <span className="light amber" />
          <span className="light green" />
        </div>
      )}

      <div className="chrome-title">
        {project.id && <>
          <span className="mono chrome-brand" style={{ color: "var(--fg-3)" }}>OMP</span>
          <span className="mono chrome-brand" style={{ color: "var(--fg-5)" }}>·</span>
        </>}
        <span className="chrome-project-name" title={sourcePath || undefined}>{projectName}</span>
        <WorktreeIndicator tab={project} showLabel />
        {titlePr && (
          <span className="chrome-pr">
            <window.PrStatus model={titlePr} mode="icon" />
            <span className="chrome-pr-label">{titlePr.stale ? "Last known · " : ""}{titlePr.label}</span>
            <window.PrStatus model={titlePr} mode="badges" />
          </span>
        )}
        {sourcePath && onConfigureProject && (
          <button className="chrome-project-config" title="project defaults" aria-label="project defaults"
            onClick={() => onConfigureProject(sourcePath, project.profile)}>
            <Icon name="cog" size={11} />
          </button>
        )}
      </div>

      <div className="chrome-right">

        {/* Windows controls — right side, hidden on macOS/Linux */}
        {IS_WIN && (
          <div className="win-controls">
            <button className="win-ctrl win-min" title="Minimize">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5.5h8" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
            <button className="win-ctrl win-max" title="Maximize / Restore">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
            <button className="win-ctrl win-close" title="Close">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.1" /></svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Project tabs ─────────────────────────────────────────────────────
// A tab's click props: select on click, close on middle-click, as in
// browsers (#24). WebKit before Safari 18.2 / WebKitGTK 2.46 has no
// `auxclick` and reports it as a `click` with button 1, hence the check in
// onClick too; newer engines never send `click` for button 1, so this
// can't double-fire. Swallowing the middle-button mousedown stops Windows
// autoscroll and Linux primary-selection paste from firing on the tab.
function tabClickProps(onSelect, onClose) {
  return {
    onClick: e => (e.button === 1 ? onClose?.() : onSelect?.()),
    onMouseDown: e => { if (e.button === 1) e.preventDefault(); },
    onAuxClick: e => { if (e.button === 1) { e.preventDefault(); onClose?.(); } },
  };
}

function TabBar({
  projects, activeId, onSelect, onClose, onRename, onNewChat, onNewInProject, onConfigureProject, onReorder,
  prStatuses = {}, profiles = [],
  settings, onSelectSettings, onCloseSettings,
}) {
  // Tabs can run under different profiles, so a tab whose profile is not the
  // built-in one is labelled with it — otherwise two tabs on the same folder
  // in different profiles look identical. Falls back to the raw id until the
  // profile list has loaded.
  const profileLabel = id =>
    id === DEFAULT_PROFILE_ID ? null : (profiles.find(p => p.id === id)?.name ?? id);
  // Tab whose name is being edited inline (#32); double-click enters it.
  const [renaming, setRenaming] = React.useState(null);
  // Drag to reorder (#40): projects along the bar ("projects", keyed by
  // group), and a group chip's members in its dropdown (see TabGroupChip).
  const reorder = window.useDragReorder(onReorder);
  return (
    <div className="tabs" onPointerDown={reorder.onPointerDown}>
      <button className="tab-add" title="new chat" aria-label="New chat" onClick={onNewChat}
        style={{ width: "auto", flex: "none", padding: "0 10px", gap: 5, whiteSpace: "nowrap" }}>
        <Icon name="conversation" size={11} />new chat
      </button>
      {/* Tabs on one folder + profile share a chip (#27); a project with a
          single tab renders as a plain tab. */}
      {groupTabs(projects).map((group) => {
        if (group.tabs.length > 1) {
          return (
            <TabGroupChip key={group.key}
              group={group}
              activeId={activeId}
              profileLabel={profileLabel}
              prStatuses={prStatuses}
              onSelect={onSelect}
              onClose={onClose}
              onNewInProject={onNewInProject}
              onConfigureProject={onConfigureProject}
              onRename={onRename}
              reorder={reorder}
            />
          );
        }
        const p = group.tabs[0];
        const active = p.id === activeId;
        const profile = profileLabel(p.profile);
        return (
          <div key={p.id}
            {...reorder.itemProps("projects", group.key, "x")}
            className={`tab ${active ? "active" : ""}${reorder.dropClass("projects", group.key)}`}
            title={[p.name, p.path].filter(Boolean).join("\n")}
            {...tabClickProps(() => onSelect(p.id), () => onClose?.(p.id))}
            // The first click of the pair already selected the tab.
            onDoubleClick={e => { if (onRename && !e.target.closest(".tab-close")) setRenaming(p.id); }}>
            <span className="tab-bar-mark" style={{ background: active ? p.color : "transparent" }} />
            <Icon name={p.scratchId ? "conversation" : "folder"} size={11} color={active ? p.color : "var(--fg-4)"} />
            {renaming === p.id ? (
              <RenameField value={p.name}
                onCommit={name => onRename(p.id, name)}
                onClose={() => setRenaming(null)} />
            ) : (
              <TabLabel tab={p} className="tab-name" title={[p.name, "double-click to rename"].filter(Boolean).join("\n")} />
            )}
            <WorktreeIndicator tab={p} />
            {profile && (
              <span className="chip muted tab-profile" title={`profile: ${profile}`}>{profile}</span>
            )}
            <window.PrStatus status={prStatuses[p.id]} />
            <TabRunDot state={p.runState} />
            {group.path && onConfigureProject && (
              <button className="tab-close" title="project defaults" aria-label="project defaults"
                onClick={e => { e.stopPropagation(); onConfigureProject(group.path, group.profile); }}>
                <Icon name="cog" size={10} />
              </button>
            )}
            <button className="tab-close" onClick={e => { e.stopPropagation(); onClose?.(p.id); }}><Icon name="close" size={9} /></button>
          </div>
        );
      })}
      {/* The Settings app tab (#37): pinned after the projects, never
          dragged; `changed` counts settings off their default. */}
      {settings?.open && (
        <div className={`tab app-tab ${settings.active ? "active" : ""}`}
          title={`settings (${hintFor("desktop.settings.open", "Ctrl+,")})`}
          {...tabClickProps(onSelectSettings, onCloseSettings)}>
          <span className="tab-bar-mark" style={{ background: settings.active ? "var(--fg-3)" : "transparent" }} />
          <Icon name="cog" size={12} />
          <span className="tab-name">Settings</span>
          {settings.changed > 0 && (
            <span className="tab-count" title={`${settings.changed} changed from default`}>{settings.changed}</span>
          )}
          <button className="tab-close" title={`close (${hintFor("desktop.tab.close", "Ctrl+W")})`}
            onClick={e => { e.stopPropagation(); onCloseSettings?.(); }}>
            <Icon name="close" size={9} />
          </button>
        </div>
      )}

    </div>
  );
}

// ── Status bar (footer) ──────────────────────────────────────────────
// Connection, the project's branch (a picker, design/branch-menu.jsx),
// tokens, cost, throughput and todo on the left, the app version (and an
// available update) on the right; the app's other buttons are on the
// toolbar (toolbar.jsx). The model and
// thinking level are not repeated here: the composer's pills below the
// prompt box show (and change) both. It spans the window under the
// workspace; the st-ctx meter, st-cost and st-tps cells (each with its
// separator) drop out when the window is narrow (layout/rail.css).
// `updater`: app/use-updater.jsx's result, as UpdateModal takes it.
// `branch`: the active tab's (null: no repository, or a detached HEAD);
// `tabId` keys the picker, so a tab switch closes it; `branchLocked`: an
// agent works on the folder, so the picker lists but does not switch.
function StatusBar({ ctx, todoDone, todoTotal, onTodo, updater, branch, tabId, branchLocked, bridge, keepAwake, keepAwakeSessionId, onKeepAwakeSettings }) {
  const todoChord = hintFor("desktop.panel.todo", "");
  return (
    <div className="status">
      <span className="status-cell"><span className="dot live" /> connected</span>
      {branch && <>
        <span className="status-sep">·</span>
        <_CH_BranchMenu key={tabId} branch={branch} bridge={bridge} locked={branchLocked} />
      </>}
      <span className="status-sep st-ctx">·</span>
      <span className="status-cell st-ctx mono">
        <span style={{ color: "var(--fg-3)" }}>{ctx.label}</span>
        <span className="status-bar-tube">
          <span className="status-bar-fill" style={{ width: `${Math.min(100, ctx.pct ?? 0)}%` }} />
        </span>
        <span className="st-ctx-pct" style={{ color: "var(--fg-4)" }}>{ctx.pct == null ? "—" : `${ctx.pct.toFixed(1)}%`}</span>
      </span>
      <span className="status-sep st-cost">·</span>
      <span className="status-cell st-cost mono"><span style={{ color: "var(--fg-3)" }}>cost</span> {ctx.cost}</span>
      <span className="status-sep st-tps">·</span>
      <span className="status-cell st-tps mono"><span style={{ color: "var(--fg-3)" }}>{ctx.tokensPerSec}</span> t/s</span>
      <span className="status-sep">·</span>
      <button className="status-cell btn ghost" onClick={onTodo}
        title={todoChord ? `plan kanban (${todoChord})` : "plan kanban"}
        style={{ height: 20, padding: "0 6px" }}>
        <Icon name="plan" size={11} color="var(--accent)" />
        <span style={{ color: "var(--accent)" }}>todo {todoDone}/{todoTotal}</span>
      </button>
      <span className="status-sep">·</span>
      <window.KeepAwakeCell key={keepAwakeSessionId || "none"} awake={keepAwake}
        sessionId={keepAwakeSessionId} onSettings={onKeepAwakeSettings} />
      <div className="status-gap" />
      {updater.pillVersion && (
        <button className="btn outlined update-pill mono" onClick={updater.openModal}
          title={`OMP Desktop v${updater.pillVersion} is available`}>
          <Icon name="arrowUp" size={9} />v{updater.pillVersion}
        </button>
      )}
      <button className="btn ghost app-version mono" onClick={updater.check} title="check for updates">
        {updater.version ? `v${updater.version}` : "—"}
      </button>
    </div>
  );
}



Object.assign(window, { WindowChrome, TabBar, StatusBar });
