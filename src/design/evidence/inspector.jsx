/* Visited panels stay mounted while navigating so drafts survive. */
(function () {
  const {
    EvidenceOutcomes: Outcomes,
    EvidenceGoals: Goals,
    EvidenceRecords: Records,
    EvidenceRequests: Requests,
    EvidencePresets: Presets,
    EvidenceHistory: History,
    EvidenceError: Error,
    useEvidenceAction: useAction,
  } = window;
  const panels = [
    ["goals", "Proof"],
    ["requests", "Ask for proof"],
  ];
  const management = [
    ["outcomes", "Goals & criteria"],
    ["records", "All evidence & checks"],
    ["presets", "Collection settings"],
    ["history", "History & report"],
  ];
  function Inspector({
    evidence,
    onClose,
    initialPanel = "goals",
    initialOutcomeId = null,
  }) {
    const [panel, setPanel] = React.useState(initialPanel);
    const [visited, setVisited] = React.useState(() => new Set([initialPanel]));
    const navigate = (next) => {
      setVisited((current) =>
        current.has(next) ? current : new Set([...current, next]),
      );
      setPanel(next);
    };
    const refresh = useAction();
    const modalRef = React.useRef(null);
    const closeRef = React.useRef(onClose);
    closeRef.current = onClose;
    window.useModalLayer(modalRef);
    React.useEffect(() => {
      const onKey = (e) => {
        const layers = document.querySelectorAll("[data-evidence-layer]");
        if (
          e.defaultPrevented ||
          (layers.length && layers[layers.length - 1] !== modalRef.current)
        )
          return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          const menu = modalRef.current?.querySelector(".ev-nav-manage[open]");
          if (menu) {
            menu.open = false;
            menu.querySelector("summary")?.focus();
            return;
          }
          closeRef.current();
          return;
        }
        if (e.key !== "Tab") return;
        e.stopPropagation();
        const root = modalRef.current;
        if (!root) return;
        const nodes = [
          ...root.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, video[controls], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((el) => el.getClientRects().length);
        if (!nodes.length) {
          e.preventDefault();
          root.focus();
          return;
        }
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === root ||
            document.activeElement === first ||
            !root.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !root.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    }, []);
    return ReactDOM.createPortal(
      <div
        className="ev-scrim"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div
          className="ev-dialog"
          data-evidence-layer="inspector"
          onKeyDown={(event) => event.stopPropagation()}
          ref={modalRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="evidence-title"
        >
          <header className="ev-dialog-head">
            <div>
              <span className="ev-eyebrow">Conversation evidence</span>
              <h1 id="evidence-title">Proof of your goals</h1>
            </div>
            <div className="ev-actions">
              <button
                className="btn ghost"
                disabled={refresh.busy}
                onClick={() => refresh.run(() => evidence.refresh())}
              >
                Refresh
              </button>
              <button
                className="btn ghost"
                onClick={onClose}
                aria-label="Close evidence inspector"
              >
                Close <span aria-hidden="true">×</span>
              </button>
            </div>
          </header>
          <nav className="ev-nav" aria-label="Evidence sections">
            {panels.map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-current={panel === key ? "page" : undefined}
                onClick={() => navigate(key)}
              >
                {label}
              </button>
            ))}
            <details className="ev-nav-manage">
              <summary>
                {management.find(([key]) => key === panel)?.[1] || "Manage"}
              </summary>
              <div className="ev-nav-menu">
                {management.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-current={panel === key ? "page" : undefined}
                    onClick={(event) => {
                      navigate(key);
                      event.currentTarget.closest("details").open = false;
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </details>
          </nav>
          <div className="ev-dialog-body">
            {evidence.loading && !evidence.view && (
              <p className="ev-note" role="status">
                Loading evidence…
              </p>
            )}
            {evidence.error && <Error error={evidence.error} />}
            <Error error={refresh.error} />
            {!evidence.view && !evidence.loading && (
              <p className="ev-empty">
                Evidence is unavailable for this conversation.
              </p>
            )}
            {evidence.view?.supported === false && (
              <p className="ev-empty">
                Evidence is not supported in this conversation.
              </p>
            )}
            {!!evidence.view?.warnings?.length && (
              <details className="ev-collection-notices">
                <summary>
                  {evidence.view.warnings.length} collection{" "}
                  {evidence.view.warnings.length === 1 ? "notice" : "notices"}
                </summary>
                {evidence.view.warnings.map((warning, index) => (
                  <p className="ev-note" key={index}>
                    {warning}
                  </p>
                ))}
              </details>
            )}
            <div hidden={panel !== "goals"}>
              {visited.has("goals") && (
                <Goals
                  evidence={evidence}
                  active={panel === "goals"}
                  focusOutcomeId={initialOutcomeId}
                  onNavigate={navigate}
                />
              )}
            </div>
            <div hidden={panel !== "outcomes"}>
              {visited.has("outcomes") && <Outcomes evidence={evidence} />}
            </div>
            <div hidden={panel !== "records"}>
              {visited.has("records") && <Records evidence={evidence} />}
            </div>
            <div hidden={panel !== "requests"}>
              {visited.has("requests") && <Requests evidence={evidence} />}
            </div>
            <div hidden={panel !== "presets"}>
              {visited.has("presets") && <Presets evidence={evidence} />}
            </div>
            <div hidden={panel !== "history"}>
              {visited.has("history") && <History evidence={evidence} />}
            </div>
          </div>
        </div>
      </div>,
      document.body,
    );
  }
  window.EvidenceInspector = Inspector;
})();
