/* Inspection and human review are separate from an agent's interpretation. */
(function () {
  const {
    EvidenceField: Field,
    EvidenceError: Error,
    EvidenceStatus: Status,
    EvidenceRecordForm: RecordForm,
    EvidenceReceipt: Receipt,
    EvidenceProofRecord: ProofRecord,
    useEvidenceAction: useAction,
  } = window;
  function Record({ evidence, record }) {
    const outcome = (evidence.view?.outcomes || []).find(
      (item) => item.id === record.outcomeId,
    );
    const requirement = outcome?.requirements?.find(
      (item) => item.id === record.requirementId,
    );
    const status = window.OMP_EVIDENCE_PROOF.record(evidence.view, record, {
      unavailableArtifactIds: evidence.unavailableArtifactIds,
    });
    return (
      <article className="ev-record">
        <div className="ev-row">
          <h3>{record.title}</h3>
          <Status status={status} />
        </div>
        <div className="ev-meta">
          {outcome?.title || "Unknown outcome"}
          {requirement ? ` · ${requirement.text}` : ""}
        </div>
        <ProofRecord
          evidence={evidence}
          record={record}
          showTitle={false}
          onAvailabilityChange={evidence.onArtifactAvailability}
        />
      </article>
    );
  }
  function CaptureCI({ evidence }) {
    const outcomes = (evidence.view?.outcomes || []).filter((o) => !o.retired);
    const [outcomeId, setOutcomeId] = React.useState("");
    const [requirementId, setRequirementId] = React.useState("");
    const action = useAction();
    const outcome = outcomes.find((o) => o.id === outcomeId);
    return (
      <details className="ev-receipt">
        <summary>Capture existing CI information</summary>
        <p className="ev-note">
          Reads available CI facts; it does not start a CI run.
        </p>
        <form
          className="ev-form"
          onSubmit={(e) => {
            e.preventDefault();
            action.run(() =>
              evidence.mutate({
                op: "capture_ci",
                outcomeId,
                requirementId: requirementId || null,
              }),
            );
          }}
        >
          <fieldset className="ev-fields" disabled={action.busy}>
            <Field label="Outcome">
              <select
                required
                value={outcomeId}
                onChange={(e) => {
                  setOutcomeId(e.target.value);
                  setRequirementId("");
                }}
              >
                <option value="">Select outcome</option>
                {outcomes.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Criterion (optional)">
              <select
                value={requirementId}
                onChange={(e) => setRequirementId(e.target.value)}
              >
                <option value="">Outcome-level evidence</option>
                {(outcome?.requirements || [])
                  .filter((r) => !r.retired)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.text}
                    </option>
                  ))}
              </select>
            </Field>
            <Error error={action.error} />
            <button className="btn" disabled={action.busy || !outcomeId}>
              Capture CI
            </button>
          </fieldset>
        </form>
      </details>
    );
  }
  function Records({ evidence }) {
    const [adding, setAdding] = React.useState(false);
    const records = evidence.view?.records || [];
    const receipts = evidence.view?.receipts || [];
    return (
      <section className="ev-stack">
        <div className="ev-section-head">
          <div>
            <h2>Records & gaps</h2>
            <p>
              Observations and failures remain visible. Review is a separate
              human decision.
            </p>
          </div>
          <button className="btn" onClick={() => setAdding(true)}>
            Add record
          </button>
        </div>
        {adding && (
          <RecordForm evidence={evidence} onDone={() => setAdding(false)} />
        )}
        <CaptureCI evidence={evidence} />
        {!records.length && (
          <p className="ev-empty">
            No records yet. Record evidence or describe a blocked gap.
          </p>
        )}
        {records.map((record) => (
          <Record key={record.id} evidence={evidence} record={record} />
        ))}
        <h3>Captured receipts</h3>
        <p className="ev-note">
          Captured tool outputs are factual receipts, not proof that acceptance
          criteria passed.
        </p>
        {!receipts.length && <p className="ev-empty">No captured receipts.</p>}
        {receipts.map((receipt) => (
          <Receipt
            key={receipt.id}
            evidence={evidence}
            receipt={receipt}
            onAvailabilityChange={evidence.onArtifactAvailability}
          />
        ))}
      </section>
    );
  }
  window.EvidenceRecords = Records;
})();
