// Answer Service Layer (Answer Knowledge Hub — Phase 6)
// จุดกลางเดียวของทุก consumer (Admin / Quick Answer / Bot / Learning / Recommend /
// Analytics) — ห้าม consumer query ตารางตรง ทุกอย่างเดินผ่าน RPC inbox.ah_* เท่านั้น
// (ARCHITECTURE.md "Components และความรับผิดชอบ")
//
// หลักการ:
//   * สิทธิ์จริงอยู่ใน SQL เสมอ (core.current_user_role) — service ไม่เชื่อ role ที่
//     client ส่งมา และไม่มีสิทธิ์ตัดสินแทนฐาน ทำได้แค่ตรวจซ้ำก่อนเสียเวลายิง RPC
//   * feature flags 5 ตัว default ปิด — flag ปิด = คืน controlled disabled ไม่ใช่ error ตูม
//   * error model กลาง ANSWER_* — client เห็นแค่ code; รายละเอียดจริงลง log ฝั่งนี้
//   * ห้าม fake result: ฟังก์ชันที่ Phase ยังไม่ถึง (recommend/usage/feedback) คืน
//     NOT_AVAILABLE_YET พร้อม phase ที่จะมา ไม่แต่งข้อมูล
//   * resolve ต่อยอด Phase 5 เท่านั้น (ah_resolve + render.mjs) — ไม่ duplicate renderer
//
// flags (default ปิดหมด — ROADMAP Phase 6):
//   ANSWER_HUB_ENABLED               ประตูหลักทุก action
//   ANSWER_HUB_DYNAMIC_DATA_ENABLED  ah_resolve (ข้อมูล dynamic จาก ERP)
//   ANSWER_HUB_BOT_ENABLED           ทางบอท (botResolve — ทางเดินจริง Phase 15)
//   ANSWER_HUB_LEARNING_ENABLED      ฟังก์ชัน learning (Phase 11+ — ยัง NOT_AVAILABLE_YET)
//   ANSWER_HUB_IMPORT_ENABLED        import (Phase 10+ — ยัง NOT_AVAILABLE_YET)

import { renderFromResolve } from './render.mjs'

// ── error model กลาง (client เห็นแค่ code พวกนี้ — ห้าม raw SQL/stack/secret) ──
export const CODES = {
  HUB_DISABLED: 'HUB_DISABLED',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  NOT_AVAILABLE_YET: 'NOT_AVAILABLE_YET',
  ANSWER_INVALID: 'ANSWER_INVALID',
  ANSWER_NOT_FOUND: 'ANSWER_NOT_FOUND',
  ANSWER_NOT_ALLOWED: 'ANSWER_NOT_ALLOWED',
  ANSWER_NOT_APPROVED: 'ANSWER_NOT_APPROVED',
  ANSWER_EXPIRED: 'ANSWER_EXPIRED',
  SOURCE_DISABLED: 'SOURCE_DISABLED',
  SOURCE_NOT_ALLOWED: 'SOURCE_NOT_ALLOWED',
  DATA_NOT_FOUND: 'DATA_NOT_FOUND',
  REQUIRED_DATA_MISSING: 'REQUIRED_DATA_MISSING',
  RENDER_FAILED: 'RENDER_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
}

// code ของฐาน (ah_*) → error model ของ service
const RPC_CODE_MAP = {
  ah_not_found: CODES.ANSWER_NOT_FOUND,
  ah_not_allowed: CODES.ANSWER_NOT_ALLOWED,
  ah_state_not_allowed: CODES.ANSWER_NOT_ALLOWED,
  ah_invalid: CODES.ANSWER_INVALID,
  ah_missing_required_data: CODES.ANSWER_INVALID,
  ah_duplicate: 'ANSWER_DUPLICATE',
  not_allowed: CODES.ANSWER_NOT_ALLOWED,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const asUuid = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim() : null)

const truthy = (v) => v === '1' || v === 'true' || v === true

// ── flags: env ตอน boot + hook override จาก inbox.settings (answer_hub.*) ──
// loadOverrides ยังไม่มีตัวจริง (local dev DB ยังไม่มี inbox.settings — ดู HANDOFF
// Blockers) — ต่อเมื่อถึง Phase ที่ settings พร้อม โดยไม่ต้องแก้ service
export function buildFlags({ env = {}, loadOverrides = null, overrideTtlMs = 60000 } = {}) {
  const NAMES = {
    master: 'ANSWER_HUB_ENABLED',
    dynamic: 'ANSWER_HUB_DYNAMIC_DATA_ENABLED',
    bot: 'ANSWER_HUB_BOT_ENABLED',
    learning: 'ANSWER_HUB_LEARNING_ENABLED',
    import: 'ANSWER_HUB_IMPORT_ENABLED',
  }
  let cache = { at: 0, overrides: {}, failed: false }
  return {
    NAMES,
    async isEnabled(name) {
      let overrides = cache.overrides
      if (loadOverrides) {
        try {
          if (Date.now() - cache.at > overrideTtlMs) {
            overrides = (await loadOverrides()) ?? {}
            cache = { at: Date.now(), overrides, failed: false }
          }
        } catch {
          // อ่าน override ไม่ได้ = ใช้ env ต่อ — ไม่ block (log ครั้งเดียวพอ)
          if (!cache.failed) cache = { ...cache, failed: true, at: Date.now() }
        }
      }
      const o = overrides[name]
      if (o === true || o === 'true' || o === '1') return true
      if (o === false || o === 'false' || o === '0') return false
      return truthy(env[NAMES[name]])
    },
  }
}

const disabled = (code) => ({ ok: false, code })

/**
 * @param {object} deps
 * @param {(token: string, fn: string, body?: object) => Promise<any>} deps.callRpc  เรียก RPC inbox.ah_* ด้วย token ของผู้ใช้จริง
 * @param {{isEnabled: (name: string) => Promise<boolean>}} deps.flags  จาก buildFlags()
 * @param {(event: string, fields?: object) => void} [deps.log]  structured log (ไม่ใส่ PII)
 */
export function createAnswerHubService({ callRpc, flags, log = () => {} }) {
  // เรียก RPC โดย map error เป็น error model กลาง — ไม่มีทาง raw error หลุดออกไป
  async function rpc(token, fn, body) {
    try {
      return { ok: true, data: await callRpc(token, fn, body ?? {}) }
    } catch (err) {
      const raw = err?.message || String(err?.code || 'unknown')
      const code = RPC_CODE_MAP[raw] ?? CODES.INTERNAL_ERROR
      // รายละเอียดจริง (รวม code ดิบ) ลง log เท่านั้น — ค่าที่คืนมีแต่ code ที่ map แล้ว
      log('answer_service_rpc_failed', { fn, raw_code: raw, mapped: code })
      return { ok: false, code, status: err?.status }
    }
  }

  // ประตู resolve ฝั่ง service — ต่อยอด ah_resolve (Phase 5) + render.mjs เท่านั้น
  async function resolveCore(token, { answer_id, context }, { requireDynamicFlag = true } = {}) {
    const got = await getAnswer(token, answer_id)
    if (!got.ok) return got

    const item = got.answer
    // static = ไม่มี dynamic data — template ล้วน render ได้เลย (ยังต้องผ่านสิทธิ์/validity ข้างบน)
    // จึงไม่โดน dynamic flag กั้น — ทำงานได้แม้ ANSWER_HUB_DYNAMIC_DATA_ENABLED ปิด
    if (item.answer_type === 'static') {
      const r = renderFromResolve(item.body_template, { values: {}, missing: [] })
      log('answer_service_resolve', { answer_id, kind: 'static', review: false })
      return {
        ok: true,
        answer_id,
        rendered_text: r.text,
        attachments: [],
        sources_used: [],
        warnings: [],
        requires_human_review: false,
      }
    }

    if (requireDynamicFlag && !(await flags.isEnabled('dynamic'))) {
      return disabled(CODES.FEATURE_DISABLED)
    }

    const res = await rpc(token, 'ah_resolve', {
      answer_id,
      context: context ?? {},
    })
    if (!res.ok) return res

    const resolve = res.data
    let rendered
    try {
      rendered = renderFromResolve(item.body_template, resolve)
    } catch {
      log('answer_service_resolve_failed', { answer_id, stage: 'render' })
      return { ok: false, code: CODES.RENDER_FAILED }
    }

    // เตือนทุกตัวแปรที่ไม่ได้ค่าจริงจากฐาน — จำแนกจาก reason ที่ src_resolve รายงาน
    const warnings = (resolve.detail ?? [])
      .filter((d) => d.status !== 'ok')
      .map((d) => ({
        variable: d.variable,
        source_code: d.source_code ?? null,
        kind:
          d.reason === 'source_inactive' ? CODES.SOURCE_DISABLED
          : d.reason === 'bot_not_allowed' || d.reason === 'human_not_allowed' ? CODES.SOURCE_NOT_ALLOWED
          : d.reason === 'source_unavailable' ? CODES.SOURCE_DISABLED
          : CODES.DATA_NOT_FOUND,
        reason: d.reason ?? null,
      }))
    for (const w of warnings) {
      log('answer_source_missing', { answer_id, variable: w.variable, source_code: w.source_code, reason: w.reason })
    }

    const review = !rendered.ok
    if (review) log('answer_service_resolve_failed', { answer_id, stage: 'required_missing', missing: rendered.missing })

    return {
      ok: true,
      answer_id,
      rendered_text: rendered.text,
      attachments: [],
      sources_used: resolve.sources ?? [],
      warnings,
      requires_human_review: review,
      values: resolve.values ?? {},
      missing: resolve.missing ?? [],
    }
  }

  // ── getAnswer — validate id → สิทธิ์ (SQL) → สถานะ → วันหมดอายุ ──
  async function getAnswer(token, answerId) {
    const id = asUuid(answerId)
    if (!id) {
      return { ok: false, code: CODES.ANSWER_NOT_FOUND }
    }
    const res = await rpc(token, 'ah_get', { id })
    if (!res.ok) return res

    const item = res.data?.item
    if (!item) return { ok: false, code: CODES.ANSWER_NOT_FOUND }
    if (item.status !== 'approved') {
      // SQL กันสิทธิ์ไปแล้ว — ที่นี่แจ้งสถานะให้ชัดสำหรับ manager+ ที่ดูของร่างได้
      log('answer_service_get', { answer_id: id, status: item.status, not_approved: true })
    }
    const now = Date.now()
    if (item.valid_from && Date.parse(item.valid_from) > now) {
      return { ok: false, code: CODES.ANSWER_EXPIRED, answer: item, versions: res.data.versions, bindings: res.data.bindings }
    }
    if (item.valid_to && Date.parse(item.valid_to) < now) {
      return { ok: false, code: CODES.ANSWER_EXPIRED, answer: item, versions: res.data.versions, bindings: res.data.bindings }
    }
    log('answer_service_get', { answer_id: id, status: item.status })
    return { ok: true, answer: item, versions: res.data.versions ?? [], bindings: res.data.bindings ?? [] }
  }

  // ── listAnswers — filter uuid ทั้งชุดตรวจก่อนยิง (แปลว่าไม่มี cast error ถึงฐาน) ──
  const FILTER_UUIDS = ['category_id', 'intent_id', 'project_id']
  async function listAnswers(token, filters = {}) {
    const body = { ...filters }
    for (const key of FILTER_UUIDS) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== '') {
        const v = asUuid(body[key])
        if (!v) return { ok: false, code: CODES.ANSWER_INVALID }
        body[key] = v
      }
    }
    const page = Number.parseInt(body.page, 10)
    const size = Number.parseInt(body.page_size, 10)
    if (Number.isFinite(page)) body.page = Math.max(page, 1)
    if (Number.isFinite(size)) body.page_size = Math.min(Math.max(size, 1), 200)
    return rpc(token, 'ah_list', body)
  }

  // ── searchAnswers — รุ่นแรก = ah_list query (title/body ilike) เสถียร ไม่มี LLM ──
  async function searchAnswers(token, { query, ...filters } = {}) {
    if (!query || !String(query).trim()) {
      return { ok: false, code: CODES.ANSWER_INVALID }
    }
    const res = await listAnswers(token, { ...filters, query: String(query).trim() })
    if (!res.ok) return res
    log('answer_service_search', { query_length: String(query).length, total: res.data?.total ?? 0 })
    return {
      ok: true,
      total: res.data.total,
      rows: (res.data.rows ?? []).map((a) => ({
        answer_id: a.id,
        title: a.title,
        category: a.category_id,
        intent: a.intent_id,
        score: null, // คะแนนจัดอันดับเป็นของ Phase 14 (SQL-first) — ไม่แต่งตัวเลข
        answer_type: a.answer_type,
        source_type: a.source_type,
        project: a.project_id,
        audience: a.audience,
      })),
    }
  }

  // ── ทางบอท — policy engine ตาม STEP 11 (ทางเดินจริงผ่าน ah_bot_recommend Phase 15) ──
  async function botResolve(token, { answer_id, context } = {}) {
    if (!(await flags.isEnabled('master'))) return disabled(CODES.HUB_DISABLED)
    if (!(await flags.isEnabled('bot'))) return disabled(CODES.FEATURE_DISABLED)

    const got = await getAnswer(token, answer_id)
    if (!got.ok) return got
    const item = got.answer

    if (item.status !== 'approved') return { ok: false, code: CODES.ANSWER_NOT_APPROVED }
    if (item.audience !== 'bot' && item.audience !== 'both') {
      log('answer_permission_denied', { answer_id, who: 'bot', why: 'audience' })
      return { ok: false, code: CODES.ANSWER_NOT_ALLOWED }
    }
    if (!item.bot_auto_answer) {
      log('answer_permission_denied', { answer_id, who: 'bot', why: 'bot_auto_answer' })
      return { ok: false, code: CODES.ANSWER_NOT_ALLOWED }
    }

    const res = await resolveCore(token, { answer_id, context }, { requireDynamicFlag: false })
    if (!res.ok) return res
    if (res.requires_human_review || res.missing?.length) {
      // required ขาด = บอทห้ามเอาไปตอบเอง — คืน controlled state ให้ flow ส่งมนุษย์
      return { ok: true, candidate: { ...res, requires_human_review: true }, requires_human_review: true }
    }
    return { ok: true, candidate: res, requires_human_review: false }
  }

  const passthrough = (fn) => async (token, data) => rpc(token, fn, data)

  const handlers = {
    ah_list: (t, d) => listAnswers(t, d),
    ah_get: (t, d) => getAnswer(t, d?.id),
    ah_save: (t, d) => rpc(t, 'ah_save', d),
    ah_approve: (t, d) => rpc(t, 'ah_approve', d),
    ah_retire: (t, d) => rpc(t, 'ah_retire', d),
    ah_versions: passthrough('ah_versions'),
    ah_source_list: passthrough('ah_source_list'),
    ah_source_save: passthrough('ah_source_save'),
    ah_binding_list: passthrough('ah_binding_list'),
    ah_binding_save: passthrough('ah_binding_save'),
    ah_binding_delete: passthrough('ah_binding_delete'),
    ah_resolve: (t, d) => resolveAnswer(t, d),
  }

  return {
    CODES,
    flags,

    /** จุดรับของ server.mjs — action จาก AH_ACTIONS ทั้งหมด */
    async handle(action, token, data = {}) {
      try {
        if (!(await flags.isEnabled('master'))) return disabled(CODES.HUB_DISABLED)
        const fn = handlers[action]
        if (!fn) return disabled(CODES.FEATURE_DISABLED)
        return await fn(token, data)
      } catch (err) {
        log('answer_service_internal', { action, error: String(err?.message ?? err) })
        return { ok: false, code: CODES.INTERNAL_ERROR }
      }
    },

    async getAnswer(token, answerId) {
      if (!(await flags.isEnabled('master'))) return disabled(CODES.HUB_DISABLED)
      try {
        return await getAnswer(token, answerId)
      } catch (err) {
        log('answer_service_internal', { fn: 'getAnswer', error: String(err?.message ?? err) })
        return { ok: false, code: CODES.INTERNAL_ERROR }
      }
    },

    listAnswers,
    searchAnswers,

    async resolveAnswer(token, { answer_id, context } = {}) {
      if (!(await flags.isEnabled('master'))) return disabled(CODES.HUB_DISABLED)
      try {
        return await resolveCore(token, { answer_id, context })
      } catch (err) {
        log('answer_service_internal', { fn: 'resolveAnswer', error: String(err?.message ?? err) })
        return { ok: false, code: CODES.INTERNAL_ERROR }
      }
    },

    botResolve,

    // ── boundary ของ Phase ที่ยังไม่ถึง — คืน controlled state ห้ามแต่งผล ──
    async recommendAnswers() {
      return { ok: false, code: CODES.NOT_AVAILABLE_YET, phase: 14 }
    },
    async recordUsage() {
      return { ok: false, code: CODES.NOT_AVAILABLE_YET, phase: 16 }
    },
    async submitFeedback() {
      return { ok: false, code: CODES.NOT_AVAILABLE_YET, phase: 17 }
    },
    async learningReview() {
      return { ok: false, code: CODES.NOT_AVAILABLE_YET, phase: 11 }
    },
  }
}
