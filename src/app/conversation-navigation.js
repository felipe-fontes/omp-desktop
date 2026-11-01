// Transcript navigation is independent of the number of cells visible in the
// minimap. Only the chat DOM is paged; stable message IDs keep targets intact.
(function () {
  const PAGE_SIZE = 160;

  function minimapKind(message) {
    if (message.kind !== "assistant") return message.kind;
    if (message.failure) return "failure";
    if (message.completed && message.ts == null) return "note";
    const text = message.blocks?.some(block => block.type === "plan" || (block.type === "text" && block.text?.trim()));
    if (!text) return "reasoning";
    return message.stopReason === "toolUse" || message.stopReason === "tool_use" ? "update" : "answer";
  }

  function lastUserIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "user" && !messages[i].agent) return i;
    }
    return -1;
  }

  function pageRange(messages, anchorId = null) {
    const index = anchorId == null ? -1 : messages.findIndex(message => message._id === anchorId);
    const start = index < 0 ? Math.max(0, messages.length - PAGE_SIZE) : index;
    return { start, end: Math.min(messages.length, start + PAGE_SIZE) };
  }

  function anchorFor(messages, targetId) {
    const index = messages.findIndex(message => message._id === targetId);
    if (index < 0) return null;
    const start = Math.max(0, index - Math.floor(PAGE_SIZE / 3));
    return messages[Math.min(start, Math.max(0, messages.length - PAGE_SIZE))]?._id ?? null;
  }

  function adjacentPageAnchor(messages, page, direction) {
    const start = direction < 0 ? Math.max(0, page.start - PAGE_SIZE) : page.end;
    return messages[Math.min(messages.length - 1, start)]?._id ?? null;
  }

  window.OMP_CONVERSATION_NAV = Object.freeze({ PAGE_SIZE, minimapKind, lastUserIndex, pageRange, anchorFor, adjacentPageAnchor });
})();
