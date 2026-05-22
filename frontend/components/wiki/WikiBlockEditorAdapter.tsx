import { useCallback, useEffect, useMemo, useRef } from 'react'
import { BlockNoteEditor } from '@blocknote/core'
import { BlockNoteViewRaw, useCreateBlockNote } from '@blocknote/react'

export type SelectionScope = 'text' | 'block' | 'multi_block'

export type SlashActionId = 'comment' | 'copy' | 'files'

export type SlashActionDefinition = {
  id: SlashActionId
  label: string
  aliases: string[]
}

export const MAX_SLASH_QUERY_LENGTH = 32
export const SLASH_ACTION_WHITELIST: SlashActionDefinition[] = [
  { id: 'comment', label: 'Comment', aliases: ['comment', 'komentar', 'komentář'] },
  { id: 'copy', label: 'Copy', aliases: ['copy', 'kopirovat', 'kopírovat'] },
  { id: 'files', label: 'Files', aliases: ['files', 'soubory'] }
]

const SLASH_ID_SET = new Set<SlashActionId>(SLASH_ACTION_WHITELIST.map((item) => item.id))

export function sanitizeSlashQuery(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input.toLowerCase().replace(/[^a-z0-9á-ž\s_-]/gi, '').trim().slice(0, MAX_SLASH_QUERY_LENGTH)
}

export function resolveSlashAction(input: unknown): SlashActionId | null {
  const query = sanitizeSlashQuery(input)
  if (!query) return null
  const found = SLASH_ACTION_WHITELIST.find((action) => action.aliases.includes(query) || action.id === query)
  if (!found) return null
  return SLASH_ID_SET.has(found.id) ? found.id : null
}

const SELECTION_SCOPES: SelectionScope[] = ['text', 'block', 'multi_block']
const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim()

function normalizeSelectionScope(value: unknown): SelectionScope {
  return typeof value === 'string' && (SELECTION_SCOPES as string[]).includes(value) ? (value as SelectionScope) : 'text'
}

type Props = {
  markdown: string
  onMarkdownChange: (markdown: string) => void
  onSelectionQuoteChange: (quote: string | null, snapshot: { quote: string; rect: { left: number; top: number; width: number; height: number } | null; scope: SelectionScope } | null) => void
  onSelectionScopeTransition?: (transition: { previous: SelectionScope; next: SelectionScope; reason: string }) => void
  onFocusChange?: (focused: boolean) => void
}

export function WikiBlockEditorAdapter({ markdown, onMarkdownChange, onSelectionQuoteChange, onSelectionScopeTransition, onFocusChange }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editor = useCreateBlockNote()
  const lastAppliedMarkdown = useRef<string>('')
  const latestMarkdownRef = useRef<string>(markdown || '')
  const markdownApplyVersionRef = useRef(0)
  const selectionFrameRef = useRef<number | null>(null)
  const lastSelectionScopeRef = useRef<SelectionScope>('text')

  latestMarkdownRef.current = markdown || ''

  const isNodeInsideRoot = (root: HTMLDivElement | null, node: Node | null): boolean => {
    if (!root || !node) return false
    if (root.contains(node)) return true

    let cursor: Node | null = node
    while (cursor) {
      if (cursor === root) return true
      const parentNode: Node | null = cursor.parentNode
      if (parentNode) {
        cursor = parentNode
        continue
      }
      const rootNode = cursor.getRootNode?.()
      if (rootNode && rootNode instanceof ShadowRoot) {
        cursor = rootNode.host
        continue
      }
      cursor = null
    }

    return false
  }

  const getBlockElement = useCallback((node: Node | null): HTMLElement | null => {
    if (!node) return null
    const element = node instanceof HTMLElement ? node : node.parentElement
    if (!element) return null
    return element.closest('[data-node-type="blockContainer"], .bn-block, p, li, h1, h2, h3, h4, h5, h6, blockquote, pre') as HTMLElement | null
  }, [])

  const detectScope = useCallback((range: Range, quote: string): SelectionScope => {
    const startBlock = getBlockElement(range.startContainer)
    const endBlock = getBlockElement(range.endContainer)
    if (!startBlock || !endBlock) return 'text'
    if (startBlock !== endBlock) return 'multi_block'
    const normalizedQuote = normalizeText(quote)
    const normalizedBlockText = normalizeText(startBlock.textContent || '')
    if (!normalizedQuote || !normalizedBlockText) return 'text'
    if (normalizedQuote === normalizedBlockText) return 'block'
    return 'text'
  }, [getBlockElement])

  const publishScopeTransition = useCallback((nextScope: SelectionScope, reason: string) => {
    const validatedNextScope = normalizeSelectionScope(nextScope)
    const previous = normalizeSelectionScope(lastSelectionScopeRef.current)
    if (previous !== validatedNextScope) {
      onSelectionScopeTransition?.({ previous, next: validatedNextScope, reason })
      lastSelectionScopeRef.current = validatedNextScope
    }
  }, [onSelectionScopeTransition])

  useEffect(() => {
    let cancelled = false
    const applyMarkdown = async () => {
      if (!editor) return
      const next = markdown || ''
      if (next === lastAppliedMarkdown.current) return
      const applyVersion = ++markdownApplyVersionRef.current
      const blocks = next.trim() ? await editor.tryParseMarkdownToBlocks(next) : ([{ type: 'paragraph' }] as any)
      if (cancelled) return
      if (applyVersion !== markdownApplyVersionRef.current) return
      if (next !== latestMarkdownRef.current) return
      editor.replaceBlocks(editor.document, blocks as any)
      lastAppliedMarkdown.current = next
    }
    void applyMarkdown()
    return () => {
      cancelled = true
    }
  }, [editor, markdown])

  const publishSelectionQuote = useCallback((mismatchRetries = 1) => {
    const selection = globalThis.getSelection?.()
    const snapshotRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null
    const snapshotQuote = selection?.toString().trim() || ''

    if (selectionFrameRef.current !== null) {
      globalThis.cancelAnimationFrame(selectionFrameRef.current)
    }
    selectionFrameRef.current = globalThis.requestAnimationFrame(() => {
      selectionFrameRef.current = null
      const root = rootRef.current
      if (!snapshotRange || snapshotRange.collapsed || snapshotQuote.length < 2) {
        publishScopeTransition('text', 'collapsed-or-short-selection')
        onSelectionQuoteChange(null, null)
        return
      }

      if (root && !isNodeInsideRoot(root, snapshotRange.commonAncestorContainer)) {
        const active = document.activeElement
        if (!(active instanceof Node) || !isNodeInsideRoot(root, active)) {
          if (mismatchRetries > 0 && snapshotQuote.length >= 2) {
            publishSelectionQuote(mismatchRetries - 1)
            return
          }
          const fallbackScope = normalizeSelectionScope(detectScope(snapshotRange, snapshotQuote))
          publishScopeTransition(fallbackScope, 'outside-root-fallback')
          onSelectionQuoteChange(snapshotQuote, { quote: snapshotQuote, rect: null, scope: fallbackScope })
          return
        }
      }

      const rect = snapshotRange.getBoundingClientRect()
      const geometry = rect.width > 0 && rect.height > 0
        ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : (Array.from(snapshotRange.getClientRects()).find((r) => r.width > 0 && r.height > 0)
          ? (() => {
              const fallback = Array.from(snapshotRange.getClientRects()).find((r) => r.width > 0 && r.height > 0)
              return fallback ? { left: fallback.left, top: fallback.top, width: fallback.width, height: fallback.height } : null
            })()
          : null)

      const detectedScope = normalizeSelectionScope(detectScope(snapshotRange, snapshotQuote))
      publishScopeTransition(detectedScope, geometry ? 'geometry-detected' : 'geometry-fallback')
      onSelectionQuoteChange(snapshotQuote, { quote: snapshotQuote, rect: geometry, scope: detectedScope })
    })
  }, [detectScope, onSelectionQuoteChange, publishScopeTransition])

  useEffect(() => {
    const onSelectionChange = () => {
      const root = rootRef.current
      const selection = globalThis.getSelection?.()
      const anchorNode = selection?.anchorNode ?? null
      const focusNode = selection?.focusNode ?? null
      const activeElement = document.activeElement instanceof Node ? document.activeElement : null

      if (
        root
        && !isNodeInsideRoot(root, anchorNode)
        && !isNodeInsideRoot(root, focusNode)
        && !isNodeInsideRoot(root, activeElement)
      ) {
        publishScopeTransition('text', 'outside-root-reset')
        onSelectionQuoteChange(null, null)
        return
      }

      publishSelectionQuote(1)
    }

    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      if (selectionFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(selectionFrameRef.current)
        selectionFrameRef.current = null
      }
    }
  }, [onSelectionQuoteChange, publishScopeTransition, publishSelectionQuote])

  const editorClassName = useMemo(() => 'wiki-blocknote-editor', [])

  return (
    <div ref={rootRef} className="wiki-blocknote-root" data-testid="wiki-editor-shell" onMouseUp={() => publishSelectionQuote(1)} onKeyUp={() => publishSelectionQuote(1)}>
      <BlockNoteViewRaw
        editor={editor as BlockNoteEditor}
        className={editorClassName}
        onChange={async () => {
          const next = await editor.blocksToMarkdownLossy(editor.document)
          lastAppliedMarkdown.current = next
          onMarkdownChange(next)
        }}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        formattingToolbar={false}
        sideMenu={false}
        slashMenu={false}
      />
    </div>
  )
}
