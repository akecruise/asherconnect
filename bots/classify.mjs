/**
 * ถอดหมวดคำถามจากข้อความลูกค้า โดยไม่ตอบอะไรกลับไป — port จาก reference/bot-webhook.ts
 *
 * ใช้ตอนบอทเงียบ (นอกเวลา หรือคนรับช่วงไปแล้ว) เพราะคำถามของลูกค้ายังมีค่าเสมอ
 * ไม่ว่าใครจะเป็นคนตอบ — เอาไปดูว่าคนถามเรื่องอะไรมากที่สุด แล้วเอาไปทำโฆษณา
 *
 * ★ ล้มแล้วไม่โยน error ออกไป — คืนหมวดที่เดาจากคำสำคัญแทน
 *   งานนี้เป็นของแถม ไม่ควรทำให้คิวค้างหรือมีงานล้มค้างไว้ให้คนตาม
 */

import { TAXONOMY, parseIntent, detectTopicCode } from './reply.mjs'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

const keywordIntent = text => ({
  topics: [{ l1: detectTopicCode(text), l2: null }],
  stage: null, objection: null, budget_signal: null, urgency: null,
  confidence: 0.4, source: 'keyword',
})

export async function classifyOnly(text, adTitle = null, {
  model = 'claude-haiku-4-5-20251001', apiKey = process.env.ANTHROPIC_API_KEY,
  minConfidence = 0.6, fetcher = fetch, onError = () => {},
} = {}) {
  if (!apiKey) { onError(new Error('anthropic_key_missing')); return keywordIntent(text) }

  const system =
    'Classify a Thai condo-buyer chat message. Respond ONLY with JSON: ' +
    '{"topics":[{"l1":"","l2":""}],"stage":"","objection":null,"budget_signal":null,"urgency":"","confidence":0.0}\n' +
    'Rules: topics max 3 from TAXONOMY only; stage awareness|consideration|intent|ready; objection price_too_high|location_far|size_small|no_parking|loan_reject_risk|loan_rejected|pet_policy|wait_and_see|null.\n' +
    (adTitle ? 'The customer came from an ad titled: ' + adTitle + '. If the message is generic (สนใจ/ขอรายละเอียด), still tag general.info_request.\n' : '') +
    'TAXONOMY:\n' + TAXONOMY

  try {
    const response = await fetcher(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 250, temperature: 0, system, messages: [{ role: 'user', content: text }] }),
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) throw new Error(`anthropic_http_${response.status}`)
    const data = await response.json()
    const raw = data?.content?.[0]?.text ?? ''
    // โมเดลตอบมาแต่ก้อนหมวด ไม่มีช่อง reply — เติมหัวให้ parseIntent อ่านได้ด้วยตัวเดิม
    //
    // ★ ของเดิมเขียนหัวเป็น '{"reply":"","' ซึ่งมีอัญประกาศเกินมาหนึ่งตัว
    //   ต่อกับ raw แล้วได้ '{"reply":"",""topics":...' ซึ่ง JSON.parse ไม่ผ่านทุกครั้ง
    //   ผลคือ classifyOnly ตกลงตัวสำรอง (คำสำคัญ) เสมอ — การจัดหมวดด้วยโมเดล
    //   ไม่เคยทำงานเลยตั้งแต่วันแรก ทุกแถวใน message_intents จึงเป็น classifier='keyword'
    //   ไม่กระทบสิ่งที่ลูกค้าเห็น เพราะเส้นทางนี้ไม่ได้ตอบอะไรกลับไป
    return parseIntent('{"reply":"",' + raw.replace(/^\s*\{/, ''), text, minConfidence).intent
  } catch (e) {
    onError(e)
    return keywordIntent(text)
  }
}

/** แปลง intent เป็นของที่ worker('store_intent') รับได้ */
export function intentRow(intent, { conversation_id, message_id, external_id, project, ad_id, ad_title,
                                    is_new_chat, bot_replied, raw_question, salt } = {}) {
  const primary = intent.topics?.[0] ?? { l1: 'other', l2: null }
  return {
    conversation_id, message_id, external_id, project, salt,
    primary_topic: primary.l1, primary_l2: primary.l2,
    secondary_topics: (intent.topics ?? []).slice(1).map(t => t.l1 + (t.l2 ? '.' + t.l2 : '')),
    stage: intent.stage, objection: intent.objection, budget_signal: intent.budget_signal,
    urgency: intent.urgency, confidence: intent.confidence, classifier: intent.source,
    raw_question, ad_id, ad_title, is_new_chat, bot_replied,
  }
}
