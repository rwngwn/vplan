import asyncio

from fastapi.testclient import TestClient

from app.main import app, healthz, store
from app.models import CreateDocumentRequest


def test_healthz_endpoint():
    assert asyncio.run(healthz()) == {"status": "ok"}


def test_documents_and_annotations_crud_contract():
    client = TestClient(app)

    create_doc = client.post(
        "/documents",
        json={"title": "Doc 1", "content": "hello", "owner": "alice"},
        headers={"x-owner": "alice"},
    )
    assert create_doc.status_code == 201
    doc = create_doc.json()
    assert doc["title"] == "Doc 1"
    assert doc["content"] == "hello"
    assert doc["owner"] == "alice"
    assert doc["version"] == 1

    doc_id = doc["id"]
    list_docs = client.get("/documents")
    assert list_docs.status_code == 200
    assert any(item["id"] == doc_id for item in list_docs.json())

    update_doc = client.patch(
        f"/documents/{doc_id}",
        json={"title": "Doc 1 updated", "version": 1},
        headers={"x-owner": "alice"},
    )
    assert update_doc.status_code == 200
    updated_doc = update_doc.json()
    assert updated_doc["title"] == "Doc 1 updated"
    assert updated_doc["version"] == 2

    create_annotation = client.post(
        f"/documents/{doc_id}/annotations",
        json={"scope": "multi_block", "instruction": "Review this", "line_no": 2},
        headers={"x-owner": "alice"},
    )
    assert create_annotation.status_code == 201
    annotation = create_annotation.json()
    assert annotation["scope"] == "multi_block"
    ann_id = annotation["id"]

    list_annotations = client.get(f"/documents/{doc_id}/annotations")
    assert list_annotations.status_code == 200
    assert any(item["id"] == ann_id for item in list_annotations.json())

    patch_annotation = client.patch(
        f"/documents/{doc_id}/annotations/{ann_id}",
        json={"instruction": "Updated", "version": 1},
        headers={"x-owner": "alice"},
    )
    assert patch_annotation.status_code == 200
    assert patch_annotation.json()["instruction"] == "Updated"
    assert patch_annotation.json()["version"] == 2

    delete_annotation = client.delete(
        f"/documents/{doc_id}/annotations/{ann_id}",
        headers={"x-owner": "alice"},
    )
    assert delete_annotation.status_code == 204

    delete_doc = client.delete(f"/documents/{doc_id}", headers={"x-owner": "alice"})
    assert delete_doc.status_code == 204


def test_document_annotation_contract_accepts_canonical_legacy_and_mixed_payloads():
    client = TestClient(app)

    create_doc = client.post(
        "/documents",
        json={"title": "Contract", "content": "hello", "owner": "alice"},
        headers={"x-owner": "alice"},
    )
    assert create_doc.status_code == 201
    doc_id = create_doc.json()["id"]

    canonical = client.post(
        f"/documents/{doc_id}/annotations",
        json={"scope": "text", "feedback": "canonical only", "line": 2},
        headers={"x-owner": "alice"},
    )
    assert canonical.status_code == 201
    canonical_body = canonical.json()
    assert canonical_body["feedback"] == "canonical only"
    assert canonical_body["line"] == 2
    assert canonical_body["instruction"] == "canonical only"
    assert canonical_body["line_no"] == 2

    legacy = client.post(
        f"/documents/{doc_id}/annotations",
        json={"scope": "text", "instruction": "legacy only", "line_no": 3},
        headers={"x-owner": "alice"},
    )
    assert legacy.status_code == 201
    legacy_body = legacy.json()
    assert legacy_body["feedback"] == "legacy only"
    assert legacy_body["line"] == 3
    assert legacy_body["instruction"] == "legacy only"
    assert legacy_body["line_no"] == 3

    mixed = client.post(
        f"/documents/{doc_id}/annotations",
        json={
            "scope": "text",
            "feedback": "canonical wins",
            "line": 7,
            "instruction": "legacy ignored",
            "line_no": 1,
        },
        headers={"x-owner": "alice"},
    )
    assert mixed.status_code == 201
    mixed_body = mixed.json()
    assert mixed_body["feedback"] == "canonical wins"
    assert mixed_body["line"] == 7
    assert mixed_body["instruction"] == "canonical wins"
    assert mixed_body["line_no"] == 7

    listed = client.get(f"/documents/{doc_id}/annotations")
    assert listed.status_code == 200
    assert all("feedback" in item and "line" in item for item in listed.json())
    assert all(item["feedback"] == item["instruction"] for item in listed.json())
    assert all(item["line"] == item["line_no"] for item in listed.json())


def test_document_annotation_exports_are_mirrored_even_if_storage_drifts():
    client = TestClient(app)

    create_doc = client.post(
        "/documents",
        json={"title": "Drift", "content": "hello", "owner": "alice"},
        headers={"x-owner": "alice"},
    )
    assert create_doc.status_code == 201
    doc_id = create_doc.json()["id"]

    created = client.post(
        f"/documents/{doc_id}/annotations",
        json={"scope": "text", "feedback": "canonical", "line": 5},
        headers={"x-owner": "alice"},
    )
    assert created.status_code == 201
    annotation_id = created.json()["id"]

    # Simulate accidental internal drift to ensure exported API contract is stable.
    annotation = store._document_annotations[doc_id][annotation_id]
    annotation.instruction = "drifted"
    annotation.line_no = 999

    listed = client.get(f"/documents/{doc_id}/annotations")
    assert listed.status_code == 200
    listed_item = next(item for item in listed.json() if item["id"] == annotation_id)
    assert listed_item["feedback"] == "canonical"
    assert listed_item["instruction"] == "canonical"
    assert listed_item["line"] == 5
    assert listed_item["line_no"] == 5


def test_annotation_lifecycle_create_edit_resolve_delete_is_non_blocking_for_document_content():
    client = TestClient(app)

    create_doc = client.post(
        "/documents",
        json={"title": "Lifecycle", "content": "stable body", "owner": "alice"},
        headers={"x-owner": "alice"},
    )
    assert create_doc.status_code == 201
    doc_id = create_doc.json()["id"]

    created = client.post(
        f"/documents/{doc_id}/annotations",
        json={"scope": "text", "feedback": "first", "line": 1},
        headers={"x-owner": "alice"},
    )
    assert created.status_code == 201
    annotation = created.json()

    edited = client.patch(
        f"/documents/{doc_id}/annotations/{annotation['id']}",
        json={"feedback": "edited", "line": 1, "version": annotation["version"]},
        headers={"x-owner": "alice"},
    )
    assert edited.status_code == 200
    assert edited.json()["feedback"] == "edited"

    resolved = client.delete(
        f"/documents/{doc_id}/annotations/{annotation['id']}",
        headers={"x-owner": "alice"},
    )
    assert resolved.status_code == 204

    current_doc = client.get(f"/documents/{doc_id}")
    assert current_doc.status_code == 200
    assert current_doc.json()["content"] == "stable body"


def test_annotation_error_paths_reject_malformed_payloads_and_detect_conflicts():
    client = TestClient(app)

    create_doc = client.post(
        "/documents",
        json={"title": "Errors", "content": "body", "owner": "alice"},
        headers={"x-owner": "alice"},
    )
    assert create_doc.status_code == 201
    doc_id = create_doc.json()["id"]

    malformed = client.post(
        f"/documents/{doc_id}/annotations",
        json={"scope": "text", "line": 1},
        headers={"x-owner": "alice"},
    )
    assert malformed.status_code == 422
    assert malformed.json()["error"]["code"] == "validation_error"

    created = client.post(
        f"/documents/{doc_id}/annotations",
        json={"scope": "text", "feedback": "valid", "line": 2},
        headers={"x-owner": "alice"},
    )
    assert created.status_code == 201
    annotation = created.json()

    stale = client.patch(
        f"/documents/{doc_id}/annotations/{annotation['id']}",
        json={"feedback": "stale", "line": 3, "version": annotation["version"] + 1},
        headers={"x-owner": "alice"},
    )
    assert stale.status_code == 409
    assert stale.json() == {"error": {"code": "conflict", "message": "version conflict"}}


def test_standardized_errors_validation_ownership_and_conflict():
    client = TestClient(app)

    doc_for_validation = client.post(
        "/documents",
        json={"title": "For Validation", "content": "x", "owner": "alice"},
        headers={"x-owner": "alice"},
    )
    doc_for_validation_id = doc_for_validation.json()["id"]

    bad_scope = client.post(
        f"/documents/{doc_for_validation_id}/annotations",
        json={"scope": "invalid", "instruction": "bad", "line_no": 1},
        headers={"x-owner": "alice"},
    )
    assert bad_scope.status_code == 422
    assert bad_scope.json()["error"]["code"] == "validation_error"

    create_doc = client.post(
        "/documents",
        json={"title": "Owned", "content": "x", "owner": "alice"},
        headers={"x-owner": "alice"},
    )
    doc_id = create_doc.json()["id"]

    forbidden = client.patch(f"/documents/{doc_id}", json={"title": "hack", "version": 1}, headers={"x-owner": "bob"})
    assert forbidden.status_code == 403
    assert forbidden.json() == {"error": {"code": "forbidden", "message": "forbidden"}}

    conflict = client.patch(
        f"/documents/{doc_id}",
        json={"title": "stale", "version": 999},
        headers={"x-owner": "alice"},
    )
    assert conflict.status_code == 409
    assert conflict.json() == {"error": {"code": "conflict", "message": "version conflict"}}


def test_mutation_endpoints_rate_limited(monkeypatch):
    client = TestClient(app)
    store._mutation_hits.clear()
    monkeypatch.setattr(store, "_mutation_limit", 1)
    monkeypatch.setattr(store, "_mutation_window_seconds", 60)

    first = client.post(
        "/documents",
        json={"title": "One", "content": "x", "owner": "ratelimit"},
        headers={"x-owner": "ratelimit"},
    )
    assert first.status_code == 201
    second = client.post(
        "/documents",
        json={"title": "Two", "content": "y", "owner": "ratelimit"},
        headers={"x-owner": "ratelimit"},
    )
    assert second.status_code == 429
    assert second.json() == {"error": {"code": "rate_limited", "message": "too many mutation requests"}}


def test_create_document_owner_must_match_authenticated_owner():
    client = TestClient(app)

    missing_owner_header = client.post("/documents", json={"title": "Doc", "content": "x", "owner": "alice"})
    assert missing_owner_header.status_code == 401
    assert missing_owner_header.json() == {"error": {"code": "unauthorized", "message": "x-owner header required"}}

    mismatch_owner = client.post(
        "/documents",
        json={"title": "Doc", "content": "x", "owner": "alice"},
        headers={"x-owner": "bob"},
    )
    assert mismatch_owner.status_code == 403
    assert mismatch_owner.json() == {"error": {"code": "forbidden", "message": "owner mismatch"}}


def test_ownerless_document_cannot_bypass_ownership_checks():
    client = TestClient(app)

    ownerless = store.create_document(CreateDocumentRequest(title="Ownerless", content="x", owner=""))

    patch = client.patch(
        f"/documents/{ownerless.id}",
        json={"title": "new", "version": ownerless.version},
        headers={"x-owner": "alice"},
    )
    assert patch.status_code == 403
    assert patch.json() == {"error": {"code": "forbidden", "message": "owner missing"}}


def test_missing_resources_return_standardized_not_found_errors():
    client = TestClient(app)
    missing_doc_id = "missing-doc"

    get_doc = client.get(f"/documents/{missing_doc_id}")
    assert get_doc.status_code == 404
    assert get_doc.json() == {"error": {"code": "not_found", "message": "document not found"}}

    list_annotations = client.get(f"/documents/{missing_doc_id}/annotations")
    assert list_annotations.status_code == 404
    assert list_annotations.json() == {"error": {"code": "not_found", "message": "document not found"}}

    create_doc = client.post(
        "/documents",
        json={"title": "Present", "content": "x", "owner": "alice"},
        headers={"x-owner": "alice"},
    )
    assert create_doc.status_code == 201
    doc_id = create_doc.json()["id"]

    get_annotation = client.patch(
        f"/documents/{doc_id}/annotations/missing-ann",
        json={"instruction": "u", "version": 1},
        headers={"x-owner": "alice"},
    )
    assert get_annotation.status_code == 404
    assert get_annotation.json() == {"error": {"code": "not_found", "message": "annotation not found"}}

    delete_annotation = client.delete(
        f"/documents/{doc_id}/annotations/missing-ann",
        headers={"x-owner": "alice"},
    )
    assert delete_annotation.status_code == 404
    assert delete_annotation.json() == {"error": {"code": "not_found", "message": "annotation not found"}}


def test_migration_endpoints_require_privileged_header(monkeypatch):
    client = TestClient(app)

    monkeypatch.setenv("OPERATIONS_TOKEN", "secret-token")

    denied = client.post("/ops/migrations/annotations-v2", json={"dry_run": True})
    assert denied.status_code == 403
    assert denied.json() == {"error": {"code": "forbidden", "message": "forbidden"}}

    rollback_denied = client.post("/ops/migrations/annotations-v2/rollback")
    assert rollback_denied.status_code == 403
    assert rollback_denied.json() == {"error": {"code": "forbidden", "message": "forbidden"}}


def test_migration_endpoints_run_with_privileged_header(monkeypatch):
    client = TestClient(app)
    monkeypatch.setenv("OPERATIONS_TOKEN", "secret-token")

    monkeypatch.setattr(
        store,
        "run_annotations_v2_migration",
        lambda dry_run: {
            "dry_run": dry_run,
            "migrated": 1,
            "skipped": 2,
            "failed": 0,
            "parity": {"expected": 3, "actual": 3},
        },
    )
    monkeypatch.setattr(
        store,
        "rollback_annotations_read_path",
        lambda: {"rollback_count": 1, "annotations_v2_enabled": False},
    )

    migration = client.post(
        "/ops/migrations/annotations-v2",
        json={"dry_run": True},
        headers={"x-ops-token": "secret-token"},
    )
    assert migration.status_code == 200
    assert migration.json()["dry_run"] is True
    assert migration.json()["migrated"] == 1
    assert migration.json()["parity"] == {"expected": 3, "actual": 3}

    rollback = client.post(
        "/ops/migrations/annotations-v2/rollback",
        headers={"x-ops-token": "secret-token"},
    )
    assert rollback.status_code == 200
    assert rollback.json() == {"rollback_count": 1, "annotations_v2_enabled": False}
