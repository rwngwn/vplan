import pytest
from pydantic import ValidationError

from app.models import CreateDocumentRequest, CreateTaskRequest
from app.main import _enforce_mutation_rate_limit, store
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


def test_parse_inline_annotations_ignores_escaped_legacy_v2_markers():
    md = """# Note
\\[\\[agent: escaped marker | quote: escaped quote\\]\\]
literal [[agent: keep this one | quote: inline quote]]
"""

    items = parse_inline_annotations(md)

    assert len(items) == 1
    assert items[0].instruction == "keep this one"
    assert items[0].line_no == 3


def test_v2_mode_keeps_annotations_isolated_from_content_outputs_with_unicode_and_multiline():
    store = TaskStore()
    store.set_feature_flags({"annotations_v2_enabled": True})
    task = store.create_task(CreateTaskRequest(title="KB sync v2"))

    markdown = "# Poznámka\n\nline 1\nline 2 ✅"
    annotations = [{"scope": "multi_block", "instruction": "řádek\nquote ✅", "line_no": 3}]
    rev = store.set_workspace_markdown(task.id, markdown, annotations)

    assert rev["annotations"] == []
    assert store.list_revisions(task.id)[0]["annotations"] == []
    feedback = store.build_feedback_packet(task.id)
    assert "řádek" not in feedback["feedback_prompt"]
    assert "quote ✅" not in feedback["feedback_prompt"]


def test_dual_write_mode_keeps_annotations_isolated_from_content_outputs_with_unicode_and_multiline(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    store.set_feature_flags({"annotations_v2_enabled": True, "dual_write_enabled": True})
    task = store.create_task(CreateTaskRequest(title="KB sync dual-write"))

    markdown = "# Poznámka\n\nline 1\nline 2 ✅"
    annotations = [{"scope": "multi_block", "instruction": "řádek\nquote ✅", "line_no": 3}]
    rev = store.set_workspace_markdown(task.id, markdown, annotations)

    assert rev["annotations"] == []
    assert store.list_revisions(task.id)[0]["annotations"] == []
    assert store.list_revision_annotations(task.id, rev["revision_id"]) == [
        {
            "scope": "multi_block",
            "feedback": "řádek\nquote ✅",
            "line": 3,
            "instruction": "řádek\nquote ✅",
            "line_no": 3,
        }
    ]

    feedback = store.build_feedback_packet(task.id)
    assert "řádek" not in feedback["feedback_prompt"]
    assert "quote ✅" not in feedback["feedback_prompt"]


def test_mixed_legacy_and_v2_records_do_not_leak_annotation_quotes_into_feedback(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))

    legacy_task = store.create_task(CreateTaskRequest(title="legacy"))
    store.set_workspace_markdown(
        legacy_task.id,
        "# Legacy",
        [{"scope": "text", "instruction": "legacy hidden", "line_no": 2}],
    )

    store.set_feature_flags({"annotations_v2_enabled": True, "dual_write_enabled": True})
    v2_task = store.create_task(CreateTaskRequest(title="v2"))
    store.set_workspace_markdown(
        v2_task.id,
        "# V2",
        [{"scope": "multi_block", "instruction": "hidden line 1\nhidden line 2", "line_no": 3}],
    )

    legacy_feedback = store.build_feedback_packet(legacy_task.id)["feedback_prompt"]
    v2_feedback = store.build_feedback_packet(v2_task.id)["feedback_prompt"]

    assert "legacy hidden" not in legacy_feedback
    assert "hidden line 1" not in v2_feedback
    assert "hidden line 2" not in v2_feedback


def test_workspace_annotation_normalization_supports_canonical_legacy_and_mixed_payloads(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    store.set_feature_flags({"annotations_v2_enabled": True, "dual_write_enabled": True})
    task = store.create_task(CreateTaskRequest(title="normalize"))

    rev = store.set_workspace_markdown(
        task.id,
        "# Test",
        [
            {"scope": "text", "feedback": "canonical", "line": 2},
            {"scope": "text", "instruction": "legacy", "line_no": 3},
            {"scope": "text", "feedback": "wins", "line": 4, "instruction": "ignored", "line_no": 1},
        ],
    )

    annotations = store.list_revision_annotations(task.id, rev["revision_id"])
    assert annotations == [
        {"scope": "text", "feedback": "canonical", "line": 2, "instruction": "canonical", "line_no": 2},
        {"scope": "text", "feedback": "legacy", "line": 3, "instruction": "legacy", "line_no": 3},
        {"scope": "text", "feedback": "wins", "line": 4, "instruction": "wins", "line_no": 4},
    ]


def test_workspace_orphan_anchor_annotations_are_non_blocking_and_persisted_in_v2(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    store.set_feature_flags({"annotations_v2_enabled": True, "dual_write_enabled": True})
    task = store.create_task(CreateTaskRequest(title="orphan-anchor"))

    rev = store.set_workspace_markdown(
        task.id,
        "# Short\n\nOnly one logical line",
        [{"scope": "text", "feedback": "orphan anchor", "line": 9999}],
    )

    stored = store.list_revision_annotations(task.id, rev["revision_id"])
    assert stored == [
        {"scope": "text", "feedback": "orphan anchor", "line": 9999, "instruction": "orphan anchor", "line_no": 9999}
    ]


def test_workspace_annotation_payload_validation_rejects_malformed_inputs(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    task = store.create_task(CreateTaskRequest(title="malformed"))

    with pytest.raises(ValidationError):
        store.set_workspace_markdown(task.id, "# Broken", [{"scope": "text", "line": 1}])


def test_workspace_annotations_persist_in_canonical_store_without_feature_flag_override(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    task = store.create_task(CreateTaskRequest(title="canonical-default"))

    rev = store.set_workspace_markdown(
        task.id,
        "# Canonical",
        [{"scope": "text", "instruction": "legacy input", "line_no": 2}],
    )

    assert rev["annotations"] == []
    assert store.list_revisions(task.id)[0]["annotations"] == []
    assert store.list_revision_annotations(task.id, rev["revision_id"]) == [
        {
            "scope": "text",
            "feedback": "legacy input",
            "line": 2,
            "instruction": "legacy input",
            "line_no": 2,
        }
    ]


def test_cleanup_invariant_annotation_persistence_is_flag_agnostic_after_cutover(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    task = store.create_task(CreateTaskRequest(title="flag-agnostic"))

    store.set_feature_flags({"annotations_v2_enabled": False, "dual_write_enabled": False})
    rev_a = store.set_workspace_markdown(task.id, "# A", [{"scope": "text", "instruction": "legacy-a", "line_no": 2}])

    store.set_feature_flags({"annotations_v2_enabled": True, "dual_write_enabled": True})
    rev_b = store.set_workspace_markdown(task.id, "# B", [{"scope": "text", "instruction": "legacy-b", "line_no": 3}])

    assert store.list_revision_annotations(task.id, rev_a["revision_id"]) == [
        {"scope": "text", "feedback": "legacy-a", "line": 2, "instruction": "legacy-a", "line_no": 2}
    ]
    assert store.list_revision_annotations(task.id, rev_b["revision_id"]) == [
        {"scope": "text", "feedback": "legacy-b", "line": 3, "instruction": "legacy-b", "line_no": 3}
    ]


def test_cleanup_invariant_feedback_packet_omits_review_annotation_artifacts(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    task = store.create_task(CreateTaskRequest(title="feedback-clean"))
    store.set_workspace_markdown(
        task.id,
        "# Body",
        [{"scope": "multi_block", "instruction": "hidden review-only quote", "line_no": 2}],
    )

    packet = store.build_feedback_packet(task.id)["feedback_prompt"]

    assert "hidden review-only quote" not in packet
    assert "Detected agent instructions:" in packet


def test_workspace_v2_conflict_path_accepts_duplicate_annotations_without_write_failures(tmp_path):
    store = TaskStore(knowledge_db_path=str(tmp_path / "knowledge.db"))
    store.set_feature_flags({"annotations_v2_enabled": True, "dual_write_enabled": True})
    task = store.create_task(CreateTaskRequest(title="dedupe"))

    rev = store.set_workspace_markdown(
        task.id,
        "# Dedupe",
        [
            {"scope": "text", "feedback": "same", "line": 5},
            {"scope": "text", "feedback": "same", "line": 5},
        ],
    )

    stored = store.list_revision_annotations(task.id, rev["revision_id"])
    assert stored == [
        {"scope": "text", "feedback": "same", "line": 5, "instruction": "same", "line_no": 5},
        {"scope": "text", "feedback": "same", "line": 5, "instruction": "same", "line_no": 5},
    ]


def test_ai_preview_requires_explicit_confirm_before_write():
    store_local = TaskStore()
    doc = store_local.create_document(CreateDocumentRequest(title="AI Doc", content="Original", owner="alice"))

    preview = store_local.preview_ai_operation(
        doc.id,
        prompt="Expand this",
        operation_id="op-1",
        base_version=doc.version,
        actor="alice",
    )

    assert preview["persisted"] is False
    doc_after_preview = store_local.get_document(doc.id)
    assert doc_after_preview.content == "Original"
    assert doc_after_preview.version == doc.version


def test_ai_preview_endpoint_throttles_abuse_path(monkeypatch):
    store._mutation_hits.clear()
    monkeypatch.setattr(store, "_mutation_limit", 1)
    monkeypatch.setattr(store, "_mutation_window_seconds", 60)

    assert _enforce_mutation_rate_limit("abuse") is None
    second = _enforce_mutation_rate_limit("abuse")
    assert second is not None
    assert second.status_code == 429
    assert second.body.decode("utf-8") == '{"error":{"code":"rate_limited","message":"too many mutation requests"}}'
