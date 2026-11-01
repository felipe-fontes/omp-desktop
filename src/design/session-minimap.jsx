/* session-minimap.jsx — the entire conversation, not just the rendered page. */
const { Icon: _MM_Icon, TOOL_META: _MM_Tools } = window;
const { minimapKind: _MM_kind } = window.OMP_CONVERSATION_NAV;

function minimapTitle(message, kind) {
  const time = message.time ? ` · ${message.time}` : "";
  if (kind === "compact") return message.status === "pending" ? "Compacting context…"
    : message.status === "error" ? message.shortSummary || "Compaction failed"
    : `Context compacted${message.tokensBefore != null ? ` · ${window.formatTokens(message.tokensBefore)} tokens before` : ""}${time}`;
  if (kind === "user") return `You · ${message.text?.slice(0, 100) || "image"}${time}`;
  if (kind === "failure") return `Request failed${message.failure.httpStatus != null ? ` · HTTP ${message.failure.httpStatus}` : ""}${time}`;
  if (message.kind === "assistant") {
    const label = kind === "answer" ? "Answer" : kind === "reasoning" ? "Reasoning" : kind === "update" ? "Assistant update" : "Note";
    const text = message.blocks?.find(block => block.type === "text" && block.text?.trim())?.text;
    return `${label}${text ? ` · ${text.slice(0, 100)}` : ""}${message.tokens ? ` · ${message.tokens.toLocaleString()} tokens` : ""}${time}`;
  }
  if (kind === "tool") return `${message.title || message.tool || "Tool"}${message.isError ? " · failed" : ""}${time}`;
  if (kind === "job") return `${message.jobId} finished${message.label ? ` · ${message.label}` : ""}`;
  if (kind === "retry") return `Retrying · attempt ${message.attempt}`;
  if (kind === "goal") return window.OMP_GOAL.rowView(message).title;
  if (kind === "approval") return `Auto-approved · ${message.tool || "tool"}`;
  return `${kind}${time}`;
}

function SessionMinimap({ messages, hoveredIdx, onHover, onClick, historyError, onRefreshHistory }) {
  const gridRef = React.useRef(null);
  const following = React.useRef(true);
  const [focused, setFocused] = React.useState(null);
  const shown = React.useMemo(() => messages.flatMap((message, index) => window.OMP_TURN_STATUS.isHidden(message) ? [] : [index]), [messages]);
  const tabStop = shown.includes(focused) ? focused : shown.at(-1);
  React.useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid && following.current) grid.scrollTop = grid.scrollHeight;
  }, [shown.length]);
  const keyNav = (event, index) => {
    const position = shown.indexOf(index);
    const next = event.key === "Home" ? 0 : event.key === "End" ? shown.length - 1
      : event.key === "ArrowLeft" ? position - 1 : event.key === "ArrowRight" ? position + 1
      : event.key === "ArrowUp" ? position - 13 : event.key === "ArrowDown" ? position + 13 : null;
    if (next == null) return;
    event.preventDefault();
    event.stopPropagation();
    const target = shown[Math.max(0, Math.min(shown.length - 1, next))];
    gridRef.current?.querySelector(`[data-minimap-idx="${target}"]`)?.focus();
  };
  return (
    <div className="minimap">
      <div className="minimap-head mono">
        <span>entire conversation</span>
        <span className="minimap-count">{shown.length}</span>
      </div>
      {historyError && <div className="minimap-error" role="status">
        <span title={historyError}>Saved history unavailable</span>
        <button type="button" className="btn ghost" title={historyError} onClick={onRefreshHistory}>Retry</button>
      </div>}
      <div className="minimap-grid" ref={gridRef} role="group" aria-label="Conversation minimap"
        onScroll={event => { const el = event.currentTarget; following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 16; }}>
        {shown.map(index => {
          const message = messages[index];
          const kind = _MM_kind(message);
          const title = minimapTitle(message, kind);
          const hue = kind === "compact" ? (message.status === "error" ? "var(--rose)" : "var(--lilac)")
            : kind === "answer" ? "var(--accent)" : kind === "failure" ? "var(--rose)"
            : kind === "ask" ? "var(--amber)" : kind === "tool" ? _MM_Tools[message.tool]?.color || "var(--fg-4)"
            : _MM_Tools[kind]?.color || "var(--fg-4)";
          return (
            <button type="button" key={message._id ?? index} data-minimap-idx={index}
              className={`minimap-cell ${kind}${message.streaming || message.status === "pending" ? " live" : ""}${hoveredIdx === index ? " hot" : ""}`}
              style={{ "--mm-color": hue }} title={title} aria-label={title}
              tabIndex={tabStop === index ? 0 : -1}
              onKeyDown={event => keyNav(event, index)}
              onFocus={() => { setFocused(index); onHover?.(index); }} onBlur={() => onHover?.(null)}
              onMouseEnter={() => onHover?.(index)} onMouseLeave={() => onHover?.(null)}
              onClick={() => onClick?.(index)}>
              {kind === "compact" && <><_MM_Icon name="context" size={10} /><span>{message.status === "pending" ? "compacting…" : message.status === "error" ? "compaction failed" : "context compacted"}</span></>}
            </button>
          );
        })}
      </div>
      <div className="minimap-legend">
        <span className="minimap-legend-item"><i className="answer" />answer</span>
        <span className="minimap-legend-item"><i className="reasoning" />reasoning</span>
        <span className="minimap-legend-item"><i className="user" />you</span>
        <span className="minimap-legend-item"><i className="compact" />compact</span>
      </div>
    </div>
  );
}

window.SessionMinimap = SessionMinimap;
