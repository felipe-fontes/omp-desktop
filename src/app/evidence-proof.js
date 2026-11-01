// Goal-oriented presentation. Collection and user acceptance stay independent.
(function () {
  const model = window.OMP_EVIDENCE_MODEL;
  const state = (state, label, reason = "") => ({ state, label, reason });
  const nonblank = (value) => typeof value === "string" && !!value.trim();
  const media = (artifact) => /^(image|video)\//.test(artifact?.mime || "");
  const failure = (receipt) =>
    receipt &&
    (receipt.isError === true ||
      (receipt.exitCode != null && receipt.exitCode !== 0));

  function record(view, item, options = {}) {
    const current = model.recordStatus(view, item);
    const receipt = item.source?.receiptId
      ? (view.receipts || []).find(
          (entry) => entry.id === item.source.receiptId,
        )
      : null;
    const artifact = item.artifact || receipt?.artifact || null;
    const freshnessReason = model.freshness(view, item);
    const knownSource =
      model.complete(view.currentFingerprint) &&
      model.complete(item.fingerprint) &&
      (!item.source?.receiptId || model.complete(item.beforeFingerprint));
    const freshness = !freshnessReason
      ? state("current", "Current source")
      : state(
          knownSource ? "stale" : "unknown",
          knownSource ? "Outdated proof" : "Freshness unknown",
          freshnessReason,
        );
    const unavailable =
      artifact && options.unavailableArtifactIds?.has(artifact.id);
    const missingReceipt = !!item.source?.receiptId && !receipt;
    const finding = item.finding;
    const compared = nonblank(finding?.expected) && nonblank(finding?.observed);
    const inspectable = !!(
      artifact?.id ||
      nonblank(receipt?.preview) ||
      item.ci?.snapshot
    );
    let reason = current.reason;
    let projectionState = "available";
    if (current.state !== "collected") projectionState = "attention";
    else if (unavailable) {
      projectionState = "attention";
      reason =
        "The attached proof could not be opened. Refresh or collect a replacement.";
    } else if (missingReceipt) {
      projectionState = "attention";
      reason =
        "The linked execution is unavailable in this snapshot; its output cannot be inspected.";
    } else if (failure(receipt)) {
      projectionState = "attention";
      reason =
        "The linked execution failed; it cannot support a reported pass.";
    } else if (!compared)
      reason =
        "Expected and observed behavior have not been recorded together.";
    else if (!inspectable)
      reason =
        "The finding still needs inspectable output or a linked behavioral check.";
    else if (item.result !== "passed")
      reason = "This is an observation, not a reported behavioral pass.";
    else projectionState = "demonstrated";

    const decision = item.review?.decision || "unreviewed";
    const reviewRequested =
      decision === "unreviewed" && item.reviewRequested === true;
    const review =
      decision === "accepted"
        ? state(
            "accepted",
            "Accepted by you",
            "Your decision applies to the captured version; freshness is shown separately.",
          )
        : decision === "rejected"
          ? state(
              "rejected",
              "Changes requested",
              item.review?.reason || "You rejected this evidence.",
            )
          : reviewRequested
            ? state(
                "requested",
                "Your review requested",
                "Review this proof when you are ready; it has not been accepted.",
              )
            : state(
                "unreviewed",
                "Not reviewed",
                "No review was requested. You do not owe a decision.",
              );
    const check = state(
      item.result || "observed",
      item.result === "passed"
        ? item.source?.type === "agent"
          ? "Agent check passed"
          : "Reported check passed"
        : item.result === "failed"
          ? "Check failed"
          : item.result === "blocked"
            ? "Check blocked"
            : item.result === "cancelled"
              ? "Check cancelled"
              : "Observation only",
      item.reason ||
        "A reported result is not independent verification or user acceptance.",
    );
    const capture = artifact
      ? state("attached", "Artifact captured")
      : receipt
        ? state("captured", "Execution captured")
        : item.fileRef || item.url || item.ci
          ? state("linked", "Proof linked")
          : state("recorded", "Finding recorded");
    return {
      record: item,
      artifact,
      state: projectionState,
      label:
        projectionState === "demonstrated"
          ? "Demonstrated"
          : projectionState === "attention"
            ? "Needs attention"
            : "Proof available",
      reason,
      demonstrated: projectionState === "demonstrated",
      capture,
      check,
      freshness,
      review,
      expected: compared ? finding.expected : "",
      observed: compared ? finding.observed : "",
      limitations: item.limitations || "",
      reviewRequested,
    };
  }

  function rank(proof) {
    return (
      (proof.freshness.state === "current" ? 1000 : 0) +
      (proof.demonstrated ? 400 : 0) +
      (proof.state !== "attention" ? 200 : 0) +
      (media(proof.artifact) ? 100 : proof.artifact ? 50 : 0) -
      (proof.review.state === "rejected" ? 10000 : 0)
    );
  }
  function ordered(records) {
    return records.sort(
      (a, b) =>
        rank(b) - rank(a) ||
        (Date.parse(b.record.at) || 0) - (Date.parse(a.record.at) || 0),
    );
  }
  function criterionFrom(view, outcome, requirement, records) {
    const current = model.requirementStatus(view, outcome, requirement);
    const exception = !!requirement.waiver;
    const best = records[0] || null;
    const demonstrated =
      !exception &&
      current.state === "collected" &&
      records.some((item) => item.demonstrated) &&
      !records.some(
        (item) =>
          item.state === "attention" && item.review.state !== "rejected",
      );
    const gaps = [];
    for (const proof of records) {
      const rejected =
        !exception && !demonstrated && proof.review.state === "rejected";
      if (
        rejected ||
        (proof.state === "attention" && proof.review.state !== "rejected")
      )
        gaps.push({
          state: rejected
            ? "rejected"
            : proof.freshness.state === "current"
              ? "attention"
              : proof.freshness.state,
          text: `${proof.record.title}: ${rejected ? `${proof.review.label}: ${proof.review.reason}` : proof.reason}`,
          recordId: proof.record.id,
          requirementId: requirement.id,
        });
    }
    if (!exception && !demonstrated && !gaps.length && requirement.required)
      gaps.push({
        state: records.length ? "available" : "missing",
        text: records.length
          ? best.reason
          : "No proof has been collected for this behavior.",
        requirementId: requirement.id,
        ...(best ? { recordId: best.record.id } : {}),
      });
    const projectionState = exception
      ? "waived"
      : demonstrated
        ? "demonstrated"
        : gaps.some((gap) => !["available", "missing"].includes(gap.state)) ||
            ["failed", "blocked", "stale", "rejected"].includes(current.state)
          ? "attention"
          : records.length
            ? "available"
            : "missing";
    return {
      requirement,
      state: projectionState,
      label: exception
        ? "Exception accepted"
        : demonstrated
          ? "Demonstrated"
          : projectionState === "attention"
            ? "Needs attention"
            : records.length
              ? "Proof available"
              : "Not demonstrated",
      reason: exception
        ? requirement.waiver.reason
        : demonstrated
          ? "The expected and observed behavior have supporting current proof. User review is separate."
          : gaps[0]?.text ||
            best?.reason ||
            "No proof has been collected for this behavior.",
      demonstrated,
      records,
      best,
      gaps,
      reviewRequested:
        !exception && records.some((item) => item.reviewRequested),
      exception,
    };
  }
  function criterion(view, outcome, requirement, options) {
    const records = ordered(
      (view.records || [])
        .filter(
          (item) =>
            item.outcomeId === outcome.id &&
            item.requirementId === requirement.id,
        )
        .map((item) => record(view, item, options)),
    );
    return criterionFrom(view, outcome, requirement, records);
  }
  function goal(view, outcome, options) {
    const activeRequirements = (outcome.requirements || []).filter(
      (item) => !item.retired,
    );
    const activeIds = new Set(activeRequirements.map((item) => item.id));
    const records = ordered(
      (view.records || [])
        .filter(
          (item) =>
            item.outcomeId === outcome.id &&
            (!item.requirementId || activeIds.has(item.requirementId)),
        )
        .map((item) => record(view, item, options)),
    );
    const criteria = activeRequirements.map((item) =>
      criterionFrom(
        view,
        outcome,
        item,
        records.filter((proof) => proof.record.requirementId === item.id),
      ),
    );
    const required = criteria.filter((item) => item.requirement.required);
    const demonstratedCount = required.filter(
      (item) => item.demonstrated,
    ).length;
    const exceptionCount = criteria.filter((item) => item.exception).length;
    const gaps = criteria.flatMap((item) => item.gaps);
    const unscopedGaps = records.filter(
      (item) =>
        !item.record.requirementId &&
        item.state === "attention" &&
        item.review.state !== "rejected",
    );
    for (const proof of unscopedGaps)
      gaps.push({
        state: "attention",
        text: `${proof.record.title}: ${proof.reason}`,
        recordId: proof.record.id,
      });
    if (!required.length)
      gaps.unshift({
        state: "missing",
        text: "Define an observable success criterion before treating this goal as demonstrated.",
      });
    const demonstrated =
      required.length > 0 &&
      demonstratedCount === required.length &&
      !criteria.some((item) => item.state === "attention") &&
      !unscopedGaps.length;
    const needsAttention =
      criteria.some((item) => item.state === "attention") ||
      required.some((item) => item.exception) ||
      unscopedGaps.length > 0;
    const projectionState = demonstrated
      ? "demonstrated"
      : needsAttention
        ? "attention"
        : records.length
          ? "available"
          : "missing";
    return {
      outcome,
      state: projectionState,
      label: demonstrated
        ? "Demonstrated"
        : needsAttention
          ? "Needs attention"
          : records.length
            ? "Proof available"
            : "Not demonstrated",
      reason: demonstrated
        ? "The required behaviors have current supporting proof. This does not imply your acceptance."
        : gaps[0]?.text ||
          (required.some((item) => item.exception)
            ? "An unmet requirement has an accepted exception; it is not demonstrated."
            : "Collect proof of the required behaviors."),
      demonstrated,
      criteria,
      records,
      best: records[0] || null,
      gaps,
      reviewRequested: records.some((item) => item.reviewRequested),
      demonstratedCount,
      requiredCount: required.length,
      exceptionCount,
      removedCount: (outcome.requirements || []).filter((item) => item.retired)
        .length,
    };
  }
  function goals(view, options) {
    return (view?.outcomes || [])
      .filter((item) => !item.retired)
      .map((item) => goal(view, item, options));
  }
  function summary(view, options) {
    const items = goals(view, options);
    return {
      total: items.length,
      demonstrated: items.filter((item) => item.demonstrated).length,
      attention: items.filter((item) => item.state === "attention").length,
      missing: items.filter((item) =>
        ["missing", "available"].includes(item.state),
      ).length,
      reviewRequested: items.filter((item) => item.reviewRequested).length,
      exceptions: items.reduce((count, item) => count + item.exceptionCount, 0),
      removed:
        (view?.outcomes || []).filter((item) => item.retired).length +
        items.reduce((count, item) => count + item.removedCount, 0),
    };
  }
  window.OMP_EVIDENCE_PROOF = { record, criterion, goal, goals, summary };
})();
