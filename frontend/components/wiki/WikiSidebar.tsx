import Link from 'next/link'
import type { KnowledgeFolder, KnowledgeNote } from '../../lib/api'
import { t } from '../../lib/i18n'

type WikiSidebarProps = {
  noteId: string
  folders: KnowledgeFolder[]
  notesByFolder: Record<string, KnowledgeNote[]>
  rootNotes: KnowledgeNote[]
  allNotes: KnowledgeNote[]
  selectedFolderId: string | null
  newSidebarNoteTitle: string
  onNewSidebarNoteTitleChange: (value: string) => void
  onCreateSidebarNote: () => void
  newFolderName: string
  onNewFolderNameChange: (value: string) => void
  onCreateFolder: () => void
  onSelectFolder: (folderId: string | null) => void
  onNavigate?: () => void
}

function NotesList({ notes, noteId, onNavigate }: { notes: KnowledgeNote[]; noteId: string; onNavigate?: () => void }) {
  return (
    <div className="space-y-1">
      {notes.map((n) => (
        <Link key={n.id} href={`/wiki/${n.id}`} onClick={onNavigate} className={`app-file-row ${n.id === noteId ? 'is-active' : ''}`}>
          <span className="truncate">{n.title}</span>
        </Link>
      ))}
    </div>
  )
}

export function WikiSidebar({
  noteId, folders, notesByFolder, rootNotes, allNotes, selectedFolderId, newSidebarNoteTitle, onNewSidebarNoteTitleChange, onCreateSidebarNote, newFolderName, onNewFolderNameChange, onCreateFolder, onSelectFolder, onNavigate
}: WikiSidebarProps) {
  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <div className="app-logo-tile">P</div>
        <div className="text-sm font-semibold">Plannotator</div>
      </div>

      <div className="app-kicker mb-2">SLOŽKY</div>
      <button onClick={() => onSelectFolder(null)} className={`app-file-row mb-1 w-full text-left ${selectedFolderId === null ? 'is-active' : ''}`}>Kořen</button>
      <div className="max-h-[30vh] space-y-1 overflow-auto">
        {folders.map((f) => (
          <button key={f.id} onClick={() => onSelectFolder(f.id)} className={`app-file-row w-full text-left ${selectedFolderId === f.id ? 'is-active' : ''}`}>
            {f.name} <span className="ml-1 app-text-faint">({(notesByFolder[f.id] || []).length})</span>
          </button>
        ))}
      </div>

      <div className="app-kicker mt-4 mb-2">SOUBORY</div>
      <div className="max-h-[34vh] overflow-auto">
        <NotesList notes={selectedFolderId ? (notesByFolder[selectedFolderId] || []) : allNotes} noteId={noteId} onNavigate={onNavigate} />
      </div>

      <div className="mt-auto space-y-2 border-t border-[var(--border-default)] pt-3">
        <input value={newFolderName} onChange={(e) => onNewFolderNameChange(e.target.value)} placeholder="nova-slozka" className="app-field w-full rounded-md px-3 py-2 text-sm"/>
        <button onClick={onCreateFolder} className="app-button-secondary w-full rounded-md px-3 py-2 text-sm">+ slozka</button>
        <input
          value={newSidebarNoteTitle}
          onChange={(e) => onNewSidebarNoteTitleChange(e.target.value)}
          placeholder={t('wiki.newMdPlaceholder')}
          className="app-field w-full rounded-md px-3 py-2 text-sm"
        />
        <button onClick={onCreateSidebarNote} className="app-button-primary w-full rounded-md px-3 py-2 text-sm">+ {t('wiki.createMd')}</button>
      </div>
    </>
  )
}
