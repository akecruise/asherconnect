import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slaTag, elapsedSlaMinutes, SLA_WARN_MINUTES, SLA_OVER_MINUTES } from '../public/sla.mjs'

// ───────────────────────────────────────────── slaTag() — แปลนาที → ป้าย

test('ตอบแล้ว (wait) ไม่มีป้าย ไม่ว่ารอมากี่นาที', () => {
  assert.deepEqual(slaTag(999, 'wait'), { label: '', tone: 'none' })
})

test('ปิดเคสแล้ว (closed) ไม่มีป้าย', () => {
  assert.deepEqual(slaTag(30, 'closed'), { label: '', tone: 'none' })
})

test('รอ 0 นาที ไม่มีป้าย', () => {
  assert.deepEqual(slaTag(0, 'new'), { label: '', tone: 'none' })
})

test('รอ 4 นาที ยังไม่ถึงเกณฑ์ ไม่มีป้าย', () => {
  assert.deepEqual(slaTag(4, 'new'), { label: '', tone: 'none' })
})

test('★ ขอบล่าง 5 นาที — เริ่มขึ้นป้ายแดงอ่อนพอดี', () => {
  const r = slaTag(5, 'new')
  assert.equal(r.tone, 'warn')
  assert.equal(r.label, 'รอ 5 นาที')
})

test('รอ 9 นาที ยังเป็นแดงอ่อน', () => {
  assert.equal(slaTag(9, 'new').tone, 'warn')
})

test('★ ขอบบน 10 นาที — ข้ามไปแดงเข้มพอดี ไม่ใช่แดงอ่อน', () => {
  const r = slaTag(10, 'late')
  assert.equal(r.tone, 'over')
  assert.equal(r.label, 'เกิน 10 นาที')
})

test('รอนานมาก (1440 นาที) ยังเป็นแดงเข้ม ไม่ใช่ป้ายอื่น', () => {
  assert.equal(slaTag(1440, 'late').tone, 'over')
})

test('ไม่มี case_status (undefined) แต่ตัวเลขถึงเกณฑ์ — ยังคำนวณจากตัวเลขได้ตามปกติ', () => {
  assert.equal(slaTag(12).tone, 'over')
})

test('waitingMinutes เป็น null/NaN — ปลอดภัย ไม่มีป้าย ไม่ throw', () => {
  assert.deepEqual(slaTag(null, 'new'), { label: '', tone: 'none' })
  assert.deepEqual(slaTag(undefined, 'new'), { label: '', tone: 'none' })
  assert.deepEqual(slaTag(NaN, 'new'), { label: '', tone: 'none' })
})

test('ค่าคงที่ที่ใช้จริงต้องตรงกับที่ inbox.settings ตั้งไว้ (5 / 10)', () => {
  assert.equal(SLA_WARN_MINUTES, 5)
  assert.equal(SLA_OVER_MINUTES, 10)
})

// ───────────────────────────────────────────── elapsedSlaMinutes() — หักช่วง 00:00–06:00
//
// ตรรกะนี้ไม่ใช่ตัวที่หน้าเว็บเรียกใช้ตอนเรนเดอร์จริง (ดูคำอธิบายหัวไฟล์ sla.mjs)
// แต่โจทย์ขอให้มีเทสต์คลุมกรณีนี้ไว้ด้วย — ใช้พิสูจน์ว่าสูตรตรงกับฐาน (sql/023) ไม่เพี้ยนไปเอง

test('ในเวลาทำการล้วน ๆ นับตรงตามนาฬิกา', () => {
  // 10:00–10:15 ไทย ไม่แตะช่วงหยุดนับเลย ต้องได้ 15 นาทีเป๊ะ
  const n = elapsedSlaMinutes('2026-09-01T03:00:00Z', '2026-09-01T03:15:00Z') // 10:00–10:15 ไทย
  assert.equal(n, 15)
})

test('★ ทักตอนเที่ยงคืน ตอบตอนตีห้า — ไม่นับเลยสักนาที (อยู่ในช่วงหยุดนับทั้งหมด)', () => {
  // 00:30–05:00 ไทย อยู่ในช่วง 00:00–06:00 ทั้งก้อน
  const n = elapsedSlaMinutes('2026-09-01T17:30:00Z', '2026-09-01T22:00:00Z') // (UTC ของคืนก่อนหน้า) = 00:30–05:00 ไทย
  assert.equal(n, 0)
})

test('★ ทักตอน 23:50 ตอบตอน 06:10 — นับเฉพาะ 23:50–00:00 (10 นาที) บวก 06:00–06:10 (10 นาที) = 20', () => {
  const n = elapsedSlaMinutes('2026-09-01T16:50:00Z', '2026-09-01T23:10:00Z') // 23:50 (31ส.ค.ไทย) ถึง 06:10 (1ก.ย. ไทย)
  assert.equal(n, 20)
})

test('★ ทักตอน 05:50 ตอบตอน 06:10 — นับแค่ 10 นาทีที่อยู่นอกช่วงหยุด (06:00–06:10)', () => {
  const n = elapsedSlaMinutes('2026-09-01T22:50:00Z', '2026-09-01T23:10:00Z') // 05:50–06:10 ไทย
  assert.equal(n, 10)
})

test('ทักตอน 08:00 ตอบตอน 09:00 (นอกช่วงหยุดนับทั้งคู่) — นับเต็ม 60 นาที', () => {
  const n = elapsedSlaMinutes('2026-09-01T01:00:00Z', '2026-09-01T02:00:00Z') // 08:00–09:00 ไทย
  assert.equal(n, 60)
})

test('เวลาปิดก่อนเวลาเปิด (ข้อมูลผิด) — คืน 0 ไม่ใช่ค่าติดลบ', () => {
  assert.equal(elapsedSlaMinutes('2026-09-01T03:00:00Z', '2026-09-01T02:00:00Z'), 0)
})

test('ปิดช่วงหยุดนับด้วย opts (pauseStartHour===pauseEndHour) — นับเต็มตลอด 24 ชม.', () => {
  const n = elapsedSlaMinutes('2026-09-01T17:30:00Z', '2026-09-01T18:00:00Z', { pauseStartHour: 0, pauseEndHour: 0 })
  assert.equal(n, 30)
})
