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

```bash
pnpm install
pnpm test:unit
```
