import sqlite3

import pytest

from app.models import CreateKnowledgeNoteRequest, CreateTaskRequest
from app.task_store import TaskStore


def test_notes_persist_across_store_restart(tmp_path):
    db_path = tmp_path / "knowledge.db"

    store1 = TaskStore(knowledge_db_path=str(db_path))
    note = store1.create_note(CreateKnowledgeNoteRequest(title="persist-me.md", body="hello"))

    store2 = TaskStore(knowledge_db_path=str(db_path))
    notes = store2.list_notes()

    assert any(n.id == note.id and n.title == "persist-me.md" for n in notes)


def test_canonical_annotation_write_tracks_success_and_failure_telemetry(tmp_path, monkeypatch):
    db_path = tmp_path / "knowledge.db"
    store = TaskStore(knowledge_db_path=str(db_path))
    task = store.create_task(CreateTaskRequest(title="canonical-write"))
    annotations = [{"scope": "text", "instruction": "v2", "line_no": 2}]

    rev = store.set_workspace_markdown(task.id, "# md", annotations)
    assert rev["annotations"] == []
    assert store.list_revision_annotations(task.id, rev["revision_id"]) == [
        {"scope": "text", "feedback": "v2", "line": 2, "instruction": "v2", "line_no": 2}
    ]

    original_v2_write = store._persist_revision_annotations_v2

    def fail_v2(*_args, **_kwargs):
        raise RuntimeError("v2 write failed")

    monkeypatch.setattr(store, "_persist_revision_annotations_v2", fail_v2)
    with pytest.raises(RuntimeError, match="annotation write failed"):
        store.set_workspace_markdown(task.id, "# md", annotations)

    monkeypatch.setattr(store, "_persist_revision_annotations_v2", original_v2_write)
    metrics = store.telemetry_snapshot()
    assert metrics["annotations_dual_write_success"] == 1
    assert metrics["annotations_dual_write_failure"] == 1


def test_canonical_write_rollback_cleans_cache_and_db_when_persist_fails(tmp_path, monkeypatch):
    db_path = tmp_path / "knowledge.db"
    store = TaskStore(knowledge_db_path=str(db_path))
    task = store.create_task(CreateTaskRequest(title="rollback-check"))
    annotations = [{"scope": "text", "instruction": "rollback", "line_no": 1}]

    original_v2_write = store._persist_revision_annotations_v2

    def fail_after_v2_write(task_id, revision_id, anns):
        original_v2_write(task_id, revision_id, anns)
        raise RuntimeError("v2 write failed after persist")

    monkeypatch.setattr(store, "_persist_revision_annotations_v2", fail_after_v2_write)

    with pytest.raises(RuntimeError, match="annotation write failed"):
        store.set_workspace_markdown(task.id, "# md", annotations)

    assert store.list_revisions(task.id) == []
    assert store._workspace_annotations.get(task.id, {}) == {}

    with sqlite3.connect(str(db_path)) as conn:
        row_count = conn.execute("SELECT COUNT(*) FROM workspace_annotations WHERE task_id = ?", (task.id,)).fetchone()[0]

    assert row_count == 0


def test_canonical_write_rollback_failure_still_returns_sanitized_error(tmp_path, monkeypatch):
    db_path = tmp_path / "knowledge.db"
    store = TaskStore(knowledge_db_path=str(db_path))
    task = store.create_task(CreateTaskRequest(title="rollback-error-sanitized"))
    annotations = [{"scope": "text", "instruction": "rollback", "line_no": 1}]

    def fail_v2(*_args, **_kwargs):
        raise RuntimeError("db driver internals")

    def fail_delete(*_args, **_kwargs):
        raise RuntimeError("rollback delete internals")

    monkeypatch.setattr(store, "_persist_revision_annotations_v2", fail_v2)
    monkeypatch.setattr(store, "_delete_revision_annotations_v2", fail_delete)

    with pytest.raises(RuntimeError, match="^annotation write failed$") as exc_info:
        store.set_workspace_markdown(task.id, "# md", annotations)

    assert str(exc_info.value) == "annotation write failed"


def test_annotations_persist_to_db_across_restart(tmp_path):
    db_path = tmp_path / "knowledge.db"
    store1 = TaskStore(knowledge_db_path=str(db_path))
    store1.set_feature_flags({"annotations_v2_enabled": True})
    task = store1.create_task(CreateTaskRequest(title="persist-annotations"))

    rev = store1.set_workspace_markdown(
        task.id,
        "# Note\n\nřádek\n> quote\nsecond line",
        [{"scope": "multi_block", "instruction": "řádek\nquote ✅", "line_no": 3}],
    )

    with sqlite3.connect(str(db_path)) as conn:
        row = conn.execute(
            "SELECT instruction FROM workspace_annotations WHERE task_id = ? AND revision_id = ?",
            (task.id, rev["revision_id"]),
        ).fetchone()

    assert row is not None
    assert row[0] == "řádek\nquote ✅"

    store2 = TaskStore(knowledge_db_path=str(db_path))
    task2 = store2.create_task(CreateTaskRequest(title="other"))
    store2._tasks[task.id] = store2._tasks.pop(task2.id)

    assert store2.list_revision_annotations(task.id, rev["revision_id"]) == [
        {"scope": "multi_block", "feedback": "řádek\nquote ✅", "line": 3, "instruction": "řádek\nquote ✅", "line_no": 3}
    ]


def test_inline_to_v2_migration_is_idempotent_and_reports_parity(tmp_path):
    db_path = tmp_path / "knowledge.db"
    store = TaskStore(knowledge_db_path=str(db_path))

    task = store.create_task(CreateTaskRequest(title="migration-idempotent"))
    rev = store.set_workspace_markdown(
        task.id,
        "# Note\n\n- [[agent: fix title]]\n- TODO(agent): test this\n",
        [{"scope": "text", "instruction": "legacy-inline", "line_no": 3}],
    )

    dry_run = store.run_annotations_v2_migration(dry_run=True)
    assert dry_run["migrated"] == 0
    assert dry_run["skipped"] == 0
    assert dry_run["failed"] == 0
    assert dry_run["parity"]["expected"] == 2
    assert dry_run["parity"]["actual"] == 1

    first = store.run_annotations_v2_migration(dry_run=False)
    assert first["migrated"] == 0
    assert first["skipped"] == 1
    assert first["failed"] == 0
    assert first["parity"]["expected"] == 2
    assert first["parity"]["actual"] == 1

    second = store.run_annotations_v2_migration(dry_run=False)
    assert second["migrated"] == 0
    assert second["skipped"] == 1
    assert second["failed"] == 0
    assert second["parity"]["expected"] == 2
    assert second["parity"]["actual"] == 1

    assert store.list_revision_annotations(task.id, rev["revision_id"]) == [
        {"scope": "text", "feedback": "legacy-inline", "line": 3, "instruction": "legacy-inline", "line_no": 3},
    ]


def test_migration_parity_actual_uses_persisted_v2_counts(tmp_path):
    db_path = tmp_path / "knowledge.db"
    store = TaskStore(knowledge_db_path=str(db_path))

    task = store.create_task(CreateTaskRequest(title="migration-parity-persisted"))
    rev = store.set_workspace_markdown(
        task.id,
        "# Note\n\n- [[agent: one]]\n- [[agent: two]]\n",
        [],
    )

    store._persist_revision_annotations_v2(
        task.id,
        rev["revision_id"],
        [
            {"scope": "text", "instruction": "existing-1", "line_no": 1},
            {"scope": "text", "instruction": "existing-2", "line_no": 2},
            {"scope": "text", "instruction": "existing-3", "line_no": 3},
        ],
    )

    report = store.run_annotations_v2_migration(dry_run=True)
    assert report["parity"]["expected"] == 2
    assert report["parity"]["actual"] == 3


def test_annotations_read_path_rollback_switch_keeps_canonical_persistence_path(tmp_path):
    db_path = tmp_path / "knowledge.db"
    store = TaskStore(knowledge_db_path=str(db_path))
    store.set_feature_flags({"annotations_v2_enabled": True})

    task = store.create_task(CreateTaskRequest(title="rollback-sim"))
    rev = store.set_workspace_markdown(task.id, "# body", [{"scope": "text", "instruction": "legacy-safe", "line_no": 1}])

    assert rev["annotations"] == []

    rollback = store.rollback_annotations_read_path()
    assert rollback["rollback_count"] == 1
    assert rollback["annotations_v2_enabled"] is False

    followup = store.set_workspace_markdown(task.id, "# body-2", [{"scope": "text", "instruction": "still-safe", "line_no": 1}])
    assert followup["annotations"] == []
    assert store.list_revision_annotations(task.id, followup["revision_id"]) == [
        {"scope": "text", "feedback": "still-safe", "line": 1, "instruction": "still-safe", "line_no": 1}
    ]


def test_rollback_preserves_reads_for_historical_v2_only_after_restart(tmp_path):
    db_path = tmp_path / "knowledge.db"
    store1 = TaskStore(knowledge_db_path=str(db_path))
    store1.set_feature_flags({"annotations_v2_enabled": True})
    task = store1.create_task(CreateTaskRequest(title="v2-only-historical"))
    rev = store1.set_workspace_markdown(task.id, "# body", [{"scope": "text", "instruction": "v2-only", "line_no": 1}])

    store2 = TaskStore(knowledge_db_path=str(db_path))
    task2 = store2.create_task(CreateTaskRequest(title="other"))
    store2._tasks[task.id] = store2._tasks.pop(task2.id)
    store2._workspace_revisions[task.id] = [{"revision_id": rev["revision_id"], "markdown": "# body"}]

    store2._workspace_annotations = {}

    rollback = store2.rollback_annotations_read_path()
    assert rollback["annotations_v2_enabled"] is False

    assert store2.list_revision_annotations(task.id, rev["revision_id"]) == [
        {"scope": "text", "feedback": "v2-only", "line": 1, "instruction": "v2-only", "line_no": 1}
    ]
