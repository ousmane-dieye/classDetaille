# ClassePulse V2 — Spécification de conception

| Élément | Valeur |
|---|---|
| Date | 2026-10-13 |
| Statut | Sections 1 à 5 **figées**. Section 6 **validée sur le principe**. Section 7 révisée : parties A, B, D et E **approuvées** ; partie C **conditionnée au résultat de T-01**. Aucune procédure n'est déclarée opérationnelle avant la réussite de ses tests (§ 9). |
| Décisions encore ouvertes | D-1 financement de l'intégration continue (tranchée pour la phase de développement, à revoir avant la production) ; D-2 durées de conservation et de verrouillage B2 (§ 10) |
| Sources | `classpulse/docs/classepulse-v2/README.md` (F-001 à F-080, règles R-*, matrice D), `ROADMAP.md`, `docs/audit-classepulse/` (audit de la V1) |
| Portée | Reconstruction complète, base vide, aucune reprise de données de la V1 |

**Conventions**
- **[Acté]** : décision validée.
- **[Principe validé]** : décision approuvée sur le principe, à confirmer par ses tests.
- **[C — conditionnel T-01]** : élément de la partie C, retenu seulement si T-01 réussit.
- **[À vérifier]** : hypothèse non démontrée, à ne jamais présenter comme une garantie.
- **[Limite]** : limite connue et acceptée.
- **[Ouvert]** : décision qui reste à prendre.

---

## 0. Contexte et décisions produit

### 0.1 Contexte
- Plateforme de vie de classe pour **une seule école** (ESP Dakar), environ **200 étudiants**. Application web responsive, **en français uniquement**, avec tous les textes dans des fichiers i18n.
- Fuseau horaire de référence : `Africa/Dakar`. Toutes les conversions de fuseau sont explicites dans le code.
- Budget limité au VPS existant et au domaine. Les services tiers utilisent leur offre gratuite tant que c'est possible (§ 7.11).
- VPS existant : 6 vCPU, 12 Go de RAM, Ubuntu 24.04, **partagé avec d'autres projets**.
- Stack imposée : React + TypeScript + Vite ; NestJS + Fastify ; PostgreSQL + Prisma ; Socket.IO ; Docker Compose + Caddy.
- Objectifs :
  - corriger par construction les failles de la V1 (une seule couche d'autorisation, côté serveur) ;
  - fiabiliser l'exploitation (sauvegardes testées, traitements qui reprennent après une panne) ;
  - rester maintenable par une petite équipe.

### 0.2 Rôles
- **Rôle global** `USER` ou `ADMIN`. **Rôle dans la classe** `STUDENT` ou `DELEGATE`, porté par l'appartenance (`class_memberships`).
- **Une seule appartenance active** par utilisateur, avec historique.
- Lors d'un transfert, l'ancienne appartenance est clôturée. Les droits de délégué disparaissent immédiatement, et l'utilisateur est retiré du salon temps réel de l'ancienne classe.
- **Comptes administrateurs dédiés** :
  - ils ne sont membres d'aucune classe (garanti par la base) ;
  - promouvoir au rôle `ADMIN` un utilisateur qui a une appartenance active est refusé ;
  - ils peuvent consulter et modérer toutes les classes ;
  - leurs messages portent le badge « Administration » ;
  - ils ne reçoivent que les notifications d'administration.
- **Délégués** : au plus 2 par classe par défaut. La limite est configurable et garantie par la base. Ils gèrent les matières de leur classe.
- Pas de rôle `TEACHER`.
- **Promotion au rôle `ADMIN`** :
  - uniquement par un administrateur ;
  - protégée contre l'auto-promotion ;
  - le dernier administrateur actif ne peut être ni rétrogradé, ni suspendu, ni supprimé ;
  - le premier administrateur est créé en ligne de commande.
- Les changements de rôle et les opérations sensibles sont journalisés.

### 0.3 Comptes et admission
- **Pas de vérification de l'email** à l'inscription :
  - l'email est saisi **une seule fois**, avec une aide qui invite à le vérifier (décision du 2026-10-13, conception UI/UX ; il était auparavant saisi deux fois) ;
  - il est rappelé sur l'écran « Demande envoyée » ;
  - il est affiché au délégué dans la demande ;
  - si l'email de bienvenue ne peut pas être envoyé, l'adresse est signalée comme « douteuse ».
- L'inscription crée le compte et la demande d'adhésion dans une seule transaction.
- Une décision d'admission est **définitive**.
  - **Refus** : motif facultatif et email au demandeur.
  - **Nouvelle demande** pour la même classe : possible 24 h après le refus.
- **Retrait d'un membre** : le délégué peut retirer un étudiant, mais pas un autre délégué ; l'administrateur peut retirer n'importe quel membre. Le motif est facultatif et l'action toujours journalisée.
- **Transfert** : par un administrateur uniquement.
- **Changement d'année** :
  1. l'administrateur crée la nouvelle classe ;
  2. il transfère en masse les étudiants cochés ;
  3. il archive l'ancienne classe, qui passe en lecture seule ;
  4. il peut copier les annales vers la nouvelle classe (case à cocher).

  Les délégués ne sont pas reconduits.
- Les anciens membres d'une classe archivée **n'y ont plus accès**.
- **Suspension** (administrateur) : connexion bloquée, sessions et connexions temps réel fermées, compte conservé.
- **Suppression de compte** : c'est une anonymisation (§ 2.6). L'export des données est hors MVP et se fait sur demande manuelle.

### 0.4 Devoirs
- Un devoir **expire à son échéance** et reste consultable dans l'onglet « Passés » jusqu'à l'archivage de la classe.
- Après l'échéance, on ne peut plus le cocher, mais on peut le décocher.
- **Suppression** : suppression logique, avec une corbeille de 30 jours (restauration possible), puis purge physique (arbitrage G).
- **Indicateur d'urgence**, calculé par **une seule fonction partagée** en jours calendaires de Dakar :
  - vert à J-5 et au-delà ;
  - jaune de J-4 à J-2 ;
  - rouge à J-1 et le jour J ;
  - « X h restantes » dans les dernières 24 h.

### 0.5 Notifications et emails
- La notification « X a terminé » est supprimée.
- **Espace « Annonces »** distinct, avec la dernière annonce épinglée en haut du chat. Le délégué peut cocher « envoyer aussi par email ».
- **Rappels J-3 et J-1** :
  - une notification par devoir dans l'application ;
  - **un seul récapitulatif par email par jour et par étudiant**, à partir de 07:00 heure de Dakar.
- **Préférences** : les emails de rappel et d'annonce peuvent être désactivés, et chaque email contient un lien de désinscription. Les notifications dans l'application restent toujours actives.
- Hors MVP : présence en ligne, « en train d'écrire », compteur de messages de chat non lus, signalement de messages.

### 0.6 Ressources et fichiers
- **Liens**, validés strictement :
  - `https` obligatoire ;
  - domaine exact présent dans une liste autorisée ;
  - pas d'identifiants dans l'URL, pas d'adresse IP ;
  - le serveur ne télécharge jamais l'URL.
- **Fichiers téléversés** : PDF, PNG ou JPEG de 10 Mo au maximum, dans **Cloudflare R2** (bucket privé, URL signées). Les vidéos restent des liens.
- **Quotas** : 2 Go par classe et 200 Mo par utilisateur. Pas d'antivirus au MVP.
- Ressources **modifiables** par leur auteur, un délégué ou un administrateur. Table unique avec un type `DOCUMENT`, `PAST_PAPER` ou `RECORDING`.
- Seules les classes actives sont visibles à l'inscription.

### 0.7 Sécurité des comptes et données personnelles
- **Mots de passe** :
  - 15 caractères minimum pour les étudiants, 16 pour les administrateurs, 128 au maximum (refus au-delà, jamais de troncature) ;
  - aucune règle de composition ;
  - normalisation NFKC ;
  - refus des mots de passe trop courants (liste locale) ;
  - hachage Argon2id.
- **Double vérification des administrateurs par code envoyé par email** (§ 3). Il n'y a pas de TOTP.
- **Conservation des données** :

  | Donnée | Durée |
  |---|---|
  | Notifications | 6 mois |
  | Conversations avec l'assistant | 90 jours |
  | Journal d'audit | 2 ans |
  | Chat | 1 an après l'archivage de la classe |
  | Emails | 1 an |
  | Journaux applicatifs (y compris les IP) | 14 jours |

- Page « Confidentialité » : traitement par un fournisseur d'IA tiers, et hébergement des fichiers chez Cloudflare.
- [À vérifier] Obligations de la loi sénégalaise 2008-12 (CDP).

### 0.8 Consultation et statistiques
- **Recherche plein texte** PostgreSQL (configuration `french_unaccent`) dans **une seule classe**. Un administrateur doit toujours choisir une classe.
- **Filtres** :
  - devoirs : par matière et par statut ;
  - ressources : par matière et par type, avec un tri par date.
- **Délégué** : l'accueil étudiant, plus un onglet « Gestion de la classe ».
- La progression d'un étudiant n'est **pas visible** des autres étudiants.
- **Statistiques du délégué** : membres, demandes, devoirs, taux de complétion par devoir et de la classe. Le dénominateur est le nombre de membres actifs à l'échéance, délégués compris.
- **Statistiques de l'administrateur** : les mêmes pour chaque classe, plus un total global, l'état des emails et des traitements planifiés, et la consommation de l'IA. Elles ne contiennent que des compteurs, jamais le contenu des conversations.

### 0.9 Assistant IA (dans le MVP)
- Périmètre de la V1 :
  - lecture seule de la plateforme ;
  - refus des questions hors sujet ;
  - quotas de 10 par minute, 60 par heure et 100 par jour par utilisateur, **plus un plafond global** ;
  - mode dégradé quand le fournisseur refuse (F-068).
- Fournisseur : **Gemini, offre gratuite**, derrière un adaptateur `LlmProvider`.
- **Minimisation des données** : ni email ni nom de famille envoyés au modèle. Une mention est affichée dans l'interface.
- [À vérifier] Conditions de l'offre gratuite : réutilisation des données par le fournisseur, quotas.

---

## 1. Architecture, modules et responsabilités [Acté]

### 1.1 Organisation
```
pnpm monorepo
├── apps/web        → SPA React (fichiers statiques)
├── apps/api        → NestJS : 1 image Docker, 2 processus
│                     • api    : HTTP (Fastify) + Socket.IO
│                     • worker : traitements planifiés (@nestjs/schedule)
└── packages/shared → schémas Zod, types, fonctions pures (urgence, normalizeEmail, local_date…)
```
- Il n'y a **ni pg-boss, ni Redis, ni BullMQ**.
- `packages/shared` ne contient aucune règle d'autorisation. Le backend revalide tout.
- Le frontend est découpé par domaine (`features/*`) et utilise TanStack Query.

### 1.2 Règles de structure
1. **Un module NestJS par domaine.** Chaque module possède ses tables. Les autres modules passent par ses services exportés.
2. **Pas de bus d'événements.** Les dépendances vont dans un seul sens. `notifications` et `realtime` sont en bas de la chaîne.
3. **Les effets d'une action sont dans la même transaction.** L'émission Socket.IO se fait **après le commit**.
4. **Pas de module « admin ».** Les points d'API d'administration sont dans chaque module et sont protégés par `authz`.
5. **Seuls les fichiers `*.repository.ts` importent Prisma.**
   - Les lectures d'éléments liés à une classe exigent `classId` : `findTask(classId, taskId)`.
   - `dependency-cruiser` impose en intégration continue qu'aucun module n'importe Prisma hors de ses repositories, ni le repository d'un autre module.
6. **Chaque méthode publique d'un service métier prend un `Actor`** et commence par une vérification d'autorisation.
   - Une écriture sur des données de classe utilise `authz.assertInTx(tx, …)`, après avoir relu avec verrou l'appartenance de l'acteur (`FOR SHARE`). Pour un administrateur, c'est sa ligne `users` qui est relue.
   - `Actor = UserActor | SystemActor`. Le `SystemActor` n'est créé que dans `jobs`, qui n'est pas importé par `ApiModule`.
7. **Une ressource d'une autre classe renvoie `404`**, avec une réponse identique à celle d'une ressource inexistante.

### 1.3 Modules
| Module | Responsabilité |
|---|---|
| `config` | Variables et fichiers de secrets validés par Zod. L'application refuse de démarrer si la configuration est invalide. |
| `database` | Client Prisma, transactions |
| `authz` | Contexte de l'acteur. Règles `can()` déclarées dans la matrice `authz/matrix.ts` (reprise de la section D). |
| `audit` | `audit_log`, en ajout seul |
| `realtime` | Passerelle Socket.IO, `LISTEN`, `emitToUser`, `emitToClass`, `disconnectUser`, `disconnectSession` |
| `mail` | Modèles, `email_outbox`, transport SMTP (worker uniquement) |
| `storage` | Adaptateur `FileStorage` compatible S3 : MinIO en développement, R2 en production |
| `auth` | Inscription, connexion, sessions, réinitialisation, limitation, Turnstile, code administrateur (F-002 à F-010) |
| `users` | Profil, email, mot de passe, anonymisation, suspension, rôle administrateur, CLI (F-011, F-028) |
| `classes` | Classes, archivage, matières (F-020 à F-023) |
| `memberships` | Demandes, appartenances, délégués, retrait, transfert, transfert en masse (F-012 à F-019, F-024 à F-027) |
| `tasks` | Devoirs, suivi, corbeille (F-029 à F-039) |
| `resources` | Liens et fichiers, quotas, vérification (F-043 à F-050) |
| `chat` | Messages, annonces, modération (F-051 à F-056) |
| `notifications` | Création par appel de service, flux, lu ou non lu, préférences (F-057 à F-060) |
| `reminders` | Rappels J-3/J-1, récapitulatif (F-040, F-041) |
| `search` | Recherche plein texte par les services de `tasks` et `resources` |
| `stats` | Indicateurs (F-069 à F-074) |
| `assistant` | Conversations, outils en lecture **appelés avec l'acteur**, `LlmProvider` (F-061 à F-068) |
| `jobs` | Worker uniquement : déclencheurs, baux, `job_runs`, signaux Healthchecks.io |

**Deux points d'entrée** : `ApiModule` (contrôleurs et passerelle) et `WorkerModule` (mêmes services, sans contrôleurs, avec `jobs`).

### 1.4 Fiabilité du worker
- **Baux** (`job_leases`) : un bail par traitement, acquis avec `UPDATE … WHERE lease_until IS NULL OR lease_until < now() RETURNING fencing_token`.
  - Durée 2 min, renouvelée toutes les 30 s.
  - Si aucune ligne n'est renvoyée, on passe son tour.
- **Réservation des éléments de travail** :
  - transaction courte avec `FOR UPDATE SKIP LOCKED` ;
  - colonnes `status`, `locked_until`, `claim_token` ;
  - traitement hors transaction ;
  - **finalisation conditionnelle** : `WHERE id = $1 AND claim_token = $2`.
- **Rattrapage** :
  - chaque traitement s'exécute au démarrage du worker ;
  - les traitements relisent l'état de la base, donc un passage manqué est rattrapé au suivant ;
  - une exécution restée `RUNNING` avec un bail expiré est marquée `ABANDONED`.
- **Déploiement** : `replicas: 1`. Sur `SIGTERM`, le worker cesse de réserver et termine en 30 s au maximum.
- **Suivi** : chaque exécution est écrite dans `job_runs`, et un signal est envoyé à Healthchecks.io.

### 1.5 Temps réel
- **La base fait foi.** Socket.IO ne fait qu'accélérer l'affichage.
- **Écritures faites dans l'API** : émission après le commit.
- **Écritures faites par le worker** :
  - `pg_notify` dans la même transaction, qui ne sert que de **signal de réveil** (des identifiants seulement, par paquets de 100) ;
  - l'API écoute sur une connexion `pg` dédiée.
- **Perte de la connexion `LISTEN`** :
  - détection par les événements `error` et `end`, le keepalive TCP, et un `SELECT 1` toutes les 30 s (délai de 5 s) ;
  - reconnexion avec un délai de 1 à 30 s, puis réenregistrement des canaux, puis `resync` envoyé à tous les clients ;
  - l'état dégradé est visible dans `/api/health/ready`.
- **API qui tombe entre le commit et l'émission** : toutes les connexions tombent avec elle, et les clients se resynchronisent en se reconnectant (§ 4).

### 1.6 Ressources du VPS
Les limites sont des valeurs de départ, à ajuster d'après les mesures de la section 5.

| Conteneur (production) | Limite | Réglages |
|---|---|---|
| PostgreSQL | 1 Go, 1,0 CPU, 512 Mo réservés | `shared_buffers=256MB`, `effective_cache_size=768MB`, `max_connections=40` |
| api | 512 Mo, 1,0 CPU | Mémoire Node limitée à 384 Mo |
| worker | 384 Mo, 0,5 CPU | Mémoire Node limitée à 256 Mo |
| web | 64 Mo, 0,25 CPU | — |
| backup (ponctuel) | 256 Mo, 0,5 CPU | — |
| Préproduction | ~1,2 Go au total | `oom_score_adj` élevé, poids CPU de 256 (contre 1024 en production) |

- **Consommation réelle attendue** : environ 0,6 à 0,9 Go en production. **[À vérifier]** par les tests de charge.
- Le cache disque est compté dans le cgroup d'un conteneur, mais il est libérable.

### 1.7 Arbitrages de la section 1
| # | Décision |
|---|---|
| A | Email au résultat ambigu : une seule reprise après 15 min, avec le même `Message-ID`, puis `FAILED` |
| B | Anciens membres d'une classe archivée : aucun accès. Copie facultative des annales vers la nouvelle classe, sous forme de **nouvelles ressources**. |
| C | Fichiers partagés par un compte supprimé : conservés, de façon anonyme |
| D | Notifications d'une ancienne classe : conservées, non cliquables (`accessible = false`) |
| E | Recherche d'un administrateur : toujours dans une classe choisie |
| F | Filet de sécurité côté client : resynchronisation au retour sur l'onglet, et `GET /api/sync/state` toutes les 5 min |

---

## 2. Modèle de données PostgreSQL [Acté]

### 2.1 Choix généraux
- **PostgreSQL 18** :
  - image fixée par empreinte ;
  - compatibilité de Prisma **[À vérifier]** (tâche T-01), avec un repli sur la version 17 sans impact sur le modèle.
- **Identifiants** : UUID v7 générés par l'application. Exception : `audit_log.id` est un `bigint` auto-incrémenté.
- **Email** : `citext`. Le stockage, l'unicité et les clés de limitation utilisent la forme normalisée par `normalizeEmail`, qui supprime les espaces au début et à la fin, applique NFKC puis met en minuscules. Seuls les emails ASCII sont acceptés au MVP.
- **Types** : `timestamptz` partout, et des `enum` PostgreSQL.
- **Les utilisateurs ne sont jamais supprimés physiquement** : la suppression d'un compte est une anonymisation. Les clés étrangères vers `users` sont en `RESTRICT`.
- **Schémas** :
  - `app` : tables, triggers, fonctions de trigger ;
  - `ext` : `citext`, `pgcrypto` ;
  - `priv` : fonctions `SECURITY DEFINER` ;
  - `public` : tous les droits retirés.

  Aucun rôle applicatif n'a `CREATE` sur un schéma, et `TEMPORARY` est retiré sur la base.
- **Rôles** :

  | Rôle | Usage |
  |---|---|
  | `cp_owner` | Possède le schéma, applique les migrations, membre de `cp_privileged` |
  | `cp_app` | API et worker. Pas de DDL, droits accordés table par table et colonne par colonne, membre d'aucun rôle. `transaction_timeout = 10s`, `idle_in_transaction_session_timeout = 10s`. |
  | `cp_privileged` | `NOLOGIN`. Propriétaire des fonctions `priv.*`, avec `search_path = pg_catalog, ext, pg_temp` et des objets toujours qualifiés par leur schéma. |
  | `cp_ops` | Exécute uniquement les fonctions `priv` d'exploitation |
  | `cp_monitor` | `SELECT` sur `priv.health_summary` (des compteurs uniquement) |

- **Transactions** :
  - niveau `READ COMMITTED` ;
  - rejouées jusqu'à 3 fois sur `40P01` (interblocage) et `40001` (conflit de sérialisation) ;
  - `classes` et `users` ne sont jamais verrouillés en `FOR UPDATE`, mais en `FOR NO KEY UPDATE` ou `FOR SHARE`.
- **Ordre global des verrous** :
  `role_guard` → `classes` → `users` → `class_memberships` → `enrollment_requests` → `auth_challenges` (LOGIN avant RECOVERY) → [insertion dans `second_factor_failures`, sans verrou] → `sessions` → lignes de contenu → `email_outbox` → compteurs de synchronisation (dans l'ordre croissant des identifiants).
- **Expirations de sécurité** : elles sont comparées à `clock_timestamp()` et non à `now()`.
- **`CHECK` à plusieurs cas** : toujours écrits sous la forme explicite « (cas A complet) OR (cas B complet) ».

### 2.2 Tables
**Identité et sessions**
- `users` :
  - colonnes : `email`, `first_name`, `last_name`, `password_hash`, `global_role`, `status` (ACTIVE, SUSPENDED, DELETED), `email_flagged_at`, `email_reminders`, `email_announcements`, `unsubscribe_token_hash`, `deleted_at` ;
  - `UNIQUE(email)` ;
  - `CHECK users_lifecycle` : un compte `ACTIVE` ou `SUSPENDED` a tous ses champs d'identité renseignés ; un compte `DELETED` est `USER`, a tous ses champs effacés, ses préférences d'email à `false` et `deleted_at` renseigné.
  - *(voir § 7.6.6 : colonnes `bg_locked_at` et `bg_lock_version` du verrouillage de secours, et leur ajout à `users_lifecycle`, dans le cadre de l'exception du § 6)*
- `sessions` :
  - colonnes : `token_hash` (SHA-256), `user_id`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `reauth_at`, `second_factor_at`, `second_factor_method`, `step_up_at`, `ip`, `user_agent`, `revoked_at`, `revoke_reason` ;
  - motifs de révocation : LOGOUT, PASSWORD_CHANGED, ROLE_CHANGED, SUSPENDED, ANONYMIZED, EMAIL_CHANGED, ADMIN_REVOKED, OTHER_DEVICES, RESTORE ;
  - **révocation logique** ;
  - purge 7 jours après l'expiration ou la révocation, après celle de leurs vérifications.
- `password_reset_tokens` : hachage du jeton, expiration après 30 min, usage unique.
- `rate_limit_buckets` :
  - clés bornées : `ip:<préfixe>` (préfixe /64 en IPv6) et `ip+acct:<préfixe>:<HMAC(email normalisé)>` ;
  - purge toutes les heures ;
  - au-delà de 50 000 lignes, seule la limite par IP s'applique et une alerte est envoyée.
- `auth_challenges` (§ 3.3) et `second_factor_failures`.
- `role_guard` : une ligne unique, qui sérialise les changements de rôle administrateur.

**Classes et appartenances**
- `classes` :
  - colonnes : `name`, `level`, `academic_year`, `status` (ACTIVE, ARCHIVED), `archived_at`, `max_delegates` (2 par défaut, entre 1 et 5), `storage_quota_bytes`, `storage_reserved_bytes` ;
  - `UNIQUE(name, academic_year)`.
- `subjects` : `UNIQUE(class_id, lower(name))`, `UNIQUE(class_id, id)` comme cible des clés étrangères composites, suppression refusée si la matière est utilisée.
- `class_memberships` :
  - index unique partiel `(user_id) WHERE left_at IS NULL` ;
  - motifs de départ : REMOVED, TRANSFER, CLASS_ARCHIVED, ACCOUNT_DELETED ;
  - trigger « limite de délégués » ;
  - trigger « conditions d'une appartenance active » : utilisateur `USER` et `ACTIVE`, classe `ACTIVE`.
- `enrollment_requests` :
  - index unique partiel `(user_id) WHERE status = 'PENDING'` ;
  - trigger « demande valide » : utilisateur verrouillé, pas déjà membre, délai de 24 h après un refus.

  Le délai est garanti à quelques secondes près, puisqu'il utilise `now()`.

**Devoirs**
- `tasks` :
  - clé étrangère composite `(class_id, subject_id)` ;
  - `deleted_at` et `deleted_by` pour la corbeille ;
  - `search_vector` (colonne générée, index GIN) ;
  - index partiel `(class_id, due_at) WHERE deleted_at IS NULL`.

  L'état « passé » est calculé à partir de `due_at`, jamais stocké.
- `task_completions` :
  - clé primaire `(task_id, user_id)` ;
  - trigger qui refuse de cocher un devoir dont l'échéance est passée, ou un devoir supprimé.
- `reminder_deliveries` : clé primaire `(task_id, user_id, kind, due_date)`, où `due_date` est la **date locale de Dakar** de l'échéance.

**Ressources**
- `resources` : soit un lien, soit un fichier. Les contraintes `res_*` portent sur :
  - l'exclusivité lien ou fichier ;
  - la forme de la clé, `classes/<class_id>/<id>` ;
  - le type MIME (PDF, PNG ou JPEG) ;
  - la taille (10 Mo au plus) ;
  - `verified_at` renseigné si et seulement si le fichier est `READY` ;
  - un cours (`RECORDING`) est toujours un lien ;
  - une annale (`PAST_PAPER`) a toujours une année et un type d'examen ;
  - un lien est en `https`, sans identifiants, et fait au plus 2 048 caractères.

  La liste exacte des domaines autorisés est vérifiée par le backend.
- Triggers sur `resources` :
  - **immuabilité** de `class_id`, `storage_key`, `size_bytes`, `mime_type` et `kind` ;
  - **transitions de `file_status`** autorisées : `PENDING_UPLOAD → PENDING_SCAN | DELETING`, `PENDING_SCAN → READY | REJECTED`, `READY | REJECTED → DELETING`.
- `storage_reservations` : le registre des quotas.
  - `id` est l'identifiant de la ressource ;
  - `purpose` vaut `UPLOAD` ou `COPY`, et `status` vaut `HELD` ou `RELEASED` ;
  - le motif de libération est cohérent avec `purpose`.

  ```sql
  ALTER TABLE storage_reservations ADD CONSTRAINT resv_ref_key UNIQUE (id, class_id, size_bytes, status);
  ALTER TABLE resources
    ADD reservation_state text GENERATED ALWAYS AS (CASE WHEN storage_key IS NOT NULL THEN 'HELD' END) STORED,
    ADD CONSTRAINT res_reservation_held FOREIGN KEY (id, class_id, size_bytes, reservation_state)
        REFERENCES storage_reservations (id, class_id, size_bytes, status);   -- NO ACTION, MATCH SIMPLE
  ```
  - Ce que la base garantit :
    - une ressource avec fichier référence toujours une réservation `HELD` ;
    - une réservation ne peut pas passer `RELEASED` tant que sa ressource existe ;
    - le compteur de la classe ne change que sur une insertion ou sur la transition `HELD → RELEASED` ;
    - la libération (`UPDATE … WHERE status = 'HELD'`) a lieu **exactement une fois** ;
    - `RELEASED → HELD` est interdit.
  - Quota par utilisateur : 200 Mo, calculé sous le verrou de la classe.
- `year_transition_copies` (copie des annales) :
  - états : PLANNED, RESERVED, COPIED, DONE, SKIPPED, FAILED, INCONSISTENT ;
  - chaque étape peut être rejouée : la clé de destination est connue d'avance ; la copie (`CopyObject`) est suivie d'une vérification `HEAD` (taille et ETag) ; l'insertion utilise `ON CONFLICT` puis un contrôle de cohérence ;
  - purge 30 jours après la fin de l'opération ;
  - aucune référence à l'ancienne classe (la provenance n'est notée que dans l'audit).

**Communication**
- `chat_messages` :
  - colonnes : `author_role_snapshot`, `kind` (MESSAGE, ANNOUNCEMENT), `content` (1 à 2 000 caractères, `NULL` pour une pierre tombale), `email_requested`, `client_msg_id`, `request_fingerprint` (32 octets), `change_seq`, `deleted_at`, `deleted_by` ;
  - `UNIQUE (class_id, author_id, client_msg_id)` ;
  - `UNIQUE (class_id, change_seq)` ;
  - `chat_content_safe` : ni caractères de contrôle, ni caractères de direction, ni message vide ;
  - **une suppression est définitive** et **le contenu est immuable** (trigger).
- `notifications` :
  - colonnes : `recipient_id`, `type`, `actor_user_id`, `params jsonb` (identifiants et titres de contenu seulement, **jamais de nom**), `class_id`, `entity_type`, `entity_id` (sans clé étrangère, valeurs fermées), `read_at`, `change_seq` ;
  - **pas de colonne `link`** ;
  - `cp_app` ne peut modifier que `read_at` et `updated_at` (droits par colonne) ;
  - `UNIQUE (recipient_id, change_seq)`.
- `class_chat_counters` et `user_notification_counters` :
  - colonnes `seq` et `purged_through`, avec `0 ≤ purged_through ≤ seq` ;
  - créés par un trigger `AFTER INSERT` sur `classes` et `users` ;
  - les fonctions `next_chat_seq` et `next_notification_seq` échouent si la ligne du compteur manque ;
  - immuabilité : ni la clé, ni `seq`, ni `purged_through` ne peuvent baisser.
- `sync_epoch` : une ligne unique, lisible par `cp_app` seulement en lecture, régénérée à chaque restauration.

**Emails**
- `email_outbox` :
  - colonnes : `recipient_user_id`, `to_address`, `kind`, `dedupe_key` (unique), `payload jsonb`, `payload_encrypted` (AES-256-GCM), `message_id` (unique), `status`, `normal_attempts` (0 à 5), `ambiguous_retry_scheduled`, `ambiguous_retry_claimed`, `next_attempt_at`, `locked_until`, `claim_token`, `expires_at`, `accepted_at`, `challenge_id` ;
  - types d'email : WELCOME, REFUSAL, PASSWORD_RESET, DIGEST, ANNOUNCEMENT, ADMIN_ALERT, SECURITY_ALERT, ADMIN_SECURITY_ALERT, ADMIN_OTP, ADMIN_EMAIL_CHANGE_OLD, ADMIN_EMAIL_CHANGE_NEW, TEST ;
  - les invariants de `CHECK` lient chaque colonne à l'état (§ 2.4).
- `email_attempts` :
  - colonnes : `attempt_no` (1 à 6), `kind` (NORMAL, AMBIGUOUS_RETRY), `outcome` (ACCEPTED, TEMP_FAIL, PERM_FAIL, AMBIGUOUS, CANCELLED_IN_FLIGHT), `smtp_code`, `smtp_response` (tronquée), `late_outcome` et `late_smtp_code` (autorisés seulement si `outcome = CANCELLED_IN_FLIGHT`) ;
  - le résultat ne peut être écrit qu'une fois (trigger).

**Assistant**
- `assistant_conversations` et `assistant_messages` (`tokens_in`, `tokens_out`, 2 000 caractères au plus pour un message utilisateur).

**Exploitation**
- `audit_log` : voir § 2.5.
- `job_leases`, et `job_runs` (purgée après 90 jours).
- `ops_settings` : une ligne unique, en lecture seule pour `cp_app`, modifiée par les scripts d'exploitation. Colonnes :
  - `orphan_delete_paused_until`, `orphan_review_required` ;
  - `bulk_email_paused` ;
  - `last_restore_at`, `last_restore_backup_at`.
- `priv.break_glass` (§ 7.6) et la vue `priv.health_summary`.

### 2.3 Synchronisation par `change_seq`
- Le trigger `BEFORE INSERT OR UPDATE` écrase `change_seq` avec le numéro suivant du compteur du périmètre. Le verrou de la ligne du compteur est conservé jusqu'à la fin de la transaction.
- **Garantie (formulation exacte)** : *si une lecture a observé la position `p` d'un périmètre, aucune transaction ne pourra rendre visible ensuite une version de ligne dont le `change_seq` est inférieur ou égal à `p`.*
- Il **n'y a pas** de garantie « sans trous ». Des numéros intermédiaires n'apparaissent sur aucune ligne visible : ligne modifiée plus tard, plusieurs modifications dans une même transaction, insertion puis effacement dans une même transaction.
- **`cp_app` n'a pas le droit `DELETE`** sur `chat_messages` ni sur `notifications`. Les suppressions physiques passent par les fonctions privilégiées `priv.purge_notifications`, `priv.purge_class_chat` et `priv.anonymize_user`. Dans la même transaction, elles exécutent `seq = seq + 1` et `purged_through = seq + 1` (la nouvelle valeur), à condition qu'au moins une ligne ait été supprimée.

### 2.4 États d'un email
- **Politique** :
  - au plus **5 tentatives normales** (délais de 1 min, 5 min, 30 min, 2 h) ;
  - **au plus 1 reprise** après un résultat ambigu (15 min après le constat) ;
  - **6 tentatives au total au maximum** ;
  - après la reprise ambiguë, tout résultat autre qu'une acceptation donne `FAILED`.
- **Transitions** : un trigger refuse toute transition absente de cette liste.
  - `PENDING`, `RETRY_WAIT` ou `UNCERTAIN` vers `SENDING`, `EXPIRED` ou `CANCELLED` ;
  - `SENDING` vers `ACCEPTED`, `RETRY_WAIT`, `UNCERTAIN`, `FAILED` ou `CANCELLED` ;
  - les états finaux ne changent plus.
- **Réservation** : **une seule instruction SQL** (CTE `FOR UPDATE SKIP LOCKED`). Elle filtre :
  - l'expiration (`expires_at > now()`) ;
  - le droit à une tentative (5 normales au plus, une seule reprise ambiguë) ;
  - `bulk_email_paused`, sauf pour les emails de sécurité.

  Elle crée la ligne `email_attempts` dans la même instruction.
- **Bail expiré** : un balayage passe la tentative à `AMBIGUOUS` / `LEASE_EXPIRED`, puis applique la règle du résultat ambigu. Un email n'est **jamais** remis en file sans précaution.
- **En cas de doute, le résultat est classé ambigu.** Seuls les échecs dont l'étape est connue et antérieure à la transmission des données sont considérés comme certains.
- **`ACCEPTED`** signifie « accepté par le serveur SMTP configuré (réponse 250) ». Ce n'est **pas** une livraison au destinataire. Les rebonds asynchrones ne sont pas suivis au MVP.
- **Garantie affichée** : au moins une fois pour les envois confirmés, au plus deux fois pour les envois ambigus.
- **Email annulé pendant son envoi** : la tentative est close `CANCELLED_IN_FLIGHT`. Un résultat tardif n'enregistre que son code, et l'email n'est jamais réactivé.

### 2.5 Journal d'audit
- `cp_app` n'a que `INSERT` et `SELECT`.
- Le trigger `audit_log_guard` remplit `source` (`APP` ou `PRIVILEGED`, selon `current_user`), `occurred_at = now()` et `db_login_role = session_user`.
- **Actions réservées à la source `PRIVILEGED`** : ACCOUNT_ANONYMIZED, NOTIFICATIONS_PURGED, CHAT_PURGED, ADMIN_RECOVERY_CODE_ISSUED, ADMIN_SECOND_FACTOR_BLOCK_CLEARED, DATABASE_RESTORED, ainsi que les actions BREAK_GLASS_* (§ 7.6).
- **Liste fermée** des actions. Les métadonnées sont un objet JSON de 4 Ko au plus, avec **un schéma Zod par action**.
- **Autorisé dans les métadonnées** : identifiants, énumérations, noms de champs, titres de contenu.
- **Interdit** : contenu des messages, consignes, URL, noms, emails, IP, secrets.
- **Ordre approximatif** : `id` et `occurred_at` ne reflètent pas l'ordre de validation. Aucun traitement ne lit le journal de façon incrémentale.
- **Fiabilité** : les entrées `PRIVILEGED` sont garanties par la base ; les entrées `APP` sont déclaratives (option B). Conservation 2 ans, purge privilégiée. La taille de la table est surveillée.

### 2.6 Anonymisation : `priv.anonymize_user` (option B)
- **Modèle de menace (option B)** :
  - l'application fait foi pour l'identité de l'acteur (`p_actor`) ;
  - la fonction **vérifie les droits** de cet acteur à partir de l'état de la base, et **limite les dégâts** à 5 anonymisations par acteur sur 24 h, comptées sur les entrées `PRIVILEGED` ;
  - elle protège contre les erreurs de code, mais **ne protège pas** contre une compromission de `cp_app`.
- **Ce que fait la fonction** :
  - prend les verrous dans l'ordre global ;
  - efface l'identité, les préférences et les jetons de l'utilisateur, et le passe `USER` et `DELETED` ;
  - révoque ses sessions (`ANONYMIZED`) ;
  - clôture son appartenance (`ACCOUNT_DELETED`) et efface `leave_note` et `decision_note` ;
  - supprime ses rappels, ses notifications (avec l'avancée de `purged_through`) et ses conversations avec l'assistant ;
  - **renomme ses fichiers** avec un nom neutre, `document-AAAA-MM-JJ.ext`, ce qui n'est possible que si l'auteur est déjà `DELETED` et que `current_user` vaut `cp_privileged` ;
  - pour ses emails : ceux en attente passent `CANCELLED`, un email en cours d'envoi est clos `CANCELLED_IN_FLIGHT`, et `to_address`, `payload` et `smtp_response` sont effacés ;
  - écrit `ACCOUNT_ANONYMIZED` dans l'audit.
  - *(voir § 7.6.6 : lève aussi le verrouillage de secours du compte, et efface l'armement qui le visait)*
- **Données conservées** : devoirs, ressources, messages (contenu compris), suivis, sous pseudonyme.
- **[Limite]** Le titre des ressources, le contenu des fichiers (métadonnées internes d'un PDF comprises) et les messages restent tels quels. L'écran de suppression le signale.
- **Garanties sur les droits**, vérifiées par des tests : `cp_app` ne peut pas exécuter `SET ROLE cp_privileged`, ne peut ni modifier une fonction, ni désactiver un trigger, ni utiliser `session_replication_role`, ni créer un objet ou une table temporaire.

### 2.7 Conservation
| Donnée | Règle |
|---|---|
| Compte | Anonymisation, ligne conservée |
| Classe | Archivage. Suppression physique seulement si elle n'a jamais eu de contenu. Chat purgé un an après l'archivage. |
| Matière | Suppression refusée si elle est utilisée |
| Devoir | Corbeille de 30 jours, puis purge (`TASK_PURGED`) |
| Ressource | Fichier : passage par `DELETING`, puis suppression du fichier, puis de la ligne, puis libération du quota. Lien : suppression directe. |
| Message | Pierre tombale. Purge un an après l'archivage de la classe. |
| Notification | 6 mois |
| Email et tentatives | 1 an |
| Conversation avec l'assistant | 90 jours |
| Sessions et vérifications | 7 jours et 24 h après la fin de validité |
| `second_factor_failures` | 24 h |
| Audit | 2 ans |

### 2.8 Ce que Prisma ne décrit pas
Les éléments suivants sont écrits en **SQL brut** dans les migrations :
- index partiels, `CHECK` portant sur plusieurs colonnes, triggers ;
- colonnes générées, `tsvector` et configuration `french_unaccent` ;
- droits par colonne, rôles, fonctions `priv` ;
- clés étrangères qui incluent le statut.

Le **test de présence du schéma** les vérifie après chaque migration. Le SQL généré par Prisma est toujours relu, puisqu'en cas de dérive, `prisma migrate dev` peut proposer de supprimer des objets qu'il ne connaît pas.

---

## 3. Authentification, sessions, sécurité des API [Acté]

### 3.1 Origine et CORS
- **Une seule origine** : `/` pour la SPA, `/api/*` pour l'API, `/socket.io/*` pour le temps réel. **Aucun CORS applicatif.**
- **R2** : CORS strict, `PUT` uniquement depuis l'origine de l'application avec l'en-tête `content-type`. Le `GET` n'est pas autorisé en CORS.
- La préproduction a un bucket et des clés séparés.

### 3.2 Authentification
- **Mots de passe** : § 0.7. La normalisation NFKC est identique dans tous les parcours.
- **Argon2id** :
  - paramètres OWASP : 19 Mio de mémoire, 2 itérations, parallélisme 1 ;
  - au plus 4 calculs simultanés.
- **Connexion** :
  - message d'erreur identique dans tous les cas ;
  - hachage factice si l'email est inconnu ;
  - la suspension n'est signalée qu'après un mot de passe correct.
- **Limitation des tentatives** :

  | Portée | Limite |
  |---|---|
  | Par IP | **100 sur 15 min** (exception validée à la section 3) |
  | Par couple IP + compte | 5 sur 15 min, avec un délai croissant |

  - **Turnstile** :
    - demandé après 3 échecs sur un couple IP + compte ;
    - exigé à l'inscription et pour « mot de passe oublié ».
  - **Un compte n'est jamais bloqué** quelle que soit l'IP d'origine.
  - Une alerte d'exploitation se déclenche quand une IP dépasse 50 échecs en 15 min.
- **Turnstile indisponible** (arbitrage M) :
  - indisponibilité détectée après 3 échecs consécutifs ou un délai de 3 s dépassé ;
  - connexion : limites réduites à 5 par IP et 2 par couple IP + compte, avec une alerte ;
  - inscription et « mot de passe oublié » : refusés temporairement.
- **Arbitrage N** : l'inscription peut révéler qu'un compte existe. Turnstile et la limitation réduisent l'énumération **sans la supprimer**.
- **Mot de passe oublié** :
  - jeton de 32 octets, valable 30 min, à usage unique ;
  - une nouvelle demande annule la précédente ;
  - une réinitialisation révoque toutes les sessions ;
  - `Referrer-Policy: no-referrer`, et le jeton est envoyé par `POST` puis retiré de l'URL.
- **Premier administrateur** : `node dist/cli create-admin --email …`.
  - Le mot de passe est lu sur l'entrée standard.
  - La commande est refusée s'il existe déjà un administrateur actif.

### 3.3 Double vérification des administrateurs par code envoyé par email
- **Parcours de connexion** :
  - identifiants valides, puis création d'une vérification `LOGIN` et envoi d'un code à 6 chiffres ;
  - cookie de vérification : `__Host-cp_challenge=…; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`, effacé avec **exactement les mêmes attributs** et `Max-Age=0` ;
  - `POST /api/auth/verify-code` ouvre la session.
- **Stockage du code** :
  - `code_hmac = HMAC-SHA256(OTP_PEPPER, challenge_id ‖ code)` ;
  - l'identifiant de la vérification est **généré par l'appelant** avant le calcul ;
  - le code n'est jamais stocké ni journalisé en clair.
- **Règles** :
  - expiration après 10 min, usage unique ;
  - 5 essais par vérification, puis `LOCKED` ;
  - une seule vérification active par usage (index unique partiel) ;
  - **toute création de vérification consomme d'abord l'ancienne** (`EXPIRED` ou `SUPERSEDED`) dans la même transaction, sans dépendre de la purge.
- **Vérification d'un code**, dans une transaction :
  1. `users FOR NO KEY UPDATE` ;
  2. contrôle du blocage du compte ;
  3. vérification `FOR UPDATE` ;
  4. comparaison du HMAC à temps constant ;
  5. en cas de succès, consommation de la vérification et création de la session.

  Deux validations simultanées n'ouvrent qu'**une seule session**.
- **Limites** :
  - demandes de code : 1 par minute, 5 par heure et 10 par jour par administrateur, 10 par heure par IP ;
  - essais : 5 par vérification ; 30 par heure et par préfixe d'IP ; **10 échecs par compte sur 60 minutes glissantes**, enregistrés dans `second_factor_failures`, tous usages confondus.
- **Compte bloqué** :
  - refus **sans comparaison** du code ;
  - aucune vérification n'est créée et aucun email n'est envoyé ;
  - le code de récupération est refusé lui aussi ;
  - le blocage ne peut être levé que par `admin-recovery-code --clear-block`.
- **Alerte** : à partir du 3ᵉ échec, une alerte est envoyée à l'administrateur concerné et aux autres, avec une clé anti-doublon `admin-2fa-alert:<compte>:<heure>`.
- **File d'emails** :
  - les codes partent par `email_outbox` avec le type `ADMIN_OTP`, le contenu chiffré et `NOTIFY` pour réveiller le worker ;
  - le contenu chiffré est effacé dans tous les états finaux.
  - Garanties de la base :
    - `challenge_email_link` : un email de code est toujours lié à sa vérification ;
    - `one_email_per_challenge` : un seul email par vérification ;
    - `outbox_challenge_guard` : cohérence du type, de l'adresse et de l'expiration avec la vérification ;
    - `challenge_consumed_cancels_emails` : la consommation d'une vérification annule ses emails.
  - **Juste avant l'envoi SMTP**, le worker vérifie que la vérification est encore active et que la session est valide.
- **Le service d'emails est indisponible** :
  - **aucun accès administrateur** n'est accordé ;
  - aucune option ne permet de désactiver la vérification ;
  - en développement, les codes arrivent dans Mailpit.
- **Récupération** : `ops admin-recovery-code --email … [--clear-block]`, lancée sous `cp_ops` par SSH.
  - La commande génère un code de 12 caractères et l'identifiant de sa vérification, puis transmet **seulement le HMAC** à `priv.issue_admin_recovery_code`.
  - La fonction, dans une seule transaction :
    - vérifie que la cible est un administrateur actif ;
    - remplace la vérification `RECOVERY` existante ;
    - insère la nouvelle, valable 15 min ;
    - écrit l'audit `PRIVILEGED` avec `db_login_role = cp_ops` ;
    - met en file les alertes aux administrateurs.
  - Utilisation : `POST /api/auth/verify-recovery`, seulement avec un cookie `LOGIN` valide, c'est-à-dire **après le mot de passe**.
  - Les deux vérifications sont consommées de façon atomique, dans l'ordre LOGIN puis RECOVERY.
  - Seule la vérification `RECOVERY` peut avoir `token_hash = NULL` (migration explicite : `DROP NOT NULL`, puis `CHECK`). Un trigger réserve sa création à `cp_privileged`. *(voir § 7.6.5 : cette exception est étendue à `BREAK_GLASS_NEW_EMAIL`, dans le cadre du § 6)*
- **Confidentialité du code de récupération** :

  | Canal | Mesure |
  |---|---|
  | Génération et affichage | Code généré dans le processus. Affichage sur le terminal seulement après le commit, puis effacement de l'écran. |
  | Exécution hors terminal | Refusée. C'est un garde-fou, **pas une garantie**. |
  | Journaux Docker | `logging: driver: none`. Comportement **[À vérifier]** sur la version de Docker installée. |
  | Base de données | `pg` utilisé directement, sans Prisma. PostgreSQL ne reçoit que le HMAC. |
  | Erreurs et traces | Seule la catégorie d'erreur est affichée. Ni Sentry ni pino ne sont utilisés. |
  | Vidage mémoire | `ulimit -c 0` |

  - **[Limite]** Ces mesures ne protègent ni contre un accès root pendant l'exécution, ni contre l'enregistrement de la session SSH ou l'historique du terminal, ni contre un regard par-dessus l'épaule.
- **Changement d'email d'un administrateur** :
  - il exige **le mot de passe, plus un code envoyé à l'ancienne adresse, plus un code envoyé à la nouvelle** (vérifications `EMAIL_CHANGE_OLD`, puis `EMAIL_CHANGE_NEW`, avec `pending_email`, liées à la session) ;
  - le code envoyé à l'ancienne adresse **tient lieu de vérification supplémentaire** pour cette opération, sans mettre à jour `step_up_at` ;
  - `verify-new` revérifie sous verrou que la session est toujours valide et que c'est bien celle de la requête ;
  - à la fin, les autres sessions sont révoquées et des alertes sont envoyées.
- **Sessions des administrateurs** :
  - 30 min d'inactivité, 8 h au maximum ;
  - le code n'est pas redemandé pendant la session ;
  - une nouvelle authentification complète est exigée après une expiration, une révocation ou une déconnexion ;
  - il n'y a pas d'« appareil de confiance ».
- **Vérification supplémentaire (`STEP_UP`)** : mot de passe **et** nouveau code, datant de moins de 5 min et liés à la session. Elle est exigée pour :
  - promouvoir ou rétrograder un administrateur ;
  - suspendre ou anonymiser un compte ;
  - le transfert en masse ;
  - l'archivage d'une classe.

  Les autres actions sensibles exigent une ressaisie du mot de passe datant de moins de 5 min.
- **⚠️ Limite documentée** : ce second facteur **dépend entièrement de la sécurité de la boîte email** de l'administrateur.
  - Le lien de réinitialisation et le code arrivent dans la même boîte. Il est donc moins robuste qu'un facteur indépendant, et dépend de la disponibilité du service d'emails.
  - Recommandation : une adresse dédiée à ce rôle, elle-même protégée par une double authentification chez son fournisseur.

### 3.4 Sessions
- **Cookie** : `__Host-cp_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sans `Domain`). Le jeton fait 32 octets, et seul son hachage est stocké.
- **Durée du cookie** :
  - étudiant : `Max-Age` de 30 jours, fixé à la connexion ;
  - administrateur : `Max-Age` de 8 h.

  **Le serveur fait toujours foi** : une session invalide donne `401`, accompagné d'un effacement du cookie avec les mêmes attributs.
- `last_seen_at` est mis à jour au plus toutes les 5 min.
- Un nouveau jeton est créé à chaque connexion.
- **Révocation** : promotion ou rétrogradation, changement de mot de passe, suspension, anonymisation, changement d'email, « déconnecter les autres appareils », restauration.
  - Ordre : vérifications de la session (`SESSION_ENDED`), puis session, puis `disconnectSession` après le commit.
- Le profil liste les sessions actives.

### 3.5 Sécurité des API
- **Protection CSRF** (refus par défaut, pour toute requête qui modifie des données) :

  | `Origin` | `Sec-Fetch-Site` | Décision |
  |---|---|---|
  | Égal à l'origine de l'application | (ignoré) | Acceptée |
  | Différent, ou `null` | (ignoré) | `403` |
  | Absent | `same-origin` | Acceptée |
  | Absent | Autre valeur, ou absent | `403` |

  - Seul `application/json` est accepté, et aucune requête `GET` ne modifie de données.
  - Socket.IO exige un `Origin` exact.
- **Validation** : pipe Zod global, champs inconnus rejetés, UUID validés, corps de 100 Ko au plus.
- **Réponses** : un DTO de sortie explicite par point d'API. L'email d'un membre n'est renvoyé qu'aux délégués et aux administrateurs.
- **Erreurs** : pas de trace d'exécution, un `request_id` dans chaque réponse.
- **Limitation générale** : `@nestjs/throttler` en mémoire (une seule instance), 300 requêtes par minute par session et 600 par IP.
- **En-têtes** (posés par Caddy) :
  - CSP stricte : `default-src 'self'`, Turnstile, R2, Sentry, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'` ;
  - HSTS d'un an, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- **Journaux** : pino au format JSON, avec masquage des cookies, des en-têtes d'autorisation, des mots de passe, des jetons, des codes et du contenu des messages. Les IP sont conservées 14 jours.
- **Dépendances** : fichier de verrouillage pnpm, Renovate, `pnpm audit` bloquant pour les vulnérabilités élevées et critiques.
- **OpenAPI** : non exposée en production (arbitrage P).
- **Assistant** : outils en lecture seule, appelés avec l'acteur. La sortie du modèle est traitée comme non fiable (markdown sans HTML, liens limités à une liste fixe d'actions).

### 3.6 Frontières entre classes
- Les URL nomment toujours la classe : `/api/classes/:classId/…` (arbitrage O).
  - Un membre ne peut viser que sa classe active.
  - Un administrateur peut viser n'importe quelle classe ; une classe archivée est en lecture seule pour lui.
- **Socket.IO** :
  - en réception seule (arbitrage L) : le client ne peut émettre que `subscribe` et `unsubscribe` ;
  - authentification par le cookie de session ;
  - les appartenances des connexions sont revérifiées toutes les 5 min.

### 3.7 Arbitrages L à P
| # | Décision |
|---|---|
| L | Socket.IO en réception seule ; toutes les écritures passent par REST |
| M | Mode dégradé de Turnstile, avec limites réduites et alerte |
| N | Révélation de l'existence d'un compte acceptée, réduite sans être supprimée |
| O | Classe explicite dans l'URL |
| P | OpenAPI non exposée en production |

---

## 4. Chat, notifications, rappels, traitements planifiés [Acté]

### 4.1 Invariants
1. Socket.IO ne sert qu'à recevoir ; les écritures passent par REST.
2. La base fait foi.
3. La garantie de synchronisation du § 2.3 s'applique, et un curseur trop ancien donne `410`.
4. Le curseur inclut une **époque** (`sync_epoch`).
5. Chaque écriture est **rejouable sans doublon**.
6. Les événements sont émis **après le commit**, et leur absence est rattrapée par REST.

**Hypothèses de dimensionnement** : 60 membres par classe au plus, un pic de 20 messages par seconde sur la plateforme, 2 appareils par utilisateur en moyenne. `Africa/Dakar` correspond à UTC+0, mais le code n'en tient jamais compte.

### 4.2 Chat
**Points d'API** :
- `GET /api/classes/:classId/chat/snapshot` : les 50 derniers messages, l'annonce épinglée, `seq` et `epoch` ;
- `GET …/chat/changes?epoch=&after_seq=&limit=100` ;
- `GET …/chat/history?before_id=&limit=50` ;
- `GET …/announcements` et `GET …/announcements/pinned` ;
- `POST …/chat/messages` avec `{client_msg_id, content, kind?, email_requested?}` ;
- `DELETE …/chat/messages/:id`.

**Envoi d'un message**, dans une transaction :
1. classe `FOR SHARE` (elle doit être `ACTIVE`, sinon `409`) ;
2. appartenance de l'acteur `FOR SHARE`, ou sa ligne `users` pour un administrateur ;
3. `authz.assertInTx`, avec `chat.post` ou `chat.announce` ;
4. `INSERT … ON CONFLICT (class_id, author_id, client_msg_id) DO NOTHING RETURNING *` ;
5. pour une annonce : notifications aux membres, et emails pour ceux qui ont activé `email_announcements` ;
6. commit, puis émission.

**Idempotence** :
- `request_fingerprint = HMAC-SHA256(IDEMPOTENCY_KEY, JSON canonique de {contenu NFC, kind, email_requested})` ;
- même clé et même empreinte : `200`, avec l'état actuel du message (une pierre tombale s'il a été supprimé entre-temps) ;
- empreinte différente : `409 idempotency_key_reused`, sans aucun effet.

**Ordre et suppression** :
- l'historique suit l'ordre des `id` (pagination par `before_id`), et le rattrapage suit `change_seq` ;
- une suppression transforme le message en pierre tombale définitive, qui garde sa place ;
- le client fusionne avec une seule règle : *il ignore tout élément dont le `change_seq` est inférieur ou égal à celui qu'il détient déjà*. Un message supprimé ne peut donc jamais réapparaître.

**Annonces** :
- une annonce supprimée annule ses emails encore en attente ;
- l'épinglage revient alors à l'annonce précédente ;
- la notification devient « Annonce supprimée », avec `accessible = false`.

**Contenu** (arbitrage S) :
- texte simple, normalisé NFC ;
- 2 000 caractères et 100 lignes au plus ;
- liens cliquables avec `rel="noopener noreferrer nofollow ugc"` ;
- aucun aperçu de lien.

**Modération** :
- l'auteur peut supprimer ses propres messages ;
- un délégué, ou un administrateur dans une classe active, peut supprimer n'importe quel message ;
- une suppression par une autre personne que l'auteur est écrite dans l'audit, sans le contenu.

### 4.3 Notifications
**Catalogue** :

| Type | Destinataires |
|---|---|
| `TASK_CREATED` | Membres sauf l'auteur |
| `TASK_UPDATED` (y compris une échéance modifiée) | Tous les membres |
| `TASK_REMINDER_D3`, `TASK_REMINDER_D1` | Membres qui ne l'ont pas terminé |
| `RESOURCE_ADDED` | Membres sauf l'auteur. **Pour un fichier, seulement au passage à `READY`** (arbitrage V). |
| `ANNOUNCEMENT_CREATED` | Membres sauf l'auteur |
| `ENROLLMENT_ACCEPTED`, `ENROLLMENT_REJECTED`, `MEMBER_REMOVED`, `MEMBER_TRANSFERRED`, `DELEGATE_APPOINTED`, `DELEGATE_REVOKED` | La personne concernée |
| `ENROLLMENT_REQUESTED` | Délégués de la classe et administrateurs |
| `ADMIN_JOB_FAILED`, `ADMIN_EMAIL_FAILURES` | Administrateurs |

**Points d'API** :
- `snapshot` : les 30 premières notifications, `unread_count`, `seq` et `epoch` ;
- `changes` et `history` ;
- `POST /api/notifications/:id/read` (idempotent) ;
- `POST /api/notifications/read-all` ;
- `GET /api/sync/state`.

**Autres règles** :
- le compteur de non-lus est toujours **recalculé par le serveur** ;
- l'API ne charge jamais l'élément visé par une notification. Ouvrir une notification revient à appeler le point d'API normal de l'élément, avec la classe tirée du **contexte de l'acteur** ;
- un envoi à toute une classe se fait dans une transaction par événement, avec les compteurs verrouillés par identifiant croissant.

### 4.4 Synchronisation
**Salons** :
- `user:<id>` : rejoint automatiquement ;
- `class:<id>` : rejoint automatiquement par un membre pour sa classe active. Un administrateur ne le rejoint qu'avec `subscribe`, pendant qu'il consulte la classe.

**Événements envoyés par le serveur** : `chat.message`, `notification.new`, `notification.updated`, `notifications.sync_needed`, `class.invalidate`, `resync`, `access.revoked`.

**Algorithme côté client**, par flux :
- au montage : `snapshot` ;
- à la réception d'un événement : on l'ignore s'il est déjà connu, on l'applique s'il est le suivant attendu, sinon on l'applique **puis on rattrape** (un écart n'est qu'un indice) ;
- rattrapage : `changes` en boucle jusqu'à `has_more = false`, avec une fusion par identifiant.

**Déclencheurs du rattrapage** :
- reconnexion ;
- `resync` ou `sync_needed` ;
- onglet redevenu visible ;
- `sync/state` toutes les 5 min, s'il montre un retard.

**`410 reset_required`** est renvoyé dans quatre cas :
1. l'époque est différente ;
2. `after_seq < purged_through` ;
3. `after_seq > seq` ;
4. il y a plus de 10 pages à rattraper.

`seq`, `purged_through` et `epoch` sont lus dans la **même instruction** que les lignes. Un `410` est suivi d'un nouveau `snapshot`.

**Listes de devoirs et de ressources** : `class.invalidate`, puis rechargement complet.

**Comportement visible pour l'utilisateur** :
- bandeau « Connexion perdue — reconnexion… » ;
- message non envoyé : « Non envoyé — Réessayer », avec le **même** `client_msg_id` ;
- affichage immédiat du message envoyé, puis élimination du doublon ;
- pas de file d'envoi hors ligne [Limite].

### 4.5 Autorisations dans le temps
**Transfert ou retrait** :
1. l'appartenance est clôturée dans la transaction ;
2. après le commit : `access.revoked`, puis exclusion du salon ;
3. les requêtes REST suivantes sur l'ancienne classe donnent `404` ;
4. le client vide son état local pour cette classe.

**Session révoquée** : `401`, et les connexions temps réel de cette session sont fermées.

**Archivage** :
- appartenances clôturées et `access.revoked` envoyé aux membres ;
- toute écriture renvoie `409` ;
- l'administrateur garde l'accès en lecture.

Si l'exclusion immédiate est manquée, la revérification toutes les 5 min la rattrape.

### 4.6 Traitements du worker
**Règles communes** : un bail par traitement, `job_runs`, un signal Healthchecks, des lots de 200 lignes au plus, chacun dans une transaction de moins de 10 s.

| Traitement | Fréquence | Règle |
|---|---|---|
| `reminders.plan` | **Toutes les 15 min** (arbitrage Q) | Voir § 4.7 |
| `digest.build` | Toutes les 15 min à partir de 07:00 | Clé `digest:<user>:<date>`, expiration à la fin de la journée locale |
| `email.send` | Chaque minute, et à chaque `NOTIFY` | Le contenu du récapitulatif est **recalculé au moment de l'envoi**, et l'email passe `CANCELLED` s'il est vide. Plafond `EMAIL_MAX_PER_HOUR`. |
| `files.verify` | Toutes les 30 s | `HEAD` (taille réelle), puis lecture des 4 premiers Ko (type réel) |
| `files.cleanup` | Toutes les heures | Fichiers `PENDING_UPLOAD` de plus d'1 h et `REJECTED` de plus de 24 h vers `DELETING` ; libération des réservations orphelines |
| `storage.reconcile` | Une fois par jour | Compteurs de quota et objets R2. Respecte `ops_settings` (§ 7.4). |
| `tasks.purge_trash` | Une fois par jour | Devoirs supprimés depuis plus de 30 jours |
| `notifications.purge`, `chat.purge` | Une fois par jour | Fonctions privilégiées, avec avancée de `purged_through` |
| Purges techniques | Une fois par jour | Sessions, vérifications, compteurs de limitation, `job_runs`, `second_factor_failures` |

**Arbitrage R** : un rappel apparu **après** l'envoi du récapitulatif du jour donne une notification dans l'application, mais **pas de second email** ce jour-là.

### 4.7 Dates locales des rappels
- **Définitions** :
  - `local_date(t) = (t AT TIME ZONE 'Africa/Dakar')::date` ;
  - `due_local = local_date(due_at)` ;
  - le rappel J-3 tombe à `due_local - 3`, le rappel J-1 à `due_local - 1`.
- **Heure de référence** : `run_now = clock_timestamp()`, lue en base au début du passage.
- **Condition d'émission** (toutes les conditions sont requises) :
  - la date du rappel est égale à `local_date(run_now)` ;
  - il est au moins 07:00 heure locale ;
  - `due_at > run_now` ;
  - le devoir n'est pas supprimé, la classe est active, le membre et l'utilisateur sont actifs, et le devoir n'est pas terminé ;
  - l'insertion `ON CONFLICT DO NOTHING` a bien créé une ligne.
- **Passage qui franchit minuit** : chaque lot vérifie d'abord que la date locale n'a pas changé. Sinon, le passage s'arrête.
- **Cas formalisés** :
  - devoir créé à 23:40 : le rappel J-1 part au passage de 23:45 ;
  - devoir créé à 23:50 : **pas de J-1** [Limite] ;
  - échéance repoussée : nouvelle clé, donc nouveaux rappels ;
  - échéance modifiée dans la même journée locale : pas de nouveau rappel ;
  - échéance avancée : pas de rappel en retard ;
  - passage rejoué ou deux passages simultanés : aucun doublon.

### 4.8 Limites de débit
| Action | Limite |
|---|---|
| Message de chat | 5 par 10 s et 30 par minute, par utilisateur et par classe. Un contenu identique au précédent dans les 60 s est refusé. |
| Annonce | 10 par jour et par classe, dont 3 au plus avec envoi par email |
| Suppression par un auteur | 30 par minute (pas de limite pour les délégués et les administrateurs) |
| `snapshot`, `changes`, `history` | 120 par minute par session |
| `read`, `read-all` | 60 par minute par session |
| Socket.IO | **300 nouvelles connexions par IP et par minute** (seules les ouvertures sont comptées) ; **10 connexions simultanées par utilisateur** ; 30 `subscribe` par minute par connexion ; `maxHttpBufferSize` de 1 Ko |

- Les limites sont tenues en mémoire (arbitrage U).
- Un dépassement donne `429` avec `Retry-After`.
- Un abus répété est journalisé et signalé, sans sanction automatique.
- Les seuils par IP sont réglables par configuration.

### 4.9 Restauration et époque (règle reprise au § 7.4)
**Invariant** : *aucune connexion `cp_app` ne peut lire une base restaurée tant que l'époque n'a pas été régénérée.*

Une restauration :
- révoque toutes les sessions ;
- consomme toutes les vérifications en cours ;
- écrit `DATABASE_RESTORED` dans l'audit.

### 4.10 Arbitrages Q à V
| # | Décision |
|---|---|
| Q | Planification des rappels toutes les 15 min |
| R | Pas de second email après le récapitulatif du jour |
| S | Chat en texte simple |
| T | Époque de synchronisation |
| U | Limites du chat en mémoire |
| V | Notification d'un fichier seulement au passage à `READY` |

---

## 5. Stratégie de tests et tests de charge [Acté]

### 5.1 Hypothèses
| # | Hypothèse |
|---|---|
| H1 | GitHub et GitHub Actions, avec un dépôt privé |
| H2 | Images publiées sur GHCR |
| H3 | **Aucun test de charge sur le VPS de production** |
| H4 | Beaucoup d'utilisateurs derrière une IP partagée (NAT, CGNAT) |
| H5 | Volume d'un an : 4 classes, 200 étudiants, 200 devoirs, 500 ressources, 20 000 messages, 50 000 notifications |

### 5.2 Outils
- **Tests** : Vitest (avec `unplugin-swc`), fast-check, Testcontainers (PostgreSQL 18 fixé par empreinte, MinIO, SMTP).
- **SMTP** : `smtp-server` pour simuler les erreurs, les coupures et les résultats ambigus ; Mailpit pour lire les emails.
- **API et frontend** : `app.inject()` de Fastify ; React Testing Library avec MSW.
- **Bout en bout** : Playwright (Chromium, et WebKit en émulation mobile), avec `@axe-core/playwright`.
- **Coupures réseau silencieuses** : Toxiproxy, uniquement la nuit.
- **Charge** : un banc de charge en Node (`undici`, `socket.io-client`, `hdr-histogram-js`). k6 est écarté.
- **Sécurité de la chaîne** : `pnpm audit`, gitleaks, Renovate, ZAP en mode passif.
- **Mesures en base** : `pg_stat_statements`, et `log_min_duration_statement = 200ms` en préproduction.

### 5.3 Données de test
- Jeu de données fixe, avec deux classes A et B, et dans chacune un étudiant, un délégué, un membre retiré et un membre transféré. S'y ajoutent deux administrateurs, ainsi que des comptes en attente, refusé, suspendu et supprimé.
- Générateur de volume déterministe (graine fixe), selon H5.
- Une base copiée depuis une base modèle (`TEMPLATE`) pour chaque fichier de test.
- **Rôles réels** : les tests applicatifs tournent sous `cp_app`, ceux d'exploitation sous `cp_ops`, et les migrations sous `cp_owner`. **Jamais de superutilisateur** dans les tests applicatifs.
- **Le temps** : le service `Clock` et `run_now` sont injectés. Pour les triggers, qui utilisent `clock_timestamp()`, on modifie les données au lieu d'avancer l'horloge.

### 5.4 Contenu par catégorie
- **Tests unitaires** :
  - fonctions pures : `normalizeEmail`, normalisation des mots de passe, `local_date`, règle d'urgence, validation des liens, type réel d'un fichier, fusion, classification SMTP, délais avant nouvelle tentative, `can()`, schémas Zod, rendu des notifications ;
  - propriétés vérifiées avec fast-check ;
  - **matrice d'autorisation générée, à 100 %** ;
  - couverture d'au moins 90 % sur `packages/shared` et `authz`.
- **Tests d'intégration** :
  - migrations sur une base vide **et** à partir de la version précédente ;
  - test de présence du schéma ;
  - chaque contrainte et chaque trigger ;
  - droits des rôles, avec une assertion sur le catalogue ;
  - pour chaque route : succès, `400`, `401`, `403` et `404` d'isolation ;
  - **méta-test** : la liste des routes est extraite d'OpenAPI, et le test échoue si une route n'a pas de cas d'isolation ;
  - emails, fichiers, synchronisation.

  Aucun test ignoré dans les domaines sécurité, droits et contraintes.
- **Bout en bout** :
  - parcours étudiant, délégué et administrateur (code par email, vérification supplémentaire, changement d'email, archivage avec copie des annales, récupération) ;
  - tailles d'écran 360×640, 390×844, 768×1024 et 1280×800 ;
  - aucune violation axe « sérieuse » ou « critique ».
- **Sécurité**, en suite dédiée et bloquante :
  - isolation : identifiants devinés, réponses indiscernables, transfert entre deux requêtes, abonnements déjà ouverts ;
  - sessions, CSRF, entrées (y compris les fichiers polyglottes) ;
  - authentification : limitation avec les variantes d'email, Turnstile, codes administrateur, récupération et confidentialité du code ;
  - limites de débit ;
  - en-têtes, et absence d'OpenAPI.
- **Concurrence** :
  - la concurrence est **prouvée** par au moins une attente de verrou observée ;
  - chaque scénario est joué dans les deux ordres ;
  - scénarios : 12 codes faux sur 3 vérifications (exactement 10 comparaisons) ; rétrogradations croisées ; 3 promotions de délégués pour une limite de 2 ; transfert ou archivage pendant une écriture ; 10 envois identiques ; 50 envois pendant une synchronisation ; deux `read-all` ; deux `reminders.plan` ; deux workers d'emails ; copie des annales reprise ; révocation pendant `verify-new` ;
  - **la nuit** : 20 répétitions, plus un test aléatoire de 200 itérations avec vérification SQL des invariants ;
  - **un test intermittent est un défaut**, jamais mis de côté.
- **Reprise** :
  - `SIGKILL` de l'API entre le commit et l'émission ;
  - `SIGKILL` du worker ;
  - coupure de `LISTEN` sans erreur (Toxiproxy) et avec erreur (`pg_terminate_backend`) ;
  - bail expiré (`SIGSTOP`) ;
  - purge pendant une pagination ;
  - script de restauration ;
  - redémarrage de PostgreSQL.
- **Frontend** :
  - états chargement, vide, erreur et hors ligne distincts ;
  - message « Non envoyé » et nouvel essai ;
  - doublons, pierre tombale reçue avant le message, `410`, `access.revoked` ;
  - coupures réseau ;
  - mobile : zones tactiles d'au moins 44 px.

### 5.5 Tests de charge (sur un VPS temporaire dédié uniquement)
**Scénarios** :

| # | Scénario |
|---|---|
| C1 | 400 connexions, dont 200 depuis la même IP |
| C2 | 20 messages par seconde pendant 15 min |
| C3 | 4 annonces simultanées de 60 destinataires |
| C4 | 600 rappels et 200 récapitulatifs |
| C5 | Charge mixte |
| C6 | Reconnexion massive (C6b : tous les clients sur une seule IP) |
| C7 | `pg_dump` pendant la charge |
| C8 | 150 connexions par identifiants depuis la même IP |

**Seuils PROPOSÉS, NON VALIDÉS** :

| Mesure | Seuil |
|---|---|
| Lecture REST (p50 / p95 / p99) | < 50 / 200 / 500 ms |
| Envoi d'un message (p95 / p99) | < 300 / 800 ms |
| Latence jusqu'à la réception (p50 / p95 / p99) | < 150 / 500 ms / 1 s |
| Erreurs (hors `429` attendus) | < 0,1 % |
| Transactions (p99) | < 1 s, sans jamais atteindre 10 s |
| Lot du worker (p99) | < 5 s |
| C4 | < 60 s |
| C6 / C6b | < 60 s / < 120 s |
| Mémoire propre de l'API / du worker | < 400 / 300 Mo, aucun arrêt pour manque de mémoire |
| C7 | p95 REST en hausse de moins de 50 % |

- **Critère strict** : **0 perte et 0 doublon** sur C2, C3, C6 et C6b.
  - Une perte est un message présent en base et absent de l'état final d'un client.
  - Un doublon est une ligne en double en base, ou un élément affiché deux fois.
  - Les doubles réceptions brutes sont comptées, mais elles ne font pas échouer le test.
- **Taux de lecture en cache de PostgreSQL** : c'est un **indicateur secondaire**, mesuré sur le volume H5 pendant C5. Ce qui fait foi : les latences, puis `blk_read_time` par requête, puis `iostat` et `vmstat`, puis `EXPLAIN`.
- **Rapport versionné** : `docs/perf/AAAA-MM-JJ.md`, avec le type de disque utilisé.

### 5.6 Intégration continue
| Étape | Déclencheur | Bloquant |
|---|---|---|
| Rapide (< 10 min) | Chaque push ou pull request | Oui |
| Intégration (< 20 min) | Chaque pull request | Oui |
| Bout en bout et images (< 25 min) | Fusion sur `main` | Oui |
| Préproduction et tests de fumée | Après `main` | Oui pour la production |
| **Nuit** (~1 h) | Planifiée | Un échec bloque la mise en production suivante |
| Exercice de restauration hebdomadaire | Minuteur systemd en préproduction (§ 7.7) | Alerte |
| Charge | Manuel, sur un VPS temporaire | Oui pour les versions concernées |

**Avant chaque mise en production** (validation manuelle) :
- étapes rapide, intégration et bout en bout réussies **sur le commit déployé** ;
- préproduction déployée avec ce même commit ;
- **dernière nuit réussie** (interprétation au § 7.9) ;
- **suite étendue réussie sur le commit exact** (§ 7.9 ; c'est un ajout, qui ne retire rien) ;
- migrations testées sur une copie anonymisée de la production, si la version modifie le schéma ;
- test de charge réussi, si la version le demande ;
- exercice de restauration réussi depuis moins de 30 jours ;
- après la mise en production : tests de fumée en lecture seule, et retour arrière prêt.

---

## 6. Exceptions validées aux sections figées (récapitulatif)
| Exception | Section touchée | Statut |
|---|---|---|
| Limites par IP : 100 connexions par 15 min, 300 nouvelles connexions Socket.IO par minute, 10 connexions par utilisateur | 3 et 4 | [Acté], validée avec la section 5 |
| Restauration exécutée par le superutilisateur local `postgres`, avec `SET LOCAL ROLE cp_owner` puis `cp_privileged` | 4 | [Principe validé] |
| Secrets d'exploitation sous forme de fichiers (`secrets/ops/*`) au lieu de `ops.env` dans l'environnement | 3 | [Principe validé] |
| Procédure de secours à deux parts (§ 7.6) et réglage des journaux PostgreSQL | 3 | [Principe validé], texte approuvé (partie A) |
| Colonnes `bg_locked_at` et `bg_lock_version` sur `app.users`, avec leur ajout à `users_lifecycle` ; `token_hash` NULL étendu à `BREAK_GLASS_NEW_EMAIL` | 2 et 3 | [Principe validé], dans le cadre de l'exception précédente (§ 7.6.5 et 7.6.6) |
| Fichiers lisibles par Cloudflare dans R2 ; seule la copie B2 est chiffrée | 0.6 et 2 | [Principe validé] |
| Authentification des rôles applicatifs par certificat client, sans mot de passe (§ 7.2.5 et 7.2.6) | 7 (inventaire des secrets) | **[C — conditionnel T-01]** |

---

## 7. Déploiement, sauvegardes et exploitation [Principe validé]

Statut des commandes :
- **[R]** : commande réelle ;
- **[A]** : exemple à adapter ;
- **[M]** : opération manuelle.

**Aucune procédure n'est déclarée exécutable avant la réussite de ses tests (§ 9).**

### 7.1 Prérequis à vérifier sur le VPS réel
- **Reverse proxy en place** sur les ports 80 et 443 : à identifier avec `ss -tlnp`, `docker ps` et `systemctl`.
  - Si c'est Caddy, ClassePulse ajoute seulement son fichier de site.
  - Sinon, le § 7.2.2 est adapté **avant** tout déploiement.
  - **Aucune migration des autres projets.**
- **Opérateurs A et B** : *à renseigner*. Ce point n'est pas opérationnel tant que leurs accès n'ont pas été vérifiés (§ 7.5).

### 7.2 Déploiement initial
**7.2.1 VPS [M]**
- SSH par clé uniquement (`PasswordAuthentication no`, `PermitRootLogin no`), et `fail2ban`.
- `unattended-upgrades`, et `timedatectl set-ntp true` [R].
- `ufw` limité aux ports 22, 80 et 443.
  - ⚠️ Docker contourne `ufw` : **aucun conteneur ClassePulse ne publie de port**.
- Utilisateur `cpdeploy`, membre du groupe `docker`.
  - ⚠️ C'est l'équivalent d'un accès root, ce qui est documenté.
  - Sa clé est restreinte : `command="/opt/classepulse/bin/deploy-gate.sh",no-pty,no-port-forwarding,…`.
  - `deploy-gate.sh` n'accepte que `deploy <env> <sha> <digest-api> <digest-web>`, avec des empreintes au format `sha256:[0-9a-f]{64}`.

**7.2.2 Caddy [A]**
- Fichier de site `/etc/caddy/sites/classepulse.caddy`, importé par le Caddy partagé sur le réseau Docker externe `edge`.
- En-têtes de sécurité (§ 3.5) et suppression de l'en-tête `Server`.
- **Maintenance** : le matcher `file /etc/caddy/maintenance/classepulse-prod.on` renvoie `503` sur `/api/*` et `/socket.io/*`, et une page statique ailleurs. Il suffit de créer ou supprimer ce fichier, **sans recharger Caddy**.
- **Routage** : `/api/*` et `/socket.io/*` vers `cp-prod-api:3000`, le reste vers `cp-prod-web:8080`. En défense supplémentaire, `handle /api/health/ready { respond 404 }`.
- Journaux conservés 14 jours (`roll_keep_for 336h`).
- Préproduction : `staging.…`, protégée par `basic_auth`.

**7.2.3 DNS et HTTPS [M]**
- Enregistrements `A` et `AAAA`, et `CAA` (optionnel).
- Let's Encrypt en défi HTTP-01, renouvellement automatique par Caddy. Le port 80 doit rester joignable.
- SPF, DKIM et DMARC pour le domaine d'envoi.

**7.2.4 Arborescence**
```
/opt/classepulse/bin/                     root:root 755   deploy.sh, deploy-gate.sh, backup.sh, restore.sh, monitor.sh, maintenance.sh
/opt/classepulse/{prod,staging}/          root:cpdeploy 750   compose.yaml, .env (non secret : configuration et empreintes)
/opt/classepulse/{prod,staging}/secrets/  root:root 0711   (traversable, non listable)
   api/*      root:cp-api 0440       worker/*  root:cp-worker 0440
   ops/*      root:cp-ops 0440       migrate/* root:cp-migrate 0440
   postgres/* root:cp-postgres 0440  backup/*  root:cp-backup 0440
/opt/classepulse/backups/tmp/             root:cp-backup 2770   (setgid ; backup.sh fixe umask 0007 ; vidé après chaque sauvegarde)
/var/log/classepulse/{prod,staging}/{api,worker}/   10001:10001 0750
```
Groupes : `cp-api` (20001), `cp-worker` (20002), `cp-ops` (20003), `cp-migrate` (20004), `cp-postgres` (20005), `cp-backup` (20006). Seule la **clé publique** age est présente sur le VPS (§ 7.3).

**7.2.5 Secrets**
- Jamais dans Git, dans les images, dans les journaux, dans les arguments de commande, **ni dans des variables d'environnement**.
- **Ce sont des fichiers**, montés par Compose dans `/run/secrets/<nom>`, et lus par l'application avec `X_FILE`. L'application refuse de démarrer si un fichier est illisible.
- **Chaque service ne monte que ses propres secrets**. Les conteneurs tournent sous un utilisateur non-root, avec `group_add` vers le groupe du service.
- Les options `uid`, `gid` et `mode` des secrets Compose ne sont **pas** utilisées : [À vérifier] hors du mode Swarm.
- **Aucune URL de connexion contenant un secret** dans l'environnement d'un service. `api`, `worker` et `migrate` construisent leur connexion à partir des fichiers.
- **Inventaire** (`docs/ops/SECRETS-INVENTORY.md`, qui liste les **noms** seulement) :
  - mot de passe du superutilisateur `postgres`, utilisé **uniquement à l'initialisation** (§ 7.2.6) ;
  - **[C — conditionnel T-01]** pour `cp_owner`, `cp_app`, `cp_ops` et `cp_monitor` : une **clé privée et un certificat client** par rôle, au lieu d'un mot de passe. Pour `cp_owner` (Prisma CLI), une identité PKCS#12, avec son mot de passe éventuel dans un fichier secret. Clé et certificat du serveur PostgreSQL ;
  - `OTP_PEPPER`, `OUTBOX_PAYLOAD_KEY`, `IDEMPOTENCY_KEY`, `RATE_LIMIT_HMAC_KEY` ;
  - clés R2 du bucket des fichiers ;
  - clés B2 du VPS, en écriture seulement, une par bucket (conteneur `backup` uniquement) ;
  - SMTP, Turnstile, Gemini, Sentry, URL Healthchecks.
- Génération : `openssl rand -hex 32` ou `-base64 32` [R].
- **Authentification des rôles applicatifs [C — conditionnel T-01]** :
  - les rôles `cp_owner`, `cp_app`, `cp_ops` et `cp_monitor` n'ont **aucun mot de passe** (`rolpassword` NULL) ;
  - l'**autorité de certification** a sa clé privée **hors ligne**, chez les opérateurs. Seuls son certificat et sa liste de révocation sont sur le VPS ;
  - **rotation** : nouveau certificat émis hors ligne, ancien certificat inscrit dans la liste de révocation, puis redémarrage du service. `monitor.sh` alerte 30 jours avant l'expiration de tout certificat ;
  - **clients** :
    - `pg` (Node et adaptateur Prisma) : options `ssl` (`ca`, `cert`, `key`) ;
    - `psql` et l'outillage d'exploitation : `sslcert`, `sslkey` et `sslrootcert`, sous forme de chemins ;
    - **CLI Prisma 7.10.0 (`migrate deploy`)** : `sslidentity` (PKCS#12), `sslpassword` lu depuis un fichier secret par la configuration Prisma, `sslmode=require`, `sslcert=<certificat de l'autorité>`, **`sslaccept=strict` obligatoire**, chemins absolus. La prise en charge de `sslpassword` et de `sslaccept` n'est documentée que pour la version 6. **Si T-01 échoue, la méthode d'authentification de `cp_owner` sera soumise à décision.**

**7.2.6 Compose (production) [A]**

Services `postgres`, `migrate` (profil `ops`), `worker`, `api`, `web`, `ops` (profil `ops`), `backup`.
- **Services applicatifs** :
  - image `ghcr.io/<org>/classepulse-api@${API_DIGEST}` ;
  - `user: "10001:10001"` et `group_add` vers le groupe du service ;
  - `read_only: true`, `tmpfs: /tmp`, `no-new-privileges`, `cap_drop: ALL` ;
  - journaux Docker limités à 10 Mo × 3.
- **Service `ops`** : `tty: true` et `logging: driver: none`.
- **Service `postgres`** :
  - image `postgres:18@sha256:…` ;
  - `user: "999:999"`, `group_add: ["20005"]`. Le volume `pgdata` appartient à `999:999` ;
  - `POSTGRES_PASSWORD_FILE=/run/secrets/pg_superuser_password` : ce secret ne sert qu'à l'initialisation, par le mécanisme de l'image (fichier fourni à `initdb`, sans instruction SQL). Il n'est monté **que pour la première initialisation**, puis retiré de la configuration Compose ;
  - `-c hba_file=/etc/postgresql/pg_hba.conf` ;
  - `shared_preload_libraries=pg_stat_statements`, `track_io_timing=on` ;
  - `log_statement='none'`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0` ;
  - **[C — conditionnel T-01]** `ssl=on`, certificat et clé du serveur (clé `root:cp-postgres 0640`), `ssl_ca_file`, `ssl_crl_file`.
- **Service `backup`** : `user: "10001:10001"`, `group_add: ["20006"]`, montage de `backups/tmp`. Il ne monte que `secrets/backup/*`.
- **Santé** :
  - `/api/health` est public : il renvoie seulement `{"status":"ok"|"degraded"}`, avec une vérification mise en cache 10 s et une limitation de débit ;
  - `/api/health/ready` est servi par un **second serveur HTTP sur le port 3001**, que Caddy ne transmet pas. Le contrôle de santé Docker l'interroge en local.
- **Journaux de l'application** :
  - montage de `/var/log/classepulse/<env>/<service>` vers `/var/log/app` ;
  - `pino-roll` : un fichier par jour, 14 conservés ;
  - filet de sécurité sur l'hôte : un minuteur exécute `find /var/log/classepulse -type f -mtime +14 -delete` chaque jour.
- **`pg_hba.conf` [A] [C — conditionnel T-01]** :
  ```
  local     all          postgres                              peer
  hostssl   classepulse  cp_owner,cp_app,cp_ops,cp_monitor  <sous-réseau Docker>  cert  map=cp
  host      all          all                                   0.0.0.0/0  reject
  host      all          all                                   ::/0       reject
  ```
  Le fichier `pg_ident` associe le nom commun (CN) de chaque certificat à son rôle.
- **Préproduction** : même structure, avec des limites plus basses, `oom_score_adj: 500`, des poids CPU plus faibles, et un bucket et des secrets distincts.

**7.2.7 Initialisation**
1. **Initialisation de la base**, en deux fichiers versionnés et rejouables sans dommage, exécutés par `postgres` :
   - `db-bootstrap-cluster.sql` :
     - rôles et attributs ;
     - `GRANT cp_privileged TO cp_owner` (pas de `CREATEDB`) ;
     - délais de `cp_app`, posés par `ALTER ROLE cp_app SET …` **sur le rôle lui-même, jamais avec `IN DATABASE`** ;
     - **[C — conditionnel T-01]** `ALTER ROLE … PASSWORD NULL` pour les quatre rôles applicatifs. Aucune instruction ne contient de mot de passe ni de vérificateur.
   - `db-bootstrap-database.sql`, **paramétré par le nom de la base** :
     - base appartenant à `cp_owner` ;
     - `REVOKE ALL` et `REVOKE TEMPORARY` pour `PUBLIC`, puis `GRANT CONNECT` aux rôles de connexion ;
     - `CREATE EXTENSION pg_stat_statements` ;
     - **aucun `ALTER DATABASE … SET`**. Si un réglage de base devient nécessaire, il est ajouté à ce fichier.
   - Le second fichier est rejoué à l'étape 5a de toute restauration (§ 7.4).
2. **Migrations** : `docker compose --profile ops run --rm migrate` [A].
   - La commande lance `prisma migrate deploy`, puis le contrôle de présence du schéma.
   - Elle est protégée par un verrou `flock` sur l'hôte. Le verrou consultatif de Prisma est [À vérifier] (tâche T-01).
3. **Contrôle de l'envoi d'emails** : `ops smtp-check --to <adresse>`.
4. **Premier administrateur** : `create-admin` (§ 3.2).
5. **Ordre de démarrage** : postgres (en bonne santé), puis worker, puis api (en bonne santé), puis web, puis le site Caddy.

**7.2.8 Vérifications après installation**

| Vérification | Critère |
|---|---|
| `/api/health` | `200` |
| En-têtes | Tous présents, `Server` absent |
| `/api/docs` | `404` |
| `/api/health/ready` depuis l'extérieur | `404` |
| Port 5432 | Absent de `ss` et de `nmap` |
| Socket.IO sans cookie | Refusé |
| Connexion administrateur | Code reçu, session ouverte |
| Email | SPF, DKIM et DMARC à `pass` |
| Fichiers | PDF jusqu'à `READY`, puis téléchargement, puis suppression. Quota revenu à 0. |
| Sauvegarde | Envoyée et vérifiée |
| Alertes | Alerte de test reçue |

**7.2.9 Retour arrière d'un premier déploiement**
- Retirer le fichier de site et recharger Caddy, puis `docker compose down`.
- Supprimer le volume `pgdata` **seulement après confirmation manuelle**.
- Remettre le DNS dans son état précédent.

### 7.3 Sauvegardes
**7.3.1 Politique**

| Élément | Fréquence | Destination | Conservation |
|---|---|---|---|
| PostgreSQL | Chaque jour à 03:00, et avant chaque déploiement | **B2** (copie protégée) et R2 (copie de confort, non protégée) | 7 quotidiennes, 4 hebdomadaires, 6 mensuelles (approximatif, voir § 7.3.5) |
| Fichiers R2 | Chaque jour à 04:00 (`ops files:backup`) | B2 `cp-files-backup`, **chiffrés fichier par fichier** | Voir § 7.3.4 |
| Configuration | Git | GitHub | — |
| Secrets | Chaque semaine, et à chaque rotation | Archive chiffrée avec age | 6 mois |

**7.3.2 Clés et chiffrement**
- Le VPS ne détient que les **clés publiques** age. Il y a une paire pour la base, une paire **distincte** pour les fichiers, et une paire de préproduction, qui peut être sur le VPS.
- **Les clés privées de production sont hors ligne uniquement**, chez chacun des deux opérateurs. **Aucun déchiffrement de production n'a lieu sur le VPS.**
- **Propriétés** :

  | Propriété | Mécanisme | Limite |
  |---|---|---|
  | Confidentialité | Chiffrement age avant l'envoi | La base est en clair sur le VPS, puisqu'elle y vit |
  | Intégrité | age authentifie chaque bloc ; SHA-256 contrôlé | Un VPS compromis peut **ajouter** de fausses sauvegardes récentes. Après une compromission, on restaure une sauvegarde **antérieure à l'incident**, identifiée par la date d'envoi enregistrée par B2. |
  | Disponibilité | Deux fournisseurs, deux clés hors ligne | La perte des deux clés hors ligne rend les sauvegardes illisibles |
  | Protection contre la suppression | B2 : clés du VPS sans droit de suppression, mode conformité | R2 n'est **pas** protégé. Le verrouillage B2 est limité dans le temps (§ 7.3.5). |

- **Fichiers dans R2** : ils ne sont **pas** chiffrés par l'application. Cloudflare peut les lire. Le chiffrement au repos annoncé par le fournisseur est [À vérifier]. **La confidentialité vis-à-vis de Cloudflare n'est pas garantie.**

**7.3.3 `backup.sh` (base)**

Le conteneur `backup` est construit en intégration continue et fixé par empreinte. Il est lancé par un minuteur systemd.
1. **Image cohérente** : `docker compose exec -T -u postgres postgres …` ouvre une transaction `REPEATABLE READ`, puis exécute `pg_export_snapshot()`.
2. **Fichier de contrôle**, calculé sur cette image :
   ```json
   { "format": 1, "taken_at": "…", "server_version": "18.x",
     "migrations": [["<nom>","<somme de contrôle>"]], "sync_epoch": "<ANCIENNE époque>",
     "row_counts": {}, "counters": {"chat_max_seq_sum":0,"notif_max_seq_sum":0,"purged_through_sum":0},
     "dump_sha256": "…" }
   ```
3. `pg_dump -Fc --compress=zstd --snapshot=<identifiant>`, puis `pg_restore --list`.
4. **Contrôle quotidien de restaurabilité** : le dump **en clair** est restauré dans un conteneur PostgreSQL jetable et isolé, comparé au fichier de contrôle, puis détruit.
5. `age -r <clé publique>`, puis `sha256sum`, puis `rclone copy` vers B2 et R2, puis `rclone check` (sur les fichiers chiffrés).
6. Suppression des fichiers temporaires, puis signal Healthchecks `backup-db`. L'alerte se déclenche si aucun signal n'arrive en 26 h.

**7.3.4 Fichiers (`ops files:backup`)**
- Pour chaque clé R2 absente de B2 :
  - transfert en flux : lecture depuis R2, puis `age -r <clé publique des fichiers>`, puis écriture de `<clé>.age` dans B2 ;
  - calcul du SHA-256 du contenu en clair pendant le flux.

  Une clé et son contenu sont immuables, donc **la présence du nom suffit**.
- Pour chaque objet `.age` dont la clé n'existe plus dans R2 : **masquage** (`rclone delete`, sans `--b2-hard-delete`).
- Fichier de contrôle quotidien `manifests/files-manifest-<date>.json` : clé, taille et SHA-256 en clair. Il ne contient ni nom de fichier ni donnée personnelle.
- **RPO des nouveaux fichiers** : ≤ 24 h.
- **Récupération après une suppression accidentelle** : jusqu'à 90 jours au moins après le masquage. Ce comportement est [À vérifier] (tâche T-06).

**7.3.5 Buckets B2, droits et cycle de vie**

| Bucket et préfixe | Mode conformité L | `daysFromUploadingToHiding` | `daysFromHidingToDeleting` | Clé d'écriture |
|---|---|---|---|---|
| `cp-backups-daily` | 8 j **[Ouvert D-2]** | **L** | **[Ouvert D-2]** | Clé dédiée à ce bucket |
| `cp-backups-weekly` | 29 j **[Ouvert D-2]** | **L** | **[Ouvert D-2]** | Clé dédiée |
| `cp-backups-monthly` | 181 j **[Ouvert D-2]** | **L** | **[Ouvert D-2]** | Clé dédiée |
| `cp-files-backup`, préfixe des fichiers | 30 j **[Ouvert D-2]** | Aucun (masquage seulement par `files:backup`) | 90 | Clé dédiée |
| `cp-files-backup`, préfixe `manifests/` | Même L | **[Ouvert D-2]** : conservation supérieure à 90 jours | **[Ouvert D-2]** | Même clé |

- **Clés du VPS** : une clé par bucket, chacune limitée à son bucket, avec `listBuckets`, `listFiles` et `writeFiles`. Elles n'ont **ni** `deleteFiles`, **ni** `writeFileRetentions`, **ni** `writeBucketRetentions`, **ni** `writeBuckets`, **ni** `bypassGovernance`. Une clé couvrant plusieurs buckets n'est utilisée que si T-06 confirme qu'une telle restriction existe et fonctionne.
- **Clé de chaque opérateur** : `listFiles` et `readFiles`. Une clé R2 de l'opérateur, limitée au bucket des fichiers, sert à la récupération.
- **Masquage** : d'après la documentation de Backblaze, `writeFiles` permet de masquer. Un masquage malveillant reste réversible tant que la version existe. **Une alerte se déclenche quand le nombre d'objets masqués en 24 h dépasse un seuil.**
- **Le masquage automatique est fixé à L**, la durée du mode conformité. Il n'a donc jamais lieu pendant le verrouillage, ce qui évite de dépendre du comportement « masquage d'une version verrouillée » (HY-02).
- **Les délais du cycle de vie sont des minimums, pas des échéances exactes.** Le masquage et la suppression ont lieu **au plus tôt** au terme du délai configuré, lors d'un traitement de Backblaze dont l'heure n'est pas garantie. La conservation effective et le coût de stockage sont donc **approximatifs**. Les écarts réels sont mesurés par T-06 et notés dans `docs/ops/`.
- **Mode conformité** :
  - personne ne peut lever le verrouillage, même avec un compte compromis ;
  - une durée trop longue ne peut pas être corrigée, d'où le test préalable T-06 ;
  - seule la durée de verrouillage est une **garantie minimale** de conservation, et seulement après le contrôle des étapes 0 et 8 de T-06.
- **[Limite]** Le mode conformité protège chaque objet **pendant L jours après son envoi**. Ensuite, la protection repose sur l'absence de `deleteFiles` dans les clés du VPS et sur la conservation après masquage. Elle **ne résiste pas** à la compromission du compte Backblaze. Le choix de L reste dans **D-2**.
- **Immuabilité : [À vérifier]** tant que T-06 n'a pas réussi.

**Protocole T-06**, sur `cp-locktest-<date>` : mode conformité d'un jour, préfixes `lc/` (masquage 1 jour après l'envoi, suppression 1 jour après le masquage) et `hide/` (suppression 1 jour après le masquage).

| # | Action | Clé | Résultat attendu, **à noter** |
|---|---|---|---|
| 0 | Lire la configuration du bucket | Opérateur | Verrouillage activé, mode = **conformité**, durée = 1 jour |
| 1 | `rclone copy` de 3 fichiers, dont un de plus de 200 Mo | Test (droits du VPS) | Réussi |
| 2 | `rclone check` (sans `readFiles`) | Test | Réussi, **sinon** on note l'erreur exacte et on décide si `readFiles` est nécessaire |
| 3 | `rclone delete --b2-hard-delete` et `b2 delete-file-version` | Test | **Refusés** |
| 4 | `rclone delete` (masquage) | Test | On note s'il est autorisé. La version reste visible avec `--b2-versions` (clé opérateur). |
| 5 | Nouvel envoi du même nom avec un autre contenu | Test | Nouvelle version. L'ancienne reste présente et verrouillée. |
| 6 | `rclone sync` après suppression d'un fichier à la source | Test | On note s'il masque ou s'il supprime |
| 7 | Modifier la conservation | Test | Refusé. **Prouve seulement l'absence de droits.** |
| 7 bis | **Raccourcir** la conservation d'un fichier ; passer un fichier de conformité à gouvernance ; modifier la conservation par défaut du bucket | **Complète** (`writeFileRetentions`, `writeBucketRetentions`, `bypassGovernance`, `deleteFiles`) | Les deux premiers sont **refusés**. Pour le troisième, on note s'il est accepté, et on vérifie que la conservation des fichiers existants n'a pas changé. |
| 8 | Supprimer une version **avec l'en-tête de contournement de la gouvernance** | Complète | **Refusé** : c'est la preuve du mode conformité |
| 9 | Relevé quotidien jusqu'au jour 5 | Opérateur | **Date et heure observées** du masquage (`lc/`) et de la suppression (`lc/` et `hide/`), et écart avec le délai configuré. **Non concluant** si rien ne s'est produit au jour 5 : on prolonge jusqu'au jour 10, puis le responsable décide. Aucun résultat n'est attendu à une heure précise. |
| 10 | Après l'expiration : suppression | Complète | **Réussie**, ce qui prouve que le refus de l'étape 8 venait bien du verrouillage |
| 11 | Clé limitée au bucket de test : lister et écrire sur un autre bucket | Test | **Refusé**. On note si une clé peut être limitée à plusieurs buckets. |
| 12 | Suppression de la clé complète | Compte | Disparue de la liste des clés |

**Après la création de chaque bucket de production** : rejouer les étapes 0 et 8 sur un petit fichier de test, qui restera verrouillé L jours, et noter le résultat.

**7.3.6 Objectifs de reprise**

| Objectif | Valeur | Limite |
|---|---|---|
| RPO base | 24 h | Jusqu'à 48 h si l'alerte n'est pas traitée. Pas de restauration à un instant précis (archivage WAL). |
| RPO nouveaux fichiers | 24 h | — |
| RTO | **4 h, objectif NON DÉMONTRÉ** | Mesuré par les exercices. Dépend de la disponibilité d'un opérateur. |

### 7.4 Restauration (`restore.sh`)
**Prérequis** :
- accès SSH ;
- `db-bootstrap-cluster.sql` et `db-bootstrap-database.sql` dans la version correspondant à la sauvegarde ;
- même version majeure de PostgreSQL ;
- image applicative compatible avec les migrations de la sauvegarde ;
- **dump déchiffré sur le poste d'un opérateur** (téléchargement depuis B2 avec une clé en lecture seule, vérification de l'empreinte, `age -d`), puis transféré par SSH dans un répertoire temporaire `root 700`.

Le script utilise `set -euo pipefail`. **En cas d'échec à n'importe quelle étape**, il conserve la maintenance et les rôles `NOLOGIN`, laisse l'ancienne base intacte avec `ALLOW_CONNECTIONS false` (ou dans l'état défini par la reprise de l'étape 8), et affiche l'étape en échec. Revenir à l'ancienne base est une **décision manuelle**.

| # | Étape | Exécutée par |
|---|---|---|
| 0 | Empreinte et `pg_restore --list` du dump déchiffré. **Espace libre** supérieur à 3 fois la taille de la base, plus la taille du dump ; sinon, arrêt avant l'étape 1. | root |
| 1 | Maintenance : `touch …/classepulse-prod.on` | root |
| 2 | `ALTER ROLE cp_app NOLOGIN; ALTER ROLE cp_monitor NOLOGIN; ALTER ROLE cp_ops NOLOGIN;` | `postgres`, via `docker compose exec -T -u postgres postgres psql` (authentification `peer`) |
| 3 | `ALTER DATABASE classepulse WITH ALLOW_CONNECTIONS false;`, puis `pg_terminate_backend` de toutes les sessions sur cette base | `postgres` |
| 4 | `docker compose stop api worker` | root |
| 5a | `CREATE DATABASE classepulse_restore OWNER cp_owner;`, puis `db-bootstrap-database.sql` appliqué à `classepulse_restore`, puis `COMMENT ON DATABASE classepulse_restore IS 'cp-restore:<restore_id>'` | `postgres` |
| 5b | `pg_restore --single-transaction --exit-on-error -d classepulse_restore`. Les propriétaires, les droits et les extensions sont restaurés à l'identique. | `postgres` |
| 5c | **Contrôle avant transformation** : migrations, nombre de lignes, compteurs et `sync_epoch` **égaux** au fichier de contrôle | `postgres` |
| 6 | `restore-step6.sql` (ci-dessous), dans `classepulse_restore` | `postgres`, avec `SET LOCAL ROLE` |
| 7 | **Contrôle après transformation**, inclus dans l'étape 6 | — |
| 8 | Renommage journalisé, avec reprise (ci-dessous) | `postgres`, connecté à la base `postgres` |
| 9 | **Avant toute réouverture**, contrôle sous `postgres` : la base à rouvrir est identifiée **par son commentaire** ; `pg_db_role_setting` contient les délais de `cp_app` avec `setdatabase = 0` ; `datacl` de `classepulse` égal à l'attendu (pas de `TEMPORARY` ni de `CONNECT` pour `PUBLIC`) ; propriétaire `cp_owner`. Si un contrôle échoue, arrêt avec la maintenance et `NOLOGIN` conservés. Sinon : `ALLOW_CONNECTIONS true`, puis `ALTER ROLE … LOGIN` pour les trois rôles, puis le worker, puis l'API (en bonne santé), puis l'examen de la file d'emails, puis l'effacement du commentaire, puis la fin de la maintenance. | `postgres`, puis root |

- L'ancienne base est conservée 7 jours, puis supprimée à la main.
- `monitor.sh` tient compte du fichier de maintenance.

**Étape 8 : renommage journalisé, avec reprise**
- **Identification des bases sans dépendre de leur nom** : le commentaire posé à l'étape 5a est conservé par le catalogue après un renommage. Toute décision de reprise s'appuie sur ce commentaire, et non sur les noms.
- 8.0 Journal `restore-state.json` (`root 600`) : `restore_id`, nom prévu `classepulse_pre_<horodatage>`, phase `RENAME_START`. Le fichier est écrit puis synchronisé sur disque **avant** toute instruction. Les sessions sur les deux bases sont terminées.
- 8a `ALTER DATABASE classepulse RENAME TO classepulse_pre_<horodatage>;` (instruction seule), puis phase `RENAMED_OLD`.
- 8b `ALTER DATABASE classepulse_restore RENAME TO classepulse;` (instruction seule), puis phase `RENAMED_NEW`.
- **Reprise** (`restore.sh --resume <restore_id>`) : obligatoire après toute interruption de l'étape 8. Elle relit **le catalogue**, sans se fier au journal seul :

  | Base `classepulse` | `classepulse_pre_<h>` | `classepulse_restore` | Situation | Action |
  |---|---|---|---|---|
  | Présente, **sans** le commentaire | Absente | Présente, avec le commentaire | Avant 8a | Reprendre en 8a |
  | Absente | Présente | Présente, avec le commentaire | Entre 8a et 8b | **Choix explicite de l'opérateur** : `--forward` (8b) ou `--back` (renommer `pre` en `classepulse`, puis arrêt) |
  | Présente, **avec** le commentaire | Présente | Absente | Après 8b | Passer à l'étape 9 |
  | Toute autre combinaison | | | Incohérence | **Arrêt**, maintenance et `NOLOGIN` conservés, intervention manuelle |

- La reprise peut être relancée sans dommage.
- Pendant toute la durée de l'étape 8, aucun rôle applicatif ne peut se connecter : rôles `NOLOGIN`, et `ALLOW_CONNECTIONS false` sur l'ancienne base.
- **Variante transactionnelle** (`BEGIN; 8a; 8b; COMMIT;`) : **non retenue** tant que T-03 n'a pas montré que PostgreSQL 18 l'accepte et qu'une interruption laisse les noms d'origine. Même dans ce cas, la reprise reste obligatoire.

**`restore-step6.sql`** :

`psql -v ON_ERROR_STOP=1 -d classepulse_restore -v old_epoch=<valeur du fichier de contrôle> -v backup_at=<date>`
```sql
BEGIN;
SELECT set_config('cp.old_epoch', :'old_epoch', true), set_config('cp.backup_at', :'backup_at', true);
SET LOCAL ROLE cp_owner;
UPDATE app.sync_epoch SET epoch = gen_random_uuid() WHERE id = 1;
UPDATE app.auth_challenges SET consumed_at = clock_timestamp(), consumed_reason = 'SESSION_ENDED'
 WHERE consumed_at IS NULL;                         -- le trigger annule les emails liés
UPDATE app.sessions SET revoked_at = clock_timestamp(), revoke_reason = 'RESTORE' WHERE revoked_at IS NULL;
UPDATE app.ops_settings
   SET orphan_delete_paused_until = now() + interval '14 days', orphan_review_required = true,
       bulk_email_paused = true, last_restore_at = now(),
       last_restore_backup_at = current_setting('cp.backup_at')::timestamptz
 WHERE id = 1;
SET LOCAL ROLE cp_privileged;
WITH r AS (
  UPDATE priv.break_glass
     SET revoked_at = now(), armed_user_id = NULL, armed_challenge_id = NULL,
         armed_new_email = NULL, armed_until = NULL
   WHERE id = 1 AND verifier IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL
  RETURNING 1)
INSERT INTO app.audit_log (actor_kind, action, entity_type, metadata)
SELECT 'SYSTEM','BREAK_GLASS_REVOKED','break_glass', jsonb_build_object('reason','RESTORE') FROM r;
INSERT INTO app.audit_log (actor_kind, action, entity_type, metadata)
VALUES ('SYSTEM','DATABASE_RESTORED','database',
        jsonb_build_object('backup_at', current_setting('cp.backup_at'), 'old_epoch', current_setting('cp.old_epoch')));
RESET ROLE;
DO $$ BEGIN
  IF (SELECT epoch::text FROM app.sync_epoch WHERE id = 1) = current_setting('cp.old_epoch') THEN RAISE EXCEPTION 'epoch_not_changed'; END IF;
  IF EXISTS (SELECT 1 FROM app.sessions WHERE revoked_at IS NULL) THEN RAISE EXCEPTION 'sessions_not_revoked'; END IF;
  IF EXISTS (SELECT 1 FROM app.auth_challenges WHERE consumed_at IS NULL) THEN RAISE EXCEPTION 'challenges_not_consumed'; END IF;
  IF EXISTS (SELECT 1 FROM priv.break_glass WHERE id = 1 AND verifier IS NOT NULL
             AND consumed_at IS NULL AND revoked_at IS NULL) THEN RAISE EXCEPTION 'break_glass_not_revoked'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.audit_log WHERE action = 'DATABASE_RESTORED' AND source = 'PRIVILEGED'
                 AND db_login_role = 'postgres' AND occurred_at = now()) THEN RAISE EXCEPTION 'audit_missing'; END IF;
END $$;
COMMIT;
```
- `SET ROLE` vérifie l'appartenance de l'**utilisateur de session** (`postgres`).
- **Aucun droit n'est ajouté à `cp_app`.**
- L'époque est nouvelle **avant** que la base porte le nom `classepulse`.
- Les verrouillages de comptes (`bg_locked_at`) présents dans la sauvegarde sont **conservés** (§ 7.6.6). Leur sortie passe par une nouvelle cérémonie, puis `release` ou `complete`.

**Conséquences connues** : elles sont réduites, pas supprimées.

| Conséquence | Mesure |
|---|---|
| Des emails et des rappels peuvent partir une seconde fois | `bulk_email_paused` dès l'étape 6, sauf pour les emails de sécurité. `ops outbox:review` annule les récapitulatifs et les annonces probablement déjà partis, puis l'envoi reprend. **Des doublons restent possibles.** |
| Un ancien mot de passe peut redevenir valide | Toutes les sessions sont révoquées. Communication obligatoire aux utilisateurs. Les administrateurs changent leur mot de passe. On s'appuie sur l'audit de l'ancienne base, si elle est lisible. |
| Le secours de la sauvegarde est réactivé | Passé à RÉVOQUÉ à l'étape 6. **Nouvelle cérémonie obligatoire** après la restauration. `monitor.sh` signale `BG_COUNTERS_DECREASED`, ce qui est attendu. |
| Des objets R2 deviennent orphelins, ou des fichiers manquent | `ops files:post-restore-report` produit deux listes : **(A)** objets sans ligne en base, conservés et listés ; **(B)** lignes `READY` sans objet. Pour B, la récupération se fait **depuis le poste d'un opérateur** : version voulue (`--b2-version-at`), `age -d`, comparaison avec le SHA-256 du fichier de contrôle, puis envoi vers R2. |
| Rôles absents de la sauvegarde | `db-bootstrap-cluster.sql` est rejoué avant la restauration |
| Dump en clair sur le poste d'un opérateur | Disque du poste chiffré. Dump supprimé dès la fin du transfert, avec la suppression notée dans la fiche d'incident. Jamais de copie sur un support amovible ni sur un service de synchronisation. |

**La suppression automatique des orphelins ne reprend que si** :
1. `now() > orphan_delete_paused_until` ;
2. **et** `orphan_review_required = false`, ce qui exige `ops orphans:ack` après examen (action auditée) ;
3. **et** le rapport a été produit après cet examen.

Sinon, la suspension reste active et une alerte est envoyée.
- `storage.reconcile` relit `ops_settings` avant chaque lot.
- `ops orphans:pause` attend que le bail en cours soit libéré avant de rendre la main.

**Reconstruction complète sur un nouveau VPS** : § 7.2.1 à 7.2.6, puis les deux fichiers d'initialisation, puis la restauration (étapes 0 à 9), puis le DNS, puis les vérifications du § 7.2.8.

### 7.5 Supervision et alertes
- **Outils** :
  - Healthchecks.io : un signal par traitement et par sauvegarde, et un check `monitor` (période de 5 min, délai de grâce de 10 min) qui reçoit un ping de **succès** à chaque passage réussi de `monitor.sh` ;
  - UptimeRobot ou équivalent : `/` et `/api/health` toutes les 5 min ;
  - Sentry ;
  - `monitor.sh`, toutes les 5 min, sous `cp_monitor`.
- **Ce que vérifie `monitor.sh`** :
  - conteneurs, disque, mémoire ;
  - `/api/health/ready` ;
  - `priv.health_summary` ;
  - expiration du certificat HTTPS ;
  - `ops_settings` ;
  - objets masqués dans B2 sur 24 h ;
  - état, version et compteurs cumulés d'événements du secours, et nombre de comptes verrouillés (§ 7.6.7) ;
  - **[C — conditionnel T-01]** expiration des certificats PostgreSQL (serveur et clients).

| Niveau | Conditions | Canal |
|---|---|---|
| **Critique** (intervention immédiate) | Site indisponible pendant plus de 10 min · base indisponible (hors maintenance) · disque au-delà de 90 % · aucune sauvegarde depuis 26 h · emails `ADMIN_OTP` en échec ou en retard de plus de 5 min · certificat valable moins de 7 jours · arrêts répétés pour manque de mémoire · **secours : tout code `BG_*` (§ 7.6.7)** | Email **et** groupe Telegram privé |
| **Alerte** (dans la journée) | File d'emails en retard de plus de 30 min · traitement en retard de plus de 3 fois son intervalle · `files.verify` en attente depuis plus de 10 min · écarts de réconciliation · erreurs R2 · disque au-delà de 80 % · certificat valable moins de 14 jours (moins de 30 jours pour les certificats PostgreSQL, [C]) · nouvelle erreur Sentry · IP au-delà de 50 échecs en 15 min · mode dégradé de Turnstile · exercice de restauration en échec · masquages B2 anormaux · suspension des orphelins sans examen · échec d'envoi d'une alerte Telegram | Email |
| **Information** | Résumé hebdomadaire : sauvegardes, exercices, volumes, emails, IA, événements `BREAK_GLASS_*` | Email |

- Les messages Telegram ne contiennent **que** le nom du check, son état et des codes comme `DISK_90`. Jamais de donnée personnelle ni de secret.
- **Test mensuel** : `monitor.sh --test` déclenche une fausse alerte de chaque niveau.
- **Opérateurs A et B** : *à renseigner*. Pour **chacun**, il faut vérifier :
  - la clé SSH ;
  - l'appartenance au groupe Telegram ;
  - l'accès en double authentification à Cloudflare, Backblaze et GitHub ;
  - la clé age hors ligne (déchiffrement réussi) ;
  - sa part du secret de secours.

  `docs/ops/ACCESS.md` est relu par une seconde personne.

### 7.6 Secours en cas d'administrateur unique compromis (exception à la section 3)

#### 7.6.1 Ce qui est garanti, et ce qui ne l'est pas
| Propriété | Par quoi | Niveau |
|---|---|---|
| Une part seule ne révèle rien du secret S | `S = S1 ⊕ S2`, parts uniformes et indépendantes | Cryptographique |
| Utiliser le vérificateur **en place** exige S, donc les deux parts | `digest(S,'sha256') = verifier` | Cryptographique |
| Lire le vérificateur ne permet pas de l'utiliser | Hachage à sens unique, S de 256 bits | Cryptographique |
| Résistance à la force brute | 256 bits d'entropie | Cryptographique, **indépendante du compteur d'échecs** |
| Compteur d'échecs et verrouillage après 5 échecs | Persistés seulement si la transaction de l'appelant est validée (§ 7.6.2) | **Garde-fou de saisie** de la commande officielle, pas une protection contre un détenteur de `cp_ops` |
| Deux personnes ont participé, à l'enregistrement comme à l'utilisation | **Non imposé techniquement** (§ 7.6.3) | Procédural |
| Tout événement du secours est signalé | Audit `PRIVILEGED` et emails mis en file dans la transaction ; `monitor.sh` (§ 7.6.7) | **Détectable, pas empêché.** Un membre du groupe `docker` (équivalent root) peut neutraliser ces mécanismes. |
| Identité des opérateurs | Libellés saisis | Déclaratif. Seul `db_login_role = cp_ops` est garanti par la base. |
| Un root du VPS ne peut pas prendre le contrôle | **Non garanti** | Limite documentée |

**Séparation des responsabilités** : la spécification **n'en revendique pas** au niveau technique.
- Tout opérateur qui exécute la commande `ops` est membre du groupe `docker`, donc équivalent root (§ 7.2.1).
- Le mécanisme garantit que **le secret** exige deux parts, et rend **visible** tout contournement par une seule personne. Il ne rend pas ce contournement impossible.

#### 7.6.2 Nature des objets PostgreSQL et persistance
- **Fonctions** : `priv.break_glass_enroll`, `priv.break_glass_revoke`, `priv.break_glass_arm`, `priv.break_glass_complete`, `priv.break_glass_release` et `priv.break_glass_status` sont des **fonctions** `SECURITY DEFINER`, appartenant à `cp_privileged`, avec `EXECUTE` accordé à `cp_ops` seul.
- **Pas de procédure** :
  - une fonction s'exécute **dans la transaction de l'appelant** : elle ne peut exécuter ni `COMMIT` ni `ROLLBACK` ;
  - une procédure (`CALL`) ne le pourrait que si elle était appelée hors d'un bloc de transaction, et **jamais si elle est `SECURITY DEFINER`**.
- **Les essais invalides ne lèvent jamais d'exception.**
  - La fonction écrit d'abord le compteur, l'audit et les alertes en file, puis **renvoie un code** : `OK`, `BAD_SECRET`, `CONSUMED`, `LOCKED`, `REVOKED`, `ARMED`, `NOT_ARMED`, `EXPIRED`, `BAD_CODE`, `CODE_LOCKED`, `TARGET_INVALID`, `NO_VERIFIER` ou `NOT_LOCKED`.
  - Seules les erreurs sans rapport avec le secret, comme un paramètre mal formé, peuvent lever une exception. Il n'y a alors rien à conserver.
- **Commande officielle** :
  - elle appelle chaque fonction **seule, en mode autocommit**, sur une connexion `pg` dédiée ;
  - elle refuse de s'exécuter si la connexion est déjà dans une transaction ;
  - après chaque appel, elle **relit** l'état (`priv.break_glass_status`), l'audit et les alertes en file pour confirmer que tout a bien été enregistré.
- **Appel encadré par `BEGIN … ROLLBACK`** :
  - le compteur, l'audit et les alertes sont annulés ;
  - ce comportement est **assumé et documenté** : il ne permet que des essais sans effet, que l'entropie de S rend inutiles ;
  - un succès annulé de cette façon n'a, lui non plus, aucun effet.
- **Table `priv.break_glass`** : une seule ligne, accessible **uniquement par les fonctions**, y compris pour `cp_ops`.
  - Colonnes : `verifier`, `version` (incrémentée à chaque enregistrement), `enrolled_at`, `consumed_at`, `revoked_at`, `failed_attempts`, `locked_at`, `armed_user_id`, `armed_challenge_id`, `armed_new_email`, `armed_until`, `armed_count`.
  - `priv.health_summary` expose l'état, `version`, `failed_attempts`, les compteurs cumulés par action `BREAK_GLASS_*` et le nombre de comptes verrouillés. **Jamais le vérificateur.**

#### 7.6.3 Enregistrement, remplacement et révocation
**Cérémonie** (`ops break-glass:enroll`) :
- chaque opérateur génère sa part sur son poste (32 octets aléatoires, encodés avec une somme de contrôle) et la tape sans affichage ;
- les sommes de contrôle sont vérifiées localement ;
- la commande calcule S, transmet `sha256(S)`, puis efface ses variables.

| État actuel | Enregistrement |
|---|---|
| ABSENT | Permis |
| ACTIF | Permis **seulement avec l'ancien S** (les deux anciennes parts, en plus des deux nouvelles) |
| ARMÉ | **Refusé** (`ARMED`) |
| ARMÉ expiré | Permis avec l'ancien S. L'armement est effacé. |
| VERROUILLÉ | **Refusé** (`LOCKED`) : **révocation préalable obligatoire** |
| RÉVOQUÉ ou CONSOMMÉ | Permis sans l'ancien S |

**Révocation** (`ops break-glass:revoke`, sans secret) :
- permise depuis ACTIF, ARMÉ expiré et VERROUILLÉ ;
- refusée depuis ARMÉ (`ARMED`). Depuis ABSENT, RÉVOQUÉ ou CONSOMMÉ, elle renvoie le code de l'état ;
- elle efface l'armement, mais **ne touche pas au verrouillage des comptes** ;
- usages : perte d'une part, départ d'un opérateur, sortie de l'état VERROUILLÉ.

**Dans tous les cas, dans la même transaction** :
- audit `BREAK_GLASS_ENROLLED` (avec `old_secret_presented`, l'état précédent et la nouvelle version) ou `BREAK_GLASS_REVOKED` ;
- `ADMIN_SECURITY_ALERT` mise en file pour tous les administrateurs ;
- `monitor.sh` déclenche une alerte critique (§ 7.6.7).

**Un seul chemin de remplacement sans l'ancien S** : la révocation, puis l'enregistrement.
- Ce chemin produit toujours **deux événements distincts** dans l'audit `PRIVILEGED` : `BREAK_GLASS_REVOKED`, puis `BREAK_GLASS_ENROLLED` avec `old_secret_presented = false`.
- Un remplacement légitime avec les deux anciennes parts ne produit que `BREAK_GLASS_ENROLLED` avec `old_secret_presented = true`.
- Atteindre VERROUILLÉ exige 5 échecs **validés**, donc 5 lignes d'audit et une alerte `BG_LOCKED`, et **ne dispense pas** de la révocation.

**Risque résiduel, assumé** : un détenteur de `cp_ops` peut, **seul**, révoquer, enregistrer, puis utiliser ou lever un verrouillage. Il produit alors au moins trois événements critiques (`BG_REVOKED`, `BG_ENROLLED`, puis `BG_ARMED` ou `BG_RELEASED`). Le contournement n'est pas **silencieux du point de vue de la base**. La transmission des alertes est traitée au § 7.6.7.

#### 7.6.4 Utilisation
`ops break-glass --admin-email … --new-email …` (et `ops break-glass:release --admin-email …`)

**Étape 0, hors base** :
- saisie des deux parts uniquement par le terminal, avec `stty -echo` ;
- jamais en argument ni en variable d'environnement ;
- refus d'exécution hors terminal ; service `ops` sans journaux Docker ;
- vérification des sommes de contrôle **sans appel à la base** ;
- lecture de l'état, affiché avant toute action. Seules les opérations permises sont proposées.

**T1 : `priv.break_glass_arm(S, admin_email, new_email, challenge_id, code_hmac)`**

Le code et l'identifiant de la vérification sont générés par la commande, selon le même schéma que `admin-recovery-code`. La fonction, en une seule transaction :
1. verrouille la ligne avec `FOR UPDATE`, puis contrôle l'état (§ 7.6.5) **avant** de vérifier S. Si S est faux, c'est un échec (§ 7.6.5) ;
2. vérifie que la cible est un `ADMIN` `ACTIVE`, sinon `TARGET_INVALID`, sans effet ;
3. **ne consomme pas S et ne touche pas au mot de passe** ;
4. passe en état ARMÉ : `armed_*`, `armed_until = clock_timestamp() + 15 min`, `armed_count + 1`. Toute vérification `BREAK_GLASS_NEW_EMAIL` précédente passe `SUPERSEDED` ;
5. **pose le verrouillage du compte** (§ 7.6.6) ;
6. agit sur la cible :
   - toutes ses sessions sont révoquées (`ADMIN_REVOKED`) et ses vérifications sont consommées ;
   - ses jetons de réinitialisation sont invalidés ;
   - ses emails `PASSWORD_RESET` et `ADMIN_OTP` en attente sont annulés ;
7. crée la vérification `BREAK_GLASS_NEW_EMAIL` et met en file l'email du code vers la nouvelle adresse ;
8. écrit l'audit `BREAK_GLASS_ARMED` et met en file les alertes vers l'ancienne adresse et vers tous les administrateurs.

> **Pourquoi verrouiller dès T1.** Sinon, la personne qui a compromis le compte, et qui détient le mot de passe et peut-être la boîte email, pourrait se reconnecter, ou réinitialiser le mot de passe vers l'ancienne adresse, entre T1 et T2.

**Saisie du code** : 15 minutes au plus, 5 essais.

**T2 : `priv.break_glass_complete(S, challenge_id, code)`**, en une seule transaction :
1. verrouille la ligne avec `FOR UPDATE`, puis contrôle l'état (il doit être ARMÉ, sur la même vérification) ;
2. **vérifie S de nouveau** (un échec est traité selon le § 7.6.5) ;
3. vérifie que la cible est toujours `ADMIN` `ACTIVE`, sinon `TARGET_INVALID` (§ 7.6.6) ;
4. vérifie le code. S'il est faux : `BAD_CODE` (§ 7.6.5) ;
5. en cas de succès :
   - `consumed_at = clock_timestamp()` ;
   - **mot de passe rendu inutilisable** ;
   - l'adresse email devient la nouvelle adresse ;
   - **verrouillage du compte levé** ;
   - audit `BREAK_GLASS_USED` ;
   - alertes vers l'ancienne adresse, la nouvelle et tous les administrateurs.

**Fin** : la commande relit l'audit et le statut des alertes, puis rend la main. L'administrateur légitime passe ensuite par « mot de passe oublié », qui arrive à la nouvelle adresse, puis par la connexion avec le code envoyé à cette même adresse.

**`priv.break_glass_release(S, admin_email)`** :
- lève le verrouillage d'un compte **sans** consommer S, sans changer le mot de passe ni l'email ;
- les sessions restent révoquées ;
- audit `BREAK_GLASS_RELEASED` et alertes ;
- usages : erreur de cible, abandon de la procédure, cible devenue invalide.

#### 7.6.5 États et transitions
**États du vérificateur**, calculés dans cet ordre de priorité ; un seul état est vrai à la fois :

| Priorité | État | Condition |
|---|---|---|
| 1 | CONSOMMÉ | `consumed_at` renseigné |
| 2 | RÉVOQUÉ | `revoked_at` renseigné |
| 3 | VERROUILLÉ | `failed_attempts ≥ 5` |
| 4 | ARMÉ | Armement présent, `armed_until > clock_timestamp()`, et vérification `BREAK_GLASS_NEW_EMAIL` au statut actif |
| 5 | ARMÉ expiré | Armement présent, et soit `armed_until ≤ clock_timestamp()`, soit vérification `LOCKED`, `EXPIRED` ou consommée |
| 6 | ACTIF | Vérificateur présent, sans armement |
| 7 | ABSENT | Aucun vérificateur |

Un enregistrement remet à zéro `consumed_at`, `revoked_at`, `failed_attempts`, `locked_at` et l'armement, et incrémente `version`.

**Deux compteurs distincts** :
- `failed_attempts` : un S **vérifié et faux**, dans `arm`, `complete`, `release` ou l'ancien S fourni à `enroll`.
  - Remis à zéro **seulement** par `enroll`.
  - Un refus dû à l'état est renvoyé **avant** toute vérification de S et ne compte pas.
- `attempts` de la vérification `BREAK_GLASS_NEW_EMAIL` : un code faux.
  - N'agit **jamais** sur `failed_attempts`.
  - N'est **jamais** inscrit dans `second_factor_failures`.

**Effets automatiques, dans la transaction qui les provoque** :
- **5ᵉ S faux, quel que soit l'état** :
  - passage à VERROUILLÉ (`locked_at`) ;
  - armement effacé et vérification consommée (`SUPERSEDED`) ;
  - **le verrouillage du compte est conservé** ;
  - audit `BREAK_GLASS_FAILED` puis `BREAK_GLASS_LOCKED`.
- **5ᵉ code faux** :
  - la vérification passe `LOCKED`, d'où l'état ARMÉ expiré ;
  - `failed_attempts` est inchangé, et le verrouillage du compte est conservé ;
  - audit `BREAK_GLASS_CODE_LOCKED`.

**Transitions** :

| État ↓ / opération → | `enroll` | `revoke` | `arm(S)` | `complete(S, code)` | `release(S, cible)` |
|---|---|---|---|---|---|
| **ABSENT** | → ACTIF | `NO_VERIFIER` | `NO_VERIFIER` | `NO_VERIFIER` | `NO_VERIFIER` |
| **ACTIF** | Ancien S juste : → ACTIF (nouvelle version). Faux : échec. | → RÉVOQUÉ | Cible invalide : `TARGET_INVALID`, sans effet. S faux : échec. Sinon : → ARMÉ. | `NOT_ARMED` | Compte non verrouillé : `NOT_LOCKED`. S faux : échec. Sinon : compte déverrouillé. |
| **ARMÉ** | `ARMED` | `ARMED` | `ARMED` | S faux : échec. Cible devenue invalide : `TARGET_INVALID`, armement effacé, → ACTIF. Code faux : essai + 1. Succès : → CONSOMMÉ. | `ARMED` |
| **ARMÉ expiré** | Ancien S exigé, comme ACTIF. Armement effacé. | → RÉVOQUÉ, armement effacé | Comme ACTIF. L'ancienne vérification est `SUPERSEDED`. | `EXPIRED` | Comme ACTIF. Si la cible est celle de l'armement, l'armement est effacé (→ ACTIF). |
| **VERROUILLÉ** | `LOCKED` (**il faut d'abord révoquer**) | → RÉVOQUÉ | `LOCKED` | `LOCKED` | `LOCKED` |
| **RÉVOQUÉ** | → ACTIF | `REVOKED` | `REVOKED` | `REVOKED` | `REVOKED` |
| **CONSOMMÉ** | → ACTIF | `CONSUMED` | `CONSUMED` | `CONSUMED` | `CONSUMED` |

L'état ARMÉ passe à ARMÉ expiré au plus tard 15 min après T1, sans opération.

**Sorties** :
- Tout état mène à ACTIF :
  - ARMÉ, par le temps (15 min au plus) ;
  - ARMÉ expiré, par `arm`, `release` ou `revoke` ;
  - VERROUILLÉ, par `revoke` ;
  - RÉVOQUÉ, CONSOMMÉ et ABSENT, par `enroll`.
- Depuis ACTIF, `release`, ou `arm` puis `complete`, lèvent tout verrouillage de compte.
- Aucune de ces opérations n'a besoin d'un administrateur. **Aucun état ne bloque définitivement l'accès administratif.**

**Interruptions** : chaque appel est atomique. Une coupure laisse donc toujours la base dans un état du tableau. Une relance de la commande lit d'abord l'état, l'affiche et ne propose que les opérations permises.

| Moment | État du vérificateur | Compte | Sortie |
|---|---|---|---|
| Avant la validation de T1 | Inchangé | Inchangé | Relancer |
| Après T1 (coupure, code non reçu, adresse erronée, 5 codes faux) | ARMÉ, puis ARMÉ expiré (S non consommé) | Verrouillé, mot de passe intact | `arm` avec les mêmes parts, ou `release` en cas d'erreur de cible |
| Après T1, parts perdues | ARMÉ expiré | Verrouillé | `revoke`, puis `enroll`, puis `arm` ou `release` |
| 5ᵉ S faux | VERROUILLÉ | Verrouillé s'il l'était | `revoke`, puis `enroll`, puis `arm` ou `release` |
| Après T2 | CONSOMMÉ | Déverrouillé, mot de passe inutilisable, nouvelle adresse | Nouvelle cérémonie. L'administrateur passe par « mot de passe oublié ». |

**Vérification `BREAK_GLASS_NEW_EMAIL`** :
- `session_id` est NULL et `token_hash` est NULL ;
- c'est **la seule exception, avec RECOVERY**, à `token_hash` non NULL (§ 3.3). La contrainte et le trigger de création réservée à `cp_privileged` sont étendus à cet usage ;
- elle expire après 15 min et accepte 5 essais ;
- elle est consommée par `complete`, ou passe `SUPERSEDED` lors d'un nouvel `arm`, d'une révocation ou d'un verrouillage du secours.

#### 7.6.6 Verrouillage du compte
**Stockage** : `app.users.bg_locked_at timestamptz NULL` et `app.users.bg_lock_version int NULL` (version du vérificateur qui a posé le verrouillage).

**Invariants garantis par la base** :

| # | Invariant | Mécanisme |
|---|---|---|
| L1 | Les deux colonnes sont toutes deux NULL, ou toutes deux renseignées | `CHECK` |
| L2 | Seul `cp_privileged` peut les modifier | `cp_app` n'a sur elles que `SELECT` (droit par colonne). Un trigger refuse toute modification si `current_user ≠ cp_privileged`. |
| L3 | Le verrouillage n'est posé que sur un `ADMIN` `ACTIVE` | Trigger, vérifié au moment de la pose |
| L4 | Un compte `DELETED` n'est jamais verrouillé | Ajout au `CHECK users_lifecycle`. `priv.anonymize_user` lève le verrouillage, et efface l'armement s'il visait ce compte. |
| L5 | Tant que le compte est verrouillé, la base refuse d'insérer pour lui une session, un jeton de réinitialisation, ou une vérification `LOGIN`, `RECOVERY`, `STEP_UP` ou `EMAIL_CHANGE_*` | Triggers sur `sessions`, `password_reset_tokens` et `auth_challenges`. L'application vérifie aussi en amont, pour renvoyer le message générique de la section 3. |
| L6 | Le verrouillage n'est levé que par `priv.break_glass_complete` (succès), `priv.break_glass_release` ou `priv.anonymize_user` | Conséquence de L2, et des seules fonctions qui le font |
| L7 | Toute pose ou levée est auditée dans la même transaction | `BREAK_GLASS_ARMED`, `BREAK_GLASS_USED`, `BREAK_GLASS_RELEASED` ou `ACCOUNT_ANONYMIZED` |
| L8 | Le verrouillage survit aux changements de rôle et de statut, ainsi qu'à la restauration | Aucune autre opération n'y touche. La restauration le conserve (§ 7.4). |

**Plusieurs comptes peuvent être verrouillés en même temps**, par exemple après un nouvel armement sur une autre cible. `priv.health_summary` expose leur **nombre**, et `monitor.sh` alerte tant qu'un compte reste verrouillé sans armement en cours (code `BG_ACCOUNT_LOCKED`).

**Cible devenue invalide** (rétrogradée, suspendue ou anonymisée entre T1 et T2) :
- `complete` renvoie `TARGET_INVALID`, efface l'armement et ramène l'état à ACTIF, **sans consommer S** ;
- le verrouillage du compte est conservé, sauf en cas d'anonymisation (L4) ;
- **sortie** : `release(S, cible)`, qui n'exige que la présence du verrouillage, quels que soient le rôle et le statut actuels ;
- un compte suspendu le reste après `release` : la suspension relève des parcours normaux des administrateurs.

#### 7.6.7 Signalement : mise en file, transmission, livraison
- Les événements du secours **ne passent pas par Healthchecks** : ils sont rares et non planifiés, alors qu'un check attend des pings périodiques. Signaler une réussite par `/fail` serait faux.

| Étape | Ce qui la prouve | Garantie |
|---|---|---|
| **Événement enregistré** | Ligne d'audit `PRIVILEGED` dans la transaction de l'opération | Base de données, si la transaction est validée |
| **Alerte mise en file** | Email `ADMIN_SECURITY_ALERT` au statut `PENDING`, dans la même transaction | Base de données |
| **Alerte transmise** | Email : statut `ACCEPTED` (accepté par le serveur SMTP). Telegram : réponse positive de l'API, notée par `monitor.sh`. | Preuve **d'acceptation par un tiers**, pas de lecture |
| **Alerte livrée ou lue** | Rien | **Jamais garanti** |

- **`monitor.sh`** :
  - lit dans `priv.health_summary` l'état, la `version` et les **compteurs cumulés** par action `BREAK_GLASS_*`. Toute hausse ou tout changement envoie une alerte Telegram critique. Les compteurs étant cumulés, plusieurs événements survenus entre deux passages sont tous signalés ;
  - envoie l'alerte, puis note la réponse de l'API. En cas d'échec, il réessaie au passage suivant et signale l'échec par email.
- **Codes Telegram**, sans aucune donnée personnelle :

  | Catégorie | Codes |
  |---|---|
  | Opération réussie | `BG_ENROLLED`, `BG_REVOKED`, `BG_ARMED`, `BG_RELEASED`, `BG_USED` |
  | Échec | `BG_FAILED`, `BG_LOCKED`, `BG_CODE_LOCKED` |
  | Interruption | `BG_ARM_EXPIRED`, levé quand l'état ARMÉ expiré est observé sans `BG_USED` ni `BG_RELEASED` |
  | État persistant | `BG_ACCOUNT_LOCKED` (compte verrouillé sans armement en cours) |
  | Anomalie | `BG_COUNTERS_DECREASED`, quand un compteur baisse (attendu après une restauration, § 7.4) |

  Toutes ces alertes sont **critiques**, parce que l'événement est rare, même quand c'est une réussite. Le code distingue réussite, échec et interruption.
- **Commande** : après chaque opération, elle affiche pour chaque alerte son statut, `PENDING`, `ACCEPTED`, `UNCERTAIN` ou `FAILED`, après une attente de 2 min au plus. Elle n'emploie jamais le mot « livrée ».
- **Vivacité** : `monitor.sh` envoie un ping de succès à son check Healthchecks à chaque passage (§ 7.5). L'**absence** de ping est détectée hors du VPS. En revanche, un ping **émis par un `monitor.sh` modifié** ne prouve pas qu'il fonctionne correctement.
- **[Limite]** La base, le worker, `monitor.sh`, le réseau sortant et la file d'emails tournent sur le VPS. **Un opérateur équivalent à root peut les neutraliser** : supprimer la file, arrêter le worker, falsifier `monitor.sh` ou ses pings. Seule une interruption totale des pings reste détectable de l'extérieur. Un appel annulé par `ROLLBACK` ne laisse aucune trace d'audit, donc ne déclenche aucune alerte (§ 7.6.2).

#### 7.6.8 Transmission du secret à PostgreSQL
- S, le HMAC du code et le code passent **uniquement en paramètres liés** (protocole étendu de `pg`, tableau `values`). **Le texte SQL est une constante** : aucune concaténation.
- Réglages PostgreSQL : `log_statement='none'`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`. `auto_explain` n'est pas chargé.
- Les valeurs transmises en paramètres liés ne sont pas écrites dans les journaux **tant que** les deux réglages de longueur valent 0. `log_parameter_max_length` ne peut être changé que par le superutilisateur ; `log_parameter_max_length_on_error` peut l'être par session, par rôle ou pour toute la base : il est interdit dans le code et détecté à l'exécution (G4). **[Limite]** Un accès root ou superutilisateur peut les modifier et journaliser ces valeurs.
- L'absence de ces valeurs dans `pg_stat_activity.query` et `pg_stat_statements` est une **exigence vérifiée par T-05 (b)**, pas une garantie a priori.

#### 7.6.9 Après une utilisation, et risques résiduels
- Après une utilisation : **nouvelle cérémonie obligatoire**.
- Risques résiduels :
  - deux opérateurs de connivence ;
  - un opérateur seul qui révoque, réenregistre, puis utilise ou lève un verrouillage, ce qui est visible mais pas empêché (§ 7.6.3) ;
  - perte d'une part, d'où une révocation puis une nouvelle cérémonie ;
  - dépendance à l'envoi d'emails pour T2. Si le worker est suspendu (§ 7.7), T2 est impossible, mais `release` reste possible ;
  - un accès root peut tout contourner.

### 7.7 Exploitation courante
| Opération | Procédure | Fréquence |
|---|---|---|
| Système | Mises à jour automatiques ; redémarrage du VPS coordonné avec les autres projets [M] | Mensuelle |
| Images | Pull request Renovate, puis le parcours normal | Hebdomadaire |
| PostgreSQL, version mineure | Préproduction d'abord, puis production avec une sauvegarde avant | — |
| PostgreSQL, version majeure | Sauvegarde, puis restauration en préproduction, puis exercice complet, puis fenêtre de maintenance | Rare |
| Contrôle des migrations | `migrate --check-only` | Mensuel |
| Contrôle de restaurabilité | Intégré à `backup.sh` | Quotidien |
| **Exercice de restauration** | `restore.sh` complet **en préproduction**, avec ses propres sauvegardes et sa clé, **durée mesurée** (« hors chemin opérateur ») | **Hebdomadaire** (section 5) |
| Exercice de déchiffrement | Sauvegarde de production téléchargée depuis B2 et déchiffrée **avec chacune des deux clés** hors ligne, puis `pg_restore --list` et comparaison avec le fichier de contrôle ; 20 fichiers tirés au hasard, déchiffrés et comparés par SHA-256. **Une fois par trimestre**, le chemin complet est chronométré (téléchargement depuis B2, déchiffrement sur le poste, transfert vers `backups/tmp` sur le VPS, puis suppression), et les temps sont versés au rapport du RTO (HY-13). | Mensuel, sur le poste de chaque opérateur |
| Disque plein | `docker system df`, journaux, `backups/tmp`. **Jamais `docker volume prune`.** | Sur alerte |
| Manque de mémoire | `docker stats`, `dmesg`. La préproduction est arrêtée en premier. | Sur alerte |
| Traitement bloqué | `ops jobs:status`. Un bail expire en 2 min. Sinon, redémarrer le worker. | Sur alerte |
| Suspendre le worker | `docker compose stop worker`. ⚠️ Plus aucun code administrateur n'est envoyé : la connexion ne se fait plus que par récupération. | Exceptionnel |
| Rotation des secrets | Fiches du § 7.10 | Annuelle, ou en cas d'incident |

**Documentation minimale**, dans `docs/ops/` : `RUNBOOK.md`, `SECRETS-INVENTORY.md`, `ACCESS.md`, `INCIDENTS.md`, `deployments.log`.

### 7.8 Déploiements et migrations
**Construction** (GitHub Actions) :
- une image API (qui contient aussi le worker et Prisma) et une image web, avec les étiquettes `sha-<commit>` ;
- **déploiement toujours par empreinte** ;
- `release.json` : commit, empreintes et classification des migrations.

**Prisma figé en version `7.10.0`** (`prisma` et `@prisma/client`, versions exactes) :
- pas de version candidate en production ;
- le passage à la version 8 (`db migrate`) fera l'objet d'une décision séparée, avec ses propres tests ;
- la documentation de la version 7 ne précise ni la transactionnalité, ni le verrou de `migrate deploy`. **Aucune supposition n'est faite** (tâche T-01).

**Classification des migrations** (en-tête de chaque fichier et description de la pull request) :
- `expand`, `contract` ou `irreversible` ;
- l'intégration continue refuse `DROP`, `ALTER … TYPE` et `RENAME` dans une migration `expand` ;
- schéma « étendre, puis contracter » : une migration est toujours compatible avec le code de la version précédente.

**Migration transactionnelle** :
- `BEGIN;` et `COMMIT;` **explicites** dans le fichier, validés par T-01 ;
- en cas d'échec, rien n'est appliqué. Correction, puis `prisma migrate resolve --rolled-back <nom>`, puis nouveau déploiement.

**Migration non transactionnelle** :
- une seule instruction par fichier, **seulement** pour une migration `expand` ;
- requête de vérification et procédure de reprise écrites dans le fichier, et exécutées par `ops migrate:verify <nom>` ;
- **`IF NOT EXISTS` ne garantit pas que l'objet existant est le bon.** Les contrôles avant `resolve --applied` ou un nouvel essai sont :

  | Objet | Contrôle |
  |---|---|
  | Index | `pg_index.indisvalid = true` **et** `pg_get_indexdef(oid)` identique à la définition attendue. Sinon : `DROP INDEX CONCURRENTLY`, puis `--rolled-back`, puis un nouvel essai. |
  | Valeur d'énumération | `pg_enum` |
  | Contrainte `NOT VALID` puis `VALIDATE` | `pg_constraint.convalidated` **et** `pg_get_constraintdef` identique |

**`deploy.sh <env> <sha> <digest-api> <digest-web>`** :
1. `flock`.
2. `.env.next`, avec les nouvelles empreintes, puis `docker pull`. En production, ces empreintes doivent déjà avoir été déployées en préproduction (`staging/deployed.json`).
3. Sauvegarde avant déploiement, vérifiée. Échec : arrêt.
4. **Migration avec l'image cible** : `docker compose --env-file .env.next --profile ops run --rm migrate`, avec un contrôle de l'empreinte de l'image en cours d'exécution.
5. `mv .env.next .env`, puis le worker (on attend un passage d'`email.send`, 90 s au plus), puis l'API (en bonne santé), puis le web. **Il y a une interruption de quelques secondes.**
6. Tests de fumée, puis enregistrement dans `deployments.log`.

**Retour arrière** (on ne prétend jamais annuler le schéma) :

| Cas | Retour arrière |
|---|---|
| `expand` appliquée, application défaillante | Retour automatique aux empreintes précédentes. **Le schéma reste dans son nouvel état.** |
| Migration non transactionnelle partielle | L'ancienne application continue. Reprise selon le fichier. |
| Migration transactionnelle en échec | Rien à annuler |
| `contract` ou `irreversible` | Fenêtre de maintenance, sauvegarde vérifiée et exercice de restauration de moins de 30 jours **obligatoires**. En cas d'échec : corriger et redéployer, **ou** restaurer la sauvegarde d'avant déploiement (les écritures postérieures sont perdues). |

**Autres règles** :
- L'API reste compatible avec la SPA précédente pendant une version. La SPA compare l'en-tête `X-App-Version` et propose de recharger la page.
- **Validation de la mise en production** : manuelle. Pour un dépôt privé sur l'offre gratuite, la disponibilité des règles de protection des environnements est [À vérifier]. À défaut, un `workflow_dispatch`.

### 7.9 Intégration continue : quotas et consommation
**Quotas officiels** (consultés le 12/10/2026) :

| Offre (dépôt privé) | Minutes par mois | Stockage d'artefacts |
|---|---|---|
| Free | 2 000 | 500 Mo |
| Pro | 3 000 | 1 Go |
| Team | 3 000 | 2 Go |

- Au-delà du quota : 0,006 $ par minute sur un runner Linux à 2 cœurs.
- Les runners auto-hébergés sont présentés comme gratuits. Leur tarif actuel pour un dépôt privé est **[À vérifier]** avant de retenir l'option c de D-1.
- **GHCR** : stockage et transfert actuellement gratuits, avec un préavis d'un mois avant tout changement. GHCR est donc retenu, sans transfert `docker save | ssh`.

**Consommation estimée**, sans réduire aucune fréquence de la section 5. **À remplacer par la mesure de T-12.**

| Suite | Volume par mois | Durée réelle (min) | Minutes facturées |
|---|---|---|---|
| Rapide | 60 | 600 | × k |
| Intégration | 40 | 800 | × k |
| Bout en bout et images | 20 | 500 | × k |
| Préproduction et fumée | 20 × 5 | 100 | × k |
| Nuit | 30 × 60 | 1 800 | × k |
| **Suite étendue** | **N mises en production × ~60** | **60 N** (par exemple 240 à 480 pour N de 4 à 8) | × k |
| **Total** | | **≈ 3 800 + 60 N** | **Inconnu avant T-12** |

- **k** : rapport entre minutes facturées et durée réelle. GitHub facture **chaque job**, arrondi à la minute supérieure, de sorte que les jobs parallèles et les matrices s'additionnent. **k ≥ 1, valeur inconnue**, mesurée par T-12.
- **Règles de déclenchement** :
  - pas de double exécution `push` et `pull_request` pour un même commit de branche ;
  - tous les navigateurs, WebKit compris, tournent sur des runners **Linux** ;
  - **durée de conservation des artefacts** : paramètre de **D-1**. Elle doit être explicite (pas la valeur par défaut de GitHub), et son effet sur le stockage est mesuré par T-12.
- **Interprétation de la règle « dernière nuit réussie » (§ 5.6)** : la **dernière exécution planifiée** de la suite de nuit (et non la dernière exécution réussie) doit être **réussie** et avoir **démarré il y a moins de 36 h**. Une nuit absente, par exemple parce que le budget est atteint ou que le planificateur ne l'a pas lancée, **bloque** la mise en production, comme une nuit en échec.

**Suite étendue sur le commit exact de production**, identique à la suite de nuit, sans rien retirer :
1. concurrence ×20 ;
2. test aléatoire de 200 itérations avec les invariants SQL ;
3. tous les tests de reprise, y compris Toxiproxy et le script de restauration sur des données synthétiques ;
4. **ZAP en mode passif** contre une pile Compose éphémère.
   - Statut : non bloquant (section 5).
   - **Toute alerte haute non examinée bloque la mise en production** à l'étape de validation manuelle.

**Aucun contrôle de la section 5 ne disparaît.**

**[D-1]** Décision de développement (§ 10) ; suite de nuit et suites étendues à financer avant la production.

### 7.10 Journaux et incidents
- **À journaliser** : requêtes (route modèle, code, durée, `request_id`, identifiant d'utilisateur, IP), authentification, refus d'autorisation, traitements, transitions des emails (identifiants seulement), erreurs.
- **À exclure** : secrets, jetons, cookies, codes, contenus, corps des emails, adresses email.
- **Conservation** : 14 jours.
- **Secret compromis** : remplacer le fichier, puis redémarrer le service concerné. Effets particuliers :

  | Secret | Effet de la rotation |
  |---|---|
  | `OTP_PEPPER` | Les codes en cours deviennent invalides |
  | `OUTBOX_PAYLOAD_KEY` | Les emails de code en attente sont annulés |
  | `IDEMPOTENCY_KEY` | Un nouvel essai d'envoi à cheval sur la rotation peut recevoir `409` |
  | Identité d'un rôle PostgreSQL **[C — conditionnel T-01]** | Nouveau certificat émis hors ligne, ancien certificat inscrit dans la liste de révocation, redémarrage du service |

  L'incident est inscrit au registre.
- **Accès administrateur suspect** : un autre administrateur suspend le compte, puis on examine l'audit (`source`, `db_login_role`). S'il n'y a qu'un administrateur : procédure du § 7.6.
- **VPS compromis** :
  1. maintenance, puis instantané du disque chez le fournisseur ;
  2. tous les secrets du VPS sont considérés comme compromis ;
  3. reconstruction sur un **nouveau VPS** à partir de Git et de la **dernière sauvegarde B2 antérieure à l'incident** ;
  4. rotation de tous les secrets (R2, B2, SMTP, identités PostgreSQL, et paires age pour les sauvegardes futures) ;
  5. réinitialisation des mots de passe des administrateurs ;
  6. information des responsables des autres projets du VPS.
- **Fuite de données** :
  1. contenir ;
  2. préserver les preuves (chiffrées, avec un accès restreint) ;
  3. évaluer à partir des identifiants, sans relire les contenus ;
  4. [À vérifier] les obligations de notification prévues par la CDP ;
  5. informer les personnes concernées.

### 7.11 Coûts et quotas
| Poste | Gratuit | Risque | Repli |
|---|---|---|---|
| GitHub Actions | 2 000 min par mois | **Dépassé** (≈ 3 800 + 60 N, × k) | D-1 |
| GHCR | Actuellement gratuit | Changement avec un mois de préavis | Réévaluation à ce moment-là |
| R2 | Offre gratuite [À vérifier], moyen de paiement probablement requis | Moyen | Réduire les quotas |
| B2 | Offre gratuite [À vérifier] | Moyen (fichiers et sauvegardes) | Coût marginal [À vérifier] |
| Healthchecks.io | ~20 checks [À vérifier], besoin d'environ 13 | Faible | — |
| UptimeRobot | [À vérifier] | Faible | — |
| Sentry | Quota mensuel [À vérifier] | Moyen | Échantillonnage, filtrage des `4xx` |
| SMTP | Selon le fournisseur [À vérifier] | Moyen | `EMAIL_MAX_PER_HOUR`, récapitulatif quotidien |
| Gemini | Offre gratuite [À vérifier] | Moyen | Plafond global et mode dégradé |
| VPS temporaire de charge | Paiement à l'heure [À vérifier] | Faible | **Jamais sur le VPS de production** |

---

## 8. Registre des hypothèses
| # | Hypothèse | Statut | Vérifiée par |
|---|---|---|---|
| HY-01 | Prisma 7.10.0 : comportement transactionnel, verrou consultatif, compatibilité avec PostgreSQL 18 ; **[C]** prise en charge par `migrate deploy` de `sslidentity`, `sslpassword` et `sslaccept=strict` | À vérifier | T-01 |
| HY-02 | Comportement de B2 : masquage d'une version verrouillée, `rclone sync` et `delete` qui masquent, cycle de vie après la fin du verrouillage et délais réels, `rclone check` sans `readFiles`, gros fichiers, restriction des clés par bucket | À vérifier | T-06 |
| HY-03 | Chiffrement au repos de R2 ; R2 sans versions ni verrouillage utilisables ici | À vérifier | T-08 |
| HY-04 | `logging: driver: none` avec `tty: true` : rien n'est écrit par Docker | À vérifier | T-04 et test de la section 3 |
| HY-05 | Groupes supplémentaires et droits de l'hôte suffisants pour les secrets (sans `uid`, `gid` ni `mode` de Compose) ; image `postgres` en `user: 999` avec `group_add` ; **[C]** clé du serveur `root:cp-postgres 0640` acceptée | À vérifier | T-09 |
| HY-06 | Reverse proxy en place sur le VPS | Inconnu | T-10 |
| HY-07 | GitHub privé, GitHub Actions et GHCR (H1, H2) ; protection des environnements sur l'offre gratuite | Hypothèse de travail | T-12 |
| HY-08 | Consommation de l'intégration continue ≈ 3 800 + 60 N minutes par mois en durée réelle, facteur k inconnu | Estimation | T-12 |
| HY-09 | Seuils de charge C1 à C8 | Proposés, non validés | T-11 |
| HY-10 | Mémoire réelle de 0,6 à 0,9 Go en production | Estimation | T-11 |
| HY-11 | 60 membres par classe, 20 messages par seconde, 2 appareils par utilisateur, volume H5 | Hypothèse | T-11 |
| HY-12 | IP partagées (NAT, CGNAT) | Hypothèse | T-11 (C1, C6, C6b) |
| HY-13 | RTO de 4 h | Non démontré | T-03 (hors chemin opérateur) et chronométrage trimestriel (§ 7.7) |
| HY-14 | Offres gratuites de R2, B2, Healthchecks, UptimeRobot, Sentry, Gemini ; limites du fournisseur SMTP | À vérifier | Au moment de la souscription |
| HY-15 | Conditions de Gemini gratuit (réutilisation des données, quotas) | À vérifier | Avant la mise en production |
| HY-16 | Obligations de la loi sénégalaise 2008-12 (CDP) | À vérifier | Avant la mise en production |
| HY-17 | Liste des domaines autorisés pour les liens (Google Drive et Docs, plus d'autres à valider) | À compléter | Configuration |
| HY-18 | Valeur du plafond global quotidien de l'IA et de `EMAIL_MAX_PER_HOUR` | À fixer | Configuration, puis mesure |

---

## 9. Tâches à traiter pendant l'implémentation
| # | Tâche | Validée quand | Où |
|---|---|---|---|
| T-01 | Prisma `7.10.0` | Tests T1 à T4 réussis : atomicité (avec et sans `BEGIN`/`COMMIT`), deux migrations simultanées (verrou observé dans `pg_locks`), `resolve` après un échec, index interrompu. La règle `BEGIN`/`COMMIT` est confirmée ou revue avant la première version. **[C]** `migrate deploy` réussit avec `sslidentity`, `sslpassword` et `sslaccept=strict`, et échoue face à un serveur présentant un certificat d'une autre autorité ou un nom d'hôte faux. Aucune URL avec secret dans l'environnement. **En cas d'échec de la partie C, la méthode d'authentification de `cp_owner` est soumise à décision.** | Intégration continue |
| T-02 | `restore-step6.sql` | Réussite : époque changée, sessions et vérifications closes, email `ADMIN_OTP` annulé, audit `PRIVILEGED`/`postgres`, secours passé à RÉVOQUÉ avec l'audit `BREAK_GLASS_REVOKED` (`RESTORE`), **même `xmin`** sur toutes les lignes modifiées. Verrouillages de comptes (`bg_locked_at`, `bg_lock_version`) conservés. Contrôle `break_glass_not_revoked` déclenché quand on retire la mise à jour. Échec provoqué (`REVOKE INSERT` en test) : aucun changement. Insertion sans `cp_privileged` refusée. Aucun droit ajouté à `cp_app`. | Intégration continue |
| T-03 | `restore.sh` complet (authentification `peer`, `exec -u postgres`) | **Trois réussites de suite**, avec une durée notée « hors chemin opérateur », qui ne démontre pas le RTO. Échec simulé à chaque étape critique, avec maintenance et `NOLOGIN` conservés. Contrôles de l'étape 9 en échec quand on retire volontairement un réglage de `cp_app` ou un `REVOKE`. **Étape 8** : interruption forcée (`SIGKILL` de `restore.sh` et de `psql`, arrêt du conteneur `postgres`, redémarrage de l'hôte) avant 8a, entre 8a et 8b, et après 8b ; à chaque fois, `--resume` identifie la situation d'après les commentaires, et aboutit à `--forward` ou `--back` sans perte ; une deuxième reprise ne produit aucun effet ; toute combinaison incohérente de bases provoque un arrêt ; comportement de `BEGIN; RENAME; RENAME; COMMIT;` observé et noté, sans être adopté. Restauration sur une base vide tout juste initialisée. Refus à l'étape 0 quand l'espace disque est insuffisant (simulé). | Préproduction |
| T-04 | Secours à deux parts | **Secret et logique** : une part seule, ou une part arbitraire, est refusée ; une somme de contrôle fausse est rejetée sans appel à la base ; le vérificateur transmis à la place de S est refusé ; un ancien S est refusé après une nouvelle cérémonie ; la réutilisation après CONSOMMÉ est refusée. **Transitions** : chaque case du tableau du § 7.6.5 ; un refus dû à l'état ne compte pas comme un échec ; 5ᵉ S faux pendant ARMÉ, VERROUILLÉ, armement effacé, verrouillage du compte conservé ; 5ᵉ code faux, ARMÉ expiré, `failed_attempts` et `second_factor_failures` inchangés ; `enroll` depuis VERROUILLÉ refusé ; révocation puis `enroll`, `REVOKED` puis `ENROLLED` avec `old_secret_presented = false`. **Transactions** : S faux dans `BEGIN … ROLLBACK`, aucune trace persistée (comportement constaté et documenté) ; S juste dans `BEGIN … ROLLBACK`, aucun effet ; avec la commande officielle, l'échec est persisté et relu ; la commande refuse une connexion déjà en transaction. **Concurrence** : deux `arm` simultanés donnent un ARMÉ et un `ARMED` ; deux `complete` simultanés, un seul succès ; un enregistrement simultané à un `arm` est sérialisé. **Verrouillage du compte** : invariants L1 à L8 ; `cp_app` ne peut pas modifier les colonnes ; les insertions de session, de jeton de réinitialisation et de vérification sont refusées pour un compte verrouillé ; l'anonymisation lève le verrouillage. **Sorties** : `release` après une erreur de cible ; révocation depuis ARMÉ expiré ; nouvelle cérémonie puis `release` ; cible rétrogradée entre T1 et T2, `TARGET_INVALID`, puis `release` réussit. **Interruptions** : `SIGKILL` après T1, compte verrouillé (connexion, réinitialisation et récupération refusées), puis relance avec les mêmes parts après l'expiration, réussie ; adresse erronée puis relance avec la bonne adresse, réussie ; `SIGKILL` après T2, une relance renvoie `CONSUMED`. **Exposition** : selon T-05 (b) et (c), pour toutes les opérations du secours. **Droits** : `cp_app` et `cp_monitor` sans `EXECUTE` ; `SELECT` direct sur `priv.break_glass` refusé, y compris à `cp_ops`. **Signalement** : audit et alertes présents pour chaque événement ; chaque code `BG_*` observé par `monitor.sh` ; deux événements dans le même intervalle de 5 min tous deux signalés ; statut de chaque alerte (`PENDING`, `ACCEPTED`, `FAILED`) affiché sans le mot « livrée » ; un arrêt de `monitor.sh` fait passer son check Healthchecks « down ». | Intégration continue, puis préproduction |
| T-05 | Secrets absents des traces PostgreSQL | Voir le détail ci-dessous | Intégration continue |
| T-06 | Protocole `cp-locktest-<date>` sur B2 (§ 7.3.5, étapes 0 à 12) | Résultats notés. Les étapes 3, 7, 7 bis (raccourcissement et changement de mode) et 8 sont refusées. L'étape 10 réussit. Délais réels du cycle de vie consignés, et comportement du masquage, de `sync` et des clés noté. Étapes 0 et 8 rejouées sur chaque bucket de production. **Tant que ce n'est pas fait : immuabilité « à vérifier ».** | Backblaze, bucket dédié |
| T-07 | Copie chiffrée des fichiers | Contrôle quotidien cohérent. Déchiffrement mensuel de 20 fichiers avec des SHA-256 identiques. Récupération depuis le poste d'un opérateur réussie. Aucune clé privée sur le VPS. | Préproduction, postes des opérateurs |
| T-08 | Chiffrement au repos de R2 | Confirmé par la documentation officielle (sans effet sur la confidentialité vis-à-vis du fournisseur) | Documentation |
| T-09 | Secrets, utilisateurs Docker, port 3001, rotation des journaux | Démarrage sans erreur de droits ; un conteneur ne voit aucun secret d'un autre service ; `docker inspect` ne montre ni secret ni URL avec secret ; `/proc/*/environ` de chaque conteneur (`api`, `worker`, `migrate`, `ops`, `backup`, `postgres`) ne contient la valeur d'aucun secret ; première initialisation de `postgres` réussie avec `user: 999` et le secret lu par le groupe ajouté (sinon, erreur exacte notée et solution revue) ; secret du superutilisateur absent du conteneur après l'initialisation ; `backup` lit ses secrets, écrit dans `backups/tmp`, et les fichiers créés y sont `rw` pour le groupe `cp-backup` seulement ; `/api/health/ready` en `404` de l'extérieur ; fichiers de plus de 14 jours supprimés. **[C]** Connexion par certificat de chaque rôle depuis son service ; refus sans certificat ou avec un certificat révoqué ; clé du serveur `root:cp-postgres 0640` acceptée avec `user: 999` ; alerte d'expiration déclenchée par un certificat de test. | Préproduction |
| T-10 | Reconnaissance du VPS : reverse proxy, opérateurs A et B, canal Telegram, `ACCESS.md` | Inventaire rédigé et accès vérifiés pour chaque opérateur. Aucun autre projet modifié sans accord. | VPS réel |
| T-11 | Charge C1 à C8 | Mesurés sur un VPS temporaire, puis seuils acceptés ou révisés par le responsable. 0 perte et 0 doublon. | VPS temporaire |
| T-12 | Consommation de l'intégration continue | Mesure du premier mois depuis le rapport d'usage de facturation : minutes facturées par workflow et par job, valeur de k, nombre N de suites étendues. Stockage des artefacts mesuré, avec la conservation explicite issue de D-1. Absence de doubles déclenchements et de runner macOS vérifiée. Tableau du § 7.9 recalculé. Plafond réajusté au-dessus de la consommation mesurée, avec des alertes de dépenses actives. Un essai montre qu'une nuit non exécutée bloque bien la validation de mise en production. | GitHub |
| T-13 | ZAP en mode passif | Aucune alerte haute non examinée au moment de la validation de mise en production | Intégration continue |

**Détail de T-05**

**Garanties attendues en production** (à démontrer par les tests ci-dessous ; ce ne sont pas des acquis) :
- G1. Aucun secret de connexion n'existe côté serveur : `rolpassword` est NULL pour `cp_owner`, `cp_app`, `cp_ops` et `cp_monitor` **[C]**. Le mot de passe du superutilisateur n'est fourni qu'à l'initialisation.
- G2. **Exigence** : toute requête qui transmet S, un code ou un jeton le fait **uniquement par paramètres liés**, avec un texte SQL constant et sans concaténation. **Vérification** : le test (b) contrôle explicitement que ces valeurs sont absentes de `pg_stat_activity.query` et de `pg_stat_statements` dans la configuration testée.
- G3. Avec la configuration de production (`log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`, `log_statement='none'`), les valeurs de ces paramètres ne sont écrites dans aucun journal, même si une instruction est lente ou en erreur.
- G4. `log_parameter_max_length` ne peut être modifié que par le superutilisateur. `log_parameter_max_length_on_error` (contexte `user`) peut être modifié **par session** (`SET`), **durablement sur son propre rôle** (`ALTER ROLE … SET`) par `cp_app`, `cp_ops` et `cp_monitor`, et **pour toute la base** (`ALTER DATABASE … SET`) par son propriétaire `cp_owner` (constaté par T-05). PostgreSQL ne permet pas de l'interdire. **Garde-fou** : aucune de ces formes dans le code, les migrations ni les scripts SQL (test automatique). **Détection** : l'API se déclare non prête (`/api/health/ready` en 503, `/api/health` dégradé) si un réglage `log_*` est enregistré sur un rôle ou sur la base. **Limite conservée** : un accès root ou superutilisateur peut changer ces réglages pour tout le serveur et journaliser ces valeurs.

**Tests d'acceptation** :
- (a) **Absence de secret de connexion (G1)** : `rolpassword` NULL pour les quatre rôles. Aucune instruction ne contient de mot de passe, de vérificateur ou de clé. Le mot de passe du superutilisateur est absent des journaux, avec une journalisation complète forcée dès le premier démarrage.
- (b) **Test structurel de journalisation forcée (G2)** : `log_statement=all`, `log_min_duration_statement=0`, `log_parameter_max_length=-1`, `log_parameter_max_length_on_error=-1`, suivi des instructions utilitaires actif dans `pg_stat_statements`, et une erreur provoquée.
  - Le client est intercepté : le texte SQL envoyé est constant et les valeurs passent par des paramètres liés.
  - Attendu : S, les codes et les jetons sont **absents** du texte des instructions, de `pg_stat_activity.query` (capturée pendant l'exécution) et de `pg_stat_statements`.
  - Leur présence dans les lignes « parameters: » du journal est **attendue** dans ce mode : elle prouve l'usage de paramètres liés. **Ce test ne vérifie pas l'absence de secrets dans les journaux.**
- (c) **Configuration de production (G3)** : les réglages de production, puis `log_statement=all` et `log_min_duration_statement=0` forcés **sans toucher** aux deux réglages de longueur, avec une erreur provoquée. Attendu : aucun S, code ni jeton dans les journaux.
- (d) **Droits (G4)** : `cp_app`, `cp_ops` et `cp_monitor` ne peuvent pas modifier `log_parameter_max_length` ; les trois formes de modification de `log_parameter_max_length_on_error` (session, rôle, base) sont caractérisées ; aucune n'apparaît dans le code, les migrations ou les scripts SQL ; un réglage `log_*` enregistré rend l'API non prête.

Opérations couvertes : initialisation, rotation d'une identité, `admin-recovery-code` et toutes les opérations du secours.

---

## 10. Décisions ouvertes
| # | Décision | Options et paramètres | À trancher avant |
|---|---|---|---|
| **D-1** | Financement de l'intégration continue | **Décidé le 2026-10-13 (phase de développement)** : rester dans l'offre gratuite (2 000 min/mois), plafond de dépenses 0 $, artefacts conservés 3 jours ; seuls les workflows rapide et intégration sont actifs. **À revoir avant la première mise en production** : la suite de nuit exigée par le § 5.6 n'est pas encore financée. Options examinées (historique) : **(a)** offre Free avec dépassement payé : environ (3 800 + 60 N − 2 000) × k × 0,006 $ par mois. **(b)** offre Pro avec dépassement (prix de l'offre [À vérifier]). **(c)** runner auto-hébergé sur une petite machine dédiée, **jamais le VPS de production** : tarif [À vérifier], une machine de plus à sécuriser, isolation par conteneurs éphémères nécessaire. **À fixer aussi** : plafond de dépenses du premier mois (avant toute mesure) et seuils d'alerte ; durée de conservation des artefacts. Après T-12, le plafond est réajusté **au-dessus** de la consommation mesurée, pour ne pas bloquer les nuits. | La mise en place de l'intégration continue (lot 0) |
| **D-2** | Durées B2 | Durées du mode conformité L (8, 29, 181 et 30 jours proposés) ; `daysFromHidingToDeleting` des buckets de sauvegarde ; conservation du préfixe `manifests/` (supérieure à 90 jours) | Après T-06, avant la création des buckets de production |

---

## 11. Limites connues et risques acceptés (rappel, sans nouvelle analyse)
- **Emails** :
  - un doublon reste possible pour un envoi ambigu ;
  - `ACCEPTED` ne signifie pas « livré » ;
  - les rebonds ne sont pas suivis.
- **Second facteur des administrateurs** : dépend de la boîte email et de la disponibilité du service d'envoi.
- **Anonymisation** : les titres, le contenu des fichiers et les messages sont conservés.
- **Option B** : une compromission de `cp_app` peut abîmer les contenus. Les protections restent l'audit `PRIVILEGED`, les sauvegardes et le moindre privilège.
- **Root sur le VPS** : il peut contourner toute protection applicative, neutraliser les alertes et journaliser les paramètres.
- **Secours** :
  - la séparation entre deux opérateurs est procédurale ;
  - un contournement par une seule personne est détectable, pas empêché ;
  - le compteur d'échecs peut être annulé par un appelant hors de la commande officielle ;
  - une alerte mise en file ou acceptée n'est pas une alerte lue.
- **Fichiers dans R2** : lisibles par Cloudflare.
- **B2** :
  - le verrouillage ne protège chaque objet que pendant L jours ;
  - les délais du cycle de vie sont des minimums, sans heure garantie.
- **Restauration** :
  - doublons d'emails possibles, anciens mots de passe redevenus valides, fichiers orphelins ;
  - nouvelle cérémonie de secours obligatoire ;
  - dump en clair sur le poste d'un opérateur pendant le transfert ;
  - pas de restauration à un instant précis.
- **RTO** : non démontré, et dépendant de la disponibilité d'un opérateur.
- **Limites par IP plus hautes** : essai d'un même mot de passe sur jusqu'à 100 comptes par quart d'heure depuis une seule IP, et iniquité derrière une IP partagée.
- **Inscription** : l'énumération des comptes est réduite, pas supprimée.
- **Rappels** : pas de J-1 pour un devoir créé entre le dernier passage avant minuit et minuit.
- **Fonctionnalités absentes** : pas de file d'envoi hors ligne, pas de compteur de non-lus dans le chat, pas de signalement de messages.
- **Déploiement** : une interruption de quelques secondes à chaque mise à jour (une seule instance).
- **Volume des rappels** : un seul email par jour et par étudiant, donc pas d'email pour un rappel apparu après le récapitulatif.

---

## 12. Suite du projet
1. Relecture et validation de cette spécification par le responsable du projet.
2. Conception UI/UX, menée pendant que les tests opérationnels sont réalisés aux étapes prévues.
3. Plan d'implémentation (skill writing-plans), **découpé en lots** livrables et testables :
   - lot 0 : fondations (monorepo, intégration continue, rôles et schémas, Prisma 7.10.0, Testcontainers ; T-01, T-05 ; en parallèle T-06 et T-10) ;
   - lot 1 : identité ;
   - lot 2 : classes ;
   - lot 3 : contenu ;
   - lot 4 : temps réel ;
   - lot 5 : traitements planifiés ;
   - lot 6 : recherche, statistiques, puis assistant ;
   - lot 7 : exploitation (T-02 à T-04, T-07, T-09) ;
   - validation (T-11, T-13, T-03) ;
   - pilote sur une classe, puis mise en production.

   Les interfaces sont construites au fil des lots 1 à 6.
