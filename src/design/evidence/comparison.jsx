/* Compare authorized captures without inferring a fix from their order. */
(function () {
  const Artifact = window.EvidenceArtifact;
  const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  function Comparison({ evidence, records, onAvailabilityChange }) {
    const receipts = evidence.view?.receipts || [];
    const candidates = [];
    const seen = new Set();
    for (const record of records || []) {
      const receipt = receipts.find(
        (item) => item.id === record.source?.receiptId,
      );
      for (const artifact of [record.artifact, receipt?.artifact]) {
        if (
          !artifact?.id ||
          !imageTypes.includes(artifact.mime) ||
          seen.has(artifact.id)
        )
          continue;
        seen.add(artifact.id);
        candidates.push({ artifact, record });
      }
    }
    const [open, setOpen] = React.useState(false);
    const [firstId, setFirstId] = React.useState("");
    const [secondId, setSecondId] = React.useState("");
    if (candidates.length < 2) return null;
    const first =
      candidates.find((item) => item.artifact.id === firstId) || candidates[0];
    const second =
      candidates.find(
        (item) =>
          item.artifact.id === secondId &&
          item.artifact.id !== first.artifact.id,
      ) || candidates.find((item) => item.artifact.id !== first.artifact.id);
    const label = (item) =>
      `${item.record.title || "Untitled record"} · ${item.artifact.name || "image"}${item.record.at ? ` · ${item.record.at}` : ""}`;
    return (
      <section className="ev-proof-compare">
        <button
          type="button"
          className="btn ghost"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Close comparison" : "Compare image captures"}
        </button>
        {open && (
          <>
            <p className="ev-note">
              Compare two captures. Their order alone does not establish a
              change or a fix.
            </p>
            <div className="ev-proof-compare-grid">
              {[
                { item: first, other: second, name: "Capture 1" },
                { item: second, other: first, name: "Capture 2" },
              ].map(({ item, other, name }) => (
                <div key={name} className="ev-proof-compare-item">
                  <label className="ev-field">
                    {name}
                    <select
                      value={item.artifact.id}
                      onChange={(event) => {
                        const value = event.target.value;
                        setFirstId(
                          name === "Capture 1" ? value : first.artifact.id,
                        );
                        setSecondId(
                          name === "Capture 2" ? value : second.artifact.id,
                        );
                      }}
                    >
                      {candidates.map((candidate) => (
                        <option
                          key={candidate.artifact.id}
                          value={candidate.artifact.id}
                          disabled={candidate.artifact.id === other.artifact.id}
                        >
                          {label(candidate)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Artifact
                    evidence={evidence}
                    artifact={item.artifact}
                    onAvailabilityChange={onAvailabilityChange}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    );
  }
  window.EvidenceComparison = Comparison;
})();
