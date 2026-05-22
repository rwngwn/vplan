# Migration cutover runbook — vp-8i1.13

## Scope
- Migrate legacy inline annotation markers in revision markdown to v2 annotation records.
- Keep migration idempotent and safe to rerun.
- Provide rollback switch to restore legacy-safe read path.

## Preconditions (STOP/GO #1)
- **GO only if** `OPERATIONS_TOKEN` is configured in runtime environment.
- **GO only if** service is healthy (`/healthz` returns `ok`).
- **GO only if** backup/snapshot of `workspace_annotations` database exists.

## Dry-run verification (STOP/GO #2)
Run:

```bash
curl -s -X POST \
  -H "content-type: application/json" \
  -H "x-ops-token: <OPERATIONS_TOKEN>" \
  -d '{"dry_run": true}' \
  http://localhost:8000/ops/migrations/annotations-v2
```

Required metrics in response:
- `migrated`
- `skipped`
- `failed`
- `parity.expected`
- `parity.actual`

**GO** when `failed == 0` and parity looks consistent for sample rows.

## Execute migration (STOP/GO #3)
Run:

```bash
curl -s -X POST \
  -H "content-type: application/json" \
  -H "x-ops-token: <OPERATIONS_TOKEN>" \
  -d '{"dry_run": false}' \
  http://localhost:8000/ops/migrations/annotations-v2
```

Acceptance checks:
- `failed == 0`
- `migrated + skipped` matches number of revisions evaluated
- `parity.expected == parity.actual`

## Post-cutover checks
- Confirm new revisions keep writing safely.
- Re-run migration with `dry_run: false` and verify idempotency (`migrated == 0`, only `skipped` increases).
- Track telemetry metric `annotations_rollback_count` remains unchanged during normal cutover.

## Rollback (explicit switch)
If post-cutover check fails, execute:

```bash
curl -s -X POST \
  -H "x-ops-token: <OPERATIONS_TOKEN>" \
  http://localhost:8000/ops/migrations/annotations-v2/rollback
```

Expected response includes:
- `rollback_count` incremented
- `annotations_v2_enabled: false`

This restores the safe legacy read path immediately.

## Post-gate cleanup note (vp-ael.6)

- Legacy review-only UI paths were removed from wiki/editor surfaces after vp-8i1 gates stabilized.
- Legacy compatibility write-path branching was removed from `TaskStore`; workspace annotations now persist through a single canonical normalized path.
- Legacy payload shape is still accepted at the API boundary and normalized server-side before persistence.
