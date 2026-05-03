import Link from 'next/link'
import { useRouter } from 'next/router'
import { useMemo } from 'react'
import useSWR from 'swr'

import { fetchTasks, Task } from '../../lib/api'

export default function TaskDetail() {
  const router = useRouter()
  const taskId = typeof router.query.id === 'string' ? router.query.id : ''
  const { data, isLoading } = useSWR('tasks', () => fetchTasks())
  const task = useMemo<Task | undefined>(() => (data || []).find((t) => t.id === taskId), [data, taskId])

  return (
    <main className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="mx-auto max-w-3xl rounded-xl bg-white p-6 shadow-sm">
        <div className="flex gap-2 text-sm">
          <Link href="/dashboard" className="text-slate-500">← Task telemetry</Link>
        </div>
        {isLoading && <p className="mt-4 text-slate-500">Loading…</p>}
        {!isLoading && !task && <p className="mt-4 text-red-600">Task not found: {taskId}</p>}
        {task && (
          <>
            <h1 className="mt-3 text-2xl font-bold">Task status detail</h1>
            <p className="mt-1 text-sm text-slate-600">Primary workflow lives in wiki review.</p>
            <p className="mt-2 text-base font-semibold">{task.title}</p>
            <p className="mt-1 text-sm text-slate-500">{task.id}</p>
            <div className="mt-3 grid gap-2 text-sm">
              <p><b>Status:</b> {task.status}</p>
              <p><b>Source:</b> {task.source_type} / {task.source_ref || '-'}</p>
              <p><b>Owner:</b> {task.owner || '-'}</p>
              <p><b>Priority:</b> {task.priority}</p>
              <p><b>Instruction:</b> {task.instruction || '-'}</p>
              <p><b>Acceptance:</b> {task.acceptance_criteria.join(' | ') || '-'}</p>
              <p><b>Result summary:</b> {task.result_summary || '-'}</p>
            </div>
            <div className="mt-4">
              <Link href={`/wiki/${task.source_ref || task.id}`} className="rounded bg-slate-900 px-3 py-2 text-xs text-white">Open primary wiki review</Link>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
