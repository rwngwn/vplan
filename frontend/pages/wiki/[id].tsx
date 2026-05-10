import { useRouter } from 'next/router'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'

import { WikiAnnotationsPanel } from '../../components/wiki/WikiAnnotationsPanel'
import { WikiMobileSheet } from '../../components/wiki/WikiMobileSheet'
import { WikiSidebar } from '../../components/wiki/WikiSidebar'
import { createFolder, createNote, fetchFolders, fetchNotes, updateNote, type KnowledgeNote } from '../../lib/api'
import { t } from '../../lib/i18n'

function stripHnPromptTemplate(raw: string): string {
  if (!raw) return raw
  const markers = ['Ranní HN digest', 'ČÁST 2 — NOTEBOOKLM-READY PODKLAD', 'NotebookLM-ready', 'Metodika sběru:']
  const hasTemplate = markers.some((m) => raw.includes(m))
  if (!hasTemplate) return raw
  return raw.split('\n').filter((line) => {
    const l = line.trim()
    if (!l) return true
    return !(
      l.startsWith('8–12 nejdůležitějších položek') ||
      l.startsWith('U každé položky:') ||
      l === 'název' ||
      l.includes('1 věta proč je důležitá') ||
      l.startsWith('odkaz (URL') ||
      l.startsWith('Poté sekce:') ||
      l.includes('## Co číst jako první') ||
      l.includes('## Rychlé trendy dne') ||
      l.startsWith('ČÁST 2') ||
      l.includes('## NotebookLM-ready') ||
      l.includes('Instrukce pro NotebookLM') ||
      l.includes('Vytvoř 2–3 minutové audio shrnutí') ||
      l.includes('Přidej 8 stručných bullet pointů') ||
      l.includes('Nakonec dej 3 praktické kroky') ||
      l.startsWith('Pak vlož "PODKLAD:"') ||
      l.startsWith('PODKLAD:') ||
      l.startsWith('Metodika sběru:') ||
      l.includes('Použij oficiální HN Firebase endpointy')
    )
  }).join('\n')
}


export default function WikiNotePage() {
  const router = useRouter()
  const noteId = typeof router.query.id === 'string' ? router.query.id : ''
  const { data: notes, mutate: mutateNotes } = useSWR('notes', fetchNotes)
  const { data: folders, mutate: mutateFolders } = useSWR('folders', fetchFolders)
  const note = useMemo(() => (notes || []).find((n) => n.id === noteId), [notes, noteId])

  const [title, setTitle] = useState('')
  const [markdownBody, setMarkdownBody] = useState('')
  const [saveState, setSaveState] = useState('')
  const [isDirty, setIsDirty] = useState(false)
  const [showPanel, setShowPanel] = useState(true)
  const [newSidebarNoteTitle, setNewSidebarNoteTitle] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [annotationTab, setAnnotationTab] = useState<'open' | 'resolved'>('open')
  const [resolvedAnnotationIds, setResolvedAnnotationIds] = useState<string[]>([])
  const editorShellRef = useRef<HTMLDivElement | null>(null)
  const [pendingAnnotation, setPendingAnnotation] = useState<{ quote: string; comment: string } | null>(null)
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; quote: string } | null>(null)
  const [commentPopover, setCommentPopover] = useState<{ x: number; y: number; quote: string } | null>(null)
  const [draftHighlightRects, setDraftHighlightRects] = useState<Array<{ left: number; top: number; width: number; height: number }>>([])
  const [contextComment, setContextComment] = useState('')
  const [researchState, setResearchState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [mobileSheet, setMobileSheet] = useState<'files' | 'annotations' | 'comment' | null>(null)
  const selectionToolbarRetryFrameRef = useRef<number | null>(null)

  const persistWiki = useCallback(async () => {
    if (!noteId) return
    await updateNote(noteId, { title, body: markdownBody })
  }, [noteId, title, markdownBody])

  useEffect(() => {
    setTitle(note?.title || '')
    const cleanedBody = stripHnPromptTemplate(note?.body || '')
    setMarkdownBody(cleanedBody)
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

  const notesByFolder = useMemo(() => {
    const map: Record<string, KnowledgeNote[]> = {}
    ;(notes || []).forEach((n) => {
      if (!n.folder_id) return
      const bucket = map[n.folder_id] || []
      bucket.push(n)
      map[n.folder_id] = bucket
    })
    return map
  }, [notes])
  const rootNotes = useMemo(() => (notes || []).filter((n) => !n.folder_id), [notes])
  const allNotes = useMemo(() => notes || [], [notes])

  const onCreateSidebarNote = async () => {
    const baseTitle = newSidebarNoteTitle.trim() || t('wiki.newMdDefaultTitle')
    const noteTitle = baseTitle.endsWith('.md') ? baseTitle : `${baseTitle}.md`
    const created = await createNote(noteTitle, '', selectedFolderId)
    setNewSidebarNoteTitle('')
    await mutateNotes()
    await router.push(`/wiki/${created.id}`)
  }

  const onCreateFolder = async () => {
    const name = newFolderName.trim()
    if (!name) return
    const folder = await createFolder(name)
    setSelectedFolderId(folder.id)
    setNewFolderName('')
    await mutateFolders()
  }

  const annotations = useMemo(() => {
    const normalized = markdownBody.replace(/\\\[/g, '[').replace(/\\\]/g, ']')
    const matches = [...normalized.matchAll(/\[\[agent:\s*([\s\S]*?)\s*\|\s*quote:\s*([\s\S]*?)\]\]/gi)]
    return matches.map((m, i) => ({
      id: `anno-${i + 1}`,
      body: m[1]?.trim() || '',
      quote: m[2]?.trim() || '',
      status: resolvedAnnotationIds.includes(`anno-${i + 1}`) ? ('resolved' as const) : ('open' as const),
      when: 'now',
      author: 'You'
    }))
  }, [markdownBody, resolvedAnnotationIds])

  const appendAnnotation = (quoteText: string, commentText: string) => {
    const safeQuote = quoteText.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const safeComment = commentText.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')
    setPendingAnnotation({ quote: safeQuote, comment: safeComment })
    setIsDirty(true)
    setShowPanel(true)
    setAnnotationTab('open')
  }

  const openCommentComposer = (quote: string, position?: { x: number; y: number }) => {
    const host = editorShellRef.current
    const selection = globalThis.getSelection?.()
    if (host && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const hostRect = host.getBoundingClientRect()
      const range = selection.getRangeAt(0)
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ left: r.left - hostRect.left, top: r.top - hostRect.top, width: r.width, height: r.height }))
      setDraftHighlightRects(rects)
    }
    setContextComment('')
    setSelectionToolbar(null)
    setCommentPopover(position ? { x: position.x, y: position.y, quote } : { x: 0, y: 0, quote })
    if (globalThis.matchMedia?.('(max-width: 1023px)').matches) setMobileSheet('comment')
  }

  const saveContextComment = () => {
    if (!commentPopover || !contextComment.trim()) return
    appendAnnotation(commentPopover.quote, contextComment)
    setCommentPopover(null)
    setSelectionToolbar(null)
    setContextComment('')
    setDraftHighlightRects([])
    setMobileSheet(null)
  }

  const cancelContextComment = () => {
    setCommentPopover(null)
    setContextComment('')
    setDraftHighlightRects([])
    if (mobileSheet === 'comment') setMobileSheet(null)
  }

  const clearSelectionToolbar = () => {
    if (selectionToolbarRetryFrameRef.current !== null) {
      globalThis.cancelAnimationFrame(selectionToolbarRetryFrameRef.current)
      selectionToolbarRetryFrameRef.current = null
    }
    globalThis.getSelection?.()?.removeAllRanges()
    setSelectionToolbar(null)
  }

  useEffect(() => {
    return () => {
      if (selectionToolbarRetryFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(selectionToolbarRetryFrameRef.current)
        selectionToolbarRetryFrameRef.current = null
      }
    }
  }, [])

  const openAnnotations = useMemo(() => annotations.filter((a) => a.status === 'open'), [annotations])
  const resolvedAnnotations = useMemo(() => annotations.filter((a) => a.status === 'resolved'), [annotations])
  const visibleAnnotations = annotationTab === 'open' ? openAnnotations : resolvedAnnotations

  useEffect(() => {
      if (commentPopover) {
        setSelectionToolbar(null)
      }
  }, [commentPopover])

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
      const brief = [`# Research brief from annotations`, `- source_note_id: ${noteId || 'unknown'}`, `- source_note_title: ${title || 'Untitled.md'}`, `- generated_at: ${now}`, `- open_annotations: ${openAnnotations.length}`, '', '## Agent instructions', 'Pro každou položku proveď: (1) ověření tvrzení, (2) dohledání zdrojů, (3) stručné doporučení, (4) navazující akční kroky.', '', lines, '', '## Output format', '- TL;DR\n- Evidence (zdroje + citace)\n- Co udělat dál (konkrétní tasky)'].join('\n')
      const created = await createNote(`research-brief-${new Date().toISOString().slice(0, 10)}.md`, brief)
      setResearchState('done')
      await router.push(`/wiki/${created.id}`)
    } catch {
      setResearchState('error')
    }
  }

  const sidebarContent = <WikiSidebar noteId={noteId} folders={folders || []} notesByFolder={notesByFolder} rootNotes={rootNotes} allNotes={allNotes} selectedFolderId={selectedFolderId} newSidebarNoteTitle={newSidebarNoteTitle} onNewSidebarNoteTitleChange={setNewSidebarNoteTitle} onCreateSidebarNote={onCreateSidebarNote} newFolderName={newFolderName} onNewFolderNameChange={setNewFolderName} onCreateFolder={onCreateFolder} onSelectFolder={setSelectedFolderId} onNavigate={() => setMobileSheet(null)} />

  const annotationsContent = <WikiAnnotationsPanel annotationTab={annotationTab} openAnnotations={openAnnotations} resolvedAnnotations={resolvedAnnotations} visibleAnnotations={visibleAnnotations} researchState={researchState} onAnnotationTabChange={setAnnotationTab} onProcessOpenAnnotations={onProcessOpenAnnotations} onResolveAnnotation={(id) => setResolvedAnnotationIds((prev) => prev.includes(id) ? prev : [...prev, id])} onClose={() => globalThis.matchMedia?.('(max-width: 1023px)').matches ? setMobileSheet(null) : setShowPanel(false)} />

  return (
    <main className="app-page min-h-screen pb-20 lg:pb-0">
      <div className="sticky top-0 z-30 border-b border-[var(--border-default)] bg-[var(--bg-base)]/95 px-3 py-1.5 backdrop-blur lg:hidden" data-testid="wiki-mobile-topbar">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{title || 'Bez názvu.md'}</div>
            <div className="app-text-faint min-h-3 text-[10px] leading-3">{saveState || (isDirty ? 'Neuložené změny' : 'Uloženo')}</div>
          </div>
          <button className="app-button-secondary rounded-md px-2.5 py-1.5 text-xs" onClick={() => setMobileSheet('files')}>Soubory</button>
        </div>
      </div>

      <div className={`mx-auto grid w-full max-w-[1480px] grid-cols-1 gap-4 px-0 py-0 lg:px-4 lg:py-4 ${showPanel ? 'lg:grid-cols-[268px_1fr_340px]' : 'lg:grid-cols-[268px_1fr]'}`}>
        <aside className="app-surface app-sidebar hidden h-[calc(100vh-2rem)] rounded-xl p-3 lg:flex">{sidebarContent}</aside>

        <section className="min-w-0">
          <div className="min-h-[calc(100dvh-7.5rem)] px-3 py-3 lg:app-surface lg:min-h-0 lg:rounded-xl lg:px-6">
            <div className="app-text-muted mb-4 hidden flex-wrap items-center gap-2 text-xs lg:flex">
              <span>{t('wiki.breadcrumbWorkspace')}</span><span>/</span><span>HN folder</span><span>/</span><span className="text-[var(--text-primary)]">{title || 'Untitled.md'}</span>
              <button onClick={() => setShowPanel((v) => !v)} className="app-button-secondary ml-auto rounded-md px-2 py-1 text-xs">Annotations</button>
            </div>

            <input value={title} onChange={(e) => { setTitle(e.target.value); setIsDirty(true) }} className="app-document-title mb-3 lg:mb-4" data-testid="wiki-title-input" />

            <div ref={editorShellRef} className="app-document-editor app-editor-shell relative">
              <WikiBlockEditorAdapter
                markdown={markdownBody}
                onMarkdownChange={(next) => {
                  setMarkdownBody(next)
                  setIsDirty(true)
                }}
                pendingAnnotation={pendingAnnotation}
                onPendingAnnotationApplied={() => setPendingAnnotation(null)}
                onSelectionQuoteChange={(quote, snapshot) => {
                  const updateSelectionToolbar = (nextQuote: string, nextSnapshot: { quote: string; rect: { left: number; top: number; width: number; height: number } | null } | null, attempt: number) => {
                    const host = editorShellRef.current
                    const fallbackToolbar = () => {
                      if (!host) {
                        setSelectionToolbar(null)
                        return
                      }
                      const hostRect = host.getBoundingClientRect()
                      setSelectionToolbar({ x: hostRect.width / 2, y: 12, quote: nextQuote })
                    }

                    if (!host || !nextSnapshot || nextSnapshot.quote !== nextQuote || !nextSnapshot.rect) {
                      if (attempt < 4) {
                        selectionToolbarRetryFrameRef.current = globalThis.requestAnimationFrame(() => {
                          selectionToolbarRetryFrameRef.current = null
                          updateSelectionToolbar(nextQuote, nextSnapshot, attempt + 1)
                        })
                      } else {
                        fallbackToolbar()
                      }
                      return
                    }

                    const hostRect = host.getBoundingClientRect()
                    const validRect = nextSnapshot.rect

                    setSelectionToolbar({
                      x: validRect.left + (validRect.width / 2) - hostRect.left,
                      y: validRect.top - hostRect.top - 10,
                      quote: nextQuote
                    })
                  }

                  if (!quote) {
                    if (selectionToolbarRetryFrameRef.current !== null) {
                      globalThis.cancelAnimationFrame(selectionToolbarRetryFrameRef.current)
                      selectionToolbarRetryFrameRef.current = null
                    }
                    setSelectionToolbar(null)
                    return
                  }

                  if (selectionToolbarRetryFrameRef.current !== null) {
                    globalThis.cancelAnimationFrame(selectionToolbarRetryFrameRef.current)
                    selectionToolbarRetryFrameRef.current = null
                  }
                  updateSelectionToolbar(quote, snapshot, 0)
                }}
              />

              {draftHighlightRects.map((rect, idx) => <div key={`draft-rect-${idx}`} className="wiki-draft-selection-highlight pointer-events-none absolute rounded-[3px] bg-amber-300/35 ring-1 ring-amber-200/45" data-testid="wiki-draft-selection-highlight" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}

              {selectionToolbar && <div className="app-selection-toolbar hidden lg:flex" data-testid="wiki-selection-toolbar" style={{ left: selectionToolbar.x, top: selectionToolbar.y }} onMouseDown={(e) => e.preventDefault()}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => selectionToolbar.quote && navigator.clipboard?.writeText(selectionToolbar.quote)}>Copy</button>
                <button type="button" data-testid="wiki-selection-comment-button" onMouseDown={(e) => e.preventDefault()} onClick={() => openCommentComposer(selectionToolbar.quote, { x: selectionToolbar.x, y: selectionToolbar.y + 14 })}>Comment</button>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setSelectionToolbar(null)}>x</button>
              </div>}

              {commentPopover && mobileSheet !== 'comment' && <div className="app-comment-popover" style={{ left: commentPopover.x, top: commentPopover.y }}>
                <div className="app-text-faint mb-2 text-xs">&quot;{commentPopover.quote.slice(0, 96)}{commentPopover.quote.length > 96 ? '...' : ''}&quot;</div>
                <textarea className="app-field min-h-20 w-full rounded p-2 text-sm" data-testid="wiki-comment-textarea" placeholder="Add a comment..." value={contextComment} onChange={(e) => setContextComment(e.target.value)} />
                <div className="mt-2 flex justify-end gap-2">
                  <button className="app-button-secondary rounded px-2 py-1 text-xs" onClick={cancelContextComment}>Cancel</button>
                  <button className="app-button-primary rounded px-2 py-1 text-xs" onClick={saveContextComment}>Save</button>
                </div>
              </div>}
            </div>

            <div className="mt-4 flex items-center gap-2 border-t border-[var(--border-default)] pt-3">
              <button onClick={onSave} className="app-button-primary rounded px-4 py-2 text-xs">{t('wiki.save')}</button>
              <span className="app-text-faint text-xs">{saveState}</span>
            </div>
          </div>
        </section>

        {showPanel && <aside className="app-surface hidden h-[calc(100vh-2rem)] overflow-hidden rounded-xl lg:block">{annotationsContent}</aside>}
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border-default)] bg-[var(--bg-base)]/95 px-3 py-2 backdrop-blur lg:hidden" data-testid="wiki-mobile-bottom-nav">
        {selectionToolbar ? <div className="grid grid-cols-[1fr_1fr_auto] gap-2" onMouseDown={(e) => e.preventDefault()}>
          <button className="app-button-primary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-comment" onMouseDown={(e) => e.preventDefault()} onClick={() => openCommentComposer(selectionToolbar.quote)}>Komentář</button>
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-copy" onMouseDown={(e) => e.preventDefault()} onClick={() => selectionToolbar.quote && navigator.clipboard?.writeText(selectionToolbar.quote)}>Kopírovat</button>
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-close" onMouseDown={(e) => e.preventDefault()} onClick={clearSelectionToolbar}>Zrušit</button>
        </div> : <div className="grid grid-cols-2 gap-2">
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-comments" onClick={() => setMobileSheet('annotations')}>Komentáře <span className="ml-1 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[10px]">{openAnnotations.length}</span></button>
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-files" onClick={() => setMobileSheet('files')}>Soubory</button>
        </div>}
      </nav>

      <WikiMobileSheet title="Soubory" open={mobileSheet === 'files'} onClose={() => setMobileSheet(null)} testId="wiki-mobile-files-sheet"><div className="app-sidebar flex min-h-[60dvh] flex-col">{sidebarContent}</div></WikiMobileSheet>
      <WikiMobileSheet title="Komentáře" open={mobileSheet === 'annotations'} onClose={() => setMobileSheet(null)} testId="wiki-mobile-comments-sheet"><div className="-m-4">{annotationsContent}</div></WikiMobileSheet>
      <WikiMobileSheet title="Přidat komentář" open={mobileSheet === 'comment' && Boolean(commentPopover)} onClose={cancelContextComment} testId="wiki-mobile-comment-sheet" footer={<div className="flex justify-end gap-2"><button className="app-button-secondary rounded-md px-3 py-2 text-sm" onClick={cancelContextComment}>Zrušit</button><button className="app-button-primary rounded-md px-4 py-2 text-sm" onClick={saveContextComment}>Uložit</button></div>}>
        {commentPopover && <div className="space-y-3"><div className="rounded-lg bg-[rgba(246,200,77,0.18)] p-3 text-sm leading-5">&quot;{commentPopover.quote}&quot;</div><textarea className="app-field min-h-32 w-full rounded-lg p-3 text-sm" data-testid="wiki-comment-textarea" placeholder="Přidej komentář..." value={contextComment} onChange={(e) => setContextComment(e.target.value)} /></div>}
      </WikiMobileSheet>
    </main>
  )
}
const WikiBlockEditorAdapter = dynamic(() => import('../../components/wiki/WikiBlockEditorAdapter').then((mod) => mod.WikiBlockEditorAdapter), { ssr: false })
