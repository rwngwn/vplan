from __future__ import annotations

import re
from dataclasses import dataclass

from .models import Task

AGENT_PATTERNS = [
    re.compile(r"@agent\s+(?P<instruction>[^\n]+)", re.IGNORECASE),
    re.compile(r"TODO\(agent\):\s*(?P<instruction>[^\n]+)", re.IGNORECASE),
    re.compile(r"\[\[agent:\s*(?P<instruction>[^\]]+)\]\]", re.IGNORECASE),
]


@dataclass
class InlineAnnotation:
    instruction: str
    line_no: int


def render_task_markdown(task: Task) -> str:
    events = "\n".join(f"- {e.at} :: {e.type} :: {e.message}" for e in task.events)
    return (
        f"---\n"
        f"id: {task.id}\n"
        f"title: {task.title}\n"
        f"status: {task.status.value}\n"
        f"created_at: {task.created_at}\n"
        f"updated_at: {task.updated_at}\n"
        f"---\n\n"
        f"# {task.title}\n\n"
        f"## Plan\n"
        f"- [ ] Rozepiš kroky\n"
        f"- [ ] Přidej rizika\n"
        f"- [ ] Přidej testovací strategii\n\n"
        f"## Review notes\n"
        f"- TODO(agent): doplň konkrétní acceptance kritéria\n\n"
        f"## Audit log\n"
        f"{events}\n"
    )


def parse_inline_annotations(markdown: str) -> list[InlineAnnotation]:
    out: list[InlineAnnotation] = []
    for idx, line in enumerate(markdown.splitlines(), start=1):
        for pattern in AGENT_PATTERNS:
            for m in pattern.finditer(line):
                instruction = m.group("instruction").strip()
                if "| quote:" in instruction:
                    instruction = instruction.split("| quote:", 1)[0].strip()
                out.append(InlineAnnotation(instruction=instruction, line_no=idx))
    return out
