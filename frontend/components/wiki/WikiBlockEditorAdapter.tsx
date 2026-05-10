import { useCallback, useEffect, useMemo, useRef } from 'react'
import { BlockNoteEditor } from '@blocknote/core'
import { BlockNoteViewRaw, useCreateBlockNote } from '@blocknote/react'

type Props = {
  markdown: string
  onMarkdownChange: (markdown: string) => void
  onSelectionQuoteChange: (quote: string | null, snapshot: { quote: string; rect: { left: number; top: number; width: number; height: number } | null } | null) => void
  onFocusChange?: (focused: boolean) => void
  pendingAnnotation: { quote: string; comment: string } | null
  onPendingAnnotationApplied: () => void
}

export function WikiBlockEditorAdapter({ markdown, onMarkdownChange, onSelectionQuoteChange, onFocusChange, pendingAnnotation, onPendingAnnotationApplied }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const editor = useCreateBlockNote()
  const lastAppliedMarkdown = useRef<string>('')
  const latestMarkdownRef = useRef<string>(markdown || '')
  const markdownApplyVersionRef = useRef(0)
  const selectionFrameRef = useRef<number | null>(null)

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

  useEffect(() => {
    const appendPending = async () => {
      if (!editor || !pendingAnnotation) return
      const snippet = `\n\n[[agent: ${pendingAnnotation.comment} | quote: ${pendingAnnotation.quote}]]`
      const existing = await editor.blocksToMarkdownLossy(editor.document)
      const next = `${existing}${snippet}`
      const blocks = await editor.tryParseMarkdownToBlocks(next)
      editor.replaceBlocks(editor.document, blocks as any)
      lastAppliedMarkdown.current = next
      onMarkdownChange(next)
      onPendingAnnotationApplied()
    }
    void appendPending()
  }, [editor, onMarkdownChange, onPendingAnnotationApplied, pendingAnnotation])

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
          onSelectionQuoteChange(snapshotQuote, { quote: snapshotQuote, rect: null })
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

      onSelectionQuoteChange(snapshotQuote, { quote: snapshotQuote, rect: geometry })
    })
  }, [onSelectionQuoteChange])

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
  }, [publishSelectionQuote])

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
