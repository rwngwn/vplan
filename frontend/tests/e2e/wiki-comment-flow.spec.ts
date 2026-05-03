import { expect, test } from '@playwright/test'

test('keeps the selected text highlight visible while typing a wiki comment', async ({ page }) => {
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

  await expect(page.getByTestId('wiki-selection-toolbar')).toBeVisible()
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
})

test('saves annotation for single-word selection', async ({ page }) => {
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

  await page.getByTestId('wiki-selection-comment-button').click()
  const commentTextarea = page.getByTestId('wiki-comment-textarea')
  await commentTextarea.fill('Komentář ke slovu')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('button', { name: 'Open (1)' })).toBeVisible()
  await expect(page.locator('aside').filter({ hasText: 'Annotations' }).getByText('Komentář ke slovu')).toBeVisible()
})

test('saves annotation when selected quote spans multiple lines', async ({ page }) => {
  const multiLineBody = 'First line with selected part.\n\nSecond line continues selection here.'

  await page.route('**/api/knowledge/notes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'demo', title: 'Demo.md', body: multiLineBody, created_at: '2026-05-03T00:00:00.000Z', updated_at: '2026-05-03T00:00:00.000Z' }])
    })
  })

  await page.goto('/wiki/demo')
  const editorShell = page.getByTestId('wiki-editor-shell')
  await expect(editorShell).toBeVisible()

  await editorShell.evaluate((node) => {
    const root = node as HTMLElement
    const firstP = root.querySelector('p')
    const secondP = root.querySelectorAll('p')[1]
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

  await page.getByTestId('wiki-selection-comment-button').click()
  const commentTextarea = page.getByTestId('wiki-comment-textarea')
  await commentTextarea.fill('Multiline quote should still become annotation')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('button', { name: 'Open (1)' })).toBeVisible()
  await expect(page.locator('aside').filter({ hasText: 'Annotations' }).getByText('Multiline quote should still become annotation')).toBeVisible()
})
