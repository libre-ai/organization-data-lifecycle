# organization-data-lifecycle Canonical Agent Rules

## Authority

Organization data lifecycle and GDPR tooling, couche 4 brick of the
constellation: `packages/data` (`@libre-ai/data`) and `packages/rgpd-kit`
(`@libre-ai/rgpd-kit`).
Doctrine lives upstream: https://raw.githubusercontent.com/libre-ai/project-governance/HEAD/AGENTS.md

## Boundaries

- Retention contracts are canonical in `libre-ai/schemas-and-contracts`,
  consumed as a peer dependency, never redefined here.
- The SQL test fixture comes from `application-development-toolkit`
  (`@libre-ai/testing`); no production database is reached from tests.
- Product code and product specifications live in their own repositories.

## Quality gates

Run `bun run check` from the local composition (`docs/development.md`) before
pushing; never hide a red test.

## Agents

- Security > quality > performance > completeness, in that order on conflict.
- Stage files before running tree-walking gates.
- Never put personal data in logs, fixtures or errors.
- Never commit a machine-local absolute filesystem path.
