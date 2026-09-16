# CONFIG.md — ค่าที่ต้องเติม อยู่ที่ไหน เอามาจากไหน

ตรวจจาก `.env` และ `channels.json` จริงเมื่อ 16 กันยายน 2026

ใช้คู่กับ `ROADMAP.md` (ลำดับการแก้) และ `README.md` (ภาพรวม)

---

## 0. สรุป — ขาดอะไรบ้าง

**ไฟล์ที่ต้องแก้: `D:\aplus_postgres_docker\asher-connect\.env`** (ไฟล์เดียว ไม่เข้า git)

| # | ตัวแปร | สถานะ | จำเป็นแค่ไหน |
|---|---|---|---|
| 1 | `LINE_NOTIFY_TOKEN` | ✅ **เติมแล้ว** (16 ก.ย. 2026 · คัดจาก `channels.json`) | **บังคับ** — ไม่มี = ไม่แจ้งอะไรเลย |
| 2 | `LINE_NOTIFY_GROUP_ID` | ⬜ **ว่าง** | **บังคับ** — ไม่มี = ไม่แจ้งอะไรเลย |
| 3 | `ANTHROPIC_API_KEY` | ⚠️ **มีค่าแต่รูปแบบผิด** | **บังคับ** — บอทคิดคำตอบไม่ได้ |
| 4 | `TELEGRAM_BOT_TOKEN` | ⬜ ว่าง | ถ้าอยากให้เด้ง Telegram ตอนได้เบอร์ |
| 5 | `TELEGRAM_CHAT_ID` | ⬜ ว่าง | คู่กับข้อ 4 |
| 6 | `RESEND_API_KEY` | ⬜ ว่าง | ถ้าอยากให้ส่งอีเมลตอนได้เบอร์ |
| 7 | `LEAD_EMAIL_TO` | ⬜ ว่าง | คู่กับข้อ 6 |
| 8 | `CONNECT_EDGE_FUNCTIONS` | ⬜ ว่าง | ไม่ต้องเติม — ปล่อยว่างถูกแล้ว |

**ที่มีครบแล้ว ไม่ต้องแตะ:** `CONNECT_PUBLIC_URL` · `SUPABASE_URL` · `SUPABASE_ANON_KEY` · `SUPABASE_SERVICE_ROLE_KEY` · `CONNECT_SHADOW_MODE` · `CONNECT_ACCOUNT_EMAIL` · `CONNECT_ACCOUNT_PASSWORD` · `LEAD_EMAIL_FROM`

> เติมแค่ข้อ 1–3 การแจ้งเข้ากลุ่ม LINE ก็กลับมาทำงาน (หลังทำ `ROADMAP.md` STEP 3)

---

## 1. LINE_NOTIFY_TOKEN — 🟢 มีอยู่แล้วในเครื่อง ไม่ต้องไปขอที่ไหน

**คือค่าอะไร:** Channel access token ของ LINE OA ที่จะเป็นคนพูดในกลุ่ม

**เอามาจากไหน:** คัดลอกจากไฟล์ `channels.json` ในโฟลเดอร์นี้ — **ตัวที่ `"enabled": true`**

```
D:\aplus_postgres_docker\asher-connect\channels.json
```

เปิดไฟล์แล้วหา object ที่หน้าตาแบบนี้ (ตัวที่ 2 ในไฟล์):

```json
{
  "key": "naii-l...",
  "name": "LINE",              ← ชื่อว่า "LINE" เฉย ๆ
  "channel": "line",
  "enabled": true,             ← ★ ต้องเป็น true
  "account_id": "U0090435e720c5a81158ba206830cceef",
  "access_token": "qzxxNL…"    ← ★ คัดลอกค่านี้ทั้งอัน
}
```

⚠️ **อย่าหยิบตัวแรก** ที่ชื่อ `LINE ASHER Connect Dev (2011572071)` — ตัวนั้น `enabled: false` (เป็นตัว dev)

**หน้าตาที่ถูกต้อง:** ยาว 172 ตัวอักษร · ตัวอักษรอังกฤษ ตัวเลข `/` `+` `=` ปนกัน

**ทำไมใช้ตัวเดียวกันได้:** LINE OA ตัวเดียวทำได้ทั้งรับแชทลูกค้าและ push เข้ากลุ่ม ไม่ต้องสร้าง OA ใหม่

**ถ้าอยากออกใหม่แทน:** https://developers.line.biz/console/ → เลือก Provider → เลือก Channel → แท็บ **Messaging API** → ล่างสุด **Channel access token (long-lived)** → กด Issue

---

## 2. LINE_NOTIFY_GROUP_ID — ต้องไปเอาจากกลุ่มจริง

**คือค่าอะไร:** รหัสของกลุ่ม LINE ที่ทีมเฝ้าอยู่ ซึ่งจะเป็นที่ที่ข้อความแจ้งไปลง

**หน้าตาที่ถูกต้อง:** ขึ้นต้นด้วย `C` ตามด้วยตัวอักษรเล็กและตัวเลข ยาวรวม 33 ตัว
ตัวอย่าง `Cf1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6`

⚠️ **หาจากแอป LINE ในมือถือไม่ได้** LINE ไม่แสดง group id ให้ผู้ใช้เห็น ต้องให้บอทบอก

### วิธีที่ 1 — อ่านจากฐาน (ใช้ได้ตอนนี้ ไม่ต้องรอแก้โค้ด) ✅ แนะนำ

1. เชิญ LINE OA ตัวที่ `enabled: true` (ข้อ 1) เข้ากลุ่มที่ทีมเฝ้าอยู่
2. พิมพ์อะไรก็ได้ในกลุ่มหนึ่งข้อความ
3. เปิดฐานแล้วรัน:

```sql
select received_at, payload
  from connect_private.webhook_log
 where channel_key like '%line%'
   and payload::text like '%"groupId"%'
 order by received_at desc
 limit 5;
```

ในผลลัพธ์จะเห็น `"groupId": "Cxxxxxxxx…"` — คัดลอกค่านั้น

รันจากบรรทัดคำสั่งก็ได้:

```powershell
docker exec supabase-db psql -U postgres -d postgres -c "select payload->'events'->0->'source'->>'groupId' as group_id, received_at from connect_private.webhook_log where payload::text like '%groupId%' order by received_at desc limit 5;"
```

### วิธีที่ 2 — พิมพ์ในกลุ่ม (ยังใช้ไม่ได้ตอนนี้)

พิมพ์ `ไอดีกลุ่ม` ในกลุ่ม แล้วบอทจะตอบ `groupId: Cxxxx…`

คำสั่งนี้เขียนไว้แล้วจริง (`sql/005_line.sql:158`) แต่คำตอบถูกเข้าคิวเป็นงาน `send`
ซึ่ง**โหมดเงาบล็อกอยู่** — จะใช้ทางนี้ได้หลังทำ `ROADMAP.md` STEP 3 เสร็จ

---

## 3. ANTHROPIC_API_KEY — ⚠️ ค่าที่ใส่อยู่ตอนนี้ผิดรูปแบบ

**อาการ:** ค่าปัจจุบันยาว 57 ตัวอักษร ขึ้นต้นด้วย `c5525d84`

**ที่ถูกต้อง:** คีย์ของ Anthropic ขึ้นต้นด้วย `sk-ant-api03-` เสมอ และยาวประมาณ 108 ตัวอักษร

ค่าที่ใส่อยู่ไม่ใช่รูปแบบนั้น → บอทจะเรียก API ไม่ผ่าน (`401 authentication_error`) และงาน `generate` / `classify` จะล้มทุกครั้ง

**เอามาจากไหน:** https://console.anthropic.com/settings/keys → **Create Key** → คัดลอกทันที (แสดงครั้งเดียว)

**ตรวจว่าใช้ได้จริง:**

```powershell
curl.exe -s -o NUL -w "%{http_code}" https://api.anthropic.com/v1/messages ^
  -H "x-api-key: <คีย์ใหม่>" -H "anthropic-version: 2023-06-01" ^
  -H "content-type: application/json" ^
  -d "{\"model\":\"claude-haiku-4-5-20251001\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

ได้ `200` = ใช้ได้ · `401` = คีย์ผิด · `400` = คีย์ถูกแต่ body ผิด (ก็ถือว่าคีย์ผ่าน)

> ถ้าค่าปัจจุบันคือคีย์ของบริการอื่นที่ใส่ผิดช่อง ให้ย้ายไปช่องที่ถูกและใส่คีย์ Anthropic จริงลงตรงนี้

---

## 4. TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID — ไม่บังคับ

ยิงเฉพาะตอนลูกค้าให้เบอร์โทรหรือ LINE ID มา ไม่ได้ยิงทุกข้อความ

### TELEGRAM_BOT_TOKEN

1. เปิด Telegram แล้วทักหา **@BotFather**
2. พิมพ์ `/newbot` → ตั้งชื่อ → ตั้ง username ที่ลงท้ายด้วย `bot`
3. BotFather จะส่ง token กลับมา

**หน้าตาที่ถูกต้อง:** `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (ตัวเลข + `:` + ตัวอักษร)

ถ้ามีบอทอยู่แล้ว: `/mybots` → เลือกบอท → **API Token**

### TELEGRAM_CHAT_ID

1. ชวนบอทเข้ากลุ่มที่ต้องการ (หรือทักบอทตรง ๆ ถ้าอยากให้เข้าแชทส่วนตัว)
2. พิมพ์อะไรก็ได้หนึ่งข้อความในกลุ่มนั้น
3. เปิด URL นี้ในเบราว์เซอร์ (แทน `<TOKEN>` ด้วย token จากข้อบน):

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

4. หา `"chat":{"id":-1001234567890` → คัดลอกตัวเลขรวมเครื่องหมายลบ

**หน้าตาที่ถูกต้อง:** กลุ่มเป็นเลข**ติดลบ** เช่น `-1001234567890` · แชทส่วนตัวเป็นเลขบวก

⚠️ ถ้า `getUpdates` คืน `{"ok":true,"result":[]}` แปลว่ายังไม่มีข้อความ ให้พิมพ์ในกลุ่มก่อนแล้วเปิดใหม่

---

## 5. RESEND_API_KEY + LEAD_EMAIL_TO — ไม่บังคับ

ยิงเฉพาะตอนได้เบอร์ เช่นเดียวกับ Telegram

### RESEND_API_KEY

https://resend.com/api-keys → **Create API Key** → สิทธิ์ **Sending access** ก็พอ

**หน้าตาที่ถูกต้อง:** ขึ้นต้นด้วย `re_`

### LEAD_EMAIL_TO

อีเมลของคนที่จะรับแจ้ง lead — ใส่ได้อีเมลเดียว เช่น `sales@apluscondo.com`

### LEAD_EMAIL_FROM

มีค่าอยู่แล้วเป็น `onboarding@resend.dev` (โดเมนทดสอบของ Resend ใช้ได้เลย)

ถ้าอยากให้อีเมลออกจากโดเมนตัวเอง ต้องไปยืนยันโดเมนที่ https://resend.com/domains ก่อน แล้วค่อยเปลี่ยนเป็น เช่น `noreply@apluscondo.com`

---

## 6. หน้าตาไฟล์ .env หลังเติมครบ

```bash
# ── คีย์ของ Claude ────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ── ปลายทางของการแจ้งทีม ──────────────────────────────────────────────────
# กลุ่ม LINE ที่ทีมเฝ้าอยู่ — ใช้ทุกครั้งที่มีคนทัก
LINE_NOTIFY_GROUP_ID=Cf1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6
LINE_NOTIFY_TOKEN=qzxxNL……(172 ตัวอักษร คัดลอกจาก channels.json)

# Telegram กับอีเมล — ยิงเฉพาะตอนลูกค้าให้เบอร์หรือ LINE มา
TELEGRAM_BOT_TOKEN=123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=-1001234567890
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
LEAD_EMAIL_TO=sales@apluscondo.com
LEAD_EMAIL_FROM=onboarding@resend.dev
```

**กฎการเขียน `.env`**
- ห้ามใส่เครื่องหมายคำพูดครอบค่า — `LINE_NOTIFY_TOKEN=abc` ไม่ใช่ `LINE_NOTIFY_TOKEN="abc"`
- ห้ามเว้นวรรครอบ `=`
- ห้ามมีช่องว่างหรือขึ้นบรรทัดใหม่ท้ายค่า (คัดลอกจาก LINE console มักติดมา)
- ไฟล์นี้อยู่ใน `.gitignore` แล้ว ค่าที่ใส่จะไม่เข้า git

---

## 7. หลังเติมค่าเสร็จ — ต้องทำอะไรต่อ

```powershell
cd D:\aplus_postgres_docker\asher-connect
docker compose up -d
```

⚠️ **ต้อง `up -d` เท่านั้น** — `docker restart` ไม่โหลด `.env` ใหม่

### ตรวจว่าค่าเข้าไปถึงในคอนเทนเนอร์จริง

```powershell
docker exec asher-connect node -e "const e=process.env;console.log({LINE_NOTIFY_TOKEN:!!e.LINE_NOTIFY_TOKEN,LINE_NOTIFY_GROUP_ID:!!e.LINE_NOTIFY_GROUP_ID,ANTHROPIC:(e.ANTHROPIC_API_KEY||'').startsWith('sk-ant-'),TELEGRAM:!!e.TELEGRAM_BOT_TOKEN,RESEND:!!e.RESEND_API_KEY})"
```

ต้องได้ `true` ในตัวที่เติมไป และ `ANTHROPIC: true`

### ทดสอบว่ายิงเข้ากลุ่ม LINE ได้จริง (ไม่ต้องรอระบบ)

```powershell
curl.exe -s -X POST https://api.line.me/v2/bot/message/push ^
  -H "Authorization: Bearer <LINE_NOTIFY_TOKEN>" ^
  -H "Content-Type: application/json" ^
  -d "{\"to\":\"<LINE_NOTIFY_GROUP_ID>\",\"messages\":[{\"type\":\"text\",\"text\":\"ทดสอบจาก asher-connect\"}]}"
```

| ผลที่ได้ | แปลว่า |
|---|---|
| `{}` ว่าง ๆ และข้อความเด้งในกลุ่ม | ✅ ทั้ง token และ group id ถูกต้อง |
| `401 Authentication failed` | token ผิดหรือหมดอายุ → กลับไปข้อ 1 |
| `400 The property, to, in the request body is invalid` | group id ผิด → กลับไปข้อ 2 |
| `403 Forbidden` | บอทไม่ได้อยู่ในกลุ่มนั้น → เชิญเข้ากลุ่มก่อน |

**ถ้าคำสั่งนี้ผ่านแล้วแต่ระบบยังไม่แจ้ง** → ไม่ใช่ปัญหา config แล้ว ให้ไปทำ `ROADMAP.md` STEP 3 (โหมดเงาบล็อกงานแจ้งอยู่)

---

## 8. ตารางอ้างอิงเร็ว

| ตัวแปร | เอามาจาก | หน้าตา |
|---|---|---|
| `LINE_NOTIFY_TOKEN` | `channels.json` ตัวที่ `enabled: true` | 172 ตัวอักษร |
| `LINE_NOTIFY_GROUP_ID` | คิวรี `webhook_log` หลังพิมพ์ในกลุ่ม | `C` + 32 ตัว |
| `ANTHROPIC_API_KEY` | console.anthropic.com/settings/keys | `sk-ant-api03-…` ~108 ตัว |
| `TELEGRAM_BOT_TOKEN` | @BotFather → `/mybots` | `เลข:ตัวอักษร` |
| `TELEGRAM_CHAT_ID` | `api.telegram.org/bot<TOKEN>/getUpdates` | เลขติดลบ |
| `RESEND_API_KEY` | resend.com/api-keys | `re_…` |
| `LEAD_EMAIL_TO` | อีเมลทีมขาย | `x@y.com` |
