from __future__ import annotations

from datetime import datetime, timezone
from difflib import unified_diff
from uuid import uuid4

from .auto_analysis import AutoAnalysisPipeline
from .models import CreateKnowledgeNoteRequest, CreateTaskRequest, KnowledgeNote, Task, TaskEvent, TaskStatus, UpdateKnowledgeNoteRequest, UpdateTaskRequest

_ALLOWED_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.open: {TaskStatus.in_progress, TaskStatus.blocked, TaskStatus.cancelled},
    TaskStatus.in_progress: {TaskStatus.review, TaskStatus.blocked, TaskStatus.cancelled, TaskStatus.open},
    TaskStatus.review: {TaskStatus.done, TaskStatus.in_progress, TaskStatus.blocked, TaskStatus.cancelled},
    TaskStatus.done: set(),
    TaskStatus.blocked: {TaskStatus.in_progress, TaskStatus.cancelled},
    TaskStatus.cancelled: set(),
}


class TaskStore:
    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}
        self._workspace_docs: dict[str, str] = {}
        self._workspace_revisions: dict[str, list[dict]] = {}
        self._reviews: dict[str, list[dict]] = {}
        self._notes: dict[str, KnowledgeNote] = {}
        self._telemetry: dict[str, int] = {
            "status_transition_invalid_attempts": 0,
            "telegram_to_task_success": 0,
            "wiki_review_actions": 0,
            "task_dashboard_views": 0,
        }
        self._auto_analysis = AutoAnalysisPipeline(self._telemetry)
        self._analyses: dict[str, list[dict]] = {}

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

    def list_notes(self) -> list[KnowledgeNote]:
        return list(self._notes.values())

    def create_note(self, payload: CreateKnowledgeNoteRequest) -> KnowledgeNote:
        note = KnowledgeNote(id=str(uuid4()), title=payload.title, body=payload.body)
        self._notes[note.id] = note
        return note

    def update_note(self, note_id: str, payload: UpdateKnowledgeNoteRequest) -> KnowledgeNote:
        note = self._notes.get(note_id)
        if note is None:
            raise KeyError(note_id)
        if payload.title is not None:
            note.title = payload.title
        if payload.body is not None:
            note.body = payload.body
        note.updated_at = datetime.now(timezone.utc).isoformat()
        return note

    def telemetry_snapshot(self) -> dict[str, int]:
        return dict(self._telemetry)

    def mark_task_dashboard_view(self) -> None:
        self._telemetry["task_dashboard_views"] += 1
