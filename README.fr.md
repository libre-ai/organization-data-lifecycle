<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Written for the retained Libre AI portfolio on 2026-09-14; earlier source documents and revisions retain their original licensing. -->

# Libre AI Organization Data Lifecycle

## Usage visé

Aider les produits à appliquer des règles explicites de conservation, de suppression et de restauration de leurs données. Chaque produit reste responsable du sens de ses données et de l’autorité nécessaire pour agir ; un composant partagé ne donne pas une permission de suppression.

## Candidats existants et limites

Les anciennes sources contiennent des fonctions de cycle de vie, des interfaces de stockage et des migrations de base de données. Ce sont des candidats à une revue délimitée, pas la preuve que tous les produits et stockages appliquent le comportement attendu. Ce candidat documentaire n’admet aucun service de données déployé, garantie de suppression complète ou nouvelle durée de rétention.

## Contrats proposés

Une demande de cycle de vie identifie son organisation, son périmètre autorisé et la règle applicable. Un résultat distingue une demande acceptée pour traitement d’une suppression réellement achevée. Un contrôle de restauration tient compte des preuves de suppression et contraintes de rétention pertinentes. Les schémas canoniques de rétention restent sous l’autorité de Contracts ; les descriptions ici ne les remplacent pas.

## Critères d’activation

Qualifier chaque fonction retenue avec son consommateur et ses preuves. Le pilote de base, les rôles SQL, les migrations et les callbacks de stockage nécessitent une qualification lorsque cette intégration est retenue ; ils ne sont pas des prérequis à l’admission d’une fonction pure. Tester l’absence de contexte d’organisation, les accès non autorisés, les limites de rétention, les suspensions applicables, les échecs et la restauration après suppression. Vérifier le résultat dans chaque stockage concerné : mettre en attente la suppression d’un blob ne démontre pas son effacement. Préserver la licence et l’attribution applicables à chaque fichier importé.

La qualification suit le périmètre réellement retenu. Un module candidat peut être admis séparément avec son consommateur et ses preuves ; les critères de parcours complet s’appliquent au produit ou à l’intégration correspondante. Un noyau pur ne nécessite pas une intégration de worker, de base de données ou de relais hors de son périmètre. Ni l’admission d’un module ni l’existence documentaire de ce dépôt ne nécessitent un parcours Missions complet.

[English](README.md)

## Navigation du portefeuille

Ces liens décrivent le portefeuille retenu visé. La disponibilité publique et l’accessibilité ne sont pas vérifiées pour ce candidat privé.

### Produits

- [Libre AI Work Supervision](https://github.com/libre-ai/ai-work-supervision)
- [Libre AI Model Policy](https://github.com/libre-ai/ai-model-policy)
- [Libre AI Practice Workbench](https://github.com/libre-ai/ai-practice-workbench)
- [Libre AI Learning Session Facilitation](https://github.com/libre-ai/learning-session-facilitation)
- [Libre AI Personal Knowledge Notebook](https://github.com/libre-ai/personal-knowledge-notebook)
- [Libre AI Information Feed Filter](https://github.com/libre-ai/information-feed-filter)
- [Libre AI Travel Itinerary Planner](https://github.com/libre-ai/travel-itinerary-planner)
- [Libre AI Public Vote Comparison](https://github.com/libre-ai/public-vote-comparison)

### Composants et outils

- [Libre AI Application Development Toolkit](https://github.com/libre-ai/application-development-toolkit)
- [Libre AI Schemas And Contracts](https://github.com/libre-ai/schemas-and-contracts)
- [Libre AI Collaborative Data Sync](https://github.com/libre-ai/collaborative-data-sync)
- [Libre AI Execution Continuity Evaluator](https://github.com/libre-ai/execution-continuity-evaluator)
- [Libre AI Execution Sandbox](https://github.com/libre-ai/execution-sandbox)
- [Libre AI Capability Authorization](https://github.com/libre-ai/capability-authorization)
- [Libre AI Organization Data Lifecycle](https://github.com/libre-ai/organization-data-lifecycle)
- [Libre AI Database Policy Inspector](https://github.com/libre-ai/database-policy-inspector)
- [Libre AI Artifact Verification](https://github.com/libre-ai/artifact-verification)

### Projet

- [Libre AI](https://github.com/libre-ai/.github)
- [Libre AI Project Website](https://github.com/libre-ai/project-website)
- [Libre AI Project Governance](https://github.com/libre-ai/project-governance)



---

## Source éditoriale revue

[Matière revue](https://github.com/libre-ai/organization-data-lifecycle/blob/4969303f19e1a81ae7ed5d131337e968bc9308c6/docs/portfolio-material.json)

SHA-256: `0acf6fb92819090277bbfdf5bfe6b0ba24d74be8ba997ba1b9a51b62d7c3ede9`
