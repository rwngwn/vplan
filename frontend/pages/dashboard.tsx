import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'

import { createNote, fetchNotes, fetchTasks, getTelemetry, importHnDigests, recordTaskDashboardView, Task } from '../lib/api'
import { t } from '../lib/i18n'

const STATUSES: Task['status'][] = ['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled']

export default function Dashboard() {
  const { data, isLoading } = useSWR('tasks', () => fetchTasks(), { refreshInterval: 4000 })
  const { data: notes, mutate: mutateNotes } = useSWR('notes', fetchNotes)
  const { data: telemetry } = useSWR('telemetry', getTelemetry, { refreshInterval: 3000 })
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<Task['status'] | ''>('')
  const [visibleMobileStatus, setVisibleMobileStatus] = useState<Task['status']>('open')
  const [newNoteTitle, setNewNoteTitle] = useState('')
  const [importState, setImportState] = useState('')

  useEffect(() => { recordTaskDashboardView() }, [])

  const filtered = useMemo(() => {
    const items = data || []
    return items.filter((t) => {
      const q = !query.trim() || t.title.toLowerCase().includes(query.toLowerCase()) || t.id.includes(query)
      const s = !statusFilter || t.status === statusFilter
      return q && s
    })
  }, [data, query, statusFilter])

  const onCreateNote = async () => {
    if (!newNoteTitle.trim()) return
    await createNote(newNoteTitle.trim())
    setNewNoteTitle('')
    await mutateNotes()
  }

  const onImportHn = async () => {
    setImportState(t('dashboard.importingHn'))
    try {
      const r = await importHnDigests(20)
      setImportState(t('dashboard.importDone', r.imported, r.skipped))
      await mutateNotes()
    } catch {
      setImportState(t('dashboard.importFailed'))
    } finally {
      setTimeout(() => setImportState(''), 3000)
    }
  }

  return (
    <main className="app-page min-h-screen p-3 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <h1 className="app-title">{t('dashboard.title')}</h1>

        <section className="app-surface rounded-lg p-4">
          <h2 className="app-section-title">{t('dashboard.wikiSection')}</h2>
          <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]">
            <input value={newNoteTitle} onChange={(e) => setNewNoteTitle(e.target.value)} placeholder={t('dashboard.newNotePlaceholder')} className="app-field min-w-0 rounded px-3 py-2" />
            <button onClick={onCreateNote} className="app-button-primary rounded px-4 py-2 font-medium">{t('dashboard.createNote')}</button>
            <button onClick={onImportHn} className="app-button-secondary rounded px-4 py-2">{t('dashboard.importHn')}</button>
          </div>
          {importState && <p className="app-text-muted mt-2 text-xs">{importState}</p>}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(notes || []).map((n) => (
              <Link key={n.id} href={`/wiki/${n.id}`} className="app-muted-panel block rounded p-2 hover:bg-[var(--bg-elevated)]">
                <p className="text-sm font-medium">{n.title}</p>
                <p className="app-text-faint text-[11px]">{n.id}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="app-surface rounded-lg p-4">
          <h2 className="app-section-title">{t('dashboard.taskTelemetry')}</h2>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('dashboard.searchTasks')} className="app-field min-w-0 flex-1 rounded px-3 py-2" />
            <select
              value={statusFilter}
              onChange={(e) => {
                const nextStatus = e.target.value as Task['status'] | ''
                setStatusFilter(nextStatus)
                if (nextStatus) setVisibleMobileStatus(nextStatus)
              }}
              className="app-field w-full rounded px-3 py-2 text-sm sm:w-auto"
            >
              <option value="">{t('dashboard.allStatuses')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
            </select>
          </div>

          <div className="app-text-muted mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded bg-[var(--bg-elevated)] px-2 py-1">{t('dashboard.metricTelegramToTask')}: {telemetry?.telegram_to_task_success ?? 0}</span>
            <span className="rounded bg-[var(--bg-elevated)] px-2 py-1">{t('dashboard.metricAutoAnalysisRuns')}: {telemetry?.auto_analysis_runs ?? 0}</span>
            <span className="rounded bg-[var(--bg-elevated)] px-2 py-1">{t('dashboard.metricInvalidStatusAttempts')}: {telemetry?.status_transition_invalid_attempts ?? 0}</span>
          </div>

          {isLoading && <p className="app-text-faint mt-3">{t('dashboard.loading')}</p>}
          <div className="mt-4 flex gap-1 overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--bg-field)] p-1 sm:hidden" role="tablist" aria-label={t('dashboard.mobileStatusFilter')}>
            {STATUSES.map((status) => {
              const isActive = visibleMobileStatus === status
              const count = filtered.filter((t) => t.status === status).length
              return (
                <button
                  key={status}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setVisibleMobileStatus(status)}
                  className={`shrink-0 rounded px-3 py-2 text-xs font-medium ${isActive ? 'app-button-primary' : 'app-button-secondary'}`}
                >
                  {t(`status.${status}`)} ({count})
                </button>
              )
            })}
          </div>

          <section className="app-muted-panel mt-3 rounded-lg p-3 sm:hidden">
            <h3 className="app-kicker mb-2">
              {t(`status.${visibleMobileStatus}`)} ({filtered.filter((task) => task.status === visibleMobileStatus).length})
            </h3>
            <div className="space-y-2">
              {filtered.filter((task) => task.status === visibleMobileStatus).map((task) => (
                <div key={task.id} className="app-elevated rounded p-2">
                  <p className="text-sm font-medium">{task.title}</p>
                  <p className="app-text-faint text-[11px]">{task.source_type}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link href={`/wiki/${task.source_ref || task.id}`} className="app-button-primary rounded px-2 py-1 text-xs">{t('dashboard.wikiReview')}</Link>
                    <Link href={`/tasks/${task.id}`} className="app-button-secondary rounded px-2 py-1 text-xs">{t('dashboard.statusDetail')}</Link>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="mt-4 hidden gap-3 sm:grid sm:grid-cols-2 xl:grid-cols-3">
            {STATUSES.map((status) => {
              const items = filtered.filter((t) => t.status === status)
              return (
                <section key={status} className="app-muted-panel rounded-lg p-3">
                  <h3 className="app-kicker mb-2">{t(`status.${status}`)} ({items.length})</h3>
                  <div className="space-y-2">
                    {items.map((task) => (
                      <div key={task.id} className="app-elevated rounded p-2">
                        <p className="text-sm font-medium">{task.title}</p>
                        <p className="app-text-faint text-[11px]">{task.source_type}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Link href={`/wiki/${task.source_ref || task.id}`} className="app-button-primary rounded px-2 py-1 text-xs">{t('dashboard.wikiReview')}</Link>
                          <Link href={`/tasks/${task.id}`} className="app-button-secondary rounded px-2 py-1 text-xs">{t('dashboard.statusDetail')}</Link>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
