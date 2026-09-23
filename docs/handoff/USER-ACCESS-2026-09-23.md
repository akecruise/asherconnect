# User & Access handoff (2026-09-23)

## Architecture and source of truth

Supabase Auth (`auth.users.id`) is the canonical human identity. Connect owns the
administration UI at `/admin/users`; CRM links to that page and does not create
another user-management UI. Connect keeps its existing server-side file session
cookie, while CRM keeps its existing `asher_crm.crm_user_sessions` cookie. Both
services check `core.user_access_state` on each authenticated request so a
disabled account, removed module, role change, or revocation is effective without
waiting for a new login. The Supabase service-role key is server-only.

| Canonical value | Existing storage | CRM interpretation |
| --- | --- | --- |
| User UUID/email | `auth.users`, mirrored in `core."user"` | `crm_memberships.auth_subject_id` is the exact UUID |
| Display name/team/status/role | `core.profile` | No second profile authority |
| Module permission | `core.user_module_access` | `crm` must be enabled |
| Role | `core.user_role` / `core.profile.role` | `sales`, `senior_sales` → Sales; `manager` → Manager; `admin` → Admin |
| Revocation/audit | `core.user_security_state`, `core.user_admin_audit` | CRM checks `revoked_after` against session creation time |

The CRM database contains four local-password accounts (`ake@asher.local`,
`admin`, `manager`, `sales`). These are separate records from the canonical
Supabase Auth users. The CRM `ake@asher.local` UUID differs from the Connect
UUID despite the matching email; the other three have no email for a safe
identity match. They must not be joined to an Auth user by username alone.
The owner has directed that Connect be authoritative and the accounts be
deduplicated, but has not supplied verified mappings for the other three.
The CRM auth change therefore must not be released as a strict cutover without
an explicit legacy transition/mapping decision. No customer or messaging
identity is touched.

## Connect API

All endpoints require an authenticated, active Connect admin. Mutation requests
require the same-origin `Origin` header. They return JSON and never return a
stored password or service-role key.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/users` | Search/filter/page; `q`, `status`, `role`, `module`, `page`, `page_size` |
| POST | `/api/admin/users` | Create Auth user and canonical access; compensates on failure |
| PATCH | `/api/admin/users/:id` | Edit name, login, role, team, modules, status |
| POST | `/api/admin/users/:id/reset-password` | Set password or generate one-time temporary password; revoke sessions |
| POST | `/api/admin/users/:id/revoke-sessions` | Force new login |
| POST | `/api/admin/users/:id/disable` | Disable and revoke |
| POST | `/api/admin/users/:id/enable` | Enable |
| GET | `/api/admin/users/:id/audit` | Latest 100 redacted audit events |

Create/edit payload: `email`, `display_name`, `role`, `team`, `modules` (`connect`,
`crm`), and `is_active`. Temporary passwords are shown only in the response to
the operation that generated them. Admins cannot disable/demote themselves or
remove the last active admin.

## คู่มือผู้ดูแล

เปิดเมนู **ผู้ใช้และสิทธิ์** ด้วยบัญชี Admin เพื่อค้นหา กรอง เพิ่ม หรือแก้ไขผู้ใช้
เลือกสิทธิ์ Connect/CRM แยกจาก Role เสมอ ปุ่มตั้งรหัสผ่านใหม่ต้องกรอกและยืนยัน
รหัสเดียวกัน หรือให้ระบบสุ่มรหัสชั่วคราวและคัดลอกเก็บในช่องทางปลอดภัยทันที
ระบบจะไม่แสดงรหัสเดิมและจะแสดงรหัสชั่วคราวเพียงครั้งเดียว เมื่อปิดบัญชีหรือ
กดบังคับเข้าสู่ระบบใหม่ เซสชันเดิมจะใช้ไม่ได้ ตรวจประวัติที่ปุ่ม Audit

หากผู้ใช้ลืมรหัสผ่าน Admin สามารถใช้ **ตั้งรหัสผ่านใหม่** แล้วแจ้งรหัสชั่วคราว
เป็นการส่วนตัว ห้ามส่งรหัสผ่านใน log, issue หรือเอกสาร หาก Admin ทุกคนเข้า
ไม่ได้ ให้ผู้ดูแลโครงสร้างพื้นฐานกู้คืนผ่าน Supabase Auth Admin API ตามขั้นตอน
break-glass ที่ได้รับอนุมัติ ไม่แก้ `auth.users` ด้วย SQL โดยตรง

## Migration, preview and rollback

`sql/202609231000_user_access_admin.sql` adds a profile display-name column,
security/audit tables, indexes, and service-role-only RPC functions. It does not
alter customer/message data or stored credentials. Apply after
`202609221000_unified_identity.sql`. Preview in a transaction ending in
`ROLLBACK`; verify duplicate normalized emails are zero and record profile,
module-access, and admin row counts before applying. Back up the Supabase Auth
database and CRM database before any production change.

App rollback: repoint each service's symlink to the previous immutable release
and restart only that service. The additive migration can remain in place during
app rollback. Do not drop the audit/security tables or restore the entire DB
without owner approval, because that could erase newer production data.

## Implementation and verification status at handoff

This is an implementation handoff, **not a production deployment**. The new
migration has **not** been committed on production. Both production health
endpoints returned HTTP 200 before deployment. The current production releases
are Connect `/opt/asher-inbox/releases/20260922T100514Z-chat-39e4232` and CRM
`/opt/asher-crm/releases/20260923T022000Z-visual-pipeline-a038a41`.

Production backups made before any change:

- Supabase/Auth DB: `/opt/asher-inbox/backups/user-access-20260923T021200Z-postgres.dump`
  (27,161,000 bytes; SHA-256 `29022dd7bde027116cc76efd945f5f0d060244d3bd4a299d685e8f2f02a44c68`)
- CRM DB: `/opt/asher-crm/backups/user-access-20260923T021200Z-crm.dump`
  (2,227,125 bytes; SHA-256 `3961e73bc7c372f9036385d1bc50077f35539a3a4b5b759290f0df39eb97e528`)

Production preview found 14 canonical profiles, 28 module-access rows, two
active admins and zero duplicate case-folded emails. The new migration ran in
one transaction ending in `ROLLBACK` without error. Local Connect `npm test`
passed, including 82/82 HTTP integration checks; the dedicated User & Access
tests passed 4/4. CRM typecheck and dedicated SSO tests passed 5/5. CRM full
suite reached 175/176; the failure was an unrelated new contact-merge test
that counted all outbox rows after an earlier test added a merge. The assertion
was scoped to its own aggregate and the contact-merge file then passed 7/7;
the full CRM suite has **not** been rerun after that fix.

No separate commits for this task exist yet. Current repository HEADs are
Connect `411d78f` and CRM `277e23d`; both working trees contain unrelated
in-progress changes, so commit/deployment packaging must stage only the files
or hunks from this task. Some CRM UI files were included in the independently
deployed visual-pipeline release during this work; the CRM auth route and
Connect admin service are not deployed.

## Local implementation audit — 2026-09-23

The implementation is present in Connect commit `9b771f4` and the CRM
integration deep-link is present in CRM commit `9bfbc5d`. The follow-up local
verification adds role normalization in the Connect navigation so the Admin
link is not lost when the bootstrap response uses a different role casing.
This pass does not deploy production or apply a migration.

Verified locally:

- Connect full suite: 82/82 passed; syntax and SQL ledger check passed.
- User & Access service tests: 8/8 passed after the local regression additions.
- CRM typecheck: passed; CRM auth/API targeted tests: 16/16 passed.
- The canonical identity remains `auth.users.id`; no CRM credential table is
  introduced and `core.user_module_access` remains the module boundary.

Known boundary: the migration file is additive and idempotent. App rollback is
safe without dropping its audit/security tables; a destructive schema rollback
must not be attempted because it could remove newer audit data. Production
deployment and production password changes are outside this local pass.

To finish: verify the owner-approved identity mapping/temporary legacy policy;
rerun CRM full suite; stage separate task-only commits; apply the new migration
after verifying the backups; deploy controlled releases based on the latest
production trees; smoke-test admin/manager/sales and module isolation; check
logs for secrets; and capture desktop/mobile screenshots and HTTP evidence.
Do not claim acceptance or remove legacy credentials until these gates pass.
