from __future__ import annotations

from datetime import datetime, timezone
from difflib import unified_diff
import os
from pathlib import Path
import re
import sqlite3
from typing import TypedDict
from uuid import uuid4

from .auto_analysis import AutoAnalysisPipeline
from .markdown_workspace import parse_inline_annotations
from .models import AnnotationPayload, CreateDocumentAnnotationRequest, CreateDocumentRequest, CreateKnowledgeFolderRequest, CreateKnowledgeNoteRequest, CreateTaskRequest, Document, DocumentAnnotation, FeatureFlags, KnowledgeFolder, KnowledgeNote, StoredAnnotation, Task, TaskEvent, TaskStatus, UpdateDocumentAnnotationRequest, UpdateDocumentRequest, UpdateKnowledgeFolderRequest, UpdateKnowledgeNoteRequest, UpdateTaskRequest

_ALLOWED_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.open: {TaskStatus.in_progress, TaskStatus.blocked, TaskStatus.cancelled},
    TaskStatus.in_progress: {TaskStatus.review, TaskStatus.blocked, TaskStatus.cancelled, TaskStatus.open},
    TaskStatus.review: {TaskStatus.done, TaskStatus.in_progress, TaskStatus.blocked, TaskStatus.cancelled},
    TaskStatus.done: set(),
    TaskStatus.blocked: {TaskStatus.in_progress, TaskStatus.cancelled},
    TaskStatus.cancelled: set(),
}


class FeatureFlagUpdates(TypedDict, total=False):
    ai_confirm_required: bool
    selection_scope_v2_enabled: bool


class TaskStore:
    def __init__(self, knowledge_db_path: str | None = None) -> None:
        self._tasks: dict[str, Task] = {}
        self._workspace_docs: dict[str, str] = {}
        self._workspace_revisions: dict[str, list[dict]] = {}
        self._reviews: dict[str, list[dict]] = {}
        self._notes: dict[str, KnowledgeNote] = {}
        self._folders: dict[str, KnowledgeFolder] = {}
        self._telemetry: dict[str, int] = {
            "status_transition_invalid_attempts": 0,
            "telegram_to_task_success": 0,
            "wiki_review_actions": 0,
            "task_dashboard_views": 0,
            "annotations_dual_write_success": 0,
            "annotations_dual_write_failure": 0,
            "ai_preview_requests": 0,
            "ai_confirm_requests": 0,
            "ai_undo_requests": 0,
            "ai_failures": 0,
            "annotations_rollback_count": 0,
        }
        self._auto_analysis = AutoAnalysisPipeline(self._telemetry)
        self._analyses: dict[str, list[dict]] = {}
        self._feature_flags = FeatureFlags()
        self._workspace_annotations: dict[str, dict[str, list[dict]]] = {}
        self._documents: dict[str, Document] = {}
        self._document_annotations: dict[str, dict[str, DocumentAnnotation]] = {}
        self._mutation_hits: dict[str, list[float]] = {}
        self._mutation_limit = 60
        self._mutation_window_seconds = 60
        self._ai_previews: dict[str, dict[str, dict]] = {}
        self._ai_operations: dict[str, list[dict]] = {}
        self._ai_audit_log: dict[str, list[dict]] = {}

        db_from_env = os.getenv("KNOWLEDGE_DB_PATH", "/tmp/knowledge.db")
        self._knowledge_db_path = knowledge_db_path or db_from_env
        self._init_knowledge_db()
        self._load_knowledge_from_db()

    def list_tasks(self) -> list[Task]:
        return list(self._tasks.values())

    def create_task(self, payload: CreateTaskRequest) -> Task:
        task = Task(id=str(uuid4()), **payload.model_dump())
        task.events.append(TaskEvent(type="created", message="task created"))
        self._tasks[task.id] = task
        self._workspace_revisions[task.id] = []
        self._reviews[task.id] = []
        self._analyses[task.id] = []
        self._workspace_annotations[task.id] = {}
        return task

    def get_feature_flags(self) -> dict:
        return self._feature_flags.model_dump()

    def allow_mutation(self, actor: str) -> bool:
        now = datetime.now(timezone.utc).timestamp()
        window_start = now - self._mutation_window_seconds
        hits = [stamp for stamp in self._mutation_hits.get(actor, []) if stamp >= window_start]
        if len(hits) >= self._mutation_limit:
            self._mutation_hits[actor] = hits
            return False
        hits.append(now)
        self._mutation_hits[actor] = hits
        return True

    def list_documents(self) -> list[Document]:
        return list(self._documents.values())

    def create_document(self, payload: CreateDocumentRequest) -> Document:
        now = datetime.now(timezone.utc).isoformat()
        document = Document(id=str(uuid4()), **payload.model_dump(), created_at=now, updated_at=now)
        self._documents[document.id] = document
        self._document_annotations[document.id] = {}
        return document

    def get_document(self, document_id: str) -> Document:
        document = self._documents.get(document_id)
        if document is None:
            raise KeyError(document_id)
        return document

    def update_document(self, document_id: str, payload: UpdateDocumentRequest) -> Document:
        document = self.get_document(document_id)
        if document.version != payload.version:
            raise ValueError("version conflict")
        updates = payload.model_dump(exclude={"version"}, exclude_none=True)
        for field, value in updates.items():
            setattr(document, field, value)
        document.version += 1
        document.updated_at = datetime.now(timezone.utc).isoformat()
        return document

    def delete_document(self, document_id: str) -> None:
        if document_id not in self._documents:
            raise KeyError(document_id)
        self._documents.pop(document_id)
        self._document_annotations.pop(document_id, None)

    def list_document_annotations(self, document_id: str) -> list[DocumentAnnotation]:
        self.get_document(document_id)
        return [self._annotation_export_shape(item) for item in self._document_annotations.get(document_id, {}).values()]

    def create_document_annotation(self, document_id: str, payload: CreateDocumentAnnotationRequest) -> DocumentAnnotation:
        self.get_document(document_id)
        now = datetime.now(timezone.utc).isoformat()
        annotation = self._annotation_export_shape(DocumentAnnotation(
            id=str(uuid4()),
            document_id=document_id,
            **payload.model_dump(),
            created_at=now,
            updated_at=now,
        ))
        self._document_annotations.setdefault(document_id, {})[annotation.id] = annotation
        return annotation

    def update_document_annotation(self, document_id: str, annotation_id: str, payload: UpdateDocumentAnnotationRequest) -> DocumentAnnotation:
        self.get_document(document_id)
        annotation = self._document_annotations.get(document_id, {}).get(annotation_id)
        if annotation is None:
            raise KeyError(annotation_id)
        if annotation.version != payload.version:
            raise ValueError("version conflict")
        updates = payload.model_dump(exclude={"version"}, exclude_none=True)
        for field, value in updates.items():
            setattr(annotation, field, value)
        annotation.version += 1
        annotation.updated_at = datetime.now(timezone.utc).isoformat()
        annotation = self._annotation_export_shape(annotation)
        self._document_annotations.setdefault(document_id, {})[annotation.id] = annotation
        return annotation

    @staticmethod
    def _annotation_export_shape(annotation: DocumentAnnotation) -> DocumentAnnotation:
        feedback = annotation.feedback or annotation.instruction
        line = annotation.line or annotation.line_no
        return annotation.model_copy(update={"feedback": feedback, "line": line, "instruction": feedback, "line_no": line})

    def delete_document_annotation(self, document_id: str, annotation_id: str) -> None:
        self.get_document(document_id)
        annotation_map = self._document_annotations.get(document_id, {})
        if annotation_id not in annotation_map:
            raise KeyError(annotation_id)
        annotation_map.pop(annotation_id)

    def set_feature_flags(self, updates: "FeatureFlagUpdates") -> dict:
        self._feature_flags = self._feature_flags.model_copy(update=updates)
        return self.get_feature_flags()

    def update_task(self, task_id: str, payload: UpdateTaskRequest) -> Task:
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)
        for field, value in payload.model_dump(exclude_none=True).items():
            setattr(task, field, value)
        task.updated_at = datetime.now(timezone.utc).isoformat()
        task.events.append(TaskEvent(type="task_updated", message="task metadata updated"))
        return task

    def get_task(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    def transition(self, task_id: str, to_status: TaskStatus, note: str | None = None) -> Task:
        task = self._tasks.get(task_id)
        if task is None:
            raise KeyError(task_id)

        if to_status not in _ALLOWED_TRANSITIONS[task.status]:
            self._telemetry["status_transition_invalid_attempts"] += 1
            raise ValueError(f"invalid transition: {task.status} -> {to_status}")

        if to_status == TaskStatus.done:
            approved_review = any(r.get("decision") == "approve" for r in self._reviews.get(task_id, []))
            if not task.result_summary.strip() or not approved_review:
                raise ValueError("done requires result_summary and at least one approve review")

        previous = task.status
        task.status = to_status
        task.updated_at = datetime.now(timezone.utc).isoformat()
        task.events.append(TaskEvent(type="status_transition", message=f"{previous.value} -> {to_status.value}" + (f" ({note})" if note else "")))
        return task

    def set_workspace_markdown(self, task_id: str, markdown: str, annotations: list[dict] | None = None) -> dict:
        if task_id not in self._tasks:
            raise KeyError(task_id)

        sanitized_annotations = []
        for item in annotations or []:
            sanitized_annotations.append(AnnotationPayload.model_validate(item).model_dump(mode="json"))

        self._workspace_docs[task_id] = markdown

        revision_id = str(uuid4())[:8]
        rev = {
            "revision_id": revision_id,
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "markdown": markdown,
            "annotations": [],
            "review_decision": "pending",
            "review_summary": "",
            "inline_feedback": [],
        }
        self._write_annotations(task_id, revision_id, sanitized_annotations)
        self._workspace_revisions[task_id].append(rev)
        self._auto_analysis.enqueue(task_id, "note_saved", markdown, idempotency_key=f"{task_id}:{rev['revision_id']}:note_saved")
        self._analyses[task_id].extend(self._auto_analysis.run_ready())
        return rev

    def list_revision_annotations(self, task_id: str, revision_id: str) -> list[dict]:
        if task_id not in self._tasks:
            raise KeyError(task_id)
        cached = self._workspace_annotations.get(task_id, {}).get(revision_id)
        if cached is not None:
            return cached

        persisted = self._load_revision_annotations_v2(task_id, revision_id)
        if persisted:
            self._workspace_annotations.setdefault(task_id, {})[revision_id] = persisted
        return persisted

    def get_workspace_markdown(self, task_id: str) -> str | None:
        return self._workspace_docs.get(task_id)

    def list_revisions(self, task_id: str) -> list[dict]:
        if task_id not in self._tasks:
            raise KeyError(task_id)
        return self._workspace_revisions.get(task_id, [])

    def get_revision(self, task_id: str, revision_id: str) -> dict:
        if task_id not in self._tasks:
            raise KeyError(task_id)
        for rev in self._workspace_revisions.get(task_id, []):
            if rev["revision_id"] == revision_id:
                return rev
        raise KeyError(revision_id)

    def diff_revision_against_previous(self, task_id: str, revision_id: str) -> str:
        revisions = self.list_revisions(task_id)
        idx = next((i for i, r in enumerate(revisions) if r["revision_id"] == revision_id), -1)
        if idx < 0:
            raise KeyError(revision_id)
        current = revisions[idx]["markdown"].splitlines(keepends=True)
        previous = revisions[idx - 1]["markdown"].splitlines(keepends=True) if idx > 0 else []
        diff = unified_diff(previous, current, fromfile="previous.md", tofile=f"revision-{revision_id}.md")
        return "".join(diff)

    def save_review(self, task_id: str, revision_id: str, decision: str, summary: str, inline_feedback: list[dict]) -> dict:
        if decision not in {"approve", "request_changes"}:
            raise ValueError("decision must be approve|request_changes")
        rev = self.get_revision(task_id, revision_id)
        review = {
            "review_id": str(uuid4())[:8],
            "revision_id": revision_id,
            "decision": decision,
            "summary": summary,
            "inline_feedback": inline_feedback,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        rev["review_decision"] = decision
        rev["review_summary"] = summary
        rev["inline_feedback"] = inline_feedback
        self._reviews[task_id].append(review)
        self._telemetry["wiki_review_actions"] += 1

        content = rev.get("markdown", "") + "\n" + summary
        self._auto_analysis.enqueue(task_id, "review_submitted", content, idempotency_key=f"{task_id}:{revision_id}:review_submitted")
        self._analyses[task_id].extend(self._auto_analysis.run_ready())
        return review

    def list_analyses(self, task_id: str) -> list[dict]:
        if task_id not in self._tasks:
            raise KeyError(task_id)
        self._analyses[task_id].extend(self._auto_analysis.run_ready())
        return self._analyses.get(task_id, [])

    def build_feedback_packet(self, task_id: str) -> dict:
        if task_id not in self._tasks:
            raise KeyError(task_id)
        revisions = self._workspace_revisions.get(task_id, [])
        latest = revisions[-1] if revisions else None
        reviews = self._reviews.get(task_id, [])
        latest_review = reviews[-1] if reviews else None

        if not latest:
            return {"task_id": task_id, "feedback_prompt": "No workspace revision yet.", "latest_revision_id": None}

        lines = [
            "You are revising a plan based on structured reviewer feedback.",
            f"Task ID: {task_id}",
            f"Revision: {latest['revision_id']}",
            "",
            "Reviewer decision:",
            f"- {latest_review['decision'] if latest_review else 'pending'}",
            "",
            "Summary:",
            latest_review["summary"] if latest_review else "(none)",
            "",
            "Inline feedback:",
        ]
        for fb in (latest_review["inline_feedback"] if latest_review else []):
            lines.append(f"- line {fb.get('line_no', '?')}: {fb.get('comment', '')}")
        lines.extend(["", "Detected agent instructions:"])
        for ann in latest.get("annotations", []):
            lines.append(f"- line {ann.get('line_no')}: {ann.get('instruction')}")

        return {"task_id": task_id, "latest_revision_id": latest["revision_id"], "feedback_prompt": "\n".join(lines)}

    def _db_conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self._knowledge_db_path)

    def _init_knowledge_db(self) -> None:
        db_path = Path(self._knowledge_db_path)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._db_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS knowledge_folders (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    parent_id TEXT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS knowledge_notes (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    folder_id TEXT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS workspace_annotations (
                    task_id TEXT NOT NULL,
                    revision_id TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    instruction TEXT NOT NULL,
                    line_no INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (task_id, revision_id, scope, instruction, line_no)
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS ai_audit_records (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    actor TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )

    def _load_knowledge_from_db(self) -> None:
        with self._db_conn() as conn:
            folder_rows = conn.execute(
                "SELECT id, name, slug, parent_id, created_at, updated_at FROM knowledge_folders"
            ).fetchall()
            note_rows = conn.execute(
                "SELECT id, title, body, folder_id, created_at, updated_at FROM knowledge_notes"
            ).fetchall()
            annotation_rows = conn.execute(
                "SELECT task_id, revision_id, scope, instruction, line_no, created_at, updated_at FROM workspace_annotations"
            ).fetchall()
            ai_audit_rows = conn.execute(
                "SELECT id, document_id, action, operation_id, status, detail, actor, created_at FROM ai_audit_records ORDER BY created_at ASC"
            ).fetchall()

        for row in folder_rows:
            folder = KnowledgeFolder(
                id=row[0],
                name=row[1],
                slug=row[2],
                parent_id=row[3],
                created_at=row[4],
                updated_at=row[5],
            )
            self._folders[folder.id] = folder

        for row in note_rows:
            note = KnowledgeNote(
                id=row[0],
                title=row[1],
                body=row[2],
                folder_id=row[3],
                created_at=row[4],
                updated_at=row[5],
            )
            self._notes[note.id] = note

        for row in annotation_rows:
            annotation = StoredAnnotation(
                task_id=row[0],
                revision_id=row[1],
                scope=row[2],
                instruction=row[3],
                line_no=row[4],
                created_at=row[5],
                updated_at=row[6],
            )
            self._workspace_annotations.setdefault(annotation.task_id, {}).setdefault(annotation.revision_id, []).append(
                annotation.model_dump(include={"scope", "feedback", "line", "instruction", "line_no"}, mode="json")
            )

        for row in ai_audit_rows:
            self._ai_audit_log.setdefault(row[1], []).append(
                {
                    "id": row[0],
                    "action": row[2],
                    "operation_id": row[3],
                    "status": row[4],
                    "detail": row[5],
                    "actor": row[6],
                    "created_at": row[7],
                }
            )

    def preview_ai_operation(self, document_id: str, prompt: str, operation_id: str, base_version: int, actor: str) -> dict:
        document = self.get_document(document_id)
        self._telemetry["ai_preview_requests"] += 1
        if document.version != base_version:
            self._telemetry["ai_failures"] += 1
            self._record_ai_audit(document_id, "preview", operation_id, "failed", "stale_preview", actor)
            raise ValueError("stale_preview")

        proposed_content = f"{document.content}\n\n[AI] {prompt.strip()}"
        preview = {
            "operation_id": operation_id,
            "base_version": base_version,
            "proposed_content": proposed_content,
        }
        self._ai_previews.setdefault(document_id, {})[operation_id] = preview
        self._record_ai_audit(document_id, "preview", operation_id, "ok", "prompt_redacted", actor)
        return {**preview, "persisted": False}

    def confirm_ai_operation(self, document_id: str, operation_id: str, base_version: int, actor: str) -> dict:
        document = self.get_document(document_id)
        self._telemetry["ai_confirm_requests"] += 1
        operations = self._ai_operations.setdefault(document_id, [])
        existing = next((item for item in operations if item["operation_id"] == operation_id), None)
        if existing is not None:
            self._record_ai_audit(document_id, "confirm", operation_id, "ok", "idempotent", actor)
            return {
                "operation_id": operation_id,
                "applied": True,
                "idempotent": True,
                "version": existing["applied_version"],
            }

        preview = self._ai_previews.get(document_id, {}).get(operation_id)
        if preview is None:
            self._telemetry["ai_failures"] += 1
            self._record_ai_audit(document_id, "confirm", operation_id, "failed", "preview_not_found", actor)
            raise ValueError("preview_not_found")
        if preview["base_version"] != base_version or document.version != base_version:
            self._telemetry["ai_failures"] += 1
            self._record_ai_audit(document_id, "confirm", operation_id, "failed", "stale_preview", actor)
            raise ValueError("stale_preview")

        old_content = document.content
        document.content = preview["proposed_content"]
        document.version += 1
        document.updated_at = datetime.now(timezone.utc).isoformat()
        operation = {
            "operation_id": operation_id,
            "previous_content": old_content,
            "applied_content": document.content,
            "applied_version": document.version,
            "undone": False,
        }
        operations.append(operation)
        self._record_ai_audit(document_id, "confirm", operation_id, "ok", "applied", actor)
        return {"operation_id": operation_id, "applied": True, "idempotent": False, "version": document.version}

    def undo_last_ai_operation(self, document_id: str, actor: str) -> dict:
        document = self.get_document(document_id)
        self._telemetry["ai_undo_requests"] += 1
        operations = self._ai_operations.get(document_id, [])
        last_confirmed = next((item for item in reversed(operations) if not item["undone"]), None)
        if last_confirmed is None:
            self._telemetry["ai_failures"] += 1
            self._record_ai_audit(document_id, "undo", "none", "failed", "undo_unavailable", actor)
            raise ValueError("undo_unavailable")

        document.content = last_confirmed["previous_content"]
        document.version += 1
        document.updated_at = datetime.now(timezone.utc).isoformat()
        last_confirmed["undone"] = True
        self._record_ai_audit(document_id, "undo", last_confirmed["operation_id"], "ok", "undone", actor)
        return {"operation_id": last_confirmed["operation_id"], "undone": True, "version": document.version}

    def list_ai_audit(self, document_id: str) -> list[dict]:
        self.get_document(document_id)
        return list(self._ai_audit_log.get(document_id, []))

    def _record_ai_audit(self, document_id: str, action: str, operation_id: str, status: str, detail: str, actor: str) -> None:
        record = {
            "id": str(uuid4()),
            "action": action,
            "operation_id": operation_id,
            "status": status,
            "detail": detail,
            "actor": actor,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._ai_audit_log.setdefault(document_id, []).append(record)
        with self._db_conn() as conn:
            conn.execute(
                """
                INSERT INTO ai_audit_records (id, document_id, action, operation_id, status, detail, actor, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    document_id,
                    action,
                    operation_id,
                    status,
                    detail,
                    actor,
                    record["created_at"],
                ),
            )

    @staticmethod
    def _validate_annotation_store_identifiers(task_id: str, revision_id: str) -> None:
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,64}", task_id):
            raise ValueError("invalid annotation payload")
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,64}", revision_id):
            raise ValueError("invalid annotation payload")

    def _persist_revision_annotations_v2(self, task_id: str, revision_id: str, annotations: list[dict]) -> None:
        now = datetime.now(timezone.utc).isoformat()
        rows = [
            StoredAnnotation(
                task_id=task_id,
                revision_id=revision_id,
                scope=annotation["scope"],
                instruction=annotation["instruction"],
                line_no=annotation["line_no"],
                created_at=now,
                updated_at=now,
            )
            for annotation in annotations
        ]
        with self._db_conn() as conn:
            for row in rows:
                conn.execute(
                    """
                    INSERT INTO workspace_annotations (task_id, revision_id, scope, instruction, line_no, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(task_id, revision_id, scope, instruction, line_no) DO UPDATE SET
                        updated_at=excluded.updated_at
                    """,
                    (
                        row.task_id,
                        row.revision_id,
                        row.scope.value,
                        row.instruction,
                        row.line_no,
                        row.created_at,
                        row.updated_at,
                    ),
                )

    def _delete_revision_annotations_v2(self, task_id: str, revision_id: str) -> None:
        with self._db_conn() as conn:
            conn.execute(
                "DELETE FROM workspace_annotations WHERE task_id = ? AND revision_id = ?",
                (task_id, revision_id),
            )

    def _count_revision_annotations_v2(self, task_id: str, revision_id: str) -> int:
        with self._db_conn() as conn:
            return conn.execute(
                "SELECT COUNT(*) FROM workspace_annotations WHERE task_id = ? AND revision_id = ?",
                (task_id, revision_id),
            ).fetchone()[0]

    def _load_revision_annotations_v2(self, task_id: str, revision_id: str) -> list[dict]:
        with self._db_conn() as conn:
            rows = conn.execute(
                """
                SELECT scope, instruction, line_no
                FROM workspace_annotations
                WHERE task_id = ? AND revision_id = ?
                ORDER BY line_no ASC, scope ASC, instruction ASC
                """,
                (task_id, revision_id),
            ).fetchall()
        return [
            StoredAnnotation(
                task_id=task_id,
                revision_id=revision_id,
                scope=row[0],
                instruction=row[1],
                line_no=row[2],
            ).model_dump(include={"scope", "feedback", "line", "instruction", "line_no"}, mode="json")
            for row in rows
        ]

    def _write_annotations(self, task_id: str, revision_id: str, annotations: list[dict]) -> None:
        self._validate_annotation_store_identifiers(task_id, revision_id)

        try:
            self._persist_revision_annotations_v2(task_id, revision_id, annotations)
            self._workspace_annotations.setdefault(task_id, {})[revision_id] = [
                StoredAnnotation(task_id=task_id, revision_id=revision_id, **annotation)
                .model_dump(include={"scope", "feedback", "line", "instruction", "line_no"}, mode="json")
                for annotation in annotations
            ]
        except Exception as exc:  # pragma: no cover - covered by behavior tests
            try:
                self._workspace_annotations.get(task_id, {}).pop(revision_id, None)
            except Exception:
                pass
            try:
                self._delete_revision_annotations_v2(task_id, revision_id)
            except Exception:
                pass
            self._telemetry["annotations_dual_write_failure"] += 1
            raise RuntimeError("annotation write failed") from exc
        self._telemetry["annotations_dual_write_success"] += 1

    def run_annotations_v2_migration(self, dry_run: bool) -> dict:
        migrated = 0
        skipped = 0
        failed = 0
        parity_expected = 0
        parity_actual = 0

        for task_id, revisions in self._workspace_revisions.items():
            if task_id not in self._tasks:
                continue
            for revision in revisions:
                revision_id = revision.get("revision_id", "")
                markdown = revision.get("markdown", "")
                if not isinstance(revision_id, str) or not isinstance(markdown, str):
                    failed += 1
                    continue

                parsed = parse_inline_annotations(markdown)
                normalized = []
                parse_failed = False
                for item in parsed:
                    if item.line_no < 1:
                        parse_failed = True
                        break
                    instruction = item.instruction.strip()
                    if not instruction:
                        continue
                    normalized.append({"scope": "text", "instruction": instruction, "line_no": item.line_no})

                if parse_failed:
                    failed += 1
                    continue

                parity_expected += len(normalized)
                existing_count = self._count_revision_annotations_v2(task_id, revision_id)

                if dry_run:
                    parity_actual += existing_count
                    continue

                if existing_count > 0:
                    skipped += 1
                    parity_actual += existing_count
                    continue

                try:
                    self._persist_revision_annotations_v2(task_id, revision_id, normalized)
                    self._workspace_annotations.setdefault(task_id, {})[revision_id] = normalized
                    migrated += 1
                    parity_actual += self._count_revision_annotations_v2(task_id, revision_id)
                except Exception:
                    failed += 1
                    parity_actual += self._count_revision_annotations_v2(task_id, revision_id)

        return {
            "dry_run": dry_run,
            "migrated": migrated,
            "skipped": skipped,
            "failed": failed,
            "parity": {"expected": parity_expected, "actual": parity_actual},
        }

    def rollback_annotations_read_path(self) -> dict:
        for task_id, revisions in self._workspace_revisions.items():
            for revision in revisions:
                revision_id = revision.get("revision_id", "")
                if not isinstance(revision_id, str) or not revision_id:
                    continue
                cached = self._workspace_annotations.get(task_id, {}).get(revision_id)
                if cached is not None:
                    continue
                persisted = self._load_revision_annotations_v2(task_id, revision_id)
                if persisted:
                    self._workspace_annotations.setdefault(task_id, {})[revision_id] = persisted

        self.set_feature_flags({"annotations_v2_enabled": False})
        self._telemetry["annotations_rollback_count"] += 1
        return {
            "rollback_count": self._telemetry["annotations_rollback_count"],
            "annotations_v2_enabled": self._feature_flags.annotations_v2_enabled,
        }

    def _persist_folder(self, folder: KnowledgeFolder) -> None:
        with self._db_conn() as conn:
            conn.execute(
                """
                INSERT INTO knowledge_folders (id, name, slug, parent_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name,
                    slug=excluded.slug,
                    parent_id=excluded.parent_id,
                    updated_at=excluded.updated_at
                """,
                (folder.id, folder.name, folder.slug, folder.parent_id, folder.created_at, folder.updated_at),
            )

    def _persist_note(self, note: KnowledgeNote) -> None:
        with self._db_conn() as conn:
            conn.execute(
                """
                INSERT INTO knowledge_notes (id, title, body, folder_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    body=excluded.body,
                    folder_id=excluded.folder_id,
                    updated_at=excluded.updated_at
                """,
                (note.id, note.title, note.body, note.folder_id, note.created_at, note.updated_at),
            )


    @staticmethod
    def _slugify(name: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower())
        slug = re.sub(r"-+", "-", slug).strip("-")
        return slug or "folder"

    def list_folders(self) -> list[KnowledgeFolder]:
        return list(self._folders.values())

    def _ensure_folder_exists(self, folder_id: str | None) -> None:
        if folder_id is None:
            return
        if folder_id not in self._folders:
            raise KeyError(folder_id)

    def _find_folder_by_slug(self, slug: str, parent_id: str | None = None) -> KnowledgeFolder | None:
        for f in self._folders.values():
            if f.slug == slug and f.parent_id == parent_id:
                return f
        return None

    def create_folder(self, payload: CreateKnowledgeFolderRequest) -> KnowledgeFolder:
        parent_id = payload.parent_id
        self._ensure_folder_exists(parent_id)
        slug = self._slugify(payload.name)
        existing = self._find_folder_by_slug(slug, parent_id)
        if existing is not None:
            return existing
        folder = KnowledgeFolder(id=str(uuid4()), name=payload.name.strip(), slug=slug, parent_id=parent_id)
        self._folders[folder.id] = folder
        self._persist_folder(folder)
        return folder

    def update_folder(self, folder_id: str, payload: UpdateKnowledgeFolderRequest) -> KnowledgeFolder:
        folder = self._folders.get(folder_id)
        if folder is None:
            raise KeyError(folder_id)
        if payload.parent_id is not None:
            self._ensure_folder_exists(payload.parent_id)
            folder.parent_id = payload.parent_id
        if payload.name is not None:
            folder.name = payload.name.strip()
            folder.slug = self._slugify(payload.name)
        folder.updated_at = datetime.now(timezone.utc).isoformat()
        self._persist_folder(folder)
        return folder

    def _derive_folder_from_title(self, title: str) -> KnowledgeFolder | None:
        if "/" not in title:
            return None
        prefix = title.split("/", 1)[0].strip()
        if not prefix:
            return None
        return self.create_folder(CreateKnowledgeFolderRequest(name=prefix))

    def list_notes(self) -> list[KnowledgeNote]:
        notes = list(self._notes.values())
        for note in notes:
            if note.folder_id is None:
                derived = self._derive_folder_from_title(note.title)
                if derived is not None:
                    note.folder_id = derived.id
                    note.updated_at = datetime.now(timezone.utc).isoformat()
                    self._persist_note(note)
        return notes

    def create_note(self, payload: CreateKnowledgeNoteRequest) -> KnowledgeNote:
        folder_id = payload.folder_id
        if folder_id is None:
            derived = self._derive_folder_from_title(payload.title)
            folder_id = derived.id if derived else None
        self._ensure_folder_exists(folder_id)
        note = KnowledgeNote(id=str(uuid4()), title=payload.title, body=payload.body, folder_id=folder_id)
        self._notes[note.id] = note
        self._persist_note(note)
        return note

    def update_note(self, note_id: str, payload: UpdateKnowledgeNoteRequest) -> KnowledgeNote:
        note = self._notes.get(note_id)
        if note is None:
            raise KeyError(note_id)
        if payload.title is not None:
            note.title = payload.title
        if payload.body is not None:
            note.body = payload.body
        if payload.folder_id is not None:
            self._ensure_folder_exists(payload.folder_id)
            note.folder_id = payload.folder_id
        note.updated_at = datetime.now(timezone.utc).isoformat()
        self._persist_note(note)
        return note

    def telemetry_snapshot(self) -> dict[str, int]:
        return dict(self._telemetry)

    def mark_task_dashboard_view(self) -> None:
        self._telemetry["task_dashboard_views"] += 1
