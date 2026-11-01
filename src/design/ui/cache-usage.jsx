/* Request-scoped cache metrics and reporting diagnostics, shared by chat and rail. */
const _CU_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 6,
});
function CacheUsage({ report, scope = "this request" }) {
  const usage = report?.usage;
  const activity = usage?.cacheRead > 0 || usage?.cacheWrite > 0;
  const source = report?.source;
  const rate = usage?.hitRate;
  const rateLabel =
    rate == null
      ? "—"
      : rate > 0 && rate < 0.001
        ? "<0.1%"
        : rate < 1 && rate > 0.999
          ? ">99.9%"
          : `${Number((rate * 100).toFixed(1))}%`;
  const summary =
    report && !usage
      ? source === "unrecognized"
        ? "cache format?"
        : "cache unreported"
      : rate != null
        ? `cache ${rateLabel}`
        : usage?.cacheRead > 0
          ? `cache ${window.formatTokens(usage.cacheRead)} read`
          : "cache —";
  const count = (value) => (value == null ? "—" : String(value));
  const cost = usage?.cost;
  return (
    <details className="cache-usage">
      <summary className="cache-usage-summary mono">
        <span>{summary}</span>{" "}
        <span className="cache-usage-scope">{scope}</span>
      </summary>
      <div className="cache-usage-details">
        <div className="cache-usage-caption">
          {!report
            ? "No assistant request yet."
            : source === "unrecognized"
              ? "Cache-related fields reached the desktop, but their format is not supported here."
              : !usage
                ? "omp did not expose cache counters for this request."
                : usage.promptTokens === 0
                  ? "No prompt tokens recorded for this request."
                  : rate == null
                    ? "Partial cache usage; not enough prompt counters to calculate a read share."
                    : `Cache-read share recorded by omp: ${rateLabel}`}
        </div>
        {report && (
          <dl className="cache-usage-values mono">
            <div>
              <dt>provider</dt>
              <dd>{report.provider ?? "not supplied"}</dd>
            </div>
            <div>
              <dt>model</dt>
              <dd>{report.model ?? "not supplied"}</dd>
            </div>
            <div>
              <dt>desktop</dt>
              <dd>
                {source === "unrecognized"
                  ? "format gap"
                  : "omp integration ready"}
              </dd>
            </div>
            <div>
              <dt>source</dt>
              <dd>
                {usage
                  ? "omp usage counters"
                  : source === "unrecognized"
                    ? "unrecognized usage fields"
                    : "not exposed by omp"}
              </dd>
            </div>
            <div>
              <dt>provider cache</dt>
              <dd>{activity ? "activity recorded" : "support unknown"}</dd>
            </div>
          </dl>
        )}
        {source === "unrecognized" && (
          <p className="cache-usage-foot">
            Fields received: {report.fields.join(", ")}
          </p>
        )}
        {usage && (
          <dl className="cache-usage-values mono">
            <div>
              <dt>cache read</dt>
              <dd>{count(usage?.cacheRead)}</dd>
            </div>
            <div>
              <dt>cache write</dt>
              <dd>{count(usage?.cacheWrite)}</dd>
            </div>
            <div>
              <dt>uncached input</dt>
              <dd>{count(usage?.input)}</dd>
            </div>
            <div>
              <dt>prompt total</dt>
              <dd>{count(usage?.promptTokens)}</dd>
            </div>
            <div>
              <dt>output</dt>
              <dd>{count(usage?.output)}</dd>
            </div>
            {cost?.cacheRead != null && (
              <div>
                <dt>cache read cost</dt>
                <dd>{_CU_USD.format(cost.cacheRead)}</dd>
              </div>
            )}
            {cost?.cacheWrite != null && (
              <div>
                <dt>cache write cost</dt>
                <dd>{_CU_USD.format(cost.cacheWrite)}</dd>
              </div>
            )}
            {cost?.total != null && (
              <div>
                <dt>request cost</dt>
                <dd>{_CU_USD.format(cost.total)}</dd>
              </div>
            )}
          </dl>
        )}
        <p className="cache-usage-foot">
          omp may normalize unreported counters to zero, so zero does not prove
          a provider has no cache. Costs may be estimates. This is request
          usage, not live cache size or time remaining.
          {usage &&
            " Rate = cache read / (uncached input + cache read + cache write)."}
        </p>
      </div>
    </details>
  );
}

window.CacheUsage = CacheUsage;
