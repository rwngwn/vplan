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

type Tab = 'edit' | 'preview' | 'diff' | 'review'
type ReviewAnnotation = {
  id: string
  line_no: number
  quote: string
  comment: string
}

function lineFromOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
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
    setSaveState('Ukládám…')
    const res = await saveWorkspace(taskId, markdown)
    setAnnotationsDetected(res.annotations)
    setSelectedRevisionId(res.revision_id)
    setSaveState(`Uloženo rev ${res.revision_id}`)
    setTimeout(() => setSaveState(''), 1800)
    await Promise.all([mutateWorkspace(), mutateRevisions()])
  }

  const onLoadDiff = async () => {
    if (!taskId || !selectedRevisionId) return
    const res = await getRevisionDiff(taskId, selectedRevisionId)
    setDiff(res.diff || 'Žádný diff (první revize?)')
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
      inline_feedback: reviewAnnotations.map((a) => ({ line_no: a.line_no, comment: `${a.comment} | quote: ${a.quote}` })),
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
          <div className="mb-3 text-xs uppercase text-slate-400">Workspace</div>
          <div className="mb-3 flex items-center gap-2 text-xs">
            <Link href="/dashboard" className="text-slate-300 hover:text-white">← dashboard</Link>
            <span className="text-slate-500">·</span>
            <Link href={`/tasks/${taskId}`} className="text-slate-300 hover:text-white">task</Link>
          </div>

          <div className="mb-4 rounded border border-[#2a2b33] bg-[#12131b] p-2">
            <p className="text-xs text-slate-400">Aktuální dokument</p>
            <p className="mt-1 text-sm font-medium">{task?.title || 'Task note'}</p>
            <p className="text-[11px] text-slate-500">{taskId}</p>
          </div>

          <div className="mb-4">
            <p className="mb-2 text-xs uppercase text-slate-400">Revisions</p>
            <div className="max-h-44 space-y-1 overflow-auto">
              {(revisions || []).map((r) => (
                <button
                  key={r.revision_id}
                  onClick={() => setSelectedRevisionId(r.revision_id)}
                  className={`w-full rounded border px-2 py-1 text-left text-xs ${selectedRevisionId === r.revision_id ? 'border-[#6b6dff] bg-[#20233a]' : 'border-[#2a2b33] bg-[#12131b]'}`}
                >
                  <div className="font-mono">{r.revision_id}</div>
                  <div className="text-slate-500">{r.review_decision}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs uppercase text-slate-400">Knowledge notes</p>
            <div className="mb-2 flex gap-1">
              <input value={newNoteTitle} onChange={(e) => setNewNoteTitle(e.target.value)} placeholder="Nová poznámka" className="w-full rounded border border-[#2a2b33] bg-[#12131b] px-2 py-1 text-xs" />
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
            {(['edit', 'preview', 'diff', 'review'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded px-2 py-1 text-xs ${tab === t ? 'bg-[#6366f1] text-white' : 'bg-[#1f2230] text-slate-300'}`}>
                {t}
              </button>
            ))}
            <button onClick={onSave} className="ml-auto rounded bg-[#6366f1] px-3 py-1 text-xs text-white">Save</button>
            <span className="text-xs text-slate-500">{saveState}</span>
          </header>

          {tab === 'edit' && (
            <div className="h-full p-3">
              <textarea
                ref={editorRef}
                value={markdown}
                onChange={(e) => setMarkdown(e.target.value)}
                className="h-full w-full resize-none rounded border border-[#2a2b33] bg-[#0f1017] p-4 font-mono text-sm leading-6 text-slate-100"
                placeholder="# Wiki page\n\n- piš markdown\n- vyber text a přidej anotaci vpravo"
              />
            </div>
          )}

          {tab === 'preview' && (
            <div className="h-full overflow-auto p-6">
              <article className="prose prose-invert max-w-none whitespace-pre-wrap text-sm leading-7">{markdown || 'Preview...'}</article>
            </div>
          )}

          {tab === 'diff' && (
            <div className="h-full p-3">
              <div className="mb-2 flex gap-2">
                <button onClick={onLoadDiff} className="rounded bg-[#1f2230] px-3 py-1 text-xs">Load diff</button>
                <span className="text-xs text-slate-500">rev: {selectedRevisionId || '-'}</span>
              </div>
              <pre className="h-[calc(100%-36px)] overflow-auto rounded border border-[#2a2b33] bg-[#0f1017] p-3 text-xs">{diff || 'Vyber revizi a načti diff'}</pre>
            </div>
          )}

          {tab === 'review' && (
            <div className="h-full overflow-auto p-3">
              <div className="rounded border border-[#2a2b33] bg-[#0f1017] p-3">
                <div className="mb-2 flex gap-2">
                  <button onClick={() => setReviewDecision('approve')} className={`rounded px-2 py-1 text-xs ${reviewDecision === 'approve' ? 'bg-emerald-600' : 'bg-[#1f2230]'}`}>approve</button>
                  <button onClick={() => setReviewDecision('request_changes')} className={`rounded px-2 py-1 text-xs ${reviewDecision === 'request_changes' ? 'bg-amber-600' : 'bg-[#1f2230]'}`}>request changes</button>
                </div>
                <textarea value={reviewSummary} onChange={(e) => setReviewSummary(e.target.value)} className="min-h-20 w-full rounded border border-[#2a2b33] bg-[#11131d] p-2 text-sm" placeholder="Shrnutí review" />
                <button onClick={onSubmitReview} className="mt-2 rounded bg-[#6366f1] px-3 py-1 text-xs">Submit review</button>
                <pre className="mt-3 whitespace-pre-wrap rounded border border-[#2a2b33] bg-[#11131d] p-2 text-xs text-slate-300">{feedbackPacket || 'Feedback packet se objeví po submitu.'}</pre>
              </div>
            </div>
          )}
        </section>

        <aside className="border-l border-[#2a2b33] bg-[#171821] p-3">
          <div className="mb-2 text-xs uppercase text-slate-400">Annotations</div>
          <p className="mb-2 text-xs text-slate-500">1) Označ text v editoru 2) napiš komentář 3) Add from selection</p>

          <textarea
            value={selectionComment}
            onChange={(e) => setSelectionComment(e.target.value)}
            className="min-h-20 w-full rounded border border-[#2a2b33] bg-[#12131b] p-2 text-xs"
            placeholder="Komentář k vybranému textu"
          />

          <button
            onClick={() => {
              if (editorRef.current) onCaptureSelection(editorRef.current)
            }}
            className="mt-2 w-full rounded bg-[#2a2f55] px-3 py-1.5 text-xs"
          >
            Add from selection
          </button>

          <div className="mt-3 space-y-2">
            {reviewAnnotations.length === 0 && <p className="text-xs text-slate-500">Žádné review anotace.</p>}
            {reviewAnnotations.map((a) => (
              <div key={a.id} className="rounded border border-[#2a2b33] bg-[#12131b] p-2">
                <div className="text-[11px] text-amber-300">line {a.line_no}</div>
                <div className="mt-1 text-xs text-slate-300">“{a.quote.slice(0, 120)}”</div>
                <div className="mt-1 text-xs">{a.comment}</div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <div className="mb-1 text-xs uppercase text-slate-400">Detected agent instructions</div>
            <div className="max-h-40 space-y-1 overflow-auto">
              {annotationsDetected.map((a, i) => (
                <div key={`${a.line_no}-${i}`} className="rounded bg-[#12131b] p-2 text-xs">ř.{a.line_no}: {a.instruction}</div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </main>
  )
}
