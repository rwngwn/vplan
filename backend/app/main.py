from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .hn_digest_import import load_digests_from_dir
from .markdown_workspace import parse_inline_annotations, render_task_markdown
from .models import CreateKnowledgeFolderRequest, CreateKnowledgeNoteRequest, CreateTaskRequest, TransitionRequest, UpdateKnowledgeFolderRequest, UpdateKnowledgeNoteRequest, UpdateTaskRequest
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


app = FastAPI(title="Backend API", version="0.6.0")
store = TaskStore()
telegram_ingest = TelegramIngestService(store)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


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
    ann_json = [{"instruction": ann.instruction, "line_no": ann.line_no} for ann in annotations]
    try:
        revision = store.set_workspace_markdown(task_id, payload.markdown, ann_json)
    except KeyError:
        raise HTTPException(status_code=404, detail="task not found")

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
