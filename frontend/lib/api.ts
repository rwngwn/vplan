import { t } from './i18n'

export type TaskStatus = 'open' | 'in_progress' | 'review' | 'done' | 'blocked' | 'cancelled'

export type Task = {
  id: string
  title: string
  status: TaskStatus
  source_type: string
  source_ref: string
  instruction: string
  priority: number
  owner: string
  acceptance_criteria: string[]
  result_summary: string
  links: string[]
  created_at: string
  updated_at: string
}

export type InlineAnnotation = { instruction: string; line_no: number }
export type WorkspaceRevision = {
  revision_id: string
  saved_at: string
  review_decision: 'pending' | 'approve' | 'request_changes'
  review_summary: string
  annotations_count: number
}

export type KnowledgeFolder = {
  id: string
  name: string
  slug: string
  parent_id: string | null
  created_at: string
  updated_at: string
}

export type KnowledgeNote = {
  id: string
  title: string
  body: string
  folder_id: string | null
  created_at: string
  updated_at: string
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '/api'

export async function fetchTasks(params?: { source_ref?: string; status?: string }): Promise<Task[]> {
  const q = new URLSearchParams()
  if (params?.source_ref) q.set('source_ref', params.source_ref)
  if (params?.status) q.set('status', params.status)
  const suffix = q.toString() ? `?${q.toString()}` : ''
  const res = await fetch(`${API_BASE}/tasks${suffix}`)
  if (!res.ok) throw new Error(t('api.errors.fetchTasks', res.status))
  return res.json()
}

export async function createTask(payload: Partial<Task> & { title: string }) {
  const res = await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(t('api.errors.createTask', res.status))
  return res.json()
}

export async function updateTask(taskId: string, payload: Partial<Task>) {
  const res = await fetch(`${API_BASE}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(t('api.errors.updateTask', res.status))
  return res.json()
}

export async function transitionTask(taskId: string, toStatus: TaskStatus, note?: string) {
  const res = await fetch(`${API_BASE}/tasks/${taskId}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to_status: toStatus, note }),
  })
  if (!res.ok) throw new Error(t('api.errors.transitionTask', res.status))
  return res.json()
}

export async function getWorkspace(taskId: string): Promise<{ task_id: string; markdown: string }> {
  const res = await fetch(`${API_BASE}/workspace/tasks/${taskId}`)
  if (!res.ok) throw new Error(t('api.errors.loadWorkspace', res.status))
  return res.json()
}

export async function saveWorkspace(taskId: string, markdown: string): Promise<{ saved: boolean; count: number; revision_id: string; annotations: InlineAnnotation[] }> {
  const res = await fetch(`${API_BASE}/workspace/tasks/${taskId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown })
  })
  if (!res.ok) throw new Error(t('api.errors.saveWorkspace', res.status))
  return res.json()
}

export async function listRevisions(taskId: string): Promise<WorkspaceRevision[]> {
  const res = await fetch(`${API_BASE}/workspace/tasks/${taskId}/revisions`)
  if (!res.ok) throw new Error(t('api.errors.loadRevisions', res.status))
  return res.json()
}

export async function getRevisionDiff(taskId: string, revisionId: string): Promise<{ revision_id: string; diff: string }> {
  const res = await fetch(`${API_BASE}/workspace/tasks/${taskId}/revisions/${revisionId}/diff`)
  if (!res.ok) throw new Error(t('api.errors.loadDiff', res.status))
  return res.json()
}

export async function submitReview(taskId: string, payload: { revision_id: string; decision: 'approve' | 'request_changes'; summary: string; inline_feedback: { line_no: number; comment: string }[] }) {
  const res = await fetch(`${API_BASE}/workspace/tasks/${taskId}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(t('api.errors.submitReview', res.status))
  return res.json()
}

export async function getFeedbackPacket(taskId: string): Promise<{ task_id: string; latest_revision_id: string | null; feedback_prompt: string }> {
  const res = await fetch(`${API_BASE}/workspace/tasks/${taskId}/feedback-packet`)
  if (!res.ok) throw new Error(t('api.errors.loadFeedbackPacket', res.status))
  return res.json()
}

export async function fetchNotes(): Promise<KnowledgeNote[]> {
  const res = await fetch(`${API_BASE}/knowledge/notes`)
  if (!res.ok) throw new Error(t('api.errors.fetchNotes', res.status))
  return res.json()
}

export async function createNote(title: string, body = '', folder_id?: string | null): Promise<KnowledgeNote> {
  const res = await fetch(`${API_BASE}/knowledge/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, folder_id: folder_id ?? null }),
  })
  if (!res.ok) throw new Error(t('api.errors.createNote', res.status))
  return res.json()
}

export async function updateNote(noteId: string, payload: { title?: string; body?: string }): Promise<KnowledgeNote> {
  const res = await fetch(`${API_BASE}/knowledge/notes/${noteId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(t('api.errors.updateNote', res.status))
  return res.json()
}

export async function getTelemetry(): Promise<Record<string, number>> {
  const res = await fetch(`${API_BASE}/telemetry`)
  if (!res.ok) throw new Error(t('api.errors.fetchTelemetry', res.status))
  return res.json()
}

export async function recordTaskDashboardView() {
  await fetch(`${API_BASE}/telemetry/task-dashboard-view`, { method: 'POST' })
}

export async function importHnDigests(limit = 10, path = '/data/hn-digests'): Promise<{ ok: boolean; scanned: number; imported: number; skipped: number }> {
  const res = await fetch(`${API_BASE}/knowledge/import-hn-digests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit, path }),
  })
  if (!res.ok) throw new Error(t('api.errors.importHn', res.status))
  return res.json()
}


export async function fetchFolders(): Promise<KnowledgeFolder[]> {
  const res = await fetch(`${API_BASE}/knowledge/folders`)
  if (!res.ok) throw new Error(t('api.errors.fetchNotes', res.status))
  return res.json()
}

export async function createFolder(name: string, parent_id?: string | null): Promise<KnowledgeFolder> {
  const res = await fetch(`${API_BASE}/knowledge/folders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parent_id: parent_id ?? null }),
  })
  if (!res.ok) throw new Error(`Failed to create folder (${res.status})`)
  return res.json()
}
