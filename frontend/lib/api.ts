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

export type FeatureFlags = {
  annotations_v2_enabled: boolean
  dual_write_enabled: boolean
  ai_confirm_required: boolean
  selection_scope_v2_enabled: boolean
}

export type Document = {
  id: string
  title: string
  content: string
  owner: string
  version: number
  created_at: string
  updated_at: string
}

export type DocumentAnnotationScope = 'text' | 'block' | 'multi_block'

export type DocumentAnnotation = {
  id: string
  document_id: string
  scope: DocumentAnnotationScope
  feedback: string
  line: number
  instruction: string
  line_no: number
  version: number
  created_at: string
  updated_at: string
}

export type FrontendAnnotationEntity = {
  id: string
  comment: string
  quote: string
  status: 'open' | 'resolved'
  author: string
  when: string
  line: number
  anchor: {
    scope: DocumentAnnotationScope
    line: number
    start_offset: number | null
    end_offset: number | null
    source: 'api' | 'legacy' | 'editor'
  }
  version: number
}

type AnnotationWritePayload = {
  scope: DocumentAnnotationScope
  feedback?: string
  line?: number
  instruction?: string
  line_no?: number
}

export type AIPreviewResponse = {
  operation_id: string
  base_version: number
  proposed_content: string
  persisted: boolean
}

export type AIConfirmResponse = {
  operation_id: string
  applied: boolean
  idempotent: boolean
  version: number
}

export type AIUndoResponse = {
  operation_id: string
  undone: boolean
  version: number
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || '/api'
const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  annotations_v2_enabled: false,
  dual_write_enabled: false,
  ai_confirm_required: true,
  selection_scope_v2_enabled: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function logEndpointFailure(category: string, endpoint: string, status?: number) {
  console.error(`[api:${category}] ${endpoint} failed`, status ?? 'unknown')
}

function safeParseAnnotationInstruction(value: string): { comment: string; quote: string } {
  try {
    const parsed = JSON.parse(value) as { comment?: unknown; quote?: unknown }
    const comment = typeof parsed?.comment === 'string' ? parsed.comment : value
    const quote = typeof parsed?.quote === 'string' ? parsed.quote : ''
    return { comment, quote }
  } catch {
    return { comment: value, quote: '' }
  }
}

function isDocumentAnnotationScope(value: string): value is DocumentAnnotationScope {
  return value === 'text' || value === 'block' || value === 'multi_block'
}

async function readJson(category: string, endpoint: string, endpointLabel: string, errorKey: 'api.errors.invalidResponse'): Promise<unknown> {
  const res = await fetch(endpoint)
  if (!res.ok) {
    logEndpointFailure(category, endpointLabel, res.status)
    throw new Error(t('api.errors.fetchDocumentAnnotations', res.status))
  }
  try {
    return await res.json()
  } catch {
    logEndpointFailure(category, endpointLabel)
    throw new Error(t(errorKey))
  }
}

function parseFeatureFlags(payload: unknown): FeatureFlags | null {
  if (!isRecord(payload)) return null
  const annotationsV2 = asBoolean(payload.annotations_v2_enabled)
  const dualWrite = asBoolean(payload.dual_write_enabled)
  const aiConfirmRequired = asBoolean(payload.ai_confirm_required)
  const selectionScopeV2 = asBoolean(payload.selection_scope_v2_enabled)
  if (annotationsV2 === null || dualWrite === null || aiConfirmRequired === null || selectionScopeV2 === null) return null
  return {
    annotations_v2_enabled: annotationsV2,
    dual_write_enabled: dualWrite,
    ai_confirm_required: aiConfirmRequired,
    selection_scope_v2_enabled: selectionScopeV2,
  }
}

function parseDocumentAnnotation(payload: unknown): DocumentAnnotation | null {
  if (!isRecord(payload)) return null
  const id = asString(payload.id)
  const documentId = asString(payload.document_id)
  const scope = asString(payload.scope)
  const feedback = asString(payload.feedback)
  const line = asNumber(payload.line)
  const instruction = asString(payload.instruction)
  const lineNo = asNumber(payload.line_no)
  const version = asNumber(payload.version)
  const createdAt = asString(payload.created_at)
  const updatedAt = asString(payload.updated_at)
  const normalizedFeedback = feedback ?? instruction
  const normalizedLine = line ?? lineNo
  if (!id || !documentId || !normalizedFeedback || normalizedLine === null || version === null || !createdAt || !updatedAt) return null
  if (!scope || !isDocumentAnnotationScope(scope)) return null
  return {
    id,
    document_id: documentId,
    scope,
    feedback: normalizedFeedback,
    line: normalizedLine,
    instruction: normalizedFeedback,
    line_no: normalizedLine,
    version,
    created_at: createdAt,
    updated_at: updatedAt,
  }
}

function parseDocument(payload: unknown): Document | null {
  if (!isRecord(payload)) return null
  const id = asString(payload.id)
  const title = asString(payload.title)
  const content = asString(payload.content)
  const owner = asString(payload.owner)
  const version = asNumber(payload.version)
  const createdAt = asString(payload.created_at)
  const updatedAt = asString(payload.updated_at)
  if (!id || !title || content === null || owner === null || version === null || !createdAt || !updatedAt) return null
  return { id, title, content, owner, version, created_at: createdAt, updated_at: updatedAt }
}

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
  if (!res.ok) throw new Error(t('api.errors.createFolder', res.status))
  return res.json()
}

export async function fetchFeatureFlags(): Promise<FeatureFlags> {
  try {
    const res = await fetch(`${API_BASE}/features/flags`)
    if (!res.ok) {
      logEndpointFailure('flags', '/features/flags', res.status)
      return DEFAULT_FEATURE_FLAGS
    }
    const payload = await res.json()
    const parsed = parseFeatureFlags(payload)
    if (!parsed) {
      logEndpointFailure('flags', '/features/flags')
      return DEFAULT_FEATURE_FLAGS
    }
    return parsed
  } catch {
    logEndpointFailure('flags', '/features/flags')
    return DEFAULT_FEATURE_FLAGS
  }
}

export async function listDocuments(): Promise<Document[]> {
  const res = await fetch(`${API_BASE}/documents`)
  if (!res.ok) {
    logEndpointFailure('documents', '/documents', res.status)
    throw new Error(t('api.errors.fetchDocuments', res.status))
  }
  const payload = await res.json()
  if (!Array.isArray(payload)) {
    logEndpointFailure('documents', '/documents')
    throw new Error(t('api.errors.invalidResponse'))
  }
  const docs: Document[] = []
  for (const item of payload) {
    const parsed = parseDocument(item)
    if (!parsed) {
      logEndpointFailure('documents', '/documents')
      throw new Error(t('api.errors.invalidResponse'))
    }
    docs.push(parsed)
  }
  return docs
}

export async function getDocument(documentId: string): Promise<Document> {
  const res = await fetch(`${API_BASE}/documents/${documentId}`)
  if (!res.ok) {
    logEndpointFailure('documents', `/documents/${documentId}`, res.status)
    throw new Error(t('api.errors.getDocument', res.status))
  }
  const parsed = parseDocument(await res.json())
  if (!parsed) {
    logEndpointFailure('documents', `/documents/${documentId}`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  return parsed
}

export async function createDocument(payload: { title: string; content?: string; owner: string }): Promise<Document> {
  const res = await fetch(`${API_BASE}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: payload.title, content: payload.content ?? '', owner: payload.owner }),
  })
  if (!res.ok) {
    logEndpointFailure('documents', '/documents', res.status)
    throw new Error(t('api.errors.createDocument', res.status))
  }
  const parsed = parseDocument(await res.json())
  if (!parsed) {
    logEndpointFailure('documents', '/documents')
    throw new Error(t('api.errors.invalidResponse'))
  }
  return parsed
}

export async function updateDocument(documentId: string, payload: { title?: string; content?: string; version: number }): Promise<Document> {
  const res = await fetch(`${API_BASE}/documents/${documentId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    logEndpointFailure('documents', `/documents/${documentId}`, res.status)
    throw new Error(t('api.errors.updateDocument', res.status))
  }
  const parsed = parseDocument(await res.json())
  if (!parsed) {
    logEndpointFailure('documents', `/documents/${documentId}`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  return parsed
}

export async function deleteDocument(documentId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/documents/${documentId}`, { method: 'DELETE' })
  if (!res.ok) {
    logEndpointFailure('documents', `/documents/${documentId}`, res.status)
    throw new Error(t('api.errors.deleteDocument', res.status))
  }
}

export async function listDocumentAnnotations(documentId: string): Promise<DocumentAnnotation[]> {
  const endpoint = `${API_BASE}/documents/${documentId}/annotations`
  const endpointLabel = `/documents/${documentId}/annotations`
  const payload = await readJson('annotations', endpoint, endpointLabel, 'api.errors.invalidResponse')
  if (!Array.isArray(payload)) {
    logEndpointFailure('annotations', endpointLabel)
    throw new Error(t('api.errors.invalidResponse'))
  }
  const annotations: DocumentAnnotation[] = []
  for (const item of payload) {
    const parsed = parseDocumentAnnotation(item)
    if (!parsed) {
      logEndpointFailure('annotations', endpointLabel)
      continue
    }
    annotations.push(parsed)
  }
  return annotations
}

export function documentAnnotationToFrontendEntity(item: DocumentAnnotation): FrontendAnnotationEntity {
  const normalized = safeParseAnnotationInstruction(item.feedback)
  return {
    id: item.id,
    comment: normalized.comment,
    quote: normalized.quote,
    status: 'open',
    author: 'You',
    when: 'now',
    line: item.line,
    anchor: {
      scope: item.scope,
      line: item.line,
      start_offset: null,
      end_offset: null,
      source: 'api',
    },
    version: item.version,
  }
}

export function legacyAnnotationToFrontendEntity(item: { id: string; body: string; quote: string; status: 'open' | 'resolved'; when?: string; author?: string; line?: number }): FrontendAnnotationEntity {
  const line = item.line ?? 1
  return {
    id: item.id,
    comment: item.body,
    quote: item.quote,
    status: item.status,
    author: item.author || 'You',
    when: item.when || 'now',
    line,
    anchor: {
      scope: 'text',
      line,
      start_offset: null,
      end_offset: null,
      source: 'legacy',
    },
    version: 1,
  }
}

export function parseLegacyWikiAnnotations(markdownBody: string, resolvedAnnotationIds: string[]): FrontendAnnotationEntity[] {
  const normalized = markdownBody.replace(/\\\[/g, '[').replace(/\\\]/g, ']')
  const matches = [...normalized.matchAll(/\[\[agent:\s*([\s\S]*?)\s*\|\s*quote:\s*([\s\S]*?)\]\]/gi)]
  return matches.map((m, i) => {
    const id = `anno-${i + 1}`
    return legacyAnnotationToFrontendEntity({
      id,
      body: m[1]?.trim() || '',
      quote: m[2]?.trim() || '',
      status: resolvedAnnotationIds.includes(id) ? 'resolved' : 'open',
    })
  })
}

export function appendLegacyWikiAnnotation(markdownBody: string, quoteText: string, commentText: string): string {
  const safeQuote = quoteText.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const safeComment = commentText.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const snippet = `\n\n[[agent: ${safeComment} | quote: ${safeQuote}]]`
  return `${markdownBody}${snippet}`
}

export function inlineAnnotationToFrontendEntity(item: InlineAnnotation, index: number): FrontendAnnotationEntity {
  const id = `inline-${item.line_no}-${index}`
  return {
    id,
    comment: item.instruction,
    quote: '',
    status: 'open',
    author: 'Agent',
    when: 'now',
    line: item.line_no,
    anchor: {
      scope: 'text',
      line: item.line_no,
      start_offset: null,
      end_offset: null,
      source: 'editor',
    },
    version: 1,
  }
}

export async function createDocumentAnnotation(documentId: string, payload: AnnotationWritePayload): Promise<DocumentAnnotation> {
  const feedback = payload.feedback ?? payload.instruction
  const line = payload.line ?? payload.line_no
  if (!feedback || line === undefined) {
    logEndpointFailure('annotations', `/documents/${documentId}/annotations`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  const res = await fetch(`${API_BASE}/documents/${documentId}/annotations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: payload.scope, feedback, line, instruction: feedback, line_no: line }),
  })
  if (!res.ok) {
    logEndpointFailure('annotations', `/documents/${documentId}/annotations`, res.status)
    throw new Error(t('api.errors.createDocumentAnnotation', res.status))
  }
  const parsed = parseDocumentAnnotation(await res.json())
  if (!parsed) {
    logEndpointFailure('annotations', `/documents/${documentId}/annotations`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  return parsed
}

export async function updateDocumentAnnotation(documentId: string, annotationId: string, payload: { scope?: DocumentAnnotationScope; feedback?: string; line?: number; instruction?: string; line_no?: number; version: number }): Promise<DocumentAnnotation> {
  const feedback = payload.feedback ?? payload.instruction
  const line = payload.line ?? payload.line_no
  const hasFeedback = feedback !== undefined && feedback !== null
  const hasLine = line !== undefined && line !== null
  const requestPayload = {
    scope: payload.scope,
    version: payload.version,
    ...(hasFeedback ? { feedback, instruction: feedback } : {}),
    ...(hasLine ? { line, line_no: line } : {}),
  }
  const res = await fetch(`${API_BASE}/documents/${documentId}/annotations/${annotationId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestPayload),
  })
  if (!res.ok) {
    logEndpointFailure('annotations', `/documents/${documentId}/annotations/${annotationId}`, res.status)
    throw new Error(t('api.errors.updateDocumentAnnotation', res.status))
  }
  const parsed = parseDocumentAnnotation(await res.json())
  if (!parsed) {
    logEndpointFailure('annotations', `/documents/${documentId}/annotations/${annotationId}`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  return parsed
}

export async function deleteDocumentAnnotation(documentId: string, annotationId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/annotations/${annotationId}`, { method: 'DELETE' })
  if (!res.ok) {
    logEndpointFailure('annotations', `/documents/${documentId}/annotations/${annotationId}`, res.status)
    throw new Error(t('api.errors.deleteDocumentAnnotation', res.status))
  }
}

export async function previewAIOperation(documentId: string, payload: { prompt: string; operation_id: string; base_version: number }): Promise<AIPreviewResponse> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/ai/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    if (res.status === 409) throw new Error('ai-stale-preview')
    logEndpointFailure('ai', `/documents/${documentId}/ai/preview`, res.status)
    throw new Error(t('api.errors.aiPreview', res.status))
  }
  const data = await res.json()
  if (!isRecord(data)) {
    logEndpointFailure('ai', `/documents/${documentId}/ai/preview`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  const operationId = asString(data.operation_id)
  const baseVersion = asNumber(data.base_version)
  const proposedContent = asString(data.proposed_content)
  const persisted = asBoolean(data.persisted)
  if (!operationId || baseVersion === null || proposedContent === null || persisted === null) {
    logEndpointFailure('ai', `/documents/${documentId}/ai/preview`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  return { operation_id: operationId, base_version: baseVersion, proposed_content: proposedContent, persisted }
}

export async function confirmAIOperation(documentId: string, payload: { operation_id: string; base_version: number }): Promise<AIConfirmResponse> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/ai/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    if (res.status === 409) throw new Error('ai-stale-preview')
    logEndpointFailure('ai', `/documents/${documentId}/ai/confirm`, res.status)
    throw new Error(t('api.errors.aiConfirm', res.status))
  }
  const data = await res.json()
  if (!isRecord(data)) {
    logEndpointFailure('ai', `/documents/${documentId}/ai/confirm`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  const operationId = asString(data.operation_id)
  const applied = asBoolean(data.applied)
  const idempotent = asBoolean(data.idempotent)
  const version = asNumber(data.version)
  if (!operationId || applied !== true || idempotent === null || version === null) {
    logEndpointFailure('ai', `/documents/${documentId}/ai/confirm`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  return { operation_id: operationId, applied, idempotent, version }
}

export async function undoAIOperation(documentId: string): Promise<AIUndoResponse> {
  const res = await fetch(`${API_BASE}/documents/${documentId}/ai/undo`, { method: 'POST' })
  if (!res.ok) {
    if (res.status === 409 || res.status === 404) throw new Error('ai-undo-unavailable')
    logEndpointFailure('ai', `/documents/${documentId}/ai/undo`, res.status)
    throw new Error(t('api.errors.aiUndo', res.status))
  }
  const data = await res.json()
  if (!isRecord(data)) {
    logEndpointFailure('ai', `/documents/${documentId}/ai/undo`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  const operationId = asString(data.operation_id)
  const undone = asBoolean(data.undone)
  const version = asNumber(data.version)
  if (!operationId || undone !== true || version === null) {
    logEndpointFailure('ai', `/documents/${documentId}/ai/undo`)
    throw new Error(t('api.errors.invalidResponse'))
  }
  return { operation_id: operationId, undone, version }
}
