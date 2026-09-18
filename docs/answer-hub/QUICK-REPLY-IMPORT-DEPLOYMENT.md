# Quick Reply Import production deployment evidence

Date: 2026-09-18 UTC

- Release commit: `b53033701b170b4cc131588f62c16b60ca7287e0`
- Previous application commit: `6895b20bd327854a3a4934ec491c2fb78ac1af04`
- Archive SHA-256: `b822587a7eaac21b0dff19d1e2b030f86a3cde3d92df9401b4ec229e7b0f3dcc`
- Backup: `/opt/asher-inbox/backup-pre-quick-reply-import-20260918T132505Z.dump`
- Backup size: 2,054,955 bytes; SHA-256 `c94200650cdc4733622714975929619bf5a2ae5f29e75e2516b214fb6bec1d76`
- Backup verification: PostgreSQL custom archive; `pg_restore --list` succeeded with 2,190 TOC entries.
- Database migrations: none.
- Container: healthy after `docker compose build asher-connect && docker compose up -d asher-connect`.
- `/healthz`: HTTP 200.
- `/health`: HTTP 200; database, workers, queue, LINE and Messenger healthy.
- `/quick-replies`: HTTP 200; `/quick-replies-admin.js`: HTTP 200 and contains the import action.

Authenticated admin preview/apply was not run from this environment because no usable admin browser session is available. The API continues to require the existing admin session and rejects unauthenticated requests; no production Quick Reply rows were changed by this deployment.

## Follow-up verification (2026-09-18)

- Release remains `b53033701b170b4cc131588f62c16b60ca7287e0`; no redeploy occurred.
- `/healthz`: HTTP 200; `/health`: HTTP 200; container healthy; database, workers, queue, LINE, and Messenger healthy.
- The authenticated browser/computer-use capability is unavailable in this environment, so the required Admin preview/apply could not be performed without bypassing authentication.
- Production data result: no Quick Reply rows changed. Asher Naii preview/apply remains pending an authenticated Admin session.

## Manual Admin runbook

1. Sign in at `https://inbox.apluscondo.com/` with the normal Admin account. The application stores the session in its existing HttpOnly cookie; do not copy or disclose it.
2. Open `/quick-replies`, choose **Import file**, select `imports/asher-facebook-quick-replies-filled-naii.xlsx`, and click **ตรวจสอบข้อมูล**.
3. Before applying, require: `total=32`, `valid=32`, `invalid=0`, and `create + update + skip = 32`. Review every UPDATE row for shortcut, category, Thai text, multiline content, URLs, and active state. Confirm `NAII_PRICE`, `NAII_PSM`, and `NAII_ROOM_PRICE` are inactive.
4. If any count or UPDATE is unexpected, close the dialog and do not apply.
5. If the gate passes, click **นำเข้า 32 รายการ**, wait for the result, and refresh the list. Confirm all 32 shortcuts, Thai/multiline/URL content, and inactive price rows.
6. Confirm `/healthz` and `/health` remain HTTP 200 after the import. No schema or deployment change is required.
