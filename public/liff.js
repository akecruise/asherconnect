// หน้า LIFF นัดชมโครงการ (Phase 4)
//
// ★★ หน้านี้ไม่ส่ง userId ขึ้นไปเลย — ส่งแต่ ID token แล้วให้ server ถาม LINE เอง
//   ว่าใครเป็นเจ้าของ token นั้น (lib/liff.mjs verifyIdToken) เพราะโค้ดหน้านี้
//   วิ่งในเครื่องของลูกค้า แก้ค่าอะไรก็ได้ ถ้า server เชื่อ userId ที่ส่งมา
//   ใครก็จองนัดในชื่อคนอื่นได้
//
// ★ LIFF ID มาจาก /liff/config ไม่ฝังในไฟล์นี้ (ไฟล์นี้ถูกแคชและอ่านได้จากข้างนอก)

const $ = id => document.getElementById(id)
const show = (el, on = true) => { el.hidden = !on }

function fail(message) {
  $('error').textContent = message
  show($('error'))
  show($('state'), false)
}

// datetime-local ให้ค่าแบบไม่มีเขตเวลา — ต่อ offset ของเครื่องเข้าไปเอง
// ★ ถ้าส่งไปเปล่า ๆ server จะตีความเป็นเขตเวลาของ server แล้วนัดเพี้ยนชั่วโมง
function withLocalOffset(value) {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  return at.toISOString()
}

async function main() {
  let config
  try {
    const res = await fetch('/liff/config')
    if (!res.ok) throw new Error('config')
    config = await res.json()
  } catch {
    return fail('ยังเปิดใช้หน้านี้ไม่ได้ กรุณาติดต่อทีมงานครับ')
  }
  if (!config.liff_id) return fail('ยังไม่ได้ตั้งค่า LIFF กรุณาติดต่อทีมงานครับ')

  try {
    await liff.init({ liffId: config.liff_id })
  } catch {
    return fail('เชื่อมต่อ LINE ไม่สำเร็จ ลองเปิดจากแอป LINE อีกครั้งครับ')
  }
  if (!liff.isLoggedIn()) return liff.login()

  const idToken = liff.getIDToken()
  if (!idToken) return fail('ไม่ได้รับสิทธิ์จาก LINE ลองเปิดใหม่อีกครั้งครับ')

  show($('state'), false)
  show($('form'))

  $('form').addEventListener('submit', async event => {
    event.preventDefault()
    $('submit').disabled = true
    show($('error'), false)

    const scheduled = withLocalOffset($('when').value)
    if (!scheduled) { $('submit').disabled = false; return fail('กรุณาเลือกวันและเวลาครับ') }

    try {
      const res = await fetch('/liff/site-visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_token: idToken,
          scheduled_at: scheduled,
          visitor_count: Number($('visitors').value),
          note: $('note').value,
          project_ref: $('project').value || null,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        $('submit').disabled = false
        return fail(MESSAGES[body.error] ?? 'ยังบันทึกไม่ได้ ลองอีกครั้งครับ')
      }
      show($('form'), false)
      $('doneWhen').textContent = new Date(scheduled).toLocaleString('th-TH', {
        dateStyle: 'full', timeStyle: 'short',
      })
      show($('done'))
    } catch {
      $('submit').disabled = false
      fail('เครือข่ายขัดข้อง ลองอีกครั้งครับ')
    }
  })
}

// แปล error ของ server เป็นภาษาที่ลูกค้าอ่านรู้เรื่อง
const MESSAGES = {
  too_soon: 'กรุณาเลือกเวลาล่วงหน้าอย่างน้อย 1 ชั่วโมงครับ',
  too_far_ahead: 'เลือกได้ไม่เกิน 90 วันข้างหน้าครับ',
  invalid_visitor_count: 'จำนวนคนต้องอยู่ระหว่าง 1–10 ครับ',
  note_too_long: 'ข้อความยาวเกินไปครับ',
  scheduled_at_must_have_timezone: 'กรุณาเลือกวันและเวลาอีกครั้งครับ',
  invalid_scheduled_at: 'กรุณาเลือกวันและเวลาอีกครั้งครับ',
  contact_not_found: 'กรุณาทักแชทกับเราก่อนหนึ่งครั้ง แล้วลองจองอีกครั้งครับ',
  id_token_expired: 'เซสชันหมดอายุ กรุณาเปิดหน้านี้ใหม่ครับ',
  audience_mismatch: 'เปิดหน้านี้จากแอป LINE ของ ASHER เท่านั้นครับ',
  rate_limited: 'มีคำขอเข้ามามาก กรุณาลองใหม่อีกครั้งครับ',
}

main()
