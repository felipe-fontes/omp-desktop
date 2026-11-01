# Visual Evidence Experience — Draft Plan

## Overview

Replace the text-heavy evidence ledger as the primary user experience with a concise answer to:

> **What did I ask for, what demonstrates that it works, and is anything still missing?**

Organize evidence by feature, business goal, and observable success criteria—not by tool executions. Show the strongest relevant proof first; keep logs and execution details available on demand.

This is a proposal for review only. No UI, collection behavior, or backend contracts are being changed.

## Approach

### Use evidence to drive discovery

Run a short loop: **question → smallest useful observation → scoped evidence → reassess gaps → next question or draft revision**. Record meaningful findings, not every command. Stop when planning decisions have supporting observations or explicit unknowns; do not treat a “Collected” counter as completion.

The first loop on this proposal exposed that distinction: an observation explicitly listing unfinished discovery changed its criterion to **Collected**, while its record remained **Unreviewed**. That is evidence of collection, not proof that the criterion is satisfied. It directly supports separating capture, behavioral results, freshness, and review.

Discovery evidence supports the plan only. The user's reported gray status and text overload remain the problem statement; no current-panel screenshot or implemented redesign is being claimed.

### Choose a goal-first experience

Three possible directions:

1. **Goal cards:** each requested outcome has its own proof and visible gaps. Strongest connection to the user's request.
2. **Media gallery:** screenshots and recordings lead. Visually compelling, but easy to lose which requirements they actually demonstrate.
3. **Guided review:** present one demonstration and decision at a time. Low initial effort, but harder to see overall coverage.

**Recommendation:** goal cards with an integrated media viewer. Keep an overall coverage summary so attractive demonstrations cannot hide missing objectives.

Each card should answer, in order:

- **Goal:** the result the user wants, in their language.
- **Expected behavior:** a short, observable definition of success.
- **Proof:** an embedded screenshot, playable recording, before/after comparison, or readable output comparison.
- **Finding:** what was actually observed and any limits—not merely “the command passed.”
- **Next action:** what remains for the agent, or an explicit user-review request.

For example, “Export respects the selected filters” needs an export interaction plus a comparison of the actual CSV rows against the complete expected filtered dataset—not just the visible page. A picture of the Export button proves neither export correctness nor file contents.

### Match proof to the claim

- **Appearance:** screenshots with zoom and optional before/after comparison.
- **Interaction:** short recordings with play, pause, and scrubbing, showing the action and resulting state. Provide keyboard-operable controls and a readable equivalent of the demonstrated result.
- **CLI/backend behavior:** readable input → expected result → observed result, backed by an assertion or inspectable output artifact. Show a terminal transcript when it helps; do not manufacture a video requirement.

A successful bash exit proves only that the command reported success. Feature proof requires a relevant behavioral check and its observed result. Logs remain supporting material, collapsed by default.

### Separate proof from approval

Proposed labels—not assertions about the current backend's semantics:

| Proof status | Meaning |
| --- | --- |
| Not demonstrated | Applicable proof is missing. |
| Checking | The agent is exercising the behavior. |
| Demonstrated | The stated behavior has supporting observations for the current source version; this is not user acceptance. |
| Needs attention | A check failed, proof is incomplete or outdated, or a prerequisite is blocked. State the reason. |

“Evidence collected” should not be the main status. Capturing an artifact is an activity, not a verdict. A record's presence must not mark a goal demonstrated while required checks remain unresolved. Show coverage of goals, not a count of tool runs. Do not rely on gray—or any color alone—to communicate meaning.

Keep **review status separate**: “Review not requested,” “Awaiting your review,” “Accepted by you,” or “Changes requested.” Request review only when explicitly required or when human judgment is necessary. Otherwise, collecting evidence must not imply the user owes a decision.

Keep governance actions out of the main proof flow:

- **Retire → Remove from scope:** the requirement is no longer part of the requested work. Preserve its history.
- **Waive → Accept an exception:** the requirement remains unmet, but the user explicitly permits proceeding without satisfying it. This is not proof or a passing result.

Confirm these mappings against the actual backend before renaming controls. For user-owned requirements, only the user can make those decisions; require a reason and show their effect before confirmation.

## Key steps

1. **Run evidence-led discovery and locate the owning UI.** Trace collection, attachments, source freshness, review, Retire, and Waive. Use recorded gaps to select the next investigation and revise the proposal. The evidence-panel implementation was not located in this checkout; resolve ownership before file-level changes.
2. **Prototype the primary experience.** Review goal cards, expanded media, readable nonvisual results, and failed/missing/outdated states using a UI feature and a CLI task. Clearly distinguish illustrative artifacts from real execution evidence.
3. **Connect proof to goals.** Reuse the existing ledger and receipts where possible. Add only missing artifact or state support. Keep media durable, associate it with the relevant criterion and executed source snapshot, and retain provenance behind a details control.
4. **Update collection and presentation together.** Have the agent report the expected behavior, observed result, best supporting proof, and remaining gaps. Group related checks; stop promoting every tool execution into a separate user-facing evidence item.
5. **Implement explicit state and review behavior.** Preserve requirement ownership, previous decisions, source freshness, and history. Label agent-reported findings accurately; do not present them as independent verification or silently promote them to user acceptance.
6. **Validate the actual desktop experience.** Exercise media playback, output inspection, state transitions, review actions, and persistence across tab switches/reloads. Update affected regression coverage and user-facing documentation.

### Acceptance criteria

- The default view reveals the requested goal, observed result, relevant proof, remaining gaps, and any required user action without opening logs.
- Users can enlarge screenshots, play/scrub recordings, and inspect nonvisual output directly from the goal card.
- A successful command alone cannot mark an unrelated feature as demonstrated; failed, missing, blocked, and outdated proof remains visible.
- Artifact capture never implies user acceptance or an unexplained wait for the user.
- Scope removals and exceptions remain distinguishable from satisfied requirements, with their reasons and history preserved.
- Evidence for an older source snapshot cannot silently represent later changes; unavailable artifacts produce an explicit gap rather than a misleading success state.
- Discovery uses the same loop: each finding says what it establishes, what remains unknown, and which planning decision it changes. “Collected” alone never closes discovery.

## Risks

- **Convincing but insufficient media:** a polished screenshot may prove appearance, not functionality. Match each artifact to a specific behavioral claim and disclose limits.
- **Unconfirmed integration boundaries:** the owning evidence UI and lifecycle semantics still need locating; presentation changes may require upstream contract changes.
- **Incomplete capture:** the current evidence report warns that a native execution receipt was not captured. Preserve that limitation; missing provenance must not be presented as independently verified behavior.
- **Privacy and storage:** screenshots and recordings can expose secrets and grow quickly. Define capture consent, redaction, retention, and bounded storage before enabling collection.
- **Desktop compatibility:** verify local media loading and playback under the app's CSP and supported webviews; avoid external hosting dependencies.
- **Oversimplification:** keep the primary view short without hiding failures, exceptions, stale proof, or the difference between agent findings and human acceptance.
