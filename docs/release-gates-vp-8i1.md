# Release Gates — vp-8i1

This document defines CI release blockers for vp-8i1.

## Hard gates

1. **Leak gate (`leak=0`)**
   - Command: `npm run gate:leak` (from `frontend/`)
   - Pass criteria: `leakCount === 0`
   - Output artifact: `frontend/gate-results/leak-gate.json`
   - Owner on failure: **Backend + Editor data-integrity owner**

2. **Desktop/mobile parity threshold gate**
   - Command: `npm run gate:parity`
   - Pass criteria: `parityScore >= 0.90` and `pass=true`
   - Output artifact: `frontend/test-results/parity-gate.json`
   - Owner on failure: **Frontend parity owner**

3. **AI confirm invariant gate**
   - Command: `npm run gate:ai-confirm`
   - Pass criteria:
     - no write without explicit confirm
     - abuse-path throttling returns `429 rate_limited`
   - Output artifact: `frontend/gate-results/ai-confirm-gate.json`
   - Owner on failure: **Backend AI flow owner**

## Aggregated machine-readable summary

- Command: `npm run gate:summary`
- Output artifact: `frontend/test-results/release-gates-vp-8i1.json`
- Summary includes:
  - gate pass/fail status
  - parity threshold and measured score
  - trend fields: leak count, parity score, AI confirm violations

## CI fail-fast order

Run deterministic dependency order:

1. `npm run gate:leak`
2. `npm run gate:parity`
3. `npm run gate:ai-confirm`
4. `npm run gate:summary`

Use combined command:

```bash
npm run gate:ci
```

Any failing gate exits non-zero and blocks release.

## Meta-tests (forced failure)

- `npm run gate:meta:parity-blocks` — intentionally exits non-zero to prove CI blocks on parity-gate failure paths.
- `npm run gate:meta:ai-invariant-blocks` — re-runs AI invariant tests used by the release gate.

## Security constraints coverage

- **CWE-209 (information exposure through logs):** gate artifacts only write aggregate counters/flags; no fixture prompt/body payloads are emitted into release artifacts.
- **CWE-770 (resource throttling):** AI abuse-path test asserts throttling behavior and 429 response.

## Changelog note

- vp-ael.6 removed legacy review artifacts and dead annotation branches after gates.
- Wiki/editor generic feedback flow remains stable, and backend annotation persistence now uses a single canonical normalization path.
