from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from pydantic import BaseModel, Field


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class TaskStatus(str, Enum):
    open = "open"
    in_progress = "in_progress"
    review = "review"
    done = "done"
    blocked = "blocked"
    cancelled = "cancelled"


class TaskEvent(BaseModel):
    at: str = Field(default_factory=utcnow_iso)
    type: str
    message: str


class Task(BaseModel):
    id: str
    title: str
    status: TaskStatus = TaskStatus.open
    source_type: str = "manual"
    source_ref: str = ""
    instruction: str = ""
    priority: int = 2
    owner: str = ""
    acceptance_criteria: list[str] = Field(default_factory=list)
    result_summary: str = ""
    links: list[str] = Field(default_factory=list)
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)
    events: list[TaskEvent] = Field(default_factory=list)


class CreateTaskRequest(BaseModel):
    title: str
    source_type: str = "manual"
    source_ref: str = ""
    instruction: str = ""
    priority: int = 2
    owner: str = ""
    acceptance_criteria: list[str] = Field(default_factory=list)
    result_summary: str = ""
    links: list[str] = Field(default_factory=list)


class UpdateTaskRequest(BaseModel):
    title: str | None = None
    source_type: str | None = None
    source_ref: str | None = None
    instruction: str | None = None
    priority: int | None = None
    owner: str | None = None
    acceptance_criteria: list[str] | None = None
    result_summary: str | None = None
    links: list[str] | None = None


class TransitionRequest(BaseModel):
    to_status: TaskStatus
    note: str | None = None


class KnowledgeNote(BaseModel):
    id: str
    title: str
    body: str
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)


class CreateKnowledgeNoteRequest(BaseModel):
    title: str
    body: str = ""


class UpdateKnowledgeNoteRequest(BaseModel):
    title: str | None = None
    body: str | None = None
