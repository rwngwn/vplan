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
type ReviewAnnotation = {
  id: string
  line_no: number
  quote: string
  comment: string
}

const TABS: Tab[] = ['edit', 'preview', 'diff', 'review']

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

  return (
    <main className="h-screen bg-[#11111a] text-[#e8e8ef]">
      <div className="grid h-full grid-cols-1 lg:grid-cols-[260px_1fr_340px]">
        <aside className="border-r border-[#2a2b33] bg-[#171821] p-3">
          <div className="mb-3 text-xs uppercase text-slate-400">{t('editor.workspace')}</div>
          <div className="mb-3 flex items-center gap-2 text-xs">
            <Link href="/dashboard" className="text-slate-300 hover:text-white">← {t('nav.dashboard')}</Link>
            <span className="text-slate-500">·</span>
            <Link href={`/tasks/${taskId}`} className="text-slate-300 hover:text-white">{t('nav.task')}</Link>
          </div>

          <div className="mb-4 rounded border border-[#2a2b33] bg-[#12131b] p-2">
            <p className="text-xs text-slate-400">{t('editor.currentDocument')}</p>
            <p className="mt-1 text-sm font-medium">{task?.title || t('editor.defaultTaskNote')}</p>
            <p className="text-[11px] text-slate-500">{taskId}</p>
          </div>

          <div className="mb-4">
            <p className="mb-2 text-xs uppercase text-slate-400">{t('editor.revisions')}</p>
            <div className="max-h-44 space-y-1 overflow-auto">
              {(revisions || []).map((r) => (
                <button
                  key={r.revision_id}
                  onClick={() => setSelectedRevisionId(r.revision_id)}
                  className={`w-full rounded border px-2 py-1 text-left text-xs ${selectedRevisionId === r.revision_id ? 'border-[#6b6dff] bg-[#20233a]' : 'border-[#2a2b33] bg-[#12131b]'}`}
                >
                  <div className="font-mono">{r.revision_id}</div>
                  <div className="text-slate-500">{reviewDecisionLabel(r.review_decision)}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs uppercase text-slate-400">{t('editor.knowledgeNotes')}</p>
            <div className="mb-2 flex gap-1">
              <input value={newNoteTitle} onChange={(e) => setNewNoteTitle(e.target.value)} placeholder={t('editor.newNotePlaceholder')} className="w-full rounded border border-[#2a2b33] bg-[#12131b] px-2 py-1 text-xs" />
              <button onClick={onCreateNote} className="rounded bg-[#2a2f55] px-2 text-xs">+</button>
            </div>
            <div className="max-h-48 space-y-1 overflow-auto">
              {(notes || []).map((n) => (
                <Link key={n.id} href={`/wiki/${n.id}`} className="block rounded border border-[#2a2b33] bg-[#12131b] px-2 py-1 text-xs hover:bg-[#1a1c28]">
                  <div className="truncate">{n.title}</div>
                </Link>
              ))}
            </div>
          </div>
        </aside>

        <section className="flex min-w-0 flex-col">
          <header className="flex items-center gap-2 border-b border-[#2a2b33] bg-[#141520] px-3 py-2">
            {TABS.map((tabId) => (
              <button key={tabId} onClick={() => setTab(tabId)} className={`rounded px-2 py-1 text-xs ${tab === tabId ? 'bg-[#6366f1] text-white' : 'bg-[#1f2230] text-slate-300'}`}>
                {t(`tabs.${tabId}`)}
              </button>
            ))}
            <button onClick={onSave} className="ml-auto rounded bg-[#6366f1] px-3 py-1 text-xs text-white">{t('editor.save')}</button>
            <span className="text-xs text-slate-500">{saveState}</span>
          </header>

          {tab === 'edit' && (
            <div className="h-full p-3">
              <textarea
                ref={editorRef}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                className="h-full w-full resize-none rounded border border-[#2a2b33] bg-[#0f1017] p-4 font-mono text-sm leading-6 text-slate-100"
                placeholder={t('editor.markdownPlaceholder')}
              />
            </div>
          )}

          {tab === 'preview' && (
            <div className="h-full overflow-auto p-6">
              <article className="prose prose-invert max-w-none whitespace-pre-wrap text-sm leading-7">{markdown || t('editor.emptyPreview')}</article>
            </div>
          )}

          {tab === 'diff' && (
            <div className="h-full p-3">
              <div className="mb-2 flex gap-2">
                <button onClick={onLoadDiff} className="rounded bg-[#1f2230] px-3 py-1 text-xs">{t('editor.loadDiff')}</button>
                <span className="text-xs text-slate-500">{t('editor.revisionPrefix')} {selectedRevisionId || '-'}</span>
              </div>
              <pre className="h-[calc(100%-36px)] overflow-auto rounded border border-[#2a2b33] bg-[#0f1017] p-3 text-xs">{diff || t('editor.selectRevisionForDiff')}</pre>
            </div>
          )}

          {tab === 'review' && (
            <div className="h-full overflow-auto p-3">
              <div className="rounded border border-[#2a2b33] bg-[#0f1017] p-3">
                <div className="mb-2 flex gap-2">
                  <button onClick={() => setReviewDecision('approve')} className={`rounded px-2 py-1 text-xs ${reviewDecision === 'approve' ? 'bg-emerald-600' : 'bg-[#1f2230]'}`}>{t('review.approve')}</button>
                  <button onClick={() => setReviewDecision('request_changes')} className={`rounded px-2 py-1 text-xs ${reviewDecision === 'request_changes' ? 'bg-amber-600' : 'bg-[#1f2230]'}`}>{t('review.requestChanges')}</button>
                </div>
                <textarea value={reviewSummary} onChange={(e) => setReviewSummary(e.target.value)} className="min-h-20 w-full rounded border border-[#2a2b33] bg-[#11131d] p-2 text-sm" placeholder={t('editor.reviewSummaryPlaceholder')} />
                <button onClick={onSubmitReview} className="mt-2 rounded bg-[#6366f1] px-3 py-1 text-xs">{t('editor.submitReview')}</button>
                <pre className="mt-3 whitespace-pre-wrap rounded border border-[#2a2b33] bg-[#11131d] p-2 text-xs text-slate-300">{feedbackPacket || t('editor.feedbackPacketEmpty')}</pre>
              </div>
            </div>
          )}
        </section>

        <aside className="border-l border-[#2a2b33] bg-[#171821] p-3">
          <div className="mb-2 text-xs uppercase text-slate-400">{t('editor.annotations')}</div>
          <p className="mb-2 text-xs text-slate-500">{t('editor.annotationInstructions')}</p>

          <textarea
            value={selectionComment}
            onChange={(e) => setSelectionComment(e.target.value)}
            className="min-h-20 w-full rounded border border-[#2a2b33] bg-[#12131b] p-2 text-xs"
            placeholder={t('editor.selectionCommentPlaceholder')}
          />

          <button
            onClick={() => {
              if (editorRef.current) onCaptureSelection(editorRef.current)
            }}
            className="mt-2 w-full rounded bg-[#2a2f55] px-3 py-1.5 text-xs"
          >
            {t('editor.addFromSelection')}
          </button>

          <div className="mt-3 space-y-2">
            {reviewAnnotations.length === 0 && <p className="text-xs text-slate-500">{t('editor.noReviewAnnotations')}</p>}
            {reviewAnnotations.map((a) => (
              <div key={a.id} className="rounded border border-[#2a2b33] bg-[#12131b] p-2">
                <div className="text-[11px] text-amber-300">{t('editor.linePrefix')} {a.line_no}</div>
                <div className="mt-1 text-xs text-slate-300">“{a.quote.slice(0, 120)}”</div>
                <div className="mt-1 text-xs">{a.comment}</div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <div className="mb-1 text-xs uppercase text-slate-400">{t('editor.detectedAgentInstructions')}</div>
            <div className="max-h-40 space-y-1 overflow-auto">
              {annotationsDetected.map((a, i) => (
                <div key={`${a.line_no}-${i}`} className="rounded bg-[#12131b] p-2 text-xs">{t('editor.linePrefix')} {a.line_no}: {a.instruction}</div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  )
}
