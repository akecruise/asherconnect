# ASHER Connect ↔ ASHER CRM — แบ่งหน้าที่ (BOUNDARIES)

อัปเดต 2026-10-02 · ใช้คู่กับ `CUSTOMER-DATA-OWNERSHIP.md` และ `CONNECT-CRM-INTEGRATION.md`
สำเนาเดียวกันอยู่ที่ `asher-connect/docs/BOUNDARIES.md` — แก้ที่ไหนต้องแก้ทั้งคู่

## กฎข้อเดียวที่ใช้ตัดสิน

- **ต้องใช้ token ของช่องทาง หรือแตะตัวแชท/ข้อความ → asher-connect**
- **เป็นเรื่องของ "คน" ต่อเนื่องตามเวลา หรือเรื่องยูนิต/เงิน → asher-crm**
- ไม่แน่ใจ → ถามว่า "ถ้าวันหนึ่งเพิ่มช่องทาง WhatsApp ข้อมูลนี้ต้องเปลี่ยนไหม" ถ้าต้องเปลี่ยน = Connect, ถ้าไม่ = CRM

## asher-connect (ชั้นช่องทาง) เป็นเจ้าของ

- webhook LINE / Messenger / IG, ตรวจ signature, token ใน `channels.json` (ห้ามเข้า DB/backup)
- conversation, message, ไฟล์สื่อ, สถานะ bot/human, การตอบของ sales และบอท
- ตัวตนในช่องทาง `(platform, channel_key, external_user_id)` + สถานะ follow / unfollow / block
- Inbox UI, SLA, สถิติการตอบ, คะแนนผู้ตอบ, รายงาน Telegram, Quick reply / Answer Hub
- **ตัวส่งออกทุกแบบ**: ตอบทีละคน และส่งหลายคน (LINE multicast) + quota + retry + ผลการส่งรายคน

## asher-crm (ชั้นลูกค้าและการขาย) เป็นเจ้าของ

- `contact_id` ระดับคน (รวมหลายช่องทางเป็นคนเดียว), ชื่อ/เบอร์/อีเมลที่ยืนยันแล้ว
- lead / opportunity, โครงการและห้องที่สนใจ, qualification, pipeline stage, เจ้าของลูกค้า
- follow-up, นัดชม, activity timeline, ยูนิต/ราคา/สต็อก, hold/จอง/สัญญา
- **segment / กลุ่มเป้าหมาย** สำหรับยิง campaign
- **หน้าจอ campaign ส่งข้อความหลายคน** (เลือกกลุ่ม, เขียนข้อความ, อนุมัติ, ตั้งเวลา, ดูผล)
- Customer 360 — หน้าดูลูกค้าหลักของทั้งระบบ

### ★ ข้อยกเว้นที่เป็นของจริงแล้ว: tag และดาว อยู่ที่ Connect

ฉบับแรกของเอกสารนี้ (2026-10-02 เช้า) เขียนว่า tag/ดาวเป็นของ CRM (`crm_tags`) — **ไม่ตรงกับของที่ขึ้น production ไปแล้ว**
ตั้งแต่ `202610011000_contact_star_tags.sql` + `202610021000_contacts_page.sql` (deploy แล้วทั้งคู่) ของจริงคือ:

| ของ | อยู่ที่ |
|---|---|
| ดาว + โน้ตติดตาม | `connect_private.contact_flag` |
| นิยาม tag + ความผูก | `connect_private.tag` · `connect_private.contact_tag` |
| ทางเรียก | `inbox.case_star` / `case_follow` / `case_tags_set` / `tags_list` / `tag_upsert` / `tag_archive` / `case_flags` / `flag_list` ผ่าน `lib/case-flags.mjs` |
| หน้ารายชื่อติดต่อ | `inbox.contacts_list` · `inbox.contact_detail` · `/contacts` |

เหตุผลที่ยังอยู่ที่ Connect: ผูกกับ `core.contact` ซึ่งเป็น unified identity ของ Connect อยู่แล้ว · LINE/Meta ไม่มี API ของ chat tag จึงไม่ต้อง sync ออก · และมีข้อมูลที่ทีมใช้งานจริงอยู่ในนั้นแล้ว
**ถ้าจะย้ายไป CRM ต้องเป็นงานย้ายข้อมูลที่ตั้งใจทำ ไม่ใช่เขียนของชุดที่สองขึ้นมาขนานกัน** — ตัดสินใจเมื่อ 2026-10-02 โดยเจ้าของระบบ

## Report — ใครออกอะไร

| Report | ออกที่ | เหตุผล |
|---|---|---|
| ติดตามลูกค้า: follow-up ค้าง/เลยกำหนด, ลูกค้าไม่ได้ติดต่อเกิน N วัน, นัดชม, funnel ตาม stage, ผลงานปิดการขายรายคน, ผล campaign | **asher-crm** (โมดูล `reports`) | ข้อมูลเป็นของ CRM ทั้งหมด |
| การตอบแชท: first-reply, SLA (09–19 / 19–09), คะแนนผู้ตอบ, บอท vs คน, แชทค้างตอบ | **asher-connect** (หน้า stats เดิม) | วัดจากข้อความ ซึ่งเป็นของ Connect |
| ส่งเข้า Telegram | CRM สร้างเนื้อหา → ส่งผ่าน bot Telegram เดิมของ Connect (`bots/notify.mjs`) ด้วย service endpoint | ใช้ bot/กลุ่มเดียว ไม่ต้องมี token Telegram สองที่ |

report ที่ต้องใช้ข้อมูลทั้งสองฝั่ง (เช่น "ลูกค้า Hot ที่ทักมาแต่ยังไม่มี follow-up") → ออกที่ CRM โดยใช้ข้อมูลที่ Connect ส่งมาเป็น event แล้ว ไม่ query DB ข้ามระบบ

## ใช้ร่วมกัน

- login และ role จาก `core.profile` (sales, senior_sales, marketing, manager, admin)
- ผูกกันด้วย `contact_id` (CRM) ↔ Connect contact reference / conversation id

## วิธีคุยกัน

| ทิศ | รูปแบบ | ตัวอย่าง |
|---|---|---|
| Connect → CRM | **event** ผ่าน outbox → `POST /internal/events` (มีอยู่แล้ว) | conversation.created, message.received, follow/unfollow, broadcast.delivered |
| CRM → Connect | **command** ผ่าน service endpoint ที่ยืนยันตัวด้วย token | ส่ง broadcast, ขอข้อความล่าสุดของลูกค้า (อ่านอย่างเดียว) |
| CRM → Connect UI | **deep link** `https://inbox.apluscondo.com/conversations/<id>` | ปุ่ม "เปิดแชท" |
| Connect UI → CRM | อ่าน/เขียนผ่าน API ของ CRM | ยูนิตว่าง (มีแล้ว), ติด tag/ดาวจากหน้าแชท |

## ห้าม

- CRM ห้ามเก็บ/อ่าน token ของช่องทาง และห้ามคัดลอกเนื้อหาข้อความเก็บถาวร (อ่านสดจาก Connect เท่านั้น)
- Connect ห้ามมี logic pipeline/qualification
- **ห้ามสร้างระบบ tag/ดาว ชุดที่สองใน CRM** ขนานกับของที่ Connect มีอยู่ (ดูข้อยกเว้นข้างบน) — CRM อ่าน/เขียนผ่าน Connect
- ห้ามสร้างตาราง "ลูกค้า" ชุดที่สองในระบบใด

## การเปลี่ยนแปลงจาก spec เดิม

- `asher-connect/docs/handoff/2026-10-01-star-follow-tags.md`: ทำตาม spec เดิมทั้งหมด **ดาว + tag อยู่ที่ Connect** (เอกสารฉบับแรกของ BOUNDARIES เขียนว่าย้ายไป CRM — ยกเลิกแล้ว ดูหัวข้อ "ข้อยกเว้น" ข้างบน)
- `asher-connect/docs/handoff/2026-10-02-line-broadcast-sender.md` ข้อ 5 (เรียก CRM `/flags` แทนของเดิม): **ยกเลิก** — ของเดิมขึ้น production แล้วและมีข้อมูลใช้งานจริงอยู่
