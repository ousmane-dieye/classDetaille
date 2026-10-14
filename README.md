# ClassePulse V2

Ce dépôt contient ClassePulse V2. Voir les deux spécifications (fonctionnelle et technique) et la feuille de route dans `docs/`.

## Démarrer en local

```bash
mkdir -p .secrets/dev && openssl rand -hex 24 > .secrets/dev/pg_superuser_password
docker compose -f docker-compose.dev.yml up -d postgres
docker compose -f docker-compose.dev.yml exec -T -u postgres postgres psql -v ON_ERROR_STOP=1 -f /bootstrap/db-bootstrap-cluster.sql
docker compose -f docker-compose.dev.yml exec -T -u postgres postgres psql -v ON_ERROR_STOP=1 -v dbname=classepulse -f /bootstrap/db-bootstrap-database.sql
# Rejouer les deux commandes : aucune erreur attendue (scripts rejouables).
docker compose -f docker-compose.dev.yml exec -T -u postgres postgres psql -d classepulse -c "select rolname, rolcanlogin from pg_roles where rolname like 'cp\_%' order by 1"
```

Sous Git Bash (Windows), préfixer les commandes `exec` par `MSYS_NO_PATHCONV=1`.

Si le port 5432 est occupé, publier PostgreSQL sur un autre port hôte : `PG_PORT=15432 docker compose -f docker-compose.dev.yml up -d postgres`.

```bash
pnpm install
pnpm test:unit
```

### Démarrer l'API

Mots de passe de développement de `cp_owner` (migrations) et `cp_app` (API), lus depuis des fichiers et passés à `psql` par l'entrée standard (jamais en argument) :

```bash
for r in cp_owner cp_app; do
  [ -f .secrets/dev/$r ] || openssl rand -hex 24 > .secrets/dev/$r
  printf "ALTER ROLE %s PASSWORD '%s';\n" "$r" "$(cat .secrets/dev/$r)" \
    | docker compose -f docker-compose.dev.yml exec -T -u postgres postgres psql -q -v ON_ERROR_STOP=1 -d classepulse
done
```

Secrets de sécurité de développement : clé HMAC des seaux de limitation (32 caractères au moins) et secret Turnstile (ici la clé de test publique de Cloudflare, qui accepte toujours ; jamais en production) :

```bash
[ -f .secrets/dev/rate_limit_hmac_key ] || openssl rand -hex 32 > .secrets/dev/rate_limit_hmac_key
[ -f .secrets/dev/turnstile_secret ] || echo 1x0000000000000000000000000000000AA > .secrets/dev/turnstile_secret
```

Secrets du lot 1b : poivre des codes administrateur (32 caractères au moins, lu par l'API et par `ops`) et clé de chiffrement de la file d'emails (64 caractères hexadécimaux, lue par l'API et par le worker) :

```bash
[ -f .secrets/dev/otp_pepper ] || openssl rand -base64 48 > .secrets/dev/otp_pepper
[ -f .secrets/dev/outbox_payload_key ] || openssl rand -hex 32 > .secrets/dev/outbox_payload_key
```

Puis, depuis `apps/api` (adapter `DB_PORT` si PostgreSQL est publié sur un autre port) :

```bash
export NODE_ENV=development HTTP_PORT=3000 READY_PORT=3001 DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=classepulse DB_AUTH_MODE=password
export APP_ORIGIN=http://localhost:5173 RATE_LIMIT_HMAC_KEY_FILE=../../.secrets/dev/rate_limit_hmac_key TURNSTILE_SECRET_FILE=../../.secrets/dev/turnstile_secret OTP_PEPPER_FILE=../../.secrets/dev/otp_pepper OUTBOX_PAYLOAD_KEY_FILE=../../.secrets/dev/outbox_payload_key
DB_USER=cp_owner DB_PASSWORD_FILE=../../.secrets/dev/cp_owner pnpm exec prisma migrate deploy
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm cli create-class --name "L3 Informatique" --level L3 --year 2026-2027
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm exec tsx --conditions=source src/main.ts
```

### Commandes d'administration (`create-admin`, `create-class`)

Elles s'exécutent sous le rôle `cp_app` (jamais `cp_owner` ni `postgres`), avec les mêmes variables d'environnement que l'API. En lot 1a, on les lance par `pnpm --filter @classepulse/api cli …` (ou `pnpm cli …` depuis `apps/api`), c'est-à-dire `tsx --conditions=source src/cli.ts`. `node dist/src/cli.js` ne fonctionnera qu'une fois le paquet partagé construit (lot 7).

```bash
# Premier administrateur : le mot de passe (16 caractères au moins) est lu sur l'entrée standard, jamais en argument.
# Sur un terminal, la saisie est masquée et confirmée ; sinon, la première ligne de l'entrée standard est utilisée.
[ -f ../../.secrets/dev/admin_password ] || openssl rand -base64 24 > ../../.secrets/dev/admin_password
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm --filter @classepulse/api cli create-admin --email admin@example.com --first-name Moussa --last-name Faye < ../../.secrets/dev/admin_password
# Une autre classe active (la première, « L3 Informatique », est créée dans le bloc de démarrage ci-dessus)
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm --filter @classepulse/api cli create-class --name "M1 Génie logiciel" --level M1 --year 2026-2027
```

Codes de sortie : `0` succès ; `1` erreur (une ligne `erreur : <CODE>` sur la sortie d'erreur, par exemple `ADMIN_ALREADY_EXISTS`, `EMAIL_TAKEN`, `PASSWORD_TOO_SHORT`, `CLASS_ALREADY_EXISTS`, `INVALID_ACADEMIC_YEAR`, `INVALID_ARGUMENTS`) ; `2` usage. Aucun mot de passe n'est affiché.

### Vérification manuelle (inscription, profil, déconnexion)

Avec l'API démarrée et une classe créée (`CLASS_ID` : identifiant renvoyé par `GET /api/classes/active`). Chaque requête qui modifie porte l'en-tête `Origin` égal à `APP_ORIGIN` (protection CSRF) ; la déconnexion exige un corps JSON `{}`.

```bash
O='Origin: http://localhost:5173'; J='Content-Type: application/json'
curl -s -i -c cookies.txt -X POST http://127.0.0.1:3000/api/auth/register -H "$O" -H "$J" -d '{"firstName":"Awa","lastName":"Diop","email":"awa@example.com","password":"une phrase de passe assez longue","classId":"<CLASS_ID>","turnstileToken":"x"}'   # → 201, cookie de session
curl -s -b cookies.txt http://127.0.0.1:3000/api/me                                   # → profil de l'étudiante
curl -s -i -b cookies.txt -X POST http://127.0.0.1:3000/api/auth/logout -H "$O" -H "$J" -d '{}'   # → 204, cookie effacé
curl -s -i -b cookies.txt http://127.0.0.1:3000/api/me                                # → 401 UNAUTHENTICATED
curl -s http://127.0.0.1:3000/api/classes/active                                      # → 200, liste des classes actives (public)
curl -s -i -X POST http://127.0.0.1:3000/api/auth/login -H "$O" -H "$J" -d '{"email":"awa@example.com","password":"mauvais mot de passe long"}'   # → 401 INVALID_CREDENTIALS
```

Variables de l'API :

| Variable | Obligatoire | Rôle (valeur par défaut) |
| --- | --- | --- |
| `APP_ORIGIN` | oui | Origine exacte de l'application web (schéma, hôte, port ; sans chemin), comparée à `Origin` pour le CSRF |
| `RATE_LIMIT_HMAC_KEY_FILE` | oui | Fichier de la clé HMAC des seaux de limitation (32 caractères au moins) |
| `TURNSTILE_SECRET_FILE` | oui | Fichier du secret Turnstile |
| `OTP_PEPPER_FILE` | oui | Fichier du poivre des codes administrateur (32 caractères au moins) |
| `OUTBOX_PAYLOAD_KEY_FILE` | oui | Fichier de la clé de chiffrement de la file d'emails (64 caractères hexadécimaux) |
| `TURNSTILE_VERIFY_URL` | non | Point de vérification Turnstile (`https://challenges.cloudflare.com/turnstile/v0/siteverify`) |
| `TRUST_PROXY` | non | Nombre de mandataires inverses de confiance pour l'IP du client, de 0 à 3 (`0`). N'utiliser une valeur > 0 que si l'API n'est joignable qu'à travers ces proxys : sinon un client choisit lui-même sa clé de limitation |
| `LOG_LEVEL` | non | `fatal`, `error`, `warn`, `info`, `debug` ou `silent` (`info`) |
| `LOGIN_LIMIT_PER_IP` | non | Tentatives de connexion par IP sur 15 min (`100`) |
| `THROTTLE_PER_IP` / `THROTTLE_PER_SESSION` | non | Limitation générale par minute (`600` / `300`) |

### Parcours administrateur en développement

Prérequis : Mailpit, l'API et le worker démarrés (sections ci-dessus), un administrateur créé (`pnpm cli create-admin`, voir plus haut).

```bash
O='Origin: http://localhost:5173'; J='Content-Type: application/json'
# 1. Connexion : 202 ADMIN_CODE_REQUIRED + cookie __Host-cp_challenge (aucune session à ce stade)
curl -s -i -c admin.txt -X POST http://127.0.0.1:3000/api/auth/login -H "$O" -H "$J" -d '{"email":"admin@example.com","password":"<mot de passe>"}'
# 2. Le code à 6 chiffres arrive dans Mailpit (http://127.0.0.1:8025) une fois le worker passé
# 3. Vérification : 200 profil + cookie __Host-cp_session
curl -s -i -b admin.txt -c admin.txt -X POST http://127.0.0.1:3000/api/auth/verify-code -H "$O" -H "$J" -d '{"code":"123456"}'
```

Les cookies `__Host-` portent l'attribut `Secure` : en HTTP local, `curl` ne les renvoie pas toujours (selon sa version) et un navigateur les refuse. Variantes qui fonctionnent : un proxy TLS local avec `curl --insecure`, passer le cookie à la main (`-H 'Cookie: __Host-cp_challenge=<valeur>'`), ou les tests d'intégration, qui rejouent ce parcours avec `inject()` (`apps/api/test/integration/auth-admin-login.int.spec.ts`, `security-admin.int.spec.ts`).

Variables d'environnement par service :

| Service | Variables du lot 1b |
| --- | --- |
| API | `OTP_PEPPER_FILE`, `OUTBOX_PAYLOAD_KEY_FILE` |
| Worker | `OUTBOX_PAYLOAD_KEY_FILE`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER` et `SMTP_PASSWORD_FILE` (facultatives), `MAIL_FROM`, `APP_ORIGIN` |
| `ops` | `OTP_PEPPER_FILE`, `DB_USER=cp_ops` |

Limite documentée (§ 3.3) : le second facteur des administrateurs repose sur la sécurité de leur boîte email. Utilise une adresse dédiée, protégée par une double authentification.

Codes d'erreur du lot 1b (stables, traduits par le web au lot 1c) : `CHALLENGE_EXPIRED`, `CODE_INVALID` (`attemptsLeft`), `CODE_LOCKED`, `SECOND_FACTOR_BLOCKED`, `TOO_MANY_CODE_REQUESTS` et `TOO_MANY_ATTEMPTS` (429, `Retry-After`), `TURNSTILE_REQUIRED`, `TURNSTILE_FAILED`, `SIGNUP_UNAVAILABLE` et `RESET_UNAVAILABLE` (503, `Retry-After`), `RESET_TOKEN_INVALID`, `CURRENT_PASSWORD_INVALID`, `REAUTH_REQUIRED`, `STEP_UP_REQUIRED` (`missing`: `PASSWORD` ou `CODE`), `EMAIL_UNCHANGED`, `EMAIL_TAKEN`, ainsi que `INVALID_CREDENTIALS`, `ACCOUNT_SUSPENDED` et `UNAUTHENTICATED` déjà présents au lot 1a. Une requête dont le corps JSON est vide s'envoie avec `{}` (jamais sans corps).

Contrat pour le lot 1c (routes du lot 1b ; un corps vide s'envoie `{}`) :

| Route | Corps | Succès | Erreurs notables |
| --- | --- | --- | --- |
| `POST /api/auth/register` | inscription, `turnstileToken` | `201` profil + session | `400 TURNSTILE_FAILED`, `503 SIGNUP_UNAVAILABLE` (`Retry-After`), `429` |
| `POST /api/auth/login` (administrateur) | `{ email, password, turnstileToken? }` | `202` `{ status: 'ADMIN_CODE_REQUIRED', expiresInSeconds, resendAfterSeconds }` + cookie `__Host-cp_challenge` | `401 INVALID_CREDENTIALS` (`turnstileRequired`), `401 TURNSTILE_REQUIRED`, `403 ACCOUNT_SUSPENDED`, `403 SECOND_FACTOR_BLOCKED`, `429 TOO_MANY_ATTEMPTS`, `429 TOO_MANY_CODE_REQUESTS` |
| `POST /api/auth/verify-code` | `{ code }` | `200` profil + session | `400 CODE_INVALID` (`attemptsLeft`), `400 CODE_LOCKED`, `400 CHALLENGE_EXPIRED`, `403 SECOND_FACTOR_BLOCKED`, `429` |
| `POST /api/auth/resend-code` | `{}` | `202` | `400 CHALLENGE_EXPIRED`, `429 TOO_MANY_CODE_REQUESTS` (`Retry-After`) |
| `POST /api/auth/verify-recovery` | `{ recoveryCode }` | `200` profil + session | comme `verify-code` |
| `POST /api/auth/forgot-password` | `{ email, turnstileToken }` | `202` `{ status: 'RESET_REQUESTED' }` (toujours) | `400 TURNSTILE_FAILED`, `503 RESET_UNAVAILABLE` (`Retry-After`), `429` |
| `POST /api/auth/reset-password` | `{ token, newPassword }` | `204` | `400 RESET_TOKEN_INVALID`, codes de politique de mot de passe |
| `POST /api/me/reauth` | `{ password }` | `204` | `400 CURRENT_PASSWORD_INVALID`, `429` |
| `POST /api/me/step-up` ; `/api/me/step-up/verify` | `{ password }` ; `{ code }` | `202` `{ expiresInSeconds }` ; `204` | `403 FORBIDDEN` (étudiant), `400 CODE_INVALID`, `400 CHALLENGE_EXPIRED` |
| `POST /api/me/email-change` ; `/verify-old` ; `/verify-new` | `{ password, newEmail }` ; `{ code }` ; `{ code }` | `202` ; `202` ; `200` profil | `400 EMAIL_UNCHANGED`, `409 EMAIL_TAKEN`, `400 CHALLENGE_EXPIRED` |

Gardes que le lot 2 appelle dans la transaction de l'action sensible : `StepUpService.assertStepUpFreshInTx` (`403 STEP_UP_REQUIRED`, `missing: 'PASSWORD' | 'CODE'`) et `assertRecentPasswordInTx` (`403 REAUTH_REQUIRED`).

### Récupération d'un administrateur

Un administrateur qui n'a plus accès à sa boîte email obtient un code de récupération (12 caractères, valable 15 minutes). Depuis un terminal, sous `DB_USER=cp_ops` :

```
pnpm --filter @classepulse/api ops admin-recovery-code --email <email> [--clear-block]
```

Le code s'affiche une seule fois, après validation en base ; appuie sur Entrée pour effacer l'écran. Transmets-le par un canal sûr : il ne sert qu'après le mot de passe (`POST /api/auth/verify-recovery`, avec le cookie de vérification). Seul son HMAC est stocké.

Limites (§ 3.3) : la commande refuse de s'exécuter sans terminal, mais c'est un garde-fou, pas une garantie (historique du shell, enregistrement de session, `ulimit -c 0` et journaux Docker : lot 7). Un compte bloqué (10 échecs) n'obtient aucun code, sauf avec `--clear-block`, qui lève le blocage et est audité. Tous les administrateurs actifs reçoivent une alerte.

### Emails en développement

Les emails partent par SMTP. En développement, Mailpit les reçoit sans les expédier (interface sur http://127.0.0.1:8025) :

```bash
docker compose -f docker-compose.dev.yml up -d mailpit
```

Le worker envoie la file d'emails ; il lit la base, `OUTBOX_PAYLOAD_KEY_FILE` et les identifiants SMTP, rien d'autre. Depuis `apps/api` (variables de base `NODE_ENV`, `DB_*`, `APP_ORIGIN` comme ci-dessus) :

```bash
SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_SECURITY=none MAIL_FROM=no-reply@classepulse.test OUTBOX_PAYLOAD_KEY_FILE=../../.secrets/dev/outbox_payload_key DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm --filter @classepulse/api worker
```

Variables du worker : `APP_ORIGIN`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY` (`none`, `starttls` ou `tls` ; `none` est refusé en production), `OUTBOX_PAYLOAD_KEY_FILE` (obligatoires) ; `SMTP_USER` et `SMTP_PASSWORD_FILE` (ensemble ou aucun), `SMTP_TIMEOUT_MS` (`30000`), `LOG_LEVEL` (`info`) facultatives. La commande `ops` ne lit que la base et `OTP_PEPPER_FILE`.

Arrêt : `SIGTERM` ou `Ctrl+C` cesse de réserver, laisse l'envoi en cours se terminer (30 s au plus), puis ferme la connexion `LISTEN` et les connexions à la base. Le worker se réveille sur `NOTIFY` (sondage de secours toutes les 15 s) et purge chaque heure les seaux de limitation de plus de 2 h. Mailpit : http://127.0.0.1:8025.

Les secrets ne passent jamais par une variable directe : `DB_PASSWORD`, `DATABASE_URL`, `PGPASSWORD` et `PGPASSFILE` sont refusés au démarrage. `prisma migrate deploy` ne lit que les variables `DB_*`.

Une requête qui modifie (`POST`, `PUT`, `PATCH`, `DELETE`) doit porter `Content-Type: application/json` et un en-tête `Origin` égal à `APP_ORIGIN` (ou, sans `Origin`, `Sec-Fetch-Site: same-origin`) ; sinon `403 CSRF_REJECTED` ou `415`.

Vérification : `curl http://127.0.0.1:3000/api/health` → `{"status":"ok"}` ; `curl http://127.0.0.1:3001/api/health/ready` → `{"ready":true}` (serveur interne, `404` sur le port 3000).
