// Phase 13 browser fixture: picker fills an editable draft and failure leaves composer usable.
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const server = http.createServer(async (req, res) => {
  if (req.url === '/quick-answer.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(await readFile(new URL('../public/quick-answer.js', import.meta.url))) }
  res.end('<!doctype html><div><form id="reply"><textarea id="message"></textarea><button id="send">Send</button></form></div>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.evaluate(async () => {
    const { mountQuickAnswer } = await import('/quick-answer.js')
    window.calls = []; window.inputs = 0
    document.querySelector('#message').addEventListener('input', () => { window.inputs++ })
    mountQuickAnswer({ api: async (action, data) => {
      window.calls.push({ action, data: structuredClone(data) })
      return { ok: true, data: { categories: [{ id: 'cat-1', name: 'Pricing' }], rows: [{ id: 'answer-1', title: 'Safe title', body_template: '<img src=x onerror=window.xss=true>' }] } }
    } })
  })
  await page.getByRole('button', { name: 'Answer Hub', exact: true }).click()
  await page.getByRole('button', { name: 'Pricing', exact: true }).click()
  assert.equal(await page.evaluate(() => calls.at(-1).action), 'ah_quick_answer')
  assert.equal(await page.evaluate(() => calls.at(-1).data.category_id), 'cat-1')
  await page.getByRole('button', { name: 'Use Safe title', exact: true }).click()
  assert.equal(await page.locator('#message').inputValue(), '<img src=x onerror=window.xss=true>')
  assert.equal(await page.evaluate(() => window.inputs), 1, 'draft dispatches normal composer input')
  assert.equal(await page.locator('img').count(), 0, 'answer preview uses text nodes')
  await page.evaluate(async () => { const { mountQuickAnswer } = await import('/quick-answer.js'); document.querySelector('#answer-hub-picker')?.remove(); mountQuickAnswer({ api: async () => ({ ok: false }) }) })
  await page.getByRole('button', { name: 'Answer Hub', exact: true }).last().click()
  assert.match(await page.locator('#answer-hub-picker').textContent(), /manual reply remain available/)
  assert.equal(await page.locator('#reply').count(), 1, 'hub failure preserves composer')
  console.log('PASS quick-answer browser: search/category/editable draft/text-only/failure fallback')
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
