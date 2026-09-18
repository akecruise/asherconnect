# ADR-002 — บอทห้าม query database โดยตรง

Status: ACCEPTED (2026-09-17)

## บริบท
บอท (bots/reply.mjs + worker) สามารถถือ service_role ได้ — ถ้าปล่อยให้เขียน SQL
เอง ความผิดพลาดเล็ก ๆ กลายเป็นการแก้/ลบข้อมูลจริง หรือรั่วข้อมูลลูกค้าไปที่โมเดล

## การตัดสินใจ
- บอทเรียก hub ผ่าน RPC `ah_bot_recommend` เท่านั้น (grant execute ให้ service_role แบบเจาะจง)
- ฟังก์ชันนี้ read-only + คืนเฉพาะข้อความที่ผ่านตัวกรอง + missing list
- ห้ามบอทเขียนทุกตารางของ answer_hub (usage/learning เขียนโดย hook ฝั่ง server ที่เดียว)

## เหตุผล
- พื้นที่โจมตีเล็กสุด: บอทพัง/ถูก prompt injection ก็อ่านได้แค่คำตอบที่อนุมัติแล้ว
- ตัวกรองบอท (approved/audience/valid/binding/bot_allowed) บังคับที่ประตูเดียว ตรวจง่าย
- ลูกค้าถามอะไรไม่ต้องเป็น SQL — เป็น text ที่ส่งเข้า recommend เท่านั้น

## ผลที่ตามมา
- ห้ามใช้ LLM สร้าง SQL ใน bot path เด็ดขาด
- ข้อมูลที่ขาด (ราคาว่าง ฯลฯ) → คืน requires_human_review ไม่ใช่ให้โมเดลเดา
