/* Stored chat workspace: files are private until exported or copied to a project. */
(function () {
  const { Icon } = window;
  const formatBytes = window.OMP_UPDATER.formatBytes;

  function ChatWorkspace({ chat, tabs, activeId, voiceActive, bridge, onClose, onChanged }) {
    const [files, setFiles] = React.useState(null);
    const [usage, setUsage] = React.useState(null);
    const [filesError, setFilesError] = React.useState(null);
    const [usageError, setUsageError] = React.useState(null);
    const [error, setError] = React.useState(null);
    const [notice, setNotice] = React.useState(null);
    const [confirmDelete, setConfirmDelete] = React.useState(false);
    const [action, setAction] = React.useState(null);
    const actionRef = React.useRef(false);
    const panelRef = React.useRef(null);
    const closeRef = React.useRef(null);
    const latestClose = React.useRef(onClose);
    latestClose.current = onClose;
    window.useModalFocus(closeRef);

    const openTabs = tabs.filter(t => t.scratchId === chat.id);
    const busy = openTabs.some(t => window.OMP_TURN_STATUS.isBusyRunState(t.runState) || (t.id === activeId && voiceActive));
    const name = openTabs[0]?.name || chat.name || "untitled chat";

    React.useEffect(() => {
      let cancelled = false;
      bridge.scratchFiles(chat.id).then(value => { if (!cancelled) setFiles(value); })
        .catch(err => { if (!cancelled) setFilesError(String(err?.message ?? err)); });
      bridge.scratchUsage(chat.id).then(value => { if (!cancelled) setUsage(value); })
        .catch(err => { if (!cancelled) setUsageError(String(err?.message ?? err)); });
      return () => { cancelled = true; };
    }, [bridge, chat.id]);

    React.useEffect(() => {
      const onKey = e => {
        e.stopPropagation();
        const panel = panelRef.current;
        if (e.key === "Escape") {
          e.preventDefault();
          if (!actionRef.current) latestClose.current();
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const buttons = [...(panel?.querySelectorAll("button:not(:disabled)") ?? [])];
          if (!buttons.length) return;
          const i = buttons.indexOf(document.activeElement);
          buttons[i < 0 ? 0 : (i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
          return;
        }
        if (panel?.contains(e.target) && !e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Enter" || e.key === " ")) return;
        e.preventDefault();
        if (!panel?.contains(e.target)) closeRef.current?.focus();
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    }, []);

    const run = async (label, operation) => {
      if (actionRef.current || busy) return;
      actionRef.current = true;
      setAction(label); setError(null); setNotice(null);
      try { await operation(); }
      catch (err) { setError(String(err?.message ?? err)); }
      finally { actionRef.current = false; setAction(null); }
    };
    const disabled = busy || !!action;
    const exportFile = path => run("exporting", async () => {
      if (await bridge.exportScratchFile(chat.id, path)) setNotice(`Exported ${path}.`);
    });
    const promote = () => run("promoting", async () => {
      const id = await bridge.promoteChat(chat.id);
      onChanged();
      if (id) latestClose.current();
    });
    const remove = () => run("deleting", async () => {
      await bridge.deleteChat(chat.id);
      onChanged();
      latestClose.current();
    });

    return (
      <div className="bridge-scrim" style={{ paddingTop: "8vh" }} onClick={() => { if (!actionRef.current) onClose(); }}>
        <div className="bridge slide-in" ref={panelRef} role="dialog" aria-modal="true" aria-label={`Manage ${name} workspace`}
          style={{ width: "min(640px, calc(100vw - 32px))", maxHeight: "82vh" }} onClick={e => e.stopPropagation()}>
          <div className="bridge-input-row">
            <Icon name="folder" size={14} color="var(--accent)" />
            <span className="mono" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name} · workspace</span>
            <button className="btn icon ghost" ref={closeRef} disabled={!!action} aria-label="Close workspace manager" onClick={onClose}><Icon name="close" size={11} /></button>
          </div>
          <div className="bridge-body" style={{ padding: "14px 16px", maxHeight: "65vh", fontSize: "var(--d-text-sm)", color: "var(--fg-2)" }}>
            <p style={{ margin: "0 0 10px" }}>Closing a chat tab keeps its workspace. Files stay on this device until you delete the workspace.</p>
            <div className="mono" aria-live="polite" style={{ color: "var(--fg-3)", marginBottom: 12 }}>
              {usageError ? `Storage unavailable: ${usageError}` : !usage ? "Calculating storage…" : `${usage.complete ? "" : "At least "}${formatBytes(usage.bytes)} · ${usage.files} regular ${usage.files === 1 ? "file" : "files"}${usage.complete ? "" : " (scan incomplete)"}`}
            </div>
            <p style={{ margin: "0 0 12px", color: "var(--fg-4)" }}>Sizes are file contents, not disk allocation; links and other non-regular files are excluded.</p>
            {busy && <p role="status" style={{ color: "var(--amber)" }}>Wait for the chat and voice activity to finish before managing its workspace.</p>}
            {error && <p role="alert" style={{ color: "var(--rose)", overflowWrap: "anywhere" }}>{error}</p>}
            {notice && <p role="status">{notice}</p>}
            <div className="bridge-group-head" style={{ paddingLeft: 0 }}>files</div>
            {filesError ? <p role="alert" style={{ overflowWrap: "anywhere" }}>Could not list files: {filesError}</p> : files === null ? <p>Loading files…</p> : files.length === 0 ? <p>No regular files in this workspace.</p> : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {files.map(file => (
                  <div key={file.path} style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--line)", padding: "4px 0" }}>
                    <span className="mono selectable" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{file.path}</span>
                    <span className="mono" style={{ color: "var(--fg-4)", whiteSpace: "nowrap" }}>{formatBytes(file.bytes)}</span>
                    <button className="btn ghost" disabled={disabled} aria-label={`Export ${file.path}`} onClick={() => exportFile(file.path)}>export…</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 16, paddingTop: 12 }}>
              <p style={{ margin: "0 0 8px" }}>Promote copies the workspace to a new project folder. The original workspace is retained for recovery; delete it separately when no longer needed.</p>
              <button className="btn outlined" disabled={disabled} onClick={promote}>promote to project…</button>
            </div>
            <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 12 }}>
              <p style={{ margin: "0 0 8px" }}>Deleting removes this chat entry, not omp history. Files are deleted only when no other chat or profile shares the workspace. Close this chat's tabs first.</p>
              {!confirmDelete ? (
                <button className="btn outlined danger" disabled={disabled || openTabs.length > 0} onClick={() => setConfirmDelete(true)}>delete workspace…</button>
              ) : (
                <div role="group" aria-label="Confirm workspace deletion">
                  <p>This permanently removes this chat entry. Unshared workspace files are deleted; shared files and conversation history remain.</p>
                  <button className="btn ghost" disabled={!!action} onClick={() => setConfirmDelete(false)}>cancel</button>{" "}
                  <button className="btn outlined danger" disabled={disabled || openTabs.length > 0} onClick={remove}>delete workspace permanently</button>
                </div>
              )}
            </div>
            {action && <p role="status">{action}…</p>}
          </div>
        </div>
      </div>
    );
  }
  window.ChatWorkspace = ChatWorkspace;
})();
