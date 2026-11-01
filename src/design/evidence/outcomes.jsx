/* Outcome and acceptance-criterion editing. */
(function () {
  const {
    EvidenceField: Field,
    EvidenceKindSelect: Kind,
    EvidenceError: Error,
    EvidenceStatus: Status,
    useEvidenceAction: useAction,
  } = window;

  function OutcomeEditor({ evidence, outcome, onDone }) {
    const [title, setTitle] = React.useState(outcome?.title || "");
    const [description, setDescription] = React.useState(
      outcome?.description || "",
    );
    const [refs, setRefs] = React.useState(
      (outcome?.todoRefs || []).join("\n"),
    );
    const action = useAction();
    const save = (e) => {
      e.preventDefault();
      action.run(
        () =>
          evidence.mutate({
            op: "outcome",
            outcome: {
              ...(outcome ? { id: outcome.id } : {}),
              title,
              description,
              todoRefs: refs
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            },
          }),
        onDone,
      );
    };
    return (
      <form className="ev-form" onSubmit={save}>
        <fieldset className="ev-fields" disabled={action.busy}>
          <Field label="Outcome">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={500}
            />
          </Field>
          <Field label="Description (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows="2"
            />
          </Field>
          <Field label="Todo links (optional, one text reference per line)">
            <textarea
              value={refs}
              onChange={(e) => setRefs(e.target.value)}
              rows="2"
            />
          </Field>
          <Error error={action.error} />
          <div className="ev-actions">
            <button className="btn" disabled={action.busy}>
              Save outcome
            </button>
            <button type="button" className="btn ghost" onClick={onDone}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    );
  }
  function RequirementEditor({ evidence, outcome, requirement, onDone }) {
    const [text, setText] = React.useState(requirement?.text || "");
    const [kind, setKind] = React.useState(requirement?.kind || "any");
    const [required, setRequired] = React.useState(
      requirement?.required ?? true,
    );
    const action = useAction();
    const save = (e) => {
      e.preventDefault();
      action.run(
        () =>
          evidence.mutate({
            op: "requirement",
            outcomeId: outcome.id,
            requirement: {
              ...(requirement ? { id: requirement.id } : {}),
              text,
              kind,
              required,
            },
          }),
        onDone,
      );
    };
    return (
      <form className="ev-form" onSubmit={save}>
        <fieldset className="ev-fields" disabled={action.busy}>
          <Field label="Acceptance criterion">
            <textarea
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows="2"
            />
          </Field>
          <Field label="Evidence type">
            <Kind value={kind} onChange={setKind} />
          </Field>
          <label className="ev-check">
            <input
              type="checkbox"
              checked={required}
              onChange={(e) => setRequired(e.target.checked)}
            />{" "}
            Required / pinned
          </label>
          <Error error={action.error} />
          <div className="ev-actions">
            <button className="btn" disabled={action.busy}>
              Save criterion
            </button>
            <button type="button" className="btn ghost" onClick={onDone}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    );
  }
  function ScopeDecision({ evidence, outcome, requirement, decision, onDone }) {
    const [reason, setReason] = React.useState("");
    const [confirmed, setConfirmed] = React.useState(false);
    const action = useAction();
    const removing = decision === "retire";
    const target = requirement ? "criterion" : "goal";
    const validReason =
      reason.trim() && new TextEncoder().encode(reason.trim()).length <= 1024;
    return (
      <form
        className="ev-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!validReason || !confirmed) return;
          action.run(
            () =>
              evidence.mutate({
                op: decision,
                outcomeId: outcome.id,
                ...(requirement ? { requirementId: requirement.id } : {}),
                reason: reason.trim(),
              }),
            onDone,
          );
        }}
      >
        <fieldset className="ev-fields" disabled={action.busy}>
          <strong>
            {removing ? `Remove ${target} from scope` : "Accept exception"}
          </strong>
          <p className="ev-note">
            {removing
              ? `This ${target} will no longer count toward active scope. Its evidence and history remain available.`
              : "This criterion remains unmet; accepting an exception records your decision and reason, not proof that it passed."}
          </p>
          <Field
            label={
              removing
                ? "Reason for removing from scope"
                : "Reason for accepting the exception"
            }
          >
            <textarea
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows="2"
            />
          </Field>
          {reason.trim() && !validReason && (
            <p className="ev-error" role="alert">
              Reason must be at most 1024 UTF-8 bytes.
            </p>
          )}
          <label className="ev-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {removing
              ? `I confirm removing this ${target} from scope.`
              : "I confirm accepting this unmet criterion as an exception."}
          </label>
          <Error error={action.error} />
          <div className="ev-actions">
            <button className="btn" disabled={!validReason || !confirmed}>
              {removing ? "Confirm removal" : "Confirm exception"}
            </button>
            <button type="button" className="btn ghost" onClick={onDone}>
              Cancel
            </button>
          </div>
        </fieldset>
      </form>
    );
  }
  function RetirementNote({ item }) {
    if (!item.retired) return null;
    return (
      <p className="ev-note">
        Removed from scope by user.{" "}
        {item.retirement?.reason
          ? `Reason: ${item.retirement.reason}`
          : "Historical removal reason unavailable."}
      </p>
    );
  }
  function Criterion({ evidence, outcome, requirement }) {
    const [editing, setEditing] = React.useState(false);
    const [decision, setDecision] = React.useState(null);
    const action = useAction();
    const status = window.OMP_EVIDENCE_MODEL.requirementStatus(
      evidence.view,
      outcome,
      requirement,
    );
    const displayStatus = requirement.retired
      ? { state: "retired", label: "Removed from scope" }
      : outcome.retired
        ? { state: "retired", label: "Goal removed from scope" }
        : requirement.waiver
          ? { ...status, label: "Exception accepted" }
          : status;
    return (
      <div className="ev-criterion">
        <div className="ev-row">
          <strong>{requirement.text}</strong>
          <Status status={displayStatus} />
        </div>
        <div className="ev-meta">
          {requirement.kind} · {requirement.required ? "required" : "optional"}{" "}
          · created by {requirement.author} · controlled by{" "}
          {requirement.owner || requirement.author} · revision{" "}
          {requirement.revision}
          {requirement.retired ? " · removed from scope" : ""}
        </div>
        {!requirement.retired &&
          !outcome.retired &&
          !requirement.waiver &&
          status.reason && <p className="ev-note">{status.reason}</p>}
        <RetirementNote item={requirement} />
        {requirement.waiver && (
          <p className="ev-note">
            Exception accepted by user: {requirement.waiver.reason}. This
            criterion remains unmet.
          </p>
        )}
        {editing ? (
          <RequirementEditor
            evidence={evidence}
            outcome={outcome}
            requirement={requirement}
            onDone={() => setEditing(false)}
          />
        ) : (
          !outcome.retired &&
          !requirement.retired &&
          !decision && (
            <div className="ev-actions">
              <button className="btn ghost" onClick={() => setEditing(true)}>
                Edit
              </button>
              <button
                className="btn ghost"
                disabled={action.busy}
                onClick={() => setDecision("retire")}
              >
                Remove from scope
              </button>
              {requirement.waiver ? (
                <button
                  className="btn ghost"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(() =>
                      evidence.mutate({
                        op: "unwaive",
                        outcomeId: outcome.id,
                        requirementId: requirement.id,
                      }),
                    )
                  }
                >
                  Remove exception
                </button>
              ) : (
                <button
                  className="btn ghost"
                  disabled={action.busy}
                  onClick={() => setDecision("waive")}
                >
                  Accept exception
                </button>
              )}
            </div>
          )
        )}
        {decision && !outcome.retired && !requirement.retired && (
          <ScopeDecision
            evidence={evidence}
            outcome={outcome}
            requirement={requirement}
            decision={decision}
            onDone={() => setDecision(null)}
          />
        )}
        <Error error={action.error} />
      </div>
    );
  }
  function Outcome({ evidence, outcome }) {
    const [editing, setEditing] = React.useState(false);
    const [adding, setAdding] = React.useState(false);
    const [removing, setRemoving] = React.useState(false);
    return (
      <article className="ev-outcome">
        {editing ? (
          <OutcomeEditor
            evidence={evidence}
            outcome={outcome}
            onDone={() => setEditing(false)}
          />
        ) : (
          <>
            <div className="ev-row">
              <h3>{outcome.title}</h3>
              <span className="ev-meta">
                created by {outcome.author} · controlled by{" "}
                {outcome.owner || outcome.author}
                {outcome.retired ? " · removed from scope" : ""}
              </span>
            </div>
            {outcome.description && <p>{outcome.description}</p>}
            <RetirementNote item={outcome} />
            {!!outcome.todoRefs?.length && (
              <p className="ev-meta">
                Todo references: {outcome.todoRefs.join(" · ")}
              </p>
            )}
            {!outcome.retired && !removing && (
              <div className="ev-actions">
                <button className="btn ghost" onClick={() => setEditing(true)}>
                  Edit outcome
                </button>
                <button className="btn ghost" onClick={() => setRemoving(true)}>
                  Remove goal from scope
                </button>
                <button className="btn ghost" onClick={() => setAdding(true)}>
                  Add criterion
                </button>
              </div>
            )}
          </>
        )}
        {removing && !outcome.retired && (
          <ScopeDecision
            evidence={evidence}
            outcome={outcome}
            decision="retire"
            onDone={() => setRemoving(false)}
          />
        )}
        {(outcome.requirements || []).map((requirement) => (
          <Criterion
            key={requirement.id}
            evidence={evidence}
            outcome={outcome}
            requirement={requirement}
          />
        ))}
        {adding && !outcome.retired && (
          <RequirementEditor
            evidence={evidence}
            outcome={outcome}
            onDone={() => setAdding(false)}
          />
        )}
      </article>
    );
  }
  function Outcomes({ evidence }) {
    const [adding, setAdding] = React.useState(false);
    const outcomes = evidence.view?.outcomes || [];
    return (
      <section className="ev-stack">
        <div className="ev-section-head">
          <div>
            <h2>Manage goals &amp; criteria</h2>
            <p>
              Define what this change needs to prove. Removed goals and criteria
              remain here with their history; only you can change scope or
              accept an exception.
            </p>
          </div>
          <button className="btn" onClick={() => setAdding(true)}>
            Add outcome
          </button>
        </div>
        {adding && (
          <OutcomeEditor evidence={evidence} onDone={() => setAdding(false)} />
        )}
        {!outcomes.length && !adding && (
          <p className="ev-empty">
            No outcomes yet. Add one, then define the evidence it needs.
          </p>
        )}
        {outcomes.map((outcome) => (
          <Outcome key={outcome.id} evidence={evidence} outcome={outcome} />
        ))}
      </section>
    );
  }
  window.EvidenceOutcomes = Outcomes;
})();
