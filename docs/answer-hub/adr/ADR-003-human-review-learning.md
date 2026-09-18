# ADR-003 — Learning ต้องผ่านคนก่อนเสมอ

Status: ACCEPTED (2026-09-17)

## บริบท
Master Command ห้าม "auto-learn แล้ว auto-send โดยไม่ผ่าน review"
คำตอบของคนขายอาจผิด อาจมีข้อมูลส่วนตัว อาจเป็นมุกเฉพาะบทสนทนา

## การตัดสินใจ
- ทุก candidate เข้า `status='pending'` — ไม่มีทางอัตโนมัติพาไป approved ได้เลย
- Approve/Edit+Approve/Merge/Reject ทำได้เฉพาะ manager+ ใน Learning Queue
- คำตอบที่เกิดจาก learning → `bot_auto_answer=false` **ตอนเกิดเสมอ** — บอทใช้ไม่ได้
  จนกว่า admin จะเปิดเองภายหลัง (double gate: approve + เปิดบอทแยกกัน)
- hook สร้าง candidate เป็น fire-and-forget + flag — พังเงียบ ๆ ไม่พัง inbound

## เหตุผล
- คุณภาพคลัง > ความเร็วการสะสม; ผิดพลาดจาก auto-approve ไปถึงลูกค้าทันที
- PII: candidate อาจมีเบอร์/ชื่อ — มีเฉพาะในฐาน แสดงเฉพาะหลัง login + gate role

## ผลที่ตามมา
- Learning Queue จะมี backlog ได้ — ออกแบบ dedupe (occurrence_count) ให้ของซ้ำไม่กอง
