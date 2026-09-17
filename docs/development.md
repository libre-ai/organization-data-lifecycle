<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: EUPL-1.2 -->
# Local development

`packages/data` (`@libre-ai/data`, 0.1.0) and `packages/rgpd-kit` (`@libre-ai/rgpd-kit`, 0.1.0). Each package retains its own exports and dependencies.

The recovery origin and exact incoming file hashes are recorded in `code-recovery-provenance.json`. Original documentation is retained separately from the public project introduction. No historical deployment workflow is activated.

Use the [shared local composition guide](https://github.com/libre-ai/project-governance/blob/main/docs/LOCAL-COMPOSITION.md) with target `organization-data-lifecycle` and the full commit ID to verify. It prepares all pinned sibling sources before ordered installation and builds UI before consumers. Run this component’s commands from its root inside that composition. Packages retain independent names, imports and versions; no registry release is implied.

Use the exact Bun toolchain declared in package manifests. Rust crates additionally declare Rust 1.97.0. Review dependency manifests and scripts before installation. `bun run check` runs the available source checks; `cargo test --locked --all-features` runs each Rust crate's tests. Multi-package roots dispatch checks and tests to their packages. SQL integration tests use the testing package's PGlite fixture, not a production database. WebSocket tests require local socket permission.

A successful source check does not imply a deployed service or completed platform qualification. The sandbox's positive Linux confinement and measured Linux coverage remain separate from macOS refusal tests. The evaluator's `check:coverage` enforces the retained Rust line/function thresholds using cargo-llvm-cov 0.9.1. Tool versions and measurement results must accompany any qualification claim.

The data package continues to consume the byte-identical `retention.v1.json`; the presence of v2/v3 does not change its selected policy. Contracts stay a peer dependency of data; the local development dependency is provided once by the workspace root to avoid duplicate Bun lock paths.
