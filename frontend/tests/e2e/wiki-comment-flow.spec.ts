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
})
