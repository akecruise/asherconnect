const BANGKOK = 'Asia/Bangkok'

export function messageSide(senderType) {
  if (senderType === 'contact') return 'inbound'
  if (senderType === 'agent' || senderType === 'bot') return 'outbound'
  return 'system'
}

export function messageSenderLabel(message, contact = {}, channel = '') {
  if (message?.sender_type === 'bot') return 'Asher Bot'
  if (message?.sender_type === 'agent') {
    return message.responder_display_name || message.sender_name ||
      (channel === 'tiktok' ? 'ตอบผ่าน TikTok — ไม่ทราบผู้ตอบ' : 'ไม่ระบุผู้ตอบ')
  }
  if (message?.sender_type === 'contact') {
    const name = (contact.display_name ?? '').trim()
    if (name && name !== 'ลูกค้าใหม่') return name
    const externalId = (contact.external_id ?? '').trim()
    if (externalId) {
      const channelName = ({ line: 'LINE', messenger: 'Messenger', instagram: 'Instagram', tiktok: 'TikTok' }[channel] ?? 'แชท')
      return `ลูกค้า ${channelName} ···${externalId.slice(-4)}`
    }
    return ({ line: 'ลูกค้า LINE', messenger: 'ลูกค้า Messenger', instagram: 'ลูกค้า Instagram', tiktok: 'ลูกค้า TikTok' }[channel] ?? 'ลูกค้า')
  }
  return 'ระบบ'
}

export function messageStatus(message) {
  if (message?.sender_type !== 'agent' && message?.sender_type !== 'bot') return ''
  if (message.read_at) return 'อ่านแล้ว'
  if (message.delivered_at) return 'ส่งถึงแล้ว'
  return ({
    pending: 'กำลังส่ง', processing: 'กำลังส่ง', sending: 'กำลังส่ง',
    sent: 'ส่งแล้ว', delivered: 'ส่งถึงแล้ว', read: 'อ่านแล้ว',
    failed: 'ส่งไม่สำเร็จ', uncertain: 'ยืนยันการส่งไม่ได้',
  })[message.delivery_status] || ''
}

export function dayKey(value) {
  if (!value) return ''
  return new Date(value).toLocaleDateString('en-CA', { timeZone: BANGKOK })
}

export function dateSeparatorLabel(value, now = new Date()) {
  const key = dayKey(value)
  if (!key) return ''
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getTime() - 86400000))
  if (key === today) return 'วันนี้'
  if (key === yesterday) return 'เมื่อวาน'
  return new Date(value).toLocaleDateString('th-TH', {
    timeZone: BANGKOK, day: 'numeric', month: 'short', year: 'numeric',
  })
}
