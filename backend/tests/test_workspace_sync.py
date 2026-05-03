from app.models import CreateTaskRequest
from app.markdown_workspace import parse_inline_annotations, render_task_markdown
from app.task_store import TaskStore


def test_render_task_markdown_is_deterministic_shape():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="KB sync"))

    md = render_task_markdown(task)

    assert md.startswith("---\nid: ")
    assert "title: KB sync" in md
    assert "status: open" in md
    assert "## Audit log" in md


def test_parse_inline_annotations_extracts_agent_instructions():
    md = """# Note
Text
@agent tohle dozkoumej do hloubky
Dalsi radek
- @agent priprav draft tasku
"""
    items = parse_inline_annotations(md)

    assert len(items) == 2
    assert items[0].instruction == "tohle dozkoumej do hloubky"
    assert items[1].instruction == "priprav draft tasku"


def test_parse_inline_annotations_supports_multiple_and_quote_payload():
    md = """# Note
[[agent: dozkoumej UX | quote: tahle cast je nejasna]] a [[agent: porovnej alternativy]]
"""
    items = parse_inline_annotations(md)

    assert len(items) == 2
    assert items[0].instruction == "dozkoumej UX"
    assert items[1].instruction == "porovnej alternativy"
