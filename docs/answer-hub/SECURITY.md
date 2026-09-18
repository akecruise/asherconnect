# SECURITY — Answer Knowledge Hub

แนวป้องกันยึดของเดิมที่ตรวจแล้วใน AUDIT.md (ใช้ pattern ที่พิสูจน์แล้ว ไม่คิดใหม่)

## หลัก 6 ข้อ (บังคับทุก Phase)

1. **สิทธิ์ตรวจใน SQL เสมอ** — ทุก `inbox.ah_*` เช็ค role ข้างในฟังก์ชัน (`core.current_user_role()`);
   UI ซ่อนเมนู = cosmetic เท่านั้น (ปรัชญาเดิมของ stats/logs)
2. **ตารางปิดตาย** — RLS enabled + revoke จาก public/anon/authenticated + ไม่มี policy;
   เข้าผ่านฟังก์ชัน security definer `set search_path=''` เท่านั้น
3. **ไม่รั่ว secret** — ห้ามส่ง service_role/Meta token/LINE secret/OpenRouter key/DB conn ไป browser;
   ห้ามเพิ่มข้อมูลลง `GET /health` (public อยู่แล้ว) และ `/healthz`; ของ hub ใช้ `ah_health` หลัง gate
   `health_can_view` เท่านั้น
4. **บอทห้าม SQL ตรง** — บอทคุยกับ hub ผ่าน `ah_bot_recommend` (grant service_role) เท่านั้น;
   ห้ามบอทสร้างราคา/โปรโมชั่น/ตัวเลขห้องว่างเอง — resolve ได้เท่าที่ source ให้ ไม่งั้น requires_human_review
5. **Injection** — ไม่ interpolate string ลง SQL เด็ดขาด (ทุก query เป็น parameter ของฟังก์ชัน);
   template `{{var}}` render แบบ replace ค่าที่ผ่าน escape แล้ว — ห้าม HTML/JS ในค่า; import ตรวจ
   type/length/enum ทุกแถวก่อนเขียน; ชื่อไฟล์/path ของ attachment ผ่าน safeMediaPath pattern เดิม
6. **XSS/CSRF** — DOM API only (ไม่ innerHTML กับข้อความ user), CSP 'self' ไม่มี inline,
   /api/command มี checkOrigin อยู่แล้ว — ใช้ประตูเดิม ไม่เปิด endpoint ใหม่

## Source Registry permission model (Phase 4 — บังคับแล้ว)

- ตาราง `answer_hub.source_registry` ปิดตายเหมือนทุกตาราง (RLS ไม่มี policy + revoke ครบ —
  ตรวจ catalog แล้ว: authenticated select = false)
- `ah_source_list` = manager/admin (ตรวจ role ในฟังก์ชัน) · `ah_source_save` = admin เท่านั้น;
  sales โดนที่ role gate, service_role (บอท) โดนตั้งแต่ grant layer (has_function_privilege = false)
- เพิ่ม/ลดแหล่งทำผ่าน migration เท่านั้น — หน้าเว็บพลิกได้แค่ bot_allowed / human_allowed /
  freshness_seconds / active / description (ห้ามแก้ object_name จากหน้าจอ)
- resolver เรียกได้เฉพาะฟังก์ชันตามทะเบียน: object_name ต้องตรง `answer_hub.src_[a-z_]+` และมี
  ฟังก์ชันอยู่จริง (selftest ตรวจทุกแถว) — ไม่มีเส้นทาง arbitrary SQL ให้บอทหรือหน้าเว็บ
- `src_available_units(…, p_status)` validate กับ enum `unit_status` จริงใน pg_catalog —
  ไม่รับ free-form string แม้แต่ตัวเดียว
- ข้อมูล fact ออกเฉพาะ `is_public ≠ 0` — ของภายในไม่มีทางหลุดออกทางคำตอบ
- ทุก src_* คืน ok/missing/invalid เท่านั้น — error ดิบของฐานไม่มีทางโผล่ปลายทาง

## Answer Service (Phase 6 — ชั้นกลางที่ควบคุมทุกทางเข้า)

- ทุก action `ah_*` เดินผ่าน `services/answer-hub/service.mjs` เท่านั้น — consumer ใหม่
  (UI/Bot/Learning) ห้ามยิงตารางตรงผ่าน PostgREST table API
- service ไม่เชื่อ role/project ที่ client ส่งมา — สิทธิ์จริงตรวจใน SQL ตลอด; service ทำได้แค่
  ตรวจซ้ำ (uuid format, validity วันหมดอายุ, bot policy) ก่อนเสียเวลายิง RPC
- error model กลาง `ANSWER_*`: code ดิบของฐานถูก map ที่เดียว — raw SQL error/stack ไม่มี
  ทางออก client (unit test S16/S17 พิสูจน์) · รายละเอียดจริงลง structured log ฝั่ง server
  (answer_service_* / answer_permission_denied / answer_source_missing — ไม่ใส่ PII/เนื้อความแชท)
- flags 5 ตัว default ปิด — ระบบเปิดใช้ทีละส่วนได้โดยไม่ deploy (env + hook override
  inbox.settings เมื่อตารางพร้อม); flag ปิด = controlled `HUB_DISABLED`/`FEATURE_DISABLED`
- ฟังก์ชันที่ Phase ยังไม่ถึง (recommend/usage/feedback) คืน NOT_AVAILABLE_YET — ไม่มี fake result
- Dockerfile ต้อง COPY services/ (test ใน bots.test.mjs จับได้ — กันลืมเหมือน bots//reports/ รอบก่อน)

## เช็คลิสต์ก่อนปิด Phase 19
- [ ] ลองเรียกทุกตารางตรง ๆ ด้วย anon/authenticated → ต้อง denied
- [ ] ลองเรียก ah_* ด้วย token sales → ต้อง not_allowed ใน action ระดับ manager/admin
- [ ] grep ใน response ทั้งหมด → ไม่มี service_role/token/secret
- [ ] bot พยายามเรียก action user → ต้องถูกปฏิเสธ (grant แยกฝั่ง)
- [ ] import ไฟล์แปลก ๆ (xlsx มี formula, csv injection `=cmd`) → ต้องถูก sanitize/ปฏิเสธ
- [ ] template ที่มี `{{วงเล็บ/quote แปลก}}` → ต้อง render ปลอดภัย

## เหตุการณ์เดิมที่ต้องไม่ทำซ้ำ
- incident 032: rerun ไฟล์ SQL เก่าทับ function 15 ตัว → ส่งข้อความตาย 37 นาที
  → กฎ: ไฟล์ใหม่เท่านั้น + plan ก่อน apply + ledger sha ตรวจทุกครั้ง
