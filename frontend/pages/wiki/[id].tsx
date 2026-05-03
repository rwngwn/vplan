import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import TurndownService from 'turndown'
import { marked } from 'marked'

import { createNote, fetchNotes, updateNote } from '../../lib/api'
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
  const note = useMemo(() => (notes || []).find((n) => n.id === noteId), [notes, noteId])

  const [title, setTitle] = useState('')
  const [html, setHtml] = useState('')
  const [saveState, setSaveState] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [showPanel, setShowPanel] = useState(true)
  const [newSidebarNoteTitle, setNewSidebarNoteTitle] = useState('')
  const [annotationComment, setAnnotationComment] = useState('')
  const [annotationTab, setAnnotationTab] = useState<'open' | 'resolved'>('open')

  const markdown = useMemo(() => td.turndown(html || ''), [html])

  const persistWiki = useCallback(async () => {
    if (!noteId) return
    await updateNote(noteId, { title, body: markdown })
  }, [noteId, title, markdown])

  useEffect(() => {
    setTitle(note?.title || '')
    setHtml(marked.parse(note?.body || '') as string)
    setIsDirty(false)
  }, [note?.id, note?.title, note?.body])

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

  const hnNotes = useMemo(() => (notes || []).filter((n) => n.title.toLowerCase().includes('hn')), [notes])
  const otherNotes = useMemo(() => (notes || []).filter((n) => !n.title.toLowerCase().includes('hn')), [notes])

  const onCreateSidebarNote = async () => {
    const baseTitle = newSidebarNoteTitle.trim() || t('wiki.newMdDefaultTitle')
    const noteTitle = baseTitle.endsWith('.md') ? baseTitle : `${baseTitle}.md`
    const created = await createNote(noteTitle, '')
    setNewSidebarNoteTitle('')
    await router.push(`/wiki/${created.id}`)
  }

  const annotations = useMemo(() => {
    const matches = [...markdown.matchAll(/\[\[agent:\s*(.*?)\s*\|\s*quote:\s*(.*?)\]\]/gi)]
    return matches.map((m, i) => ({
      id: `anno-${i + 1}`,
      body: m[1]?.trim() || '',
      quote: m[2]?.trim() || '',
      status: 'open' as const,
      when: 'now'
    }))
  }, [markdown])

  const onAddAnnotation = () => {
    const selectedQuote = (globalThis.getSelection?.()?.toString() || '').trim()
    if (!selectedQuote || !annotationComment.trim()) return
    const safeQuote = selectedQuote.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const safeComment = annotationComment.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')
    setHtml((prev) => `${prev}<p>[[agent: ${safeComment} | quote: ${safeQuote}]]</p>`)
    setAnnotationComment('')
    setIsDirty(true)
    setShowPanel(true)
  }

  return (
    <main className="app-page min-h-screen">
      <div className={`mx-auto grid w-full max-w-[1480px] grid-cols-1 gap-4 px-3 py-4 lg:px-4 ${showPanel ? 'lg:grid-cols-[268px_1fr_340px]' : 'lg:grid-cols-[268px_1fr]'}`}>
        <aside className="app-surface app-sidebar h-[calc(100vh-2rem)] rounded-xl p-3">
          <div className="mb-3 flex items-center gap-2">
            <div className="app-logo-tile">P</div>
            <div className="text-sm font-semibold">Plannotator</div>
            <div className="ml-auto text-[11px] app-text-faint">acme</div>
          </div>

          <div className="space-y-1">
            <div className="app-kicker mb-1">HN folder</div>
            {hnNotes.map((n) => (
              <Link key={n.id} href={`/wiki/${n.id}`} className={`app-file-row ${n.id === noteId ? 'is-active' : ''}`}>
                <span className="truncate">{n.title}</span>
              </Link>
            ))}
          </div>

          <div className="mt-4 max-h-[40vh] space-y-1 overflow-auto">
            <div className="app-kicker mb-1">{t('wiki.otherFiles')}</div>
            {otherNotes.map((n) => (
              <Link key={n.id} href={`/wiki/${n.id}`} className={`app-file-row ${n.id === noteId ? 'is-active' : ''}`}>
                <span className="truncate">{n.title}</span>
              </Link>
            ))}
          </div>

          <div className="mt-auto space-y-2 border-t border-[var(--border-default)] pt-3">
            <input value={newSidebarNoteTitle} onChange={(e) => setNewSidebarNoteTitle(e.target.value)} placeholder={t('wiki.newMdPlaceholder')} className="app-field w-full rounded-md px-3 py-2 text-sm" />
            <button onClick={onCreateSidebarNote} className="app-button-primary w-full rounded-md px-3 py-2 text-sm">+ {t('wiki.createMd')}</button>
          </div>
        </aside>

        <section className="min-w-0">
          <div className="app-surface rounded-xl px-4 py-3 md:px-6">
            <div className="app-text-muted mb-4 flex flex-wrap items-center gap-2 text-xs">
              <span>{t('wiki.breadcrumbWorkspace')}</span>
              <span>/</span>
              <span>HN folder</span>
              <span>/</span>
              <span className="text-[var(--text-primary)]">{title || 'Untitled.md'}</span>
              <button onClick={() => setShowPanel((v) => !v)} className="app-button-secondary ml-auto rounded-md px-2 py-1 text-xs">Annotations</button>
            </div>

            <input
              value={title}
              onChange={(e) => { setTitle(e.target.value); setIsDirty(true) }}
              className="app-document-title mb-4"
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

            <div className="app-muted-panel mt-4 rounded-lg p-3">
              <div className="app-kicker mb-2">{t('wiki.annotateSelection')}</div>
              <textarea value={annotationComment} onChange={(e) => setAnnotationComment(e.target.value)} placeholder={t('wiki.annotationCommentPlaceholder')} className="app-field min-h-20 w-full rounded p-2 text-sm" />
              <button onClick={onAddAnnotation} className="app-button-secondary mt-2 w-full rounded px-3 py-2 text-sm">{t('wiki.addAnnotationFromSelection')}</button>
            </div>

            <div className="mt-4 flex items-center gap-2 border-t border-[var(--border-default)] pt-3">
              <button onClick={onSave} className="app-button-primary rounded px-4 py-2 text-xs">{t('wiki.save')}</button>
              <span className="app-text-faint text-xs">{saveState}</span>
            </div>
          </div>
        </section>

        {showPanel && (
          <aside className="app-surface h-[calc(100vh-2rem)] overflow-hidden rounded-xl">
            <div className="flex items-center gap-2 border-b border-[var(--border-default)] px-3 py-3">
              <b className="text-sm">Annotations</b>
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs">{annotations.length}</span>
              <button className="ml-auto app-button-secondary rounded px-2 py-1 text-xs" onClick={() => setShowPanel(false)}>✕</button>
            </div>
            <div className="flex gap-2 border-b border-[var(--border-default)] px-3 py-2 text-xs">
              <button className={`rounded px-2 py-1 ${annotationTab === 'open' ? 'bg-[var(--bg-elevated)]' : ''}`} onClick={() => setAnnotationTab('open')}>Open ({annotations.length})</button>
              <button className={`rounded px-2 py-1 ${annotationTab === 'resolved' ? 'bg-[var(--bg-elevated)]' : ''}`} onClick={() => setAnnotationTab('resolved')}>Resolved (0)</button>
            </div>
            <div className="space-y-2 overflow-auto p-3">
              {annotations.length === 0 ? (
                <div className="app-text-muted rounded-lg border border-[var(--border-default)] p-3 text-xs">Select text and add comment to create annotation.</div>
              ) : (
                annotations.map((a) => (
                  <div key={a.id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-muted)] p-3">
                    <div className="mb-1 text-[11px] app-text-faint">{a.when}</div>
                    <div className="mb-2 rounded bg-[rgba(246,200,77,0.22)] px-2 py-1 text-xs">{a.quote}</div>
                    <p className="text-sm leading-5">{a.body}</p>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>
    </main>
  )
}
