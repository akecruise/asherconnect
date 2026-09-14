# สลับจาก edge function บน cloud มาที่ asher-connect

อัปเดต 2026-09-14 · Phase 5

เอกสารนี้ตอบสามคำถาม: **เทียบยังไง · ผ่านเกณฑ์เมื่อไหร่ · ถอยยังไง**

---

## 0. ก่อนเริ่มนับสามวัน — ต้องครบทุกข้อนี้ก่อน

ถ้าข้อไหนยังไม่ครบ ตัวเลขที่ได้จะไม่มีความหมาย และจะเสียเวลาสามวันฟรี

| ต้องมี | ตรวจยังไง | ยังขาดอยู่ไหม |
|---|---|---|
| `ANTHROPIC_API_KEY` ใน `.env` | `docker exec asher-connect node -e "console.log(!!process.env.ANTHROPIC_API_KEY)"` | ☐ |
| สวิตช์บอทเปิด (ปุ่มบนหน้าเว็บ) | `curl -s localhost:3200/health` ดู `bot.switches` | ☐ |
| `CONNECT_SHADOW_MODE=true` | `curl -s localhost:3200/health` ดู `shadow: true` | ☐ |
| webhook ของ LINE/Meta ยิงเข้า **ทั้งสองที่** | ดูของดิบเข้ามาจริงไหม (คิวรีข้อ 1) | ☐ |
| ตัวตั้งเวลาเรียก `inbox.watchdog(now())` ทุกนาที | ยังไม่ได้ตั้ง — pg_cron ยังไม่ติดตั้ง | ☐ |

**เรื่องที่ต้องตัดสินก่อน:** ตอนนี้ cloud ยังเป็นตัวที่ตอบลูกค้าจริงอยู่
เครื่องนี้อยู่ในโหมดเงา — รับของเข้ามาคิดและบันทึก แต่ไม่ส่งอะไรออกไป
ผู้ให้บริการจึงต้องยิง webhook เข้าสองที่พร้อมกันตลอดสามวัน ไม่ใช่ย้ายมาที่นี่ก่อน

---

## 1. ดูว่าของเข้ามาครบไหม

```sql
-- ของดิบที่รับมาได้ แยกตามช่องทางและสถานะ
select channel_key, status, count(*), max(received_at)
  from connect_private.webhook_log
 where received_at > now() - interval '1 day'
 group by 1,2 order by 1,2;

-- event ที่แปลแล้ว แยกตามชนิด — postback/follow ควรมีบ้างถ้ามีคนกดปุ่มหรือเพิ่มเพื่อน
select event_type, count(*) from connect_private.inbound_event
 where received_at > now() - interval '1 day' group by 1 order by 2 desc;
```

`status='failed'` ต้องเป็น 0 · ถ้ามี ดู `last_error` แล้วแก้ก่อนเริ่มนับ

---

## 2. เทียบการตัดสินใจกับ cloud

เกณฑ์ของ PLAN คือ `bot_decisions` ฝั่ง local ตรงกับ cloud **≥ 99%** ในสามช่อง
`reply_go` · `notify_go` · `delay_sec`

### 2.1 ดึงของฝั่ง local

```sql
select ci.external_id                          as customer_key,
       left(d.text, 200)                       as text,
       d.decided_at,
       d.reply_go, d.reply_reason,
       d.notify_go, d.notify_reason,
       d.notify_action, d.delay_sec
  from inbox.bot_decisions d
  join inbox.conversation c  on c.id = d.conversation_id
  join inbox.inbox i         on i.id = c.inbox_id
  left join core.contact_identity ci
         on ci.contact_id = c.contact_id and ci.channel = i.channel and ci.account_key = i.id::text
 where d.decided_at >= :from and d.decided_at < :to
 order by d.decided_at;
```

### 2.2 ดึงของฝั่ง cloud

ต้องรันบน Supabase Cloud (เครื่องนี้ต่อไปไม่ถึง) — ตารางของเดิมชื่อ `public.bot_decisions`

```sql
select cu.psid                                  as customer_key,
       left(b.text, 200)                        as text,
       b.created_at                             as decided_at,
       b.reply_go, b.reply_reason,
       b.notify_go, b.notify_reason,
       b.delay_sec
  from bot_decisions b
  join conversations cv on cv.id = b.conversation_id
  join customers cu     on cu.id = cv.customer_id
 where b.created_at >= :from and b.created_at < :to
 order by b.created_at;
```

### 2.3 จับคู่ยังไง

**ของเดิมไม่มี `event_id`** จึงจับคู่ด้วยกุญแจตรงตัวไม่ได้ ต้องใช้สามอย่างรวมกัน

```
customer_key  +  left(text,200)  +  decided_at ต่างกันไม่เกิน 60 วินาที
```

`customer_key` คือ psid ของ Messenger หรือ userId ของ LINE — ตรงกันทั้งสองฝั่ง
แถวที่จับคู่ไม่ได้ **ห้ามทิ้ง** ให้นับแยกเป็น "มีข้างเดียว" เพราะนั่นคืออาการที่ต้องอธิบายให้ได้

วิธีที่เร็วที่สุดคือ export ทั้งสองฝั่งเป็น CSV แล้ว join ในฐาน local

```bash
# บน cloud: รันคิวรี 2.2 แล้ว export เป็น cloud_decisions.csv
docker cp cloud_decisions.csv supabase-db:/tmp/
docker exec supabase-db psql -U postgres -d postgres -c "
  create temp table cloud_d(customer_key text, text text, decided_at timestamptz,
                            reply_go bool, reply_reason text, notify_go bool,
                            notify_reason text, delay_sec int);
  \\copy cloud_d from '/tmp/cloud_decisions.csv' csv header;
  -- แล้ว join กับคิวรี 2.1
"
```

### 2.4 ตัวเลขที่ต้องรายงาน

| ตัวเลข | เกณฑ์ผ่าน |
|---|---|
| จับคู่ได้กี่ % ของทั้งหมด | ≥ 98% (ที่เหลือต้องอธิบายได้ทีละแถว) |
| `reply_go` ตรงกัน | ≥ 99% |
| `notify_go` ตรงกัน | ≥ 99% |
| `delay_sec` ต่างกันไม่เกิน jitter (4 วินาที) | ≥ 99% |
| แถวที่มีเฉพาะฝั่ง local | ต้องอธิบายได้ทุกแถว |
| แถวที่มีเฉพาะฝั่ง cloud | ต้องเป็น 0 — ถ้ามีแปลว่าเรารับ event ไม่ครบ |

**ต่างกันแล้วยังผ่านได้ ถ้าเป็นสามกรณีนี้** (บันทึกไว้ในรายงาน อย่าปล่อยผ่านเงียบ ๆ)

1. `delay_sec` ต่างกันไม่เกิน 4 วินาที — jitter สุ่มคนละค่า ตั้งใจให้ต่าง
2. cloud บันทึกคำสั่งแอดมิน (`test …` / `sim …`) แต่ local ไม่มี — ตัดทิ้งตาม PLAN แล้ว
3. `notify_reason` ต่างกันแต่ `notify_go` เท่ากัน — ถ้อยคำของเหตุผลไม่ใช่พฤติกรรม

---

## 3. เทียบคำตอบของบอท (ไม่ใช่แค่การตัดสินใจ)

การตัดสินใจตรงกันไม่ได้แปลว่าคำตอบเหมือนกัน — โมเดลตอบไม่ซ้ำเดิมอยู่แล้ว
สิ่งที่ต้องดูคือ **คำตอบของเราไม่แย่กว่าเดิม** ไม่ใช่เหมือนเดิม

```sql
-- คำตอบที่บอทคิดไว้ในโหมดเงา (ยังไม่ได้ส่งออกไปหาลูกค้า)
select c.id, m.created_at, m.content
  from inbox.message m join inbox.conversation c on c.id = m.conversation_id
 where m.sender_type = 'bot' and m.created_at > now() - interval '1 day'
 order by m.created_at desc limit 50;
```

อ่านด้วยตา 50 ข้อความ แล้วตอบสามข้อ

- มีข้อความไหน**แต่งตัวเลขหรือสถานที่ที่ไม่มีใน PROJECT DATA** ไหม → ถ้ามี **ห้ามสลับ**
- มีข้อความไหนตอบเรื่องโครงการที่ยังไม่มีข้อมูล (Vibe) ไหม → ถ้ามี **ห้ามสลับ**
- มีข้อความไหนขอเบอร์ทั้งที่ลูกค้าให้ไปแล้วไหม → แก้ที่ `known` ใน worker ก่อน

---

## 4. หน่วยความจำ

```powershell
docker stats asher-connect --no-stream
curl -s http://127.0.0.1:3200/health   # ดู memory.rssMb
```

| ที่มา | หมายถึง | เกณฑ์ |
|---|---|---|
| `docker stats` | RSS ที่ kernel นับให้ container | นิ่งต่ำกว่า 120 MB ตลอดสามวัน |
| `/health` → `memory.rssMb` | RSS ที่ Node เห็นตัวเอง | เตือนใน log เมื่อเกิน 140 |
| `mem_limit` ใน compose | เพดานแข็ง ถูกฆ่าเมื่อเกิน | 256 MB |
| `--max-old-space-size` | เพดาน heap ของ V8 | 160 MB |

เพดานสองชั้นตั้งใจให้ V8 เริ่มเก็บกวาดก่อนที่ kernel จะฆ่าโพรเซส
**ถูก OOM kill แล้วจะไม่มี log ว่าตอนนั้นทำอะไรอยู่** ซึ่งคือสิ่งที่ต้องเลี่ยงที่สุด

ขึ้นเรื่อย ๆ ไม่ลง = รั่ว ให้ดูสามที่ก่อน: ประวัติที่ส่งให้ Claude (`history_limit`),
ของดิบใน `webhook_log` ที่ยังไม่ถูกลบ, และจำนวนงานค้างใน `connect_private.job`

---

## 5. วันสลับจริง

ทำตามลำดับ ห้ามสลับลำดับ

```
1. ปิดบอทบน cloud ก่อน          ← สำคัญที่สุด ไม่งั้นลูกค้าได้คำตอบสองครั้ง
2. รอ 5 นาที ดูว่าไม่มีอะไรออกจาก cloud อีก
3. ปิดโหมดเงาที่นี่:  CONNECT_SHADOW_MODE=false ใน .env
4. docker compose ... up -d       (restart เฉย ๆ ไม่โหลด env ใหม่)
5. ดู /health ว่า shadow: false และ workerLastSuccess ขยับ
6. ทดสอบด้วยบัญชีตัวเองหนึ่งข้อความ ก่อนปล่อยลูกค้าจริง
7. ย้าย webhook ของ LINE/Meta มาที่นี่ที่เดียว
```

### ของที่ค้างอยู่ตอนปิดโหมดเงา

งานส่งที่สะสมไว้ตอนโหมดเงา **จะถูกส่งออกทันทีที่ปิดโหมด** ตามลำดับเดิม
ถ้าสะสมมาสามวัน ลูกค้าจะได้ข้อความเก่าทั้งหมดพร้อมกัน

ตรวจก่อนเสมอ แล้วตัดสินใจว่าจะล้างหรือปล่อย

```sql
select count(*), min(created_at), max(created_at)
  from connect_private.delivery where status = 'pending';

-- ถ้าจะไม่ส่งของเก่า ให้ทำเครื่องหมายว่าข้าม (อย่า delete — เสียหลักฐาน)
update connect_private.delivery
   set status = 'failed', last_error = 'ข้ามตอนสลับระบบ ไม่ส่งของเก่า'
 where status = 'pending' and created_at < now() - interval '1 hour';
```

---

## 6. ถอยกลับ

ทุกขั้นถอยได้ภายในไม่กี่นาที และ**ไม่ต้อง deploy อะไรเลย**

| อาการ | ทำอะไร | ใช้เวลา |
|---|---|---|
| บอทตอบผิด/ตอบมั่ว | กดปุ่ม **บอทเปิด · กดเพื่อปิด** บนหน้าเว็บ | ทันที |
| ส่งออกผิดพลาดทั้งระบบ | `CONNECT_SHADOW_MODE=true` แล้ว `up -d` | ~30 วินาที |
| ต้องกลับไปใช้ cloud | เปิดบอทบน cloud คืน + ย้าย webhook กลับ | ~5 นาที |
| ฐานข้อมูลมีปัญหา | `npm run backup:verify` แล้วกู้จาก backup ล่าสุด | ตามขนาดฐาน |

**ปิดบอทด้วยปุ่มไม่ได้หยุดการรับข้อความ** — ข้อความลูกค้ายังเข้าระบบครบ
เซลส์ยังตอบเองได้จากหน้าจอตามปกติ หยุดแค่การเรียก AI

---

## 7. ของที่ยังไม่พร้อม ณ วันที่เขียน

| เรื่อง | สถานะ |
|---|---|
| `pg_cron` | ยังไม่ติดตั้ง → `inbox.watchdog()` ยังไม่มีใครเรียก → **ยังไม่มีการแจ้งค้างตอบ** |
| คำสั่งในกลุ่ม LINE | ยังไม่เข้า `receive` (รอ Phase 6) |
| `[AD:xxx]` prefix ของ LINE | ยังไม่ได้แปล (รอ Phase 6) |
| รายงาน Telegram 09:00 | รอ Phase 7 และยังไม่มีโค้ดอ้างอิง (`fbline_report_TG.ts` หาไม่เจอ) |
| ข้อมูลโครงการ Asher Vibe | ยังไม่มี — บอทถูกสั่งให้ไม่ตอบคำถามเชิงข้อมูลของโครงการนี้ |
| RAG (`match_knowledge`) | ไม่มี pgvector และไม่มีตาราง knowledge — ของเดิมก็ข้ามเมื่อไม่มี OpenAI key |

สามข้อแรกกระทบตัวเลขเทียบโดยตรง — `watchdog` ที่ไม่เดินแปลว่าฝั่งเราจะไม่มีแถว
"แจ้งค้างตอบ" ที่ cloud มี ให้แยกนับต่างหาก อย่าเอาไปรวมกับ `reply_go` ที่ไม่ตรง
