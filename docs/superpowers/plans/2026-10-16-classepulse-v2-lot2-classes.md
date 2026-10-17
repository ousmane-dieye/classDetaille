# ClassePulse V2 — Lot 2 : classes, appartenances et anonymisation — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** le lot 2 ouvre la **gestion de classe** : le délégué décide des demandes d'adhésion (P8), gère membres, matières et statistiques simples (écrans M9) ; l'administrateur crée, consulte et nomme les délégués (M11, M12), conduit le changement d'année en assistant (M13) ; l'anonymisation de compte (`priv.anonymize_user`) et son écran (M14) arrivent enfin. L'isolation entre classes est prouvée par un méta-test sur la table des routes.

**Architecture :** l'API gagne les tables `class_memberships` et `subjects`, des **déclencheurs PostgreSQL** (limite de délégués, conditions d'appartenance active, « pas déjà membre », délai 24 h déjà en place) et les routes `/api/classes/:classId/…` ; la logique d'interdiction vit **en base d'abord**, l'application ne fait que traduire les erreurs. `priv.anonymize_user` (fonction `SECURITY DEFINER`, schéma `priv`) efface l'identité sans jamais supprimer de ligne. Les gardes du lot 1b (`assertStepUpFreshInTx`, `assertRecentPasswordInTx`) sont enfin consommés : archivage et transfert en masse exigent la vérification supplémentaire (mot de passe puis code, M13). Le web ajoute les écrans Gestion (délégué) et Administration (admin), reliés par des liens sur `/profil` — la barre d'onglets viendra au lot 3.

**Tech Stack :** inchangé (NestJS 11, Fastify 5, Prisma 7.10.0, PostgreSQL, Zod 4 dans `@classepulse/shared`, React 19.3, Vite 8.3, Vitest 5 + Testcontainers, axe-core 4.14.0). Migrations `-- classification: expand` uniquement.

**Spec :** `docs/superpowers/specs/2026-10-13-classepulse-v2-design.md` (§ 0.2 rôles, § 0.3 comptes et admission, § 1.2 règles 5-7, § 2.2 « Classes et appartenances », § 2.6 anonymisation, § 3.3 vérification supplémentaire, § 3.6 frontières entre classes, § 5.3 jeu de données, § 5.4 tests) et `docs/superpowers/specs/2026-10-13-classepulse-v2-ux-design.md` (§ 1.2 gestion délégué, § 1.4 actions critiques, § 2 P8, P9 ; § 3.2 états ; § 3.3 rédaction). Maquettes : `docs/design/mockups/lot3-delegue.html` (M9 « Gestion de la classe », refus, matières, membres), `docs/design/mockups/lot4-administration.html` (M11 « Vue d'ensemble », M12 fiche de classe, M13 changement d'année), `docs/design/mockups/m14-etats-profil.html` (M14, section suppression). Feuille de route : `docs/superpowers/plans/2026-10-13-classepulse-v2-roadmap.md` (ligne « 2 — Classes » et décisions du 2026-10-14).

## Global Constraints

- Toutes les dépendances en **version exacte** (`pnpm add -E`) ; `pnpm audit --audit-level high` vert ; **aucune dépendance ajoutée** dans ce lot (le besoin est en base et en écrans).
- **Seuls les `*.repository.ts` importent Prisma** ; chaque méthode publique d'un service commence par `authz.assert(actor, action)` ; UUID v7 générés par l'application.
- **Ordre des verrous global** (§ 2.1) : `role_guard` → `classes` → `users` → `class_memberships` → `enrollment_requests` → … ; `classes` et `users` jamais `FOR UPDATE` (mais `FOR NO KEY UPDATE` ou `FOR SHARE`).
- **Toute règle d'interdiction existe en base** (déclencheur ou contrainte) **et** dans l'API : l'application n'est jamais le seul rempart (§ 2.2). Les déclencheurs lèvent une erreur que le service traduit en code stable anglais.
- **Isolation (§ 1.2 règle 7, § 3.6)** : toute lecture ou écriture vise `classId` dans l'URL ; une ressource d'une autre classe renvoie `404` **identique** à une ressource inexistante, pour tous les rôles (délégué compris après un transfert).
- **Une seule appartenance active** par utilisateur (index partiel `(user_id) WHERE left_at IS NULL`) ; **une seule demande `PENDING`** par utilisateur toutes classes confondues (index déjà en place) ; **délai 24 h** après un refus pour la même classe, garanti par le déclencheur avec `now()`.
- **Décision d'admission définitive** (§ 0.3) : jamais de « rouvrir » une demande ; seule une **nouvelle demande** est possible après le délai.
- **Vérification supplémentaire (§ 3.3)** : `assertStepUpFreshInTx` exigé pour **l'archivage** et **le transfert en masse** ; `assertRecentPasswordInTx` (mot de passe < 5 min) pour les autres actions sensibles du lot (transfert simple, retrait, nomination de délégué, suppression de compte).
- **Anonymisation (§ 2.6)** : les utilisateurs ne sont **jamais** supprimés physiquement ; `priv.anonymize_user` efface l'identité, clôture l'appartenance (`ACCOUNT_DELETED`), révoque les sessions (`ANONYMIZED`), annule la file d'emails, journalise `ACCOUNT_ANONYMIZED` (source `PRIVILEGED` uniquement) et **limite les dégâts à 5 anonymisations par acteur sur 24 h**.
- **Journalisation** : chaque décision, retrait, transfert, nomination, archivage et anonymisation écrit dans `audit_log` (enum fermé + schémas Zod par action, métadonnées sans email ni contenu).
- **Emails** : au lot 2, **seul le refus** d'adhésion envoie un email (§ 0.3), par la file `email_outbox` existante avec un nouveau `EmailKind`.
- Le web **n'invente rien** : compte à rebours, délais et compte rendu viennent du serveur ; textes français au tutoiement, codes d'erreur anglais ; « jamais la couleur seule » ; axe-core sur chaque écran, zéro violation `serious` ou `critical` ; jetons `--cp-*` uniquement.
- Tests : `pnpm test:unit` et `pnpm test:int` verts à chaque tâche (Testcontainers, rôles réels, jamais de superutilisateur) ; **aucun test ignoré** dans les domaines sécurité, droits et contraintes (§ 5.4).

## Review Focus

1. **Le déni d'accès entre classes** : un délégué de la classe A qui tente `/api/classes/<B>/…` reçoit le même `404` que pour une classe inexistante ; le méta-test échoue si une route sans cas d'isolation est ajoutée. → tâches 2-8 et 15.
2. **Les déclencheurs comme vérité** : 3 nominations de délégués pour une limite de 2 (concurrence prouvée par une attente de verrou observée), « pas déjà membre », « utilisateur verrouillé », délai 24 h. → tâches 1, 4, 15.
3. **Archivage et transfert** : clôture de l'appartenance dans la transaction, `409` en écriture sur classe archivée, anciens membres sans accès (`404`), délégué transféré redevient étudiant, délégués non reconduits. → tâches 6, 7, 13.
4. **L'anonymisation** : rien ne référence plus l'identité, l'appartenance est clôturée `ACCOUNT_DELETED`, la file d'emails est annulée, l'audit est `PRIVILEGED`, et `cp_app` ne peut pas exécuter la fonction sans passer par l'API. → tâches 8, 14.
5. **La décision définitive** : aucun chemin ne rouvre une demande refusée ; l'email de refus part une seule fois ; la nouvelle demande est refusée par la base pendant 24 h. → tâche 2.

## Rulings (décisions de rédaction, à relire par le responsable)

- **R1 — Routes du lot 2.** `GET /api/classes` (admin : toutes, archivées incluses) ; `POST /api/classes` (admin, enfin dans l'application) ; `GET /api/classes/:classId` (membre, délégué, admin ; inclut les statistiques simples : membres, demandes en attente, demandes traitées) ; `POST /api/classes/:classId/archive` (admin, STEP_UP) ; `GET /api/classes/:classId/requests` ; `POST /api/classes/:classId/requests/:requestId/accept` ; `POST /api/classes/:classId/requests/:requestId/refuse` ; `GET /api/classes/:classId/members` (emails visibles) ; `DELETE /api/classes/:classId/members/:userId` (motif facultatif) ; `POST /api/classes/:classId/delegates` ; `DELETE /api/classes/:classId/delegates/:userId` ; `GET|POST /api/classes/:classId/subjects` ; `DELETE /api/classes/:classId/subjects/:subjectId` ; `POST /api/users/:userId/transfer` (transfert simple) ; `POST /api/classes/:classId/transfers` (masse, atomique, ≤ 200 userIds, STEP_UP) ; `POST /api/me/account` (suppression de son propre compte) ; `POST /api/me/enrollment` (compte existant : nouvelle demande d'adhésion, R16). *Coût si faux : des routes à déplacer.*
- **R2 — Méta-test sur le registre de routes.** Le document OpenAPI n'existe pas encore (il sera servi plus tard, jamais en production, § 3.5 arbitrage P). Le registre `collectRoutes` du lot 1a tient lieu de table des routes : le méta-test d'isolation (§ 5.4) l'extrait et **échoue si une route `/api/classes/:classId/…` ou `/api/users/:userId/…` n'a pas de cas d'isolation** dans sa table. *Coût si faux : un générateur OpenAPI prématuré.*
- **R3 — « Copier les annales » reportée au lot 3.** P9 compte 4 étapes ; la 4ᵉ (`year_transition_copies`, copie R2 des ressources) exige le module `storage` qui n'existe pas. Le lot 2 livre l'assistant en **3 étapes** (créer · transférer · archiver) ; l'étape « copier les annales » sera ajoutée au lot 3 sans changer les étapes livrées. *Coût si faux : une tâche impossible à terminer.*
- **R4 — `priv.anonymize_user` en migrations `expand`.** La fonction purge aussi rappels, notifications, conversations d'assistant et fichiers (§ 2.6) — tables des lots 3 à 6. Elle est livrée au lot 2 sur ce qui existe (identité, préférences, jetons, sessions, appartenance, file d'emails, audit) et **chaque lot l'étend** par une migration dédiée avec ses tests. *Coût si faux : l'anonymisation bloquée jusqu'au lot 6.*
- **R5 — Suspension hors lot 2.** § 0.3 décrit la suspension d'un compte, mais la roadmap n'affecte aucun écran au lot 2 ; elle part avec l'administration des comptes (lot à planifier). `users.status` et `SessionRevokeReason` l'attendent déjà. *Coût si faux : un écran de plus.*
- **R6 — Seul le refus envoie un email** au lot 2 (§ 0.3), via `email_outbox` avec le kind **`REFUSAL`** (déjà dans l'énumération § 2.4, gabarit ajouté en tâche 2) et le motif entre guillemets. Acceptation, retrait et transfert sont visibles à la connexion suivante ; leurs **notifications in-app** arrivent au lot 4 (catalogue § 4.3). *Coût si faux : des emails non demandés.*
- **R7 — Transfert.** Simple : admin seul, `assertRecentPasswordInTx`, l'ancienne appartenance est clôturée `TRANSFER`, les droits de délégué disparaissent (le délégué transféré redevient `STUDENT`). Masse : admin seul, STEP_UP, **atomique** (tout ou rien), 200 étudiants max par appel (au-delà : plusieurs appels — le seuil vient du § 4.6, la spec n'en fixe pas). Les délégués **ne sont pas reconduits** au changement d'année (§ 0.3). *Coût si faux : des transferts partiels.*
- **R8 — Nomination des délégués par l'administrateur** (M12 : « l'administrateur nomme les délégués ») ; révocation par l'administrateur (elle redonne `STUDENT`). Limite `max_delegates` (défaut **2**, colonne 1–5) **garantie par le déclencheur**, pas par l'API. Un délégué ne retire jamais un autre délégué (§ 0.3) : le bouton n'existe pas pour lui, et le serveur refuse. *Coût si faux : une course à la nomination.*
- **R9 — `GET /api/me` gagne `membership`.** Nouveau champ `membership: { classId, classLabel, role: 'STUDENT' | 'DELEGATE' } | null` (appartenance active). Une étudiante acceptée retrouve sa classe sur `/profil` (section « Ma classe ») ; l'accueil étudiant (M1) reste au lot 3. *Coût si faux : un aller-retour supplémentaire.*
- **R10 — Quotas de stockage ajoutés maintenant.** `classes.storage_quota_bytes` et `storage_reserved_bytes` (§ 2.2) sont créés dans la migration du lot 2 (expand), **utilisés au lot 3** par `storage`. *Coût si faux : une migration de plus au lot 3.*
- **R11 — Statistiques au lot 2.** « Statistiques simples » (P8) = membres actifs, demandes en attente, demandes traitées ; les taux de complétion (§ 0.8) arrivent avec les devoirs au lot 3, sans changer le contrat de `GET /api/classes/:classId`. *Coût si faux : un contrat à casser.*
- **R12 — Matières.** Table `subjects` (`UNIQUE(class_id, lower(name))`, nom 2–60 caractères via `normalizeName` de `@classepulse/shared`). Suppression refusée `409 SUBJECT_IN_USE` si la matière est référencée (à lot 2 : vérifiée sur ce qui existe ; la portée s'étendra aux devoirs au lot 3). L'unicité `(class_id, id)` (cible des clés étrangères composites, § 2.2) est ajoutée par le lot 3 avec `tasks`. *Coût si faux : des références pendants.*
- **R13 — Vérification supplémentaire côté web.** Composant `StepUpDialog` : sur `403 STEP_UP_REQUIRED` (`missing: 'PASSWORD'` puis `'CODE'`), fenêtre avec le mot de passe puis le code à 6 chiffres (`OtpInput` réutilisé), puis rejeu de l'action. Aucun écran ne duplique la logique de compte à rebours (elle vient du serveur). *Coût si faux : deux écrans de vérification.*
- **R14 — Accès aux écrans.** Pas de barre d'onglets au lot 2 (elle vient avec l'accueil étudiant, lot 3) : depuis `/profil`, un lien « Gestion de ma classe » (déleguée, avec le badge du nombre de demandes) et « Classes » (administratrice) ouvrent les écrans M9/M11/M12/M13. *Coût si faux : une navigation à refaire.*
- **R15 — Écrans livrés au lot 1c inchangés**, hormis la section « Ma classe » et la section « Supprimer mon compte » ajoutées à `/profil` (M14), le lien de gestion (R14) et le bouton « Refaire ta demande » sur l'écran de refus (R16). *Coût si faux : des tests à réécrire sans besoin.*
- **R16 — Re-demande d'adhésion (décision du responsable du 2026-10-17).** § 0.3 prévoit « une nouvelle demande pour la même classe possible 24 h après le refus » et l'écran M7 annonce « à partir du X », mais aucun chemin applicatif n'existait (`register` crée toujours un nouveau compte ; même email → `409 EMAIL_TAKEN`). Le lot 2 livre `POST /api/me/enrollment { classId }` (compte existant, `201` avec la demande ; `400 ENROLLMENT_RETRY_PENDING` avec `retryAfter`, `409 ALREADY_MEMBER`, `409 REQUEST_ALREADY_PENDING`, `400 CLASS_NOT_AVAILABLE`) et l'écran M7 « Demande refusée » gagne le bouton « Refaire ta demande » qui l'appelle (l'écran n'affiche aucun compte à rebours côté client : le serveur fait foi). « Demander une autre classe » reste tel quel (→ inscription). *Coût si faux : une règle de la spec inatteignable, ou un écran à refaire.*

---

## Structure des fichiers

```
apps/api/
  prisma/migrations/20261016000000_classes_memberships/
    migration.sql                        class_memberships, subjects, classes.max_delegates + quotas,
                                         déclencheurs (membership_valid, delegate_limit,
                                         « pas déjà membre »), grants cp_app
  prisma/migrations/20261016000100_anonymize_user/
    migration.sql                        priv.anonymize_user (expand R4) + droits, tests de garanties
  prisma/schema.prisma                   ClassMembership, Subject, enums class_role, leave_reason,
                                         nouvelles colonnes de classes
  src/modules/authz/matrix.ts            actions du lot 2 (+ matrice oraclе spec)
  src/modules/audit/audit-actions.ts     ENROLLMENT_ACCEPTED/REFUSED, MEMBER_REMOVED, MEMBER_TRANSFERRED,
                                         DELEGATE_APPOINTED/REVOKED, CLASS_CREATED (app), CLASS_ARCHIVED,
                                         SUBJECT_CREATED/DELETED, ACCOUNT_DELETED (APP)
  src/modules/classes/                   + class-detail, subjects, archive, create (admin), list (admin)
  src/modules/memberships/               + requests (liste, accept, refuse), members, delegates, transfers
  src/modules/users/                     + deleteAccount (POST /api/me/account, anonymisation)
  src/mail/templates/                    enrollment-refused (FR)
  test/integration/                      membership*.int.spec.ts, subjects.int.spec.ts, transfers.int.spec.ts,
                                         archive.int.spec.ts, anonymize.int.spec.ts, isolation-meta.int.spec.ts,
                                         security-classes.int.spec.ts
  test/support/seed.ts                   jeu de données § 5.3 : deux classes A et B
apps/web/src/
  api/classes.ts                         client des routes classes/memberships (+ specs)
  api/messages.ts                        nouveaux codes → textes français
  components/StepUpDialog.tsx (+ spec)   mot de passe puis code (R13)
  screens/manage/ClassRequestsScreen.tsx M9 demandes (accepter / refuser + motif)
  screens/manage/ClassMembersScreen.tsx  M9 membres, retrait avec motif
  screens/manage/ClassSubjectsScreen.tsx M9 matières (suppression désactivée si utilisée)
  screens/manage/ClassStatsScreen.tsx    M9 statistiques simples
  screens/admin/ClassesScreen.tsx        M11 vue d'ensemble (toutes les classes, création)
  screens/admin/ClassCreateScreen.tsx    création in-app (R8 lot 1a levé)
  screens/admin/ClassDetailScreen.tsx    M12 fiche (badge « Lecture seule », délégués, stats)
  screens/admin/YearTransitionScreen.tsx M13 assistant 3 étapes + récapitulatif + compte rendu
  screens/profile/ProfileScreen.tsx      + « Ma classe », + « Supprimer mon compte » (M14)
  routes.tsx                             nouvelles adresses
docs/superpowers/plans/2026-10-16-classepulse-v2-lot2-classes.md   ce plan
README.md                                contrat du lot 3, parcours manuel, nouvelles variables aucune
```

---

### Task 1 : Migration `classes_memberships` — tables, déclencheurs, droits

- [x] **Step 1 : Écrire les tests (échouent)** — `memberships-schema.int.spec.ts` : `class_memberships` crée une appartenance ; **deuxième appartenance active refusée** (index partiel) ; déclencheur `membership_valid` refuse un utilisateur `SUSPENDED`, un utilisateur `ADMIN` et une classe `ARCHIVED` ; déclencheur `delegate_limit` refuse le 3ᵉ délégué pour `max_delegates = 2` (et accepte un 3ᵉ si la colonne vaut 3) ; `subjects` refuse un doublon insensible à la casse ; `enrollment_request_valid` refuse une seconde demande `PENDING` et une demande d'un **membre actif** (complément R9 du lot 1a) ; les droits `cp_app` permettent les décisions et les écritures de membership mais **jamais** `DELETE` sur `users`. Les tests tournent sous `cp_app` et `cp_owner` (déclencheurs et index), jamais sous superutilisateur.
- [x] **Step 2 : Implémenter** — migration `expand` (tables + déclencheurs + grants), modèle Prisma (`ClassMembership`, `Subject`, enums `class_role` `STUDENT|DELEGATE`, `leave_reason` `REMOVED|TRANSFER|CLASS_ARCHIVED|ACCOUNT_DELETED`), colonnes `classes.max_delegates` (2, CHECK 1–5) et quotas (R10). *Note de réalisation : la migration ajoute aussi les valeurs d'audit du lot 2, l'extension de `audit_target` (`SUBJECT`), le déclencheur `enrollment_decision_final` (décision définitive en base) et les grants de décision — `identity-schema.int.spec.ts` (catalogue exact des droits + « cp_app peut décider ») est mis à jour ici, pas en tâche 2.*
- [x] **Step 3 : Vérifier** — `pnpm test:unit` (688 tests ; flaky `logger.spec` confirmé 4/4 isolé), `pnpm test:int -- memberships-schema` + `identity-schema` + `audit` + `security-admin` + `schema-presence` (verts), `pnpm lint`, typecheck (shared/api/web) : tous à 0.
- [x] **Step 4 : Commit** — `feat(lot2): tables appartenances et matieres, declencheurs et droits`.

### Task 2 : Décision d'adhésion (P8, API)

- [x] **Step 1 : Écrire les tests (échouent)** — `enrollment-decisions.int.spec.ts` : délégué de la classe voit les demandes (`GET …/requests`, email inclus) ; `accept` → `200` avec l'appartenance `STUDENT`, la demande `ACCEPTED` (`decided_at`, `decided_by`), audit `ENROLLMENT_ACCEPTED` ; `refuse` → `204`, motif ≤ 500 caractères, **un email `REFUSAL` une seule fois** dans `email_outbox` (payload `className` + `note`), audit `ENROLLMENT_REFUSED` ; une décision sur une demande déjà décidée → `409 REQUEST_ALREADY_DECIDED` ; un membre étudiant → `403` ; **un délégué d'une autre classe → `404` identique** à une demande inexistante ; `POST /api/me/enrollment` (R16) : moins de 24 h après un refus → `400 ENROLLMENT_RETRY_PENDING` avec `retryAfter`, plus de 24 h → `201`, membre actif → `409 ALREADY_MEMBER`, demande en attente → `409 REQUEST_ALREADY_PENDING`, classe inexistante → `400 CLASS_NOT_AVAILABLE` ; `authz` : nouvelles lignes de matrice + oraclе.
- [x] **Step 2 : Implémenter** — actions `memberships.listRequests`, `memberships.accept`, `memberships.refuse` (user, admin) et `me.createEnrollment` (user) ; routes du module `memberships` + `POST /api/me/enrollment` ; audit `ENROLLMENT_ACCEPTED` / `ENROLLMENT_REFUSED` ; gabarit français du kind `REFUSAL` (déjà dans l'énumération) ; traduction des exceptions du déclencheur (`ENROLLMENT_RETRY_PENDING`, `ALREADY_MEMBER`, `REQUEST_ALREADY_PENDING`, `REQUEST_ALREADY_DECIDED`) ; verrou `classes` en tête de chaque flux (ordre global § 2.1) ; `MailModule` déplacé à la racine (`features.ts`), enregistré global + ajouté au contexte CLI.
- [x] **Step 3 : Vérifier** — tests, typecheck, lint, depcruise ; mise à jour de `routes-meta.int.spec.ts` (règle R11 du lot 1a). *(L'oracle des droits de `identity-schema.int.spec.ts` a été mis à jour en tâche 1, avec les grants.)*
- [x] **Step 4 : Commit** — `feat(lot2): decisions d'adhesion, email de refus (P8)`.

### Task 3 : Membres et retrait (P8, API)

- [x] **Step 1 : Écrire les tests (échouent)** — `members.int.spec.ts` : liste des membres avec email et rôle ; retrait d'un étudiant par le délégué → `204`, appartenance clôturée `REMOVED`, audit ; retrait **d'un autre délégué par un délégué → `403 DELEGATE_FORBIDDEN`** (et le bouton n'existe pas côté web) ; l'admin retire n'importe qui ; motif facultatif (≤ 500) ; retrait d'un membre d'une autre classe → `404` ; membre retiré : ses requêtes ultérieures sur la classe → `404` ; classe archivée → `409 CLASS_ARCHIVED`.
- [x] **Step 2 : Implémenter** — `memberships.listMembers`, `memberships.remove` (user, admin) ; `assertRecentPasswordInTx` pour le retrait (§ 3.3) ; audit `MEMBER_REMOVED`. *(Service de fraîcheur extrait dans `AuthzModule` global — `FreshnessService` — pour éviter un cycle Auth ↔ métier ; step-up.int.spec adapté.)*
- [x] **Step 3 : Vérifier** — tests, typecheck, lint, routes-meta.
- [x] **Step 4 : Commit** — `feat(lot2): membres et retrait avec motif (P8)`.

### Task 4 : Délégués (M12, API)

- [x] **Step 1 : Écrire les tests (échouent)** — `delegates.int.spec.ts` : l'admin nomme un délégué (`role` passe `DELEGATE`), révocation (`STUDENT`) ; **3 nominations concurrentes pour une limite de 2** : exactement 2 passent, l'attente de verrou est observée (`pg_stat` ou `FOR UPDATE` sur `classes`), les autres reçoivent `409 DELEGATE_LIMIT_REACHED` ; un délégué ne nomme personne (`403`) ; nomination dans une autre classe → `404` ; audit `DELEGATE_APPOINTED` / `DELEGATE_REVOKED`.
- [x] **Step 2 : Implémenter** — `memberships.appointDelegate`, `memberships.revokeDelegate` (admin) ; `assertRecentPasswordInTx` ; le déclencheur `delegate_limit` fait foi, l'API traduit.
- [x] **Step 3 : Vérifier** — tests, typecheck, lint, routes-meta.
- [x] **Step 4 : Commit** — `feat(lot2): delegation jusqu'a deux, nomination par l'administrateur`.

### Task 5 : Matières (P8, API)

- [ ] **Step 1 : Écrire les tests (échouent)** — `subjects.int.spec.ts` : création par le délégué (`201`) et par l'admin ; doublon insensible à la casse → `409 SUBJECT_ALREADY_EXISTS` ; nom hors gabarit (2–60, caractères interdits) → `400 INVALID_SUBJECT_NAME` ; suppression d'une matière libre → `204` ; suppression d'une matière **utilisée → `409 SUBJECT_IN_USE` avec le motif dans `extra`** ; matière d'une autre classe → `404` ; classe archivée → `409` ; audit `SUBJECT_CREATED` / `SUBJECT_DELETED`.
- [ ] **Step 2 : Implémenter** — `classes.listSubjects/createSubject/deleteSubject` (user, admin) ; `normalizeName` partagé ; le service vérifie l'usage sur les tables existantes (R12).
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, routes-meta.
- [ ] **Step 4 : Commit** — `feat(lot2): matieres de la classe, suppression refusee si utilisee`.

### Task 6 : Classe : détail, création in-app et archivage (M11/M12, API)

- [ ] **Step 1 : Écrire les tests (échouent)** — `classes-admin.int.spec.ts` : `GET /api/classes` (admin : toutes, archivées incluses ; délégué → `403`) ; `POST /api/classes` (admin ; `409 CLASS_ALREADY_EXISTS`, mêmes validités que la CLI) ; `GET /api/classes/:classId` (membre, délégué, admin) avec statistiques simples (R11) ; **archivage** : STEP_UP exigé (`403 STEP_UP_REQUIRED` sans vérification, puis succès), toutes les appartenances clôturées `CLASS_ARCHIVED`, `409 CLASS_ARCHIVED` en écriture, l'admin garde la lecture, les anciens membres reçoivent `404`, audit `CLASS_ARCHIVED` ; archiver deux fois → `409` ; classe d'une autre classe → `404`.
- [ ] **Step 2 : Implémenter** — `classes.listAll`, `classes.create` (admin, `via: 'app'`), `classes.detail`, `classes.archive` ; actions `classes.list`, `classes.createApp`, `classes.read`, `classes.archive` ; audit `CLASS_CREATED` (via app) ; `assertStepUpFreshInTx` consommé.
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, routes-meta.
- [ ] **Step 4 : Commit** — `feat(lot2): classe en application, fiche et archivage verifie`.

### Task 7 : Transfert simple et en masse (M13, API)

- [ ] **Step 1 : Écrire les tests (échouent)** — `transfers.int.spec.ts` : transfert simple d'un étudiant (admin, mot de passe récent) → ancienne appartenance `TRANSFER`, nouvelle `STUDENT`, l'ancienne classe renvoie `404` au transféré ; **transfert d'un délégué → il redevient `STUDENT`** ; masse : atomique (une cible invalide annule tout), **201 transférés sur 200 demandés → `400 BATCH_TOO_LARGE`**, STEP_UP exigé, délégués non reconduits (un délégué dans le lot reste `STUDENT`) ; transfert vers une classe archivée → `409` ; utilisateur d'une autre classe → `404` ; audits `MEMBER_TRANSFERRED` (un par étudiant, métadonnées sans liste d'emails).
- [ ] **Step 2 : Implémenter** — `memberships.transfer`, `memberships.transferMass` (admin) ; `assertRecentPasswordInTx` / `assertStepUpFreshInTx` ; clôture puis création dans la transaction (ordre des verrous).
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, routes-meta.
- [ ] **Step 4 : Commit** — `feat(lot2): transfert simple et en masse avec verification`.

### Task 8 : `priv.anonymize_user` et suppression de compte (API)

- [ ] **Step 1 : Écrire les tests (échouent)** — `anonymize.int.spec.ts` : `POST /api/me/account` (mot de passe récent exigé, `400 CURRENT_PASSWORD_INVALID` sinon) → compte `DELETED`, identité effacée, préférences à `false`, `deleted_at` posé ; session révoquée `ANONYMIZED` ; appartenance clôturée `ACCOUNT_DELETED`, `leave_note` et `decision_note` effacés ; file d'emails annulée (`CANCELLED`, `to_address` et `payload` effacés) ; demande `PENDING` annulée ; **audit `ACCOUNT_ANONYMIZED` accepté seulement en source `PRIVILEGED`** (tentative APP → refus) ; 6ᵉ anonymisation d'un même acteur en 24 h → refus ; `cp_app` ne peut ni `SET ROLE cp_privileged`, ni modifier la fonction ; la reconnexion après suppression → `401` (jamais d'erreur 500) ; conservés sous pseudonyme : devoirs, ressources, messages (aucune table encore — test d'absence de régression).
- [ ] **Step 2 : Implémenter** — migration `priv.anonymize_user(uuid)` (R4 : ce qui existe au lot 2), `users.deleteAccount` (action `me.deleteAccount`), appel par l'API sous `cp_app` via la fonction ; audit `ACCOUNT_DELETED` (APP) + `ACCOUNT_ANONYMIZED` (PRIVILEGED, écrit par la fonction).
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, routes-meta.
- [ ] **Step 4 : Commit** — `feat(lot2): anonymisation du compte et suppression depuis le profil`.

### Task 9 : Fondations web du lot 2 (client, routes, StepUpDialog, Me)

- [ ] **Step 1 : Écrire les tests (échouent)** — `api/classes.spec.ts` : chaque route du lot 2 est appelée avec la bonne méthode et `{}` pour un corps vide ; `messages.spec.ts` : `REQUEST_ALREADY_DECIDED`, `ENROLLMENT_RETRY_PENDING`, `REQUEST_ALREADY_PENDING`, `DELEGATE_LIMIT_REACHED`, `DELEGATE_FORBIDDEN`, `SUBJECT_IN_USE`, `SUBJECT_ALREADY_EXISTS`, `INVALID_SUBJECT_NAME`, `CLASS_ARCHIVED`, `BATCH_TOO_LARGE`, `ALREADY_MEMBER` ont un texte français ; `StepUpDialog` : `403 STEP_UP_REQUIRED missing PASSWORD` → champ mot de passe, `missing CODE` → `OtpInput`, succès → rejeu de l'action, échec → message sans effacer la saisie ; `GET /api/me` expose `membership` et `/profil` affiche « Ma classe ».
- [ ] **Step 2 : Implémenter** — `api/classes.ts`, `StepUpDialog`, routes (`/gestion/...`, `/classes`, `/classes/nouvelle`, `/classes/:classId`, `/classes/:classId/{demandes,membres,matieres}`, `/transition`), liens depuis `/profil` (R14), `membership` dans le contexte de session.
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, a11y (nouvelles adresses dans `a11y.spec.tsx`, deux thèmes).
- [ ] **Step 4 : Commit** — `feat(lot2): fondations web, verification supplementaire et routes`.

### Task 10 : Gestion — demandes (M9, P8)

- [ ] **Step 1 : Écrire les tests (échouent)** — `ClassRequestsScreen.spec.tsx` : liste (email, date, classe), état vide « Aucune demande en attente. » ; « Refuser » ouvre la fenêtre « Refuser la demande de … » avec **motif facultatif** et la mention « Cette décision est définitive. » ; « Accepter » avec confirmation nommant l'objet ; `409 REQUEST_ALREADY_DECIDED` → message et rechargement ; `401` → retour à la connexion ; erreur serveur → message + « Réessayer » ; hors connexion → écritures désactivées avec la raison. `M7RefusedScreen.spec.tsx` (R16) : bouton « Refaire ta demande » → `POST /api/me/enrollment` ; `400 ENROLLMENT_RETRY_PENDING` → message avec `retryAfter` (aucun compte à rebours côté client) ; `201` → écran « Demande envoyée » ; `409 ALREADY_MEMBER` → message ; « Demander une autre classe » inchangé (→ inscription).
- [ ] **Step 2 : Implémenter** — `ClassRequestsScreen` (M9), `api/classes.ts` (decide) ; bouton « Refaire ta demande » sur `PendingScreen` (état REFUSED) + `api/me.ts` (`createEnrollment`).
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, a11y.
- [ ] **Step 4 : Commit** — `feat(lot2): gestion des demandes d'adhesion et re-demande (M9, M7)`.

### Task 11 : Gestion — membres, matières et statistiques (M9)

- [ ] **Step 1 : Écrire les tests (échouent)** — membres : liste avec emails et rôle, badge « Délégué » ; retrait avec motif facultatif, confirmation « Retirer … de la classe ? » ; **pas de bouton retrait sur un délégué** pour un délégué ; `403 DELEGATE_FORBIDDEN` affiché si le serveur refuse ; matière : ajout, suppression **désactivée avec la raison** si utilisée (M9) ; statistiques : membres, demandes en attente, traitées ; états vide/erreur/chargement partout.
- [ ] **Step 2 : Implémenter** — `ClassMembersScreen`, `ClassSubjectsScreen`, `ClassStatsScreen`.
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, a11y.
- [ ] **Step 4 : Commit** — `feat(lot2): membres, matieres et statistiques (M9)`.

### Task 12 : Administration — vue d'ensemble, création et fiche de classe (M11/M12)

- [ ] **Step 1 : Écrire les tests (échouent)** — `ClassesScreen` : toutes les classes (nom, niveau, année, effectif, badge « Lecture seule » sur les archivées), bouton « Créer une classe » ; `ClassCreateScreen` : nom, niveau, année `AAAA-AAAA`, `409` → message ; `ClassDetailScreen` (M12) : fiche, sélecteur de contexte (revenir à la liste), statistiques, **nomination et révocation des délégués** avec `409 DELEGATE_LIMIT_REACHED` affiché, section « Archiver la classe » (renvoie vers l'assistant de confirmation de l'étape 4), `404` pour une classe inconnue ou interdite.
- [ ] **Step 2 : Implémenter** — `ClassesScreen`, `ClassCreateScreen`, `ClassDetailScreen`.
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, a11y.
- [ ] **Step 4 : Commit** — `feat(lot2): administration des classes et delegation (M11, M12)`.

### Task 13 : Assistant de changement d'année (M13, P9)

- [ ] **Step 1 : Écrire les tests (échouent)** — `YearTransitionScreen.spec.tsx` : assistant en **3 étapes** (créer la classe · cocher les étudiants **tous cochés par défaut** avec recherche · archiver l'ancienne) ; **récapitulatif** avant confirmation (noms, effectif, année) ; confirmation sensible : `StepUpDialog` (mot de passe puis code) ; compte rendu final « N étudiants transférés · classe archivée » avec le détail des échecs éventuels (`409` sur un membre parti) ; retour au milieu de l'assistant sans rien perdre ; étape « copier les annales » absente (R3) avec sa mention « Arrive avec le lot 3. ».
- [ ] **Step 2 : Implémenter** — `YearTransitionScreen` (création réelle à l'étape 1, transfert en masse à l'étape 2, archivage à l'étape 3).
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, a11y.
- [ ] **Step 4 : Commit** — `feat(lot2): assistant du changement d'annee (M13)`.

### Task 14 : Profil — ma classe et suppression de compte (M14)

- [ ] **Step 1 : Écrire les tests (échouent)** — section « Ma classe » (nom, niveau, année, rôle, lien « Gestion de ma classe » si déléguée) ; section « Supprimer mon compte » : avertissement nommant ce qui **reste** (titres, fichiers, messages conservés — § 2.6 limite), champ mot de passe récent, confirmation « Supprimer définitivement mon compte » (bouton destructif), succès → déconnexion et écran d'état ; `400 CURRENT_PASSWORD_INVALID` → message sous le champ, contenu jamais effacé ; `429` → compte à rebours ; étudiante refusée ou en attente : section visible mais expliquée.
- [ ] **Step 2 : Implémenter** — sections dans `ProfileScreen`, `api/classes.ts` (deleteAccount).
- [ ] **Step 3 : Vérifier** — tests, typecheck, lint, a11y.
- [ ] **Step 4 : Commit** — `feat(lot2): ma classe et suppression du compte (M14)`.

### Task 15 : Isolation — jeu de données et méta-test (§ 5.3, § 5.4)

- [ ] **Step 1 : Écrire les tests (échouent)** — `test/support/seed.ts` : classes A et B, chacune avec un étudiant, un délégué, un membre retiré et un membre transféré, deux administrateurs, des comptes en attente, refusé, suspendu et supprimé (§ 5.3) ; `isolation-meta.int.spec.ts` : la table des routes (registre `collectRoutes`, R2) est extraite et **échoue si une route `:classId` ou `:userId` du lot 2 manque à la table des cas d'isolation** ; chaque cas joue la route avec l'identifiant de l'autre classe et exige le `404` identique (corps comparable à celui d'un identifiant inconnu) ; `security-classes.int.spec.ts` : identifiants devinés, réponse identique, membre retiré sans accès, délégué transféré sans accès, classe archivée en lecture seule pour l'admin, écriture interdite sans CSRF, `401` et `403` propres ; **aucun test ignoré**.
- [ ] **Step 2 : Implémenter** — compléter les cas manquants découverts par le méta-test (la table fait foi, les routes sans cas réel sont corrigées).
- [ ] **Step 3 : Vérifier** — `pnpm test:int` complet, `pnpm test:unit`, lint, typecheck.
- [ ] **Step 4 : Commit** — `feat(lot2): meta-test d'isolation et jeu de donnees de deux classes`.

### Task 16 : Vérification finale, README et feuille de route

- [ ] **Step 1 : Parcours manuel** — P8 et P9 de bout en bout contre l'API réelle, Mailpit et le web en HTTPS : inscription d'une étudiante → décision du délégué (refus avec motif → email dans Mailpit ; nouvelle tentative bloquée 24 h) → acceptation → accès à la classe ; nomination d'un délégué ; matières ; changement d'année complet (créer, transférer, archiver, vérification supplémentaire) ; suppression de compte.
- [ ] **Step 2 : README** — nouvelles routes et codes du contrat, parcours manuel, rappel : aucune variable d'environnement ajoutée, `priv.anonymize_user` étendue par chaque lot suivant (R4).
- [ ] **Step 3 : Vérification finale** — `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:int`, `pnpm depcruise`, `pnpm audit --audit-level high`, `pnpm --filter @classepulse/web build` ; feuille de route mise à jour (lot 2 terminé) ; relecture de la couverture de la spec ci-dessous.
- [ ] **Step 4 : Commit** — `feat(lot2): verification finale, README et feuille de route`.

## Critères de sortie du lot 2

- Parcours **P8 (gestion) et P9 (changement d'année en 3 étapes, R3) de bout en bout**, contre l'API réelle et le web en HTTPS.
- Écrans **M9, M11, M12, M13** et la **suppression de compte M14**, dans les deux thèmes, **axe-core sans violation `serious` ou `critical`**.
- **Isolation prouvée** : méta-test vert sur la table des routes, jeu de données § 5.3 en place, suite sécurité sans test ignoré ; toute route du lot 2 a son cas `404` d'isolation.
- Les **déclencheurs** font foi (limite de délégués, appartenance active, pas déjà membre, 24 h) et les tests de concurrence observent une attente de verrou.
- `pnpm test:unit`, `pnpm test:int`, `pnpm lint`, `pnpm typecheck`, `pnpm depcruise`, `pnpm audit --audit-level high` verts ; build de production sans erreur ; migrations `expand` uniquement.

## Contrat pour le lot 3 (rappel des routes et des codes)

| Route | Corps | Succès | Erreurs notables |
| --- | --- | --- | --- |
| `GET /api/classes` | — | `200` toutes les classes (admin) | `403 FORBIDDEN` |
| `POST /api/classes` | `{ name, level, academicYear }` | `201` | `400 INVALID_CLASS_NAME \| INVALID_CLASS_LEVEL \| INVALID_ACADEMIC_YEAR`, `409 CLASS_ALREADY_EXISTS` |
| `GET /api/classes/:classId` | — | `200` fiche + stats | `404 NOT_FOUND` (isolation) |
| `POST /api/classes/:classId/archive` | `{}` | `200` | `403 STEP_UP_REQUIRED` (`missing`), `409 CLASS_ARCHIVED`, `404` |
| `GET /api/classes/:classId/requests` | — | `200` demandes (email) | `403 FORBIDDEN`, `404` |
| `POST /api/classes/:classId/requests/:requestId/accept` | `{}` | `200` appartenance | `409 REQUEST_ALREADY_DECIDED`, `404` |
| `POST /api/classes/:classId/requests/:requestId/refuse` | `{ note? }` | `204` (+ email) | `409 REQUEST_ALREADY_DECIDED`, `404` |
| `GET /api/classes/:classId/members` | — | `200` membres (emails) | `403`, `404` |
| `DELETE /api/classes/:classId/members/:userId` | `{ note? }` | `204` | `403 DELEGATE_FORBIDDEN \| REAUTH_REQUIRED`, `409 CLASS_ARCHIVED`, `404` |
| `POST /api/classes/:classId/delegates` | `{ userId }` | `200` | `409 DELEGATE_LIMIT_REACHED`, `403 REAUTH_REQUIRED`, `404` |
| `DELETE /api/classes/:classId/delegates/:userId` | `{}` | `200` | `403 REAUTH_REQUIRED`, `404` |
| `GET|POST /api/classes/:classId/subjects` ; `DELETE …/subjects/:subjectId` | `{ name }` ; `{}` | `200` ; `201` ; `204` | `400 INVALID_SUBJECT_NAME`, `409 SUBJECT_ALREADY_EXISTS \| SUBJECT_IN_USE \| CLASS_ARCHIVED`, `404` |
| `POST /api/users/:userId/transfer` | `{ toClassId }` | `200` | `403 REAUTH_REQUIRED`, `409 CLASS_ARCHIVED`, `404` |
| `POST /api/classes/:classId/transfers` | `{ userIds: [...] }` | `200` `{ transferred }` | `400 BATCH_TOO_LARGE`, `403 STEP_UP_REQUIRED`, `409`, `404` |
| `POST /api/me/account` | `{ password }` | `204` | `400 CURRENT_PASSWORD_INVALID`, `429` (`Retry-After`), `401` |
| `POST /api/me/enrollment` (R16) | `{ classId }` | `201` demande `PENDING` | `400 ENROLLMENT_RETRY_PENDING` (`retryAfter`) \| `CLASS_NOT_AVAILABLE`, `409 ALREADY_MEMBER \| REQUEST_ALREADY_PENDING` |

Codes traduits côté web ajoutés : `REQUEST_ALREADY_DECIDED`, `ENROLLMENT_RETRY_PENDING` (`retryAfter`), `REQUEST_ALREADY_PENDING`, `ALREADY_MEMBER`, `DELEGATE_LIMIT_REACHED`, `DELEGATE_FORBIDDEN`, `SUBJECT_IN_USE`, `SUBJECT_ALREADY_EXISTS`, `INVALID_SUBJECT_NAME`, `CLASS_ARCHIVED`, `BATCH_TOO_LARGE`. Nouveautés portées par le lot 3 : tables `tasks`, `resources`, `storage`, `notifications` ; extension de `priv.anonymize_user` (R4) ; étape « copier les annales » de l'assistant (R3).

## Couverture de la spec (auto-relecture)

| Exigence | Tâche |
|---|---|
| § 0.2 rôles : `STUDENT`/`DELEGATE` sur l'appartenance, une seule active, délégués ≤ 2 (base), ADMIN hors classe, délégué transféré redevient étudiant | 1, 4, 7 |
| § 0.3 admission : décision définitive, refus avec motif + email, nouvelle demande après 24 h | 1, 2 |
| § 0.3 retrait : délégué sur étudiants, admin sur tous, motif facultatif, journalisé | 3 |
| § 0.3 transfert : admin seul, ancienne appartenance clôturée, droits de délégué immédiatement perdus | 7 |
| § 0.3 changement d'année : créer · transférer en masse · archiver (· annales au lot 3, R3) ; délégués non reconduits ; anciens membres sans accès | 6, 7, 13 |
| § 0.3 suppression = anonymisation (§ 2.6), écran M14 | 8, 14 |
| § 2.2 `class_memberships` (index partiel, motifs de départ, déclencheurs) ; `subjects` (unicité, usage) ; `classes.max_delegates` + quotas ; trigger « pas déjà membre » | 1 |
| § 2.6 `priv.anonymize_user` : effacement, `ACCOUNT_DELETED`, sessions `ANONYMIZED`, file annulée, audit `PRIVILEGED`, 5/24 h, garanties `cp_app`, limite affichée à l'écran | 8, 14 |
| § 3.3 vérification supplémentaire : archivage, transfert en masse (STEP_UP) ; ressaisie du mot de passe ailleurs | 6, 7, 9, 13 |
| § 3.6 frontières : URL avec `:classId`, membre = sa classe, admin = toutes (archivée en lecture seule), `404` identique | 2-8, 15 |
| § 5.3 jeu de données : deux classes A et B, retirés, transférés, deux admins, comptes particuliers | 15 |
| § 5.4 méta-test d'isolation, concurrence prouvée par verrou observé, aucun test ignoré | 4, 15 |
| UX § 1.2 gestion du délégué en tête du menu, badge des demandes | 9, 14 |
| UX § 1.4 actions critiques : mot de passe puis code | 9, 13 |
| UX § 2 P8 : fiche avec email, accepter/refuser, motif facultatif, décision définitive, retrait, matières désactivées si utilisées, statistiques simples | 10, 11 |
| UX § 2 P9 : assistant, tous cochés par défaut, recherche, récapitulatif, vérification supplémentaire, compte rendu | 13 |
| UX M11 vue d'ensemble, M12 fiche + délégués + badge « Lecture seule », M9 refus/matières/membres, M14 suppression | 11, 12, 14 |
| UX § 3.2 états (vide, erreur, 404, 409 archivée, hors connexion) et § 3.3 rédaction (tutoiement, confirmations nommant l'objet) | 10-14 |
