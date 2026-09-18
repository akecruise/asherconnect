// Browser UI tests with a deterministic API fixture. Real RPCs: http.integration.mjs.
// PLAYWRIGHT_MODULE points to an installed playwright/index.mjs; no runtime dependency.
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
const server = http.createServer(async (req, res) => {
  if (req.url === '/answer-hub.js' || req.url === '/answer-hub.css') {
    res.setHeader('Content-Type', req.url.endsWith('.js') ? 'text/javascript' : 'text/css')
    return res.end(await readFile(new URL('../public' + req.url, import.meta.url)))
  }
  res.end('<!doctype html><html lang="th"><meta charset="utf-8"><div id="workspace"><main><div>chat shell</div></main></div></html>')
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  page.on('dialog', d => d.accept())
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.evaluate(async () => {
    const { mountAnswerHub } = await import('/answer-hub.js')
    window.calls = []; window.items = []; window.versions = []; window.xss = false
    window.learning = [{ id: 'learning-1', question: 'Learned question', human_answer: 'Human answer' }]
    const api = async (action, data) => {
      window.calls.push({ action, data: structuredClone(data) })
      if (action === 'ah_editor_options') return { ok: true, data: { role: 'admin', categories: [], intents: [], projects: [], sources: [{ id: 'source-1', source_code: 'PROJECT_PROFILE', active: true }] } }
      if (action === 'ah_list') return { ok: true, data: { rows: window.items, total: window.items.length } }
      if (action === 'ah_save') {
        const old = window.items.find(x => x.id === data.id)
        const item = { ...data, id: data.id || 'answer-1', status: data.submit || old?.status === 'approved' ? 'review' : old?.status || 'draft' }
        if (old?.status === 'approved') window.versions.push({ version_no: 1, snapshot: old })
        window.items = [item]; return { ok: true, data: item }
      }
      if (action === 'ah_editor_get') return { ok: true, data: { item: window.items[0], bindings: window.items[0].bindings, versions: window.versions } }
      if (action === 'ah_preview') return { ok: true, rendered_text: data.body_template, missing: [], sources_used: [], warnings: [], attachments: data.attachments }
      if (action === 'ah_import_preview') return { ok: true, data: { new: 1, update: 0, rows: [{ _row: 2, classification: 'NEW', title: 'Imported answer', category: 'price_promo', body_template: 'text' }] } }
      if (action === 'ah_import_commit') return { ok: true, data: { count: 1, batch_id: 'batch-1', rows: data.rows } }
      if (action === 'ah_learning_list') return { ok: true, data: { rows: window.learning } }
      if (action === 'ah_learning_review') { window.learning = []; return { ok: true, data: { candidate: { status: data.decision === 'reject' ? 'rejected' : 'approved' }, answer_id: 'learning-answer' } } }
      if (action === 'ah_approve' || action === 'ah_retire') { window.items[0].status = action === 'ah_approve' ? 'approved' : 'retired'; return { ok: true, data: window.items[0] } }
      throw Error('Unexpected action ' + action)
    }
    await mountAnswerHub({ api, role: 'admin' })
  })
  await page.getByRole('button', { name: 'บันทึกร่าง / บันทึกการแก้ไข', exact: true }).click()
  assert.equal(await page.evaluate(() => calls.filter(x => x.action === 'ah_save').length), 0, 'required fields validated')
  await page.locator('#ae-title').fill('Browser draft')
  await page.locator('#ae-body_template').fill('<img src=x onerror="window.xss=true">')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  assert.equal(await page.evaluate(() => window.xss), false, 'preview is text, not HTML')
  assert.equal(await page.locator('#answer-editor img').count(), 0)
  await page.locator('#ai-file').setInputFiles({ name: 'answers.csv', mimeType: 'text/csv', buffer: Buffer.from('category,title,answer\nprice_promo,Imported answer,text') })
  await page.getByRole('button', { name: 'Preview import', exact: true }).click()
  await page.getByRole('button', { name: 'Apply import', exact: true }).click()
  assert.match(await page.locator('#answer-import pre').textContent(), /Imported 1 rows/)
  await page.getByRole('button', { name: 'Refresh learning queue', exact: true }).click()
  assert.equal(await page.getByText('Learned question', { exact: false }).count(), 1)
  await page.getByRole('button', { name: 'Reject', exact: true }).click()
  assert.match(await page.locator('#learning-queue').textContent(), /No pending learning candidates/)
  await page.getByRole('button', { name: 'เพิ่มตัวแปร', exact: true }).click()
  await page.locator('[name$="variable_name"]').fill('project_name')
  await page.getByRole('button', { name: 'บันทึกร่าง / บันทึกการแก้ไข', exact: true }).click()
  await page.waitForFunction(() => items.length === 1 && document.querySelector('#answer-editor').getAttribute('aria-busy') === 'false')
  assert.equal(await page.evaluate(() => items[0].bindings[0].variable_name), 'project_name')
  await page.getByRole('button', { name: 'ส่งตรวจ', exact: true }).click()
  await page.waitForFunction(() => items[0].status === 'review' && document.querySelector('#answer-editor').getAttribute('aria-busy') === 'false')
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await page.waitForFunction(() => items[0].status === 'approved' && document.querySelector('#answer-editor').getAttribute('aria-busy') === 'false')
  await page.locator('#ae-body_template').fill('Edited')
  await page.getByRole('button', { name: 'Retire', exact: true }).click()
  assert.equal(await page.evaluate(() => items[0].status), 'approved', 'dirty form blocks transition')
  await page.getByRole('button', { name: 'บันทึกร่าง / บันทึกการแก้ไข', exact: true }).click()
  await page.waitForFunction(() => versions.length === 1 && document.querySelector('#answer-editor').getAttribute('aria-busy') === 'false')
  await page.getByRole('button', { name: 'Retire', exact: true }).click()
  await page.waitForFunction(() => items[0].status === 'retired' && document.querySelector('#answer-editor').getAttribute('aria-busy') === 'false')
  assert.equal(await page.locator('#ae-title').isDisabled(), true)
  assert.deepEqual(errors, [])
  console.log('PASS browser: validation, text-only preview, bindings, draft, submit, approve, dirty protection, edit/history, retire')
} finally {
  await browser.close(); await new Promise(r => server.close(r))
}
