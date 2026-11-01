/* chat/message-actions.jsx — actions on saved conversation entries. */
const { Icon: _MA_Icon } = window;

function MessageActions({ entryId, onRewind, onFork, conversationBusy }) {
  const [confirming, setConfirming] = React.useState(false);
  const [pending, setPending] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const pendingRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const rewindRef = React.useRef(null);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const cancelConfirmation = () => {
    setConfirming(false);
    setNotice({ text: "Rewind cancelled.", error: false });
    requestAnimationFrame(() => { if (mountedRef.current) rewindRef.current?.focus(); });
  };
  const run = async (action, callback) => {
    if (conversationBusy || pendingRef.current || typeof callback !== "function") return;
    pendingRef.current = true;
    setPending(action);
    setNotice(null);
    try {
      const result = await callback(entryId);
      if (!mountedRef.current) return;
      setConfirming(false);
      if (!result?.ok) {
        setNotice(result?.cancelled
          ? { text: `${action === "rewind" ? "Rewind" : "Fork"} cancelled.`, error: false }
          : { text: result?.error || `Could not ${action} this conversation.`, error: true });
      }
    } catch (error) {
      if (mountedRef.current) {
        setConfirming(false);
        setNotice({ text: error?.message || `Could not ${action} this conversation.`, error: true });
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(null);
    }
  };

  if (!entryId || (typeof onRewind !== "function" && typeof onFork !== "function")) return null;
  const disabled = conversationBusy || pending !== null;
  return (
    <div className="message-actions" onKeyDown={event => {
      if (confirming && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!pendingRef.current) cancelConfirmation();
      }
    }}>
      <div className="message-actions-buttons" aria-label="Saved message actions">
        {typeof onRewind === "function" && (
          <button type="button" className="message-action" ref={rewindRef}
            title="Rewind conversation to before this prompt" disabled={disabled || confirming}
            onClick={() => { setNotice(null); setConfirming(true); }}>
            <_MA_Icon name="back" size={11} aria-hidden="true" /> Rewind to here
          </button>
        )}
        {typeof onFork === "function" && (
          <button type="button" className="message-action" title="Fork conversation through this message"
            disabled={disabled || confirming} onClick={() => run("fork", onFork)}>
            <_MA_Icon name="branch" size={11} aria-hidden="true" /> {pending === "fork" ? "Forking…" : "Fork from here"}
          </button>
        )}
      </div>
      {confirming && (
        <div className="message-action-confirm" role="group" aria-label="Confirm rewind">
          <span>Rewind to before this prompt? This prompt and later messages will not be in the active conversation. The original saved conversation is preserved. Workspace files will not be undone. The prompt will be restored to the composer.</span>
          <div className="message-action-confirm-buttons">
            <button type="button" className="btn ghost" autoFocus disabled={pending !== null} onClick={cancelConfirmation}>Keep conversation</button>
            <button type="button" className="btn outlined danger" disabled={disabled} onClick={() => run("rewind", onRewind)}>
              {pending === "rewind" ? "Rewinding…" : "Rewind conversation"}
            </button>
          </div>
        </div>
      )}
      {notice && <div className={`message-action-notice${notice.error ? " error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}</div>}
    </div>
  );
}

window.MessageActions = MessageActions;
