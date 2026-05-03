import Link from 'next/link'
import { useRouter } from 'next/router'
import { useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'

import {
  createNote,
  fetchNotes,
  fetchTasks,
  getFeedbackPacket,
  getRevisionDiff,
  getWorkspace,
  listRevisions,
  saveWorkspace,
  submitReview,
  type InlineAnnotation,
} from '../../lib/api'
import { t } from '../../lib/i18n'

type Tab = 'edit' | 'preview' | 'diff' | 'review'
type MobilePanel = 'revisions' | 'annotations' | 'notes' | 'review'
type ReviewAnnotation = {
  id: string
  line_no: number
  quote: string
  comment: string
}

const TABS: Tab[] = ['edit', 'preview', 'diff', 'review']
const MOBILE_PANELS: MobilePanel[] = ['revisions', 'annotations', 'notes', 'review']

function lineFromOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

function reviewDecisionLabel(decision: 'pending' | 'approve' | 'request_changes'): string {
  if (decision === 'approve') return t('review.approve')
  if (decision === 'request_changes') return t('review.requestChanges')
  return t('review.pending')
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
  const [annotationsDetected, setAnnotationsDetected] = useState<InlineAnnotation[]>([])
  const [selectedRevisionId, setSelectedRevisionId] = useState('')
  const [diff, setDiff] = useState('')
  const [feedbackPacket, setFeedbackPacket] = useState('')

  const [reviewDecision, setReviewDecision] = useState<'approve' | 'request_changes'>('request_changes')
  const [reviewSummary, setReviewSummary] = useState('')
  const [selectionComment, setSelectionComment] = useState('')
  const [reviewAnnotations, setReviewAnnotations] = useState<ReviewAnnotation[]>([])
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
    setAnnotationsDetected(res.annotations)
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
    const quote = markdown.slice(start, end).trim()
    if (!quote || !selectionComment.trim()) return

    const lineNo = lineFromOffset(markdown, start)
    const ann: ReviewAnnotation = {
      id: crypto.randomUUID(),
      line_no: lineNo,
      quote,
      comment: selectionComment.trim(),
    }
    setReviewAnnotations((prev) => [...prev, ann])
    setSelectionComment('')
  }

  const onSubmitReview = async () => {
    if (!taskId || !selectedRevisionId) return
    await submitReview(taskId, {
      revision_id: selectedRevisionId,
      decision: reviewDecision,
      summary: reviewSummary,
      inline_feedback: reviewAnnotations.map((a) => ({ line_no: a.line_no, comment: t('editor.inlineFeedbackQuote', a.comment, a.quote) })),
    })
    await mutateRevisions()
    const packet = await getFeedbackPacket(taskId)
    setFeedbackPacket(packet.feedback_prompt)
    setTab('review')
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
      <div className="mb-3 flex items-center gap-2 text-xs">
        <Link href="/dashboard" className="app-link-muted min-h-11 py-3 lg:min-h-0 lg:py-0">← {t('nav.dashboard')}</Link>
        <span className="app-text-faint">·</span>
        <Link href={`/tasks/${taskId}`} className="app-link-muted min-h-11 py-3 lg:min-h-0 lg:py-0">{t('nav.task')}</Link>
      </div>

      <div className="app-muted-panel mb-4 rounded p-2">
        <p className="app-text-muted text-xs">{t('editor.currentDocument')}</p>
        <p className="mt-1 text-sm font-medium">{task?.title || t('editor.defaultTaskNote')}</p>
        <p className="app-text-faint text-[11px]">{taskId}</p>
      </div>
    </>
  )

  const revisionsPanel = (
    <div className="mb-4">
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
            <div className="app-text-faint">{reviewDecisionLabel(r.review_decision)}</div>
          </button>
        ))}
      </div>
    </div>
  )

  const notesPanel = (
    <div>
      <p className="app-kicker mb-2">{t('editor.knowledgeNotes')}</p>
      <div className="mb-2 flex gap-1">
        <input value={newNoteTitle} onChange={(e) => setNewNoteTitle(e.target.value)} placeholder={t('editor.newNotePlaceholder')} className="app-field min-h-11 w-full rounded px-2 py-2 text-xs lg:min-h-0 lg:py-1" />
        <button onClick={onCreateNote} className="app-button-secondary min-h-11 min-w-11 rounded px-2 text-xs lg:min-h-0 lg:min-w-0">+</button>
      </div>
      <div className="max-h-64 space-y-1 overflow-auto lg:max-h-48">
        {(notes || []).map((n) => (
          <Link key={n.id} href={`/wiki/${n.id}`} className="app-muted-panel block min-h-11 rounded px-2 py-3 text-xs hover:bg-[var(--bg-elevated)] lg:min-h-0 lg:py-1">
            <div className="truncate">{n.title}</div>
          </Link>
        ))}
      </div>
    </div>
  )

  const reviewControlsPanel = (
    <div className="app-field rounded p-3">
      <div className="mb-2 flex gap-2">
        <button onClick={() => setReviewDecision('approve')} className={`min-h-11 rounded px-3 py-2 text-xs lg:min-h-0 lg:px-2 lg:py-1 ${reviewDecision === 'approve' ? 'bg-[var(--status-success)]' : 'app-button-secondary'}`}>{t('review.approve')}</button>
        <button onClick={() => setReviewDecision('request_changes')} className={`min-h-11 rounded px-3 py-2 text-xs lg:min-h-0 lg:px-2 lg:py-1 ${reviewDecision === 'request_changes' ? 'bg-[var(--status-warning)]' : 'app-button-secondary'}`}>{t('review.requestChanges')}</button>
      </div>
      <textarea value={reviewSummary} onChange={(e) => setReviewSummary(e.target.value)} className="app-field min-h-24 w-full rounded p-2 text-sm lg:min-h-20" placeholder={t('editor.reviewSummaryPlaceholder')} />
      <button onClick={onSubmitReview} className="app-button-primary mt-2 min-h-11 rounded px-3 py-2 text-xs lg:min-h-0 lg:py-1">{t('editor.submitReview')}</button>
      <pre className="app-field mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded p-2 text-xs text-[var(--text-secondary)] lg:max-h-none">{feedbackPacket || t('editor.feedbackPacketEmpty')}</pre>
    </div>
  )

  const annotationsPanel = (
    <>
      <div className="app-kicker mb-2">{t('editor.annotations')}</div>
      <p className="app-text-faint mb-2 text-xs">{t('editor.annotationInstructions')}</p>

      <textarea
        value={selectionComment}
        onChange={(e) => setSelectionComment(e.target.value)}
        className="app-field min-h-24 w-full rounded p-2 text-xs lg:min-h-20"
        placeholder={t('editor.selectionCommentPlaceholder')}
      />

      <button
        onClick={() => {
          if (editorRef.current) onCaptureSelection(editorRef.current)
        }}
        className="app-button-secondary mt-2 min-h-11 w-full rounded px-3 py-2 text-xs lg:min-h-0 lg:py-1.5"
      >
        {t('editor.addFromSelection')}
      </button>

      <div className="mt-3 max-h-52 space-y-2 overflow-auto lg:max-h-none">
        {reviewAnnotations.length === 0 && <p className="app-text-faint text-xs">{t('editor.noReviewAnnotations')}</p>}
        {reviewAnnotations.map((a) => (
          <div key={a.id} className="app-muted-panel rounded p-2">
            <div className="text-[11px] text-[var(--status-warning)]">{t('editor.linePrefix')} {a.line_no}</div>
            <div className="mt-1 text-xs text-[var(--text-secondary)]">“{a.quote.slice(0, 120)}”</div>
            <div className="mt-1 text-xs">{a.comment}</div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <div className="app-kicker mb-1">{t('editor.detectedAgentInstructions')}</div>
        <div className="max-h-40 space-y-1 overflow-auto">
          {annotationsDetected.map((a, i) => (
            <div key={`${a.line_no}-${i}`} className="rounded bg-[var(--bg-muted)] p-2 text-xs">{t('editor.linePrefix')} {a.line_no}: {a.instruction}</div>
          ))}
        </div>
      </div>
    </>
  )

  return (
    <main className="app-page h-[100dvh] overflow-hidden">
      <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[260px_1fr_340px]">
        <aside className="hidden border-r border-[var(--border-default)] bg-[var(--bg-surface)] p-3 lg:block">
          {workspacePanel}
          {revisionsPanel}
          {notesPanel}
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          <header className="border-b border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2">
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
            <div className="min-h-0 flex-1 p-3 pb-20 lg:pb-3">
              <textarea
                ref={editorRef}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                className="app-field h-full w-full resize-none rounded p-4 font-mono text-sm leading-6"
                placeholder={t('editor.markdownPlaceholder')}
              />
            </div>
          )}

          {tab === 'preview' && (
            <div className="min-h-0 flex-1 overflow-auto p-6 pb-20 lg:pb-6">
              <article className="prose prose-invert max-w-none whitespace-pre-wrap text-sm leading-7">{markdown || t('editor.emptyPreview')}</article>
            </div>
          )}

          {tab === 'diff' && (
            <div className="min-h-0 flex-1 p-3 pb-20 lg:pb-3">
              <div className="mb-2 flex gap-2">
                <button onClick={onLoadDiff} className="app-button-secondary min-h-11 rounded px-3 py-2 text-xs lg:min-h-0 lg:py-1">{t('editor.loadDiff')}</button>
                <span className="app-text-faint text-xs">{t('editor.revisionPrefix')} {selectedRevisionId || '-'}</span>
              </div>
              <pre className="app-field h-[calc(100%-36px)] overflow-auto rounded p-3 text-xs">{diff || t('editor.selectRevisionForDiff')}</pre>
            </div>
          )}

          {tab === 'review' && (
            <div className="min-h-0 flex-1 overflow-auto p-3 pb-20 lg:pb-3">
              {reviewControlsPanel}
            </div>
          )}

          <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-[var(--border-default)] bg-[var(--bg-surface)] lg:hidden">
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

        <aside className="hidden border-l border-[var(--border-default)] bg-[var(--bg-surface)] p-3 lg:block">
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
            {mobilePanel === 'review' && reviewControlsPanel}
          </section>
        </div>
      )}
    </main>
  )
}
