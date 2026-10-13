# T-01 : Prisma

## Configuration Prisma 7.10.0

`pnpm exec prisma --version` (avec les variables DB_* et un DB_PASSWORD_FILE factices) :

```
Loaded Prisma config from prisma.config.ts.

Prisma schema loaded from prisma\schema.prisma.
prisma               : 7.10.0
@prisma/client       : 7.10.0
Operating System     : win32
Architecture         : x64
Node.js              : v24.15.0
TypeScript           : 6.0.3
Query Compiler       : enabled
PSL                  : @prisma/prisma-schema-wasm 7.10.0-4.0edf323efd1d98336f3f0a68684b56f689b900d3
Schema Engine        : schema-engine-cli 0edf323efd1d98336f3f0a68684b56f689b900d3
Default Engines Hash : 0edf323efd1d98336f3f0a68684b56f689b900d3
Studio               : 0.33.0
```

Noms d'option : aucun nom du brief n'a dû être changé (`prisma/config` `defineConfig`, `datasource.url`, générateur `prisma-client` avec `moduleFormat = "esm"`, `datasource.schemas` sans url). L'import `./src/config/*.js` depuis `prisma.config.ts` est résolu vers le `.ts` par le chargeur de configuration Prisma sans adaptation.

Constats :
- `prisma.config.ts` est paresseux : `datasource` n'est défini que si `DB_HOST` est présent. Prisma 7.10.0 accepte une configuration sans `datasource` ; `prisma generate` fonctionne sans aucune variable DB_* (CI). `migrate deploy` reçoit l'URL construite comme avant.
- pnpm 12 : build scripts approuvés dans `allowBuilds` : `prisma` et `@prisma/engines` (téléchargement/installation des moteurs). Rien d'autre.
- `migrate deploy` avec `BEGIN;` / `COMMIT;` explicites dans la migration : aucune erreur ni échec ; la ligne est enregistrée dans `app._prisma_migrations` (`finished_at` renseigné).
- `runPrisma` lance la CLI via `execFile(process.execPath, [prisma/build/index.js, ...])`, sans shell, identique sous Windows et Linux ; le répertoire temporaire des secrets est supprimé après chaque exécution.
- Les paquets @visx/*, @radix-ui/*, d3 du lockfile sont des dépendances transitives de `@prisma/studio-core@0.33.0` (via `prisma@7.10.0`).
