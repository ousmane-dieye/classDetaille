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
- Toute commande Prisma (y compris `--version` et `generate`) charge `prisma.config.ts`, donc exige les variables DB_* valides (et un fichier DB_PASSWORD_FILE existant) ; sans elles : `invalid configuration: NODE_ENV, HTTP_PORT, ...`. `pnpm prisma:generate` doit donc être lancé avec cet environnement.
- pnpm 12 : build scripts approuvés dans `allowBuilds` : `prisma` et `@prisma/engines` (téléchargement/installation des moteurs). Rien d'autre.
- `migrate deploy` avec `BEGIN;` / `COMMIT;` explicites dans la migration : aucune erreur ni échec ; la ligne est enregistrée dans `app._prisma_migrations` (`finished_at` renseigné).
- Windows : Node 24 ne peut pas lancer `pnpm.cmd` via `execFile` (ENOENT) ; `runPrisma` passe par `cmd.exe /d /c pnpm exec prisma ...` sous win32 et transmet SystemRoot, ComSpec, etc.
