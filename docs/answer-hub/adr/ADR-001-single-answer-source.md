# ADR-001 — Human และ Bot ใช้คลังคำตอบเดียวกัน

Status: ACCEPTED (2026-09-17)

## บริบท
ปัจจุบันคนขายใช้ Quick Reply (inbox.quick_reply) แต่บอทใช้ไฟล์ markdown
(bots/project-data/*.md) คนละชุด — ความรู้แตกเป็นสองที่ แก้ที่หนึ่งอีกที่ค้างเก่า

## การตัดสินใจ
ทั้งคนและบอทดึงคำตอบจาก `answer_hub.answer_item` เดียวกัน ต่างกันที่ **ตัวกรอง**:
- คน: status approved (หรือ draft ของทีมจัดการ) + audience human|both
- บอท: approved + audience bot|both + bot_auto_answer + อยู่ใน valid + resolve สำเร็จ + source bot_allowed

## เหตุผล
- ความรู้ชุดเดียว = คำตอบไม่ขัดกันเอง; การอนุมัติเป็นด่านเดียวชัดเจน
- ตัวอย่างของ spec: Human เห็น Answer A ได้ทันที แต่บอทยังใช้ไม่ได้จน admin อนุมัติ + เปิด bot_auto_answer

## ผลที่ตามมา
- Quick Reply เดิมยังใช้ได้ (legacy) แต่คำตอบใหม่ทั้งหมดเข้า hub — ดู ADR-005
- ตัวกรองบอทต้อง implement ที่เดียว (`ah_bot_recommend`) ห้ามกระจายหลายจุด
