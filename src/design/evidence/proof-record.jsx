/* A goal's primary proof; human review is never inferred from collection. */
(function () {
  const {
    EvidenceField: Field,
    EvidenceError: Error,
    EvidenceWhen: When,
    EvidenceArtifact: Artifact,
    useEvidenceAction: useAction,
    EvidenceReceiptFingerprint: ReceiptFingerprint,
    EvidenceReceipt: Receipt,
    EvidenceCI: CI,
  } = window;
  function ProofRecord({
    evidence,
    record,
    onAvailabilityChange,
    showTitle = true,
  }) {
    const [reviewing, setReviewing] = React.useState("");
    const [reason, setReason] = React.useState("");
    const action = useAction();
    const view = evidence.view || {};
    const receipt = (view.receipts || []).find(
      (item) => item.id === record.source?.receiptId,
    );
    const projection = window.OMP_EVIDENCE_PROOF?.record(view, record, {
      unavailableArtifactIds: evidence.unavailableArtifactIds,
    });
    const fallback = window.OMP_EVIDENCE_MODEL.recordStatus(view, record);
    const artifacts = [record.artifact, receipt?.artifact].filter(Boolean);
    const primary =
      projection?.artifact || record.artifact || receipt?.artifact || null;
    const decision = record.review?.decision || "unreviewed";
    const requested =
      record.reviewRequested === true && decision === "unreviewed";
    const reasonBytes = new TextEncoder().encode(reason.trim()).length;
    const statusRows = [
      [
        "Capture",
        projection?.capture?.label ||
          (primary ? "Artifact attached" : "No artifact attached"),
        projection?.capture?.reason,
      ],
      [
        "Check",
        projection?.check?.label || record.result || "Unknown",
        projection?.check?.reason,
      ],
      [
        "Freshness",
        projection?.freshness?.label || fallback.label,
        projection ? projection.freshness?.reason : fallback.reason,
      ],
      [
        "Human review",
        requested ? "Review requested" : projection?.review?.label || decision,
        record.review?.reason || projection?.review?.reason,
      ],
    ];
    return (
      <div className="ev-proof-record">
        <div className="ev-proof-byline">
          {showTitle && <strong>{record.title}</strong>}
          <span>
            {record.source?.type || "Unknown"} source · <When at={record.at} />
          </span>
        </div>
        {primary ? (
          <Artifact
            evidence={evidence}
            artifact={primary}
            onAvailabilityChange={onAvailabilityChange}
          />
        ) : receipt?.preview?.trim() ? (
          <section
            className="ev-proof-output"
            aria-label="Captured execution output"
          >
            <strong>Captured output</strong>
            <pre className="selectable" tabIndex={0}>
              {receipt.preview}
            </pre>
            {receipt.truncated && (
              <p className="ev-note">The captured output is truncated.</p>
            )}
          </section>
        ) : record.ci?.snapshot ? (
          <section className="ev-proof-output" aria-label="Captured CI output">
            <strong>CI result: {record.ci.state}</strong>
            <p>{record.ci.snapshot.checksState || record.ci.state}</p>
            {!!record.ci.snapshot.failedChecks?.length && (
              <ul>
                {record.ci.snapshot.failedChecks.map((check, index) => (
                  <li key={index}>{check.name || "Unnamed check"}</li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <p className="ev-note">
            No captured output is attached. References and execution metadata
            are supporting details, not proof of behavior.
          </p>
        )}
        <div className="ev-proof-facts">
          {statusRows.map(([name, label, detail]) => (
            <div key={name} title={detail || undefined}>
              <span>{name}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </div>
        {projection?.reason && <p className="ev-note">{projection.reason}</p>}
        <div className="ev-proof-finding">
          <div>
            <span>Expected</span>
            <p>{record.finding?.expected || "Not recorded"}</p>
          </div>
          <div>
            <span>Observed</span>
            <p>{record.finding?.observed || "Not recorded"}</p>
          </div>
        </div>
        {record.summary &&
          record.summary.trim() !== projection?.observed?.trim() && (
            <p className="ev-proof-summary">{record.summary}</p>
          )}
        {record.limitations && (
          <p>
            <strong>Limitations:</strong> {record.limitations}
          </p>
        )}
        {record.reason && (
          <p>
            <strong>Reason:</strong> {record.reason}
          </p>
        )}
        <details className="ev-proof-review">
          <summary>Review this evidence</summary>
          <p className="ev-note">
            Only your explicit decision accepts or rejects this record. A
            recorded result is not independent acceptance.
          </p>
          <div className="ev-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={action.busy}
              onClick={() => {
                setReason("");
                setReviewing("accepted");
              }}
            >
              Accept
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={action.busy}
              onClick={() => {
                setReason("");
                setReviewing("rejected");
              }}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={action.busy || decision === "unreviewed"}
              onClick={() => {
                setReason("");
                setReviewing("unreviewed");
              }}
            >
              Reset review
            </button>
          </div>
          {reviewing && (
            <form
              className="ev-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  reasonBytes > 1024 ||
                  (reviewing === "rejected" && !reason.trim())
                )
                  return;
                action.run(
                  () =>
                    evidence.mutate({
                      op: "review",
                      recordId: record.id,
                      decision: reviewing,
                      reason: reason.trim(),
                    }),
                  () => {
                    setReviewing("");
                    setReason("");
                  },
                );
              }}
            >
              <fieldset className="ev-fields" disabled={action.busy}>
                {reviewing !== "unreviewed" && (
                  <Field
                    label={`Reason for ${reviewing === "accepted" ? "accepting (optional)" : "rejecting"}`}
                  >
                    <textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      required={reviewing === "rejected"}
                      rows="2"
                      aria-invalid={reasonBytes > 1024}
                    />
                    <span>{reasonBytes} / 1024 UTF-8 bytes</span>
                  </Field>
                )}
                {reasonBytes > 1024 && (
                  <p className="ev-error" role="alert">
                    Review reason exceeds 1024 UTF-8 bytes.
                  </p>
                )}
                <div className="ev-actions">
                  <button
                    className="btn"
                    disabled={
                      action.busy ||
                      reasonBytes > 1024 ||
                      (reviewing === "rejected" && !reason.trim())
                    }
                  >
                    Confirm{" "}
                    {reviewing === "accepted"
                      ? "acceptance"
                      : reviewing === "rejected"
                        ? "rejection"
                        : "reset"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setReviewing("")}
                  >
                    Cancel
                  </button>
                </div>
              </fieldset>
            </form>
          )}
          <Error error={action.error} />
        </details>
        <details className="ev-proof-details">
          <summary>Source, receipts and details</summary>
          <p className="ev-meta">
            Source: {record.source?.type || "unknown"} · {record.kind} ·{" "}
            <When at={record.at} />
          </p>
          {record.fileRef?.path && (
            <p className="ev-break">
              <strong>File reference:</strong> {record.fileRef.path}
              {record.fileRef.from != null ? `:${record.fileRef.from}` : ""}
              {record.fileRef.to != null ? `–${record.fileRef.to}` : ""}
            </p>
          )}
          {record.url && (
            <p className="ev-break">
              <strong>URL reference:</strong> {record.url}
            </p>
          )}
          {record.fingerprint ? (
            <ReceiptFingerprint
              label={record.source?.type === "ci" ? "CI commit" : "Source"}
              fingerprint={record.fingerprint}
            />
          ) : (
            <p className="ev-meta">Source fingerprint unavailable.</p>
          )}
          {record.ci && <CI ci={record.ci} />}
          {receipt ? (
            <Receipt
              evidence={evidence}
              receipt={receipt}
              onAvailabilityChange={onAvailabilityChange}
            />
          ) : (
            record.source?.receiptId && (
              <p className="ev-note">
                Linked receipt unavailable in the current window.
              </p>
            )
          )}
          {artifacts
            .filter(
              (artifact) => artifact !== primary && artifact.id !== primary?.id,
            )
            .map((artifact) => (
              <LazyArtifact
                key={artifact.id}
                evidence={evidence}
                artifact={artifact}
                onAvailabilityChange={onAvailabilityChange}
              />
            ))}
        </details>
      </div>
    );
  }
  function LazyArtifact({ evidence, artifact, onAvailabilityChange }) {
    const [opened, setOpened] = React.useState(false);
    return (
      <details
        className="ev-receipt"
        onToggle={(event) => setOpened(event.currentTarget.open)}
      >
        <summary>Additional artifact · {artifact.name || artifact.id}</summary>
        {opened && (
          <Artifact
            evidence={evidence}
            artifact={artifact}
            onAvailabilityChange={onAvailabilityChange}
          />
        )}
      </details>
    );
  }
  window.EvidenceProofRecord = ProofRecord;
})();
