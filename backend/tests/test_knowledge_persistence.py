from app.models import CreateKnowledgeNoteRequest
from app.task_store import TaskStore


def test_notes_persist_across_store_restart(tmp_path):
    db_path = tmp_path / "knowledge.db"

    store1 = TaskStore(knowledge_db_path=str(db_path))
    note = store1.create_note(CreateKnowledgeNoteRequest(title="persist-me.md", body="hello"))

    store2 = TaskStore(knowledge_db_path=str(db_path))
    notes = store2.list_notes()

    assert any(n.id == note.id and n.title == "persist-me.md" for n in notes)
