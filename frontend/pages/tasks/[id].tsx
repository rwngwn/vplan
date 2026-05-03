import Link from 'next/link'
import { useRouter } from 'next/router'
import { useMemo } from 'react'
import useSWR from 'swr'

import { fetchTasks, Task } from '../../lib/api'
import { t } from '../../lib/i18n'

export default function TaskDetail() {
  const router = useRouter()
  const taskId = typeof router.query.id === 'string' ? router.query.id : ''
  const { data, isLoading } = useSWR('tasks', () => fetchTasks())
  const task = useMemo<Task | undefined>(() => (data || []).find((t) => t.id === taskId), [data, taskId])

  return (
    <main className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="mx-auto max-w-3xl rounded-xl bg-white p-6 shadow-sm">
        <div className="flex gap-2 text-sm">
          <Link href="/dashboard" className="text-slate-500">← {t('nav.taskTelemetry')}</Link>
        </div>
        {isLoading && <p className="mt-4 text-slate-500">{t('dashboard.loading')}</p>}
        {!isLoading && !task && <p className="mt-4 text-red-600">{t('tasks.notFound', taskId)}</p>}
        {task && (
          <>
            <h1 className="mt-3 text-2xl font-bold">{t('tasks.statusDetailTitle')}</h1>
            <p className="mt-1 text-sm text-slate-600">{t('tasks.primaryWorkflow')}</p>
            <p className="mt-2 text-base font-semibold">{task.title}</p>
            <p className="mt-1 text-sm text-slate-500">{task.id}</p>
            <div className="mt-3 grid gap-2 text-sm">
              <p><b>{t('tasks.status')}:</b> {t(`status.${task.status}`)}</p>
              <p><b>{t('tasks.source')}:</b> {task.source_type} / {task.source_ref || '-'}</p>
              <p><b>{t('tasks.owner')}:</b> {task.owner || '-'}</p>
              <p><b>{t('tasks.priority')}:</b> {task.priority}</p>
              <p><b>{t('tasks.instruction')}:</b> {task.instruction || '-'}</p>
              <p><b>{t('tasks.acceptance')}:</b> {task.acceptance_criteria.join(' | ') || '-'}</p>
              <p><b>{t('tasks.resultSummary')}:</b> {task.result_summary || '-'}</p>
            </div>
            <div className="mt-4">
              <Link href={`/wiki/${task.source_ref || task.id}`} className="rounded bg-slate-900 px-3 py-2 text-xs text-white">{t('tasks.openPrimaryWikiReview')}</Link>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
