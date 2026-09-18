# ADR-004 — ใช้ ERP Live Data ไม่สำเนาข้อความนิ่ง

Status: ACCEPTED (2026-09-17)

## บริบท
ราคาอยู่ที่ `inventory.unit.price`, โปรโมชั่นอยู่ที่ `public.promotions`,
ข้อมูลโครงการอยู่ที่ `core.project` + `public.project_facts` — ของจริงตรวจแล้ว (AUDIT §4.3)
คำตอบแบบพิมพ์ราคานิ่งไว้ใน template จะค้างเก่าทันทีที่ ERP แก้

## การตัดสินใจ
- คำตอบที่มีตัวเลข/ข้อเท็จจริงจาก ERP ใช้ `{{variable}}` + binding ไป source_registry
- ลำดับความจริง: ERP Live > Admin Approved Manual > Approved Learned > Imported > AI Draft
- AI draft (Claude fallback) ห้าม override ข้อมูล ERP — fallback ใช้เฉพาะเมื่อ hub ไม่มีคำตอบ
- source ขาด/ข้อมูลว่าง → fallback_text หรือ missing list — **ห้ามเดา** (ปรัชญาเดียวกับ
  `projectDataFor` เดิม: ไม่มีข้อมูล = บอกว่าจะไปเช็คให้ ไม่ยืมของโครงการอื่น)

## เหตุผล
- ราคา/ห้องว่าง/โปรโมชั่นเปลี่ยนบ่อย — จุดจริงคือ ERP จุดเดียว
- cache TTL ต่อ source ทำให้ตอบเร็วแต่ของสด

## ผลที่ตามมา
- ทุก dynamic answer ต้องมี binding + fallback ก่อน approve ได้ (RPC บังคับตรวจ)
