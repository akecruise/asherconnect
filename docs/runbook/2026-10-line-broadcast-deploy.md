# Runbook — deploy ตัวส่ง LINE หลายคน (Phase 1)

วันที่เขียน 2026-10-02 · commit ที่จะขึ้น: ปลายทางของ `feature/line-broadcast-sender`
อ่านก่อน: `docs/BOUNDARIES.md` · `docs/handoff/2026-10-02-line-broadcast-implementation.md` · `docs/handoff/2026-10-02-phase0-audit.md`

> **ยังไม่ได้รันอะไรในไฟล์นี้เลย** — เอกสารนี้คือแผน ผู้ใช้เป็นคนรันบน VPS แล้ววางผลกลับมา
> cloud session เข้า VPS/โดเมนไม่ได้ (network policy) และ **ssh เข้าตัวเองจะ Permission denied — รันบน VPS ตรง ๆ ไม่ต้อง ssh**

## ลำดับทั้งหมด (อย่าข้ามขั้น)

```
0 ตัดสินใจเรื่อง branch  →  1 pre-check + backup  →  2 ลง SQL + ตรวจ
→  3 deploy แบบ dry run + ตั้ง token  →  4 ทดสอบ /internal/* ด้วย curl
→  5 allowlist ทีมงาน + เปิด LIVE ยิงจริง  →  6 เกณฑ์ขยายไปลูกค้าจริง
```

**ตัวเลขที่ต้องมีติดมือก่อนเริ่ม** (จาก Phase 0 ข้อ 5 — ถ้ายังไม่ได้นับ ไปนับก่อน):
จำนวน `pending` ใน `inbox.crm_publish_outbox` · ถ้าหลักพันขึ้นไป **ห้ามกู้ `crmPublisherWorker` พร้อมกับ deploy นี้** แยกเป็นสองรอบ

---

## 0. ตัดสินใจเรื่อง branch ก่อน (★ ต้องทำก่อนทุกอย่าง)

สาย production คือ `hotfix/login-button-color` **ไม่ใช่** `main` (`origin/main` = `ab2f655 "first commit"` ว่างเปล่า)
ตอนนี้ `feature/line-broadcast-sender` = `hotfix/login-button-color` + 6 commit และ **ไม่มีโอกาส conflict** (ตรวจแล้วใน Phase 0 ข้อ 4)

เลือกหนึ่งทาง:

| | ทาง | เหมาะเมื่อ |
|---|---|---|
| **A** (แนะนำ) | เปิด PR `feature/line-broadcast-sender` → `hotfix/login-button-color` แล้ว merge · deploy จาก **merge commit** | ปกติ — ประวัติ production ชัด ย้อนได้ด้วย `git revert` |
| **B** | deploy จากปลาย `feature/line-broadcast-sender` ตรง ๆ | รีบทดสอบบน prod · แต่ production จะรัน commit ที่ไม่อยู่ในสาย production |

```bash
# บนเครื่องผู้ใช้ — เปิด PR (ทาง A)
gh pr create --base hotfix/login-button-color --head feature/line-broadcast-sender \
  --title "LINE multicast sender + service API for CRM" --body-file docs/handoff/2026-10-02-line-broadcast-implementation.md
```

**จด commit 40 ตัวที่จะ deploy ไว้** — ทุกขั้นข้างล่างใช้ค่านี้:
```bash
COMMIT=<hash 40 ตัว>        # ต้อง push ขึ้น GitHub แล้ว (สคริปต์ดึงผ่าน codeload)
```

---

## 1. Pre-check + จุดย้อนกลับ

รันบน VPS:

```bash
cd /opt/asher-inbox/app

# 1.1 ตัวที่รันอยู่ตอนนี้ — ต้องเป็น 4a5482dbc9d44ce12df7c2c92952cf995736abbd
cat .deployed-commit

# 1.2 container สุขภาพดีอยู่ก่อน deploy
docker ps --filter name=asher-connect --format '{{.Status}}'
curl -s http://127.0.0.1:3200/health | head -c 400; echo

# 1.3 ★ ตัวเลข backlog (Phase 0 ข้อ 5) — ต้องรู้ก่อน
docker exec supabase-db psql -U postgres -d postgres -X -c "select inbox.crm_publish_stats();"

# 1.4 ของที่ห้ามทับ ยังอยู่ครบไหม
ls -la .env channels.json .sessions/ | head
```

**ผลที่ควรเห็น**
- `.deployed-commit` = `4a5482d...` ถ้าไม่ตรง **หยุด** แล้วรายงานค่าที่เห็น (มีคนอื่น deploy ไปแล้ว)
- `/health` ตอบ 200 และ `"ok": true`
- `crm_publish_stats()` → จด `pending` ไว้

**backup ไม่ต้องทำมือ** — `deploy-from-github.sh` ทำให้เองเมื่อส่งไฟล์ SQL เข้าไป:
`docker exec supabase-db pg_dump -U postgres -d postgres -n connect_private -n inbox > ../pre-deploy-<stamp>.sql`
และ `docker tag app-asher-connect:rollback-<stamp>` + `cp -a . ../app.bak-<stamp>`

---

## 2. ดูแผนก่อน แล้วลง SQL + โค้ดในรอบเดียว

`sql/` ไม่เข้า image (`Dockerfile` COPY เฉพาะ `package.json server.mjs providers.mjs auth.mjs bots/ reports/ public/ lib/ scripts/`)
→ migration ลงฐานแยก แต่สคริปต์จัดลำดับให้แล้ว: **backup → SQL → แตกโค้ด → build → ตรวจ 200**

```bash
curl -fsSL "https://raw.githubusercontent.com/akecruise/asherconnect/$COMMIT/scripts/deploy-from-github.sh" -o /tmp/deploy.sh

# 2.1 ดูแผนอย่างเดียว ไม่แก้อะไรเลย
DRY_RUN=1 EXPECT_LIVE=$(cat /opt/asher-inbox/app/.deployed-commit) \
  bash /tmp/deploy.sh "$COMMIT" sql/202610021200_line_broadcast.sql
```

**อ่านผล DRY RUN ให้ครบก่อนไปต่อ**
- หัวข้อ `3/7 ไฟล์ที่ถูกแก้ด้วยมือบนเครื่อง` — ถ้ามีไฟล์ `.mjs`/`.js` ขึ้นว่า **ชนกัน** ให้ **หยุด** และส่งรายการกลับมา
  (ไฟล์ใน `sql/ docs/ tests/` ขึ้นว่า "เก็บของบนเครื่อง" = ปกติ ไม่ต้องทำอะไร — ดู Phase 0 ว่า VPS มี SQL ที่ไม่อยู่ในรีโป)
- ต้องเห็นว่าจะลง `sql/202610021200_line_broadcast.sql` ไฟล์เดียว

```bash
# 2.2 รันจริง
EXPECT_LIVE=$(cat /opt/asher-inbox/app/.deployed-commit) \
  bash /tmp/deploy.sh "$COMMIT" sql/202610021200_line_broadcast.sql 2>&1 \
  | grep -v "^ *=> \|^#[0-9]" | tail -30

# 2.3 PostgREST ต้องโหลดรายชื่อฟังก์ชันใหม่ ไม่งั้น rpc ใหม่จะ 404
docker exec supabase-db psql -U postgres -d postgres -c "notify pgrst, 'reload schema'"
```

**ผลที่ควรเห็น:** ท้ายสุดคือ `DEPLOY ผ่าน: <commit>` และ `/ /app.js /app-nav.js /case-flags.mjs /contacts` ตอบ `200` ทุกตัว

### 2.4 ตรวจว่า SQL ลงครบจริง (อ่านอย่างเดียว)

```bash
docker exec supabase-db psql -U postgres -d postgres -X -c "
-- ตาราง 4 ตัว
select 'table' kind, relname from pg_class
 where relnamespace='connect_private'::regnamespace
   and relname in ('broadcast_job','broadcast_batch','broadcast_recipient','channel_follow')
union all
-- ฟังก์ชัน 13 ตัว
select 'function', proname from pg_proc
 where pronamespace='inbox'::regnamespace and proname like 'broadcast%'
 order by 1,2;"
```
**ควรเห็น:** table **4** แถว · function **13** แถว (`broadcast_batch_finish`, `broadcast_cancel`, `broadcast_claim_batch`, `broadcast_complete`, `broadcast_contact_profile`, `broadcast_emit`, `broadcast_enqueue`, `broadcast_follow_track`, `broadcast_job_fail`, `broadcast_job_start`, `broadcast_next_job`, `broadcast_recent_messages`, `broadcast_status`)

```bash
# ★ ด่านสิทธิ์ — ข้อนี้สำคัญที่สุดในหัวข้อนี้
docker exec supabase-db psql -U postgres -d postgres -X -c "
select p.proname,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('anon',          p.oid, 'execute') as anon,
       has_function_privilege('service_role',  p.oid, 'execute') as service_role
  from pg_proc p
 where p.pronamespace='inbox'::regnamespace and p.proname like 'broadcast%'
 order by 1;"
```
**ควรเห็น:** `authenticated` และ `anon` = `f` **ทุกแถว** · `service_role` = `t` (ยกเว้น `broadcast_emit` / `broadcast_follow_track` ที่เป็น `f` ทั้งสามคอลัมน์ — ตัวช่วยภายใน ตั้งใจไม่ให้ใครเรียก)
**ถ้าเจอ `authenticated = t` แถวใดแถวหนึ่ง → หยุด** แปลว่าเซลส์ยิง broadcast ได้จากหน้าเว็บ

```bash
# ทริกเกอร์ follow ติดตั้งแล้ว และของเดิมไม่หาย
docker exec supabase-db psql -U postgres -d postgres -X -c "
select tgname from pg_trigger
 where tgrelid='inbox.message'::regclass and not tgisinternal order by 1;"
```
**ควรเห็น:** `trg_broadcast_follow_track` **และ** `trg_crm_publish_message` (ของเดิม ต้องยังอยู่) + ทริกเกอร์เดิมอื่น ๆ

```bash
# backfill ทำงาน — มีสถานะ follow ย้อนหลังเข้ามาแล้ว
docker exec supabase-db psql -U postgres -d postgres -X -c "
select source, following, count(*) from connect_private.channel_follow group by 1,2 order by 1,2;"
```
**ควรเห็น:** แถว `backfill` จำนวนหนึ่ง (เท่ากับจำนวนคนที่เคยมี event follow/unfollow) · ยังไม่มี `webhook` จนกว่าจะมีคนกด follow/บล็อกใหม่

---

## 3. ตั้ง env — dry run เป็นค่าตั้งต้น

**★ ขั้นนี้ยัง *ไม่* ตั้ง `LINE_BROADCAST_LIVE`** ตั้งแค่ token

```bash
cd /opt/asher-inbox/app
cp -a .env ".env.bak-$(date +%Y%m%d-%H%M%S)"        # .env ไม่ได้อยู่ใน git — สำรองเองเสมอ

# สร้าง token แล้ว "จดไว้" เพราะต้องเอาไปตั้งที่ฝั่ง CRM ให้ตรงกัน
TOKEN=$(openssl rand -hex 32); echo "CONNECT_SERVICE_TOKEN=$TOKEN"

printf 'CONNECT_SERVICE_TOKEN=%s\n' "$TOKEN" >> .env
docker compose up -d
```

```bash
# ตรวจว่าแอปเห็นค่าแล้ว และยังเป็น dry run อยู่
curl -s http://127.0.0.1:3200/health | python3 -m json.tool | grep -A 5 '"broadcast"'
```
**ควรเห็นเป๊ะ ๆ:**
```json
"broadcast": {
    "live": false,            ← ★ ต้องเป็น false
    "serviceTokenSet": true,  ← ★ ต้องเป็น true
    "testAllowlist": 0,
    "lastSuccess": null
}
```
`live: true` ตอนนี้ = มีคนตั้ง `LINE_BROADCAST_LIVE=1` ไว้ก่อนแล้ว → **หยุด เอาออกก่อน**

---

## 4. ทดสอบ `/internal/*` ด้วย curl ครบทุกเส้นทาง

ตั้งค่าใช้ร่วม (บน VPS):
```bash
B=http://127.0.0.1:3200
H="Authorization: Bearer $TOKEN"
CH=<channel_key ของ LINE OA จาก channels.json>    # เช่น naii-line
```

### 4.1 ไม่มี token / token ผิด → 401 ทุกเส้นทาง

```bash
for p in "/internal/broadcasts" "/internal/line/quota?channel_key=$CH" \
         "/internal/contacts/00000000-0000-0000-0000-000000000000/profile"; do
  printf '%-70s ' "$p"
  curl -s -o /dev/null -w 'no-token=%{http_code} ' "$B$p"
  curl -s -o /dev/null -w 'bad-token=%{http_code}\n' -H "Authorization: Bearer wrong" "$B$p"
done
```
**ควรเห็น:** `no-token=401 bad-token=401` ทุกบรรทัด · **ถ้าเจอ 200 หรือ 404 → หยุดทันที** ประตูไม่ได้ล็อก

### 4.2 โควตาของ OA — ต้องรู้ตัวเลขนี้ก่อนยิงจริง

```bash
curl -s -H "$H" "$B/internal/line/quota?channel_key=$CH"
```
**ควรเห็น:** `{"limit":300,"used":<n>,"remaining":<300-n>}` (หรือ `limit:null` ถ้าแพ็กเกจไม่จำกัด)
★ `limit: 300` คือเพดานฟรีของ `@wdq0911k` ตามที่ handoff บันทึก — ถ้าจำนวนผู้รับเกิน `remaining` **งานจะถูกปฏิเสธทั้งก้อน ไม่ส่งบางส่วน** โดยตั้งใจ
`channel_key` ผิด → `404 {"error":"channel_not_found"}`

### 4.3 อ่านข้อมูลลูกค้า (อ่านอย่างเดียว)

```bash
REF=$(docker exec supabase-db psql -U postgres -d postgres -X -A -t -c \
  "select c.contact_id from inbox.conversation c
    where not coalesce(c.is_test,false) order by c.last_message_at desc nulls last limit 1")
echo "contact_ref=$REF"

curl -s -H "$H" "$B/internal/contacts/$REF/profile"
curl -s -H "$H" "$B/internal/contacts/$REF/recent-messages?limit=3"
```
**ควรเห็น:** `profile` คืน `display_name`/`picture_url`/`channels[]` ที่มี `following` ต่อช่องทาง
`recent-messages` คืน `{"messages":[...]}` เรียงใหม่→เก่า
**★ ตรวจสองอย่างด้วยตา:** (1) ไม่มี `access_token` / `secret` โผล่ในคำตอบ (2) ไม่มีเคส `is_test`

### 4.4 รับงาน — dry run (ยังไม่ถึงลูกค้า)

ใช้ userId ของ **ตัวเองหรือเพื่อนร่วมทีม** ไม่ใช่ของลูกค้า:
```bash
MYID=<LINE userId ของคุณ>
IDEM="runbook-dry-$(date +%s)"

curl -s -X POST "$B/internal/broadcasts" -H "$H" -H 'Content-Type: application/json' -d "{
  \"idempotency_key\": \"$IDEM\",
  \"channel_key\": \"$CH\",
  \"messages\": [{\"type\":\"text\",\"text\":\"ทดสอบ dry run ไม่ถึงลูกค้า\"}],
  \"recipients\": [{\"contact_ref\":\"$REF\",\"external_user_id\":\"$MYID\"}]
}"
```
**ควรเห็น:** `{"job_id":"...","accepted":1,"skipped":[],"reused":false,"dry_run":true}` ← `dry_run: true` คือหัวใจของขั้นนี้

```bash
JOB=<job_id ที่ได้>
sleep 12                      # worker เดินทุก 5 วินาที
curl -s -H "$H" "$B/internal/broadcasts/$JOB"
```
**ควรเห็น:** `status: "sent"`, `sent_count: 1` · และใน log ต้องมี `broadcast_dry_run`
```bash
docker logs asher-connect --since 5m 2>&1 | grep -E 'broadcast_(accepted|job_started|dry_run|batch_done)'
```
**★ สิ่งที่ยืนยันว่ายังไม่ได้ส่งจริง:** มีบรรทัด `broadcast_dry_run` และ **ไม่มี** `line_request_id` ในผล
**และโทรศัพท์ของคุณต้องไม่มีข้อความเข้า** — ถ้าได้ข้อความ แปลว่า `live` ไม่ได้เป็น false จริง → หยุด

### 4.5 idempotency + cancel + ข้อความผิดรูป

```bash
# ยิงคีย์เดิมซ้ำ → ต้องได้ job เดิม ไม่สร้างใหม่
curl -s -X POST "$B/internal/broadcasts" -H "$H" -H 'Content-Type: application/json' -d "{
  \"idempotency_key\": \"$IDEM\", \"channel_key\": \"$CH\",
  \"messages\": [{\"type\":\"text\",\"text\":\"ของใหม่ที่ต้องถูกเมิน\"}],
  \"recipients\": [{\"external_user_id\":\"$MYID\"},{\"external_user_id\":\"Uอีกคน\"}]}"
```
**ควรเห็น:** `job_id` เดิม · `"reused":true` · `"accepted":1` (ไม่ใช่ 2 — ไม่เพิ่มผู้รับให้ job เดิม)

```bash
# ข้อความผิดรูป → 400 พร้อมรหัสที่อ่านออก
for body in \
  '{"idempotency_key":"bad-1","channel_key":"'"$CH"'","messages":[],"recipients":[{"external_user_id":"U1"}]}' \
  '{"idempotency_key":"bad-2","channel_key":"'"$CH"'","messages":[{"type":"flex","contents":{}}],"recipients":[{"external_user_id":"U1"}]}' \
  '{"idempotency_key":"bad-3","channel_key":"'"$CH"'","messages":[{"type":"image","originalContentUrl":"http://x/a.jpg","previewImageUrl":"http://x/a.jpg"}],"recipients":[{"external_user_id":"U1"}]}' \
  '{"idempotency_key":"bad-4","channel_key":"ไม่มีช่องนี้","messages":[{"type":"text","text":"x"}],"recipients":[{"external_user_id":"U1"}]}' ; do
  curl -s -o /dev/null -w '%{http_code} ' -X POST "$B/internal/broadcasts" -H "$H" -H 'Content-Type: application/json' -d "$body"
  curl -s -X POST "$B/internal/broadcasts" -H "$H" -H 'Content-Type: application/json' -d "$body"; echo
done
```
**ควรเห็น:** `400 messages_required` · `400 unsupported_message_type` · `400 image_url_must_be_https` · `400 channel_not_found`

```bash
# cancel งานที่ยังไม่ส่ง
curl -s -X POST "$B/internal/broadcasts/$JOB/cancel" -H "$H"
```
**ควรเห็น:** `{"cancelled_batches":0,"status":"sent"}` (งานนี้ส่งจบแล้ว — ยกเลิกของที่ส่งแล้วไม่ได้ ถูกต้อง)

### 4.6 event เข้าคิวไป CRM แล้ว (แต่ยังไม่ถูกดูด — ตามที่ตัดสินใจไว้)

```bash
docker exec supabase-db psql -U postgres -d postgres -X -c "
select event_type, status, count(*) from inbox.crm_publish_outbox
 where event_type like 'broadcast%' or event_type = 'channel_identity.follow_changed'
 group by 1,2 order by 1,2;"
```
**ควรเห็น:** `broadcast.batch_result` + `broadcast.completed` สถานะ `pending`
★ `pending` ค้างเป็นเรื่องปกติ **ตามที่ตัดสินใจไว้** — ไม่มี `crmPublisherWorker` แล้ว (handoff ข้อค้าง 2)

---

## 5. ยิงจริงหาทีมงาน (ยังไม่ใช่ลูกค้า)

**เงื่อนไขก่อนเข้าขั้นนี้ — ต้องผ่านครบ:** 4.1 ได้ 401 ทุกเส้นทาง · 4.4 ได้ `dry_run:true` และไม่มีข้อความเข้าโทรศัพท์ · 4.5 ครบ · 2.4 สิทธิ์ถูก

```bash
cd /opt/asher-inbox/app

# 5.1 allowlist — ใส่ userId ของทีมงาน 2–3 คน คั่นด้วย , (ไม่มีเว้นวรรค)
printf 'BROADCAST_TEST_ALLOWLIST=%s\n' "Uaaa...,Ubbb...,Uccc..." >> .env
printf 'LINE_BROADCAST_LIVE=1\n' >> .env
docker compose up -d

curl -s http://127.0.0.1:3200/health | python3 -m json.tool | grep -A 5 '"broadcast"'
```
**ควรเห็น:** `"live": true` · `"testAllowlist": 3`

```bash
# 5.2 ยิงจริงด้วย test:true — เพดาน 5 คน และต้องอยู่ใน allowlist
curl -s -X POST "$B/internal/broadcasts" -H "$H" -H 'Content-Type: application/json' -d "{
  \"idempotency_key\": \"runbook-live-$(date +%s)\",
  \"channel_key\": \"$CH\",
  \"test\": true,
  \"messages\": [{\"type\":\"text\",\"text\":\"ทดสอบส่งหลายคนจาก ASHER Connect\"}],
  \"recipients\": [{\"external_user_id\":\"Uaaa...\"},{\"external_user_id\":\"Ubbb...\"}]
}"
```
**ควรเห็น:** `"dry_run":false` · `accepted:2`
**ทดสอบด่าน allowlist ด้วย:** ใส่ userId ที่ไม่อยู่ในลิสต์ → `400 test_recipient_not_allowed` · ใส่ 6 คน → `400 test_recipient_limit`

```bash
# 5.3 ผล
curl -s -H "$H" "$B/internal/broadcasts/<job_id>"
docker logs asher-connect --since 5m 2>&1 | grep broadcast_batch_done
```

### เกณฑ์ผ่าน Phase 1 — ต้องครบทั้งสี่

| # | เกณฑ์ | ตรวจจาก |
|---|---|---|
| 1 | ข้อความถึงทีมงานทุกคนในลิสต์ **คนละหนึ่งข้อความ ไม่ซ้ำ** | ถามคนในลิสต์ทุกคน |
| 2 | `status: "sent"` · `sent_count` = จำนวนที่ส่ง · `failed_count: 0` | `GET /internal/broadcasts/:id` |
| 3 | มี `line_request_id` ใน `batches[]` | เส้นทางเดียวกัน |
| 4 | **โควตาที่ลดลง = จำนวนข้อความที่ส่ง** | เทียบ `used` จาก `/internal/line/quota` ก่อน-หลัง |

```bash
# เกณฑ์ 4 — ★ เช็กนี้สำคัญ: ส่งซ้ำซ่อนอยู่จะโผล่ที่นี่ก่อนที่ไหน
curl -s -H "$H" "$B/internal/line/quota?channel_key=$CH"
```
ลดมากกว่าจำนวนผู้รับ = **มีการส่งซ้ำ** → ปิด `LIVE` ทันที แล้วไล่ `retry_key` ใน `broadcast_batch`

---

## 6. เกณฑ์ขยายไปลูกค้าจริง

**ห้ามข้ามไปลูกค้าจริงจนกว่าจะครบ:**

1. Phase 1 เกณฑ์ 1–4 ผ่าน และ **รอ ≥1 วันทำการ** โดยไม่มีคนรายงานข้อความซ้ำ
2. **ตัดสินใจเรื่องโควตาแล้ว** — รีช 2,690 แต่ฟรี 300/เดือน · ต้องรู้ว่าจะซื้อแพ็กเกจ หรือยอมส่งได้ ≤300/เดือน (handoff ข้อค้าง 4)
3. **CRM มีหน้ายืนยันจำนวนเทียบโควตาคงเหลือก่อนกดส่ง** — ไม่งั้นคนกดจะไม่รู้ว่างานจะถูกปฏิเสธทั้งก้อน
4. ยืนยันกับฝั่ง CRM ว่า `contact_ref` = `core.contact.id` ตรงกับที่ CRM เก็บ (handoff ข้อค้าง 6)
5. ตัดสินใจเรื่อง **ฐานความยินยอม (consent)** ว่าใครส่งหาได้ — Connect ตัดแค่คน `unfollow` ที่ตัวเองรู้ ไม่ได้ตัดตาม consent
6. ทดลองกับกลุ่มจริงกลุ่มเล็กก่อน (เช่น ≤20 คน) แล้วเทียบโควตาอีกครั้ง

**ข้อจำกัดที่ต้องเขียนในหน้าจอของ CRM** (ย้ำจาก handoff): multicast ส่งไม่ถึงคนที่บล็อก **แต่ LINE ไม่บอกว่าใคร** — "ส่งแล้ว" = LINE รับคำขอ ไม่ใช่ลูกค้าอ่านแล้ว

---

## 7. ย้อนกลับ — แยกตามขั้น

| ขั้นที่พลาด | วิธีย้อน | หมายเหตุ |
|---|---|---|
| **5 ยิงจริงแล้วมีปัญหา** | ลบ `LINE_BROADCAST_LIVE=1` ออกจาก `.env` แล้ว `docker compose up -d` | **เร็วที่สุด ไม่ต้อง deploy ใหม่** · งานที่ค้างกลับไปเป็น dry run ทันที |
| ต้องหยุดงานที่กำลังส่ง | `POST /internal/broadcasts/:id/cancel` | ยกเลิกได้เฉพาะ batch ที่ยังไม่ยิง — ของที่ LINE รับไปแล้วเรียกคืนไม่ได้ |
| ต้องปิดประตู `/internal/*` ทั้งบาน | ลบ `CONNECT_SERVICE_TOKEN` ออกจาก `.env` แล้ว `docker compose up -d` | ไม่ตั้ง = ประตูปิดสนิท (ไม่ใช่เปิดให้ทุกคน) |
| **3–4 โค้ดมีปัญหา** | สคริปต์พิมพ์คำสั่งย้อนให้ตอนล้มเอง:<br>`cd /opt/asher-inbox && rm -rf app && mv app.bak-<stamp> app && cd app && docker tag app-asher-connect:rollback-<stamp> app-asher-connect && docker compose up -d` | |
| **2 SQL** | **ไม่ต้องย้อน** — additive ทั้งไฟล์ (ตารางใหม่ ฟังก์ชันใหม่ + `alter ... add constraint` ที่ของเดิมยังผ่านเท่าเดิม) | ถ้าจะถอนจริง: `drop trigger trg_broadcast_follow_track on inbox.message;` แล้ว drop ตาราง `broadcast_*` / `channel_follow` · มี `pre-deploy-<stamp>.sql` เป็นตัวสำรอง |
| อยากถอนทั้ง release | `git revert <merge commit>` → push → deploy commit ใหม่ | SQL ทิ้งไว้ได้ ไม่มีใครเรียก |

---

## ตารางเก็บผล (กรอกแล้วส่งกลับมา)

| ขั้น | สิ่งที่ต้องกรอก | ผล |
|---|---|---|
| 1.1 | `.deployed-commit` ก่อน deploy | |
| 1.3 | `pending` ใน crm_publish_outbox | |
| 2.2 | บรรทัดสุดท้ายของสคริปต์ | |
| 2.4 | จำนวน table / function · มี `authenticated = t` ไหม | |
| 2.4 | จำนวนแถว `channel_follow` จาก backfill | |
| 3 | `broadcast` ใน `/health` | |
| 4.1 | รหัสที่ได้ (ต้อง 401 หมด) | |
| 4.2 | `{limit, used, remaining}` | |
| 4.4 | `dry_run` · มีข้อความเข้าโทรศัพท์ไหม | |
| 5.2 | `dry_run:false` · `accepted` | |
| 5.3 | `status` · `sent_count` · `failed_count` · `line_request_id` | |
| 5 เกณฑ์ 4 | `used` ก่อน → หลัง (ต่างกันเท่าไร) | |
