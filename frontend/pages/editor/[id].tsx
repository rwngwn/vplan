import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'

import {
  createNote,
  fetchNotes,
  fetchTasks,
  getRevisionDiff,
  getWorkspace,
  inlineAnnotationToFrontendEntity,
  listRevisions,
  saveWorkspace,
  type FrontendAnnotationEntity,
} from '../../lib/api'
import { t } from '../../lib/i18n'

type Tab = 'edit' | 'preview' | 'diff'
type MobilePanel = 'revisions' | 'annotations' | 'notes'
type FeedbackAction = FrontendAnnotationEntity

const TABS: Tab[] = ['edit', 'preview', 'diff']
const MOBILE_PANELS: MobilePanel[] = ['revisions', 'annotations', 'notes']

function lineFromOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

function sanitizeFeedbackInput(value: string): string {
  return value.replace(/[<>]/g, '').trim().slice(0, 1000)
}

export default function EditorPage() {
  const router = useRouter()
  const taskId = typeof router.query.id === 'string' ? router.query.id : ''

  const { data: tasks } = useSWR('tasks', fetchTasks)
  const { data: notes, mutate: mutateNotes } = useSWR('notes', fetchNotes)
  const { data: workspace, mutate: mutateWorkspace } = useSWR(taskId ? ['workspace', taskId] : null, () => getWorkspace(taskId))
  const { data: revisions, mutate: mutateRevisions } = useSWR(taskId ? ['revisions', taskId] : null, () => listRevisions(taskId))

  const [tab, setTab] = useState<Tab>('edit')
  const [mobilePanel, setMobilePanel] = useState<MobilePanel | null>(null)
  const [markdown, setMarkdown] = useState('')
  const [saveState, setSaveState] = useState('')
  const [annotationsDetected, setAnnotationsDetected] = useState<FrontendAnnotationEntity[]>([])
  const [selectedRevisionId, setSelectedRevisionId] = useState('')
  const [diff, setDiff] = useState('')
  const [selectionComment, setSelectionComment] = useState('')
  const [feedbackActions, setFeedbackActions] = useState<FeedbackAction[]>([])
  const [editingActionId, setEditingActionId] = useState<string | null>(null)
  const [uiError, setUiError] = useState('')
  const editorRef = useRef<HTMLTextAreaElement | null>(null)

  const [newNoteTitle, setNewNoteTitle] = useState('')

  const task = useMemo(() => (tasks || []).find((t) => t.id === taskId), [tasks, taskId])

  useEffect(() => {
    if (workspace?.markdown) setMarkdown(workspace.markdown)
  }, [workspace?.markdown])

  const onSave = async () => {
    if (!taskId) return
    setSaveState(t('editor.saving'))
    const res = await saveWorkspace(taskId, markdown)
    setAnnotationsDetected(res.annotations.map((item, index) => inlineAnnotationToFrontendEntity(item, index)))
    setSelectedRevisionId(res.revision_id)
    setSaveState(t('editor.savedRevision', res.revision_id))
    setTimeout(() => setSaveState(''), 1800)
    await Promise.all([mutateWorkspace(), mutateRevisions()])
  }

  const onLoadDiff = async () => {
    if (!taskId || !selectedRevisionId) return
    const res = await getRevisionDiff(taskId, selectedRevisionId)
    setDiff(res.diff || t('editor.noDiff'))
  }

  const onCaptureSelection = (el: HTMLTextAreaElement) => {
    const start = el.selectionStart
    const end = el.selectionEnd
    if (end <= start) return
    const quote = sanitizeFeedbackInput(markdown.slice(start, end))
    const comment = sanitizeFeedbackInput(selectionComment)
    if (!quote || !comment) return

    const lineNo = lineFromOffset(markdown, start)
    const action: FeedbackAction = inlineAnnotationToFrontendEntity({ instruction: comment, line_no: lineNo }, feedbackActions.length)
    action.quote = quote
    setFeedbackActions((prev) => [...prev, action])
    setSelectionComment('')
    setEditingActionId(null)
  }

  const onEditFeedbackAction = (action: FeedbackAction) => {
    setEditingActionId(action.id)
    setSelectionComment(action.comment)
    setUiError('')
  }

  const onSaveFeedbackActionEdit = () => {
    if (!editingActionId) return
    const comment = sanitizeFeedbackInput(selectionComment)
    if (!comment) {
      setUiError(t('editor.genericActionError'))
      return
    }
    setFeedbackActions((prev) => prev.map((action) => (action.id === editingActionId ? { ...action, comment } : action)))
    setSelectionComment('')
    setEditingActionId(null)
    setUiError('')
  }

  const onDeleteFeedbackAction = (actionId: string) => {
    setFeedbackActions((prev) => prev.filter((action) => action.id !== actionId))
    if (editingActionId === actionId) {
      setEditingActionId(null)
      setSelectionComment('')
    }
    setUiError('')
  }

  const onCreateNote = async () => {
    if (!newNoteTitle.trim()) return
    await createNote(newNoteTitle.trim(), '')
    setNewNoteTitle('')
    await mutateNotes()
  }

  const workspacePanel = (
    <>
      <div className="app-kicker mb-3">{t('editor.workspace')}</div>
      <div className="mb-4 flex items-center gap-2 text-xs">
        <Link href="/dashboard" className="app-link-muted min-h-11 py-3 lg:min-h-0 lg:py-0">← {t('nav.dashboard')}</Link>
        <span className="app-text-faint">·</span>
        <Link href={`/tasks/${taskId}`} className="app-link-muted min-h-11 py-3 lg:min-h-0 lg:py-0">{t('nav.task')}</Link>
      </div>

      <div className="mb-5 border-t border-[var(--border-default)] pt-4">
        <p className="app-text-muted text-xs">{t('editor.currentDocument')}</p>
        <p className="mt-2 text-sm font-medium leading-5">{task?.title || t('editor.defaultTaskNote')}</p>
        <p className="app-text-faint mt-1 break-all text-[11px]">{taskId}</p>
      </div>
    </>
  )

  const revisionsPanel = (
    <div className="app-muted-panel mb-4 rounded-lg p-3">
      <p className="app-kicker mb-2">{t('editor.revisions')}</p>
      <div className="max-h-64 space-y-1 overflow-auto lg:max-h-44">
        {(revisions || []).map((r) => (
          <button
            key={r.revision_id}
            onClick={() => {
              setSelectedRevisionId(r.revision_id)
              setMobilePanel(null)
            }}
            className={`min-h-11 w-full rounded border px-2 py-2 text-left text-xs lg:min-h-0 lg:py-1 ${selectedRevisionId === r.revision_id ? 'border-[var(--accent-hover)] bg-[var(--bg-elevated)]' : 'border-[var(--border-default)] bg-[var(--bg-muted)]'}`}
          >
            <div className="font-mono">{r.revision_id}</div>
            <div className="app-text-faint">{t('editor.feedbackActionsCount', r.annotations_count)}</div>
          </button>
        ))}
      </div>
    </div>
  )

  const notesPanel = (
    <div className="app-muted-panel rounded-lg p-3">
      <p className="app-kicker mb-2">{t('editor.knowledgeNotes')}</p>
      <div className="mb-3 flex gap-2">
        <input value={newNoteTitle} onChange={(e) => setNewNoteTitle(e.target.value)} placeholder={t('editor.newNotePlaceholder')} className="app-field min-h-11 w-full rounded px-2 py-2 text-xs lg:min-h-0 lg:py-1" />
        <button onClick={onCreateNote} className="app-button-secondary min-h-11 min-w-11 rounded px-2 text-xs lg:min-h-0 lg:min-w-0">+</button>
      </div>
      <div className="max-h-64 space-y-1 overflow-auto lg:max-h-48">
        {(notes || []).map((n) => (
          <Link key={n.id} href={`/wiki/${n.id}`} className="block min-h-11 rounded border border-[var(--border-default)] bg-[var(--bg-field)] px-2 py-3 text-xs hover:bg-[var(--bg-elevated)] lg:min-h-0 lg:py-1">
            <div className="truncate">{n.title}</div>
          </Link>
        ))}
      </div>
    </div>
  )

  const annotationsPanel = (
    <div className="space-y-4">
      <section className="app-muted-panel rounded-lg p-3">
        <div className="app-kicker mb-2">{t('editor.annotations')}</div>
        <p className="app-text-faint mb-2 text-xs">{t('editor.annotationInstructions')}</p>

          <textarea
            value={selectionComment}
            onChange={(e) => setSelectionComment(e.target.value)}
            className="app-field min-h-24 w-full rounded p-2 text-xs lg:min-h-20"
            placeholder={t('editor.selectionCommentPlaceholder')}
          />

          {uiError && <p className="mt-2 text-xs text-[var(--status-danger)]">{uiError}</p>}

          {!editingActionId && (
            <button
              onClick={() => {
                if (editorRef.current) onCaptureSelection(editorRef.current)
              }}
              className="app-button-secondary mt-2 min-h-11 w-full rounded px-3 py-2 text-xs lg:min-h-0 lg:py-1.5"
            >
              {t('editor.addFromSelection')}
            </button>
          )}
          {editingActionId && <button onClick={onSaveFeedbackActionEdit} className="app-button-primary mt-2 min-h-11 w-full rounded px-3 py-2 text-xs lg:min-h-0 lg:py-1.5">{t('editor.saveFeedbackEdit')}</button>}

          <div className="mt-3 max-h-52 space-y-2 overflow-auto lg:max-h-none">
            {feedbackActions.length === 0 && <p className="app-text-faint text-xs">{t('editor.noFeedbackActions')}</p>}
            {feedbackActions.map((a) => (
              <div key={a.id} className="rounded border border-[var(--border-default)] bg-[var(--bg-field)] p-2">
                <div className="text-[11px] text-[var(--status-warning)]">{t('editor.linePrefix')} {a.line}</div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">“{a.quote.slice(0, 120)}”</div>
                <div className="mt-1 text-xs">{a.comment}</div>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => onEditFeedbackAction(a)} className="app-button-secondary min-h-11 rounded px-2 py-1 text-xs lg:min-h-0">{t('editor.editFeedbackAction')}</button>
                  <button onClick={() => onDeleteFeedbackAction(a.id)} className="app-button-secondary min-h-11 rounded px-2 py-1 text-xs lg:min-h-0">{t('editor.deleteFeedbackAction')}</button>
                </div>
              </div>
            ))}
          </div>
      </section>

      <section className="app-muted-panel rounded-lg p-3">
        <div className="app-kicker mb-1">{t('editor.detectedAgentInstructions')}</div>
        <div className="max-h-40 space-y-1 overflow-auto">
          {annotationsDetected.map((a, i) => (
            <div key={`${a.id}-${i}`} className="rounded bg-[var(--bg-muted)] p-2 text-xs">{t('editor.linePrefix')} {a.anchor.line}: {a.comment}</div>
          ))}
        </div>
      </section>
    </div>
  )

  return (
    <main className="app-page h-[100dvh] overflow-hidden">
      <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[280px_1fr_360px]">
        <aside className="hidden border-r border-[var(--border-default)] bg-[var(--bg-surface)] p-4 lg:block">
          {workspacePanel}
          {revisionsPanel}
          {notesPanel}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 lg:px-5 lg:py-3">
            <div className="mb-2 min-w-0 lg:hidden">
              <div className="truncate text-sm font-medium">{task?.title || t('editor.defaultTaskNote')}</div>
              <div className="app-text-faint mt-1 flex items-center gap-2 text-xs">
                <Link href="/dashboard" className="app-link-muted min-h-11 py-3">{t('nav.dashboard')}</Link>
                <span>·</span>
                <Link href={`/tasks/${taskId}`} className="app-link-muted min-h-11 py-3">{t('nav.task')}</Link>
              </div>
            </div>
            <div className="flex items-center gap-2 overflow-x-auto">
              {TABS.map((tabId) => (
                <button key={tabId} onClick={() => setTab(tabId)} className={`min-h-11 shrink-0 rounded px-3 py-2 text-xs lg:min-h-0 lg:px-2 lg:py-1 ${tab === tabId ? 'app-button-primary' : 'app-button-secondary'}`}>
                  {t(`tabs.${tabId}`)}
                </button>
              ))}
              <button onClick={onSave} className="app-button-primary ml-auto min-h-11 shrink-0 rounded px-3 py-2 text-xs lg:min-h-0 lg:py-1">{t('editor.save')}</button>
              <span className="app-text-faint shrink-0 text-xs">{saveState}</span>
            </div>
          </header>

          {tab === 'edit' && (
            <div className="min-h-0 flex-1 p-3 pb-20 lg:p-5 lg:pb-5">
              <textarea
                ref={editorRef}
                data-testid="editor-markdown-textarea"
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                className="app-field h-full w-full resize-none rounded-lg p-4 font-mono text-sm leading-6 lg:p-5 lg:leading-7"
                placeholder={t('editor.markdownPlaceholder')}
              />
            </div>
          )}

          {tab === 'preview' && (
            <div className="min-h-0 flex-1 overflow-auto p-5 pb-20 lg:p-8 lg:pb-8">
              <article className="prose prose-invert mx-auto max-w-3xl whitespace-pre-wrap text-sm leading-7">{markdown || t('editor.emptyPreview')}</article>
            </div>
          )}

          {tab === 'diff' && (
            <div className="min-h-0 flex-1 p-3 pb-20 lg:p-5 lg:pb-5">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button onClick={onLoadDiff} className="app-button-secondary min-h-11 rounded px-3 py-2 text-xs lg:min-h-0 lg:py-1">{t('editor.loadDiff')}</button>
                <span className="app-text-faint text-xs">{t('editor.revisionPrefix')} {selectedRevisionId || '-'}</span>
              </div>
              <pre className="app-field h-[calc(100%-48px)] overflow-auto rounded-lg p-4 text-xs">{diff || t('editor.selectRevisionForDiff')}</pre>
            </div>
          )}

          <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-3 border-t border-[var(--border-default)] bg-[var(--bg-surface)] lg:hidden">
            {MOBILE_PANELS.map((panelId) => (
              <button
                key={panelId}
                onClick={() => setMobilePanel((current) => (current === panelId ? null : panelId))}
                className={`min-h-14 px-2 py-2 text-xs ${mobilePanel === panelId ? 'app-button-primary' : 'text-[var(--text-secondary)]'}`}
              >
                {t(`mobilePanel.${panelId}`)}
              </button>
            ))}
          </nav>
        </section>

        <aside className="hidden border-l border-[var(--border-default)] bg-[var(--bg-surface)] p-4 lg:block">
          {annotationsPanel}
        </aside>
      </div>

      {mobilePanel && (
        <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={() => setMobilePanel(null)}>
          <section className="absolute inset-x-0 bottom-0 max-h-[72dvh] overflow-auto rounded-t border-t border-[var(--border-default)] bg-[var(--bg-surface)] p-3 pb-6" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="app-kicker">{t(`mobilePanel.${mobilePanel}`)}</h2>
              <button onClick={() => setMobilePanel(null)} className="app-button-secondary min-h-11 rounded px-3 py-2 text-xs">{t('editor.closePanel')}</button>
            </div>
            {mobilePanel === 'revisions' && revisionsPanel}
            {mobilePanel === 'annotations' && annotationsPanel}
            {mobilePanel === 'notes' && notesPanel}
          </section>
        </div>
      )}
    </main>
  )
}
