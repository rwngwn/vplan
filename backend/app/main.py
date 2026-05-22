import os
from typing import Any

from fastapi import FastAPI, Header, HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError

from .hn_digest_import import load_digests_from_dir
from .markdown_workspace import parse_inline_annotations, render_task_markdown
from .models import AIConfirmRequest, AIPreviewRequest, AnnotationScope, CreateDocumentAnnotationRequest, CreateDocumentRequest, CreateKnowledgeFolderRequest, CreateKnowledgeNoteRequest, CreateTaskRequest, TransitionRequest, UpdateDocumentAnnotationRequest, UpdateDocumentRequest, UpdateKnowledgeFolderRequest, UpdateKnowledgeNoteRequest, UpdateTaskRequest
from .task_store import TaskStore
from .telegram_ingest import TelegramIngestService


class TelegramWebhookRequest(BaseModel):
    update: dict[str, Any]


class WorkspacePullResponse(BaseModel):
    task_id: str
    markdown: str


class WorkspacePushRequest(BaseModel):
    markdown: str


class ReviewRequest(BaseModel):
    revision_id: str
    decision: str
    summary: str = ""
    inline_feedback: list[dict[str, Any]] = []


class ImportDigestsRequest(BaseModel):
    path: str = "/data/hn-digests"
    limit: int = 10


class RunAnnotationsMigrationRequest(BaseModel):
    dry_run: bool = True


app = FastAPI(title="Backend API", version="0.6.0")
store = TaskStore()
telegram_ingest = TelegramIngestService(store)


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


def _enforce_mutation_rate_limit(owner_header: str | None) -> JSONResponse | None:
    actor = (owner_header or "anonymous").strip() or "anonymous"
    if not store.allow_mutation(actor):
        return _error(429, "rate_limited", "too many mutation requests")
    return None


def _enforce_owner(owner_header: str | None, resource_owner: str) -> JSONResponse | None:
    if not resource_owner:
        return _error(403, "forbidden", "owner missing")
    if owner_header != resource_owner:
        return _error(403, "forbidden", "forbidden")
    return None


def _validated_owner_for_create(owner_header: str | None, payload_owner: str) -> tuple[str | None, JSONResponse | None]:
    normalized_header = (owner_header or "").strip()
    if not normalized_header:
        return None, _error(401, "unauthorized", "x-owner header required")

    normalized_payload = (payload_owner or "").strip()
    if normalized_payload and normalized_payload != normalized_header:
        return None, _error(403, "forbidden", "owner mismatch")

    return normalized_header, None


def _enforce_ops_privilege(x_ops_token: str | None) -> JSONResponse | None:
    provided = (x_ops_token or "").strip()
    required = os.getenv("OPERATIONS_TOKEN", "").strip()
    if not required or provided != required:
        return _error(403, "forbidden", "forbidden")
    return None


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(_request, _exc: RequestValidationError):
    return _error(422, "validation_error", "invalid request")


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/features/flags")
async def feature_flags():
    return store.get_feature_flags()


@app.get("/tasks")
async def list_tasks(source_ref: str | None = None, source_type: str | None = None, status: str | None = None):
    tasks = store.list_tasks()
    if source_ref:
        tasks = [t for t in tasks if t.source_ref == source_ref]
    if source_type:
        tasks = [t for t in tasks if t.source_type == source_type]
    if status:
        tasks = [t for t in tasks if t.status.value == status]
    return tasks


@app.post("/tasks")
async def create_task(payload: CreateTaskRequest):
    return store.create_task(payload)


@app.patch("/tasks/{task_id}")
async def update_task(task_id: str, payload: UpdateTaskRequest):
    try:
        return store.update_task(task_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="task not found")




@app.get("/knowledge/folders")
async def list_folders():
    return store.list_folders()


@app.post("/knowledge/folders")
async def create_folder(payload: CreateKnowledgeFolderRequest):
    try:
        return store.create_folder(payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="parent folder not found")


@app.patch("/knowledge/folders/{folder_id}")
async def update_folder(folder_id: str, payload: UpdateKnowledgeFolderRequest):
    try:
        return store.update_folder(folder_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="folder not found")

@app.get("/knowledge/notes")
async def list_notes():
    return store.list_notes()


@app.post("/knowledge/notes")
async def create_note(payload: CreateKnowledgeNoteRequest):
    return store.create_note(payload)


@app.patch("/knowledge/notes/{note_id}")
async def update_note(note_id: str, payload: UpdateKnowledgeNoteRequest):
    try:
        return store.update_note(note_id, payload)
    except KeyError:
        raise HTTPException(status_code=404, detail="note not found")


@app.post("/knowledge/import-hn-digests")
async def import_hn_digests(payload: ImportDigestsRequest):
    parsed = load_digests_from_dir(payload.path, limit=max(1, min(payload.limit, 50)))
    existing_titles = {n.title for n in store.list_notes()}
    imported = 0
    skipped = 0

    for item in parsed:
        if item.title in existing_titles:
            skipped += 1
            continue
        store.create_note(CreateKnowledgeNoteRequest(title=item.title, body=item.body))
        existing_titles.add(item.title)
        imported += 1

    return {
        "ok": True,
        "scanned": len(parsed),
        "imported": imported,
        "skipped": skipped,
    }


@app.post("/tasks/{task_id}/transition")
async def transition_task(task_id: str, payload: TransitionRequest):
    try:
        return store.transition(task_id, payload.to_status, payload.note)
    except KeyError:
        raise HTTPException(status_code=404, detail="task not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/telegram/webhook")
async def telegram_webhook(payload: TelegramWebhookRequest):
    result = telegram_ingest.handle_update(payload.update)
    return {
        "ok": result.ok,
        "message": result.message,
        "deduplicated": result.deduplicated,
        "task_id": result.task_id,
        "wiki_link": result.wiki_link,
        "task_link": result.task_link,
    }


@app.get("/workspace/tasks/{task_id}", response_model=WorkspacePullResponse)
async def workspace_pull(task_id: str):
    task = store.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")

    custom_md = store.get_workspace_markdown(task_id)
    markdown = custom_md if custom_md is not None else render_task_markdown(task)
    return WorkspacePullResponse(task_id=task_id, markdown=markdown)


@app.post("/workspace/tasks/{task_id}")
async def workspace_save(task_id: str, payload: WorkspacePushRequest):
    annotations = parse_inline_annotations(payload.markdown)
    ann_json = [{"scope": AnnotationScope.text.value, "instruction": ann.instruction, "line_no": ann.line_no} for ann in annotations]
    try:
        revision = store.set_workspace_markdown(task_id, payload.markdown, ann_json)
    except KeyError:
        raise HTTPException(status_code=404, detail="task not found")
    except ValidationError:
        raise HTTPException(status_code=400, detail="invalid annotation payload")

    return {"saved": True, "count": len(annotations), "revision_id": revision["revision_id"], "annotations": ann_json}


@app.get("/workspace/tasks/{task_id}/revisions")
async def workspace_revisions(task_id: str):
    try:
        revisions = store.list_revisions(task_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="task not found")

    return [
        {
            "revision_id": r["revision_id"],
            "saved_at": r["saved_at"],
            "review_decision": r["review_decision"],
            "review_summary": r["review_summary"],
            "annotations_count": len(r["annotations"]),
        }
        for r in revisions
    ]


@app.get("/workspace/tasks/{task_id}/revisions/{revision_id}/diff")
async def workspace_revision_diff(task_id: str, revision_id: str):
    try:
        diff = store.diff_revision_against_previous(task_id, revision_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="revision or task not found")
    return {"revision_id": revision_id, "diff": diff}


@app.post("/workspace/tasks/{task_id}/review")
async def workspace_review(task_id: str, payload: ReviewRequest):
    try:
        review = store.save_review(task_id, payload.revision_id, payload.decision, payload.summary, payload.inline_feedback)
    except KeyError:
        raise HTTPException(status_code=404, detail="revision or task not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return review


@app.get("/workspace/tasks/{task_id}/feedback-packet")
async def workspace_feedback_packet(task_id: str):
    try:
        return store.build_feedback_packet(task_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="task not found")


@app.get("/workspace/tasks/{task_id}/analysis")
async def workspace_analysis(task_id: str):
    try:
        return store.list_analyses(task_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="task not found")


@app.post("/workspace/annotations")
async def workspace_annotations(payload: WorkspacePushRequest):
    annotations = parse_inline_annotations(payload.markdown)
    return {"count": len(annotations), "annotations": [{"instruction": ann.instruction, "line_no": ann.line_no} for ann in annotations]}


@app.get("/telemetry")
async def telemetry():
    return store.telemetry_snapshot()


@app.post("/telemetry/task-dashboard-view")
async def task_dashboard_view():
    store.mark_task_dashboard_view()
    return {"ok": True}


@app.get("/documents")
async def list_documents():
    return store.list_documents()


@app.post("/documents", status_code=status.HTTP_201_CREATED)
async def create_document(payload: CreateDocumentRequest, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error
    owner, owner_error = _validated_owner_for_create(x_owner, payload.owner)
    if owner_error is not None:
        return owner_error
    return store.create_document(payload.model_copy(update={"owner": owner}))


@app.get("/documents/{document_id}")
async def get_document(document_id: str):
    try:
        return store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")


@app.patch("/documents/{document_id}")
async def update_document(document_id: str, payload: UpdateDocumentRequest, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error

    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    try:
        return store.update_document(document_id, payload)
    except ValueError:
        return _error(409, "conflict", "version conflict")


@app.delete("/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(document_id: str, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error
    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    store.delete_document(document_id)
    return JSONResponse(status_code=status.HTTP_204_NO_CONTENT, content=None)


@app.get("/documents/{document_id}/annotations")
async def list_document_annotations(document_id: str):
    try:
        return store.list_document_annotations(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")


@app.post("/documents/{document_id}/annotations", status_code=status.HTTP_201_CREATED)
async def create_document_annotation(document_id: str, payload: CreateDocumentAnnotationRequest, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error
    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    return store.create_document_annotation(document_id, payload)


@app.patch("/documents/{document_id}/annotations/{annotation_id}")
async def update_document_annotation(document_id: str, annotation_id: str, payload: UpdateDocumentAnnotationRequest, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error
    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    try:
        return store.update_document_annotation(document_id, annotation_id, payload)
    except KeyError:
        return _error(404, "not_found", "annotation not found")
    except ValueError:
        return _error(409, "conflict", "version conflict")


@app.delete("/documents/{document_id}/annotations/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document_annotation(document_id: str, annotation_id: str, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error
    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    try:
        store.delete_document_annotation(document_id, annotation_id)
    except KeyError:
        return _error(404, "not_found", "annotation not found")
    return JSONResponse(status_code=status.HTTP_204_NO_CONTENT, content=None)


@app.post("/documents/{document_id}/ai/preview")
async def ai_preview(document_id: str, payload: AIPreviewRequest, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error
    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    try:
        return store.preview_ai_operation(document_id, payload.prompt, payload.operation_id, payload.base_version, x_owner or "anonymous")
    except ValueError as exc:
        if str(exc) == "stale_preview":
            return _error(409, "stale_preview", "stale preview base revision")
        return _error(400, "invalid_request", "invalid request")


@app.post("/documents/{document_id}/ai/confirm")
async def ai_confirm(document_id: str, payload: AIConfirmRequest, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error
    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    try:
        return store.confirm_ai_operation(document_id, payload.operation_id, payload.base_version, x_owner or "anonymous")
    except ValueError as exc:
        if str(exc) == "stale_preview":
            return _error(409, "stale_preview", "stale preview base revision")
        if str(exc) == "preview_not_found":
            return _error(404, "preview_not_found", "preview not found")
        return _error(400, "invalid_request", "invalid request")


@app.post("/documents/{document_id}/ai/undo")
async def ai_undo(document_id: str, x_owner: str | None = Header(default=None)):
    rate_limit_error = _enforce_mutation_rate_limit(x_owner)
    if rate_limit_error is not None:
        return rate_limit_error
    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    try:
        return store.undo_last_ai_operation(document_id, x_owner or "anonymous")
    except ValueError:
        return _error(409, "undo_unavailable", "undo unavailable")


@app.get("/documents/{document_id}/ai/audit")
async def ai_audit(document_id: str, x_owner: str | None = Header(default=None)):
    try:
        existing = store.get_document(document_id)
    except KeyError:
        return _error(404, "not_found", "document not found")

    owner_error = _enforce_owner(x_owner, existing.owner)
    if owner_error is not None:
        return owner_error

    return store.list_ai_audit(document_id)


@app.post("/ops/migrations/annotations-v2")
async def run_annotations_v2_migration(payload: RunAnnotationsMigrationRequest, x_ops_token: str | None = Header(default=None)):
    privilege_error = _enforce_ops_privilege(x_ops_token)
    if privilege_error is not None:
        return privilege_error
    return store.run_annotations_v2_migration(dry_run=payload.dry_run)


@app.post("/ops/migrations/annotations-v2/rollback")
async def rollback_annotations_v2_read_path(x_ops_token: str | None = Header(default=None)):
    privilege_error = _enforce_ops_privilege(x_ops_token)
    if privilege_error is not None:
        return privilege_error
    return store.rollback_annotations_read_path()
