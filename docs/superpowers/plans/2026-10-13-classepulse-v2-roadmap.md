# ClassePulse V2 — Feuille de route d'implémentation

> Index des lots. Chaque lot a son **propre plan détaillé** (`docs/superpowers/plans/AAAA-MM-JJ-classepulse-v2-lotN-<nom>.md`), rédigé au début du lot à partir du code réellement en place. Plans rédigés à ce jour : lot 0, lot 1a, lot 1b, **lot 1c** (`2026-10-15-classepulse-v2-lot1c-ecrans.md`).

**Spécifications :** `docs/superpowers/specs/2026-10-13-classepulse-v2-design.md` (fonctionnel et technique) et `docs/superpowers/specs/2026-10-13-classepulse-v2-ux-design.md` (UI/UX). **Maquettes :** `docs/design/mockups/`.

## Règles communes à tous les lots
- Un lot n'est commencé que lorsque le précédent est **fusionné sur `main`** et que ses critères de sortie sont remplis.
- Chaque lot livre un logiciel qui démarre et dont les tests passent ; pas de code « à brancher plus tard ».
- Les tâches opérationnelles T-01 à T-13 sont rattachées au lot indiqué ; leur réussite est consignée dans `docs/ops/T-xx-*.md`.
- Les décisions ouvertes D-1 et D-2 bloquent uniquement les tâches indiquées ; elles ne sont jamais tranchées par l'implémenteur.

## Lots

| Lot | Contenu (sections de la spécification) | Écrans (maquettes) | Tâches T | Critère de sortie |
|---|---|---|---|---|
| **0 — Fondations** | Monorepo, configuration et secrets en fichiers, base PostgreSQL (rôles, schémas, droits), Prisma 7.10.0, harnais Testcontainers, module `database`, règles d'architecture, squelette web avec l'identité B, intégration continue (§ 1, § 2.1, § 2.8, § 5.2, § 5.3, § 5.6, § 7.2.4 à 7.2.7, UX § 4) | — | **T-01**, **T-05** ; en parallèle **T-06**, **T-10** | API et web démarrent ; `/api/health` et `/api/health/ready` ; harnais avec rôles réels ; T-01 et T-05 consignés ; CI rapide et intégration verte (après D-1) |
| **1 — Identité** | `auth`, `users`, sessions, CSRF, limitation, Turnstile, code administrateur, récupération, `create-admin`, `audit`, `authz` (matrice), `mail` + `email_outbox` (§ 2.2 identité, § 2.4, § 2.5, § 3) | M7, M8, M14 (profil, sessions, suppression) | — | Parcours P1, P2, P10 de bout en bout ; suite sécurité « authentification » verte |
| **2 — Classes** | `classes`, `memberships` (demandes, appartenances, délégués, retrait, transfert, transfert en masse, archivage), anonymisation `priv.anonymize_user` (§ 0.2, § 0.3, § 2.2 classes, § 2.6) | M9, M11, M12, M13, écrans d'état M7/M14 | — | P8, P9 ; isolation entre classes (méta-test OpenAPI) |
| **3 — Contenu** | `tasks` (corbeille, cochage), `resources` (liens, fichiers R2, quotas, vérification), `storage`, `notifications` (création) (§ 0.4, § 0.6, § 2.2 devoirs/ressources) | M1, M2, M3, M10 | — | P3, P4, P5 ; règles d'urgence et de quotas |
| **4 — Temps réel** | `chat`, annonces, `realtime` (Socket.IO, `LISTEN`), synchronisation `change_seq`/époque, notifications (flux) (§ 2.3, § 4.1 à 4.5, § 4.8) | M4, M5 | — | P6, P7 ; 0 perte / 0 doublon en intégration |
| **5 — Traitements planifiés** | `jobs` (baux, `job_runs`, Healthchecks), `reminders`, récapitulatif, `email.send`, purges, `files.verify`/`cleanup`, `storage.reconcile` (§ 1.4, § 4.6, § 4.7) | — | — | Tests de reprise du worker ; rappels et récapitulatif |
| **6 — Recherche, stats, assistant** | `search`, `stats`, `assistant` (`LlmProvider`, quotas, mode dégradé) (§ 0.8, § 0.9) | M6, statistiques M9/M11 | — | P11 ; quotas et mode dégradé testés |
| **7 — Exploitation** | Compose de production, Caddy, `deploy.sh`, `backup.sh`, `restore.sh`, secours à deux parts, `monitor.sh`, journaux (§ 7) | — | **T-02**, **T-03**, **T-04**, **T-07**, **T-09** | Préproduction déployée ; T-02, T-04, T-07, T-09 réussies |
| **Validation** | Charge sur VPS temporaire, ZAP, trois restaurations de suite | — | **T-11**, **T-13**, **T-03** | Seuils acceptés ou révisés par le responsable |
| **Pilote** | Une classe, mesures de performance UX (UX § 5.3) | — | T-08, T-12 | Retour du pilote traité |
| **Production** | Validation manuelle (§ 5.6) | — | — | — |

## Dépendances et décisions
- **D-1** (financement de l'intégration continue) : à trancher **avant la tâche 13 du lot 0** (activation des workflows).
- **D-2** (durées B2) : à trancher **après T-06**, avant la création des buckets de production (lot 7).
- **Partie C** (authentification par certificat) : conditionnée à **T-01** (lot 0, tâche 10). Si T-01 échoue, la méthode d'authentification de `cp_owner` est soumise au responsable avant le lot 1.
- **Photo des pages d'accès** : à fournir par le responsable avant la fin du lot 1.

## Décisions du responsable sur le lot 1 (2026-10-14)
- **Découpage en trois sous-plans**, livrés dans l'ordre, chacun avec un logiciel qui démarre et des tests verts :
  - **1a — API identité** : comptes, mots de passe, sessions, CSRF, limitations, Turnstile, audit, `authz`, `create-admin` ;
  - **1b — Emails et administrateurs** : `email_outbox`, worker d'envoi, code administrateur, récupération, vérification supplémentaire, changement d'email d'un administrateur, mot de passe oublié ;
  - **1c — Écrans** : M7, M8, M14 (profil et sessions) et parcours P1, P2, P10 de bout en bout.
- **Classes minimales au lot 1** : table `classes`, liste des classes actives, création d'une classe en ligne de commande, demande d'adhésion créée à l'inscription et écran « demande en attente ». Les décisions d'admission (P8) restent au lot 2.
- **Suppression de compte (anonymisation) au lot 2**, avec `priv.anonymize_user` et son écran, quand les appartenances existent. Le profil du lot 1 n'a pas de bouton de suppression.
- **Worker d'envoi des emails au lot 1 (1b)** : processus worker et traitement `email.send` (bail, réservation, nouvelles tentatives, résultat ambigu, § 2.4). `job_runs`, Healthchecks.io et les autres traitements restent au lot 5.

## Avancement
- **2026-10-15 — lot 1 terminé** (1a API identité, 1b emails et administrateurs, 1c écrans) : l'application web de bout en bout est livrée sur `https://localhost:5173` — inscription P1, connexion P2 (code administrateur M8), demande en attente M7, mot de passe oublié et réinitialisation, profil M14/P10, sessions actives, états communs (chargement, vide, erreur, maintenance, hors ligne) et accessibilité (axe-core sur chaque écran, les deux thèmes). Tests web verts, typecheck, lint, build, `depcruise` et audit sans erreur ; aucune modification d'API dans ce lot. Le lot 2 (décisions d'admission P8, anonymisation) ouvre la suite.
