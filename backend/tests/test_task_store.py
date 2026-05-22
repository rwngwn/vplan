import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import AnnotationPayload, AnnotationScope, CreateDocumentAnnotationRequest, CreateDocumentRequest, CreateTaskRequest, TaskStatus, UpdateTaskRequest
from app.task_store import TaskStore


def test_create_task_defaults_to_open_with_extended_fields():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="hello"))

    assert task.status == TaskStatus.open
    assert task.source_type == "manual"
    assert len(task.events) == 1


def test_valid_transition_path_with_done_constraints():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="hello", result_summary="ready"))
    task = store.transition(task.id, TaskStatus.in_progress)
    task = store.transition(task.id, TaskStatus.review)

    rev = store.set_workspace_markdown(task.id, "line one\nline two long enough delta for analysis trigger")
    store.save_review(task.id, rev["revision_id"], "approve", "looks good", [])
    task = store.transition(task.id, TaskStatus.done)

    assert task.status == TaskStatus.done


def test_invalid_transition_raises_and_tracks_telemetry():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="hello"))

    try:
        store.transition(task.id, TaskStatus.done)
    except ValueError as exc:
        assert "invalid transition" in str(exc)
    else:
        raise AssertionError("Expected ValueError")

    assert store.telemetry_snapshot()["status_transition_invalid_attempts"] == 1


def test_update_task_metadata():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="hello"))
    updated = store.update_task(task.id, UpdateTaskRequest(owner="alex", priority=1, acceptance_criteria=["x"]))
    assert updated.owner == "alex"
    assert updated.priority == 1


def test_annotation_payload_validation_enforces_type_and_length_constraints():
    valid = AnnotationPayload(scope=AnnotationScope.text, instruction="Do the thing", line_no=12)
    assert valid.scope == AnnotationScope.text

    with pytest.raises(ValueError):
        AnnotationPayload(scope=AnnotationScope.text, instruction="x" * 1001, line_no=1)

    with pytest.raises(ValueError):
        AnnotationPayload(scope="invalid", instruction="ok", line_no=1)


def test_v2_path_prevents_annotation_leakage_and_keeps_legacy_reader_fallback(tmp_path):
    v2_store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge-v2.db"))
    v2_store.set_feature_flags({"annotations_v2_enabled": True})
    v2_task = v2_store.create_task(CreateTaskRequest(title="v2 task"))
    v2_rev = v2_store.set_workspace_markdown(
        v2_task.id,
        "# note",
        [{"scope": "text", "instruction": "v2", "line_no": 2}],
    )
    assert v2_rev["annotations"] == []
    assert v2_store.list_revision_annotations(v2_task.id, v2_rev["revision_id"]) == [
        {"scope": "text", "feedback": "v2", "line": 2, "instruction": "v2", "line_no": 2}
    ]
    reloaded_v2_store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge-v2.db"))
    reloaded_v2_store._tasks[v2_task.id] = v2_task
    assert reloaded_v2_store.list_revision_annotations(v2_task.id, v2_rev["revision_id"]) == [
        {"scope": "text", "feedback": "v2", "line": 2, "instruction": "v2", "line_no": 2}
    ]


def test_feature_flags_endpoint_contract_response_defaults():
    client = TestClient(app)

    response = client.get("/features/flags")

    assert response.status_code == 200
    payload = response.json()
    assert set(payload.keys()) == {
        "annotations_v2_enabled",
        "dual_write_enabled",
        "ai_confirm_required",
        "selection_scope_v2_enabled",
    }
    assert all(isinstance(value, bool) for value in payload.values())
    assert payload == {
        "annotations_v2_enabled": False,
        "dual_write_enabled": False,
        "ai_confirm_required": True,
        "selection_scope_v2_enabled": False,
    }


def test_workspace_save_returns_generic_4xx_on_annotation_validation_error(monkeypatch):
    client = TestClient(app)

    create_response = client.post("/tasks", json={"title": "task for invalid annotation"})
    task_id = create_response.json()["id"]

    def bad_annotations(_markdown):
        return [type("Ann", (), {"instruction": "x" * 2001, "line_no": 0})()]

    monkeypatch.setattr("app.main.parse_inline_annotations", bad_annotations)

    response = client.post(f"/workspace/tasks/{task_id}", json={"markdown": "any"})

    assert response.status_code == 400
    assert response.json() == {"detail": "invalid annotation payload"}


def test_workspace_save_malformed_fixture_returns_generic_error_without_internal_details(monkeypatch):
    client = TestClient(app)

    create_response = client.post("/tasks", json={"title": "malformed fixture"})
    task_id = create_response.json()["id"]

    def malformed_annotations(_markdown):
        return [type("Ann", (), {"instruction": "ok", "line_no": "bad-line"})()]

    monkeypatch.setattr("app.main.parse_inline_annotations", malformed_annotations)

    response = client.post(f"/workspace/tasks/{task_id}", json={"markdown": "fixture"})

    assert response.status_code == 400
    assert response.json() == {"detail": "invalid annotation payload"}


def test_dual_write_forced_failure_rolls_back_and_keeps_error_payload_generic(monkeypatch, tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    store.set_feature_flags({"annotations_v2_enabled": True, "dual_write_enabled": True})
    task = store.create_task(CreateTaskRequest(title="forced dual-write failure"))

    def fail_v2_write(_task_id, _revision_id, _annotations):
        raise RuntimeError("db exploded with internal details")

    monkeypatch.setattr(store, "_persist_revision_annotations_v2", fail_v2_write)

    with pytest.raises(RuntimeError, match="annotation write failed"):
        store.set_workspace_markdown(
            task.id,
            "# content",
            [{"scope": "text", "instruction": "hidden", "line_no": 1}],
        )

    assert store.telemetry_snapshot()["annotations_dual_write_failure"] == 1
    revisions = store.list_revisions(task.id)
    assert len(revisions) == 0
    assert store.list_revision_annotations(task.id, "missing") == []


def test_ai_preview_confirm_undo_full_flow_and_audit_completeness():
    client = TestClient(app)
    owner = "alice"

    created = client.post(
        "/documents",
        json={"title": "AI Doc", "content": "Original", "owner": owner},
        headers={"x-owner": owner},
    )
    document_id = created.json()["id"]
    base_version = created.json()["version"]

    preview = client.post(
        f"/documents/{document_id}/ai/preview",
        json={"prompt": "Add summary", "operation_id": "op-1", "base_version": base_version},
        headers={"x-owner": owner},
    )
    assert preview.status_code == 200
    preview_payload = preview.json()
    assert preview_payload["persisted"] is False
    assert preview_payload["base_version"] == base_version

    unchanged = client.get(f"/documents/{document_id}")
    assert unchanged.json()["content"] == "Original"
    assert unchanged.json()["version"] == base_version

    confirm = client.post(
        f"/documents/{document_id}/ai/confirm",
        json={"operation_id": "op-1", "base_version": base_version},
        headers={"x-owner": owner},
    )
    assert confirm.status_code == 200
    assert confirm.json()["applied"] is True
    assert confirm.json()["idempotent"] is False

    updated = client.get(f"/documents/{document_id}")
    assert updated.json()["version"] == base_version + 1
    assert "[AI]" in updated.json()["content"]

    undo = client.post(f"/documents/{document_id}/ai/undo", headers={"x-owner": owner})
    assert undo.status_code == 200
    assert undo.json()["undone"] is True

    reverted = client.get(f"/documents/{document_id}")
    assert reverted.json()["content"] == "Original"
    assert reverted.json()["version"] == base_version + 2

    audit = client.get(f"/documents/{document_id}/ai/audit", headers={"x-owner": owner})
    assert audit.status_code == 200
    actions = [entry["action"] for entry in audit.json()]
    assert actions == ["preview", "confirm", "undo"]
    assert all("prompt" not in entry for entry in audit.json())

    telemetry = client.get("/telemetry").json()
    assert telemetry["ai_preview_requests"] >= 1
    assert telemetry["ai_confirm_requests"] >= 1
    assert telemetry["ai_undo_requests"] >= 1


def test_ai_confirm_is_idempotent_and_stale_preview_is_rejected():
    client = TestClient(app)
    owner = "bob"
    created = client.post(
        "/documents",
        json={"title": "AI Doc", "content": "Base", "owner": owner},
        headers={"x-owner": owner},
    )
    document_id = created.json()["id"]
    version = created.json()["version"]

    client.post(
        f"/documents/{document_id}/ai/preview",
        json={"prompt": "change once", "operation_id": "op-idem", "base_version": version},
        headers={"x-owner": owner},
    )

    first_confirm = client.post(
        f"/documents/{document_id}/ai/confirm",
        json={"operation_id": "op-idem", "base_version": version},
        headers={"x-owner": owner},
    )
    second_confirm = client.post(
        f"/documents/{document_id}/ai/confirm",
        json={"operation_id": "op-idem", "base_version": version},
        headers={"x-owner": owner},
    )

    assert first_confirm.status_code == 200
    assert second_confirm.status_code == 200
    assert second_confirm.json()["idempotent"] is True

    current = client.get(f"/documents/{document_id}").json()
    assert current["version"] == version + 1

    stale = client.post(
        f"/documents/{document_id}/ai/preview",
        json={"prompt": "stale", "operation_id": "op-stale", "base_version": version},
        headers={"x-owner": owner},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "stale_preview"


def test_document_annotation_export_keeps_canonical_and_legacy_fields(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge-docs.db"))
    document = store.create_document(CreateDocumentRequest(title="Doc", content="Body", owner="owner"))

    created = store.create_document_annotation(document.id, CreateDocumentAnnotationRequest(scope="text", feedback="feedback body", line=3))

    assert created.feedback == "feedback body"
    assert created.line == 3
    assert created.instruction == "feedback body"
    assert created.line_no == 3


def test_ai_undo_edge_cases_return_expected_errors():
    client = TestClient(app)
    owner = "carol"
    created = client.post(
        "/documents",
        json={"title": "AI Doc", "content": "Base", "owner": owner},
        headers={"x-owner": owner},
    )
    document_id = created.json()["id"]

    missing = client.post(f"/documents/{document_id}/ai/undo", headers={"x-owner": owner})
    assert missing.status_code == 409
    assert missing.json()["error"]["code"] == "undo_unavailable"

    client.post(
        f"/documents/{document_id}/ai/preview",
        json={"prompt": "change", "operation_id": "op-undo", "base_version": 1},
        headers={"x-owner": owner},
    )
    client.post(
        f"/documents/{document_id}/ai/confirm",
        json={"operation_id": "op-undo", "base_version": 1},
        headers={"x-owner": owner},
    )
    first_undo = client.post(f"/documents/{document_id}/ai/undo", headers={"x-owner": owner})
    second_undo = client.post(f"/documents/{document_id}/ai/undo", headers={"x-owner": owner})

    assert first_undo.status_code == 200
    assert second_undo.status_code == 409
    assert second_undo.json()["error"]["code"] == "undo_unavailable"
