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

Puis, depuis `apps/api` (adapter `DB_PORT` si PostgreSQL est publié sur un autre port) :

```bash
export NODE_ENV=development HTTP_PORT=3000 READY_PORT=3001 DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=classepulse DB_AUTH_MODE=password
DB_USER=cp_owner DB_PASSWORD_FILE=../../.secrets/dev/cp_owner pnpm exec prisma migrate deploy
DB_USER=cp_app DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm exec tsx src/main.ts
```

Vérification : `curl http://127.0.0.1:3000/api/health` → `{"status":"ok"}` ; `curl http://127.0.0.1:3001/api/health/ready` → `{"ready":true}` (serveur interne, `404` sur le port 3000).
