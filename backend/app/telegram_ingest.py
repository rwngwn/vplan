from __future__ import annotations

import os
from dataclasses import dataclass

from .models import CreateTaskRequest, TaskStatus
from .task_store import TaskStore


@dataclass
class TelegramResult:
    ok: bool
    message: str
    deduplicated: bool = False
    task_id: str | None = None
    wiki_link: str | None = None
    task_link: str | None = None


_ALIAS_TO_TITLE = {
    "zkm": "Dozkoumat",
    "ovr": "Ověřit",
    "cmp": "Porovnat",
    "dec": "Rozhodnutí",
    "todo": "Úkol",
}


class TelegramIngestService:
    def __init__(self, store: TaskStore) -> None:
        self._store = store
        self._seen_update_ids: set[int] = set()
        self._base_url = os.getenv("APP_BASE_URL", "http://localhost:3000").rstrip("/")

    def _extract_reply_context(self, message: dict) -> tuple[str, str, list[str]]:
        chat_id = str((message.get("chat") or {}).get("id", ""))
        message_id = str(message.get("message_id", ""))
        timestamp = str(message.get("date", ""))
        reply = message.get("reply_to_message") or {}
        reply_to_id = str(reply.get("message_id", ""))
        reply_text = (reply.get("text") or "").strip()
        source_ref = f"tg:{chat_id}:{message_id}" if chat_id and message_id else ""
        links = [
            f"telegram://chat/{chat_id}" if chat_id else "",
            f"telegram://message/{chat_id}/{message_id}" if chat_id and message_id else "",
            f"reply_to:{reply_to_id}" if reply_to_id else "",
            f"timestamp:{timestamp}" if timestamp else "",
            f"reply_text:{reply_text}" if reply_text else "",
        ]
        return source_ref, reply_text, [l for l in links if l]

    def handle_update(self, update: dict) -> TelegramResult:
        update_id = update.get("update_id")
        if isinstance(update_id, int):
            if update_id in self._seen_update_ids:
                return TelegramResult(ok=True, message="duplicate update ignored", deduplicated=True)
            self._seen_update_ids.add(update_id)

        message = update.get("message") or {}
        text = (message.get("text") or "").strip()

        if not text:
            return TelegramResult(ok=True, message="no text message")

        source_ref, reply_text, links = self._extract_reply_context(message)

        if text.startswith("/task "):
            title = text[len("/task ") :].strip()
            if not title:
                return TelegramResult(ok=False, message="missing task title")
            task = self._store.create_task(CreateTaskRequest(title=title, source_type="telegram", source_ref=source_ref, instruction=reply_text, links=links))
            self._store._telemetry["telegram_to_task_success"] += 1
            wiki_ref = task.source_ref or task.id
            return TelegramResult(ok=True, message="task created", task_id=task.id, wiki_link=f"{self._base_url}/wiki/{wiki_ref}", task_link=f"{self._base_url}/tasks/{task.id}")

        for alias, prefix_title in _ALIAS_TO_TITLE.items():
            if text == alias or text.startswith(f"{alias}:"):
                suffix = text.split(":", 1)[1].strip() if ":" in text else ""
                task_title = f"{prefix_title}: {suffix}" if suffix else prefix_title
                task = self._store.create_task(CreateTaskRequest(
                    title=task_title,
                    source_type="telegram",
                    source_ref=source_ref,
                    instruction=reply_text or suffix,
                    acceptance_criteria=[f"Resolve command: {alias}"],
                    links=links,
                ))
                self._store._telemetry["telegram_to_task_success"] += 1
                wiki_ref = task.source_ref or task.id
                return TelegramResult(ok=True, message=f"task created from {alias}", task_id=task.id, wiki_link=f"{self._base_url}/wiki/{wiki_ref}", task_link=f"{self._base_url}/tasks/{task.id}")

        if text.startswith("/status "):
            parts = text.split(maxsplit=2)
            if len(parts) < 3:
                return TelegramResult(ok=False, message="usage: /status <task_id> <status>")
            task_id, status_raw = parts[1], parts[2]
            try:
                to_status = TaskStatus(status_raw)
            except ValueError:
                return TelegramResult(ok=False, message=f"unknown status: {status_raw}")

            try:
                task = self._store.transition(task_id, to_status)
            except KeyError:
                return TelegramResult(ok=False, message="task not found")
            except ValueError as exc:
                return TelegramResult(ok=False, message=str(exc))
            wiki_ref = task.source_ref or task.id
            return TelegramResult(ok=True, message="task updated", task_id=task.id, wiki_link=f"{self._base_url}/wiki/{wiki_ref}", task_link=f"{self._base_url}/tasks/{task.id}")

        return TelegramResult(ok=True, message="unsupported command")
