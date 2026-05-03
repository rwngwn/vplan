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
    <main className="app-page min-h-screen p-4 md:p-6">
      <div className="app-surface mx-auto max-w-3xl rounded-lg p-6">
        <div className="flex gap-2 text-sm">
          <Link href="/dashboard" className="app-link-muted">← {t('nav.taskTelemetry')}</Link>
        </div>
        {isLoading && <p className="app-text-faint mt-4">{t('dashboard.loading')}</p>}
        {!isLoading && !task && <p className="mt-4 text-[var(--status-danger)]">{t('tasks.notFound', taskId)}</p>}
        {task && (
          <>
            <h1 className="app-title mt-3">{t('tasks.statusDetailTitle')}</h1>
            <p className="app-text-muted mt-1 text-sm">{t('tasks.primaryWorkflow')}</p>
            <p className="mt-2 text-base font-semibold">{task.title}</p>
            <p className="app-text-faint mt-1 text-sm">{task.id}</p>
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
              <Link href={`/wiki/${task.source_ref || task.id}`} className="app-button-primary rounded px-3 py-2 text-xs">{t('tasks.openPrimaryWikiReview')}</Link>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
