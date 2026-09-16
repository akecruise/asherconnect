# ตั้งค่าบัญชีทดสอบ (TEST_USER_IDS)

คำสั่งทั้งหมดในไฟล์นี้ **ผู้ใช้รันเอง** — รันซ้ำได้โดยไม่เกิดบรรทัดซ้ำใน `.env`

---

## 1. ใส่ LINE userId ก่อน (ยืนยันแล้ว)

```bash
ssh root@187.53.139.175
cd /opt/asher-inbox/app

# สำรองก่อนเสมอ
cp .env ".env.bak-$(date +%Y%m%d-%H%M%S)"

# ★ รันซ้ำได้: มีบรรทัดอยู่แล้วให้แทนที่ ไม่มีให้เพิ่ม
IDS='U0090435e720c5a81158ba206830cceef'
if grep -q '^TEST_USER_IDS=' .env; then
  sed -i "s|^TEST_USER_IDS=.*|TEST_USER_IDS=$IDS|" .env
  echo "แทนที่ค่าเดิมแล้ว"
else
  printf 'TEST_USER_IDS=%s\n' "$IDS" >> .env
  echo "เพิ่มบรรทัดใหม่แล้ว"
fi

# ตรวจว่ามีบรรทัดเดียวจริง
grep -c '^TEST_USER_IDS=' .env      # ต้องได้ 1
grep '^TEST_USER_IDS=' .env
```

> ⚠️ **ยังไม่ใส่ Messenger PSID** `28306603612314915` เพราะยังไม่ได้ยืนยันว่าเป็นของคุณ
> ใส่ ID ผิด = แชทลูกค้าคนนั้นหลุดจากสถิติถาวร (`is_test` ปลดไม่ได้)

---

## 2. ให้ container เห็นค่าใหม่

```bash
docker compose up -d --force-recreate
```

`docker restart` ไม่โหลด `.env` ใหม่ — ต้อง recreate เท่านั้น

---

## 3. ตรวจว่า container เห็นค่าแล้ว

```bash
docker exec asher-connect node -e '
const v = (process.env.TEST_USER_IDS ?? "").split(",").map(s=>s.trim()).filter(Boolean)
console.log(v.length ? `เห็นแล้ว ${v.length} บัญชี: ${v.join(" · ")}` : "ยังไม่เห็น — ฟีเจอร์ปิดอยู่")'
```

จากนั้นพิมพ์ `test` จากบัญชี LINE นั้น ควรได้ `🧪 รีเซ็ตแล้ว — บอทพร้อมตอบ เริ่มทดสอบได้เลย`

ตรวจฝั่งเซิร์ฟเวอร์:

```bash
docker logs asher-connect --since 5m 2>&1 | grep test_reset
```

---

## 4. หา Messenger PSID ของคุณ

**วิธี:** ส่งข้อความที่มีคำเฉพาะซึ่งไม่มีใครพิมพ์ซ้ำได้ จากบัญชี Facebook ของคุณเข้าเพจ
เช่น `ทดสอบรหัส-ก้อง-7391`

แล้วค้นจากของดิบที่ระบบเก็บไว้ (อ่านอย่างเดียว ไม่แก้อะไร):

```bash
docker exec supabase-db psql -U postgres -d postgres -c "
select w.received_at at time zone 'Asia/Bangkok' as thai_time,
       w.channel_key,
       jsonb_path_query_first(w.payload, '\$.entry[*].messaging[*].sender.id') #>> '{}' as psid,
       jsonb_path_query_first(w.payload, '\$.entry[*].messaging[*].message.text') #>> '{}' as ข้อความ
  from connect_private.webhook_log w
 where w.received_at > now() - interval '30 minutes'
   and w.payload::text ilike '%ทดสอบรหัส-ก้อง-7391%'
 order by w.received_at desc;"
```

ถ้า `jsonb_path_query_first` ใช้ไม่ได้บนเวอร์ชันนี้ ใช้แบบตรง ๆ แทน:

```bash
docker exec supabase-db psql -U postgres -d postgres -c "
select w.received_at at time zone 'Asia/Bangkok' as thai_time,
       w.payload->'entry'->0->'messaging'->0->'sender'->>'id'   as psid,
       w.payload->'entry'->0->'messaging'->0->'message'->>'text' as ข้อความ
  from connect_private.webhook_log w
 where w.received_at > now() - interval '30 minutes'
   and w.payload::text ilike '%ทดสอบรหัส-ก้อง-7391%'
 order by w.received_at desc;"
```

ได้ PSID มาแล้วเติมต่อท้าย — ยังรันซ้ำได้เหมือนเดิม:

```bash
cd /opt/asher-inbox/app
cp .env ".env.bak-$(date +%Y%m%d-%H%M%S)"
IDS='U0090435e720c5a81158ba206830cceef,<PSID ที่ได้>'
sed -i "s|^TEST_USER_IDS=.*|TEST_USER_IDS=$IDS|" .env
grep -c '^TEST_USER_IDS=' .env      # ต้องได้ 1
docker compose up -d --force-recreate
```

---

## ถอยกลับ

```bash
cd /opt/asher-inbox/app
sed -i '/^TEST_USER_IDS=/d' .env    # ลบบรรทัดออก = ปิดฟีเจอร์สนิท
docker compose up -d --force-recreate
```

ธง `is_test` ที่ติดไปแล้วจะยังอยู่ (ตั้งใจให้ติดถาวร) — การปิดฟีเจอร์แค่ทำให้ไม่มีใครสั่งรีเซ็ตได้อีก
