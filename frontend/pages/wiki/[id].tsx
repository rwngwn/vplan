import { useRouter } from 'next/router'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import useSWR from 'swr'
import { SLASH_ACTION_WHITELIST, sanitizeSlashQuery, resolveSlashAction, type SelectionScope, type SlashActionId } from '../../components/wiki/WikiBlockEditorAdapter'

import { WikiAnnotationsPanel } from '../../components/wiki/WikiAnnotationsPanel'
import { WikiMobileSheet } from '../../components/wiki/WikiMobileSheet'
import { WikiSidebar } from '../../components/wiki/WikiSidebar'
import { confirmAIOperation, createDocumentAnnotation, createFolder, createNote, deleteDocumentAnnotation, documentAnnotationToFrontendEntity, fetchFeatureFlags, fetchFolders, fetchNotes, listDocumentAnnotations, previewAIOperation, undoAIOperation, updateNote, type FeatureFlags, type FrontendAnnotationEntity, type KnowledgeNote } from '../../lib/api'
import { t } from '../../lib/i18n'

const VALID_SELECTION_SCOPES: SelectionScope[] = ['text', 'block', 'multi_block']
const AI_PROMPT_MIN_LENGTH = 2
const AI_PROMPT_MAX_LENGTH = 2000
const normalizePageSelectionScope = (scope: unknown): SelectionScope => (
  typeof scope === 'string' && (VALID_SELECTION_SCOPES as string[]).includes(scope)
    ? (scope as SelectionScope)
    : 'text'
)

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
  const editorShellRef = useRef<HTMLDivElement | null>(null)
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags | null>(null)
  const [metadataAnnotations, setMetadataAnnotations] = useState<FrontendAnnotationEntity[]>([])
  const [annotationError, setAnnotationError] = useState('')
  const [selectionToolbar, setSelectionToolbar] = useState<{ x: number; y: number; quote: string } | null>(null)
  const [selectionScope, setSelectionScope] = useState<SelectionScope>('text')
  const [commentPopover, setCommentPopover] = useState<{ x: number; y: number; quote: string } | null>(null)
  const [draftHighlightRects, setDraftHighlightRects] = useState<Array<{ left: number; top: number; width: number; height: number }>>([])
  const [contextComment, setContextComment] = useState('')
  const [researchState, setResearchState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [mobileSheet, setMobileSheet] = useState<'files' | 'annotations' | 'comment' | 'ai' | null>(null)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiState, setAiState] = useState<'idle' | 'preview' | 'confirm' | 'applied' | 'undo' | 'error'>('idle')
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [aiOperationId, setAiOperationId] = useState('')
  const [aiBaseVersion, setAiBaseVersion] = useState(1)
  const [aiPreviewContent, setAiPreviewContent] = useState('')
  const [aiStatusMessage, setAiStatusMessage] = useState('Idle')
  const [aiLastAppliedOperationId, setAiLastAppliedOperationId] = useState('')
  const [aiPreConfirmSnapshot, setAiPreConfirmSnapshot] = useState('')
  const [aiMetrics, setAiMetrics] = useState({ previewOpened: 0, confirmSuccess: 0, undoSuccess: 0, autoApplyViolations: 0 })
  const aiConfirmInFlightRef = useRef(false)
  const [slashMenu, setSlashMenu] = useState<{ query: string; items: Array<{ id: SlashActionId; label: string }>; noMatch: boolean; mobile: boolean } | null>(null)
  const slashExecuteGuardRef = useRef<{ action: SlashActionId; at: number } | null>(null)
  const slashMetricsRef = useRef({ blockedAttempts: 0, executed: 0 })
  const selectionToolbarRetryFrameRef = useRef<number | null>(null)

  const isSelectionScopeV2Enabled = featureFlags?.selection_scope_v2_enabled === true
  const allowedActionsByScope: Record<SelectionScope, Array<'copy' | 'comment'>> = useMemo(() => ({
    text: ['copy', 'comment'],
    block: ['copy'],
    multi_block: ['copy']
  }), [])
  const resolvedScope: SelectionScope = isSelectionScopeV2Enabled ? selectionScope : 'text'
  const isActionAllowed = useCallback((action: 'copy' | 'comment') => allowedActionsByScope[resolvedScope].includes(action), [allowedActionsByScope, resolvedScope])

  const persistWiki = useCallback(async () => {
    if (!noteId) return
    await updateNote(noteId, { title, body: markdownBody })
  }, [noteId, title, markdownBody])

  useEffect(() => {
    let alive = true
    fetchFeatureFlags().then((next) => {
      if (alive) setFeatureFlags(next)
    }).catch(() => {
      if (alive) setFeatureFlags({ annotations_v2_enabled: false, dual_write_enabled: false, ai_confirm_required: true, selection_scope_v2_enabled: false })
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!noteId) {
      setMetadataAnnotations([])
      return
    }
    let alive = true
    listDocumentAnnotations(noteId).then((items) => {
      if (!alive) return
      setMetadataAnnotations(items.map(documentAnnotationToFrontendEntity))
    }).catch(() => {
      if (alive) setAnnotationError('Nepodařilo se uložit komentář.')
    })
    return () => {
      alive = false
    }
  }, [noteId])

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

  const emitAiMetric = useCallback((name: 'previewOpened' | 'confirmSuccess' | 'undoSuccess' | 'autoApplyViolations') => {
    setAiMetrics((prev) => {
      const next = { ...prev, [name]: prev[name] + 1 }
      document.dispatchEvent(new CustomEvent('wiki:ai-metric', { detail: { ...next } }))
      return next
    })
  }, [])

  const openAiAssistant = useCallback(() => {
    setAiPanelOpen(true)
    if (globalThis.matchMedia?.('(max-width: 1023px)').matches) setMobileSheet('ai')
    emitAiMetric('previewOpened')
  }, [emitAiMetric])

  const runAiPreview = useCallback(async () => {
    if (!noteId) return
    const normalizedPrompt = aiPrompt.trim()
    if (normalizedPrompt.length < AI_PROMPT_MIN_LENGTH || normalizedPrompt.length > AI_PROMPT_MAX_LENGTH) {
      setAiState('error')
      setAiStatusMessage('Preview failed')
      return
    }
    try {
      const preview = await previewAIOperation(noteId, { prompt: normalizedPrompt, operation_id: aiOperationId || `op-${Date.now()}`, base_version: aiBaseVersion })
      if (preview.persisted) {
        emitAiMetric('autoApplyViolations')
      }
      setAiState('preview')
      setAiStatusMessage('Preview ready')
      setAiOperationId(preview.operation_id)
      setAiBaseVersion(preview.base_version)
      setAiPreviewContent(preview.proposed_content)
    } catch (error) {
      setAiState('error')
      setAiStatusMessage(error instanceof Error && error.message === 'ai-stale-preview' ? 'Stale preview conflict' : 'Preview failed')
    }
  }, [aiBaseVersion, aiOperationId, aiPrompt, emitAiMetric, noteId])

  const runAiConfirm = useCallback(async () => {
    if (!noteId || !aiOperationId) return
    if (aiConfirmInFlightRef.current) {
      setAiState('error')
      setAiStatusMessage('Duplicate confirm blocked')
      return
    }
    aiConfirmInFlightRef.current = true
    setAiState('confirm')
    try {
      const confirmation = await confirmAIOperation(noteId, { operation_id: aiOperationId, base_version: aiBaseVersion })
      if (confirmation.idempotent || aiLastAppliedOperationId === confirmation.operation_id) {
        setAiState('error')
        setAiStatusMessage('Duplicate confirm blocked')
        return
      }
      setAiState('applied')
      setAiStatusMessage('Applied')
      setAiLastAppliedOperationId(confirmation.operation_id)
      setAiPreConfirmSnapshot(markdownBody)
      setAiBaseVersion(confirmation.version)
      setMarkdownBody(aiPreviewContent)
      setIsDirty(true)
      emitAiMetric('confirmSuccess')
    } catch (error) {
      setAiState('error')
      setAiStatusMessage(error instanceof Error && error.message === 'ai-stale-preview' ? 'Stale preview conflict' : 'Confirm failed')
    } finally {
      aiConfirmInFlightRef.current = false
    }
  }, [aiBaseVersion, aiLastAppliedOperationId, aiOperationId, aiPreviewContent, emitAiMetric, markdownBody, noteId])

  const runAiUndo = useCallback(async () => {
    if (!noteId || aiState !== 'applied') {
      setAiState('error')
      setAiStatusMessage('Undo unavailable')
      return
    }
    try {
      const undo = await undoAIOperation(noteId)
      setAiState('undo')
      setAiStatusMessage('Undone')
      setAiBaseVersion(undo.version)
      if (aiPreConfirmSnapshot) {
        setMarkdownBody(aiPreConfirmSnapshot)
        setIsDirty(true)
      }
      setAiPreConfirmSnapshot('')
      emitAiMetric('undoSuccess')
    } catch (error) {
      setAiState('error')
      setAiStatusMessage(error instanceof Error && error.message === 'ai-undo-unavailable' ? 'Undo unavailable' : 'Undo failed')
    }
  }, [aiPreConfirmSnapshot, aiState, emitAiMetric, noteId])

  const dismissAiPreview = useCallback(() => {
    setAiState('idle')
    setAiPreviewContent('')
    setAiStatusMessage('Idle')
    setAiOperationId('')
  }, [])

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

  const appendMetadataAnnotation = async (quoteText: string, commentText: string) => {
    if (!noteId) return
    const comment = commentText.trim()
    const quote = quoteText.trim()
    if (!comment || comment.length > 500 || quote.length > 1000) {
      setAnnotationError('Nepodařilo se uložit komentář.')
      return
    }
    const escapedComment = comment.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const escapedQuote = quote.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const instruction = JSON.stringify({ comment: escapedComment, quote: escapedQuote })
    const optimisticId = `tmp-${Date.now()}`
    const optimistic: FrontendAnnotationEntity = {
      id: optimisticId,
      comment: escapedComment,
      quote: escapedQuote,
      status: 'open',
      when: 'now',
      author: 'You',
      line: 1,
      anchor: { scope: 'text', line: 1, start_offset: null, end_offset: null, source: 'api' },
      version: 1,
    }
    setMetadataAnnotations((prev) => [optimistic, ...prev])
    setAnnotationError('')
    try {
      const created = await createDocumentAnnotation(noteId, { scope: 'text', instruction, line_no: 1 })
      setMetadataAnnotations((prev) => prev.map((item) => item.id === optimisticId ? { ...item, id: created.id, version: created.version } : item))
      setShowPanel(true)
      setAnnotationTab('open')
    } catch {
      setMetadataAnnotations((prev) => prev.filter((item) => item.id !== optimisticId))
      setAnnotationError('Nepodařilo se uložit komentář.')
      throw new Error('annotation-create-failed')
    }
  }

  const openCommentComposer = useCallback((quote: string, position?: { x: number; y: number }) => {
    if (!isActionAllowed('comment')) return
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
  }, [isActionAllowed])

  const saveContextComment = async () => {
    if (!commentPopover || !contextComment.trim()) return
    try {
      await appendMetadataAnnotation(commentPopover.quote, contextComment)
      setCommentPopover(null)
      setSelectionToolbar(null)
      setContextComment('')
      setDraftHighlightRects([])
      setMobileSheet(null)
    } catch {
      // keep composer open to preserve deterministic recovery
    }
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
    setSelectionScope('text')
  }

  const publishSlashMetrics = useCallback(() => {
    const metrics = {
      blockedAttempts: slashMetricsRef.current.blockedAttempts,
      executed: slashMetricsRef.current.executed,
      executionRate: slashMetricsRef.current.executed === 0
        ? 0
        : slashMetricsRef.current.executed / (slashMetricsRef.current.executed + slashMetricsRef.current.blockedAttempts)
    }
    document.dispatchEvent(new CustomEvent('wiki:slash-metrics', { detail: metrics }))
  }, [])

  const blockedSlashAttempt = useCallback((query: string, reason: string) => {
    slashMetricsRef.current.blockedAttempts += 1
    publishSlashMetrics()
    document.dispatchEvent(new CustomEvent('wiki:slash-blocked', { detail: { query, reason } }))
  }, [publishSlashMetrics])

  const executeSlashAction = useCallback((candidate: unknown, source: 'keyboard' | 'touch') => {
    const action = resolveSlashAction(candidate)
    if (!action) {
      blockedSlashAttempt(String(candidate || ''), 'unknown-command')
      return
    }

    const guard = slashExecuteGuardRef.current
    const now = Date.now()
    if (guard && guard.action === action && now - guard.at < 250) {
      return
    }
    slashExecuteGuardRef.current = { action, at: now }

    if (action === 'comment') {
      if (!selectionToolbar?.quote || !isActionAllowed('comment')) {
        blockedSlashAttempt(String(candidate || ''), 'comment-unavailable')
        return
      }
      openCommentComposer(selectionToolbar.quote)
    } else if (action === 'copy') {
      if (!selectionToolbar?.quote) {
        blockedSlashAttempt(String(candidate || ''), 'copy-unavailable')
        return
      }
      void navigator.clipboard?.writeText(selectionToolbar.quote)
    } else if (action === 'files') {
      if (globalThis.matchMedia?.('(max-width: 1023px)').matches) {
        setMobileSheet('files')
      }
    }

    slashMetricsRef.current.executed += 1
    publishSlashMetrics()
    document.dispatchEvent(new CustomEvent('wiki:slash-executed', { detail: { action, source } }))
    setSlashMenu(null)
  }, [blockedSlashAttempt, isActionAllowed, openCommentComposer, publishSlashMetrics, selectionToolbar?.quote])

  const openSlashMenu = useCallback((rawQuery: string, mobile: boolean) => {
    const query = sanitizeSlashQuery(rawQuery)
    const items = SLASH_ACTION_WHITELIST.filter((item) => {
      if (!query) return true
      return item.id.includes(query) || item.aliases.some((alias) => alias.includes(query))
    }).map((item) => ({ id: item.id, label: item.label }))
    setSlashMenu({ query, items, noMatch: items.length === 0, mobile })
  }, [])

  const onSlashInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setSlashMenu(null)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const query = sanitizeSlashQuery(event.currentTarget.value.replace(/^\//, ''))
      if (!query) {
        openSlashMenu('', globalThis.matchMedia?.('(max-width: 1023px)').matches === true)
        return
      }
      if (slashMenu?.items?.length) {
        executeSlashAction(slashMenu.items[0].id, 'keyboard')
      } else {
        blockedSlashAttempt(query, 'no-match')
      }
    }
  }, [blockedSlashAttempt, executeSlashAction, openSlashMenu, slashMenu?.items])

  const logSelectionScopeTransition = useCallback((transition: { previous: SelectionScope; next: SelectionScope; reason: string }) => {
    console.debug('[wiki-selection-scope-transition]', transition)
    document.dispatchEvent(new CustomEvent('wiki:selection-scope-transition', { detail: transition }))
  }, [])

  useEffect(() => {
    return () => {
      if (selectionToolbarRetryFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(selectionToolbarRetryFrameRef.current)
        selectionToolbarRetryFrameRef.current = null
      }
    }
  }, [])

  const annotations = metadataAnnotations
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
        const intent = guessIntent(`${a.comment} ${a.quote}`)
        return `## ${idx + 1}. ${intent.toUpperCase()}\n- komentář: ${a.comment}\n- citace: "${a.quote}"\n- další krok: Připravit ověřené zdroje, shrnutí a doporučení.`
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

  const annotationsContent = <WikiAnnotationsPanel annotationTab={annotationTab} openAnnotations={openAnnotations} resolvedAnnotations={resolvedAnnotations} visibleAnnotations={visibleAnnotations} researchState={researchState} errorMessage={annotationError} onAnnotationTabChange={setAnnotationTab} onProcessOpenAnnotations={onProcessOpenAnnotations} onResolveAnnotation={async (id) => {
    if (noteId) {
      setMetadataAnnotations((prev) => prev.map((item) => item.id === id ? { ...item, status: 'resolved' } : item))
      try {
        await deleteDocumentAnnotation(noteId, id)
      } catch {
        setMetadataAnnotations((prev) => prev.map((item) => item.id === id ? { ...item, status: 'open' } : item))
        setAnnotationError('Nepodařilo se uložit komentář.')
      }
      return
    }
  }} onClose={() => globalThis.matchMedia?.('(max-width: 1023px)').matches ? setMobileSheet(null) : setShowPanel(false)} />

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
            <div className="mb-2 hidden lg:block">
              <button type="button" className="app-button-secondary rounded-md px-3 py-2 text-xs" data-testid="wiki-ai-trigger-desktop" onClick={openAiAssistant}>AI helper</button>
            </div>
            <input
              className="app-field mb-3 w-full rounded-lg px-3 py-2 text-sm"
              placeholder="/ command"
              data-testid="wiki-slash-input"
              onFocus={() => openSlashMenu('', globalThis.matchMedia?.('(max-width: 1023px)').matches === true)}
              onChange={(e) => openSlashMenu(e.target.value.replace(/^\//, ''), globalThis.matchMedia?.('(max-width: 1023px)').matches === true)}
              onKeyDown={onSlashInputKeyDown}
            />
            {slashMenu && !slashMenu.mobile && <div className="app-slash-menu" data-testid="wiki-slash-menu-desktop">
              {slashMenu.noMatch ? <div className="app-slash-empty" data-testid="wiki-slash-no-match">No matching commands</div> : slashMenu.items.map((item) => (
                <button key={item.id} type="button" className="app-slash-item" data-testid={`wiki-slash-item-${item.id}`} onClick={() => executeSlashAction(item.id, 'touch')}>
                  {item.label}
                </button>
              ))}
            </div>}

            <div ref={editorShellRef} className="app-document-editor app-editor-shell relative">
              <WikiBlockEditorAdapter
                markdown={markdownBody}
                onMarkdownChange={(next) => {
                  setMarkdownBody(next)
                  setIsDirty(true)
                }}
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
                    setSelectionScope('text')
                    return
                  }

                  setSelectionScope(normalizePageSelectionScope(snapshot?.scope))

                  if (selectionToolbarRetryFrameRef.current !== null) {
                    globalThis.cancelAnimationFrame(selectionToolbarRetryFrameRef.current)
                    selectionToolbarRetryFrameRef.current = null
                  }
                  updateSelectionToolbar(quote, snapshot, 0)
                }}
                onSelectionScopeTransition={logSelectionScopeTransition}
              />

              {draftHighlightRects.map((rect, idx) => <div key={`draft-rect-${idx}`} className="wiki-draft-selection-highlight app-selection-highlight pointer-events-none absolute rounded-[3px]" data-testid="wiki-draft-selection-highlight" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />)}

              {selectionToolbar && <div className="app-selection-toolbar hidden lg:flex" data-testid="wiki-selection-toolbar" data-selection-scope={resolvedScope} style={{ left: selectionToolbar.x, top: selectionToolbar.y }} onMouseDown={(e) => e.preventDefault()}>
                <button type="button" data-testid="wiki-selection-copy-button" onMouseDown={(e) => e.preventDefault()} onClick={() => selectionToolbar.quote && navigator.clipboard?.writeText(selectionToolbar.quote)}>Copy</button>
                {isActionAllowed('comment') && <button type="button" data-testid="wiki-selection-comment-button" onMouseDown={(e) => e.preventDefault()} onClick={() => openCommentComposer(selectionToolbar.quote, { x: selectionToolbar.x, y: selectionToolbar.y + 14 })}>Comment</button>}
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
            {aiPanelOpen && <div className="app-ai-popup mt-3 hidden rounded-lg border border-[var(--border-default)] p-3 lg:block" data-testid="wiki-ai-popup-desktop">
              <textarea className="app-field min-h-20 w-full rounded p-2 text-sm" data-testid="wiki-ai-prompt-input" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="Ask AI to propose edit" />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="app-button-secondary rounded px-2 py-1 text-xs" data-testid="wiki-ai-preview-submit" onClick={runAiPreview}>Preview</button>
                <button type="button" className="app-button-primary rounded px-2 py-1 text-xs" data-testid="wiki-ai-confirm-submit" onClick={runAiConfirm}>Confirm</button>
                <button type="button" className="app-button-secondary rounded px-2 py-1 text-xs" data-testid="wiki-ai-undo-submit" onClick={runAiUndo}>Undo</button>
                <button type="button" className="app-button-secondary rounded px-2 py-1 text-xs" data-testid="wiki-ai-dismiss-preview" onClick={dismissAiPreview}>Dismiss</button>
              </div>
              <div className="app-text-faint mt-2 text-xs" data-testid="wiki-ai-status">{aiStatusMessage}</div>
              {aiState === 'preview' && <pre className="app-ai-preview mt-2" data-testid="wiki-ai-preview-content">{aiPreviewContent}</pre>}
            </div>}
          </div>
        </section>

        {showPanel && <aside className="app-surface hidden h-[calc(100vh-2rem)] overflow-hidden rounded-xl lg:block">{annotationsContent}</aside>}
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border-default)] bg-[var(--bg-base)]/95 px-3 py-2 backdrop-blur lg:hidden" data-testid="wiki-mobile-bottom-nav">
        {selectionToolbar ? <div className={`grid gap-2 ${isActionAllowed('comment') ? 'grid-cols-[1fr_1fr_auto]' : 'grid-cols-[1fr_auto]'}`} data-testid="wiki-mobile-selection-actions" data-selection-scope={resolvedScope} onMouseDown={(e) => e.preventDefault()}>
          {isActionAllowed('comment') && <button className="app-button-primary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-comment" onMouseDown={(e) => e.preventDefault()} onClick={() => openCommentComposer(selectionToolbar.quote)}>Komentář</button>}
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-copy" onMouseDown={(e) => e.preventDefault()} onClick={() => selectionToolbar.quote && navigator.clipboard?.writeText(selectionToolbar.quote)}>Kopírovat</button>
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-close" onMouseDown={(e) => e.preventDefault()} onClick={clearSelectionToolbar}>Zrušit</button>
        </div> : <div className="grid grid-cols-2 gap-2">
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-comments" onClick={() => setMobileSheet('annotations')}>Komentáře <span className="ml-1 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[10px]">{openAnnotations.length}</span></button>
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-mobile-nav-files" onClick={() => setMobileSheet('files')}>Soubory</button>
          <button className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-ai-trigger-mobile" onClick={openAiAssistant}>AI</button>
        </div>}
      </nav>

      <WikiMobileSheet title="Soubory" open={mobileSheet === 'files'} onClose={() => setMobileSheet(null)} testId="wiki-mobile-files-sheet" selectionScope={resolvedScope}><div className="app-sidebar flex min-h-[60dvh] flex-col">{sidebarContent}</div></WikiMobileSheet>
      <WikiMobileSheet title="Komentáře" open={mobileSheet === 'annotations'} onClose={() => setMobileSheet(null)} testId="wiki-mobile-comments-sheet" selectionScope={resolvedScope}><div className="-m-4">{annotationsContent}</div></WikiMobileSheet>
      <WikiMobileSheet title="Přidat komentář" open={mobileSheet === 'comment' && Boolean(commentPopover)} onClose={cancelContextComment} testId="wiki-mobile-comment-sheet" selectionScope={resolvedScope} footer={<div className="flex justify-end gap-2"><button className="app-button-secondary rounded-md px-3 py-2 text-sm" onClick={cancelContextComment}>Zrušit</button><button className="app-button-primary rounded-md px-4 py-2 text-sm" onClick={saveContextComment}>Uložit</button></div>}>
        {commentPopover && <div className="space-y-3"><div className="app-selection-quote rounded-lg p-3 text-sm leading-5">&quot;{commentPopover.quote}&quot;</div><textarea className="app-field min-h-32 w-full rounded-lg p-3 text-sm" data-testid="wiki-comment-textarea" placeholder="Přidej komentář..." value={contextComment} onChange={(e) => setContextComment(e.target.value)} /></div>}
      </WikiMobileSheet>
      <WikiMobileSheet title="Slash menu" open={Boolean(slashMenu?.mobile)} onClose={() => setSlashMenu(null)} testId="wiki-mobile-slash-sheet" selectionScope={resolvedScope}>
        <div className="space-y-2">
          {slashMenu?.noMatch ? <div className="app-slash-empty" data-testid="wiki-slash-no-match">No matching commands</div> : slashMenu?.items.map((item) => (
            <button key={item.id} type="button" className="app-slash-item w-full text-left" data-testid={`wiki-mobile-slash-item-${item.id}`} onClick={() => executeSlashAction(item.id, 'touch')}>
              {item.label}
            </button>
          ))}
        </div>
      </WikiMobileSheet>
      <WikiMobileSheet title="AI helper" open={mobileSheet === 'ai'} onClose={() => setMobileSheet(null)} testId="wiki-mobile-ai-sheet" selectionScope={resolvedScope}>
        <div className="space-y-3">
          <textarea className="app-field min-h-28 w-full rounded-lg p-3 text-sm" data-testid="wiki-ai-prompt-input" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="Ask AI to propose edit" />
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-ai-preview-submit" onClick={runAiPreview}>Preview</button>
            <button type="button" className="app-button-primary rounded-md px-3 py-2 text-sm" data-testid="wiki-ai-confirm-submit" onClick={runAiConfirm}>Confirm</button>
            <button type="button" className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-ai-undo-submit" onClick={runAiUndo}>Undo</button>
            <button type="button" className="app-button-secondary rounded-md px-3 py-2 text-sm" data-testid="wiki-ai-dismiss-preview" onClick={dismissAiPreview}>Dismiss</button>
          </div>
          <div className="app-text-faint text-xs" data-testid="wiki-ai-status">{aiStatusMessage}</div>
          {aiState === 'preview' && <pre className="app-ai-preview" data-testid="wiki-ai-preview-content">{aiPreviewContent}</pre>}
        </div>
      </WikiMobileSheet>
      <div className="hidden" aria-hidden="true">
        <span data-testid="wiki-ai-metric-preview-opened">{aiMetrics.previewOpened}</span>
        <span data-testid="wiki-ai-metric-confirm-success">{aiMetrics.confirmSuccess}</span>
        <span data-testid="wiki-ai-metric-undo-success">{aiMetrics.undoSuccess}</span>
        <span data-testid="wiki-ai-metric-auto-apply-violations">{aiMetrics.autoApplyViolations}</span>
      </div>
    </main>
  )
}
const WikiBlockEditorAdapter = dynamic(() => import('../../components/wiki/WikiBlockEditorAdapter').then((mod) => mod.WikiBlockEditorAdapter), { ssr: false })
