# ClassePulse V2 — Lot 1a : API identité — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** une API qui permet de s'inscrire (compte + demande d'adhésion à une classe active, en une transaction), de se connecter et de se déconnecter avec une session par cookie, de gérer son profil, ses préférences, son mot de passe et ses sessions, avec CSRF, limitations (base + mémoire), Turnstile et mode dégradé, journal d'audit, matrice d'autorisation, et les commandes `create-admin` et `create-class`.

**Architecture :** modules NestJS sous `apps/api/src/modules/<domaine>/` (`authz`, `audit`, `users`, `classes`, `memberships`, `auth`). Seuls les `*.repository.ts` importent Prisma. Une fabrique `buildApiApp()` (`src/http/app.ts`) monte Fastify (identifiant de requête, filtre d'erreurs, CSRF, cookies, limite de corps) pour `main.ts` **et** pour les tests (`app.inject()`). Un garde de session global refuse par défaut ; les routes publiques sont marquées `@Public()`. Les règles métier pures et les schémas Zod partagés sont dans `packages/shared`.

**Tech Stack :** NestJS 12 + Fastify 5, Prisma 7.10.0 (adaptateur pg), PostgreSQL 18, Zod 4, `@node-rs/argon2`, `@fastify/cookie`, `@nestjs/throttler`, `uuid` (v7), Vitest + fast-check + `@vitest/coverage-v8`, Testcontainers.

**Spec :** `docs/superpowers/specs/2026-10-13-classepulse-v2-design.md` (§ 0.2, § 0.3, § 0.7, § 1.2, § 1.3, § 2.1, § 2.2 « Identité et sessions » et « Classes et appartenances », § 2.5, § 2.7, § 3.1, § 3.2, § 3.4, § 3.5, § 5.3, § 5.4) et `docs/superpowers/specs/2026-10-13-classepulse-v2-ux-design.md` (§ 2 P1, P2, P10 ; § 3.2 codes d'erreur). Feuille de route : `docs/superpowers/plans/2026-10-13-classepulse-v2-roadmap.md` (« Décisions du responsable sur le lot 1 »). Référence fonctionnelle : `classpulse/docs/classepulse-v2/README.md` (F-002 à F-013, F-028).

## Global Constraints

- Toutes les dépendances en **version exacte** (`pnpm add -E`), `pnpm-lock.yaml` committé ; `pnpm audit --audit-level high` reste vert.
- **Seuls les `*.repository.ts` importent Prisma** (plus `src/database/`) ; un module n'importe jamais le repository d'un autre (dependency-cruiser).
- **Chaque méthode publique d'un service métier prend un `Actor`** et commence par `authz.assert(actor, action)` (§ 1.2, règle 6).
- Identifiants **UUID v7 générés par l'application** ; seul `audit_log.id` est un `bigint` auto-incrémenté.
- Email : forme normalisée par `normalizeEmail` = **suppression des espaces au début et à la fin, puis NFKC, puis minuscules** ; emails **ASCII uniquement** ; colonne `citext`.
- Mots de passe : **15 caractères minimum (USER), 16 (ADMIN), 128 au maximum, refus au-delà, jamais de troncature** ; aucune règle de composition ; **NFKC** identique dans tous les parcours ; refus des mots de passe courants (liste locale) ; **Argon2id : 19 Mio, 2 itérations, parallélisme 1, au plus 4 calculs simultanés**.
- Connexion : **message d'erreur identique** dans tous les cas ; **hachage factice** si l'email est inconnu ; la suspension n'est signalée **qu'après un mot de passe correct**.
- Limitation de la connexion : **100 par IP sur 15 min** ; **5 par couple IP + compte sur 15 min avec délai croissant** ; **Turnstile après 3 échecs** sur un couple IP + compte ; **un compte n'est jamais bloqué** quelle que soit l'IP ; alerte d'exploitation **au-delà de 50 échecs d'une IP en 15 min** ; clés `ip:<préfixe>` (/64 en IPv6) et `ip+acct:<préfixe>:<HMAC(email normalisé)>` ; au-delà de **50 000 lignes**, seule la limite par IP s'applique, avec alerte.
- Turnstile **exigé à l'inscription** ; **indisponible** après 3 échecs consécutifs ou un délai de 3 s dépassé : connexion avec limites réduites à **5 par IP et 2 par couple IP + compte** et alerte ; **inscription refusée temporairement**.
- Cookie de session : `__Host-cp_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sans `Domain`), jeton de **32 octets**, seul son **SHA-256** est stocké ; `Max-Age` **30 jours** (étudiant) ; une session invalide donne **`401` avec effacement du cookie aux mêmes attributs** ; `last_seen_at` mis à jour **au plus toutes les 5 min** ; nouveau jeton à chaque connexion.
- Révocation : **logique** (`revoked_at`, `revoke_reason`) ; motifs LOGOUT, PASSWORD_CHANGED, ROLE_CHANGED, SUSPENDED, ANONYMIZED, EMAIL_CHANGED, ADMIN_REVOKED, OTHER_DEVICES, RESTORE.
- Expirations de sécurité comparées à **`clock_timestamp()`**, jamais à `now()`.
- CSRF (refus par défaut, toute requête qui modifie) : `Origin` égal à l'origine → acceptée ; `Origin` différent ou `null` → `403` ; `Origin` absent et `Sec-Fetch-Site: same-origin` → acceptée ; `Origin` absent et autre valeur ou absent → `403`. **Seul `application/json`** est accepté ; aucune requête `GET` ne modifie de données. **Aucun CORS applicatif.**
- Validation : Zod, **champs inconnus rejetés**, UUID validés, **corps de 100 Ko au plus**. Un DTO de sortie explicite par point d'API. **Pas de trace d'exécution** dans les erreurs, un **`request_id`** dans chaque réponse.
- Limitation générale `@nestjs/throttler` en mémoire : **300 requêtes par minute par session et 600 par IP** ; dépassement → `429` avec `Retry-After`.
- Journaux pino JSON, masquage des cookies, en-têtes d'autorisation, mots de passe, jetons et codes.
- Audit : `cp_app` n'a que `INSERT` et `SELECT` ; `audit_log_guard` remplit `source`, `occurred_at = now()`, `db_login_role = session_user` ; **liste fermée** d'actions ; métadonnées **objet JSON ≤ 4 Ko, un schéma Zod par action** ; **interdit** : contenus, URL, noms, emails, IP, secrets. Actions réservées à `PRIVILEGED` : ACCOUNT_ANONYMIZED, NOTIFICATIONS_PURGED, CHAT_PURGED, ADMIN_RECOVERY_CODE_ISSUED, ADMIN_SECOND_FACTOR_BLOCK_CLEARED, DATABASE_RESTORED.
- Ordre global des verrous : `role_guard` → `classes` → `users` → `class_memberships` → `enrollment_requests` → … → `sessions`. `classes` et `users` jamais en `FOR UPDATE` (seulement `FOR NO KEY UPDATE` ou `FOR SHARE`).
- `CHECK` à plusieurs cas toujours écrits « (cas A complet) OR (cas B complet) ».
- Migrations : en-tête `-- classification: expand|contract|irreversible`, `BEGIN;` / `COMMIT;` explicites ; droits **table par table et colonne par colonne** pour `cp_app`, **jamais `DELETE`** sur `users`.
- Tests applicatifs sous **`cp_app`**, jamais en superutilisateur (sauf initialisation du conteneur) ; le temps : on **modifie les données** plutôt que d'avancer l'horloge pour les contrôles en base.
- **Matrice d'autorisation générée, testée à 100 %** ; couverture **≥ 90 %** sur `packages/shared` et `authz`.
- Textes destinés aux personnes : **français, tutoiement** ; les codes d'erreur de l'API sont des identifiants stables en anglais (`INVALID_CREDENTIALS`), traduits par le web (lot 1c).

## Review Focus

1. **Email saisi avec des variantes** (espaces autour, majuscules, caractères pleine largeur `ａｌｉｃｅ@…`, `ALICE@EXAMPLE.COM`) : même compte, même clé de limitation, refus « déjà utilisé » à l'inscription ; un email non ASCII après NFKC est refusé proprement (`400`), pas une erreur `500`. → tests en tâches 1 et 10.
2. **Mot de passe de 129 caractères ou plus, ou qui ne dépasse 128 qu'après NFKC** (`ﬃ` devient `ffi`) : refusé avec `400 PASSWORD_TOO_LONG`, jamais tronqué ni haché ; un mot de passe de 15 caractères dont la longueur ne vient que de caractères combinés compte en points de code après NFKC. → tests en tâche 1 et 6.
3. **Deux connexions ou inscriptions simultanées avec le même email** : une seule inscription aboutit, l'autre reçoit `409 EMAIL_TAKEN` (jamais `500`) ; deux `create-admin` simultanés ne créent qu'un administrateur. → tests en tâches 10 et 12.
4. **Cookie de session présent mais révoqué, expiré, ou d'un compte suspendu** : `401` avec effacement du cookie aux mêmes attributs, sur toute route protégée, y compris `POST` ; l'ancien cookie ne redevient jamais valide. → tests en tâches 7 et 13.
5. **Corps JSON invalide, trop gros (> 100 Ko), mauvais `Content-Type`, champ inconnu** : réponse `400`/`413`/`415` au format commun `{ error: { code }, requestId }`, sans trace d'exécution ni écho de la valeur saisie. → tests en tâche 4.

## Rulings (décisions de rédaction, à relire par le responsable)

- **R1 — Acteur anonyme et acteur CLI.** La spec définit `Actor = UserActor | SystemActor`. Les parcours avant authentification (inscription, liste des classes actives, connexion) et les commandes en ligne (`create-admin`, `create-class`) ont besoin d'un acteur : ajout de `AnonymousActor` (`kind: 'anonymous'`) et `CliActor` (`kind: 'cli'`), chacun autorisé seulement pour les actions que la matrice lui ouvre. `SystemActor` arrive avec `jobs` (lot 5). *Coût si faux : renommer deux types.*
- **R2 — Connexion d'un administrateur au lot 1a.** Le code par email n'existe qu'au lot 1b. Au lot 1a, un administrateur au mot de passe correct reçoit `403 ADMIN_SECOND_FACTOR_REQUIRED` et **aucune session** ; le lot 1b remplace cette réponse par la vérification `LOGIN`. *Coût si faux : aucun, l'administrateur ne se connecte simplement pas avant 1b.*
- **R3 — L'inscription ouvre une session.** Après l'inscription, la personne est connectée « sans classe active » et voit l'écran d'état (UX § 1.1). *Coût si faux : supprimer l'appel de création de session dans `register`.*
- **R4 — Durée d'inactivité des étudiants.** La spec ne fixe que le `Max-Age` de 30 jours ; `idle_expires_at = absolute_expires_at = création + 30 jours`. Les 30 min / 8 h des administrateurs arrivent au lot 1b. *Coût si faux : une constante.*
- **R5 — Délai croissant.** Après le n-ième échec d'un couple IP + compte dans la fenêtre, la tentative suivante n'est permise qu'après `min(2^(n-1), 30)` secondes (`429` + `Retry-After`) ; le 6ᵉ essai de la fenêtre est refusé jusqu'à sa fin. *Coût si faux : une fonction pure.*
- **R6 — Ce qui compte.** Chaque tentative de connexion consomme le seau `ip:` ; seuls les **échecs** de mot de passe consomment le seau `ip+acct:` ; un succès efface le seau `ip+acct:`. Un mauvais mot de passe actuel lors d'un changement de mot de passe compte comme un échec du couple IP + compte. *Coût si faux : quelques lignes du limiteur.*
- **R7 — Retour de Turnstile.** En mode dégradé, nouvel essai du service 60 s après l'entrée en mode dégradé ; un succès le quitte. *Coût si faux : une constante.*
- **R8 — Création des classes au lot 1.** La spec prévoit la création par l'administrateur dans l'application (lot 2). Au lot 1, `create-class` en ligne de commande (sous `cp_app`) permet d'avoir des classes à choisir ; l'écran arrive au lot 2. Année scolaire au format `AAAA-AAAA` (deuxième année = première + 1). *Coût si faux : une contrainte `CHECK` à relâcher.*
- **R9 — Demande d'adhésion au lot 1.** Le trigger « demande valide » vérifie au lot 1 : utilisateur `USER` et `ACTIVE`, classe `ACTIVE`, délai de 24 h après un refus pour la même classe. « Pas déjà membre » est ajouté au lot 2 avec `class_memberships`. *Coût si faux : aucun, aucune appartenance n'existe avant le lot 2.*
- **R10 — Colonnes ajoutées plus tard.** `sessions.second_factor_at`, `second_factor_method`, `step_up_at` (lot 1b) ; colonnes de quota et `max_delegates` de `classes` (lots 2 et 3) ; compteurs de notifications sur `users` (lot 4) ; `bg_locked_*` (lot 7). Chaque ajout est une migration `expand`. *Coût si faux : aucun.*
- **R11 — Méta-test des routes.** Sans OpenAPI au lot 1a, la liste des routes vient d'un crochet Fastify `onRoute` ; le test échoue si une route n'est pas déclarée dans la table des attentes (publique ou non, modifiante ou non), et vérifie `401` (anonyme) et `403` (CSRF) pour chacune. *Coût si faux : remplacer la source de la liste au lot 2.*
- **R12 — Liste des mots de passe courants.** Construite à partir de SecLists (`Passwords/Common-Credentials/10-million-password-list-top-1000000.txt`, licence MIT), en ne gardant que les entrées de **15 caractères ou plus** après NFKC (les plus courtes sont déjà refusées par la longueur), en minuscules. *Coût si faux : changer de source.*
- **R13 — Primitive d'authentification sans acteur.** `UsersService.activeRoleOf(userId)` est la seule méthode publique d'un service sans `Actor` : c'est elle qui construit l'acteur à partir d'une session (tâche 7). *Coût si faux : la déplacer dans un service dédié.*
- **R14 — Purges reportées au worker.** La purge horaire de `rate_limit_buckets` (§ 2.2) et celle des sessions 7 jours après leur fin (§ 2.7) sont des traitements du worker : elles arrivent avec le processus worker au lot 1b (purge des seaux) et au lot 5 (sessions). En attendant, les seaux expirés sont réutilisés par leur clé et le plafond de 50 000 lignes reste appliqué. *Coût si faux : la table grossit en développement, sans effet sur les limites.*
- **R15 — Mot de passe actuel faux.** `POST /api/me/password` répond `400 CURRENT_PASSWORD_INVALID` et non `401` : un `401` ferait croire au navigateur que la session a expiré (UX § 3.2). *Coût si faux : un code d'erreur.*

---

## Structure des fichiers

```
packages/shared/
  package.json                      exports avec la condition « source »
  src/index.ts                      réexporte tout
  src/email.ts                      normalizeEmail, isAcceptedEmail
  src/password.ts                   normalizePassword, passwordLength, checkPasswordLength
  src/names.ts                      normalizeName
  src/identity-schemas.ts           schémas Zod des corps des routes d'identité
  src/*.spec.ts
apps/api/
  prisma/schema.prisma              modèles User, Session, Class, EnrollmentRequest, AuditLog
  prisma/migrations/20261014000000_identity/migration.sql
  prisma/migrations/20261014000100_classes_enrollment_audit/migration.sql
  src/main.ts                       démarre buildApiApp() + serveur 3001
  src/cli.ts                        create-admin, create-class
  src/config/config.schema.ts       + APP_ORIGIN, TRUST_PROXY, *_FILE de sécurité, seuils
  src/config/load-config.ts         + loadDbConfig, http, security, turnstile, limits
  src/http/app.ts                   buildApiApp(config, overrides)
  src/http/clock.ts                 Clock, SystemClock
  src/http/csrf.ts                  csrfDecision (fonction pure) + crochet Fastify
  src/http/errors.ts                ApiError, AllExceptionsFilter, gestionnaire Fastify
  src/http/zod.pipe.ts              ZodPipe
  src/http/public.decorator.ts      @Public()
  src/http/logger.ts                options pino (masquage)
  src/http/ip.ts                    ipPrefix
  src/http/routes.ts                registre des routes (méta-test)
  src/modules/authz/actor.ts        Actor, UserActor, AnonymousActor, CliActor
  src/modules/authz/matrix.ts       ACTIONS, MATRIX
  src/modules/authz/authz.service.ts  can, assert
  src/modules/authz/authz.module.ts
  src/modules/audit/audit-actions.ts  liste fermée + schémas Zod des métadonnées
  src/modules/audit/audit.repository.ts
  src/modules/audit/audit.service.ts  recordInTx
  src/modules/audit/audit.module.ts
  src/modules/users/users.repository.ts
  src/modules/users/users.service.ts
  src/modules/users/users.controller.ts   GET /api/me, PATCH profil et préférences
  src/modules/users/users.module.ts
  src/modules/classes/classes.repository.ts
  src/modules/classes/classes.service.ts
  src/modules/classes/classes.controller.ts  GET /api/classes/active
  src/modules/classes/classes.module.ts
  src/modules/memberships/memberships.repository.ts
  src/modules/memberships/memberships.service.ts
  src/modules/memberships/memberships.module.ts
  src/modules/auth/password-hasher.ts     Argon2id, sémaphore, hachage factice
  src/modules/auth/common-passwords.ts    chargement de la liste locale
  src/modules/auth/common-passwords.txt
  src/modules/auth/password-policy.ts     validateNewPassword
  src/modules/auth/session-cookie.ts      chaînes Set-Cookie exactes
  src/modules/auth/sessions.repository.ts
  src/modules/auth/sessions.service.ts
  src/modules/auth/session.guard.ts       garde global, @CurrentActor()
  src/modules/auth/rate-limit.repository.ts
  src/modules/auth/login-rate-limiter.ts
  src/modules/auth/turnstile.ts           TurnstileVerifier, HttpTurnstileVerifier, TurnstileGate
  src/modules/auth/auth.service.ts        register, login, logout, changePassword, sessions
  src/modules/auth/auth.controller.ts     /api/auth/*
  src/modules/auth/account.controller.ts  /api/me/password, /api/me/sessions*
  src/modules/auth/auth.module.ts
  test/support/app.ts                     testConfig, buildTestApp, FakeTurnstile, fixtures
  test/integration/identity-schema.int.spec.ts
  test/integration/audit.int.spec.ts
  test/integration/auth-register.int.spec.ts
  test/integration/auth-login.int.spec.ts
  test/integration/account.int.spec.ts
  test/integration/cli.int.spec.ts
  test/integration/security-auth.int.spec.ts
  test/integration/routes-meta.int.spec.ts
```

---

### Task 1 : `packages/shared` — email, mot de passe, noms, schémas

**Files :**
- Modify : `packages/shared/package.json`, `packages/shared/src/index.ts`, `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `vitest.config.ts`, `package.json`, `.github/workflows/rapide.yml`
- Create : `packages/shared/src/email.ts`, `packages/shared/src/password.ts`, `packages/shared/src/names.ts`, `packages/shared/src/identity-schemas.ts`
- Test : `packages/shared/src/email.spec.ts`, `packages/shared/src/password.spec.ts`, `packages/shared/src/names.spec.ts`, `packages/shared/src/identity-schemas.spec.ts`

**Interfaces :**
- Produces (depuis `@classepulse/shared`) :
  - `normalizeEmail(input: string): string` ; `isAcceptedEmail(normalized: string): boolean`
  - `PASSWORD_MIN = { USER: 15, ADMIN: 16 }`, `PASSWORD_MAX = 128`, `normalizePassword(p: string): string`, `passwordLength(p: string): number`, `checkPasswordLength(p: string, role: 'USER' | 'ADMIN'): 'TOO_SHORT' | 'TOO_LONG' | null`
  - `normalizeName(input: string): string`
  - schémas Zod `.strict()` : `RegisterBody`, `LoginBody`, `UpdateProfileBody`, `UpdatePreferencesBody`, `ChangePasswordBody` et leurs types `z.infer`

- [ ] **Step 1 : Dépendances et résolution « source »**

```bash
export PATH=/c/Users/bmd/bin:$PATH
pnpm --filter @classepulse/shared add -E zod@4.6.7
pnpm add -w -D -E fast-check @vitest/coverage-v8@5.0.4
pnpm --filter @classepulse/api add -E "@classepulse/shared@workspace:*"
```

`packages/shared/package.json` (remplace `main`) :

```json
{
  "name": "@classepulse/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "source": "./src/index.ts", "types": "./src/index.ts", "default": "./dist/index.js" }
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "tsc -p tsconfig.json --outDir dist"
  },
  "dependencies": { "zod": "4.6.7" }
}
```

La condition `source` sert au développement et aux tests (TypeScript lu directement) ; `default` (`dist/`) sert à l'image de production (lot 7). Ajouter la condition partout où le code est résolu :

- `apps/api/tsconfig.json` : `"compilerOptions": { "outDir": "dist", "lib": ["ES2024"], "customConditions": ["source"] }`
- `apps/api/vitest.config.ts` : `resolve: { conditions: ['source'] }` dans `defineConfig({...})`
- commandes `tsx` du README et de la CLI : `tsx --conditions=source …`

- [ ] **Step 2 : Écrire les tests (échouent)**

`packages/shared/src/email.spec.ts` :

```ts
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isAcceptedEmail, normalizeEmail } from './email.js';

describe('normalizeEmail (§ 2.1 : espaces, NFKC, minuscules)', () => {
  it.each([
    ['  Alice@Example.COM ', 'alice@example.com'],
    ['ＡＬＩＣＥ@example.com', 'alice@example.com'], // pleine largeur → ASCII par NFKC
    ['alice@example.com', 'alice@example.com'],
    ['\talice@example.com\n', 'alice@example.com'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });
  it('est idempotente', () => {
    fc.assert(fc.property(fc.string(), (s) => normalizeEmail(normalizeEmail(s)) === normalizeEmail(s)));
  });
});

describe('isAcceptedEmail (ASCII seulement au MVP)', () => {
  it.each(['alice@example.com', 'a.b+c@sub.example.sn', "o'brien@example.org"])('accepte %s', (e) => {
    expect(isAcceptedEmail(e)).toBe(true);
  });
  it.each(['', 'alice', 'alice@', '@example.com', 'alice@localhost', 'élise@example.com', 'alice@exämple.com', 'a b@example.com', `${'a'.repeat(250)}@example.com`])('refuse %j', (e) => {
    expect(isAcceptedEmail(e)).toBe(false);
  });
});
```

`packages/shared/src/password.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { PASSWORD_MAX, PASSWORD_MIN, checkPasswordLength, normalizePassword, passwordLength } from './password.js';

describe('mots de passe (§ 0.7)', () => {
  it('constantes', () => {
    expect(PASSWORD_MIN).toEqual({ USER: 15, ADMIN: 16 });
    expect(PASSWORD_MAX).toBe(128);
  });
  it('NFKC : la ligature ﬃ devient ffi', () => {
    expect(normalizePassword('ﬃ')).toBe('ffi');
  });
  it('compte en points de code après NFKC (emoji = 1, é composé = 1)', () => {
    expect(passwordLength('😀')).toBe(1);
    expect(passwordLength('é')).toBe(1); // NFKC compose e + accent
  });
  it.each([
    ['a'.repeat(14), 'USER', 'TOO_SHORT'],
    ['a'.repeat(15), 'USER', null],
    ['a'.repeat(15), 'ADMIN', 'TOO_SHORT'],
    ['a'.repeat(16), 'ADMIN', null],
    ['a'.repeat(128), 'USER', null],
    ['a'.repeat(129), 'USER', 'TOO_LONG'],
    ['ﬃ'.repeat(43), 'USER', 'TOO_LONG'], // 43 caractères saisis, 129 après NFKC
  ] as const)('%j (%s) → %s', (p, role, expected) => {
    expect(checkPasswordLength(p, role)).toBe(expected);
  });
});
```

`packages/shared/src/names.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { normalizeName } from './names.js';

describe('normalizeName', () => {
  it('supprime les espaces autour et réduit les espaces internes', () => {
    expect(normalizeName('  Awa   Diop ')).toBe('Awa Diop');
  });
  it('applique NFC', () => {
    expect(normalizeName('Amélie')).toBe('Amélie');
  });
});
```

`packages/shared/src/identity-schemas.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { ChangePasswordBody, LoginBody, RegisterBody, UpdatePreferencesBody, UpdateProfileBody } from './identity-schemas.js';

const register = {
  firstName: 'Awa', lastName: 'Diop', email: ' Awa.Diop@Example.com ', password: 'une phrase de passe assez longue',
  classId: '0192b1c4-5d6e-7f80-9a1b-2c3d4e5f6a7b', turnstileToken: 'tok',
};

describe('schémas d’identité', () => {
  it('RegisterBody normalise l’email et le nom', () => {
    const r = RegisterBody.parse({ ...register, firstName: '  Awa ' });
    expect(r.email).toBe('awa.diop@example.com');
    expect(r.firstName).toBe('Awa');
  });
  it('refuse un champ inconnu', () => {
    expect(RegisterBody.safeParse({ ...register, role: 'ADMIN' }).success).toBe(false);
  });
  it('refuse un classId qui n’est pas un UUID', () => {
    expect(RegisterBody.safeParse({ ...register, classId: '1' }).success).toBe(false);
  });
  it('refuse un email non ASCII après normalisation', () => {
    expect(RegisterBody.safeParse({ ...register, email: 'élise@example.com' }).success).toBe(false);
  });
  it('refuse un nom de 1 ou de 81 caractères', () => {
    expect(RegisterBody.safeParse({ ...register, lastName: 'D' }).success).toBe(false);
    expect(RegisterBody.safeParse({ ...register, lastName: 'D'.repeat(81) }).success).toBe(false);
  });
  it('LoginBody : turnstileToken facultatif, mot de passe limité à 1024 caractères bruts', () => {
    expect(LoginBody.safeParse({ email: 'a@example.com', password: 'x' }).success).toBe(true);
    expect(LoginBody.safeParse({ email: 'a@example.com', password: 'x'.repeat(1025) }).success).toBe(false);
  });
  it('UpdatePreferencesBody exige au moins un champ', () => {
    expect(UpdatePreferencesBody.safeParse({}).success).toBe(false);
    expect(UpdatePreferencesBody.safeParse({ emailReminders: false }).success).toBe(true);
  });
  it('UpdateProfileBody et ChangePasswordBody sont stricts', () => {
    expect(UpdateProfileBody.safeParse({ firstName: 'Awa', lastName: 'Diop', email: 'x@y.sn' }).success).toBe(false);
    expect(ChangePasswordBody.safeParse({ currentPassword: 'a', newPassword: 'b' }).success).toBe(true);
  });
});
```

Run : `pnpm vitest run --project unit packages/shared` — Expected : FAIL (modules introuvables).

- [ ] **Step 3 : Implémenter**

`packages/shared/src/email.ts` :

```ts
/** Forme normalisée d'un email (§ 2.1) : espaces au début et à la fin supprimés, puis NFKC, puis minuscules. */
export function normalizeEmail(input: string): string {
  return input.trim().normalize('NFKC').toLowerCase();
}

const LOCAL = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const EMAIL_RE = new RegExp(`^${LOCAL}@${LABEL}(?:\\.${LABEL})+$`);

/** Email accepté au MVP : ASCII, au plus 254 caractères, domaine avec au moins un point. */
export function isAcceptedEmail(normalized: string): boolean {
  return normalized.length <= 254 && EMAIL_RE.test(normalized);
}
```

`packages/shared/src/password.ts` :

```ts
export const PASSWORD_MIN = { USER: 15, ADMIN: 16 } as const;
export const PASSWORD_MAX = 128;

/** Normalisation identique dans tous les parcours (§ 3.2). */
export function normalizePassword(p: string): string {
  return p.normalize('NFKC');
}

/** Longueur en points de code, après NFKC. */
export function passwordLength(p: string): number {
  return [...normalizePassword(p)].length;
}

export function checkPasswordLength(p: string, role: 'USER' | 'ADMIN'): 'TOO_SHORT' | 'TOO_LONG' | null {
  const n = passwordLength(p);
  if (n > PASSWORD_MAX) return 'TOO_LONG';
  if (n < PASSWORD_MIN[role]) return 'TOO_SHORT';
  return null;
}
```

`packages/shared/src/names.ts` :

```ts
/** Prénom ou nom : NFC, espaces réduits. La longueur (2 à 80) est vérifiée par les schémas et par la base. */
export function normalizeName(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/g, ' ');
}
```

`packages/shared/src/identity-schemas.ts` :

```ts
import { z } from 'zod';
import { isAcceptedEmail, normalizeEmail } from './email.js';
import { normalizeName } from './names.js';

// Le mot de passe brut est borné à 1024 caractères avant toute normalisation (défense contre les corps énormes) ;
// la règle métier (15/16 à 128 après NFKC) est appliquée par le serveur, avec un code d'erreur précis.
const RawPassword = z.string().min(1).max(1024);
const Email = z.string().max(320).transform(normalizeEmail).refine(isAcceptedEmail, { message: 'INVALID_EMAIL' });
const Name = z.string().max(200).transform(normalizeName).pipe(z.string().min(2).max(80).regex(/^[^\p{Cc}\p{Cf}]+$/u));

export const RegisterBody = z.strictObject({
  firstName: Name,
  lastName: Name,
  email: Email,
  password: RawPassword,
  classId: z.uuid(),
  turnstileToken: z.string().min(1).max(2048),
});
export type RegisterBody = z.infer<typeof RegisterBody>;

export const LoginBody = z.strictObject({
  email: Email,
  password: RawPassword,
  turnstileToken: z.string().min(1).max(2048).optional(),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const UpdateProfileBody = z.strictObject({ firstName: Name, lastName: Name });
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

export const UpdatePreferencesBody = z
  .strictObject({ emailReminders: z.boolean().optional(), emailAnnouncements: z.boolean().optional() })
  .refine((v) => v.emailReminders !== undefined || v.emailAnnouncements !== undefined, { message: 'EMPTY' });
export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBody>;

export const ChangePasswordBody = z.strictObject({ currentPassword: RawPassword, newPassword: RawPassword });
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;
```

`packages/shared/src/index.ts` :

```ts
export const APP_TIME_ZONE = 'Africa/Dakar' as const;
export * from './email.js';
export * from './password.js';
export * from './names.js';
export * from './identity-schemas.js';
```

- [ ] **Step 4 : Couverture ≥ 90 % (shared, puis authz en tâche 5)**

`vitest.config.ts` (racine), ajouter au bloc `test` :

```ts
coverage: {
  provider: 'v8',
  include: ['packages/shared/src/**/*.ts', 'apps/api/src/modules/authz/**/*.ts'],
  exclude: ['**/*.spec.ts'],
  thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
},
```

`package.json` (racine) : `"test:cov": "vitest run --project unit --coverage"`. Dans `.github/workflows/rapide.yml`, remplacer `- run: pnpm test:unit` par :

```yaml
      - run: pnpm test:unit
      - run: pnpm test:cov
```

- [ ] **Step 5 : Vérifier**

Run : `pnpm vitest run --project unit packages/shared && pnpm test:cov && pnpm typecheck && pnpm lint`
Expected : PASS ; couverture de `packages/shared` ≥ 90 %.

- [ ] **Step 6 : Commit**

```bash
git add packages/shared apps/api/package.json apps/api/tsconfig.json apps/api/vitest.config.ts vitest.config.ts package.json pnpm-lock.yaml .github/workflows/rapide.yml
git commit -m "feat(shared): normalisation des emails, mots de passe et noms ; schémas d'identité"
```

---

### Task 2 : Migration `identity` — `users`, `sessions`, `rate_limit_buckets`, `role_guard`

**Files :**
- Create : `apps/api/prisma/migrations/20261014000000_identity/migration.sql`
- Modify : `apps/api/prisma/schema.prisma`, `apps/api/test/integration/schema-presence.int.spec.ts`
- Test : `apps/api/test/integration/identity-schema.int.spec.ts`

**Interfaces :**
- Produces : tables `app.users`, `app.sessions`, `app.rate_limit_buckets`, `app.role_guard` ; types `app.global_role`, `app.user_status`, `app.session_revoke_reason` ; modèles Prisma `User`, `Session` (enums `GlobalRole`, `UserStatus`, `SessionRevokeReason`).

- [ ] **Step 1 : Écrire le test (échoue)**

`apps/api/test/integration/identity-schema.int.spec.ts` :

```ts
import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); app = await connectAs('cp_app', db); });
afterAll(async () => { await app.end(); });

const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';
async function insertUser(email: string, extra: Record<string, unknown> = {}) {
  const id = uuidv7();
  const cols = { id, email, first_name: 'Awa', last_name: 'Diop', password_hash: HASH, ...extra };
  const keys = Object.keys(cols);
  await app.query(`insert into app.users (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols));
  return id;
}

describe('users (§ 2.2)', () => {
  it('insère un compte ACTIVE avec les valeurs par défaut', async () => {
    const id = await insertUser('awa@example.com');
    const r = await app.query('select global_role, status, email_reminders, email_announcements from app.users where id = $1', [id]);
    expect(r.rows[0]).toEqual({ global_role: 'USER', status: 'ACTIVE', email_reminders: true, email_announcements: true });
  });
  it('unicité de l’email insensible à la casse (citext)', async () => {
    await insertUser('dup@example.com');
    await expect(insertUser('DUP@example.com')).rejects.toMatchObject({ code: '23514' }); // non normalisé
    await expect(insertUser('dup@example.com')).rejects.toMatchObject({ code: '23505' });
  });
  it.each([' x@example.com', 'X@example.com', 'é@example.com', 'sans-arobase'])('refuse un email non normalisé %j', async (email) => {
    await expect(insertUser(email)).rejects.toMatchObject({ code: '23514', constraint: 'users_email_normalized' });
  });
  it('users_lifecycle : un compte ACTIVE sans mot de passe est refusé', async () => {
    await expect(insertUser('nopw@example.com', { password_hash: null })).rejects.toMatchObject({ constraint: 'users_lifecycle' });
  });
  it('users_lifecycle : un compte DELETED doit avoir tout effacé', async () => {
    await expect(insertUser('del@example.com', { status: 'DELETED' })).rejects.toMatchObject({ constraint: 'users_lifecycle' });
  });
  it('cp_app ne peut ni supprimer un compte, ni changer son email, son rôle ou son statut', async () => {
    const id = await insertUser('rights@example.com');
    await expect(app.query('delete from app.users where id = $1', [id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set email = 'z@example.com' where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set global_role = 'ADMIN' where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`update app.users set status = 'SUSPENDED' where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('sessions (§ 2.2, § 3.4)', () => {
  async function insertSession(userId: string, extra: Record<string, unknown> = {}) {
    const cols = { id: uuidv7(), token_hash: randomBytes(32), user_id: userId, idle_expires_at: new Date(Date.now() + 3600_000), absolute_expires_at: new Date(Date.now() + 7200_000), ...extra };
    const keys = Object.keys(cols);
    await app.query(`insert into app.sessions (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols));
    return cols.id as string;
  }
  it('le hachage du jeton fait 32 octets', async () => {
    const u = await insertUser('s1@example.com');
    await expect(insertSession(u, { token_hash: randomBytes(16) })).rejects.toMatchObject({ constraint: 'sessions_token_hash_len' });
  });
  it('révocation : date et motif ensemble', async () => {
    const u = await insertUser('s2@example.com');
    const s = await insertSession(u);
    await expect(app.query('update app.sessions set revoked_at = clock_timestamp() where id = $1', [s])).rejects.toMatchObject({ constraint: 'sessions_revocation' });
    await app.query(`update app.sessions set revoked_at = clock_timestamp(), revoke_reason = 'LOGOUT' where id = $1`, [s]);
  });
  it('une révocation est définitive', async () => {
    const u = await insertUser('s3@example.com');
    const s = await insertSession(u);
    await app.query(`update app.sessions set revoked_at = clock_timestamp(), revoke_reason = 'LOGOUT' where id = $1`, [s]);
    await expect(app.query('update app.sessions set revoked_at = null, revoke_reason = null where id = $1', [s])).rejects.toMatchObject({ code: '23514' });
  });
  it('cp_app ne peut pas supprimer une session ni changer son jeton', async () => {
    const u = await insertUser('s4@example.com');
    const s = await insertSession(u);
    await expect(app.query('delete from app.sessions where id = $1', [s])).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('update app.sessions set token_hash = $2 where id = $1', [s, randomBytes(32)])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('rate_limit_buckets et role_guard', () => {
  it.each(['ip:203.0.113.7', 'ip:2001:db8:1:2::', `ip+acct:203.0.113.7:${'a'.repeat(64)}`])('accepte la clé %s', async (key) => {
    await app.query('insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp())', [key]);
  });
  it.each(['user:alice', 'ip:', `ip+acct:1.2.3.4:alice@example.com`])('refuse la clé %s', async (key) => {
    await expect(app.query('insert into app.rate_limit_buckets (key, window_start) values ($1, clock_timestamp())', [key])).rejects.toMatchObject({ constraint: 'rate_limit_key_shape' });
  });
  it('role_guard a une seule ligne, verrouillable par cp_app', async () => {
    const r = await app.query('select id from app.role_guard');
    expect(r.rows).toEqual([{ id: 1 }]);
    await app.query('begin');
    await app.query('select id from app.role_guard where id = 1 for update');
    await app.query('rollback');
    await expect(app.query('insert into app.role_guard values (2)')).rejects.toMatchObject({ code: '42501' });
  });
});
```

Ajouter `uuid` (`pnpm --filter @classepulse/api add -E uuid`) : il sert aussi au code (tâche 6).

Run : `pnpm vitest run --project integration apps/api/test/integration/identity-schema.int.spec.ts` — Expected : FAIL (`relation "app.users" does not exist`).

- [ ] **Step 2 : Écrire la migration**

`apps/api/prisma/migrations/20261014000000_identity/migration.sql` :

```sql
-- classification: expand
BEGIN;

CREATE TYPE app.global_role AS ENUM ('USER', 'ADMIN');
CREATE TYPE app.user_status AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');
CREATE TYPE app.session_revoke_reason AS ENUM
  ('LOGOUT', 'PASSWORD_CHANGED', 'ROLE_CHANGED', 'SUSPENDED', 'ANONYMIZED', 'EMAIL_CHANGED', 'ADMIN_REVOKED', 'OTHER_DEVICES', 'RESTORE');

CREATE TABLE app.users (
  id                     uuid PRIMARY KEY,
  email                  ext.citext,
  first_name             text,
  last_name              text,
  password_hash          text,
  global_role            app.global_role NOT NULL DEFAULT 'USER',
  status                 app.user_status NOT NULL DEFAULT 'ACTIVE',
  email_flagged_at       timestamptz,
  email_reminders        boolean NOT NULL DEFAULT true,
  email_announcements    boolean NOT NULL DEFAULT true,
  unsubscribe_token_hash bytea,
  deleted_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  -- Forme normalisée (normalizeEmail) et ASCII imprimable uniquement (§ 2.1).
  CONSTRAINT users_email_normalized CHECK (
    email IS NULL
    OR (email::text = lower(normalize(btrim(email::text), NFKC))
        AND email::text ~ '^[!-~]+@[!-~]+$'
        AND length(email::text) <= 254)
  ),
  CONSTRAINT users_names_length CHECK (
    (first_name IS NULL OR char_length(first_name) BETWEEN 2 AND 80)
    AND (last_name IS NULL OR char_length(last_name) BETWEEN 2 AND 80)
  ),
  CONSTRAINT users_lifecycle CHECK (
    (status IN ('ACTIVE', 'SUSPENDED')
      AND email IS NOT NULL AND first_name IS NOT NULL AND last_name IS NOT NULL
      AND password_hash IS NOT NULL AND deleted_at IS NULL)
    OR
    (status = 'DELETED' AND global_role = 'USER'
      AND email IS NULL AND first_name IS NULL AND last_name IS NULL AND password_hash IS NULL
      AND email_flagged_at IS NULL AND unsubscribe_token_hash IS NULL
      AND email_reminders = false AND email_announcements = false
      AND deleted_at IS NOT NULL)
  )
);

GRANT SELECT ON app.users TO cp_app;
GRANT INSERT (id, email, first_name, last_name, password_hash, global_role, status, created_at, updated_at) ON app.users TO cp_app;
-- Au lot 1a, cp_app ne modifie que le nom, le hachage du mot de passe et les préférences.
GRANT UPDATE (first_name, last_name, password_hash, email_reminders, email_announcements, updated_at) ON app.users TO cp_app;

CREATE TABLE app.sessions (
  id                  uuid PRIMARY KEY,
  token_hash          bytea NOT NULL,
  user_id             uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  reauth_at           timestamptz,
  ip                  inet,
  user_agent          text,
  revoked_at          timestamptz,
  revoke_reason       app.session_revoke_reason,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash),
  CONSTRAINT sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_expiry_order CHECK (idle_expires_at <= absolute_expires_at),
  CONSTRAINT sessions_revocation CHECK (
    (revoked_at IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  CONSTRAINT sessions_user_agent_len CHECK (user_agent IS NULL OR char_length(user_agent) <= 512)
);
CREATE INDEX sessions_user_active_idx ON app.sessions (user_id) WHERE revoked_at IS NULL;

-- Une révocation est définitive : ni la date ni le motif ne changent ensuite.
CREATE FUNCTION app.sessions_revocation_final() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'session revocation is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sessions_revocation_final BEFORE UPDATE ON app.sessions
  FOR EACH ROW EXECUTE FUNCTION app.sessions_revocation_final();

GRANT SELECT, INSERT ON app.sessions TO cp_app;
GRANT UPDATE (last_seen_at, idle_expires_at, reauth_at, revoked_at, revoke_reason) ON app.sessions TO cp_app;

CREATE TABLE app.rate_limit_buckets (
  key             text PRIMARY KEY,
  window_start    timestamptz NOT NULL,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  failures        integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_failure_at timestamptz,
  -- Clés bornées (§ 2.2) : IP ou préfixe /64, et HMAC-SHA256 hexadécimal de l'email normalisé.
  CONSTRAINT rate_limit_key_shape CHECK (
    key ~ '^ip:[0-9a-f:.]{1,45}$' OR key ~ '^ip\+acct:[0-9a-f:.]{1,45}:[0-9a-f]{64}$'
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE ON app.rate_limit_buckets TO cp_app;

-- Une ligne unique qui sérialise les changements de rôle administrateur (§ 2.2).
CREATE TABLE app.role_guard (id smallint PRIMARY KEY CHECK (id = 1));
INSERT INTO app.role_guard (id) VALUES (1);
-- FOR UPDATE exige un droit UPDATE ; la colonne id ne peut de toute façon valoir que 1.
GRANT SELECT, UPDATE (id) ON app.role_guard TO cp_app;

COMMIT;
```

- [ ] **Step 3 : Modèles Prisma**

Ajouter à `apps/api/prisma/schema.prisma` (l'email est déclaré `String` : la base garde `citext` et la forme normalisée, l'application compare toujours la forme normalisée, ce qui évite à Prisma de dépendre du schéma `ext` dans `search_path`) :

```prisma
enum GlobalRole {
  USER
  ADMIN

  @@map("global_role")
  @@schema("app")
}

enum UserStatus {
  ACTIVE
  SUSPENDED
  DELETED

  @@map("user_status")
  @@schema("app")
}

enum SessionRevokeReason {
  LOGOUT
  PASSWORD_CHANGED
  ROLE_CHANGED
  SUSPENDED
  ANONYMIZED
  EMAIL_CHANGED
  ADMIN_REVOKED
  OTHER_DEVICES
  RESTORE

  @@map("session_revoke_reason")
  @@schema("app")
}

model User {
  id                   String     @id @db.Uuid
  email                String?    @unique
  firstName            String?    @map("first_name")
  lastName             String?    @map("last_name")
  passwordHash         String?    @map("password_hash")
  globalRole           GlobalRole @default(USER) @map("global_role")
  status               UserStatus @default(ACTIVE)
  emailFlaggedAt       DateTime?  @map("email_flagged_at") @db.Timestamptz
  emailReminders       Boolean    @default(true) @map("email_reminders")
  emailAnnouncements   Boolean    @default(true) @map("email_announcements")
  unsubscribeTokenHash Bytes?     @map("unsubscribe_token_hash")
  deletedAt            DateTime?  @map("deleted_at") @db.Timestamptz
  createdAt            DateTime   @default(now()) @map("created_at") @db.Timestamptz
  updatedAt            DateTime   @default(now()) @map("updated_at") @db.Timestamptz
  sessions             Session[]

  @@map("users")
  @@schema("app")
}

model Session {
  id                String               @id @db.Uuid
  tokenHash         Bytes                @unique @map("token_hash")
  userId            String               @map("user_id") @db.Uuid
  user              User                 @relation(fields: [userId], references: [id], onDelete: Restrict)
  createdAt         DateTime             @default(now()) @map("created_at") @db.Timestamptz
  lastSeenAt        DateTime             @default(now()) @map("last_seen_at") @db.Timestamptz
  idleExpiresAt     DateTime             @map("idle_expires_at") @db.Timestamptz
  absoluteExpiresAt DateTime             @map("absolute_expires_at") @db.Timestamptz
  reauthAt          DateTime?            @map("reauth_at") @db.Timestamptz
  ip                String?              @db.Inet
  userAgent         String?              @map("user_agent")
  revokedAt         DateTime?            @map("revoked_at") @db.Timestamptz
  revokeReason      SessionRevokeReason? @map("revoke_reason")

  @@map("sessions")
  @@schema("app")
}
```

`rate_limit_buckets` et `role_guard` ne sont lus qu'en SQL brut (`$queryRaw`) : pas de modèle.

- [ ] **Step 4 : Mettre à jour le test de présence du schéma**

Dans `schema-presence.int.spec.ts`, remplacer l'attente de `_prisma_migrations` par la liste ordonnée de toutes les migrations du dossier (elle ne dépend plus d'un nom en dur) :

```ts
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
// …
  it('toutes les migrations du dépôt sont enregistrées par Prisma', async () => {
    const expected = readdirSync(resolve(import.meta.dirname, '../../prisma/migrations'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => ({ migration_name: d.name, done: true })).sort((a, b) => a.migration_name.localeCompare(b.migration_name));
    const c = await connectAs('cp_owner', db);
    const r = await c.query(`select migration_name, finished_at is not null as done from app._prisma_migrations order by 1`);
    await c.end();
    expect(r.rows).toEqual(expected);
  });
```

et ajouter :

```ts
  it('tables et triggers de l’identité', async () => {
    const c = await connectAs('cp_monitor', db);
    const t = await c.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where nspname = 'app' and relkind = 'r' and relname in ('users','sessions','rate_limit_buckets','role_guard') order by 1`);
    const tg = await c.query(`select tgname from pg_trigger where not tgisinternal and tgname = 'sessions_revocation_final'`);
    await c.end();
    expect(t.rows.map((r) => r.relname)).toEqual(['rate_limit_buckets', 'role_guard', 'sessions', 'users']);
    expect(tg.rowCount).toBe(1);
  });
```

- [ ] **Step 5 : Vérifier**

Run : `pnpm --filter @classepulse/api prisma:generate && pnpm vitest run --project integration apps/api/test/integration/identity-schema.int.spec.ts apps/api/test/integration/schema-presence.int.spec.ts apps/api/test/integration/role-privileges.int.spec.ts && pnpm vitest run --project unit apps/api/test/architecture/migrations.spec.ts`
Expected : PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/prisma apps/api/test/integration apps/api/package.json pnpm-lock.yaml
git commit -m "feat(db): tables users, sessions, rate_limit_buckets et role_guard, droits par colonne"
```

---

### Task 3 : Migration `classes_enrollment_audit` — `classes`, `enrollment_requests`, `audit_log`

**Files :**
- Create : `apps/api/prisma/migrations/20261014000100_classes_enrollment_audit/migration.sql`
- Modify : `apps/api/prisma/schema.prisma`, `apps/api/test/integration/schema-presence.int.spec.ts`
- Test : `apps/api/test/integration/audit.int.spec.ts` (partie base), `apps/api/test/integration/identity-schema.int.spec.ts` (ajouts)

**Interfaces :**
- Consumes : `app.users` (tâche 2).
- Produces : `app.classes`, `app.enrollment_requests`, `app.audit_log`, types `app.class_status`, `app.enrollment_status`, `app.audit_source`, `app.audit_action` ; modèles Prisma `Class`, `EnrollmentRequest`, `AuditLog` (enums `ClassStatus`, `EnrollmentStatus`, `AuditSource`, `AuditAction`).
- Valeurs de `app.audit_action` au lot 1a : `ADMIN_CREATED`, `CLASS_CREATED`, `ACCOUNT_REGISTERED`, `PASSWORD_CHANGED`, `SESSIONS_REVOKED`, plus les réservées `ACCOUNT_ANONYMIZED`, `NOTIFICATIONS_PURGED`, `CHAT_PURGED`, `ADMIN_RECOVERY_CODE_ISSUED`, `ADMIN_SECOND_FACTOR_BLOCK_CLEARED`, `DATABASE_RESTORED`. Les lots suivants ajoutent des valeurs par `ALTER TYPE … ADD VALUE` (migration non transactionnelle, `-- non-transactional`, une instruction).

- [ ] **Step 1 : Écrire les tests (échouent)**

Ajouter à `identity-schema.int.spec.ts` :

```ts
describe('classes et enrollment_requests (§ 2.2, R8, R9)', () => {
  async function insertClass(name: string, year = '2026-2027', status = 'ACTIVE') {
    const id = uuidv7();
    await app.query(`insert into app.classes (id, name, level, academic_year) values ($1, $2, 'L3', $3)`, [id, name, year]);
    if (status === 'ARCHIVED') {
      // cp_app ne peut pas archiver au lot 1 : on passe par le propriétaire pour préparer la donnée.
      const owner = await connectAs('cp_owner', db);
      await owner.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [id]);
      await owner.end();
    }
    return id;
  }
  it('unicité (name, academic_year) et format de l’année', async () => {
    await insertClass('L3 Info');
    await expect(insertClass('L3 Info')).rejects.toMatchObject({ code: '23505' });
    await expect(insertClass('L3 Réseaux', '2026-2028')).rejects.toMatchObject({ constraint: 'classes_text_lengths' });
  });
  it('une seule demande en attente par utilisateur', async () => {
    const c1 = await insertClass('C1');
    const c2 = await insertClass('C2');
    const u = await insertUser('enr1@example.com');
    await app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c1]);
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c2])).rejects.toMatchObject({ code: '23505' });
  });
  it('refuse une demande pour une classe archivée', async () => {
    const c = await insertClass('C3', '2025-2026', 'ARCHIVED');
    const u = await insertUser('enr2@example.com');
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c])).rejects.toMatchObject({ code: '23514' });
  });
  it('refuse une demande d’un administrateur', async () => {
    const c = await insertClass('C4');
    const u = await insertUser('enr3@example.com', { global_role: 'ADMIN' });
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c])).rejects.toMatchObject({ code: '23514' });
  });
  it('refuse une nouvelle demande pour la même classe moins de 24 h après un refus, l’accepte après', async () => {
    const c = await insertClass('C5');
    const u = await insertUser('enr4@example.com');
    const owner = await connectAs('cp_owner', db);
    const reqId = uuidv7();
    await app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [reqId, u, c]);
    await owner.query(`update app.enrollment_requests set status = 'REFUSED', decided_at = now() - interval '23 hours', decided_by = $2 where id = $1`, [reqId, u]);
    await expect(app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c])).rejects.toMatchObject({ code: '23514' });
    await owner.query(`update app.enrollment_requests set decided_at = now() - interval '25 hours' where id = $1`, [reqId]);
    await owner.end();
    await app.query(`insert into app.enrollment_requests (id, user_id, class_id) values ($1, $2, $3)`, [uuidv7(), u, c]);
  });
  it('cp_app ne peut pas encore décider une demande (lot 2)', async () => {
    await expect(app.query(`update app.enrollment_requests set status = 'ACCEPTED'`)).rejects.toMatchObject({ code: '42501' });
  });
});
```

`apps/api/test/integration/audit.int.spec.ts` :

```ts
import { v7 as uuidv7 } from 'uuid';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
let app: pg.Client;
beforeAll(async () => { db = await createTestDatabase(); app = await connectAs('cp_app', db); });
afterAll(async () => { await app.end(); });

describe('audit_log (§ 2.5)', () => {
  it('le trigger remplit source, occurred_at et db_login_role', async () => {
    const r = await app.query(`insert into app.audit_log (action, metadata) values ('CLASS_CREATED', '{"via":"cli"}') returning source, db_login_role, occurred_at is not null as dated`);
    expect(r.rows[0]).toEqual({ source: 'APP', db_login_role: 'cp_app', dated: true });
  });
  it('cp_app ne peut pas choisir la source ni la date', async () => {
    await expect(app.query(`insert into app.audit_log (action, source) values ('CLASS_CREATED', 'PRIVILEGED')`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`insert into app.audit_log (action, occurred_at) values ('CLASS_CREATED', now() - interval '1 day')`)).rejects.toMatchObject({ code: '42501' });
  });
  it.each(['ACCOUNT_ANONYMIZED', 'NOTIFICATIONS_PURGED', 'CHAT_PURGED', 'ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'DATABASE_RESTORED'])(
    'refuse l’action réservée %s depuis APP', async (action) => {
      await expect(app.query(`insert into app.audit_log (action) values ($1)`, [action])).rejects.toMatchObject({ code: '42501' });
    });
  it('cp_app ne peut ni modifier ni supprimer une entrée', async () => {
    await expect(app.query(`update app.audit_log set metadata = '{}'`)).rejects.toMatchObject({ code: '42501' });
    await expect(app.query(`delete from app.audit_log`)).rejects.toMatchObject({ code: '42501' });
  });
  it('métadonnées : objet JSON de 4 Ko au plus', async () => {
    await expect(app.query(`insert into app.audit_log (action, metadata) values ('CLASS_CREATED', '[1]')`)).rejects.toMatchObject({ constraint: 'audit_metadata_object' });
    const big = JSON.stringify({ x: 'a'.repeat(4100) });
    await expect(app.query(`insert into app.audit_log (action, metadata) values ('CLASS_CREATED', $1)`, [big])).rejects.toMatchObject({ constraint: 'audit_metadata_object' });
  });
  it('cible : type et identifiant ensemble, type dans la liste', async () => {
    await expect(app.query(`insert into app.audit_log (action, target_type) values ('CLASS_CREATED', 'CLASS')`)).rejects.toMatchObject({ constraint: 'audit_target' });
    await expect(app.query(`insert into app.audit_log (action, target_type, target_id) values ('CLASS_CREATED', 'FILE', $1)`, [uuidv7()])).rejects.toMatchObject({ constraint: 'audit_target' });
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/identity-schema.int.spec.ts apps/api/test/integration/audit.int.spec.ts` — Expected : FAIL.

- [ ] **Step 2 : Écrire la migration**

`apps/api/prisma/migrations/20261014000100_classes_enrollment_audit/migration.sql` :

```sql
-- classification: expand
BEGIN;

CREATE TYPE app.class_status AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TABLE app.classes (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  level         text NOT NULL,
  academic_year text NOT NULL,
  status        app.class_status NOT NULL DEFAULT 'ACTIVE',
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classes_name_year_key UNIQUE (name, academic_year),
  CONSTRAINT classes_archive_state CHECK (
    (status = 'ACTIVE' AND archived_at IS NULL) OR (status = 'ARCHIVED' AND archived_at IS NOT NULL)
  ),
  -- R8 : année « AAAA-AAAA », la seconde suivant la première.
  CONSTRAINT classes_text_lengths CHECK (
    char_length(name) BETWEEN 2 AND 80
    AND char_length(level) BETWEEN 1 AND 40
    AND academic_year ~ '^[0-9]{4}-[0-9]{4}$'
    AND substr(academic_year, 6, 4)::int = substr(academic_year, 1, 4)::int + 1
  )
);
GRANT SELECT ON app.classes TO cp_app;
GRANT INSERT (id, name, level, academic_year, created_at, updated_at) ON app.classes TO cp_app;
-- FOR SHARE exige un droit UPDATE sur au moins une colonne.
GRANT UPDATE (updated_at) ON app.classes TO cp_app;

CREATE TYPE app.enrollment_status AS ENUM ('PENDING', 'ACCEPTED', 'REFUSED');
CREATE TABLE app.enrollment_requests (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  class_id      uuid NOT NULL REFERENCES app.classes (id) ON DELETE RESTRICT,
  status        app.enrollment_status NOT NULL DEFAULT 'PENDING',
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES app.users (id) ON DELETE RESTRICT,
  decision_note text,
  CONSTRAINT enrollment_decision CHECK (
    (status = 'PENDING' AND decided_at IS NULL AND decided_by IS NULL AND decision_note IS NULL)
    OR (status IN ('ACCEPTED', 'REFUSED') AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT enrollment_note_len CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX enrollment_one_pending ON app.enrollment_requests (user_id) WHERE status = 'PENDING';
CREATE INDEX enrollment_user_created_idx ON app.enrollment_requests (user_id, created_at DESC);

-- « Demande valide » (§ 2.2, R9). Verrous dans l'ordre global : classes puis users.
CREATE FUNCTION app.enrollment_request_valid() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  c_status app.class_status;
  u_status app.user_status;
  u_role   app.global_role;
BEGIN
  SELECT status INTO c_status FROM app.classes WHERE id = NEW.class_id FOR SHARE;
  IF c_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'enrollment: class is not active' USING ERRCODE = 'check_violation';
  END IF;
  SELECT status, global_role INTO u_status, u_role FROM app.users WHERE id = NEW.user_id FOR SHARE;
  IF u_status IS DISTINCT FROM 'ACTIVE' OR u_role IS DISTINCT FROM 'USER' THEN
    RAISE EXCEPTION 'enrollment: user cannot enroll' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.enrollment_requests r
     WHERE r.user_id = NEW.user_id AND r.class_id = NEW.class_id
       AND r.status = 'REFUSED' AND r.decided_at > now() - interval '24 hours'
  ) THEN
    RAISE EXCEPTION 'enrollment: refused less than 24 hours ago' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER enrollment_request_valid BEFORE INSERT ON app.enrollment_requests
  FOR EACH ROW EXECUTE FUNCTION app.enrollment_request_valid();

GRANT SELECT ON app.enrollment_requests TO cp_app;
GRANT INSERT (id, user_id, class_id, created_at) ON app.enrollment_requests TO cp_app;

CREATE TYPE app.audit_source AS ENUM ('APP', 'PRIVILEGED');
CREATE TYPE app.audit_action AS ENUM (
  'ADMIN_CREATED', 'CLASS_CREATED', 'ACCOUNT_REGISTERED', 'PASSWORD_CHANGED', 'SESSIONS_REVOKED',
  'ACCOUNT_ANONYMIZED', 'NOTIFICATIONS_PURGED', 'CHAT_PURGED',
  'ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'DATABASE_RESTORED'
);
CREATE TABLE app.audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  source        app.audit_source NOT NULL DEFAULT 'APP',
  db_login_role text NOT NULL DEFAULT session_user,
  actor_user_id uuid REFERENCES app.users (id) ON DELETE RESTRICT,
  action        app.audit_action NOT NULL,
  target_type   text,
  target_id     uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096),
  CONSTRAINT audit_target CHECK (
    (target_type IS NULL AND target_id IS NULL)
    OR (target_type IN ('USER', 'CLASS', 'SESSION', 'ENROLLMENT_REQUEST') AND target_id IS NOT NULL)
  )
);
CREATE INDEX audit_log_occurred_idx ON app.audit_log (occurred_at);

CREATE FUNCTION app.audit_log_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.occurred_at := now();
  NEW.db_login_role := session_user;
  NEW.source := CASE WHEN current_user = 'cp_privileged' THEN 'PRIVILEGED' ELSE 'APP' END::app.audit_source;
  IF NEW.source = 'APP' AND NEW.action IN (
    'ACCOUNT_ANONYMIZED', 'NOTIFICATIONS_PURGED', 'CHAT_PURGED',
    'ADMIN_RECOVERY_CODE_ISSUED', 'ADMIN_SECOND_FACTOR_BLOCK_CLEARED', 'DATABASE_RESTORED'
  ) THEN
    RAISE EXCEPTION 'audit: action reserved to PRIVILEGED source' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER audit_log_guard BEFORE INSERT ON app.audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_guard();

GRANT SELECT ON app.audit_log TO cp_app;
GRANT INSERT (actor_user_id, action, target_type, target_id, metadata) ON app.audit_log TO cp_app;

COMMIT;
```

- [ ] **Step 3 : Modèles Prisma**

```prisma
enum ClassStatus {
  ACTIVE
  ARCHIVED

  @@map("class_status")
  @@schema("app")
}

enum EnrollmentStatus {
  PENDING
  ACCEPTED
  REFUSED

  @@map("enrollment_status")
  @@schema("app")
}

enum AuditSource {
  APP
  PRIVILEGED

  @@map("audit_source")
  @@schema("app")
}

enum AuditAction {
  ADMIN_CREATED
  CLASS_CREATED
  ACCOUNT_REGISTERED
  PASSWORD_CHANGED
  SESSIONS_REVOKED
  ACCOUNT_ANONYMIZED
  NOTIFICATIONS_PURGED
  CHAT_PURGED
  ADMIN_RECOVERY_CODE_ISSUED
  ADMIN_SECOND_FACTOR_BLOCK_CLEARED
  DATABASE_RESTORED

  @@map("audit_action")
  @@schema("app")
}

model Class {
  id           String      @id @db.Uuid
  name         String
  level        String
  academicYear String      @map("academic_year")
  status       ClassStatus @default(ACTIVE)
  archivedAt   DateTime?   @map("archived_at") @db.Timestamptz
  createdAt    DateTime    @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime    @default(now()) @map("updated_at") @db.Timestamptz

  @@unique([name, academicYear])
  @@map("classes")
  @@schema("app")
}

model EnrollmentRequest {
  id           String           @id @db.Uuid
  userId       String           @map("user_id") @db.Uuid
  classId      String           @map("class_id") @db.Uuid
  status       EnrollmentStatus @default(PENDING)
  createdAt    DateTime         @default(now()) @map("created_at") @db.Timestamptz
  decidedAt    DateTime?        @map("decided_at") @db.Timestamptz
  decidedBy    String?          @map("decided_by") @db.Uuid
  decisionNote String?          @map("decision_note")

  @@map("enrollment_requests")
  @@schema("app")
}

model AuditLog {
  id          BigInt      @id @default(autoincrement())
  occurredAt  DateTime    @default(now()) @map("occurred_at") @db.Timestamptz
  source      AuditSource @default(APP)
  dbLoginRole String      @default(dbgenerated("SESSION_USER")) @map("db_login_role")
  actorUserId String?     @map("actor_user_id") @db.Uuid
  action      AuditAction
  targetType  String?     @map("target_type")
  targetId    String?     @map("target_id") @db.Uuid
  metadata    Json        @default("{}")

  @@map("audit_log")
  @@schema("app")
}
```

(Les relations `EnrollmentRequest → User/Class` ne sont pas déclarées : aucun module ne les traverse au lot 1a, les clés étrangères existent en base.)

- [ ] **Step 4 : Présence du schéma**

Dans le test « tables et triggers de l’identité » de `schema-presence.int.spec.ts`, ajouter `'audit_log', 'classes', 'enrollment_requests'` à la liste attendue (ordre alphabétique) et les triggers `enrollment_request_valid`, `audit_log_guard` (`tgname in (...)`, `rowCount` = 3).

- [ ] **Step 5 : Vérifier**

Run : `pnpm --filter @classepulse/api prisma:generate && pnpm vitest run --project integration apps/api/test/integration/identity-schema.int.spec.ts apps/api/test/integration/audit.int.spec.ts apps/api/test/integration/schema-presence.int.spec.ts`
Expected : PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/prisma apps/api/test/integration
git commit -m "feat(db): classes, demandes d'adhésion (trigger « demande valide ») et journal d'audit"
```

---
### Task 4 : Socle HTTP — configuration, `buildApiApp`, erreurs, CSRF, validation, journaux, limitation générale

**Files :**
- Modify : `apps/api/src/config/config.schema.ts`, `apps/api/src/config/load-config.ts`, `apps/api/src/config/load-config.spec.ts`, `apps/api/prisma.config.ts`, `apps/api/src/api.module.ts`, `apps/api/src/main.ts`, `apps/api/src/health/health.controller.ts`
- Create : `apps/api/src/http/app.ts`, `clock.ts`, `core.module.ts`, `csrf.ts`, `errors.ts`, `features.ts`, `ip.ts`, `logger.ts`, `public.decorator.ts`, `routes.ts`, `zod.pipe.ts`
- Test : `apps/api/src/http/csrf.spec.ts`, `ip.spec.ts`, `errors.spec.ts`, `app.spec.ts`

**Interfaces :**
- Produces :
  - `AppConfig` étendu : `http: { origin: string; trustProxy: number; logLevel: LogLevel }`, `security: { rateLimitHmacKey: string }`, `turnstile: { secret: string; verifyUrl: string }`, `limits: { loginPerIp: number; throttlePerIp: number; throttlePerSession: number }` ; `loadDbConfig(env): DbConfig`.
  - `class ApiError extends HttpException { constructor(status: number, code: string, extra?: Record<string, unknown>, headers?: Record<string, string>) }`
  - `errorBody(code, requestId, extra?)`, `toErrorResponse(e: unknown, requestId: string): { status; body: { error: { code } & …; requestId }; headers }`
  - `csrfDecision(origin, secFetchSite, appOrigin): 'accept' | 'reject'`, `isJsonContentType(ct): boolean`
  - `class ZodPipe<T extends z.ZodType>` → `400 { code: 'VALIDATION_FAILED', fields: string[] }`
  - `@Public()` et `IS_PUBLIC`
  - `abstract class Clock { abstract now(): Date }`, `SystemClock`, `CoreModule.forRoot(clock?)`
  - `ipPrefix(ip: string): string`
  - `buildApiApp(config, overrides?): Promise<{ app: NestFastifyApplication; routes: RouteInfo[] }>` ; `AppOverrides = { probe?; clock?; logStream?; features? }` (la tâche 8 ajoute `turnstile?`)
  - `AppThrottlerGuard`, `ThrottleGuardModule`, `defaultFeatures(config, overrides)` (`src/http/features.ts`), complété par les tâches 9 et 10

- [ ] **Step 1 : Dépendances**

```bash
pnpm --filter @classepulse/api add -E @fastify/cookie @nestjs/throttler
```

- [ ] **Step 2 : Configuration (tests d'abord)**

Dans `load-config.spec.ts`, ajouter deux fichiers secrets et trois variables à `base` (les tests existants restent valides), puis les tests :

```ts
const hmac = join(dir, 'hmac');
writeFileSync(hmac, `${'a1'.repeat(32)}\n`);
const turnstile = join(dir, 'turnstile');
writeFileSync(turnstile, '1x0000000000000000000000000000000AA\n');
// dans base :
//   APP_ORIGIN: 'http://localhost:5173', RATE_LIMIT_HMAC_KEY_FILE: hmac, TURNSTILE_SECRET_FILE: turnstile,

  it('lit l’origine, les secrets de sécurité et les seuils par défaut', () => {
    const cfg = loadConfig(base);
    expect(cfg.http).toEqual({ origin: 'http://localhost:5173', trustProxy: 0, logLevel: 'info' });
    expect(cfg.security.rateLimitHmacKey).toBe('a1'.repeat(32));
    expect(cfg.turnstile).toEqual({ secret: '1x0000000000000000000000000000000AA', verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify' });
    expect(cfg.limits).toEqual({ loginPerIp: 100, throttlePerIp: 600, throttlePerSession: 300 });
  });
  it('normalise APP_ORIGIN et refuse un chemin', () => {
    expect(loadConfig({ ...base, APP_ORIGIN: 'https://classepulse.example/' }).http.origin).toBe('https://classepulse.example');
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'https://classepulse.example/app' })).toThrow(/APP_ORIGIN/);
  });
  it('refuse une clé HMAC de moins de 32 caractères', () => {
    writeFileSync(join(dir, 'short'), 'abc\n');
    expect(() => loadConfig({ ...base, RATE_LIMIT_HMAC_KEY_FILE: join(dir, 'short') })).toThrow(/RATE_LIMIT_HMAC_KEY/);
  });
  it('loadDbConfig ne demande que les variables de la base', () => {
    const dbOnly = Object.fromEntries(Object.entries(base).filter(([k]) => k === 'NODE_ENV' || k.startsWith('DB_')));
    expect(loadDbConfig(dbOnly).user).toBe('cp_app');
  });
```

`config.schema.ts` : séparer le schéma de la base et le schéma complet.

```ts
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);

export const dbEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    DB_HOST: z.string().min(1),
    DB_PORT: port,
    DB_NAME: z.string().min(1),
    DB_USER: z.string().min(1),
    DB_AUTH_MODE: z.enum(['password', 'cert']),
    DB_PASSWORD_FILE: z.string().min(1).optional(),
    DB_SSL_CA_FILE: z.string().min(1).optional(),
    DB_SSL_CERT_FILE: z.string().min(1).optional(),
    DB_SSL_KEY_FILE: z.string().min(1).optional(),
    DB_SSL_P12_FILE: z.string().min(1).optional(),
    DB_SSL_P12_PASSWORD_FILE: z.string().min(1).optional(),
  })
  .passthrough();

export const envSchema = dbEnvSchema.extend({
  HTTP_PORT: port,
  READY_PORT: port,
  READY_HOST: z.string().min(1).default('127.0.0.1'),
  APP_ORIGIN: z.url().refine((u) => { const p = new URL(u); return p.pathname === '/' && !p.search && !p.hash; }),
  TRUST_PROXY: z.coerce.number().int().min(0).max(3).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  RATE_LIMIT_HMAC_KEY_FILE: z.string().min(1),
  TURNSTILE_SECRET_FILE: z.string().min(1),
  TURNSTILE_VERIFY_URL: z.url().default('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
  LOGIN_LIMIT_PER_IP: z.coerce.number().int().min(1).default(100),
  THROTTLE_PER_IP: z.coerce.number().int().min(1).default(600),
  THROTTLE_PER_SESSION: z.coerce.number().int().min(1).default(300),
});
```

`load-config.ts` : extraire la partie base dans `loadDbConfig`, puis compléter `loadConfig`.

```ts
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'silent';
export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  httpPort: number;
  readyPort: number;
  /** Adresse d'écoute du serveur interne de disponibilité (127.0.0.1 par défaut). */
  readyHost: string;
  db: DbConfig;
  http: { origin: string; trustProxy: number; logLevel: LogLevel };
  security: { rateLimitHmacKey: string };
  turnstile: { secret: string; verifyUrl: string };
  limits: { loginPerIp: number; throttlePerIp: number; throttlePerSession: number };
};

function checkForbidden(env: NodeJS.ProcessEnv): void {
  for (const key of FORBIDDEN_DIRECT_SECRETS) {
    if (env[key] !== undefined) throw new Error(`${key} must not be set: use a *_FILE secret`);
  }
}

function issuesOf(error: { issues: { path: PropertyKey[] }[] }): string {
  return error.issues.map((i) => i.path.join('.')).join(', ');
}

/** Configuration de la base seule : utilisée par la CLI Prisma (prisma.config.ts) et par loadConfig. */
export function loadDbConfig(env: NodeJS.ProcessEnv): DbConfig {
  checkForbidden(env);
  const parsed = dbEnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${issuesOf(parsed.error)}`);
  const e = parsed.data;
  let auth: DbAuth;
  // … calcul de `auth` actuel, inchangé (mode password interdit en production, mode cert) …
  return { host: e.DB_HOST, port: e.DB_PORT, database: e.DB_NAME, user: e.DB_USER, auth };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  checkForbidden(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`invalid configuration: ${issuesOf(parsed.error)}`);
  const e = parsed.data;
  const db = loadDbConfig(env);
  const rateLimitHmacKey = readSecretFile(e.RATE_LIMIT_HMAC_KEY_FILE);
  if (rateLimitHmacKey.length < 32) throw new Error('invalid configuration: RATE_LIMIT_HMAC_KEY (32 characters minimum)');
  return {
    nodeEnv: e.NODE_ENV,
    httpPort: e.HTTP_PORT,
    readyPort: e.READY_PORT,
    readyHost: e.READY_HOST,
    db,
    http: { origin: new URL(e.APP_ORIGIN).origin, trustProxy: e.TRUST_PROXY, logLevel: e.LOG_LEVEL },
    security: { rateLimitHmacKey },
    turnstile: { secret: readSecretFile(e.TURNSTILE_SECRET_FILE), verifyUrl: e.TURNSTILE_VERIFY_URL },
    limits: { loginPerIp: e.LOGIN_LIMIT_PER_IP, throttlePerIp: e.THROTTLE_PER_IP, throttlePerSession: e.THROTTLE_PER_SESSION },
  };
}
```

Le test existant « un message d’erreur ne contient jamais le contenu d’un fichier de secret » doit rester vert avec les nouveaux fichiers (ajouter un cas : `RATE_LIMIT_HMAC_KEY_FILE` pointant vers le fichier du secret de test et `APP_ORIGIN` invalide → message sans la valeur).

`prisma.config.ts` : remplacer `loadConfig(process.env).db` par `loadDbConfig(process.env)`.

Run : `pnpm vitest run --project unit apps/api/src/config` — Expected : FAIL avant l'implémentation, PASS après.

- [ ] **Step 3 : Fonctions pures (tests d'abord)**

`apps/api/src/http/csrf.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { csrfDecision, isJsonContentType } from './csrf.js';

const APP = 'https://classepulse.example';

describe('csrfDecision (§ 3.5, refus par défaut)', () => {
  it.each([
    [APP, undefined, 'accept'],
    [APP, 'cross-site', 'accept'], // Sec-Fetch-Site ignoré quand Origin est présent
    ['https://evil.example', 'same-origin', 'reject'],
    ['null', undefined, 'reject'],
    [`${APP}:443`, undefined, 'reject'], // comparaison exacte
    [undefined, 'same-origin', 'accept'],
    [undefined, 'same-site', 'reject'],
    [undefined, 'none', 'reject'],
    [undefined, undefined, 'reject'],
  ] as const)('Origin=%s Sec-Fetch-Site=%s → %s', (origin, site, expected) => {
    expect(csrfDecision(origin, site, APP)).toBe(expected);
  });
});

describe('isJsonContentType', () => {
  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])('accepte %s', (ct) => {
    expect(isJsonContentType(ct)).toBe(true);
  });
  it.each([undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp'])('refuse %s', (ct) => {
    expect(isJsonContentType(ct)).toBe(false);
  });
});
```

`apps/api/src/http/ip.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { ipPrefix } from './ip.js';

describe('ipPrefix (§ 2.2 : préfixe /64 en IPv6)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::'],
    ['2001:0DB8:0001:0002::1', '2001:db8:1:2::'],
    ['2001:db8::1', '2001:db8:0:0::'],
    ['::1', '0:0:0:0::'],
  ])('%s → %s', (ip, expected) => {
    expect(ipPrefix(ip)).toBe(expected);
  });
  it('refuse une valeur qui n’est pas une IP', () => {
    expect(() => ipPrefix('localhost')).toThrow();
  });
});
```

`apps/api/src/http/errors.spec.ts` :

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';
import { ApiError, toErrorResponse } from './errors.js';

describe('toErrorResponse', () => {
  it('ApiError : code, champs supplémentaires et en-têtes', () => {
    const r = toErrorResponse(new ApiError(429, 'TOO_MANY_ATTEMPTS', { retryAfter: 5 }, { 'retry-after': '5' }), 'rid');
    expect(r).toEqual({ status: 429, body: { error: { code: 'TOO_MANY_ATTEMPTS', retryAfter: 5 }, requestId: 'rid' }, headers: { 'retry-after': '5' } });
  });
  it('HttpException de Nest : seulement un code générique, jamais le message', () => {
    const r = toErrorResponse(new NotFoundException('Cannot GET /api/secret?token=abc'), 'rid');
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND' }, requestId: 'rid' });
  });
  it('un objet { code } construit par notre code est recopié avec ses champs', () => {
    const r = toErrorResponse(new BadRequestException({ code: 'VALIDATION_FAILED', fields: ['email'] }), 'rid');
    expect(r.body.error).toEqual({ code: 'VALIDATION_FAILED', fields: ['email'] });
  });
  it('ThrottlerException → 429 TOO_MANY_REQUESTS', () => {
    expect(toErrorResponse(new ThrottlerException(), 'rid').body.error.code).toBe('TOO_MANY_REQUESTS');
  });
  it.each([
    [{ statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' }, 413, 'PAYLOAD_TOO_LARGE'],
    [{ statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    [{ statusCode: 400, code: 'FST_ERR_CTP_EMPTY_JSON_BODY' }, 400, 'INVALID_JSON'],
    [{ statusCode: 400, name: 'SyntaxError' }, 400, 'INVALID_JSON'],
  ])('erreur Fastify %j → %d %s', (err, status, code) => {
    const r = toErrorResponse(Object.assign(new Error('Unexpected token in JSON: "secret"'), err), 'rid');
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ error: { code }, requestId: 'rid' });
  });
  it('erreur inconnue → 500 INTERNAL sans message', () => {
    expect(toErrorResponse(new Error('password=hunter2'), 'rid')).toEqual({ status: 500, body: { error: { code: 'INTERNAL' }, requestId: 'rid' }, headers: {} });
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/http` — Expected : FAIL (modules introuvables).

- [ ] **Step 4 : Implémenter les fonctions pures**

`apps/api/src/http/errors.ts` :

```ts
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Erreur métier : un code stable (anglais), des champs sûrs (jamais une valeur saisie) et des en-têtes éventuels. */
export class ApiError extends HttpException {
  constructor(status: number, readonly code: string, readonly extra: Record<string, unknown> = {}, readonly headers: Record<string, string> = {}) {
    super({ code, ...extra }, status);
  }
}

const GENERIC: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'TOO_MANY_REQUESTS', 503: 'UNAVAILABLE',
};

export function errorBody(code: string, requestId: string, extra: Record<string, unknown> = {}) {
  return { error: { code, ...extra }, requestId };
}

type ErrorResponse = { status: number; body: ReturnType<typeof errorBody>; headers: Record<string, string> };

function fastifyCode(e: Error & { code?: string }): string | undefined {
  if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return 'PAYLOAD_TOO_LARGE';
  if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return 'UNSUPPORTED_MEDIA_TYPE';
  if (e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || e.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || e.name === 'SyntaxError') return 'INVALID_JSON';
  return undefined;
}

export function toErrorResponse(e: unknown, requestId: string): ErrorResponse {
  if (e instanceof ApiError) return { status: e.getStatus(), body: errorBody(e.code, requestId, e.extra), headers: e.headers };
  if (e instanceof HttpException) {
    const status = e.getStatus();
    const r = e.getResponse();
    // Seuls les objets construits par notre code ({ code, … }) sont recopiés ; jamais un message de Nest.
    if (typeof r === 'object' && r !== null && typeof (r as { code?: unknown }).code === 'string') {
      const { code, ...rest } = r as { code: string } & Record<string, unknown>;
      return { status, body: errorBody(code, requestId, rest), headers: {} };
    }
    return { status, body: errorBody(GENERIC[status] ?? 'ERROR', requestId), headers: {} };
  }
  if (e instanceof Error) {
    const fe = e as Error & { statusCode?: number; code?: string };
    const code = fastifyCode(fe);
    if (code && fe.statusCode !== undefined && fe.statusCode >= 400 && fe.statusCode < 500) {
      return { status: fe.statusCode, body: errorBody(code, requestId), headers: {} };
    }
  }
  return { status: 500, body: errorBody('INTERNAL', requestId), headers: {} };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(e: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const reply = ctx.getResponse<FastifyReply>();
    const { status, body, headers } = toErrorResponse(e, req.id);
    // Jamais le message : il peut contenir une valeur saisie. Seul le type d'erreur est journalisé.
    if (status >= 500) this.logger.error(`unhandled ${e instanceof Error ? e.name : typeof e} (request ${req.id})`);
    void reply.status(status).headers(headers).send(body);
  }
}
```

`apps/api/src/http/csrf.ts` :

```ts
import type { FastifyInstance } from 'fastify';
import { errorBody } from './errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Tableau du § 3.5 : Origin fait foi s'il est présent ; sinon seul Sec-Fetch-Site: same-origin est accepté. */
export function csrfDecision(origin: string | undefined, secFetchSite: string | undefined, appOrigin: string): 'accept' | 'reject' {
  if (origin !== undefined) return origin === appOrigin ? 'accept' : 'reject';
  return secFetchSite === 'same-origin' ? 'accept' : 'reject';
}

export function isJsonContentType(ct: string | undefined): boolean {
  return ct !== undefined && /^application\/json\s*(;|$)/i.test(ct.trim());
}

function single(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Crochet onRequest : toutes les requêtes modifiantes, avant le routage et la lecture du corps. */
export function registerCsrf(fastify: FastifyInstance, appOrigin: string): void {
  fastify.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    if (csrfDecision(single(req.headers.origin), single(req.headers['sec-fetch-site']), appOrigin) === 'reject') {
      return reply.code(403).send(errorBody('CSRF_REJECTED', req.id));
    }
    if (!isJsonContentType(single(req.headers['content-type']))) {
      return reply.code(415).send(errorBody('UNSUPPORTED_MEDIA_TYPE', req.id));
    }
  });
}
```

`apps/api/src/http/ip.ts` :

```ts
import { isIPv4, isIPv6 } from 'node:net';

function expandV6(ip: string): number[] {
  const hasGap = ip.includes('::');
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = hasGap && tail ? tail.split(':') : [];
  const fill = hasGap ? Array<string>(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

/** Clé de limitation d'une IP : l'adresse IPv4 entière, ou le préfixe /64 d'une IPv6 (§ 2.2). */
export function ipPrefix(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) throw new Error('not an IP address');
  return `${expandV6(ip.toLowerCase()).slice(0, 4).map((g) => g.toString(16)).join(':')}::`;
}
```

`apps/api/src/http/zod.pipe.ts` :

```ts
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './errors.js';

/** Validation d'un corps ou d'un paramètre : champs inconnus refusés (schémas stricts), aucune valeur recopiée. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (r.success) return r.data;
    const fields = [...new Set(r.error.issues.map((i) => (i.path.length ? i.path.join('.') : '(body)')))];
    throw new ApiError(400, 'VALIDATION_FAILED', { fields });
  }
}
```

`apps/api/src/http/public.decorator.ts` :

```ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'cp:isPublic';
/** Route accessible sans session. Toutes les autres exigent une session valide (garde global, refus par défaut). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
```

`apps/api/src/http/clock.ts` :

```ts
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date { return new Date(); }
}
```

`apps/api/src/http/core.module.ts` :

```ts
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { Clock, SystemClock } from './clock.js';

@Global()
@Module({})
export class CoreModule {
  static forRoot(clock: Clock = new SystemClock()): DynamicModule {
    return { module: CoreModule, providers: [{ provide: Clock, useValue: clock }], exports: [Clock] };
  }
}
```

`apps/api/src/http/logger.ts` :

```ts
import type { FastifyServerOptions } from 'fastify';
import type { LogLevel } from '../config/load-config.js';

/** pino JSON (§ 3.5) : ni en-têtes, ni corps, ni chaîne de requête ; cookies et autorisations masqués par sécurité. */
export function loggerOptions(level: LogLevel, stream?: NodeJS.WritableStream): FastifyServerOptions['logger'] {
  if (level === 'silent' && !stream) return false;
  return {
    level: level === 'silent' ? 'info' : level,
    ...(stream ? { stream } : {}),
    redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], censor: '[redacted]' },
    serializers: {
      req: (req: { id: string; method: string; url: string; ip?: string }) => ({ id: req.id, method: req.method, url: req.url.split('?')[0], ip: req.ip }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  };
}
```

`apps/api/src/http/routes.ts` :

```ts
import type { FastifyInstance } from 'fastify';

export type RouteInfo = { method: string; url: string };

/** Enregistre chaque route déclarée (méta-test, R11). HEAD, ajouté par Fastify, est ignoré. */
export function collectRoutes(fastify: FastifyInstance): RouteInfo[] {
  const routes: RouteInfo[] = [];
  fastify.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD') routes.push({ method, url: r.url });
  });
  return routes;
}
```

- [ ] **Step 5 : `buildApiApp`, module racine, limitation générale**

`apps/api/src/api.module.ts` (les modules métier arrivent par `features`) :

```ts
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/load-config.js';
import { HealthModule } from './health/health.module.js';
import type { ReadinessProbe } from './health/readiness.service.js';

@Module({})
export class ApiModule {
  static forRoot(config: AppConfig, probe: Type<ReadinessProbe>, infra: DynamicModule['imports'] = [], features: DynamicModule['imports'] = []): DynamicModule {
    return { module: ApiModule, imports: [ConfigModule.forRoot(config), ...infra, ...features, HealthModule.register(probe, infra)] };
  }
}
```

`apps/api/src/http/features.ts` (les tâches 9, 10 et 11 y ajoutent leurs modules) :

```ts
import { type ExecutionContext, Injectable, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, type ThrottlerLimitDetail } from '@nestjs/throttler';
import type { AppConfig } from '../config/load-config.js';
import type { AppOverrides } from './app.js';
import { ApiError } from './errors.js';

/**
 * Dépassement → 429 au format commun avec `Retry-After` (§ 4.8). Avec plusieurs limiteurs nommés, la classe
 * de base pose `Retry-After-<nom>` : on lève donc notre propre erreur avec l'en-tête standard.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(_ctx: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const retryAfter = Math.max(1, Math.ceil(detail.timeToBlockExpire));
    throw new ApiError(429, 'TOO_MANY_REQUESTS', { retryAfter }, { 'retry-after': String(retryAfter) });
  }
}

/** Limitation générale (§ 3.5). Premier garde global : elle passe avant toute lecture en base. */
@Module({ providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }] })
export class ThrottleGuardModule {}

export function defaultFeatures(_config: AppConfig, _o: AppOverrides): DynamicModule['imports'] {
  return [ThrottleGuardModule];
}
```

`apps/api/src/http/app.ts` :

```ts
import { createHash, randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ThrottlerModule } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { ApiModule } from '../api.module.js';
import type { AppConfig } from '../config/load-config.js';
import { DatabaseModule, DatabaseReadinessProbe } from '../database/database.module.js';
import type { ReadinessProbe } from '../health/readiness.service.js';
import type { Clock } from './clock.js';
import { CoreModule } from './core.module.js';
import { registerCsrf } from './csrf.js';
import { AllExceptionsFilter } from './errors.js';
import { defaultFeatures } from './features.js';
import { loggerOptions } from './logger.js';
import { collectRoutes, type RouteInfo } from './routes.js';

export const BODY_LIMIT_BYTES = 100 * 1024;
const SESSION_COOKIE = '__Host-cp_session';

export type AppOverrides = {
  probe?: Type<ReadinessProbe>;
  // `turnstile?: TurnstileVerifier` est ajouté en tâche 8, quand le vérificateur existe.
  clock?: Clock;
  logStream?: NodeJS.WritableStream;
  features?: (config: AppConfig, o: AppOverrides) => DynamicModule['imports'];
};

function throttlerModule(config: AppConfig): DynamicModule {
  const cookieOf = (req: Record<string, unknown>) => (req as unknown as FastifyRequest).cookies?.[SESSION_COOKIE];
  return ThrottlerModule.forRoot({
    throttlers: [
      { name: 'ip', ttl: 60_000, limit: config.limits.throttlePerIp, getTracker: (req) => String((req as unknown as FastifyRequest).ip) },
      {
        name: 'session', ttl: 60_000, limit: config.limits.throttlePerSession,
        // Le jeton n'est jamais gardé en mémoire tel quel : seule son empreinte sert de clé.
        getTracker: (req) => createHash('sha256').update(String(cookieOf(req))).digest('hex'),
        skipIf: (ctx) => !cookieOf(ctx.switchToHttp().getRequest()),
      },
    ],
  });
}

export async function buildApiApp(config: AppConfig, o: AppOverrides = {}): Promise<{ app: NestFastifyApplication; routes: RouteInfo[] }> {
  const adapter = new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: config.http.trustProxy,
    genReqId: () => randomUUID(),
    requestIdHeader: false, // l'identifiant est toujours généré par le serveur
    logger: loggerOptions(config.http.logLevel, o.logStream),
  });
  const fastify = adapter.getInstance();
  const routes = collectRoutes(fastify);
  registerCsrf(fastify, config.http.origin);
  fastify.addHook('onSend', async (req, reply) => { reply.header('x-request-id', req.id); });

  const features = (o.features ?? defaultFeatures)(config, o) ?? [];
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forRoot(config, o.probe ?? DatabaseReadinessProbe, [DatabaseModule, CoreModule.forRoot(o.clock)], [throttlerModule(config), ...features]),
    adapter,
    { logger: config.http.logLevel === 'silent' || config.nodeEnv === 'test' ? false : ['error', 'warn', 'log'] },
  );
  await app.register(fastifyCookie as never);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  await app.init();
  await fastify.ready();
  return { app, routes };
}
```

`main.ts` :

```ts
import 'reflect-metadata';
import { loadConfig } from './config/load-config.js';
import { ReadinessService } from './health/readiness.service.js';
import { buildReadyServer } from './health/ready-server.js';
import { buildApiApp } from './http/app.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const { app } = await buildApiApp(config);
  const ready = buildReadyServer(app.get(ReadinessService));
  // L'arrêt de l'application publique ferme aussi le serveur interne.
  app.getHttpAdapter().getInstance().addHook('onClose', async () => { await ready.close(); });
  await app.listen({ port: config.httpPort, host: '0.0.0.0' });
  try {
    // Serveur interne : interrogé seulement par le contrôle de santé Docker, depuis le conteneur.
    await ready.listen({ port: config.readyPort, host: config.readyHost });
  } catch (e) {
    await app.close();
    throw e;
  }
}

bootstrap().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'bootstrap failed');
  process.exit(1);
});
```

`health.controller.ts` : ajouter `@Public()` sur la classe (`import { Public } from '../http/public.decorator.js'`).

Vérifier dans les types installés de `@nestjs/throttler` que `timeToBlockExpire` est en **secondes** (sinon diviser par 1 000) et que `getTracker` / `skipIf` sont acceptés par limiteur ; le test ci-dessous (`Retry-After` entre 1 et 60) est l'arbitre.

- [ ] **Step 6 : Test de l'application (sans base)**

`apps/api/src/http/app.spec.ts` (sonde factice ; Prisma est construit mais jamais interrogé) :

```ts
import 'reflect-metadata';
import { Writable } from 'node:stream';
import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/load-config.js';
import { ReadinessProbe } from '../health/readiness.service.js';
import { buildApiApp } from './app.js';
import { ThrottleGuardModule } from './features.js';
import { Public } from './public.decorator.js';
import { ZodPipe } from './zod.pipe.js';

@Injectable()
class OkProbe extends ReadinessProbe { async check() { return true; } }

const Echo = z.strictObject({ name: z.string().max(10) });
@Public()
@Controller('t')
class TestController {
  @Get('boom') boom(): never { throw new Error('password=hunter2'); }
  @Post('echo') echo(@Body(new ZodPipe(Echo)) b: z.infer<typeof Echo>) { return b; }
}
@Module({ controllers: [TestController] })
class TestModule {}

const ORIGIN = 'https://app.test';
const config: AppConfig = {
  nodeEnv: 'test', httpPort: 0, readyPort: 0, readyHost: '127.0.0.1',
  db: { host: '127.0.0.1', port: 1, database: 'x', user: 'cp_app', auth: { mode: 'password', password: 'x' } },
  http: { origin: ORIGIN, trustProxy: 0, logLevel: 'silent' },
  security: { rateLimitHmacKey: 'k'.repeat(64) },
  turnstile: { secret: 's', verifyUrl: 'http://127.0.0.1:1/' },
  limits: { loginPerIp: 100, throttlePerIp: 5, throttlePerSession: 300 },
};

let app: NestFastifyApplication;
const logs: string[] = [];
beforeAll(async () => {
  const logStream = new Writable({ write(chunk, _e, cb) { logs.push(String(chunk)); cb(); } });
  ({ app } = await buildApiApp(config, { probe: OkProbe, logStream, features: () => [ThrottleGuardModule, TestModule] }));
});
afterAll(async () => { await app.close(); });

let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter}`;
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: payload as string, remoteAddress: nextIp(), headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers } });

describe('socle HTTP', () => {
  it('chaque réponse porte x-request-id, repris dans le corps des erreurs ; aucune trace', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/t/boom', remoteAddress: nextIp() });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL' }, requestId: res.headers['x-request-id'] });
    expect(res.body).not.toContain('hunter2');
  });
  it('un x-request-id fourni par le client est ignoré', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: nextIp(), headers: { 'x-request-id': 'forged' } });
    expect(res.headers['x-request-id']).not.toBe('forged');
  });
  it('404 au format commun, sans le chemin demandé', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope?token=abc', remoteAddress: nextIp() });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND' }, requestId: res.headers['x-request-id'] });
  });
  it('validation : champ inconnu refusé, valeur jamais recopiée', async () => {
    const res = await post('/api/t/echo', { name: 'ok', role: 'ADMIN-SECRET' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toEqual({ code: 'VALIDATION_FAILED', fields: ['(body)'] });
    expect(res.body).not.toContain('ADMIN-SECRET');
  });
  it('JSON invalide → 400 INVALID_JSON sans écho', async () => {
    const res = await post('/api/t/echo', '{"name": secret-value');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_JSON');
    expect(res.body).not.toContain('secret-value');
  });
  it('corps de plus de 100 Ko → 413', async () => {
    const res = await post('/api/t/echo', JSON.stringify({ name: 'x'.repeat(101 * 1024) }));
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('CSRF : Origin étranger → 403 ; sans Origin ni Sec-Fetch-Site → 403 ; same-origin → accepté', async () => {
    expect((await post('/api/t/echo', { name: 'a' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    const noOrigin = await app.inject({ method: 'POST', url: '/api/t/echo', payload: { name: 'a' }, remoteAddress: nextIp(), headers: { 'content-type': 'application/json' } });
    expect(noOrigin.statusCode).toBe(403);
    expect(noOrigin.json().error.code).toBe('CSRF_REJECTED');
    const sameOrigin = await app.inject({ method: 'POST', url: '/api/t/echo', payload: { name: 'a' }, remoteAddress: nextIp(), headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' } });
    expect(sameOrigin.statusCode).toBe(201);
  });
  it('Content-Type autre que JSON → 415', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/t/echo', payload: 'name=a', remoteAddress: nextIp(), headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
  it('limitation générale par IP : 429 avec Retry-After', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: '203.0.113.250' });
    expect(last?.statusCode).toBe(429);
    expect(Number(last?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(last?.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(last?.json().error.code).toBe('TOO_MANY_REQUESTS');
  });
  it('les journaux ne contiennent ni cookie ni chaîne de requête', async () => {
    await app.inject({ method: 'GET', url: '/api/health?token=tok-123', remoteAddress: nextIp(), headers: { cookie: '__Host-cp_session=COOKIE-VALUE' } });
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain('COOKIE-VALUE');
    expect(all).not.toContain('tok-123');
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/http apps/api/src/config apps/api/src/health` — Expected : PASS.

- [ ] **Step 7 : Vérifier et committer**

Run : `pnpm typecheck && pnpm lint && pnpm depcruise && pnpm test:unit && pnpm vitest run --project integration apps/api/test/integration/prisma-t01.int.spec.ts`
(le dernier vérifie que la CLI Prisma démarre toujours avec `loadDbConfig`.) Expected : PASS.

```bash
git add apps/api package.json pnpm-lock.yaml
git commit -m "feat(api): socle HTTP — configuration, erreurs communes, CSRF, validation Zod, journaux masqués, limitation générale"
```

---

### Task 5 : Modules `authz` et `audit`

**Files :**
- Create : `apps/api/src/modules/authz/actor.ts`, `matrix.ts`, `authz.service.ts`, `authz.module.ts` ; `apps/api/src/modules/audit/audit-actions.ts`, `audit.repository.ts`, `audit.service.ts`, `audit.module.ts`
- Test : `apps/api/src/modules/authz/matrix.spec.ts`, `apps/api/src/modules/audit/audit.service.spec.ts`, `apps/api/test/integration/audit.int.spec.ts` (ajout)

**Interfaces :**
- Produces :
  - `UserActor = { kind: 'user'; userId: string; globalRole: 'USER' | 'ADMIN'; sessionId: string }`, `AnonymousActor = { kind: 'anonymous'; ip: string }`, `CliActor = { kind: 'cli'; command: 'create-admin' | 'create-class' }`, `Actor = UserActor | AnonymousActor | CliActor`
  - `ACTIONS`, `Action`, `ActorClass`, `MATRIX`, `actorClass(a)`, `can(actor, action)`
  - `AuthzService.assert(actor: Actor, action: Action): void` (lève `ApiError(403, 'FORBIDDEN')`) ; `AuthzModule` global
  - `AUDIT_METADATA`, `AppAuditAction`, `AuditTargetType`
  - `AuditService.recordInTx<A>(tx: TxClient, actor: Actor, entry: { action: A; targetType?; targetId?; metadata }): Promise<void>` ; `AuditModule` global

- [ ] **Step 1 : Tests (échouent)**

`apps/api/src/modules/authz/matrix.spec.ts` (matrice générée, à 100 % : chaque action × chaque classe d'acteur) :

```ts
import { describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ACTIONS, MATRIX, actorClass, can, type Action } from './matrix.js';

const ACTORS = {
  anonymous: { kind: 'anonymous', ip: '203.0.113.1' },
  user: { kind: 'user', userId: 'u', globalRole: 'USER', sessionId: 's' },
  admin: { kind: 'user', userId: 'a', globalRole: 'ADMIN', sessionId: 's' },
  cli: { kind: 'cli', command: 'create-admin' },
} satisfies Record<string, Actor>;
type Name = keyof typeof ACTORS;

// Attendu, écrit à la main depuis la spec (§ 0.2, § 0.3, § 3) : c'est la référence du test.
const EXPECTED: Record<Action, readonly Name[]> = {
  'classes.listActive': ['anonymous', 'user', 'admin'],
  'auth.register': ['anonymous'],
  'auth.login': ['anonymous'],
  'auth.logout': ['user', 'admin'],
  'me.read': ['user', 'admin'],
  'me.updateProfile': ['user', 'admin'],
  'me.updatePreferences': ['user'],
  'me.changePassword': ['user', 'admin'],
  'me.listSessions': ['user', 'admin'],
  'me.revokeOtherSessions': ['user', 'admin'],
  'admin.createFirst': ['cli'],
  'classes.create': ['cli'],
};

describe('matrice d’autorisation (§ 5.4 : générée, 100 %)', () => {
  it('chaque action de la matrice a une attente, et inversement', () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
  });
  for (const action of ACTIONS) {
    for (const name of Object.keys(ACTORS) as Name[]) {
      const allowed = EXPECTED[action].includes(name);
      it(`${action} × ${name} → ${allowed ? 'autorisé' : 'refusé'}`, () => {
        expect(can(ACTORS[name], action)).toBe(allowed);
      });
    }
  }
  it('actorClass distingue l’administrateur de l’étudiant', () => {
    expect(actorClass(ACTORS.admin)).toBe('admin');
    expect(actorClass(ACTORS.user)).toBe('user');
  });
});
```

`apps/api/src/modules/authz/authz.service.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../http/errors.js';
import { AuthzService } from './authz.service.js';

describe('AuthzService.assert', () => {
  it('laisse passer une action autorisée', () => {
    expect(() => new AuthzService().assert({ kind: 'anonymous', ip: '1.2.3.4' }, 'auth.login')).not.toThrow();
  });
  it('lève 403 FORBIDDEN sinon', () => {
    try {
      new AuthzService().assert({ kind: 'anonymous', ip: '1.2.3.4' }, 'me.read');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).getStatus()).toBe(403);
      expect((e as ApiError).code).toBe('FORBIDDEN');
    }
  });
});
```

`apps/api/src/modules/audit/audit.service.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import type { TxClient } from '../../database/prisma.service.js';
import type { AuditRepository, AuditRow } from './audit.repository.js';
import { AuditService } from './audit.service.js';

class FakeRepo { rows: AuditRow[] = []; async insertInTx(_tx: TxClient, row: AuditRow) { this.rows.push(row); } }
const tx = {} as TxClient;
const user = { kind: 'user', userId: '0192b1c4-5d6e-7f80-9a1b-2c3d4e5f6a7b', globalRole: 'USER', sessionId: 's' } as const;
const svc = (repo = new FakeRepo()) => ({ repo, s: new AuditService(repo as unknown as AuditRepository) });

describe('AuditService.recordInTx (§ 2.5)', () => {
  it('écrit l’acteur, l’action, la cible et des métadonnées validées', async () => {
    const { repo, s } = svc();
    await s.recordInTx(tx, user, { action: 'PASSWORD_CHANGED', targetType: 'USER', targetId: user.userId, metadata: { revokedSessions: 2 } });
    expect(repo.rows).toEqual([{ actorUserId: user.userId, action: 'PASSWORD_CHANGED', targetType: 'USER', targetId: user.userId, metadata: { revokedSessions: 2 } }]);
  });
  it('un acteur CLI ou anonyme n’a pas d’identifiant d’utilisateur', async () => {
    const { repo, s } = svc();
    await s.recordInTx(tx, { kind: 'cli', command: 'create-class' }, { action: 'CLASS_CREATED', targetType: 'CLASS', targetId: user.userId, metadata: { via: 'cli' } });
    expect(repo.rows[0]?.actorUserId).toBeNull();
  });
  it('refuse un champ de métadonnées hors schéma (par exemple un email)', async () => {
    await expect(svc().s.recordInTx(tx, user, { action: 'PASSWORD_CHANGED', metadata: { revokedSessions: 1, email: 'a@b.sn' } as never })).rejects.toThrow(/audit metadata/);
  });
  it('refuse une cible incomplète', async () => {
    await expect(svc().s.recordInTx(tx, user, { action: 'PASSWORD_CHANGED', targetType: 'USER', metadata: { revokedSessions: 1 } })).rejects.toThrow(/audit target/);
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules` — Expected : FAIL.

- [ ] **Step 2 : Implémenter `authz`**

`apps/api/src/modules/authz/actor.ts` :

```ts
/** Acteur authentifié par une session. Un administrateur n'est membre d'aucune classe (§ 0.2). */
export type UserActor = { kind: 'user'; userId: string; globalRole: 'USER' | 'ADMIN'; sessionId: string };
/** Parcours avant authentification (R1). L'IP sert aux limitations, jamais à l'audit. */
export type AnonymousActor = { kind: 'anonymous'; ip: string };
/** Commandes en ligne (R1). */
export type CliActor = { kind: 'cli'; command: 'create-admin' | 'create-class' };
export type Actor = UserActor | AnonymousActor | CliActor;
```

`apps/api/src/modules/authz/matrix.ts` :

```ts
import type { Actor } from './actor.js';

export const ACTIONS = [
  'classes.listActive', 'auth.register', 'auth.login', 'auth.logout',
  'me.read', 'me.updateProfile', 'me.updatePreferences', 'me.changePassword', 'me.listSessions', 'me.revokeOtherSessions',
  'admin.createFirst', 'classes.create',
] as const;
export type Action = (typeof ACTIONS)[number];
export type ActorClass = 'anonymous' | 'user' | 'admin' | 'cli';

/** Matrice des droits (§ 1.3 : reprise de la section D, corrigée par la spec). Chaque lot y ajoute ses actions. */
export const MATRIX: Record<Action, readonly ActorClass[]> = {
  'classes.listActive': ['anonymous', 'user', 'admin'],
  'auth.register': ['anonymous'],
  'auth.login': ['anonymous'],
  'auth.logout': ['user', 'admin'],
  'me.read': ['user', 'admin'],
  'me.updateProfile': ['user', 'admin'],
  // Un administrateur ne reçoit que les notifications d'administration (§ 0.2) : pas de préférences de rappels.
  'me.updatePreferences': ['user'],
  'me.changePassword': ['user', 'admin'],
  'me.listSessions': ['user', 'admin'],
  'me.revokeOtherSessions': ['user', 'admin'],
  'admin.createFirst': ['cli'],
  'classes.create': ['cli'],
};

export function actorClass(a: Actor): ActorClass {
  if (a.kind === 'user') return a.globalRole === 'ADMIN' ? 'admin' : 'user';
  return a.kind;
}

export function can(actor: Actor, action: Action): boolean {
  return MATRIX[action].includes(actorClass(actor));
}
```

`apps/api/src/modules/authz/authz.service.ts` :

```ts
import { Injectable } from '@nestjs/common';
import { ApiError } from '../../http/errors.js';
import type { Actor } from './actor.js';
import { can, type Action } from './matrix.js';

@Injectable()
export class AuthzService {
  assert(actor: Actor, action: Action): void {
    if (!can(actor, action)) throw new ApiError(403, 'FORBIDDEN');
  }
}
```

`apps/api/src/modules/authz/authz.module.ts` :

```ts
import { Global, Module } from '@nestjs/common';
import { AuthzService } from './authz.service.js';

@Global()
@Module({ providers: [AuthzService], exports: [AuthzService] })
export class AuthzModule {}
```

- [ ] **Step 3 : Implémenter `audit`**

`apps/api/src/modules/audit/audit-actions.ts` :

```ts
import { z } from 'zod';

/**
 * Liste fermée des actions écrites par l'application (source APP) et schéma de leurs métadonnées (§ 2.5).
 * Autorisé : identifiants, énumérations, compteurs. Interdit : contenus, URL, noms, emails, IP, secrets.
 */
export const AUDIT_METADATA = {
  ADMIN_CREATED: z.strictObject({ via: z.literal('cli') }),
  CLASS_CREATED: z.strictObject({ via: z.literal('cli') }),
  ACCOUNT_REGISTERED: z.strictObject({ classId: z.uuid(), enrollmentRequestId: z.uuid() }),
  PASSWORD_CHANGED: z.strictObject({ revokedSessions: z.number().int().min(0) }),
  SESSIONS_REVOKED: z.strictObject({ reason: z.literal('OTHER_DEVICES'), count: z.number().int().min(0) }),
} as const;
export type AppAuditAction = keyof typeof AUDIT_METADATA;
export type AuditTargetType = 'USER' | 'CLASS' | 'SESSION' | 'ENROLLMENT_REQUEST';
export const AUDIT_METADATA_MAX_BYTES = 4096;
```

`apps/api/src/modules/audit/audit.repository.ts` :

```ts
import { Injectable } from '@nestjs/common';
import type { TxClient } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AppAuditAction, AuditTargetType } from './audit-actions.js';

export type AuditRow = {
  actorUserId: string | null;
  action: AppAuditAction;
  targetType: AuditTargetType | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
};

@Injectable()
export class AuditRepository {
  async insertInTx(tx: TxClient, row: AuditRow): Promise<void> {
    // source, occurred_at et db_login_role sont posés par le trigger audit_log_guard.
    await tx.auditLog.create({ data: { ...row, metadata: row.metadata as Prisma.InputJsonValue }, select: { id: true } });
  }
}
```

`apps/api/src/modules/audit/audit.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { TxClient } from '../../database/prisma.service.js';
import type { Actor } from '../authz/actor.js';
import { AUDIT_METADATA, AUDIT_METADATA_MAX_BYTES, type AppAuditAction, type AuditTargetType } from './audit-actions.js';
import { AuditRepository } from './audit.repository.js';

export type AuditEntry<A extends AppAuditAction> = {
  action: A;
  targetType?: AuditTargetType;
  targetId?: string;
  metadata: z.input<(typeof AUDIT_METADATA)[A]>;
};

@Injectable()
export class AuditService {
  constructor(@Inject(AuditRepository) private readonly repo: AuditRepository) {}

  /** Toujours dans la transaction de l'action journalisée (§ 1.2, règle 3). */
  async recordInTx<A extends AppAuditAction>(tx: TxClient, actor: Actor, entry: AuditEntry<A>): Promise<void> {
    const parsed = AUDIT_METADATA[entry.action].safeParse(entry.metadata);
    if (!parsed.success) throw new Error(`audit metadata rejected for ${entry.action}`);
    const metadata = parsed.data as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(metadata)) > AUDIT_METADATA_MAX_BYTES) throw new Error('audit metadata too large');
    if ((entry.targetType === undefined) !== (entry.targetId === undefined)) throw new Error('audit target incomplete');
    await this.repo.insertInTx(tx, {
      actorUserId: actor.kind === 'user' ? actor.userId : null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata,
    });
  }
}
```

`apps/api/src/modules/audit/audit.module.ts` :

```ts
import { Global, Module } from '@nestjs/common';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({ providers: [AuditRepository, AuditService], exports: [AuditService] })
export class AuditModule {}
```

- [ ] **Step 4 : Intégration de l'audit sous `cp_app`**

Ajouter à `audit.int.spec.ts` :

```ts
import { PrismaService } from '../../src/database/prisma.service.js';
import { AuditRepository } from '../../src/modules/audit/audit.repository.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { dbConfigFor } from '../support/pg.js';

describe('AuditService sous cp_app', () => {
  it('écrit une entrée APP dans la transaction ; rien si la transaction échoue', async () => {
    const prisma = new PrismaService(dbConfigFor('cp_app', db));
    const svc = new AuditService(new AuditRepository());
    const cli = { kind: 'cli', command: 'create-class' } as const;
    const kept = uuidv7();
    const rolled = uuidv7();
    try {
      await prisma.withTx((tx) => svc.recordInTx(tx, cli, { action: 'CLASS_CREATED', targetType: 'CLASS', targetId: kept, metadata: { via: 'cli' } }));
      await expect(prisma.withTx(async (tx) => {
        await svc.recordInTx(tx, cli, { action: 'CLASS_CREATED', targetType: 'CLASS', targetId: rolled, metadata: { via: 'cli' } });
        throw new Error('rollback');
      })).rejects.toThrow('rollback');
    } finally {
      await prisma.onModuleDestroy();
    }
    const r = await app.query(`select target_id, source from app.audit_log where target_id = any($1::uuid[])`, [[kept, rolled]]);
    expect(r.rows).toEqual([{ target_id: kept, source: 'APP' }]);
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules && pnpm vitest run --project integration apps/api/test/integration/audit.int.spec.ts && pnpm test:cov`
Expected : PASS ; couverture de `authz` ≥ 90 %.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/modules/authz apps/api/src/modules/audit apps/api/test/integration/audit.int.spec.ts
git commit -m "feat(api): matrice d'autorisation (acteurs, can, assert) et journal d'audit à liste fermée"
```

---

### Task 6 : Module `users` — dépôt, hachage Argon2id, politique des mots de passe

**Files :**
- Create : `apps/api/src/modules/users/user.dto.ts`, `password-hasher.ts`, `common-passwords.ts`, `common-passwords.txt`, `password-policy.ts`, `users.repository.ts`, `users.service.ts`, `users.module.ts`
- Modify : `apps/api/package.json` (dépendance, script `build`)
- Test : `apps/api/src/modules/users/password-hasher.spec.ts`, `password-policy.spec.ts`

**Interfaces :**
- Consumes : `AuthzService`, `AuditService` (tâche 5) ; `normalizePassword`, `checkPasswordLength`, `normalizeEmail`, `isAcceptedEmail`, `normalizeName` (tâche 1) ; `PrismaService`, `TxClient`.
- Produces :
  - `ARGON2_OPTIONS`, `Semaphore`, `PasswordHasher` : `hash(normalized)`, `verify(stored, normalized)`, `verifyDummy(normalized): Promise<false>`
  - `CommonPasswords.has(normalized): boolean`, `loadCommonPasswords()`
  - `validateNewPassword(raw, role, common): { ok: true; normalized } | { ok: false; code: 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_TOO_COMMON' }`
  - types `UserProfileDto`, `LoginUser`, `NewStudent`, `NewAdminInput` (`user.dto.ts`)
  - `UsersService` : `findForLogin(actor: AnonymousActor, email)`, `credentialsOf(actor: UserActor)`, `createStudentInTx(tx, actor: AnonymousActor, input: NewStudent)`, `createFirstAdmin(actor: CliActor, input: NewAdminInput): Promise<string>`, `setPasswordHashInTx(tx, actor: UserActor, hash)`, `profileOf(actor: UserActor): Promise<UserProfileDto>`, `updateProfile(actor, body)`, `updatePreferences(actor, body)`
  - `UsersModule` exporte `UsersService`, `PasswordHasher`, `CommonPasswords`

- [ ] **Step 1 : Dépendance et liste locale**

```bash
pnpm --filter @classepulse/api add -E @node-rs/argon2
```

`@node-rs/argon2` fournit des binaires précompilés (paquets optionnels), sans script d'installation : `allowBuilds` ne change pas. Vérifier que `pnpm install --frozen-lockfile` ne demande aucune autorisation de build.

Construire `apps/api/src/modules/users/common-passwords.txt` (R12) :

```bash
SECLISTS_COMMIT=$(git ls-remote https://github.com/danielmiessler/SecLists.git HEAD | cut -f1)
TMP=$(mktemp)
curl -fsSL "https://raw.githubusercontent.com/danielmiessler/SecLists/${SECLISTS_COMMIT}/Passwords/Common-Credentials/10-million-password-list-top-1000000.txt" -o "$TMP"
node -e '
const fs = require("node:fs");
const [src, commit] = process.argv.slice(1);
const words = new Set();
for (const line of fs.readFileSync(src, "utf8").split(/\r?\n/)) {
  const n = line.normalize("NFKC").toLowerCase();
  const len = [...n].length;
  if (len >= 15 && len <= 128) words.add(n);
}
const header = ["# Mots de passe courants de 15 caractères ou plus (NFKC, minuscules).", `# Source : SecLists (MIT), commit ${commit}, Passwords/Common-Credentials/10-million-password-list-top-1000000.txt`];
fs.writeFileSync("apps/api/src/modules/users/common-passwords.txt", [...header, ...[...words].sort()].join("\n") + "\n");
' "$TMP" "$SECLISTS_COMMIT"
rm -f "$TMP"
wc -l apps/api/src/modules/users/common-passwords.txt
```

Script `build` de `apps/api/package.json` (le compilateur ne copie pas les `.txt`) :

```json
"build": "tsc -p tsconfig.json && node -e \"require('node:fs').cpSync('src/modules/users/common-passwords.txt','dist/src/modules/users/common-passwords.txt')\""
```

- [ ] **Step 2 : Tests (échouent)**

`apps/api/src/modules/users/password-hasher.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { PasswordHasher, Semaphore } from './password-hasher.js';

describe('PasswordHasher (§ 3.2 : Argon2id 19 Mio, t=2, p=1)', () => {
  const h = new PasswordHasher();
  it('produit un hachage Argon2id aux paramètres OWASP', async () => {
    expect(await h.hash('une phrase de passe assez longue')).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });
  it('vérifie le bon mot de passe et refuse un autre', async () => {
    const hash = await h.hash('une phrase de passe assez longue');
    await expect(h.verify(hash, 'une phrase de passe assez longue')).resolves.toBe(true);
    await expect(h.verify(hash, 'une phrase de passe assez longuE')).resolves.toBe(false);
  });
  it('un hachage corrompu donne faux, jamais une exception', async () => {
    await expect(h.verify('pas-un-hachage', 'x')).resolves.toBe(false);
  });
  it('verifyDummy renvoie toujours faux', async () => {
    await expect(h.verifyDummy('nimporte quoi du tout')).resolves.toBe(false);
  });
});

describe('Semaphore (au plus 4 calculs simultanés)', () => {
  it('ne dépasse jamais la limite', async () => {
    const s = new Semaphore(4);
    let running = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 12 }, () => s.run(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
    })));
    expect(peak).toBe(4);
  });
  it('libère la place même si la tâche échoue', async () => {
    const s = new Semaphore(1);
    await expect(s.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    await expect(s.run(async () => 'ok')).resolves.toBe('ok');
  });
});
```

`apps/api/src/modules/users/password-policy.spec.ts` :

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommonPasswords, loadCommonPasswords } from './common-passwords.js';
import { validateNewPassword } from './password-policy.js';

const common = new CommonPasswords(['motdepassedelaclasse', 'ilovemyclasse2026']);

describe('validateNewPassword (§ 0.7)', () => {
  it('normalise (NFKC) et accepte 15 caractères pour un étudiant', () => {
    expect(validateNewPassword('ﬁ'.repeat(8), 'USER', common)).toEqual({ ok: true, normalized: 'fi'.repeat(8) });
  });
  it.each([
    ['a'.repeat(14), 'USER', 'PASSWORD_TOO_SHORT'],
    ['a'.repeat(15), 'ADMIN', 'PASSWORD_TOO_SHORT'],
    ['a'.repeat(129), 'USER', 'PASSWORD_TOO_LONG'],
    ['MotDePasseDeLaClasse', 'USER', 'PASSWORD_TOO_COMMON'], // comparaison en minuscules
  ] as const)('%j (%s) → %s', (p, role, code) => {
    expect(validateNewPassword(p, role, common)).toEqual({ ok: false, code });
  });
  it('aucune règle de composition', () => {
    expect(validateNewPassword('aaaaaaaaaaaaaaa', 'USER', common).ok).toBe(true);
  });
});

describe('liste locale', () => {
  it('se charge et reconnaît une entrée du fichier, quelle que soit la casse', () => {
    const lines = readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    const list = loadCommonPasswords();
    expect(lines.length).toBeGreaterThan(0);
    expect(list.has(lines[0]!)).toBe(true);
    expect(list.has(lines[0]!.toUpperCase())).toBe(true);
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules/users` — Expected : FAIL.

- [ ] **Step 3 : Implémenter le hachage et la politique**

`apps/api/src/modules/users/password-hasher.ts` :

```ts
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** Paramètres OWASP (§ 3.2). `algorithm: 2` = Argon2id (l'énumération du paquet est un « const enum », absent à l'exécution). */
export const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const MAX_CONCURRENT_HASHES = 4;

export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

@Injectable()
export class PasswordHasher {
  private readonly slots = new Semaphore(MAX_CONCURRENT_HASHES);
  private dummyHash: Promise<string> | undefined;

  /** Le mot de passe reçu est déjà normalisé (NFKC). */
  hash(normalized: string): Promise<string> {
    return this.slots.run(() => hash(normalized, ARGON2_OPTIONS));
  }

  verify(stored: string, normalized: string): Promise<boolean> {
    return this.slots.run(async () => {
      try { return await verify(stored, normalized); } catch { return false; }
    });
  }

  /** Même coût qu'une vérification réelle, quand l'email est inconnu (§ 3.2). */
  async verifyDummy(normalized: string): Promise<false> {
    this.dummyHash ??= this.hash(randomBytes(32).toString('hex'));
    await this.verify(await this.dummyHash, normalized);
    return false;
  }
}
```

(Si le typage de `@node-rs/argon2` refuse `algorithm: 2`, écrire `algorithm: 2 as never` avec le même commentaire : le test sur le préfixe `$argon2id$` est l'arbitre.)

`apps/api/src/modules/users/common-passwords.ts` :

```ts
import { readFileSync } from 'node:fs';

export class CommonPasswords {
  private readonly set: ReadonlySet<string>;
  constructor(entries: Iterable<string>) { this.set = new Set([...entries].map((e) => e.toLowerCase())); }
  /** `normalized` : mot de passe déjà normalisé (NFKC) ; la comparaison ignore la casse. */
  has(normalized: string): boolean { return this.set.has(normalized.toLowerCase()); }
}

export function loadCommonPasswords(): CommonPasswords {
  const text = readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8');
  return new CommonPasswords(text.split(/\r?\n/).filter((l) => l.length > 0 && !l.startsWith('#')));
}
```

`apps/api/src/modules/users/password-policy.ts` :

```ts
import { checkPasswordLength, normalizePassword } from '@classepulse/shared';
import type { CommonPasswords } from './common-passwords.js';

export type PasswordRejection = 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_TOO_COMMON';

/** Règles d'un nouveau mot de passe (§ 0.7) : longueur après NFKC, liste locale ; jamais de troncature. */
export function validateNewPassword(raw: string, role: 'USER' | 'ADMIN', common: CommonPasswords):
  { ok: true; normalized: string } | { ok: false; code: PasswordRejection } {
  const length = checkPasswordLength(raw, role);
  if (length === 'TOO_LONG') return { ok: false, code: 'PASSWORD_TOO_LONG' };
  if (length === 'TOO_SHORT') return { ok: false, code: 'PASSWORD_TOO_SHORT' };
  const normalized = normalizePassword(raw);
  if (common.has(normalized)) return { ok: false, code: 'PASSWORD_TOO_COMMON' };
  return { ok: true, normalized };
}
```

- [ ] **Step 4 : Dépôt et service**

`apps/api/src/modules/users/user.dto.ts` :

```ts
export type UserProfileDto = {
  id: string; email: string; firstName: string; lastName: string;
  globalRole: 'USER' | 'ADMIN'; emailReminders: boolean; emailAnnouncements: boolean;
};
export type LoginUser = { id: string; email: string; passwordHash: string | null; globalRole: 'USER' | 'ADMIN'; status: 'ACTIVE' | 'SUSPENDED' | 'DELETED' };
export type NewStudent = { id: string; email: string; firstName: string; lastName: string; passwordHash: string };
export type NewAdminInput = { email: string; firstName: string; lastName: string; password: string };
```

`apps/api/src/modules/users/users.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import type { LoginUser, NewStudent, UserProfileDto } from './user.dto.js';

const PROFILE = { id: true, email: true, firstName: true, lastName: true, globalRole: true, emailReminders: true, emailAnnouncements: true } as const;
const LOGIN = { id: true, email: true, passwordHash: true, globalRole: true, status: true } as const;

@Injectable()
export class UsersRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<LoginUser | null> {
    const u = await this.prisma.client.user.findUnique({ where: { email }, select: LOGIN });
    return u?.email ? { ...u, email: u.email } : null;
  }

  async findLoginById(id: string): Promise<LoginUser | null> {
    const u = await this.prisma.client.user.findUnique({ where: { id }, select: LOGIN });
    return u?.email ? { ...u, email: u.email } : null;
  }

  async findProfile(id: string): Promise<UserProfileDto | null> {
    const u = await this.prisma.client.user.findFirst({ where: { id, status: 'ACTIVE' }, select: PROFILE });
    if (!u?.email || !u.firstName || !u.lastName) return null;
    return { ...u, email: u.email, firstName: u.firstName, lastName: u.lastName };
  }

  async createInTx(tx: TxClient, row: NewStudent & { globalRole: 'USER' | 'ADMIN' }): Promise<void> {
    await tx.user.create({ data: row, select: { id: true } });
  }

  async updateProfile(id: string, firstName: string, lastName: string): Promise<void> {
    await this.prisma.client.user.update({ where: { id }, data: { firstName, lastName, updatedAt: new Date() }, select: { id: true } });
  }

  async updatePreferences(id: string, prefs: { emailReminders?: boolean; emailAnnouncements?: boolean }): Promise<void> {
    await this.prisma.client.user.update({ where: { id }, data: { ...prefs, updatedAt: new Date() }, select: { id: true } });
  }

  async setPasswordHashInTx(tx: TxClient, id: string, passwordHash: string): Promise<void> {
    await tx.user.update({ where: { id }, data: { passwordHash, updatedAt: new Date() }, select: { id: true } });
  }

  /** Premier verrou de l'ordre global (§ 2.1). */
  async lockRoleGuardInTx(tx: TxClient): Promise<void> {
    await tx.$queryRaw`select id from app.role_guard where id = 1 for update`;
  }

  async activeAdminExistsInTx(tx: TxClient): Promise<boolean> {
    const r = await tx.$queryRaw<{ found: boolean }[]>`select exists (select 1 from app.users where global_role = 'ADMIN' and status = 'ACTIVE') as found`;
    return r[0]?.found === true;
  }
}
```

`apps/api/src/modules/users/users.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { isAcceptedEmail, normalizeEmail, normalizeName, type UpdatePreferencesBody, type UpdateProfileBody } from '@classepulse/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { AnonymousActor, CliActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { CommonPasswords } from './common-passwords.js';
import { PasswordHasher } from './password-hasher.js';
import { validateNewPassword } from './password-policy.js';
import type { LoginUser, NewAdminInput, NewStudent, UserProfileDto } from './user.dto.js';
import { UsersRepository } from './users.repository.js';

const nameOk = (n: string) => [...n].length >= 2 && [...n].length <= 80;

@Injectable()
export class UsersService {
  constructor(
    @Inject(UsersRepository) private readonly repo: UsersRepository,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(CommonPasswords) private readonly common: CommonPasswords,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** `email` : forme normalisée (les schémas Zod l'ont déjà normalisé). */
  async findForLogin(actor: AnonymousActor, email: string): Promise<LoginUser | null> {
    this.authz.assert(actor, 'auth.login');
    return this.repo.findByEmail(email);
  }

  async credentialsOf(actor: UserActor): Promise<LoginUser> {
    this.authz.assert(actor, 'me.changePassword');
    const u = await this.repo.findLoginById(actor.userId);
    if (!u) throw new ApiError(401, 'UNAUTHENTICATED');
    return u;
  }

  async createStudentInTx(tx: TxClient, actor: AnonymousActor, input: NewStudent): Promise<void> {
    this.authz.assert(actor, 'auth.register');
    await this.repo.createInTx(tx, { ...input, globalRole: 'USER' });
  }

  /** `create-admin` (§ 3.2) : refusé s'il existe déjà un administrateur actif ; sérialisé par role_guard. */
  async createFirstAdmin(actor: CliActor, input: NewAdminInput): Promise<string> {
    this.authz.assert(actor, 'admin.createFirst');
    const email = normalizeEmail(input.email);
    if (!isAcceptedEmail(email)) throw new ApiError(400, 'INVALID_EMAIL');
    const firstName = normalizeName(input.firstName);
    const lastName = normalizeName(input.lastName);
    if (!nameOk(firstName) || !nameOk(lastName)) throw new ApiError(400, 'INVALID_NAME');
    const pw = validateNewPassword(input.password, 'ADMIN', this.common);
    if (!pw.ok) throw new ApiError(400, pw.code);
    const passwordHash = await this.hasher.hash(pw.normalized);
    const id = uuidv7();
    await this.prisma.withTx(async (tx) => {
      await this.repo.lockRoleGuardInTx(tx);
      if (await this.repo.activeAdminExistsInTx(tx)) throw new ApiError(409, 'ADMIN_ALREADY_EXISTS');
      await this.repo.createInTx(tx, { id, email, firstName, lastName, passwordHash, globalRole: 'ADMIN' });
      await this.audit.recordInTx(tx, actor, { action: 'ADMIN_CREATED', targetType: 'USER', targetId: id, metadata: { via: 'cli' } });
    });
    return id;
  }

  async setPasswordHashInTx(tx: TxClient, actor: UserActor, passwordHash: string): Promise<void> {
    this.authz.assert(actor, 'me.changePassword');
    await this.repo.setPasswordHashInTx(tx, actor.userId, passwordHash);
  }

  async profileOf(actor: UserActor): Promise<UserProfileDto> {
    this.authz.assert(actor, 'me.read');
    const p = await this.repo.findProfile(actor.userId);
    if (!p) throw new ApiError(401, 'UNAUTHENTICATED');
    return p;
  }

  async updateProfile(actor: UserActor, body: UpdateProfileBody): Promise<void> {
    this.authz.assert(actor, 'me.updateProfile');
    await this.repo.updateProfile(actor.userId, body.firstName, body.lastName);
  }

  async updatePreferences(actor: UserActor, body: UpdatePreferencesBody): Promise<void> {
    this.authz.assert(actor, 'me.updatePreferences');
    await this.repo.updatePreferences(actor.userId, {
      ...(body.emailReminders !== undefined ? { emailReminders: body.emailReminders } : {}),
      ...(body.emailAnnouncements !== undefined ? { emailAnnouncements: body.emailAnnouncements } : {}),
    });
  }
}
```

`apps/api/src/modules/users/users.module.ts` (le contrôleur arrive en tâche 11) :

```ts
import { Module } from '@nestjs/common';
import { CommonPasswords, loadCommonPasswords } from './common-passwords.js';
import { PasswordHasher } from './password-hasher.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';

@Module({
  providers: [UsersRepository, UsersService, PasswordHasher, { provide: CommonPasswords, useFactory: loadCommonPasswords }],
  exports: [UsersService, PasswordHasher, CommonPasswords],
})
export class UsersModule {}
```

- [ ] **Step 5 : Vérifier et committer**

Run : `pnpm vitest run --project unit apps/api/src/modules/users && pnpm typecheck && pnpm lint && pnpm depcruise`
Expected : PASS.

```bash
git add apps/api/src/modules/users apps/api/package.json pnpm-lock.yaml
git commit -m "feat(users): hachage Argon2id borné à 4 calculs, politique des mots de passe et liste locale"
```

---
### Task 7 : Sessions — cookie, dépôt, service, garde global

**Files :**
- Create : `apps/api/src/modules/auth/session-cookie.ts`, `sessions.repository.ts`, `sessions.service.ts`, `session.guard.ts`, `client-context.ts` ; `apps/api/src/http/current-actor.ts`
- Modify : `apps/api/src/modules/users/users.service.ts`, `users.repository.ts` (`activeRoleOf`)
- Test : `apps/api/src/modules/auth/session-cookie.spec.ts`, `apps/api/test/integration/sessions.int.spec.ts`

**Interfaces :**
- Consumes : `UsersService` (tâche 6), `AuthzService`, `AuditService` (tâche 5), `IS_PUBLIC`, `ApiError` (tâche 4).
- Produces :
  - `SESSION_COOKIE = '__Host-cp_session'`, `STUDENT_SESSION_SECONDS = 2_592_000`, `newSessionToken(): { token: string; hash: Buffer }`, `hashSessionToken(token: string): Buffer | null`, `sessionSetCookie(token: string, maxAgeSeconds: number): string`, `sessionClearCookie(): string`
  - `type ClientContext = { ip: string; userAgent: string | null }`, `clientContextOf(req: FastifyRequest): ClientContext`
  - `type OpenedSession = { token: string; maxAgeSeconds: number; actor: UserActor }`
  - `SessionsService` : `openInTx(tx, user: { id: string; globalRole: 'USER' }, ctx: ClientContext): Promise<OpenedSession>`, `authenticate(token: string): Promise<UserActor | null>`, `logout(actor: UserActor): Promise<void>`, `list(actor: UserActor): Promise<SessionDto[]>`, `revokeOthers(actor: UserActor): Promise<number>`, `revokeOthersInTx(tx, actor: UserActor, reason: 'PASSWORD_CHANGED'): Promise<number>`, `markReauthInTx(tx, actor: UserActor): Promise<void>`
  - `type SessionDto = { id: string; createdAt: string; lastSeenAt: string; userAgent: string | null; current: boolean }`
  - `SessionGuard` (global, refus par défaut) ; `@CurrentActor()` et l'augmentation `FastifyRequest.actor?: UserActor` dans `src/http/current-actor.ts`
  - `UsersService.activeRoleOf(userId: string): Promise<'USER' | 'ADMIN' | null>` — **R13** : primitive d'authentification appelée par le garde de session, sans `Actor` (c'est elle qui construit l'acteur).

> **R13 — Primitive d'authentification sans acteur.** `activeRoleOf` est la seule méthode publique d'un service sans `Actor` : elle sert à construire l'acteur à partir d'une session. Elle ne renvoie qu'un rôle, et seulement pour un compte `ACTIVE`. *Coût si faux : la déplacer dans un service dédié.*

- [ ] **Step 1 : Tests du cookie (échouent)**

`apps/api/src/modules/auth/session-cookie.spec.ts` :

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashSessionToken, newSessionToken, sessionClearCookie, sessionSetCookie, STUDENT_SESSION_SECONDS } from './session-cookie.js';

describe('cookie de session (§ 3.4)', () => {
  it('attributs exacts à la pose et à l’effacement', () => {
    expect(sessionSetCookie('TOKEN', STUDENT_SESSION_SECONDS)).toBe('__Host-cp_session=TOKEN; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000');
    expect(sessionClearCookie()).toBe('__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  });
  it('jeton de 32 octets ; seul le SHA-256 des octets est stocké', () => {
    const { token, hash } = newSessionToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(hash).toEqual(createHash('sha256').update(Buffer.from(token, 'base64url')).digest());
    expect(hashSessionToken(token)).toEqual(hash);
  });
  it('deux jetons ne se répètent pas', () => {
    expect(newSessionToken().token).not.toBe(newSessionToken().token);
  });
  it.each(['', 'abc', 'a'.repeat(44), `${'a'.repeat(42)}!`])('refuse un jeton mal formé %j sans calcul', (t) => {
    expect(hashSessionToken(t)).toBeNull();
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules/auth` — Expected : FAIL.

- [ ] **Step 2 : Implémenter le cookie et le contexte client**

`apps/api/src/modules/auth/session-cookie.ts` :

```ts
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = '__Host-cp_session';
/** Étudiant : Max-Age de 30 jours, fixé à la connexion (§ 3.4) ; inactivité = même durée (R4). */
export const STUDENT_SESSION_SECONDS = 30 * 24 * 3600;
const ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Lax';

export function newSessionToken(): { token: string; hash: Buffer } {
  const raw = randomBytes(32);
  return { token: raw.toString('base64url'), hash: createHash('sha256').update(raw).digest() };
}

/** Jeton mal formé : null, sans requête en base. */
export function hashSessionToken(token: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  return raw.length === 32 ? createHash('sha256').update(raw).digest() : null;
}

export function sessionSetCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; ${ATTRS}; Max-Age=${maxAgeSeconds}`;
}

/** Effacement avec exactement les mêmes attributs (§ 3.4). */
export function sessionClearCookie(): string {
  return `${SESSION_COOKIE}=; ${ATTRS}; Max-Age=0`;
}
```

`apps/api/src/modules/auth/client-context.ts` :

```ts
import type { FastifyRequest } from 'fastify';

export type ClientContext = { ip: string; userAgent: string | null };

export function clientContextOf(req: FastifyRequest): ClientContext {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' && ua.length > 0 ? ua.slice(0, 512) : null };
}
```

- [ ] **Step 3 : `activeRoleOf` (users)**

`users.repository.ts` :

```ts
  async activeRoleOf(id: string): Promise<'USER' | 'ADMIN' | null> {
    const u = await this.prisma.client.user.findFirst({ where: { id, status: 'ACTIVE' }, select: { globalRole: true } });
    return u?.globalRole ?? null;
  }
```

`users.service.ts` :

```ts
  /** R13 : primitive d'authentification (construit l'acteur) ; seulement pour un compte ACTIVE. */
  activeRoleOf(userId: string): Promise<'USER' | 'ADMIN' | null> {
    return this.repo.activeRoleOf(userId);
  }
```

- [ ] **Step 4 : Dépôt et service des sessions**

`apps/api/src/modules/auth/sessions.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';

export type RevokeReason = 'LOGOUT' | 'PASSWORD_CHANGED' | 'OTHER_DEVICES';
export type NewSessionRow = {
  id: string; tokenHash: Buffer; userId: string;
  idleSeconds: number; absoluteSeconds: number; ip: string | null; userAgent: string | null;
};

@Injectable()
export class SessionsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Échéances calculées par l'horloge de la base (§ 2.1 : clock_timestamp()). */
  async createInTx(tx: TxClient, s: NewSessionRow): Promise<void> {
    await tx.$executeRaw`
      insert into app.sessions (id, token_hash, user_id, idle_expires_at, absolute_expires_at, ip, user_agent)
      values (${s.id}::uuid, ${s.tokenHash}, ${s.userId}::uuid,
              clock_timestamp() + make_interval(secs => ${s.idleSeconds}::double precision),
              clock_timestamp() + make_interval(secs => ${s.absoluteSeconds}::double precision),
              ${s.ip}::inet, ${s.userAgent})`;
  }

  async findValid(tokenHash: Buffer): Promise<{ sessionId: string; userId: string; stale: boolean } | null> {
    const r = await this.prisma.client.$queryRaw<{ id: string; user_id: string; stale: boolean }[]>`
      select id, user_id, last_seen_at < clock_timestamp() - interval '5 minutes' as stale
        from app.sessions
       where token_hash = ${tokenHash} and revoked_at is null
         and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()`;
    const row = r[0];
    return row ? { sessionId: row.id, userId: row.user_id, stale: row.stale } : null;
  }

  /** Au plus toutes les 5 min (§ 3.4) ; l'inactivité ne dépasse jamais l'échéance absolue. */
  async touch(sessionId: string, idleSeconds: number): Promise<void> {
    await this.prisma.client.$executeRaw`
      update app.sessions
         set last_seen_at = clock_timestamp(),
             idle_expires_at = least(clock_timestamp() + make_interval(secs => ${idleSeconds}::double precision), absolute_expires_at)
       where id = ${sessionId}::uuid and revoked_at is null and last_seen_at < clock_timestamp() - interval '5 minutes'`;
  }

  async revoke(sessionId: string, reason: RevokeReason): Promise<void> {
    await this.prisma.client.$executeRaw`
      update app.sessions set revoked_at = clock_timestamp(), revoke_reason = ${reason}::app.session_revoke_reason
       where id = ${sessionId}::uuid and revoked_at is null`;
  }

  async revokeOthersInTx(tx: TxClient, userId: string, keepSessionId: string, reason: RevokeReason): Promise<number> {
    return tx.$executeRaw`
      update app.sessions set revoked_at = clock_timestamp(), revoke_reason = ${reason}::app.session_revoke_reason
       where user_id = ${userId}::uuid and id <> ${keepSessionId}::uuid and revoked_at is null`;
  }

  async markReauthInTx(tx: TxClient, sessionId: string): Promise<void> {
    await tx.$executeRaw`update app.sessions set reauth_at = clock_timestamp() where id = ${sessionId}::uuid`;
  }

  async listActive(userId: string): Promise<{ id: string; createdAt: Date; lastSeenAt: Date; userAgent: string | null }[]> {
    const rows = await this.prisma.client.$queryRaw<{ id: string; created_at: Date; last_seen_at: Date; user_agent: string | null }[]>`
      select id, created_at, last_seen_at, user_agent from app.sessions
       where user_id = ${userId}::uuid and revoked_at is null
         and idle_expires_at > clock_timestamp() and absolute_expires_at > clock_timestamp()
       order by last_seen_at desc`;
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, userAgent: r.user_agent }));
  }
}
```

`apps/api/src/modules/auth/sessions.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { hashSessionToken, newSessionToken, STUDENT_SESSION_SECONDS } from './session-cookie.js';
import { SessionsRepository } from './sessions.repository.js';

export type OpenedSession = { token: string; maxAgeSeconds: number; actor: UserActor };
export type SessionDto = { id: string; createdAt: string; lastSeenAt: string; userAgent: string | null; current: boolean };

@Injectable()
export class SessionsService {
  constructor(
    @Inject(SessionsRepository) private readonly repo: SessionsRepository,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Nouveau jeton à chaque connexion (§ 3.4). Au lot 1a, seuls les comptes USER ouvrent une session (R2). */
  async openInTx(tx: TxClient, user: { id: string; globalRole: 'USER' }, ctx: ClientContext): Promise<OpenedSession> {
    const { token, hash } = newSessionToken();
    const id = uuidv7();
    await this.repo.createInTx(tx, {
      id, tokenHash: hash, userId: user.id,
      idleSeconds: STUDENT_SESSION_SECONDS, absoluteSeconds: STUDENT_SESSION_SECONDS,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return { token, maxAgeSeconds: STUDENT_SESSION_SECONDS, actor: { kind: 'user', userId: user.id, globalRole: user.globalRole, sessionId: id } };
  }

  /** Le serveur fait foi : session révoquée, expirée ou compte non ACTIVE → null. */
  async authenticate(token: string): Promise<UserActor | null> {
    const hash = hashSessionToken(token);
    if (!hash) return null;
    const s = await this.repo.findValid(hash);
    if (!s) return null;
    const role = await this.users.activeRoleOf(s.userId);
    if (!role) return null;
    if (s.stale) await this.repo.touch(s.sessionId, STUDENT_SESSION_SECONDS);
    return { kind: 'user', userId: s.userId, globalRole: role, sessionId: s.sessionId };
  }

  async logout(actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'auth.logout');
    await this.repo.revoke(actor.sessionId, 'LOGOUT');
  }

  async list(actor: UserActor): Promise<SessionDto[]> {
    this.authz.assert(actor, 'me.listSessions');
    const rows = await this.repo.listActive(actor.userId);
    return rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), lastSeenAt: r.lastSeenAt.toISOString(), userAgent: r.userAgent, current: r.id === actor.sessionId }));
  }

  async revokeOthers(actor: UserActor): Promise<number> {
    this.authz.assert(actor, 'me.revokeOtherSessions');
    return this.prisma.withTx(async (tx) => {
      const count = await this.repo.revokeOthersInTx(tx, actor.userId, actor.sessionId, 'OTHER_DEVICES');
      await this.audit.recordInTx(tx, actor, { action: 'SESSIONS_REVOKED', targetType: 'USER', targetId: actor.userId, metadata: { reason: 'OTHER_DEVICES', count } });
      return count;
    });
  }

  async revokeOthersInTx(tx: TxClient, actor: UserActor, reason: 'PASSWORD_CHANGED'): Promise<number> {
    this.authz.assert(actor, 'me.changePassword');
    return this.repo.revokeOthersInTx(tx, actor.userId, actor.sessionId, reason);
  }

  async markReauthInTx(tx: TxClient, actor: UserActor): Promise<void> {
    this.authz.assert(actor, 'me.changePassword');
    await this.repo.markReauthInTx(tx, actor.sessionId);
  }
}
```

- [ ] **Step 5 : Garde de session**

`apps/api/src/http/current-actor.ts` (couche HTTP : utilisable par tous les contrôleurs sans dépendre du module `auth`) :

```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { UserActor } from '../modules/authz/actor.js';
import { ApiError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest { actor?: UserActor }
}

/** Acteur posé par le garde de session ; absent seulement sur une route @Public(). */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): UserActor => {
  const actor = ctx.switchToHttp().getRequest<FastifyRequest>().actor;
  if (!actor) throw new ApiError(401, 'UNAUTHENTICATED');
  return actor;
});
```

`apps/api/src/modules/auth/session.guard.ts` :

```ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import '../../http/current-actor.js';
import { ApiError } from '../../http/errors.js';
import { IS_PUBLIC } from '../../http/public.decorator.js';
import { SESSION_COOKIE, sessionClearCookie } from './session-cookie.js';
import { SessionsService } from './sessions.service.js';

/** Garde global : toute route non marquée @Public() exige une session valide (refus par défaut). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new ApiError(401, 'UNAUTHENTICATED');
    const actor = await this.sessions.authenticate(token);
    if (!actor) {
      // Session invalide : 401 et effacement du cookie aux mêmes attributs (§ 3.4).
      ctx.switchToHttp().getResponse<FastifyReply>().header('set-cookie', sessionClearCookie());
      throw new ApiError(401, 'UNAUTHENTICATED');
    }
    req.actor = actor;
    return true;
  }
}
```

- [ ] **Step 6 : Test d'intégration du service (sous `cp_app`)**

`apps/api/test/integration/sessions.int.spec.ts` :

```ts
import 'reflect-metadata';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { AuditRepository } from '../../src/modules/audit/audit.repository.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { SessionsRepository } from '../../src/modules/auth/sessions.repository.js';
import { SessionsService } from '../../src/modules/auth/sessions.service.js';
import { AuthzService } from '../../src/modules/authz/authz.service.js';
import { CommonPasswords } from '../../src/modules/users/common-passwords.js';
import { PasswordHasher } from '../../src/modules/users/password-hasher.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { connectAs, createTestDatabase, dbConfigFor } from '../support/pg.js';

let db: string;
let prisma: PrismaService;
let sessions: SessionsService;
const ctx = { ip: '203.0.113.5', userAgent: 'vitest' };

beforeAll(async () => {
  db = await createTestDatabase();
  prisma = new PrismaService(dbConfigFor('cp_app', db));
  const authz = new AuthzService();
  const audit = new AuditService(new AuditRepository());
  const users = new UsersService(new UsersRepository(prisma), authz, audit, new PasswordHasher(), new CommonPasswords([]), prisma);
  sessions = new SessionsService(new SessionsRepository(prisma), users, authz, audit, prisma);
});
afterAll(async () => { await prisma.onModuleDestroy(); });

async function newUser(): Promise<string> {
  const id = uuidv7();
  const c = await connectAs('cp_app', db);
  await c.query(`insert into app.users (id, email, first_name, last_name, password_hash) values ($1, $2, 'Awa', 'Diop', 'x')`, [id, `${id}@example.com`]);
  await c.end();
  return id;
}
const open = (userId: string) => prisma.withTx((tx) => sessions.openInTx(tx, { id: userId, globalRole: 'USER' }, ctx));
async function asOwner(sql: string, params: unknown[]) {
  const c = await connectAs('cp_owner', db);
  try { await c.query(sql, params); } finally { await c.end(); }
}

describe('SessionsService (§ 3.4)', () => {
  it('ouvre une session de 30 jours et l’authentifie', async () => {
    const u = await newUser();
    const s = await open(u);
    expect(s.maxAgeSeconds).toBe(2_592_000);
    await expect(sessions.authenticate(s.token)).resolves.toEqual({ kind: 'user', userId: u, globalRole: 'USER', sessionId: s.actor.sessionId });
    const c = await connectAs('cp_app', db);
    const r = await c.query(`select absolute_expires_at - created_at as life, idle_expires_at = absolute_expires_at as same, octet_length(token_hash) as n from app.sessions where id = $1`, [s.actor.sessionId]);
    await c.end();
    expect(r.rows[0]).toMatchObject({ same: true, n: 32 });
    expect(r.rows[0].life.days).toBe(30);
  });
  it('session révoquée, expirée, ou compte suspendu → null', async () => {
    const u = await newUser();
    const a = await open(u);
    await sessions.logout(a.actor);
    await expect(sessions.authenticate(a.token)).resolves.toBeNull();

    const b = await open(u);
    await asOwner(`update app.sessions set idle_expires_at = clock_timestamp() - interval '1 second' where id = $1`, [b.actor.sessionId]);
    await expect(sessions.authenticate(b.token)).resolves.toBeNull();

    const c = await open(u);
    await asOwner(`update app.users set status = 'SUSPENDED' where id = $1`, [u]);
    await expect(sessions.authenticate(c.token)).resolves.toBeNull();
  });
  it('last_seen_at n’est mis à jour qu’après 5 min', async () => {
    const u = await newUser();
    const s = await open(u);
    const read = async () => {
      const c = await connectAs('cp_app', db);
      const r = await c.query(`select last_seen_at from app.sessions where id = $1`, [s.actor.sessionId]);
      await c.end();
      return (r.rows[0].last_seen_at as Date).getTime();
    };
    const t0 = await read();
    await sessions.authenticate(s.token);
    expect(await read()).toBe(t0);
    await asOwner(`update app.sessions set last_seen_at = clock_timestamp() - interval '6 minutes' where id = $1`, [s.actor.sessionId]);
    const old = await read();
    await sessions.authenticate(s.token);
    expect(await read()).toBeGreaterThan(old);
  });
  it('revokeOthers garde la session courante, révoque les autres et journalise', async () => {
    const u = await newUser();
    const keep = await open(u);
    const other1 = await open(u);
    const other2 = await open(u);
    await expect(sessions.revokeOthers(keep.actor)).resolves.toBe(2);
    await expect(sessions.authenticate(keep.token)).resolves.not.toBeNull();
    await expect(sessions.authenticate(other1.token)).resolves.toBeNull();
    await expect(sessions.authenticate(other2.token)).resolves.toBeNull();
    const list = await sessions.list(keep.actor);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: keep.actor.sessionId, current: true, userAgent: 'vitest' });
    const c = await connectAs('cp_app', db);
    const r = await c.query(`select metadata from app.audit_log where action = 'SESSIONS_REVOKED' and target_id = $1`, [u]);
    await c.end();
    expect(r.rows).toEqual([{ metadata: { reason: 'OTHER_DEVICES', count: 2 } }]);
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules/auth && pnpm vitest run --project integration apps/api/test/integration/sessions.int.spec.ts`
Expected : PASS.

- [ ] **Step 7 : Commit**

```bash
git add apps/api/src/modules/auth apps/api/src/modules/users apps/api/src/http/current-actor.ts apps/api/test/integration/sessions.int.spec.ts
git commit -m "feat(auth): sessions par cookie __Host-, révocation logique, garde global refusant par défaut"
```

---

### Task 8 : Limitation de la connexion (en base) et Turnstile avec mode dégradé

**Files :**
- Create : `apps/api/src/modules/auth/rate-limit.repository.ts`, `login-rate-limiter.ts`, `turnstile.ts`
- Test : `apps/api/src/modules/auth/login-rate-limiter.spec.ts`, `apps/api/src/modules/auth/turnstile.spec.ts`, `apps/api/test/integration/rate-limit.int.spec.ts`

**Interfaces :**
- Consumes : `ipPrefix` (tâche 4), `Clock` (tâche 4), `AppConfig.security.rateLimitHmacKey`, `AppConfig.limits.loginPerIp`, `AppConfig.turnstile`.
- Produces :
  - constantes `WINDOW_SECONDS = 900`, `ACCOUNT_LIMIT = 5`, `TURNSTILE_AFTER_FAILURES = 3`, `IP_ALERT_FAILURES = 50`, `BUCKET_ROW_CAP = 50_000`, `DEGRADED_LIMITS = { ip: 5, account: 2 }`, `backoffSeconds(failures: number): number`
  - `type LoginKeys = { ipKey: string; accountKey: string }`, `type Gate = { kind: 'allowed'; turnstileRequired: boolean } | { kind: 'limited'; retryAfterSeconds: number }`
  - `LoginRateLimiter` : `keys(ip: string, normalizedEmail: string): LoginKeys`, `check(keys: LoginKeys, degraded: boolean): Promise<Gate>`, `recordFailure(keys: LoginKeys, degraded: boolean): Promise<{ turnstileRequired: boolean }>`, `recordSuccess(keys: LoginKeys): Promise<void>`
  - `type VerifierResult = 'valid' | 'invalid' | 'error' | 'timeout'`, `abstract class TurnstileVerifier { abstract verify(token: string, ip: string): Promise<VerifierResult> }`, `HttpTurnstileVerifier`
  - `TurnstileGate` : `isDegraded(): boolean`, `check(token: string | undefined, ip: string): Promise<'valid' | 'invalid' | 'unavailable'>` ; `DEGRADED_RETRY_MS = 60_000`, `TURNSTILE_TIMEOUT_MS = 3_000`

- [ ] **Step 1 : Tests unitaires (échouent)**

`apps/api/src/modules/auth/login-rate-limiter.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { backoffSeconds } from './login-rate-limiter.js';

describe('backoffSeconds (R5 : délai croissant)', () => {
  it.each([[0, 0], [1, 1], [2, 2], [3, 4], [4, 8], [5, 16], [6, 30], [20, 30]])('%d échec(s) → %d s', (n, s) => {
    expect(backoffSeconds(n)).toBe(s);
  });
});
```

`apps/api/src/modules/auth/turnstile.spec.ts` :

```ts
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../http/clock.js';
import { HttpTurnstileVerifier, TurnstileGate, TurnstileVerifier, type VerifierResult } from './turnstile.js';

class FakeVerifier extends TurnstileVerifier {
  next: VerifierResult = 'valid';
  calls = 0;
  async verify() { this.calls++; return this.next; }
}
class FakeClock extends Clock { t = 1_000_000; now() { return new Date(this.t); } }

describe('TurnstileGate (§ 3.2, arbitrage M, R7)', () => {
  it('jeton absent → invalid, sans appel', async () => {
    const v = new FakeVerifier();
    expect(await new TurnstileGate(v, new FakeClock()).check(undefined, '1.2.3.4')).toBe('invalid');
    expect(v.calls).toBe(0);
  });
  it('3 erreurs consécutives → mode dégradé, plus d’appel pendant 60 s, nouvel essai ensuite', async () => {
    const v = new FakeVerifier();
    const clock = new FakeClock();
    const g = new TurnstileGate(v, clock);
    v.next = 'error';
    for (let i = 0; i < 3; i++) expect(await g.check('t', 'ip')).toBe('unavailable');
    expect(g.isDegraded()).toBe(true);
    expect(await g.check('t', 'ip')).toBe('unavailable');
    expect(v.calls).toBe(3);
    clock.t += 60_000;
    expect(g.isDegraded()).toBe(false);
    v.next = 'valid';
    expect(await g.check('t', 'ip')).toBe('valid');
    expect(v.calls).toBe(4);
  });
  it('un délai dépassé met en mode dégradé immédiatement', async () => {
    const v = new FakeVerifier();
    const g = new TurnstileGate(v, new FakeClock());
    v.next = 'timeout';
    expect(await g.check('t', 'ip')).toBe('unavailable');
    expect(g.isDegraded()).toBe(true);
  });
  it('un jeton refusé n’est pas une panne et remet le compteur d’erreurs à zéro', async () => {
    const v = new FakeVerifier();
    const g = new TurnstileGate(v, new FakeClock());
    v.next = 'error'; await g.check('t', 'ip'); await g.check('t', 'ip');
    v.next = 'invalid'; expect(await g.check('t', 'ip')).toBe('invalid');
    v.next = 'error'; await g.check('t', 'ip');
    expect(g.isDegraded()).toBe(false);
  });
});

describe('HttpTurnstileVerifier', () => {
  const server = Fastify();
  let behaviour: 'ok' | 'ko' | '500' | 'slow' = 'ok';
  let lastBody = '';
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, body));
  server.post('/verify', async (req, reply) => {
    lastBody = String(req.body);
    if (behaviour === '500') return reply.code(500).send({});
    if (behaviour === 'slow') await new Promise((r) => setTimeout(r, 300));
    return { success: behaviour === 'ok' };
  });
  let url = '';
  beforeAll(async () => { url = `${await server.listen({ port: 0, host: '127.0.0.1' })}/verify`; });
  afterAll(async () => { await server.close(); });

  it.each([['ok', 'valid'], ['ko', 'invalid'], ['500', 'error']] as const)('%s → %s', async (b, expected) => {
    behaviour = b;
    expect(await new HttpTurnstileVerifier('SECRET', url).verify('tok', '203.0.113.9')).toBe(expected);
  });
  it('envoie le secret, le jeton et l’IP en formulaire', async () => {
    behaviour = 'ok';
    await new HttpTurnstileVerifier('SECRET', url).verify('tok', '203.0.113.9');
    expect(new URLSearchParams(lastBody).get('secret')).toBe('SECRET');
    expect(new URLSearchParams(lastBody).get('response')).toBe('tok');
    expect(new URLSearchParams(lastBody).get('remoteip')).toBe('203.0.113.9');
  });
  it('délai dépassé → timeout', async () => {
    behaviour = 'slow';
    expect(await new HttpTurnstileVerifier('SECRET', url, 50).verify('tok', 'ip')).toBe('timeout');
  });
  it('service injoignable → error', async () => {
    expect(await new HttpTurnstileVerifier('SECRET', 'http://127.0.0.1:1/verify').verify('tok', 'ip')).toBe('error');
  });
  it('n’écrit jamais le secret dans les journaux', async () => {
    const spy = vi.spyOn(console, 'error');
    await new HttpTurnstileVerifier('SECRET-XYZ', 'http://127.0.0.1:1/verify').verify('tok', 'ip');
    expect(spy.mock.calls.flat().join(' ')).not.toContain('SECRET-XYZ');
    spy.mockRestore();
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules/auth` — Expected : FAIL.

- [ ] **Step 2 : Turnstile**

`apps/api/src/modules/auth/turnstile.ts` :

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../http/clock.js';

export type VerifierResult = 'valid' | 'invalid' | 'error' | 'timeout';
export const TURNSTILE_TIMEOUT_MS = 3_000;
export const DEGRADED_RETRY_MS = 60_000;
const ERRORS_BEFORE_DEGRADED = 3;

export abstract class TurnstileVerifier {
  abstract verify(token: string, ip: string): Promise<VerifierResult>;
}

export class HttpTurnstileVerifier extends TurnstileVerifier {
  constructor(private readonly secret: string, private readonly url: string, private readonly timeoutMs = TURNSTILE_TIMEOUT_MS) { super(); }

  async verify(token: string, ip: string): Promise<VerifierResult> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        body: new URLSearchParams({ secret: this.secret, response: token, remoteip: ip }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return 'error';
      const body = (await res.json()) as { success?: unknown };
      return body.success === true ? 'valid' : 'invalid';
    } catch (e) {
      return e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'error';
    }
  }
}

/** Mode dégradé (arbitrage M) : 3 erreurs consécutives ou un délai dépassé ; nouvel essai après 60 s (R7). */
@Injectable()
export class TurnstileGate {
  private readonly logger = new Logger('Turnstile');
  private consecutiveErrors = 0;
  private degradedSince: number | null = null;

  constructor(@Inject(TurnstileVerifier) private readonly verifier: TurnstileVerifier, @Inject(Clock) private readonly clock: Clock) {}

  isDegraded(): boolean {
    return this.degradedSince !== null && this.clock.now().getTime() - this.degradedSince < DEGRADED_RETRY_MS;
  }

  async check(token: string | undefined, ip: string): Promise<'valid' | 'invalid' | 'unavailable'> {
    if (this.isDegraded()) return 'unavailable';
    if (!token) return 'invalid';
    const r = await this.verifier.verify(token, ip);
    if (r === 'valid' || r === 'invalid') {
      this.consecutiveErrors = 0;
      if (this.degradedSince !== null) {
        this.degradedSince = null;
        this.logger.log('turnstile recovered');
      }
      return r;
    }
    this.consecutiveErrors++;
    if (r === 'timeout' || this.consecutiveErrors >= ERRORS_BEFORE_DEGRADED) this.enterDegraded();
    return 'unavailable';
  }

  private enterDegraded(): void {
    this.degradedSince = this.clock.now().getTime();
    // Alerte d'exploitation (§ 3.2) : un événement nommé, sans donnée de la requête.
    this.logger.warn('alert: turnstile unavailable, degraded login limits active');
  }
}
```

Dans `apps/api/src/http/app.ts`, ajouter le champ à `AppOverrides` (le vérificateur existe désormais) :

```ts
import type { TurnstileVerifier } from '../modules/auth/turnstile.js';
// dans AppOverrides :
  /** Vérificateur Turnstile de remplacement (tests). Par défaut : HttpTurnstileVerifier (tâche 10). */
  turnstile?: TurnstileVerifier;
```

- [ ] **Step 3 : Dépôt des seaux et limiteur**

`apps/api/src/modules/auth/rate-limit.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';

/** Seaux à fenêtre fixe (§ 2.2). Toutes les durées sont calculées par l'horloge de la base. */
@Injectable()
export class RateLimitRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Compte une tentative sur le seau de l'IP ; la fenêtre repart si elle est échue. */
  async hit(key: string, windowSeconds: number): Promise<{ attempts: number; resetIn: number }> {
    const r = await this.prisma.client.$queryRaw<{ attempts: number; reset_in: number }[]>`
      insert into app.rate_limit_buckets as b (key, window_start, attempts) values (${key}, clock_timestamp(), 1)
      on conflict (key) do update set
        attempts = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then 1 else b.attempts + 1 end,
        failures = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then 0 else b.failures end,
        window_start = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then clock_timestamp() else b.window_start end
      returning attempts,
        greatest(0, ceil(extract(epoch from (window_start + make_interval(secs => ${windowSeconds}::double precision) - clock_timestamp()))))::int as reset_in`;
    return { attempts: r[0]!.attempts, resetIn: r[0]!.reset_in };
  }

  async readFailures(key: string, windowSeconds: number): Promise<{ failures: number; sinceLastMs: number; resetIn: number } | null> {
    const r = await this.prisma.client.$queryRaw<{ failures: number; since_ms: number; reset_in: number }[]>`
      select failures,
             coalesce((extract(epoch from (clock_timestamp() - last_failure_at)) * 1000)::int, 2147483647) as since_ms,
             greatest(0, ceil(extract(epoch from (window_start + make_interval(secs => ${windowSeconds}::double precision) - clock_timestamp()))))::int as reset_in
        from app.rate_limit_buckets
       where key = ${key} and window_start > clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision)`;
    const row = r[0];
    return row ? { failures: row.failures, sinceLastMs: row.since_ms, resetIn: row.reset_in } : null;
  }

  async addIpFailure(key: string): Promise<number> {
    const r = await this.prisma.client.$queryRaw<{ failures: number }[]>`
      update app.rate_limit_buckets set failures = failures + 1 where key = ${key} returning failures`;
    return r[0]?.failures ?? 0;
  }

  async addAccountFailure(key: string, windowSeconds: number): Promise<number> {
    const r = await this.prisma.client.$queryRaw<{ failures: number }[]>`
      insert into app.rate_limit_buckets as b (key, window_start, failures, last_failure_at) values (${key}, clock_timestamp(), 1, clock_timestamp())
      on conflict (key) do update set
        failures = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then 1 else b.failures + 1 end,
        window_start = case when b.window_start <= clock_timestamp() - make_interval(secs => ${windowSeconds}::double precision) then clock_timestamp() else b.window_start end,
        last_failure_at = clock_timestamp()
      returning failures`;
    return r[0]!.failures;
  }

  async clear(key: string): Promise<void> {
    await this.prisma.client.$executeRaw`delete from app.rate_limit_buckets where key = ${key}`;
  }

  /** Compte borné : ne lit jamais plus de `cap` lignes. */
  async rowCountUpTo(cap: number): Promise<number> {
    const r = await this.prisma.client.$queryRaw<{ n: number }[]>`select count(*)::int as n from (select 1 from app.rate_limit_buckets limit ${cap}::int) s`;
    return r[0]!.n;
  }
}
```

`apps/api/src/modules/auth/login-rate-limiter.ts` :

```ts
import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module.js';
import type { AppConfig } from '../../config/load-config.js';
import { ipPrefix } from '../../http/ip.js';
import { RateLimitRepository } from './rate-limit.repository.js';

export const WINDOW_SECONDS = 900;
export const ACCOUNT_LIMIT = 5;
export const TURNSTILE_AFTER_FAILURES = 3;
export const IP_ALERT_FAILURES = 50;
export const BUCKET_ROW_CAP = 50_000;
export const DEGRADED_LIMITS = { ip: 5, account: 2 } as const;

export type LoginKeys = { ipKey: string; accountKey: string };
export type Gate = { kind: 'allowed'; turnstileRequired: boolean } | { kind: 'limited'; retryAfterSeconds: number };

/** R5 : après le n-ième échec, attendre min(2^(n-1), 30) s. */
export function backoffSeconds(failures: number): number {
  return failures <= 0 ? 0 : Math.min(2 ** (failures - 1), 30);
}

/**
 * Limitation de la connexion (§ 3.2). Un compte n'est jamais bloqué en tant que tel : seuls les seaux
 * « IP » et « IP + compte » existent, de sorte qu'un tiers ne peut bloquer le titulaire depuis une autre IP.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly logger = new Logger('LoginRateLimiter');
  private capWarned = false;

  constructor(@Inject(RateLimitRepository) private readonly repo: RateLimitRepository, @Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** `normalizedEmail` : forme de normalizeEmail ; seul son HMAC entre dans la clé. */
  keys(ip: string, normalizedEmail: string): LoginKeys {
    const prefix = ipPrefix(ip);
    const mac = createHmac('sha256', this.config.security.rateLimitHmacKey).update(normalizedEmail).digest('hex');
    return { ipKey: `ip:${prefix}`, accountKey: `ip+acct:${prefix}:${mac}` };
  }

  async check(keys: LoginKeys, degraded: boolean): Promise<Gate> {
    const ipLimit = degraded ? DEGRADED_LIMITS.ip : this.config.limits.loginPerIp;
    const accountLimit = degraded ? DEGRADED_LIMITS.account : ACCOUNT_LIMIT;
    const ip = await this.repo.hit(keys.ipKey, WINDOW_SECONDS);
    if (ip.attempts > ipLimit) return { kind: 'limited', retryAfterSeconds: Math.max(1, ip.resetIn) };
    const acct = await this.repo.readFailures(keys.accountKey, WINDOW_SECONDS);
    if (acct) {
      if (acct.failures >= accountLimit) return { kind: 'limited', retryAfterSeconds: Math.max(1, acct.resetIn) };
      const waitMs = backoffSeconds(acct.failures) * 1000 - acct.sinceLastMs;
      if (waitMs > 0) return { kind: 'limited', retryAfterSeconds: Math.ceil(waitMs / 1000) };
    }
    return { kind: 'allowed', turnstileRequired: !degraded && (acct?.failures ?? 0) >= TURNSTILE_AFTER_FAILURES };
  }

  async recordFailure(keys: LoginKeys, degraded: boolean): Promise<{ turnstileRequired: boolean }> {
    const ipFailures = await this.repo.addIpFailure(keys.ipKey);
    // Alerte d'exploitation au passage du seuil (§ 3.2), une fois par fenêtre.
    if (ipFailures === IP_ALERT_FAILURES + 1) this.logger.warn(`alert: login failures above ${IP_ALERT_FAILURES} for ${keys.ipKey} in 15 min`);
    if ((await this.repo.rowCountUpTo(BUCKET_ROW_CAP + 1)) > BUCKET_ROW_CAP) {
      // Au-delà de 50 000 lignes, seule la limite par IP s'applique (§ 2.2).
      if (!this.capWarned) this.logger.warn(`alert: rate_limit_buckets above ${BUCKET_ROW_CAP} rows, per-account limit suspended`);
      this.capWarned = true;
      return { turnstileRequired: false };
    }
    this.capWarned = false;
    const failures = await this.repo.addAccountFailure(keys.accountKey, WINDOW_SECONDS);
    return { turnstileRequired: !degraded && failures >= TURNSTILE_AFTER_FAILURES };
  }

  async recordSuccess(keys: LoginKeys): Promise<void> {
    await this.repo.clear(keys.accountKey);
  }
}
```

- [ ] **Step 4 : Intégration du limiteur (sous `cp_app`)**

`apps/api/test/integration/rate-limit.int.spec.ts` :

```ts
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/config/load-config.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { BUCKET_ROW_CAP, LoginRateLimiter } from '../../src/modules/auth/login-rate-limiter.js';
import { RateLimitRepository } from '../../src/modules/auth/rate-limit.repository.js';
import { connectAs, createTestDatabase, dbConfigFor } from '../support/pg.js';

let db: string;
let prisma: PrismaService;
let limiter: LoginRateLimiter;
const config = { security: { rateLimitHmacKey: 'k'.repeat(64) }, limits: { loginPerIp: 3 } } as AppConfig;

beforeAll(async () => {
  db = await createTestDatabase();
  prisma = new PrismaService(dbConfigFor('cp_app', db));
  limiter = new LoginRateLimiter(new RateLimitRepository(prisma), config);
});
afterAll(async () => { await prisma.onModuleDestroy(); });
beforeEach(async () => { await sql('delete from app.rate_limit_buckets'); });

async function sql(text: string, params: unknown[] = []) {
  const c = await connectAs('cp_app', db);
  try { return await c.query(text, params); } finally { await c.end(); }
}
/** Le temps : on vieillit le dernier échec au lieu d'avancer l'horloge (§ 5.3). */
const ageFailures = (key: string) => sql(`update app.rate_limit_buckets set last_failure_at = last_failure_at - interval '1 hour' where key = $1`, [key]);

describe('LoginRateLimiter (§ 3.2)', () => {
  it('clés : préfixe IP et HMAC de l’email, jamais l’email en clair', async () => {
    const k = limiter.keys('2001:db8:1:2:aa::1', 'awa@example.com');
    expect(k.ipKey).toBe('ip:2001:db8:1:2::');
    expect(k.accountKey).toMatch(/^ip\+acct:2001:db8:1:2:::[0-9a-f]{64}$/);
    expect(k.accountKey).not.toContain('awa');
  });
  it('par IP : la tentative au-delà de la limite est refusée jusqu’à la fin de la fenêtre', async () => {
    const k = limiter.keys('203.0.113.1', 'a@example.com');
    for (let i = 0; i < 3; i++) expect((await limiter.check(k, false)).kind).toBe('allowed');
    const g = await limiter.check(k, false);
    expect(g).toMatchObject({ kind: 'limited' });
    expect((g as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(800);
  });
  it('par IP + compte : délai croissant, Turnstile après 3 échecs, refus au 5ᵉ échec', async () => {
    const k = limiter.keys('203.0.113.2', 'b@example.com');
    const big = new LoginRateLimiter(new RateLimitRepository(prisma), { ...config, limits: { ...config.limits, loginPerIp: 100 } } as AppConfig);
    expect(await big.recordFailure(k, false)).toEqual({ turnstileRequired: false });
    expect(await big.check(k, false)).toEqual({ kind: 'limited', retryAfterSeconds: 1 });
    await ageFailures(k.accountKey);
    await big.recordFailure(k, false);
    await ageFailures(k.accountKey);
    expect(await big.recordFailure(k, false)).toEqual({ turnstileRequired: true });
    await ageFailures(k.accountKey);
    expect(await big.check(k, false)).toEqual({ kind: 'allowed', turnstileRequired: true });
    await big.recordFailure(k, false); await ageFailures(k.accountKey);
    await big.recordFailure(k, false); await ageFailures(k.accountKey);
    expect((await big.check(k, false)).kind).toBe('limited');
  });
  it('un compte n’est jamais bloqué depuis une autre IP', async () => {
    const big = new LoginRateLimiter(new RateLimitRepository(prisma), { ...config, limits: { ...config.limits, loginPerIp: 100 } } as AppConfig);
    const attacker = big.keys('198.51.100.66', 'victim@example.com');
    for (let i = 0; i < 5; i++) { await big.recordFailure(attacker, false); await ageFailures(attacker.accountKey); }
    expect((await big.check(attacker, false)).kind).toBe('limited');
    expect(await big.check(big.keys('203.0.113.77', 'victim@example.com'), false)).toEqual({ kind: 'allowed', turnstileRequired: false });
  });
  it('un succès efface le seau IP + compte', async () => {
    const big = new LoginRateLimiter(new RateLimitRepository(prisma), { ...config, limits: { ...config.limits, loginPerIp: 100 } } as AppConfig);
    const k = big.keys('203.0.113.3', 'c@example.com');
    await big.recordFailure(k, false);
    await big.recordSuccess(k);
    expect((await sql('select count(*)::int as n from app.rate_limit_buckets where key = $1', [k.accountKey])).rows[0].n).toBe(0);
  });
  it('mode dégradé : 5 par IP et 2 par couple, sans Turnstile', async () => {
    const big = new LoginRateLimiter(new RateLimitRepository(prisma), { ...config, limits: { ...config.limits, loginPerIp: 100 } } as AppConfig);
    const k = big.keys('203.0.113.4', 'd@example.com');
    await big.recordFailure(k, true); await ageFailures(k.accountKey);
    expect(await big.recordFailure(k, true)).toEqual({ turnstileRequired: false });
    await ageFailures(k.accountKey);
    expect((await big.check(k, true)).kind).toBe('limited');
    const ipOnly = big.keys('203.0.113.5', 'e@example.com');
    for (let i = 0; i < 5; i++) expect((await big.check(ipOnly, true)).kind).toBe('allowed');
    expect((await big.check(ipOnly, true)).kind).toBe('limited');
  });
  it('alerte au 51ᵉ échec d’une IP dans la fenêtre', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const k = limiter.keys('203.0.113.6', 'f@example.com');
    await limiter.check(k, false);
    await sql(`update app.rate_limit_buckets set failures = 50 where key = $1`, [k.ipKey]);
    await limiter.recordFailure(k, false);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/login failures above 50/);
    warn.mockRestore();
  });
  it('au-delà de 50 000 lignes, seule la limite par IP s’applique, avec alerte', async () => {
    await sql(`insert into app.rate_limit_buckets (key, window_start) select 'ip:10.' || (g / 65536) || '.' || ((g / 256) % 256) || '.' || (g % 256), clock_timestamp() from generate_series(1, $1::int) g`, [BUCKET_ROW_CAP + 1]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const k = limiter.keys('203.0.113.7', 'g@example.com');
    await limiter.check(k, false);
    await limiter.recordFailure(k, false);
    expect((await sql('select count(*)::int as n from app.rate_limit_buckets where key = $1', [k.accountKey])).rows[0].n).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/above 50000 rows/);
    warn.mockRestore();
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/modules/auth && pnpm vitest run --project integration apps/api/test/integration/rate-limit.int.spec.ts`
Expected : PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/modules/auth apps/api/src/http/app.ts apps/api/test/integration/rate-limit.int.spec.ts
git commit -m "feat(auth): limitation de la connexion par IP et IP + compte, délai croissant, Turnstile et mode dégradé"
```

---

### Task 9 : Modules `classes` et `memberships` (lot 1) et liste des classes actives

**Files :**
- Create : `apps/api/src/modules/classes/classes.repository.ts`, `classes.service.ts`, `classes.controller.ts`, `classes.module.ts`, `class.dto.ts` ; `apps/api/src/modules/memberships/memberships.repository.ts`, `memberships.service.ts`, `memberships.module.ts`, `enrollment.dto.ts` ; `apps/api/test/support/app.ts`
- Modify : `apps/api/src/http/features.ts`
- Test : `apps/api/test/integration/classes.int.spec.ts`

**Interfaces :**
- Consumes : `AuthzService`, `AuditService`, `PrismaService`, `Public`, `ZodPipe`.
- Produces :
  - `type ClassSummaryDto = { id: string; name: string; level: string; academicYear: string }`
  - `ClassesService` : `listActive(actor: Actor): Promise<ClassSummaryDto[]>`, `lockActiveForEnrollmentInTx(tx, actor: AnonymousActor, classId: string): Promise<void>` (lève `ApiError(400, 'CLASS_NOT_AVAILABLE')`), `summaryOf(actor: UserActor, classId: string): Promise<ClassSummaryDto | null>`, `create(actor: CliActor, input: { name: string; level: string; academicYear: string }): Promise<string>`
  - `GET /api/classes/active` (public) → `200 ClassSummaryDto[]`
  - `type EnrollmentDto = { id: string; status: 'PENDING' | 'ACCEPTED' | 'REFUSED'; class: ClassSummaryDto | null; createdAt: string; decidedAt: string | null; decisionNote: string | null; retryAfter: string | null }`
  - `MembershipsService` : `createRequestInTx(tx, actor: AnonymousActor, input: { userId: string; classId: string }): Promise<string>`, `latestRequestOf(actor: UserActor): Promise<{ id; status; classId; createdAt; decidedAt; decisionNote } | null>`
  - `test/support/app.ts` : `ORIGIN`, `testConfig(db: string, over?: Partial<AppConfig>): AppConfig`, `FakeTurnstile`, `buildTestApp(db: string, opts?: { config?: Partial<AppConfig>; turnstile?: FakeTurnstile }): Promise<TestApp>`, `send(app, method, url, body?, headers?)`, `sessionCookieOf(res): string | undefined`, `insertClass(db, name, opts?): Promise<string>`

- [ ] **Step 1 : Support de test commun**

`apps/api/test/support/app.ts` :

```ts
import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { LightMyRequestResponse } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import type { AppConfig } from '../../src/config/load-config.js';
import { buildApiApp } from '../../src/http/app.js';
import type { RouteInfo } from '../../src/http/routes.js';
import { TurnstileVerifier, type VerifierResult } from '../../src/modules/auth/turnstile.js';
import { connectAs, dbConfigFor } from './pg.js';

export const ORIGIN = 'https://app.test';

export function testConfig(db: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test', httpPort: 0, readyPort: 0, readyHost: '127.0.0.1',
    db: dbConfigFor('cp_app', db),
    http: { origin: ORIGIN, trustProxy: 0, logLevel: 'silent' },
    security: { rateLimitHmacKey: 'test-hmac-key-'.padEnd(64, 'x') },
    turnstile: { secret: 'unused', verifyUrl: 'http://127.0.0.1:1/' },
    limits: { loginPerIp: 100, throttlePerIp: 10_000, throttlePerSession: 10_000 },
    ...over,
  };
}

export class FakeTurnstile extends TurnstileVerifier {
  next: VerifierResult = 'valid';
  calls = 0;
  async verify(): Promise<VerifierResult> { this.calls++; return this.next; }
}

export type TestApp = { app: NestFastifyApplication; routes: RouteInfo[]; turnstile: FakeTurnstile; close: () => Promise<void> };

export async function buildTestApp(db: string, opts: { config?: Partial<AppConfig>; turnstile?: FakeTurnstile } = {}): Promise<TestApp> {
  const turnstile = opts.turnstile ?? new FakeTurnstile();
  const { app, routes } = await buildApiApp(testConfig(db, opts.config), { turnstile });
  return { app, routes, turnstile, close: () => app.close() };
}

let ipSeq = 0;
/** Une IP différente par appel, sauf si le test en impose une (les limitations sont par IP). */
export function freshIp(): string { ipSeq++; return `198.18.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`; }

export function send(app: NestFastifyApplication, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown,
  headers: Record<string, string> = {}, remoteAddress = freshIp()): Promise<LightMyRequestResponse> {
  const mutating = method !== 'GET';
  return app.inject({
    method, url, remoteAddress,
    ...(mutating ? { payload: (body ?? {}) as object } : {}),
    headers: { ...(mutating ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...headers },
  });
}

export function sessionCookieOf(res: LightMyRequestResponse): string | undefined {
  const raw = [res.headers['set-cookie']].flat().filter((v): v is string => typeof v === 'string');
  const c = raw.find((v) => v.startsWith('__Host-cp_session='));
  const value = c?.split(';')[0]?.slice('__Host-cp_session='.length);
  return value ? value : undefined;
}

export const cookieHeader = (token: string) => ({ cookie: `__Host-cp_session=${token}` });

export async function insertClass(db: string, name: string, opts: { year?: string; archived?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  const c = await connectAs('cp_app', db);
  await c.query(`insert into app.classes (id, name, level, academic_year) values ($1, $2, 'L3', $3)`, [id, name, opts.year ?? '2026-2027']);
  await c.end();
  if (opts.archived) {
    // Préparation de donnée : cp_app ne peut pas archiver au lot 1.
    const o = await connectAs('cp_owner', db);
    await o.query(`update app.classes set status = 'ARCHIVED', archived_at = now() where id = $1`, [id]);
    await o.end();
  }
  return id;
}
```

- [ ] **Step 2 : Test d'intégration (échoue)**

`apps/api/test/integration/classes.int.spec.ts` :

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, insertClass, send, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
beforeAll(async () => {
  db = await createTestDatabase();
  await insertClass(db, 'L3 Informatique', { year: '2026-2027' });
  await insertClass(db, 'M1 Réseaux', { year: '2026-2027' });
  await insertClass(db, 'L3 Informatique', { year: '2025-2026', archived: true });
  t = await buildTestApp(db);
});
afterAll(async () => { await t.close(); });

describe('GET /api/classes/active (§ 0.6 : seules les classes actives)', () => {
  it('public, classes actives seulement, triées par année puis nom, DTO minimal', async () => {
    const res = await send(t.app, 'GET', '/api/classes/active');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; academicYear: string }[];
    expect(body.map((c) => `${c.academicYear} ${c.name}`)).toEqual(['2026-2027 L3 Informatique', '2026-2027 M1 Réseaux']);
    expect(Object.keys(body[0]!).sort()).toEqual(['academicYear', 'id', 'level', 'name']);
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/classes.int.spec.ts` — Expected : FAIL (404).

- [ ] **Step 3 : Implémenter `classes`**

`apps/api/src/modules/classes/class.dto.ts` :

```ts
export type ClassSummaryDto = { id: string; name: string; level: string; academicYear: string };
```

`apps/api/src/modules/classes/classes.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import type { ClassSummaryDto } from './class.dto.js';

const SUMMARY = { id: true, name: true, level: true, academicYear: true } as const;

@Injectable()
export class ClassesRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  listActive(): Promise<ClassSummaryDto[]> {
    return this.prisma.client.class.findMany({ where: { status: 'ACTIVE' }, select: SUMMARY, orderBy: [{ academicYear: 'desc' }, { name: 'asc' }] });
  }

  findSummary(id: string): Promise<ClassSummaryDto | null> {
    return this.prisma.client.class.findUnique({ where: { id }, select: SUMMARY });
  }

  /** Verrou partagé de l'ordre global (classes avant users) ; vrai si la classe existe et est active. */
  async lockActiveForShareInTx(tx: TxClient, id: string): Promise<boolean> {
    const r = await tx.$queryRaw<{ active: boolean }[]>`select status = 'ACTIVE' as active from app.classes where id = ${id}::uuid for share`;
    return r[0]?.active === true;
  }

  async createInTx(tx: TxClient, row: { id: string } & Omit<ClassSummaryDto, 'id'>): Promise<void> {
    await tx.class.create({ data: row, select: { id: true } });
  }
}
```

`apps/api/src/modules/classes/classes.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { normalizeName } from '@classepulse/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import { isUniqueViolation } from '../../database/errors.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { Actor, AnonymousActor, CliActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import type { ClassSummaryDto } from './class.dto.js';
import { ClassesRepository } from './classes.repository.js';

const YEAR = /^(\d{4})-(\d{4})$/;

@Injectable()
export class ClassesService {
  constructor(
    @Inject(ClassesRepository) private readonly repo: ClassesRepository,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async listActive(actor: Actor): Promise<ClassSummaryDto[]> {
    this.authz.assert(actor, 'classes.listActive');
    return this.repo.listActive();
  }

  async lockActiveForEnrollmentInTx(tx: TxClient, actor: AnonymousActor, classId: string): Promise<void> {
    this.authz.assert(actor, 'auth.register');
    if (!(await this.repo.lockActiveForShareInTx(tx, classId))) throw new ApiError(400, 'CLASS_NOT_AVAILABLE');
  }

  /** Résumé de la classe d'une demande de l'acteur (écran d'état) ; la vérification d'appartenance arrive au lot 2. */
  async summaryOf(actor: UserActor, classId: string): Promise<ClassSummaryDto | null> {
    this.authz.assert(actor, 'me.read');
    return this.repo.findSummary(classId);
  }

  /** `create-class` (R8). */
  async create(actor: CliActor, input: { name: string; level: string; academicYear: string }): Promise<string> {
    this.authz.assert(actor, 'classes.create');
    const name = normalizeName(input.name);
    const level = normalizeName(input.level);
    const m = YEAR.exec(input.academicYear.trim());
    if ([...name].length < 2 || [...name].length > 80) throw new ApiError(400, 'INVALID_CLASS_NAME');
    if ([...level].length < 1 || [...level].length > 40) throw new ApiError(400, 'INVALID_CLASS_LEVEL');
    if (!m || Number(m[2]) !== Number(m[1]) + 1) throw new ApiError(400, 'INVALID_ACADEMIC_YEAR');
    const id = uuidv7();
    try {
      await this.prisma.withTx(async (tx) => {
        await this.repo.createInTx(tx, { id, name, level, academicYear: input.academicYear.trim() });
        await this.audit.recordInTx(tx, actor, { action: 'CLASS_CREATED', targetType: 'CLASS', targetId: id, metadata: { via: 'cli' } });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError(409, 'CLASS_ALREADY_EXISTS');
      throw e;
    }
    return id;
  }
}
```

`apps/api/src/database/errors.ts` (même style que `tx.ts`) :

```ts
function codeOf(v: unknown, key: string): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const value = (v as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Violation d'unicité, quelle que soit la forme de l'erreur (Prisma P2002 ou SQLSTATE 23505 via l'adaptateur pg). */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  if (codeOf(o, 'code') === 'P2002' || codeOf(o, 'code') === '23505') return true;
  const adapter = (o.meta as Record<string, unknown> | undefined)?.driverAdapterError as Record<string, unknown> | undefined;
  return [codeOf(o.cause, 'code'), codeOf(o.cause, 'originalCode'), codeOf(adapter?.cause, 'originalCode')].includes('23505');
}
```

Ajouter `apps/api/src/database/errors.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors.js';

describe('isUniqueViolation', () => {
  it.each([
    [{ code: 'P2002' }, true],
    [{ code: '23505' }, true],
    [{ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }, true],
    [{ cause: { code: '23505' } }, true],
    [{ code: '23514' }, false],
    [new Error('x'), false],
    [null, false],
  ])('%j → %s', (e, expected) => {
    expect(isUniqueViolation(e)).toBe(expected);
  });
});
```

`apps/api/src/modules/classes/classes.controller.ts` :

```ts
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import '../../http/current-actor.js';
import { Public } from '../../http/public.decorator.js';
import type { ClassSummaryDto } from './class.dto.js';
import { ClassesService } from './classes.service.js';

@Controller('classes')
export class ClassesController {
  constructor(@Inject(ClassesService) private readonly classes: ClassesService) {}

  /** Liste des classes actives, visible à l'inscription (§ 0.6). */
  @Public()
  @Get('active')
  listActive(@Req() req: FastifyRequest): Promise<ClassSummaryDto[]> {
    return this.classes.listActive(req.actor ?? { kind: 'anonymous', ip: req.ip });
  }
}
```

`apps/api/src/modules/classes/classes.module.ts` :

```ts
import { Module } from '@nestjs/common';
import { ClassesController } from './classes.controller.js';
import { ClassesRepository } from './classes.repository.js';
import { ClassesService } from './classes.service.js';

@Module({ controllers: [ClassesController], providers: [ClassesRepository, ClassesService], exports: [ClassesService] })
export class ClassesModule {}
```

- [ ] **Step 4 : Implémenter `memberships`**

`apps/api/src/modules/memberships/enrollment.dto.ts` :

```ts
import type { ClassSummaryDto } from '../classes/class.dto.js';

export type EnrollmentRow = {
  id: string; status: 'PENDING' | 'ACCEPTED' | 'REFUSED'; classId: string;
  createdAt: Date; decidedAt: Date | null; decisionNote: string | null;
};
export type EnrollmentDto = {
  id: string; status: 'PENDING' | 'ACCEPTED' | 'REFUSED'; class: ClassSummaryDto | null;
  createdAt: string; decidedAt: string | null; decisionNote: string | null;
  /** Refus : date à partir de laquelle une nouvelle demande pour cette classe est possible (24 h, § 0.3). */
  retryAfter: string | null;
};
```

`apps/api/src/modules/memberships/memberships.repository.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService, type TxClient } from '../../database/prisma.service.js';
import type { EnrollmentRow } from './enrollment.dto.js';

@Injectable()
export class MembershipsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createRequestInTx(tx: TxClient, row: { id: string; userId: string; classId: string }): Promise<void> {
    // Le trigger enrollment_request_valid vérifie la classe, l'utilisateur et le délai après refus (R9).
    await tx.enrollmentRequest.create({ data: row, select: { id: true } });
  }

  latestForUser(userId: string): Promise<EnrollmentRow | null> {
    return this.prisma.client.enrollmentRequest.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, classId: true, createdAt: true, decidedAt: true, decisionNote: true },
    });
  }
}
```

`apps/api/src/modules/memberships/memberships.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { TxClient } from '../../database/prisma.service.js';
import type { AnonymousActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import type { EnrollmentRow } from './enrollment.dto.js';
import { MembershipsRepository } from './memberships.repository.js';

@Injectable()
export class MembershipsService {
  constructor(@Inject(MembershipsRepository) private readonly repo: MembershipsRepository, @Inject(AuthzService) private readonly authz: AuthzService) {}

  /** Demande d'adhésion créée dans la transaction de l'inscription (§ 0.3). */
  async createRequestInTx(tx: TxClient, actor: AnonymousActor, input: { userId: string; classId: string }): Promise<string> {
    this.authz.assert(actor, 'auth.register');
    const id = uuidv7();
    await this.repo.createRequestInTx(tx, { id, ...input });
    return id;
  }

  async latestRequestOf(actor: UserActor): Promise<EnrollmentRow | null> {
    this.authz.assert(actor, 'me.read');
    return this.repo.latestForUser(actor.userId);
  }
}
```

`apps/api/src/modules/memberships/memberships.module.ts` :

```ts
import { Module } from '@nestjs/common';
import { MembershipsRepository } from './memberships.repository.js';
import { MembershipsService } from './memberships.service.js';

@Module({ providers: [MembershipsRepository, MembershipsService], exports: [MembershipsService] })
export class MembershipsModule {}
```

- [ ] **Step 5 : Brancher les modules**

`apps/api/src/http/features.ts` — `defaultFeatures` renvoie désormais :

```ts
export function defaultFeatures(_config: AppConfig, _o: AppOverrides): DynamicModule['imports'] {
  return [ThrottleGuardModule, AuthzModule, AuditModule, UsersModule, ClassesModule, MembershipsModule];
}
```

(imports correspondants depuis `../modules/*/*.module.js`.)

Run : `pnpm vitest run --project unit apps/api/src/database && pnpm vitest run --project integration apps/api/test/integration/classes.int.spec.ts && pnpm depcruise`
Expected : PASS.

- [ ] **Step 6 : Commit**

```bash
git add apps/api/src/modules/classes apps/api/src/modules/memberships apps/api/src/database/errors.ts apps/api/src/database/errors.spec.ts apps/api/src/http/features.ts apps/api/test
git commit -m "feat(classes): liste publique des classes actives ; demandes d'adhésion (création) ; support de test de l'API"
```

---
### Task 10 : Module `auth` — inscription, connexion, déconnexion

**Files :**
- Create : `apps/api/src/modules/auth/auth.service.ts`, `auth.controller.ts`, `auth.module.ts` ; `apps/api/src/modules/users/me.service.ts`, `me.dto.ts`
- Modify : `apps/api/src/modules/users/users.module.ts`, `apps/api/src/http/features.ts`, `apps/api/test/support/app.ts`
- Test : `apps/api/test/integration/auth-register.int.spec.ts`, `apps/api/test/integration/auth-login.int.spec.ts`

**Interfaces :**
- Consumes : tout ce qui précède (`UsersService`, `PasswordHasher`, `CommonPasswords`, `ClassesService`, `MembershipsService`, `SessionsService`, `LoginRateLimiter`, `TurnstileGate`, `AuditService`, `AuthzService`, `isUniqueViolation`, `sessionSetCookie`, `sessionClearCookie`, `clientContextOf`).
- Produces :
  - `type MeDto = UserProfileDto & { enrollment: EnrollmentDto | null }` ; `MeService.me(actor: UserActor): Promise<MeDto>` (exporté par `UsersModule`)
  - `AuthService` : `register(actor: AnonymousActor, body: RegisterBody, ctx: ClientContext): Promise<OpenedSession>`, `login(actor: AnonymousActor, body: LoginBody, ctx: ClientContext): Promise<OpenedSession>`, `logout(actor: UserActor): Promise<void>`, `changePassword(actor: UserActor, body: ChangePasswordBody, ctx: ClientContext): Promise<void>` (tâche 11)
  - `POST /api/auth/register` (public) → `201 MeDto` + `Set-Cookie` ; erreurs `400 VALIDATION_FAILED | TURNSTILE_FAILED | CLASS_NOT_AVAILABLE | PASSWORD_TOO_SHORT | PASSWORD_TOO_LONG | PASSWORD_TOO_COMMON`, `409 EMAIL_TAKEN`, `503 SIGNUP_UNAVAILABLE`
  - `POST /api/auth/login` (public) → `200 MeDto` + `Set-Cookie` ; erreurs `401 INVALID_CREDENTIALS { turnstileRequired }`, `401 TURNSTILE_REQUIRED { turnstileRequired: true }`, `403 ACCOUNT_SUSPENDED`, `403 ADMIN_SECOND_FACTOR_REQUIRED` (R2), `429 TOO_MANY_ATTEMPTS { retryAfter }` + `Retry-After`
  - `POST /api/auth/logout` → `204` + effacement du cookie
  - `AuthModule.register(config, overrides)` : déclare, **dans cet ordre**, les gardes globaux `AppThrottlerGuard` puis `SessionGuard`

- [ ] **Step 1 : `MeService` (users)**

`apps/api/src/modules/users/me.dto.ts` :

```ts
import type { EnrollmentDto } from '../memberships/enrollment.dto.js';
import type { UserProfileDto } from './user.dto.js';

export type MeDto = UserProfileDto & { enrollment: EnrollmentDto | null };
```

`apps/api/src/modules/users/me.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { UserActor } from '../authz/actor.js';
import { ClassesService } from '../classes/classes.service.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import type { MeDto } from './me.dto.js';
import { UsersService } from './users.service.js';

const REFUSAL_RETRY_MS = 24 * 3600 * 1000;

/** Vue « moi » : profil + dernière demande d'adhésion (écrans d'état, UX § 1.1). */
@Injectable()
export class MeService {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(MembershipsService) private readonly memberships: MembershipsService,
    @Inject(ClassesService) private readonly classes: ClassesService,
  ) {}

  async me(actor: UserActor): Promise<MeDto> {
    const profile = await this.users.profileOf(actor);
    const req = actor.globalRole === 'USER' ? await this.memberships.latestRequestOf(actor) : null;
    if (!req) return { ...profile, enrollment: null };
    return {
      ...profile,
      enrollment: {
        id: req.id,
        status: req.status,
        class: await this.classes.summaryOf(actor, req.classId),
        createdAt: req.createdAt.toISOString(),
        decidedAt: req.decidedAt?.toISOString() ?? null,
        decisionNote: req.decisionNote,
        retryAfter: req.status === 'REFUSED' && req.decidedAt ? new Date(req.decidedAt.getTime() + REFUSAL_RETRY_MS).toISOString() : null,
      },
    };
  }
}
```

`users.module.ts` : `imports: [ClassesModule, MembershipsModule]`, ajouter `MeService` aux `providers` et aux `exports`.

- [ ] **Step 2 : Tests d'inscription (échouent)**

Compléter `apps/api/test/support/app.ts` :

```ts
export const PASSWORD = 'une phrase de passe assez longue';

export function registration(classId: string, over: Record<string, unknown> = {}) {
  const n = Math.random().toString(36).slice(2, 10);
  return { firstName: 'Awa', lastName: 'Diop', email: `awa.${n}@example.com`, password: PASSWORD, classId, turnstileToken: 'tok', ...over };
}

export async function registerStudent(app: NestFastifyApplication, classId: string, over: Record<string, unknown> = {}) {
  const body = registration(classId, over);
  const res = await send(app, 'POST', '/api/auth/register', body);
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  return { token: sessionCookieOf(res)!, email: String(body.email), password: String(body.password), userId: (res.json() as { id: string }).id };
}

export async function query(db: string, sql: string, params: unknown[] = [], role: 'cp_app' | 'cp_owner' = 'cp_app') {
  const c = await connectAs(role, db);
  try { return await c.query(sql, params); } finally { await c.end(); }
}
```

`apps/api/test/integration/auth-register.int.spec.ts` :

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, insertClass, PASSWORD, query, registration, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let classId: string;
let archivedId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  classId = await insertClass(db, 'L3 Informatique');
  archivedId = await insertClass(db, 'L2 Ancienne', { year: '2024-2025', archived: true });
  t = await buildTestApp(db);
});
afterAll(async () => { await t.close(); });

describe('POST /api/auth/register (P1, § 0.3)', () => {
  it('crée le compte, la demande en attente, l’audit et une session, en une transaction', async () => {
    const body = registration(classId, { email: '  Awa.Diop@Example.COM ' });
    const res = await send(t.app, 'POST', '/api/auth/register', body);
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toMatch(/^__Host-cp_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    const me = res.json();
    expect(me).toMatchObject({
      email: 'awa.diop@example.com', firstName: 'Awa', lastName: 'Diop', globalRole: 'USER', emailReminders: true, emailAnnouncements: true,
      enrollment: { status: 'PENDING', class: { id: classId, name: 'L3 Informatique', level: 'L3', academicYear: '2026-2027' }, decidedAt: null, retryAfter: null },
    });
    expect(res.body).not.toContain(PASSWORD);
    const rows = await query(db, `select (select count(*)::int from app.enrollment_requests where user_id = $1 and status = 'PENDING') as req,
      (select count(*)::int from app.sessions where user_id = $1) as sess,
      (select metadata from app.audit_log where action = 'ACCOUNT_REGISTERED' and target_id = $1) as audit,
      (select password_hash from app.users where id = $1) as hash`, [me.id]);
    expect(rows.rows[0]).toMatchObject({ req: 1, sess: 1, audit: { classId, enrollmentRequestId: me.enrollment.id } });
    expect(rows.rows[0].hash).toMatch(/^\$argon2id\$/);
  });
  it('variantes du même email → 409 EMAIL_TAKEN (casse, espaces, pleine largeur)', async () => {
    await send(t.app, 'POST', '/api/auth/register', registration(classId, { email: 'fatou@example.com' }));
    for (const email of ['FATOU@example.com', ' fatou@example.com', 'ｆａｔｏｕ@example.com']) {
      const res = await send(t.app, 'POST', '/api/auth/register', registration(classId, { email }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EMAIL_TAKEN');
    }
  });
  it('deux inscriptions simultanées avec le même email : une 201, une 409', async () => {
    const body = registration(classId, { email: 'twin@example.com' });
    const [a, b] = await Promise.all([send(t.app, 'POST', '/api/auth/register', body), send(t.app, 'POST', '/api/auth/register', body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((await query(db, `select count(*)::int as n from app.users where email = 'twin@example.com'`)).rows[0].n).toBe(1);
  });
  it.each([
    [{ password: 'a'.repeat(14) }, 'PASSWORD_TOO_SHORT'],
    [{ password: 'a'.repeat(129) }, 'PASSWORD_TOO_LONG'],
  ])('mot de passe refusé %#', async (over, code) => {
    const res = await send(t.app, 'POST', '/api/auth/register', registration(classId, over));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });
  it('classe archivée ou inconnue → 400 CLASS_NOT_AVAILABLE, rien n’est créé', async () => {
    for (const id of [archivedId, '0192b1c4-5d6e-7f80-9a1b-2c3d4e5f6a7b']) {
      const body = registration(id);
      const res = await send(t.app, 'POST', '/api/auth/register', body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CLASS_NOT_AVAILABLE');
      expect((await query(db, `select count(*)::int as n from app.users where email = $1`, [body.email])).rows[0].n).toBe(0);
    }
  });
  it('email non ASCII → 400 VALIDATION_FAILED sur email ; champ inconnu → 400', async () => {
    const res = await send(t.app, 'POST', '/api/auth/register', registration(classId, { email: 'élise@example.com' }));
    expect(res.json().error).toEqual({ code: 'VALIDATION_FAILED', fields: ['email'] });
    expect((await send(t.app, 'POST', '/api/auth/register', registration(classId, { globalRole: 'ADMIN' }))).statusCode).toBe(400);
  });
  it('Turnstile refusé → 400 TURNSTILE_FAILED ; indisponible (3 erreurs) → 503 SIGNUP_UNAVAILABLE', async () => {
    const local = await buildTestApp(db);
    try {
      local.turnstile.next = 'invalid';
      const r1 = await send(local.app, 'POST', '/api/auth/register', registration(classId));
      expect(r1.statusCode).toBe(400);
      expect(r1.json().error.code).toBe('TURNSTILE_FAILED');
      local.turnstile.next = 'error';
      for (let i = 0; i < 3; i++) await send(local.app, 'POST', '/api/auth/register', registration(classId));
      const r2 = await send(local.app, 'POST', '/api/auth/register', registration(classId));
      expect(r2.statusCode).toBe(503);
      expect(r2.json().error.code).toBe('SIGNUP_UNAVAILABLE');
      expect(sessionCookieOf(r2)).toBeUndefined();
    } finally {
      await local.close();
    }
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/auth-register.int.spec.ts` — Expected : FAIL (404).

- [ ] **Step 3 : `AuthService`, contrôleur, module**

`apps/api/src/modules/auth/auth.service.ts` :

```ts
import { Inject, Injectable } from '@nestjs/common';
import { normalizePassword, type ChangePasswordBody, type LoginBody, type RegisterBody } from '@classepulse/shared';
import { v7 as uuidv7 } from 'uuid';
import { isUniqueViolation } from '../../database/errors.js';
import { PrismaService } from '../../database/prisma.service.js';
import { ApiError } from '../../http/errors.js';
import { AuditService } from '../audit/audit.service.js';
import type { AnonymousActor, UserActor } from '../authz/actor.js';
import { AuthzService } from '../authz/authz.service.js';
import { ClassesService } from '../classes/classes.service.js';
import { MembershipsService } from '../memberships/memberships.service.js';
import { CommonPasswords } from '../users/common-passwords.js';
import { PasswordHasher } from '../users/password-hasher.js';
import { validateNewPassword } from '../users/password-policy.js';
import { UsersService } from '../users/users.service.js';
import type { ClientContext } from './client-context.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { SessionsService, type OpenedSession } from './sessions.service.js';
import { TurnstileGate } from './turnstile.js';

function tooManyAttempts(retryAfter: number): ApiError {
  return new ApiError(429, 'TOO_MANY_ATTEMPTS', { retryAfter }, { 'retry-after': String(retryAfter) });
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(ClassesService) private readonly classes: ClassesService,
    @Inject(MembershipsService) private readonly memberships: MembershipsService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(LoginRateLimiter) private readonly limiter: LoginRateLimiter,
    @Inject(TurnstileGate) private readonly turnstile: TurnstileGate,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(CommonPasswords) private readonly common: CommonPasswords,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** P1 : compte + demande d'adhésion + session dans une seule transaction (§ 0.3, R3). */
  async register(actor: AnonymousActor, body: RegisterBody, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.register');
    const t = await this.turnstile.check(body.turnstileToken, actor.ip);
    if (t === 'unavailable') throw new ApiError(503, 'SIGNUP_UNAVAILABLE');
    if (t === 'invalid') throw new ApiError(400, 'TURNSTILE_FAILED');
    const pw = validateNewPassword(body.password, 'USER', this.common);
    if (!pw.ok) throw new ApiError(400, pw.code);
    const passwordHash = await this.hasher.hash(pw.normalized);
    const userId = uuidv7();
    try {
      return await this.prisma.withTx(async (tx) => {
        // Ordre global des verrous : classes, puis users, puis enrollment_requests, puis sessions.
        await this.classes.lockActiveForEnrollmentInTx(tx, actor, body.classId);
        await this.users.createStudentInTx(tx, actor, { id: userId, email: body.email, firstName: body.firstName, lastName: body.lastName, passwordHash });
        const enrollmentRequestId = await this.memberships.createRequestInTx(tx, actor, { userId, classId: body.classId });
        await this.audit.recordInTx(tx, actor, { action: 'ACCOUNT_REGISTERED', targetType: 'USER', targetId: userId, metadata: { classId: body.classId, enrollmentRequestId } });
        return this.sessions.openInTx(tx, { id: userId, globalRole: 'USER' }, ctx);
      });
    } catch (e) {
      // Arbitrage N : l'inscription peut révéler qu'un compte existe ; Turnstile et la limitation réduisent l'énumération.
      if (isUniqueViolation(e)) throw new ApiError(409, 'EMAIL_TAKEN');
      throw e;
    }
  }

  /** P2 : message identique dans tous les cas ; hachage factice ; suspension signalée après un mot de passe correct. */
  async login(actor: AnonymousActor, body: LoginBody, ctx: ClientContext): Promise<OpenedSession> {
    this.authz.assert(actor, 'auth.login');
    const keys = this.limiter.keys(actor.ip, body.email);
    const degraded = this.turnstile.isDegraded();
    const gate = await this.limiter.check(keys, degraded);
    if (gate.kind === 'limited') throw tooManyAttempts(gate.retryAfterSeconds);
    if (gate.turnstileRequired) {
      const t = await this.turnstile.check(body.turnstileToken, actor.ip);
      if (t === 'invalid') throw new ApiError(401, 'TURNSTILE_REQUIRED', { turnstileRequired: true });
      // 'unavailable' : Turnstile vient de passer en mode dégradé ; les limites réduites s'appliquent aux tentatives suivantes.
    }
    const password = normalizePassword(body.password);
    const user = await this.users.findForLogin(actor, body.email);
    const ok = user?.passwordHash ? await this.hasher.verify(user.passwordHash, password) : await this.hasher.verifyDummy(password);
    if (!user || !ok) {
      const { turnstileRequired } = await this.limiter.recordFailure(keys, degraded);
      throw new ApiError(401, 'INVALID_CREDENTIALS', { turnstileRequired });
    }
    await this.limiter.recordSuccess(keys);
    if (user.status === 'SUSPENDED') throw new ApiError(403, 'ACCOUNT_SUSPENDED');
    if (user.globalRole === 'ADMIN') throw new ApiError(403, 'ADMIN_SECOND_FACTOR_REQUIRED'); // R2 : code par email au lot 1b
    return this.prisma.withTx((tx) => this.sessions.openInTx(tx, { id: user.id, globalRole: 'USER' }, ctx));
  }

  logout(actor: UserActor): Promise<void> {
    return this.sessions.logout(actor);
  }

  /** P10 : mot de passe actuel exigé ; les autres sessions sont révoquées (§ 3.4). */
  async changePassword(actor: UserActor, body: ChangePasswordBody, ctx: ClientContext): Promise<void> {
    const me = await this.users.credentialsOf(actor);
    const keys = this.limiter.keys(ctx.ip, me.email);
    const degraded = this.turnstile.isDegraded();
    const gate = await this.limiter.check(keys, degraded);
    if (gate.kind === 'limited') throw tooManyAttempts(gate.retryAfterSeconds);
    const ok = me.passwordHash ? await this.hasher.verify(me.passwordHash, normalizePassword(body.currentPassword)) : false;
    if (!ok) {
      await this.limiter.recordFailure(keys, degraded); // R6
      throw new ApiError(400, 'CURRENT_PASSWORD_INVALID');
    }
    await this.limiter.recordSuccess(keys);
    const pw = validateNewPassword(body.newPassword, me.globalRole, this.common);
    if (!pw.ok) throw new ApiError(400, pw.code);
    const passwordHash = await this.hasher.hash(pw.normalized);
    await this.prisma.withTx(async (tx) => {
      await this.users.setPasswordHashInTx(tx, actor, passwordHash);
      const revokedSessions = await this.sessions.revokeOthersInTx(tx, actor, 'PASSWORD_CHANGED');
      await this.sessions.markReauthInTx(tx, actor);
      await this.audit.recordInTx(tx, actor, { action: 'PASSWORD_CHANGED', targetType: 'USER', targetId: actor.userId, metadata: { revokedSessions } });
    });
  }
}
```

`apps/api/src/modules/auth/auth.controller.ts` :

```ts
import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { LoginBody, RegisterBody } from '@classepulse/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentActor } from '../../http/current-actor.js';
import { Public } from '../../http/public.decorator.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { MeDto } from '../users/me.dto.js';
import { MeService } from '../users/me.service.js';
import { AuthService } from './auth.service.js';
import { clientContextOf } from './client-context.js';
import { sessionClearCookie, sessionSetCookie } from './session-cookie.js';

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(MeService) private readonly me: MeService) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(@Body(new ZodPipe(RegisterBody)) body: RegisterBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<MeDto> {
    const opened = await this.auth.register({ kind: 'anonymous', ip: req.ip }, body, clientContextOf(req));
    reply.header('set-cookie', sessionSetCookie(opened.token, opened.maxAgeSeconds));
    return this.me.me(opened.actor);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginBody)) body: LoginBody, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): Promise<MeDto> {
    const opened = await this.auth.login({ kind: 'anonymous', ip: req.ip }, body, clientContextOf(req));
    reply.header('set-cookie', sessionSetCookie(opened.token, opened.maxAgeSeconds));
    return this.me.me(opened.actor);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentActor() actor: UserActor, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.auth.logout(actor);
    reply.header('set-cookie', sessionClearCookie());
  }
}
```

`apps/api/src/modules/auth/auth.module.ts` :

```ts
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { AppConfig } from '../../config/load-config.js';
import type { AppOverrides } from '../../http/app.js';
import { AppThrottlerGuard } from '../../http/features.js';
import { ClassesModule } from '../classes/classes.module.js';
import { MembershipsModule } from '../memberships/memberships.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { RateLimitRepository } from './rate-limit.repository.js';
import { SessionGuard } from './session.guard.js';
import { SessionsRepository } from './sessions.repository.js';
import { SessionsService } from './sessions.service.js';
import { HttpTurnstileVerifier, TurnstileGate, TurnstileVerifier } from './turnstile.js';

@Module({})
export class AuthModule {
  static register(config: AppConfig, o: AppOverrides): DynamicModule {
    return {
      module: AuthModule,
      imports: [UsersModule, ClassesModule, MembershipsModule],
      controllers: [AuthController],
      providers: [
        // Ordre des gardes globaux : limitation générale, PUIS session (aucune lecture en base avant la limitation).
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_GUARD, useClass: SessionGuard },
        { provide: TurnstileVerifier, useValue: o.turnstile ?? new HttpTurnstileVerifier(config.turnstile.secret, config.turnstile.verifyUrl) },
        TurnstileGate, RateLimitRepository, LoginRateLimiter, SessionsRepository, SessionsService, AuthService,
      ],
      exports: [SessionsService, AuthService],
    };
  }
}
```

`apps/api/src/http/features.ts` — `defaultFeatures` :

```ts
export function defaultFeatures(config: AppConfig, o: AppOverrides): DynamicModule['imports'] {
  // La limitation générale est déclarée par AuthModule, avant le garde de session.
  return [AuthzModule, AuditModule, UsersModule, ClassesModule, MembershipsModule, AuthModule.register(config, o)];
}
```

`ThrottleGuardModule` reste exporté pour `app.spec.ts` (tâche 4).

Run : `pnpm vitest run --project integration apps/api/test/integration/auth-register.int.spec.ts apps/api/test/integration/classes.int.spec.ts` — Expected : PASS.

- [ ] **Step 4 : Tests de connexion et de déconnexion**

`apps/api/test/integration/auth-login.int.spec.ts` :

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, PASSWORD, query, registerStudent, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let classId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  classId = await insertClass(db, 'L3 Informatique');
  t = await buildTestApp(db);
});
afterAll(async () => { await t.close(); });

const login = (body: Record<string, unknown>, ip?: string) => send(t.app, 'POST', '/api/auth/login', body, {}, ip);
const withoutId = (b: { error: unknown }) => b.error;
const ageFailures = () => query(db, `update app.rate_limit_buckets set last_failure_at = last_failure_at - interval '1 hour' where key like 'ip+acct:%'`);

describe('POST /api/auth/login (P2, § 3.2)', () => {
  it('succès : nouveau jeton à chaque connexion, cookie aux bons attributs', async () => {
    const s = await registerStudent(t.app, classId);
    const a = await login({ email: s.email, password: PASSWORD });
    const b = await login({ email: s.email, password: PASSWORD });
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ email: s.email, enrollment: { status: 'PENDING' } });
    expect(sessionCookieOf(a)).not.toBe(sessionCookieOf(b));
    expect(sessionCookieOf(a)).not.toBe(s.token);
  });
  it('réponse identique : email inconnu, mauvais mot de passe, compte supprimé', async () => {
    const s = await registerStudent(t.app, classId);
    const deleted = await registerStudent(t.app, classId);
    await query(db, `update app.users set status = 'DELETED', global_role = 'USER', email = null, first_name = null, last_name = null,
      password_hash = null, email_reminders = false, email_announcements = false, deleted_at = now() where id = $1`, [deleted.userId], 'cp_owner');
    const r1 = await login({ email: 'nobody@example.com', password: PASSWORD });
    const r2 = await login({ email: s.email, password: `${PASSWORD}!` });
    const r3 = await login({ email: deleted.email, password: PASSWORD });
    for (const r of [r1, r2, r3]) expect(r.statusCode).toBe(401);
    expect(withoutId(r1.json())).toEqual({ code: 'INVALID_CREDENTIALS', turnstileRequired: false });
    expect(withoutId(r2.json())).toEqual(withoutId(r1.json()));
    expect(withoutId(r3.json())).toEqual(withoutId(r1.json()));
    expect(r1.headers['set-cookie']).toBeUndefined();
  });
  it('suspension signalée seulement après un mot de passe correct', async () => {
    const s = await registerStudent(t.app, classId);
    await query(db, `update app.users set status = 'SUSPENDED' where id = $1`, [s.userId], 'cp_owner');
    expect((await login({ email: s.email, password: 'mauvais mot de passe long' })).json().error.code).toBe('INVALID_CREDENTIALS');
    const ok = await login({ email: s.email, password: PASSWORD });
    expect(ok.statusCode).toBe(403);
    expect(ok.json().error.code).toBe('ACCOUNT_SUSPENDED');
  });
  it('administrateur (R2) : 403 ADMIN_SECOND_FACTOR_REQUIRED, aucune session', async () => {
    const s = await registerStudent(t.app, classId);
    // Préparation de donnée : promotion directe par le propriétaire (le parcours de promotion arrive au lot 2).
    await query(db, `update app.users set global_role = 'ADMIN' where id = $1`, [s.userId], 'cp_owner');
    const before = (await query(db, `select count(*)::int as n from app.sessions where user_id = $1`, [s.userId])).rows[0].n;
    const res = await login({ email: s.email, password: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ADMIN_SECOND_FACTOR_REQUIRED');
    expect(sessionCookieOf(res)).toBeUndefined();
    expect((await query(db, `select count(*)::int as n from app.sessions where user_id = $1`, [s.userId])).rows[0].n).toBe(before);
  });
  it('variantes de l’email : même seau ; Turnstile demandé après 3 échecs ; 429 au-delà de 5', async () => {
    const s = await registerStudent(t.app, classId, { email: 'variant@example.com' });
    const ip = '203.0.113.40';
    for (const email of ['variant@example.com', ' VARIANT@example.com', 'ｖａｒｉａｎｔ@example.com']) {
      await login({ email, password: 'mauvais mot de passe long' }, ip);
      await ageFailures();
    }
    const needs = await login({ email: s.email, password: PASSWORD }, ip);
    expect(needs.statusCode).toBe(401);
    expect(needs.json().error).toEqual({ code: 'TURNSTILE_REQUIRED', turnstileRequired: true });
    t.turnstile.next = 'invalid';
    expect((await login({ email: s.email, password: PASSWORD, turnstileToken: 'bad' }, ip)).json().error.code).toBe('TURNSTILE_REQUIRED');
    t.turnstile.next = 'valid';
    for (let i = 0; i < 2; i++) {
      await login({ email: s.email, password: 'mauvais mot de passe long', turnstileToken: 'tok' }, ip);
      await ageFailures();
    }
    const limited = await login({ email: s.email, password: PASSWORD, turnstileToken: 'tok' }, ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Depuis une autre IP, le titulaire se connecte (un compte n'est jamais bloqué).
    expect((await login({ email: s.email, password: PASSWORD }, '203.0.113.41')).statusCode).toBe(200);
  });
  it('délai croissant : une tentative immédiatement après un échec → 429 Retry-After: 1', async () => {
    const s = await registerStudent(t.app, classId);
    const ip = '203.0.113.42';
    await login({ email: s.email, password: 'mauvais mot de passe long' }, ip);
    const r = await login({ email: s.email, password: PASSWORD }, ip);
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBe('1');
  });
  it('mode dégradé de Turnstile : 2 échecs par couple IP + compte suffisent à limiter', async () => {
    const local = await buildTestApp(db);
    try {
      local.turnstile.next = 'error';
      // Trois erreurs du service (via l'inscription) → mode dégradé.
      for (let i = 0; i < 3; i++) await send(local.app, 'POST', '/api/auth/register', { firstName: 'Awa', lastName: 'Diop', email: `deg${i}@example.com`, password: PASSWORD, classId, turnstileToken: 'tok' });
      const s = await registerStudent(t.app, classId);
      const ip = '203.0.113.43';
      for (let i = 0; i < 2; i++) {
        await send(local.app, 'POST', '/api/auth/login', { email: s.email, password: 'mauvais mot de passe long' }, {}, ip);
        await ageFailures();
      }
      expect((await send(local.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD }, {}, ip)).statusCode).toBe(429);
    } finally {
      await local.close();
    }
  });
});

describe('POST /api/auth/logout', () => {
  it('204, cookie effacé aux mêmes attributs, jeton inutilisable ensuite', async () => {
    const s = await registerStudent(t.app, classId);
    const out = await send(t.app, 'POST', '/api/auth/logout', {}, cookieHeader(s.token));
    expect(out.statusCode).toBe(204);
    expect(out.headers['set-cookie']).toBe('__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    const again = await send(t.app, 'POST', '/api/auth/logout', {}, cookieHeader(s.token));
    expect(again.statusCode).toBe(401);
    expect(again.headers['set-cookie']).toBe('__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    expect((await query(db, `select revoke_reason from app.sessions where user_id = $1`, [s.userId])).rows).toEqual([{ revoke_reason: 'LOGOUT' }]);
  });
  it('sans cookie → 401 sans Set-Cookie', async () => {
    const res = await send(t.app, 'POST', '/api/auth/logout', {});
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/auth-login.int.spec.ts apps/api/test/integration/auth-register.int.spec.ts`
Expected : PASS.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "feat(auth): inscription (compte + demande + session en une transaction), connexion, déconnexion"
```

---

### Task 11 : Profil, préférences, mot de passe et sessions (`/api/me…`)

**Files :**
- Create : `apps/api/src/modules/users/users.controller.ts`, `apps/api/src/modules/auth/account.controller.ts`
- Modify : `apps/api/src/modules/users/users.module.ts`, `apps/api/src/modules/auth/auth.module.ts`
- Test : `apps/api/test/integration/account.int.spec.ts`

**Interfaces :**
- Consumes : `MeService`, `UsersService`, `AuthService.changePassword`, `SessionsService.list/revokeOthers`, `CurrentActor`, `ZodPipe`, schémas `UpdateProfileBody`, `UpdatePreferencesBody`, `ChangePasswordBody`.
- Produces :
  - `GET /api/me` → `200 MeDto`
  - `PATCH /api/me/profile` → `200 MeDto` ; `PATCH /api/me/email-preferences` → `200 MeDto` (`403` pour un administrateur)
  - `POST /api/me/password` → `204` ; `400 CURRENT_PASSWORD_INVALID | PASSWORD_TOO_SHORT | PASSWORD_TOO_LONG | PASSWORD_TOO_COMMON` ; `429 TOO_MANY_ATTEMPTS`
  - `GET /api/me/sessions` → `200 SessionDto[]` ; `POST /api/me/sessions/revoke-others` → `200 { revoked: number }`

- [ ] **Step 1 : Tests (échouent)**

`apps/api/test/integration/account.int.spec.ts` :

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, PASSWORD, query, registerStudent, send, sessionCookieOf, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

let db: string;
let t: TestApp;
let classId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  classId = await insertClass(db, 'L3 Informatique');
  t = await buildTestApp(db);
});
afterAll(async () => { await t.close(); });

const NEW_PASSWORD = 'une autre phrase de passe bien longue';

describe('GET /api/me', () => {
  it('200 : profil et demande en attente ; 401 sans session', async () => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: s.userId, email: s.email, enrollment: { status: 'PENDING', class: { id: classId } } });
    expect(res.json()).not.toHaveProperty('passwordHash');
    expect((await send(t.app, 'GET', '/api/me')).statusCode).toBe(401);
  });
  it('refus : motif et date de nouvelle demande (24 h après la décision)', async () => {
    const s = await registerStudent(t.app, classId);
    await query(db, `update app.enrollment_requests set status = 'REFUSED', decided_at = '2026-10-14T10:00:00Z', decided_by = user_id, decision_note = 'Classe complète' where user_id = $1`, [s.userId], 'cp_owner');
    const me = (await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token))).json();
    expect(me.enrollment).toMatchObject({ status: 'REFUSED', decisionNote: 'Classe complète', decidedAt: '2026-10-14T10:00:00.000Z', retryAfter: '2026-10-15T10:00:00.000Z' });
  });
});

describe('PATCH /api/me/profile et /api/me/email-preferences', () => {
  it('normalise les noms ; champ inconnu → 400 ; nom trop court → 400', async () => {
    const s = await registerStudent(t.app, classId);
    const ok = await send(t.app, 'PATCH', '/api/me/profile', { firstName: '  Fatou  Binetou ', lastName: 'Ndiaye' }, cookieHeader(s.token));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ firstName: 'Fatou Binetou', lastName: 'Ndiaye' });
    expect((await send(t.app, 'PATCH', '/api/me/profile', { firstName: 'Fatou', lastName: 'Ndiaye', email: 'x@example.com' }, cookieHeader(s.token))).statusCode).toBe(400);
    expect((await send(t.app, 'PATCH', '/api/me/profile', { firstName: 'F', lastName: 'Ndiaye' }, cookieHeader(s.token))).json().error).toEqual({ code: 'VALIDATION_FAILED', fields: ['firstName'] });
  });
  it('préférences : un seul champ suffit ; corps vide → 400', async () => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'PATCH', '/api/me/email-preferences', { emailReminders: false }, cookieHeader(s.token));
    expect(res.json()).toMatchObject({ emailReminders: false, emailAnnouncements: true });
    expect((await send(t.app, 'PATCH', '/api/me/email-preferences', {}, cookieHeader(s.token))).statusCode).toBe(400);
  });
});

describe('POST /api/me/password (P10)', () => {
  it('204 : nouveau mot de passe, autres sessions révoquées, session courante gardée, audit', async () => {
    const s = await registerStudent(t.app, classId);
    const other = sessionCookieOf(await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD }))!;
    const res = await send(t.app, 'POST', '/api/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, cookieHeader(s.token));
    expect(res.statusCode).toBe(204);
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token))).statusCode).toBe(200);
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(other))).statusCode).toBe(401);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD })).statusCode).toBe(401);
    expect((await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: NEW_PASSWORD })).statusCode).toBe(200);
    const audit = await query(db, `select metadata from app.audit_log where action = 'PASSWORD_CHANGED' and target_id = $1`, [s.userId]);
    expect(audit.rows).toEqual([{ metadata: { revokedSessions: 1 } }]);
    const reasons = await query(db, `select revoke_reason from app.sessions where user_id = $1 and revoked_at is not null`, [s.userId]);
    expect(reasons.rows).toEqual([{ revoke_reason: 'PASSWORD_CHANGED' }]);
  });
  it('mot de passe actuel faux → 400 CURRENT_PASSWORD_INVALID (jamais 401, la session reste valide)', async () => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/me/password', { currentPassword: 'faux mot de passe long', newPassword: NEW_PASSWORD }, cookieHeader(s.token));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CURRENT_PASSWORD_INVALID');
    expect((await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token))).statusCode).toBe(200);
  });
  it.each([['a'.repeat(14), 'PASSWORD_TOO_SHORT'], ['a'.repeat(129), 'PASSWORD_TOO_LONG']])('nouveau mot de passe refusé %#', async (newPassword, code) => {
    const s = await registerStudent(t.app, classId);
    const res = await send(t.app, 'POST', '/api/me/password', { currentPassword: PASSWORD, newPassword }, cookieHeader(s.token));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });
});

describe('sessions actives', () => {
  it('liste avec « cet appareil », puis déconnexion des autres appareils', async () => {
    const s = await registerStudent(t.app, classId);
    await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD }, { 'user-agent': 'Téléphone' });
    const list = (await send(t.app, 'GET', '/api/me/sessions', undefined, cookieHeader(s.token))).json() as { current: boolean; userAgent: string | null }[];
    expect(list).toHaveLength(2);
    expect(list.filter((x) => x.current)).toHaveLength(1);
    expect(list.map((x) => x.userAgent)).toContain('Téléphone');
    const res = await send(t.app, 'POST', '/api/me/sessions/revoke-others', {}, cookieHeader(s.token));
    expect(res.json()).toEqual({ revoked: 1 });
    expect((await send(t.app, 'GET', '/api/me/sessions', undefined, cookieHeader(s.token))).json()).toHaveLength(1);
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/account.int.spec.ts` — Expected : FAIL (404).

- [ ] **Step 2 : Contrôleurs**

`apps/api/src/modules/users/users.controller.ts` :

```ts
import { Body, Controller, Get, HttpCode, Inject, Patch } from '@nestjs/common';
import { UpdatePreferencesBody, UpdateProfileBody } from '@classepulse/shared';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import type { MeDto } from './me.dto.js';
import { MeService } from './me.service.js';
import { UsersService } from './users.service.js';

@Controller('me')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService, @Inject(MeService) private readonly meService: MeService) {}

  @Get()
  me(@CurrentActor() actor: UserActor): Promise<MeDto> {
    return this.meService.me(actor);
  }

  @Patch('profile')
  @HttpCode(200)
  async profile(@CurrentActor() actor: UserActor, @Body(new ZodPipe(UpdateProfileBody)) body: UpdateProfileBody): Promise<MeDto> {
    await this.users.updateProfile(actor, body);
    return this.meService.me(actor);
  }

  @Patch('email-preferences')
  @HttpCode(200)
  async preferences(@CurrentActor() actor: UserActor, @Body(new ZodPipe(UpdatePreferencesBody)) body: UpdatePreferencesBody): Promise<MeDto> {
    await this.users.updatePreferences(actor, body);
    return this.meService.me(actor);
  }
}
```

`apps/api/src/modules/auth/account.controller.ts` :

```ts
import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ChangePasswordBody } from '@classepulse/shared';
import type { FastifyRequest } from 'fastify';
import { CurrentActor } from '../../http/current-actor.js';
import { ZodPipe } from '../../http/zod.pipe.js';
import type { UserActor } from '../authz/actor.js';
import { AuthService } from './auth.service.js';
import { clientContextOf } from './client-context.js';
import { SessionsService, type SessionDto } from './sessions.service.js';

@Controller('me')
export class AccountController {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(SessionsService) private readonly sessions: SessionsService) {}

  @Post('password')
  @HttpCode(204)
  async changePassword(@CurrentActor() actor: UserActor, @Body(new ZodPipe(ChangePasswordBody)) body: ChangePasswordBody, @Req() req: FastifyRequest): Promise<void> {
    await this.auth.changePassword(actor, body, clientContextOf(req));
  }

  @Get('sessions')
  list(@CurrentActor() actor: UserActor): Promise<SessionDto[]> {
    return this.sessions.list(actor);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  async revokeOthers(@CurrentActor() actor: UserActor): Promise<{ revoked: number }> {
    return { revoked: await this.sessions.revokeOthers(actor) };
  }
}
```

`users.module.ts` : `controllers: [UsersController]`. `auth.module.ts` : `controllers: [AuthController, AccountController]`.

Run : `pnpm vitest run --project integration apps/api/test/integration/account.int.spec.ts && pnpm depcruise`
Expected : PASS.

- [ ] **Step 3 : Commit**

```bash
git add apps/api/src apps/api/test/integration/account.int.spec.ts
git commit -m "feat(users): profil, préférences, changement de mot de passe et sessions actives"
```

---

### Task 12 : Commandes `create-admin` et `create-class`, README

**Files :**
- Create : `apps/api/src/cli.ts`, `apps/api/src/cli/cli.module.ts`, `apps/api/src/cli/read-password.ts`
- Modify : `apps/api/package.json` (script `cli`), `README.md`, `apps/api/test/support/app.ts`
- Test : `apps/api/src/cli/read-password.spec.ts`, `apps/api/test/integration/cli.int.spec.ts`

**Interfaces :**
- Consumes : `UsersService.createFirstAdmin`, `ClassesService.create`, `loadConfig`, `ApiError`.
- Produces :
  - `node dist/src/cli.js create-admin --email … --first-name … --last-name …` (mot de passe sur l'entrée standard) ; `… create-class --name … --level … --year AAAA-AAAA` ; codes de sortie `0` (succès), `1` (erreur, une ligne `erreur : <CODE>` sur stderr), `2` (usage)
  - `readPassword(stdin, out): Promise<string>` (TTY : saisie masquée et confirmation ; sinon première ligne de l'entrée standard)
  - en développement : `pnpm --filter @classepulse/api cli create-admin …` (`tsx --conditions=source src/cli.ts`)

- [ ] **Step 1 : Lecture du mot de passe (tests d'abord)**

`apps/api/src/cli/read-password.spec.ts` :

```ts
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readPassword } from './read-password.js';

describe('readPassword (entrée standard non interactive)', () => {
  it('lit la première ligne, sans le saut de ligne, espaces conservés', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    stdin.end(' mot de passe administrateur \nligne ignorée\n');
    await expect(readPassword(stdin as never, new PassThrough() as never)).resolves.toBe(' mot de passe administrateur ');
  });
  it('accepte les fins de ligne Windows', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    stdin.end('secret-windows-1234\r\n');
    await expect(readPassword(stdin as never, new PassThrough() as never)).resolves.toBe('secret-windows-1234');
  });
});
```

`apps/api/src/cli/read-password.ts` :

```ts
export class CliError extends Error {
  constructor(readonly code: string) { super(code); }
}

type In = NodeJS.ReadStream & { isTTY?: boolean };

function promptHidden(stdin: In, out: NodeJS.WritableStream, label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { stdin.off('data', onData); stdin.setRawMode?.(false); stdin.pause(); out.write('\n'); };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { cleanup(); resolve(value); return; }
        if (ch === '\u0003') { cleanup(); reject(new CliError('CANCELLED')); return; }
        if (ch === '\u007f' || ch === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        value += ch;
      }
    };
    out.write(label);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Mot de passe lu sur l'entrée standard (§ 3.2), jamais en argument ni en variable d'environnement. */
export async function readPassword(stdin: In = process.stdin, out: NodeJS.WritableStream = process.stderr): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(Buffer.from(c as Buffer));
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  const first = await promptHidden(stdin, out, 'Mot de passe : ');
  const second = await promptHidden(stdin, out, 'Confirme le mot de passe : ');
  if (first !== second) throw new CliError('PASSWORDS_DO_NOT_MATCH');
  return first;
}
```

- [ ] **Step 2 : Module et point d'entrée**

`apps/api/src/cli/cli.module.ts` :

```ts
import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import type { AppConfig } from '../config/load-config.js';
import { DatabaseModule } from '../database/database.module.js';
import { CoreModule } from '../http/core.module.js';
import { AuditModule } from '../modules/audit/audit.module.js';
import { AuthzModule } from '../modules/authz/authz.module.js';
import { ClassesModule } from '../modules/classes/classes.module.js';
import { UsersModule } from '../modules/users/users.module.js';

@Module({})
export class CliModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: CliModule, imports: [ConfigModule.forRoot(config), DatabaseModule, CoreModule.forRoot(), AuthzModule, AuditModule, UsersModule, ClassesModule] };
  }
}
```

`apps/api/src/cli.ts` :

```ts
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { CliModule } from './cli/cli.module.js';
import { CliError, readPassword } from './cli/read-password.js';
import { loadConfig } from './config/load-config.js';
import { ApiError } from './http/errors.js';
import { ClassesService } from './modules/classes/classes.service.js';
import { UsersService } from './modules/users/users.service.js';

const USAGE = 'usage : cli create-admin --email <email> --first-name <prénom> --last-name <nom>   (mot de passe sur l’entrée standard)\n'
  + '        cli create-class --name <nom> --level <niveau> --year <AAAA-AAAA>\n';

/** Seule la catégorie de l'erreur est affichée : jamais de message ni de trace (une valeur saisie pourrait y figurer). */
function category(e: unknown): string {
  if (e instanceof ApiError || e instanceof CliError) return e.code;
  if (e instanceof TypeError && (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) return 'INVALID_ARGUMENTS';
  return 'UNEXPECTED';
}

function required(values: Record<string, string | boolean | undefined>, names: string[]): string[] {
  return names.map((n) => {
    const v = values[n];
    if (typeof v !== 'string' || v.length === 0) throw new CliError('INVALID_ARGUMENTS');
    return v;
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== 'create-admin' && command !== 'create-class') { process.stderr.write(USAGE); return 2; }
  const ctx = await NestFactory.createApplicationContext(CliModule.forRoot(loadConfig(process.env)), { logger: false });
  try {
    if (command === 'create-admin') {
      const { values } = parseArgs({ args: rest, strict: true, options: { email: { type: 'string' }, 'first-name': { type: 'string' }, 'last-name': { type: 'string' } } });
      const [email, firstName, lastName] = required(values, ['email', 'first-name', 'last-name']);
      const password = await readPassword();
      await ctx.get(UsersService).createFirstAdmin({ kind: 'cli', command }, { email: email!, firstName: firstName!, lastName: lastName!, password });
      process.stdout.write('administrateur créé\n');
    } else {
      const { values } = parseArgs({ args: rest, strict: true, options: { name: { type: 'string' }, level: { type: 'string' }, year: { type: 'string' } } });
      const [name, level, academicYear] = required(values, ['name', 'level', 'year']);
      const id = await ctx.get(ClassesService).create({ kind: 'cli', command }, { name: name!, level: level!, academicYear: academicYear! });
      process.stdout.write(`classe créée : ${id}\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(`erreur : ${category(e)}\n`);
    return 1;
  } finally {
    await ctx.close();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), () => { process.stderr.write('erreur : UNEXPECTED\n'); process.exit(1); });
```

`apps/api/package.json` : `"cli": "tsx --conditions=source src/cli.ts"`.

- [ ] **Step 3 : Tests d'intégration (sous `cp_app`)**

Compléter `apps/api/test/support/app.ts` :

```ts
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Lance la CLI avec une configuration lue depuis des fichiers secrets temporaires (jamais en variables). */
export async function runCli(db: string, args: string[], stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  const cfg = testConfig(db);
  const dir = mkdtempSync(join(tmpdir(), 'cp-cli-'));
  const file = (name: string, value: string) => { const p = join(dir, name); writeFileSync(p, `${value}\n`); return p; };
  const auth = cfg.db.auth as { password: string };
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE,
    NODE_ENV: 'test', HTTP_PORT: '3000', READY_PORT: '3001', APP_ORIGIN: cfg.http.origin, LOG_LEVEL: 'silent',
    DB_HOST: cfg.db.host, DB_PORT: String(cfg.db.port), DB_NAME: cfg.db.database, DB_USER: 'cp_app', DB_AUTH_MODE: 'password',
    DB_PASSWORD_FILE: file('db', auth.password),
    RATE_LIMIT_HMAC_KEY_FILE: file('hmac', cfg.security.rateLimitHmacKey),
    TURNSTILE_SECRET_FILE: file('turnstile', cfg.turnstile.secret),
  };
  try {
    return await new Promise((done, fail) => {
      const p = spawn(process.execPath, ['--conditions=source', '--import', 'tsx', 'src/cli.ts', ...args], { cwd: resolve(import.meta.dirname, '../..'), env });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (d) => { stdout += String(d); });
      p.stderr.on('data', (d) => { stderr += String(d); });
      p.on('error', fail);
      p.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
      p.stdin.end(stdin);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

`apps/api/test/integration/cli.int.spec.ts` :

```ts
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { AuditRepository } from '../../src/modules/audit/audit.repository.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { AuthzService } from '../../src/modules/authz/authz.service.js';
import { CommonPasswords } from '../../src/modules/users/common-passwords.js';
import { PasswordHasher } from '../../src/modules/users/password-hasher.js';
import { UsersRepository } from '../../src/modules/users/users.repository.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { query, runCli } from '../support/app.js';
import { connectAs, createTestDatabase, dbConfigFor } from '../support/pg.js';

const ADMIN_PASSWORD = 'mot de passe administrateur solide';

describe('create-admin (§ 3.2)', () => {
  let db: string;
  beforeAll(async () => { db = await createTestDatabase(); });

  it('crée le premier administrateur ; le mot de passe n’apparaît nulle part', async () => {
    const r = await runCli(db, ['create-admin', '--email', ' Admin@Example.com ', '--first-name', 'Moussa', '--last-name', 'Faye'], `${ADMIN_PASSWORD}\n`);
    expect(r).toMatchObject({ code: 0, stdout: 'administrateur créé\n' });
    expect(r.stdout + r.stderr).not.toContain(ADMIN_PASSWORD);
    const u = await query(db, `select email::text, global_role, status from app.users where global_role = 'ADMIN'`);
    expect(u.rows).toEqual([{ email: 'admin@example.com', global_role: 'ADMIN', status: 'ACTIVE' }]);
    expect((await query(db, `select count(*)::int as n from app.audit_log where action = 'ADMIN_CREATED'`)).rows[0].n).toBe(1);
  });
  it('refusée s’il existe déjà un administrateur actif', async () => {
    const r = await runCli(db, ['create-admin', '--email', 'second@example.com', '--first-name', 'Awa', '--last-name', 'Sow'], `${ADMIN_PASSWORD}\n`);
    expect(r).toMatchObject({ code: 1, stderr: 'erreur : ADMIN_ALREADY_EXISTS\n' });
  });
  it('mot de passe administrateur de 15 caractères → PASSWORD_TOO_SHORT ; argument manquant → INVALID_ARGUMENTS ; commande inconnue → 2', async () => {
    const fresh = await createTestDatabase();
    expect((await runCli(fresh, ['create-admin', '--email', 'a@example.com', '--first-name', 'Awa', '--last-name', 'Sow'], `${'a'.repeat(15)}\n`)).stderr).toBe('erreur : PASSWORD_TOO_SHORT\n');
    expect((await runCli(fresh, ['create-admin', '--email', 'a@example.com'], `${ADMIN_PASSWORD}\n`)).stderr).toBe('erreur : INVALID_ARGUMENTS\n');
    expect((await runCli(fresh, ['drop-everything'])).code).toBe(2);
  });
});

describe('create-admin : concurrence sérialisée par role_guard (§ 5.4)', () => {
  let db: string;
  let prisma: PrismaService;
  let users: UsersService;
  beforeAll(async () => {
    db = await createTestDatabase();
    prisma = new PrismaService(dbConfigFor('cp_app', db));
    users = new UsersService(new UsersRepository(prisma), new AuthzService(), new AuditService(new AuditRepository()), new PasswordHasher(), new CommonPasswords([]), prisma);
  });
  afterAll(async () => { await prisma.onModuleDestroy(); });

  it('une attente de verrou est observée, puis un seul administrateur est créé', async () => {
    const holder = await connectAs('cp_app', db);
    await holder.query('begin');
    await holder.query('select id from app.role_guard where id = 1 for update');
    const cli = { kind: 'cli', command: 'create-admin' } as const;
    const a = users.createFirstAdmin(cli, { email: 'a@example.com', firstName: 'Awa', lastName: 'Sow', password: ADMIN_PASSWORD }).then(() => 'ok', (e) => e.code);
    const b = users.createFirstAdmin(cli, { email: 'b@example.com', firstName: 'Binta', lastName: 'Ba', password: ADMIN_PASSWORD }).then(() => 'ok', (e) => e.code);
    // Preuve de la concurrence : au moins une session cp_app attend le verrou de role_guard.
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i++) {
      const r = await holder.query(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`);
      waiting = r.rows[0].n;
      if (waiting === 0) await new Promise((res) => setTimeout(res, 50));
    }
    await holder.query('commit');
    await holder.end();
    expect(waiting).toBeGreaterThan(0);
    expect((await Promise.all([a, b])).sort()).toEqual(['ADMIN_ALREADY_EXISTS', 'ok']);
    expect((await query(db, `select count(*)::int as n from app.users where global_role = 'ADMIN'`)).rows[0].n).toBe(1);
  });
});

describe('create-class (R8)', () => {
  let db: string;
  beforeAll(async () => { db = await createTestDatabase(); });

  it('crée une classe active, journalisée ; doublon → CLASS_ALREADY_EXISTS ; année invalide → INVALID_ACADEMIC_YEAR', async () => {
    const ok = await runCli(db, ['create-class', '--name', 'L3 Informatique', '--level', 'L3', '--year', '2026-2027']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^classe créée : [0-9a-f-]{36}\n$/);
    expect((await query(db, `select status from app.classes where name = 'L3 Informatique'`)).rows).toEqual([{ status: 'ACTIVE' }]);
    expect((await query(db, `select count(*)::int as n from app.audit_log where action = 'CLASS_CREATED'`)).rows[0].n).toBe(1);
    expect((await runCli(db, ['create-class', '--name', 'L3 Informatique', '--level', 'L3', '--year', '2026-2027'])).stderr).toBe('erreur : CLASS_ALREADY_EXISTS\n');
    expect((await runCli(db, ['create-class', '--name', 'M1', '--level', 'M1', '--year', '2026-2028'])).stderr).toBe('erreur : INVALID_ACADEMIC_YEAR\n');
  });
});
```

Run : `pnpm vitest run --project unit apps/api/src/cli && pnpm vitest run --project integration apps/api/test/integration/cli.int.spec.ts`
Expected : PASS.

- [ ] **Step 4 : README (démarrage local)**

Dans `README.md`, section « Démarrer l'API », remplacer le bloc d'environnement par :

```bash
# Secrets de développement (fichiers, jamais en variables) :
[ -f .secrets/dev/rate_limit_hmac_key ] || openssl rand -hex 32 > .secrets/dev/rate_limit_hmac_key
# Clé de test Cloudflare « toujours accepté » (développement uniquement).
echo 1x0000000000000000000000000000000AA > .secrets/dev/turnstile_secret

export NODE_ENV=development HTTP_PORT=3000 READY_PORT=3001 APP_ORIGIN=http://localhost:5173 \
  DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=classepulse DB_AUTH_MODE=password \
  RATE_LIMIT_HMAC_KEY_FILE=../../.secrets/dev/rate_limit_hmac_key TURNSTILE_SECRET_FILE=../../.secrets/dev/turnstile_secret
DB_USER=cp_owner DB_PASSWORD_FILE=../../.secrets/dev/cp_owner pnpm exec prisma migrate deploy
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm cli create-class --name "L3 Informatique" --level L3 --year 2026-2027
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm exec tsx --conditions=source src/main.ts
```

et ajouter la vérification :

```bash
curl -s http://127.0.0.1:3000/api/classes/active
curl -s -i -X POST http://127.0.0.1:3000/api/auth/login -H 'Origin: http://localhost:5173' -H 'Content-Type: application/json' \
  -d '{"email":"inconnu@example.com","password":"x"}'   # → 401 INVALID_CREDENTIALS
```

- [ ] **Step 5 : Commit**

```bash
git add apps/api/src/cli.ts apps/api/src/cli apps/api/package.json apps/api/test README.md
git commit -m "feat(cli): create-admin (mot de passe sur l'entrée standard, sérialisé) et create-class"
```

---

### Task 13 : Suite de sécurité « authentification » et méta-test des routes

**Files :**
- Modify : `apps/api/test/support/app.ts` (option `logStream`)
- Test : `apps/api/test/integration/security-auth.int.spec.ts`, `apps/api/test/integration/routes-meta.int.spec.ts`

**Interfaces :**
- Consumes : toutes les routes du lot 1a ; `buildTestApp`.
- Produces : la table `EXPECTED_ROUTES` (référence pour les lots suivants : chaque nouvelle route doit y être ajoutée, sinon le méta-test échoue).

- [ ] **Step 1 : Méta-test des routes (R11)**

Dans `buildTestApp`, accepter `logStream?: NodeJS.WritableStream` et le transmettre à `buildApiApp`.

`apps/api/test/integration/routes-meta.int.spec.ts` :

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, ORIGIN, send, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

/** Toute route de l'API doit figurer ici (R11). `public` : accessible sans session. */
const EXPECTED_ROUTES: Record<string, { public: boolean }> = {
  'GET /api/health': { public: true },
  'GET /api/classes/active': { public: true },
  'POST /api/auth/register': { public: true },
  'POST /api/auth/login': { public: true },
  'POST /api/auth/logout': { public: false },
  'GET /api/me': { public: false },
  'PATCH /api/me/profile': { public: false },
  'PATCH /api/me/email-preferences': { public: false },
  'POST /api/me/password': { public: false },
  'GET /api/me/sessions': { public: false },
  'POST /api/me/sessions/revoke-others': { public: false },
};

let t: TestApp;
beforeAll(async () => { t = await buildTestApp(await createTestDatabase()); });
afterAll(async () => { await t.close(); });

const entries = () => Object.entries(EXPECTED_ROUTES).map(([k, v]) => {
  const [method, url] = k.split(' ') as ['GET' | 'POST' | 'PATCH', string];
  return { key: k, method, url, ...v };
});

describe('méta-test des routes (§ 5.4, R11)', () => {
  it('la liste des routes déclarées est exactement la table attendue', () => {
    expect(t.routes.map((r) => `${r.method} ${r.url}`).sort()).toEqual(Object.keys(EXPECTED_ROUTES).sort());
  });
  it.each(entries().filter((r) => !r.public))('$key : 401 sans session', async ({ method, url }) => {
    const res = await send(t.app, method, url, {});
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });
  it.each(entries().filter((r) => r.method !== 'GET'))('$key : 403 CSRF avec une origine étrangère', async ({ method, url }) => {
    const res = await send(t.app, method, url, {}, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CSRF_REJECTED');
  });
  it.each(entries().filter((r) => r.method !== 'GET'))('$key : 415 si le corps n’est pas du JSON', async ({ method, url }) => {
    const res = await t.app.inject({ method, url, payload: 'a=b', headers: { origin: ORIGIN, 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(415);
  });
});
```

- [ ] **Step 2 : Suite de sécurité « authentification »**

`apps/api/test/integration/security-auth.int.spec.ts` :

```ts
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, cookieHeader, insertClass, PASSWORD, query, registerStudent, send, type TestApp } from '../support/app.js';
import { createTestDatabase } from '../support/pg.js';

const CLEAR = '__Host-cp_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
let db: string;
let t: TestApp;
let classId: string;
const logs: string[] = [];
beforeAll(async () => {
  db = await createTestDatabase();
  classId = await insertClass(db, 'L3 Informatique');
  const logStream = new Writable({ write(c, _e, cb) { logs.push(String(c)); cb(); } });
  t = await buildTestApp(db, { config: { http: { origin: 'https://app.test', trustProxy: 0, logLevel: 'info' } }, logStream });
});
afterAll(async () => { await t.close(); });

describe('sécurité — sessions (§ 3.4)', () => {
  it.each([
    ['révoquée', (id: string) => query(db, `update app.sessions set revoked_at = clock_timestamp(), revoke_reason = 'ADMIN_REVOKED' where user_id = $1`, [id])],
    ['inactivité dépassée', (id: string) => query(db, `update app.sessions set idle_expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [id], 'cp_owner')],
    ['échéance absolue dépassée', (id: string) => query(db, `update app.sessions set idle_expires_at = clock_timestamp() - interval '2 seconds', absolute_expires_at = clock_timestamp() - interval '1 second' where user_id = $1`, [id], 'cp_owner')],
    ['compte suspendu', (id: string) => query(db, `update app.users set status = 'SUSPENDED' where id = $1`, [id], 'cp_owner')],
  ])('session %s → 401 et effacement du cookie, en GET comme en POST', async (_name, spoil) => {
    const s = await registerStudent(t.app, classId);
    await spoil(s.userId);
    for (const res of [
      await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token)),
      await send(t.app, 'POST', '/api/me/sessions/revoke-others', {}, cookieHeader(s.token)),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBe(CLEAR);
    }
  });
  it.each(['', 'not-a-token', 'a'.repeat(43), '<script>'])('cookie mal formé %j → 401', async (value) => {
    const res = await send(t.app, 'GET', '/api/me', undefined, { cookie: `__Host-cp_session=${value}` });
    expect(res.statusCode).toBe(401);
  });
  it('un jeton n’est jamais stocké en clair', async () => {
    const s = await registerStudent(t.app, classId);
    const r = await query(db, `select count(*)::int as n from app.sessions where token_hash = convert_to($1, 'UTF8') or encode(token_hash, 'base64') like '%' || $1 || '%'`, [s.token]);
    expect(r.rows[0].n).toBe(0);
  });
});

describe('sécurité — entrées et réponses', () => {
  it('aucun mot de passe, jeton ni cookie dans les journaux', async () => {
    const s = await registerStudent(t.app, classId);
    await send(t.app, 'POST', '/api/auth/login', { email: s.email, password: PASSWORD });
    await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token));
    const all = logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(s.token);
  });
  it('les DTO ne renvoient jamais le hachage, le statut interne ni l’IP', async () => {
    const s = await registerStudent(t.app, classId);
    const me = await send(t.app, 'GET', '/api/me', undefined, cookieHeader(s.token));
    const sessions = await send(t.app, 'GET', '/api/me/sessions', undefined, cookieHeader(s.token));
    expect(me.body).not.toMatch(/argon2|passwordHash|"status":"ACTIVE"/);
    expect(sessions.body).not.toMatch(/\bip\b|198\.18\./);
  });
  it.each(['/api/docs', '/api/openapi.json', '/api-json', '/docs'])('OpenAPI absente : %s → 404 (arbitrage P)', async (url) => {
    expect((await send(t.app, 'GET', url)).statusCode).toBe(404);
  });
  it('les erreurs portent un requestId égal à x-request-id et aucune trace', async () => {
    const res = await send(t.app, 'POST', '/api/auth/login', { email: 'x@example.com', password: 'y' });
    expect(res.json().requestId).toBe(res.headers['x-request-id']);
    expect(res.body).not.toMatch(/at \w+ \(|\.ts:\d+/);
  });
});

describe('sécurité — limitation générale avant toute lecture en base', () => {
  it('un flot de cookies invalides depuis une IP finit en 429, pas en 401 indéfiniment', async () => {
    const local = await buildTestApp(db, { config: { limits: { loginPerIp: 100, throttlePerIp: 5, throttlePerSession: 10_000 } } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await send(local.app, 'GET', '/api/me', undefined, { cookie: `__Host-cp_session=${'b'.repeat(43)}` }, '203.0.113.99')).statusCode);
      expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(codes.at(-1)).toBe(429);
    } finally {
      await local.close();
    }
  });
});
```

Run : `pnpm vitest run --project integration apps/api/test/integration/routes-meta.int.spec.ts apps/api/test/integration/security-auth.int.spec.ts`
Expected : PASS.

- [ ] **Step 3 : Vérification complète du lot 1a**

```bash
pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:cov && pnpm depcruise && pnpm audit --audit-level high
pnpm test:int   # projet d'intégration complet
pnpm test:int   # deux fois de suite : un test intermittent est un défaut (§ 5.4)
```

Expected : tout vert, deux passes d'intégration consécutives sans échec.

Démarrage local (README, section « Démarrer l'API ») : créer une classe, démarrer l'API, puis vérifier à la main qu'une inscription via `curl` (avec `turnstileToken` quelconque et la clé de test Cloudflare) renvoie `201` et un cookie `__Host-cp_session`, que `GET /api/me` avec ce cookie renvoie la demande en attente, et que `POST /api/auth/logout` renvoie `204`.

- [ ] **Step 4 : Commit**

```bash
git add apps/api/test
git commit -m "test(sécurité): suite « authentification » et méta-test des routes"
```

---

## Critères de sortie du lot 1a

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:cov` (≥ 90 % sur `packages/shared` et `authz`), `pnpm depcruise`, `pnpm audit --audit-level high` verts.
- [ ] Projet d'intégration complet vert **deux fois de suite**.
- [ ] Inscription, connexion, `GET /api/me`, profil, préférences, mot de passe, sessions et déconnexion vérifiés à la main sur l'API démarrée en local.
- [ ] `create-class` et `create-admin` fonctionnent en local ; un second `create-admin` est refusé.
- [ ] Pull request ouverte, CI rapide et intégration vertes.
- [ ] Rulings R1 à R15 relus par le responsable (ou acceptés tels quels).
