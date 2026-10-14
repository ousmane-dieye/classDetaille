# ClassePulse V2 — Lot 1b : Emails et administrateurs — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** une file d'emails fiable (`email_outbox`, états et politique de reprise du § 2.4) servie par un processus worker (traitement `email.send`, baux, réservation atomique, résultat ambigu), et, par-dessus, les parcours qui en dépendent : code administrateur par email à la connexion (qui remplace le `403 ADMIN_SECOND_FACTOR_REQUIRED` du lot 1a), code de récupération émis par `ops admin-recovery-code`, vérification supplémentaire (`STEP_UP`) et ressaisie du mot de passe, changement d'email d'un administrateur, « mot de passe oublié ».

**Architecture :** deux processus partagent le même code : l'API (`src/main.ts`, enfile des emails dans la transaction métier) et le worker (`src/worker.ts`, seul à parler SMTP). Le module `mail` contient la file (dépôt en SQL paramétré brut, jamais `create` de Prisma), le chiffrement des secrets (AES-256-GCM), la politique de reprise (fonction pure), les modèles de texte et le transport SMTP ; le module `jobs` ordonnance les traitements du worker avec des baux (`job_leases`). Le module `auth` gagne un sous-dossier `second-factor/` (codes à 6 chiffres, vérifications `auth_challenges`, échecs, blocage, alertes) utilisé par la connexion, la vérification supplémentaire et le changement d'email. La récupération passe par une fonction `priv.issue_admin_recovery_code` (SECURITY DEFINER, propriétaire `cp_privileged`) appelée par une commande `ops` qui n'utilise ni Prisma ni Nest.

**Tech Stack :** celui du lot 1a, plus `nodemailer` (transport SMTP), `pg` direct pour `LISTEN`/`NOTIFY` et pour la commande `ops`. Mailpit (déjà dans `docker-compose.dev.yml`) reçoit les emails en développement.

**Spec :** `docs/superpowers/specs/2026-10-13-classepulse-v2-design.md` (§ 0.7, § 1.4, § 2.2 « Identité et sessions » et « Emails », § 2.4, § 2.5, § 3.2, § 3.3, § 3.4, § 5.4, § 7.6.7) et `docs/superpowers/specs/2026-10-13-classepulse-v2-ux-design.md` (§ 2 P2, § 3.2 codes d'erreur). Feuille de route : `docs/superpowers/plans/2026-10-13-classepulse-v2-roadmap.md` (« Décisions du responsable sur le lot 1 »). Plan précédent : `docs/superpowers/plans/2026-10-14-classepulse-v2-lot1a-api-identite.md` (Rulings R1 à R15, repris ici quand ils s'appliquent encore).

**Hors périmètre (ne pas faire) :** `job_runs`, Healthchecks.io, purge des sessions et des vérifications, tous les traitements autres que `email.send` et la purge horaire des seaux (lot 5) ; suppression de compte (lot 2) ; écrans M8, M13 et leurs variantes (lot 1c) ; verrouillage de secours `bg_locked_*` et `BREAK_GLASS_*` (lot 7) ; modèles WELCOME, REFUSAL, DIGEST, ANNOUNCEMENT, ADMIN_ALERT (lots 2 à 4) ; empaquetage, `ulimit -c 0` et `logging: driver: none` de la commande `ops` (lot 7). **D-2 (durées B2) n'est pas concernée par ce lot.**

## Global Constraints

Reprises du lot 1a (elles s'appliquent encore) :

- Toutes les dépendances en **version exacte** (`pnpm add -E`), `pnpm-lock.yaml` committé ; `pnpm audit --audit-level high` reste vert.
- **Seuls les `*.repository.ts` importent Prisma** (plus `src/database/`) ; un module n'importe jamais le repository d'un autre (dependency-cruiser).
- **Chaque méthode publique d'un service métier prend un `Actor`** et commence par `authz.assert(actor, action)` (§ 1.2, règle 6). Exceptions déjà admises : les primitives d'authentification sans acteur (R13 du lot 1a).
- Identifiants **UUID v7 générés par l'application** (sauf les lignes écrites par une fonction SQL : `uuidv7()` de PostgreSQL 18) ; seul `audit_log.id` est un `bigint` auto-incrémenté.
- Email : `normalizeEmail` (espaces, NFKC, minuscules), ASCII uniquement, colonne `citext`. Mots de passe : **15 caractères minimum (USER), 16 (ADMIN), 128 au maximum, refus au-delà, jamais de troncature**, NFKC dans tous les parcours, liste de mots de passe courants, **Argon2id 19 Mio / 2 itérations / parallélisme 1 / 4 calculs simultanés au plus**.
- Cookie de session `__Host-cp_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sans `Domain`), jeton de 32 octets, seul son SHA-256 est stocké ; une session invalide donne `401` avec effacement du cookie aux **mêmes attributs** ; `last_seen_at` au plus toutes les 5 min ; nouveau jeton à chaque connexion.
- Révocation **logique** ; motifs LOGOUT, PASSWORD_CHANGED, ROLE_CHANGED, SUSPENDED, ANONYMIZED, EMAIL_CHANGED, ADMIN_REVOKED, OTHER_DEVICES, RESTORE.
- Expirations de sécurité comparées à **`clock_timestamp()`**, jamais à `now()`.
- CSRF (refus par défaut, toute requête qui modifie), **seul `application/json`**, champs inconnus rejetés, corps de 100 Ko au plus, un DTO de sortie explicite par route, **pas de trace d'exécution**, un `request_id` partout. Un corps JSON vide est refusé (`400 INVALID_JSON`) : les clients envoient `{}` ; toute route modifiante sans corps utile valide `EmptyBody` (schéma strict).
- Limitation générale `@nestjs/throttler` : 300 requêtes par minute et par session, 600 par IP.
- Journaux pino JSON : masquage des cookies, en-têtes d'autorisation, mots de passe, jetons **et codes** ; aucun code, jeton, HMAC ou secret ne figure jamais dans un journal, un message d'erreur ou une métadonnée d'audit.
- Audit : `cp_app` n'a que `INSERT` et `SELECT` ; liste **fermée** d'actions, un schéma Zod par action, métadonnées ≤ 4 Ko, **interdit** : contenus, URL, noms, emails, IP, secrets.
- Ordre global des verrous : `role_guard` → `classes` → `users` → `class_memberships` → `enrollment_requests` → `auth_challenges` (**LOGIN avant RECOVERY**) → `second_factor_failures` (insertion sans verrou) → `sessions` → lignes de contenu → `email_outbox` → compteurs. `users` jamais en `FOR UPDATE` (seulement `FOR NO KEY UPDATE` ou `FOR SHARE`).
- `CHECK` à plusieurs cas toujours écrits « (cas A complet) OR (cas B complet) ». Migrations : en-tête `-- classification: expand|contract|irreversible`, `BEGIN;`/`COMMIT;`, droits **table par table et colonne par colonne** pour `cp_app`, **jamais `DELETE`** sur `users`, `sessions`, `audit_log`, `auth_challenges`, `email_outbox`, `email_attempts`.
- **`cp_app` n'a des droits par colonne** : un `create`/`update` de Prisma envoie des valeurs par défaut côté client et échoue en `42501`. Tout dépôt de ce lot écrit avec des gabarits `$executeRaw`/`$queryRaw` paramétrés, sur des colonnes accordées (modèles : `sessions.repository.ts`, `audit.repository.ts`).
- **Toute limite, tout compteur, tout bail est réservé atomiquement en une seule instruction** (modèle : `LoginRateLimiter.check()`), jamais « lire puis écrire » ; chaque primitive de concurrence est accompagnée d'un test joué dans les deux ordres avec une attente de verrou observée dans `pg_stat_activity`.
- Tests applicatifs sous **`cp_app`** ; les connexions privilégiées (`cp_owner`, `postgres`) ne servent qu'à préparer une donnée que `cp_app` ne peut pas écrire ou à observer `pg_stat_activity`. Écrire le test d'abord, **montrer le ROUGE**, puis implémenter. On modifie les données plutôt que d'avancer l'horloge.
- Matrice d'autorisation et **oracle écrit à la main** (`matrix.spec.ts`) mis à jour pour chaque action ajoutée ; couverture ≥ 90 % sur `packages/shared` et `authz`.
- Outils : Vitest résout `@classepulse/shared` par `ssr.resolve.conditions`; `tsx` se lance avec `--conditions=source` ; ESLint ne tolère pas les paramètres `_` inutilisés ; `exactOptionalPropertyTypes` est actif (étalement conditionnel des champs optionnels).
- Textes destinés aux personnes : **français, tutoiement** ; codes d'erreur de l'API : identifiants stables **en anglais**, traduits par le web (lot 1c).

Propres au lot 1b (valeurs exactes de la spec) :

- **Code administrateur** : 6 chiffres, `code_hmac = HMAC-SHA256(OTP_PEPPER, challenge_id ‖ code)`, l'identifiant de la vérification est **généré par l'appelant avant le calcul**, jamais stocké ni journalisé en clair ; **expire après 10 min**, usage unique, **5 essais** par vérification puis `LOCKED` ; **une seule vérification active par usage** (index unique partiel) ; toute création **consomme d'abord l'ancienne** (`EXPIRED` ou `SUPERSEDED`) dans la même transaction.
- **Vérification d'un code**, dans une transaction : `users FOR NO KEY UPDATE` → contrôle du blocage → vérification `FOR UPDATE` → comparaison HMAC à temps constant → consommation et création de la session. Deux validations simultanées n'ouvrent qu'**une seule session**.
- **Limites** : demandes de code **1 par minute, 5 par heure, 10 par jour par administrateur, 10 par heure par IP** ; essais **30 par heure et par préfixe d'IP** ; **10 échecs par compte sur 60 minutes glissantes** dans `second_factor_failures`, tous usages confondus ; **à partir du 3ᵉ échec** une alerte part vers l'administrateur concerné et les autres. Un compte bloqué : refus **sans comparaison**, aucune vérification créée, aucun email, code de récupération refusé aussi ; blocage levé seulement par `admin-recovery-code --clear-block`.
- Cookie de vérification : `__Host-cp_challenge=…; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`, effacé avec **exactement les mêmes attributs** et `Max-Age=0`.
- Sessions des administrateurs : **30 min d'inactivité, 8 h au maximum** ; le code n'est pas redemandé pendant la session ; pas d'« appareil de confiance ». **Aucun accès administrateur si le service d'emails est indisponible**, aucune option ne désactive la vérification.
- Récupération : code de **12 caractères**, **seul le HMAC** part vers PostgreSQL (paramètres liés, **texte SQL constant**), valable **15 min**, utilisable par `POST /api/auth/verify-recovery` **seulement avec un cookie `LOGIN` valide** ; les deux vérifications sont consommées de façon atomique dans l'ordre LOGIN puis RECOVERY ; seule la vérification `RECOVERY` peut être créée par `cp_privileged` ; audit `PRIVILEGED` avec `db_login_role = cp_ops`.
- Vérification supplémentaire `STEP_UP` : mot de passe **et** nouveau code, **moins de 5 min**, liés à la session. Changement d'email d'un administrateur : mot de passe + code à l'ancienne adresse (`EMAIL_CHANGE_OLD`, tient lieu de vérification supplémentaire **sans mettre à jour `step_up_at`**) + code à la nouvelle (`EMAIL_CHANGE_NEW`), `pending_email`, liés à la session ; `verify-new` revérifie **sous verrou** que la session est valide et que c'est celle de la requête ; à la fin les autres sessions sont révoquées et des alertes partent.
- Mot de passe oublié : jeton de **32 octets**, valable **30 min**, **à usage unique**, une nouvelle demande annule la précédente, la réinitialisation **révoque toutes les sessions**, Turnstile exigé (indisponible : refus temporaire), jeton envoyé par `POST` puis retiré de l'URL.
- Emails (§ 2.4) : au plus **5 tentatives normales** (délais **1 min, 5 min, 30 min, 2 h**), **au plus 1 reprise après un résultat ambigu (15 min après le constat)**, **6 tentatives au total**, après la reprise tout résultat autre qu'une acceptation donne `FAILED` ; transitions refusées par un trigger ; **réservation en une seule instruction SQL** (`FOR UPDATE SKIP LOCKED`) filtrant expiration, droit à une tentative et `bulk_email_paused` (sauf emails de sécurité), et créant la ligne `email_attempts` dans la même instruction ; bail expiré → tentative `AMBIGUOUS`/`LEASE_EXPIRED` puis règle ambiguë (jamais de remise en file sans précaution) ; **en cas de doute, ambigu** ; `ACCEPTED` = réponse 250 du serveur SMTP configuré, pas une livraison ; contenu chiffré (AES-256-GCM) **effacé dans tous les états finaux** ; email annulé pendant l'envoi : tentative `CANCELLED_IN_FLIGHT`, un résultat tardif n'écrit que son code, jamais de réactivation ; **juste avant l'envoi SMTP**, le worker revérifie que la vérification est encore active et que la session est valide.
- Worker : `replicas: 1`, un bail par traitement (**2 min, renouvelé toutes les 30 s**, `UPDATE … WHERE lease_until IS NULL OR lease_until < clock_timestamp() RETURNING fencing_token`), à `SIGTERM` il cesse de réserver et termine en **30 s au maximum**, chaque traitement s'exécute au démarrage ; réveil par `NOTIFY`, relève de secours par sondage.
- Secrets : **fichiers** (`X_FILE`), jamais dans l'environnement ; chaque service ne lit que les siens : l'API lit `OTP_PEPPER` et `OUTBOX_PAYLOAD_KEY`, le worker lit `OUTBOX_PAYLOAD_KEY` et les identifiants SMTP, `ops` lit `OTP_PEPPER`.

## Review Focus

Entrées ou conditions que la spec implique mais qu'aucune tâche ne testerait sans cette liste, la plus probable d'abord. Chaque ligne a son test dans la tâche qui possède le code.

1. **Code collé avec des séparateurs ou des espaces** (`123 456`, `123-456`, espace final) : accepté après nettoyage, **sans compter d'échec** quand la forme est invalide (`12345`, `1234567`, `abcdef`) → `400 VALIDATION_FAILED`, aucun essai consommé. → tâches 1 et 10.
2. **Double clic sur « Renvoyer », ou deux renvois simultanés** : un seul code actif et un seul email en file, l'autre appel reçoit `429 TOO_MANY_CODE_REQUESTS` avec `Retry-After` ; l'ancien code ne fonctionne plus et son email non parti est annulé. → tâches 9 et 10.
3. **Cookie de vérification absent, expiré, d'un autre administrateur, ou déjà consommé** : `400 CHALLENGE_EXPIRED`, cookie effacé aux mêmes attributs, jamais `500`, aucune indication sur l'existence du compte. → tâche 10.
4. **Service d'emails en panne ou worker arrêté** : la connexion renvoie `202` (la vérification existe), aucune session n'est ouverte, l'email reste `PENDING` puis `EXPIRED` après 10 min ; un nouveau « Renvoyer » crée un nouveau code. Un email dont le code a été saisi avant l'envoi n'est jamais envoyé. → tâches 8 et 10.
5. **Jeton de réinitialisation réutilisé, expiré, remplacé par une nouvelle demande, ou présenté deux fois en parallèle** : une seule réinitialisation aboutit, les autres reçoivent `400 RESET_TOKEN_INVALID` ; une adresse inconnue ou un compte suspendu reçoit la **même réponse** `202` qu'un compte actif ; un administrateur qui réinitialise doit ensuite passer par le code à la connexion. → tâche 14.
6. (Contrôles complémentaires, dans le corps des tâches) **Changement d'email vers une adresse déjà prise** (`409 EMAIL_TAKEN`, aucune session révoquée), **session révoquée entre `verify-old` et `verify-new`**, **résultat SMTP ambigu sur le 5ᵉ essai normal** (une reprise, jamais plus de 6 tentatives).

## Rulings (décisions de rédaction, à relire par le responsable)

- **R1 — Acteur système.** Le worker et ses traitements ont besoin d'un acteur : ajout de `SystemActor` (`kind: 'system'`, `job: 'email.send' | 'maintenance.purge'`) et de la classe `system` dans la matrice (la spec prévoyait `SystemActor` avec `jobs`, R1 du lot 1a). Les actions `mail.enqueue`, `mail.deliver`, `mail.sweep`, `maintenance.purge` lui sont ouvertes. *Coût si faux : renommer un type.*
- **R2 — Forme des vérifications liées à une session.** La spec dit « seule la vérification `RECOVERY` peut avoir `token_hash = NULL` ». Or `STEP_UP` et `EMAIL_CHANGE_*` n'ont pas de cookie : elles sont retrouvées par leur session. Décision : `token_hash` est obligatoire pour `LOGIN` seulement ; `STEP_UP`, `EMAIL_CHANGE_OLD` et `EMAIL_CHANGE_NEW` ont `session_id` obligatoire et `token_hash NULL` ; `RECOVERY` a les deux à `NULL`. C'est un `CHECK` à quatre cas. *Coût si faux : un `CHECK` à réécrire (migration expand).* **À signaler : écart avec la lettre de la spec.**
- **R3 — Le blocage est un état persistant.** La spec donne « 10 échecs sur 60 minutes glissantes » et « le blocage ne peut être levé que par `--clear-block` ». Décision : au 10ᵉ échec, `users.second_factor_blocked_at` est posé (colonne `UPDATE` pour `cp_app` seulement de `NULL` vers une date, jamais l'inverse : trigger) ; il reste posé après la fin de la fenêtre ; seul `cp_privileged` le lève (`priv.issue_admin_recovery_code(…, true)`, audit `ADMIN_SECOND_FACTOR_BLOCK_CLEARED`). *Coût si faux : une colonne et un trigger.* **À signaler : la spec ne dit pas si le blocage s'éteint avec la fenêtre.**
- **R4 — Statuts et codes d'erreur.** Les erreurs de code sont des `400` et non des `401` (un `401` ferait croire au navigateur que la session a expiré, UX § 3.2, comme R15 du lot 1a) : `CODE_INVALID` (avec `attemptsLeft`), `CODE_LOCKED`, `CHALLENGE_EXPIRED` (cookie absent, expiré, consommé, ou compte devenu invalide). `403 SECOND_FACTOR_BLOCKED` (seulement après un mot de passe correct, donc sans énumération), `429 TOO_MANY_CODE_REQUESTS`, `403 STEP_UP_REQUIRED` (`missing: 'PASSWORD' | 'CODE'`), `403 REAUTH_REQUIRED`, `400 RESET_TOKEN_INVALID`, `400 EMAIL_UNCHANGED`, `503 RESET_UNAVAILABLE` (Turnstile indisponible). La connexion d'un administrateur renvoie **`202`** `{ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: 600, resendAfterSeconds: 60 }` avec le cookie de vérification. *Coût si faux : des codes à renommer (le web les traduit au lot 1c).*
- **R5 — Où vivent les limites de code.** Les demandes par IP (10/h) et les essais par préfixe d'IP (30/h) sont des seaux `rate_limit_buckets` (clés `otp-ip:` et `otp-try-ip:`, `CHECK` élargi), incrémentés atomiquement. Les demandes par administrateur (1/min, 5/h, 10/jour) sont comptées dans `auth_challenges.created_at` **sous le verrou `users FOR NO KEY UPDATE`** (une seule transaction à la fois par administrateur, donc atomique). Conséquence : **la purge des vérifications (lot 5) doit conserver les lignes consommées au moins 24 h.** *Coût si faux : une table de seaux de plus.*
- **R6 — Fournisseur d'emails.** La spec ne désigne ni fournisseur ni identifiants (§ 7.11, § 8 : « SMTP »). Décision : transport **SMTP générique** (`nodemailer`), configuré par `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` (`none`|`starttls`|`tls`), `SMTP_USER` + `SMTP_PASSWORD_FILE` facultatifs, `MAIL_FROM`. Valeur de développement : **Mailpit** (`127.0.0.1:1025`, sans TLS, déjà dans `docker-compose.dev.yml`) ; `none` est refusé en production. **Le fournisseur de production, son domaine d'expédition (SPF/DKIM) et ses identifiants sont à choisir par le responsable avant le lot 7.** Les tests de transport n'utilisent aucun fournisseur : un petit serveur SMTP scripté (`net`). *Coût si faux : aucun dans le code, une décision d'exploitation.*
- **R7 — Clé anti-doublon des alertes.** La spec donne `admin-2fa-alert:<compte>:<heure>` mais `dedupe_key` est unique par email : avec plusieurs destinataires la clé doit inclure le destinataire. Décision : `admin-2fa-alert:<compte>:<heure UTC>:<destinataire>`. *Coût si faux : une chaîne.* **À signaler.**
- **R8 — Lien de réinitialisation.** `APP_ORIGIN` + `/reinitialiser-mot-de-passe#token=<jeton>` : le jeton est dans le **fragment** (jamais envoyé au serveur ni dans `Referer`) ; l'écran (lot 1c) le lit, le retire de l'URL (`history.replaceState`) et l'envoie par `POST /api/auth/reset-password`. *Coût si faux : une constante de modèle.*
- **R9 — Limites de « mot de passe oublié ».** La spec n'exige que Turnstile. Pour éviter l'envoi massif d'emails : 10 demandes par heure et par IP (`429 TOO_MANY_ATTEMPTS`) et 3 par heure et par compte (au-delà, **réponse `202` identique mais aucun email**, pour ne rien révéler). Réponse toujours `202`. Pas d'égalisation des temps de réponse (arbitrage N : l'existence d'un compte peut se déduire d'un délai). *Coût si faux : un seuil.* **À signaler (seuils choisis).**
- **R10 — Durées de session des administrateurs.** `idle_expires_at = création + 30 min`, `absolute_expires_at = création + 8 h`, cookie `Max-Age=28800`, prolongation de l'inactivité à chaque `touch` (plafonnée par l'échéance absolue). *Coût si faux : deux constantes.*
- **R11 — Fraîcheur de la vérification supplémentaire.** `STEP_UP` exige que `reauth_at` **et** `step_up_at` aient moins de 5 min (« mot de passe et code, moins de 5 min »). Les autres actions sensibles exigent seulement `reauth_at` (< 5 min) : ajout de `POST /api/me/reauth`. Les gardes `assertStepUpFreshInTx` et `assertRecentPasswordInTx` sont livrés ici, consommés par le lot 2. *Coût si faux : une requête SQL.*
- **R12 — Identifiants de message.** `email_outbox.message_id` contient l'UUID seul ; le worker compose l'en-tête `Message-ID: <uuid@domaine de MAIL_FROM>` (le domaine n'est connu que du worker). Une reprise ambiguë réutilise le même `Message-ID`. *Coût si faux : aucun.*
- **R13 — Chiffrement.** `payload_encrypted` (`bytea`) = IV (12) ‖ étiquette (16) ‖ texte chiffré, **données additionnelles authentifiées = identifiant de l'email** (un contenu recopié dans une autre ligne ne se déchiffre plus). `OUTBOX_PAYLOAD_KEY` : 64 caractères hexadécimaux. Les types sans modèle au lot 1b (WELCOME, REFUSAL, DIGEST, ANNOUNCEMENT, ADMIN_ALERT) existent dans l'énumération SQL mais leur rendu échoue en `PERM_FAIL` (`RENDER_FAILED`), échec **certain** car antérieur à la transmission. *Coût si faux : une énumération.*
- **R14 — Résultat tardif d'un bail expiré.** La spec définit le résultat tardif seulement pour un email annulé. Pour un bail expiré (tentative déjà `AMBIGUOUS`), un résultat tardif **n'est pas enregistré** : il est journalisé (`LATE_RESULT_DROPPED`, identifiant et catégorie seulement). La garantie « au plus deux fois pour les envois ambigus » reste vraie. *Coût si faux : une colonne `late_*` de plus.*
- **R15 — Code de récupération.** 12 caractères de l'alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (31 symboles, sans I, L, O, 0, 1), affiché groupé par 4 (`ABCD-EFGH-JKMN`), séparateurs et casse ignorés à la saisie. La commande exige un terminal (garde-fou, pas une garantie), affiche le code **après** la validation, attend la touche Entrée, puis efface l'écran. *Coût si faux : un alphabet.*
- **R16 — Changement de mot de passe.** La spec n'impose ni Turnstile ni vérification supplémentaire pour `POST /api/me/password` (§ 3.2, § 3.3). Décision : inchangé (session valide + 5 échecs par 15 min + délai croissant). *Coût si faux : ajouter `CredentialsChecker` + `StepUpService` à cette route.*
- **R17 — Actions d'audit ajoutées** (source `APP`, liste fermée) : `ADMIN_LOGIN` (`method`), `ADMIN_EMAIL_CHANGED` (`revokedSessions`), `PASSWORD_RESET_COMPLETED` (`revokedSessions`), `ADMIN_SECOND_FACTOR_BLOCKED` (`failures`). Les actions `PRIVILEGED` (`ADMIN_RECOVERY_CODE_ISSUED`, `ADMIN_SECOND_FACTOR_BLOCK_CLEARED`) existent déjà. *Coût si faux : une valeur d'énumération (`ADD VALUE`, irréversible mais inoffensif).*
- **R18 — Purge des seaux.** Toutes les heures, le worker supprime par lots de 5 000 les seaux dont `window_start` a plus de 2 h (la plus longue fenêtre est 1 h). La purge des sessions et des vérifications reste au lot 5. *Coût si faux : une constante.*
- **R19 — Baux.** Les lignes de `job_leases` (`email.send`, `maintenance.purge`) sont créées par la migration (`cp_app` n'a que `UPDATE`). Le bail d'envoi d'un email (`locked_until`) dure 120 s, plus que le délai total SMTP (60 s). *Coût si faux : des constantes.*
- **R21 — Demandes de code comptées.** La limite 1/min, 5/h, 10/jour compte `LOGIN`, `STEP_UP` et `EMAIL_CHANGE_OLD` ; `EMAIL_CHANGE_NEW` n'est ni comptée ni limitée (elle n'existe qu'après la vérification de l'ancienne adresse, déjà comptée ; sans cela la 2ᵉ étape se heurterait toujours à la limite d'une par minute). Conséquence assumée : un administrateur qui vient de se connecter attend la fin de la minute avant sa première vérification supplémentaire (`Retry-After`). Mise en œuvre en tâche 13. *Coût si faux : une clause SQL.*
- **R20 — Reports du lot 1a, tenus ici.** R14 (purge horaire des seaux → tâche 8), préchauffage de `PasswordHasher.verifyDummy` au démarrage (tâche 15), rejets `TURNSTILE_REQUIRED` comptés pour l'alerte des 50 échecs par IP (tâche 15). `CredentialsChecker` (tâche 12) regroupe la vérification du mot de passe actuel et en dérive les cas de ressaisie.

---

## Structure des fichiers

```
packages/shared/src/
  identity-schemas.ts           exporte EmailField, RawPasswordField (étaient locaux)
  second-factor-schemas.ts      OtpCode, RecoveryCode, normalizeRecoveryCode, corps des nouvelles routes
apps/api/
  package.json                  + nodemailer ; scripts « worker » et « ops »
  prisma/migrations/20261014000200_second_factor/migration.sql
  prisma/migrations/20261014000300_email_outbox/migration.sql
  prisma/migrations/20261014000400_admin_recovery/migration.sql
  prisma/schema.prisma          + AuthChallenge, SecondFactorFailure, PasswordResetToken, EmailOutbox, EmailAttempt, JobLease, énumérations
  src/worker.ts                 point d'entrée du worker
  src/ops.ts                    point d'entrée ops (admin-recovery-code)
  src/ops/admin-recovery-code.ts  runAdminRecoveryCode (pg direct, sans Nest ni Prisma)
  src/config/config.schema.ts   + OTP_PEPPER_FILE, OUTBOX_PAYLOAD_KEY_FILE, workerEnvSchema, opsEnvSchema
  src/config/load-config.ts     + loadWorkerConfig, loadOpsConfig ; AppConfig.security enrichi
  src/config/config.module.ts   + DB_CONFIG, WorkerConfigModule
  src/modules/authz/actor.ts    + SystemActor
  src/modules/authz/matrix.ts   + actions du lot 1b, classe « system »
  src/modules/audit/audit-actions.ts  + 4 actions
  src/modules/mail/email-kinds.ts       types, types de sécurité, schémas Zod payload/secret
  src/modules/mail/payload-cipher.ts    AES-256-GCM
  src/modules/mail/outbox-policy.ts     nextState (fonction pure)
  src/modules/mail/templates.ts         renderEmail (français, tutoiement)
  src/modules/mail/outbox.repository.ts insertInTx, reserve, finalize, sweep, expire, cancel…
  src/modules/mail/mail.service.ts      enqueueInTx (côté API et worker)
  src/modules/mail/mail-transport.ts    MailTransport, classifySmtpError, SmtpMailTransport
  src/modules/mail/email-sender.ts      EmailSender (traitement email.send)
  src/modules/mail/mail.module.ts       MailModule.register(key) ; MailWorkerModule
  src/modules/maintenance/{maintenance.repository,maintenance.service,maintenance.module}.ts
  src/modules/jobs/{job-lease.repository,job-scheduler,notify-listener,jobs.module}.ts
  src/worker/worker.module.ts           WorkerModule.forRoot(config)
  src/modules/auth/second-factor/otp.ts                 codes, HMAC, jeton et cookie de vérification
  src/modules/auth/second-factor/challenges.repository.ts
  src/modules/auth/second-factor/second-factor.service.ts
  src/modules/auth/second-factor/otp-limiter.ts
  src/modules/auth/credentials-checker.ts               mot de passe actuel + limiteur
  src/modules/auth/step-up.service.ts                   reauth, step-up, gardes de fraîcheur
  src/modules/auth/email-change.service.ts
  src/modules/auth/password-reset.service.ts + password-reset.repository.ts
  src/modules/auth/auth.service.ts, auth.controller.ts, account.controller.ts, session-cookie.ts, sessions.*  (modifiés)
  test/support/{lock-wait,second-factor,scripted-smtp}.ts
  test/integration/{second-factor-schema,email-schema,mail-outbox,mail-transport,worker,second-factor-service,auth-admin-login,admin-recovery,step-up,email-change,password-reset,security-admin}.int.spec.ts
```

La liste ci-dessus est indicative ; le texte des tâches fait foi.

---

### Task 1 : `packages/shared` — schémas des codes et des nouvelles routes

**Files :**
- Modify : `packages/shared/src/identity-schemas.ts`, `packages/shared/src/index.ts`
- Create : `packages/shared/src/second-factor-schemas.ts`
- Test : `packages/shared/src/second-factor-schemas.spec.ts`

**Interfaces :**
- Consumes : `Email` et `RawPassword` de `identity-schemas.ts` (à exporter sous les noms `EmailField` et `RawPasswordField`).
- Produces (depuis `@classepulse/shared`) : `OTP_LENGTH = 6`, `RECOVERY_CODE_LENGTH = 12`, `RECOVERY_ALPHABET`, `normalizeRecoveryCode(input: string): string`, schémas Zod `.strict()` `VerifyCodeBody` (`{ code }`), `VerifyRecoveryBody` (`{ recoveryCode }`), `ForgotPasswordBody` (`{ email, turnstileToken }`), `ResetPasswordBody` (`{ token, newPassword }`), `PasswordBody` (`{ password }`, pour `reauth` et `step-up`), `EmailChangeStartBody` (`{ password, newEmail }`) et leurs types.

- [ ] **Step 1 : Écrire le test (échoue)**

`packages/shared/src/second-factor-schemas.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import {
  EmailChangeStartBody, ForgotPasswordBody, PasswordBody, RECOVERY_ALPHABET, ResetPasswordBody,
  VerifyCodeBody, VerifyRecoveryBody, normalizeRecoveryCode,
} from './second-factor-schemas.js';

describe('VerifyCodeBody (Review Focus 1)', () => {
  it.each([['123456', '123456'], [' 123 456 ', '123456'], ['123-456', '123456'], ['123456\n', '123456']])('accepte %j', (input, expected) => {
    expect(VerifyCodeBody.parse({ code: input }).code).toBe(expected);
  });
  it.each(['12345', '1234567', 'abcdef', '12 34 5a', '', '１２３４５６'])('refuse %j', (input) => {
    expect(VerifyCodeBody.safeParse({ code: input }).success).toBe(false);
  });
  it('refuse un champ inconnu', () => {
    expect(VerifyCodeBody.safeParse({ code: '123456', extra: 1 }).success).toBe(false);
  });
});

describe('code de récupération (R15)', () => {
  it('l’alphabet a 31 symboles sans I, L, O, 0, 1', () => {
    expect(RECOVERY_ALPHABET).toHaveLength(31);
    for (const c of 'ILO01') expect(RECOVERY_ALPHABET).not.toContain(c);
  });
  it.each([['abcd-efgh-jkmn', 'ABCDEFGHJKMN'], [' ABCD EFGH JKMN ', 'ABCDEFGHJKMN']])('normalise %j', (input, expected) => {
    expect(normalizeRecoveryCode(input)).toBe(expected);
    expect(VerifyRecoveryBody.parse({ recoveryCode: input }).recoveryCode).toBe(expected);
  });
  it.each(['ABCDEFGHJKM', 'ABCDEFGHJKMNP', 'ABCDEFGHIKMN', 'ABCDEFGHJK0N'])('refuse %j', (input) => {
    expect(VerifyRecoveryBody.safeParse({ recoveryCode: input }).success).toBe(false);
  });
});

describe('autres corps', () => {
  it('ForgotPasswordBody normalise l’email et exige Turnstile', () => {
    expect(ForgotPasswordBody.parse({ email: ' Awa@Example.COM ', turnstileToken: 't' }).email).toBe('awa@example.com');
    expect(ForgotPasswordBody.safeParse({ email: 'awa@example.com' }).success).toBe(false);
  });
  it('ResetPasswordBody exige un jeton de 43 caractères base64url', () => {
    const token = 'A'.repeat(43);
    expect(ResetPasswordBody.safeParse({ token, newPassword: 'x'.repeat(20) }).success).toBe(true);
    expect(ResetPasswordBody.safeParse({ token: 'court', newPassword: 'x'.repeat(20) }).success).toBe(false);
    expect(ResetPasswordBody.safeParse({ token: `${'A'.repeat(42)}+`, newPassword: 'x'.repeat(20) }).success).toBe(false);
  });
  it('PasswordBody et EmailChangeStartBody', () => {
    expect(PasswordBody.safeParse({ password: 'x' }).success).toBe(true);
    expect(PasswordBody.safeParse({ password: 'x', extra: 1 }).success).toBe(false);
    expect(EmailChangeStartBody.parse({ password: 'x', newEmail: 'Nouveau@Example.com' }).newEmail).toBe('nouveau@example.com');
    expect(EmailChangeStartBody.safeParse({ password: 'x', newEmail: 'élise@example.com' }).success).toBe(false);
  });
});
```

Run : `pnpm vitest run --project unit packages/shared/src/second-factor-schemas.spec.ts` — Expected : FAIL (`Cannot find module './second-factor-schemas.js'`).

- [ ] **Step 2 : Implémenter**

Dans `packages/shared/src/identity-schemas.ts`, renommer les deux constantes locales en exports : `export const RawPasswordField = …` et `export const EmailField = …` (même définition), et remplacer leurs usages dans le fichier (`RawPassword` → `RawPasswordField`, `Email` → `EmailField`).

`packages/shared/src/second-factor-schemas.ts` :

```ts
import { z } from 'zod';
import { EmailField, RawPasswordField } from './identity-schemas.js';

export const OTP_LENGTH = 6;
export const RECOVERY_CODE_LENGTH = 12;
/** 31 symboles : ni I, L, O (confusion avec 1 et 0), ni 0, ni 1 (R15). */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Espaces et tirets retirés (« 123 456 » collé depuis un email). */
const stripSeparators = (s: string): string => s.replace(/[\s-]/g, '');

export function normalizeRecoveryCode(input: string): string {
  return stripSeparators(input).toUpperCase();
}

export const OtpCode = z
  .string()
  .max(32)
  .transform(stripSeparators)
  .pipe(z.string().regex(/^[0-9]{6}$/, { message: 'INVALID_CODE' }));

export const RecoveryCode = z
  .string()
  .max(64)
  .transform(normalizeRecoveryCode)
  .pipe(z.string().regex(new RegExp(`^[${RECOVERY_ALPHABET}]{${RECOVERY_CODE_LENGTH}}$`), { message: 'INVALID_CODE' }));

export const VerifyCodeBody = z.strictObject({ code: OtpCode });
export type VerifyCodeBody = z.infer<typeof VerifyCodeBody>;

export const VerifyRecoveryBody = z.strictObject({ recoveryCode: RecoveryCode });
export type VerifyRecoveryBody = z.infer<typeof VerifyRecoveryBody>;

export const ForgotPasswordBody = z.strictObject({ email: EmailField, turnstileToken: z.string().min(1).max(2048) });
export type ForgotPasswordBody = z.infer<typeof ForgotPasswordBody>;

export const ResetPasswordBody = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  newPassword: RawPasswordField,
});
export type ResetPasswordBody = z.infer<typeof ResetPasswordBody>;

export const PasswordBody = z.strictObject({ password: RawPasswordField });
export type PasswordBody = z.infer<typeof PasswordBody>;

export const EmailChangeStartBody = z.strictObject({ password: RawPasswordField, newEmail: EmailField });
export type EmailChangeStartBody = z.infer<typeof EmailChangeStartBody>;
```

Ajouter `export * from './second-factor-schemas.js';` à `packages/shared/src/index.ts`.

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project unit packages/shared` puis `pnpm --filter @classepulse/shared typecheck` — Expected : PASS (les tests du lot 1a restent verts : le renommage ne change pas les schémas).

- [ ] **Step 4 : Commit**

```bash
git add packages/shared
git commit -m "feat(shared): schémas du code administrateur, de la récupération et des routes du lot 1b

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2 : Configuration, acteur système, secrets et aides de test

**Files :**
- Modify : `apps/api/src/config/config.schema.ts`, `apps/api/src/config/load-config.ts`, `apps/api/src/config/config.module.ts`, `apps/api/src/database/prisma.service.ts`, `apps/api/src/modules/authz/actor.ts`, `apps/api/src/modules/authz/matrix.ts`, `apps/api/package.json`, `apps/api/test/support/app.ts`, `README.md`
- Create : `apps/api/test/support/lock-wait.ts`
- Test : `apps/api/src/config/load-config.spec.ts` (étendre), `apps/api/src/modules/authz/matrix.spec.ts` (oracle)

**Interfaces :**
- Produces :
  - `AppConfig.security: { rateLimitHmacKey: string; otpPepper: string; outboxPayloadKey: Buffer }`
  - `WorkerConfig = { nodeEnv; db: DbConfig; logLevel: LogLevel; appOrigin: string; outboxPayloadKey: Buffer; mail: { from: string; smtp: { host: string; port: number; security: 'none'|'starttls'|'tls'; auth: { user: string; password: string } | null; timeoutMs: number } } }` et `loadWorkerConfig(env): WorkerConfig`
  - `OpsConfig = { nodeEnv; db: DbConfig; otpPepper: string }` et `loadOpsConfig(env): OpsConfig`
  - `DB_CONFIG` (jeton Nest) fourni par `ConfigModule.forRoot(config)` et par `WorkerConfigModule.forRoot(config)` ; `prismaServiceProvider` l'injecte au lieu de `APP_CONFIG`
  - `WORKER_CONFIG` (jeton Nest)
  - `SystemActor = { kind: 'system'; job: 'email.send' | 'maintenance.purge' }`, `Actor` l'inclut
  - `waitForLockWait(db: string, holderPid: number): Promise<void>` (test)

- [ ] **Step 1 : Écrire les tests (échouent)**

Étendre `apps/api/src/config/load-config.spec.ts` (en réutilisant ses aides d'environnement ; ci-dessous les cas à ajouter, avec `baseEnv()` l'environnement valide déjà utilisé dans ce fichier et `secretFile(value)` son aide qui écrit un fichier temporaire) :

```ts
describe('lot 1b : secrets et worker', () => {
  const hex = 'a'.repeat(64);
  it('loadConfig lit OTP_PEPPER_FILE et OUTBOX_PAYLOAD_KEY_FILE', () => {
    const c = loadConfig({ ...baseEnv(), OTP_PEPPER_FILE: secretFile('p'.repeat(40)), OUTBOX_PAYLOAD_KEY_FILE: secretFile(hex) });
    expect(c.security.otpPepper).toBe('p'.repeat(40));
    expect(c.security.outboxPayloadKey).toEqual(Buffer.from(hex, 'hex'));
  });
  it.each([['court', hex], ['p'.repeat(40), 'zz'.repeat(32)], ['p'.repeat(40), 'a'.repeat(62)]])('refuse pepper %j / clé %j', (pepper, key) => {
    expect(() => loadConfig({ ...baseEnv(), OTP_PEPPER_FILE: secretFile(pepper), OUTBOX_PAYLOAD_KEY_FILE: secretFile(key) })).toThrow(/OTP_PEPPER|OUTBOX_PAYLOAD_KEY/);
  });
  it('loadWorkerConfig : Mailpit en développement, sans identifiants', () => {
    const w = loadWorkerConfig({ ...dbOnlyEnv(), APP_ORIGIN: 'https://app.test', OUTBOX_PAYLOAD_KEY_FILE: secretFile(hex), MAIL_FROM: 'no-reply@app.test', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', SMTP_SECURITY: 'none' });
    expect(w.mail.smtp).toMatchObject({ host: '127.0.0.1', port: 1025, security: 'none', auth: null, timeoutMs: 30_000 });
  });
  it('loadWorkerConfig : SMTP_SECURITY=none refusé en production, identifiants incomplets refusés', () => {
    const env = { ...dbOnlyEnv(), APP_ORIGIN: 'https://app.test', OUTBOX_PAYLOAD_KEY_FILE: secretFile(hex), MAIL_FROM: 'no-reply@app.test', SMTP_HOST: 'smtp.example', SMTP_PORT: '587' };
    expect(() => loadWorkerConfig({ ...env, NODE_ENV: 'production', SMTP_SECURITY: 'none' })).toThrow(/SMTP_SECURITY/);
    expect(() => loadWorkerConfig({ ...env, SMTP_SECURITY: 'starttls', SMTP_USER: 'u' })).toThrow(/SMTP_PASSWORD_FILE/);
  });
  it('loadOpsConfig lit OTP_PEPPER_FILE et la base, rien d’autre', () => {
    const o = loadOpsConfig({ ...dbOnlyEnv(), OTP_PEPPER_FILE: secretFile('p'.repeat(40)) });
    expect(o.otpPepper).toBe('p'.repeat(40));
  });
});
```

Dans `apps/api/src/modules/authz/matrix.spec.ts`, l'oracle écrit à la main doit déclarer les nouvelles actions (voir Step 3) ; ajouter d'abord, avant le code, les lignes attendues :

```ts
// Oracle indépendant de MATRIX (lot 1b) : ne jamais le déduire de MATRIX.
const EXPECTED_1B: Record<string, readonly string[]> = {
  'auth.verifyCode': ['anonymous'], 'auth.resendCode': ['anonymous'], 'auth.verifyRecovery': ['anonymous'],
  'auth.forgotPassword': ['anonymous'], 'auth.resetPassword': ['anonymous'],
  'me.reauth': ['user', 'admin'],
  'me.stepUp': ['admin'], 'me.stepUpVerify': ['admin'], 'stepUp.assertFresh': ['admin'], 'reauth.assertRecent': ['user', 'admin'],
  'me.changeEmailStart': ['admin'], 'me.changeEmailVerifyOld': ['admin'], 'me.changeEmailVerifyNew': ['admin'],
  'mail.enqueue': ['anonymous', 'user', 'admin', 'system'],
  'mail.deliver': ['system'], 'mail.sweep': ['system'], 'maintenance.purge': ['system'],
};
describe('matrice du lot 1b', () => {
  it.each(Object.entries(EXPECTED_1B))('%s', (action, classes) => {
    expect([...MATRIX[action as keyof typeof MATRIX]].sort()).toEqual([...classes].sort());
  });
  it('la classe system n’a aucune autre action', () => {
    const sys = Object.entries(MATRIX).filter(([, c]) => c.includes('system')).map(([a]) => a).sort();
    expect(sys).toEqual(['mail.deliver', 'mail.enqueue', 'mail.sweep', 'maintenance.purge']);
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/config/load-config.spec.ts apps/api/src/modules/authz/matrix.spec.ts` — Expected : FAIL (`loadWorkerConfig is not a function`, actions absentes).

- [ ] **Step 2 : Configuration**

`apps/api/src/config/config.schema.ts` — ajouter à `envSchema` (via `.extend`) :

```ts
  OTP_PEPPER_FILE: z.string().min(1),
  OUTBOX_PAYLOAD_KEY_FILE: z.string().min(1),
```

et exporter :

```ts
export const workerEnvSchema = dbEnvSchema.extend({
  APP_ORIGIN: origin,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  OUTBOX_PAYLOAD_KEY_FILE: z.string().min(1),
  MAIL_FROM: z.email(),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: port,
  SMTP_SECURITY: z.enum(['none', 'starttls', 'tls']),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD_FILE: z.string().min(1).optional(),
  SMTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(30_000),
});

export const opsEnvSchema = dbEnvSchema.extend({ OTP_PEPPER_FILE: z.string().min(1) });
```

`apps/api/src/config/load-config.ts` — types et chargeurs :

```ts
export type AppConfig = { /* champs existants */ security: { rateLimitHmacKey: string; otpPepper: string; outboxPayloadKey: Buffer }; /* … */ };
export type SmtpSecurity = 'none' | 'starttls' | 'tls';
export type WorkerConfig = {
  nodeEnv: 'development' | 'test' | 'production'; db: DbConfig; logLevel: LogLevel; appOrigin: string; outboxPayloadKey: Buffer;
  mail: { from: string; smtp: { host: string; port: number; security: SmtpSecurity; auth: { user: string; password: string } | null; timeoutMs: number } };
};
export type OpsConfig = { nodeEnv: 'development' | 'test' | 'production'; db: DbConfig; otpPepper: string };

const MIN_PEPPER_LENGTH = 32;

function readPepper(file: string): string {
  const v = readSecretFile(file);
  if (v.length < MIN_PEPPER_LENGTH) throw new Error(`invalid configuration: OTP_PEPPER (${MIN_PEPPER_LENGTH} characters minimum)`);
  return v;
}

/** 64 caractères hexadécimaux = 32 octets (R13) ; seul le nom de la variable figure dans l'erreur. */
function readHexKey(file: string): Buffer {
  const v = readSecretFile(file);
  if (!/^[0-9a-fA-F]{64}$/.test(v)) throw new Error('invalid configuration: OUTBOX_PAYLOAD_KEY (64 hexadecimal characters)');
  return Buffer.from(v, 'hex');
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  checkForbidden(env);
  const parsed = workerEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${issuesOf(parsed.error)}`);
  const e = parsed.data;
  if (e.NODE_ENV === 'production' && e.SMTP_SECURITY === 'none') throw new Error('invalid configuration: SMTP_SECURITY (none is not allowed in production)');
  if (Boolean(e.SMTP_USER) !== Boolean(e.SMTP_PASSWORD_FILE)) throw new Error('invalid configuration: SMTP_USER, SMTP_PASSWORD_FILE (both or none)');
  const auth = e.SMTP_USER && e.SMTP_PASSWORD_FILE ? { user: e.SMTP_USER, password: readSecretFile(e.SMTP_PASSWORD_FILE) } : null;
  return {
    nodeEnv: e.NODE_ENV, db: loadDbConfig(env), logLevel: e.LOG_LEVEL, appOrigin: new URL(e.APP_ORIGIN).origin,
    outboxPayloadKey: readHexKey(e.OUTBOX_PAYLOAD_KEY_FILE),
    mail: { from: e.MAIL_FROM, smtp: { host: e.SMTP_HOST, port: e.SMTP_PORT, security: e.SMTP_SECURITY, auth, timeoutMs: e.SMTP_TIMEOUT_MS } },
  };
}

export function loadOpsConfig(env: NodeJS.ProcessEnv): OpsConfig {
  checkForbidden(env);
  const parsed = opsEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${issuesOf(parsed.error)}`);
  return { nodeEnv: parsed.data.NODE_ENV, db: loadDbConfig(env), otpPepper: readPepper(parsed.data.OTP_PEPPER_FILE) };
}
```

Dans `loadConfig`, lire `security: { rateLimitHmacKey, otpPepper: readPepper(e.OTP_PEPPER_FILE), outboxPayloadKey: readHexKey(e.OUTBOX_PAYLOAD_KEY_FILE) }`. Exporter `readHexKey` et `readPepper` ne sert qu'ici.

`apps/api/src/config/config.module.ts` :

```ts
import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig, DbConfig, WorkerConfig } from './load-config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
/** Connexion à la base : fournie par l'API (AppConfig.db) et par le worker (WorkerConfig.db). */
export const DB_CONFIG = Symbol('DB_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: APP_CONFIG, useValue: config }, { provide: DB_CONFIG, useValue: config.db }], exports: [APP_CONFIG, DB_CONFIG] };
  }
}

@Global()
@Module({})
export class WorkerConfigModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    return { module: WorkerConfigModule, providers: [{ provide: WORKER_CONFIG, useValue: config }, { provide: DB_CONFIG, useValue: config.db }], exports: [WORKER_CONFIG, DB_CONFIG] };
  }
}

export type { DbConfig };
```

`apps/api/src/database/prisma.service.ts` — remplacer le fournisseur :

```ts
export const prismaServiceProvider = {
  provide: PrismaService,
  inject: [DB_CONFIG],
  useFactory: (db: DbConfig) => new PrismaService(db),
};
```

(importer `DB_CONFIG` depuis `config.module.js` à la place de `APP_CONFIG`, retirer l'import `AppConfig` devenu inutile).

`apps/api/test/support/app.ts` :
- `testConfig` : `security: { rateLimitHmacKey: …, otpPepper: 'test-otp-pepper-'.padEnd(48, 'x'), outboxPayloadKey: Buffer.alloc(32, 7) }` ;
- exporter `TEST_OUTBOX_KEY = Buffer.alloc(32, 7)` et `TEST_OTP_PEPPER` (mêmes valeurs, utilisées par les aides des tâches suivantes) ;
- `runCli` : écrire aussi deux fichiers et ajouter à l'environnement `OTP_PEPPER_FILE: file('pepper', TEST_OTP_PEPPER)` et `OUTBOX_PAYLOAD_KEY_FILE: file('outbox', TEST_OUTBOX_KEY.toString('hex'))` (sans eux la CLI du lot 1a refuse de démarrer).

`apps/api/test/support/lock-wait.ts` :

```ts
import { connectAs } from './pg.js';

/** Attend (5 s au plus) qu'une session `cp_app` autre que `holderPid` soit en attente d'un verrou ; observation par `postgres`. */
export async function waitForLockWait(db: string, holderPid: number): Promise<void> {
  const admin = await connectAs('postgres', db);
  try {
    for (let i = 0; i < 100; i++) {
      const r = await admin.query(
        `select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'cp_app' and pid <> $2 and wait_event_type = 'Lock'`,
        [db, holderPid]);
      if (r.rows[0].n > 0) return;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('aucune attente de verrou observée');
  } finally {
    await admin.end();
  }
}
```

- [ ] **Step 3 : Acteur système et matrice**

`actor.ts` :

```ts
/** Traitements du worker (R1 du lot 1b). */
export type SystemActor = { kind: 'system'; job: 'email.send' | 'maintenance.purge' };
export type Actor = UserActor | AnonymousActor | CliActor | SystemActor;
```

`matrix.ts` : `ActorClass` gagne `'system'` ; `ACTIONS` gagne les dix-sept actions de l'oracle ci-dessus (`auth.verifyCode`, `auth.resendCode`, `auth.verifyRecovery`, `auth.forgotPassword`, `auth.resetPassword`, `me.reauth`, `me.stepUp`, `me.stepUpVerify`, `stepUp.assertFresh`, `reauth.assertRecent`, `me.changeEmailStart`, `me.changeEmailVerifyOld`, `me.changeEmailVerifyNew`, `mail.enqueue`, `mail.deliver`, `mail.sweep`, `maintenance.purge`) et `MATRIX` leurs classes exactement comme dans `EXPECTED_1B`. `actorClass` renvoie `a.kind` pour `system` (déjà couvert par la ligne `return a.kind`).

- [ ] **Step 4 : Dépendance, scripts, README**

```bash
export PATH=/c/Users/bmd/bin:$PATH
pnpm --filter @classepulse/api add -E "nodemailer@$(pnpm view nodemailer version)"
pnpm --filter @classepulse/api add -D -E "@types/nodemailer@$(pnpm view @types/nodemailer version)"
```

`apps/api/package.json`, scripts : `"worker": "tsx --conditions=source src/worker.ts"`, `"ops": "tsx --conditions=source src/ops.ts"`.

`README.md` : section « Emails en développement » : démarrer Mailpit (`docker compose -f docker-compose.dev.yml up -d mailpit`, interface sur http://127.0.0.1:8025), créer deux fichiers secrets de développement (`openssl rand -hex 32 > .secrets/dev/outbox_payload_key` et `openssl rand -base64 48 > .secrets/dev/otp_pepper`), variables du worker (`SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURITY=none MAIL_FROM=no-reply@classepulse.test OUTBOX_PAYLOAD_KEY_FILE=…`) et de l'API (`OTP_PEPPER_FILE`, `OUTBOX_PAYLOAD_KEY_FILE`), commande `pnpm --filter @classepulse/api worker`.

- [ ] **Step 5 : Vérifier**

Run : `pnpm vitest run --project unit apps/api/src/config apps/api/src/modules/authz` puis `pnpm typecheck` puis `pnpm lint` — Expected : PASS. Run : `pnpm vitest run --project integration apps/api/test/integration/cli.int.spec.ts apps/api/test/integration/database.int.spec.ts` — Expected : PASS (non-régression : la CLI lit les nouveaux fichiers, la base est construite depuis `DB_CONFIG`).

- [ ] **Step 6 : Commit**

```bash
git add apps/api package.json pnpm-lock.yaml README.md
git commit -m "feat(config): secrets du code et de la file d'emails, configuration du worker et de ops, acteur système

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3 : Migration `second_factor` — vérifications, échecs, jetons, colonnes de session

**Files :**
- Create : `apps/api/prisma/migrations/20261014000200_second_factor/migration.sql`
- Modify : `apps/api/prisma/schema.prisma`, `apps/api/test/integration/schema-presence.int.spec.ts`, `apps/api/test/integration/identity-schema.int.spec.ts` (le test « cp_app ne peut pas changer son email » devient « … pas celui d'un étudiant »), le test d'assertion exacte des droits de `cp_app` (`role-privileges.int.spec.ts`, D6 du lot 1a) pour les colonnes et tables ajoutées
- Test : `apps/api/test/integration/second-factor-schema.int.spec.ts`

**Interfaces :**
- Produces : types `app.challenge_purpose` (`LOGIN`, `RECOVERY`, `STEP_UP`, `EMAIL_CHANGE_OLD`, `EMAIL_CHANGE_NEW` — **dans cet ordre**, il sert à l'ordre des verrous), `app.challenge_consumed_reason` (`USED`, `EXPIRED`, `SUPERSEDED`, `LOCKED`, `SESSION_ENDED`) ; tables `app.auth_challenges`, `app.second_factor_failures`, `app.password_reset_tokens` ; colonnes `users.second_factor_blocked_at`, `sessions.second_factor_at`, `sessions.second_factor_method` (`EMAIL_CODE` | `RECOVERY_CODE`), `sessions.step_up_at` ; valeurs d'audit `ADMIN_LOGIN`, `ADMIN_EMAIL_CHANGED`, `PASSWORD_RESET_COMPLETED`, `ADMIN_SECOND_FACTOR_BLOCKED` ; clés de seaux `otp-ip:`, `otp-try-ip:`, `forgot-ip:`, `forgot-acct:`.

- [ ] **Step 1 : Écrire le test (échoue)**

`apps/api/test/integration/second-factor-schema.int.spec.ts` :

```ts
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
let owner: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); app = await connectAs('cp_app', db); owner = await connectAs('cp_owner', db); });
afterAll(async () => { await app.end(); await owner.end(); });

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';
async function insertUser(email: string, role: 'USER' | 'ADMIN' = 'ADMIN') {
  const id = uuidv7();
  await app.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop',$3,$4)`, [id, email, HASH, role]);
  return id;
}
async function insertSession(userId: string, secondFactor = true) {
  const id = uuidv7();
  await app.query(
    `insert into app.sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at, second_factor_at, second_factor_method)
     values ($1,$2,$3, clock_timestamp() + interval '30 minutes', clock_timestamp() + interval '8 hours', ${secondFactor ? 'clock_timestamp()' : 'null'}, ${secondFactor ? `'EMAIL_CODE'` : 'null'})`,
    [id, randomBytes(32), userId]);
  return id;
}
type Ch = { id?: string; userId: string; purpose: string; sessionId?: string | null; tokenHash?: Buffer | null; pendingEmail?: string | null; ttl?: string };
async function insertChallenge(c: Ch) {
  const id = c.id ?? uuidv7();
  await app.query(
    `insert into app.auth_challenges (id, user_id, purpose, session_id, token_hash, code_hmac, pending_email, expires_at)
     values ($1,$2,$3::app.challenge_purpose,$4,$5,$6,$7, clock_timestamp() + interval '${c.ttl ?? '10 minutes'}')`,
    [id, c.userId, c.purpose, c.sessionId ?? null, c.tokenHash === undefined ? randomBytes(32) : c.tokenHash, randomBytes(32), c.pendingEmail ?? null]);
  return id;
}

describe('auth_challenges (§ 3.3, R2)', () => {
  it('LOGIN : jeton obligatoire, aucune session', async () => {
    const u = await insertUser('l1@example.com');
    await expect(insertChallenge({ userId: u, purpose: 'LOGIN', tokenHash: null })).rejects.toMatchObject({ constraint: 'auth_challenges_shape' });
    await insertChallenge({ userId: u, purpose: 'LOGIN' });
  });
  it('STEP_UP : session obligatoire, jeton absent', async () => {
    const u = await insertUser('s1@example.com');
    await expect(insertChallenge({ userId: u, purpose: 'STEP_UP', tokenHash: null })).rejects.toMatchObject({ constraint: 'auth_challenges_shape' });
    await insertChallenge({ userId: u, purpose: 'STEP_UP', tokenHash: null, sessionId: await insertSession(u) });
  });
  it('une seule vérification active par usage, plusieurs usages possibles', async () => {
    const u = await insertUser('u1@example.com');
    await insertChallenge({ userId: u, purpose: 'LOGIN' });
    await expect(insertChallenge({ userId: u, purpose: 'LOGIN' })).rejects.toMatchObject({ code: '23505' });
    await insertChallenge({ userId: u, purpose: 'STEP_UP', tokenHash: null, sessionId: await insertSession(u) });
  });
  it('consommer libère l’usage ; consommation et motif vont ensemble ; une consommation est définitive', async () => {
    const u = await insertUser('c1@example.com');
    const id = await insertChallenge({ userId: u, purpose: 'LOGIN' });
    await expect(app.query(`update app.auth_challenges set consumed_at = clock_timestamp() where id = $1`, [id])).rejects.toMatchObject({ constraint: 'auth_challenges_consumed' });
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'SUPERSEDED' where id = $1`, [id]);
    await expect(app.query(`update app.auth_challenges set attempts = 1 where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    await insertChallenge({ userId: u, purpose: 'LOGIN' });
  });
  it('au plus 5 essais, et le compteur ne baisse jamais', async () => {
    const u = await insertUser('a1@example.com');
    const id = await insertChallenge({ userId: u, purpose: 'LOGIN' });
    await app.query(`update app.auth_challenges set attempts = 3 where id = $1`, [id]);
    await expect(app.query(`update app.auth_challenges set attempts = 2 where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    await expect(app.query(`update app.auth_challenges set attempts = 6 where id = $1`, [id])).rejects.toMatchObject({ constraint: 'auth_challenges_attempts_range' });
  });
  it('seul cp_privileged crée une vérification RECOVERY', async () => {
    const u = await insertUser('r1@example.com');
    await expect(insertChallenge({ userId: u, purpose: 'RECOVERY', tokenHash: null })).rejects.toMatchObject({ code: '42501' });
  });
  it('réservée aux administrateurs actifs', async () => {
    const u = await insertUser('stu@example.com', 'USER');
    await expect(insertChallenge({ userId: u, purpose: 'LOGIN' })).rejects.toMatchObject({ code: '23514' });
  });
  it('un compte bloqué ne reçoit plus de vérification (hors RECOVERY)', async () => {
    const u = await insertUser('b1@example.com');
    await app.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [u]);
    await expect(insertChallenge({ userId: u, purpose: 'LOGIN' })).rejects.toMatchObject({ code: '23514' });
  });
  it('EMAIL_CHANGE_NEW exige un EMAIL_CHANGE_OLD consommé (USED) de la même session et du même email', async () => {
    const u = await insertUser('e1@example.com');
    const s = await insertSession(u);
    await expect(insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_NEW', tokenHash: null, sessionId: s, pendingEmail: 'n@example.com' })).rejects.toMatchObject({ code: '23514' });
    const old = await insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_OLD', tokenHash: null, sessionId: s, pendingEmail: 'n@example.com' });
    await expect(insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_NEW', tokenHash: null, sessionId: s, pendingEmail: 'n@example.com' })).rejects.toMatchObject({ code: '23514' }); // OLD pas encore consommé
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [old]);
    await expect(insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_NEW', tokenHash: null, sessionId: s, pendingEmail: 'autre@example.com' })).rejects.toMatchObject({ code: '23514' }); // autre email
    await insertChallenge({ userId: u, purpose: 'EMAIL_CHANGE_NEW', tokenHash: null, sessionId: s, pendingEmail: 'n@example.com' });
  });
  it('cp_app ne supprime rien', async () => {
    const u = await insertUser('d1@example.com');
    const id = await insertChallenge({ userId: u, purpose: 'LOGIN' });
    await expect(app.query('delete from app.auth_challenges where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('colonnes de users (R3)', () => {
  it('cp_app pose le blocage mais ne le lève ni ne le modifie', async () => {
    const u = await insertUser('blk@example.com');
    await app.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [u]);
    await expect(app.query(`update app.users set second_factor_blocked_at = null where id = $1`, [u])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [u])).rejects.toMatchObject({ code: '23514' });
  });
  it('le blocage ne vise qu’un administrateur', async () => {
    const u = await insertUser('blk2@example.com', 'USER');
    await expect(app.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [u])).rejects.toMatchObject({ code: '23514' });
  });
  it('cp_app change l’email d’un administrateur, pas celui d’un étudiant', async () => {
    const a = await insertUser('adm@example.com');
    const s = await insertUser('stud@example.com', 'USER');
    await app.query(`update app.users set email = 'adm2@example.com' where id = $1`, [a]);
    await expect(app.query(`update app.users set email = 'stud2@example.com' where id = $1`, [s])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set global_role = 'USER' where id = $1`, [a])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('sessions : second facteur (§ 3.3)', () => {
  it('une session d’administrateur sans second facteur est refusée', async () => {
    const a = await insertUser('sa@example.com');
    await expect(insertSession(a, false)).rejects.toMatchObject({ code: '23514' });
    await insertSession(a, true);
  });
  it('une session d’étudiant n’en a pas besoin ; méthode et date vont ensemble', async () => {
    const s = await insertUser('ss@example.com', 'USER');
    await insertSession(s, false);
    await expect(app.query(`insert into app.sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at, second_factor_method) values ($1,$2,$3, now() + interval '1 hour', now() + interval '2 hours', 'EMAIL_CODE')`, [uuidv7(), randomBytes(32), s])).rejects.toMatchObject({ constraint: 'sessions_second_factor_pair' });
  });
  it('cp_app met à jour step_up_at', async () => {
    const a = await insertUser('su@example.com');
    const id = await insertSession(a);
    await app.query(`update app.sessions set step_up_at = clock_timestamp() where id = $1`, [id]);
    await expect(app.query(`update app.sessions set second_factor_at = null, second_factor_method = null where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('second_factor_failures, password_reset_tokens, seaux', () => {
  it('failures : insertion et lecture seulement', async () => {
    const u = await insertUser('f1@example.com');
    await app.query(`insert into app.second_factor_failures (user_id, challenge_id, purpose) values ($1, $2, 'LOGIN')`, [u, uuidv7()]);
    await expect(app.query('delete from app.second_factor_failures where user_id = $1', [u])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.second_factor_failures set purpose = 'STEP_UP' where user_id = $1`, [u])).rejects.toMatchObject({ code: '42501' });
  });
  it('jetons de réinitialisation : un seul actif par compte, hachage de 32 octets', async () => {
    const u = await insertUser('p1@example.com');
    const ins = (hash: Buffer) => app.query(`insert into app.password_reset_tokens (id, user_id, token_hash, expires_at) values ($1,$2,$3, clock_timestamp() + interval '30 minutes')`, [uuidv7(), u, hash]);
    await expect(ins(randomBytes(16))).rejects.toMatchObject({ constraint: 'password_reset_hash_len' });
    await ins(randomBytes(32));
    await expect(ins(randomBytes(32))).rejects.toMatchObject({ code: '23505' });
    await app.query(`update app.password_reset_tokens set consumed_at = clock_timestamp() where user_id = $1`, [u]);
    await ins(randomBytes(32));
  });
  it.each(['otp-ip:203.0.113.7', 'otp-try-ip:2001:db8:1:2::', 'forgot-ip:203.0.113.7', `forgot-acct:${'a'.repeat(64)}`])('seau accepté %s', async (key) => {
    await app.query('insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp())', [key]);
  });
  it.each(['otp-ip:', 'forgot-acct:alice@example.com', 'login:1.2.3.4'])('seau refusé %s', async (key) => {
    await expect(app.query('insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp())', [key])).rejects.toMatchObject({ constraint: 'rate_limit_key_shape' });
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/second-factor-schema.int.spec.ts` — Expected : FAIL (`type "app.challenge_purpose" does not exist`).

- [ ] **Step 2 : Écrire la migration**

`apps/api/prisma/migrations/20261014000200_second_factor/migration.sql` :

```sql
-- classification: expand
BEGIN;

-- Actions d'audit de l'application (R17). Les valeurs ne sont pas utilisées dans cette transaction.
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ADMIN_LOGIN';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ADMIN_EMAIL_CHANGED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_COMPLETED';
ALTER TYPE app.audit_action ADD VALUE IF NOT EXISTS 'ADMIN_SECOND_FACTOR_BLOCKED';

-- L'ordre des valeurs est l'ordre des verrous : LOGIN avant RECOVERY (§ 2.1).
CREATE TYPE app.challenge_purpose AS ENUM ('LOGIN', 'RECOVERY', 'STEP_UP', 'EMAIL_CHANGE_OLD', 'EMAIL_CHANGE_NEW');
CREATE TYPE app.challenge_consumed_reason AS ENUM ('USED', 'EXPIRED', 'SUPERSEDED', 'LOCKED', 'SESSION_ENDED');

ALTER TABLE app.users ADD COLUMN second_factor_blocked_at timestamptz;
GRANT UPDATE (email, second_factor_blocked_at) ON app.users TO cp_app;

CREATE FUNCTION app.users_second_factor_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.second_factor_blocked_at IS DISTINCT FROM OLD.second_factor_blocked_at THEN
    IF NEW.second_factor_blocked_at IS NULL AND current_user <> 'cp_privileged' THEN
      RAISE EXCEPTION 'second factor block is lifted by a privileged role only' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.second_factor_blocked_at IS NOT NULL AND NEW.second_factor_blocked_at IS NOT NULL THEN
      RAISE EXCEPTION 'second factor block date is final' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.second_factor_blocked_at IS NOT NULL AND NEW.global_role <> 'ADMIN' THEN
      RAISE EXCEPTION 'only an administrator can be blocked' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.email::text IS DISTINCT FROM OLD.email::text AND OLD.global_role <> 'ADMIN' AND current_user <> 'cp_privileged' THEN
    RAISE EXCEPTION 'only an administrator email is changed by the application' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_second_factor_guard BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.users_second_factor_guard();

ALTER TABLE app.sessions
  ADD COLUMN second_factor_at     timestamptz,
  ADD COLUMN second_factor_method text,
  ADD COLUMN step_up_at           timestamptz,
  ADD CONSTRAINT sessions_second_factor_pair CHECK (
    (second_factor_at IS NULL AND second_factor_method IS NULL)
    OR (second_factor_at IS NOT NULL AND second_factor_method IN ('EMAIL_CODE', 'RECOVERY_CODE'))
  );
GRANT UPDATE (step_up_at) ON app.sessions TO cp_app;

-- Défense en profondeur : aucune session d'administrateur sans second facteur (§ 3.3).
CREATE FUNCTION app.sessions_admin_second_factor() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.second_factor_at IS NULL AND EXISTS (SELECT 1 FROM app.users u WHERE u.id = NEW.user_id AND u.global_role = 'ADMIN') THEN
    RAISE EXCEPTION 'an administrator session requires a second factor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_admin_second_factor BEFORE INSERT ON app.sessions
  FOR EACH ROW EXECUTE FUNCTION app.sessions_admin_second_factor();

CREATE TABLE app.auth_challenges (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  purpose        app.challenge_purpose NOT NULL,
  session_id     uuid REFERENCES app.sessions (id) ON DELETE RESTRICT,
  token_hash     bytea,
  code_hmac      bytea NOT NULL,
  pending_email  ext.citext,
  ip             inet,
  attempts       smallint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  consumed_reason app.challenge_consumed_reason,
  CONSTRAINT auth_challenges_attempts_range CHECK (attempts BETWEEN 0 AND 5),
  CONSTRAINT auth_challenges_hmac_len CHECK (octet_length(code_hmac) = 32),
  CONSTRAINT auth_challenges_token_len CHECK (token_hash IS NULL OR octet_length(token_hash) = 32),
  CONSTRAINT auth_challenges_consumed CHECK (
    (consumed_at IS NULL AND consumed_reason IS NULL)
    OR (consumed_at IS NOT NULL AND consumed_reason IS NOT NULL)
  ),
  -- R2 : quatre formes.
  CONSTRAINT auth_challenges_shape CHECK (
    (purpose = 'LOGIN' AND token_hash IS NOT NULL AND session_id IS NULL AND pending_email IS NULL)
    OR (purpose = 'RECOVERY' AND token_hash IS NULL AND session_id IS NULL AND pending_email IS NULL)
    OR (purpose = 'STEP_UP' AND token_hash IS NULL AND session_id IS NOT NULL AND pending_email IS NULL)
    OR (purpose IN ('EMAIL_CHANGE_OLD', 'EMAIL_CHANGE_NEW') AND token_hash IS NULL AND session_id IS NOT NULL AND pending_email IS NOT NULL)
  )
);
CREATE UNIQUE INDEX auth_challenges_active ON app.auth_challenges (user_id, purpose) WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX auth_challenges_token_hash_key ON app.auth_challenges (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX auth_challenges_user_created_idx ON app.auth_challenges (user_id, created_at);

CREATE FUNCTION app.auth_challenges_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE u record;
BEGIN
  SELECT global_role, status, second_factor_blocked_at INTO u FROM app.users WHERE id = NEW.user_id;
  IF NEW.purpose = 'RECOVERY' AND current_user <> 'cp_privileged' THEN
    RAISE EXCEPTION 'a recovery challenge is created by a privileged role only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF u.global_role IS DISTINCT FROM 'ADMIN' OR u.status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'challenges are reserved to active administrators' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purpose <> 'RECOVERY' AND u.second_factor_blocked_at IS NOT NULL THEN
    RAISE EXCEPTION 'second factor blocked' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.purpose = 'EMAIL_CHANGE_NEW' AND NOT EXISTS (
    SELECT 1 FROM app.auth_challenges o
     WHERE o.user_id = NEW.user_id AND o.purpose = 'EMAIL_CHANGE_OLD' AND o.session_id = NEW.session_id
       AND o.pending_email::text = NEW.pending_email::text AND o.consumed_reason = 'USED'
       AND o.consumed_at > clock_timestamp() - interval '15 minutes') THEN
    RAISE EXCEPTION 'the old address must be verified first' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_challenges_guard BEFORE INSERT ON app.auth_challenges
  FOR EACH ROW EXECUTE FUNCTION app.auth_challenges_guard();

CREATE FUNCTION app.auth_challenges_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a consumed challenge no longer changes' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'attempts never decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_challenges_immutable BEFORE UPDATE ON app.auth_challenges
  FOR EACH ROW EXECUTE FUNCTION app.auth_challenges_immutable();

GRANT SELECT ON app.auth_challenges TO cp_app;
GRANT INSERT (id, user_id, purpose, session_id, token_hash, code_hmac, pending_email, ip, expires_at) ON app.auth_challenges TO cp_app;
GRANT UPDATE (attempts, consumed_at, consumed_reason) ON app.auth_challenges TO cp_app;

CREATE TABLE app.second_factor_failures (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  challenge_id uuid,
  purpose      app.challenge_purpose NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX second_factor_failures_user_idx ON app.second_factor_failures (user_id, occurred_at);
GRANT SELECT ON app.second_factor_failures TO cp_app;
GRANT INSERT (user_id, challenge_id, purpose) ON app.second_factor_failures TO cp_app;

CREATE TABLE app.password_reset_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  token_hash  bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT password_reset_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT password_reset_token_hash_key UNIQUE (token_hash)
);
CREATE UNIQUE INDEX password_reset_active ON app.password_reset_tokens (user_id) WHERE consumed_at IS NULL;
GRANT SELECT ON app.password_reset_tokens TO cp_app;
GRANT INSERT (id, user_id, token_hash, expires_at) ON app.password_reset_tokens TO cp_app;
GRANT UPDATE (consumed_at) ON app.password_reset_tokens TO cp_app;

ALTER TABLE app.rate_limit_buckets DROP CONSTRAINT rate_limit_key_shape;
ALTER TABLE app.rate_limit_buckets ADD CONSTRAINT rate_limit_key_shape CHECK (
  key ~ '^ip:[0-9a-f:.]{1,45}$'
  OR key ~ '^ip\+acct:[0-9a-f:.]{1,45}:[0-9a-f]{64}$'
  OR key ~ '^(otp-ip|otp-try-ip|forgot-ip):[0-9a-f:.]{1,45}$'
  OR key ~ '^forgot-acct:[0-9a-f]{64}$'
);

COMMIT;
```

Ajouter dans `schema.prisma` les modèles `AuthChallenge`, `SecondFactorFailure`, `PasswordResetToken` (colonnes en `@map`, `@@schema("app")`), les énumérations `ChallengePurpose` et `ChallengeConsumedReason`, les champs `secondFactorBlockedAt` (`User`) et `secondFactorAt`, `secondFactorMethod`, `stepUpAt` (`Session`), et les quatre valeurs de l'énumération `AuditAction` si elle y figure. Puis `pnpm --filter @classepulse/api prisma:generate`. Mettre à jour `schema-presence.int.spec.ts` (tables attendues) et l'assertion exacte des droits de `cp_app` (nouvelles colonnes et tables, **toujours sans `DELETE`** sur les trois tables nouvelles).

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/second-factor-schema.int.spec.ts apps/api/test/integration/schema-presence.int.spec.ts apps/api/test/integration/identity-schema.int.spec.ts apps/api/test/integration/role-privileges.int.spec.ts apps/api/test/integration/migrate-from-previous.int.spec.ts` ; `pnpm vitest run --project unit apps/api/test/architecture` (en-tête et `BEGIN` de la migration) — Expected : PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/api
git commit -m "feat(db): vérifications du second facteur, échecs, jetons de réinitialisation, colonnes de session

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4 : Migration `email_outbox` — file, tentatives, baux, triggers

**Files :**
- Create : `apps/api/prisma/migrations/20261014000300_email_outbox/migration.sql`
- Modify : `apps/api/prisma/schema.prisma`, `apps/api/test/integration/schema-presence.int.spec.ts`, `apps/api/test/integration/role-privileges.int.spec.ts`
- Test : `apps/api/test/integration/email-schema.int.spec.ts`

**Interfaces :**
- Produces : types `app.email_kind` (WELCOME, REFUSAL, PASSWORD_RESET, DIGEST, ANNOUNCEMENT, ADMIN_ALERT, SECURITY_ALERT, ADMIN_SECURITY_ALERT, ADMIN_OTP, ADMIN_EMAIL_CHANGE_OLD, ADMIN_EMAIL_CHANGE_NEW, TEST), `app.email_status` (PENDING, SENDING, RETRY_WAIT, UNCERTAIN, ACCEPTED, FAILED, EXPIRED, CANCELLED), `app.email_attempt_kind` (NORMAL, AMBIGUOUS_RETRY), `app.email_attempt_outcome` (ACCEPTED, TEMP_FAIL, PERM_FAIL, AMBIGUOUS, CANCELLED_IN_FLIGHT) ; tables `app.email_outbox`, `app.email_attempts`, `app.job_leases` (lignes `email.send` et `maintenance.purge`) ; notification `NOTIFY email_outbox` à chaque insertion.
- Colonnes d'insertion accordées à `cp_app` sur `email_outbox` : `id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id` ; `UPDATE` : `status, normal_attempts, ambiguous_retry_scheduled, ambiguous_retry_claimed, next_attempt_at, locked_until, claim_token, accepted_at, payload_encrypted`. `email_attempts` : `INSERT (email_id, attempt_no, kind, claim_token)`, `UPDATE (finished_at, outcome, smtp_code, smtp_response, error_code, late_outcome, late_smtp_code)`. `job_leases` : `SELECT`, `UPDATE (holder, lease_until, fencing_token)`.

- [ ] **Step 1 : Écrire le test (échoue)**

`apps/api/test/integration/email-schema.int.spec.ts` :

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
let adminId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  app = await connectAs('cp_app', db);
  adminId = uuidv7();
  await app.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,'adm@example.com','Awa','Diop','$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA','ADMIN')`, [adminId]);
});
afterAll(async () => { await app.end(); });

async function insertEmail(over: { kind?: string; challengeId?: string | null; to?: string; secret?: boolean; dedupe?: string; ttl?: string } = {}) {
  const id = uuidv7();
  const kind = over.kind ?? 'TEST';
  await app.query(
    `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
     values ($1,$2,$3,$4::app.email_kind,$5,'{}'::jsonb,$6,$7, clock_timestamp() + interval '${over.ttl ?? '1 hour'}', $8)`,
    [id, adminId, over.to ?? 'adm@example.com', kind, over.dedupe ?? `k:${id}`, over.secret === false ? null : randomBytes(40), randomUUID(), over.challengeId ?? null]);
  return id;
}
const setState = (id: string, sets: string) => app.query(`update app.email_outbox set ${sets} where id = $1`, [id]);
const SENDING = `status = 'SENDING', claim_token = gen_random_uuid(), locked_until = clock_timestamp() + interval '2 minutes', normal_attempts = normal_attempts + 1`;
const RETRY = `status = 'RETRY_WAIT', claim_token = null, locked_until = null, next_attempt_at = clock_timestamp()`;
const UNCERTAIN = `status = 'UNCERTAIN', claim_token = null, locked_until = null, ambiguous_retry_scheduled = true`;
const FAILED = `status = 'FAILED', claim_token = null, locked_until = null, payload_encrypted = null`;
const ACCEPTED = `status = 'ACCEPTED', claim_token = null, locked_until = null, payload_encrypted = null, accepted_at = clock_timestamp()`;

describe('transitions (§ 2.4)', () => {
  it('chemin nominal : PENDING → SENDING → RETRY_WAIT → SENDING → UNCERTAIN → SENDING → FAILED', async () => {
    const id = await insertEmail();
    await setState(id, SENDING);
    await setState(id, RETRY);
    await setState(id, SENDING);
    await setState(id, UNCERTAIN);
    await setState(id, `${SENDING.replace('normal_attempts = normal_attempts + 1', 'ambiguous_retry_claimed = true')}`);
    await setState(id, FAILED);
  });
  it.each([
    ['PENDING → ACCEPTED', ACCEPTED],
    ['PENDING → FAILED', FAILED],
    ['PENDING → RETRY_WAIT', `${RETRY}, normal_attempts = 1`],
  ])('refuse %s', async (_n, sets) => {
    const id = await insertEmail();
    await expect(setState(id, sets)).rejects.toMatchObject({ code: '23514' });
  });
  it('refuse SENDING → EXPIRED et toute modification d’un état final', async () => {
    const a = await insertEmail();
    await setState(a, SENDING);
    await expect(setState(a, `status = 'EXPIRED', claim_token = null, locked_until = null, payload_encrypted = null`)).rejects.toMatchObject({ code: '23514' });
    await setState(a, ACCEPTED);
    await expect(setState(a, `next_attempt_at = clock_timestamp()`)).rejects.toMatchObject({ code: '23514' });
    const b = await insertEmail();
    await setState(b, `status = 'CANCELLED', payload_encrypted = null`);
    await expect(setState(b, `status = 'SENDING', claim_token = gen_random_uuid(), locked_until = clock_timestamp() + interval '1 minute', normal_attempts = 1`)).rejects.toMatchObject({ code: '23514' });
  });
  it('autorise PENDING, RETRY_WAIT et UNCERTAIN → EXPIRED / CANCELLED', async () => {
    const a = await insertEmail();
    await setState(a, `status = 'EXPIRED', payload_encrypted = null`);
    const b = await insertEmail();
    await setState(b, SENDING); await setState(b, UNCERTAIN);
    await setState(b, `status = 'CANCELLED', payload_encrypted = null`);
  });
});

describe('forme des lignes (CHECK)', () => {
  it('SENDING exige jeton et bail ; PENDING n’en a pas', async () => {
    const id = await insertEmail();
    await expect(setState(id, `status = 'SENDING', normal_attempts = 1`)).rejects.toMatchObject({ constraint: 'email_outbox_state_shape' });
  });
  it('au plus 5 tentatives normales ; RETRY_WAIT seulement avant la 5ᵉ', async () => {
    const id = await insertEmail();
    await setState(id, SENDING);
    await setState(id, `normal_attempts = 5`);
    await expect(setState(id, RETRY)).rejects.toMatchObject({ constraint: 'email_outbox_state_shape' });
    await expect(setState(id, `normal_attempts = 6`)).rejects.toMatchObject({ constraint: 'email_outbox_normal_attempts_range' });
  });
  it('les états finaux n’ont plus de contenu chiffré', async () => {
    const id = await insertEmail({ kind: 'ADMIN_SECURITY_ALERT' });
    await setState(id, SENDING);
    await expect(setState(id, `status = 'ACCEPTED', claim_token = null, locked_until = null, accepted_at = clock_timestamp()`)).rejects.toMatchObject({ constraint: 'email_outbox_state_shape' });
  });
  it('un type à secret exige un contenu chiffré tant que l’email n’est pas final', async () => {
    await expect(insertEmail({ kind: 'PASSWORD_RESET', secret: false })).rejects.toMatchObject({ constraint: 'email_outbox_secret_kinds' });
    await insertEmail({ kind: 'ADMIN_SECURITY_ALERT', secret: false });
  });
  it('clé anti-doublon et identifiant de message uniques', async () => {
    await insertEmail({ dedupe: 'same' });
    await expect(insertEmail({ dedupe: 'same' })).rejects.toMatchObject({ code: '23505' });
  });
  it('cp_app ne supprime rien', async () => {
    const id = await insertEmail();
    await expect(app.query('delete from app.email_outbox where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('delete from app.email_attempts')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('email_attempts : résultat écrit une seule fois', () => {
  async function attempt(emailId: string) {
    await setState(emailId, SENDING);
    const claim = (await app.query('select claim_token from app.email_outbox where id = $1', [emailId])).rows[0].claim_token;
    await app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', $2)`, [emailId, claim]);
    return claim as string;
  }
  it('le résultat ne se réécrit pas', async () => {
    const id = await insertEmail();
    await attempt(id);
    await app.query(`update app.email_attempts set outcome = 'TEMP_FAIL', smtp_code = 451, finished_at = clock_timestamp() where email_id = $1`, [id]);
    await expect(app.query(`update app.email_attempts set outcome = 'ACCEPTED' where email_id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  });
  it('résultat tardif seulement après CANCELLED_IN_FLIGHT, une fois', async () => {
    const id = await insertEmail();
    await attempt(id);
    await expect(app.query(`update app.email_attempts set late_outcome = 'ACCEPTED' where email_id = $1`, [id])).rejects.toMatchObject({ constraint: 'email_attempts_late_only_cancelled' });
    await app.query(`update app.email_attempts set outcome = 'CANCELLED_IN_FLIGHT', finished_at = clock_timestamp() where email_id = $1`, [id]);
    await app.query(`update app.email_attempts set late_outcome = 'ACCEPTED', late_smtp_code = 250 where email_id = $1`, [id]);
    await expect(app.query(`update app.email_attempts set late_outcome = 'TEMP_FAIL' where email_id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
  });
  it('numéro et nature cohérents, unicité par email', async () => {
    const id = await insertEmail();
    await setState(id, SENDING);
    await expect(app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'AMBIGUOUS_RETRY', gen_random_uuid())`, [id])).rejects.toMatchObject({ constraint: 'email_attempts_kind_no' });
    await app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', gen_random_uuid())`, [id]);
    await expect(app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', gen_random_uuid())`, [id])).rejects.toMatchObject({ code: '23505' });
  });
});

describe('liens avec les vérifications (§ 3.3)', () => {
  async function challenge() {
    const u = uuidv7();
    await app.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop','$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA','ADMIN')`, [u, `c${u}@example.com`]);
    const id = uuidv7();
    await app.query(`insert into app.auth_challenges (id, user_id, purpose, token_hash, code_hmac, expires_at) values ($1,$2,'LOGIN',$3,$4, clock_timestamp() + interval '10 minutes')`, [id, u, randomBytes(32), randomBytes(32)]);
    return { id, userId: u, email: `c${u}@example.com` };
  }
  async function otpFor(c: { id: string; userId: string; email: string }, over: { to?: string; kind?: string } = {}) {
    const id = uuidv7();
    await app.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
       values ($1,$2,$3,$4::app.email_kind,$5,'{}'::jsonb,$6,$7, (select expires_at from app.auth_challenges where id = $8), $8)`,
      [id, c.userId, over.to ?? c.email, over.kind ?? 'ADMIN_OTP', `otp:${c.id}`, randomBytes(40), randomUUID(), c.id]);
    return id;
  }
  it('challenge_email_link : un type de code exige une vérification, les autres n’en ont pas', async () => {
    await expect(insertEmail({ kind: 'ADMIN_OTP' })).rejects.toMatchObject({ constraint: 'email_outbox_challenge_link' });
    const c = await challenge();
    await expect(insertEmail({ kind: 'TEST', challengeId: c.id })).rejects.toMatchObject({ code: '23514' }); // refusé par outbox_challenge_guard
  });
  it('outbox_challenge_guard : adresse, destinataire, type cohérents', async () => {
    const c = await challenge();
    await expect(otpFor(c, { to: 'autre@example.com' })).rejects.toMatchObject({ code: '23514' });
    await expect(otpFor(c, { kind: 'ADMIN_EMAIL_CHANGE_OLD' })).rejects.toMatchObject({ code: '23514' });
    await otpFor(c);
  });
  it('one_email_per_challenge', async () => {
    const c = await challenge();
    await otpFor(c);
    await expect(app.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
       values ($1,$2,$3,'ADMIN_OTP','otp2:${c.id}','{}'::jsonb,$4,$5, clock_timestamp() + interval '1 minute', $6)`,
      [uuidv7(), c.userId, c.email, randomBytes(40), randomUUID(), c.id])).rejects.toMatchObject({ code: '23505' });
  });
  it('une vérification consommée est refusée pour un nouvel email', async () => {
    const c = await challenge();
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'EXPIRED' where id = $1`, [c.id]);
    await expect(otpFor(c)).rejects.toMatchObject({ code: '23514' });
  });
  it('challenge_consumed_cancels_emails : annule l’email en file et clôt la tentative en cours', async () => {
    const c = await challenge();
    const pending = await otpFor(c);
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'SUPERSEDED' where id = $1`, [c.id]);
    const r = await app.query('select status, payload_encrypted from app.email_outbox where id = $1', [pending]);
    expect(r.rows[0]).toEqual({ status: 'CANCELLED', payload_encrypted: null });

    const c2 = await challenge();
    const sending = await otpFor(c2);
    await setState(sending, SENDING);
    const claim = (await app.query('select claim_token from app.email_outbox where id = $1', [sending])).rows[0].claim_token;
    await app.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) values ($1, 1, 'NORMAL', $2)`, [sending, claim]);
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [c2.id]);
    expect((await app.query('select status from app.email_outbox where id = $1', [sending])).rows[0].status).toBe('CANCELLED');
    expect((await app.query('select outcome from app.email_attempts where email_id = $1', [sending])).rows[0].outcome).toBe('CANCELLED_IN_FLIGHT');
  });
  it('la consommation d’une vérification ne touche pas un email déjà ACCEPTED', async () => {
    const c = await challenge();
    const id = await otpFor(c);
    await setState(id, SENDING); await setState(id, ACCEPTED);
    await app.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [c.id]);
    expect((await app.query('select status from app.email_outbox where id = $1', [id])).rows[0].status).toBe('ACCEPTED');
  });
});

describe('NOTIFY et baux', () => {
  it('une insertion validée notifie le canal email_outbox', async () => {
    const listener = await connectAs('cp_app', db);
    const got = new Promise<void>((resolve) => listener.on('notification', (m) => { if (m.channel === 'email_outbox') resolve(); }));
    await listener.query('listen email_outbox');
    await insertEmail();
    await Promise.race([got, new Promise((_r, rej) => setTimeout(() => rej(new Error('pas de notification')), 3000))]);
    await listener.end();
  });
  it('job_leases : deux lignes semées, cp_app ne peut que les mettre à jour', async () => {
    const r = await app.query('select name from app.job_leases order by name');
    expect(r.rows.map((x) => x.name)).toEqual(['email.send', 'maintenance.purge']);
    await expect(app.query(`insert into app.job_leases (name) values ('autre')`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.job_leases set name = 'x'`)).rejects.toMatchObject({ code: '42501' });
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/email-schema.int.spec.ts` — Expected : FAIL (`type "app.email_kind" does not exist`).

- [ ] **Step 2 : Écrire la migration**

`apps/api/prisma/migrations/20261014000300_email_outbox/migration.sql` :

```sql
-- classification: expand
BEGIN;

CREATE TYPE app.email_kind AS ENUM (
  'WELCOME', 'REFUSAL', 'PASSWORD_RESET', 'DIGEST', 'ANNOUNCEMENT', 'ADMIN_ALERT', 'SECURITY_ALERT',
  'ADMIN_SECURITY_ALERT', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW', 'TEST'
);
CREATE TYPE app.email_status AS ENUM ('PENDING', 'SENDING', 'RETRY_WAIT', 'UNCERTAIN', 'ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED');
CREATE TYPE app.email_attempt_kind AS ENUM ('NORMAL', 'AMBIGUOUS_RETRY');
CREATE TYPE app.email_attempt_outcome AS ENUM ('ACCEPTED', 'TEMP_FAIL', 'PERM_FAIL', 'AMBIGUOUS', 'CANCELLED_IN_FLIGHT');

CREATE TABLE app.email_outbox (
  id                        uuid PRIMARY KEY,
  recipient_user_id         uuid REFERENCES app.users (id) ON DELETE RESTRICT,
  to_address                text NOT NULL,
  kind                      app.email_kind NOT NULL,
  dedupe_key                text NOT NULL,
  payload                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_encrypted         bytea,
  message_id                text NOT NULL,
  status                    app.email_status NOT NULL DEFAULT 'PENDING',
  normal_attempts           smallint NOT NULL DEFAULT 0,
  ambiguous_retry_scheduled boolean NOT NULL DEFAULT false,
  ambiguous_retry_claimed   boolean NOT NULL DEFAULT false,
  next_attempt_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_until              timestamptz,
  claim_token               uuid,
  expires_at                timestamptz NOT NULL,
  accepted_at               timestamptz,
  challenge_id              uuid REFERENCES app.auth_challenges (id) ON DELETE RESTRICT,
  created_at                timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT email_outbox_dedupe_key_key UNIQUE (dedupe_key),
  CONSTRAINT email_outbox_message_id_key UNIQUE (message_id),
  CONSTRAINT email_outbox_normal_attempts_range CHECK (normal_attempts BETWEEN 0 AND 5),
  CONSTRAINT email_outbox_claimed_scheduled CHECK (NOT ambiguous_retry_claimed OR ambiguous_retry_scheduled),
  CONSTRAINT email_outbox_payload_size CHECK (octet_length(payload::text) <= 4096),
  -- § 2.4 : chaque colonne est liée à l'état.
  CONSTRAINT email_outbox_state_shape CHECK (
    (status = 'PENDING' AND normal_attempts = 0 AND NOT ambiguous_retry_scheduled AND NOT ambiguous_retry_claimed
      AND claim_token IS NULL AND locked_until IS NULL AND accepted_at IS NULL)
    OR (status = 'SENDING' AND normal_attempts >= 1 AND claim_token IS NOT NULL AND locked_until IS NOT NULL AND accepted_at IS NULL)
    OR (status = 'RETRY_WAIT' AND normal_attempts BETWEEN 1 AND 4 AND NOT ambiguous_retry_scheduled AND NOT ambiguous_retry_claimed
      AND claim_token IS NULL AND locked_until IS NULL AND accepted_at IS NULL)
    OR (status = 'UNCERTAIN' AND normal_attempts BETWEEN 1 AND 5 AND ambiguous_retry_scheduled AND NOT ambiguous_retry_claimed
      AND claim_token IS NULL AND locked_until IS NULL AND accepted_at IS NULL)
    OR (status = 'ACCEPTED' AND accepted_at IS NOT NULL AND claim_token IS NULL AND locked_until IS NULL AND payload_encrypted IS NULL)
    OR (status IN ('FAILED', 'EXPIRED', 'CANCELLED') AND accepted_at IS NULL AND claim_token IS NULL AND locked_until IS NULL AND payload_encrypted IS NULL)
  ),
  -- Un type qui porte un secret a son contenu chiffré tant que l'email n'est pas final.
  CONSTRAINT email_outbox_secret_kinds CHECK (
    status IN ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED')
    OR kind NOT IN ('PASSWORD_RESET', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW')
    OR payload_encrypted IS NOT NULL
  ),
  -- challenge_email_link : un email de code est toujours lié à sa vérification, et seulement lui.
  CONSTRAINT email_outbox_challenge_link CHECK (
    (kind IN ('ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW') AND challenge_id IS NOT NULL)
    OR (kind NOT IN ('ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW') AND challenge_id IS NULL)
  )
);
-- one_email_per_challenge
CREATE UNIQUE INDEX one_email_per_challenge ON app.email_outbox (challenge_id) WHERE challenge_id IS NOT NULL;
CREATE INDEX email_outbox_due_idx ON app.email_outbox (next_attempt_at) WHERE status IN ('PENDING', 'RETRY_WAIT', 'UNCERTAIN');
CREATE INDEX email_outbox_sending_idx ON app.email_outbox (locked_until) WHERE status = 'SENDING';

CREATE FUNCTION app.email_outbox_transition() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status IN ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'email in final state % no longer changes', OLD.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status IN ('PENDING', 'RETRY_WAIT', 'UNCERTAIN') AND NEW.status IN ('SENDING', 'EXPIRED', 'CANCELLED'))
    OR (OLD.status = 'SENDING' AND NEW.status IN ('ACCEPTED', 'RETRY_WAIT', 'UNCERTAIN', 'FAILED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'email transition % -> % refused', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_outbox_transition BEFORE UPDATE ON app.email_outbox
  FOR EACH ROW EXECUTE FUNCTION app.email_outbox_transition();

-- outbox_challenge_guard : type, adresse, destinataire et expiration cohérents avec la vérification.
CREATE FUNCTION app.outbox_challenge_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; expected_to text;
BEGIN
  IF NEW.challenge_id IS NULL THEN RETURN NEW; END IF;
  SELECT ch.user_id, ch.purpose, ch.pending_email, ch.expires_at, ch.consumed_at, u.email AS user_email
    INTO c FROM app.auth_challenges ch JOIN app.users u ON u.id = ch.user_id WHERE ch.id = NEW.challenge_id;
  IF NOT FOUND OR c.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'the challenge is not active' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((NEW.kind = 'ADMIN_OTP' AND c.purpose IN ('LOGIN', 'STEP_UP'))
       OR (NEW.kind = 'ADMIN_EMAIL_CHANGE_OLD' AND c.purpose = 'EMAIL_CHANGE_OLD')
       OR (NEW.kind = 'ADMIN_EMAIL_CHANGE_NEW' AND c.purpose = 'EMAIL_CHANGE_NEW')) THEN
    RAISE EXCEPTION 'email kind does not match the challenge purpose' USING ERRCODE = 'check_violation';
  END IF;
  expected_to := CASE WHEN c.purpose = 'EMAIL_CHANGE_NEW' THEN c.pending_email::text ELSE c.user_email::text END;
  IF NEW.to_address <> expected_to OR NEW.recipient_user_id IS DISTINCT FROM c.user_id THEN
    RAISE EXCEPTION 'address or recipient does not match the challenge' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.expires_at > c.expires_at THEN
    RAISE EXCEPTION 'email outlives its challenge' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_challenge_guard BEFORE INSERT ON app.email_outbox
  FOR EACH ROW EXECUTE FUNCTION app.outbox_challenge_guard();

CREATE FUNCTION app.email_outbox_notify() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_notify('email_outbox', '');
  RETURN NULL;
END $$;
CREATE TRIGGER email_outbox_notify AFTER INSERT ON app.email_outbox
  FOR EACH STATEMENT EXECUTE FUNCTION app.email_outbox_notify();

CREATE TABLE app.email_attempts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_id      uuid NOT NULL REFERENCES app.email_outbox (id) ON DELETE RESTRICT,
  attempt_no    smallint NOT NULL,
  kind          app.email_attempt_kind NOT NULL,
  claim_token   uuid NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at   timestamptz,
  outcome       app.email_attempt_outcome,
  smtp_code     integer,
  smtp_response text,
  error_code    text,
  late_outcome  app.email_attempt_outcome,
  late_smtp_code integer,
  CONSTRAINT email_attempts_email_no_key UNIQUE (email_id, attempt_no),
  CONSTRAINT email_attempts_kind_no CHECK (
    (kind = 'NORMAL' AND attempt_no BETWEEN 1 AND 5)
    OR (kind = 'AMBIGUOUS_RETRY' AND attempt_no BETWEEN 2 AND 6)
  ),
  CONSTRAINT email_attempts_response_len CHECK (smtp_response IS NULL OR char_length(smtp_response) <= 500),
  CONSTRAINT email_attempts_late_only_cancelled CHECK (
    (late_outcome IS NULL AND late_smtp_code IS NULL)
    OR (outcome = 'CANCELLED_IN_FLIGHT' AND late_outcome IS NOT NULL AND late_outcome <> 'CANCELLED_IN_FLIGHT')
  )
);
CREATE INDEX email_attempts_open_idx ON app.email_attempts (email_id, claim_token) WHERE outcome IS NULL;

CREATE FUNCTION app.email_attempts_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.outcome IS NOT NULL AND (
       NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.smtp_code IS DISTINCT FROM OLD.smtp_code
    OR NEW.smtp_response IS DISTINCT FROM OLD.smtp_response OR NEW.error_code IS DISTINCT FROM OLD.error_code
    OR NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
    RAISE EXCEPTION 'an attempt result is written once' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.late_outcome IS NOT NULL AND (NEW.late_outcome IS DISTINCT FROM OLD.late_outcome OR NEW.late_smtp_code IS DISTINCT FROM OLD.late_smtp_code) THEN
    RAISE EXCEPTION 'a late result is written once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER email_attempts_once BEFORE UPDATE ON app.email_attempts
  FOR EACH ROW EXECUTE FUNCTION app.email_attempts_once();

-- challenge_consumed_cancels_emails : la consommation d'une vérification annule ses emails, y compris pendant l'envoi.
CREATE FUNCTION app.challenge_consumed_cancels_emails() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE app.email_attempts a SET outcome = 'CANCELLED_IN_FLIGHT', finished_at = clock_timestamp()
    FROM app.email_outbox o
   WHERE o.challenge_id = NEW.id AND o.status = 'SENDING' AND a.email_id = o.id AND a.outcome IS NULL;
  UPDATE app.email_outbox SET status = 'CANCELLED', claim_token = NULL, locked_until = NULL, payload_encrypted = NULL
   WHERE challenge_id = NEW.id AND status IN ('PENDING', 'SENDING', 'RETRY_WAIT', 'UNCERTAIN');
  RETURN NULL;
END $$;
CREATE TRIGGER challenge_consumed_cancels_emails AFTER UPDATE OF consumed_at ON app.auth_challenges
  FOR EACH ROW WHEN (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
  EXECUTE FUNCTION app.challenge_consumed_cancels_emails();

CREATE TABLE app.job_leases (
  name          text PRIMARY KEY,
  holder        text,
  lease_until   timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0
);
INSERT INTO app.job_leases (name) VALUES ('email.send'), ('maintenance.purge');

GRANT SELECT ON app.email_outbox TO cp_app;
GRANT INSERT (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
  ON app.email_outbox TO cp_app;
GRANT UPDATE (status, normal_attempts, ambiguous_retry_scheduled, ambiguous_retry_claimed, next_attempt_at, locked_until, claim_token, accepted_at, payload_encrypted)
  ON app.email_outbox TO cp_app;
GRANT SELECT ON app.email_attempts TO cp_app;
GRANT INSERT (email_id, attempt_no, kind, claim_token) ON app.email_attempts TO cp_app;
GRANT UPDATE (finished_at, outcome, smtp_code, smtp_response, error_code, late_outcome, late_smtp_code) ON app.email_attempts TO cp_app;
GRANT SELECT ON app.job_leases TO cp_app;
GRANT UPDATE (holder, lease_until, fencing_token) ON app.job_leases TO cp_app;

COMMIT;
```

Le test « `PENDING → RETRY_WAIT` refusé » est refusé par le trigger de transition. Ajouter les modèles Prisma `EmailOutbox`, `EmailAttempt`, `JobLease` et leurs énumérations à `schema.prisma`, régénérer le client, mettre à jour `schema-presence.int.spec.ts` et l'assertion exacte des droits (`role-privileges.int.spec.ts`).

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/email-schema.int.spec.ts apps/api/test/integration/second-factor-schema.int.spec.ts apps/api/test/integration/schema-presence.int.spec.ts apps/api/test/integration/role-privileges.int.spec.ts apps/api/test/integration/migrate-from-previous.int.spec.ts` ; `pnpm vitest run --project unit apps/api/test/architecture` — Expected : PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/api
git commit -m "feat(db): email_outbox, email_attempts, job_leases, triggers de transition et de liaison aux vérifications

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5 : Module `mail` (pur) — types d'email, chiffrement, politique de reprise, modèles

**Files :**
- Create : `apps/api/src/modules/mail/email-kinds.ts`, `apps/api/src/modules/mail/payload-cipher.ts`, `apps/api/src/modules/mail/outbox-policy.ts`, `apps/api/src/modules/mail/templates.ts`
- Test : `apps/api/src/modules/mail/payload-cipher.spec.ts`, `apps/api/src/modules/mail/outbox-policy.spec.ts`, `apps/api/src/modules/mail/templates.spec.ts`

**Interfaces :**
- Produces :
  - `EMAIL_KINDS`, `type EmailKind`, `SECURITY_KINDS: ReadonlySet<EmailKind>`, `SECRET_KINDS: ReadonlySet<EmailKind>`, `KIND_SCHEMAS` (par type : `payload` et `secret` Zod, `secret: null` si aucun), `isSupportedKind(k)`
  - `class PayloadCipher { constructor(key: Buffer); encrypt(emailId: string, secret: Record<string, string>): Buffer; decrypt(emailId: string, data: Buffer): Record<string, string> }`
  - `MAX_NORMAL_ATTEMPTS = 5`, `RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200]`, `AMBIGUOUS_RETRY_DELAY_SECONDS = 900`, `type SendKind = 'ACCEPTED' | 'TEMP_FAIL' | 'PERM_FAIL' | 'AMBIGUOUS'`, `type Snapshot = { normalAttempts: number; retryClaimed: boolean }`, `type Decision = { status: 'ACCEPTED' | 'RETRY_WAIT' | 'UNCERTAIN' | 'FAILED'; delaySeconds: number | null }`, `nextState(s: Snapshot, outcome: SendKind): Decision`
  - `class RenderError extends Error`, `renderEmail(kind: EmailKind, payload: unknown, secret: unknown, ctx: { appOrigin: string }): { subject: string; text: string }`

- [ ] **Step 1 : Écrire les tests (échouent)**

`apps/api/src/modules/mail/payload-cipher.spec.ts` :

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PayloadCipher } from './payload-cipher.js';

const key = Buffer.alloc(32, 9);
describe('PayloadCipher (R13)', () => {
  it('aller-retour', () => {
    const c = new PayloadCipher(key);
    const id = randomUUID();
    expect(c.decrypt(id, c.encrypt(id, { code: '123456' }))).toEqual({ code: '123456' });
  });
  it('deux chiffrements du même contenu diffèrent, et le code n’apparaît pas en clair', () => {
    const c = new PayloadCipher(key);
    const id = randomUUID();
    const a = c.encrypt(id, { code: '123456' });
    const b = c.encrypt(id, { code: '123456' });
    expect(a.equals(b)).toBe(false);
    expect(a.toString('latin1')).not.toContain('123456');
  });
  it('un contenu recopié dans une autre ligne ne se déchiffre pas', () => {
    const c = new PayloadCipher(key);
    expect(() => c.decrypt(randomUUID(), c.encrypt(randomUUID(), { code: '1' }))).toThrow();
  });
  it('une altération est détectée', () => {
    const c = new PayloadCipher(key);
    const id = randomUUID();
    const data = c.encrypt(id, { code: '123456' });
    data[data.length - 1] = data[data.length - 1]! ^ 1;
    expect(() => c.decrypt(id, data)).toThrow();
  });
  it('une autre clé ne déchiffre pas ; une clé de mauvaise taille est refusée', () => {
    const id = randomUUID();
    const data = new PayloadCipher(key).encrypt(id, { code: '1' });
    expect(() => new PayloadCipher(Buffer.alloc(32, 1)).decrypt(id, data)).toThrow();
    expect(() => new PayloadCipher(Buffer.alloc(16))).toThrow();
  });
});
```

`apps/api/src/modules/mail/outbox-policy.spec.ts` :

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AMBIGUOUS_RETRY_DELAY_SECONDS, RETRY_DELAYS_SECONDS, nextState, type SendKind } from './outbox-policy.js';

describe('nextState (§ 2.4)', () => {
  it.each([1, 2, 3, 4])('échec temporaire à la tentative normale %i : nouvelle tentative après le délai prévu', (n) => {
    expect(nextState({ normalAttempts: n, retryClaimed: false }, 'TEMP_FAIL')).toEqual({ status: 'RETRY_WAIT', delaySeconds: RETRY_DELAYS_SECONDS[n - 1] });
  });
  it('les délais sont 1 min, 5 min, 30 min, 2 h', () => {
    expect([...RETRY_DELAYS_SECONDS]).toEqual([60, 300, 1800, 7200]);
  });
  it('échec temporaire à la 5ᵉ tentative normale : FAILED', () => {
    expect(nextState({ normalAttempts: 5, retryClaimed: false }, 'TEMP_FAIL')).toEqual({ status: 'FAILED', delaySeconds: null });
  });
  it('échec définitif : FAILED à tout moment', () => {
    expect(nextState({ normalAttempts: 1, retryClaimed: false }, 'PERM_FAIL').status).toBe('FAILED');
  });
  it.each([1, 3, 5])('résultat ambigu à la tentative normale %i : une reprise dans 15 min', (n) => {
    expect(nextState({ normalAttempts: n, retryClaimed: false }, 'AMBIGUOUS')).toEqual({ status: 'UNCERTAIN', delaySeconds: AMBIGUOUS_RETRY_DELAY_SECONDS });
  });
  it.each<SendKind>(['TEMP_FAIL', 'PERM_FAIL', 'AMBIGUOUS'])('après la reprise ambiguë, %s donne FAILED', (o) => {
    expect(nextState({ normalAttempts: 2, retryClaimed: true }, o)).toEqual({ status: 'FAILED', delaySeconds: null });
  });
  it('une acceptation est toujours ACCEPTED, même à la reprise', () => {
    expect(nextState({ normalAttempts: 5, retryClaimed: true }, 'ACCEPTED')).toEqual({ status: 'ACCEPTED', delaySeconds: null });
  });
});

describe('cycle de vie (propriété)', () => {
  type Status = 'PENDING' | 'RETRY_WAIT' | 'UNCERTAIN' | 'ACCEPTED' | 'FAILED';
  function run(outcomes: SendKind[]) {
    let snap = { normalAttempts: 0, retryClaimed: false };
    let status: Status = 'PENDING';
    let attempts = 0;
    let retries = 0;
    for (const o of outcomes) {
      if (status === 'ACCEPTED' || status === 'FAILED') break;
      if (status === 'UNCERTAIN') { snap = { ...snap, retryClaimed: true }; retries++; } else snap = { ...snap, normalAttempts: snap.normalAttempts + 1 };
      attempts++;
      status = nextState(snap, o).status;
    }
    return { status, attempts, retries };
  }
  it('jamais plus de 6 tentatives ni de 1 reprise ; toujours terminé après 6 résultats', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom<SendKind>('TEMP_FAIL', 'PERM_FAIL', 'AMBIGUOUS', 'ACCEPTED'), { minLength: 6, maxLength: 12 }), (outcomes) => {
      const r = run(outcomes);
      return r.attempts <= 6 && r.retries <= 1 && (r.status === 'ACCEPTED' || r.status === 'FAILED');
    }));
  });
  it('quatre échecs temporaires, un résultat ambigu au 5ᵉ essai, puis un échec : 6 tentatives exactement', () => {
    expect(run(['TEMP_FAIL', 'TEMP_FAIL', 'TEMP_FAIL', 'TEMP_FAIL', 'AMBIGUOUS', 'TEMP_FAIL'])).toEqual({ status: 'FAILED', attempts: 6, retries: 1 });
  });
});
```

`apps/api/src/modules/mail/templates.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { EMAIL_KINDS, SECURITY_KINDS } from './email-kinds.js';
import { RenderError, renderEmail } from './templates.js';

const ctx = { appOrigin: 'https://app.test' };
const TOKEN = 'T'.repeat(43);
const cases = [
  ['ADMIN_OTP', { purpose: 'LOGIN' }, { code: '123456' }],
  ['ADMIN_OTP', { purpose: 'STEP_UP' }, { code: '123456' }],
  ['ADMIN_EMAIL_CHANGE_OLD', { newEmail: 'nouveau@example.com' }, { code: '123456' }],
  ['ADMIN_EMAIL_CHANGE_NEW', {}, { code: '123456' }],
  ['PASSWORD_RESET', {}, { token: TOKEN }],
  ['SECURITY_ALERT', { event: 'PASSWORD_RESET' }, null],
  ['SECURITY_ALERT', { event: 'EMAIL_CHANGED' }, null],
  ['ADMIN_SECURITY_ALERT', { event: 'SECOND_FACTOR_FAILURES', accountEmail: 'a@example.com', failures: 3 }, null],
  ['ADMIN_SECURITY_ALERT', { event: 'SECOND_FACTOR_BLOCKED', accountEmail: 'a@example.com' }, null],
  ['ADMIN_SECURITY_ALERT', { event: 'EMAIL_CHANGED', accountEmail: 'a@example.com' }, null],
  ['ADMIN_SECURITY_ALERT', { event: 'RECOVERY_CODE_ISSUED', accountEmail: 'a@example.com' }, null],
  ['TEST', {}, null],
] as const;

describe('renderEmail', () => {
  it.each(cases)('%s %j : sujet et texte non vides, tutoiement', (kind, payload, secret) => {
    const r = renderEmail(kind, payload, secret, ctx);
    expect(r.subject.length).toBeGreaterThan(3);
    expect(r.text.length).toBeGreaterThan(20);
    expect(`${r.subject}\n${r.text}`).not.toMatch(/\b(vous|votre|vos)\b/i);
  });
  it('le code figure dans le texte, jamais dans le sujet', () => {
    const r = renderEmail('ADMIN_OTP', { purpose: 'LOGIN' }, { code: '123456' }, ctx);
    expect(r.text).toContain('123456');
    expect(r.subject).not.toContain('123456');
    expect(r.text).toContain('10 minutes');
  });
  it('le lien de réinitialisation met le jeton dans le fragment (R8)', () => {
    const r = renderEmail('PASSWORD_RESET', {}, { token: TOKEN }, ctx);
    expect(r.text).toContain(`https://app.test/reinitialiser-mot-de-passe#token=${TOKEN}`);
    expect(r.subject).not.toContain(TOKEN);
    expect(r.text).toContain('30 minutes');
  });
  it('un champ inconnu, un secret manquant ou mal formé fait échouer le rendu', () => {
    expect(() => renderEmail('ADMIN_OTP', { purpose: 'LOGIN', extra: 1 }, { code: '123456' }, ctx)).toThrow(RenderError);
    expect(() => renderEmail('ADMIN_OTP', { purpose: 'LOGIN' }, null, ctx)).toThrow(RenderError);
    expect(() => renderEmail('ADMIN_OTP', { purpose: 'LOGIN' }, { code: '12' }, ctx)).toThrow(RenderError);
  });
  it('un type sans modèle au lot 1b échoue en RenderError (R13)', () => {
    for (const k of ['WELCOME', 'REFUSAL', 'DIGEST', 'ANNOUNCEMENT', 'ADMIN_ALERT'] as const) expect(() => renderEmail(k, {}, null, ctx)).toThrow(RenderError);
  });
});

describe('types d’email', () => {
  it('les types de sécurité sont exactement ceux que la spec exempte de bulk_email_paused', () => {
    expect([...SECURITY_KINDS].sort()).toEqual(['ADMIN_EMAIL_CHANGE_NEW', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_OTP', 'ADMIN_SECURITY_ALERT', 'PASSWORD_RESET', 'SECURITY_ALERT']);
    expect(EMAIL_KINDS).toHaveLength(12);
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules/mail` — Expected : FAIL (modules absents).

- [ ] **Step 2 : Implémenter**

`apps/api/src/modules/mail/email-kinds.ts` :

```ts
import { z } from 'zod';

export const EMAIL_KINDS = [
  'WELCOME', 'REFUSAL', 'PASSWORD_RESET', 'DIGEST', 'ANNOUNCEMENT', 'ADMIN_ALERT', 'SECURITY_ALERT',
  'ADMIN_SECURITY_ALERT', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW', 'TEST',
] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** Envoyés même quand bulk_email_paused est vrai (§ 2.4) ; la réservation SQL reçoit cette liste en paramètre. */
export const SECURITY_KINDS: ReadonlySet<EmailKind> = new Set<EmailKind>([
  'PASSWORD_RESET', 'SECURITY_ALERT', 'ADMIN_SECURITY_ALERT', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW',
]);
/** Portent un secret chiffré (miroir du CHECK email_outbox_secret_kinds). */
export const SECRET_KINDS: ReadonlySet<EmailKind> = new Set<EmailKind>(['PASSWORD_RESET', 'ADMIN_OTP', 'ADMIN_EMAIL_CHANGE_OLD', 'ADMIN_EMAIL_CHANGE_NEW']);

const otp = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });

/** Types disposant d'un modèle au lot 1b. `payload` n'est jamais secret ; `secret` est chiffré (AES-256-GCM). */
export const KIND_SCHEMAS = {
  ADMIN_OTP: { payload: z.strictObject({ purpose: z.enum(['LOGIN', 'STEP_UP']) }), secret: otp },
  ADMIN_EMAIL_CHANGE_OLD: { payload: z.strictObject({ newEmail: z.string().max(254) }), secret: otp },
  ADMIN_EMAIL_CHANGE_NEW: { payload: z.strictObject({}), secret: otp },
  PASSWORD_RESET: { payload: z.strictObject({}), secret: z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }) },
  SECURITY_ALERT: { payload: z.strictObject({ event: z.enum(['PASSWORD_RESET', 'EMAIL_CHANGED']) }), secret: null },
  ADMIN_SECURITY_ALERT: {
    payload: z.strictObject({
      event: z.enum(['SECOND_FACTOR_FAILURES', 'SECOND_FACTOR_BLOCKED', 'EMAIL_CHANGED', 'RECOVERY_CODE_ISSUED']),
      accountEmail: z.string().max(254),
      failures: z.number().int().min(0).optional(),
    }),
    secret: null,
  },
  TEST: { payload: z.strictObject({}), secret: null },
} as const;
export type SupportedKind = keyof typeof KIND_SCHEMAS;
export const isSupportedKind = (k: EmailKind): k is SupportedKind => k in KIND_SCHEMAS;
```

`apps/api/src/modules/mail/payload-cipher.ts` :

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM ; données additionnelles authentifiées = identifiant de l'email (R13). Format : IV ‖ étiquette ‖ chiffré. */
export class PayloadCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('OUTBOX_PAYLOAD_KEY must be 32 bytes');
  }

  encrypt(emailId: string, secret: Record<string, string>): Buffer {
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(emailId, 'utf8'));
    const ct = Buffer.concat([c.update(JSON.stringify(secret), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  decrypt(emailId: string, data: Buffer): Record<string, string> {
    const d = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, IV_BYTES));
    d.setAAD(Buffer.from(emailId, 'utf8'));
    d.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const plain = Buffer.concat([d.update(data.subarray(IV_BYTES + TAG_BYTES)), d.final()]);
    return JSON.parse(plain.toString('utf8')) as Record<string, string>;
  }
}
```

`apps/api/src/modules/mail/outbox-policy.ts` :

```ts
export const MAX_NORMAL_ATTEMPTS = 5;
/** Délais après la 1ʳᵉ, 2ᵉ, 3ᵉ et 4ᵉ tentative normale (§ 2.4). */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200] as const;
export const AMBIGUOUS_RETRY_DELAY_SECONDS = 900;

export type SendKind = 'ACCEPTED' | 'TEMP_FAIL' | 'PERM_FAIL' | 'AMBIGUOUS';
/** État de l'email au moment de la réservation (le bail garantit que personne d'autre ne le change). */
export type Snapshot = { normalAttempts: number; retryClaimed: boolean };
export type Decision = { status: 'ACCEPTED' | 'RETRY_WAIT' | 'UNCERTAIN' | 'FAILED'; delaySeconds: number | null };

export function nextState(s: Snapshot, outcome: SendKind): Decision {
  if (outcome === 'ACCEPTED') return { status: 'ACCEPTED', delaySeconds: null };
  // Après la reprise ambiguë, tout résultat autre qu'une acceptation donne FAILED.
  if (s.retryClaimed || outcome === 'PERM_FAIL') return { status: 'FAILED', delaySeconds: null };
  if (outcome === 'AMBIGUOUS') return { status: 'UNCERTAIN', delaySeconds: AMBIGUOUS_RETRY_DELAY_SECONDS };
  if (s.normalAttempts >= MAX_NORMAL_ATTEMPTS) return { status: 'FAILED', delaySeconds: null };
  return { status: 'RETRY_WAIT', delaySeconds: RETRY_DELAYS_SECONDS[s.normalAttempts - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1]! };
}
```

`apps/api/src/modules/mail/templates.ts` :

```ts
import { KIND_SCHEMAS, isSupportedKind, type EmailKind } from './email-kinds.js';

export class RenderError extends Error {}
export type RenderContext = { appOrigin: string };
export const RESET_PASSWORD_PATH = '/reinitialiser-mot-de-passe';

const SIGNATURE = '\n\nL’équipe ClassePulse';
const lines = (...l: string[]): string => `${l.join('\n')}${SIGNATURE}`;

/** Modèles en texte brut, français, tutoiement. Un champ inconnu ou un secret invalide fait échouer le rendu. */
export function renderEmail(kind: EmailKind, payload: unknown, secret: unknown, ctx: RenderContext): { subject: string; text: string } {
  if (!isSupportedKind(kind)) throw new RenderError(`no template for ${kind}`);
  const schemas = KIND_SCHEMAS[kind];
  const p = schemas.payload.safeParse(payload);
  if (!p.success) throw new RenderError(`invalid payload for ${kind}`);
  let s: Record<string, string> = {};
  if (schemas.secret) {
    const parsed = schemas.secret.safeParse(secret);
    if (!parsed.success) throw new RenderError(`invalid secret for ${kind}`);
    s = parsed.data as Record<string, string>;
  }
  const d = p.data as Record<string, unknown>;
  switch (kind) {
    case 'ADMIN_OTP':
      return {
        subject: d.purpose === 'STEP_UP' ? 'Ton code de vérification ClassePulse' : 'Ton code de connexion ClassePulse',
        text: lines('Bonjour,', '', `Voici ton code : ${s.code}`, '',
          'Il est valable 10 minutes et ne sert qu’une fois. Si tu n’es pas à l’origine de cette demande, change ton mot de passe sans attendre et préviens un autre administrateur.'),
      };
    case 'ADMIN_EMAIL_CHANGE_OLD':
      return {
        subject: 'Confirme le changement de ton adresse email',
        text: lines('Bonjour,', '', `Tu as demandé à remplacer l’adresse de ton compte par ${String(d.newEmail)}.`, `Voici ton code de confirmation : ${s.code}`, '',
          'Il est valable 10 minutes. Si ce n’est pas toi, ne l’utilise pas et change ton mot de passe sans attendre.'),
      };
    case 'ADMIN_EMAIL_CHANGE_NEW':
      return {
        subject: 'Confirme ta nouvelle adresse email',
        text: lines('Bonjour,', '', 'Cette adresse va devenir celle de ton compte administrateur ClassePulse.', `Voici ton code de confirmation : ${s.code}`, '',
          'Il est valable 10 minutes. Si tu ne reconnais pas cette demande, ignore ce message.'),
      };
    case 'PASSWORD_RESET':
      return {
        subject: 'Réinitialise ton mot de passe ClassePulse',
        text: lines('Bonjour,', '', 'Pour choisir un nouveau mot de passe, ouvre ce lien :', `${ctx.appOrigin}${RESET_PASSWORD_PATH}#token=${s.token}`, '',
          'Il est valable 30 minutes et ne sert qu’une fois. Si tu n’as rien demandé, ignore ce message : ton mot de passe reste inchangé.'),
      };
    case 'SECURITY_ALERT':
      return d.event === 'PASSWORD_RESET'
        ? { subject: 'Ton mot de passe ClassePulse a été réinitialisé', text: lines('Bonjour,', '', 'Le mot de passe de ton compte vient d’être réinitialisé et tes appareils ont été déconnectés.', 'Si ce n’est pas toi, contacte un administrateur sans attendre.') }
        : { subject: 'L’adresse de ton compte ClassePulse a changé', text: lines('Bonjour,', '', 'L’adresse email de ton compte vient d’être remplacée. Cette adresse ne recevra plus de messages.', 'Si ce n’est pas toi, contacte un autre administrateur sans attendre.') };
    case 'ADMIN_SECURITY_ALERT': {
      const who = String(d.accountEmail);
      const what: Record<string, string> = {
        SECOND_FACTOR_FAILURES: `Plusieurs codes erronés ont été saisis pour le compte administrateur ${who} (${String(d.failures ?? '?')} échecs en 60 minutes).`,
        SECOND_FACTOR_BLOCKED: `Le compte administrateur ${who} est bloqué après 10 codes erronés. Seul un opérateur peut le débloquer.`,
        EMAIL_CHANGED: `L’adresse du compte administrateur ${who} vient d’être remplacée.`,
        RECOVERY_CODE_ISSUED: `Un code de récupération vient d’être émis par un opérateur pour le compte administrateur ${who}.`,
      };
      return { subject: 'Alerte de sécurité ClassePulse', text: lines('Bonjour,', '', what[String(d.event)]!, '', 'Si tu ne reconnais pas cet événement, préviens les autres administrateurs.') };
    }
    case 'TEST':
      return { subject: 'Test ClassePulse', text: lines('Ceci est un message de test.') };
  }
}
```

Le `switch` est exhaustif sur `SupportedKind` (le contrôle `isSupportedKind` réduit le type) : TypeScript refuse un cas oublié.

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project unit apps/api/src/modules/mail` ; `pnpm typecheck` ; `pnpm lint` — Expected : PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/api/src/modules/mail
git commit -m "feat(mail): types d'email, chiffrement des secrets, politique de reprise et modèles de texte

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6 : File d'emails — dépôt SQL, mise en file, réservation atomique, finalisation

**Files :**
- Create : `apps/api/src/modules/mail/outbox.repository.ts`, `apps/api/src/modules/mail/mail.service.ts`, `apps/api/src/modules/mail/mail-delivery.service.ts`, `apps/api/src/modules/mail/mail.module.ts`, `apps/api/test/support/mail.ts`
- Modify : `apps/api/prisma/migrations/20261014000300_email_outbox/migration.sql` (déclencheur d'annulation : Step 2 — la migration n'est pas encore publiée)
- Test : `apps/api/test/integration/mail-outbox.int.spec.ts`

**Interfaces :**
- Consumes : `PayloadCipher`, `KIND_SCHEMAS`, `SECURITY_KINDS`, `nextState` (tâche 5) ; `PrismaService`, `TxClient` ; `AuthzService`.
- Produces :
  - `type EnqueueInput = { kind: EmailKind; recipientUserId: string; toAddress: string; dedupeKey: string; payload: Record<string, unknown>; secret?: Record<string, string>; expiresInSeconds?: number; challengeId?: string }` (avec `challengeId`, l'expiration de l'email est celle de la vérification ; sans, `expiresInSeconds` est obligatoire)
  - `MailService.enqueueInTx(tx: TxClient, actor: Actor, input: EnqueueInput): Promise<string | null>` (identifiant, ou `null` si la clé anti-doublon existe déjà ; action `mail.enqueue`)
  - `type ReservedEmail = { id: string; kind: EmailKind; toAddress: string; messageId: string; payload: Record<string, unknown>; payloadEncrypted: Buffer | null; challengeId: string | null; normalAttempts: number; retryClaimed: boolean; claimToken: string }`
  - `type SendResult = { kind: SendKind; smtpCode: number | null; response: string | null; errorCode: string | null }`
  - `MailDeliveryService` (acteur `SystemActor`) : `reserve(actor, batch, leaseSeconds): Promise<ReservedEmail[]>` ; `finalize(actor, row, result): Promise<boolean>` ; `recordLateOutcome(actor, row, result): Promise<void>` ; `challengeStillActive(actor, emailId): Promise<boolean>` ; `cancelSending(actor, row): Promise<boolean>` ; `sweepExpiredLeases(actor, limit): Promise<number>` ; `expireOverdue(actor, limit): Promise<number>`
  - `MailModule.register(outboxKey: Buffer): DynamicModule` (exporte `MailService`, `MailDeliveryService`)
  - test : `SYSTEM`, `cipher`, `mailTestModule(db)`, `seedChallengeEmail(db)`, `seedPlainEmail(db)`, `forceEmail`, `emailRow`, `attemptRows` dans `test/support/mail.ts`

- [ ] **Step 1 : Aides de test**

`apps/api/test/support/mail.ts` :

```ts
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { v7 as uuidv7 } from 'uuid';
import { ConfigModule } from '../../src/config/config.module.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { SystemActor } from '../../src/modules/authz/actor.js';
import { AuthzModule } from '../../src/modules/authz/authz.module.js';
import { MailDeliveryService } from '../../src/modules/mail/mail-delivery.service.js';
import { MailModule } from '../../src/modules/mail/mail.module.js';
import { MailService } from '../../src/modules/mail/mail.service.js';
import { PayloadCipher } from '../../src/modules/mail/payload-cipher.js';
import { TEST_OUTBOX_KEY, testConfig } from './app.js';
import { connectAs } from './pg.js';

export const SYSTEM: SystemActor = { kind: 'system', job: 'email.send' };
export const cipher = new PayloadCipher(TEST_OUTBOX_KEY);

export async function mailTestModule(db: string) {
  const mod = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MailModule.register(TEST_OUTBOX_KEY)],
  }).compile();
  await mod.init();
  return { mail: mod.get(MailService), delivery: mod.get(MailDeliveryService), prisma: mod.get(PrismaService), close: () => mod.close() };
}

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';
/** Insère (sous cp_app) un administrateur, une vérification LOGIN active et son email ADMIN_OTP en file. */
export async function seedChallengeEmail(db: string, code = '123456') {
  const c = await connectAs('cp_app', db);
  try {
    const userId = uuidv7();
    const email = `adm.${userId}@example.com`;
    await c.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop',$3,'ADMIN')`, [userId, email, HASH]);
    const challengeId = uuidv7();
    await c.query(`insert into app.auth_challenges (id, user_id, purpose, token_hash, code_hmac, expires_at) values ($1,$2,'LOGIN',$3,$4, clock_timestamp() + interval '10 minutes')`, [challengeId, userId, randomBytes(32), randomBytes(32)]);
    const emailId = uuidv7();
    await c.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
       values ($1,$2,$3,'ADMIN_OTP',$4,'{"purpose":"LOGIN"}'::jsonb,$5,$6,(select expires_at from app.auth_challenges where id = $7),$7)`,
      [emailId, userId, email, `otp:${challengeId}`, cipher.encrypt(emailId, { code }), randomUUID(), challengeId]);
    return { userId, email, challengeId, emailId, code };
  } finally { await c.end(); }
}

/** Email sans vérification ni destinataire (type TEST par défaut), pour la file elle-même. */
export async function seedPlainEmail(db: string, over: { kind?: string; ttl?: string } = {}) {
  const c = await connectAs('cp_app', db);
  try {
    const id = uuidv7();
    await c.query(
      `insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at)
       values ($1,null,'dest@example.com',$2::app.email_kind,$3,'{}'::jsonb,null,$4, clock_timestamp() + interval '${over.ttl ?? '1 hour'}')`,
      [id, over.kind ?? 'TEST', `k:${id}`, randomUUID()]);
    return id;
  } finally { await c.end(); }
}

/** Fixe directement l'état d'un email (préparation de donnée sous cp_app : les colonnes sont accordées). */
export async function forceEmail(db: string, id: string, sets: string): Promise<void> {
  const c = await connectAs('cp_app', db);
  try { await c.query(`update app.email_outbox set ${sets} where id = $1`, [id]); } finally { await c.end(); }
}

export async function emailRow(db: string, id: string) {
  const c = await connectAs('cp_app', db);
  try {
    const r = await c.query(
      `select status, normal_attempts, ambiguous_retry_scheduled as scheduled, ambiguous_retry_claimed as claimed, payload_encrypted is not null as has_payload,
              extract(epoch from (next_attempt_at - clock_timestamp()))::int as in_seconds, accepted_at is not null as accepted
         from app.email_outbox where id = $1`, [id]);
    return r.rows[0] as { status: string; normal_attempts: number; scheduled: boolean; claimed: boolean; has_payload: boolean; in_seconds: number; accepted: boolean };
  } finally { await c.end(); }
}

export async function attemptRows(db: string, id: string) {
  const c = await connectAs('cp_app', db);
  try {
    const r = await c.query('select attempt_no, kind, outcome, smtp_code, error_code, late_outcome, late_smtp_code from app.email_attempts where email_id = $1 order by attempt_no', [id]);
    return r.rows as { attempt_no: number; kind: string; outcome: string | null; smtp_code: number | null; error_code: string | null; late_outcome: string | null; late_smtp_code: number | null }[];
  } finally { await c.end(); }
}
```

- [ ] **Step 2 : Corriger le déclencheur d'annulation de la tâche 4**

Dans `20261014000300_email_outbox/migration.sql` (pas encore appliquée hors développement), remplacer le corps de `app.challenge_consumed_cancels_emails()` : la tentative en cours n'est close que pour les emails **réellement annulés**. Sinon, face à une finalisation concurrente, l'email serait `ACCEPTED` et sa tentative `CANCELLED_IN_FLIGHT`. L'ordre de verrouillage est celui de la finalisation (email, puis tentative) :

```sql
CREATE FUNCTION app.challenge_consumed_cancels_emails() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  WITH cancelled AS (
    UPDATE app.email_outbox SET status = 'CANCELLED', claim_token = NULL, locked_until = NULL, payload_encrypted = NULL
     WHERE challenge_id = NEW.id AND status IN ('PENDING', 'SENDING', 'RETRY_WAIT', 'UNCERTAIN')
    RETURNING id)
  UPDATE app.email_attempts a SET outcome = 'CANCELLED_IN_FLIGHT', finished_at = clock_timestamp()
    FROM cancelled c WHERE a.email_id = c.id AND a.outcome IS NULL;
  RETURN NULL;
END $$;
```

Le test « annule l'email en file et clôt la tentative en cours » de la tâche 4 reste valable ; la tâche 6 ajoute le test de concurrence.

- [ ] **Step 3 : Écrire les tests (échouent)**

`apps/api/test/integration/mail-outbox.int.spec.ts` :

```ts
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReservedEmail, SendResult } from '../../src/modules/mail/mail-delivery.service.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { SYSTEM, attemptRows, cipher, emailRow, forceEmail, mailTestModule, seedChallengeEmail, seedPlainEmail } from '../support/mail.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let m: Awaited<ReturnType<typeof mailTestModule>>;
beforeAll(async () => { db = await createTestDatabase(); m = await mailTestModule(db); });
afterAll(async () => { await m.close(); });

const ok: SendResult = { kind: 'ACCEPTED', smtpCode: 250, response: '250 OK', errorCode: null };
const temp: SendResult = { kind: 'TEMP_FAIL', smtpCode: 451, response: '451 later', errorCode: null };
const amb: SendResult = { kind: 'AMBIGUOUS', smtpCode: null, response: null, errorCode: 'ECONNRESET' };
const makeDue = (id: string) => forceEmail(db, id, `next_attempt_at = clock_timestamp() - interval '1 second'`);
async function reserveOne(): Promise<ReservedEmail> {
  const r = await m.delivery.reserve(SYSTEM, 1, 120);
  expect(r).toHaveLength(1);
  return r[0]!;
}
/** Vide la file de tout ce qui est dû, pour que chaque test parte d'une file contrôlée. */
async function drainQueue() {
  for (;;) {
    const r = await m.delivery.reserve(SYSTEM, 50, 120);
    if (r.length === 0) return;
    for (const x of r) await m.delivery.finalize(SYSTEM, x, ok);
  }
}

describe('enqueueInTx', () => {
  it('chiffre le secret, ne met rien de secret dans payload, et refuse un doublon', async () => {
    const u = await seedChallengeEmail(db); // fournit un administrateur
    const id = await m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, { kind: 'anonymous', ip: '203.0.113.1' }, {
      kind: 'PASSWORD_RESET', recipientUserId: u.userId, toAddress: u.email, dedupeKey: `pr:${randomUUID()}`, payload: {}, secret: { token: 'T'.repeat(43) }, expiresInSeconds: 1800 }));
    expect(id).toBeTruthy();
    const c = await connectAs('cp_app', db);
    const r = await c.query('select payload, payload_encrypted from app.email_outbox where id = $1', [id]);
    await c.end();
    expect(JSON.stringify(r.rows[0].payload)).not.toContain('TTTT');
    expect(r.rows[0].payload_encrypted.toString('latin1')).not.toContain('TTTT');
    expect(cipher.decrypt(id!, r.rows[0].payload_encrypted)).toEqual({ token: 'T'.repeat(43) });
    const input = { kind: 'TEST' as const, recipientUserId: u.userId, toAddress: u.email, dedupeKey: `dup:${randomUUID()}`, payload: {}, expiresInSeconds: 60 };
    expect(await m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, SYSTEM, input))).toBeTruthy();
    expect(await m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, SYSTEM, input))).toBeNull();
  });
  it('refuse un contenu hors schéma et un secret manquant', async () => {
    const base = { recipientUserId: uuidv7(), toAddress: 'a@example.com', dedupeKey: `x:${randomUUID()}`, expiresInSeconds: 60 };
    await expect(m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, SYSTEM, { ...base, kind: 'TEST', payload: { extra: 1 } }))).rejects.toThrow();
    await expect(m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, SYSTEM, { ...base, kind: 'PASSWORD_RESET', payload: {} }))).rejects.toThrow();
  });
  it('la CLI ne met pas en file (action mail.enqueue)', async () => {
    await expect(m.prisma.withTx((tx) => m.mail.enqueueInTx(tx, { kind: 'cli', command: 'create-class' }, { kind: 'TEST', recipientUserId: uuidv7(), toAddress: 'a@example.com', dedupeKey: `c:${randomUUID()}`, payload: {}, expiresInSeconds: 60 }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('reserve : filtres', () => {
  it('ne réserve ni un email pas encore dû, ni un email expiré ; crée la tentative dans la même instruction', async () => {
    await drainQueue();
    const future = await seedPlainEmail(db);
    await forceEmail(db, future, `next_attempt_at = clock_timestamp() + interval '1 hour'`);
    const expired = await seedPlainEmail(db, { ttl: '1 second' });
    await new Promise((r) => setTimeout(r, 1200));
    const due = await seedPlainEmail(db);
    const got = await m.delivery.reserve(SYSTEM, 10, 120);
    expect(got.map((x) => x.id)).toEqual([due]);
    expect(got[0]).toMatchObject({ normalAttempts: 1, retryClaimed: false });
    expect(await attemptRows(db, due)).toMatchObject([{ attempt_no: 1, kind: 'NORMAL', outcome: null }]);
    expect((await emailRow(db, future)).status).toBe('PENDING');
    expect((await emailRow(db, expired)).status).toBe('PENDING');
  });
  it('bulk_email_paused : seuls les types de sécurité partent', async () => {
    await drainQueue();
    const owner = await connectAs('cp_owner', db);
    await owner.query('update app.ops_settings set bulk_email_paused = true');
    try {
      const bulk = await seedPlainEmail(db, { kind: 'DIGEST' });
      const security = await seedPlainEmail(db, { kind: 'SECURITY_ALERT' });
      const got = await m.delivery.reserve(SYSTEM, 10, 120);
      expect(got.map((x) => x.id)).toEqual([security]);
      expect((await emailRow(db, bulk)).status).toBe('PENDING');
    } finally {
      await owner.query('update app.ops_settings set bulk_email_paused = false');
      await owner.end();
    }
  });
});

describe('reserve : atomicité (concurrence)', () => {
  it('quatre réservations parallèles se partagent 20 emails sans en prendre un deux fois', async () => {
    await drainQueue();
    const ids = await Promise.all(Array.from({ length: 20 }, () => seedPlainEmail(db)));
    const batches = await Promise.all([1, 2, 3, 4].map(() => m.delivery.reserve(SYSTEM, 10, 120)));
    const all = batches.flat().map((x) => x.id);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ids].sort());
    for (const id of ids) expect(await attemptRows(db, id)).toHaveLength(1);
  });
  it('un email à sa 4ᵉ tentative normale n’est réservé qu’une fois sur 12 appels parallèles ; l’échec suivant donne FAILED', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    await forceEmail(db, id, `status = 'SENDING', claim_token = gen_random_uuid(), locked_until = clock_timestamp() + interval '1 minute', normal_attempts = 4`);
    await forceEmail(db, id, `status = 'RETRY_WAIT', claim_token = null, locked_until = null, next_attempt_at = clock_timestamp() - interval '1 second'`);
    const results = await Promise.all(Array.from({ length: 12 }, () => m.delivery.reserve(SYSTEM, 1, 120)));
    const mine = results.flat().filter((x) => x.id === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.normalAttempts).toBe(5);
    expect(await m.delivery.finalize(SYSTEM, mine[0]!, temp)).toBe(true);
    expect((await emailRow(db, id)).status).toBe('FAILED');
    expect(await m.delivery.reserve(SYSTEM, 5, 120)).toEqual([]);
  });
  it('une réservation ignore une ligne verrouillée par une transaction ouverte (SKIP LOCKED), sans attendre', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    await holder.query('select id from app.email_outbox where id = $1 for update', [id]);
    const t0 = Date.now();
    expect(await m.delivery.reserve(SYSTEM, 5, 120)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2000);
    await holder.query('rollback');
    await holder.end();
    expect((await m.delivery.reserve(SYSTEM, 5, 120)).map((x) => x.id)).toEqual([id]);
  });
});

describe('finalize : politique du § 2.4', () => {
  it('échec temporaire : RETRY_WAIT à +1 min ; ambigu : UNCERTAIN à +15 min ; la reprise ambiguë qui échoue donne FAILED', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    let row = await reserveOne();
    expect(await m.delivery.finalize(SYSTEM, row, temp)).toBe(true);
    let e = await emailRow(db, id);
    expect(e.status).toBe('RETRY_WAIT');
    expect(e.in_seconds).toBeGreaterThan(50); expect(e.in_seconds).toBeLessThanOrEqual(60);
    await makeDue(id);
    row = await reserveOne();
    expect(row.normalAttempts).toBe(2);
    expect(await m.delivery.finalize(SYSTEM, row, amb)).toBe(true);
    e = await emailRow(db, id);
    expect(e).toMatchObject({ status: 'UNCERTAIN', scheduled: true, claimed: false });
    expect(e.in_seconds).toBeGreaterThan(890); expect(e.in_seconds).toBeLessThanOrEqual(900);
    await makeDue(id);
    row = await reserveOne();
    expect(row).toMatchObject({ normalAttempts: 2, retryClaimed: true });
    expect(await m.delivery.finalize(SYSTEM, row, temp)).toBe(true);
    expect((await emailRow(db, id)).status).toBe('FAILED');
    expect((await attemptRows(db, id)).map((a) => [a.attempt_no, a.kind, a.outcome])).toEqual([[1, 'NORMAL', 'TEMP_FAIL'], [2, 'NORMAL', 'AMBIGUOUS'], [3, 'AMBIGUOUS_RETRY', 'TEMP_FAIL']]);
  });
  it('cinq échecs temporaires : FAILED à la 5ᵉ ; ambigu au 5ᵉ essai : une reprise, 6 tentatives au plus', async () => {
    await drainQueue();
    const a = await seedPlainEmail(db);
    for (let i = 1; i <= 5; i++) { await m.delivery.finalize(SYSTEM, await reserveOne(), temp); if (i < 5) await makeDue(a); }
    expect(await emailRow(db, a)).toMatchObject({ status: 'FAILED', has_payload: false });
    expect(await attemptRows(db, a)).toHaveLength(5);

    const b = await seedPlainEmail(db);
    for (let i = 1; i <= 4; i++) { await m.delivery.finalize(SYSTEM, await reserveOne(), temp); await makeDue(b); }
    await m.delivery.finalize(SYSTEM, await reserveOne(), amb);
    expect((await emailRow(db, b)).status).toBe('UNCERTAIN');
    await makeDue(b);
    const retry = await reserveOne();
    expect(retry).toMatchObject({ normalAttempts: 5, retryClaimed: true });
    await m.delivery.finalize(SYSTEM, retry, temp);
    expect((await emailRow(db, b)).status).toBe('FAILED');
    expect(await attemptRows(db, b)).toHaveLength(6);
  });
  it('acceptation : accepted_at posé et contenu chiffré effacé ; mauvais jeton : rien ne change', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    const row = await reserveOne();
    expect(row.id).toBe(s.emailId);
    expect(row.payloadEncrypted).not.toBeNull();
    expect(await m.delivery.finalize(SYSTEM, { ...row, claimToken: randomUUID() }, ok)).toBe(false);
    expect((await emailRow(db, s.emailId)).status).toBe('SENDING');
    expect(await m.delivery.finalize(SYSTEM, row, ok)).toBe(true);
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'ACCEPTED', accepted: true, has_payload: false });
    expect((await attemptRows(db, s.emailId))[0]).toMatchObject({ outcome: 'ACCEPTED', smtp_code: 250 });
  });
});

describe('annulation pendant l’envoi, dans les deux ordres (verrou observé)', () => {
  it('ordre 1 : l’annulation est validée en dernier → la finalisation attend, ne réactive rien, le résultat tardif n’écrit que son code', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    const row = await reserveOne();
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [s.challengeId]);
    const pending = m.delivery.finalize(SYSTEM, row, ok);
    await waitForLockWait(db, pid);
    await holder.query('commit');
    await holder.end();
    expect(await pending).toBe(false);
    await m.delivery.recordLateOutcome(SYSTEM, row, ok);
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'CANCELLED', has_payload: false });
    expect((await attemptRows(db, s.emailId))[0]).toMatchObject({ outcome: 'CANCELLED_IN_FLIGHT', late_outcome: 'ACCEPTED', late_smtp_code: 250 });
  });
  it('ordre 2 : la finalisation est validée en dernier → l’annulation attend puis ne change rien', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    await reserveOne();
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query(`update app.email_outbox set status = 'ACCEPTED', claim_token = null, locked_until = null, payload_encrypted = null, accepted_at = clock_timestamp() where id = $1`, [s.emailId]);
    await holder.query(`update app.email_attempts set outcome = 'ACCEPTED', smtp_code = 250, finished_at = clock_timestamp() where email_id = $1 and outcome is null`, [s.emailId]);
    const other = await connectAs('cp_app', db);
    const consuming = other.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [s.challengeId]);
    await waitForLockWait(db, pid);
    await holder.query('commit');
    await consuming;
    await holder.end();
    await other.end();
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'ACCEPTED', accepted: true });
    expect((await attemptRows(db, s.emailId))[0]).toMatchObject({ outcome: 'ACCEPTED' });
  });
  it('challengeStillActive et cancelSending (contrôle juste avant l’envoi)', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    const row = await reserveOne();
    expect(await m.delivery.challengeStillActive(SYSTEM, row.id)).toBe(true);
    // expires_at n'est pas modifiable par cp_app : préparation de donnée sous cp_owner.
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.auth_challenges set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [s.challengeId]);
    await o.end();
    expect(await m.delivery.challengeStillActive(SYSTEM, row.id)).toBe(false);
    expect(await m.delivery.cancelSending(SYSTEM, row)).toBe(true);
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'CANCELLED', has_payload: false });
    expect((await attemptRows(db, s.emailId))[0]!.outcome).toBe('CANCELLED_IN_FLIGHT');
  });
});

describe('bail expiré et expiration', () => {
  it('bail expiré : tentative AMBIGUOUS/LEASE_EXPIRED puis règle ambiguë ; reprise déjà faite : FAILED', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    await reserveOne();
    await forceEmail(db, id, `locked_until = clock_timestamp() - interval '1 second'`);
    expect(await m.delivery.sweepExpiredLeases(SYSTEM, 10)).toBe(1);
    expect(await emailRow(db, id)).toMatchObject({ status: 'UNCERTAIN', scheduled: true, claimed: false });
    expect((await attemptRows(db, id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', error_code: 'LEASE_EXPIRED' });
    await makeDue(id);
    await reserveOne();
    await forceEmail(db, id, `locked_until = clock_timestamp() - interval '1 second'`);
    expect(await m.delivery.sweepExpiredLeases(SYSTEM, 10)).toBe(1);
    expect(await emailRow(db, id)).toMatchObject({ status: 'FAILED', has_payload: false });
  });
  it('le balayage ignore, sans attendre, une ligne en cours de finalisation ; la finalisation valide gagne ensuite', async () => {
    await drainQueue();
    const id = await seedPlainEmail(db);
    const row = await reserveOne();
    await forceEmail(db, id, `locked_until = clock_timestamp() - interval '1 second'`);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    await holder.query('select id from app.email_outbox where id = $1 for update', [id]);
    expect(await m.delivery.sweepExpiredLeases(SYSTEM, 10)).toBe(0);
    await holder.query('rollback');
    await holder.end();
    expect(await m.delivery.finalize(SYSTEM, row, ok)).toBe(true);
    expect((await emailRow(db, id)).status).toBe('ACCEPTED');
  });
  it('expireOverdue : EXPIRED et contenu effacé', async () => {
    await drainQueue();
    const s = await seedChallengeEmail(db);
    const o = await connectAs('cp_owner', db); // expires_at n'est pas modifiable par cp_app
    await o.query(`update app.email_outbox set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [s.emailId]);
    await o.end();
    expect(await m.delivery.expireOverdue(SYSTEM, 10)).toBeGreaterThanOrEqual(1);
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'EXPIRED', has_payload: false });
  });
});

describe('actions', () => {
  it('seul l’acteur système réserve', async () => {
    await expect(m.delivery.reserve({ kind: 'anonymous', ip: '203.0.113.1' } as never, 1, 120)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/mail-outbox.int.spec.ts` — Expected : FAIL (`mail-delivery.service` absent).

- [ ] **Step 4 : Implémenter**

`apps/api/src/modules/mail/outbox.repository.ts` :

```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { SECURITY_KINDS, type EmailKind } from './email-kinds.js';
import type { Decision, SendKind } from './outbox-policy.js';

export type SendResult = { kind: SendKind; smtpCode: number | null; response: string | null; errorCode: string | null };
export type NewEmail = {
  id: string; kind: EmailKind; recipientUserId: string | null; toAddress: string; dedupeKey: string;
  payload: Record<string, unknown>; payloadEncrypted: Buffer | null; messageId: string;
  /** Avec une vérification, l'expiration de l'email est celle de la vérification (outbox_challenge_guard). */
  challengeId: string | null; expiresInSeconds: number | null;
};
export type ReservedEmail = {
  id: string; kind: EmailKind; toAddress: string; messageId: string; payload: Record<string, unknown>;
  payloadEncrypted: Buffer | null; challengeId: string | null; normalAttempts: number; retryClaimed: boolean; claimToken: string;
};
type ReservedRow = {
  id: string; kind: EmailKind; to_address: string; message_id: string; payload: Record<string, unknown>;
  payload_encrypted: Uint8Array | null; challenge_id: string | null; normal_attempts: number; ambiguous_retry_claimed: boolean;
};

const SECURITY_LIST = [...SECURITY_KINDS] as string[];
const clip = (s: string | null): string | null => (s === null ? null : s.slice(0, 200));

@Injectable()
export class OutboxRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** `null` si la clé anti-doublon existe déjà. L'expiration vient de la vérification liée, sinon de `expiresInSeconds`. */
  async insertInTx(tx: TxClient, e: NewEmail): Promise<string | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      insert into app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, payload_encrypted, message_id, expires_at, challenge_id)
      select ${e.id}::uuid, ${e.recipientUserId}::uuid, ${e.toAddress}, ${e.kind}::app.email_kind, ${e.dedupeKey}, ${JSON.stringify(e.payload)}::jsonb,
             ${e.payloadEncrypted}, ${e.messageId},
             coalesce((select c.expires_at from app.auth_challenges c where c.id = ${e.challengeId}::uuid),
                      clock_timestamp() + make_interval(secs => ${e.expiresInSeconds}::double precision)),
             ${e.challengeId}::uuid
      on conflict (dedupe_key) do nothing
      returning id`;
    return rows[0]?.id ?? null;
  }

  /**
   * Réservation : UNE instruction (§ 2.4). Filtre l'expiration, le droit à une tentative (5 normales, une seule reprise
   * ambiguë) et bulk_email_paused (sauf types de sécurité), verrouille avec SKIP LOCKED et crée la tentative.
   */
  async reserve(batch: number, leaseSeconds: number): Promise<ReservedEmail[]> {
    const claim = randomUUID();
    const rows = await this.prisma.client.$queryRaw<ReservedRow[]>`
      with cand as (
        select o.id from app.email_outbox o
         where ((o.status in ('PENDING', 'RETRY_WAIT') and o.normal_attempts < 5)
             or (o.status = 'UNCERTAIN' and o.ambiguous_retry_scheduled and not o.ambiguous_retry_claimed))
           and o.next_attempt_at <= clock_timestamp()
           and o.expires_at > clock_timestamp()
           and (o.kind::text = any(${SECURITY_LIST}::text[]) or not (select s.bulk_email_paused from app.ops_settings s where s.id = 1))
         order by o.next_attempt_at, o.id
         limit ${batch}::int
         for update of o skip locked),
      upd as (
        update app.email_outbox o set
               status = 'SENDING', claim_token = ${claim}::uuid,
               locked_until = clock_timestamp() + make_interval(secs => ${leaseSeconds}::double precision),
               normal_attempts = o.normal_attempts + case when o.status = 'UNCERTAIN' then 0 else 1 end,
               ambiguous_retry_claimed = o.ambiguous_retry_claimed or o.status = 'UNCERTAIN'
          from cand where o.id = cand.id
        returning o.id, o.kind, o.to_address, o.message_id, o.payload, o.payload_encrypted, o.challenge_id, o.normal_attempts, o.ambiguous_retry_claimed),
      att as (
        insert into app.email_attempts (email_id, attempt_no, kind, claim_token)
        select u.id, u.normal_attempts + case when u.ambiguous_retry_claimed then 1 else 0 end,
               (case when u.ambiguous_retry_claimed then 'AMBIGUOUS_RETRY' else 'NORMAL' end)::app.email_attempt_kind, ${claim}::uuid
          from upd u
        returning email_id)
      select u.id, u.kind, u.to_address, u.message_id, u.payload, u.payload_encrypted, u.challenge_id, u.normal_attempts, u.ambiguous_retry_claimed
        from upd u join att a on a.email_id = u.id`;
    return rows.map((r) => ({
      id: r.id, kind: r.kind, toAddress: r.to_address, messageId: r.message_id, payload: r.payload,
      payloadEncrypted: r.payload_encrypted ? Buffer.from(r.payload_encrypted) : null, challengeId: r.challenge_id,
      normalAttempts: r.normal_attempts, retryClaimed: r.ambiguous_retry_claimed, claimToken: claim,
    }));
  }

  /** Finalisation conditionnelle : `false` si l'email n'est plus à nous (annulé, bail expiré). Un seul statement, ordre email puis tentative. */
  async finalize(e: { id: string; claimToken: string }, d: Decision, r: SendResult): Promise<boolean> {
    const rows = await this.prisma.client.$queryRaw<{ id: bigint }[]>`
      with o as (
        update app.email_outbox set
               status = ${d.status}::app.email_status, claim_token = null, locked_until = null,
               next_attempt_at = case when ${d.delaySeconds}::int is null then next_attempt_at else clock_timestamp() + make_interval(secs => ${d.delaySeconds}::double precision) end,
               ambiguous_retry_scheduled = ambiguous_retry_scheduled or ${d.status}::text = 'UNCERTAIN',
               accepted_at = case when ${d.status}::text = 'ACCEPTED' then clock_timestamp() else null end,
               payload_encrypted = case when ${d.status}::text in ('ACCEPTED', 'FAILED') then null else payload_encrypted end
         where id = ${e.id}::uuid and claim_token = ${e.claimToken}::uuid and status = 'SENDING'
        returning id)
      update app.email_attempts a set finished_at = clock_timestamp(), outcome = ${r.kind}::app.email_attempt_outcome,
             smtp_code = ${r.smtpCode}::int, smtp_response = ${clip(r.response)}, error_code = ${r.errorCode}
        from o where a.email_id = o.id and a.claim_token = ${e.claimToken}::uuid and a.outcome is null
      returning a.id`;
    return rows.length === 1;
  }

  /** Résultat arrivé après une annulation en cours d'envoi : seul le code est enregistré, l'email n'est jamais réactivé. */
  async recordLateOutcome(e: { id: string; claimToken: string }, r: SendResult): Promise<void> {
    await this.prisma.client.$executeRaw`
      update app.email_attempts set late_outcome = ${r.kind}::app.email_attempt_outcome, late_smtp_code = ${r.smtpCode}::int
       where email_id = ${e.id}::uuid and claim_token = ${e.claimToken}::uuid and outcome = 'CANCELLED_IN_FLIGHT' and late_outcome is null`;
  }

  /** La vérification liée est encore active et sa session (si elle en a une) est valide ; vrai pour un email sans vérification. */
  async challengeStillActive(emailId: string): Promise<boolean> {
    const r = await this.prisma.client.$queryRaw<{ ok: boolean }[]>`
      select (o.challenge_id is null or exists (
        select 1 from app.auth_challenges c left join app.sessions s on s.id = c.session_id
         where c.id = o.challenge_id and c.consumed_at is null and c.expires_at > clock_timestamp()
           and (c.session_id is null or (s.revoked_at is null and s.idle_expires_at > clock_timestamp() and s.absolute_expires_at > clock_timestamp())))) as ok
        from app.email_outbox o where o.id = ${emailId}::uuid`;
    return r[0]?.ok === true;
  }

  /** Annule un email que nous avons réservé et que nous n'enverrons pas ; la tentative est close sans transmission. */
  async cancelSending(e: { id: string; claimToken: string }): Promise<boolean> {
    const rows = await this.prisma.client.$queryRaw<{ id: bigint }[]>`
      with o as (
        update app.email_outbox set status = 'CANCELLED', claim_token = null, locked_until = null, payload_encrypted = null
         where id = ${e.id}::uuid and claim_token = ${e.claimToken}::uuid and status = 'SENDING'
        returning id)
      update app.email_attempts a set outcome = 'CANCELLED_IN_FLIGHT', finished_at = clock_timestamp()
        from o where a.email_id = o.id and a.claim_token = ${e.claimToken}::uuid and a.outcome is null
      returning a.id`;
    return rows.length === 1;
  }

  /** Bail expiré : tentative AMBIGUOUS/LEASE_EXPIRED, puis règle ambiguë (UNCERTAIN +15 min, ou FAILED si la reprise a déjà eu lieu). */
  async sweepExpiredLeases(limit: number): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      with exp as (
        select id, ambiguous_retry_claimed from app.email_outbox
         where status = 'SENDING' and locked_until < clock_timestamp()
         order by locked_until limit ${limit}::int for update skip locked),
      o as (
        update app.email_outbox o set
               status = (case when exp.ambiguous_retry_claimed then 'FAILED' else 'UNCERTAIN' end)::app.email_status,
               claim_token = null, locked_until = null,
               ambiguous_retry_scheduled = o.ambiguous_retry_scheduled or not exp.ambiguous_retry_claimed,
               next_attempt_at = case when exp.ambiguous_retry_claimed then o.next_attempt_at else clock_timestamp() + interval '15 minutes' end,
               payload_encrypted = case when exp.ambiguous_retry_claimed then null else o.payload_encrypted end
          from exp where o.id = exp.id
        returning o.id)
      update app.email_attempts a set outcome = 'AMBIGUOUS', error_code = 'LEASE_EXPIRED', finished_at = clock_timestamp()
        from o where a.email_id = o.id and a.outcome is null
      returning o.id`;
    return rows.length;
  }

  async expireOverdue(limit: number): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      with e as (
        select id from app.email_outbox
         where status in ('PENDING', 'RETRY_WAIT', 'UNCERTAIN') and expires_at <= clock_timestamp()
         order by expires_at limit ${limit}::int for update skip locked)
      update app.email_outbox o set status = 'EXPIRED', payload_encrypted = null from e where o.id = e.id returning o.id`;
    return rows.length;
  }
}
```

`apps/api/src/modules/mail/mail.service.ts` :

```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { TxClient } from '../../database/prisma.service.js';
import type { Actor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { KIND_SCHEMAS, isSupportedKind, type EmailKind } from './email-kinds.js';
import { OutboxRepository } from './outbox.repository.js';
import { PayloadCipher } from './payload-cipher.js';

export const OUTBOX_KEY = Symbol('OUTBOX_KEY');

export type EnqueueInput = {
  kind: EmailKind; recipientUserId: string; toAddress: string; dedupeKey: string;
  payload: Record<string, unknown>; secret?: Record<string, string>;
  expiresInSeconds?: number; challengeId?: string;
};

@Injectable()
export class MailService {
  private readonly cipher: PayloadCipher;
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(OutboxRepository) private readonly repo: OutboxRepository,
    @Inject(OUTBOX_KEY) key: Buffer,
  ) { this.cipher = new PayloadCipher(key); }

  /** Toujours dans la transaction métier (§ 1.2) ; NOTIFY part au commit (déclencheur). `null` : clé anti-doublon déjà vue. */
  async enqueueInTx(tx: TxClient, actor: Actor, input: EnqueueInput): Promise<string | null> {
    this.authz.assert(actor, 'mail.enqueue');
    if (!isSupportedKind(input.kind)) throw new Error(`email kind ${input.kind} has no template yet`);
    const schemas = KIND_SCHEMAS[input.kind];
    if (!schemas.payload.safeParse(input.payload).success) throw new Error(`invalid payload for ${input.kind}`);
    if (schemas.secret && !schemas.secret.safeParse(input.secret).success) throw new Error(`invalid secret for ${input.kind}`);
    if (!schemas.secret && input.secret) throw new Error(`${input.kind} carries no secret`);
    if (!input.challengeId && input.expiresInSeconds === undefined) throw new Error('an email needs an expiry');
    const id = uuidv7();
    return this.repo.insertInTx(tx, {
      id, kind: input.kind, recipientUserId: input.recipientUserId, toAddress: input.toAddress, dedupeKey: input.dedupeKey,
      payload: input.payload, payloadEncrypted: input.secret ? this.cipher.encrypt(id, input.secret) : null,
      messageId: randomUUID(), challengeId: input.challengeId ?? null, expiresInSeconds: input.expiresInSeconds ?? null,
    });
  }
}
```

(L'erreur levée pour un contenu invalide est une `Error` de programmation, jamais une réponse HTTP : les appelants construisent eux-mêmes le contenu.)

`apps/api/src/modules/mail/mail-delivery.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { nextState } from './outbox-policy.js';
import { OutboxRepository, type ReservedEmail, type SendResult } from './outbox.repository.js';

export type { ReservedEmail, SendResult };

/** Côté worker : toutes les opérations exigent l'acteur système (R1). */
@Injectable()
export class MailDeliveryService {
  constructor(@Inject(AuthzService) private readonly authz: AuthzService, @Inject(OutboxRepository) private readonly repo: OutboxRepository) {}

  reserve(actor: SystemActor, batch: number, leaseSeconds: number): Promise<ReservedEmail[]> {
    this.authz.assert(actor, 'mail.deliver');
    return this.repo.reserve(batch, leaseSeconds);
  }

  finalize(actor: SystemActor, row: ReservedEmail, result: SendResult): Promise<boolean> {
    this.authz.assert(actor, 'mail.deliver');
    return this.repo.finalize(row, nextState({ normalAttempts: row.normalAttempts, retryClaimed: row.retryClaimed }, result.kind), result);
  }

  recordLateOutcome(actor: SystemActor, row: ReservedEmail, result: SendResult): Promise<void> {
    this.authz.assert(actor, 'mail.deliver');
    return this.repo.recordLateOutcome(row, result);
  }

  challengeStillActive(actor: SystemActor, emailId: string): Promise<boolean> {
    this.authz.assert(actor, 'mail.deliver');
    return this.repo.challengeStillActive(emailId);
  }

  cancelSending(actor: SystemActor, row: ReservedEmail): Promise<boolean> {
    this.authz.assert(actor, 'mail.deliver');
    return this.repo.cancelSending(row);
  }

  sweepExpiredLeases(actor: SystemActor, limit: number): Promise<number> {
    this.authz.assert(actor, 'mail.sweep');
    return this.repo.sweepExpiredLeases(limit);
  }

  expireOverdue(actor: SystemActor, limit: number): Promise<number> {
    this.authz.assert(actor, 'mail.sweep');
    return this.repo.expireOverdue(limit);
  }
}
```

`apps/api/src/modules/mail/mail.module.ts` :

```ts
import { Module, type DynamicModule } from '@nestjs/common';
import { MailDeliveryService } from './mail-delivery.service.js';
import { MailService, OUTBOX_KEY } from './mail.service.js';
import { OutboxRepository } from './outbox.repository.js';

@Module({})
export class MailModule {
  static register(outboxKey: Buffer): DynamicModule {
    return {
      module: MailModule,
      providers: [{ provide: OUTBOX_KEY, useValue: outboxKey }, OutboxRepository, MailService, MailDeliveryService],
      exports: [MailService, MailDeliveryService],
    };
  }
}
```

(`AuthzModule` exporte déjà `AuthzService` ; `DatabaseModule` est global.)

- [ ] **Step 5 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/mail-outbox.int.spec.ts apps/api/test/integration/email-schema.int.spec.ts` ; `pnpm typecheck` ; `pnpm lint` ; `pnpm depcruise` — Expected : PASS. Pour prouver que le test « 12 appels parallèles » est discriminant, remplacer provisoirement `for update of o skip locked` par un simple `for update`, constater l'échec ou l'attente, puis remettre.

- [ ] **Step 6 : Commit**

```bash
git add apps/api
git commit -m "feat(mail): file d'emails, réservation atomique, finalisation, annulation en cours d'envoi, balayage des baux

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7 : Transport SMTP et classification des résultats

**Files :**
- Create : `apps/api/src/modules/mail/mail-transport.ts`, `apps/api/test/support/scripted-smtp.ts`
- Test : `apps/api/src/modules/mail/mail-transport.spec.ts` (unitaire : table), `apps/api/test/integration/mail-transport.int.spec.ts` (serveur SMTP scripté)

**Interfaces :**
- Consumes : `WorkerConfig['mail']` (tâche 2), `SendResult` (tâche 6).
- Produces : `type OutgoingMail = { messageId: string; to: string; subject: string; text: string }` ; `abstract class MailTransport { abstract send(mail: OutgoingMail): Promise<SendResult> }` ; `classifySmtpError(e: unknown): SendResult` ; `class SmtpMailTransport extends MailTransport { constructor(mail: WorkerConfig['mail']) }` ; `startScriptedSmtp(opts): Promise<{ port; received: string[]; close() }>` (test).

- [ ] **Step 1 : Écrire les tests (échouent)**

`apps/api/src/modules/mail/mail-transport.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { classifySmtpError } from './mail-transport.js';

/** « En cas de doute, ambigu » (§ 2.4) : seuls les échecs d'étape connue et antérieure aux données sont certains. */
describe('classifySmtpError', () => {
  it.each([
    [{ code: 'ECONNREFUSED', command: 'CONN' }, 'TEMP_FAIL'],
    [{ code: 'ENOTFOUND', command: 'CONN' }, 'TEMP_FAIL'],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, 'TEMP_FAIL'],
    [{ code: 'ESOCKET', command: 'EHLO' }, 'TEMP_FAIL'],
    [{ code: 'ECONNRESET', command: 'RCPT TO' }, 'TEMP_FAIL'],
    [{ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }, 'TEMP_FAIL'],
    [{ responseCode: 421, command: 'EHLO' }, 'TEMP_FAIL'],
    [{ responseCode: 450, command: 'RCPT TO' }, 'TEMP_FAIL'],
    [{ responseCode: 451, command: 'DATA' }, 'TEMP_FAIL'],
    [{ responseCode: 550, command: 'RCPT TO' }, 'PERM_FAIL'],
    [{ responseCode: 554, command: 'DATA' }, 'PERM_FAIL'],
    [{ code: 'ETIMEDOUT', command: 'DATA' }, 'AMBIGUOUS'],
    [{ code: 'ECONNRESET', command: 'DATA' }, 'AMBIGUOUS'],
    [{ code: 'ESOCKET' }, 'AMBIGUOUS'],
    [{ code: 'ECONNECTION', command: 'DATA' }, 'AMBIGUOUS'],
    [new Error('inconnu'), 'AMBIGUOUS'],
    ['une chaîne', 'AMBIGUOUS'],
    [null, 'AMBIGUOUS'],
  ])('%j → %s', (err, expected) => {
    expect(classifySmtpError(err).kind).toBe(expected);
  });
  it('conserve le code SMTP et tronque la réponse', () => {
    const r = classifySmtpError({ responseCode: 550, response: `550 ${'x'.repeat(400)}`, command: 'RCPT TO' });
    expect(r.smtpCode).toBe(550);
    expect(r.response!.length).toBeLessThanOrEqual(200);
  });
});
```

`apps/api/test/support/scripted-smtp.ts` :

```ts
import net from 'node:net';

export type ScriptedSmtpOptions = {
  rcpt?: 'ok' | 450 | 550;
  afterData?: 'accept' | 'drop' | 451 | 554;
  greetingDelayMs?: number;
};

/** Petit serveur SMTP (net) dont les réponses sont scriptées : aucun fournisseur réel dans les tests (R6). */
export async function startScriptedSmtp(opts: ScriptedSmtpOptions = {}) {
  const received: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let inData = false;
    let buf = '';
    const reply = (s: string) => socket.write(`${s}\r\n`);
    setTimeout(() => { if (!socket.destroyed) reply('220 scripted ESMTP'); }, opts.greetingDelayMs ?? 0);
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end === -1) return;
          received.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          inData = false;
          const a = opts.afterData ?? 'accept';
          if (a === 'drop') { socket.destroy(); return; }
          reply(a === 'accept' ? '250 2.0.0 OK queued as scripted' : `${a} scripted refusal`);
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') reply('250 scripted');
        else if (cmd === 'MAIL' || cmd === 'RSET') reply('250 OK');
        else if (cmd === 'RCPT') { const r = opts.rcpt ?? 'ok'; reply(r === 'ok' ? '250 OK' : `${r} scripted recipient refusal`); }
        else if (cmd === 'DATA') { inData = true; reply('354 go ahead'); }
        else if (cmd === 'QUIT') { reply('221 bye'); socket.end(); return; }
        else reply('502 not implemented');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, received, close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) };
}
```

`apps/api/test/integration/mail-transport.int.spec.ts` :

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SmtpMailTransport } from '../../src/modules/mail/mail-transport.js';
import { startScriptedSmtp, type ScriptedSmtpOptions } from '../support/scripted-smtp.js';

const mail = () => ({ messageId: randomUUID(), to: 'dest@example.com', subject: 'Sujet', text: 'Corps du message' });
const cfg = (port: number, timeoutMs = 3000) => ({ from: 'no-reply@app.test', smtp: { host: '127.0.0.1', port, security: 'none' as const, auth: null, timeoutMs } });

async function sendWith(opts: ScriptedSmtpOptions, timeoutMs?: number) {
  const s = await startScriptedSmtp(opts);
  try { return { result: await new SmtpMailTransport(cfg(s.port, timeoutMs)).send(mail()), received: s.received }; } finally { await s.close(); }
}

describe('SmtpMailTransport sur le fil (serveur scripté)', () => {
  it('250 : ACCEPTED, avec le Message-ID composé par le worker (R12)', async () => {
    const m = mail();
    const s = await startScriptedSmtp();
    const r = await new SmtpMailTransport(cfg(s.port)).send(m);
    await s.close();
    expect(r).toMatchObject({ kind: 'ACCEPTED', smtpCode: 250 });
    expect(s.received[0]).toContain(`Message-ID: <${m.messageId}@app.test>`);
    expect(s.received[0]).toContain('Corps du message');
  });
  it('450 au destinataire : TEMP_FAIL certain', async () => { expect((await sendWith({ rcpt: 450 })).result.kind).toBe('TEMP_FAIL'); });
  it('550 au destinataire : PERM_FAIL', async () => { expect((await sendWith({ rcpt: 550 })).result).toMatchObject({ kind: 'PERM_FAIL', smtpCode: 550 }); });
  it('451 après les données : refus explicite, TEMP_FAIL', async () => { expect((await sendWith({ afterData: 451 })).result.kind).toBe('TEMP_FAIL'); });
  it('554 après les données : PERM_FAIL', async () => { expect((await sendWith({ afterData: 554 })).result.kind).toBe('PERM_FAIL'); });
  it('connexion coupée après les données : AMBIGUOUS (le message a peut-être été accepté)', async () => {
    const { result, received } = await sendWith({ afterData: 'drop' });
    expect(received).toHaveLength(1);
    expect(result.kind).toBe('AMBIGUOUS');
  });
  it('port fermé : TEMP_FAIL certain (rien n’a été transmis)', async () => {
    const s = await startScriptedSmtp();
    const port = s.port;
    await s.close();
    expect((await new SmtpMailTransport(cfg(port)).send(mail())).kind).toBe('TEMP_FAIL');
  });
  it('salutation qui n’arrive jamais : TEMP_FAIL certain', async () => {
    expect((await sendWith({ greetingDelayMs: 5000 }, 1000)).result.kind).toBe('TEMP_FAIL');
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules/mail/mail-transport.spec.ts` — Expected : FAIL (module absent).

- [ ] **Step 2 : Implémenter**

`apps/api/src/modules/mail/mail-transport.ts` :

```ts
import nodemailer, { type Transporter } from 'nodemailer';
import type { WorkerConfig } from '../../config/load-config.js';
import type { SendResult } from './outbox.repository.js';

export type OutgoingMail = { messageId: string; to: string; subject: string; text: string };

export abstract class MailTransport {
  abstract send(mail: OutgoingMail): Promise<SendResult>;
}

/** Étapes d'avant la transmission des données (§ 2.4) : un échec réseau à ce stade est certain. */
const BEFORE_DATA = new Set(['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'AUTH PLAIN', 'AUTH LOGIN', 'MAIL FROM', 'RCPT TO']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET', 'EDNS']);

const clip = (s: unknown): string | null => (typeof s === 'string' ? s.slice(0, 200) : null);

/**
 * En cas de doute, AMBIGUOUS. Sont certains : une réponse SMTP explicite (4xx = non accepté, temporaire ; 5xx = refusé),
 * une erreur d'authentification, et une panne réseau survenue avant la commande DATA.
 * Si un test sur le fil diverge parce que nodemailer nomme autrement l'étape, corriger la table, jamais élargir « certain ».
 */
export function classifySmtpError(e: unknown): SendResult {
  const err = (typeof e === 'object' && e !== null ? e : {}) as { code?: unknown; command?: unknown; responseCode?: unknown; response?: unknown };
  const code = typeof err.code === 'string' ? err.code : null;
  const command = typeof err.command === 'string' ? err.command : null;
  const smtpCode = typeof err.responseCode === 'number' ? err.responseCode : null;
  const base = { smtpCode, response: clip(err.response), errorCode: code };
  if (code === 'EAUTH') return { ...base, kind: 'TEMP_FAIL' }; // erreur de configuration : on réessaie, l'opérateur peut corriger
  if (smtpCode !== null) {
    if (smtpCode >= 400 && smtpCode < 500) return { ...base, kind: 'TEMP_FAIL' };
    if (smtpCode >= 500 && smtpCode < 600) return { ...base, kind: 'PERM_FAIL' };
    return { ...base, kind: 'AMBIGUOUS' };
  }
  if (command !== null && BEFORE_DATA.has(command) && code !== null && NETWORK_CODES.has(code)) return { ...base, kind: 'TEMP_FAIL' };
  return { ...base, kind: 'AMBIGUOUS' };
}

export class SmtpMailTransport extends MailTransport {
  private readonly transporter: Transporter;
  private readonly domain: string;

  constructor(private readonly mail: WorkerConfig['mail']) {
    super();
    const s = mail.smtp;
    this.domain = mail.from.split('@')[1]!;
    this.transporter = nodemailer.createTransport({
      host: s.host, port: s.port,
      secure: s.security === 'tls', requireTLS: s.security === 'starttls', ignoreTLS: s.security === 'none',
      ...(s.auth ? { auth: { user: s.auth.user, pass: s.auth.password } } : {}),
      connectionTimeout: s.timeoutMs, greetingTimeout: s.timeoutMs, socketTimeout: s.timeoutMs,
    });
  }

  async send(m: OutgoingMail): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: { name: 'ClassePulse', address: this.mail.from },
        to: m.to, subject: m.subject, text: m.text,
        messageId: `<${m.messageId}@${this.domain}>`,
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      const response = String(info.response ?? '');
      // ACCEPTED = réponse 250 du serveur configuré (§ 2.4). Toute autre forme de succès apparent est un doute.
      if (/^250[ -]/.test(response) && info.accepted.length === 1) return { kind: 'ACCEPTED', smtpCode: 250, response: clip(response), errorCode: null };
      return { kind: 'AMBIGUOUS', smtpCode: null, response: clip(response), errorCode: 'UNEXPECTED_RESPONSE' };
    } catch (e) {
      return classifySmtpError(e);
    }
  }
}
```

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project unit apps/api/src/modules/mail` ; `pnpm vitest run --project integration apps/api/test/integration/mail-transport.int.spec.ts` ; `pnpm typecheck` ; `pnpm lint` — Expected : PASS. Si un cas sur le fil donne un autre résultat, afficher une fois `err.code` et `err.command` en local et ajuster `BEFORE_DATA` ou `NETWORK_CODES` ; jamais classer `DATA` comme certain.

- [ ] **Step 4 : Commit**

```bash
git add apps/api
git commit -m "feat(mail): transport SMTP et classification certaine ou ambiguë des résultats

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8 : Processus worker — baux, traitement `email.send`, `NOTIFY`, purge horaire des seaux

**Files :**
- Create : `apps/api/src/modules/mail/email-sender.ts`, `apps/api/src/modules/mail/mail-worker.module.ts`, `apps/api/src/modules/maintenance/{maintenance.repository,maintenance.service,maintenance.module}.ts`, `apps/api/src/modules/jobs/{job-lease.repository,job-lease.service,jobs-support.module,job-scheduler,notify-listener,worker-runtime,jobs.module}.ts`, `apps/api/src/worker/worker.module.ts`, `apps/api/src/worker.ts`
- Modify : `apps/api/src/modules/authz/matrix.ts` et son oracle (`jobs.lease` : `['system']` ; la classe `system` a alors cinq actions), `apps/api/test/support/app.ts` (`workerConfigFor`), `README.md`
- Test : `apps/api/test/integration/worker.int.spec.ts`

**Interfaces :**
- Consumes : `MailDeliveryService`, `MailTransport`, `renderEmail`, `PayloadCipher` ; `WorkerConfig`, `WORKER_CONFIG`, `DB_CONFIG`.
- Produces :
  - `EmailSender.drain(actor: SystemActor, signal: AbortSignal): Promise<number>` (emails traités) ; une réservation = **un** email (`RESERVE_BATCH = 1`) : un arrêt n'abandonne jamais un email réservé mais non envoyé
  - `MaintenanceService.purgeRateLimitBuckets(actor: SystemActor, olderThanSeconds?: number, batch?: number): Promise<number>`
  - `JobLeaseService.acquire(actor, holder, ttlSeconds?): Promise<number | null>` (jeton d'écriture), `renew(actor, holder, token, ttlSeconds?): Promise<boolean>`, `release(actor, holder, token): Promise<void>` (le nom du bail est `actor.job`)
  - `JobScheduler` : `register(def)`, `start()`, `kick(name)`, `stop(deadlineMs)` ; `JobDef = { name: SystemActor['job']; intervalMs: number; run(actor, signal): Promise<void> }`
  - `WorkerModule.forRoot(config: WorkerConfig, o?: { transport?: MailTransport; pollMs?: number }): DynamicModule`
  - `workerConfigFor(db)` (test)

- [ ] **Step 1 : Écrire les tests (échouent)**

Ajouter à `apps/api/test/support/app.ts` :

```ts
import type { WorkerConfig } from '../../src/config/load-config.js';

export function workerConfigFor(db: string): WorkerConfig {
  return {
    nodeEnv: 'test', db: dbConfigFor('cp_app', db), logLevel: 'silent', appOrigin: ORIGIN, outboxPayloadKey: TEST_OUTBOX_KEY,
    mail: { from: 'no-reply@app.test', smtp: { host: '127.0.0.1', port: 1, security: 'none', auth: null, timeoutMs: 1000 } },
  };
}
```

`apps/api/test/integration/worker.int.spec.ts` :

```ts
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConfigModule } from '../../src/config/config.module.js';
import { DatabaseModule } from '../../src/database/database.module.js';
import { AuthzModule } from '../../src/modules/authz/authz.module.js';
import { JobLeaseService } from '../../src/modules/jobs/job-lease.service.js';
import { JobsSupportModule } from '../../src/modules/jobs/jobs-support.module.js';
import { EmailSender } from '../../src/modules/mail/email-sender.js';
import { MailTransport, type OutgoingMail } from '../../src/modules/mail/mail-transport.js';
import { MailWorkerModule } from '../../src/modules/mail/mail-worker.module.js';
import type { SendResult } from '../../src/modules/mail/outbox.repository.js';
import { MaintenanceModule } from '../../src/modules/maintenance/maintenance.module.js';
import { MaintenanceService } from '../../src/modules/maintenance/maintenance.service.js';
import { WorkerModule } from '../../src/worker/worker.module.js';
import { testConfig, workerConfigFor } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { SYSTEM, attemptRows, emailRow, forceEmail, seedChallengeEmail, seedPlainEmail } from '../support/mail.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

const ACCEPT: SendResult = { kind: 'ACCEPTED', smtpCode: 250, response: '250 OK', errorCode: null };
class FakeTransport extends MailTransport {
  sent: OutgoingMail[] = [];
  queue: SendResult[] = [];
  gate: Promise<void> | null = null;
  async send(m: OutgoingMail): Promise<SendResult> {
    this.sent.push(m);
    if (this.gate) await this.gate;
    return this.queue.shift() ?? ACCEPT;
  }
}

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

async function senderModule(transport: FakeTransport) {
  const mod = await Test.createTestingModule({
    imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MailWorkerModule.register(workerConfigFor(db), transport)],
  }).compile();
  await mod.init();
  return { sender: mod.get(EmailSender), close: () => mod.close() };
}
const live = () => new AbortController().signal;
const makeDue = (id: string) => forceEmail(db, id, `next_attempt_at = clock_timestamp() - interval '1 second'`);
/** Envoie tout ce qui est dû avec un transport qui accepte, pour que chaque test parte d'une file contrôlée. */
async function cleanQueue() {
  const { sender, close } = await senderModule(new FakeTransport());
  await sender.drain(SYSTEM, live());
  await close();
}
const waitUntil = async (cond: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 200; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`délai dépassé : ${what}`);
};

describe('EmailSender', () => {
  it('envoie un email de code : texte déchiffré, ACCEPTED, contenu chiffré effacé', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const { sender, close } = await senderModule(t);
    const s = await seedChallengeEmail(db, '654321');
    await sender.drain(SYSTEM, live());
    await close();
    const mail = t.sent.find((m) => m.to === s.email)!;
    expect(mail.text).toContain('654321');
    expect(mail.subject).not.toContain('654321');
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'ACCEPTED', has_payload: false });
  });
  it('résultat ambigu puis reprise : même Message-ID, FAILED si la reprise n’est pas acceptée', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    t.queue = [{ kind: 'AMBIGUOUS', smtpCode: null, response: null, errorCode: 'ECONNRESET' }, { kind: 'TEMP_FAIL', smtpCode: 451, response: '451', errorCode: null }];
    const { sender, close } = await senderModule(t);
    const id = await seedPlainEmail(db);
    await sender.drain(SYSTEM, live());
    expect((await emailRow(db, id)).status).toBe('UNCERTAIN');
    await makeDue(id);
    await sender.drain(SYSTEM, live());
    await close();
    expect((await emailRow(db, id)).status).toBe('FAILED');
    expect((await attemptRows(db, id)).map((a) => a.outcome)).toEqual(['AMBIGUOUS', 'TEMP_FAIL']);
    expect(t.sent).toHaveLength(2);
    expect(t.sent[0]!.messageId).toBe(t.sent[1]!.messageId);
  });
  it('contrôle juste avant l’envoi : une vérification déjà expirée n’envoie rien', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const { sender, close } = await senderModule(t);
    const s = await seedChallengeEmail(db);
    const owner = await connectAs('cp_owner', db); // expires_at n'est pas modifiable par cp_app
    await owner.query(`update app.auth_challenges set expires_at = clock_timestamp() - interval '1 second' where id = $1`, [s.challengeId]);
    await owner.end();
    await sender.drain(SYSTEM, live());
    await close();
    expect(t.sent.some((m) => m.to === s.email)).toBe(false);
    expect((await emailRow(db, s.emailId)).status).toBe('CANCELLED');
  });
  it('annulé pendant l’envoi : jamais réactivé, le résultat tardif n’écrit que son code', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    let release!: () => void;
    t.gate = new Promise<void>((r) => { release = r; });
    const { sender, close } = await senderModule(t);
    const s = await seedChallengeEmail(db);
    const draining = sender.drain(SYSTEM, live());
    await waitUntil(() => t.sent.some((m) => m.to === s.email), 'envoi commencé');
    const c = await connectAs('cp_app', db);
    await c.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [s.challengeId]);
    await c.end();
    release();
    await draining;
    await close();
    expect(await emailRow(db, s.emailId)).toMatchObject({ status: 'CANCELLED', has_payload: false });
    expect((await attemptRows(db, s.emailId))[0]).toMatchObject({ outcome: 'CANCELLED_IN_FLIGHT', late_outcome: 'ACCEPTED', late_smtp_code: 250 });
  });
  it('arrêt : l’email en cours se termine, aucun autre n’est réservé', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    let release!: () => void;
    t.gate = new Promise<void>((r) => { release = r; });
    const { sender, close } = await senderModule(t);
    const ids = [await seedPlainEmail(db), await seedPlainEmail(db), await seedPlainEmail(db)];
    const abort = new AbortController();
    const draining = sender.drain(SYSTEM, abort.signal);
    await waitUntil(() => t.sent.length === 1, 'premier envoi commencé');
    abort.abort();
    release();
    expect(await draining).toBe(1);
    await close();
    const statuses = await Promise.all(ids.map(async (id) => (await emailRow(db, id)).status));
    expect(statuses.filter((s) => s === 'ACCEPTED')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'PENDING')).toHaveLength(2);
  });
  it('un type sans modèle échoue en PERM_FAIL RENDER_FAILED, sans appel SMTP', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const { sender, close } = await senderModule(t);
    const id = await seedPlainEmail(db, { kind: 'DIGEST' });
    await sender.drain(SYSTEM, live());
    await close();
    expect(t.sent).toHaveLength(0);
    expect((await emailRow(db, id)).status).toBe('FAILED');
    expect((await attemptRows(db, id))[0]).toMatchObject({ outcome: 'PERM_FAIL', error_code: 'RENDER_FAILED' });
  });
  it('un bail expiré est balayé au début du traitement (ambigu, jamais remis en file tel quel)', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const { sender, close } = await senderModule(t);
    const id = await seedPlainEmail(db);
    const o = await connectAs('cp_app', db);
    await o.query(`update app.email_outbox set status = 'SENDING', claim_token = gen_random_uuid(), locked_until = clock_timestamp() - interval '1 second', normal_attempts = 1 where id = $1`, [id]);
    await o.query(`insert into app.email_attempts (email_id, attempt_no, kind, claim_token) select id, 1, 'NORMAL', claim_token from app.email_outbox where id = $1`, [id]);
    await o.end();
    await sender.drain(SYSTEM, live());
    await close();
    expect(await emailRow(db, id)).toMatchObject({ status: 'UNCERTAIN', scheduled: true });
    expect((await attemptRows(db, id))[0]).toMatchObject({ outcome: 'AMBIGUOUS', error_code: 'LEASE_EXPIRED' });
    expect(t.sent).toHaveLength(0);
  });
});

describe('baux (job_leases)', () => {
  const actor = { kind: 'system', job: 'maintenance.purge' } as const;
  async function leases() {
    const mod = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, JobsSupportModule] }).compile();
    await mod.init();
    return { svc: mod.get(JobLeaseService), close: () => mod.close() };
  }
  it('huit acquisitions parallèles : une seule gagne, le jeton croît', async () => {
    const { svc, close } = await leases();
    const res = await Promise.all(Array.from({ length: 8 }, (_v, i) => svc.acquire(actor, `h${i}`, 60)));
    const winnerIndex = res.findIndex((r) => r !== null);
    expect(res.filter((r) => r !== null)).toHaveLength(1);
    const token = res[winnerIndex]!;
    const holder = `h${winnerIndex}`;
    expect(await svc.renew(actor, holder, token, 60)).toBe(true);
    expect(await svc.renew(actor, 'autre', token, 60)).toBe(false);
    await svc.release(actor, holder, token);
    const next = await svc.acquire(actor, 'suivant', 60);
    expect(next).toBeGreaterThan(token);
    await svc.release(actor, 'suivant', next!);
    await close();
  });
  it('un bail expiré se reprend ; une reprise qui attend un verrou tenu perd, une fois le bail renouvelé', async () => {
    const { svc, close } = await leases();
    const o = await connectAs('cp_app', db);
    await o.query(`update app.job_leases set lease_until = clock_timestamp() - interval '1 second' where name = 'maintenance.purge'`);
    await o.query('begin');
    const pid = (await o.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await o.query(`update app.job_leases set holder = 'b', lease_until = clock_timestamp() + interval '60 seconds', fencing_token = fencing_token + 1 where name = 'maintenance.purge'`);
    const racing = svc.acquire(actor, 'c', 60);
    await waitForLockWait(db, pid);
    await o.query('commit');
    expect(await racing).toBeNull(); // la condition est réévaluée : le bail est de nouveau valable
    await o.query(`update app.job_leases set lease_until = null where name = 'maintenance.purge'`);
    await o.end();
    await close();
  });
  it('seul l’acteur système prend un bail', async () => {
    const { svc, close } = await leases();
    await expect(svc.acquire({ kind: 'anonymous', ip: '203.0.113.1' } as never, 'x', 60)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await close();
  });
});

describe('purge horaire des seaux (R14 du lot 1a, R18)', () => {
  const purger = { kind: 'system', job: 'maintenance.purge' } as const;
  async function maintenance() {
    const mod = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MaintenanceModule] }).compile();
    await mod.init();
    return { svc: mod.get(MaintenanceService), close: () => mod.close() };
  }
  it('supprime par lots les seaux de plus de 2 h, garde les autres, ignore une ligne verrouillée sans attendre', async () => {
    const { svc, close } = await maintenance();
    const o = await connectAs('cp_app', db);
    for (let i = 0; i < 250; i++) await o.query(`insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp() - interval '3 hours')`, [`ip:10.1.0.${i}`]);
    await o.query(`insert into app.rate_limit_buckets (key, window_start) values ('ip:10.9.9.9', clock_timestamp() - interval '10 minutes')`);
    await o.query('begin');
    await o.query(`select key from app.rate_limit_buckets where key = 'ip:10.1.0.0' for update`);
    const t0 = Date.now();
    expect(await svc.purgeRateLimitBuckets(purger, 7200, 100)).toBe(249);
    expect(Date.now() - t0).toBeLessThan(3000);
    await o.query('rollback');
    expect(await svc.purgeRateLimitBuckets(purger, 7200, 100)).toBe(1);
    expect((await o.query(`select key from app.rate_limit_buckets where key = 'ip:10.9.9.9'`)).rows).toHaveLength(1);
    await o.end();
    await close();
  });
  it('refuse un acteur autre que le système', async () => {
    const { svc, close } = await maintenance();
    await expect(svc.purgeRateLimitBuckets({ kind: 'cli', command: 'create-class' } as never)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await close();
  });
});

describe('WorkerModule (de bout en bout)', () => {
  it('envoie au démarrage, se réveille par NOTIFY (sondage à 60 s) et s’arrête proprement', async () => {
    await cleanQueue();
    const t = new FakeTransport();
    const before = await seedPlainEmail(db); // présent avant le démarrage : « chaque traitement s’exécute au démarrage »
    const mod = await Test.createTestingModule({ imports: [WorkerModule.forRoot(workerConfigFor(db), { transport: t, pollMs: 60_000 })] }).compile();
    await mod.init();
    const accepted = (id: string) => async () => (await emailRow(db, id)).status === 'ACCEPTED';
    await waitUntil(accepted(before), 'email préexistant envoyé');
    const woken = await seedPlainEmail(db);
    await waitUntil(accepted(woken), 'email réveillé par NOTIFY'); // 5 s au plus : le sondage (60 s) n'a pas pu le faire
    const t0 = Date.now();
    await mod.close();
    expect(Date.now() - t0).toBeLessThan(30_000);
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/worker.int.spec.ts` — Expected : FAIL (modules absents).

- [ ] **Step 2 : Implémenter**

Matrice : ajouter `'jobs.lease'` (`['system']`) à `ACTIONS` et `MATRIX`, à `EXPECTED_1B` et à la liste « la classe system n'a aucune autre action » (`['jobs.lease', 'mail.deliver', 'mail.enqueue', 'mail.sweep', 'maintenance.purge']`).

`apps/api/src/modules/mail/email-sender.ts` :

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { isSupportedKind } from './email-kinds.js';
import { MailDeliveryService, type ReservedEmail, type SendResult } from './mail-delivery.service.js';
import { MailTransport } from './mail-transport.js';
import type { PayloadCipher } from './payload-cipher.js';
import { renderEmail, type RenderContext } from './templates.js';

export const SENDER_CONTEXT = Symbol('SENDER_CONTEXT');
export type SenderContext = { render: RenderContext; cipher: PayloadCipher };

/** Un seul email par réservation : à l'arrêt, aucun email réservé mais non envoyé ne reste en SENDING. */
export const RESERVE_BATCH = 1;
/** Bail d'envoi : plus long que le délai total SMTP (R19). */
export const SEND_LEASE_SECONDS = 120;
const SWEEP_LIMIT = 50;
const RENDER_FAILED: SendResult = { kind: 'PERM_FAIL', smtpCode: null, response: null, errorCode: 'RENDER_FAILED' };

@Injectable()
export class EmailSender {
  private readonly logger = new Logger('EmailSender');

  constructor(
    @Inject(MailDeliveryService) private readonly delivery: MailDeliveryService,
    @Inject(MailTransport) private readonly transport: MailTransport,
    @Inject(SENDER_CONTEXT) private readonly ctx: SenderContext,
  ) {}

  /** Balaye les baux expirés, expire les emails en retard, puis envoie ce qui est dû jusqu'à épuisement ou arrêt. */
  async drain(actor: SystemActor, signal: AbortSignal): Promise<number> {
    await this.delivery.sweepExpiredLeases(actor, SWEEP_LIMIT);
    await this.delivery.expireOverdue(actor, SWEEP_LIMIT);
    let processed = 0;
    while (!signal.aborted) {
      const batch = await this.delivery.reserve(actor, RESERVE_BATCH, SEND_LEASE_SECONDS);
      if (batch.length === 0) break;
      for (const row of batch) { await this.deliver(actor, row); processed++; }
    }
    return processed;
  }

  /** `null` : le rendu a échoué (déchiffrement, schéma, type sans modèle) — échec certain, antérieur à toute transmission. */
  private render(row: ReservedEmail): { subject: string; text: string } | null {
    try {
      if (!isSupportedKind(row.kind)) return null;
      const secret = row.payloadEncrypted ? this.ctx.cipher.decrypt(row.id, row.payloadEncrypted) : null;
      return renderEmail(row.kind, row.payload, secret, this.ctx.render);
    } catch {
      return null;
    }
  }

  private async deliver(actor: SystemActor, row: ReservedEmail): Promise<void> {
    // Juste avant l'envoi : la vérification est-elle encore active, la session valide ? (§ 3.3)
    if (row.challengeId && !(await this.delivery.challengeStillActive(actor, row.id))) {
      await this.delivery.cancelSending(actor, row);
      this.logger.log(`email ${row.id} (${row.kind}) cancelled before sending`);
      return;
    }
    const rendered = this.render(row);
    const result = rendered ? await this.transport.send({ messageId: row.messageId, to: row.toAddress, subject: rendered.subject, text: rendered.text }) : RENDER_FAILED;
    // Journal : identifiant, type, catégorie ; jamais l'adresse, le contenu ni la réponse SMTP.
    this.logger.log(`email ${row.id} (${row.kind}) attempt ${row.normalAttempts}${row.retryClaimed ? '+retry' : ''}: ${result.kind}`);
    if (!(await this.delivery.finalize(actor, row, result))) {
      // Annulé en cours d'envoi : seul le code est enregistré. Bail expiré : le résultat est abandonné (R14).
      await this.delivery.recordLateOutcome(actor, row, result);
      this.logger.warn(`LATE_RESULT_DROPPED ${row.id} ${result.kind}`);
    }
  }
}
```

`apps/api/src/modules/mail/mail-worker.module.ts` :

```ts
import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerConfig } from '../../config/load-config.js';
import { EmailSender, SENDER_CONTEXT } from './email-sender.js';
import { MailTransport, SmtpMailTransport } from './mail-transport.js';
import { MailModule } from './mail.module.js';
import { PayloadCipher } from './payload-cipher.js';

@Module({})
export class MailWorkerModule {
  static register(config: WorkerConfig, transport?: MailTransport): DynamicModule {
    return {
      module: MailWorkerModule,
      imports: [MailModule.register(config.outboxPayloadKey)],
      providers: [
        { provide: MailTransport, useValue: transport ?? new SmtpMailTransport(config.mail) },
        { provide: SENDER_CONTEXT, useValue: { render: { appOrigin: config.appOrigin }, cipher: new PayloadCipher(config.outboxPayloadKey) } },
        EmailSender,
      ],
      exports: [EmailSender],
    };
  }
}
```

`apps/api/src/modules/maintenance/maintenance.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class MaintenanceRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Une ligne verrouillée par une transaction ouverte est ignorée (SKIP LOCKED) : jamais d'attente. */
  async purgeRateLimitBucketsBatch(olderThanSeconds: number, batch: number): Promise<number> {
    const r = await this.prisma.client.$queryRaw<{ key: string }[]>`
      with d as (
        select key from app.rate_limit_buckets
         where window_start < clock_timestamp() - make_interval(secs => ${olderThanSeconds}::double precision)
         limit ${batch}::int for update skip locked)
      delete from app.rate_limit_buckets b using d where b.key = d.key returning b.key`;
    return r.length;
  }
}
```

`apps/api/src/modules/maintenance/maintenance.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { MaintenanceRepository } from './maintenance.repository.js';

/** R18 : la plus longue fenêtre de seau est 1 h ; on garde 2 h. */
export const BUCKET_RETENTION_SECONDS = 7200;
export const PURGE_BATCH = 5000;

@Injectable()
export class MaintenanceService {
  constructor(@Inject(AuthzService) private readonly authz: AuthzService, @Inject(MaintenanceRepository) private readonly repo: MaintenanceRepository) {}

  async purgeRateLimitBuckets(actor: SystemActor, olderThanSeconds = BUCKET_RETENTION_SECONDS, batch = PURGE_BATCH): Promise<number> {
    this.authz.assert(actor, 'maintenance.purge');
    let total = 0;
    for (;;) {
      const n = await this.repo.purgeRateLimitBucketsBatch(olderThanSeconds, batch);
      total += n;
      if (n < batch) return total;
    }
  }
}
```

`maintenance.module.ts` : `@Module({ providers: [MaintenanceRepository, MaintenanceService], exports: [MaintenanceService] })`.

`apps/api/src/modules/jobs/job-lease.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

@Injectable()
export class JobLeaseRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Acquisition atomique (§ 1.4) : une ligne est renvoyée au gagnant, aucune aux autres. */
  async acquire(name: string, holder: string, ttlSeconds: number): Promise<number | null> {
    const r = await this.prisma.client.$queryRaw<{ token: string }[]>`
      update app.job_leases set holder = ${holder}, lease_until = clock_timestamp() + make_interval(secs => ${ttlSeconds}::double precision), fencing_token = fencing_token + 1
       where name = ${name} and (lease_until is null or lease_until < clock_timestamp())
      returning fencing_token::text as token`;
    return r[0] ? Number(r[0].token) : null;
  }

  async renew(name: string, holder: string, token: number, ttlSeconds: number): Promise<boolean> {
    const r = await this.prisma.client.$queryRaw<{ n: number }[]>`
      update app.job_leases set lease_until = clock_timestamp() + make_interval(secs => ${ttlSeconds}::double precision)
       where name = ${name} and holder = ${holder} and fencing_token = ${token}::bigint and lease_until >= clock_timestamp()
      returning 1 as n`;
    return r.length === 1;
  }

  async release(name: string, holder: string, token: number): Promise<void> {
    await this.prisma.client.$executeRaw`
      update app.job_leases set lease_until = null where name = ${name} and holder = ${holder} and fencing_token = ${token}::bigint`;
  }
}
```

`apps/api/src/modules/jobs/job-lease.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { JobLeaseRepository } from './job-lease.repository.js';

/** Durée 2 min, renouvelée toutes les 30 s (§ 1.4). */
export const LEASE_SECONDS = 120;
export const RENEW_EVERY_MS = 30_000;

/** Le nom du bail est le nom du traitement de l'acteur. */
@Injectable()
export class JobLeaseService {
  constructor(@Inject(AuthzService) private readonly authz: AuthzService, @Inject(JobLeaseRepository) private readonly repo: JobLeaseRepository) {}

  acquire(actor: SystemActor, holder: string, ttlSeconds = LEASE_SECONDS): Promise<number | null> {
    this.authz.assert(actor, 'jobs.lease');
    return this.repo.acquire(actor.job, holder, ttlSeconds);
  }

  renew(actor: SystemActor, holder: string, token: number, ttlSeconds = LEASE_SECONDS): Promise<boolean> {
    this.authz.assert(actor, 'jobs.lease');
    return this.repo.renew(actor.job, holder, token, ttlSeconds);
  }

  release(actor: SystemActor, holder: string, token: number): Promise<void> {
    this.authz.assert(actor, 'jobs.lease');
    return this.repo.release(actor.job, holder, token);
  }
}
```

`jobs-support.module.ts` : `@Module({ providers: [JobLeaseRepository, JobLeaseService], exports: [JobLeaseService] })`.

`apps/api/src/modules/jobs/job-scheduler.ts` :

```ts
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SystemActor } from '../authz/actor.js';
import { JobLeaseService, RENEW_EVERY_MS } from './job-lease.service.js';

export type JobDef = { name: SystemActor['job']; intervalMs: number; run: (actor: SystemActor, signal: AbortSignal) => Promise<void> };
type Slot = { def: JobDef; running: Promise<void> | null; again: boolean; timer: NodeJS.Timeout | null };

/** Un bail par traitement (§ 1.4) ; bail pris ailleurs : on passe son tour ; un passage manqué est rattrapé au suivant. */
@Injectable()
export class JobScheduler {
  private readonly logger = new Logger('JobScheduler');
  private readonly slots = new Map<string, Slot>();
  private readonly abort = new AbortController();
  private readonly holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private stopping = false;

  constructor(@Inject(JobLeaseService) private readonly leases: JobLeaseService) {}

  register(def: JobDef): void { this.slots.set(def.name, { def, running: null, again: false, timer: null }); }

  /** Chaque traitement s'exécute immédiatement au démarrage, puis à son intervalle. */
  start(): void {
    for (const [name, slot] of this.slots) {
      this.kick(name);
      slot.timer = setInterval(() => this.kick(name), slot.def.intervalMs);
    }
  }

  /** Demande un passage ; si un passage est en cours, un seul passage de rattrapage est mémorisé. */
  kick(name: string): void {
    const slot = this.slots.get(name);
    if (!slot || this.stopping) return;
    if (slot.running) { slot.again = true; return; }
    slot.running = this.cycle(slot).finally(() => {
      slot.running = null;
      if (slot.again && !this.stopping) { slot.again = false; this.kick(name); }
    });
  }

  private async cycle(slot: Slot): Promise<void> {
    const actor: SystemActor = { kind: 'system', job: slot.def.name };
    let token: number | null;
    try { token = await this.leases.acquire(actor, this.holder); } catch { this.logger.error(`lease acquisition failed for ${actor.job}`); return; }
    if (token === null) return; // le bail est pris ailleurs
    const held = token;
    const renew = setInterval(() => { void this.leases.renew(actor, this.holder, held).catch(() => undefined); }, RENEW_EVERY_MS);
    try {
      await slot.def.run(actor, this.abort.signal);
    } catch (e) {
      this.logger.error(`job ${actor.job} failed (${e instanceof Error ? e.constructor.name : 'unknown'})`);
    } finally {
      clearInterval(renew);
      await this.leases.release(actor, this.holder, held).catch(() => undefined);
    }
  }

  /** À SIGTERM : on cesse de réserver, l'envoi en cours se termine, dans la limite de `deadlineMs` (30 s). */
  async stop(deadlineMs: number): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    for (const slot of this.slots.values()) if (slot.timer) clearInterval(slot.timer);
    const running = [...this.slots.values()].map((s) => s.running).filter((r): r is Promise<void> => r !== null);
    await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, deadlineMs))]);
  }
}
```

`apps/api/src/modules/jobs/notify-listener.ts` :

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import pg from 'pg';
import { DB_CONFIG } from '../../config/config.module.js';
import { toPgPoolConfig } from '../../config/database-connection.js';
import type { DbConfig } from '../../config/load-config.js';

/** LISTEN email_outbox sur une connexion dédiée ; reconnexion automatique, avec rattrapage à chaque reconnexion. */
@Injectable()
export class NotifyListener {
  private readonly logger = new Logger('NotifyListener');
  private client: pg.Client | null = null;
  private stopped = false;
  private retry: NodeJS.Timeout | null = null;

  constructor(@Inject(DB_CONFIG) private readonly db: DbConfig) {}

  async start(onNotify: () => void): Promise<void> {
    this.stopped = false;
    await this.connect(onNotify);
  }

  private schedule(onNotify: () => void): void {
    if (this.stopped) return;
    this.retry = setTimeout(() => { void this.connect(onNotify); }, 2000);
  }

  private async connect(onNotify: () => void): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client(toPgPoolConfig(this.db));
    const lost = () => {
      if (this.stopped || this.client !== client) return;
      this.client = null;
      this.schedule(onNotify);
    };
    client.on('notification', () => onNotify());
    client.on('error', lost);
    client.on('end', lost);
    try {
      await client.connect();
      this.client = client;
      await client.query('listen email_outbox');
      onNotify(); // rattrapage : un NOTIFY a pu passer pendant la coupure
    } catch {
      this.logger.warn('LISTEN connection failed, retrying');
      this.client = null;
      client.removeAllListeners();
      client.on('error', () => undefined);
      await client.end().catch(() => undefined);
      this.schedule(onNotify);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const c = this.client;
    this.client = null;
    if (c) { c.removeAllListeners(); c.on('error', () => undefined); await c.end().catch(() => undefined); }
  }
}
```

`apps/api/src/modules/jobs/worker-runtime.ts` :

```ts
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { EmailSender } from '../mail/email-sender.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { JobScheduler } from './job-scheduler.js';
import { NotifyListener } from './notify-listener.js';

export const WORKER_OPTIONS = Symbol('WORKER_OPTIONS');
export type WorkerOptions = { pollMs: number };
/** Budget d'arrêt à SIGTERM (§ 1.4). */
export const SHUTDOWN_DEADLINE_MS = 30_000;
const PURGE_EVERY_MS = 3_600_000;

@Injectable()
export class WorkerRuntime implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(JobScheduler) private readonly scheduler: JobScheduler,
    @Inject(NotifyListener) private readonly listener: NotifyListener,
    @Inject(EmailSender) private readonly sender: EmailSender,
    @Inject(MaintenanceService) private readonly maintenance: MaintenanceService,
    @Inject(WORKER_OPTIONS) private readonly options: WorkerOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.scheduler.register({ name: 'email.send', intervalMs: this.options.pollMs, run: async (actor, signal) => { await this.sender.drain(actor, signal); } });
    this.scheduler.register({ name: 'maintenance.purge', intervalMs: PURGE_EVERY_MS, run: async (actor) => { await this.maintenance.purgeRateLimitBuckets(actor); } });
    this.scheduler.start();
    await this.listener.start(() => this.scheduler.kick('email.send'));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.listener.stop();
    await this.scheduler.stop(SHUTDOWN_DEADLINE_MS);
  }
}
```

`apps/api/src/modules/jobs/jobs.module.ts` :

```ts
import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerConfig } from '../../config/load-config.js';
import type { MailTransport } from '../mail/mail-transport.js';
import { MailWorkerModule } from '../mail/mail-worker.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { JobScheduler } from './job-scheduler.js';
import { JobsSupportModule } from './jobs-support.module.js';
import { NotifyListener } from './notify-listener.js';
import { WORKER_OPTIONS, WorkerRuntime } from './worker-runtime.js';

@Module({})
export class JobsModule {
  static register(config: WorkerConfig, o: { transport?: MailTransport; pollMs: number }): DynamicModule {
    return {
      module: JobsModule,
      imports: [JobsSupportModule, MaintenanceModule, MailWorkerModule.register(config, o.transport)],
      providers: [{ provide: WORKER_OPTIONS, useValue: { pollMs: o.pollMs } }, JobScheduler, NotifyListener, WorkerRuntime],
    };
  }
}
```

`apps/api/src/worker/worker.module.ts` :

```ts
import { Module, type DynamicModule } from '@nestjs/common';
import { WorkerConfigModule } from '../config/config.module.js';
import type { WorkerConfig } from '../config/load-config.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthzModule } from '../modules/authz/authz.module.js';
import { JobsModule } from '../modules/jobs/jobs.module.js';
import type { MailTransport } from '../modules/mail/mail-transport.js';

@Module({})
export class WorkerModule {
  static forRoot(config: WorkerConfig, o: { transport?: MailTransport; pollMs?: number } = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        WorkerConfigModule.forRoot(config), DatabaseModule, AuthzModule,
        JobsModule.register(config, { ...(o.transport ? { transport: o.transport } : {}), pollMs: o.pollMs ?? 15_000 }),
      ],
    };
  }
}
```

`apps/api/src/worker.ts` :

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadWorkerConfig, type WorkerConfig } from './config/load-config.js';
import { WorkerModule } from './worker/worker.module.js';

async function main(): Promise<void> {
  let config: WorkerConfig;
  try {
    config = loadWorkerConfig(process.env);
  } catch (e) {
    // Les messages du chargeur ne contiennent que des noms de variables, jamais de valeurs.
    process.stderr.write(`erreur : INVALID_CONFIGURATION\n${e instanceof Error ? e.message : ''}\n`);
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(config), { logger: config.logLevel === 'silent' ? false : ['log', 'warn', 'error'] });
  app.enableShutdownHooks(); // SIGTERM et SIGINT : arrêt en 30 s au plus (WorkerRuntime)
}

main().catch(() => { process.stderr.write('erreur : WORKER_START_FAILED\n'); process.exit(1); });
```

README : section « Worker » (démarrage, `SIGTERM`, variables, Mailpit sur http://127.0.0.1:8025).

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/worker.int.spec.ts apps/api/test/integration/mail-outbox.int.spec.ts` ; `pnpm vitest run --project unit apps/api/src/modules/authz` ; `pnpm typecheck` ; `pnpm lint` ; `pnpm depcruise` — Expected : PASS. Contrôle manuel (une fois) : démarrer Mailpit, lancer `pnpm --filter @classepulse/api worker`, insérer un email `TEST` sous `cp_app` avec `psql`, constater sa réception dans Mailpit, puis `Ctrl+C` et vérifier l'arrêt immédiat.

- [ ] **Step 4 : Commit**

```bash
git add apps/api README.md
git commit -m "feat(worker): processus worker, baux, traitement email.send, réveil NOTIFY, purge horaire des seaux

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9 : Second facteur — noyau (codes, vérifications, échecs, blocage, alertes)

**Files :**
- Create : `apps/api/src/modules/auth/second-factor/otp.ts`, `apps/api/src/modules/auth/second-factor/challenges.repository.ts`, `apps/api/src/modules/auth/second-factor/second-factor.service.ts`, `apps/api/src/modules/auth/second-factor/otp-limiter.ts`, `apps/api/test/support/second-factor.ts`
- Modify : `apps/api/src/http/session-cookie-name.ts` (+ `CHALLENGE_COOKIE`), `apps/api/src/modules/audit/audit-actions.ts`, `apps/api/src/modules/auth/auth.module.ts` (fournisseurs et `MailModule.register(config.security.outboxPayloadKey)`)
- Test : `apps/api/src/modules/auth/second-factor/otp.spec.ts`, `apps/api/src/modules/audit/audit-actions-1b.spec.ts`, `apps/api/test/integration/second-factor-service.int.spec.ts`

**Interfaces :**
- Consumes : `MailService.enqueueInTx` (tâche 6) ; `RateLimitRepository.hit` (lot 1a) ; `AuditService.recordInTx` ; `APP_CONFIG` (`security.otpPepper`) ; tables de la tâche 3.
- Produces :
  - `otp.ts` : `OTP_TTL_SECONDS = 600`, `newOtpCode(): string`, `otpHmac(pepper: string, challengeId: string, code: string): Buffer`, `otpMatches(expected: Buffer, pepper: string, challengeId: string, code: string): boolean`, `newChallengeToken(): { token: string; hash: Buffer }`, `hashChallengeToken(token: string): Buffer | null`, `challengeSetCookie(token: string): string`, `challengeClearCookie(): string`
  - `type ChallengePurpose = 'LOGIN' | 'RECOVERY' | 'STEP_UP' | 'EMAIL_CHANGE_OLD' | 'EMAIL_CHANGE_NEW'`
  - `type IssueInput = { userId: string; purpose: Exclude<ChallengePurpose, 'RECOVERY'>; sessionId: string | null; pendingEmail: string | null; tokenHash: Buffer | null; ip: string | null }` ; `type Issued = { challengeId: string; expiresInSeconds: 600; resendAfterSeconds: 60 }`
  - `type ChallengeRef = { id: string; purpose: ChallengePurpose; sessionId: string | null; pendingEmail: string | null }`
  - `type CheckInput = { userId: string; purpose: ChallengePurpose; code: string; challengeId?: string }` ; `type CheckOutcome = { ok: true; challenge: ChallengeRef; companion: ChallengeRef | null } | { ok: false; reason: 'WRONG'; attemptsLeft: number } | { ok: false; reason: 'LOCKED' | 'EXPIRED' | 'BLOCKED' }`
  - `SecondFactorService` : `issueInTx(tx, actor, input): Promise<Issued>` (verrouille `users FOR NO KEY UPDATE`, compte les demandes, consomme l'ancienne, crée la vérification et met l'email en file) ; `checkInTx(tx, actor, input): Promise<CheckOutcome>` (verrouille, compare ; **un échec n'est jamais une exception** : l'appelant valide la transaction puis lève l'erreur) ; `consumeInTx(tx, actor, challenge: ChallengeRef, reason): Promise<void>` ; `findLoginChallenge(actor: AnonymousActor, tokenHash: Buffer): Promise<{ challengeId: string; userId: string } | null>`
  - `outcomeToError(o: Exclude<CheckOutcome, { ok: true }>, opts: { clearChallengeCookie: boolean }): ApiError`
  - `OtpLimiter` : `hitRequest(ip: string): Promise<void>` (10 par heure et par préfixe d'IP), `hitTry(ip: string): Promise<void>` (30 par heure) ; dépassement → `429 TOO_MANY_ATTEMPTS`
  - test : `createAdmin(db, over?)`, `latestCode(db, email, kind?)`, `seedHistory(db, userId, count, ageMinutes)`

- [ ] **Step 1 : Aides de test et tests unitaires**

Ajouter `export const CHALLENGE_COOKIE = '__Host-cp_challenge';` à `apps/api/src/http/session-cookie-name.ts`.

`apps/api/src/modules/auth/second-factor/otp.spec.ts` :

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { challengeClearCookie, challengeSetCookie, hashChallengeToken, newChallengeToken, newOtpCode, otpHmac, otpMatches } from './otp.js';

const ID = '0199c0de-0000-7000-8000-000000000001';
describe('codes (§ 3.3)', () => {
  it('6 chiffres, zéros initiaux conservés', () => {
    for (let i = 0; i < 2000; i++) expect(newOtpCode()).toMatch(/^[0-9]{6}$/);
  });
  it('le HMAC suit la spec : HMAC-SHA256(pepper, identifiant ‖ code), calculé ici indépendamment', () => {
    const expected = createHmac('sha256', 'pepper-de-test').update(Buffer.from(`${ID}123456`, 'utf8')).digest();
    expect(otpHmac('pepper-de-test', ID, '123456').equals(expected)).toBe(true);
  });
  it('otpMatches : bon code, mauvais code, autre identifiant, autre pepper, longueur différente', () => {
    const h = otpHmac('p'.repeat(40), ID, '123456');
    expect(otpMatches(h, 'p'.repeat(40), ID, '123456')).toBe(true);
    expect(otpMatches(h, 'p'.repeat(40), ID, '123457')).toBe(false);
    expect(otpMatches(h, 'p'.repeat(40), '0199c0de-0000-7000-8000-000000000002', '123456')).toBe(false);
    expect(otpMatches(h, 'q'.repeat(40), ID, '123456')).toBe(false);
    expect(otpMatches(h.subarray(0, 16), 'p'.repeat(40), ID, '123456')).toBe(false);
  });
  it('le jeton de vérification : 32 octets, seul le SHA-256 est stocké, un jeton mal formé est refusé sans calcul', () => {
    const { token, hash } = newChallengeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashChallengeToken(token)!.equals(hash)).toBe(true);
    expect(hashChallengeToken('court')).toBeNull();
    expect(hashChallengeToken('!'.repeat(43))).toBeNull();
  });
  it('cookie : attributs exacts (§ 3.3), effacement avec les mêmes attributs', () => {
    const t = 'A'.repeat(43);
    expect(challengeSetCookie(t)).toBe(`__Host-cp_challenge=${t}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600`);
    expect(challengeClearCookie()).toBe('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
  });
});
```

`apps/api/src/modules/audit/audit-actions-1b.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { AUDIT_METADATA } from './audit-actions.js';

describe('actions d’audit du lot 1b (R17)', () => {
  it.each([
    ['ADMIN_LOGIN', { method: 'EMAIL_CODE' }], ['ADMIN_LOGIN', { method: 'RECOVERY_CODE' }],
    ['ADMIN_EMAIL_CHANGED', { revokedSessions: 2 }], ['PASSWORD_RESET_COMPLETED', { revokedSessions: 0 }],
    ['ADMIN_SECOND_FACTOR_BLOCKED', { failures: 10 }],
  ] as const)('%s accepte %j', (action, meta) => {
    expect(AUDIT_METADATA[action].safeParse(meta).success).toBe(true);
  });
  it.each([
    ['ADMIN_LOGIN', { method: 'EMAIL_CODE', ip: '1.2.3.4' }], ['ADMIN_LOGIN', { method: 'TOTP' }],
    ['ADMIN_EMAIL_CHANGED', { revokedSessions: 1, email: 'a@example.com' }], ['PASSWORD_RESET_COMPLETED', {}],
    ['ADMIN_SECOND_FACTOR_BLOCKED', { failures: -1 }],
  ] as const)('%s refuse %j (jamais d’email, d’IP ni de secret)', (action, meta) => {
    expect(AUDIT_METADATA[action].safeParse(meta).success).toBe(false);
  });
});
```

`apps/api/test/support/second-factor.ts` :

```ts
import { v7 as uuidv7 } from 'uuid';
import { normalizePassword } from '@classepulse/shared';
import { PasswordHasher } from '../../src/modules/users/password-hasher.js';
import { cipher } from './mail.js';
import { PASSWORD } from './app.js';
import { connectAs } from './pg.js';

/** Administrateur actif (insertion sous cp_app, comme la CLI) ; mot de passe = PASSWORD. */
export async function createAdmin(db: string, over: { email?: string; status?: 'ACTIVE' | 'SUSPENDED' } = {}) {
  const id = uuidv7();
  const email = over.email ?? `admin.${id}@example.com`;
  const hash = await new PasswordHasher().hash(normalizePassword(PASSWORD));
  const c = await connectAs('cp_app', db);
  try {
    await c.query(`insert into app.users (id, email, first_name, last_name, password_hash, global_role) values ($1,$2,'Awa','Diop',$3,'ADMIN')`, [id, email, hash]);
  } finally { await c.end(); }
  if (over.status === 'SUSPENDED') {
    const o = await connectAs('cp_owner', db); // cp_app ne modifie pas le statut
    await o.query(`update app.users set status = 'SUSPENDED' where id = $1`, [id]);
    await o.end();
  }
  return { id, email, password: PASSWORD };
}

/** Le dernier code en clair mis en file pour une adresse (déchiffré avec la clé de test) : remplace la boîte email. */
export async function latestCode(db: string, to: string, kind = 'ADMIN_OTP'): Promise<string> {
  const c = await connectAs('cp_app', db);
  try {
    const r = await c.query(`select id, payload_encrypted from app.email_outbox where to_address = $1 and kind = $2::app.email_kind and payload_encrypted is not null order by created_at desc, id desc limit 1`, [to, kind]);
    if (!r.rows[0]) throw new Error(`aucun email ${kind} en attente pour ${to}`);
    return cipher.decrypt(r.rows[0].id, r.rows[0].payload_encrypted).code!;
  } finally { await c.end(); }
}

/** Historique de demandes de code : `count` vérifications consommées, créées il y a `ageMinutes` minutes (cp_owner : created_at n'est pas modifiable par cp_app). */
export async function seedHistory(db: string, userId: string, count: number, ageMinutes: number): Promise<void> {
  const o = await connectAs('cp_owner', db);
  try {
    for (let i = 0; i < count; i++) {
      await o.query(
        `insert into app.auth_challenges (id, user_id, purpose, token_hash, code_hmac, expires_at, created_at, consumed_at, consumed_reason)
         values ($1,$2,'LOGIN', decode(md5($1::text) || md5($2::text), 'hex'), decode(md5($1::text) || md5($2::text), 'hex'),
                 clock_timestamp() - make_interval(mins => $3) + interval '10 minutes', clock_timestamp() - make_interval(mins => $3), clock_timestamp() - make_interval(mins => $3), 'EXPIRED')`,
        [uuidv7(), userId, ageMinutes]);
    }
  } finally { await o.end(); }
}

/** Vieillit toutes les vérifications d'un compte (une vérification consommée ne se modifie plus : les déclencheurs sont neutralisés pour cette seule préparation de donnée, sous postgres). */
export async function ageChallenges(db: string, userId: string, minutes: number): Promise<void> {
  const p = await connectAs('postgres', db);
  try {
    await p.query('set session_replication_role = replica');
    await p.query(`update app.auth_challenges set created_at = created_at - make_interval(mins => $2) where user_id = $1`, [userId, minutes]);
  } finally { await p.end(); }
}
```

(`PASSWORD` de `test/support/app.ts` fait 32 caractères : valable pour un administrateur. Les insertions de `seedHistory` passent par `cp_owner` : le `INSERT` de `cp_app` n'accorde pas `created_at`, `consumed_*`.)

Run : `pnpm vitest run --project unit apps/api/src/modules/auth/second-factor apps/api/src/modules/audit/audit-actions-1b.spec.ts` — Expected : FAIL (modules absents).

- [ ] **Step 2 : Écrire le test d'intégration (échoue)**

`apps/api/test/integration/second-factor-service.int.spec.ts` :

```ts
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { ApiError } from '../../src/http/errors.js';
import { OtpLimiter } from '../../src/modules/auth/second-factor/otp-limiter.js';
import { otpHmac } from '../../src/modules/auth/second-factor/otp.js';
import { SecondFactorService, outcomeToError, type CheckOutcome } from '../../src/modules/auth/second-factor/second-factor.service.js';
import { buildTestApp, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { ageChallenges, createAdmin, latestCode, seedHistory } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let sf: SecondFactorService;
let prisma: PrismaService;
const anon = { kind: 'anonymous', ip: '203.0.113.7' } as const;
beforeAll(async () => {
  db = await createTestDatabase();
  t = await buildTestApp(db);
  sf = t.app.get(SecondFactorService, { strict: false });
  prisma = t.app.get(PrismaService, { strict: false });
});
afterAll(async () => { await t.close(); });

const issueLogin = (userId: string) => prisma.withTx((tx) => sf.issueInTx(tx, anon, { userId, purpose: 'LOGIN', sessionId: null, pendingEmail: null, tokenHash: randomBytes(32), ip: anon.ip }));
const check = (userId: string, code: string, challengeId?: string) =>
  prisma.withTx((tx) => sf.checkInTx(tx, anon, { userId, purpose: 'LOGIN', code, ...(challengeId ? { challengeId } : {}) }));
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const active = (userId: string) => rows(`select id, attempts from app.auth_challenges where user_id = $1 and consumed_at is null and purpose = 'LOGIN'`, [userId]);
const wrong = (code: string) => (code === '000000' ? '000001' : '000000');

describe('issueInTx', () => {
  it('crée une vérification active, un HMAC conforme et un email chiffré lié', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    expect(issued).toMatchObject({ expiresInSeconds: 600, resendAfterSeconds: 60 });
    const code = await latestCode(db, a.email);
    expect(code).toMatch(/^[0-9]{6}$/);
    const [ch] = await rows(`select id, code_hmac, expires_at > clock_timestamp() + interval '9 minutes' as ten from app.auth_challenges where id = $1`, [issued.challengeId]);
    expect(ch.code_hmac.equals(otpHmac(t.config().security.otpPepper, issued.challengeId, code))).toBe(true);
    expect(ch.ten).toBe(true);
    const [mail] = await rows(`select kind, status, challenge_id, payload from app.email_outbox where challenge_id = $1`, [issued.challengeId]);
    expect(mail).toMatchObject({ kind: 'ADMIN_OTP', status: 'PENDING', challenge_id: issued.challengeId, payload: { purpose: 'LOGIN' } });
    expect(JSON.stringify(mail.payload)).not.toContain(code);
  });
  it('consomme l’ancienne (SUPERSEDED) et annule son email ; une seule vérification reste active', async () => {
    const a = await createAdmin(db);
    const first = await issueLogin(a.id);
    await ageChallenges(db, a.id, 2);
    const second = await issueLogin(a.id);
    expect((await active(a.id)).map((r) => r.id)).toEqual([second.challengeId]);
    const [old] = await rows(`select consumed_reason from app.auth_challenges where id = $1`, [first.challengeId]);
    expect(old.consumed_reason).toBe('SUPERSEDED');
    const [oldMail] = await rows(`select status, payload_encrypted is null as cleared from app.email_outbox where challenge_id = $1`, [first.challengeId]);
    expect(oldMail).toEqual({ status: 'CANCELLED', cleared: true });
  });
  it('limites : 1 par minute, 5 par heure, 10 par jour', async () => {
    const a = await createAdmin(db);
    await issueLogin(a.id);
    await expect(issueLogin(a.id)).rejects.toMatchObject({ code: 'TOO_MANY_CODE_REQUESTS', headers: { 'retry-after': expect.stringMatching(/^[0-9]+$/) } });
    const b = await createAdmin(db);
    await seedHistory(db, b.id, 5, 30); // 5 demandes dans l'heure, aucune dans la dernière minute
    await expect(issueLogin(b.id)).rejects.toMatchObject({ code: 'TOO_MANY_CODE_REQUESTS' });
    const c = await createAdmin(db);
    await seedHistory(db, c.id, 4, 30);
    await issueLogin(c.id); // la 5ᵉ de l'heure passe
    const d = await createAdmin(db);
    await seedHistory(db, d.id, 10, 120); // 10 dans la journée, aucune dans l'heure
    await expect(issueLogin(d.id)).rejects.toMatchObject({ code: 'TOO_MANY_CODE_REQUESTS' });
  });
  it('un administrateur bloqué : 403 SECOND_FACTOR_BLOCKED, aucune vérification, aucun email', async () => {
    const a = await createAdmin(db);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [a.id]);
    await c.end();
    await expect(issueLogin(a.id)).rejects.toMatchObject({ code: 'SECOND_FACTOR_BLOCKED' });
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [a.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.email_outbox where recipient_user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('un étudiant, un compte suspendu ou inconnu : CHALLENGE_EXPIRED, jamais de vérification', async () => {
    const s = await createAdmin(db, { status: 'SUSPENDED' });
    await expect(issueLogin(s.id)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
    await expect(issueLogin(uuidv7())).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });
  });
  it('un acteur non autorisé est refusé', async () => {
    const a = await createAdmin(db);
    await expect(prisma.withTx((tx) => sf.issueInTx(tx, { kind: 'cli', command: 'create-class' } as never, { userId: a.id, purpose: 'LOGIN', sessionId: null, pendingEmail: null, tokenHash: Buffer.alloc(32, 1), ip: null }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('issueInTx : atomicité des limites', () => {
  it('six demandes simultanées : une seule aboutit (1 par minute), une vérification active, un email', async () => {
    const a = await createAdmin(db);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => issueLogin(a.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as ApiError).code).toBe('TOO_MANY_CODE_REQUESTS');
    expect(await active(a.id)).toHaveLength(1);
    expect(await rows(`select 1 from app.email_outbox where recipient_user_id = $1 and status <> 'CANCELLED'`, [a.id])).toHaveLength(1);
  });
  it('une demande qui attend le verrou de l’administrateur est servie après lui (verrou observé)', async () => {
    const a = await createAdmin(db);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [a.id]);
    const pending = issueLogin(a.id);
    await waitForLockWait(db, pid);
    await holder.query('rollback');
    await holder.end();
    expect((await pending).expiresInSeconds).toBe(600);
  });
});

describe('checkInTx', () => {
  async function fresh() {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    return { a, issued, code: await latestCode(db, a.email) };
  }
  it('bon code : ok, la vérification n’est consommée que par l’appelant', async () => {
    const { a, issued, code } = await fresh();
    const r = await check(a.id, code, issued.challengeId);
    expect(r).toMatchObject({ ok: true, challenge: { id: issued.challengeId, purpose: 'LOGIN' } });
    expect(await active(a.id)).toHaveLength(1);
  });
  it('mauvais code : l’échec est enregistré (validé), 5 essais puis LOCKED, l’email est annulé', async () => {
    const { a, issued, code } = await fresh();
    for (let i = 1; i <= 4; i++) expect(await check(a.id, wrong(code), issued.challengeId)).toEqual({ ok: false, reason: 'WRONG', attemptsLeft: 5 - i });
    expect((await active(a.id))[0]!.attempts).toBe(4);
    expect(await check(a.id, wrong(code), issued.challengeId)).toEqual({ ok: false, reason: 'LOCKED' });
    expect(await active(a.id)).toHaveLength(0);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1`, [a.id])).toHaveLength(5);
    const [mail] = await rows(`select status from app.email_outbox where challenge_id = $1`, [issued.challengeId]);
    expect(mail.status).toBe('CANCELLED');
    expect(await check(a.id, code, issued.challengeId)).toEqual({ ok: false, reason: 'EXPIRED' });
  });
  it('3ᵉ échec : alerte à tous les administrateurs actifs, sans doublon dans l’heure (R7)', async () => {
    const a = await createAdmin(db);
    const other = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const c = await connectAs('cp_app', db);
    for (let i = 0; i < 2; i++) await c.query(`insert into app.second_factor_failures (user_id, challenge_id, purpose) values ($1,$2,'LOGIN')`, [a.id, issued.challengeId]);
    await c.end();
    await check(a.id, wrong(code), issued.challengeId); // 3ᵉ
    await check(a.id, wrong(code), issued.challengeId); // 4ᵉ : même heure, pas de doublon
    const alerts = await rows(`select recipient_user_id, dedupe_key, payload from app.email_outbox where kind = 'ADMIN_SECURITY_ALERT' and payload->>'accountEmail' = $1`, [a.email]);
    const recipients = alerts.map((r) => r.recipient_user_id);
    expect(recipients).toContain(a.id);
    expect(recipients).toContain(other.id);
    expect(new Set(recipients).size).toBe(recipients.length);
    expect(alerts[0].dedupe_key).toMatch(new RegExp(`^admin-2fa-alert:${a.id}:[0-9]{10}:`));
    expect(alerts[0].payload).toMatchObject({ event: 'SECOND_FACTOR_FAILURES', failures: 3 });
  });
  it('10ᵉ échec en 60 minutes : compte bloqué, vérifications consommées, audit, alerte ; puis refus sans comparaison', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const c = await connectAs('cp_app', db);
    for (let i = 0; i < 9; i++) await c.query(`insert into app.second_factor_failures (user_id, challenge_id, purpose) values ($1,$2,'STEP_UP')`, [a.id, uuidv7()]);
    await c.end();
    expect(await check(a.id, wrong(code), issued.challengeId)).toEqual({ ok: false, reason: 'BLOCKED' });
    const [u] = await rows(`select second_factor_blocked_at is not null as blocked from app.users where id = $1`, [a.id]);
    expect(u.blocked).toBe(true);
    expect(await active(a.id)).toHaveLength(0);
    const [audit] = await rows(`select source, action, metadata from app.audit_log where target_id = $1 and action = 'ADMIN_SECOND_FACTOR_BLOCKED'`, [a.id]);
    expect(audit).toMatchObject({ source: 'APP', metadata: { failures: 10 } });
    expect((await rows(`select 1 from app.email_outbox where kind = 'ADMIN_SECURITY_ALERT' and payload->>'event' = 'SECOND_FACTOR_BLOCKED' and payload->>'accountEmail' = $1`, [a.email])).length).toBeGreaterThanOrEqual(1);
  });
  it('compte bloqué : le bon code est refusé sans comparaison (aucun essai ni échec enregistré)', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [a.id]);
    await c.end();
    expect(await check(a.id, code, issued.challengeId)).toEqual({ ok: false, reason: 'BLOCKED' });
    expect((await active(a.id))[0]!.attempts).toBe(0);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('outcomeToError : codes et en-têtes', () => {
    const wrongE = outcomeToError({ ok: false, reason: 'WRONG', attemptsLeft: 3 } as Exclude<CheckOutcome, { ok: true }>, { clearChallengeCookie: true });
    expect([wrongE.getStatus(), wrongE.code, wrongE.extra]).toEqual([400, 'CODE_INVALID', { attemptsLeft: 3 }]);
    const locked = outcomeToError({ ok: false, reason: 'LOCKED' }, { clearChallengeCookie: true });
    expect([locked.getStatus(), locked.code, locked.headers['set-cookie']]).toEqual([400, 'CODE_LOCKED', '__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0']);
    expect(outcomeToError({ ok: false, reason: 'EXPIRED' }, { clearChallengeCookie: false }).headers).toEqual({});
    expect(outcomeToError({ ok: false, reason: 'BLOCKED' }, { clearChallengeCookie: false })).toMatchObject({ code: 'SECOND_FACTOR_BLOCKED' });
    expect(outcomeToError({ ok: false, reason: 'BLOCKED' }, { clearChallengeCookie: false }).getStatus()).toBe(403);
  });
});

describe('checkInTx : deux validations simultanées (verrou observé, deux issues)', () => {
  /** Le titulaire tient le verrou de l'administrateur ; la vérification attend ; puis il valide ou annule. */
  async function holdThenCheck(outcome: 'COMMIT' | 'ROLLBACK') {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [a.id]);
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where id = $1`, [issued.challengeId]);
    const pending = check(a.id, code, issued.challengeId);
    await waitForLockWait(db, pid);
    await holder.query(outcome);
    await holder.end();
    return pending;
  }
  it('le titulaire a consommé la vérification : la seconde validation reçoit EXPIRED', async () => {
    expect(await holdThenCheck('COMMIT')).toEqual({ ok: false, reason: 'EXPIRED' });
  });
  it('le titulaire a annulé : la seconde validation réussit', async () => {
    expect(await holdThenCheck('ROLLBACK')).toMatchObject({ ok: true });
  });
  it('deux validations parallèles du même code : une seule réussit à consommer', async () => {
    const a = await createAdmin(db);
    const issued = await issueLogin(a.id);
    const code = await latestCode(db, a.email);
    const attempt = () => prisma.withTx(async (tx) => {
      const r = await sf.checkInTx(tx, anon, { userId: a.id, purpose: 'LOGIN', code, challengeId: issued.challengeId });
      if (r.ok) await sf.consumeInTx(tx, anon, r.challenge, 'USED');
      return r;
    });
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'EXPIRED')).toHaveLength(1);
  });
});

describe('OtpLimiter', () => {
  it('10 demandes par heure et par préfixe d’IP, 30 essais', async () => {
    const lim = t.app.get(OtpLimiter, { strict: false });
    for (let i = 0; i < 10; i++) await lim.hitRequest('198.51.100.9');
    await expect(lim.hitRequest('198.51.100.9')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    await lim.hitRequest('198.51.100.10');
    for (let i = 0; i < 30; i++) await lim.hitTry('198.51.100.20');
    await expect(lim.hitTry('198.51.100.20')).rejects.toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });
});
```

Ajouter à `TestApp` (`test/support/app.ts`) un accesseur `config: () => AppConfig` (la configuration passée à `buildApiApp`) ; `buildTestApp` le renseigne avec `testConfig(db, opts.config)`. Retirer l'import `cipher` et sa ligne `expect(cipher)` si ESLint les juge inutiles. Dans `issueLogin`, le jeton de test peut simplement être `randomBytes(32)` (le code ci-dessus écrit un remplissage compliqué : le remplacer par `randomBytes(32)` importé de `node:crypto`).

Run : `pnpm vitest run --project integration apps/api/test/integration/second-factor-service.int.spec.ts` — Expected : FAIL (`second-factor.service` absent).

- [ ] **Step 3 : Implémenter**

`audit-actions.ts` : ajouter à `AUDIT_METADATA` :

```ts
  ADMIN_LOGIN: z.strictObject({ method: z.enum(['EMAIL_CODE', 'RECOVERY_CODE']) }),
  ADMIN_EMAIL_CHANGED: z.strictObject({ revokedSessions: z.number().int().min(0) }),
  PASSWORD_RESET_COMPLETED: z.strictObject({ revokedSessions: z.number().int().min(0) }),
  ADMIN_SECOND_FACTOR_BLOCKED: z.strictObject({ failures: z.number().int().min(0) }),
```

`apps/api/src/modules/auth/second-factor/otp.ts` :

```ts
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { CHALLENGE_COOKIE } from '../../../http/session-cookie-name.js';

export const OTP_TTL_SECONDS = 600;
const ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Strict';

export function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** HMAC-SHA256(OTP_PEPPER, challenge_id ‖ code) (§ 3.3) ; l'identifiant (36 caractères) est celui de la vérification, fixé avant le calcul. */
export function otpHmac(pepper: string, challengeId: string, code: string): Buffer {
  return createHmac('sha256', pepper).update(challengeId.toLowerCase(), 'utf8').update(code, 'utf8').digest();
}

/** Comparaison à temps constant. */
export function otpMatches(expected: Buffer, pepper: string, challengeId: string, code: string): boolean {
  const actual = otpHmac(pepper, challengeId, code);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function newChallengeToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  return { token: raw.toString('base64url'), hash: createHash('sha256').update(raw).digest() };
}

/** Jeton mal formé : null, sans requête en base. */
export function hashChallengeToken(token: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  return raw.length === 32 ? createHash('sha256').update(raw).digest() : null;
}

export const challengeSetCookie = (token: string): string => `${CHALLENGE_COOKIE}=${token}; ${ATTRS}; Max-Age=${OTP_TTL_SECONDS}`;
/** Effacement avec exactement les mêmes attributs (§ 3.3). */
export const challengeClearCookie = (): string => `${CHALLENGE_COOKIE}=; ${ATTRS}; Max-Age=0`;
```

`apps/api/src/modules/auth/second-factor/challenges.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../../database/prisma.service.js';

export type ChallengePurpose = 'LOGIN' | 'RECOVERY' | 'STEP_UP' | 'EMAIL_CHANGE_OLD' | 'EMAIL_CHANGE_NEW';
export type ConsumeReason = 'USED' | 'EXPIRED' | 'SUPERSEDED' | 'LOCKED' | 'SESSION_ENDED';
export type LockedUser = { id: string; email: string; role: 'USER' | 'ADMIN'; status: string; blockedAt: Date | null };
export type NewChallenge = {
  id: string; userId: string; purpose: ChallengePurpose; sessionId: string | null; tokenHash: Buffer | null;
  codeHmac: Buffer; pendingEmail: string | null; ip: string | null; ttlSeconds: number;
};
export type LockedChallenge = { id: string; purpose: ChallengePurpose; sessionId: string | null; pendingEmail: string | null; attempts: number; codeHmac: Buffer };
export type RequestCounts = { minute: number; hour: number; day: number; retryMinute: number; retryHour: number; retryDay: number };

@Injectable()
export class ChallengesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Premier verrou de toute opération sur les vérifications (§ 3.3, étape 1). */
  async lockUserInTx(tx: TxClient, userId: string): Promise<LockedUser | null> {
    const r = await tx.$queryRaw<{ id: string; email: string; role: 'USER' | 'ADMIN'; status: string; blocked_at: Date | null }[]>`
      select id, email::text as email, global_role::text as role, status::text as status, second_factor_blocked_at as blocked_at
        from app.users where id = ${userId}::uuid for no key update`;
    const u = r[0];
    return u ? { id: u.id, email: u.email, role: u.role, status: u.status, blockedAt: u.blocked_at } : null;
  }

  /** À appeler sous le verrou de l'administrateur : le comptage et l'insertion sont ainsi atomiques (R5). Purposes hors RECOVERY. */
  async requestCountsInTx(tx: TxClient, userId: string): Promise<RequestCounts> {
    const r = await tx.$queryRaw<{ m: number; h: number; d: number; rm: number | null; rh: number | null; rd: number | null }[]>`
      select count(*) filter (where created_at > clock_timestamp() - interval '1 minute')::int as m,
             count(*) filter (where created_at > clock_timestamp() - interval '1 hour')::int as h,
             count(*)::int as d,
             ceil(extract(epoch from (max(created_at) filter (where created_at > clock_timestamp() - interval '1 minute') + interval '1 minute' - clock_timestamp())))::int as rm,
             ceil(extract(epoch from (min(created_at) filter (where created_at > clock_timestamp() - interval '1 hour') + interval '1 hour' - clock_timestamp())))::int as rh,
             ceil(extract(epoch from (min(created_at) + interval '1 day' - clock_timestamp())))::int as rd
        from app.auth_challenges
       where user_id = ${userId}::uuid and purpose <> 'RECOVERY' and created_at > clock_timestamp() - interval '1 day'`;
    const x = r[0]!;
    return { minute: x.m, hour: x.h, day: x.d, retryMinute: x.rm ?? 60, retryHour: x.rh ?? 3600, retryDay: x.rd ?? 86400 };
  }

  async supersedeActiveInTx(tx: TxClient, userId: string, purpose: ChallengePurpose): Promise<void> {
    await tx.$executeRaw`
      update app.auth_challenges
         set consumed_at = clock_timestamp(),
             consumed_reason = (case when expires_at <= clock_timestamp() then 'EXPIRED' else 'SUPERSEDED' end)::app.challenge_consumed_reason
       where user_id = ${userId}::uuid and purpose = ${purpose}::app.challenge_purpose and consumed_at is null`;
  }

  async insertInTx(tx: TxClient, c: NewChallenge): Promise<void> {
    await tx.$executeRaw`
      insert into app.auth_challenges (id, user_id, purpose, session_id, token_hash, code_hmac, pending_email, ip, expires_at)
      values (${c.id}::uuid, ${c.userId}::uuid, ${c.purpose}::app.challenge_purpose, ${c.sessionId}::uuid, ${c.tokenHash}, ${c.codeHmac},
              ${c.pendingEmail}::ext.citext, ${c.ip}::inet, clock_timestamp() + make_interval(secs => ${c.ttlSeconds}::double precision))`;
  }

  /** Lecture sans verrou : retrouve la vérification LOGIN active d'un cookie. */
  async findLoginByTokenHash(hash: Buffer): Promise<{ id: string; userId: string } | null> {
    const r = await this.prisma.client.$queryRaw<{ id: string; user_id: string }[]>`
      select id, user_id from app.auth_challenges
       where token_hash = ${hash} and purpose = 'LOGIN' and consumed_at is null and expires_at > clock_timestamp()`;
    return r[0] ? { id: r[0].id, userId: r[0].user_id } : null;
  }

  /**
   * Verrouille (FOR UPDATE) les vérifications actives utiles. Pour RECOVERY : LOGIN puis RECOVERY, dans cet ordre
   * (l'énumération `challenge_purpose` est déclarée dans l'ordre des verrous ; LockRows s'applique après le tri).
   */
  async lockForCheckInTx(tx: TxClient, userId: string, purpose: ChallengePurpose, challengeId: string | null): Promise<LockedChallenge[]> {
    const rows = purpose === 'RECOVERY'
      ? await tx.$queryRaw<LockedRow[]>`
          select id, purpose::text as purpose, session_id, pending_email::text as pending_email, attempts, code_hmac from app.auth_challenges
           where user_id = ${userId}::uuid and purpose in ('LOGIN', 'RECOVERY') and consumed_at is null and expires_at > clock_timestamp()
           order by purpose for update`
      : await tx.$queryRaw<LockedRow[]>`
          select id, purpose::text as purpose, session_id, pending_email::text as pending_email, attempts, code_hmac from app.auth_challenges
           where user_id = ${userId}::uuid and purpose = ${purpose}::app.challenge_purpose and consumed_at is null and expires_at > clock_timestamp()
             and (${challengeId}::uuid is null or id = ${challengeId}::uuid)
           for update`;
    return rows.map((r) => ({ id: r.id, purpose: r.purpose, sessionId: r.session_id, pendingEmail: r.pending_email, attempts: r.attempts, codeHmac: Buffer.from(r.code_hmac) }));
  }

  async incrementAttemptsInTx(tx: TxClient, id: string): Promise<number> {
    const r = await tx.$queryRaw<{ attempts: number }[]>`update app.auth_challenges set attempts = attempts + 1 where id = ${id}::uuid returning attempts`;
    return r[0]!.attempts;
  }

  async consumeInTx(tx: TxClient, id: string, reason: ConsumeReason): Promise<void> {
    await tx.$executeRaw`
      update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = ${reason}::app.challenge_consumed_reason
       where id = ${id}::uuid and consumed_at is null`;
  }

  async insertFailureInTx(tx: TxClient, userId: string, challengeId: string, purpose: ChallengePurpose): Promise<void> {
    await tx.$executeRaw`insert into app.second_factor_failures (user_id, challenge_id, purpose) values (${userId}::uuid, ${challengeId}::uuid, ${purpose}::app.challenge_purpose)`;
  }

  async countFailuresInTx(tx: TxClient, userId: string): Promise<number> {
    const r = await tx.$queryRaw<{ n: number }[]>`
      select count(*)::int as n from app.second_factor_failures where user_id = ${userId}::uuid and occurred_at > clock_timestamp() - interval '60 minutes'`;
    return r[0]!.n;
  }

  async setBlockedInTx(tx: TxClient, userId: string): Promise<boolean> {
    const r = await tx.$queryRaw<{ n: number }[]>`
      update app.users set second_factor_blocked_at = clock_timestamp() where id = ${userId}::uuid and second_factor_blocked_at is null returning 1 as n`;
    return r.length === 1;
  }

  /** Consomme toutes les vérifications actives du compte, sauf RECOVERY (seule sortie du blocage). */
  async consumeAllActiveInTx(tx: TxClient, userId: string, reason: ConsumeReason): Promise<void> {
    await tx.$executeRaw`
      update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = ${reason}::app.challenge_consumed_reason
       where user_id = ${userId}::uuid and purpose <> 'RECOVERY' and consumed_at is null`;
  }

  async activeAdminsInTx(tx: TxClient): Promise<{ id: string; email: string }[]> {
    return tx.$queryRaw<{ id: string; email: string }[]>`
      select id, email::text as email from app.users where status = 'ACTIVE' and global_role = 'ADMIN' order by id`;
  }
}

type LockedRow = { id: string; purpose: ChallengePurpose; session_id: string | null; pending_email: string | null; attempts: number; code_hmac: Uint8Array };
```

`apps/api/src/modules/auth/second-factor/otp-limiter.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../http/errors.js';
import { ipPrefix } from '../../../http/ip.js';
import { RateLimitRepository } from '../rate-limit.repository.js';

const HOUR = 3600;
export const OTP_REQUESTS_PER_IP_HOUR = 10;
export const OTP_TRIES_PER_IP_HOUR = 30;

/** Seaux par préfixe d'IP (R5) : l'incrément est atomique (INSERT … ON CONFLICT), jamais « lire puis écrire ». */
@Injectable()
export class OtpLimiter {
  constructor(@Inject(RateLimitRepository) private readonly repo: RateLimitRepository) {}

  hitRequest(ip: string): Promise<void> { return this.hit(`otp-ip:${ipPrefix(ip)}`, OTP_REQUESTS_PER_IP_HOUR); }
  hitTry(ip: string): Promise<void> { return this.hit(`otp-try-ip:${ipPrefix(ip)}`, OTP_TRIES_PER_IP_HOUR); }

  private async hit(key: string, limit: number): Promise<void> {
    const r = await this.repo.hit(key, HOUR);
    if (r.attempts > limit) {
      const retryAfter = Math.max(1, r.resetIn);
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', { retryAfter }, { 'retry-after': String(retryAfter) });
    }
  }
}
```

`apps/api/src/modules/auth/second-factor/second-factor.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG } from '../../../config/config.module.js';
import type { AppConfig } from '../../../config/load-config.js';
import type { TxClient } from '../../../database/prisma.service.js';
import { ApiError } from '../../../http/errors.js';
import { AuditService } from '../../audit/audit.service.js';
import type { Actor, AnonymousActor } from '../../authz/actor.js';
import { AuthzService } from '../../authz/authz.service.js';
import type { Action } from '../../authz/matrix.js';
import { MailService } from '../../mail/mail.service.js';
import {
  ChallengesRepository, type ChallengePurpose, type ConsumeReason, type LockedChallenge,
} from './challenges.repository.js';
import { OTP_TTL_SECONDS, challengeClearCookie, newOtpCode, otpHmac, otpMatches } from './otp.js';

export type { ChallengePurpose };
export type IssueInput = {
  userId: string; purpose: Exclude<ChallengePurpose, 'RECOVERY'>; sessionId: string | null; pendingEmail: string | null;
  tokenHash: Buffer | null; ip: string | null;
};
export type Issued = { challengeId: string; expiresInSeconds: 600; resendAfterSeconds: 60 };
export type ChallengeRef = { id: string; purpose: ChallengePurpose; sessionId: string | null; pendingEmail: string | null };
export type CheckInput = { userId: string; purpose: ChallengePurpose; code: string; challengeId?: string };
export type CheckOutcome =
  | { ok: true; challenge: ChallengeRef; companion: ChallengeRef | null }
  | { ok: false; reason: 'WRONG'; attemptsLeft: number }
  | { ok: false; reason: 'LOCKED' | 'EXPIRED' | 'BLOCKED' };

export const MAX_ATTEMPTS = 5;
const ALERT_AFTER_FAILURES = 3;
const BLOCK_AFTER_FAILURES = 10;
const LIMITS = { minute: 1, hour: 5, day: 10 } as const;

/** L'action d'autorisation de chaque usage (émission : celle de l'étape qui crée la vérification). */
const ISSUE_ACTION: Record<ChallengePurpose, Action> = {
  LOGIN: 'auth.login', RECOVERY: 'auth.verifyRecovery', STEP_UP: 'me.stepUp', EMAIL_CHANGE_OLD: 'me.changeEmailStart', EMAIL_CHANGE_NEW: 'me.changeEmailVerifyOld',
};
const CHECK_ACTION: Record<ChallengePurpose, Action> = {
  LOGIN: 'auth.verifyCode', RECOVERY: 'auth.verifyRecovery', STEP_UP: 'me.stepUpVerify', EMAIL_CHANGE_OLD: 'me.changeEmailVerifyOld', EMAIL_CHANGE_NEW: 'me.changeEmailVerifyNew',
};

const ref = (c: LockedChallenge): ChallengeRef => ({ id: c.id, purpose: c.purpose, sessionId: c.sessionId, pendingEmail: c.pendingEmail });
const hourKey = (): string => new Date().toISOString().slice(0, 13).replace(/[-T]/g, '');

/** Erreur HTTP d'un échec de vérification (R4). `clearChallengeCookie` : seulement pour les parcours qui portent le cookie de connexion. */
export function outcomeToError(o: Exclude<CheckOutcome, { ok: true }>, opts: { clearChallengeCookie: boolean }): ApiError {
  const headers: Record<string, string> = opts.clearChallengeCookie ? { 'set-cookie': challengeClearCookie() } : {};
  switch (o.reason) {
    case 'WRONG': return new ApiError(400, 'CODE_INVALID', { attemptsLeft: o.attemptsLeft });
    case 'LOCKED': return new ApiError(400, 'CODE_LOCKED', {}, headers);
    case 'EXPIRED': return new ApiError(400, 'CHALLENGE_EXPIRED', {}, headers);
    case 'BLOCKED': return new ApiError(403, 'SECOND_FACTOR_BLOCKED', {}, headers);
  }
}

@Injectable()
export class SecondFactorService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(ChallengesRepository) private readonly repo: ChallengesRepository,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Crée une vérification et met son email en file, dans la transaction de l'appelant. Ordre : verrou `users`, limites
   * (comptées sous ce verrou, donc atomiques), consommation de l'ancienne, insertion, email.
   */
  async issueInTx(tx: TxClient, actor: Actor, input: IssueInput): Promise<Issued> {
    this.authz.assert(actor, ISSUE_ACTION[input.purpose]);
    const u = await this.repo.lockUserInTx(tx, input.userId);
    if (!u || u.status !== 'ACTIVE' || u.role !== 'ADMIN') throw new ApiError(400, 'CHALLENGE_EXPIRED');
    if (u.blockedAt) throw new ApiError(403, 'SECOND_FACTOR_BLOCKED');
    const n = await this.repo.requestCountsInTx(tx, u.id);
    const wait = n.minute >= LIMITS.minute ? n.retryMinute : n.hour >= LIMITS.hour ? n.retryHour : n.day >= LIMITS.day ? n.retryDay : 0;
    if (wait > 0) throw new ApiError(429, 'TOO_MANY_CODE_REQUESTS', { retryAfter: wait }, { 'retry-after': String(wait) });
    await this.repo.supersedeActiveInTx(tx, u.id, input.purpose);
    const id = uuidv7(); // généré par l'appelant avant le calcul du HMAC (§ 3.3)
    const code = newOtpCode();
    await this.repo.insertInTx(tx, {
      id, userId: u.id, purpose: input.purpose, sessionId: input.sessionId, tokenHash: input.tokenHash,
      codeHmac: otpHmac(this.config.security.otpPepper, id, code), pendingEmail: input.pendingEmail, ip: input.ip, ttlSeconds: OTP_TTL_SECONDS,
    });
    const base = { recipientUserId: u.id, dedupeKey: `otp:${id}`, challengeId: id, secret: { code } } as const;
    if (input.purpose === 'EMAIL_CHANGE_NEW') {
      await this.mail.enqueueInTx(tx, actor, { ...base, kind: 'ADMIN_EMAIL_CHANGE_NEW', toAddress: input.pendingEmail!, payload: {} });
    } else if (input.purpose === 'EMAIL_CHANGE_OLD') {
      await this.mail.enqueueInTx(tx, actor, { ...base, kind: 'ADMIN_EMAIL_CHANGE_OLD', toAddress: u.email, payload: { newEmail: input.pendingEmail! } });
    } else {
      await this.mail.enqueueInTx(tx, actor, { ...base, kind: 'ADMIN_OTP', toAddress: u.email, payload: { purpose: input.purpose } });
    }
    return { challengeId: id, expiresInSeconds: 600, resendAfterSeconds: 60 };
  }

  /**
   * Étapes 1 à 4 du § 3.3. Un échec n'est jamais une exception : la transaction de l'appelant doit être validée pour que
   * l'essai, l'échec, le blocage et les alertes soient enregistrés ; l'appelant lève ensuite `outcomeToError`.
   */
  async checkInTx(tx: TxClient, actor: Actor, input: CheckInput): Promise<CheckOutcome> {
    this.authz.assert(actor, CHECK_ACTION[input.purpose]);
    const u = await this.repo.lockUserInTx(tx, input.userId);
    if (!u || u.status !== 'ACTIVE' || u.role !== 'ADMIN') return { ok: false, reason: 'EXPIRED' };
    if (u.blockedAt) return { ok: false, reason: 'BLOCKED' }; // refus sans comparaison
    const locked = await this.repo.lockForCheckInTx(tx, u.id, input.purpose, input.challengeId ?? null);
    const target = locked.find((c) => c.purpose === input.purpose);
    // RECOVERY : seulement avec la vérification LOGIN du cookie, verrouillée avant elle.
    const companion = input.purpose === 'RECOVERY' ? locked.find((c) => c.purpose === 'LOGIN' && c.id === input.challengeId) : undefined;
    if (!target || (input.purpose === 'RECOVERY' && !companion)) return { ok: false, reason: 'EXPIRED' };
    if (target.attempts >= MAX_ATTEMPTS) {
      await this.repo.consumeInTx(tx, target.id, 'LOCKED');
      return { ok: false, reason: 'LOCKED' };
    }
    if (otpMatches(target.codeHmac, this.config.security.otpPepper, target.id, input.code)) {
      return { ok: true, challenge: ref(target), companion: companion ? ref(companion) : null };
    }
    const attempts = await this.repo.incrementAttemptsInTx(tx, target.id);
    await this.repo.insertFailureInTx(tx, u.id, target.id, input.purpose);
    const failures = await this.repo.countFailuresInTx(tx, u.id);
    if (attempts >= MAX_ATTEMPTS) await this.repo.consumeInTx(tx, target.id, 'LOCKED');
    if (failures >= ALERT_AFTER_FAILURES) await this.alertAdminsInTx(tx, actor, u.email, 'SECOND_FACTOR_FAILURES', u.id, failures);
    if (failures >= BLOCK_AFTER_FAILURES && (await this.repo.setBlockedInTx(tx, u.id))) {
      await this.audit.recordInTx(tx, actor, { action: 'ADMIN_SECOND_FACTOR_BLOCKED', targetType: 'USER', targetId: u.id, metadata: { failures } });
      await this.repo.consumeAllActiveInTx(tx, u.id, 'LOCKED');
      await this.alertAdminsInTx(tx, actor, u.email, 'SECOND_FACTOR_BLOCKED', u.id, failures);
      return { ok: false, reason: 'BLOCKED' };
    }
    return attempts >= MAX_ATTEMPTS ? { ok: false, reason: 'LOCKED' } : { ok: false, reason: 'WRONG', attemptsLeft: MAX_ATTEMPTS - attempts };
  }

  async consumeInTx(tx: TxClient, actor: Actor, challenge: ChallengeRef, reason: ConsumeReason): Promise<void> {
    this.authz.assert(actor, CHECK_ACTION[challenge.purpose]);
    await this.repo.consumeInTx(tx, challenge.id, reason);
  }

  async findLoginChallenge(actor: AnonymousActor, tokenHash: Buffer): Promise<{ challengeId: string; userId: string } | null> {
    this.authz.assert(actor, 'auth.verifyCode');
    const r = await this.repo.findLoginByTokenHash(tokenHash);
    return r ? { challengeId: r.id, userId: r.userId } : null;
  }

  /** Alerte à l'administrateur concerné et aux autres (§ 3.3) ; clé anti-doublon par compte, heure UTC et destinataire (R7). */
  private async alertAdminsInTx(tx: TxClient, actor: Actor, accountEmail: string, event: 'SECOND_FACTOR_FAILURES' | 'SECOND_FACTOR_BLOCKED', accountId: string, failures: number): Promise<void> {
    const prefix = event === 'SECOND_FACTOR_BLOCKED' ? 'admin-2fa-block' : 'admin-2fa-alert';
    for (const admin of await this.repo.activeAdminsInTx(tx)) {
      await this.mail.enqueueInTx(tx, actor, {
        kind: 'ADMIN_SECURITY_ALERT', recipientUserId: admin.id, toAddress: admin.email,
        dedupeKey: `${prefix}:${accountId}:${hourKey()}:${admin.id}`,
        payload: event === 'SECOND_FACTOR_FAILURES' ? { event, accountEmail, failures } : { event, accountEmail },
        expiresInSeconds: 86_400,
      });
    }
  }
}
```

`auth.module.ts` : importer `MailModule.register(config.security.outboxPayloadKey)` ; ajouter les fournisseurs `ChallengesRepository`, `SecondFactorService`, `OtpLimiter` ; exporter `SecondFactorService`.

- [ ] **Step 4 : Vérifier**

Run : `pnpm vitest run --project unit apps/api/src/modules/auth/second-factor apps/api/src/modules/audit apps/api/src/modules/authz` ; `pnpm vitest run --project integration apps/api/test/integration/second-factor-service.int.spec.ts apps/api/test/integration/audit.int.spec.ts` ; `pnpm typecheck` ; `pnpm lint` ; `pnpm depcruise` — Expected : PASS. Preuve que le test « six demandes simultanées » est discriminant : retirer provisoirement le verrou `for no key update` de `lockUserInTx`, constater plusieurs réussites, remettre.

- [ ] **Step 5 : Commit**

```bash
git add apps/api
git commit -m "feat(auth): noyau du second facteur — vérifications, essais, échecs, blocage, alertes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10 : Connexion d'un administrateur — code par email, renvoi, session de 8 h

**Files :**
- Modify : `apps/api/src/modules/auth/auth.service.ts`, `apps/api/src/modules/auth/auth.controller.ts`, `apps/api/src/modules/auth/sessions.service.ts`, `apps/api/src/modules/auth/sessions.repository.ts`, `apps/api/src/modules/auth/session-cookie.ts`, `apps/api/test/integration/auth-login.int.spec.ts` (le cas `ADMIN_SECOND_FACTOR_REQUIRED` du lot 1a devient le cas ci-dessous), `apps/api/test/integration/routes-meta.int.spec.ts`
- Test : `apps/api/test/integration/auth-admin-login.int.spec.ts`

**Interfaces :**
- Consumes : `SecondFactorService`, `OtpLimiter`, `outcomeToError`, `challengeSetCookie`, `challengeClearCookie`, `hashChallengeToken`, `newChallengeToken` (tâche 9) ; `VerifyCodeBody` (tâche 1).
- Produces :
  - `POST /api/auth/login` (administrateur) → `202` `{ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: 600, resendAfterSeconds: 60 }` + cookie `__Host-cp_challenge`, **aucun cookie de session**
  - `POST /api/auth/verify-code` `{ code }` (public, cookie de vérification) → `200` `MeDto` + cookie de session `Max-Age=28800` + effacement du cookie de vérification
  - `POST /api/auth/resend-code` `{}` (public, cookie de vérification) → `202` (même corps) + nouveau cookie
  - `AuthService.login(...)` renvoie `{ kind: 'session'; opened: OpenedSession } | { kind: 'second-factor'; sent: { cookieToken: string; expiresInSeconds: 600; resendAfterSeconds: 60 } }`
  - `AuthService.verifyCode(actor: AnonymousActor, body: VerifyCodeBody, cookieToken: string | undefined, ctx): Promise<OpenedSession>` ; `AuthService.resendCode(actor, cookieToken, ctx)`
  - `SessionsService.openAdminInTx(tx, actor: AnonymousActor, user: { id: string }, method: 'EMAIL_CODE' | 'RECOVERY_CODE', ctx): Promise<OpenedSession>` ; `ADMIN_IDLE_SECONDS = 1800`, `ADMIN_ABSOLUTE_SECONDS = 28800`

- [ ] **Step 1 : Écrire le test (échoue)**

`apps/api/test/integration/auth-admin-login.int.spec.ts` :

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, registerStudent, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { ageChallenges, createAdmin, latestCode } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
beforeAll(async () => { db = await createTestDatabase(); t = await buildTestApp(db); });
afterAll(async () => { await t.close(); });

const CHALLENGE_RE = /^__Host-cp_challenge=([A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600$/;
const cookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie']].flat().filter((c): c is string => typeof c === 'string');
const challengeCookie = (res: { headers: Record<string, unknown> }) => cookies(res).find((c) => c.startsWith('__Host-cp_challenge='));
const challengeHeader = (res: { headers: Record<string, unknown> }) => ({ cookie: `__Host-cp_challenge=${CHALLENGE_RE.exec(challengeCookie(res)!)![1]}` });
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
async function startLogin(a: { email: string; password: string }, ip?: string) {
  const res = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password }, {}, ip);
  expect(res.statusCode).toBe(202);
  return { res, header: challengeHeader(res) };
}

describe('POST /api/auth/login (administrateur)', () => {
  it('202 avec le cookie de vérification, aucune session, une vérification et un email en file', async () => {
    const a = await createAdmin(db);
    const { res } = await startLogin(a);
    expect(res.json()).toEqual({ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: 600, resendAfterSeconds: 60 });
    expect(challengeCookie(res)).toMatch(CHALLENGE_RE);
    expect(sessionCookieOf(res)).toBeUndefined();
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'LOGIN' and consumed_at is null`, [a.id])).toHaveLength(1);
    const [mail] = await rows(`select kind, status, expires_at <= clock_timestamp() + interval '10 minutes' as within from app.email_outbox where recipient_user_id = $1`, [a.id]);
    expect(mail).toEqual({ kind: 'ADMIN_OTP', status: 'PENDING', within: true }); // worker arrêté : l'email attend, aucun accès (Review Focus 4)
  });
  it('mauvais mot de passe : même réponse que pour un étudiant, aucune vérification créée', async () => {
    const a = await createAdmin(db);
    const res = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: 'un mauvais mot de passe long' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('compte suspendu : ACCOUNT_SUSPENDED après un mot de passe correct ; compte bloqué : SECOND_FACTOR_BLOCKED, sans email', async () => {
    const s = await createAdmin(db, { status: 'SUSPENDED' });
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: s.password })).json().error.code).toBe('ACCOUNT_SUSPENDED');
    const b = await createAdmin(db);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [b.id]);
    await c.end();
    const res = await send(t.app, 'POST', '/api/auth/login', { email: b.email, password: b.password });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'SECOND_FACTOR_BLOCKED']);
    expect(await rows(`select 1 from app.email_outbox where recipient_user_id = $1`, [b.id])).toHaveLength(0);
  });
  it('un étudiant se connecte comme avant (régression lot 1a) : session de 30 jours, pas de vérification', async () => {
    const classId = await insertClass(db, 'L3 Admin Login');
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: s.password });
    expect(res.statusCode).toBe(200);
    expect(cookies(res).find((c) => c.startsWith('__Host-cp_session='))).toContain('Max-Age=2592000');
    expect(challengeCookie(res)).toBeUndefined();
  });
});

describe('POST /api/auth/verify-code', () => {
  it('ouvre la session (8 h, 30 min d’inactivité), efface le cookie de vérification aux mêmes attributs, journalise, annule l’email', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: `${code.slice(0, 3)} ${code.slice(3)}` }, header); // « 123 456 » collé
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.id, globalRole: 'ADMIN' });
    const set = cookies(res);
    expect(set.find((c) => c.startsWith('__Host-cp_session='))).toMatch(/Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$/);
    expect(set).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    const [s] = await rows(`select second_factor_method as m, extract(epoch from idle_expires_at - created_at)::int as idle, extract(epoch from absolute_expires_at - created_at)::int as abs from app.sessions where user_id = $1`, [a.id]);
    expect(s.m).toBe('EMAIL_CODE');
    expect(s.idle).toBeGreaterThanOrEqual(1799); expect(s.idle).toBeLessThanOrEqual(1801);
    expect(s.abs).toBeGreaterThanOrEqual(28799); expect(s.abs).toBeLessThanOrEqual(28801);
    expect((await rows(`select consumed_reason from app.auth_challenges where user_id = $1 and purpose = 'LOGIN'`, [a.id]))[0].consumed_reason).toBe('USED');
    expect((await rows(`select status, payload_encrypted is null as cleared from app.email_outbox where recipient_user_id = $1`, [a.id]))[0]).toEqual({ status: 'CANCELLED', cleared: true });
    expect((await rows(`select metadata from app.audit_log where actor_user_id is null and target_id = $1 and action = 'ADMIN_LOGIN'`, [a.id]))[0].metadata).toEqual({ method: 'EMAIL_CODE' });
    const me = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(sessionCookieOf(res)!));
    expect(me.statusCode).toBe(200);
    // le code est à usage unique
    const again = await send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
    expect([again.statusCode, again.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
  });
  it('code de forme invalide : 400 VALIDATION_FAILED, aucun essai consommé (Review Focus 1)', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    for (const code of ['12345', '1234567', 'abcdef', '']) {
      const res = await send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
      expect([res.statusCode, res.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await rows(`select attempts from app.auth_challenges where user_id = $1`, [a.id]))[0].attempts).toBe(0);
  });
  it('mauvais code : CODE_INVALID avec les essais restants, cookie conservé ; au 5ᵉ : CODE_LOCKED et cookie effacé', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const bad = code === '000000' ? '000001' : '000000';
    for (let i = 1; i <= 4; i++) {
      const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: bad }, header);
      expect([res.statusCode, res.json().error.code, res.json().error.attemptsLeft]).toEqual([400, 'CODE_INVALID', 5 - i]);
      expect(cookies(res).filter((c) => c.startsWith('__Host-cp_challenge='))).toHaveLength(0);
    }
    const last = await send(t.app, 'POST', '/api/auth/verify-code', { code: bad }, header);
    expect([last.statusCode, last.json().error.code]).toEqual([400, 'CODE_LOCKED']);
    expect(cookies(last)).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    const after = await send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
    expect(after.json().error.code).toBe('CHALLENGE_EXPIRED');
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it.each([
    ['sans cookie', () => ({})],
    ['cookie mal formé', () => ({ cookie: '__Host-cp_challenge=pas-un-jeton' })],
    ['cookie inconnu', () => ({ cookie: `__Host-cp_challenge=${'A'.repeat(43)}` })],
  ])('%s : 400 CHALLENGE_EXPIRED, cookie effacé, jamais 500 (Review Focus 3)', async (_n, headers) => {
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: '123456' }, headers());
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(cookies(res)).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
  });
  it('vérification expirée (donnée modifiée) : CHALLENGE_EXPIRED', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.auth_challenges set expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [a.id]);
    await o.end();
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code }, header)).json().error.code).toBe('CHALLENGE_EXPIRED');
  });
  it('le cookie d’un administrateur ne sert pas le code d’un autre', async () => {
    const a = await createAdmin(db);
    const b = await createAdmin(db);
    const { header: headerA } = await startLogin(a);
    await startLogin(b);
    const codeB = await latestCode(db, b.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: codeB }, headerA);
    expect(res.json().error.code).toBe('CODE_INVALID');
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [b.id])).toHaveLength(0);
  });
  it('limite des essais par préfixe d’IP : 30 par heure puis 429', async () => {
    const ip = '198.51.100.77';
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await send(t.app, 'POST', '/api/auth/verify-code', { code: '123456' }, {}, ip)).statusCode;
    expect(last).toBe(429);
  });
});

describe('deux validations simultanées de la même vérification (verrou observé)', () => {
  async function holdThenVerify(outcome: 'COMMIT' | 'ROLLBACK') {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [a.id]);
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where user_id = $1 and purpose = 'LOGIN'`, [a.id]);
    const pending = send(t.app, 'POST', '/api/auth/verify-code', { code }, header);
    await waitForLockWait(db, pid);
    await holder.query(outcome);
    await holder.end();
    return { res: await pending, a };
  }
  it('le titulaire a consommé la vérification : CHALLENGE_EXPIRED, aucune session', async () => {
    const { res, a } = await holdThenVerify('COMMIT');
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('le titulaire a annulé : la validation réussit', async () => {
    const { res } = await holdThenVerify('ROLLBACK');
    expect(res.statusCode).toBe(200);
  });
  it('deux requêtes parallèles avec le bon code : une session, une erreur', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const code = await latestCode(db, a.email);
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/auth/verify-code', { code }, header)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(1);
  });
});

describe('POST /api/auth/resend-code', () => {
  it('renvoi immédiat : 429 TOO_MANY_CODE_REQUESTS avec Retry-After ; l’ancien code reste valable', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const res = await send(t.app, 'POST', '/api/auth/resend-code', {}, header);
    expect([res.statusCode, res.json().error.code]).toEqual([429, 'TOO_MANY_CODE_REQUESTS']);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    const code = await latestCode(db, a.email);
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code }, header)).statusCode).toBe(200);
  });
  it('après 1 minute : nouveau code et nouveau cookie ; l’ancien cookie et l’ancien code ne servent plus, son email est annulé', async () => {
    const a = await createAdmin(db);
    const { header: oldHeader } = await startLogin(a);
    const oldCode = await latestCode(db, a.email);
    await ageChallenges(db, a.id, 2);
    const res = await send(t.app, 'POST', '/api/auth/resend-code', {}, oldHeader);
    expect(res.statusCode).toBe(202);
    expect(challengeCookie(res)).toMatch(CHALLENGE_RE);
    const newCode = await latestCode(db, a.email);
    expect(newCode).not.toBe(oldCode);
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code: oldCode }, oldHeader)).json().error.code).toBe('CHALLENGE_EXPIRED');
    expect((await rows(`select count(*)::int as n from app.email_outbox where recipient_user_id = $1 and status = 'CANCELLED'`, [a.id]))[0].n).toBe(1);
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code: newCode }, challengeHeader(res))).statusCode).toBe(200);
  });
  it('double clic : deux renvois simultanés, un seul aboutit, une seule vérification active (Review Focus 2)', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    await ageChallenges(db, a.id, 2);
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/auth/resend-code', {}, header)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([202, 429]);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'LOGIN' and consumed_at is null`, [a.id])).toHaveLength(1);
    expect(await rows(`select 1 from app.email_outbox where recipient_user_id = $1 and status = 'PENDING'`, [a.id])).toHaveLength(1);
  });
  it('sans cookie : 400 CHALLENGE_EXPIRED', async () => {
    const res = await send(t.app, 'POST', '/api/auth/resend-code', {});
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
  });
});

describe('session d’administrateur', () => {
  it('30 minutes d’inactivité : une session dont l’échéance est dépassée donne 401 et efface le cookie', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const login = await send(t.app, 'POST', '/api/auth/verify-code', { code: await latestCode(db, a.email) }, header);
    const token = sessionCookieOf(login)!;
    const c = await connectAs('cp_app', db);
    await c.query(`update app.sessions set idle_expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [a.id]);
    await c.end();
    const me = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(token));
    expect(me.statusCode).toBe(401);
    expect(cookies(me)).toContain('__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  });
  it('l’activité prolonge l’inactivité d’une session d’administrateur de 30 minutes, plafonnée à 8 h', async () => {
    const a = await createAdmin(db);
    const { header } = await startLogin(a);
    const login = await send(t.app, 'POST', '/api/auth/verify-code', { code: await latestCode(db, a.email) }, header);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.sessions set last_seen_at = clock_timestamp() - interval '10 minutes' where user_id = $1`, [a.id]);
    await send(t.app, 'GET', '/api/me', undefined, cookieHeader(sessionCookieOf(login)!));
    const r = await c.query(`select extract(epoch from idle_expires_at - clock_timestamp())::int as left from app.sessions where user_id = $1`, [a.id]);
    await c.end();
    expect(r.rows[0].left).toBeGreaterThan(1790); expect(r.rows[0].left).toBeLessThanOrEqual(1800);
  });
});
```

Dans `auth-login.int.spec.ts`, remplacer le cas qui attend `403 ADMIN_SECOND_FACTOR_REQUIRED` par : un administrateur au mot de passe correct reçoit `202`, aucun cookie de session. (`grep -rn ADMIN_SECOND_FACTOR_REQUIRED apps` doit ensuite ne rien renvoyer.) Dans `routes-meta.int.spec.ts`, ajouter à `EXPECTED_ROUTES` : `'POST /api/auth/verify-code': { public: true }`, `'POST /api/auth/resend-code': { public: true }` et à `VALID_BODY` : `'POST /api/auth/verify-code': () => ({ code: '123456' })`, `'POST /api/auth/resend-code': () => ({})`.

Run : `pnpm vitest run --project integration apps/api/test/integration/auth-admin-login.int.spec.ts` — Expected : FAIL (`ADMIN_SECOND_FACTOR_REQUIRED` au lieu de 202).

- [ ] **Step 2 : Implémenter**

`session-cookie.ts` : ajouter `export const ADMIN_IDLE_SECONDS = 30 * 60; export const ADMIN_ABSOLUTE_SECONDS = 8 * 3600;` (R10).

`sessions.repository.ts` — `NewSessionRow` gagne `secondFactorMethod: 'EMAIL_CODE' | 'RECOVERY_CODE' | null` et `createInTx` devient :

```ts
  async createInTx(tx: TxClient, s: NewSessionRow): Promise<void> {
    await tx.$executeRaw`
      insert into app.sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at, ip, user_agent, second_factor_at, second_factor_method)
      select ${s.id}::uuid, ${s.tokenHash}, ${s.userId}::uuid,
             n.t + make_interval(secs => ${s.idleSeconds}::double precision),
             n.t + make_interval(secs => ${s.absoluteSeconds}::double precision),
             ${s.ip}::inet, ${s.userAgent},
             case when ${s.secondFactorMethod}::text is null then null else n.t end, ${s.secondFactorMethod}::text
        from (select clock_timestamp() as t) n`;
  }
```

`sessions.service.ts` : `openInTx` passe `secondFactorMethod: null` ; ajouter

```ts
  /** Session d'administrateur (§ 3.3, R10) : créée seulement après le code (ou le code de récupération). */
  async openAdminInTx(tx: TxClient, actor: AnonymousActor, user: { id: string }, method: 'EMAIL_CODE' | 'RECOVERY_CODE', ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.verifyCode');
    const { token, hash } = newSessionToken();
    const id = uuidv7();
    await this.repo.createInTx(tx, { id, tokenHash: hash, userId: user.id, idleSeconds: ADMIN_IDLE_SECONDS, absoluteSeconds: ADMIN_ABSOLUTE_SECONDS, ip: ctx.ip, userAgent: ctx.userAgent, secondFactorMethod: method });
    return { token, maxAgeSeconds: ADMIN_ABSOLUTE_SECONDS, actor: { kind: 'user', userId: user.id, globalRole: 'ADMIN', sessionId: id } };
  }
```

et dans `authenticate`, remplacer `await this.repo.touch(s.sessionId, STUDENT_SESSION_SECONDS)` par `await this.repo.touch(s.sessionId, role === 'ADMIN' ? ADMIN_IDLE_SECONDS : STUDENT_SESSION_SECONDS)`. (Précision : `last_seen_at` n'est mis à jour qu'au plus toutes les 5 min, § 3.4 ; l'inactivité effective d'un administrateur est donc de 25 à 30 min.)

`auth.service.ts` — injecter `SecondFactorService`, `OtpLimiter` ; `login` renvoie le type union :

```ts
export type AdminCodeSent = { cookieToken: string; expiresInSeconds: 600; resendAfterSeconds: 60 };
export type LoginResult = { kind: 'session'; opened: OpenedSession } | { kind: 'second-factor'; sent: AdminCodeSent };

    // … après `if (user.status === 'SUSPENDED') throw …` :
    if (user.globalRole === 'ADMIN') return { kind: 'second-factor', sent: await this.startAdminCode(actor, user.id, ctx) };
    return { kind: 'session', opened: await this.prisma.withTx((tx) => this.sessions.openInTx(tx, actor, { id: user.id, globalRole: 'USER' }, ctx)) };
```

```ts
  /** Mot de passe correct, administrateur : une vérification LOGIN et son email (§ 3.3). Aucun accès tant que le code n'est pas saisi. */
  private async startAdminCode(actor: AnonymousActor, userId: string, ctx: ClientContext): Promise<AdminCodeSent> {
    await this.otpLimiter.hitRequest(ctx.ip);
    const challenge = newChallengeToken();
    const issued = await this.prisma.withTx((tx) => this.secondFactor.issueInTx(tx, actor, { userId, purpose: 'LOGIN', sessionId: null, pendingEmail: null, tokenHash: challenge.hash, ip: ctx.ip }));
    return { cookieToken: challenge.token, expiresInSeconds: issued.expiresInSeconds, resendAfterSeconds: issued.resendAfterSeconds };
  }

  /** Cookie de vérification absent, mal formé, inconnu, expiré ou consommé : toujours la même erreur, cookie effacé. */
  private async loginChallengeOf(actor: AnonymousActor, cookieToken: string | undefined) {
    const hash = cookieToken ? hashChallengeToken(cookieToken) : null;
    const found = hash ? await this.secondFactor.findLoginChallenge(actor, hash) : null;
    if (!found) throw outcomeToError({ ok: false, reason: 'EXPIRED' }, { clearChallengeCookie: true });
    return found;
  }

  async verifyCode(actor: AnonymousActor, body: VerifyCodeBody, cookieToken: string | undefined, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.verifyCode');
    await this.otpLimiter.hitTry(ctx.ip);
    const ref = await this.loginChallengeOf(actor, cookieToken);
    const outcome = await this.prisma.withTx(async (tx) => {
      const r = await this.secondFactor.checkInTx(tx, actor, { userId: ref.userId, purpose: 'LOGIN', code: body.code, challengeId: ref.challengeId });
      if (!r.ok) return r; // valider la transaction : essai, échec, blocage et alertes sont enregistrés
      await this.secondFactor.consumeInTx(tx, actor, r.challenge, 'USED');
      const opened = await this.sessions.openAdminInTx(tx, actor, { id: ref.userId }, 'EMAIL_CODE', ctx);
      await this.audit.recordInTx(tx, actor, { action: 'ADMIN_LOGIN', targetType: 'USER', targetId: ref.userId, metadata: { method: 'EMAIL_CODE' } });
      return { ok: true as const, opened };
    });
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: outcome.reason !== 'WRONG' });
    return outcome.opened;
  }

  async resendCode(actor: AnonymousActor, cookieToken: string | undefined, ctx: ClientContext): Promise<AdminCodeSent> {
    this.authz.assert(actor, 'auth.resendCode');
    await this.otpLimiter.hitRequest(ctx.ip);
    const ref = await this.loginChallengeOf(actor, cookieToken);
    const challenge = newChallengeToken();
    const issued = await this.prisma.withTx((tx) => this.secondFactor.issueInTx(tx, actor, { userId: ref.userId, purpose: 'LOGIN', sessionId: null, pendingEmail: null, tokenHash: challenge.hash, ip: ctx.ip }));
    return { cookieToken: challenge.token, expiresInSeconds: issued.expiresInSeconds, resendAfterSeconds: issued.resendAfterSeconds };
  }
```

`auth.controller.ts` : `login` adapté et deux routes :

```ts
  @Public()
  @Post('login')
  async login(@Body(new ZodPipe(LoginBody)) body: LoginBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<MeDto | AdminCodeRequiredDto> {
    const r = await this.auth.login({ kind: 'anonymous', ip: req.ip }, body, clientContextOf(req));
    if (r.kind === 'second-factor') {
      reply.code(202).header('set-cookie', challengeSetCookie(r.sent.cookieToken));
      return { status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: r.sent.expiresInSeconds, resendAfterSeconds: r.sent.resendAfterSeconds };
    }
    reply.code(200).header('set-cookie', sessionSetCookie(r.opened.token, r.opened.maxAgeSeconds));
    return this.me.me(r.opened.actor);
  }

  @Public()
  @Post('verify-code')
  @HttpCode(200)
  async verifyCode(@Body(new ZodPipe(VerifyCodeBody)) body: VerifyCodeBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<MeDto> {
    const opened = await this.auth.verifyCode({ kind: 'anonymous', ip: req.ip }, body, req.cookies?.[CHALLENGE_COOKIE], clientContextOf(req));
    reply.header('set-cookie', [sessionSetCookie(opened.token, opened.maxAgeSeconds), challengeClearCookie()]);
    return this.me.me(opened.actor);
  }

  @Public()
  @Post('resend-code')
  @HttpCode(202)
  async resendCode(@Body(new ZodPipe(EmptyBody)) _body: unknown, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<AdminCodeRequiredDto> {
    const sent = await this.auth.resendCode({ kind: 'anonymous', ip: req.ip }, req.cookies?.[CHALLENGE_COOKIE], clientContextOf(req));
    reply.header('set-cookie', challengeSetCookie(sent.cookieToken));
    return { status: 'ADMIN_CODE_REQUIRED', expiresInSeconds: sent.expiresInSeconds, resendAfterSeconds: sent.resendAfterSeconds };
  }
```

avec `type AdminCodeRequiredDto = { status: 'ADMIN_CODE_REQUIRED'; expiresInSeconds: 600; resendAfterSeconds: 60 }` dans `me.dto.ts` ou un `auth.dto.ts`. Retirer `@HttpCode(200)` de `login` (le statut vient de `reply.code`). Si Nest réécrit le statut malgré `reply.code(202)` (test rouge sur 202), basculer `login` sur `@Res()` sans `passthrough` et `reply.code(202).send(body)`.

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/auth-admin-login.int.spec.ts apps/api/test/integration/auth-login.int.spec.ts apps/api/test/integration/routes-meta.int.spec.ts apps/api/test/integration/sessions.int.spec.ts apps/api/test/integration/security-auth.int.spec.ts` ; `pnpm typecheck` ; `pnpm lint` ; `pnpm depcruise` — Expected : PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/api
git commit -m "feat(auth): connexion d'un administrateur par code envoyé par email, renvoi, session de 8 h

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11 : Récupération d'un administrateur — fonction privilégiée, commande `ops`, `verify-recovery`

**Files :**
- Create : `apps/api/prisma/migrations/20261014000400_admin_recovery/migration.sql`, `apps/api/src/ops/admin-recovery-code.ts`, `apps/api/src/ops.ts`
- Modify : `apps/api/src/modules/auth/auth.service.ts`, `apps/api/src/modules/auth/auth.controller.ts`, `apps/api/test/support/app.ts` (`runOps`), `apps/api/test/integration/routes-meta.int.spec.ts`, `apps/api/test/integration/role-privileges.int.spec.ts` (droits de `cp_privileged` et `cp_ops`), `README.md`
- Test : `apps/api/test/integration/admin-recovery.int.spec.ts`

**Interfaces :**
- Consumes : `otpHmac`, `normalizeRecoveryCode`, `RECOVERY_ALPHABET` (tâches 1 et 9), `loadOpsConfig` (tâche 2), `SecondFactorService.checkInTx` (RECOVERY, tâche 9).
- Produces :
  - SQL : `priv.issue_admin_recovery_code(p_email text, p_challenge_id uuid, p_code_hmac bytea, p_clear_block boolean) RETURNS timestamptz`
  - `runAdminRecoveryCode(deps: { client: Pick<pg.Client, 'query'>; pepper: string; io: RecoveryIo }, args: { email: string; clearBlock: boolean }): Promise<number>` (code de sortie) ; `type RecoveryIo = { isTty: boolean; write(s: string): void; waitForEnter(): Promise<void> }` ; `newRecoveryCode(): string`
  - `POST /api/auth/verify-recovery` `{ recoveryCode }` (public) → `200` `MeDto` + cookie de session + effacement du cookie de vérification
  - `AuthService.verifyRecovery(actor: AnonymousActor, body: VerifyRecoveryBody, cookieToken: string | undefined, ctx): Promise<OpenedSession>`

- [ ] **Step 1 : Écrire les tests (échouent)**

Ajouter à `test/support/app.ts` :

```ts
/** Lance la commande ops (processus séparé, sans terminal : le garde-fou doit la refuser). */
export async function runOps(db: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cfg = testConfig(db);
  const dir = mkdtempSync(join(tmpdir(), 'cp-ops-'));
  const file = (name: string, value: string) => { const p = join(dir, name); writeFileSync(p, `${value}\n`); return p; };
  const auth = cfg.db.auth as { password: string };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: 'test', DB_HOST: cfg.db.host, DB_PORT: String(cfg.db.port), DB_NAME: cfg.db.database, DB_USER: 'cp_ops', DB_AUTH_MODE: 'password',
    DB_PASSWORD_FILE: file('db', auth.password), OTP_PEPPER_FILE: file('pepper', TEST_OTP_PEPPER),
  };
  try {
    return await new Promise((done, fail) => {
      const p = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/ops.ts', ...args], { cwd: resolve(import.meta.dirname, '../..'), env });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (d) => { stdout += String(d); });
      p.stderr.on('data', (d) => { stderr += String(d); });
      p.on('error', fail);
      p.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
      p.stdin.end('');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
```

`apps/api/test/integration/admin-recovery.int.spec.ts` :

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdminRecoveryCode, type RecoveryIo } from '../../src/ops/admin-recovery-code.js';
import { otpHmac } from '../../src/modules/auth/second-factor/otp.js';
import { TEST_OTP_PEPPER, buildTestApp, cookieHeader, runOps, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { createAdmin } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let ops: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); t = await buildTestApp(db); ops = await connectAs('cp_ops', db); });
afterAll(async () => { await ops.end(); await t.close(); });

const CODE_RE = /: ([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})\n/;
function fakeIo(over: Partial<RecoveryIo> = {}) {
  const written: string[] = [];
  const io: RecoveryIo = { isTty: true, write: (s) => { written.push(s); }, waitForEnter: async () => undefined, ...over };
  return { io, written, text: () => written.join('') };
}
async function issue(email: string, clearBlock = false) {
  const f = fakeIo();
  const exit = await runAdminRecoveryCode({ client: ops, pepper: TEST_OTP_PEPPER, io: f.io }, { email, clearBlock });
  return { exit, code: CODE_RE.exec(f.text())?.[1], text: f.text() };
}
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const cookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie']].flat().filter((c): c is string => typeof c === 'string');
async function loginCookie(a: { email: string; password: string }) {
  const res = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
  return { cookie: `__Host-cp_challenge=${/__Host-cp_challenge=([^;]+)/.exec(cookies(res).find((c) => c.startsWith('__Host-cp_challenge='))!)![1]}` };
}

describe('priv.issue_admin_recovery_code via runAdminRecoveryCode', () => {
  it('émet un code de 12 caractères : seul le HMAC est en base, audit PRIVILEGED sous cp_ops, alertes à tous les administrateurs', async () => {
    const a = await createAdmin(db);
    const other = await createAdmin(db);
    const { exit, code, text } = await issue(a.email);
    expect(exit).toBe(0);
    expect(code).toBeTruthy();
    expect(text).toContain('15 minutes');
    const [ch] = await rows(`select id, code_hmac, token_hash, session_id, expires_at > clock_timestamp() + interval '14 minutes' as fifteen from app.auth_challenges where user_id = $1 and purpose = 'RECOVERY' and consumed_at is null`, [a.id]);
    expect(ch.code_hmac.equals(otpHmac(TEST_OTP_PEPPER, ch.id, code!.replaceAll('-', '')))).toBe(true);
    expect([ch.token_hash, ch.session_id, ch.fifteen]).toEqual([null, null, true]);
    const [audit] = await rows(`select source, db_login_role, action, actor_user_id from app.audit_log where target_id = $1 and action = 'ADMIN_RECOVERY_CODE_ISSUED'`, [a.id]);
    expect(audit).toEqual({ source: 'PRIVILEGED', db_login_role: 'cp_ops', action: 'ADMIN_RECOVERY_CODE_ISSUED', actor_user_id: null });
    const alerts = await rows(`select recipient_user_id, payload from app.email_outbox where kind = 'ADMIN_SECURITY_ALERT' and payload->>'event' = 'RECOVERY_CODE_ISSUED' and payload->>'accountEmail' = $1`, [a.email]);
    expect(alerts.map((r) => r.recipient_user_id)).toEqual(expect.arrayContaining([a.id, other.id]));
    // le code n'apparaît dans aucune colonne
    const bare = code!.replaceAll('-', '');
    const dump = JSON.stringify(await rows(`select payload, to_address from app.email_outbox`)) + JSON.stringify(await rows(`select metadata from app.audit_log`));
    expect(dump).not.toContain(bare);
  });
  it('un nouveau code remplace le précédent (SUPERSEDED)', async () => {
    const a = await createAdmin(db);
    await issue(a.email);
    await issue(a.email);
    const r = await rows(`select consumed_reason from app.auth_challenges where user_id = $1 and purpose = 'RECOVERY' order by created_at`, [a.id]);
    expect(r.map((x) => x.consumed_reason)).toEqual(['SUPERSEDED', null]);
  });
  it.each(['inconnu@example.com'])('cible inconnue : TARGET_NOT_ACTIVE_ADMIN, aucun code affiché', async (email) => {
    const { exit, code, text } = await issue(email);
    expect([exit, code]).toEqual([1, undefined]);
    expect(text).toContain('TARGET_NOT_ACTIVE_ADMIN');
  });
  it('un compte suspendu n’est pas une cible valable', async () => {
    const s = await createAdmin(db, { status: 'SUSPENDED' });
    const { exit, text } = await issue(s.email);
    expect(exit).toBe(1);
    expect(text).toContain('TARGET_NOT_ACTIVE_ADMIN');
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [s.id])).toHaveLength(0);
  });
  it('--clear-block lève le blocage (audit PRIVILEGED) ; sans l’option il reste', async () => {
    const a = await createAdmin(db);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [a.id]);
    await c.end();
    await issue(a.email);
    expect((await rows(`select second_factor_blocked_at is not null as b from app.users where id = $1`, [a.id]))[0].b).toBe(true);
    await issue(a.email, true);
    expect((await rows(`select second_factor_blocked_at is not null as b from app.users where id = $1`, [a.id]))[0].b).toBe(false);
    expect((await rows(`select source, db_login_role from app.audit_log where target_id = $1 and action = 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED'`, [a.id]))[0]).toEqual({ source: 'PRIVILEGED', db_login_role: 'cp_ops' });
  });
  it('garde-fou : sans terminal, aucune requête n’est envoyée et aucun code n’est affiché', async () => {
    let queries = 0;
    const f = fakeIo({ isTty: false });
    const exit = await runAdminRecoveryCode({ client: { query: (async () => { queries++; return { rows: [] }; }) as never }, pepper: TEST_OTP_PEPPER, io: f.io }, { email: 'a@example.com', clearBlock: false });
    expect([exit, queries]).toEqual([2, 0]);
    expect(f.text()).toContain('TTY_REQUIRED');
  });
  it('le code n’est affiché qu’après la validation : si la base échoue, rien n’est affiché ni détaillé', async () => {
    const f = fakeIo();
    const exit = await runAdminRecoveryCode({ client: { query: (async () => { throw Object.assign(new Error('secret détail interne'), { code: 'XX000' }); }) as never }, pepper: TEST_OTP_PEPPER, io: f.io }, { email: 'a@example.com', clearBlock: false });
    expect(exit).toBe(1);
    expect(f.text()).toContain('UNEXPECTED');
    expect(f.text()).not.toContain('secret détail interne');
    expect(f.text()).not.toMatch(CODE_RE);
  });
  it('affiche le code, attend Entrée, puis efface l’écran', async () => {
    const a = await createAdmin(db);
    const seen: string[] = [];
    const f = fakeIo({ waitForEnter: async () => { seen.push('enter'); } });
    await runAdminRecoveryCode({ client: ops, pepper: TEST_OTP_PEPPER, io: f.io }, { email: a.email, clearBlock: false });
    expect(f.written.at(-1)).toBe('\x1b[2J\x1b[3J\x1b[H');
    expect(seen).toEqual(['enter']);
  });
  it('le texte SQL est une constante (aucune concaténation) et le fichier n’utilise ni Prisma ni Nest', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../src/ops/admin-recovery-code.ts'), 'utf8');
    expect(src).toMatch(/client\.query\(\s*'select priv\.issue_admin_recovery_code\(\$1, \$2, \$3, \$4\)/);
    expect(src).not.toMatch(/prisma|@nestjs|console\.log|logger/i);
  });
  it('cp_app ne peut ni appeler la fonction ni créer une vérification RECOVERY', async () => {
    const a = await createAdmin(db);
    const c = await connectAs('cp_app', db);
    await expect(c.query(`select priv.issue_admin_recovery_code($1, gen_random_uuid(), decode(repeat('00', 32), 'hex'), false)`, [a.email])).rejects.toMatchObject({ code: '42501' });
    await c.end();
  });
  it('processus séparé sans terminal : refusé (code 2, TTY_REQUIRED), aucune vérification créée', async () => {
    const a = await createAdmin(db);
    const r = await runOps(db, ['admin-recovery-code', '--email', a.email]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toContain('TTY_REQUIRED');
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1`, [a.id])).toHaveLength(0);
  }, 60_000);
});

describe('POST /api/auth/verify-recovery', () => {
  it('avec le cookie LOGIN et le code de récupération : session ouverte, les deux vérifications consommées, audit', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const { code } = await issue(a.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code!.toLowerCase() }, header); // casse et tirets ignorés
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.id, globalRole: 'ADMIN' });
    expect(cookies(res)).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(sessionCookieOf(res)!))).statusCode).toBe(200);
    expect((await rows(`select second_factor_method as m from app.sessions where user_id = $1`, [a.id]))[0].m).toBe('RECOVERY_CODE');
    expect((await rows(`select purpose::text as p, consumed_reason::text as r from app.auth_challenges where user_id = $1 order by purpose`, [a.id])).map((r) => `${r.p}:${r.r}`)).toEqual(['LOGIN:USED', 'RECOVERY:USED']);
    expect((await rows(`select metadata from app.audit_log where target_id = $1 and action = 'ADMIN_LOGIN'`, [a.id]))[0].metadata).toEqual({ method: 'RECOVERY_CODE' });
  });
  it('sans cookie LOGIN, le code de récupération ne sert à rien (seulement après le mot de passe)', async () => {
    const a = await createAdmin(db);
    const { code } = await issue(a.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code! });
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('le cookie LOGIN d’un autre administrateur ne sert pas', async () => {
    const a = await createAdmin(db);
    const b = await createAdmin(db);
    const headerB = await loginCookie(b);
    const { code } = await issue(a.email);
    const res = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code! }, headerB);
    expect(res.json().error.code).toBe('CHALLENGE_EXPIRED'); // b n'a aucune vérification RECOVERY active
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('mauvais code : CODE_INVALID, essais comptés sur la vérification RECOVERY, échecs enregistrés', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const { code } = await issue(a.email);
    const wrong = code!.startsWith('A') ? 'BBBB-BBBB-BBBB' : 'AAAA-AAAA-AAAA';
    const res = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: wrong }, header);
    expect([res.statusCode, res.json().error.code, res.json().error.attemptsLeft]).toEqual([400, 'CODE_INVALID', 4]);
    expect((await rows(`select attempts from app.auth_challenges where user_id = $1 and purpose = 'RECOVERY'`, [a.id]))[0].attempts).toBe(1);
    expect(await rows(`select 1 from app.second_factor_failures where user_id = $1 and purpose = 'RECOVERY'`, [a.id])).toHaveLength(1);
  });
  it('compte bloqué : le code de récupération est refusé sans comparaison ; après --clear-block il fonctionne', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const c = await connectAs('cp_app', db);
    await c.query(`update app.users set second_factor_blocked_at = clock_timestamp() where id = $1`, [a.id]);
    await c.end();
    const first = await issue(a.email);
    const refused = await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: first.code! }, header);
    expect([refused.statusCode, refused.json().error.code]).toEqual([403, 'SECOND_FACTOR_BLOCKED']);
    expect((await rows(`select attempts from app.auth_challenges where user_id = $1 and purpose = 'RECOVERY' and consumed_at is null`, [a.id]))[0].attempts).toBe(0);
    const second = await issue(a.email, true);
    expect((await send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: second.code! }, header)).statusCode).toBe(200);
  });
  it('deux requêtes simultanées avec le bon code : une session, une erreur (ordre de verrous LOGIN puis RECOVERY)', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const { code } = await issue(a.email);
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code! }, header)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(1);
  });
  it('un titulaire qui a consommé la vérification LOGIN : la récupération reçoit CHALLENGE_EXPIRED (verrou observé)', async () => {
    const a = await createAdmin(db);
    const header = await loginCookie(a);
    const { code } = await issue(a.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [a.id]);
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where user_id = $1 and purpose = 'LOGIN'`, [a.id]);
    const pending = send(t.app, 'POST', '/api/auth/verify-recovery', { recoveryCode: code! }, header);
    await waitForLockWait(db, pid);
    await holder.query('commit');
    await holder.end();
    expect((await pending).json().error.code).toBe('CHALLENGE_EXPIRED');
  });
});
```

Dans `routes-meta.int.spec.ts`, ajouter `'POST /api/auth/verify-recovery': { public: true }` et `VALID_BODY` : `() => ({ recoveryCode: 'ABCD-EFGH-JKMN' })`.

Run : `pnpm vitest run --project integration apps/api/test/integration/admin-recovery.int.spec.ts` — Expected : FAIL (`function priv.issue_admin_recovery_code does not exist`, module `ops/admin-recovery-code` absent).

- [ ] **Step 2 : Migration**

`apps/api/prisma/migrations/20261014000400_admin_recovery/migration.sql` :

```sql
-- classification: expand
BEGIN;

-- cp_privileged agit dans la fonction (SECURITY DEFINER) : droits minimaux, colonne par colonne.
GRANT USAGE ON SCHEMA app TO cp_privileged;
GRANT SELECT ON app.users TO cp_privileged;
GRANT UPDATE (second_factor_blocked_at) ON app.users TO cp_privileged;
GRANT SELECT, UPDATE (consumed_at, consumed_reason) ON app.auth_challenges TO cp_privileged;
GRANT INSERT (id, user_id, purpose, code_hmac, expires_at) ON app.auth_challenges TO cp_privileged;
GRANT SELECT ON app.email_outbox TO cp_privileged;
GRANT INSERT (id, recipient_user_id, to_address, kind, dedupe_key, payload, message_id, expires_at) ON app.email_outbox TO cp_privileged;
-- Le déclencheur d'annulation (consommation de la vérification remplacée) lit et met à jour la file.
GRANT UPDATE (status, claim_token, locked_until, payload_encrypted) ON app.email_outbox TO cp_privileged;
GRANT SELECT ON app.email_attempts TO cp_privileged;
GRANT UPDATE (outcome, finished_at) ON app.email_attempts TO cp_privileged;
GRANT SELECT ON app.audit_log TO cp_privileged;
GRANT INSERT (actor_user_id, action, target_type, target_id, metadata) ON app.audit_log TO cp_privileged;

SET LOCAL ROLE cp_privileged;

CREATE FUNCTION priv.issue_admin_recovery_code(p_email text, p_challenge_id uuid, p_code_hmac bytea, p_clear_block boolean)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_user app.users%ROWTYPE;
  v_expires timestamptz;
  v_admin record;
BEGIN
  -- Comparaison en texte : les opérateurs citext ne sont pas dans le chemin de recherche restreint.
  SELECT * INTO v_user FROM app.users
   WHERE email::text = p_email AND status = 'ACTIVE' AND global_role = 'ADMIN' FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TARGET_NOT_ACTIVE_ADMIN' USING ERRCODE = 'P0002';
  END IF;

  IF p_clear_block AND v_user.second_factor_blocked_at IS NOT NULL THEN
    UPDATE app.users SET second_factor_blocked_at = NULL WHERE id = v_user.id;
    INSERT INTO app.audit_log (actor_user_id, action, target_type, target_id, metadata)
    VALUES (NULL, 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'USER', v_user.id, '{}'::jsonb);
  END IF;

  UPDATE app.auth_challenges SET consumed_at = clock_timestamp(), consumed_reason = 'SUPERSEDED'
   WHERE user_id = v_user.id AND purpose = 'RECOVERY' AND consumed_at IS NULL;
  v_expires := clock_timestamp() + interval '15 minutes';
  INSERT INTO app.auth_challenges (id, user_id, purpose, code_hmac, expires_at)
  VALUES (p_challenge_id, v_user.id, 'RECOVERY', p_code_hmac, v_expires);

  INSERT INTO app.audit_log (actor_user_id, action, target_type, target_id, metadata)
  VALUES (NULL, 'ADMIN_RECOVERY_CODE_ISSUED', 'USER', v_user.id, '{}'::jsonb);

  FOR v_admin IN SELECT id, email::text AS email FROM app.users WHERE status = 'ACTIVE' AND global_role = 'ADMIN' ORDER BY id LOOP
    INSERT INTO app.email_outbox (id, recipient_user_id, to_address, kind, dedupe_key, payload, message_id, expires_at)
    VALUES (uuidv7(), v_admin.id, v_admin.email, 'ADMIN_SECURITY_ALERT',
            'admin-recovery-alert:' || p_challenge_id::text || ':' || v_admin.id::text,
            jsonb_build_object('event', 'RECOVERY_CODE_ISSUED', 'accountEmail', v_user.email::text),
            gen_random_uuid()::text, clock_timestamp() + interval '24 hours')
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;
  RETURN v_expires;
END $$;

REVOKE ALL ON FUNCTION priv.issue_admin_recovery_code(text, uuid, bytea, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION priv.issue_admin_recovery_code(text, uuid, bytea, boolean) TO cp_ops;

RESET ROLE;

COMMIT;
```

(L'audit des actions `PRIVILEGED` est écrit avec `db_login_role = session_user = cp_ops` par `audit_log_guard`.)

- [ ] **Step 3 : Implémenter la commande `ops`**

`apps/api/src/ops/admin-recovery-code.ts` :

```ts
import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { RECOVERY_ALPHABET, RECOVERY_CODE_LENGTH, isAcceptedEmail, normalizeEmail } from '@classepulse/shared';
import { otpHmac } from '../modules/auth/second-factor/otp.js';

export type RecoveryIo = { isTty: boolean; write(s: string): void; waitForEnter(): Promise<void> };

/** 12 caractères de l'alphabet sans ambiguïté (R15) ; `crypto.randomInt` est uniforme. */
export function newRecoveryCode(): string {
  let c = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) c += RECOVERY_ALPHABET[randomInt(0, RECOVERY_ALPHABET.length)]!;
  return c;
}
const grouped = (c: string): string => `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;

/** Seule la catégorie de l'erreur est affichée : jamais de message, de trace ni de valeur (§ 3.3). */
function category(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'P0002' ? 'TARGET_NOT_ACTIVE_ADMIN' : 'UNEXPECTED';
}

/**
 * `ops admin-recovery-code` (§ 3.3). Le code est généré ici ; PostgreSQL ne reçoit que son HMAC, en paramètres liés
 * (texte SQL constant). Affiché seulement après la validation, puis l'écran est effacé. Ni Prisma ni Nest ni journal.
 */
export async function runAdminRecoveryCode(
  deps: { client: Pick<pg.Client, 'query'>; pepper: string; io: RecoveryIo },
  args: { email: string; clearBlock: boolean },
): Promise<number> {
  const { client, pepper, io } = deps;
  // Garde-fou, pas une garantie (§ 3.3).
  if (!io.isTty) { io.write('erreur : TTY_REQUIRED (lance la commande depuis un terminal)\n'); return 2; }
  const email = normalizeEmail(args.email);
  if (!isAcceptedEmail(email)) { io.write('erreur : INVALID_ARGUMENTS\n'); return 2; }
  const code = newRecoveryCode();
  const challengeId = uuidv7();
  try {
    // Appel autocommit : la fonction est validée quand la promesse est résolue.
    await client.query('select priv.issue_admin_recovery_code($1, $2, $3, $4) as expires_at', [email, challengeId, otpHmac(pepper, challengeId, code), args.clearBlock]);
  } catch (e) {
    io.write(`erreur : ${category(e)}\n`);
    return 1;
  }
  io.write(`Code de récupération (valable 15 minutes, à transmettre par un canal sûr) : ${grouped(code)}\n`);
  io.write('Appuie sur Entrée pour effacer l’écran.\n');
  await io.waitForEnter();
  io.write('\x1b[2J\x1b[3J\x1b[H');
  return 0;
}
```

`apps/api/src/ops.ts` :

```ts
import { parseArgs } from 'node:util';
import readline from 'node:readline';
import pg from 'pg';
import { toPgPoolConfig } from './config/database-connection.js';
import { loadOpsConfig } from './config/load-config.js';
import { runAdminRecoveryCode, type RecoveryIo } from './ops/admin-recovery-code.js';

const USAGE = 'usage : ops admin-recovery-code --email <email> [--clear-block]\n';

const terminalIo = (): RecoveryIo => ({
  isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  write: (s) => { process.stdout.write(s); },
  waitForEnter: () => new Promise<void>((done) => { const rl = readline.createInterface({ input: process.stdin }); rl.question('', () => { rl.close(); done(); }); }),
});

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'admin-recovery-code') { process.stderr.write(USAGE); return 2; }
  const io = terminalIo();
  if (!io.isTty) { process.stderr.write('erreur : TTY_REQUIRED (lance la commande depuis un terminal)\n'); return 2; }
  let parsed: { email?: string; 'clear-block'?: boolean };
  try {
    parsed = parseArgs({ args: rest, strict: true, options: { email: { type: 'string' }, 'clear-block': { type: 'boolean' } } }).values;
  } catch { process.stderr.write(USAGE); return 2; }
  if (!parsed.email) { process.stderr.write(USAGE); return 2; }
  let config: ReturnType<typeof loadOpsConfig>;
  try { config = loadOpsConfig(process.env); } catch (e) {
    process.stderr.write(`erreur : INVALID_CONFIGURATION\n${e instanceof Error ? e.message : ''}\n`);
    return 1;
  }
  const client = new pg.Client(toPgPoolConfig(config.db));
  try {
    await client.connect();
    return await runAdminRecoveryCode({ client, pepper: config.otpPepper, io }, { email: parsed.email, clearBlock: parsed['clear-block'] === true });
  } catch { process.stderr.write('erreur : UNEXPECTED\n'); return 1; } finally { await client.end().catch(() => undefined); }
}

main(process.argv.slice(2)).then((code) => { process.exit(code); });
```

`AuthService.verifyRecovery` (dans `auth.service.ts`) :

```ts
  /** Seulement avec un cookie LOGIN valide, donc après le mot de passe. LOGIN puis RECOVERY, consommés atomiquement (§ 3.3). */
  async verifyRecovery(actor: AnonymousActor, body: VerifyRecoveryBody, cookieToken: string | undefined, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.verifyRecovery');
    await this.otpLimiter.hitTry(ctx.ip);
    const ref = await this.loginChallengeOf(actor, cookieToken);
    const outcome = await this.prisma.withTx(async (tx) => {
      const r = await this.secondFactor.checkInTx(tx, actor, { userId: ref.userId, purpose: 'RECOVERY', code: body.recoveryCode, challengeId: ref.challengeId });
      if (!r.ok) return r;
      await this.secondFactor.consumeInTx(tx, actor, r.companion!, 'USED'); // LOGIN d'abord
      await this.secondFactor.consumeInTx(tx, actor, r.challenge, 'USED');
      const opened = await this.sessions.openAdminInTx(tx, actor, { id: ref.userId }, 'RECOVERY_CODE', ctx);
      await this.audit.recordInTx(tx, actor, { action: 'ADMIN_LOGIN', targetType: 'USER', targetId: ref.userId, metadata: { method: 'RECOVERY_CODE' } });
      return { ok: true as const, opened };
    });
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: outcome.reason !== 'WRONG' });
    return outcome.opened;
  }
```

et la route (contrôleur) :

```ts
  @Public()
  @Post('verify-recovery')
  @HttpCode(200)
  async verifyRecovery(@Body(new ZodPipe(VerifyRecoveryBody)) body: VerifyRecoveryBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<MeDto> {
    const opened = await this.auth.verifyRecovery({ kind: 'anonymous', ip: req.ip }, body, req.cookies?.[CHALLENGE_COOKIE], clientContextOf(req));
    reply.header('set-cookie', [sessionSetCookie(opened.token, opened.maxAgeSeconds), challengeClearCookie()]);
    return this.me.me(opened.actor);
  }
```

Mettre à jour `role-privileges.int.spec.ts` (droits de `cp_privileged` : colonnes ci-dessus ; `cp_ops` : `EXECUTE` sur la fonction seulement) et le README (section « Récupération d'un administrateur » : `pnpm --filter @classepulse/api ops admin-recovery-code --email … [--clear-block]` depuis un terminal, sous `DB_USER=cp_ops` ; rappel des limites § 3.3 ; `ulimit -c 0` et journaux Docker au lot 7).

- [ ] **Step 4 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/admin-recovery.int.spec.ts apps/api/test/integration/role-privileges.int.spec.ts apps/api/test/integration/routes-meta.int.spec.ts apps/api/test/integration/migrate-from-previous.int.spec.ts` ; `pnpm vitest run --project unit apps/api/test/architecture` ; `pnpm typecheck` ; `pnpm lint` ; `pnpm depcruise` — Expected : PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/api README.md
git commit -m "feat(auth): récupération d'un administrateur — fonction privilégiée, commande ops, verify-recovery

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12 : Ressaisie du mot de passe et vérification supplémentaire (`STEP_UP`)

**Files :**
- Create : `apps/api/src/modules/auth/credentials-checker.ts`, `apps/api/src/modules/auth/too-many-attempts.ts`, `apps/api/src/modules/auth/step-up.service.ts`
- Modify : `apps/api/src/modules/auth/auth.service.ts` (`changePassword` et `login` utilisent `tooManyAttempts` et `CredentialsChecker`), `apps/api/src/modules/auth/account.controller.ts`, `apps/api/src/modules/auth/sessions.repository.ts`, `apps/api/src/modules/auth/auth.module.ts`, `apps/api/test/support/second-factor.ts` (`loginAdmin`), `apps/api/test/integration/routes-meta.int.spec.ts`
- Test : `apps/api/test/integration/step-up.int.spec.ts`

**Interfaces :**
- Consumes : `LoginRateLimiter`, `TurnstileGate`, `PasswordHasher`, `UsersService.credentialsOf`, `SecondFactorService`, `OtpLimiter`, `PasswordBody` (tâche 1).
- Produces :
  - `tooManyAttempts(retryAfter: number): ApiError` (extrait de `auth.service.ts`, `429 TOO_MANY_ATTEMPTS`)
  - `CredentialsChecker.verifyOrThrow(actor: UserActor, password: string, ctx: ClientContext): Promise<void>` (limiteur du lot 1a, R6 ; faux : `400 CURRENT_PASSWORD_INVALID`, R15)
  - `StepUpService.reauth(actor, password, ctx): Promise<void>` ; `startStepUp(actor, password, ctx): Promise<{ expiresInSeconds: 600 }>` ; `verifyStepUp(actor, code: string, ctx): Promise<void>` ; `assertStepUpFreshInTx(tx, actor: UserActor): Promise<void>` (→ `403 STEP_UP_REQUIRED` avec `missing: 'PASSWORD' | 'CODE'`) ; `assertRecentPasswordInTx(tx, actor: UserActor): Promise<void>` (→ `403 REAUTH_REQUIRED`) — gardes que le lot 2 appelle **dans la transaction de l'action sensible**
  - Routes : `POST /api/me/reauth` `{ password }` → `204` ; `POST /api/me/step-up` `{ password }` → `202` `{ expiresInSeconds: 600 }` (administrateur) ; `POST /api/me/step-up/verify` `{ code }` → `204` (administrateur)
  - `SessionsRepository.freshnessInTx(tx, sessionId)`, `markStepUpInTx(tx, sessionId)`
  - test : `loginAdmin(app, db, admin?)` → `{ admin, token, headers }`

- [ ] **Step 1 : Aides et test (échoue)**

Ajouter à `test/support/second-factor.ts` :

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { cookieHeader, send, sessionCookieOf } from './app.js';

/** Connexion complète d'un administrateur (mot de passe, code lu en base, session). Vieillit d'abord ses demandes de code (limite d'une par minute). */
export async function loginAdmin(app: NestFastifyApplication, db: string, existing?: { id: string; email: string; password: string }) {
  const admin = existing ?? (await createAdmin(db));
  await ageChallenges(db, admin.id, 2);
  const login = await send(app, 'POST', '/api/auth/login', { email: admin.email, password: admin.password });
  if (login.statusCode !== 202) throw new Error(`login administrateur : ${login.statusCode} ${login.body}`);
  const set = [login.headers['set-cookie']].flat().find((c) => String(c).startsWith('__Host-cp_challenge='))!;
  const res = await send(app, 'POST', '/api/auth/verify-code', { code: await latestCode(db, admin.email) }, { cookie: String(set).split(';')[0]! });
  if (res.statusCode !== 200) throw new Error(`verify-code : ${res.statusCode} ${res.body}`);
  const token = sessionCookieOf(res)!;
  return { admin, token, headers: cookieHeader(token) };
}
```

(`ageChallenges` a déjà la version qui vieillit toutes les lignes, définie en tâche 9.) La version suivante n'est qu'un rappel :

```ts
export async function ageChallenges(db: string, userId: string, minutes: number): Promise<void> {
  const p = await connectAs('postgres', db);
  try {
    await p.query('set session_replication_role = replica'); // préparation de donnée : ni le déclencheur d'immuabilité ni celui d'annulation
    await p.query(`update app.auth_challenges set created_at = created_at - make_interval(mins => $2) where user_id = $1`, [userId, minutes]);
  } finally { await p.end(); }
}
```

`apps/api/test/integration/step-up.int.spec.ts` :

```ts
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { StepUpService } from '../../src/modules/auth/step-up.service.js';
import { PASSWORD, buildTestApp, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { ageChallenges, loginAdmin, latestCode } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let svc: StepUpService;
let prisma: PrismaService;
beforeAll(async () => {
  db = await createTestDatabase();
  t = await buildTestApp(db);
  svc = t.app.get(StepUpService, { strict: false });
  prisma = t.app.get(PrismaService, { strict: false });
});
afterAll(async () => { await t.close(); });

async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const setSession = async (userId: string, sets: string) => { const c = await connectAs('cp_app', db); await c.query(`update app.sessions set ${sets} where user_id = $1`, [userId]); await c.end(); };
const fresh = (userId: string, sessionId: string) => prisma.withTx((tx) => svc.assertStepUpFreshInTx(tx, { kind: 'user', userId, globalRole: 'ADMIN', sessionId }));
const recent = (userId: string, sessionId: string) => prisma.withTx((tx) => svc.assertRecentPasswordInTx(tx, { kind: 'user', userId, globalRole: 'ADMIN', sessionId }));
const sessionIdOf = async (userId: string) => (await rows(`select id from app.sessions where user_id = $1 and revoked_at is null order by created_at desc limit 1`, [userId]))[0].id as string;

describe('POST /api/me/reauth', () => {
  it('mot de passe juste : 204 et reauth_at posé ; faux : 400 CURRENT_PASSWORD_INVALID ; le délai croissant du lot 1a s’applique', async () => {
    const classId = await insertClass(db, 'L3 Reauth');
    const s = await registerStudent(t.app, classId);
    const headers = { cookie: `__Host-cp_session=${s.token}` };
    const ip = '198.51.100.50';
    const bad = await send(t.app, 'POST', '/api/me/reauth', { password: 'un mauvais mot de passe long' }, headers, ip);
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'CURRENT_PASSWORD_INVALID']);
    const again = await send(t.app, 'POST', '/api/me/reauth', { password: s.password }, headers, ip);
    expect(again.statusCode).toBe(429); // R5 du lot 1a : délai croissant après un échec
    const ok = await send(t.app, 'POST', '/api/me/reauth', { password: s.password }, headers);
    expect(ok.statusCode).toBe(204);
    expect((await rows(`select reauth_at is not null as r from app.sessions where user_id = $1`, [s.userId]))[0].r).toBe(true);
  });
  it('sans session : 401', async () => {
    expect((await send(t.app, 'POST', '/api/me/reauth', { password: PASSWORD })).statusCode).toBe(401);
  });
});

describe('étapes de la vérification supplémentaire', () => {
  it('un étudiant ne la demande pas (403 FORBIDDEN)', async () => {
    const classId = await insertClass(db, 'L3 StepUp Student');
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/me/step-up', { password: s.password }, { cookie: `__Host-cp_session=${s.token}` });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'FORBIDDEN']);
  });
  it('mot de passe faux : 400, aucune vérification, aucun email', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    const res = await send(t.app, 'POST', '/api/me/step-up', { password: 'un mauvais mot de passe long' }, headers);
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CURRENT_PASSWORD_INVALID']);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'STEP_UP'`, [admin.id])).toHaveLength(0);
  });
  it('parcours complet : mot de passe, code lié à la session, puis step_up_at', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    const start = await send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers);
    expect([start.statusCode, start.json()]).toEqual([202, { expiresInSeconds: 600 }]);
    const [ch] = await rows(`select session_id, token_hash, purpose::text as p from app.auth_challenges where user_id = $1 and purpose = 'STEP_UP' and consumed_at is null`, [admin.id]);
    expect(ch).toMatchObject({ p: 'STEP_UP', token_hash: null, session_id: await sessionIdOf(admin.id) });
    expect((await rows(`select payload from app.email_outbox where kind = 'ADMIN_OTP' and recipient_user_id = $1 order by created_at desc limit 1`, [admin.id]))[0].payload).toEqual({ purpose: 'STEP_UP' });
    const code = await latestCode(db, admin.email);
    const done = await send(t.app, 'POST', '/api/me/step-up/verify', { code }, headers);
    expect(done.statusCode).toBe(204);
    const [s] = await rows(`select step_up_at is not null as su, reauth_at is not null as re from app.sessions where user_id = $1`, [admin.id]);
    expect(s).toEqual({ su: true, re: true });
    expect((await rows(`select consumed_reason::text as r from app.auth_challenges where user_id = $1 and purpose = 'STEP_UP'`, [admin.id]))[0].r).toBe('USED');
    await fresh(admin.id, await sessionIdOf(admin.id)); // ne lève pas
  });
  it('mauvais code : CODE_INVALID, essais comptés ; sans demande préalable : CHALLENGE_EXPIRED', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    const none = await send(t.app, 'POST', '/api/me/step-up/verify', { code: '123456' }, headers);
    expect([none.statusCode, none.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    await ageChallenges(db, admin.id, 2);
    await send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers);
    const code = await latestCode(db, admin.email);
    const bad = await send(t.app, 'POST', '/api/me/step-up/verify', { code: code === '000000' ? '000001' : '000000' }, headers);
    expect([bad.statusCode, bad.json().error.code, bad.json().error.attemptsLeft]).toEqual([400, 'CODE_INVALID', 4]);
    expect(bad.headers['set-cookie']).toBeUndefined(); // aucun cookie de vérification dans ce parcours
  });
  it('le code d’une autre session du même administrateur ne sert pas, et ne la consomme pas', async () => {
    const a = await loginAdmin(t.app, db);
    await ageChallenges(db, a.admin.id, 2);
    const b = await loginAdmin(t.app, db, a.admin);
    await ageChallenges(db, a.admin.id, 2);
    await send(t.app, 'POST', '/api/me/step-up', { password: a.admin.password }, a.headers);
    const code = await latestCode(db, a.admin.email);
    const wrongSession = await send(t.app, 'POST', '/api/me/step-up/verify', { code }, b.headers);
    expect([wrongSession.statusCode, wrongSession.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect((await send(t.app, 'POST', '/api/me/step-up/verify', { code }, a.headers)).statusCode).toBe(204);
  });
  it('deux demandes simultanées : une seule aboutit ; deux validations simultanées : une seule réussit', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    const starts = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers)));
    expect(starts.map((r) => r.statusCode).sort()).toEqual([202, 429]);
    const code = await latestCode(db, admin.email);
    const verifies = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/me/step-up/verify', { code }, headers)));
    expect(verifies.map((r) => r.statusCode).sort()).toEqual([204, 400]);
  });
  it('validation en attente du verrou de l’administrateur puis consommation par le titulaire : CHALLENGE_EXPIRED (verrou observé)', async () => {
    const { admin, headers } = await loginAdmin(t.app, db);
    await ageChallenges(db, admin.id, 2);
    await send(t.app, 'POST', '/api/me/step-up', { password: admin.password }, headers);
    const code = await latestCode(db, admin.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [admin.id]);
    await holder.query(`update app.auth_challenges set consumed_at = clock_timestamp(), consumed_reason = 'USED' where user_id = $1 and purpose = 'STEP_UP'`, [admin.id]);
    const pending = send(t.app, 'POST', '/api/me/step-up/verify', { code }, headers);
    await waitForLockWait(db, pid);
    await holder.query('commit');
    await holder.end();
    expect((await pending).json().error.code).toBe('CHALLENGE_EXPIRED');
  });
});

describe('gardes de fraîcheur (consommés par le lot 2, dans la transaction de l’action)', () => {
  it('assertStepUpFreshInTx : PASSWORD manquant, puis CODE manquant, puis valide ; moins de 5 minutes pour chacun', async () => {
    const { admin } = await loginAdmin(t.app, db);
    const sid = await sessionIdOf(admin.id);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', extra: { missing: 'PASSWORD' } });
    await setSession(admin.id, `reauth_at = clock_timestamp()`);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', extra: { missing: 'CODE' } });
    await setSession(admin.id, `step_up_at = clock_timestamp()`);
    await fresh(admin.id, sid);
    await setSession(admin.id, `step_up_at = clock_timestamp() - interval '4 minutes 59 seconds'`);
    await fresh(admin.id, sid);
    await setSession(admin.id, `step_up_at = clock_timestamp() - interval '5 minutes 1 second'`);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ extra: { missing: 'CODE' } });
    await setSession(admin.id, `step_up_at = clock_timestamp(), reauth_at = clock_timestamp() - interval '5 minutes 1 second'`);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ extra: { missing: 'PASSWORD' } });
  });
  it('assertRecentPasswordInTx : REAUTH_REQUIRED sans ressaisie récente', async () => {
    const { admin } = await loginAdmin(t.app, db);
    const sid = await sessionIdOf(admin.id);
    await expect(recent(admin.id, sid)).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
    await setSession(admin.id, `reauth_at = clock_timestamp() - interval '4 minutes'`);
    await recent(admin.id, sid);
    await setSession(admin.id, `reauth_at = clock_timestamp() - interval '6 minutes'`);
    await expect(recent(admin.id, sid)).rejects.toMatchObject({ code: 'REAUTH_REQUIRED' });
  });
  it('une session révoquée : 401, jamais une fraîcheur', async () => {
    const { admin } = await loginAdmin(t.app, db);
    const sid = await sessionIdOf(admin.id);
    await setSession(admin.id, `reauth_at = clock_timestamp(), step_up_at = clock_timestamp(), revoked_at = clock_timestamp(), revoke_reason = 'ADMIN_REVOKED'`);
    await expect(fresh(admin.id, sid)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it('un acteur non administrateur est refusé par la matrice', async () => {
    await expect(prisma.withTx((tx) => svc.assertStepUpFreshInTx(tx, { kind: 'user', userId: 'x', globalRole: 'USER', sessionId: 'y' }))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
```

Dans `routes-meta.int.spec.ts` : ajouter `'POST /api/me/reauth': { public: false }`, `'POST /api/me/step-up': { public: false }`, `'POST /api/me/step-up/verify': { public: false }` et leurs `VALID_BODY` (`{ password: PASSWORD }`, `{ password: PASSWORD }`, `{ code: '123456' }`).

Run : `pnpm vitest run --project integration apps/api/test/integration/step-up.int.spec.ts` — Expected : FAIL (404 sur les routes, `StepUpService` absent).

- [ ] **Step 2 : Implémenter**

`apps/api/src/modules/auth/too-many-attempts.ts` : `export function tooManyAttempts(retryAfter: number): ApiError { return new ApiError(429, 'TOO_MANY_ATTEMPTS', { retryAfter }, { 'retry-after': String(retryAfter) }); }` (importer `ApiError` de `../../http/errors.js`) ; dans `auth.service.ts`, supprimer la fonction locale du même nom et importer celle-ci.

`apps/api/src/modules/auth/credentials-checker.ts` :

```ts
import { normalizePassword } from '@classepulse/shared';
import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../http/errors.js';
import type { UserActor } from '../authz/actor.js';
import { PasswordHasher } from '../users/password-hasher.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { tooManyAttempts } from './too-many-attempts.js';
import { TurnstileGate } from './turnstile.js';

/** Vérification du mot de passe actuel d'une session : limiteur du lot 1a (R6, un échec compte pour IP + compte), 400 sinon (R15). */
@Injectable()
export class CredentialsChecker {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(LoginRateLimiter) private readonly limiter: LoginRateLimiter,
    @Inject(TurnstileGate) private readonly turnstile: TurnstileGate,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
  ) {}

  async verifyOrThrow(actor: UserActor, password: string, ctx: ClientContext): Promise<void> {
    const user = await this.users.credentialsOf(actor); // action me.changePassword : étudiants et administrateurs
    const keys = this.limiter.keys(ctx.ip, user.email);
    const degraded = this.turnstile.isDegraded();
    const gate = await this.limiter.check(keys, degraded);
    if (gate.kind === 'limited') throw tooManyAttempts(gate.retryAfterSeconds);
    const current = normalizePassword(password);
    const ok = user.passwordHash ? await this.hasher.verify(user.passwordHash, current) : await this.hasher.verifyDummy(current);
    if (!ok) {
      await this.limiter.recordFailure(keys, degraded);
      throw new ApiError(400, 'CURRENT_PASSWORD_INVALID');
    }
    await this.limiter.recordSuccess(keys);
  }
}
```

`AuthService.changePassword` : remplacer le bloc entre `validateNewPassword` et `const passwordHash = …` par `await this.credentials.verifyOrThrow(actor, body.currentPassword, ctx);` (injecter `CredentialsChecker`) ; le reste est inchangé (R16). Les tests du lot 1a (`account.int.spec.ts`) servent de non-régression.

`sessions.repository.ts` :

```ts
  /** Fraîcheur (moins de 5 min) du mot de passe et du code, sous `FOR SHARE` : la session ne peut pas être révoquée pendant l'action. `null` : session invalide. */
  async freshnessInTx(tx: TxClient, sessionId: string): Promise<{ password: boolean; code: boolean } | null> {
    const r = await tx.$queryRaw<{ pw: boolean; code: boolean }[]>`
      select coalesce(reauth_at > clock_timestamp() - interval '5 minutes', false) as pw,
             coalesce(step_up_at > clock_timestamp() - interval '5 minutes', false) as code
        from app.sessions
       where id = ${sessionId}::uuid and revoked_at is null and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()
         for share`;
    return r[0] ? { password: r[0].pw, code: r[0].code } : null;
  }

  async markStepUpInTx(tx: TxClient, sessionId: string): Promise<boolean> {
    const r = await tx.$queryRaw<{ n: number }[]>`
      update app.sessions set step_up_at = clock_timestamp() where id = ${sessionId}::uuid and revoked_at is null returning 1 as n`;
    return r.length === 1;
  }
```

`apps/api/src/modules/auth/step-up.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import type { UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import type { ClientContext } from './client-context.js';
import { CredentialsChecker } from './credentials-checker.js';
import { OtpLimiter } from './second-factor/otp-limiter.js';
import { SecondFactorService, outcomeToError, type CheckOutcome } from './second-factor/second-factor.service.js';
import { SessionsRepository } from './sessions.repository.js';

@Injectable()
export class StepUpService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(CredentialsChecker) private readonly credentials: CredentialsChecker,
    @Inject(SecondFactorService) private readonly sf: SecondFactorService,
    @Inject(OtpLimiter) private readonly otpLimiter: OtpLimiter,
    @Inject(SessionsRepository) private readonly sessions: SessionsRepository,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Ressaisie du mot de passe : autorise pendant 5 min les actions sensibles qui n'exigent pas de code (§ 3.3, R11). */
  async reauth(actor: UserActor, password: string, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'me.reauth');
    await this.credentials.verifyOrThrow(actor, password, ctx);
    await this.prisma.withTx((tx) => this.sessions.markReauthInTx(tx, actor.sessionId));
  }

  /** Étape 1 : mot de passe (ressaisie) puis code envoyé à l'adresse, lié à la session. */
  async startStepUp(actor: UserActor, password: string, ctx: ClientContext): Promise<{ expiresInSeconds: 600 }> {
    this.authz.assert(actor, 'me.stepUp');
    await this.credentials.verifyOrThrow(actor, password, ctx);
    await this.otpLimiter.hitRequest(ctx.ip);
    await this.prisma.withTx(async (tx) => {
      await this.sessions.markReauthInTx(tx, actor.sessionId);
      await this.sf.issueInTx(tx, actor, { userId: actor.userId, purpose: 'STEP_UP', sessionId: actor.sessionId, pendingEmail: null, tokenHash: null, ip: ctx.ip });
    });
    return { expiresInSeconds: 600 };
  }

  /** Étape 2 : le code doit appartenir à la session de la requête ; sinon CHALLENGE_EXPIRED, sans consommer la vérification d'une autre session. */
  async verifyStepUp(actor: UserActor, code: string, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'me.stepUpVerify');
    await this.otpLimiter.hitTry(ctx.ip);
    const outcome = await this.prisma.withTx(async (tx): Promise<CheckOutcome> => {
      const r = await this.sf.checkInTx(tx, actor, { userId: actor.userId, purpose: 'STEP_UP', code });
      if (!r.ok) return r; // la transaction est validée : l'essai et l'échec sont enregistrés
      if (r.challenge.sessionId !== actor.sessionId) return { ok: false, reason: 'EXPIRED' };
      await this.sf.consumeInTx(tx, actor, r.challenge, 'USED');
      if (!(await this.sessions.markStepUpInTx(tx, actor.sessionId))) return { ok: false, reason: 'EXPIRED' };
      return r;
    });
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: false });
  }

  /** À appeler dans la transaction de l'action qui exige une vérification supplémentaire (promotion, suspension, anonymisation, transfert en masse, archivage). */
  async assertStepUpFreshInTx(tx: TxClient, actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'stepUp.assertFresh');
    const f = await this.sessions.freshnessInTx(tx, actor.sessionId);
    if (!f) throw new ApiError(401, 'UNAUTHENTICATED');
    if (!f.password) throw new ApiError(403, 'STEP_UP_REQUIRED', { missing: 'PASSWORD' });
    if (!f.code) throw new ApiError(403, 'STEP_UP_REQUIRED', { missing: 'CODE' });
  }

  /** Pour les autres actions sensibles : ressaisie du mot de passe datant de moins de 5 min. */
  async assertRecentPasswordInTx(tx: TxClient, actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'reauth.assertRecent');
    const f = await this.sessions.freshnessInTx(tx, actor.sessionId);
    if (!f) throw new ApiError(401, 'UNAUTHENTICATED');
    if (!f.password) throw new ApiError(403, 'REAUTH_REQUIRED');
  }
}
```

`account.controller.ts` : trois routes (`@CurrentActor() actor: UserActor`, `@Req() req`) :

```ts
  @Post('reauth') @HttpCode(204)
  async reauth(@CurrentActor() actor: UserActor, @Body(new ZodPipe(PasswordBody)) body: PasswordBody, @Req() req: FastifyRequest): Promise<void> {
    await this.stepUp.reauth(actor, body.password, clientContextOf(req));
  }
  @Post('step-up') @HttpCode(202)
  startStepUp(@CurrentActor() actor: UserActor, @Body(new ZodPipe(PasswordBody)) body: PasswordBody, @Req() req: FastifyRequest): Promise<{ expiresInSeconds: 600 }> {
    return this.stepUp.startStepUp(actor, body.password, clientContextOf(req));
  }
  @Post('step-up/verify') @HttpCode(204)
  async verifyStepUp(@CurrentActor() actor: UserActor, @Body(new ZodPipe(VerifyCodeBody)) body: VerifyCodeBody, @Req() req: FastifyRequest): Promise<void> {
    await this.stepUp.verifyStepUp(actor, body.code, clientContextOf(req));
  }
```

Enregistrer `CredentialsChecker` et `StepUpService` dans `AuthModule` (fournisseurs ; exporter `StepUpService`).

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/step-up.int.spec.ts apps/api/test/integration/account.int.spec.ts apps/api/test/integration/routes-meta.int.spec.ts apps/api/test/integration/auth-admin-login.int.spec.ts apps/api/test/integration/second-factor-service.int.spec.ts` ; `pnpm typecheck` ; `pnpm lint` ; `pnpm depcruise` — Expected : PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/api
git commit -m "feat(auth): ressaisie du mot de passe, vérification supplémentaire STEP_UP et gardes de fraîcheur

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13 : Changement d'email d'un administrateur

**Files :**
- Create : `apps/api/src/modules/auth/email-change.service.ts`
- Modify : `apps/api/src/modules/auth/second-factor/challenges.repository.ts` et `second-factor.service.ts` (exemption des demandes `EMAIL_CHANGE_NEW`, R21 ; méthode `notifyOtherAdminsInTx`), `apps/api/src/modules/users/users.repository.ts`, `users.service.ts` (`emailExists`, `changeEmailInTx`), `apps/api/src/modules/auth/sessions.service.ts` et `sessions.repository.ts` (`revokeOthersInTx` accepte `EMAIL_CHANGED`), `apps/api/src/modules/auth/account.controller.ts`, `apps/api/src/modules/auth/auth.module.ts`, `apps/api/test/integration/routes-meta.int.spec.ts`
- Test : `apps/api/test/integration/email-change.int.spec.ts`

**Interfaces :**
- Consumes : `CredentialsChecker`, `SecondFactorService`, `OtpLimiter`, `MailService`, `SessionsService`, `AuditService`, `EmailChangeStartBody` et `VerifyCodeBody` (tâche 1).
- Produces :
  - `POST /api/me/email-change` `{ password, newEmail }` → `202` `{ expiresInSeconds: 600 }` ; `POST /api/me/email-change/verify-old` `{ code }` → `202` `{ expiresInSeconds: 600 }` ; `POST /api/me/email-change/verify-new` `{ code }` → `200` `MeDto` (nouvelle adresse). Administrateur seulement.
  - `EmailChangeService.start(actor: UserActor, body, ctx)`, `verifyOld(actor, code, ctx)`, `verifyNew(actor, code, ctx): Promise<void>`
  - `UsersService.emailExists(actor: UserActor, email: string): Promise<boolean>` (action `me.changeEmailStart`) ; `UsersService.changeEmailInTx(tx, actor: UserActor, newEmail: string): Promise<void>` (action `me.changeEmailVerifyNew`)
  - `SecondFactorService.notifyOtherAdminsInTx(tx, actor, p: { accountId: string; accountEmail: string; dedupePart: string }): Promise<void>`
  - Codes : `409 EMAIL_TAKEN`, `400 EMAIL_UNCHANGED` ; `SessionsService.revokeOthersInTx(tx, actor, reason: 'PASSWORD_CHANGED' | 'EMAIL_CHANGED'): Promise<number>`


- [ ] **Step 1 : Écrire le test (échoue)**

`apps/api/test/integration/email-change.int.spec.ts` :

```ts
import 'reflect-metadata';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { ageChallenges, createAdmin, latestCode, loginAdmin } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
beforeAll(async () => { db = await createTestDatabase(); t = await buildTestApp(db); });
afterAll(async () => { await t.close(); });

async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const emailOf = async (id: string) => (await rows('select email::text as e from app.users where id = $1', [id]))[0].e as string;
const newAddress = () => `nouveau.${uuidv7()}@example.com`;
type Ctx = Awaited<ReturnType<typeof loginAdmin>>;

async function startChange(s: Ctx, newEmail: string) {
  await ageChallenges(db, s.admin.id, 2);
  return send(t.app, 'POST', '/api/me/email-change', { password: s.admin.password, newEmail }, s.headers);
}
async function toNewStep(s: Ctx, newEmail: string) {
  expect((await startChange(s, newEmail)).statusCode).toBe(202);
  const old = await send(t.app, 'POST', '/api/me/email-change/verify-old', { code: await latestCode(db, s.admin.email, 'ADMIN_EMAIL_CHANGE_OLD') }, s.headers);
  expect(old.statusCode).toBe(202);
  return latestCode(db, newEmail, 'ADMIN_EMAIL_CHANGE_NEW');
}

describe('parcours complet (§ 3.3)', () => {
  it('mot de passe + code ancienne adresse + code nouvelle adresse : l’email change, les autres sessions sont révoquées, alertes, audit, sans step_up_at', async () => {
    const other = await createAdmin(db); // destinataire d'une alerte
    const a = await loginAdmin(t.app, db);
    const second = await loginAdmin(t.app, db, a.admin); // autre appareil du même administrateur
    const target = newAddress();
    const start = await startChange(a, target);
    expect([start.statusCode, start.json()]).toEqual([202, { expiresInSeconds: 600 }]);
    const [oldMail] = await rows(`select to_address, payload from app.email_outbox where kind = 'ADMIN_EMAIL_CHANGE_OLD' and recipient_user_id = $1 order by created_at desc limit 1`, [a.admin.id]);
    expect(oldMail).toMatchObject({ to_address: a.admin.email, payload: { newEmail: target } });
    const verifiedOld = await send(t.app, 'POST', '/api/me/email-change/verify-old', { code: await latestCode(db, a.admin.email, 'ADMIN_EMAIL_CHANGE_OLD') }, a.headers);
    expect([verifiedOld.statusCode, verifiedOld.json()]).toEqual([202, { expiresInSeconds: 600 }]);
    expect((await rows(`select to_address from app.email_outbox where kind = 'ADMIN_EMAIL_CHANGE_NEW' and recipient_user_id = $1`, [a.admin.id]))[0].to_address).toBe(target);
    const done = await send(t.app, 'POST', '/api/me/email-change/verify-new', { code: await latestCode(db, target, 'ADMIN_EMAIL_CHANGE_NEW') }, a.headers);
    expect(done.statusCode).toBe(200);
    expect(done.json().email).toBe(target);
    expect(await emailOf(a.admin.id)).toBe(target);
    const sessions = await rows(`select id, revoke_reason::text as r from app.sessions where user_id = $1 order by created_at`, [a.admin.id]);
    expect(sessions.map((s) => s.r)).toEqual([null, 'EMAIL_CHANGED']); // la session courante vit, l'autre est révoquée
    expect((await send(t.app, 'GET', '/api/me', undefined, second.headers)).statusCode).toBe(401);
    expect((await send(t.app, 'GET', '/api/me', undefined, a.headers)).statusCode).toBe(200);
    expect((await rows(`select metadata from app.audit_log where target_id = $1 and action = 'ADMIN_EMAIL_CHANGED'`, [a.admin.id]))[0].metadata).toEqual({ revokedSessions: 1 });
    expect((await rows(`select 1 from app.email_outbox where kind = 'SECURITY_ALERT' and to_address = $1 and payload->>'event' = 'EMAIL_CHANGED'`, [a.admin.email])).length).toBe(1);
    const alerts = await rows(`select recipient_user_id from app.email_outbox where kind = 'ADMIN_SECURITY_ALERT' and payload->>'event' = 'EMAIL_CHANGED' and payload->>'accountEmail' = $1`, [target]);
    expect(alerts.map((r) => r.recipient_user_id)).toContain(other.id);
    expect(alerts.map((r) => r.recipient_user_id)).not.toContain(a.admin.id);
    expect((await rows(`select step_up_at is null as n from app.sessions where id = (select id from app.sessions where user_id = $1 and revoked_at is null)`, [a.admin.id]))[0].n).toBe(true);
    // la nouvelle adresse se connecte, l'ancienne non
    expect((await send(t.app, 'POST', '/api/auth/login', { email: target, password: a.admin.password })).statusCode).toBe(202);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: a.admin.email, password: a.admin.password })).statusCode).toBe(401);
  });
});

describe('début du parcours', () => {
  it('mot de passe faux, même adresse, adresse déjà prise : aucune vérification, aucune session révoquée (Review Focus 6)', async () => {
    const taken = await createAdmin(db);
    const a = await loginAdmin(t.app, db);
    await ageChallenges(db, a.admin.id, 2);
    const bad = await send(t.app, 'POST', '/api/me/email-change', { password: 'un mauvais mot de passe long', newEmail: newAddress() }, a.headers);
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'CURRENT_PASSWORD_INVALID']);
    const same = await send(t.app, 'POST', '/api/me/email-change', { password: a.admin.password, newEmail: a.admin.email.toUpperCase() }, a.headers);
    expect([same.statusCode, same.json().error.code]).toEqual([400, 'EMAIL_UNCHANGED']);
    const dup = await send(t.app, 'POST', '/api/me/email-change', { password: a.admin.password, newEmail: taken.email }, a.headers);
    expect([dup.statusCode, dup.json().error.code]).toEqual([409, 'EMAIL_TAKEN']);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose in ('EMAIL_CHANGE_OLD', 'EMAIL_CHANGE_NEW')`, [a.admin.id])).toHaveLength(0);
    expect((await rows(`select count(*)::int as n from app.sessions where user_id = $1 and revoked_at is null`, [a.admin.id]))[0].n).toBe(1);
  });
  it('un étudiant : 403 ; un administrateur sans parcours en cours : CHALLENGE_EXPIRED aux deux étapes', async () => {
    const classId = await insertClass(db, 'L3 EmailChange');
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/me/email-change', { password: s.password, newEmail: newAddress() }, { cookie: `__Host-cp_session=${s.token}` });
    expect(res.statusCode).toBe(403);
    const a = await loginAdmin(t.app, db);
    for (const step of ['verify-old', 'verify-new']) {
      const r = await send(t.app, 'POST', `/api/me/email-change/${step}`, { code: '123456' }, a.headers);
      expect([r.statusCode, r.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    }
  });
  it('deux demandes simultanées : une seule aboutit', async () => {
    const a = await loginAdmin(t.app, db);
    await ageChallenges(db, a.admin.id, 2);
    const body = { password: a.admin.password, newEmail: newAddress() };
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/me/email-change', body, a.headers)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([202, 429]);
  });
});

describe('codes et liaison à la session', () => {
  it('mauvais code à l’ancienne adresse : CODE_INVALID ; le code de la nouvelle adresse ne sert pas à l’étape 1', async () => {
    const a = await loginAdmin(t.app, db);
    expect((await startChange(a, newAddress())).statusCode).toBe(202);
    const code = await latestCode(db, a.admin.email, 'ADMIN_EMAIL_CHANGE_OLD');
    const bad = await send(t.app, 'POST', '/api/me/email-change/verify-old', { code: code === '000000' ? '000001' : '000000' }, a.headers);
    expect([bad.statusCode, bad.json().error.code, bad.json().error.attemptsLeft]).toEqual([400, 'CODE_INVALID', 4]);
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-new', { code }, a.headers)).json().error.code).toBe('CHALLENGE_EXPIRED'); // pas encore de vérification NEW
  });
  it('le code d’une autre session du même administrateur ne sert pas, et ne la consomme pas', async () => {
    const a = await loginAdmin(t.app, db);
    const b = await loginAdmin(t.app, db, a.admin);
    expect((await startChange(a, newAddress())).statusCode).toBe(202);
    const code = await latestCode(db, a.admin.email, 'ADMIN_EMAIL_CHANGE_OLD');
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-old', { code }, b.headers)).json().error.code).toBe('CHALLENGE_EXPIRED');
    expect((await send(t.app, 'POST', '/api/me/email-change/verify-old', { code }, a.headers)).statusCode).toBe(202);
  });
});

describe('fin du parcours : verrous et conflits', () => {
  it('adresse prise entre les deux étapes : 409 EMAIL_TAKEN, l’email ne change pas, aucune session révoquée, la vérification reste', async () => {
    const a = await loginAdmin(t.app, db);
    await loginAdmin(t.app, db, a.admin);
    const target = newAddress();
    const codeNew = await toNewStep(a, target);
    await createAdmin(db, { email: target }); // quelqu'un prend l'adresse entre-temps
    const res = await send(t.app, 'POST', '/api/me/email-change/verify-new', { code: codeNew }, a.headers);
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'EMAIL_TAKEN']);
    expect(await emailOf(a.admin.id)).toBe(a.admin.email);
    expect((await rows(`select count(*)::int as n from app.sessions where user_id = $1 and revoked_at is null`, [a.admin.id]))[0].n).toBe(2);
    expect(await rows(`select 1 from app.auth_challenges where user_id = $1 and purpose = 'EMAIL_CHANGE_NEW' and consumed_at is null`, [a.admin.id])).toHaveLength(1);
  });
  it('session révoquée entre verify-old et verify-new, pendant que la requête attend le verrou de la session : CHALLENGE_EXPIRED, l’email ne change pas', async () => {
    const a = await loginAdmin(t.app, db);
    const target = newAddress();
    const codeNew = await toNewStep(a, target);
    const sid = (await rows(`select id from app.sessions where user_id = $1 and revoked_at is null`, [a.admin.id]))[0].id as string;
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.sessions where id = $1 for update', [sid]);
    const pending = send(t.app, 'POST', '/api/me/email-change/verify-new', { code: codeNew }, a.headers);
    await waitForLockWait(db, pid);
    await holder.query(`update app.sessions set revoked_at = clock_timestamp(), revoke_reason = 'ADMIN_REVOKED' where id = $1`, [sid]);
    await holder.query('commit');
    await holder.end();
    const res = await pending;
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
    expect(await emailOf(a.admin.id)).toBe(a.admin.email);
  });
  it('deux validations simultanées de la nouvelle adresse : un seul changement, un seul audit', async () => {
    const a = await loginAdmin(t.app, db);
    const target = newAddress();
    const codeNew = await toNewStep(a, target);
    const res = await Promise.all([1, 2].map(() => send(t.app, 'POST', '/api/me/email-change/verify-new', { code: codeNew }, a.headers)));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await rows(`select 1 from app.audit_log where target_id = $1 and action = 'ADMIN_EMAIL_CHANGED'`, [a.admin.id])).toHaveLength(1);
    expect(await emailOf(a.admin.id)).toBe(target);
  });
});
```

Ajouter à `routes-meta.int.spec.ts` : `'POST /api/me/email-change'`, `'POST /api/me/email-change/verify-old'`, `'POST /api/me/email-change/verify-new'` (non publiques) et leurs `VALID_BODY` (`{ password: PASSWORD, newEmail: 'nouveau@example.com' }`, `{ code: '123456' }`, `{ code: '123456' }`).

Run : `pnpm vitest run --project integration apps/api/test/integration/email-change.int.spec.ts` — Expected : FAIL (404 sur les routes).

- [ ] **Step 2 : Implémenter**

`challenges.repository.ts` : `requestCountsInTx` ne compte plus `EMAIL_CHANGE_NEW` : remplacer `purpose <> 'RECOVERY'` par `purpose not in ('RECOVERY', 'EMAIL_CHANGE_NEW')`. `second-factor.service.ts` : dans `issueInTx`, `const wait = input.purpose === 'EMAIL_CHANGE_NEW' ? 0 : (…comme avant…)` et ajouter la méthode :

```ts
  /** Alerte les autres administrateurs actifs (§ 3.3, changement d'email) ; le compte concerné n'est pas destinataire. */
  async notifyOtherAdminsInTx(tx: TxClient, actor: Actor, p: { accountId: string; accountEmail: string; dedupePart: string }): Promise<void> {
    this.authz.assert(actor, 'me.changeEmailVerifyNew');
    for (const admin of await this.repo.activeAdminsInTx(tx)) {
      if (admin.id === p.accountId) continue;
      await this.mail.enqueueInTx(tx, actor, {
        kind: 'ADMIN_SECURITY_ALERT', recipientUserId: admin.id, toAddress: admin.email,
        dedupeKey: `admin-email-alert:${p.dedupePart}:${admin.id}`,
        payload: { event: 'EMAIL_CHANGED', accountEmail: p.accountEmail }, expiresInSeconds: 86_400,
      });
    }
  }
```

`users.repository.ts` :

```ts
  async emailExists(email: string): Promise<boolean> {
    const r = await this.prisma.client.$queryRaw<{ n: number }[]>`select 1 as n from app.users where email = ${email}::ext.citext`;
    return r.length > 0;
  }

  /** Colonne `email` accordée à cp_app seulement pour les administrateurs (déclencheur users_second_factor_guard, § 3.3). */
  async changeEmailInTx(tx: TxClient, id: string, email: string): Promise<void> {
    await tx.$executeRaw`update app.users set email = ${email}::ext.citext, updated_at = now() where id = ${id}::uuid`;
  }
```

`users.service.ts` : `emailExists(actor: UserActor, email: string)` (assert `me.changeEmailStart`) et `changeEmailInTx(tx, actor: UserActor, newEmail: string)` (assert `me.changeEmailVerifyNew`, puis le dépôt).

`sessions.repository.ts` : `RevokeReason` gagne `'EMAIL_CHANGED'`. `sessions.service.ts` :

```ts
  async revokeOthersInTx(tx: TxClient, actor: UserActor, reason: 'PASSWORD_CHANGED' | 'EMAIL_CHANGED'): Promise<number> {
    this.authz.assert(actor, reason === 'PASSWORD_CHANGED' ? 'me.changePassword' : 'me.changeEmailVerifyNew');
    return this.repo.revokeOthersInTx(tx, actor.userId, actor.sessionId, reason);
  }
```

`apps/api/src/modules/auth/email-change.service.ts` :

```ts
import type { EmailChangeStartBody } from '@classepulse/shared';
import { Inject, Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../../database/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { MailService } from '../mail/mail.service.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { CredentialsChecker } from './credentials-checker.js';
import { OtpLimiter } from './second-factor/otp-limiter.js';
import { SecondFactorService, outcomeToError, type CheckOutcome } from './second-factor/second-factor.service.js';
import { SessionsRepository } from './sessions.repository.js';
import { SessionsService } from './sessions.service.js';

@Injectable()
export class EmailChangeService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(CredentialsChecker) private readonly credentials: CredentialsChecker,
    @Inject(SecondFactorService) private readonly sf: SecondFactorService,
    @Inject(OtpLimiter) private readonly otpLimiter: OtpLimiter,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(SessionsRepository) private readonly sessionsRepo: SessionsRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Étape 1 : mot de passe, puis code envoyé à l'ANCIENNE adresse (`pending_email` = la nouvelle, liée à la session). */
  async start(actor: UserActor, body: EmailChangeStartBody, ctx: ClientContext): Promise<{ expiresInSeconds: 600 }> {
    this.authz.assert(actor, 'me.changeEmailStart');
    await this.credentials.verifyOrThrow(actor, body.password, ctx);
    const current = await this.users.credentialsOf(actor);
    if (body.newEmail === current.email) throw new ApiError(400, 'EMAIL_UNCHANGED');
    if (await this.users.emailExists(actor, body.newEmail)) throw new ApiError(409, 'EMAIL_TAKEN');
    await this.otpLimiter.hitRequest(ctx.ip);
    await this.prisma.withTx((tx) => this.sf.issueInTx(tx, actor, {
      userId: actor.userId, purpose: 'EMAIL_CHANGE_OLD', sessionId: actor.sessionId, pendingEmail: body.newEmail, tokenHash: null, ip: ctx.ip }));
    return { expiresInSeconds: 600 };
  }

  /** Étape 2 : code de l'ancienne adresse (tient lieu de vérification supplémentaire, sans toucher `step_up_at`), puis code envoyé à la NOUVELLE. */
  async verifyOld(actor: UserActor, code: string, ctx: ClientContext): Promise<{ expiresInSeconds: 600 }> {
    this.authz.assert(actor, 'me.changeEmailVerifyOld');
    await this.otpLimiter.hitTry(ctx.ip);
    const outcome = await this.prisma.withTx(async (tx): Promise<CheckOutcome> => {
      const r = await this.sf.checkInTx(tx, actor, { userId: actor.userId, purpose: 'EMAIL_CHANGE_OLD', code });
      if (!r.ok) return r;
      if (r.challenge.sessionId !== actor.sessionId || !r.challenge.pendingEmail) return { ok: false, reason: 'EXPIRED' };
      await this.sf.consumeInTx(tx, actor, r.challenge, 'USED');
      await this.sf.issueInTx(tx, actor, {
        userId: actor.userId, purpose: 'EMAIL_CHANGE_NEW', sessionId: actor.sessionId, pendingEmail: r.challenge.pendingEmail, tokenHash: null, ip: ctx.ip });
      return r;
    });
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: false });
    return { expiresInSeconds: 600 };
  }

  /**
   * Étape 3 : code de la nouvelle adresse. Sous verrou : la session est toujours valide et c'est celle de la requête
   * (ordre users → auth_challenges → sessions). À la fin : les autres sessions sont révoquées, alertes, audit.
   */
  async verifyNew(actor: UserActor, code: string, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'me.changeEmailVerifyNew');
    await this.otpLimiter.hitTry(ctx.ip);
    const oldEmail = (await this.users.credentialsOf(actor)).email;
    let outcome: CheckOutcome;
    try {
      outcome = await this.prisma.withTx(async (tx): Promise<CheckOutcome> => {
        const r = await this.sf.checkInTx(tx, actor, { userId: actor.userId, purpose: 'EMAIL_CHANGE_NEW', code });
        if (!r.ok) return r;
        const newEmail = r.challenge.pendingEmail;
        if (r.challenge.sessionId !== actor.sessionId || !newEmail || !(await this.sessionsRepo.lockValidInTx(tx, actor.sessionId))) return { ok: false, reason: 'EXPIRED' };
        await this.sf.consumeInTx(tx, actor, r.challenge, 'USED');
        await this.users.changeEmailInTx(tx, actor, newEmail);
        const revoked = await this.sessions.revokeOthersInTx(tx, actor, 'EMAIL_CHANGED');
        await this.audit.recordInTx(tx, actor, { action: 'ADMIN_EMAIL_CHANGED', targetType: 'USER', targetId: actor.userId, metadata: { revokedSessions: revoked } });
        // L'ancienne adresse est prévenue ; les autres administrateurs aussi.
        await this.mail.enqueueInTx(tx, actor, {
          kind: 'SECURITY_ALERT', recipientUserId: actor.userId, toAddress: oldEmail, dedupeKey: `email-changed:${r.challenge.id}`,
          payload: { event: 'EMAIL_CHANGED' }, expiresInSeconds: 86_400 });
        await this.sf.notifyOtherAdminsInTx(tx, actor, { accountId: actor.userId, accountEmail: newEmail, dedupePart: r.challenge.id });
        return r;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'EMAIL_TAKEN'); // la transaction est annulée : rien n'a changé
      throw e;
    }
    if (!outcome.ok) throw outcomeToError(outcome, { clearChallengeCookie: false });
  }
}
```

`sessions.repository.ts` : ajouter

```ts
  /** Verrou de la session (après les vérifications dans l'ordre global) : vrai si elle est encore valide. */
  async lockValidInTx(tx: TxClient, sessionId: string): Promise<boolean> {
    const r = await tx.$queryRaw<{ n: number }[]>`
      select 1 as n from app.sessions
       where id = ${sessionId}::uuid and revoked_at is null and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()
         for update`;
    return r.length === 1;
  }
```

Routes (`account.controller.ts`, injecter `EmailChangeService` et `MeService`) : `POST me/email-change` (`@HttpCode(202)`, `EmailChangeStartBody`), `POST me/email-change/verify-old` (`@HttpCode(202)`, `VerifyCodeBody`), `POST me/email-change/verify-new` (`@HttpCode(200)`, `VerifyCodeBody`, renvoie `this.me.me(actor)` après `verifyNew`). Enregistrer `EmailChangeService` dans `AuthModule`.

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/email-change.int.spec.ts apps/api/test/integration/step-up.int.spec.ts apps/api/test/integration/second-factor-service.int.spec.ts apps/api/test/integration/account.int.spec.ts apps/api/test/integration/routes-meta.int.spec.ts` ; `pnpm vitest run --project unit apps/api/src/modules/authz` ; `pnpm typecheck` ; `pnpm lint` ; `pnpm depcruise` — Expected : PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/api
git commit -m "feat(auth): changement d'email d'un administrateur (mot de passe, code ancienne adresse, code nouvelle adresse)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14 : Mot de passe oublié

**Files :**
- Create : `apps/api/src/modules/auth/password-reset.repository.ts`, `apps/api/src/modules/auth/password-reset.service.ts`
- Modify : `apps/api/src/modules/auth/auth.controller.ts`, `apps/api/src/modules/auth/auth.module.ts`, `apps/api/src/modules/auth/sessions.repository.ts` et `sessions.service.ts` (`revokeAllInTx`), `apps/api/src/modules/auth/second-factor/second-factor.service.ts` (`endAllInTx`), `apps/api/src/modules/users/users.service.ts` et `users.repository.ts` (`findForPasswordReset`, `findForPasswordResetById`, `resetPasswordInTx`), `apps/api/test/integration/routes-meta.int.spec.ts`
- Test : `apps/api/test/integration/password-reset.int.spec.ts`

**Interfaces :**
- Consumes : `Turnstile` (`TurnstileGate.check`), `RateLimitRepository.hit`, `MailService`, `PasswordHasher`, `validateNewPassword`, `CommonPasswords`, `AuditService`, `ForgotPasswordBody` et `ResetPasswordBody` (tâche 1), `APP_CONFIG` (`security.rateLimitHmacKey`).
- Produces :
  - `POST /api/auth/forgot-password` `{ email, turnstileToken }` (public) → `202` `{ status: 'RESET_REQUESTED' }` **dans tous les cas** (compte actif, inconnu, suspendu, limite par compte atteinte) ; `400 TURNSTILE_FAILED`, `503 RESET_UNAVAILABLE` (avec `Retry-After: 60`), `429 TOO_MANY_ATTEMPTS` (10 par heure et par préfixe d'IP)
  - `POST /api/auth/reset-password` `{ token, newPassword }` (public) → `204` ; `400 RESET_TOKEN_INVALID`, ou l'erreur de politique de mot de passe (`PASSWORD_TOO_SHORT`, …) **sans consommer le jeton** ; en-tête `Referrer-Policy: no-referrer` sur ces deux réponses
  - `PasswordResetService.request(actor: AnonymousActor, body, ctx): Promise<void>` ; `reset(actor: AnonymousActor, body, ctx): Promise<void>`
  - `SecondFactorService.endAllInTx(tx, actor: AnonymousActor, userId): Promise<void>` (consomme `SESSION_ENDED` toutes les vérifications actives, sauf RECOVERY) ; `SessionsService.revokeAllInTx(tx, actor: AnonymousActor, userId, reason: 'PASSWORD_CHANGED'): Promise<number>`

- [ ] **Step 1 : Écrire le test (échoue)**

`apps/api/test/integration/password-reset.int.spec.ts` :

```ts
import { createHash } from 'node:crypto';
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { waitForLockWait } from '../support/lock-wait.js';
import { cipher } from '../support/mail.js';
import { ageChallenges, createAdmin, loginAdmin } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let classId: string;
beforeAll(async () => { db = await createTestDatabase(); t = await buildTestApp(db); classId = await insertClass(db, 'L3 Reset'); });
afterAll(async () => { await t.close(); });

const NEW_PASSWORD = 'un tout nouveau mot de passe 2026';
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const forgot = (email: string, ip?: string) => send(t.app, 'POST', '/api/auth/forgot-password', { email, turnstileToken: 'tok' }, {}, ip);
/** Le jeton en clair de la dernière demande (déchiffré avec la clé de test) : remplace la boîte email. */
async function latestToken(email: string): Promise<string> {
  const [r] = await rows(`select id, payload_encrypted from app.email_outbox where to_address = $1 and kind = 'PASSWORD_RESET' and payload_encrypted is not null order by created_at desc, id desc limit 1`, [email]);
  return cipher.decrypt(r.id, r.payload_encrypted).token!;
}
const reset = (token: string, newPassword = NEW_PASSWORD) => send(t.app, 'POST', '/api/auth/reset-password', { token, newPassword });

describe('POST /api/auth/forgot-password', () => {
  it('compte actif, inconnu, suspendu : la même réponse 202 ; seul le compte actif reçoit un email (Review Focus 5)', async () => {
    const s = await registerStudent(t.app, classId);
    const susp = await createAdmin(db, { status: 'SUSPENDED' });
    const r1 = await forgot(s.email);
    const r2 = await forgot('inconnu.reset@example.com');
    const r3 = await forgot(susp.email);
    for (const r of [r1, r2, r3]) { expect(r.statusCode).toBe(202); expect(r.json()).toEqual({ status: 'RESET_REQUESTED' }); expect(r.headers['referrer-policy']).toBe('no-referrer'); }
    expect(await rows(`select 1 from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email])).toHaveLength(1);
    expect(await rows(`select 1 from app.email_outbox where kind = 'PASSWORD_RESET' and to_address in ($1, $2)`, ['inconnu.reset@example.com', susp.email])).toHaveLength(0);
  });
  it('jeton de 32 octets, haché (SHA-256), valable 30 min, absent de payload ; expiration de l’email alignée', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await rows(`select token_hash, extract(epoch from expires_at - created_at)::int as ttl from app.password_reset_tokens where user_id = $1 and consumed_at is null`, [s.userId]);
    expect(row.token_hash.equals(createHash('sha256').update(Buffer.from(token, 'base64url')).digest())).toBe(true);
    expect(row.ttl).toBeGreaterThanOrEqual(1799); expect(row.ttl).toBeLessThanOrEqual(1801);
    expect(JSON.stringify(await rows(`select payload from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email]))).not.toContain(token);
  });
  it('Turnstile invalide : 400 ; indisponible : 503 RESET_UNAVAILABLE avec Retry-After ; aucun jeton créé', async () => {
    const s = await registerStudent(t.app, classId);
    t.turnstile.next = 'invalid';
    expect((await forgot(s.email)).json().error.code).toBe('TURNSTILE_FAILED');
    t.turnstile.next = 'unavailable';
    const down = await forgot(s.email);
    expect([down.statusCode, down.json().error.code, down.headers['retry-after']]).toEqual([503, 'RESET_UNAVAILABLE', '60']);
    t.turnstile.next = 'valid';
    expect(await rows(`select 1 from app.password_reset_tokens where user_id = $1`, [s.userId])).toHaveLength(0);
  });
  it('une nouvelle demande annule la précédente ; au-delà de 3 par heure et par compte : même 202, aucun email (R9)', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const first = await latestToken(s.email);
    await forgot(s.email);
    const second = await latestToken(s.email);
    expect(second).not.toBe(first);
    expect((await reset(first)).json().error.code).toBe('RESET_TOKEN_INVALID');
    await forgot(s.email); // 3ᵉ
    const fourth = await forgot(s.email);
    expect([fourth.statusCode, fourth.json()]).toEqual([202, { status: 'RESET_REQUESTED' }]);
    expect(await rows(`select 1 from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email])).toHaveLength(3);
  });
  it('10 demandes par heure et par IP, puis 429', async () => {
    const ip = '198.51.100.88';
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await forgot(`ip.${i}@example.com`, ip)).statusCode;
    expect(last).toBe(429);
  });
});

describe('POST /api/auth/reset-password', () => {
  it('nouveau mot de passe, toutes les sessions révoquées, jeton consommé, audit, alerte ; l’ancien mot de passe ne marche plus', async () => {
    const s = await registerStudent(t.app, classId);
    await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: s.password }); // deuxième session
    await forgot(s.email);
    const token = await latestToken(s.email);
    const res = await reset(token);
    expect(res.statusCode).toBe(204);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect((await rows(`select count(*)::int as n from app.sessions where user_id = $1 and revoked_at is null`, [s.userId]))[0].n).toBe(0);
    expect((await rows(`select distinct revoke_reason::text as r from app.sessions where user_id = $1`, [s.userId]))[0].r).toBe('PASSWORD_CHANGED');
    expect((await rows(`select metadata from app.audit_log where target_id = $1 and action = 'PASSWORD_RESET_COMPLETED'`, [s.userId]))[0].metadata).toEqual({ revokedSessions: 2 });
    expect((await rows(`select 1 from app.email_outbox where kind = 'SECURITY_ALERT' and to_address = $1 and payload->>'event' = 'PASSWORD_RESET'`, [s.email])).length).toBe(1);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: s.password })).statusCode).toBe(401);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: NEW_PASSWORD })).statusCode).toBe(200);
    const again = await reset(token); // usage unique
    expect([again.statusCode, again.json().error.code]).toEqual([400, 'RESET_TOKEN_INVALID']);
  });
  it('jeton inconnu, mal formé ou expiré', async () => {
    expect((await reset('A'.repeat(43))).json().error.code).toBe('RESET_TOKEN_INVALID');
    expect((await reset('court')).json().error.code).toBe('VALIDATION_FAILED');
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.password_reset_tokens set expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [s.userId]);
    await o.end();
    expect((await reset(token)).json().error.code).toBe('RESET_TOKEN_INVALID');
  });
  it('mot de passe refusé par la politique : l’erreur précise, et le jeton reste utilisable', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const short = await reset(token, 'trop court');
    expect([short.statusCode, short.json().error.code]).toEqual([400, 'PASSWORD_TOO_SHORT']);
    expect((await reset(token)).statusCode).toBe(204);
  });
  it('compte suspendu entre la demande et la réinitialisation : RESET_TOKEN_INVALID', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.users set status = 'SUSPENDED' where id = $1`, [s.userId]);
    await o.end();
    expect((await reset(token)).json().error.code).toBe('RESET_TOKEN_INVALID');
  });
  it('administrateur : mot de passe de 16 caractères au moins ; après la réinitialisation, le code reste exigé à la connexion et les vérifications en cours sont terminées', async () => {
    const a = await loginAdmin(t.app, db);
    await ageChallenges(db, a.admin.id, 2);
    await send(t.app, 'POST', '/api/me/step-up', { password: a.admin.password }, a.headers);
    await forgot(a.admin.email);
    const token = await latestToken(a.admin.email);
    const short = await reset(token, 'quinze caracter');
    expect([short.statusCode, short.json().error.code]).toEqual([400, 'PASSWORD_TOO_SHORT']);
    expect((await reset(token)).statusCode).toBe(204);
    expect((await rows(`select count(*)::int as n from app.auth_challenges where user_id = $1 and consumed_at is null`, [a.admin.id]))[0].n).toBe(0);
    expect((await send(t.app, 'GET', '/api/me', undefined, a.headers)).statusCode).toBe(401);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: a.admin.email, password: NEW_PASSWORD })).statusCode).toBe(202);
  });
  it('deux réinitialisations simultanées avec le même jeton : une seule aboutit', async () => {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const res = await Promise.all([reset(token, NEW_PASSWORD), reset(token, `${NEW_PASSWORD} bis`)]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([204, 400]);
  });
  async function holdThenReset(outcome: 'COMMIT' | 'ROLLBACK') {
    const s = await registerStudent(t.app, classId);
    await forgot(s.email);
    const token = await latestToken(s.email);
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    const pid = (await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    await holder.query('select id from app.users where id = $1 for no key update', [s.userId]);
    await holder.query(`update app.password_reset_tokens set consumed_at = clock_timestamp() where user_id = $1 and consumed_at is null`, [s.userId]);
    const pending = reset(token);
    await waitForLockWait(db, pid);
    await holder.query(outcome);
    await holder.end();
    return pending;
  }
  it('le titulaire a consommé le jeton (verrou observé) : RESET_TOKEN_INVALID', async () => {
    const r = await holdThenReset('COMMIT');
    expect([r.statusCode, r.json().error.code]).toEqual([400, 'RESET_TOKEN_INVALID']);
  });
  it('le titulaire a annulé (verrou observé) : la réinitialisation aboutit', async () => {
    expect((await holdThenReset('ROLLBACK')).statusCode).toBe(204);
  });
});
```

Ajouter à `routes-meta.int.spec.ts` : `'POST /api/auth/forgot-password': { public: true }`, `'POST /api/auth/reset-password': { public: true }` et `VALID_BODY` : `() => ({ email: 'inconnu@example.com', turnstileToken: 'tok' })`, `() => ({ token: 'A'.repeat(43), newPassword: 'un mot de passe assez long 42' })`.

Run : `pnpm vitest run --project integration apps/api/test/integration/password-reset.int.spec.ts` — Expected : FAIL (404).

- [ ] **Step 2 : Implémenter**

`users.repository.ts` / `users.service.ts` : `findForPasswordReset(actor: AnonymousActor, email)` (action `auth.forgotPassword`, `repo.findByEmail`), `findForPasswordResetById(actor: AnonymousActor, id)` (action `auth.resetPassword`, `repo.findLoginById`), `resetPasswordInTx(tx, actor: AnonymousActor, userId, passwordHash)` (action `auth.resetPassword`, `repo.setPasswordHashInTx`). `sessions.repository.ts` :

```ts
  async revokeAllInTx(tx: TxClient, userId: string, reason: RevokeReason): Promise<number> {
    return tx.$executeRaw`
      update app.sessions set revoked_at = clock_timestamp(), revoke_reason = ${reason}::app.session_revoke_reason
       where user_id = ${userId}::uuid and revoked_at is null`;
  }
```

`SessionsService.revokeAllInTx(tx, actor: AnonymousActor, userId, reason: 'PASSWORD_CHANGED')` (assert `auth.resetPassword`). `SecondFactorService.endAllInTx(tx, actor: AnonymousActor, userId)` (assert `auth.resetPassword`, `repo.consumeAllActiveInTx(tx, userId, 'SESSION_ENDED')`).

`apps/api/src/modules/auth/password-reset.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';

export type LockedUser = { id: string; email: string; status: string };

@Injectable()
export class PasswordResetRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async lockUserInTx(tx: TxClient, userId: string): Promise<LockedUser | null> {
    const r = await tx.$queryRaw<LockedUser[]>`select id, email::text as email, status::text as status from app.users where id = ${userId}::uuid for no key update`;
    return r[0] ?? null;
  }

  async supersedeActiveInTx(tx: TxClient, userId: string): Promise<void> {
    await tx.$executeRaw`update app.password_reset_tokens set consumed_at = clock_timestamp() where user_id = ${userId}::uuid and consumed_at is null`;
  }

  async insertInTx(tx: TxClient, t: { id: string; userId: string; tokenHash: Buffer; ttlSeconds: number }): Promise<void> {
    await tx.$executeRaw`
      insert into app.password_reset_tokens (id, user_id, token_hash, expires_at)
      values (${t.id}::uuid, ${t.userId}::uuid, ${t.tokenHash}, clock_timestamp() + make_interval(secs => ${t.ttlSeconds}::double precision))`;
  }

  /** Lecture sans verrou : retrouve un jeton actif. */
  async findActive(tokenHash: Buffer): Promise<{ id: string; userId: string } | null> {
    const r = await this.prisma.client.$queryRaw<{ id: string; user_id: string }[]>`
      select id, user_id from app.password_reset_tokens where token_hash = ${tokenHash} and consumed_at is null and expires_at > clock_timestamp()`;
    return r[0] ? { id: r[0].id, userId: r[0].user_id } : null;
  }

  /** Verrou du jeton, après celui du compte ; revérifie qu'il est toujours actif. */
  async lockActiveInTx(tx: TxClient, tokenHash: Buffer): Promise<{ id: string } | null> {
    const r = await tx.$queryRaw<{ id: string }[]>`
      select id from app.password_reset_tokens where token_hash = ${tokenHash} and consumed_at is null and expires_at > clock_timestamp() for update`;
    return r[0] ?? null;
  }

  async consumeInTx(tx: TxClient, id: string): Promise<void> {
    await tx.$executeRaw`update app.password_reset_tokens set consumed_at = clock_timestamp() where id = ${id}::uuid and consumed_at is null`;
  }
}
```

`apps/api/src/modules/auth/password-reset.service.ts` :

```ts
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { type ForgotPasswordBody, type ResetPasswordBody } from '@classepulse/shared';
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/load-config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { ipPrefix } from '../../http/ip.js';
import { AuditService } from '../audit/audit.service.js';
import type { AnonymousActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { MailService } from '../mail/mail.service.js';
import { CommonPasswords } from '../users/common-passwords.js';
import { PasswordHasher } from '../users/password-hasher.js';
import { validateNewPassword } from '../users/password-policy.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { PasswordResetRepository } from './password-reset.repository.js';
import { RateLimitRepository } from './rate-limit.repository.js';
import { SecondFactorService } from './second-factor/second-factor.service.js';
import { SessionsService } from './sessions.service.js';
import { tooManyAttempts } from './too-many-attempts.js';
import { TurnstileGate } from './turnstile.js';

const HOUR = 3600;
export const RESET_REQUESTS_PER_IP_HOUR = 10;
export const RESET_REQUESTS_PER_ACCOUNT_HOUR = 3;
const RESET_TTL_SECONDS = 1800;

const hashToken = (token: string): Buffer => createHash('sha256').update(Buffer.from(token, 'base64url')).digest();

@Injectable()
export class PasswordResetService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(TurnstileGate) private readonly turnstile: TurnstileGate,
    @Inject(RateLimitRepository) private readonly buckets: RateLimitRepository,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(PasswordResetRepository) private readonly repo: PasswordResetRepository,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(SecondFactorService) private readonly secondFactor: SecondFactorService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(CommonPasswords) private readonly common: CommonPasswords,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** § 3.2 : Turnstile exigé ; réponse identique que le compte existe, soit actif, suspendu ou inconnu (arbitrage N, R9). */
  async request(actor: AnonymousActor, body: ForgotPasswordBody, ctx: ClientContext): Promise<void> {
    this.authz.assert(actor, 'auth.forgotPassword');
    const t = await this.turnstile.check(body.turnstileToken, actor.ip);
    if (t === 'unavailable') throw new ApiError(503, 'RESET_UNAVAILABLE', {}, { 'retry-after': '60' });
    if (t === 'invalid') throw new ApiError(400, 'TURNSTILE_FAILED');
    const ip = await this.buckets.hit(`forgot-ip:${ipPrefix(ctx.ip)}`, HOUR);
    if (ip.attempts > RESET_REQUESTS_PER_IP_HOUR) throw tooManyAttempts(Math.max(1, ip.resetIn));
    const mac = createHmac('sha256', this.config.security.rateLimitHmacKey).update(body.email).digest('hex');
    const account = await this.buckets.hit(`forgot-acct:${mac}`, HOUR);
    if (account.attempts > RESET_REQUESTS_PER_ACCOUNT_HOUR) return; // silencieux : rien ne révèle l'existence du compte
    const user = await this.users.findForPasswordReset(actor, body.email);
    if (!user || user.status !== 'ACTIVE') return;
    const raw = randomBytes(32);
    const token = raw.toString('base64url');
    const id = uuidv7();
    await this.prisma.withTx(async (tx) => {
      const locked = await this.repo.lockUserInTx(tx, user.id);
      if (!locked || locked.status !== 'ACTIVE') return;
      await this.repo.supersedeActiveInTx(tx, user.id); // une nouvelle demande annule la précédente
      await this.repo.insertInTx(tx, { id, userId: user.id, tokenHash: hashToken(token), ttlSeconds: RESET_TTL_SECONDS });
      await this.mail.enqueueInTx(tx, actor, {
        kind: 'PASSWORD_RESET', recipientUserId: user.id, toAddress: locked.email, dedupeKey: `password-reset:${id}`,
        payload: {}, secret: { token }, expiresInSeconds: RESET_TTL_SECONDS });
    });
  }

  /** Le jeton arrive par POST (jamais en URL). Une règle de mot de passe refusée ne consomme pas le jeton. */
  async reset(actor: AnonymousActor, body: ResetPasswordBody): Promise<void> {
    this.authz.assert(actor, 'auth.resetPassword');
    const tokenHash = hashToken(body.token);
    const ref = await this.repo.findActive(tokenHash);
    if (!ref) throw new ApiError(400, 'RESET_TOKEN_INVALID');
    const user = await this.users.findForPasswordResetById(actor, ref.userId);
    if (!user || user.status !== 'ACTIVE') throw new ApiError(400, 'RESET_TOKEN_INVALID');
    const pw = validateNewPassword(body.newPassword, user.globalRole, this.common);
    if (!pw.ok) throw new ApiError(400, pw.code);
    const passwordHash = await this.hasher.hash(pw.normalized); // hors transaction (Argon2id est lent)
    const revoked = await this.prisma.withTx(async (tx): Promise<number | null> => {
      const locked = await this.repo.lockUserInTx(tx, user.id); // users → jeton → vérifications → sessions → email
      if (!locked || locked.status !== 'ACTIVE') return null;
      const tok = await this.repo.lockActiveInTx(tx, tokenHash);
      if (!tok) return null;
      await this.repo.consumeInTx(tx, tok.id);
      await this.users.resetPasswordInTx(tx, actor, user.id, passwordHash);
      await this.secondFactor.endAllInTx(tx, actor, user.id);
      const n = await this.sessions.revokeAllInTx(tx, actor, user.id, 'PASSWORD_CHANGED');
      await this.audit.recordInTx(tx, actor, { action: 'PASSWORD_RESET_COMPLETED', targetType: 'USER', targetId: user.id, metadata: { revokedSessions: n } });
      await this.mail.enqueueInTx(tx, actor, {
        kind: 'SECURITY_ALERT', recipientUserId: user.id, toAddress: locked.email, dedupeKey: `password-reset-done:${tok.id}`,
        payload: { event: 'PASSWORD_RESET' }, expiresInSeconds: 86_400 });
      return n;
    });
    if (revoked === null) throw new ApiError(400, 'RESET_TOKEN_INVALID');
  }
}
```

`validateNewPassword` normalise lui-même (NFKC) et renvoie `pw.normalized`.

Contrôleur :

```ts
  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body(new ZodPipe(ForgotPasswordBody)) body: ForgotPasswordBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ status: 'RESET_REQUESTED' }> {
    reply.header('referrer-policy', 'no-referrer');
    await this.reset.request({ kind: 'anonymous', ip: req.ip }, body, clientContextOf(req));
    return { status: 'RESET_REQUESTED' };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(204)
  async resetPassword(@Body(new ZodPipe(ResetPasswordBody)) body: ResetPasswordBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    reply.header('referrer-policy', 'no-referrer');
    await this.reset.reset({ kind: 'anonymous', ip: req.ip }, body);
  }
```

Enregistrer `PasswordResetRepository` et `PasswordResetService` dans `AuthModule`. (Le service est nommé `PasswordResetService` ; dans le contrôleur le champ injecté s'appelle `reset`.)

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project integration apps/api/test/integration/password-reset.int.spec.ts apps/api/test/integration/routes-meta.int.spec.ts apps/api/test/integration/account.int.spec.ts apps/api/test/integration/auth-register.int.spec.ts` ; `pnpm typecheck` ; `pnpm lint` ; `pnpm depcruise` — Expected : PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/api
git commit -m "feat(auth): mot de passe oublié — demande avec Turnstile, jeton à usage unique, réinitialisation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 15 : Reports du lot 1a — préchauffage de `verifyDummy`, rejets Turnstile comptés, changement de mot de passe d'un administrateur

**Files :**
- Modify : `apps/api/src/modules/users/password-hasher.ts`, `apps/api/src/modules/auth/login-rate-limiter.ts`, `apps/api/src/modules/auth/auth.service.ts`
- Test : `apps/api/src/modules/users/password-hasher.spec.ts` (étendre), `apps/api/test/integration/rate-limit.int.spec.ts` (étendre), `apps/api/test/integration/account.int.spec.ts` (étendre)

**Interfaces :**
- Produces : `PasswordHasher implements OnApplicationBootstrap` (`onApplicationBootstrap(): Promise<void>`) ; `LoginRateLimiter.recordTurnstileRejection(keys: LoginKeys): Promise<void>`.

- [ ] **Step 1 : Écrire les tests (échouent)**

Dans `password-hasher.spec.ts` :

```ts
describe('préchauffage (report R14 du lot 1a)', () => {
  it('le démarrage calcule le hachage factice une fois : la première connexion d’un email inconnu n’est plus plus lente', async () => {
    const h = new PasswordHasher();
    expect((h as unknown as { dummyHash?: Promise<string> }).dummyHash).toBeUndefined();
    await h.onApplicationBootstrap();
    expect((h as unknown as { dummyHash?: Promise<string> }).dummyHash).toBeDefined();
    const before = (h as unknown as { dummyHash: Promise<string> }).dummyHash;
    await h.verifyDummy('x'.repeat(16));
    expect((h as unknown as { dummyHash: Promise<string> }).dummyHash).toBe(before); // pas recalculé
  });
});
```

Dans `rate-limit.int.spec.ts` (réutiliser ses aides de construction du limiteur ; `limiter` = `LoginRateLimiter` du module de test, `keys` = `limiter.keys(ip, email)`) :

```ts
  it('les rejets TURNSTILE_REQUIRED comptent pour l’alerte des 50 échecs par IP (report du lot 1a)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const keys = limiter.keys('198.51.100.200', 'alerte@example.com');
    await limiter.check(keys, false); // crée le seau de l'IP
    for (let i = 0; i < 50; i++) await limiter.recordTurnstileRejection(keys);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('login failures above'))).toHaveLength(0);
    await limiter.recordTurnstileRejection(keys); // le 51ᵉ franchit le seuil
    expect(warn.mock.calls.filter(([m]) => String(m).includes('login failures above'))).toHaveLength(1);
    await limiter.recordTurnstileRejection(keys); // une seule alerte par fenêtre
    expect(warn.mock.calls.filter(([m]) => String(m).includes('login failures above'))).toHaveLength(1);
    warn.mockRestore();
  });
  it('un rejet TURNSTILE_REQUIRED à la connexion incrémente les échecs du seau de l’IP', async () => {
    const ip = '198.51.100.201';
    const email = 'turnstile.count@example.com';
    for (let i = 0; i < 3; i++) await send(t.app, 'POST', '/api/auth/login', { email, password: 'mauvais mot de passe long' }, {}, ip);
    const before = (await rows(`select failures from app.rate_limit_buckets where key = $1`, [`ip:${ip}`]))[0].failures as number;
    const res = await send(t.app, 'POST', '/api/auth/login', { email, password: 'mauvais mot de passe long' }, {}, ip); // Turnstile exigé, absent
    expect(res.json().error.code).toBe('TURNSTILE_REQUIRED');
    expect((await rows(`select failures from app.rate_limit_buckets where key = $1`, [`ip:${ip}`]))[0].failures).toBe(before + 1);
  });
```

Dans `account.int.spec.ts` : cas « un administrateur change son mot de passe sans vérification supplémentaire (R16) » : `loginAdmin` ; `POST /api/me/password` avec le mot de passe actuel et un nouveau de 16 caractères au moins → `204` ; ses autres sessions sont révoquées (`PASSWORD_CHANGED`) ; un nouveau mot de passe de 15 caractères est refusé (`PASSWORD_TOO_SHORT`).

Run : `pnpm vitest run --project unit apps/api/src/modules/users/password-hasher.spec.ts` puis `pnpm vitest run --project integration apps/api/test/integration/rate-limit.int.spec.ts apps/api/test/integration/account.int.spec.ts` — Expected : FAIL (`onApplicationBootstrap is not a function`, `recordTurnstileRejection is not a function`) ; le cas d'administrateur peut passer d'emblée (il documente R16).

- [ ] **Step 2 : Implémenter**

`password-hasher.ts` : `export class PasswordHasher implements OnApplicationBootstrap` (import de `OnApplicationBootstrap` depuis `@nestjs/common`) et

```ts
  /** Report du lot 1a : le hachage factice est prêt avant la première requête (aucun écart de durée à la première connexion inconnue). */
  async onApplicationBootstrap(): Promise<void> {
    await this.verifyDummy('warm-up');
  }
```

`login-rate-limiter.ts` : extraire de `recordFailure` la partie « échec par IP + alerte » en méthode privée `countIpFailure(keys)` et ajouter

```ts
  /** Un rejet « Turnstile exigé » est un échec d'IP comme un mauvais mot de passe (§ 3.2, alerte au-delà de 50 en 15 min). */
  async recordTurnstileRejection(keys: LoginKeys): Promise<void> {
    await this.countIpFailure(keys);
  }

  private async countIpFailure(keys: LoginKeys): Promise<void> {
    const ipFailures = await this.repo.addIpFailure(keys.ipKey);
    if (ipFailures === IP_ALERT_FAILURES + 1) this.logger.warn(`alert: login failures above ${IP_ALERT_FAILURES} for ${keys.ipKey} in 15 min`);
  }
```

(`recordFailure` appelle `countIpFailure` à la place de ses deux lignes d'origine.) `auth.service.ts`, dans `login`, avant chacun des deux `throw new ApiError(401, 'TURNSTILE_REQUIRED', …)` : `await this.limiter.recordTurnstileRejection(keys);`.

- [ ] **Step 3 : Vérifier**

Run : `pnpm vitest run --project unit apps/api/src/modules/users` ; `pnpm vitest run --project integration apps/api/test/integration/rate-limit.int.spec.ts apps/api/test/integration/account.int.spec.ts apps/api/test/integration/auth-login.int.spec.ts` ; `pnpm typecheck` ; `pnpm lint` — Expected : PASS.

- [ ] **Step 4 : Commit**

```bash
git add apps/api
git commit -m "fix(auth): préchauffage du hachage factice, rejets Turnstile comptés pour l'alerte par IP

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 16 : Suite de sécurité « administrateurs et emails », méta-test des routes, README, vérification finale

**Files :**
- Modify : `apps/api/test/integration/routes-meta.int.spec.ts` (vérification qu'aucune route du lot 1b n'est oubliée), `README.md`
- Test : `apps/api/test/integration/security-admin.int.spec.ts`

**Interfaces :**
- Consumes : tout ce qui précède.

- [ ] **Step 1 : Écrire la suite (échoue tant qu'une tâche précédente est incomplète)**

`apps/api/test/integration/security-admin.int.spec.ts` :

```ts
import 'reflect-metadata';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUDIT_METADATA } from '../../src/modules/audit/audit-actions.js';
import { EMAIL_KINDS, SECURITY_KINDS } from '../../src/modules/mail/email-kinds.js';
import { TEST_OTP_PEPPER, TEST_OUTBOX_KEY, buildTestApp, insertClass, registerStudent, send, type TestApp } from '../support/app.js';
import { cipher, seedChallengeEmail, SYSTEM } from '../support/mail.js';
import { ageChallenges, createAdmin, latestCode, loginAdmin } from '../support/second-factor.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
const logged: string[] = [];
beforeAll(async () => {
  db = await createTestDatabase();
  const sink = new Writable({ write(chunk, _enc, cb) { logged.push(String(chunk)); cb(); } });
  t = await buildTestApp(db, { logStream: sink });
});
afterAll(async () => { await t.close(); });
async function rows(sql: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}
const setCookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie']].flat().filter((c): c is string => typeof c === 'string');

describe('aucun secret dans les journaux, les métadonnées d’audit ni les colonnes en clair', () => {
  it('codes, jetons, cookies, HMAC et clés ne figurent nulle part après un parcours complet', async () => {
    const secrets: string[] = [TEST_OTP_PEPPER, TEST_OUTBOX_KEY.toString('hex')];
    const a = await createAdmin(db);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
    const challengeToken = /__Host-cp_challenge=([^;]+)/.exec(setCookies(login)[0]!)![1]!;
    const code = await latestCode(db, a.email);
    secrets.push(code, challengeToken);
    const verified = await send(t.app, 'POST', '/api/auth/verify-code', { code }, { cookie: `__Host-cp_challenge=${challengeToken}` });
    const session = /__Host-cp_session=([^;]+)/.exec(setCookies(verified).find((c) => c.startsWith('__Host-cp_session='))!)![1]!;
    secrets.push(session);
    await send(t.app, 'POST', '/api/auth/verify-code', { code: '999999' }, { cookie: `__Host-cp_challenge=${challengeToken}` });
    // réinitialisation de mot de passe
    const classId = await insertClass(db, 'L3 Security Admin');
    const s = await registerStudent(t.app, classId);
    await send(t.app, 'POST', '/api/auth/forgot-password', { email: s.email, turnstileToken: 'tok' });
    const [mail] = await rows(`select id, payload_encrypted from app.email_outbox where kind = 'PASSWORD_RESET' and to_address = $1`, [s.email]);
    const resetToken = cipher.decrypt(mail.id, mail.payload_encrypted).token!;
    secrets.push(resetToken);
    await send(t.app, 'POST', '/api/auth/reset-password', { token: resetToken, newPassword: 'un tout nouveau mot de passe 2026' });
    // ce que la base garde en clair
    const [ch] = await rows(`select encode(code_hmac, 'hex') as h from app.auth_challenges where user_id = $1 limit 1`, [a.id]);
    secrets.push(ch.h);
    const visible = [
      logged.join('\n'),
      JSON.stringify(await rows('select metadata from app.audit_log')),
      JSON.stringify(await rows('select payload, to_address, dedupe_key, message_id from app.email_outbox')),
      JSON.stringify(await rows('select smtp_response, error_code from app.email_attempts')),
    ].join('\n');
    for (const secret of secrets) expect(visible, `fuite de ${secret.slice(0, 4)}…`).not.toContain(secret);
  });
  it('un email dans un état final n’a plus de contenu chiffré', async () => {
    expect(await rows(`select 1 from app.email_outbox where status in ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED') and payload_encrypted is not null`)).toHaveLength(0);
  });
  it('les journaux du worker ne contiennent ni adresse ni contenu', async () => {
    const lines: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(Logger.prototype, m).mockImplementation((msg: unknown) => { lines.push(String(msg)); }));
    const { EmailSender } = await import('../../src/modules/mail/email-sender.js');
    const { MailWorkerModule } = await import('../../src/modules/mail/mail-worker.module.js');
    const { MailTransport } = await import('../../src/modules/mail/mail-transport.js');
    const { Test } = await import('@nestjs/testing');
    const { ConfigModule } = await import('../../src/config/config.module.js');
    const { DatabaseModule } = await import('../../src/database/database.module.js');
    const { AuthzModule } = await import('../../src/modules/authz/authz.module.js');
    const { testConfig, workerConfigFor } = await import('../support/app.js');
    class Accepting extends MailTransport { async send() { return { kind: 'ACCEPTED' as const, smtpCode: 250, response: '250 OK dest', errorCode: null }; } }
    const mod = await Test.createTestingModule({ imports: [ConfigModule.forRoot(testConfig(db)), DatabaseModule, AuthzModule, MailWorkerModule.register(workerConfigFor(db), new Accepting())] }).compile();
    await mod.init();
    const seeded = await seedChallengeEmail(db, '424242');
    await mod.get(EmailSender).drain(SYSTEM, new AbortController().signal);
    await mod.close();
    for (const s of spies) s.mockRestore();
    const all = lines.join('\n');
    expect(all).toContain(seeded.emailId);
    expect(all).not.toContain(seeded.email);
    expect(all).not.toContain('424242');
  });
});

describe('cookies du lot 1b : attributs exacts', () => {
  it('session d’administrateur, vérification et effacement', async () => {
    const a = await createAdmin(db);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
    const challenge = setCookies(login).find((c) => c.startsWith('__Host-cp_challenge='))!;
    expect(challenge).toMatch(/^__Host-cp_challenge=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=600$/);
    const res = await send(t.app, 'POST', '/api/auth/verify-code', { code: await latestCode(db, a.email) }, { cookie: challenge.split(';')[0]! });
    const cookies = setCookies(res);
    expect(cookies.find((c) => c.startsWith('__Host-cp_session='))).toMatch(/^__Host-cp_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$/);
    expect(cookies).toContain('__Host-cp_challenge=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    for (const c of cookies) expect(c).not.toMatch(/Domain=/i);
  });
});

describe('un administrateur n’obtient jamais de session sans code', () => {
  it('ni par la connexion, ni par le renvoi, ni avec un code de forme valide mais inconnu', async () => {
    const a = await createAdmin(db);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
    expect(setCookies(login).some((c) => c.startsWith('__Host-cp_session='))).toBe(false);
    const header = { cookie: setCookies(login)[0]!.split(';')[0]! };
    await ageChallenges(db, a.id, 2);
    const resend = await send(t.app, 'POST', '/api/auth/resend-code', {}, header);
    expect(setCookies(resend).some((c) => c.startsWith('__Host-cp_session='))).toBe(false);
    expect((await send(t.app, 'POST', '/api/auth/verify-code', { code: '000000' }, { cookie: setCookies(resend)[0]!.split(';')[0]! })).statusCode).toBe(400);
    expect(await rows(`select 1 from app.sessions where user_id = $1`, [a.id])).toHaveLength(0);
  });
  it('« aucune option ne désactive la vérification » : le service d’emails n’a aucune influence sur l’accès', async () => {
    const a = await createAdmin(db);
    const login = await send(t.app, 'POST', '/api/auth/login', { email: a.email, password: a.password });
    expect(login.statusCode).toBe(202);
    expect((await rows(`select status from app.email_outbox where recipient_user_id = $1`, [a.id]))[0].status).toBe('PENDING'); // aucun worker
    expect((await send(t.app, 'GET', '/api/me')).statusCode).toBe(401);
  });
});

describe('contrat avec le lot 1c : codes d’erreur stables (R4)', () => {
  it('l’ensemble des codes levés par les modules d’authentification est celui que le web traduira', () => {
    const dir = resolve(import.meta.dirname, '../../src/modules');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p); } };
    walk(resolve(dir, 'auth'));
    const found = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/new ApiError\(\d{3}, '([A-Z_]+)'/g)) found.add(m[1]!);
    for (const m of readFileSync(resolve(dir, 'auth/second-factor/second-factor.service.ts'), 'utf8').matchAll(/new ApiError\(\d{3}, '([A-Z_]+)'/g)) found.add(m[1]!);
    expect([...found].sort()).toEqual([
      'CHALLENGE_EXPIRED', 'CODE_INVALID', 'CODE_LOCKED', 'CURRENT_PASSWORD_INVALID', 'EMAIL_TAKEN', 'EMAIL_UNCHANGED', 'INVALID_CREDENTIALS',
      'REAUTH_REQUIRED', 'RESET_TOKEN_INVALID', 'RESET_UNAVAILABLE', 'SECOND_FACTOR_BLOCKED', 'SIGNUP_UNAVAILABLE', 'STEP_UP_REQUIRED',
      'TOO_MANY_ATTEMPTS', 'TOO_MANY_CODE_REQUESTS', 'TURNSTILE_FAILED', 'TURNSTILE_REQUIRED', 'UNAUTHENTICATED', 'ACCOUNT_SUSPENDED',
    ].sort());
  });
});

describe('cohérence entre le code et la base', () => {
  it('chaque action d’audit de l’application existe dans l’énumération SQL, et aucune action privilégiée n’est déclarée côté application', async () => {
    const c = await connectAs('cp_app', db);
    const r = await c.query(`select unnest(enum_range(null::app.audit_action))::text as v`);
    await c.end();
    const sql = new Set(r.rows.map((x) => x.v as string));
    for (const action of Object.keys(AUDIT_METADATA)) expect(sql.has(action), action).toBe(true);
    for (const reserved of ['ACCOUNT_ANONYMIZED', 'ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'DATABASE_RESTORED']) expect(Object.keys(AUDIT_METADATA)).not.toContain(reserved);
  });
  it('les types d’email du code sont ceux de l’énumération SQL ; les types de sécurité en sont un sous-ensemble', async () => {
    const c = await connectAs('cp_app', db);
    const r = await c.query(`select unnest(enum_range(null::app.email_kind))::text as v`);
    await c.end();
    expect(r.rows.map((x) => x.v as string).sort()).toEqual([...EMAIL_KINDS].sort());
    for (const k of SECURITY_KINDS) expect(EMAIL_KINDS).toContain(k);
  });
});
```

Dans `routes-meta.int.spec.ts`, la table `EXPECTED_ROUTES` doit maintenant compter **exactement** les routes du lot 1a et celles du lot 1b : `verify-code`, `resend-code`, `verify-recovery`, `forgot-password`, `reset-password` (publiques) ; `me/reauth`, `me/step-up`, `me/step-up/verify`, `me/email-change`, `me/email-change/verify-old`, `me/email-change/verify-new` (non publiques) ; `VALID_BODY` a une entrée par route modifiante (le test existant « chaque route modifiante a un corps valide déclaré » le garantit). Ajouter un test : une route modifiante publique avec cookie de vérification répond `400 CHALLENGE_EXPIRED` (pas `401`, pas `500`) quand le cookie est absent : `verify-code`, `resend-code`, `verify-recovery`.

```ts
  it.each(['/api/auth/verify-code', '/api/auth/verify-recovery', '/api/auth/resend-code'])('%s sans cookie de vérification : 400 CHALLENGE_EXPIRED', async (url) => {
    const body = url.endsWith('resend-code') ? {} : url.endsWith('verify-code') ? { code: '123456' } : { recoveryCode: 'ABCD-EFGH-JKMN' };
    const res = await send(t.app, 'POST', url, body);
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'CHALLENGE_EXPIRED']);
  });
```

Run : `pnpm vitest run --project integration apps/api/test/integration/security-admin.int.spec.ts apps/api/test/integration/routes-meta.int.spec.ts` — Expected : PASS si les tâches 1 à 15 sont complètes (sinon la liste des codes d'erreur ou des routes dit exactement ce qui manque).

- [ ] **Step 2 : README**

Compléter le README : (1) section « Parcours administrateur en développement » : démarrer Mailpit, l'API et le worker, puis une série de `curl` (avec `-H 'Origin: https://app.test'`, `-H 'content-type: application/json'`, `-c`/`-b` pour les cookies — en HTTP local les cookies `__Host-`/`Secure` exigent `curl --insecure` derrière un proxy TLS local ou le test `inject()` ; documenter la variante qui marche : les tests d'intégration) pour : connexion → code lu dans Mailpit (http://127.0.0.1:8025) → `verify-code` ; (2) table des variables d'environnement par service (API : `OTP_PEPPER_FILE`, `OUTBOX_PAYLOAD_KEY_FILE` ; worker : `OUTBOX_PAYLOAD_KEY_FILE`, `SMTP_*`, `MAIL_FROM`, `APP_ORIGIN` ; ops : `OTP_PEPPER_FILE`, `DB_USER=cp_ops`) ; (3) rappel des limites documentées (§ 3.3) : le second facteur dépend de la sécurité de la boîte email, une adresse dédiée protégée par une double authentification est recommandée ; (4) la liste des codes d'erreur du lot 1b pour le lot 1c.

- [ ] **Step 3 : Vérification finale**

```bash
export PATH=/c/Users/bmd/bin:$PATH
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:cov
pnpm depcruise
pnpm test:int
pnpm test:int
pnpm audit --audit-level high
```

Expected : tout est vert ; `test:int` est lancé deux fois (les tests de concurrence ne doivent pas être instables) ; la couverture de `packages/shared` et de `authz` reste ≥ 90 %. Puis la passe manuelle de bout en bout : Mailpit + API + worker, création d'un administrateur (`pnpm --filter @classepulse/api cli create-admin …`), connexion, lecture du code dans Mailpit, `verify-code`, étape de vérification supplémentaire, `ops admin-recovery-code` depuis un vrai terminal. Noter le résultat dans le message du commit.

- [ ] **Step 4 : Commit**

```bash
git add apps/api README.md
git commit -m "test(sécurité): suite « administrateurs et emails », méta-test des routes du lot 1b, README

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Contrat pour le lot 1c (rappel des routes et des codes)

| Route | Corps | Succès | Erreurs notables |
|---|---|---|---|
| `POST /api/auth/login` (administrateur) | `{ email, password, turnstileToken? }` | `202` `{ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds, resendAfterSeconds }` + cookie `__Host-cp_challenge` | `401 INVALID_CREDENTIALS` (`turnstileRequired`), `401 TURNSTILE_REQUIRED`, `403 ACCOUNT_SUSPENDED`, `403 SECOND_FACTOR_BLOCKED`, `429 TOO_MANY_ATTEMPTS`, `429 TOO_MANY_CODE_REQUESTS` |
| `POST /api/auth/verify-code` | `{ code }` | `200` profil + session | `400 CODE_INVALID` (`attemptsLeft`), `400 CODE_LOCKED`, `400 CHALLENGE_EXPIRED`, `403 SECOND_FACTOR_BLOCKED`, `429` |
| `POST /api/auth/resend-code` | `{}` | `202` | `400 CHALLENGE_EXPIRED`, `429 TOO_MANY_CODE_REQUESTS` (`Retry-After`) |
| `POST /api/auth/verify-recovery` | `{ recoveryCode }` | `200` profil + session | comme `verify-code` |
| `POST /api/auth/forgot-password` | `{ email, turnstileToken }` | `202` `{ status: 'RESET_REQUESTED' }` (toujours) | `400 TURNSTILE_FAILED`, `503 RESET_UNAVAILABLE`, `429` |
| `POST /api/auth/reset-password` | `{ token, newPassword }` | `204` | `400 RESET_TOKEN_INVALID`, codes de politique de mot de passe |
| `POST /api/me/reauth` | `{ password }` | `204` | `400 CURRENT_PASSWORD_INVALID`, `429` |
| `POST /api/me/step-up` ; `/verify` | `{ password }` ; `{ code }` | `202` `{ expiresInSeconds }` ; `204` | `403 FORBIDDEN` (étudiant), `400 CODE_INVALID`, `400 CHALLENGE_EXPIRED` |
| `POST /api/me/email-change` ; `/verify-old` ; `/verify-new` | `{ password, newEmail }` ; `{ code }` ; `{ code }` | `202` ; `202` ; `200` profil | `400 EMAIL_UNCHANGED`, `409 EMAIL_TAKEN`, `400 CHALLENGE_EXPIRED` |

Gardes que le lot 2 appelle dans la transaction de l'action sensible : `StepUpService.assertStepUpFreshInTx` (`403 STEP_UP_REQUIRED`, `missing: 'PASSWORD' | 'CODE'`) et `assertRecentPasswordInTx` (`403 REAUTH_REQUIRED`).

## Couverture de la spec (auto-relecture)

| Exigence | Tâche |
|---|---|
| § 2.2 `email_outbox`, `email_attempts`, `auth_challenges`, `second_factor_failures`, `password_reset_tokens`, colonnes de session | 3, 4 |
| § 2.4 états, transitions (trigger), réservation en une instruction, bail expiré, ambigu, annulation en cours d'envoi, `ACCEPTED`, chiffrement effacé | 4, 5, 6, 8 |
| § 1.4 baux, `NOTIFY`, arrêt en 30 s, rattrapage au démarrage | 8 |
| § 3.3 code, HMAC, limites, échecs, alertes, blocage, cookie, file d'emails, contrôle avant envoi | 4, 6, 8, 9, 10 |
| § 3.3 récupération (`priv.issue_admin_recovery_code`, `ops`, `verify-recovery`, confidentialité) | 11 |
| § 3.3 changement d'email, vérification supplémentaire | 12, 13 |
| § 3.2 mot de passe oublié | 14 |
| § 3.4 sessions d'administrateur (30 min, 8 h), révocations `EMAIL_CHANGED` et `PASSWORD_CHANGED` | 10, 13, 14 |
| § 2.5 audit (nouvelles actions, source `PRIVILEGED` sous `cp_ops`) | 3, 9, 10, 11, 13, 14 |
| Reports du lot 1a (R14 purge des seaux, préchauffage, rejets Turnstile comptés, Turnstile sur changement de mot de passe) | 8, 15 |
| Review Focus 1 à 6 | 1 et 10 ; 9 et 10 ; 10 ; 8 et 10 ; 14 ; 13 et 6 |

Points laissés à la décision du responsable (voir les Rulings marqués « À signaler ») : R2 (forme des vérifications liées à une session), R3 (blocage persistant), R6 (fournisseur d'emails et domaine d'expédition de production), R7 (clé anti-doublon des alertes), R9 (seuils de « mot de passe oublié »).
