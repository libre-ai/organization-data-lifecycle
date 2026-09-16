<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Written for the retained Libre AI portfolio on 2026-09-14; earlier source documents and revisions retain their original licensing. -->

# Libre AI Organization Data Lifecycle

## Intended use

Help products apply explicit rules to the retention, deletion and restoration of their data. A product remains responsible for the meaning of its data and the authority to act on it; a shared lifecycle component does not grant deletion permission.

## Existing candidates and limits

Earlier sources contain lifecycle functions, storage interfaces and database migrations. They are candidates for bounded review, not proof that every product or storage system enforces the intended behavior. This documentary candidate admits no deployed data service, complete deletion guarantee or new retention duration.

## Proposed contracts

A lifecycle request identifies its organization, authorized scope and applicable rule. A result distinguishes a request accepted for processing from deletion actually completed. A restoration check accounts for the relevant deletion evidence and retention constraints. Canonical retention schemas remain under Contracts; descriptions here do not replace them.

## Activation criteria

Qualify each selected function with its own consumer and evidence. Database drivers, SQL roles, migrations and storage callbacks require qualification when that integration is selected; they are not prerequisites for admitting a pure function. Test missing organization context, unauthorized access, retention limits, holds where applicable, failures and restoration after deletion. Verify the outcome in every affected storage system: queuing a blob deletion is not proof that the blob was erased. Preserve each imported file’s applicable license and attribution.

Qualification follows the actual selected scope. A candidate module may be admitted independently with its own consumer and evidence; complete journey criteria apply to the corresponding product or integration. A pure core does not require a worker, database or relay integration that is outside its scope. Neither module admission nor this repository’s documentary existence requires a complete Missions journey.

[Français](README.fr.md)

## Portfolio navigation

These links describe the intended retained portfolio. Public availability and reachability are not verified for this private candidate.

### Products

- [Libre AI Work Supervision](https://github.com/libre-ai/ai-work-supervision)
- [Libre AI Model Policy](https://github.com/libre-ai/ai-model-policy)
- [Libre AI Practice Workbench](https://github.com/libre-ai/ai-practice-workbench)
- [Libre AI Learning Session Facilitation](https://github.com/libre-ai/learning-session-facilitation)
- [Libre AI Personal Knowledge Notebook](https://github.com/libre-ai/personal-knowledge-notebook)
- [Libre AI Information Feed Filter](https://github.com/libre-ai/information-feed-filter)
- [Libre AI Travel Itinerary Planner](https://github.com/libre-ai/travel-itinerary-planner)
- [Libre AI Public Vote Comparison](https://github.com/libre-ai/public-vote-comparison)

### Components and tools

- [Libre AI Application Development Toolkit](https://github.com/libre-ai/application-development-toolkit)
- [Libre AI Schemas And Contracts](https://github.com/libre-ai/schemas-and-contracts)
- [Libre AI Collaborative Data Sync](https://github.com/libre-ai/collaborative-data-sync)
- [Libre AI Execution Continuity Evaluator](https://github.com/libre-ai/execution-continuity-evaluator)
- [Libre AI Execution Sandbox](https://github.com/libre-ai/execution-sandbox)
- [Libre AI Capability Authorization](https://github.com/libre-ai/capability-authorization)
- [Libre AI Organization Data Lifecycle](https://github.com/libre-ai/organization-data-lifecycle)
- [Libre AI Database Policy Inspector](https://github.com/libre-ai/database-policy-inspector)
- [Libre AI Artifact Verification](https://github.com/libre-ai/artifact-verification)

### Project

- [Libre AI](https://github.com/libre-ai/.github)
- [Libre AI Project Website](https://github.com/libre-ai/project-website)
- [Libre AI Project Governance](https://github.com/libre-ai/project-governance)



---

## Reviewed editorial source

[Reviewed material](https://github.com/libre-ai/organization-data-lifecycle/blob/4969303f19e1a81ae7ed5d131337e968bc9308c6/docs/portfolio-material.json)

SHA-256: `0acf6fb92819090277bbfdf5bfe6b0ba24d74be8ba997ba1b9a51b62d7c3ede9`
