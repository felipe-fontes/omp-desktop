/* Artifact data comes only from the authorized native media service. */
(function () {
  const ImageViewer = window.EvidenceArtifactViewer;
  const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
  const videoTypes = ["video/mp4", "video/webm"];
  const typeOf = (mime) =>
    imageTypes.includes(mime)
      ? "image"
      : videoTypes.includes(mime)
        ? "video"
        : mime === "text/plain"
          ? "text"
          : null;

  function Artifact({ evidence, artifact, onAvailabilityChange }) {
    const [loaded, setLoaded] = React.useState(null);
    const [error, setError] = React.useState("");
    const [expanded, setExpanded] = React.useState(false);
    const [textOpen, setTextOpen] = React.useState(true);
    const callback = React.useRef(null);
    callback.current = {
      explicit: onAvailabilityChange,
      shared: evidence.onArtifactAvailability,
    };
    const id = artifact?.id;
    const mime = artifact?.mime;
    const owner = evidence.ownerKey;
    const type = typeOf(mime);
    const attempt = evidence.assetRefreshVersion || 0;
    const report = (available) => {
      if (!id) return;
      const { shared, explicit } = callback.current;
      shared?.(id, available);
      if (explicit !== shared) explicit?.(id, available);
    };
    const identity = React.useRef(null);
    identity.current = { id, owner, mime, attempt };
    React.useEffect(() => {
      let active = true;
      const owns = () =>
        active &&
        identity.current?.id === id &&
        identity.current?.owner === owner &&
        identity.current?.mime === mime &&
        identity.current?.attempt === attempt;
      setLoaded(null);
      setError("");
      setExpanded(false);
      setTextOpen(true);
      const fail = (message) => {
        if (!owns()) return;
        setError(message);
        report(false);
      };
      if (!id) {
        fail("No durable artifact ID is available.");
      } else if (!type) {
        fail("This artifact type cannot be inspected safely.");
      } else if (
        type === "video" &&
        (typeof document.createElement("video").canPlayType !== "function" ||
          !document.createElement("video").canPlayType(mime))
      ) {
        fail("This environment cannot play the captured video type.");
      } else {
        Promise.resolve()
          .then(() =>
            type === "text" ? evidence.assetText(id) : evidence.assetSource(id),
          )
          .then((value) => {
            if (!owns()) return;
            if (type === "text") {
              if (typeof value?.text !== "string")
                throw new Error("Text preview is unavailable.");
              // Native already bounds the preview; bound rendering independently too.
              setLoaded({
                id,
                owner,
                attempt,
                mime,
                type,
                value: {
                  text: value.text.slice(0, 65536),
                  truncated: value.truncated || value.text.length > 65536,
                },
              });
              report(true);
            } else {
              if (
                value?.mime !== mime ||
                typeof value.url !== "string" ||
                !value.url
              )
                throw new Error(
                  "Authorized media source is unavailable or has a different type.",
                );
              setLoaded({ id, owner, mime, attempt, type, value: value.url });
            }
          })
          .catch((err) => fail(err?.message || String(err)));
      }
      return () => {
        active = false;
      };
    }, [
      id,
      mime,
      type,
      owner,
      attempt,
      evidence.assetSource,
      evidence.assetText,
    ]);
    if (!artifact) return <p className="ev-note">No artifact attached.</p>;
    const current =
      loaded?.id === id &&
      loaded?.owner === owner &&
      loaded?.mime === mime &&
      loaded?.attempt === attempt
        ? loaded
        : null;
    const failDecode = (message) => {
      if (
        identity.current?.id !== id ||
        identity.current?.owner !== owner ||
        identity.current?.mime !== mime ||
        identity.current?.attempt !== attempt
      )
        return;
      setError(message);
      report(false);
    };
    const success = () => {
      if (
        identity.current?.id === id &&
        identity.current?.owner === owner &&
        identity.current?.mime === mime &&
        id &&
        identity.current?.attempt === attempt
      )
        report(true);
    };
    return (
      <div className="ev-artifact ev-proof-artifact">
        <div className="ev-proof-caption">
          <strong>{artifact.name || "Evidence artifact"}</strong>
          <span>
            {mime || "Unknown type"}
            {artifact.bytes != null ? ` · ${artifact.bytes} bytes` : ""}
          </span>
        </div>
        {error ? (
          <p className="ev-error" role="alert">
            Artifact unavailable: {error}
          </p>
        ) : !current ? (
          <p className="ev-note">Loading artifact…</p>
        ) : current.type === "image" ? (
          <>
            <button
              type="button"
              className="ev-proof-image-button"
              onClick={() => setExpanded(true)}
              aria-label={`Enlarge ${artifact.name || "evidence image"}`}
            >
              <img
                src={current.value}
                alt={artifact.name || "Evidence image"}
                loading="lazy"
                decoding="async"
                onLoad={success}
                onError={() =>
                  failDecode("Image could not be decoded or loaded.")
                }
              />
              <span>Enlarge image</span>
            </button>
            {expanded && (
              <ImageViewer
                source={current.value}
                name={artifact.name || "Evidence image"}
                onClose={() => setExpanded(false)}
                onError={() =>
                  failDecode("Enlarged image could not be decoded or loaded.")
                }
              />
            )}
          </>
        ) : current.type === "video" ? (
          <video
            className="ev-proof-video"
            controls
            preload="metadata"
            src={current.value}
            onLoadedMetadata={success}
            onError={() =>
              failDecode("Video playback or decoding is unavailable.")
            }
          >
            Video playback is unavailable in this environment.
          </video>
        ) : (
          <details
            className="ev-proof-text"
            open={textOpen}
            onToggle={(event) => setTextOpen(event.currentTarget.open)}
          >
            <summary>Inspect text output</summary>
            <pre className="selectable">{current.value.text}</pre>
            {current.value.truncated && (
              <p className="ev-note">Text preview is truncated.</p>
            )}
          </details>
        )}
        <details className="ev-proof-metadata">
          <summary>Artifact details</summary>
          <p className="ev-meta ev-break">
            ID: {id || "unavailable"}
            {artifact.sha256 ? ` · SHA-256 ${artifact.sha256}` : ""}
          </p>
        </details>
      </div>
    );
  }

  window.EvidenceArtifact = Artifact;
})();
