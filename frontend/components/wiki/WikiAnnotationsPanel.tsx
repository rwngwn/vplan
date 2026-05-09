type WikiAnnotation = {
  id: string
  body: string
  quote: string
  status: 'open' | 'resolved'
  when: string
  author: string
}

type WikiAnnotationsPanelProps = {
  annotationTab: 'open' | 'resolved'
  openAnnotations: WikiAnnotation[]
  resolvedAnnotations: WikiAnnotation[]
  visibleAnnotations: WikiAnnotation[]
  researchState: 'idle' | 'running' | 'done' | 'error'
  onAnnotationTabChange: (tab: 'open' | 'resolved') => void
  onProcessOpenAnnotations: () => void
  onResolveAnnotation: (id: string) => void
  onClose?: () => void
}

export function WikiAnnotationsPanel({
  annotationTab,
  openAnnotations,
  resolvedAnnotations,
  visibleAnnotations,
  researchState,
  onAnnotationTabChange,
  onProcessOpenAnnotations,
  onResolveAnnotation,
  onClose
}: WikiAnnotationsPanelProps) {
  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--border-default)] px-3 py-3">
        <b className="text-sm">Annotations</b>
        <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs">{openAnnotations.length}</span>
        {onClose && <button className="ml-auto app-button-secondary rounded px-2 py-1 text-xs" onClick={onClose}>x</button>}
      </div>
      <div className="flex gap-2 border-b border-[var(--border-default)] px-3 py-2 text-xs">
        <button className={`rounded px-2 py-1 ${annotationTab === 'open' ? 'bg-[var(--bg-elevated)]' : ''}`} onClick={() => onAnnotationTabChange('open')}>Open ({openAnnotations.length})</button>
        <button className={`rounded px-2 py-1 ${annotationTab === 'resolved' ? 'bg-[var(--bg-elevated)]' : ''}`} onClick={() => onAnnotationTabChange('resolved')}>Resolved ({resolvedAnnotations.length})</button>
        <button
          className="ml-auto app-button-primary rounded px-2 py-1 text-[11px]"
          disabled={researchState === 'running' || openAnnotations.length === 0}
          onClick={onProcessOpenAnnotations}
        >
          {researchState === 'running' ? 'Processing...' : 'Process open annotations'}
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
                    onClick={() => onResolveAnnotation(a.id)}
                  >resolve</button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  )
}

export type { WikiAnnotation }
