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

Puis, depuis `apps/api` (adapter `DB_PORT` si PostgreSQL est publié sur un autre port) :

```bash
export NODE_ENV=development HTTP_PORT=3000 READY_PORT=3001 DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=classepulse DB_AUTH_MODE=password
export APP_ORIGIN=http://localhost:5173 RATE_LIMIT_HMAC_KEY_FILE=../../.secrets/dev/rate_limit_hmac_key TURNSTILE_SECRET_FILE=../../.secrets/dev/turnstile_secret
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
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm --filter @classepulse/api cli create-admin   --email admin@example.com --first-name Moussa --last-name Faye < ../../.secrets/dev/admin_password
# Classe active
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm --filter @classepulse/api cli create-class   --name "L3 Informatique" --level L3 --year 2026-2027
```

Codes de sortie : `0` succès ; `1` erreur (une ligne `erreur : <CODE>` sur la sortie d'erreur, par exemple `ADMIN_ALREADY_EXISTS`, `EMAIL_TAKEN`, `PASSWORD_TOO_SHORT`, `CLASS_ALREADY_EXISTS`, `INVALID_ACADEMIC_YEAR`, `INVALID_ARGUMENTS`) ; `2` usage. Aucun mot de passe n'est affiché.

### Vérification manuelle (inscription, profil, déconnexion)

Avec l'API démarrée et une classe créée (`CLASS_ID` : identifiant renvoyé par `GET /api/classes/active`). Chaque requête qui modifie porte l'en-tête `Origin` égal à `APP_ORIGIN` (protection CSRF) ; la déconnexion exige un corps JSON `{}`.

```bash
O='Origin: http://localhost:5173'; J='Content-Type: application/json'
curl -s -i -c cookies.txt -X POST http://127.0.0.1:3000/api/auth/register -H "$O" -H "$J"   -d '{"firstName":"Awa","lastName":"Diop","email":"awa@example.com","password":"une phrase de passe assez longue","classId":"<CLASS_ID>","turnstileToken":"x"}'   # → 201, cookie de session
curl -s -b cookies.txt http://127.0.0.1:3000/api/me                                   # → profil de l'étudiante
curl -s -i -b cookies.txt -X POST http://127.0.0.1:3000/api/auth/logout -H "$O" -H "$J" -d '{}'   # → 204, cookie effacé
curl -s -i -b cookies.txt http://127.0.0.1:3000/api/me                                # → 401 UNAUTHENTICATED
```

Variables de l'API :

| Variable | Obligatoire | Rôle (valeur par défaut) |
| --- | --- | --- |
| `APP_ORIGIN` | oui | Origine exacte de l'application web (schéma, hôte, port ; sans chemin), comparée à `Origin` pour le CSRF |
| `RATE_LIMIT_HMAC_KEY_FILE` | oui | Fichier de la clé HMAC des seaux de limitation (32 caractères au moins) |
| `TURNSTILE_SECRET_FILE` | oui | Fichier du secret Turnstile |
| `TURNSTILE_VERIFY_URL` | non | Point de vérification Turnstile (`https://challenges.cloudflare.com/turnstile/v0/siteverify`) |
| `TRUST_PROXY` | non | Nombre de mandataires inverses de confiance pour l'IP du client, de 0 à 3 (`0`) |
| `LOG_LEVEL` | non | `fatal`, `error`, `warn`, `info`, `debug` ou `silent` (`info`) |
| `LOGIN_LIMIT_PER_IP` | non | Tentatives de connexion par IP sur 15 min (`100`) |
| `THROTTLE_PER_IP` / `THROTTLE_PER_SESSION` | non | Limitation générale par minute (`600` / `300`) |

Les secrets ne passent jamais par une variable directe : `DB_PASSWORD`, `DATABASE_URL`, `PGPASSWORD` et `PGPASSFILE` sont refusés au démarrage. `prisma migrate deploy` ne lit que les variables `DB_*`.

Une requête qui modifie (`POST`, `PUT`, `PATCH`, `DELETE`) doit porter `Content-Type: application/json` et un en-tête `Origin` égal à `APP_ORIGIN` (ou, sans `Origin`, `Sec-Fetch-Site: same-origin`) ; sinon `403 CSRF_REJECTED` ou `415`.

Vérification : `curl http://127.0.0.1:3000/api/health` → `{"status":"ok"}` ; `curl http://127.0.0.1:3001/api/health/ready` → `{"ready":true}` (serveur interne, `404` sur le port 3000).
