import type { ReactNode } from 'react'

type WikiMobileSheetProps = {
  title: string
  open: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  testId?: string
  selectionScope?: 'text' | 'block' | 'multi_block'
}

export function WikiMobileSheet({ title, open, onClose, children, footer, testId, selectionScope = 'text' }: WikiMobileSheetProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 lg:hidden" data-testid={testId} data-selection-scope={selectionScope}>
      <button
        type="button"
        aria-label="Close sheet"
        className="app-overlay-backdrop absolute inset-0"
        data-testid="wiki-mobile-overlay"
        onClick={onClose}
      />
      <section className="app-surface app-mobile-sheet absolute inset-x-0 bottom-0 max-h-[86dvh] overflow-hidden rounded-t-2xl border-x-0 border-b-0" data-testid="wiki-mobile-sheet-surface">
        <div className="flex items-center gap-3 border-b border-[var(--border-default)] px-4 py-3">
          <div className="h-1.5 w-10 rounded-full bg-[var(--border-strong)]" />
          <b className="min-w-0 flex-1 truncate text-sm">{title}</b>
          <button className="app-button-secondary rounded-md px-3 py-1.5 text-xs" onClick={onClose}>Close</button>
        </div>
        <div className="max-h-[calc(86dvh-7.5rem)] overflow-auto p-4">
          {children}
        </div>
        {footer && (
          <div className="border-t border-[var(--border-default)] p-4">
            {footer}
          </div>
        )}
      </section>
    </div>
  )
}
