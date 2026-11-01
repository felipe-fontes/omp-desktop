/* Execution and source metadata, secondary to the observed behavior. */
(function () {
  const { EvidenceWhen: When, EvidenceArtifact: Artifact } = window;
  function ReceiptFingerprint({ label, fingerprint }) {
    if (!fingerprint) return <p className="ev-meta">{label}: unavailable.</p>;
    return (
      <p className="ev-meta ev-break">
        {label}: {fingerprint.head || "unknown revision"} ·{" "}
        {fingerprint.complete
          ? fingerprint.dirtyDigest
            ? `working tree ${fingerprint.dirtyDigest}`
            : "clean working tree"
          : `incomplete: ${fingerprint.reason || "unknown reason"}`}
      </p>
    );
  }
  function Receipt({ evidence, receipt, onAvailabilityChange }) {
    const [opened, setOpened] = React.useState(false);
    return (
      <details
        className="ev-receipt"
        onToggle={(event) => setOpened(event.currentTarget.open)}
      >
        <summary>
          {receipt.toolName} ·{" "}
          {receipt.isError ? "tool error" : "tool returned"}{" "}
          <When at={receipt.at} />
        </summary>
        <p className="ev-note">
          Execution receipt only; a successful tool call does not verify the
          outcome.
        </p>
        {receipt.command && <pre className="selectable">{receipt.command}</pre>}
        {receipt.exitCode != null && (
          <p className="ev-meta">Exit code: {receipt.exitCode}</p>
        )}
        <ReceiptFingerprint
          label="Source before execution"
          fingerprint={receipt.beforeFingerprint}
        />
        <ReceiptFingerprint
          label="Source after execution"
          fingerprint={receipt.fingerprint}
        />
        {receipt.preview && <pre className="selectable">{receipt.preview}</pre>}
        {receipt.truncated && (
          <p className="ev-note">Receipt preview truncated.</p>
        )}
        {opened && receipt.artifact && (
          <Artifact
            evidence={evidence}
            artifact={receipt.artifact}
            onAvailabilityChange={onAvailabilityChange}
          />
        )}
      </details>
    );
  }
  function CI({ ci }) {
    const snapshot = ci.snapshot;
    return (
      <details className="ev-receipt">
        <summary>CI details · {ci.state || "unknown"}</summary>
        {ci.sourceSha && (
          <p className="ev-break">
            <strong>Source commit:</strong> {ci.sourceSha}
          </p>
        )}
        {snapshot ? (
          <>
            <p>
              <strong>Repository:</strong>{" "}
              {snapshot.repository || "unavailable"} · <strong>Branch:</strong>{" "}
              {snapshot.branch || "unavailable"}
            </p>
            <p>
              <strong>Pull request:</strong> {snapshot.number ?? "unavailable"}{" "}
              · {snapshot.prState || "unknown"} · <strong>Checks:</strong>{" "}
              {snapshot.checksState || "unknown"}
            </p>
            {snapshot.url && (
              <p className="ev-break">
                <strong>PR URL:</strong> {snapshot.url}
              </p>
            )}
            {!!snapshot.failedChecks?.length && (
              <>
                <strong>Failed checks</strong>
                <ul>
                  {snapshot.failedChecks.map((check, i) => (
                    <li key={i}>
                      {check.name || "Unnamed check"}
                      {check.url ? ` — ${check.url}` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        ) : (
          <p className="ev-note">No CI snapshot is available.</p>
        )}
        {ci.reason && (
          <p>
            <strong>Reason:</strong> {ci.reason}
          </p>
        )}
        {ci.limitations && (
          <p>
            <strong>Limitations:</strong> {ci.limitations}
          </p>
        )}
      </details>
    );
  }
  Object.assign(window, {
    EvidenceReceiptFingerprint: ReceiptFingerprint,
    EvidenceReceipt: Receipt,
    EvidenceCI: CI,
  });
})();
