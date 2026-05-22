# PRD: Plannotator Annotation UX Replication in vplan

## 1) Executive Summary
vplan currently lacks a first-class annotation review loop that combines inline feedback with an explicit approval gate. This creates friction for human review, weakens revision quality, and leaves host integrations without a consistent machine-readable decision output.

We will implement a Workflow Fidelity First MVP that replicates the core Plannotator annotation UX inside vplan: users annotate content inline, manage annotations in a side panel, make an explicit approve/send/dismiss decision, and emit a structured JSON payload for downstream automation.

Target users are: (a) reviewers who annotate generated plans/specs, (b) authors/agents that revise based on feedback, and (c) host orchestrators that need deterministic decision payloads.

Success is measured by: higher review completion rate, strict JSON validity, anchor reattachment reliability across revisions, and zero leakage defects (no unintended metadata/content exposure).

## 2) User Stories

### Persona A: Reviewer
1. As a reviewer, I want to highlight text and create typed annotations so that I can leave precise, actionable feedback.
2. As a reviewer, I want a side panel that lists annotations with filters and status so that I can manage review progress quickly.
3. As a reviewer, I want keyboard shortcuts for annotation and decision actions so that review is fast without heavy mouse use.
4. As a reviewer, I want an explicit approve/send/dismiss action so that my decision is unambiguous.

### Persona B: Author/Agent
1. As an author/agent, I want structured annotation output (not free text only) so that I can apply revisions programmatically.
2. As an author/agent, I want revision diffs with stable anchor mapping so that I can preserve context between versions.

### Persona C: Host Integrator
1. As a host integrator, I want a versioned decision payload contract so that I can reliably parse and route reviewer outcomes.
2. As a host integrator, I want strict metadata/content separation so that private runtime metadata never leaks into user-visible content.

### Acceptance Criteria for P0 Stories
- Reviewer can create, edit, and delete annotations of 5 MVP types on inline selections.
- Side panel reflects all annotations in real time, supports selection jump, and status filtering.
- Approve/send/dismiss state machine enforces allowed transitions and emits one final decision event per review session.
- Decision payload validates against schema version `1.0` with 100% validity in automated tests.
- After revision, >=95% of anchors reattach automatically for non-destructive edits in test corpus.
- Metadata fields are never rendered in end-user content views; leakage test suite has zero critical failures.

## 3) Feature List (MoSCoW)

### Must Have (MVP)
1. **Inline annotation creation** with 5 types:
   - issue
   - suggestion
   - question
   - praise
   - blocker
2. **Annotation side panel**: list, select-to-jump, status display, basic filter (open/resolved/all).
3. **Decision controls**: approve / send / dismiss with explicit confirmation semantics.
4. **Structured JSON decision output** (versioned contract, strict validation).
5. **Keyboard shortcuts** for create annotation, navigate annotations, and submit decision.
6. **Revision diff + anchor reattachment** using text-quote + positional fallback strategy.
7. **Metadata/content separation layer** for privacy-safe rendering and transport.

### Should Have
1. Batch resolve/unresolve in side panel.
2. Annotation type color legends and quick toggle filters.
3. Session autosave recovery for unfinished reviews.

### Could Have
1. Collaborative multi-reviewer view.
2. Inline thread replies per annotation.
3. Export to markdown summary in addition to JSON.

### Won’t Have (this version)
1. Real-time multi-user co-editing.
2. Arbitrary document format support beyond current vplan render targets.
3. External share links/public annotation publishing.

## 4) Explicit Feature Requirements
1. **Semantics first:** each annotation must carry type + severity/priority + actionable message.
2. **Contract first:** no send/approve event may be emitted without schema-valid payload.
3. **Interaction determinism:** identical user action sequence must produce identical decision state transitions.
4. **Revision robustness:** anchors must survive common edits (insertions/deletions around selection).
5. **Release gate alignment:** feature cannot roll out without passing contract, anchor, and leakage gates.

## 5) Non-Goals
- Building a generalized collaborative editor platform.
- Replacing vplan’s existing generation pipeline.
- Introducing external sharing/permissions model beyond current host boundaries.
- Full historical analytics dashboard (basic event metrics only in MVP).

## 6) Technical Constraints
- Must integrate with existing vplan host integration boundaries and event bus semantics.
- Must preserve privacy boundaries: metadata-only fields cannot be mixed into display content payloads.
- Must support deterministic schema validation in CI and at runtime.
- Must remain compatible with existing revision workflow and diff subsystem assumptions.

## 7) Data Contract — Annotation Decision Payload (v1.0)

```json
{
  "schemaVersion": "1.0",
  "sessionId": "uuid",
  "document": {
    "id": "string",
    "revisionId": "string",
    "contentHash": "sha256"
  },
  "reviewer": {
    "id": "string",
    "role": "human|agent"
  },
  "decision": {
    "action": "approve|send|dismiss",
    "timestamp": "ISO-8601",
    "comment": "string|null"
  },
  "annotations": [
    {
      "id": "uuid",
      "type": "issue|suggestion|question|praise|blocker",
      "status": "open|resolved",
      "priority": "p0|p1|p2|p3",
      "anchor": {
        "quote": "string",
        "start": 0,
        "end": 0,
        "path": "optional structural path"
      },
      "message": "string",
      "metadata": {
        "createdAt": "ISO-8601",
        "updatedAt": "ISO-8601"
      }
    }
  ],
  "metrics": {
    "annotationCount": 0,
    "openCount": 0,
    "resolvedCount": 0
  }
}
```

Contract rules:
- `schemaVersion` required and must equal supported parser version.
- `decision.action` is required and terminal for session.
- `annotations[].anchor.quote` required for primary reattachment; `start/end` are secondary fallback.
- `metadata` is transport/internal only and must not render in user-visible annotation text.

## 8) UX Behavior — Approve/Send/Dismiss State Machine

States: `draft` -> `reviewing` -> terminal (`approved` | `sent` | `dismissed`)

Transitions:
- `draft` -> `reviewing`: first annotation created or panel opened.
- `reviewing` -> `approved`: reviewer confirms approve; allowed only if no open `blocker` annotations.
- `reviewing` -> `sent`: reviewer confirms send; allowed with open items.
- `reviewing` -> `dismissed`: reviewer confirms dismiss; captures optional reason.
- Terminal states are immutable; re-open requires new session.

UI rules:
- Decision buttons always visible in side panel footer.
- Disabled state includes inline reason (e.g., "Approve blocked: unresolved blocker annotation").
- Confirm dialog required for terminal action; post-confirm emits exactly one decision payload.

## 9) Success Metrics (OKR-Aligned)
- **Review completion rate:** +20% from baseline within 30 days of rollout.
- **JSON validity:** 100% schema-valid payloads in CI and runtime telemetry.
- **Anchor reattachment rate:** >=95% in controlled revision corpus; >=90% in production telemetry.
- **Zero leakage defects:** 0 Sev1/Sev2 incidents for metadata/content boundary.

## 10) Risks and Mitigations
1. **Anchor stability drift on heavy edits**
   - Mitigation: layered reattachment (quote match -> positional fallback -> unresolved flag) + regression corpus.
2. **Approval policy ambiguity**
   - Mitigation: explicit blocking rule for `blocker` type in state machine and UI copy.
3. **Host integration semantic mismatch**
   - Mitigation: versioned schema + contract tests in host adapter.
4. **Privacy boundary violation**
   - Mitigation: strict serializer split, leakage unit tests, and pre-release security checklist.

## 11) Rollout Plan
1. **Phase 0 (internal flag):** ship to team-only environment; validate state machine + contract.
2. **Phase 1 (limited beta):** enable for selected workflows; monitor metrics and leakage gates.
3. **Phase 2 (default on):** enable by default after two consecutive weeks meeting validity + leakage + anchor thresholds.
4. **Fallback:** instant kill-switch to legacy review flow if Sev1 defect appears.

## 12) MVP Definition
MVP is complete when reviewers can create 5 typed inline annotations, manage them in a side panel, and submit approve/send/dismiss with schema-valid decision payloads that survive revision via stable reattachment. This MVP validates the Workflow Fidelity First hypothesis and is releasable once contract, anchor, and privacy gates pass.

## 13) Open Questions
1. Should `approve` require all non-blocker annotations resolved, or only blocker-free status?
2. Should `dismiss` payload include mandatory reason codes for analytics?
3. What production telemetry retention window is acceptable for privacy policy?
4. Do host adapters need backward compatibility shims for pre-1.0 payload consumers?
