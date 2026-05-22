from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class KnowledgeFolder(BaseModel):
    id: str
    name: str
    slug: str
    parent_id: str | None = None
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)


class CreateKnowledgeFolderRequest(BaseModel):
    name: str
    parent_id: str | None = None


class UpdateKnowledgeFolderRequest(BaseModel):
    name: str | None = None
    parent_id: str | None = None


class KnowledgeNote(BaseModel):
    id: str
    title: str
    body: str
    folder_id: str | None = None
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)


class CreateKnowledgeNoteRequest(BaseModel):
    title: str
    body: str = ""
    folder_id: str | None = None


class UpdateKnowledgeNoteRequest(BaseModel):
    title: str | None = None
    body: str | None = None
    folder_id: str | None = None


class AnnotationScope(str, Enum):
    text = "text"
    block = "block"
    multi_block = "multi_block"


class AnnotationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: AnnotationScope
    feedback: str = Field(min_length=1, max_length=1000)
    line: int = Field(ge=1, le=1000000)
    instruction: str = Field(min_length=1, max_length=1000)
    line_no: int = Field(ge=1, le=1000000)

    @model_validator(mode="before")
    @classmethod
    def _normalize_feedback_contract(cls, values: object) -> object:
        if not isinstance(values, dict):
            return values
        payload = dict(values)
        feedback = payload.get("feedback")
        instruction = payload.get("instruction")
        line = payload.get("line")
        line_no = payload.get("line_no")

        canonical_feedback = feedback if feedback is not None else instruction
        canonical_line = line if line is not None else line_no
        if canonical_feedback is None or canonical_line is None:
            return values

        payload["feedback"] = canonical_feedback
        payload["line"] = canonical_line
        payload["instruction"] = canonical_feedback
        payload["line_no"] = canonical_line
        return payload


class StoredAnnotation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(min_length=1, max_length=64)
    revision_id: str = Field(min_length=1, max_length=64)
    scope: AnnotationScope
    feedback: str = Field(min_length=1, max_length=1000)
    line: int = Field(ge=1, le=1000000)
    instruction: str = Field(min_length=1, max_length=1000)
    line_no: int = Field(ge=1, le=1000000)
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)

    @model_validator(mode="before")
    @classmethod
    def _normalize_feedback_contract(cls, values: object) -> object:
        if not isinstance(values, dict):
            return values
        payload = dict(values)
        feedback = payload.get("feedback")
        instruction = payload.get("instruction")
        line = payload.get("line")
        line_no = payload.get("line_no")

        canonical_feedback = feedback if feedback is not None else instruction
        canonical_line = line if line is not None else line_no
        if canonical_feedback is None or canonical_line is None:
            return values

        payload["feedback"] = canonical_feedback
        payload["line"] = canonical_line
        payload["instruction"] = canonical_feedback
        payload["line_no"] = canonical_line
        return payload


class FeatureFlags(BaseModel):
    annotations_v2_enabled: bool = False
    dual_write_enabled: bool = False
    ai_confirm_required: bool = True
    selection_scope_v2_enabled: bool = False


class Document(BaseModel):
    id: str
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=100000)
    owner: str = Field(default="", max_length=128)
    version: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)


class CreateDocumentRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=100000)
    owner: str = Field(default="", max_length=128)


class UpdateDocumentRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content: str | None = Field(default=None, max_length=100000)
    version: int = Field(ge=1)


class DocumentAnnotation(BaseModel):
    id: str
    document_id: str
    scope: AnnotationScope
    feedback: str = Field(min_length=1, max_length=1000)
    line: int = Field(ge=1, le=1000000)
    instruction: str = Field(min_length=1, max_length=1000)
    line_no: int = Field(ge=1, le=1000000)
    version: int = Field(default=1, ge=1)
    created_at: str = Field(default_factory=utcnow_iso)
    updated_at: str = Field(default_factory=utcnow_iso)

    @model_validator(mode="before")
    @classmethod
    def _normalize_feedback_contract(cls, values: object) -> object:
        if not isinstance(values, dict):
            return values
        payload = dict(values)
        feedback = payload.get("feedback")
        instruction = payload.get("instruction")
        line = payload.get("line")
        line_no = payload.get("line_no")

        canonical_feedback = feedback if feedback is not None else instruction
        canonical_line = line if line is not None else line_no
        if canonical_feedback is None or canonical_line is None:
            return values

        payload["feedback"] = canonical_feedback
        payload["line"] = canonical_line
        payload["instruction"] = canonical_feedback
        payload["line_no"] = canonical_line
        return payload


class CreateDocumentAnnotationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: AnnotationScope
    feedback: str = Field(min_length=1, max_length=1000)
    line: int = Field(ge=1, le=1000000)
    instruction: str = Field(min_length=1, max_length=1000)
    line_no: int = Field(ge=1, le=1000000)

    @model_validator(mode="before")
    @classmethod
    def _normalize_feedback_contract(cls, values: object) -> object:
        if not isinstance(values, dict):
            return values
        payload = dict(values)
        feedback = payload.get("feedback")
        instruction = payload.get("instruction")
        line = payload.get("line")
        line_no = payload.get("line_no")

        canonical_feedback = feedback if feedback is not None else instruction
        canonical_line = line if line is not None else line_no
        if canonical_feedback is None or canonical_line is None:
            return values

        payload["feedback"] = canonical_feedback
        payload["line"] = canonical_line
        payload["instruction"] = canonical_feedback
        payload["line_no"] = canonical_line
        return payload


class UpdateDocumentAnnotationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: AnnotationScope | None = None
    feedback: str | None = Field(default=None, min_length=1, max_length=1000)
    line: int | None = Field(default=None, ge=1, le=1000000)
    instruction: str | None = Field(default=None, min_length=1, max_length=1000)
    line_no: int | None = Field(default=None, ge=1, le=1000000)
    version: int = Field(ge=1)

    @model_validator(mode="before")
    @classmethod
    def _normalize_feedback_contract(cls, values: object) -> object:
        if not isinstance(values, dict):
            return values
        payload = dict(values)
        feedback = payload.get("feedback")
        instruction = payload.get("instruction")
        line = payload.get("line")
        line_no = payload.get("line_no")

        canonical_feedback = feedback if feedback is not None else instruction
        canonical_line = line if line is not None else line_no

        if canonical_feedback is not None:
            payload["feedback"] = canonical_feedback
            payload["instruction"] = canonical_feedback
        if canonical_line is not None:
            payload["line"] = canonical_line
            payload["line_no"] = canonical_line

        return payload


class AIPreviewRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    operation_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    base_version: int = Field(ge=1)


class AIConfirmRequest(BaseModel):
    operation_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    base_version: int = Field(ge=1)
