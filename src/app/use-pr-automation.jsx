/* Per-tab PR automation: the controller owns polling and dispatch; this hook
   supplies current React state and redraws when its visible state changes.
   `railVisible`: the card's rail is on screen (layout not focus, not replaced
   by the tree or browser); with the window, it gates reads while Auto-fix is
   off. */
function usePrAutomation({
  bridge,
  tabId,
  sessionIds,
  sessions = [],
  runState,
  blocked,
  projectKey,
  branchKey = null,
  conversationKey = null,
  featureEnabled = true,
  connected = bridge?.isConnected ?? true,
  railVisible = true,
}) {
  const [, redraw] = React.useState(0);
  const [windowVisible, setWindowVisible] = React.useState(
    window.document?.visibilityState !== "hidden",
  );
  const visible = railVisible && windowVisible;
  const selected = sessions.find((session) => session.id === tabId);
  const localKey = JSON.stringify([tabId, projectKey, branchKey, conversationKey]);
  const [local, setLocal] = React.useState({ key: null, changes: null, error: null });
  const [localRefresh, refreshLocal] = React.useState(0);
  const statuses = React.useRef(new Map());
  const context = React.useRef(null);
  context.current = {
    bridge,
    tabId,
    sessionIds,
    runState,
    blocked,
    projectKey,
    connected,
    branchKey,
    conversationKey,
    featureEnabled,
    visible,
  };
  const controller = React.useRef(null);
  if (!controller.current) {
    controller.current = window.OMP_PR_AUTOMATION.createController({
      getContext: () => context.current,
      onChange: () => redraw((n) => n + 1),
    });
  }
  const automation = controller.current;
  React.useEffect(() => {
    automation.start();
    return () => automation.stop();
  }, [automation]);
  React.useEffect(() => {
    automation.sync();
  }, [
    automation,
    bridge,
    tabId,
    sessionIds,
    runState,
    blocked,
    projectKey,
    connected,
    branchKey,
    conversationKey,
    featureEnabled,
    visible,
  ]);
  // This read is local-only: missing gh or a missing GitHub remote must not
  // prevent the working-tree count from appearing.
  React.useEffect(() => {
    if (!featureEnabled || !visible || !tabId || !projectKey ||
        connected === false || typeof bridge?.changesSnapshot !== "function") return;
    let cancelled = false;
    let timer;
    const read = async () => {
      try {
        const changes = await bridge.changesSnapshot(tabId);
        if (cancelled) return;
        if (changes === window.OMP_PR_AUTOMATION.STALE) {
          timer = setTimeout(read, 250);
          return;
        }
        setLocal({ key: localKey, changes, error: null });
      } catch (error) {
        if (!cancelled) setLocal((previous) => ({
          key: localKey,
          changes: previous.key === localKey ? previous.changes : null,
          error: error?.message || String(error),
        }));
      }
    };
    read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [bridge, tabId, projectKey, branchKey, conversationKey, localKey,
      selected?.gitRevision, connected, featureEnabled, visible, localRefresh]);
  React.useEffect(() => {
    const onFocus = () => { automation.refresh(); refreshLocal((n) => n + 1); };
    const onVisibilityChange = () => {
      const shown = window.document?.visibilityState === "visible";
      setWindowVisible(shown);
      if (shown) { automation.refresh(); refreshLocal((n) => n + 1); }
    };
    window.addEventListener?.("focus", onFocus);
    window.document?.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener?.("focus", onFocus);
      window.document?.removeEventListener(
        "visibilitychange",
        onVisibilityChange,
      );
    };
  }, [automation]);
  const view = automation.view();
  const identities = new Map(sessions.map((s) => [s.id, JSON.stringify([
    s.path, s.branch, s.profile, s.sessionFile, s.processStartedAt,
    s.conversationVersion,
  ])]));
  for (const [id, entry] of statuses.current) {
    if (!featureEnabled || identities.get(id) !== entry.identity) statuses.current.delete(id);
  }
  if (featureEnabled && identities.has(tabId) && (view.snapshot || !view.loading)) {
    statuses.current.set(tabId, { identity: identities.get(tabId), status: {
      snapshot: view.snapshot, loading: view.loading, discoveryError: view.discoveryError,
    } });
  }
  return {
    ...view,
    localChanges: local.key === localKey ? local.changes : null,
    localError: local.key === localKey ? local.error : null,
    statuses: Object.fromEntries([...statuses.current].map(([id, entry]) => [id, entry.status])),
    toggle: automation.toggle,
    pause: automation.pause,
    refresh: () => { automation.refresh(); refreshLocal((n) => n + 1); },
    // `onFocusCapture` of the conversation: focus entering it from another
    // element refreshes the card. Moves inside it would each start a GitHub
    // read, and focus coming back from <body> (no relatedTarget, e.g. after
    // clicking transcript text) is not a return: window focus is the
    // listener above.
    onConversationFocus: (e) => {
      if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
        automation.refresh();
        refreshLocal((n) => n + 1);
      }
    },
  };
}

window.usePrAutomation = usePrAutomation;
