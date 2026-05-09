from __future__ import annotations

from datetime import datetime, timezone
from difflib import unified_diff
import os
from pathlib import Path
import re
import sqlite3
from uuid import uuid4

from .auto_analysis import AutoAnalysisPipeline
from .models import CreateKnowledgeFolderRequest, CreateKnowledgeNoteRequest, CreateTaskRequest, KnowledgeFolder, KnowledgeNote, Task, TaskEvent, TaskStatus, UpdateKnowledgeFolderRequest, UpdateKnowledgeNoteRequest, UpdateTaskRequest

_ALLOWED_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.open: {TaskStatus.in_progress, TaskStatus.blocked, TaskStatus.cancelled},
    TaskStatus.in_progress: {TaskStatus.review, TaskStatus.blocked, TaskStatus.cancelled, TaskStatus.open},
    TaskStatus.review: {TaskStatus.done, TaskStatus.in_progress, TaskStatus.blocked, TaskStatus.cancelled},
    TaskStatus.done: set(),
    TaskStatus.blocked: {TaskStatus.in_progress, TaskStatus.cancelled},
    TaskStatus.cancelled: set(),
}


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
        }
        self._auto_analysis = AutoAnalysisPipeline(self._telemetry)
        self._analyses: dict[str, list[dict]] = {}

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
        return task

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
        self._workspace_docs[task_id] = markdown

        rev = {
            "revision_id": str(uuid4())[:8],
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "markdown": markdown,
            "annotations": annotations or [],
            "review_decision": "pending",
            "review_summary": "",
            "inline_feedback": [],
        }
        self._workspace_revisions[task_id].append(rev)
        self._auto_analysis.enqueue(task_id, "note_saved", markdown, idempotency_key=f"{task_id}:{rev['revision_id']}:note_saved")
        self._analyses[task_id].extend(self._auto_analysis.run_ready())
        return rev

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

    def _load_knowledge_from_db(self) -> None:
        with self._db_conn() as conn:
            folder_rows = conn.execute(
                "SELECT id, name, slug, parent_id, created_at, updated_at FROM knowledge_folders"
            ).fetchall()
            note_rows = conn.execute(
                "SELECT id, title, body, folder_id, created_at, updated_at FROM knowledge_notes"
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
