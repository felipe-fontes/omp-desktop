// Pure PR presentation shared by the Changes card and project navigation.
(function () {
  const CHECK_PRIORITY = {
    none: 0,
    success: 1,
    unknown: 2,
    pending: 3,
    failure: 4,
  };

  function countText(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function checksText(checksState, failedCount) {
    const failed = failedCount
      ? countText(failedCount, "failed check", "failed checks")
      : "Checks failed";
    switch (checksState) {
      case "failure":
        return failed;
      case "pending":
        return failedCount ? `Checks pending; ${failed}` : "Checks pending";
      case "success":
        return "Checks passed";
      case "none":
        return "No checks";
      default:
        return "Check results unknown";
    }
  }

  function maxChecks(left, right) {
    return CHECK_PRIORITY[left] >= CHECK_PRIORITY[right] ? left : right;
  }
  // The PR lookup returns only open PRs and individual CI checks.
  function snapshotChecks(snapshot) {
    const state = window.OMP_PR_AUTOMATION.ciSummary(snapshot.checks).state;
    return state === "running" || state === "queued" ? "pending"
      : state === "neutral" ? "unknown" : state;
  }


  function identity(snapshot) {
    return `${snapshot.repository.trim().toLowerCase()}#${snapshot.number}`;
  }

  // Fresh reports supersede stale duplicates of the same PR.
  function summarize(reports) {
    const fresh = reports.filter((status) => !status.discoveryError);
    const snapshots = (fresh.length ? fresh : reports).map(
      (status) => status.snapshot,
    );
    const draft = snapshots.some((snapshot) => snapshot.isDraft);
    const checks = new Set();
    const threads = new Set();
    let checksState = "none";
    for (const snapshot of snapshots) {
      checksState = maxChecks(checksState, snapshotChecks(snapshot));
      for (const check of snapshot.failedChecks) checks.add(check.id);
      for (const thread of snapshot.threads) threads.add(thread.id);
    }
    const snapshot = snapshots[0];
    const repository = snapshots.map((item) => item.repository).sort()[0];
    return {
      draft,
      checksState,
      failedCount: checks.size,
      threadCount: threads.size,
      threads,
      number: snapshot.number,
      repository,
    };
  }

  function lifecycle(group) {
    const glyph = group.draft ? "draft" : "open";
    const tone =
      group.checksState === "failure" || group.failedCount ? "failure" : glyph;
    return { glyph, tone, label: group.draft ? "Draft" : "Open" };
  }

  function groupDescription(group, includeRepository) {
    const { label } = lifecycle(group);
    const identityText = `${label} pull request #${group.number}${includeRepository ? ` (${group.repository})` : ""}`;
    const checks = checksText(group.checksState, group.failedCount);
    const parts = [identityText, checks];
    if (group.threadCount) {
      parts.push(
        countText(
          group.threadCount,
          "unresolved review thread",
          "unresolved review threads",
        ),
      );
    }
    return parts.join("; ");
  }

  function aggregate(statuses) {
    const groups = new Map();
    const errors = new Set();
    let noPrCount = 0;
    for (const status of statuses || []) {
      if (!status) continue;
      if (status.discoveryError) errors.add(String(status.discoveryError));
      if (!status.snapshot) {
        if (
          status.snapshot === null &&
          status.loading === false &&
          !status.discoveryError
        )
          noPrCount++;
        continue;
      }
      const key = identity(status.snapshot);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(status);
    }
    const stale = errors.size > 0;
    const freshness = stale
      ? `; Last known status may be stale: ${[...errors].sort().join("; ")}`
      : "";
    const summaries = [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, reports]) => summarize(reports));
    if (!summaries.length) return null;
    if (summaries.length === 1 && !noPrCount) {
      const group = summaries[0];
      return {
        ...lifecycle(group),
        description: groupDescription(group, false) + freshness,
        number: group.number,
        repository: group.repository,
        lifecycleLabel: lifecycle(group).label,
        lifecycleDescription: `${stale ? "Last known: " : ""}${lifecycle(group).label} pull request #${group.number} (${group.repository})`,
        checksDescription: checksText(group.checksState, group.failedCount),
        reviewDescription: countText(group.threadCount, "unresolved review thread", "unresolved review threads"),
        refreshDescription: stale ? `Last known PR status; refresh failed: ${[...errors].sort().join("; ")}` : null,
        checksState: group.checksState,
        failedCount: group.failedCount,
        threadCount: group.threadCount,
        stale,
        prCount: 1,
      };
    }

    const checksState = summaries.reduce(
      (state, group) => maxChecks(state, group.checksState),
      "none",
    );
    const failedCount = summaries.reduce(
      (count, group) => count + group.failedCount,
      0,
    );
    const threads = new Set(summaries.flatMap((group) => [...group.threads]));
    const threadCount = threads.size;
    const failed = summaries.some(
      (group) => group.checksState === "failure" || group.failedCount,
    );
    const details = summaries
      .map((group) => groupDescription(group, true))
      .join("; ");
    const label =
      summaries.length > 1
        ? "Multiple pull requests"
        : "Mixed pull request status";
    const heading =
      summaries.length > 1 ? `${label} (${summaries.length})` : label;
    const noPr = noPrCount
      ? `; ${countText(noPrCount, "conversation without a pull request", "conversations without a pull request")}`
      : "";
    return {
      glyph: "mixed",
      tone: failed ? "failure" : "mixed",
      label,
      description: `${heading}; ${details}${noPr}${freshness}`,
      number: null,
      repository: null,
      lifecycleLabel: label,
      lifecycleDescription: `${stale ? "Last known: " : ""}${heading}; ${details}${noPr}`,
      checksDescription: checksText(checksState, failedCount),
      reviewDescription: countText(threadCount, "unresolved review thread", "unresolved review threads"),
      refreshDescription: stale ? `Last known PR status; refresh failed: ${[...errors].sort().join("; ")}` : null,
      checksState,
      failedCount,
      threadCount,
      stale,
      prCount: summaries.length,
    };
  }

  function present(status) {
    return aggregate(status ? [status] : []);
  }

  window.OMP_PR_STATUS = { present, aggregate };
})();
