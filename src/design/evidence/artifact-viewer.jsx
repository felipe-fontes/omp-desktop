/* Focus-safe enlargement of an authorized evidence image. */
(function () {
  function ImageViewer({ source, name, onClose, onError }) {
    const modalRef = React.useRef(null);
    const [zoom, setZoom] = React.useState(100);
    window.useModalLayer(modalRef);
    // The inspector is itself a portal modal. Restore its root inertness after
    // the shared layer hook releases the nested artifact layer.
    React.useEffect(
      () => () => {
        if (document.querySelector('[data-evidence-layer="inspector"]')) {
          const root = document.getElementById("root");
          if (root) root.inert = true;
        }
      },
      [],
    );
    React.useEffect(() => {
      const onKey = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== "Tab") return;
        event.stopPropagation();
        const root = modalRef.current;
        if (!root) return;
        const nodes = [
          ...root.querySelectorAll(
            'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((el) => el.getClientRects().length);
        if (!nodes.length) {
          event.preventDefault();
          root.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === root ||
            document.activeElement === nodes[0] ||
            !root.contains(document.activeElement))
        ) {
          event.preventDefault();
          nodes[nodes.length - 1].focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === nodes[nodes.length - 1] ||
            !root.contains(document.activeElement))
        ) {
          event.preventDefault();
          nodes[0].focus();
        }
      };
      window.addEventListener("keydown", onKey, true);
      return () => window.removeEventListener("keydown", onKey, true);
    }, [onClose]);
    return ReactDOM.createPortal(
      <div
        className="ev-proof-overlay"
        data-evidence-layer="artifact"
        onKeyDown={(event) => event.stopPropagation()}
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Enlarged evidence: ${name}`}
      >
        <header className="ev-proof-overlay-head">
          <strong>{name}</strong>
          <div className="ev-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={zoom <= 50}
              onClick={() => setZoom((n) => Math.max(50, n - 25))}
              aria-label="Zoom out"
            >
              −
            </button>
            <span aria-live="polite">{zoom}%</span>
            <button
              type="button"
              className="btn ghost"
              disabled={zoom >= 400}
              onClick={() => setZoom((n) => Math.min(400, n + 25))}
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setZoom(100)}
            >
              Reset zoom
            </button>
            <button type="button" className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </header>
        <div
          className="ev-proof-zoom-area"
          tabIndex={0}
          aria-label="Scrollable enlarged image"
        >
          <img
            src={source}
            alt={name}
            style={{ width: `${zoom}%` }}
            onError={onError}
          />
        </div>
      </div>,
      document.body,
    );
  }
  window.EvidenceArtifactViewer = ImageViewer;
})();
