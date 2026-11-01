/* Collection is independent of whether the Ambient card is visible. */
(function () {
  const {
    EvidenceInspector: Inspector,
    EvidenceError: Error,
    useEvidenceAction: useAction,
  } = window;
  function Card({ evidence }) {
    const [panel, setPanel] = React.useState(null);
    const [outcomeId, setOutcomeId] = React.useState(null);
    const view = evidence?.view;
    const owner =
      evidence?.ownerKey ||
      `${evidence?.profileId || ""}:${view?.sessionId || ""}:${view?.epoch || ""}`;
    const priorOwner = React.useRef(owner);
    React.useEffect(() => {
      if (priorOwner.current !== owner) {
        priorOwner.current = owner;
        setPanel(null);
        setOutcomeId(null);
      }
    }, [owner]);
    const action = useAction();
    if (!evidence) return null;
    const options = { unavailableArtifactIds: evidence.unavailableArtifactIds };
    const summary = view
      ? window.OMP_EVIDENCE_PROOF.summary(view, options)
      : null;
    const goals = view ? window.OMP_EVIDENCE_PROOF.goals(view, options) : [];
    return (
      <>
        <div className="rail-card glass ev-card">
          <div className="rail-card-head ev-card-head">
            <span className="ev-card-mark" aria-hidden="true">
              ◇
            </span>
            <strong>Evidence</strong>
          </div>
          {view?.supported === false ? (
            <p className="ev-note">
              Evidence is not supported in this conversation.
            </p>
          ) : !view ? (
            <p className="ev-note">
              {evidence.loading ? "Loading evidence…" : "Evidence unavailable."}
            </p>
          ) : (
            <>
              <label className="ev-check ev-card-toggle">
                <input
                  type="checkbox"
                  checked={!!view.tracking}
                  disabled={action.busy}
                  onChange={(e) =>
                    action.run(() =>
                      evidence.mutate({
                        op: "tracking",
                        enabled: e.target.checked,
                      }),
                    )
                  }
                />{" "}
                Collection {view.tracking ? "on" : "off"}
              </label>
              {!goals.length ? (
                <p className="ev-card-empty">
                  What should this work demonstrate? Define a goal to begin.
                </p>
              ) : (
                <>
                  <div className="ev-card-counts">
                    <span>
                      <b>
                        {summary.demonstrated} / {summary.total}
                      </b>{" "}
                      goals demonstrated
                    </span>
                    {summary.attention > 0 && (
                      <span>{summary.attention} need attention</span>
                    )}
                    {summary.reviewRequested > 0 && (
                      <span>{summary.reviewRequested} request your review</span>
                    )}
                  </div>
                  <div className="ev-card-list">
                    {goals.slice(0, 3).map((goal) => (
                      <button
                        key={goal.outcome.id}
                        onClick={() => {
                          setOutcomeId(goal.outcome.id);
                          setPanel("goals");
                        }}
                        title={goal.outcome.title}
                      >
                        <span>{goal.outcome.title}</span>
                        <small>{goal.label}</small>
                      </button>
                    ))}
                  </div>
                  {goals.length > 3 && (
                    <span className="ev-meta">
                      +{goals.length - 3} more goals
                    </span>
                  )}
                  {!summary.reviewRequested && (
                    <p className="ev-card-empty">
                      No review requested. Collection does not mean acceptance.
                    </p>
                  )}
                </>
              )}
            </>
          )}
          <Error error={action.error || evidence.error} />
          <div className="ev-card-actions">
            <button
              className="btn ghost outlined"
              onClick={() => {
                setOutcomeId(null);
                setPanel("goals");
              }}
            >
              See proof
            </button>
            <button className="btn ghost" onClick={() => setPanel("requests")}>
              Request
            </button>
          </div>
        </div>
        {panel && (
          <Inspector
            key={owner}
            evidence={evidence}
            onClose={() => setPanel(null)}
            initialPanel={panel}
            initialOutcomeId={outcomeId}
          />
        )}
      </>
    );
  }
  window.EvidenceCard = Card;
})();
