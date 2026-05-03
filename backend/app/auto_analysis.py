from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from difflib import unified_diff


@dataclass
class PendingEvent:
    task_id: str
    trigger: str
    content: str
    idempotency_key: str
    queued_at: datetime


class AutoAnalysisPipeline:
    def __init__(self, telemetry: dict[str, int], now_fn=None) -> None:
        self._telemetry = telemetry
        self._pending: dict[str, PendingEvent] = {}
        self._last_run_at: dict[str, datetime] = {}
        self._last_hash: dict[str, str] = {}
        self._last_content: dict[str, str] = {}
        self._now_fn = now_fn or (lambda: datetime.now(timezone.utc))
        self.debounce_seconds = 2
        self.max_frequency_seconds = 15
        self.min_delta_chars = 20

    def enqueue(self, task_id: str, trigger: str, content: str, idempotency_key: str) -> None:
        self._telemetry["auto_analysis_events_received"] = self._telemetry.get("auto_analysis_events_received", 0) + 1
        if self._last_hash.get(task_id) == idempotency_key:
            self._telemetry["auto_analysis_idempotent_skips"] = self._telemetry.get("auto_analysis_idempotent_skips", 0) + 1
            return

        prior = self._last_content.get(task_id, "")
        if abs(len(content) - len(prior)) < self.min_delta_chars:
            self._telemetry["auto_analysis_min_delta_skips"] = self._telemetry.get("auto_analysis_min_delta_skips", 0) + 1
            return

        ev = PendingEvent(task_id=task_id, trigger=trigger, content=content, idempotency_key=idempotency_key, queued_at=self._now_fn())
        self._pending[task_id] = ev
        self._telemetry["auto_analysis_coalesced"] = self._telemetry.get("auto_analysis_coalesced", 0) + 1

    def run_ready(self) -> list[dict]:
        out: list[dict] = []
        now = self._now_fn()
        for task_id, ev in list(self._pending.items()):
            if now - ev.queued_at < timedelta(seconds=self.debounce_seconds):
                continue
            last = self._last_run_at.get(task_id)
            if last and now - last < timedelta(seconds=self.max_frequency_seconds):
                self._telemetry["auto_analysis_frequency_skips"] = self._telemetry.get("auto_analysis_frequency_skips", 0) + 1
                continue

            prev = self._last_content.get(task_id, "")
            diff = "".join(unified_diff(prev.splitlines(keepends=True), ev.content.splitlines(keepends=True), fromfile="previous", tofile="latest"))
            analysis = {
                "task_id": task_id,
                "trigger": ev.trigger,
                "idempotency_key": ev.idempotency_key,
                "incremental_diff": diff,
                "summary": f"Auto-analysis {ev.trigger}: {len(diff)} diff chars",
                "estimated_tokens": max(1, len(diff) // 4),
            }
            self._last_run_at[task_id] = now
            self._last_hash[task_id] = ev.idempotency_key
            self._last_content[task_id] = ev.content
            del self._pending[task_id]
            self._telemetry["auto_analysis_runs"] = self._telemetry.get("auto_analysis_runs", 0) + 1
            self._telemetry["auto_analysis_estimated_tokens"] = self._telemetry.get("auto_analysis_estimated_tokens", 0) + analysis["estimated_tokens"]
            out.append(analysis)

        return out
