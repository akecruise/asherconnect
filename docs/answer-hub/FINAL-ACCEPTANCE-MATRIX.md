# Answer Hub Final MVP Acceptance Matrix

| Phase | Feature / implementation | Migration | Authorization | Tests / evidence | UI / production | Result |
|---:|---|---|---|---|---|---|
| 0 | Discovery and audit | N/A | N/A | AUDIT.md | N/A | PASS |
| 1 | Foundation schema, categories, intents | foundation | RLS/revoke | foundation selftest | N/A | PASS |
| 2 | Answer core lifecycle | answer_item | SQL role gates | answer item selftest | Admin shell | PASS |
| 3 | Versions and snapshots | answer_version | manager/admin read gates | version selftest | History UI | PASS |
| 4 | Source registry and ERP resolvers | source_registry | source allow gates | source selftest | Source editor | PASS |
| 5 | Bindings and rendering | answer_binding | source/bot/human gates | binding + render tests | Preview | PASS |
| 6 | Answer service and flags | service/RPC boundary | whitelist + flags | service tests | API boundary | PASS |
| 7 | Quick Reply compatibility | existing path preserved | existing auth | HTTP regression | Legacy Quick Replies | PASS |
| 8 | Admin UI | existing schema | manager/admin | browser fixture | Admin editor | PASS |
| 9 | Add/edit/preview lifecycle | answer_edit | server/RPC validation | SQL/service/browser/HTTP | Admin editor | PASS |
| 10 | Import CSV/XLSX | answer_import | admin apply | parser/SQL/browser/HTTP | Import UI | PASS |
| 11 | Learning capture | learning | service-role capture | learning SQL/service/HTTP | Queue | PASS |
| 12 | Learning review | learning_review | manager/admin | SQL/browser/HTTP | Review UI | PASS |
| 13 | Sales Quick Answer | quick_answer | authenticated + approved audience | browser/HTTP/service | Composer picker | MVP READY |
| 14 | SQL recommendation | recommendation | role gate + audience isolation | recommendation SQL/service | Recommended results | MVP READY |
| 15 | Bot Hub-first bridge | existing worker + recommend | bot filters + fallback | bot/service regression | Worker path | MVP READY |
| 16 | Usage telemetry | usage | service-role-only write | usage SQL + full regression | Fire-and-forget | MVP READY |
| 17 | Feedback reports | feedback | authenticated write | feedback SQL + service | Report action | MVP READY |
| 18 | Cross-role permissions | existing gates/RLS | role isolation | 13 SQL selftests | Admin/sales separation | MVP READY |
| 19 | Security review | validation and DOM text rendering | no browser service key | scan + full regression | Safe fallback | MVP READY |
| 20 | Hub health summary | health | manager/admin | check + SQL coverage | Dashboard data | MVP READY |
| 21 | Structured logging | existing log/flowHealth events | server-side | full regression | Operational logs | MVP READY |
| 22 | Automated tests | npm test + SQL selftests | test fixtures | 220 Node + 82 HTTP + 13 SQL | N/A | MVP READY |
| 23 | Manual checklist | TESTING.md | role-specific checklist | checklist documented | Manual browser pending | MVP READY |
| 24 | Admin dashboard | ah_health + dashboard panel | manager/admin | check + service boundary | Dashboard panel | MVP READY |
| 25 | Documentation | canonical guides | N/A | docs reviewed | Guides present | MVP READY |
| 26 | Deployment procedure | DEPLOYMENT.md | release prerequisites | procedure documented | Not deployed this run | BLOCKED |
| 27 | Rollback procedure | ROLLBACK.md + flags | admin/ops controls | procedure documented | Live proof pending | MVP READY |
| 28 | Troubleshooting | TROUBLESHOOTING.md | N/A | guide reviewed | Operational guide | MVP READY |
| 29 | Feature flags | env/service gating | server-side flags | service tests | Legacy fallback | MVP READY |
| 30 | Final acceptance | this matrix + HANDOFF | all verified local gates | full regression PASS | Production deploy pending | MVP READY |

## Full regression evidence

- `npm run check`: PASS
- `npm test`: 220 Node tests PASS / 0 FAIL; HTTP integration 82/82 PASS / 0 FAIL
- Answer Hub SQL selftests: 13/13 PASS / 0 FAIL
- `git diff --check`: PASS
- Production: not deployed in this run
