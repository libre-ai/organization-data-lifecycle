# @libre-ai/data

Tenant-isolated data platform (WP-G2-D01). Enforces the DATA-LIFECYCLE lock: a
transaction-local tenant context, deny-by-default row ownership, validated
retention bounds, backup ceiling and restore replay.

**Status: application layer AND database barrier complete, awaiting the
independent RLS/deletion reviews.** The package now carries both required
layers. The **mandatory enforcement** is the PostgreSQL barrier under
`migrations/`: tenant-format CHECKs, tenant-inclusive primary keys,
`ENABLE + FORCE ROW LEVEL SECURITY`, isolation policies bound to the
transaction-local `app.tenant_id`, and least-privilege grants to the NOLOGIN
`libre_ai_app` role (deletion receipts are append-only: no UPDATE/DELETE
grant). The application layer remains defense in depth above it — a caller
that bypasses the helpers is still denied by the database, which the raw-SQL
barrier tests prove without any helper (`src/adapters/
rls-barrier.integration.test.ts`).

Hardened after that review: subject digests must be opaque SHA-256 (a cleartext
value is refused, closing a content-leak vector); an unknown deletion-receipt
status fails the restore closed; the tenant-id provenance requirement (K2) is
documented. The security logic of all three acceptance criteria is implemented
and tested (37 tests, strict TDD):

- `tenant-context` — transaction-local tenant scope; missing context denies;
  clears on return and on throw.
- `tenant-row-guard` — a row is reachable only under its owning tenant; the
  `public` service tenant is rejected on private rows.
- `retention-bounds` — tenant-configured retention validated against the
  accepted minimum/maximum.
- `expired-selection` — the retention job's core: opaque IDs whose age reached
  the window; a shorter retention schedules already-expired records immediately.
- `backup-ceiling` — a deletion receipt's backup expiry never exceeds 35 days.
- `restore-replay` — a completed deletion does not resurrect on restore.

## Integration layer (src/adapters + migrations)

The `packages/testing` mechanism was arbitrated to **PGlite** (owner run
prompt, 2026-07-20; D5 preflight green under the exact CI bun canary). On top
of that harness this package now provides, all under strict TDD with real
PostgreSQL semantics:

- `migrations/` — isolated owner migrations for the platform tables
  (`retention_rules`, `deletion_receipts`) and the application role;
- `adapters/tenant-transaction` — one call binds the application context
  (AsyncLocalStorage) and the database context (`SET LOCAL ROLE` +
  transaction-local `app.tenant_id`) so they cannot drift; `clearPooledSession`
  carries the pool-clearing semantics (`DISCARD ALL` before reuse);
- `adapters/retention-rules-store` — contract-validated tenant retention
  configuration (application validation runs before any SQL);
- `adapters/deletion-receipt-store` — append-only receipt evidence plus the
  restore-replay feed;
- `adapters/expired-selection-query` — the SQL twin of `expired-selection`,
  controlled clock, strict table-identifier validation;
- `adapters/projection-cache-port` / `blob-store-port` — Redis/Cellar-class
  ports (TTL mandatory, never authority; enqueue-only content-addressed blob
  deletion) with in-memory doubles; real clients arrive with G4 provisioning;
- `adapters/active-deletion` — explicit deletion end to end: bounded-retry
  cache purge (a cache failure can never restore access), then one tenant
  transaction deleting the rows, enqueueing blob deletion and persisting the
  contract-valid receipt.

Known limits, deliberate: PGlite is single-connection, so pool clearing is
exercised as semantics, and real-pool behavior lands with G4 infrastructure;
the retention job worker (a `@libre-ai/retention` package) is deferred — the
name sits outside the signed Lexicon map and the three locked acceptance
criteria do not require it.

**Acceptance path remaining: run `rls-adversarial-review` and
`migration-and-deletion-review` as independent passes** (loop-security kernel
K4: the implementer does not approve its own guardrails), then the layer's
bootstrap hard stop (ADR-0011 D4) for the owner pronouncement.

## État du projet

<!-- libre-ai:project-status:begin -->
<!-- Section générée depuis project.v1.yaml — ne pas éditer à la main. -->

- Situation actuelle : Née verte en γ 3.4 ; premier consommateur git-dep (sessions) prouvé en γ 3.5 après le fix de résolution module (338b55e7).
- Maturité : usable
- Exposition : spec-published
- Confiance : medium
- Preuves vérifiées le : 2026-07-30
- Avancement : 50 % du périmètre actuellement déclaré

<!-- libre-ai:project-status:end -->

La fiche [`project.v1.yaml`](./project.v1.yaml) est l'autorité de l'état du projet ; cette section en est générée et le gate de flotte échoue si elles divergent.
