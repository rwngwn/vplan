import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'

import { createNote, fetchNotes, fetchTasks, getTelemetry, importHnDigests, recordTaskDashboardView, Task } from '../lib/api'

const STATUSES: Task['status'][] = ['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled']

export default function Dashboard() {
  const { data, isLoading } = useSWR('tasks', () => fetchTasks(), { refreshInterval: 4000 })
  const { data: notes, mutate: mutateNotes } = useSWR('notes', fetchNotes)
  const { data: telemetry } = useSWR('telemetry', getTelemetry, { refreshInterval: 3000 })
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
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
    setImportState('Importuju HN digesty…')
    try {
      const r = await importHnDigests(20)
      setImportState(`Import hotov: +${r.imported} (skip ${r.skipped})`)
      await mutateNotes()
    } catch {
      setImportState('Import selhal')
    } finally {
      setTimeout(() => setImportState(''), 3000)
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-3 md:p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <h1 className="text-xl font-bold md:text-2xl">Wiki-first Workspace</h1>

        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Wiki (primary)</h2>
          <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto_auto]">
            <input value={newNoteTitle} onChange={(e) => setNewNoteTitle(e.target.value)} placeholder="New wiki note" className="rounded border px-3 py-2" />
            <button onClick={onCreateNote} className="rounded bg-slate-900 px-4 py-2 text-white">Create note</button>
            <button onClick={onImportHn} className="rounded bg-indigo-600 px-4 py-2 text-white">Import HN digesty</button>
          </div>
          {importState && <p className="mt-2 text-xs text-slate-600">{importState}</p>}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {(notes || []).map((n) => (
              <Link key={n.id} href={`/wiki/${n.id}`} className="rounded border bg-slate-50 p-2 hover:bg-slate-100">
                <p className="text-sm font-medium">{n.title}</p>
                <p className="text-[11px] text-slate-500">{n.id}</p>
              </Link>
            ))}
          </div>
        </section>

        <section className="rounded-xl bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Task Telemetry (read-only)</h2>
          <div className="mt-2 flex gap-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks" className="w-full rounded border px-3 py-2" />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded border px-3 py-2 text-sm">
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="mt-3 flex gap-2 text-xs text-slate-600">
            <span className="rounded bg-slate-100 px-2 py-1">telegram_to_task_success: {telemetry?.telegram_to_task_success ?? 0}</span>
            <span className="rounded bg-slate-100 px-2 py-1">auto_analysis_runs: {telemetry?.auto_analysis_runs ?? 0}</span>
            <span className="rounded bg-slate-100 px-2 py-1">invalid_status_attempts: {telemetry?.status_transition_invalid_attempts ?? 0}</span>
          </div>

          {isLoading && <p className="mt-3 text-slate-500">Loading…</p>}
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {STATUSES.map((status) => {
              const items = filtered.filter((t) => t.status === status)
              return (
                <section key={status} className="rounded-xl bg-slate-50 p-3 shadow-sm">
                  <h2 className="mb-2 text-xs font-semibold uppercase text-slate-600">{status} ({items.length})</h2>
                  <div className="space-y-2">
                    {items.map((task) => (
                      <div key={task.id} className="rounded border bg-white p-2">
                        <p className="text-sm font-medium">{task.title}</p>
                        <p className="text-[11px] text-slate-500">{task.source_type}</p>
                        <div className="mt-2 flex gap-2">
                          <Link href={`/wiki/${task.source_ref || task.id}`} className="rounded bg-slate-900 px-2 py-1 text-xs text-white">Wiki review</Link>
                          <Link href={`/tasks/${task.id}`} className="rounded bg-slate-100 px-2 py-1 text-xs">Status</Link>
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
