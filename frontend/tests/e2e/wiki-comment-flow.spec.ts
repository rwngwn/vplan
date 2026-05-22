import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import {
  appendLegacyWikiAnnotation,
  createDocumentAnnotation,
  deleteDocumentAnnotation,
  documentAnnotationToFrontendEntity,
  fetchFeatureFlags,
  listDocumentAnnotations,
  parseLegacyWikiAnnotations,
  updateDocumentAnnotation,
} from '../../lib/api'

test('annotation adapters keep canonical anchor metadata and round-trip legacy markers', () => {
  const markdown = appendLegacyWikiAnnotation('Body', 'Quote <tag>', 'Comment <tag>')
  const parsed = parseLegacyWikiAnnotations(markdown, [])
  expect(parsed).toHaveLength(1)
  expect(parsed[0].comment).toContain('&lt;tag&gt;')
  expect(parsed[0].quote).toContain('&lt;tag&gt;')
  expect(parsed[0].anchor.source).toBe('legacy')
  expect(parsed[0].anchor.line).toBe(1)

  const canonical = documentAnnotationToFrontendEntity({
    id: 'doc-ann-1',
    document_id: 'demo',
    scope: 'text',
    feedback: JSON.stringify({ comment: 'hello', quote: 'world' }),
    line: 7,
    instruction: JSON.stringify({ comment: 'hello', quote: 'world' }),
    line_no: 7,
    version: 1,
    created_at: '2026-05-03T00:00:00.000Z',
    updated_at: '2026-05-03T00:00:00.000Z',
  })
  expect(canonical.anchor.source).toBe('api')
  expect(canonical.anchor.line).toBe(7)
})

test('desktop/mobile parity fixture matrix enforces deterministic CI gate output', async ({ browser }) => {
  await runParityFixtureMatrix(browser)
})

type ParityViewport = 'desktop' | 'mobile'

async function setupParityRoutes(page: Page) {
  const body = 'Parity fixture first paragraph with scoped actions for selection and AI.'
  const annotationStore: Array<{ id: string; document_id: string; scope: 'text'; instruction: string; line_no: number; version: number; created_at: string; updated_at: string }> = []
  let previewCalls = 0

  await page.route('**/api/features/flags', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        annotations_v2_enabled: true,
        dual_write_enabled: false,
        ai_confirm_required: true,
        selection_scope_v2_enabled: true,
      }),
    })
  })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Parity.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.route('**/api/documents/demo/annotations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([
        ...annotationStore,
        {
          id: 'seed-valid',
          document_id: 'demo',
          scope: 'text',
          feedback: JSON.stringify({ comment: 'Seeded canonical comment', quote: 'seeded quote' }),
          line: 1,
          instruction: JSON.stringify({ comment: 'Seeded canonical comment', quote: 'seeded quote' }),
          line_no: 1,
          version: 1,
          created_at: '2026-05-03T00:00:00.000Z',
          updated_at: '2026-05-03T00:00:00.000Z',
        },
        {
          id: 'seed-malformed',
          document_id: 'demo',
          scope: 'text',
          instruction: null,
          line_no: 'bad',
          version: 1,
          created_at: '2026-05-03T00:00:00.000Z',
          updated_at: '2026-05-03T00:00:00.000Z',
        },
      ]) })
      return
    }
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { instruction: string; line_no: number }
      const now = '2026-05-10T00:00:00.000Z'
      const created = { id: `ann-${annotationStore.length + 1}`, document_id: 'demo', scope: 'text' as const, instruction: payload.instruction, line_no: payload.line_no, version: 1, created_at: now, updated_at: now }
      annotationStore.push(created)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(created) })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/documents/*/ai/preview', async (route) => {
    previewCalls += 1
    const payload = route.request().postDataJSON() as { prompt?: string } | null
    const promptLength = (payload?.prompt || '').length
    if (promptLength < 2 || promptLength > 2000) {
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'validation' }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: `parity-op-${previewCalls}`, base_version: 1, proposed_content: `Preview content ${previewCalls}`, persisted: false }) })
  })
  await page.route('**/api/documents/*/ai/confirm', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'parity-op', applied: true, idempotent: false, version: 2 }) })
  })
  await page.route('**/api/documents/*/ai/undo', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'parity-op', undone: true, version: 3 }) })
  })
}

async function runParityFixtureMatrix(browser: Browser) {
  expect(process.env.PLAYWRIGHT_PARITY_GATE).toBe('1')
  const threshold = 0.9
  const cases = ['slash-allowlisted', 'slash-malformed', 'selection-text', 'selection-block', 'ai-confirm-undo', 'ai-prompt-boundary', 'annotations-malformed-safe-fallback'] as const
  const results: Array<{ viewport: ParityViewport; caseId: string; passed: boolean }> = []

  for (const viewport of ['desktop', 'mobile'] as const) {
    for (const caseId of cases) {
      await runParityCase(browser, viewport, caseId)
      results.push({ viewport, caseId, passed: true })
    }
  }

  const paritySummary = cases.map((caseId) => {
    const desktop = results.find((item) => item.caseId === caseId && item.viewport === 'desktop')?.passed === true
    const mobile = results.find((item) => item.caseId === caseId && item.viewport === 'mobile')?.passed === true
    return { caseId, desktop, mobile, parityPass: desktop === mobile && desktop, reason: desktop && mobile ? 'both-viewports-passed' : 'viewport-mismatch-or-failure' }
  })
  const parityPassed = paritySummary.filter((item) => item.parityPass).length
  const parityScore = parityPassed / paritySummary.length
  const gate = {
    threshold,
    parityScore,
    parityPassed,
    totalCases: paritySummary.length,
    pass: parityScore >= threshold,
    details: paritySummary,
  }

  mkdirSync(resolve(process.cwd(), 'test-results'), { recursive: true })
  writeFileSync(resolve(process.cwd(), 'test-results', 'parity-gate.json'), JSON.stringify(gate, null, 2), 'utf8')
  console.log(`PARITY_GATE:${JSON.stringify(gate)}`)
  for (const detail of gate.details) {
    expect(detail.reason).toBeTruthy()
  }
  expect(gate.pass).toBe(true)
}

async function runParityCase(browser: Browser, viewport: ParityViewport, caseId: 'slash-allowlisted' | 'slash-malformed' | 'selection-text' | 'selection-block' | 'ai-confirm-undo' | 'ai-prompt-boundary' | 'annotations-malformed-safe-fallback') {
  const context = await browser.newContext({
    viewport: viewport === 'desktop' ? { width: 1280, height: 900 } : { width: 390, height: 844 },
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:3100',
    permissions: ['clipboard-read', 'clipboard-write'],
    reducedMotion: 'reduce',
    colorScheme: 'light',
  })
  try {
    const page = await context.newPage()
    await setupParityRoutes(page)
    await page.goto('/wiki/demo')
    await expect(page.getByTestId('wiki-editor-shell')).toBeVisible()

    if (caseId === 'slash-allowlisted') {
      await page.getByTestId('wiki-slash-input').focus()
      await page.getByTestId('wiki-slash-input').fill('/files')
      if (viewport === 'desktop') {
        await page.keyboard.press('Enter')
        await expect(page.getByTestId('wiki-slash-no-match')).toHaveCount(0)
      } else {
        await page.getByTestId('wiki-mobile-slash-item-files').click()
        await expect(page.getByTestId('wiki-mobile-files-sheet')).toBeVisible()
        await page.getByTestId('wiki-mobile-files-sheet').getByRole('button', { name: 'Close', exact: true }).click()
      }
      return
    }

    if (caseId === 'slash-malformed') {
      await page.getByTestId('wiki-slash-input').focus()
      await page.getByTestId('wiki-slash-input').fill('/not-in-whitelist-command-12345678901234567890')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('wiki-slash-no-match')).toBeVisible()
      if (viewport === 'mobile') {
        const closeButton = page.getByTestId('wiki-mobile-slash-sheet').getByRole('button', { name: 'Close' })
        if (await closeButton.count()) {
          await closeButton.first().click()
        }
        await expect(page.getByTestId('wiki-mobile-slash-sheet')).toBeHidden()
      }
      return
    }

    if (caseId === 'selection-text') {
      const editorParagraph = page.getByTestId('wiki-editor-shell').locator('p').first()
      await expect(editorParagraph).toContainText('Parity fixture first paragraph with scoped actions for selection and AI.')
      await page.getByTestId('wiki-editor-shell').locator('p').first().evaluate((node) => {
        const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
        if (!textNode?.textContent) throw new Error('Text node missing')
        const start = textNode.textContent.indexOf('scoped actions')
        if (start < 0) throw new Error('Scoped actions segment missing')
        const range = document.createRange()
        range.setStart(textNode, start)
        range.setEnd(textNode, start + 'scoped'.length)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      })
      await waitForSelectionAction(page)
      await expect(viewport === 'desktop' ? page.getByTestId('wiki-selection-toolbar') : page.getByTestId('wiki-mobile-selection-actions')).toHaveAttribute('data-selection-scope', 'text')
      await expect(viewport === 'desktop' ? page.getByTestId('wiki-selection-comment-button') : page.getByTestId('wiki-mobile-nav-comment')).toBeVisible()
      return
    }

    if (caseId === 'selection-block') {
      const editorParagraph = page.getByTestId('wiki-editor-shell').locator('p').first()
      await expect(editorParagraph).toContainText('Parity fixture first paragraph with scoped actions for selection and AI.')
      await page.getByTestId('wiki-editor-shell').locator('p').first().evaluate((node) => {
        const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
        if (!textNode?.textContent) throw new Error('Text node missing')
        const range = document.createRange()
        range.setStart(textNode, 0)
        range.setEnd(textNode, textNode.textContent.length)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
      })
      await expect(viewport === 'desktop' ? page.getByTestId('wiki-selection-toolbar') : page.getByTestId('wiki-mobile-selection-actions')).toHaveAttribute('data-selection-scope', 'block')
      await expect(viewport === 'desktop' ? page.getByTestId('wiki-selection-comment-button') : page.getByTestId('wiki-mobile-nav-comment')).toHaveCount(0)
      return
    }

    if (caseId === 'annotations-malformed-safe-fallback') {
      await expect(page.getByText('Seeded canonical comment')).toHaveCount(1)
      await expect(page.getByText('Nepodařilo se uložit komentář.')).toHaveCount(0)
      return
    }

    await openAiAssistant(page)
    const aiSurface = viewport === 'desktop' ? page.getByTestId('wiki-ai-popup-desktop') : page.getByTestId('wiki-mobile-ai-sheet')
    await expect(aiSurface).toBeVisible()
    if (caseId === 'ai-confirm-undo') {
      await aiSurface.getByTestId('wiki-ai-prompt-input').fill('Parity prompt baseline')
      await aiSurface.getByTestId('wiki-ai-preview-submit').click()
      await expect(aiSurface.getByTestId('wiki-ai-status')).toContainText('Preview ready')
      await aiSurface.getByTestId('wiki-ai-confirm-submit').click()
      await expect(aiSurface.getByTestId('wiki-ai-status')).toContainText('Applied')
      await aiSurface.getByTestId('wiki-ai-undo-submit').click()
      await expect(aiSurface.getByTestId('wiki-ai-status')).toContainText('Undone')
      return
    }

    await aiSurface.getByTestId('wiki-ai-prompt-input').fill('x')
    await aiSurface.getByTestId('wiki-ai-preview-submit').click()
    await expect(aiSurface.getByTestId('wiki-ai-status')).toContainText('Preview failed')
    await aiSurface.getByTestId('wiki-ai-prompt-input').fill('x'.repeat(2001))
    await aiSurface.getByTestId('wiki-ai-preview-submit').click()
    await expect(aiSurface.getByTestId('wiki-ai-status')).toContainText('Preview failed')
  } finally {
    await context.close()
  }
}

async function openAiAssistant(page: Page) {
  const desktopTrigger = page.getByTestId('wiki-ai-trigger-desktop')
  const mobileTrigger = page.getByTestId('wiki-ai-trigger-mobile')
  const mobileVisible = await mobileTrigger.isVisible().catch(() => false)
  if (mobileVisible) {
    await mobileTrigger.click()
    return
  }
  const viewportWidth = await page.evaluate(() => window.innerWidth)
  if (viewportWidth >= 1024 || await desktopTrigger.isVisible().catch(() => false)) {
    await expect(desktopTrigger).toBeVisible()
    await desktopTrigger.click()
    return
  }
  await expect(mobileTrigger).toBeVisible()
  await mobileTrigger.click()
}

async function waitForSelectionAction(page: Page) {
  const desktopButton = page.getByTestId('wiki-selection-comment-button')
  const mobileButton = page.getByTestId('wiki-mobile-nav-comment')
  await expect.poll(async () => (await desktopButton.count()) + (await mobileButton.count())).toBeGreaterThan(0)
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((nextTheme) => {
    document.documentElement.classList.remove('theme-light', 'theme-dark')
    document.documentElement.classList.add(nextTheme === 'light' ? 'theme-light' : 'theme-dark')
  }, theme)
}

async function openSelectionToolbar(page: Page) {
  const editorParagraph = page.getByTestId('wiki-editor-shell').locator('p').first()
  await expect(editorParagraph).toContainText('Theme surface validation body text for selection.')
  await editorParagraph.evaluate((node) => {
    const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
    if (!textNode?.textContent) throw new Error('Editor text missing')
    const start = textNode.textContent.indexOf('surface validation')
    if (start < 0) throw new Error('Expected quote missing')
    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'surface validation'.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })
  await waitForSelectionAction(page)
  await expect(page.getByTestId('wiki-selection-toolbar')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/features/flags', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        annotations_v2_enabled: true,
        dual_write_enabled: false,
        ai_confirm_required: true,
        selection_scope_v2_enabled: false,
      }),
    })
  })

  await page.route('**/api/documents/*/annotations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: '[]' })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/documents/*/ai/preview', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ operation_id: 'mock-op', base_version: 1, proposed_content: 'preview', persisted: false }),
      })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/documents/*/ai/confirm', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ operation_id: 'mock-op', applied: true, idempotent: false, version: 2 }),
      })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/documents/*/ai/undo', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ operation_id: 'mock-op', undone: true, version: 3 }),
      })
      return
    }
    await route.fallback()
  })
})

test('keeps the selected text highlight visible while typing a wiki comment', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const createdAnnotationPayloads: Array<{ scope: string; instruction: string; line_no: number }> = []
  const annotationStore: Array<{ id: string; document_id: string; scope: 'text'; instruction: string; line_no: number; version: number; created_at: string; updated_at: string }> = []
  const notePatchPayloads: Array<{ body?: string }> = []

  await page.route('**/api/documents/demo/annotations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(annotationStore) })
      return
    }
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { scope: string; instruction: string; line_no: number }
      createdAnnotationPayloads.push(payload)
      const now = '2026-05-10T00:00:00.000Z'
      const created = {
        id: `ann-${annotationStore.length + 1}`,
        document_id: 'demo',
        scope: 'text' as const,
        instruction: payload.instruction,
        line_no: payload.line_no,
        version: 1,
        created_at: now,
        updated_at: now,
      }
      annotationStore.push(created)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(created) })
      return
    }
    await route.fallback()
  })
  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback()
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'demo',
          title: 'Demo.md',
          body: 'This demo paragraph has text that can be commented on from the selection toolbar.',
          created_at: '2026-05-03T00:00:00.000Z',
          updated_at: '2026-05-03T00:00:00.000Z',
        },
      ]),
    })
  })

  await page.route('**/api/knowledge/notes/demo', async (route) => {
    if (route.request().method() === 'PATCH') {
      notePatchPayloads.push((route.request().postDataJSON() || {}) as { body?: string })
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'demo',
        title: 'Demo.md',
        body: 'This demo paragraph has text that can be commented on from the selection toolbar.',
        created_at: '2026-05-03T00:00:00.000Z',
        updated_at: '2026-05-03T00:00:00.000Z',
      }),
    })
  })

  await page.goto('/wiki/demo')

  const editorShell = page.getByTestId('wiki-editor-shell')
  await expect(editorShell).toBeVisible()
  const editorParagraph = editorShell.locator('p').first()
  await expect(editorParagraph).toContainText('demo paragraph')

  await editorParagraph.evaluate((node) => {
    const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
    if (!textNode?.textContent) throw new Error('Editor text was not rendered')

    const start = textNode.textContent.indexOf('demo paragraph')
    if (start < 0) throw new Error('Expected selectable text was not found')

    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'demo paragraph'.length)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await waitForSelectionAction(page)
  await expect(page.getByTestId('wiki-selection-toolbar')).toBeVisible()
  await expect(page.getByTestId('wiki-selection-comment-button')).toBeVisible()
  await page.getByTestId('wiki-selection-comment-button').click()

  const highlight = page.locator('.wiki-draft-selection-highlight')
  await expect.poll(() => highlight.count()).toBeGreaterThan(0)
  await expect(highlight.first()).toBeVisible()

  const commentTextarea = page.getByTestId('wiki-comment-textarea')
  await expect(commentTextarea).toBeVisible()
  await commentTextarea.fill('Keep this selection highlighted while I type.')

  await expect(commentTextarea).toHaveValue('Keep this selection highlighted while I type.')
  await expect(highlight.first()).toBeVisible()

  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('button', { name: 'Open (1)' })).toBeVisible()
  await expect(page.locator('aside').filter({ hasText: 'Annotations' }).getByText('Keep this selection highlighted while I type.')).toBeVisible()
  await expect.poll(() => createdAnnotationPayloads.length).toBe(1)
  await expect(createdAnnotationPayloads[0]?.scope).toBe('text')
  await expect(notePatchPayloads.length).toBe(0)
})

test('saves annotation for single-word selection', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const body = 'Tady testujeme slovo spolehlivosti v jedné větě.'

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Demo.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')
  const editorShell = page.getByTestId('wiki-editor-shell')
  await expect(editorShell).toBeVisible()

  const editorParagraph = editorShell.locator('p').first()
  await expect(editorParagraph).toContainText('spolehlivosti')

  await editorParagraph.evaluate((node) => {
    const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
    if (!textNode?.textContent) throw new Error('Editor text missing')
    const start = textNode.textContent.indexOf('spolehlivosti')
    if (start < 0) throw new Error('Word not found')

    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'spolehlivosti'.length)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await waitForSelectionAction(page)
  await expect(page.getByTestId('wiki-selection-comment-button')).toBeVisible()
  await page.getByTestId('wiki-selection-comment-button').click()
  const commentTextarea = page.getByTestId('wiki-comment-textarea')
  await commentTextarea.fill('Komentář ke slovu')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('button', { name: 'Open (1)' })).toBeVisible()
  await expect(page.getByText('Komentář ke slovu').first()).toBeVisible()
})

test('metadata annotation can be resolved without mutating editor content', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const body = 'Resolving metadata annotations should keep editor text stable.'
  const annotationStore = [{
    id: 'ann-1',
    document_id: 'demo',
    scope: 'text' as const,
    instruction: JSON.stringify({ quote: 'metadata annotations', comment: 'Resolve me' }),
    line_no: 1,
    version: 1,
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
  }]
  const resolvedIds: string[] = []

  await page.route('**/api/documents/demo/annotations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(annotationStore.filter((item) => !resolvedIds.includes(item.id))) })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/documents/demo/annotations/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      const annotationId = route.request().url().split('/').pop() || ''
      resolvedIds.push(annotationId)
      await route.fulfill({ status: 204, body: '' })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Demo.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }]),
    })
  })

  await page.goto('/wiki/demo')
  await expect(page.locator('aside').filter({ hasText: 'Annotations' }).getByText('Resolve me')).toBeVisible()
  await page.getByRole('button', { name: 'resolve', exact: true }).click()
  await expect.poll(() => resolvedIds.length).toBe(1)
  await page.getByRole('button', { name: 'Resolved (1)' }).click()
  await expect(page.locator('aside').filter({ hasText: 'Annotations' }).getByText('Resolve me')).toBeVisible()
  await expect(page.getByTestId('wiki-editor-shell').locator('p').first()).toContainText(body)
})

test('metadata-v2 mode ignores legacy inline marker parsing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const body = 'Visible text before.\n\n[[agent: hidden instruction | quote: should not be parsed in v2]]\n\nVisible text after.'

  await page.addInitScript(() => {
    const original = String.prototype.matchAll
    String.prototype.matchAll = function (matcher: RegExp | string) {
      if (
        typeof this === 'string'
        && this.includes('[[agent:')
        && matcher instanceof RegExp
        && matcher.source === '\\[\\[agent:\\s*([\\s\\S]*?)\\s*\\|\\s*quote:\\s*([\\s\\S]*?)\\]\\]'
        && matcher.flags.includes('g')
      ) {
        throw new Error('legacy-parser-invoked')
      }
      return Reflect.apply(original, this, [matcher])
    }
  })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'MetadataV2.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }]),
    })
  })

  await page.route('**/api/documents/demo/annotations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: '[]' })
      return
    }
    await route.fallback()
  })

  await page.goto('/wiki/demo')

  await expect(page.getByRole('button', { name: 'Open (0)' })).toBeVisible()
  await expect(page.locator('aside').filter({ hasText: 'Annotations' }).getByText('hidden instruction')).toHaveCount(0)
})

test('saves annotation when selected quote spans multiple lines', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const multiLineBody = 'First line with selected part.\n\nSecond line continues selection here.'
  const annotationStore: Array<{ id: string; document_id: string; scope: 'text'; instruction: string; line_no: number; version: number; created_at: string; updated_at: string }> = []

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Demo.md', body: multiLineBody, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.route('**/api/documents/demo/annotations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(annotationStore) })
      return
    }
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { scope: string; instruction: string; line_no: number }
      const now = '2026-05-10T00:00:00.000Z'
      const created = { id: `ann-${annotationStore.length + 1}`, document_id: 'demo', scope: 'text' as const, instruction: payload.instruction, line_no: payload.line_no, version: 1, created_at: now, updated_at: now }
      annotationStore.push(created)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(created) })
      return
    }
    await route.fallback()
  })

  await page.goto('/wiki/demo')
  const editorShell = page.getByTestId('wiki-editor-shell')
  await expect(editorShell).toBeVisible()

  await editorShell.evaluate((node) => {
    const root = node as HTMLElement
    const paragraphs = Array.from(root.querySelectorAll('p'))
    const firstP = paragraphs.find((p) => p.textContent?.includes('selected part'))
    const secondP = paragraphs.find((p) => p.textContent?.includes('selection here'))
    if (!firstP || !secondP) throw new Error('Expected two paragraphs in editor')

    const firstText = document.createTreeWalker(firstP, NodeFilter.SHOW_TEXT).nextNode()
    const secondText = document.createTreeWalker(secondP, NodeFilter.SHOW_TEXT).nextNode()
    if (!firstText?.textContent || !secondText?.textContent) throw new Error('Missing text nodes')

    const start = firstText.textContent.indexOf('selected part')
    const end = secondText.textContent.indexOf('selection') + 'selection'.length
    if (start < 0 || end <= 0) throw new Error('Selection markers not found')

    const range = document.createRange()
    range.setStart(firstText, start)
    range.setEnd(secondText, end)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await waitForSelectionAction(page)
  await expect(page.getByTestId('wiki-selection-comment-button')).toBeVisible()
  await page.getByTestId('wiki-selection-comment-button').click()
  const commentTextarea = page.getByTestId('wiki-comment-textarea')
  await commentTextarea.fill('Multiline quote should still become annotation')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('button', { name: 'Open (1)' })).toBeVisible()
  await expect(page.locator('aside').filter({ hasText: 'Annotations' }).getByText('Multiline quote should still become annotation')).toBeVisible()
})

test('selection scope transition matrix constrains desktop actions deterministically', async ({ page }) => {
  const body = 'First block text for scoped actions.\n\nSecond block text for cross block selection.'

  await page.route('**/api/features/flags', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        annotations_v2_enabled: true,
        dual_write_enabled: false,
        ai_confirm_required: true,
        selection_scope_v2_enabled: true,
      }),
    })
  })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Scope.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')
  const editorShell = page.getByTestId('wiki-editor-shell')
  await expect(editorShell).toBeVisible()

  await editorShell.evaluate((root) => {
    const paragraphs = Array.from((root as HTMLElement).querySelectorAll('p'))
    const first = paragraphs[0]
    const second = paragraphs[1]
    if (!first || !second) throw new Error('Expected two paragraphs')
    const firstText = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()
    const secondText = document.createTreeWalker(second, NodeFilter.SHOW_TEXT).nextNode()
    if (!firstText?.textContent || !secondText?.textContent) throw new Error('Missing paragraph text nodes')

    const selection = window.getSelection()
    selection?.removeAllRanges()

    const textRange = document.createRange()
    const textStart = firstText.textContent.indexOf('scoped actions')
    textRange.setStart(firstText, textStart)
    textRange.setEnd(firstText, textStart + 'scoped'.length)
    selection?.addRange(textRange)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await waitForSelectionAction(page)
  const desktopToolbar = page.getByTestId('wiki-selection-toolbar')
  await expect(desktopToolbar).toHaveAttribute('data-selection-scope', 'text')
  await expect(page.getByTestId('wiki-selection-comment-button')).toBeVisible()

  await editorShell.evaluate((root) => {
    const first = (root as HTMLElement).querySelectorAll('p')[0]
    if (!first) throw new Error('Missing first paragraph')
    const text = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()
    if (!text?.textContent) throw new Error('Missing first paragraph text')
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, text.textContent.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await expect(desktopToolbar).toHaveAttribute('data-selection-scope', 'block')
  await expect(page.getByTestId('wiki-selection-comment-button')).toHaveCount(0)
  await expect(page.getByTestId('wiki-comment-textarea')).toHaveCount(0)

  await editorShell.evaluate((root) => {
    const paragraphs = Array.from((root as HTMLElement).querySelectorAll('p'))
    const first = paragraphs[0]
    const second = paragraphs[1]
    if (!first || !second) throw new Error('Expected two paragraphs for multi-block selection')
    const firstText = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()
    const secondText = document.createTreeWalker(second, NodeFilter.SHOW_TEXT).nextNode()
    if (!firstText?.textContent || !secondText?.textContent) throw new Error('Missing text for multi-block selection')
    const range = document.createRange()
    range.setStart(firstText, 0)
    range.setEnd(secondText, Math.min(secondText.textContent.length, 'Second'.length))
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await expect(desktopToolbar).toHaveAttribute('data-selection-scope', 'multi_block')
  await expect(page.getByTestId('wiki-selection-comment-button')).toHaveCount(0)
})

test('selection scope transition matrix constrains mobile actions deterministically', async ({ page }) => {
  const body = 'First mobile block text for scoped actions.\n\nSecond mobile block text for cross block selection.'
  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/features/flags', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        annotations_v2_enabled: true,
        dual_write_enabled: false,
        ai_confirm_required: true,
        selection_scope_v2_enabled: true,
      }),
    })
  })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'MobileScope.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')
  const editorShell = page.getByTestId('wiki-editor-shell')
  const actions = page.getByTestId('wiki-mobile-selection-actions')
  const defaultCommentsButton = page.getByTestId('wiki-mobile-nav-comments')
  await expect.poll(async () => await editorShell.locator('p').count()).toBeGreaterThan(0)
  await editorShell.click()

  await editorShell.evaluate((root) => {
    const first = Array.from((root as HTMLElement).querySelectorAll('p')).find((p) => (p.textContent || '').trim().length > 0)
    if (!first) throw new Error('Missing first mobile paragraph')
    const text = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()
    if (!text?.textContent) throw new Error('Missing first mobile text')
    const start = text.textContent.indexOf('scoped actions')
    const range = document.createRange()
    range.setStart(text, start)
    range.setEnd(text, start + 'scoped'.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await waitForSelectionAction(page)
  await expect(actions).toHaveAttribute('data-selection-scope', 'text')
  await expect(page.getByTestId('wiki-mobile-nav-comment')).toBeVisible()

  await editorShell.evaluate((root) => {
    const first = Array.from((root as HTMLElement).querySelectorAll('p')).find((p) => (p.textContent || '').trim().length > 0)
    if (!first) throw new Error('Missing first mobile paragraph for block selection')
    const text = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()
    if (!text?.textContent) throw new Error('Missing first text for block selection')
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, text.textContent.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await expect(actions).toHaveAttribute('data-selection-scope', 'block')
  await expect(page.getByTestId('wiki-mobile-nav-comment')).toHaveCount(0)
  await expect(page.getByTestId('wiki-mobile-nav-copy')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-nav-close')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-comment-sheet')).toHaveCount(0)

  await editorShell.evaluate((root) => {
    const paragraphs = Array.from((root as HTMLElement).querySelectorAll('p'))
    const first = paragraphs[0]
    const second = paragraphs[1]
    if (!first || !second) throw new Error('Expected two mobile paragraphs for multi-block selection')
    const firstText = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()
    const secondText = document.createTreeWalker(second, NodeFilter.SHOW_TEXT).nextNode()
    if (!firstText?.textContent || !secondText?.textContent) throw new Error('Missing mobile text for multi-block selection')
    const range = document.createRange()
    range.setStart(firstText, 0)
    range.setEnd(secondText, Math.min(secondText.textContent.length, 'Second'.length))
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await expect(actions).toHaveAttribute('data-selection-scope', 'multi_block')
  await expect(page.getByTestId('wiki-mobile-nav-comment')).toHaveCount(0)
  await expect(page.getByTestId('wiki-mobile-nav-copy')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-nav-close')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-comment-sheet')).toHaveCount(0)
})

test('selection scope fallback exhaust path uses outside-root-fallback with stable mobile UI', async ({ page }) => {
  const body = 'Root paragraph for fallback detection checks.'
  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/features/flags', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        annotations_v2_enabled: true,
        dual_write_enabled: false,
        ai_confirm_required: true,
        selection_scope_v2_enabled: true,
      }),
    })
  })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Fallback.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')
  const editorShell = page.getByTestId('wiki-editor-shell')
  const actions = page.getByTestId('wiki-mobile-selection-actions')
  const defaultCommentsButton = page.getByTestId('wiki-mobile-nav-comments')
  await expect.poll(async () => await editorShell.locator('p').count()).toBeGreaterThan(0)

  await page.evaluate(() => {
    ;(window as typeof window & { __wikiSelectionTransitions?: Array<{ previous: string; next: string; reason: string }> }).__wikiSelectionTransitions = []
    document.addEventListener('wiki:selection-scope-transition', ((event: Event) => {
      const custom = event as CustomEvent<{ previous: string; next: string; reason: string }>
      const store = (window as typeof window & { __wikiSelectionTransitions?: Array<{ previous: string; next: string; reason: string }> }).__wikiSelectionTransitions
      if (store) store.push(custom.detail)
    }) as EventListener)
  })

  await page.evaluate(() => {
    const outside = document.createElement('p')
    outside.id = 'outside-root-selection-target'
    outside.textContent = 'Outside root fallback text'
    document.body.appendChild(outside)
    const textNode = outside.firstChild
    if (!textNode?.textContent) throw new Error('Outside root text node missing')
    const range = document.createRange()
    range.setStart(textNode, 0)
    range.setEnd(textNode, textNode.textContent.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const editorShell = document.querySelector('[data-testid="wiki-editor-shell"]')
    if (!(editorShell instanceof HTMLElement)) throw new Error('Editor shell missing')
    editorShell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })

  await expect.poll(async () => await actions.count()).toBeGreaterThan(0)
  await expect(actions).toBeVisible()
  await expect(actions).toHaveAttribute('data-selection-scope', 'block')
  await expect(page.getByTestId('wiki-mobile-nav-comment')).toHaveCount(0)
  await expect(page.getByTestId('wiki-mobile-nav-copy')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-nav-close')).toBeVisible()
  await expect(defaultCommentsButton).toHaveCount(0)
  await expect(page.getByTestId('wiki-mobile-comment-sheet')).toHaveCount(0)

  await expect.poll(async () => {
    return page.evaluate(() => {
      const transitions = (window as typeof window & { __wikiSelectionTransitions?: Array<{ previous: string; next: string; reason: string }> }).__wikiSelectionTransitions || []
      return transitions.some((item) => item.reason === 'outside-root-fallback')
    })
  }).toBe(true)
})

test('desktop leak guard forced-failure scenario surfaces leaked legacy marker deterministically', async ({ page }) => {
  await page.route('**/api/features/flags', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        annotations_v2_enabled: false,
        dual_write_enabled: false,
        ai_confirm_required: true,
        selection_scope_v2_enabled: false,
      }),
    })
  })

  await page.setViewportSize({ width: 1280, height: 900 })
  const body = [
    'Visible intro paragraph.',
    '\\[\\[agent: escaped marker | quote: this stays literal\\]\\]',
    '[[agent: hidden instruction | quote: multiline',
    'quote payload]]',
    'Visible outro paragraph.'
  ].join('\n\n')

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'LeakGuard.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')

  const editorShell = page.getByTestId('wiki-editor-shell')
  await expect(editorShell).toContainText('Visible intro paragraph.')
  await expect(editorShell).toContainText('Visible outro paragraph.')
  await expect(editorShell).toContainText('[[agent: escaped marker | quote: this stays literal]]')
  await expect(editorShell).toContainText('[[agent: hidden instruction | quote: multilinequote payload]]')
})

test('mobile bottom action bar excludes deprecated format sheet trigger', async ({ page }) => {
  const body = 'Mobile actions should stay in thumb zone at the bottom.'

  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Mobile.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')

  const bottomNav = page.getByTestId('wiki-mobile-bottom-nav')
  await expect(bottomNav.getByTestId('wiki-mobile-nav-format')).toHaveCount(0)
  await expect(bottomNav.getByTestId('wiki-mobile-nav-comments')).toBeVisible()
  await expect(bottomNav.getByTestId('wiki-mobile-nav-files')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-format-sheet')).toHaveCount(0)
})

test('supports markdown-style heading command in block editor', async ({ page }) => {
  const body = 'Start writing here.'

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Slash.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')

  const editorShell = page.getByTestId('wiki-editor-shell')
  const editorParagraph = editorShell.locator('p').first()
  await editorParagraph.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.type('# Heading One')
  await page.keyboard.press('Enter')
  await expect(editorShell.locator('h1')).toContainText('Heading One')
})

test('slash allowlisted command executes deterministic observable behavior', async ({ page }) => {
  const body = 'Selected text can be used with slash command.'

  await page.setViewportSize({ width: 1280, height: 900 })

  await page.addInitScript(() => {
    ;(window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics = { blockedAttempts: 0, executed: 0, executionRate: 0 }
    document.addEventListener('wiki:slash-metrics', ((event: Event) => {
      const custom = event as CustomEvent<{ blockedAttempts: number; executed: number; executionRate: number }>
      ;(window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics = custom.detail
    }) as EventListener)
  })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Slash.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')

  const editorParagraph = page.getByTestId('wiki-editor-shell').locator('p').first()
  await expect(editorParagraph).toContainText('Selected text')
  await editorParagraph.evaluate((node) => {
    const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
    if (!textNode?.textContent) throw new Error('Editor text missing')
    const start = textNode.textContent.indexOf('Selected text')
    if (start < 0) throw new Error('Selection text not found')

    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'Selected text'.length)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await waitForSelectionAction(page)
  const slashInput = page.getByTestId('wiki-slash-input')
  await slashInput.focus()
  await slashInput.fill('/files')
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('wiki-slash-menu-desktop')).toHaveCount(0)
  await expect(page.getByTestId('wiki-slash-no-match')).toHaveCount(0)
  await expect.poll(async () => {
    return page.evaluate(() => {
      const summary = (window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics
      return summary?.executed ?? 0
    })
  }).toBeGreaterThan(0)
})

test('mobile slash sheet keeps allowlisted execution and blocked no-match parity', async ({ page }) => {
  const body = 'Mobile slash should preserve allowlisted and blocked behaviors.'

  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'MobileSlash.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.addInitScript(() => {
    ;(window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics = { blockedAttempts: 0, executed: 0, executionRate: 0 }
    document.addEventListener('wiki:slash-metrics', ((event: Event) => {
      const custom = event as CustomEvent<{ blockedAttempts: number; executed: number; executionRate: number }>
      ;(window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics = custom.detail
    }) as EventListener)
  })

  await page.goto('/wiki/demo')

  const slashInput = page.getByTestId('wiki-slash-input')

  await slashInput.focus()
  await slashInput.fill('/files')
  await page.getByTestId('wiki-mobile-slash-item-files').click()
  await expect(page.getByTestId('wiki-mobile-files-sheet')).toBeVisible()

  await page.getByTestId('wiki-mobile-files-sheet').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByTestId('wiki-mobile-files-sheet')).toBeHidden()

  await slashInput.focus()
  await slashInput.fill('/not-in-whitelist-command-12345678901234567890')
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('wiki-mobile-slash-sheet')).toBeVisible()
  await expect(page.getByTestId('wiki-slash-no-match')).toBeVisible()
  await expect.poll(async () => {
    return page.evaluate(() => {
      const summary = (window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics
      return summary?.blockedAttempts ?? 0
    })
  }).toBeGreaterThan(0)
})

test('slash non-whitelisted command is blocked with deterministic no-match', async ({ page }) => {
  const body = 'Unknown slash command should be blocked.'

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'SlashBlock.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.addInitScript(() => {
    ;(window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics = { blockedAttempts: 0, executed: 0, executionRate: 0 }
    document.addEventListener('wiki:slash-metrics', ((event: Event) => {
      const custom = event as CustomEvent<{ blockedAttempts: number; executed: number; executionRate: number }>
      ;(window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics = custom.detail
    }) as EventListener)
  })

  await page.goto('/wiki/demo')
  const slashInput = page.getByTestId('wiki-slash-input')
  await slashInput.focus()
  await slashInput.fill('/not-in-whitelist-command-12345678901234567890')
  await page.keyboard.press('Enter')

  await expect(page.getByTestId('wiki-slash-no-match')).toBeVisible()
  await expect(page.getByTestId('wiki-comment-textarea')).toHaveCount(0)
  await expect.poll(async () => {
    return page.evaluate(() => {
      const summary = (window as typeof window & { __slashMetrics?: { blockedAttempts: number; executed: number; executionRate: number } }).__slashMetrics
      return summary?.blockedAttempts ?? 0
    })
  }).toBeGreaterThan(0)
})

test('editor feedback interactions support add edit delete without review blocking', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'task-1', title: 'Editor task', status: 'in_progress' }]),
    })
  })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) })
  })

  await page.route('**/api/workspace/tasks/task-1', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ task_id: 'task-1', markdown: 'Line one\nLine two' }) })
      return
    }
    if (route.request().method() === 'POST') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ saved: true, count: 0, revision_id: 'rev-1', annotations: [] }) })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/workspace/tasks/task-1/revisions', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ revision_id: 'rev-1', saved_at: '2026-05-10T00:00:00.000Z', review_decision: 'pending', review_summary: '', annotations_count: 0 }]) })
  })

  await page.goto('/editor/task-1')

  await expect(page.getByText('Odeslat recenzi')).toHaveCount(0)
  await expect(page.getByText('Balíček zpětné vazby')).toHaveCount(0)

  const editor = page.getByTestId('editor-markdown-textarea')
  await editor.focus()
  await editor.evaluate((el: HTMLTextAreaElement) => {
    el.setSelectionRange(0, 8)
  })

  const commentInput = page.getByPlaceholder('Komentář k vybranému textu').last()
  await commentInput.fill('První komentář')
  await page.getByRole('button', { name: 'Přidat z výběru' }).click()
  await expect(page.getByText('První komentář')).toBeVisible()

  await page.getByRole('button', { name: 'Upravit' }).click()
  await commentInput.fill('Upravený komentář')
  await page.getByRole('button', { name: 'Uložit změny' }).click()
  await expect(page.getByText('Upravený komentář')).toBeVisible()

  await page.getByRole('button', { name: 'Smazat' }).click()
  await expect(page.getByText('Upravený komentář')).toHaveCount(0)
})

test('editor selection anchoring parity supports keyboard and mouse add flows', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'task-1', title: 'Editor task', status: 'in_progress' }]) })
  })
  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) })
  })
  await page.route('**/api/workspace/tasks/task-1', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ task_id: 'task-1', markdown: 'Mouse anchor line\nKeyboard anchor line' }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ saved: true, count: 0, revision_id: 'rev-1', annotations: [] }) })
  })
  await page.route('**/api/workspace/tasks/task-1/revisions', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ revision_id: 'rev-1', saved_at: '2026-05-10T00:00:00.000Z', review_decision: 'pending', review_summary: '', annotations_count: 0 }]) })
  })

  await page.goto('/editor/task-1')
  const editor = page.getByTestId('editor-markdown-textarea')
  const commentInput = page.getByPlaceholder('Komentář k vybranému textu').last()

  await editor.focus()
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 5))
  await commentInput.fill('Mouse selection note')
  await page.getByRole('button', { name: 'Přidat z výběru' }).click()
  await expect(page.getByText('Mouse selection note')).toBeVisible()

  await editor.focus()
  await page.keyboard.press('End')
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')
  await commentInput.fill('Keyboard selection note')
  await page.getByRole('button', { name: 'Přidat z výběru' }).click()
  await expect(page.getByText('Keyboard selection note')).toBeVisible()
})

test('editor mobile parity path keeps add edit delete non-blocking', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'task-1', title: 'Editor task', status: 'in_progress' }]) })
  })
  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([]) })
  })
  await page.route('**/api/workspace/tasks/task-1', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ task_id: 'task-1', markdown: 'Mobile line one\nMobile line two' }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ saved: true, count: 0, revision_id: 'rev-1', annotations: [] }) })
  })
  await page.route('**/api/workspace/tasks/task-1/revisions', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ revision_id: 'rev-1', saved_at: '2026-05-10T00:00:00.000Z', review_decision: 'pending', review_summary: '', annotations_count: 0 }]) })
  })

  await page.goto('/editor/task-1')
  await page.getByRole('button', { name: 'Anotace' }).click()

  const editor = page.getByTestId('editor-markdown-textarea')
  await editor.focus()
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 6))

  const commentInput = page.getByPlaceholder('Komentář k vybranému textu').nth(1)
  await commentInput.fill('Mobilní komentář')
  await page.getByRole('button', { name: 'Přidat z výběru' }).click()
  await expect(page.getByText('Mobilní komentář')).toHaveCount(2)

  await page.getByRole('button', { name: 'Upravit' }).click()
  await commentInput.fill('Mobilní upravený komentář')
  await page.getByRole('button', { name: 'Uložit změny' }).click()
  await expect(page.getByText('Mobilní upravený komentář')).toHaveCount(2)

  await page.getByRole('button', { name: 'Smazat' }).click()
  await expect(page.getByText('Mobilní upravený komentář')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Uložit' })).toBeVisible()
})

test('dedicated block editor keeps block handle and formatting toolbar hidden', async ({ page }) => {
  const body = 'Selecting this sentence should not open deprecated format controls.'

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Format.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')

  const editorParagraph = page.getByTestId('wiki-editor-shell').locator('p').first()
  await expect(editorParagraph).toContainText('Selecting this sentence')

  await editorParagraph.evaluate((node) => {
    const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
    if (!textNode?.textContent) throw new Error('Editor text missing')
    const start = textNode.textContent.indexOf('Selecting this sentence')
    if (start < 0) throw new Error('Selection text not found')

    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'Selecting this sentence'.length)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await waitForSelectionAction(page)
  await expect(page.getByTestId('wiki-selection-toolbar')).toBeVisible()
  await expect(page.locator('[class*="bn-side-menu"]')).toHaveCount(0)
  await expect(page.locator('[class*="bn-formatting-toolbar"]')).toHaveCount(0)
})

test('mobile selection opens comment sheet and persists annotation marker', async ({ page }) => {
  const body = 'Mobile editor text supports selecting a quote and saving a comment from a bottom sheet.'
  const createdAnnotationPayloads: Array<{ scope: string; instruction: string; line_no: number }> = []
  const annotationStore: Array<{ id: string; document_id: string; scope: 'text'; instruction: string; line_no: number; version: number; created_at: string; updated_at: string }> = []

  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Mobile.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.route('**/api/documents/demo/annotations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(annotationStore) })
      return
    }
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { scope: string; instruction: string; line_no: number }
      createdAnnotationPayloads.push(payload)
      const now = '2026-05-10T00:00:00.000Z'
      const created = { id: `ann-${annotationStore.length + 1}`, document_id: 'demo', scope: 'text' as const, instruction: payload.instruction, line_no: payload.line_no, version: 1, created_at: now, updated_at: now }
      annotationStore.push(created)
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(created) })
      return
    }
    await route.fallback()
  })

  await page.route('**/api/knowledge/notes/demo', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'demo',
        title: 'Mobile.md',
        body,
        created_at: '2026-05-03T00:00:00.000Z',
        updated_at: '2026-05-03T00:00:00.000Z'
      })
    })
  })

  await page.goto('/wiki/demo')

  await expect(page.getByTestId('wiki-mobile-topbar')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-bottom-nav')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-bottom-nav').getByTestId('wiki-mobile-nav-format')).toHaveCount(0)
  await expect(page.getByTestId('wiki-mobile-bottom-nav').getByTestId('wiki-mobile-nav-comments')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-bottom-nav').getByTestId('wiki-mobile-nav-files')).toBeVisible()
  await expect(page.locator('aside.app-sidebar')).toBeHidden()

  const editorShell = page.getByTestId('wiki-editor-shell')
  const editorParagraph = editorShell.locator('p').first()
  await expect(editorParagraph).toContainText('selecting a quote')

  await editorParagraph.evaluate((node) => {
    const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
    if (!textNode?.textContent) throw new Error('Editor text missing')
    const start = textNode.textContent.indexOf('selecting a quote')
    if (start < 0) throw new Error('Quote not found')

    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'selecting a quote'.length)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  await expect(page.getByTestId('wiki-selection-toolbar')).toBeHidden()
  const bottomNav = page.getByTestId('wiki-mobile-bottom-nav')
  await expect(bottomNav.getByTestId('wiki-mobile-nav-format')).toHaveCount(0)
  await expect(bottomNav.getByTestId('wiki-mobile-nav-comments')).toBeHidden()
  await expect(bottomNav.getByTestId('wiki-mobile-nav-files')).toBeHidden()
  await waitForSelectionAction(page)
  await expect(page.getByTestId('wiki-mobile-nav-comment')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-nav-copy')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-nav-close')).toBeVisible()
  await page.getByTestId('wiki-mobile-nav-comment').click()

  await expect(page.getByTestId('wiki-mobile-comment-sheet')).toBeVisible()
  const commentTextarea = page.getByTestId('wiki-comment-textarea')
  await commentTextarea.fill('Mobile comment from sheet')
  await page.getByTestId('wiki-mobile-comment-sheet').getByRole('button', { name: 'Uložit' }).click()

  await expect(page.getByTestId('wiki-mobile-comment-sheet')).toBeHidden()
  await expect(bottomNav.getByTestId('wiki-mobile-nav-format')).toHaveCount(0)
  await expect(bottomNav.getByTestId('wiki-mobile-nav-comments')).toBeVisible()
  await expect(bottomNav.getByTestId('wiki-mobile-nav-files')).toBeVisible()
  await bottomNav.getByTestId('wiki-mobile-nav-comments').click()
  await expect(page.getByTestId('wiki-mobile-comments-sheet').getByText('Mobile comment from sheet')).toBeVisible()
  await expect.poll(() => createdAnnotationPayloads.length).toBe(1)
  await expect(createdAnnotationPayloads[0]?.scope).toBe('text')
})

test('mobile leak guard forced-failure scenario surfaces leaked marker in editor output', async ({ page }) => {
  await page.route('**/api/features/flags', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        annotations_v2_enabled: false,
        dual_write_enabled: false,
        ai_confirm_required: true,
        selection_scope_v2_enabled: false,
      }),
    })
  })

  const baseBody = 'Mobile note body before save.\n\n[[agent: hidden mobile | quote: line 1\nline 2]]'

  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'MobileLeak.md', body: baseBody, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')

  await expect(page.getByTestId('wiki-editor-shell')).toContainText('[[agent: hidden mobile | quote: line 1 line 2]]')
})

test('mobile selection bottom nav can dismiss selection without opening sheets', async ({ page }) => {
  const body = 'Close should dismiss the selected mobile quote without moving into another panel.'

  await page.setViewportSize({ width: 390, height: 844 })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Mobile.md', body, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')

  const editorParagraph = page.getByTestId('wiki-editor-shell').locator('p').first()
  await expect(editorParagraph).toContainText('selected mobile quote')

  await editorParagraph.evaluate((node) => {
    const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode()
    if (!textNode?.textContent) throw new Error('Editor text missing')
    const start = textNode.textContent.indexOf('selected mobile quote')
    if (start < 0) throw new Error('Quote not found')

    const range = document.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + 'selected mobile quote'.length)

    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
  })

  const bottomNav = page.getByTestId('wiki-mobile-bottom-nav')
  await waitForSelectionAction(page)
  await expect(page.getByTestId('wiki-mobile-nav-comment')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-nav-copy')).toBeVisible()
  await page.getByTestId('wiki-mobile-nav-close').click()

  await expect(page.getByTestId('wiki-mobile-nav-comment')).toBeHidden()
  await expect(page.getByTestId('wiki-mobile-nav-copy')).toBeHidden()
  await expect(bottomNav.getByTestId('wiki-mobile-nav-format')).toHaveCount(0)
  await expect(bottomNav.getByTestId('wiki-mobile-nav-comments')).toBeVisible()
  await expect(bottomNav.getByTestId('wiki-mobile-nav-files')).toBeVisible()
  await expect(page.getByTestId('wiki-mobile-comment-sheet')).toBeHidden()
})

test('api client returns safe feature-flag defaults when endpoint is unavailable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('network down')
  }) as typeof fetch

  try {
    await expect(fetchFeatureFlags()).resolves.toEqual({
      annotations_v2_enabled: false,
      dual_write_enabled: false,
      ai_confirm_required: true,
      selection_scope_v2_enabled: false,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client guards unexpected annotation response shapes', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ unexpected: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch

  try {
    await expect(listDocumentAnnotations('doc-1')).rejects.toThrow('Neplatná odpověď API.')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client normalizes canonical/legacy/mixed annotation list responses', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        { id: 'a1', document_id: 'doc-1', scope: 'text', feedback: 'canonical', line: 2, version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'a2', document_id: 'doc-1', scope: 'text', instruction: 'legacy', line_no: 3, version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'a3', document_id: 'doc-1', scope: 'text', feedback: 'mixed-canonical', line: 9, instruction: 'legacy-ignored', line_no: 1, version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

  try {
    await expect(listDocumentAnnotations('doc-1')).resolves.toEqual([
      {
        id: 'a1',
        document_id: 'doc-1',
        scope: 'text',
        feedback: 'canonical',
        line: 2,
        instruction: 'canonical',
        line_no: 2,
        version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a2',
        document_id: 'doc-1',
        scope: 'text',
        feedback: 'legacy',
        line: 3,
        instruction: 'legacy',
        line_no: 3,
        version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a3',
        document_id: 'doc-1',
        scope: 'text',
        feedback: 'mixed-canonical',
        line: 9,
        instruction: 'mixed-canonical',
        line_no: 9,
        version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client keeps orphan-anchor annotations non-blocking by preserving canonical shape', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          id: 'orphan-1',
          document_id: 'doc-1',
          scope: 'text',
          instruction: 'orphan anchor',
          line_no: 9999,
          version: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

  try {
    await expect(listDocumentAnnotations('doc-1')).resolves.toEqual([
      {
        id: 'orphan-1',
        document_id: 'doc-1',
        scope: 'text',
        feedback: 'orphan anchor',
        line: 9999,
        instruction: 'orphan anchor',
        line_no: 9999,
        version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client safely drops malformed annotation payloads from backend contract', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([{ id: 'bad-1', scope: 'text', line_no: 'oops' }]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

  try {
    await expect(listDocumentAnnotations('doc-1')).resolves.toEqual([])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client lifecycle create/edit/resolve/delete remains deterministic and non-blocking', async () => {
  const originalFetch = globalThis.fetch
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = []
  globalThis.fetch = (async (input, init) => {
    const method = init?.method ?? 'GET'
    const url = String(input)
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ method, url, body })

    if (method === 'POST') {
      return new Response(JSON.stringify({ id: 'a1', document_id: 'doc-1', scope: 'text', feedback: 'created', line: 2, instruction: 'created', line_no: 2, version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }
    if (method === 'PATCH') {
      return new Response(JSON.stringify({ id: 'a1', document_id: 'doc-1', scope: 'text', feedback: 'edited', line: 2, instruction: 'edited', line_no: 2, version: 2, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    await createDocumentAnnotation('doc-1', { scope: 'text', instruction: 'created', line_no: 2 })
    await updateDocumentAnnotation('doc-1', 'a1', { instruction: 'edited', line_no: 2, version: 1 })
    await deleteDocumentAnnotation('doc-1', 'a1')

    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'DELETE'])
    expect(calls[0]?.body).toMatchObject({ scope: 'text', feedback: 'created', line: 2, instruction: 'created', line_no: 2 })
    expect(calls[1]?.body).toMatchObject({ feedback: 'edited', line: 2, instruction: 'edited', line_no: 2, version: 1 })
    expect(calls[2]?.body).toBeNull()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client forwards explicit empty feedback in update payload for backend validation', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input, init) => {
    capturedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    return new Response(
      JSON.stringify({
        id: 'a1',
        document_id: 'doc-1',
        scope: 'text',
        feedback: 'server',
        line: 2,
        instruction: 'server',
        line_no: 2,
        version: 2,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    await updateDocumentAnnotation('doc-1', 'a1', { feedback: '', version: 1 })
    expect(capturedBody).not.toBeNull()
    expect(capturedBody).toMatchObject({ feedback: '', instruction: '', version: 1 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client surfaces conflict handling for annotation updates', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'conflict', message: 'version conflict' } }), { status: 409, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  try {
    await expect(updateDocumentAnnotation('doc-1', 'a1', { instruction: 'x', line_no: 1, version: 1 })).rejects.toThrow()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('api client create annotation sends mirrored canonical and legacy fields', async () => {
  const originalFetch = globalThis.fetch
  let capturedBody: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input, init) => {
    capturedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    return new Response(
      JSON.stringify({
        id: 'a1',
        document_id: 'doc-1',
        scope: 'text',
        feedback: 'server',
        line: 4,
        instruction: 'server',
        line_no: 4,
        version: 1,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    await createDocumentAnnotation('doc-1', { scope: 'text', instruction: 'hello', line_no: 4 })
    expect(capturedBody).toMatchObject({ scope: 'text', feedback: 'hello', line: 4, instruction: 'hello', line_no: 4 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('desktop ai flow supports preview then confirm then undo', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const confirms: Array<{ operation_id: string; base_version: number }> = []
  let undos = 0
  const baseBody = 'Original content before AI confirm.'
  const previewBody = 'Preview content returned by AI.'

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Demo.md', body: baseBody, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.route('**/api/documents/*/ai/preview', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', base_version: 1, proposed_content: previewBody, persisted: false }) })
  })

  await page.route('**/api/documents/*/ai/confirm', async (route) => {
    confirms.push(route.request().postDataJSON() as { operation_id: string; base_version: number })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', applied: true, idempotent: false, version: 2 }) })
  })
  await page.route('**/api/documents/*/ai/undo', async (route) => {
    undos += 1
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', undone: true, version: 3 }) })
  })

  await page.goto('/wiki/demo')
  await expect(page.getByTestId('wiki-editor-shell')).toContainText(baseBody)
  await openAiAssistant(page)
  await page.getByTestId('wiki-ai-prompt-input').fill('Improve style')
  await page.getByTestId('wiki-ai-preview-submit').click()

  await expect(page.getByTestId('wiki-ai-status')).toContainText('Preview ready')
  await expect(page.getByTestId('wiki-editor-shell')).toContainText(baseBody)
  await page.getByTestId('wiki-ai-confirm-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Applied')
  await expect(page.getByTestId('wiki-editor-shell')).toContainText(previewBody)
  await page.getByTestId('wiki-ai-undo-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Undone')
  await expect(page.getByTestId('wiki-editor-shell')).toContainText(baseBody)

  await expect(page.getByTestId('wiki-ai-metric-preview-opened')).toContainText('1')
  await expect(page.getByTestId('wiki-ai-metric-confirm-success')).toContainText('1')
  await expect(page.getByTestId('wiki-ai-metric-undo-success')).toContainText('1')
  await expect(page.getByTestId('wiki-ai-metric-auto-apply-violations')).toContainText('0')
  await expect(confirms.length).toBe(1)
  await expect(undos).toBe(1)
})

test('ai preview validation blocks out-of-bounds prompt with generic error', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  let previewCalls = 0

  await page.route('**/api/documents/*/ai/preview', async (route) => {
    previewCalls += 1
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', base_version: 1, proposed_content: 'preview', persisted: false }) })
  })

  await page.goto('/wiki/demo')
  await openAiAssistant(page)

  await page.getByTestId('wiki-ai-prompt-input').fill('x')
  await page.getByTestId('wiki-ai-preview-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Preview failed')

  await page.getByTestId('wiki-ai-prompt-input').fill('x'.repeat(2001))
  await page.getByTestId('wiki-ai-preview-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Preview failed')
  await expect(previewCalls).toBe(0)
})

test('ai preview persisted=true increments auto-apply violation metric', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.route('**/api/documents/*/ai/preview', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', base_version: 1, proposed_content: 'preview', persisted: true }) })
  })

  await page.goto('/wiki/demo')
  await openAiAssistant(page)
  await page.getByTestId('wiki-ai-prompt-input').fill('Valid prompt for preview')
  await page.getByTestId('wiki-ai-preview-submit').click()

  await expect(page.getByTestId('wiki-ai-status')).toContainText('Preview ready')
  await expect(page.getByTestId('wiki-ai-metric-auto-apply-violations')).toContainText('1')
})

test('mobile ai flow supports preview then confirm then undo', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/wiki/demo')

  await openAiAssistant(page)
  const sheet = page.getByTestId('wiki-mobile-ai-sheet')
  await expect(sheet).toBeVisible()
  await sheet.getByTestId('wiki-ai-prompt-input').fill('Summarize this note')
  await sheet.getByTestId('wiki-ai-preview-submit').click()
  await expect(sheet.getByTestId('wiki-ai-status')).toContainText('Preview ready')
  await sheet.getByTestId('wiki-ai-confirm-submit').click()
  await expect(sheet.getByTestId('wiki-ai-status')).toContainText('Applied')
  await sheet.getByTestId('wiki-ai-undo-submit').click()
  await expect(sheet.getByTestId('wiki-ai-status')).toContainText('Undone')
})

test('dismissing preview without confirm does not mutate document', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  let confirmCalls = 0
  let undoCalls = 0

  await page.route('**/api/documents/*/ai/confirm', async (route) => {
    confirmCalls += 1
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', applied: true, idempotent: false, version: 2 }) })
  })
  await page.route('**/api/documents/*/ai/undo', async (route) => {
    undoCalls += 1
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', undone: true, version: 3 }) })
  })

  await page.goto('/wiki/demo')
  await openAiAssistant(page)
  await page.getByTestId('wiki-ai-prompt-input').fill('Preview only')
  await page.getByTestId('wiki-ai-preview-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Preview ready')
  await page.getByTestId('wiki-ai-dismiss-preview').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Idle')
  await expect(confirmCalls).toBe(0)
  await expect(undoCalls).toBe(0)
})

test('theme tokens keep slash, selection, and ai surfaces readable in light and dark themes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Theme.md', body: 'Theme surface validation body text for selection.', created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }]),
    })
  })

  await page.goto('/wiki/demo')
  await expect(page.getByTestId('wiki-slash-input')).toBeVisible()
  await page.getByTestId('wiki-slash-input').focus()
  await expect(page.getByTestId('wiki-slash-menu-desktop')).toBeVisible()

  await openSelectionToolbar(page)

  await openAiAssistant(page)
  await expect(page.getByTestId('wiki-ai-popup-desktop')).toBeVisible()

  for (const theme of ['dark', 'light'] as const) {
    await setTheme(page, theme)
    await openSelectionToolbar(page)
    const slashBackground = await page.getByTestId('wiki-slash-menu-desktop').evaluate((el) => globalThis.getComputedStyle(el).backgroundColor)
    const selectionBackground = await page.getByTestId('wiki-selection-toolbar').evaluate((el) => globalThis.getComputedStyle(el).backgroundColor)
    const aiBackground = await page.getByTestId('wiki-ai-popup-desktop').evaluate((el) => globalThis.getComputedStyle(el).backgroundColor)

    expect(slashBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(selectionBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(aiBackground).not.toBe('rgba(0, 0, 0, 0)')
    await page.getByTestId('wiki-selection-toolbar').getByRole('button', { name: 'x' }).click()

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('wiki-ai-trigger-mobile')).toBeVisible()
    await page.getByTestId('wiki-ai-trigger-mobile').click()
    await expect(page.getByTestId('wiki-mobile-ai-sheet')).toBeVisible()
    const overlayToken = await page.evaluate(() => globalThis.getComputedStyle(document.documentElement).getPropertyValue('--overlay-backdrop').trim())
    const sheetCoversOverlay = await page.evaluate(() => {
      const sheet = document.querySelector('[data-testid="wiki-mobile-sheet-surface"]') as HTMLElement | null
      if (!sheet) return false
      const rect = sheet.getBoundingClientRect()
      const topElement = document.elementFromPoint(rect.left + (rect.width / 2), rect.top + 8)
      return Boolean(topElement && sheet.contains(topElement))
    })
    expect(overlayToken).not.toBe('rgba(0, 0, 0, 0)')
    expect(sheetCoversOverlay).toBe(true)
    await page.getByTestId('wiki-mobile-sheet-surface').getByRole('button', { name: 'Close' }).click()
    await page.setViewportSize({ width: 1280, height: 900 })
  }
})

test('ai flow handles stale conflict, duplicate confirm, and undo unavailable states', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  let previewCalls = 0
  let confirmCalls = 0

  await page.route('**/api/documents/*/ai/preview', async (route) => {
    previewCalls += 1
    if (previewCalls === 1) {
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'stale preview' }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', base_version: 1, proposed_content: 'preview', persisted: false }) })
  })

  await page.route('**/api/documents/*/ai/confirm', async (route) => {
    confirmCalls += 1
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ operation_id: 'mock-op', applied: true, idempotent: confirmCalls > 1, version: 2 }) })
  })
  await page.route('**/api/documents/*/ai/undo', async (route) => {
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'undo unavailable' }) })
  })

  await page.goto('/wiki/demo')
  await openAiAssistant(page)
  await page.getByTestId('wiki-ai-prompt-input').fill('Handle conflicts')
  await page.getByTestId('wiki-ai-preview-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Stale preview conflict')
  await page.getByTestId('wiki-ai-preview-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Preview ready')
  await page.getByTestId('wiki-ai-confirm-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Applied')
  await page.getByTestId('wiki-ai-confirm-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Duplicate confirm blocked')
  await page.getByTestId('wiki-ai-undo-submit').click()
  await expect(page.getByTestId('wiki-ai-status')).toContainText('Undo unavailable')
})
