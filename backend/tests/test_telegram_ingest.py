from app.task_store import TaskStore
from app.telegram_ingest import TelegramIngestService


def test_alias_command_creates_task_with_reply_metadata_payload():
    store = TaskStore()
    ingest = TelegramIngestService(store)

    result = ingest.handle_update(
        {
            "update_id": 1,
            "message": {
                "text": "zkm: parser edge cases",
                "chat": {"id": 999},
                "message_id": 12,
                "date": 1700000000,
                "reply_to_message": {"message_id": 10, "text": "investigate tokenizer"},
            },
        }
    )

    assert result.ok is True
    task = store.list_tasks()[0]
    assert task.source_type == "telegram"
    assert task.source_ref == "tg:999:12"
    assert "investigate tokenizer" in task.instruction
    assert result.wiki_link is not None
    assert result.task_link is not None


def test_duplicate_update_is_ignored():
    store = TaskStore()
    ingest = TelegramIngestService(store)
    payload = {"update_id": 42, "message": {"text": "/task Dup test"}}

    first = ingest.handle_update(payload)
    second = ingest.handle_update(payload)

    assert first.ok is True
    assert second.ok is True
    assert second.deduplicated is True
    assert len(store.list_tasks()) == 1
