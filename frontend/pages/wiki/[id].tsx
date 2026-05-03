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
    <main className="app-page min-h-screen pb-24 md:pb-10">
      <div className="mx-auto w-full max-w-3xl px-4 py-4 md:px-6 md:py-8">
        <div className="app-text-muted mb-5 flex flex-wrap items-center gap-x-2 gap-y-3 text-xs">
          <span>{t('wiki.breadcrumbWorkspace')}</span>
          <span>·</span>
          <Link href="/dashboard" className="app-link-muted min-h-11 py-3 md:min-h-0 md:py-0">{t('wiki.breadcrumbTelemetry')}</Link>
          <button onClick={() => setShowPanel((v) => !v)} className="app-button-secondary ml-auto min-h-11 rounded px-3 py-2 text-xs md:min-h-0 md:py-1.5">{t('wiki.reviewPanel')}</button>
        </div>

        <input
          value={title}
          onChange={(e) => { setTitle(e.target.value); setIsDirty(true) }}
          className="app-document-title mb-5"
        />

        <div className="app-document-editor">
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
              containerProps={{}}
            />
          </EditorProvider>
        </div>

        <div className="sticky bottom-0 z-10 -mx-4 mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg-base)]/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0 md:backdrop-blur-0">
          <button onClick={onSave} className="app-button-primary min-h-11 rounded px-4 py-2 text-xs md:min-h-0 md:py-1.5">{t('wiki.save')}</button>
          <span className="app-text-faint min-w-0 flex-1 text-xs">{saveState}</span>
          <span className="app-text-faint w-full text-[11px] md:ml-auto md:w-auto">{t('wiki.markdownBackground')}</span>
        </div>

        {showPanel && (
          <div className="app-muted-panel mt-5 rounded-lg p-4">
            <h3 className="app-kicker">{t('wiki.reviewActions')}</h3>
            <select value={selectedTask} onChange={(e) => setSelectedTask(e.target.value)} className="app-field mt-3 min-h-11 w-full rounded px-3 py-2 text-sm md:min-h-0 md:text-xs">
              <option value="">{t('wiki.selectLinkedTask')}</option>
              {(tasks || []).map((task) => <option key={task.id} value={task.id}>{task.title} [{t(`status.${task.status}`)}]</option>)}
            </select>
            <textarea value={reviewSummary} onChange={(e) => setReviewSummary(e.target.value)} className="app-field mt-3 min-h-28 w-full rounded p-3 text-sm md:min-h-24 md:text-xs" placeholder={t('wiki.reviewSummary')} />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <button onClick={() => onSubmitReview('request_changes')} className="min-h-11 rounded bg-[var(--status-warning)] px-3 py-2 text-xs md:min-h-0 md:py-1.5">{t('wiki.requestChanges')}</button>
              <button onClick={() => onSubmitReview('approve')} className="min-h-11 rounded bg-[var(--status-success)] px-3 py-2 text-xs md:min-h-0 md:py-1.5">{t('wiki.approve')}</button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
