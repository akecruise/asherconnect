# Answer Hub Hardening TODO

## Phase 13
- Persist favorites and reports server-side after Phase 17 feedback model is available.
- Add richer preview for attachments and resolved dynamic answers.

## Phase 14
- Tune scoring weights using production-safe aggregate usage after Phase 16.
- Add intent/category weighting and query-performance benchmarks.

## Phase 15
- Resolve dynamic Hub bindings for bot only after an explicit data-completeness gate.
- Add end-to-end worker fixture that asserts Hub answer selection before Claude fallback.
## MVP additions deferred

- Phase 16 duplicate usage de-duplication and production analytics dashboards.
- Phase 17 admin moderation views and feedback aggregation.
- Phase 18–30 remaining MVP work and final regression evidence.
- Phase 18 reviewer isolation matrix and Phase 19 automated secret scanner remain hardening items.
- Phase 20 dashboard presentation and full 14-counter admin screen remain deferred; the secure health RPC is the MVP surface.
- Phase 21 log event taxonomy completeness and Phase 24 full 14-counter dashboard are deferred.
- Phase 26 production smoke/deploy, Phase 27 live rollback proof, and Phase 30 full regression remain pending for final acceptance.

## Phase 30 post-MVP items

- Production controlled deployment and migration ledger verification for the new Answer Hub migrations.
- Manual authenticated browser checklist and live RPC smoke tests.
- Live rollback rehearsal.
- Full dashboard aggregation (14 counters), usage de-duplication, ranking tuning, and event taxonomy expansion.
- Production health is currently PASS for the historical Phase 8 artifact only; new Answer Hub migrations were not deployed.
