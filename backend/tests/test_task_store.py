from app.models import CreateTaskRequest, TaskStatus, UpdateTaskRequest
from app.task_store import TaskStore


def test_create_task_defaults_to_open_with_extended_fields():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="hello"))

    assert task.status == TaskStatus.open
    assert task.source_type == "manual"
    assert len(task.events) == 1


def test_valid_transition_path_with_done_constraints():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="hello", result_summary="ready"))
    task = store.transition(task.id, TaskStatus.in_progress)
    task = store.transition(task.id, TaskStatus.review)

    rev = store.set_workspace_markdown(task.id, "line one\nline two long enough delta for analysis trigger")
    store.save_review(task.id, rev["revision_id"], "approve", "looks good", [])
    task = store.transition(task.id, TaskStatus.done)

    assert task.status == TaskStatus.done


def test_invalid_transition_raises_and_tracks_telemetry():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="hello"))

    try:
        store.transition(task.id, TaskStatus.done)
    except ValueError as exc:
        assert "invalid transition" in str(exc)
    else:
        raise AssertionError("Expected ValueError")

    assert store.telemetry_snapshot()["status_transition_invalid_attempts"] == 1


def test_update_task_metadata():
    store = TaskStore()
    task = store.create_task(CreateTaskRequest(title="hello"))
    updated = store.update_task(task.id, UpdateTaskRequest(owner="alex", priority=1, acceptance_criteria=["x"]))
    assert updated.owner == "alex"
    assert updated.priority == 1
