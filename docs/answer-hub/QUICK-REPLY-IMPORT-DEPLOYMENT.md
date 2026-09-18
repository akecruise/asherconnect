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
