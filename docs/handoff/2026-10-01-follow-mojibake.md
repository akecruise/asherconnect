# Handoff — แจ้งเตือน LINE "มีคนทัก" ทั้งที่ไม่มีใครทัก (1 ต.ค. 2569)

## อาการ

19:02 กลุ่มแจ้งเตือนได้:

```
🟠 มีคนทัก LINE (19:02 น.)
👤 ลูกค้า · แชทใหม่
ข้อความ: เน€เธเธดเนเธกเน€เธเธทเนเธญเธเนเธซเธกเน
บอท: ไม่ตอบ (undefined) → คนต้องตอบ
```

เปิด chat.line.biz ไม่เจอข้อความ — **เพราะไม่มีข้อความจริง** เป็น event `follow` (ลูกค้ากดเพิ่มเพื่อน OA)
ข้อความเพี้ยนคือ "เพิ่มเพื่อนใหม่" ที่ถูก decode ผิด (UTF-8 → cp874)

## สาเหตุ (2 อย่าง)

1. **SQL ภาษาไทยเพี้ยน** — `sql/202609211200_messenger_identity_p0.sql` ถูกเซฟผ่าน cp874 (PowerShell 5 / Windows Thai)
   และ commit ไปแบบเพี้ยนแล้ว (commit `eef925a`) ไฟล์นี้คือนิยามล่าสุดของ `connect_private.receive_event`
   สตริงที่ลูกค้า/ทีมเห็นและเพี้ยน 4 ตัว:
   - บรรทัด 147 `[ข้อความที่ไม่ใช่ข้อความตัวอักษร]` (สติกเกอร์/รูป ฯลฯ)
   - บรรทัด 175 `[ลูกค้าบล็อกบัญชี]` (unfollow)
   - บรรทัด 311 `[ลูกค้าเพิ่มเพื่อน]` (follow — ข้อความระบบในแชท)
   - บรรทัด 329 `เพิ่มเพื่อนใหม่` (payload แจ้งทีมตอน follow)
   คอมเมนต์อีก ~64 บรรทัดก็เพี้ยน แต่ไม่กระทบการทำงาน
2. **`bots/notify.mjs` ไม่รู้จัก `kind: 'follow'`** — เลยแสดงเป็น "มีคนทัก" + `reply_reason` ที่ไม่มีใน payload ออกมาเป็น `undefined`

## ทำแล้ว (เครื่อง Windows, ยังไม่ commit)

| ไฟล์ | สิ่งที่แก้ |
|---|---|
| `sql/202609211200_messenger_identity_p0.sql` | ถอด mojibake กลับเป็น UTF-8 ทั้งไฟล์ (69 บรรทัด) — decode ล้มเหลว 0 บรรทัด, ตรงกับ `202609191500_review_code.sql` |
| `bots/notify.mjs` | follow → `👋 มีคนเพิ่มเพื่อน` · `ยังไม่ได้ทัก ไม่ต้องตอบ` · ไม่แสดงบรรทัด `ข้อความ:` · ไม่แสดง แชทใหม่/เดิม; ไม่มี `reply_reason` → `ไม่ระบุเหตุผล` |
| `tests/notify-follow.test.mjs` (ใหม่) | follow ไม่ขึ้น "มีคนทัก"/"คนต้องตอบ"/`undefined` + กันไฟล์ `sql/*.sql` มี Thai mojibake |
| `docs/hotfix-2026-10-01-follow-mojibake.sql` (ใหม่) | hotfix ฐานโปรดักชัน แก้เฉพาะ 4 สตริงใน function ที่รันอยู่ (ASCII ล้วน) |

ผลเทสต์: `node --test tests/notify-follow.test.mjs tests/notify-test-prefix.test.mjs tests/bots.test.mjs` → 37 pass / 0 fail
`node sql/run.mjs check` → ผ่าน
Hotfix ลองกับฐาน local (`supabase-db`) แบบ rollback → `follow_text_fixed = t`

## ยังไม่ได้ทำ — ทำต่อตามลำดับ

### 1. ลง hotfix บน VPS (ด่วน — หยุดข้อความเพี้ยน)

Cloud session เข้า VPS ไม่ได้ (port 22 ถูกบล็อก) ต้องทำจาก shell ที่ ssh อยู่ (`root@srv1977564`)

```bash
docker ps --format '{{.Names}}' | grep -i db      # ยืนยันชื่อ container ฐาน
# ก๊อปเนื้อหา docs/hotfix-2026-10-01-follow-mojibake.sql ไปไว้ /tmp/hotfix.sql แล้ว
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < /tmp/hotfix.sql
```

ต้องได้ `follow_text_fixed = t` · ถ้า pattern ไหนเจอไม่ครบ 1 ครั้ง จะ error และไม่แก้อะไร
(หลังจากนี้ `run.mjs plan` จะเห็น sha ของไฟล์ 202609211200 ไม่ตรงทะเบียน — ปกติ หายเมื่อ apply ไฟล์ที่แก้แล้ว)

### 2. Commit + deploy `notify.mjs`

- ต้อง build image ใหม่ (ดู `docs/deploy.md` — deploy จาก commit เท่านั้น)
- ⚠️ branch `connect-profile-content` มีงานอื่นค้าง (ดู handoff 2026-09-30) — **อย่า deploy HEAD ทั้งก้อนโดยไม่ตรวจ**
  ทางเลือก: cherry-pick 4 ไฟล์ข้างบนเป็น commit แยกบน commit ที่ VPS รันอยู่ (`.deployed-commit`) แล้ว deploy อันนั้น
- จนกว่าจะ deploy: ข้อความจะไม่เพี้ยนแล้ว (หลัง hotfix) แต่หัวข้อยังขึ้น "🟠 มีคนทัก … ไม่ตอบ (undefined)" สำหรับ follow

### 3. ซ่อมข้อความเก่าในฐาน (ไม่บังคับ)

สคริปต์พร้อมแล้ว: `docs/cleanup-2026-10-01-follow-mojibake.sql` (ASCII ล้วน, จับเฉพาะสตริงเพี้ยนแบบตรงตัว ไม่ใช้ pattern)
แก้ `inbox.message.content` · `inbox.conversation.last_message_preview` · `inbox.bot_decisions.text`
นับอย่างเดียว ไม่แก้: `connect_private.job` (แจ้งเตือนที่ส่งไปแล้ว) · `inbox.crm_publish_outbox` (ส่งให้ CRM ไปแล้ว)
**ลง hotfix ข้อ 1 ก่อน** ไม่งั้นแถวใหม่ยังเพี้ยนต่อ

```bash
# dry run (ค่าเริ่มต้น) — แสดงจำนวนแล้ว rollback
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 < /tmp/cleanup.sql
# ตัวเลขดูสมเหตุสมผล แล้วค่อยลงจริง
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v apply=1 < /tmp/cleanup.sql
```

ลองกับ Postgres 16 ชั่วคราวแล้ว: แถวเพี้ยนตรงตัวถูกแก้, ข้อความลูกค้าจริงและแถวที่มีข้อความอื่นต่อท้ายไม่ถูกแตะ, dry run ไม่เปลี่ยนอะไร

### 4. กันไม่ให้เกิดซ้ำ

- ห้ามเขียน/แก้ไฟล์ที่มีภาษาไทยด้วย PowerShell 5 (`Set-Content`/`Out-File`/`>`) — ใช้ editor, node, หรือ python ที่ระบุ `encoding='utf-8'`
- เทสต์ใหม่จะแดงถ้ามีไฟล์ `sql/*.sql` เพี้ยนอีก — ควรให้รันใน CI/ก่อน deploy
- `reference/inbox-schema.sql` ก็มี mojibake (ไม่ได้ใช้รัน ยังไม่ได้แก้)
