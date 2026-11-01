/* Goal-first evidence: projection and native ledger remain authoritative. */
(function () {
  const Status = window.EvidenceStatus;

  function imageCount(view, records) {
    const ids = new Set();
    for (const record of records) {
      const receipt = (view.receipts || []).find(
        (item) => item.id === record.source?.receiptId,
      );
      for (const artifact of [record.artifact, receipt?.artifact]) {
        if (
          artifact?.id &&
          ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            artifact.mime,
          )
        )
          ids.add(artifact.id);
      }
    }
    return ids.size;
  }

  function GoalCard({
    evidence,
    goal,
    onNavigate,
    onAvailabilityChange,
    cardRef,
  }) {
    const { outcome } = goal;
    const criteria = (goal.criteria || []).filter(
      (item) => !item.requirement.retired,
    );
    const required = criteria.filter((item) => item.requirement.required);
    const needsProof = required.some(
      (item) => !item.demonstrated && !item.exception,
    );
    const records = (goal.records || []).map((item) => item.record);
    const best = goal.best?.record;
    const comparisonAvailable = imageCount(evidence.view, records) >= 2;
    const ProofRecord = window.EvidenceProofRecord;
    const Comparison = window.EvidenceComparison;
    const gaps = goal.gaps || [];

    return (
      <article className="ev-goal-card" ref={cardRef} tabIndex={-1}>
        <header className="ev-goal-heading">
          <div>
            <span className="ev-goal-kicker">Business objective</span>
            <h3>{outcome.title}</h3>
            {outcome.description && (
              <p className="ev-goal-description">{outcome.description}</p>
            )}
          </div>
          <Status status={goal} />
        </header>

        <div className="ev-goal-coverage">
          <span>
            <strong>{goal.demonstratedCount}</strong> of {goal.requiredCount}{" "}
            required criteria demonstrated
          </span>
          {goal.exceptionCount > 0 && (
            <span>
              {goal.exceptionCount} accepted{" "}
              {goal.exceptionCount === 1 ? "exception" : "exceptions"}
            </span>
          )}
          {goal.removedCount > 0 && (
            <span>{goal.removedCount} removed from scope</span>
          )}
        </div>

        <section
          className="ev-goal-section"
          aria-label={`Observed result for ${outcome.title}`}
        >
          <div className="ev-goal-section-head">
            <h4>Observed result &amp; strongest proof</h4>
            {records.length > 1 && <span>{records.length} records</span>}
          </div>
          {best && ProofRecord ? (
            <ProofRecord
              key={best.id}
              evidence={evidence}
              record={best}
              onAvailabilityChange={onAvailabilityChange}
            />
          ) : best ? (
            <p className="ev-goal-empty">
              Proof display is unavailable. Open all evidence to inspect this
              record.
            </p>
          ) : (
            <p className="ev-goal-empty">
              No observed result or proof recorded for this goal. Request or add
              real evidence rather than assuming an outcome.
            </p>
          )}
          {comparisonAvailable && Comparison && (
            <Comparison
              evidence={evidence}
              records={records}
              onAvailabilityChange={onAvailabilityChange}
            />
          )}
        </section>
        <details className="ev-goal-section ev-goal-expected">
          <summary>
            Expected behavior · {criteria.length}{" "}
            {criteria.length === 1 ? "criterion" : "criteria"}
          </summary>
          {criteria.length ? (
            <ul className="ev-goal-criteria">
              {criteria.map((criterion) => (
                <li key={criterion.requirement.id}>
                  <div className="ev-goal-criterion-main">
                    <span>{criterion.requirement.text}</span>
                    <Status status={criterion} />
                  </div>
                  <span className="ev-goal-criterion-meta">
                    {criterion.requirement.required ? "Required" : "Optional"} ·{" "}
                    {criterion.requirement.kind}
                  </span>
                  {criterion.exception && (
                    <p className="ev-goal-criterion-note">
                      Exception accepted by user:{" "}
                      {criterion.requirement.waiver?.reason || criterion.reason}
                      . This criterion remains unmet.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="ev-goal-empty">
              No expected behavior defined yet. Add a criterion that describes
              what real evidence should show.
            </p>
          )}
        </details>

        {(gaps.length > 0 || (!goal.demonstrated && goal.reason)) && (
          <section
            className="ev-goal-gaps"
            aria-label={`Gaps for ${outcome.title}`}
          >
            <h4>Gaps &amp; limitations</h4>
            {gaps.length ? (
              <ul>
                {gaps.map((gap, index) => {
                  const criterion = criteria.find(
                    (item) => item.requirement.id === gap.requirementId,
                  );
                  return (
                    <li
                      key={`${gap.requirementId || "goal"}-${gap.recordId || "gap"}-${index}`}
                    >
                      {criterion && (
                        <strong>{criterion.requirement.text}: </strong>
                      )}
                      {gap.text}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p>{goal.reason}</p>
            )}
          </section>
        )}

        <div
          className="ev-goal-next"
          aria-label={`Next actions for ${outcome.title}`}
        >
          <div>
            <span className="ev-goal-kicker">Agent next</span>
            <p>
              {!criteria.length
                ? "Define an observable success criterion, then collect proof for it."
                : !required.length
                  ? "No required criteria are defined; optional proof can still be collected."
                  : needsProof
                    ? "Collect current, scoped proof for the outstanding required criteria; preserve failures and earlier evidence."
                    : "No additional proof is indicated for the active required criteria."}
            </p>
          </div>
          <div>
            <span className="ev-goal-kicker">Your next action</span>
            <p>
              {goal.reviewRequested
                ? "Review the evidence requested for your decision. Acceptance is separate from collection."
                : !criteria.length
                  ? "No review is waiting. You can define the goal yourself or let the agent propose criteria."
                  : needsProof
                    ? "Nothing to approve yet. The agent still needs to demonstrate these behaviors."
                    : "No review has been requested. You can inspect the evidence or manage scope."}
            </p>
            <div className="ev-actions">
              {!criteria.length ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => onNavigate("outcomes")}
                >
                  Define criteria
                </button>
              ) : needsProof ? (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => onNavigate("requests")}
                >
                  Request proof
                </button>
              ) : null}
              {goal.reviewRequested && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => onNavigate("records")}
                >
                  Review evidence
                </button>
              )}
              {records.length > 0 && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => onNavigate("records")}
                >
                  All evidence
                </button>
              )}
            </div>
          </div>
        </div>
      </article>
    );
  }

  function Goals({
    evidence,
    active = true,
    focusOutcomeId = null,
    onNavigate,
  }) {
    const focusedCard = React.useRef(null);
    const unavailableArtifactIds = evidence.unavailableArtifactIds;
    const onAvailabilityChange = evidence.onArtifactAvailability;
    const projection = window.OMP_EVIDENCE_PROOF;
    const view = evidence.view;
    const options = { unavailableArtifactIds };
    const goals = view && projection ? projection.goals(view, options) : [];
    const summary =
      view && projection ? projection.summary(view, options) : null;
    const hasFocusedGoal = goals.some(
      (goal) => goal.outcome.id === focusOutcomeId,
    );
    React.useEffect(() => {
      if (active && focusOutcomeId && hasFocusedGoal && focusedCard.current) {
        focusedCard.current.focus({ preventScroll: true });
        focusedCard.current.scrollIntoView({ block: "nearest" });
      }
    }, [active, focusOutcomeId, hasFocusedGoal]);
    if (!view || !projection) return null;
    return (
      <section className="ev-goal-page" aria-label="Goals and evidence">
        <header className="ev-goal-intro">
          <div>
            <span className="ev-goal-kicker">Evidence of progress</span>
            <h2>Goals &amp; proof</h2>
            <p>
              Start with the outcome, then inspect what was observed and what
              still needs proof.
            </p>
          </div>
          <button
            type="button"
            className="btn ghost"
            onClick={() => onNavigate("outcomes")}
          >
            Manage goals
          </button>
        </header>
        {goals.length ? (
          <>
            <div className="ev-goal-summary" aria-label="Evidence coverage">
              <span>
                <strong>{summary.demonstrated}</strong> / {summary.total} goals
                demonstrated
              </span>
              {summary.attention > 0 && (
                <span>{summary.attention} need attention</span>
              )}
              {summary.missing > 0 && <span>{summary.missing} need proof</span>}
              {summary.reviewRequested > 0 && (
                <span>{summary.reviewRequested} review requested</span>
              )}
              {summary.exceptions > 0 && (
                <span>{summary.exceptions} exceptions</span>
              )}
              {summary.removed > 0 && (
                <span>{summary.removed} removed from scope</span>
              )}
            </div>
            {goals.map((goal) => (
              <GoalCard
                key={goal.outcome.id}
                evidence={evidence}
                goal={goal}
                onNavigate={onNavigate}
                onAvailabilityChange={onAvailabilityChange}
                cardRef={
                  goal.outcome.id === focusOutcomeId ? focusedCard : undefined
                }
              />
            ))}
          </>
        ) : (
          <div className="ev-goal-blank">
            <h3>No active goals yet</h3>
            <p>
              Define a business objective and its expected behavior, then
              request or add real proof.
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => onNavigate("outcomes")}
            >
              Define a goal
            </button>
          </div>
        )}
      </section>
    );
  }
  window.EvidenceGoals = Goals;
})();
