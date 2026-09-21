# HANDOFF — เปิดท่อ ASHER Connect → ASHER CRM จนได้ Lead จริง (2026-09-21)

> **สถานะ: ใช้งานจริงแล้วบน production · Lead 66 ใบ · pending 0 · dead_letter 0 · health เขียวทั้งสองฝั่ง**
> **ไม่มีข้อมูล production ถูกลบหรือทับ** — `inbox.message` = 478 แถวเท่าเดิมตลอดงาน
> เอกสารนี้แทนที่หัวข้อ "CONNECT PATCH REQUIRED" ใน `asher-crm/docs/handoff/SALES-OS-PRODUCTION-HANDOFF.md` (งานนั้นทำเสร็จแล้ว)
> agent ถัดไปเริ่มที่หัวข้อ **"ทางเดินต่อ"** ท้ายไฟล์ได้ทันที

---

## ปัญหาเดิมคืออะไร

`https://crm.apluscondo.com/health` ตอบ `crm_integration_enabled=false` มาตลอด
สาเหตุ **ไม่ใช่เรื่องเดียว** แต่มี 4 เรื่องซ้อนกัน แก้ตัวใดตัวหนึ่งก็ยังไม่ติด

| # | อาการ | หลักฐาน |
|---|---|---|
| 1 | แฟล็กปิดอยู่ | `ASHER_CRM_ENABLE_INTEGRATION=false` ใน container |
| 2 | ไม่มี token | `ASHER_CRM_CONNECT_TOKEN` ไม่ถูกตั้ง → `serviceTokens={}` → `/internal/events` ตอบ 401 ทุกครั้ง |
| 3 | ไม่มี binding | `ASHER_CRM_PRODUCER_BINDINGS` ไม่ถูกตั้ง → `producerBindings={}` → fail closed 403 (GAP-I-01) |
| 4 | **ฝั่ง Connect ไม่มีท่อเลย** | ไม่มีโค้ด publisher · ไม่มีตาราง outbox · ไม่มี function · ไม่มี env `ASHER_CRM_*` สักตัว |

ข้อ 4 คือตัวใหญ่ — โค้ดมีอยู่ใน working tree แต่ **ยังไม่เคย commit และไม่เคย deploy**

### เรื่องที่ซ่อนอยู่ลึกกว่านั้น

ต่อให้เปิดท่อได้ **Lead ก็ยังไม่เกิด** เพราะ:

* `message.received` / `message.sent` เดินเข้า `processMessageEvent()` ซึ่ง **ไม่เคยสร้าง Lead เลย** — สร้างแค่ contact / conversation / message
* Lead เกิดจาก `conversation.created` เท่านั้น และต้องพก `project_ref` ที่ resolve ได้ (`events/service.ts:182-212`)
* Connect **ไม่เคยส่ง `conversation.created`**
* ฝั่ง CRM ก็ยังไม่มี pipeline (0) · stage (0) · project (0) · project_ref (0) — ขาดอย่างใดอย่างหนึ่ง Lead ก็ไม่เกิด

**สรุป: `projects_total=0` ไม่ใช่ "ปัญหาแยก" อย่างที่เคยเข้าใจ มันคือตัวบล็อก Lead โดยตรง**

---

## ที่มาของข้อมูลโครงการ (ไม่มีตัวไหนแต่งขึ้น)

| ของ | มาจาก | ยืนยันด้วย |
|---|---|---|
| โครงการ 2 แห่ง | `core.project` ฝั่ง Connect ซึ่ง `extra.source = 'public.erp_project'` | lead จริง 66 ใบใน `crm.lead` ชี้มาที่ `asher-naii` ทั้งหมด |
| pipeline + stage 7 ขั้น | `crm.pipeline` / `crm.stage` ฝั่ง Connect | mirror มาทั้ง `code` และ `sort_order` · `is_won→won` · `is_lost→lost` |
| ช่องทาง → โครงการ | หลักฐานการใช้งานจริง (messenger 51 + line 15 ใบ → `asher-naii`) | ตั้งเป็น config ไม่ฝัง id ลงโค้ด |

**`total_units = 0` แปลว่า "ยังไม่ได้นำเข้าคลังห้อง" ไม่ใช่จำนวนห้องที่แต่งขึ้น** — ห้ามเติมเลขมั่วเพื่อให้ตัวเลข health สวย

---

## สิ่งที่ทำไปแล้ว

### คอมมิต

| repo | commit | เนื้อหา |
|---|---|---|
| asher-connect | `8295043` | publisher outbox + worker (`inbox.crm_publish_outbox`, claim/finish/stats, ทริกเกอร์บน `inbox.message`) |
| asher-connect | `97c16f0` | `conversation.created` + `ASHER_CRM_PROJECT_MAP` (ช่องทาง → โครงการ) |
| asher-crm | `bf1744f` | seed master data + เทสต์ (`sql/production/001_connect_master_data.sql`) |

> ⚠️ asher-crm มีไฟล์ค้าง uncommitted อยู่ **58 รายการก่อนเริ่มงานนี้** — ไม่ได้แตะ stage เฉพาะ 2 ไฟล์ของงานนี้

### migration ที่ลงไปแล้ว

| ไฟล์ | ฐาน | ลักษณะ |
|---|---|---|
| `sql/202609211300_crm_publisher.sql` | `postgres` (ฐานจริงของ Connect) | additive — สร้างตาราง 1 + index 2 + function 4 + trigger 1 |
| `sql/202609212000_crm_conversation_created.sql` | `postgres` | แก้ check constraint ให้รับ `conversation.created` + `create or replace` ทริกเกอร์ |
| `asher-crm/sql/production/001_connect_master_data.sql` | `answer_hub_clone_20260918` | additive — pipeline 1 · stage 7 · project 2 · project_ref 2 · ทุกคำสั่ง `ON CONFLICT DO NOTHING` |

**ไม่มี DROP TABLE · ไม่มี TRUNCATE · ไม่มีการลบแถวใด ๆ**

### config บน production (ค่าอยู่ในไฟล์ ไม่อยู่ใน git)

`/opt/asher-inbox/app/.env` — เพิ่ม 7 ตัว:
`ASHER_CRM_PUBLISH_ENABLED` · `ASHER_CRM_URL` · `ASHER_CRM_CONNECT_TOKEN` · `ASHER_CRM_PRODUCER` · `ASHER_CRM_WORKSPACE_ID` · `ASHER_CRM_PUBLISH_INTERVAL_MS` · `ASHER_CRM_PROJECT_MAP`

`/opt/asher-crm/shared/.env.production` — เพิ่ม/แก้ 4 ตัว:
`ASHER_CRM_ENABLE_INTEGRATION=true` · `ASHER_CRM_ENABLE_CRM_WRITE=true` · `ASHER_CRM_CONNECT_TOKEN` · `ASHER_CRM_PRODUCER_BINDINGS`

* workspace: `ced53311-8c1e-47ef-9913-1430007614c5` ("ASHER CRM Launch")
* producer: `connect-sandbox` (ชื่อนี้ hardcode อยู่ใน `config.ts` ฝั่ง CRM — ห้ามเปลี่ยนข้างเดียว)
* token สุ่มใหม่ด้วย `openssl rand -hex 32` เก็บเฉพาะในไฟล์ `.env` ทั้งสองฝั่ง **ไม่เคยเข้า git ไม่เคยขึ้น log** (ตรวจแล้ว 0 ครั้งใน log 60 นาที)
* `ASHER_CRM_PROJECT_MAP` ชี้ทั้ง Messenger และ LINE OA ไปที่ `asher-naii`
  ช่อง `1947d7a7…` (LINE Dev, `enabled=false`) **ไม่แมป** โดยตั้งใจ

### ของเดิมที่ยังอยู่ครบ

`CONNECT_SHADOW_MODE=false` (ไม่แตะ) · META/LINE keys 4 ตัวครบ · `channels.json` ไม่ถูกแก้ · restarts=0 ทั้งสอง container

---

## ท่อทำงานยังไง

```
ลูกค้าทัก Messenger/LINE
  └─ inbox.message (INSERT)
       └─ trigger trg_crm_publish_message          ← กลืน error ของตัวเอง
            ├─ conversation.created  (ครั้งเดียว/บทสนทนา)
            └─ message.received | message.sent
                 └─ inbox.crm_publish_outbox (pending)
                      └─ crmPublisherWorker  ทุก 3 วิ · ครั้งละ 20 ใบ · lease 60 วิ
                           └─ POST http://asher-crm:3300/internal/events   ← วงในเท่านั้น
                                └─ CRM: dedupe → contact → conversation → Lead
```

**จุดสำคัญ 3 อย่าง**

1. **ทริกเกอร์มี `exception when others then return NEW`** → CRM ล่มก็ไม่ทำให้ข้อความลูกค้าหาย inbound ไม่เคยถูกบล็อก
2. **`event_id` ของ `conversation.created` คำนวณจาก conversation id** (`md5('conversation.created:'||id)::uuid`) → `ON CONFLICT DO NOTHING` ทำให้ยิงซ้ำกี่รอบก็ได้ใบเดียว ไม่ต้องมีตารางจำสถานะ
3. **`project_ref` เติมโดย publisher ตอนส่ง** ไม่ได้อยู่ในทริกเกอร์ → เปลี่ยนการแมปโครงการได้โดย**ไม่ต้อง deploy** แก้ `.env` แล้ว `docker compose up -d` พอ
   ช่องที่ไม่ได้แมป → ส่งไปโดยไม่มี `project_ref` → CRM ลง `project_ref_missing` และ**ไม่เปิด Lead** (ดีกว่าผูก Lead ผิดโครงการ) + log `crm_project_map_miss`

---

## ผลการตรวจรับ

| รายการ | ผล |
|---|---|
| Lead ทั้งหมด | **66** (messenger 49 · line 17) ทุกใบ `follow_up` / `open` / `asher-naii` |
| contacts / identities / conversations / lead_projects | 66 / 66 / 66 / 66 — ตรงกัน 1:1 ทุกชั้น |
| ซ้ำ | `dup_identity=0` · `dup_open_lead=0` |
| idempotency | ส่ง `event_id` เดิมซ้ำ → ทุกตัวเลขเท่าเดิม · CRM log `dedupe:true` · `processed_at` ไม่ขยับ |
| retry | บังคับ `network_error` → กลับเป็น `pending` + backoff + บันทึก error → **กู้คืนเองสำเร็จ** (attempts=3) |
| outbox | delivered 68 · pending 0 · processing 0 · dead_letter 0 |
| CRM receipts | `conversation.created` 66 processed · `message.received` 2 processed · failed 0 |
| health | connect `/healthz` 200 · `/health` 200 · crm `/health` 200 · restarts 0 |
| secret ใน log | 0 ครั้ง ทั้งสอง container |
| API จริง | `/api/crm/leads` 200 (66) · `/api/crm/projects` 200 (2) · `/api/work-queue/summary` → `{"UNASSIGNED":66}` |

### backfill บทสนทนาเก่า

69 บทสนทนา − 2 แชททดสอบ (`is_test=true`) − 1 ช่อง Dev (ไม่แมป) = **64 ใบ** เข้าคิว ส่งครบ ไม่มีตกหล่น
รวมกับที่ทดสอบไว้ก่อน 2 ใบ = 66

### เทสต์

| ชุด | ผล |
|---|---|
| Connect — `npm run check` | ผ่าน |
| Connect — 14 ไฟล์ (รวม `crm-publisher` 8 ข้อ) | **175 pass / 0 fail** |
| CRM — 16 ไฟล์ บน throwaway db | **99 pass / 0 fail** (79–154 วิ) |

> **ENVIRONMENT_BLOCKED (ไม่ใช่ regression):** `decide` (38) · `outcomes` (13) · `report`
> ล้มเพราะ WSL ไม่มี docker ตายตั้งแต่ขั้น setup ก่อนถึง assertion ใด ๆ
>
> ☠️ **อันตราย:** เทสต์ชุดนี้ยิง `docker exec supabase-db` ตรงเข้าฐาน **production** และมีคำสั่ง
> `DELETE FROM inbox.message` / `core.contact` / `crm.lead`
> **ห้ามรันบนเครื่องที่ต่อ docker ถึง production ได้** — ที่ไม่พังเพราะ WSL ไม่มี docker เท่านั้น

### ความปลอดภัยของเทสต์ CRM

`resetSchema()` สั่ง `DROP SCHEMA asher_crm CASCADE` จึงรันบน `asher_crm_selftest` เท่านั้น
มีด่านกั้นในสคริปต์: ถ้า DSN ยังมีคำว่า `answer_hub_clone_20260918` จะ **abort ทันที**
และตรวจชื่อฐานให้ตรงเป๊ะก่อน `DROP DATABASE` ทุกครั้ง — ฐาน production ไม่เคยถูกแตะ

---

## rollback

`/opt/rollback/<timestamp>/` มี 3 ชุด (ล่าสุด `20260921-165352`)

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `connect.env.bak` · `crm.env.production.bak` · `crm.env.beforeWriteEnable.bak` | คืน config (สิทธิ์ 0600) |
| `connect-app-before/` | โฟลเดอร์แอป Connect ก่อน deploy |
| `rollback-crm-publisher.sql` | ลบ outbox + function + trigger ที่งานนี้สร้าง |
| `rollback-trigger-to-previous.sql` | คืนทริกเกอร์เวอร์ชันก่อน `conversation.created` |
| `rollback-master-data.sql` | ลบ pipeline/stage/project ที่ seed — **ลบเฉพาะแถวที่ยังไม่มี Lead อ้างถึง** |

image: `app-asher-connect:rollback-*` · `app-asher-crm:rollback-*`

**ปิดท่อเร็วสุดโดยไม่ต้อง rollback อะไรเลย:** ตั้ง `ASHER_CRM_PUBLISH_ENABLED=false` แล้ว `docker compose up -d`
แถวที่ค้างในคิวจะถูกเก็บไว้ ไม่หาย เปิดกลับเมื่อไหร่ก็ส่งต่อ

> `rollback-crm-publisher.sql` **ยังไม่เคยถูกรันจริง** ตรวจแล้วว่าวัตถุที่จะ DROP มีอยู่ครบ (table + 4 function + trigger)
> แต่ไม่รันทดสอบ เพราะ `drop trigger` จับ ACCESS EXCLUSIVE lock บน `inbox.message` ซึ่งเป็นตารางที่มีทราฟฟิกจริง

---

## บัญชีเข้าใช้งาน

`https://crm.apluscondo.com/login` — **ล็อกอินด้วย username ไม่ใช่อีเมล** (`AuthService.login` ค้นที่ `u.username` เท่านั้น)

| username | role | หมายเหตุ |
|---|---|---|
| `admin` / `manager` / `sales` | ตามชื่อ | รหัสอยู่ที่ `/opt/asher-crm/shared/bootstrap-credentials.txt` (0600) |
| `ake@asher.local` | admin | สร้างในงานนี้ · ตั้ง `email` ไว้แล้วเพื่อรองรับ SSO ในอนาคต |

* **admin ข้ามการกรองโครงการทั้งหมด** (`leads/read.ts:47`) เห็น Lead ครบ 66
* **manager / sales เห็น 0 ใบ** เพราะ `crm_member_projects` ว่าง (ดูหัวข้อถัดไป)
* UI ส่ง `content-type: application/json` มากับ GET ด้วย — ถ้าทดสอบด้วย curl **ต้องใส่ header นี้** ไม่งั้นได้ 415

---

## ข้อจำกัดที่ยังอยู่

| # | เรื่อง | ผลกระทบ |
|---|---|---|
| 1 | `crm_member_projects` ว่าง | manager/sales เห็น 0 ใบ · และ `sales` เห็นเฉพาะงานที่ถูกจ่ายให้ตัวเองแล้ว (`read.ts:42` บังคับ `ownerId=ตัวเอง`) |
| 2 | ยังไม่มี SSO | CRM กับ Connect คนละที่เก็บรหัส · Connect ใช้ GoTrue (`supabase-auth`) ส่วน CRM ใช้ scrypt ของตัวเอง |
| 3 | `units_total=0` | ยังไม่นำเข้าคลังห้อง — แท็บ Inventory ว่าง |
| 4 | `asher-vibe` ไม่มีช่องทางแมป | โครงการพร้อมใช้ใน CRM แล้ว แต่ไม่มีหลักฐานว่าเพจ/LINE ไหนเป็นของ Vibe |
| 5 | lead list จำกัด 100 แถว | ตอนนี้ 66 ยังพอ เกิน 100 เมื่อไหร่ต้องใช้ filter/pagination |
| 6 | แชททดสอบ 2 + ช่อง Dev 1 ไม่มี Lead | ตั้งใจข้าม |
| 7 | **`channels.json` เก็บ token Meta/LINE เป็น plaintext** | ไฟล์นี้ถูกเปิดอ่านระหว่างงานและค่าหลุดไปอยู่ใน transcript — **ควร rotate** |

---

## ทางเดินต่อ

เรียงตามความเร่งด่วน

1. **rotate token ของ Meta และ LINE** (ข้อจำกัด #7) — เรื่องความปลอดภัย ควรทำก่อนเพื่อน
   แก้ที่ `channels.json` บน VPS แล้ว `docker compose up -d` (ไฟล์นี้ไม่อยู่ใน git อยู่แล้ว)
2. **เปลี่ยนรหัส `ake@asher.local`** — รหัสที่ตั้งไว้ตอนสร้างเดาง่ายและหลุดใน transcript
3. **ให้ manager/sales เห็นงาน** (ข้อจำกัด #1)
   ```sql
   INSERT INTO asher_crm.crm_member_projects (workspace_id, membership_id, project_ref_id)
   SELECT m.workspace_id, m.id, p.id
   FROM asher_crm.crm_memberships m
   CROSS JOIN asher_crm.crm_project_refs p
   WHERE m.workspace_id = p.workspace_id AND m.role IN ('manager','sales') AND m.active
   ON CONFLICT DO NOTHING;
   ```
   ⚠️ `sales` จะยังเห็น 0 อยู่ดีจนกว่า manager จะจ่ายงานให้ — เป็นดีไซน์ ไม่ใช่บั๊ก
4. **SSO บัญชีเดียวทุกโมดูล** (ข้อจำกัด #2) — **แก้ไฟล์เดียว ไม่ต้องแตะ Connect**
   แก้ `asher-crm/src/modules/auth/service.ts`: ลองรหัสท้องถิ่นก่อน → ถ้าไม่ผ่านให้ถาม GoTrue
   (`POST /auth/v1/token?grant_type=password`) → สำเร็จแล้วหา `crm_users` ที่ email ตรงกัน → ออก session ของ CRM เหมือนเดิม
   * ยืนยันแล้วว่า CRM ต่อถึง `http://supabase-envoy:8000` ได้ (ตอบ 401 กับ key ปลอม = ถึงจริง)
   * **ต้องคงรหัสท้องถิ่นไว้เป็นทางสำรอง** ไม่งั้น GoTrue ล่ม = เข้าระบบไม่ได้ทั้งบริษัท
   * ทำเป็น optional (`ASHER_CRM_AUTH_GOTRUE_URL` ว่าง = พฤติกรรมเดิมเป๊ะ) จะปิดกลับได้โดยไม่ต้อง deploy
   * สิทธิ์ยังเป็นของ CRM: GoTrue ตอบแค่ "คุณคือใคร" ส่วน "ทำอะไรได้" มาจาก `crm_memberships` · ไม่มีแถวใน `crm_users` = เข้าไม่ได้ (fail closed)
5. **นำเข้าคลังห้อง** (ข้อจำกัด #3) — ลง `crm_units` + `crm_buildings` + `crm_floors` แล้วค่อยอัป `crm_projects.total_units` ให้ตรงของจริง
6. **แก้เทสต์ที่ยิงฐาน production** (อันตรายข้อ ☠️) — ให้ `decide`/`outcomes`/`report` อ่าน DSN จาก env แล้วชี้ throwaway db เหมือนฝั่ง CRM

---

## คำสั่งที่ใช้บ่อย

```bash
# สุขภาพท่อ
curl -s https://crm.apluscondo.com/health

# คิวฝั่ง Connect
ssh root@187.53.139.175 \
  "docker exec supabase-db psql -U postgres -d postgres -tAc 'select inbox.crm_publish_stats()'"

# Lead ที่เกิดแล้ว
ssh root@187.53.139.175 \
  "docker exec supabase-db psql -U postgres -d answer_hub_clone_20260918 \
   -c \"select l.source, s.code, count(*) from asher_crm.crm_leads l \
        join asher_crm.crm_stages s on s.id=l.stage_id group by 1,2\""

# ปิดท่อฉุกเฉิน (คิวไม่หาย)
ssh root@187.53.139.175 \
  "sed -i 's/^ASHER_CRM_PUBLISH_ENABLED=.*/ASHER_CRM_PUBLISH_ENABLED=false/' /opt/asher-inbox/app/.env \
   && cd /opt/asher-inbox/app && docker compose up -d"
```
