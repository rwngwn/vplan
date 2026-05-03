import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import TurndownService from 'turndown'
import { marked } from 'marked'

import { createNote, fetchNotes, updateNote } from '../../lib/api'
import { t } from '../../lib/i18n'

const Editor = dynamic(() => import('react-simple-wysiwyg').then((m) => m.Editor), { ssr: false })
const BtnBold = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnBold), { ssr: false })
const BtnItalic = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnItalic), { ssr: false })
const BtnUnderline = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnUnderline), { ssr: false })
const BtnStrikeThrough = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnStrikeThrough), { ssr: false })
const BtnBulletList = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnBulletList), { ssr: false })
const BtnNumberedList = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnNumberedList), { ssr: false })
const BtnLink = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnLink), { ssr: false })
const BtnClearFormatting = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnClearFormatting), { ssr: false })
const BtnStyles = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnStyles), { ssr: false })
const BtnUndo = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnUndo), { ssr: false })
const BtnRedo = dynamic(() => import('react-simple-wysiwyg').then((m) => m.BtnRedo), { ssr: false })
const Separator = dynamic(() => import('react-simple-wysiwyg').then((m) => m.Separator), { ssr: false })
const Toolbar = dynamic(() => import('react-simple-wysiwyg').then((m) => m.Toolbar), { ssr: false })
const EditorProvider = dynamic(() => import('react-simple-wysiwyg').then((m) => m.EditorProvider), { ssr: false })

const td = new TurndownService()

function stripHnPromptTemplate(raw: string): string {
  if (!raw) return raw
  const markers = [
    'Ranní HN digest',
    'ČÁST 2 — NOTEBOOKLM-READY PODKLAD',
    'NotebookLM-ready',
    'Metodika sběru:'
  ]
  const hasTemplate = markers.some((m) => raw.includes(m))
  if (!hasTemplate) return raw

  return raw
    .split('\n')
    .filter((line) => {
      const l = line.trim()
      if (!l) return true
      if (l.startsWith('8–12 nejdůležitějších položek')) return false
      if (l.startsWith('U každé položky:')) return false
      if (l === 'název') return false
      if (l.includes('1 věta proč je důležitá')) return false
      if (l.startsWith('odkaz (URL')) return false
      if (l.startsWith('Poté sekce:')) return false
      if (l.includes('## Co číst jako první')) return false
      if (l.includes('## Rychlé trendy dne')) return false
      if (l.startsWith('ČÁST 2')) return false
      if (l.includes('## NotebookLM-ready')) return false
      if (l.includes('Instrukce pro NotebookLM')) return false
      if (l.includes('Vytvoř 2–3 minutové audio shrnutí')) return false
      if (l.includes('Přidej 8 stručných bullet pointů')) return false
      if (l.includes('Nakonec dej 3 praktické kroky')) return false
      if (l.startsWith('Pak vlož "PODKLAD:"')) return false
      if (l.startsWith('PODKLAD:')) return false
      if (l.startsWith('Metodika sběru:')) return false
      if (l.includes('Použij oficiální HN Firebase endpointy')) return false
      return true
    })
    .join('\n')
}

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
  const [resolvedAnnotationIds, setResolvedAnnotationIds] = useState<string[]>([])
  const editorShellRef = useRef<HTMLDivElement | null>(null)
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; quote: string } | null>(null)
  const [commentPopover, setCommentPopover] = useState<{ x: number; y: number; quote: string } | null>(null)
  const [draftHighlightRects, setDraftHighlightRects] = useState<Array<{ left: number; top: number; width: number; height: number }>>([])
  const [contextComment, setContextComment] = useState('')
  const [researchState, setResearchState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')

  const markdown = useMemo(() => td.turndown(html || ''), [html])

  const persistWiki = useCallback(async () => {
    if (!noteId) return
    await updateNote(noteId, { title, body: markdown })
  }, [noteId, title, markdown])

  useEffect(() => {
    setTitle(note?.title || '')
    const cleanedBody = stripHnPromptTemplate(note?.body || '')
    setHtml(marked.parse(cleanedBody) as string)
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

  const planNotes = useMemo(() => (notes || []).filter((n) => /(plan|rfc|telemetry)/i.test(n.title)), [notes])
  const hnNotes = useMemo(() => (notes || []).filter((n) => n.title.toLowerCase().includes('hn')), [notes])
  const otherNotes = useMemo(() => (notes || []).filter((n) => !n.title.toLowerCase().includes('hn') && !/(plan|rfc|telemetry)/i.test(n.title)), [notes])

  const onCreateSidebarNote = async () => {
    const baseTitle = newSidebarNoteTitle.trim() || t('wiki.newMdDefaultTitle')
    const noteTitle = baseTitle.endsWith('.md') ? baseTitle : `${baseTitle}.md`
    const created = await createNote(noteTitle, '')
    setNewSidebarNoteTitle('')
    await router.push(`/wiki/${created.id}`)
  }

  const annotations = useMemo(() => {
    const normalized = markdown.replace(/\\\[/g, '[').replace(/\\\]/g, ']')
    const matches = [...normalized.matchAll(/\[\[agent:\s*([\s\S]*?)\s*\|\s*quote:\s*([\s\S]*?)\]\]/gi)]
    return matches.map((m, i) => ({
      id: `anno-${i + 1}`,
      body: m[1]?.trim() || '',
      quote: m[2]?.trim() || '',
      status: resolvedAnnotationIds.includes(`anno-${i + 1}`) ? ('resolved' as const) : ('open' as const),
      when: 'now',
      author: 'You'
    }))
  }, [markdown, resolvedAnnotationIds])

  const appendAnnotation = (quoteText: string, commentText: string) => {
    const safeQuote = quoteText.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const safeComment = commentText.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')
    setHtml((prev) => `${prev}<p>[[agent: ${safeComment} | quote: ${safeQuote}]]</p>`)
    setIsDirty(true)
    setShowPanel(true)
  }

  const onAddAnnotation = () => {
    const selectedQuote = (globalThis.getSelection?.()?.toString() || '').trim()
    if (!selectedQuote || !annotationComment.trim()) return
    appendAnnotation(selectedQuote, annotationComment)
    setAnnotationComment('')
  }

  useEffect(() => {
    const updateSelection = () => {
      const selection = globalThis.getSelection?.()
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setSelectionToolbar(null)
        return
      }
      const text = selection.toString().trim()
      if (text.length < 2) {
        setSelectionToolbar(null)
        return
      }
      const range = selection.getRangeAt(0)
      const container = range.commonAncestorContainer
      const host = editorShellRef.current
      if (!host) return
      const belongs = container instanceof Node && host.contains(container)
      if (!belongs) {
        setSelectionToolbar(null)
        return
      }
      const rect = range.getBoundingClientRect()
      const hostRect = host.getBoundingClientRect()
      setSelectionToolbar({
        x: rect.left - hostRect.left + rect.width / 2,
        y: rect.top - hostRect.top - 10,
        quote: text
      })
    }

    document.addEventListener('mouseup', updateSelection)
    document.addEventListener('keyup', updateSelection)
    document.addEventListener('selectionchange', updateSelection)
    return () => {
      document.removeEventListener('mouseup', updateSelection)
      document.removeEventListener('keyup', updateSelection)
      document.removeEventListener('selectionchange', updateSelection)
    }
  }, [])

  const openAnnotations = useMemo(() => annotations.filter((a) => a.status === 'open'), [annotations])
  const resolvedAnnotations = useMemo(() => annotations.filter((a) => a.status === 'resolved'), [annotations])
  const visibleAnnotations = annotationTab === 'open' ? openAnnotations : resolvedAnnotations

  const guessIntent = (text: string) => {
    const lower = text.toLowerCase()
    if (/dozkoumej|research|zjisti|ověř|fakt|zdroj/.test(lower)) return 'research'
    if (/implement|udělej|build|kód|feature|fix/.test(lower)) return 'implementation'
    if (/rizik|trade-?off|alternativ|protiargument/.test(lower)) return 'analysis'
    return 'follow-up'
  }

  const onProcessOpenAnnotations = async () => {
    if (openAnnotations.length === 0) return
    try {
      setResearchState('running')
      const now = new Date().toISOString()
      const lines = openAnnotations.map((a, idx) => {
        const intent = guessIntent(`${a.body} ${a.quote}`)
        return `## ${idx + 1}. ${intent.toUpperCase()}\n- komentář: ${a.body}\n- citace: "${a.quote}"\n- další krok: Připravit ověřené zdroje, shrnutí a doporučení.`
      }).join('\n\n')

      const brief = [
        `# Research brief from annotations`,
        `- source_note_id: ${noteId || 'unknown'}`,
        `- source_note_title: ${title || 'Untitled.md'}`,
        `- generated_at: ${now}`,
        `- open_annotations: ${openAnnotations.length}`,
        '',
        '## Agent instructions',
        'Pro každou položku proveď: (1) ověření tvrzení, (2) dohledání zdrojů, (3) stručné doporučení, (4) navazující akční kroky.',
        '',
        lines,
        '',
        '## Output format',
        '- TL;DR\n- Evidence (zdroje + citace)\n- Co udělat dál (konkrétní tasky)'
      ].join('\n')

      const created = await createNote(`research-brief-${new Date().toISOString().slice(0, 10)}.md`, brief)
      setResearchState('done')
      await router.push(`/wiki/${created.id}`)
    } catch {
      setResearchState('error')
    }
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
            <div className="app-kicker mb-1 flex items-center">PLANS & RFCS <span className="ml-auto text-[11px]">{planNotes.length}</span></div>
            {planNotes.map((n) => (
              <Link key={n.id} href={`/wiki/${n.id}`} className={`app-file-row ${n.id === noteId ? 'is-active' : ''}`}>
                <span className="truncate">{n.title}</span>
              </Link>
            ))}
          </div>

          <div className="mt-4 max-h-[28vh] space-y-1 overflow-auto">
            <div className="app-kicker mb-1 flex items-center">HN FOLDER <span className="ml-auto text-[11px]">{hnNotes.length}</span></div>
            {hnNotes.map((n) => (
              <Link key={n.id} href={`/wiki/${n.id}`} className={`app-file-row ${n.id === noteId ? 'is-active' : ''}`}>
                <span className="truncate">{n.title}</span>
              </Link>
            ))}
          </div>

          <div className="mt-4 max-h-[22vh] space-y-1 overflow-auto">
            <div className="app-kicker mb-1 flex items-center">OSTATNÍ SOUBORY <span className="ml-auto text-[11px]">{otherNotes.length}</span></div>
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
              data-testid="wiki-title-input"
            />

            <div ref={editorShellRef} className="app-document-editor app-editor-shell relative" data-testid="wiki-editor-shell">
              <EditorProvider>
                <Toolbar>
                  <BtnUndo />
                  <BtnRedo />
                  <Separator />
                  <BtnBold />
                  <BtnItalic />
                  <BtnUnderline />
                  <BtnStrikeThrough />
                  <Separator />
                  <BtnBulletList />
                  <BtnNumberedList />
                  <BtnLink />
                  <BtnClearFormatting />
                  <BtnStyles />
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

              {draftHighlightRects.map((rect, idx) => (
                <div
                  key={`draft-rect-${idx}`}
                  className="wiki-draft-selection-highlight pointer-events-none absolute rounded-[3px] bg-amber-300/35 ring-1 ring-amber-200/45"
                  data-testid="wiki-draft-selection-highlight"
                  style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                />
              ))}

              {selectionToolbar && (
                <div className="app-selection-toolbar" data-testid="wiki-selection-toolbar" style={{ left: selectionToolbar.x, top: selectionToolbar.y }} onMouseDown={(e) => e.preventDefault()}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (selectionToolbar.quote) navigator.clipboard?.writeText(selectionToolbar.quote)
                    }}
                  >Copy</button>
                  <button
                    type="button"
                    data-testid="wiki-selection-comment-button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      const host = editorShellRef.current
                      const selection = globalThis.getSelection?.()
                      if (host && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
                        const range = selection.getRangeAt(0)
                        const rects = Array.from(range.getClientRects())
                          .filter((r) => r.width > 0 && r.height > 0)
                          .map((r) => {
                            const hostRect = host.getBoundingClientRect()
                            return {
                              left: r.left - hostRect.left,
                              top: r.top - hostRect.top,
                              width: r.width,
                              height: r.height
                            }
                          })
                        setDraftHighlightRects(rects)
                      }
                      setCommentPopover({ x: selectionToolbar.x, y: selectionToolbar.y + 14, quote: selectionToolbar.quote })
                      setContextComment('')
                    }}
                  >Comment</button>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setSelectionToolbar(null)}>✕</button>
                </div>
              )}

              {commentPopover && (
                <div className="app-comment-popover" style={{ left: commentPopover.x, top: commentPopover.y }}>
                  <div className="app-text-faint mb-2 text-xs">„{commentPopover.quote.slice(0, 96)}{commentPopover.quote.length > 96 ? '…' : ''}“</div>
                  <textarea
                    className="app-field min-h-20 w-full rounded p-2 text-sm"
                    data-testid="wiki-comment-textarea"
                    placeholder="Add a comment..."
                    value={contextComment}
                    onChange={(e) => setContextComment(e.target.value)}
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button className="app-button-secondary rounded px-2 py-1 text-xs" onClick={() => { setCommentPopover(null); setDraftHighlightRects([]) }}>Cancel</button>
                    <button
                      className="app-button-primary rounded px-2 py-1 text-xs"
                      onClick={() => {
                        if (!contextComment.trim()) return
                        appendAnnotation(commentPopover.quote, contextComment)
                        setCommentPopover(null)
                        setSelectionToolbar(null)
                        setContextComment('')
                        setDraftHighlightRects([])
                      }}
                    >Save</button>
                  </div>
                </div>
              )}
            </div>

            <div className="app-muted-panel mt-4 rounded-lg p-3">
              <div className="app-kicker mb-2">{t('wiki.annotateSelection')}</div>
              <textarea value={annotationComment} onChange={(e) => setAnnotationComment(e.target.value)} placeholder={t('wiki.annotationCommentPlaceholder')} className="app-field min-h-20 w-full rounded p-2 text-sm" />
              <button
                onClick={() => {
                  onAddAnnotation()
                  setAnnotationTab('open')
                }}
                className="app-button-secondary mt-2 w-full rounded px-3 py-2 text-sm"
              >{t('wiki.addAnnotationFromSelection')}</button>
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
              <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs">{openAnnotations.length}</span>
              <button className="ml-auto app-button-secondary rounded px-2 py-1 text-xs" onClick={() => setShowPanel(false)}>✕</button>
            </div>
            <div className="flex gap-2 border-b border-[var(--border-default)] px-3 py-2 text-xs">
              <button className={`rounded px-2 py-1 ${annotationTab === 'open' ? 'bg-[var(--bg-elevated)]' : ''}`} onClick={() => setAnnotationTab('open')}>Open ({openAnnotations.length})</button>
              <button className={`rounded px-2 py-1 ${annotationTab === 'resolved' ? 'bg-[var(--bg-elevated)]' : ''}`} onClick={() => setAnnotationTab('resolved')}>Resolved ({resolvedAnnotations.length})</button>
              <button
                className="ml-auto app-button-primary rounded px-2 py-1 text-[11px]"
                disabled={researchState === 'running' || openAnnotations.length === 0}
                onClick={onProcessOpenAnnotations}
              >
                {researchState === 'running' ? 'Processing…' : 'Process open annotations'}
              </button>
            </div>
            {researchState === 'error' && (
              <div className="px-3 pt-2 text-[11px] text-rose-300">Nepodařilo se vytvořit research brief.</div>
            )}
            <div className="space-y-2 overflow-auto p-3">
              {visibleAnnotations.length === 0 ? (
                <div className="app-text-muted rounded-lg border border-[var(--border-default)] p-3 text-xs">Select text and add comment to create annotation.</div>
              ) : (
                visibleAnnotations.map((a) => (
                  <div key={a.id} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-muted)] p-3">
                    <div className="mb-1 flex items-center gap-2 text-[11px] app-text-faint">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[10px] text-white">YU</span>
                      <span className="font-semibold text-[var(--text-primary)]">{a.author}</span>
                      <span className="ml-auto">{a.when}</span>
                    </div>
                    <div className="mb-2 rounded bg-[rgba(246,200,77,0.22)] px-2 py-1 text-xs">{a.quote}</div>
                    <p className="text-sm leading-5">{a.body}</p>
                    {a.status === 'open' && (
                      <div className="mt-2 flex justify-end">
                        <button
                          className="app-button-secondary rounded px-2 py-1 text-[11px]"
                          onClick={() => setResolvedAnnotationIds((prev) => prev.includes(a.id) ? prev : [...prev, a.id])}
                        >resolve</button>
                      </div>
                    )}
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
