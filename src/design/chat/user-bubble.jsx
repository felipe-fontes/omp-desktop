/* chat/user-bubble.jsx — user-side bubble, right-aligned. */
const { ImageThumbs: _UB_ImageThumbs, MessageActions: _UB_MessageActions } = window;

function UserBubble({ msg, idx, highlighted, onRewind, onFork, conversationBusy, conversationKey }) {
  return (
    <div className={`row user fade-up${highlighted ? " mm-hot" : ""}`} data-msg-idx={idx}>
      <div className="user-bubble selectable">
        <div className="user-meta">
          <span className="mono" style={{ color: "var(--fg-4)" }}>{msg.time}</span>
          <span className="chip muted">you</span>
        </div>
        <_UB_ImageThumbs images={msg.images} className="user-images" alt="attached image" />
        {msg.text && <div className="user-text">{msg.text}</div>}
        {msg.entryId && (onRewind || onFork) && (
          <_UB_MessageActions key={JSON.stringify([conversationKey, msg.entryId])}
            entryId={msg.entryId} onRewind={onRewind} onFork={onFork} conversationBusy={conversationBusy} />
        )}
      </div>
    </div>
  );
}

Object.assign(window, { UserBubble });
