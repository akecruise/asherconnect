# TESTING — Answer Knowledge Hub (โครง — checklist เต็มตาม Phase 22–23)

## หลักการยืมจาก docs/testing.md เดิม
1. inject เวลา (`p_now`) เสมอ ไม่ใช้ now() ใน logic
2. inject fetch ปลอม — ห้ามยิง Claude/ERP จริงใน unit test
3. ค่าที่คาดหวัง copy จาก spec ไม่ใช่จากผลรัน
4. ทดสอบว่า **สิ่งอันตรายไม่เกิด** (บอทใช้คำตอบ unapproved ไม่ได้ ฯลฯ)
5. test ที่แตะ DB ต้องล้างของเองพร้อมหลักฐาน
6. เลือกระดับจำลองถูก: A ล้วน → B fake fetch → C DB จริงนับสอบ → D ต่อ scenario → E HTTP เต็ม

## Manual checklist (Phase 23 — กรอกผลจริง)

- [ ] Admin Login เห็นเมนู คลังคำตอบ
- [ ] Create Category
- [ ] Create Intent
- [ ] Create Static Answer → Draft → Submit → Approve
- [ ] Create Dynamic Answer ({{starting_price}}) → Preview resolve จริง
- [ ] Quick Answer แสดงใน composer + search + หมวด
- [ ] Edit Before Send → ข้อความที่ส่งตรงที่แก้
- [ ] Send สำเร็จ → usage เพิ่ม
- [ ] Learning Candidate เกิดเมื่อคนตอบ (เห็นใน queue)
- [ ] Approve Candidate → answer เกิด bot_auto_answer=false
- [ ] Bot Test: approved+bot เปิด → บอทใช้ / ปิด → fallback Claude
- [ ] ERP Source Test: ราคาจาก inventory.unit ตรงจริง
- [ ] Import: valid / invalid / duplicate
- [ ] Version Test: แก้ของ approved → version +1
- [ ] Permission Test: sales กด approve → โดนปฏิเสธ
- [ ] Health Test: /admin/health โชว์ส่วน hub
- [ ] Rollback Test: ปิด flag → ระบบเดิมสมบูรณ์

## Test IDs T01–T30
รายการเต็มอยู่ใน `ROADMAP.md` Phase 22 — ไฟล์ที่จะเกิด:
`tests/answer-hub/*.test.mjs` + `sql/_selftest/ah_*.sql`

## Answer Service tests (Phase 6 — S01–S21) — ✅ ผ่านครบ 2026-09-18

| ID | เคส | อยู่ที่ | ผล |
|---|---|---|---|
| S01 | get approved human answer | `tests/answer-hub.service.test.mjs` (unit, fake rpc) | ✅ |
| S02 | sales cannot read draft | unit (mapping ANSWER_NOT_ALLOWED) + SQL selftest `ah_answer_item/binding` | ✅ |
| S03 | admin can read draft | unit (status draft ผ่านพร้อม not_approved log) | ✅ |
| S04 | bot cannot use human-only | unit (audience=human → ANSWER_NOT_ALLOWED) | ✅ |
| S05 | bot cannot use bot_auto_answer=false | unit | ✅ |
| S06 | expired answer blocked | unit (valid_to/valid_from → ANSWER_EXPIRED) | ✅ |
| S07 | list filter category | `sql/_selftest/ah_answer_service_selftest.sql` | ✅ |
| S08 | list filter project | selftest service | ✅ |
| S09 | search answer | selftest service (title+body) + unit (รูปทรง normalized) | ✅ |
| S10 | resolve static | unit (ไม่ยิง ah_resolve · ไม่โดน dynamic flag) | ✅ |
| S11 | resolve dynamic | unit (values → rendered + sources_used) | ✅ |
| S12 | resolve hybrid | unit (ok/fallback/missing ปน → review=true) | ✅ |
| S13 | required binding missing | unit + SQL selftest Phase 5 | ✅ |
| S14 | disabled source | unit (warning SOURCE_DISABLED) | ✅ |
| S15 | invalid answer id | unit (ไม่ยิง rpc) + selftest service (พฤติกรรม SQL) | ✅ |
| S16 | controlled error | unit (INTERNAL_ERROR mapping) | ✅ |
| S17 | no raw SQL error leak | unit (JSON ผลไม่มีข้อความดิบ) + safeCodes ปิดทาง HTTP | ✅ |
| S18 | pagination works | selftest service (page/total) + unit (clamp page_size) | ✅ |
| S19 | Quick Reply regression | npm test ชุดเดิมผ่านทั้งหมด | ✅ |
| S20 | messaging regression | integration 68/68 | ✅ |
| S21 | Phase 1–5 selftest PASS | รันซ้ำครบ 6 ไฟล์ผ่านหมด | ✅ |
