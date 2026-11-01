// Request usage reported through omp, not provider cache contents or capacity.
// omp may initialize unreported counters to zero; zero is not a support flag.
(function () {
  const number = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;

  function fromUsage(usage) {
    if (!usage || typeof usage !== "object") return null;
    // Prefer a supplied omp field, even when invalid, to avoid replacing an
    // unknown value with a conflicting raw provider field.
    const field = (normalized, raw) =>
      number(usage[normalized] === undefined ? usage[raw] : usage[normalized]);
    const input = field("input", "input_tokens");
    const output = field("output", "output_tokens");
    const cacheRead = field("cacheRead", "cache_read_input_tokens");
    const cacheWrite = field("cacheWrite", "cache_creation_input_tokens");
    if (cacheRead === null && cacheWrite === null) return null;

    // omp's input is uncached: prompt tokens add input, cache reads and writes.
    const promptTokens =
      input !== null && cacheRead !== null && cacheWrite !== null
        ? number(input + cacheRead + cacheWrite)
        : null;
    const hitRate =
      promptTokens !== null && promptTokens > 0
        ? cacheRead / promptTokens
        : null;
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      promptTokens,
      hitRate,
      cost: {
        cacheRead: number(usage.cost?.cacheRead),
        cacheWrite: number(usage.cost?.cacheWrite),
        total: number(usage.cost?.total),
      },
    };
  }

  // Only field names, never arbitrary provider payloads. Bounded and used only
  // when the known counter formats are absent; costs aren't token counters.
  function cacheFields(usage) {
    const fields = [];
    function visit(value, prefix, depth) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        depth > 2
      )
        return;
      for (const key of Object.keys(value)) {
        if (fields.length === 6) return;
        if (key === "cost" || value[key] == null) continue;
        const path = prefix ? `${prefix}.${key}` : key;
        if (/cache/i.test(key)) fields.push(path);
        else visit(value[key], path, depth + 1);
      }
    }
    visit(usage, "", 0);
    return fields;
  }

  // Provider identity belongs to this request, not the tab's current model.
  function fromMessage(message) {
    if (message?.role !== "assistant") return null;
    const usage = fromUsage(message.usage);
    const fields = usage ? [] : cacheFields(message.usage);
    const identity = (value) =>
      typeof value === "string" && value.trim() ? value : null;
    return {
      provider: identity(message.provider),
      model: identity(message.model),
      usage,
      source: usage ? "omp" : fields.length ? "unrecognized" : "missing",
      fields,
    };
  }

  function fromMessages(messages) {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return fromMessage(messages[i]);
    }
    return null;
  }

  window.OMP_CACHE_USAGE = { fromUsage, fromMessage, fromMessages };
})();
