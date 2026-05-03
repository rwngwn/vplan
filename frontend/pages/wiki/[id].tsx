import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import TurndownService from 'turndown'
import { marked } from 'marked'

import { fetchNotes, fetchTasks, listRevisions, saveWorkspace, submitReview, transitionTask, updateNote, updateTask } from '../../lib/api'
import { t } from '../../lib/i18n'

const Editor = dynamic(() => import('react-simple-wysiwyg').then((m) => m.DefaultEditor), { ssr: false })
const BtnBold = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnBold), { ssr: false })
const BtnItalic = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnItalic), { ssr: false })
const BtnBulletList = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnBulletList), { ssr: false })
const BtnLink = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnLink), { ssr: false })
const BtnUndo = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnUndo), { ssr: false })
const BtnRedo = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnRedo), { ssr: false })
const Separator = dynamic(() => import('react-simple-wysiwyg').then((m) => m.Separator), { ssr: false })
const Toolbar = dynamic(() => import('react-simple-wysiwyg').then((m) => m.Toolbar), { ssr: false })
const EditorProvider = dynamic(() => import('react-simple-wysiwyg').then((m) => m.EditorProvider), { ssr: false })

const td = new TurndownService()

export default function WikiNotePage() {
  const router = useRouter()
  const noteId = typeof router.query.id === 'string' ? router.query.id : ''
  const { data: notes } = useSWR('notes', fetchNotes)
  const { data: tasks, mutate: mutateTasks } = useSWR(noteId ? ['tasks', noteId] : null, () => fetchTasks({ source_ref: noteId }))
  const note = useMemo(() => (notes || []).find((n) => n.id === noteId), [notes, noteId])

  const [title, setTitle] = useState('')
  const [html, setHtml] = useState('')
  const [saveState, setSaveState] = useState('')
  const [reviewSummary, setReviewSummary] = useState('')
  const [selectedTask, setSelectedTask] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [showPanel, setShowPanel] = useState(false)

  const markdown = useMemo(() => td.turndown(html || ''), [html])

  const persistWiki = useCallback(async () => {
    if (!noteId) return
    await updateNote(noteId, { title, body: markdown })
    if (selectedTask) {
      await saveWorkspace(selectedTask, `# ${title}\n\n${markdown}`)
    }
  }, [noteId, title, markdown, selectedTask])

  useEffect(() => {
    setTitle(note?.title || '')
    setHtml(marked.parse(note?.body || '') as string)
    setIsDirty(false)
  }, [note?.id, note?.title, note?.body])

  useEffect(() => {
    if (tasks?.[0]) setSelectedTask((prev) => prev || tasks[0].id)
  }, [tasks])

  useEffect(() => {
    if (!isDirty || !noteId) return
    const handle = setTimeout(async () => {
      try {
        setSaveState(t('wiki.autosave'))
        await persistWiki()
        setSaveState(t('wiki.saved'))
        setIsDirty(false)
      } catch {
        setSaveState(t('wiki.autosaveFailed'))
      }
    }, 900)

    return () => clearTimeout(handle)
  }, [isDirty, noteId, persistWiki])

  const onSave = async () => {
    try {
      setSaveState(t('wiki.saving'))
      await persistWiki()
      setSaveState(t('wiki.saved'))
      setIsDirty(false)
    } catch {
      setSaveState(t('wiki.saveFailed'))
    }
  }

  const onSubmitReview = async (decision: 'approve' | 'request_changes') => {
    if (!selectedTask) return
    await persistWiki()
    const revs = await listRevisions(selectedTask)
    const latest = revs[revs.length - 1]
    if (!latest) return
    await submitReview(selectedTask, { revision_id: latest.revision_id, decision, summary: reviewSummary, inline_feedback: [] })
    await transitionTask(selectedTask, decision === 'approve' ? 'review' : 'in_progress')
    if (decision === 'approve') {
      await updateTask(selectedTask, { result_summary: reviewSummary || t('wiki.approvedSummary') })
    }
    await mutateTasks()
    setReviewSummary('')
    setShowPanel(false)
  }

  return (
    <main className="app-page min-h-screen">
      <div className="mx-auto max-w-5xl p-2 md:p-4">
        <div className="app-text-muted mb-2 flex items-center gap-2 text-xs">
          <span>{t('wiki.breadcrumbWorkspace')}</span>
          <span>·</span>
          <Link href="/dashboard" className="app-link-muted">{t('wiki.breadcrumbTelemetry')}</Link>
          <button onClick={() => setShowPanel((v) => !v)} className="app-button-secondary ml-auto rounded px-2 py-1 text-xs">{t('wiki.reviewPanel')}</button>
        </div>

        <input
          value={title}
          onChange={(e) => { setTitle(e.target.value); setIsDirty(true) }}
          className="app-field w-full rounded px-3 py-2 text-base font-semibold md:text-lg"
        />

        <div className="app-field mt-2 overflow-hidden rounded">
          <EditorProvider>
            <Toolbar>
              <BtnUndo />
              <BtnRedo />
              <Separator />
              <BtnBold />
              <BtnItalic />
              <BtnBulletList />
              <BtnLink />
            </Toolbar>
            <Editor
              value={html}
              onChange={(e) => {
                setHtml(e.target.value)
                setIsDirty(true)
              }}
              containerProps={{ style: { minHeight: '66vh', fontSize: 16 } }}
            />
          </EditorProvider>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <button onClick={onSave} className="app-button-primary rounded px-3 py-1.5 text-xs">{t('wiki.save')}</button>
          <span className="app-text-faint text-xs">{saveState}</span>
          <span className="app-text-faint ml-auto text-[11px]">{t('wiki.markdownBackground')}</span>
        </div>

        {showPanel && (
          <div className="app-muted-panel mt-3 rounded p-3">
            <h3 className="app-kicker">{t('wiki.reviewActions')}</h3>
            <select value={selectedTask} onChange={(e) => setSelectedTask(e.target.value)} className="app-field mt-2 w-full rounded px-2 py-2 text-xs">
              <option value="">{t('wiki.selectLinkedTask')}</option>
              {(tasks || []).map((task) => <option key={task.id} value={task.id}>{task.title} [{t(`status.${task.status}`)}]</option>)}
            </select>
            <textarea value={reviewSummary} onChange={(e) => setReviewSummary(e.target.value)} className="app-field mt-2 min-h-24 w-full rounded p-2 text-xs" placeholder={t('wiki.reviewSummary')} />
            <div className="mt-2 flex gap-2">
              <button onClick={() => onSubmitReview('request_changes')} className="rounded bg-[var(--status-warning)] px-2 py-1 text-xs">{t('wiki.requestChanges')}</button>
              <button onClick={() => onSubmitReview('approve')} className="rounded bg-[var(--status-success)] px-2 py-1 text-xs">{t('wiki.approve')}</button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
