# ClassePulse V2 — Lot 0 : Fondations — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** poser un monorepo qui démarre (API NestJS + Fastify, web React), une base PostgreSQL 18 avec ses rôles, schémas et droits, Prisma 7.10.0, un harnais de tests sur rôles réels, et démontrer T-01 et T-05.

**Architecture :** monorepo pnpm (`apps/api`, `apps/web`, `packages/shared`). La base est initialisée par deux scripts SQL exécutés par `postgres`, puis par des migrations Prisma explicitement transactionnelles. Les tests d'intégration démarrent un PostgreSQL 18 via Testcontainers et se connectent avec les **vrais rôles** (`cp_app`, `cp_owner`…), jamais en superutilisateur pour le code applicatif.

**Tech Stack :** Node.js LTS, pnpm, TypeScript strict, NestJS + Fastify, Prisma `7.10.0` + `@prisma/adapter-pg`, PostgreSQL 18, Zod, Vitest + `unplugin-swc`, Testcontainers, dependency-cruiser, React + Vite, React Testing Library, GitHub Actions.

**Spec :** `docs/superpowers/specs/2026-10-13-classepulse-v2-design.md` (§ 1, § 2.1, § 2.8, § 3.5, § 5, § 7.2, § 7.6.8, § 7.8, § 9 T-01/T-05) et `docs/superpowers/specs/2026-10-13-classepulse-v2-ux-design.md` (§ 4, § 5.3). Feuille de route : `docs/superpowers/plans/2026-10-13-classepulse-v2-roadmap.md`.

## Global Constraints

- PostgreSQL **18**, image **fixée par empreinte** (`postgres:18@sha256:…`).
- Prisma **figé en version `7.10.0`** (`prisma` et `@prisma/client`, versions exactes) ; pas de version candidate.
- Toutes les dépendances sont installées en **version exacte** (`pnpm add -E`) et le fichier `pnpm-lock.yaml` est committé.
- Secrets : jamais dans Git, les images, les journaux, les arguments de commande **ni les variables d'environnement**. Ce sont des **fichiers**, lus via des variables `X_FILE`. L'application refuse de démarrer si un fichier est illisible.
- Rôles : `cp_owner` (migrations), `cp_app` (API et worker, aucun DDL), `cp_privileged` (`NOLOGIN`), `cp_ops`, `cp_monitor`. Schémas `app`, `ext`, `priv` ; `public` sans droits ; `TEMPORARY` retiré.
- `cp_app` : `transaction_timeout = 10s`, `idle_in_transaction_session_timeout = 10s`, posés **sur le rôle, jamais avec `IN DATABASE`**.
- Transactions en `READ COMMITTED`, rejouées jusqu'à **3 fois** sur `40P01` et `40001`.
- **Seuls les fichiers `*.repository.ts` importent Prisma** (plus le module `database`), imposé par dependency-cruiser.
- Migrations : en-tête `-- classification: expand|contract|irreversible` ; `BEGIN;` et `COMMIT;` **explicites** dans les migrations transactionnelles.
- Tests applicatifs sous `cp_app`, d'exploitation sous `cp_ops`, migrations sous `cp_owner`. **Jamais de superutilisateur** dans les tests applicatifs (le superutilisateur ne sert qu'à initialiser le conteneur).
- `/api/health` public : `{"status":"ok"|"degraded"}`, vérification **mise en cache 10 s**. `/api/health/ready` servi par un **second serveur HTTP sur le port 3001**.
- PostgreSQL : `log_statement='none'`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`.
- Données sensibles transmises à PostgreSQL **uniquement en paramètres liés**, texte SQL constant.
- **Partie C (conditionnelle à T-01)** : rôles applicatifs authentifiés par certificat client, `rolpassword` NULL ; Prisma CLI avec `sslidentity`, `sslpassword`, `sslmode=require`, `sslcert`, **`sslaccept=strict`**.
- UI : Figtree **hébergée par l'application**, graisses 400, 600, 800, caractères latins ; couleurs exactes de l'UX § 4.1 ; thèmes clair et sombre ; tutoiement ; aucun marqueur « style IA » (UX § 4.6).

## Review Focus

1. **Fichier secret avec un saut de ligne final** (cas normal quand on fait `echo "x" > fichier`) : la valeur doit être lue sans le `\n`, sinon toutes les connexions échouent avec « mot de passe incorrect ». → test en tâche 2.
2. **Message d'erreur PostgreSQL qui recopie la valeur saisie** (par exemple `invalid input syntax for type integer: "<secret>"`) : il contourne `log_parameter_max_length=0`, car c'est le *message*, pas le paramètre, qui contient le secret. Les fonctions qui reçoivent un secret ne doivent donc jamais le convertir côté serveur. → test de caractérisation en tâche 11.
3. **Deux `migrate deploy` lancés en même temps** (double clic sur le déploiement, deux runners) : une seule application de chaque migration, l'autre attend ou échoue proprement. → T2 en tâche 10.
4. **`/api/health/ready` atteint depuis l'extérieur** : il ne doit exister que sur le port 3001 ; le port public doit répondre `404`. → test en tâche 3.
5. **Interblocage qui persiste au-delà de 3 essais** : l'appelant doit recevoir l'erreur d'origine (pas une boucle infinie, pas une erreur masquée). → test en tâche 8.

---

## Structure des fichiers

```
package.json · pnpm-workspace.yaml · tsconfig.base.json · eslint.config.mjs · vitest.config.ts · .nvmrc
.dependency-cruiser.cjs
docker-compose.dev.yml
db/
  db-bootstrap-cluster.sql        rôles, attributs, délais de cp_app
  db-bootstrap-database.sql       base, droits de la base, pg_stat_statements
packages/shared/
  package.json · tsconfig.json
  src/index.ts                    constantes partagées (fuseau)
  src/index.spec.ts
apps/api/
  package.json · tsconfig.json · vitest.config.ts · prisma.config.ts
  prisma/schema.prisma
  prisma/migrations/20261013000000_foundations/migration.sql
  src/main.ts                     démarrage des deux serveurs (3000 et 3001)
  src/api.module.ts
  src/config/secret-file.ts       lecture des fichiers secrets
  src/config/config.schema.ts     schéma Zod de l'environnement
  src/config/load-config.ts       configuration typée
  src/config/database-connection.ts  options de connexion (pg et URL Prisma)
  src/config/config.module.ts
  src/database/prisma.service.ts  client Prisma + adaptateur pg
  src/database/tx.ts              transactions et nouvel essai
  src/database/catalog-checks.ts  contrôles de catalogue (index invalides…)
  src/database/database.module.ts
  src/health/readiness.service.ts
  src/health/health.controller.ts
  src/health/ready-server.ts      serveur du port 3001
  src/health/health.module.ts
  test/support/images.ts          image PostgreSQL fixée
  test/support/global-setup.ts    conteneur partagé
  test/support/pg.ts              bases de test, connexions par rôle
  test/support/prisma-cli.ts      lancer la CLI Prisma
  test/support/certs.ts           autorité et certificats de test (partie C)
  test/integration/*.int.spec.ts
  test/architecture/fixtures/**   fichiers violant volontairement les règles
apps/web/
  package.json · tsconfig.json · vite.config.ts · index.html
  src/main.tsx · src/App.tsx
  src/theme/tokens.ts             source unique des couleurs (UX § 4.1)
  src/theme/contrast.ts           calcul du contraste WCAG
  src/theme/tokens.css            généré depuis tokens.ts
  src/theme/theme.ts              préférence clair/sombre/système
  scripts/gen-tokens.ts
.github/workflows/rapide.yml · integration.yml
docs/ops/T-01-prisma.md · T-05-journaux.md · T-06-b2-locktest.md · T-10-reconnaissance-vps.md
```

---

### Task 1 : Monorepo et outillage

**Files :**
- Create : `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `.nvmrc`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test : `packages/shared/src/index.spec.ts`

**Interfaces :**
- Produces : `@classepulse/shared` exporte `APP_TIME_ZONE = 'Africa/Dakar'` ; scripts racine `lint`, `typecheck`, `test:unit`, `test:int`, `depcruise`.

- [ ] **Step 1 : Initialiser le dépôt pnpm**

```bash
node --version            # doit afficher une version LTS (≥ 22)
node --version > .nvmrc
corepack enable
corepack use pnpm@latest  # écrit "packageManager" exact dans package.json
```

`package.json` :

```json
{
  "name": "classepulse",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "eslint .",
    "typecheck": "pnpm -r typecheck",
    "test:unit": "vitest run --project unit --project web",
    "test:int": "vitest run --project integration",
    "depcruise": "depcruise apps/api/src --config .dependency-cruiser.cjs"
  }
}
```

`pnpm-workspace.yaml` :

```yaml
packages:
  - apps/*
  - packages/*
```

`tsconfig.base.json` :

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 2 : Installer l'outillage commun en versions exactes**

```bash
pnpm add -Dw -E typescript vitest unplugin-swc @swc/core eslint typescript-eslint @eslint/js dependency-cruiser prettier
```

`eslint.config.mjs` :

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/generated/**', '**/node_modules/**', 'apps/api/test/architecture/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`vitest.config.ts` (projets : `unit`, `integration`, `web`) :

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { extends: 'apps/api/vitest.config.ts', test: { name: 'unit', include: ['apps/api/src/**/*.spec.ts', 'apps/api/test/architecture/**/*.spec.ts', 'packages/**/src/**/*.spec.ts'] } },
      { extends: 'apps/api/vitest.config.ts', test: { name: 'integration', include: ['apps/api/test/integration/**/*.int.spec.ts'], globalSetup: ['apps/api/test/support/global-setup.ts'], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false } },
      'apps/web',
    ],
  },
});
```

- [ ] **Step 3 : Écrire le test du paquet partagé (il échoue)**

`packages/shared/package.json` :

```json
{
  "name": "@classepulse/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "typecheck": "tsc -p tsconfig.json --noEmit" }
}
```

`packages/shared/tsconfig.json` :

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/shared/src/index.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { APP_TIME_ZONE } from './index.js';

describe('shared', () => {
  it('fixe le fuseau de référence de la plateforme', () => {
    expect(APP_TIME_ZONE).toBe('Africa/Dakar');
  });
});
```

- [ ] **Step 4 : Lancer le test**

Run : `pnpm vitest run packages/shared`
Expected : FAIL — `Cannot find module './index.js'`.

- [ ] **Step 5 : Implémenter**

`packages/shared/src/index.ts` :

```ts
export const APP_TIME_ZONE = 'Africa/Dakar' as const;
```

- [ ] **Step 6 : Relancer**

Run : `pnpm vitest run packages/shared`
Expected : PASS (1 test).

- [ ] **Step 7 : Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs vitest.config.ts .nvmrc packages/shared
git commit -m "chore: initialise le monorepo pnpm et le paquet partagé"
```

---

### Task 2 : Configuration et secrets en fichiers

**Files :**
- Create : `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `apps/api/src/config/secret-file.ts`, `apps/api/src/config/config.schema.ts`, `apps/api/src/config/load-config.ts`, `apps/api/src/config/database-connection.ts`
- Test : `apps/api/src/config/secret-file.spec.ts`, `apps/api/src/config/load-config.spec.ts`, `apps/api/src/config/database-connection.spec.ts`

**Interfaces :**
- Produces :
  - `readSecretFile(path: string): string`
  - `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
  - `type AppConfig = { nodeEnv: 'development'|'test'|'production'; httpPort: number; readyPort: number; db: DbConfig }`
  - `type DbConfig = { host: string; port: number; database: string; user: string; auth: { mode: 'password'; password: string } | { mode: 'cert'; caFile: string; certFile: string; keyFile: string; p12File?: string; p12Password?: string } }`
  - `toPgPoolConfig(db: DbConfig): import('pg').PoolConfig`
  - `toPrismaCliUrl(db: DbConfig): string`

- [ ] **Step 1 : Créer le paquet API**

```bash
mkdir -p apps/api/src/config
cd apps/api
pnpm init
pnpm add -E zod pg @nestjs/common @nestjs/core @nestjs/platform-fastify fastify reflect-metadata rxjs
pnpm add -E -D @types/pg @types/node @nestjs/testing testcontainers @testcontainers/postgresql node-forge @types/node-forge
cd ../..
```

Dans `apps/api/package.json`, ajouter `"name": "@classepulse/api"`, `"type": "module"`, `"private": true` et `"scripts": { "typecheck": "tsc -p tsconfig.json --noEmit", "build": "tsc -p tsconfig.json" }`.

`apps/api/tsconfig.json` :

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist" }, "include": ["src", "test", "prisma.config.ts"] }
```

`apps/api/vitest.config.ts` :

```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { environment: 'node' },
});
```

- [ ] **Step 2 : Écrire les tests de lecture des secrets (ils échouent)**

`apps/api/src/config/secret-file.spec.ts` :

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSecretFile } from './secret-file.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-secret-'));
const file = (name: string, content: string) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

describe('readSecretFile', () => {
  it('retire un seul saut de ligne final (LF)', () => {
    expect(readSecretFile(file('lf', 's3cr3t\n'))).toBe('s3cr3t');
  });
  it('retire un seul saut de ligne final (CRLF)', () => {
    expect(readSecretFile(file('crlf', 's3cr3t\r\n'))).toBe('s3cr3t');
  });
  it('conserve les espaces internes et les autres caractères', () => {
    expect(readSecretFile(file('sp', ' a b \n'))).toBe(' a b ');
  });
  it('refuse un fichier vide', () => {
    expect(() => readSecretFile(file('empty', '\n'))).toThrow(/secret file empty/);
  });
  it("refuse un fichier illisible sans révéler de contenu", () => {
    expect(() => readSecretFile(join(dir, 'absent'))).toThrow(/secret file unreadable: .*absent$/);
  });
});
```

- [ ] **Step 3 : Lancer**

Run : `pnpm vitest run apps/api/src/config/secret-file.spec.ts`
Expected : FAIL — module introuvable.

- [ ] **Step 4 : Implémenter**

`apps/api/src/config/secret-file.ts` :

```ts
import { readFileSync } from 'node:fs';

export function readSecretFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`secret file unreadable: ${path}`);
  }
  const value = raw.replace(/\r?\n$/, '');
  if (value.length === 0) throw new Error(`secret file empty: ${path}`);
  return value;
}
```

- [ ] **Step 5 : Relancer**

Run : `pnpm vitest run apps/api/src/config/secret-file.spec.ts`
Expected : PASS (5 tests).

- [ ] **Step 6 : Écrire les tests de configuration (ils échouent)**

`apps/api/src/config/load-config.spec.ts` :

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './load-config.js';

const dir = mkdtempSync(join(tmpdir(), 'cp-cfg-'));
const pw = join(dir, 'pw');
writeFileSync(pw, 'dev-password\n');

const base = {
  NODE_ENV: 'development',
  HTTP_PORT: '3000',
  READY_PORT: '3001',
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_NAME: 'classepulse',
  DB_USER: 'cp_app',
  DB_AUTH_MODE: 'password',
  DB_PASSWORD_FILE: pw,
};

describe('loadConfig', () => {
  it('construit une configuration typée en mode mot de passe (développement)', () => {
    const cfg = loadConfig(base);
    expect(cfg.httpPort).toBe(3000);
    expect(cfg.readyPort).toBe(3001);
    expect(cfg.db.auth).toEqual({ mode: 'password', password: 'dev-password' });
  });
  it('refuse une variable manquante', () => {
    const { DB_HOST: _omit, ...env } = base;
    expect(() => loadConfig(env)).toThrow(/DB_HOST/);
  });
  it('refuse le mode mot de passe en production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/password mode is not allowed in production/);
  });
  it('refuse un secret passé directement dans une variable', () => {
    expect(() => loadConfig({ ...base, DB_PASSWORD: 'x' })).toThrow(/DB_PASSWORD must not be set/);
  });
  it('lit les chemins des certificats en mode cert', () => {
    const cfg = loadConfig({
      ...base,
      NODE_ENV: 'production',
      DB_AUTH_MODE: 'cert',
      DB_PASSWORD_FILE: undefined,
      DB_SSL_CA_FILE: '/run/secrets/ca.crt',
      DB_SSL_CERT_FILE: '/run/secrets/client.crt',
      DB_SSL_KEY_FILE: '/run/secrets/client.key',
    });
    expect(cfg.db.auth).toEqual({ mode: 'cert', caFile: '/run/secrets/ca.crt', certFile: '/run/secrets/client.crt', keyFile: '/run/secrets/client.key' });
  });
});
```

- [ ] **Step 7 : Lancer**

Run : `pnpm vitest run apps/api/src/config/load-config.spec.ts`
Expected : FAIL — module introuvable.

- [ ] **Step 8 : Implémenter**

`apps/api/src/config/config.schema.ts` :

```ts
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    HTTP_PORT: port,
    READY_PORT: port,
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

export type Env = z.infer<typeof envSchema>;
```

`apps/api/src/config/load-config.ts` :

```ts
import { envSchema } from './config.schema.js';
import { readSecretFile } from './secret-file.js';

export type DbAuth =
  | { mode: 'password'; password: string }
  | { mode: 'cert'; caFile: string; certFile: string; keyFile: string; p12File?: string; p12Password?: string };

export type DbConfig = { host: string; port: number; database: string; user: string; auth: DbAuth };

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  httpPort: number;
  readyPort: number;
  db: DbConfig;
};

const FORBIDDEN_DIRECT_SECRETS = ['DB_PASSWORD', 'DATABASE_URL'] as const;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  for (const key of FORBIDDEN_DIRECT_SECRETS) {
    if (env[key] !== undefined) throw new Error(`${key} must not be set: use a *_FILE secret`);
  }
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid configuration: ${names}`);
  }
  const e = parsed.data;
  let auth: DbAuth;
  if (e.DB_AUTH_MODE === 'password') {
    if (e.NODE_ENV === 'production') throw new Error('password mode is not allowed in production');
    if (!e.DB_PASSWORD_FILE) throw new Error('invalid configuration: DB_PASSWORD_FILE');
    auth = { mode: 'password', password: readSecretFile(e.DB_PASSWORD_FILE) };
  } else {
    if (!e.DB_SSL_CA_FILE || !e.DB_SSL_CERT_FILE || !e.DB_SSL_KEY_FILE) {
      throw new Error('invalid configuration: DB_SSL_CA_FILE, DB_SSL_CERT_FILE, DB_SSL_KEY_FILE');
    }
    auth = { mode: 'cert', caFile: e.DB_SSL_CA_FILE, certFile: e.DB_SSL_CERT_FILE, keyFile: e.DB_SSL_KEY_FILE };
    if (e.DB_SSL_P12_FILE) auth.p12File = e.DB_SSL_P12_FILE;
    if (e.DB_SSL_P12_PASSWORD_FILE) auth.p12Password = readSecretFile(e.DB_SSL_P12_PASSWORD_FILE);
  }
  return {
    nodeEnv: e.NODE_ENV,
    httpPort: e.HTTP_PORT,
    readyPort: e.READY_PORT,
    db: { host: e.DB_HOST, port: e.DB_PORT, database: e.DB_NAME, user: e.DB_USER, auth },
  };
}
```

- [ ] **Step 9 : Relancer**

Run : `pnpm vitest run apps/api/src/config/load-config.spec.ts`
Expected : PASS (5 tests).

- [ ] **Step 10 : Écrire les tests des options de connexion (ils échouent)**

`apps/api/src/config/database-connection.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { toPgPoolConfig, toPrismaCliUrl } from './database-connection.js';

const db = { host: 'db', port: 5432, database: 'classepulse', user: 'cp_owner' };

describe('options de connexion', () => {
  it('mode mot de passe : options pg sans URL', () => {
    const cfg = toPgPoolConfig({ ...db, auth: { mode: 'password', password: 'p@ss/w:rd' } });
    expect(cfg).toMatchObject({ host: 'db', port: 5432, database: 'classepulse', user: 'cp_owner', password: 'p@ss/w:rd' });
    expect(cfg.ssl).toBeUndefined();
  });
  it('mode mot de passe : URL Prisma avec le mot de passe encodé et le schéma app', () => {
    const url = toPrismaCliUrl({ ...db, auth: { mode: 'password', password: 'p@ss/w:rd' } });
    expect(url).toBe('postgresql://cp_owner:p%40ss%2Fw%3Ard@db:5432/classepulse?schema=app');
  });
  it('mode cert : URL Prisma stricte (sslaccept=strict obligatoire)', () => {
    const url = toPrismaCliUrl({
      ...db,
      auth: { mode: 'cert', caFile: '/s/ca.crt', certFile: '/s/c.crt', keyFile: '/s/c.key', p12File: '/s/c.p12', p12Password: 'x y' },
    });
    const u = new URL(url);
    expect(u.username).toBe('cp_owner');
    expect(u.password).toBe('');
    expect(u.searchParams.get('sslmode')).toBe('require');
    expect(u.searchParams.get('sslaccept')).toBe('strict');
    expect(u.searchParams.get('sslcert')).toBe('/s/ca.crt');
    expect(u.searchParams.get('sslidentity')).toBe('/s/c.p12');
    expect(u.searchParams.get('sslpassword')).toBe('x y');
  });
  it('mode cert sans identité PKCS#12 : URL Prisma refusée', () => {
    expect(() => toPrismaCliUrl({ ...db, auth: { mode: 'cert', caFile: 'a', certFile: 'b', keyFile: 'c' } })).toThrow(/DB_SSL_P12_FILE/);
  });
});
```

- [ ] **Step 11 : Lancer**

Run : `pnpm vitest run apps/api/src/config/database-connection.spec.ts`
Expected : FAIL — module introuvable.

- [ ] **Step 12 : Implémenter**

`apps/api/src/config/database-connection.ts` :

```ts
import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';
import type { DbConfig } from './load-config.js';

export function toPgPoolConfig(db: DbConfig): PoolConfig {
  const base: PoolConfig = { host: db.host, port: db.port, database: db.database, user: db.user };
  if (db.auth.mode === 'password') return { ...base, password: db.auth.password };
  return {
    ...base,
    ssl: {
      rejectUnauthorized: true,
      ca: readFileSync(db.auth.caFile, 'utf8'),
      cert: readFileSync(db.auth.certFile, 'utf8'),
      key: readFileSync(db.auth.keyFile, 'utf8'),
    },
  };
}

export function toPrismaCliUrl(db: DbConfig): string {
  const u = new URL(`postgresql://${db.host}:${db.port}/${encodeURIComponent(db.database)}`);
  u.username = encodeURIComponent(db.user);
  u.searchParams.set('schema', 'app');
  if (db.auth.mode === 'password') {
    u.password = encodeURIComponent(db.auth.password);
    return u.toString();
  }
  if (!db.auth.p12File) throw new Error('invalid configuration: DB_SSL_P12_FILE (required by the Prisma CLI)');
  u.searchParams.set('sslmode', 'require');
  u.searchParams.set('sslaccept', 'strict');
  u.searchParams.set('sslcert', db.auth.caFile);
  u.searchParams.set('sslidentity', db.auth.p12File);
  if (db.auth.p12Password !== undefined) u.searchParams.set('sslpassword', db.auth.p12Password);
  return u.toString();
}
```

- [ ] **Step 13 : Relancer**

Run : `pnpm vitest run apps/api/src/config`
Expected : PASS (14 tests). Si le test d'URL échoue à cause de l'encodage du mot de passe (`URL` ré-encode `%`), remplacer l'affectation par `u.password = db.auth.password` (l'objet `URL` encode lui-même) et ajuster l'attendu du test sur la sortie réelle, après avoir vérifié que le mot de passe décodé est identique.

- [ ] **Step 14 : Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): configuration Zod et secrets lus depuis des fichiers"
```

---

### Task 3 : Application NestJS, `/api/health` et serveur interne 3001

**Files :**
- Create : `apps/api/src/config/config.module.ts`, `apps/api/src/health/readiness.service.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/health/ready-server.ts`, `apps/api/src/health/health.module.ts`, `apps/api/src/api.module.ts`, `apps/api/src/main.ts`
- Test : `apps/api/src/health/health.spec.ts`

**Interfaces :**
- Consumes : `loadConfig`, `AppConfig` (tâche 2).
- Produces :
  - jeton d'injection `APP_CONFIG` (valeur `AppConfig`) exporté par `ConfigModule`
  - `abstract class ReadinessProbe { abstract check(): Promise<boolean> }` (implémenté en tâche 8 par le module `database`)
  - `ReadinessService.isReady(): Promise<boolean>` (non mis en cache), `ReadinessService.publicStatus(): Promise<'ok'|'degraded'>` (mis en cache 10 s)
  - `buildReadyServer(readiness: ReadinessService): FastifyInstance`
  - `ApiModule.forRoot(config: AppConfig, probe: Type<ReadinessProbe>)`

- [ ] **Step 1 : Écrire les tests (ils échouent)**

`apps/api/src/health/health.spec.ts` :

```ts
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HealthModule } from './health.module.js';
import { ReadinessProbe } from './readiness.service.js';
import { ReadinessService } from './readiness.service.js';
import { buildReadyServer } from './ready-server.js';

class FakeProbe extends ReadinessProbe {
  ok = true;
  calls = 0;
  async check() { this.calls++; return this.ok; }
}

describe('santé', () => {
  let app: NestFastifyApplication;
  let probe: FakeProbe;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    probe = new FakeProbe();
    const mod = await Test.createTestingModule({ imports: [HealthModule.register(FakeProbe)] })
      .overrideProvider(ReadinessProbe).useValue(probe)
      .compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(async () => { vi.useRealTimers(); await app.close(); });

  it('/api/health renvoie seulement le statut', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/api/health met la vérification en cache 10 s', async () => {
    await app.inject({ method: 'GET', url: '/api/health' });
    await app.inject({ method: 'GET', url: '/api/health' });
    expect(probe.calls).toBe(1);
    vi.setSystemTime(Date.now() + 10_001);
    probe.ok = false;
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ status: 'degraded' });
    expect(probe.calls).toBe(2);
  });

  it("/api/health/ready n'existe pas sur le port public", async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health/ready' });
    expect(res.statusCode).toBe(404);
  });

  it('le serveur interne répond 200 puis 503, sans cache', async () => {
    const ready = buildReadyServer(app.get(ReadinessService));
    expect((await ready.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(200);
    probe.ok = false;
    expect((await ready.inject({ method: 'GET', url: '/api/health/ready' })).statusCode).toBe(503);
    await ready.close();
  });
});
```

- [ ] **Step 2 : Lancer**

Run : `pnpm vitest run apps/api/src/health`
Expected : FAIL — modules introuvables.

- [ ] **Step 3 : Implémenter**

`apps/api/src/health/readiness.service.ts` :

```ts
import { Injectable } from '@nestjs/common';

export abstract class ReadinessProbe {
  abstract check(): Promise<boolean>;
}

const PUBLIC_CACHE_MS = 10_000;

@Injectable()
export class ReadinessService {
  private cached: { at: number; status: 'ok' | 'degraded' } | undefined;

  constructor(private readonly probe: ReadinessProbe) {}

  async isReady(): Promise<boolean> {
    try {
      return await this.probe.check();
    } catch {
      return false;
    }
  }

  async publicStatus(): Promise<'ok' | 'degraded'> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < PUBLIC_CACHE_MS) return this.cached.status;
    const status = (await this.isReady()) ? 'ok' : 'degraded';
    this.cached = { at: now, status };
    return status;
  }
}
```

`apps/api/src/health/health.controller.ts` :

```ts
import { Controller, Get } from '@nestjs/common';
import { ReadinessService } from './readiness.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get()
  async health(): Promise<{ status: 'ok' | 'degraded' }> {
    return { status: await this.readiness.publicStatus() };
  }
}
```

`apps/api/src/health/health.module.ts` :

```ts
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ReadinessProbe, ReadinessService } from './readiness.service.js';

@Module({})
export class HealthModule {
  static register(probe: Type<ReadinessProbe>, imports: DynamicModule['imports'] = []): DynamicModule {
    return {
      module: HealthModule,
      imports,
      controllers: [HealthController],
      providers: [{ provide: ReadinessProbe, useExisting: probe }, probe, ReadinessService],
      exports: [ReadinessService],
    };
  }
}
```

`apps/api/src/health/ready-server.ts` :

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import type { ReadinessService } from './readiness.service.js';

export function buildReadyServer(readiness: ReadinessService): FastifyInstance {
  const server = Fastify({ logger: false });
  server.get('/api/health/ready', async (_req, reply) => {
    const ok = await readiness.isReady();
    return reply.code(ok ? 200 : 503).send({ ready: ok });
  });
  return server;
}
```

`apps/api/src/config/config.module.ts` :

```ts
import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from './load-config.js';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return { module: ConfigModule, providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] };
  }
}
```

`apps/api/src/api.module.ts` :

```ts
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import type { AppConfig } from './config/load-config.js';
import { HealthModule } from './health/health.module.js';
import type { ReadinessProbe } from './health/readiness.service.js';

@Module({})
export class ApiModule {
  static forRoot(config: AppConfig, probe: Type<ReadinessProbe>, imports: DynamicModule['imports'] = []): DynamicModule {
    return { module: ApiModule, imports: [ConfigModule.forRoot(config), ...imports, HealthModule.register(probe, imports)] };
  }
}
```

`apps/api/src/main.ts` (le module `database` est branché en tâche 8 ; d'ici là, la sonde renvoie `true`) :

```ts
import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ApiModule } from './api.module.js';
import { loadConfig } from './config/load-config.js';
import { ReadinessProbe, ReadinessService } from './health/readiness.service.js';
import { buildReadyServer } from './health/ready-server.js';

@Injectable()
class AlwaysReady extends ReadinessProbe {
  async check() { return true; }
}

async function bootstrap(): Promise<void> {
  const config = loadConfig(process.env);
  const app = await NestFactory.create<NestFastifyApplication>(ApiModule.forRoot(config, AlwaysReady), new FastifyAdapter());
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  await app.listen({ port: config.httpPort, host: '0.0.0.0' });
  const ready = buildReadyServer(app.get(ReadinessService));
  await ready.listen({ port: config.readyPort, host: '0.0.0.0' });
}

void bootstrap();
```

- [ ] **Step 4 : Relancer**

Run : `pnpm vitest run apps/api/src/health`
Expected : PASS (4 tests).

- [ ] **Step 5 : Commit**

```bash
git add apps/api
git commit -m "feat(api): application NestJS, /api/health en cache et serveur interne 3001"
```

---

### Task 4 : Scripts d'initialisation de la base et environnement de développement

**Files :**
- Create : `db/db-bootstrap-cluster.sql`, `db/db-bootstrap-database.sql`, `docker-compose.dev.yml`, `apps/api/test/support/images.ts`, `README.md`

**Interfaces :**
- Produces : scripts exécutables par `postgres` avec `psql -v ON_ERROR_STOP=1` ; `db-bootstrap-database.sql` prend la variable `dbname` ; `PG_IMAGE` (image fixée par empreinte).

- [ ] **Step 1 : Fixer l'image PostgreSQL par empreinte**

```bash
docker pull postgres:18
docker image inspect postgres:18 --format '{{index .RepoDigests 0}}'
# exemple de sortie : postgres@sha256:3f1c…
```

`apps/api/test/support/images.ts` (remplacer la valeur par la sortie exacte de la commande, préfixée de `postgres:18@`) :

```ts
export const PG_IMAGE = process.env.PG_IMAGE ?? 'postgres:18@sha256:<sortie exacte de la commande ci-dessus>';
```

La même chaîne est utilisée dans `docker-compose.dev.yml`. Le test de la tâche 5 vérifie qu'elle contient `@sha256:` suivi de 64 caractères hexadécimaux.

- [ ] **Step 2 : Écrire `db/db-bootstrap-cluster.sql`**

```sql
-- db-bootstrap-cluster.sql — exécuté par postgres, rejouable sans dommage.
\set ON_ERROR_STOP on

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['cp_owner','cp_app','cp_ops','cp_monitor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I LOGIN', r);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_privileged') THEN
    CREATE ROLE cp_privileged NOLOGIN;
  END IF;
END $$;

ALTER ROLE cp_owner      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE cp_app        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE cp_ops        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE cp_monitor    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE cp_privileged NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOLOGIN;

GRANT cp_privileged TO cp_owner;

-- Délais de cp_app : sur le rôle lui-même, jamais IN DATABASE (§ 7.2.7).
ALTER ROLE cp_app SET transaction_timeout = '10s';
ALTER ROLE cp_app SET idle_in_transaction_session_timeout = '10s';

-- [C — conditionnel T-01] En production, aucun mot de passe : authentification par certificat.
-- En développement et en test, les mots de passe sont posés séparément (tâche 5), jamais ici.
```

Note : `cp_owner` est `NOINHERIT` ; il doit faire `SET ROLE cp_privileged` explicitement pour créer des objets `priv`. C'est voulu : les migrations le font dans leur transaction.

- [ ] **Step 3 : Écrire `db/db-bootstrap-database.sql`**

```sql
-- db-bootstrap-database.sql — psql -v dbname=<nom>, exécuté par postgres, rejouable.
\set ON_ERROR_STOP on

SELECT format('CREATE DATABASE %I OWNER cp_owner', :'dbname')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'dbname') \gexec

SELECT format('ALTER DATABASE %I OWNER TO cp_owner', :'dbname') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'dbname') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO cp_owner, cp_app, cp_ops, cp_monitor', :'dbname') \gexec
-- Aucun ALTER DATABASE … SET (§ 7.2.7).

\connect :dbname
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

- [ ] **Step 4 : Écrire `docker-compose.dev.yml` (développement local uniquement)**

```yaml
# Développement local uniquement. Ports publiés sur 127.0.0.1 seulement.
services:
  postgres:
    image: postgres:18@sha256:<même empreinte que images.ts>
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/pg_superuser_password
    command: ["postgres", "-c", "shared_preload_libraries=pg_stat_statements", "-c", "log_statement=none", "-c", "log_parameter_max_length=0", "-c", "log_parameter_max_length_on_error=0"]
    secrets: [pg_superuser_password]
    volumes:
      - pgdata:/var/lib/postgresql
      - ./db:/bootstrap:ro
    ports: ["127.0.0.1:5432:5432"]
  minio:
    image: minio/minio
    command: ["server", "/data", "--console-address", ":9001"]
    ports: ["127.0.0.1:9000:9000", "127.0.0.1:9001:9001"]
  mailpit:
    image: axllent/mailpit
    ports: ["127.0.0.1:1025:1025", "127.0.0.1:8025:8025"]
secrets:
  pg_superuser_password:
    file: ./.secrets/dev/pg_superuser_password
volumes:
  pgdata: {}
```

Fixer aussi `minio/minio` et `axllent/mailpit` par empreinte, avec la même commande `docker image inspect` que pour PostgreSQL. Ajouter `.secrets/` au `.gitignore`.

- [ ] **Step 5 : Vérifier les scripts à la main**

```bash
mkdir -p .secrets/dev && openssl rand -hex 24 > .secrets/dev/pg_superuser_password
docker compose -f docker-compose.dev.yml up -d postgres
docker compose -f docker-compose.dev.yml exec -T -u postgres postgres psql -v ON_ERROR_STOP=1 -f /bootstrap/db-bootstrap-cluster.sql
docker compose -f docker-compose.dev.yml exec -T -u postgres postgres psql -v ON_ERROR_STOP=1 -v dbname=classepulse -f /bootstrap/db-bootstrap-database.sql
# Rejouer les deux commandes : aucune erreur attendue (scripts rejouables).
docker compose -f docker-compose.dev.yml exec -T -u postgres postgres psql -d classepulse -c "select rolname, rolcanlogin from pg_roles where rolname like 'cp\_%' order by 1"
```

Expected : 5 rôles ; `cp_privileged` avec `rolcanlogin = f`.

- [ ] **Step 6 : README de développement**

`README.md` : remplacer le contenu par un titre, un paragraphe renvoyant aux deux spécifications et à la feuille de route, puis la section « Démarrer en local » reprenant exactement les commandes de l'étape 5, suivies de `pnpm install` et `pnpm test:unit`.

- [ ] **Step 7 : Commit**

```bash
git add db docker-compose.dev.yml apps/api/test/support/images.ts README.md .gitignore
git commit -m "feat(db): scripts d'initialisation des rôles et de la base, environnement de développement"
```

---

### Task 5 : Harnais Testcontainers sur rôles réels

**Files :**
- Create : `apps/api/test/support/global-setup.ts`, `apps/api/test/support/pg.ts`
- Test : `apps/api/test/integration/bootstrap.int.spec.ts`

**Interfaces :**
- Consumes : `PG_IMAGE` (tâche 4), scripts `db/*.sql`.
- Produces :
  - `inject('pg')` → `PgInfo = { host: string; port: number; superPassword: string; rolePassword: string; templateDb: string }`
  - `createTestDatabase(): Promise<string>` (crée une base copiée du modèle, rejoue les droits de la base, renvoie son nom)
  - `connectAs(role: 'postgres'|'cp_owner'|'cp_app'|'cp_ops'|'cp_monitor', database: string): Promise<pg.Client>`
  - `runSql(database: string, sql: string): Promise<void>` (superutilisateur, initialisation uniquement)
  - `dbConfigFor(role, database): DbConfig` (mode mot de passe, pour Prisma et la CLI)
  - `PG_CONTAINER` : accès au conteneur pour lire les journaux (`getPgContainer()`)

- [ ] **Step 1 : Écrire le test d'initialisation (il échoue)**

`apps/api/test/integration/bootstrap.int.spec.ts` :

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { PG_IMAGE } from '../support/images.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

describe('initialisation de la base', () => {
  it("l'image PostgreSQL est fixée par empreinte", () => {
    expect(PG_IMAGE).toMatch(/^postgres:18@sha256:[0-9a-f]{64}$/);
  });

  it('crée les rôles avec les bons attributs', async () => {
    const c = await connectAs('cp_monitor', db);
    const { rows } = await c.query(
      `select rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole from pg_roles where rolname like 'cp\\_%' order by 1`,
    );
    await c.end();
    expect(rows).toEqual([
      { rolname: 'cp_app', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
      { rolname: 'cp_monitor', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
      { rolname: 'cp_ops', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
      { rolname: 'cp_owner', rolsuper: false, rolcanlogin: true, rolcreatedb: false, rolcreaterole: false },
      { rolname: 'cp_privileged', rolsuper: false, rolcanlogin: false, rolcreatedb: false, rolcreaterole: false },
    ]);
  });

  it('pose les délais de cp_app sur le rôle (setdatabase = 0)', async () => {
    const c = await connectAs('cp_app', db);
    const t = await c.query('show transaction_timeout');
    const i = await c.query('show idle_in_transaction_session_timeout');
    await c.end();
    expect(t.rows[0].transaction_timeout).toBe('10s');
    expect(i.rows[0].idle_in_transaction_session_timeout).toBe('10s');
  });

  it("retire CONNECT et TEMPORARY à PUBLIC sur la base", async () => {
    const c = await connectAs('cp_app', db);
    const { rows } = await c.query(
      `select has_database_privilege('cp_app', current_database(), 'TEMPORARY') as app_temp,
              has_database_privilege('cp_monitor', current_database(), 'TEMPORARY') as mon_temp`,
    );
    await c.end();
    expect(rows[0]).toEqual({ app_temp: false, mon_temp: false });
  });
});
```

- [ ] **Step 2 : Lancer**

Run : `pnpm test:int -- bootstrap`
Expected : FAIL — `../support/pg.js` introuvable.

- [ ] **Step 3 : Implémenter le démarrage partagé**

`apps/api/test/support/global-setup.ts` :

```ts
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { PG_IMAGE } from './images.js';

export type PgInfo = { host: string; port: number; superPassword: string; rolePassword: string; templateDb: string; containerId: string };

declare module 'vitest' {
  export interface ProvidedContext { pg: PgInfo }
}

let container: StartedPostgreSqlContainer | undefined;

async function psql(c: StartedPostgreSqlContainer, args: string[]): Promise<void> {
  const r = await c.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', ...args]);
  if (r.exitCode !== 0) throw new Error(`psql failed (${r.exitCode}): ${r.output}`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const superPassword = randomBytes(18).toString('hex');
  const rolePassword = randomBytes(18).toString('hex');
  container = await new PostgreSqlContainer(PG_IMAGE)
    .withUsername('postgres')
    .withPassword(superPassword)
    .withDatabase('postgres')
    .withCommand(['postgres', '-c', 'shared_preload_libraries=pg_stat_statements', '-c', 'log_statement=none', '-c', 'log_parameter_max_length=0', '-c', 'log_parameter_max_length_on_error=0'])
    .withCopyDirectoriesToContainer([{ source: resolve(import.meta.dirname, '../../../../db'), target: '/bootstrap' }])
    .start();

  await psql(container, ['-d', 'postgres', '-f', '/bootstrap/db-bootstrap-cluster.sql']);
  // Test uniquement : mots de passe aléatoires pour le mode « password ». Jamais en production.
  for (const role of ['cp_owner', 'cp_app', 'cp_ops', 'cp_monitor']) {
    await psql(container, ['-d', 'postgres', '-c', `ALTER ROLE ${role} PASSWORD '${rolePassword}'`]);
  }
  const templateDb = 'cp_template';
  await psql(container, ['-d', 'postgres', '-v', `dbname=${templateDb}`, '-f', '/bootstrap/db-bootstrap-database.sql']);

  project.provide('pg', {
    host: container.getHost(),
    port: container.getPort(),
    superPassword,
    rolePassword,
    templateDb,
    containerId: container.getId(),
  });
  return async () => { await container?.stop(); };
}
```

Note : à la tâche 6, ce `setup` appliquera aussi les migrations Prisma sur `cp_template` (étape 6 de la tâche 6).

`apps/api/test/support/pg.ts` :

```ts
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import type { DbConfig } from '../../src/config/load-config.js';

export type Role = 'postgres' | 'cp_owner' | 'cp_app' | 'cp_ops' | 'cp_monitor';

function info() { return inject('pg'); }

export async function connectAs(role: Role, database: string): Promise<pg.Client> {
  const i = info();
  const client = new pg.Client({
    host: i.host,
    port: i.port,
    user: role,
    password: role === 'postgres' ? i.superPassword : i.rolePassword,
    database,
  });
  await client.connect();
  return client;
}

export async function runSql(database: string, sql: string): Promise<void> {
  const c = await connectAs('postgres', database);
  try { await c.query(sql); } finally { await c.end(); }
}

export async function createTestDatabase(): Promise<string> {
  const i = info();
  const name = `t_${randomBytes(6).toString('hex')}`;
  await runSql('postgres', `CREATE DATABASE ${name} TEMPLATE ${i.templateDb} OWNER cp_owner`);
  await runSql('postgres', `REVOKE ALL ON DATABASE ${name} FROM PUBLIC; GRANT CONNECT ON DATABASE ${name} TO cp_owner, cp_app, cp_ops, cp_monitor`);
  return name;
}

export function dbConfigFor(role: Exclude<Role, 'postgres'>, database: string): DbConfig {
  const i = info();
  return { host: i.host, port: i.port, database, user: role, auth: { mode: 'password', password: i.rolePassword } };
}
```

- [ ] **Step 4 : Relancer**

Run : `pnpm test:int -- bootstrap`
Expected : PASS (4 tests). Si `withCopyDirectoriesToContainer` n'existe pas dans la version installée, utiliser `withCopyFilesToContainer` avec les deux fichiers SQL listés un à un.

- [ ] **Step 5 : Commit**

```bash
git add apps/api/test
git commit -m "test(api): harnais Testcontainers PostgreSQL 18 avec rôles réels"
```

---

### Task 6 : Prisma 7.10.0, schéma et migration de fondation

**Files :**
- Create : `apps/api/prisma.config.ts`, `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261013000000_foundations/migration.sql`, `apps/api/prisma/migrations/migration_lock.toml`, `apps/api/test/support/prisma-cli.ts`
- Modify : `apps/api/test/support/global-setup.ts` (appliquer les migrations sur le modèle)
- Test : `apps/api/test/integration/schema-presence.int.spec.ts`

**Interfaces :**
- Consumes : `loadConfig`, `toPrismaCliUrl` (tâche 2) ; harnais (tâche 5).
- Produces :
  - client généré dans `apps/api/src/generated/prisma` (modèles `SyncEpoch`, `OpsSettings`)
  - `runPrisma(args: string[], db: DbConfig, opts?: { configPath?: string }): Promise<{ code: number; stdout: string; stderr: string }>`
  - tables `app.sync_epoch` (une ligne, `id = 1`) et `app.ops_settings` (une ligne, `id = 1`) ; schémas `app`, `ext`, `priv` ; extensions `citext` et `pgcrypto` dans `ext`

- [ ] **Step 1 : Installer Prisma en version exacte**

```bash
cd apps/api
pnpm add -E prisma@7.10.0 @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0
cd ../..
```

Vérifier `apps/api/package.json` : les trois versions sont exactement `7.10.0`. Lire la documentation Prisma 7 sur `prisma.config.ts`, le générateur `prisma-client` et les driver adapters ; si un nom d'option ci-dessous diffère dans la version 7.10.0, appliquer le nom documenté et le noter dans `docs/ops/T-01-prisma.md`.

- [ ] **Step 2 : Configuration et schéma**

`apps/api/prisma.config.ts` (l'URL est construite en mémoire à partir des fichiers secrets ; jamais de `DATABASE_URL`) :

```ts
import { defineConfig } from 'prisma/config';
import { loadConfig } from './src/config/load-config.js';
import { toPrismaCliUrl } from './src/config/database-connection.js';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: toPrismaCliUrl(loadConfig(process.env).db) },
});
```

`apps/api/prisma/schema.prisma` :

```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "esm"
}

datasource db {
  provider = "postgresql"
  schemas  = ["app"]
}

model SyncEpoch {
  id    Int    @id @db.SmallInt
  epoch String @db.Uuid

  @@map("sync_epoch")
  @@schema("app")
}

model OpsSettings {
  id                      Int       @id @db.SmallInt
  orphanDeletePausedUntil DateTime? @map("orphan_delete_paused_until") @db.Timestamptz
  orphanReviewRequired    Boolean   @default(false) @map("orphan_review_required")
  bulkEmailPaused         Boolean   @default(false) @map("bulk_email_paused")
  lastRestoreAt           DateTime? @map("last_restore_at") @db.Timestamptz
  lastRestoreBackupAt     DateTime? @map("last_restore_backup_at") @db.Timestamptz

  @@map("ops_settings")
  @@schema("app")
}
```

Ajouter `apps/api/src/generated/` au `.gitignore`, et le script `"prisma:generate": "prisma generate"` dans `apps/api/package.json`.

- [ ] **Step 3 : Écrire la migration de fondation (SQL brut, § 2.8)**

`apps/api/prisma/migrations/20261013000000_foundations/migration.sql` :

```sql
-- classification: expand
BEGIN;

CREATE SCHEMA IF NOT EXISTS ext;
CREATE SCHEMA IF NOT EXISTS app;
-- cp_owner (propriétaire de la base, membre de cp_privileged) crée priv au nom de cp_privileged.
CREATE SCHEMA IF NOT EXISTS priv AUTHORIZATION cp_privileged;

CREATE EXTENSION IF NOT EXISTS citext SCHEMA ext;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA ext;

REVOKE ALL ON SCHEMA app, ext FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO cp_app, cp_ops, cp_monitor;
GRANT USAGE ON SCHEMA ext TO cp_app, cp_ops, cp_monitor, cp_privileged;
-- cp_owner est NOINHERIT : il agit sur priv en prenant explicitement le rôle propriétaire.
SET LOCAL ROLE cp_privileged;
REVOKE ALL ON SCHEMA priv FROM PUBLIC;
GRANT USAGE ON SCHEMA priv TO cp_ops, cp_monitor;
RESET ROLE;

CREATE TABLE app.sync_epoch (
  id    smallint PRIMARY KEY CHECK (id = 1),
  epoch uuid NOT NULL
);
INSERT INTO app.sync_epoch (id, epoch) VALUES (1, gen_random_uuid());
GRANT SELECT ON app.sync_epoch TO cp_app;

CREATE TABLE app.ops_settings (
  id                         smallint PRIMARY KEY CHECK (id = 1),
  orphan_delete_paused_until timestamptz,
  orphan_review_required     boolean NOT NULL DEFAULT false,
  bulk_email_paused          boolean NOT NULL DEFAULT false,
  last_restore_at            timestamptz,
  last_restore_backup_at     timestamptz
);
INSERT INTO app.ops_settings (id) VALUES (1);
GRANT SELECT ON app.ops_settings TO cp_app;

COMMIT;
```

`apps/api/prisma/migrations/migration_lock.toml` :

```toml
provider = "postgresql"
```

- [ ] **Step 4 : Utilitaire CLI pour les tests**

`apps/api/test/support/prisma-cli.ts` :

```ts
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DbConfig } from '../../src/config/load-config.js';

export const API_DIR = resolve(import.meta.dirname, '../..');

export function envForDb(db: DbConfig): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'cp-prisma-'));
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    HTTP_PORT: '3000',
    READY_PORT: '3001',
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_NAME: db.database,
    DB_USER: db.user,
    DB_AUTH_MODE: db.auth.mode,
  };
  if (db.auth.mode === 'password') {
    const pw = join(dir, 'pw');
    writeFileSync(pw, db.auth.password, { mode: 0o600 });
    return { ...base, DB_PASSWORD_FILE: pw };
  }
  const env: NodeJS.ProcessEnv = { ...base, DB_SSL_CA_FILE: db.auth.caFile, DB_SSL_CERT_FILE: db.auth.certFile, DB_SSL_KEY_FILE: db.auth.keyFile };
  if (db.auth.p12File) env.DB_SSL_P12_FILE = db.auth.p12File;
  if (db.auth.p12Password !== undefined) {
    const p = join(dir, 'p12pw');
    writeFileSync(p, db.auth.p12Password, { mode: 0o600 });
    env.DB_SSL_P12_PASSWORD_FILE = p;
  }
  return env;
}

export function runPrisma(args: string[], db: DbConfig, opts: { configPath?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const full = opts.configPath ? [...args, '--config', opts.configPath] : args;
  return new Promise((done) => {
    execFile('pnpm', ['exec', 'prisma', ...full], { cwd: API_DIR, env: envForDb(db), timeout: 120_000 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
```

- [ ] **Step 5 : Écrire le test de présence du schéma (il échoue)**

`apps/api/test/integration/schema-presence.int.spec.ts` :

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

describe('présence du schéma (§ 2.8)', () => {
  it('schémas, extensions et tables de fondation', async () => {
    const c = await connectAs('cp_monitor', db);
    const schemas = await c.query(`select nspname from pg_namespace where nspname in ('app','ext','priv') order by 1`);
    const ext = await c.query(`select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where extname in ('citext','pgcrypto') order by 1`);
    const priv = await c.query(`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'priv'`);
    await c.end();
    expect(schemas.rows.map((r) => r.nspname)).toEqual(['app', 'ext', 'priv']);
    expect(ext.rows).toEqual([{ extname: 'citext', nspname: 'ext' }, { extname: 'pgcrypto', nspname: 'ext' }]);
    expect(priv.rows[0].owner).toBe('cp_privileged');
  });

  it('une seule ligne dans sync_epoch et ops_settings, lisibles par cp_app', async () => {
    const c = await connectAs('cp_app', db);
    const e = await c.query('select count(*)::int as n from app.sync_epoch');
    const o = await c.query('select count(*)::int as n from app.ops_settings');
    await c.end();
    expect(e.rows[0].n).toBe(1);
    expect(o.rows[0].n).toBe(1);
  });

  it('la migration de fondation est enregistrée par Prisma', async () => {
    const c = await connectAs('cp_owner', db);
    const r = await c.query(`select migration_name, finished_at is not null as done from app._prisma_migrations`);
    await c.end();
    expect(r.rows).toEqual([{ migration_name: '20261013000000_foundations', done: true }]);
  });
});
```

- [ ] **Step 6 : Appliquer les migrations sur la base modèle**

Dans `apps/api/test/support/global-setup.ts`, après la création de `cp_template` et avant `project.provide`, ajouter :

```ts
import { runPrisma } from './prisma-cli.js';
// …
const migrate = await runPrisma(['migrate', 'deploy'], {
  host: container.getHost(), port: container.getPort(), database: templateDb, user: 'cp_owner',
  auth: { mode: 'password', password: rolePassword },
});
if (migrate.code !== 0) throw new Error(`prisma migrate deploy failed:\n${migrate.stdout}\n${migrate.stderr}`);
```

- [ ] **Step 7 : Générer le client et lancer les tests**

Run : `pnpm --filter @classepulse/api prisma:generate && pnpm test:int -- schema-presence`
Expected : PASS (3 tests). Si `migrate deploy` signale la présence de `BEGIN`/`COMMIT` (avertissement ou erreur de transaction imbriquée), **ne pas les retirer** : noter le message exact dans `docs/ops/T-01-prisma.md` ; la décision est prise à la tâche 10 (T1).

- [ ] **Step 8 : Commit**

```bash
git add apps/api .gitignore
git commit -m "feat(db): Prisma 7.10.0, migration de fondation et test de présence du schéma"
```

---

### Task 7 : Droits des rôles (moindre privilège)

**Files :**
- Test : `apps/api/test/integration/role-privileges.int.spec.ts`

**Interfaces :**
- Consumes : `createTestDatabase`, `connectAs` (tâche 5) ; migration de fondation (tâche 6).

- [ ] **Step 1 : Écrire les tests**

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });

async function expectDenied(role: 'cp_app' | 'cp_ops' | 'cp_monitor', sql: string, code = '42501'): Promise<void> {
  const c = await connectAs(role, db);
  try {
    await expect(c.query(sql)).rejects.toMatchObject({ code });
  } finally {
    await c.end();
  }
}

describe('droits de cp_app (§ 2.1, § 2.6)', () => {
  it('ne peut pas créer de table dans app', () => expectDenied('cp_app', 'create table app.x (id int)'));
  it('ne peut pas créer de table dans public', () => expectDenied('cp_app', 'create table public.x (id int)'));
  it('ne peut pas créer de table temporaire', () => expectDenied('cp_app', 'create temp table x (id int)'));
  it('ne peut pas prendre le rôle cp_privileged', () => expectDenied('cp_app', 'set role cp_privileged'));
  it('ne peut pas désactiver les triggers', () => expectDenied('cp_app', "set session_replication_role = 'replica'"));
  it('ne peut pas modifier sync_epoch', () => expectDenied('cp_app', 'update app.sync_epoch set epoch = gen_random_uuid()'));
  it('ne peut pas lire le schéma priv', () => expectDenied('cp_app', 'select 1 from priv.nothing', '42501'));
  it('peut lire sync_epoch', async () => {
    const c = await connectAs('cp_app', db);
    const r = await c.query('select epoch from app.sync_epoch where id = 1');
    await c.end();
    expect(r.rowCount).toBe(1);
  });
});
```

Note : `select 1 from priv.nothing` échoue avec `42501` (pas d'`USAGE` sur `priv`) avant même de chercher la table ; si PostgreSQL renvoie `42P01`, c'est que `cp_app` a l'usage de `priv` : c'est un défaut à corriger dans la migration, pas dans le test.

- [ ] **Step 2 : Lancer**

Run : `pnpm test:int -- role-privileges`
Expected : PASS (8 tests). Tout test en échec signale un droit en trop : corriger la migration ou le script d'initialisation, jamais affaiblir le test.

- [ ] **Step 3 : Commit**

```bash
git add apps/api/test/integration/role-privileges.int.spec.ts
git commit -m "test(db): droits minimaux de cp_app"
```

---

### Task 8 : Module `database` (client Prisma, transactions, nouvel essai)

**Files :**
- Create : `apps/api/src/database/tx.ts`, `apps/api/src/database/prisma.service.ts`, `apps/api/src/database/database.module.ts`
- Modify : `apps/api/src/main.ts` (sonde de disponibilité réelle)
- Test : `apps/api/src/database/tx.spec.ts`, `apps/api/test/integration/database.int.spec.ts`

**Interfaces :**
- Consumes : `APP_CONFIG`, `toPgPoolConfig` (tâches 2, 3) ; `ReadinessProbe` (tâche 3).
- Produces :
  - `isRetryableTxError(e: unknown): boolean` (vrai pour `40P01`, `40001`, et le code Prisma `P2034`)
  - `runWithRetry<T>(fn: () => Promise<T>, maxAttempts?: number): Promise<T>` (3 par défaut ; renvoie la **dernière erreur d'origine**)
  - `class PrismaService` : `client: PrismaClient` ; `withTx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>` (READ COMMITTED + nouvel essai) ; `ping(): Promise<boolean>`
  - `type TxClient` (client transactionnel Prisma)
  - `class DatabaseReadinessProbe extends ReadinessProbe`
  - `DatabaseModule` (global, exporte `PrismaService` et `DatabaseReadinessProbe`)

- [ ] **Step 1 : Écrire les tests unitaires du nouvel essai (ils échouent)**

`apps/api/src/database/tx.spec.ts` :

```ts
import { describe, expect, it, vi } from 'vitest';
import { isRetryableTxError, runWithRetry } from './tx.js';

const pgErr = (code: string) => Object.assign(new Error(code), { code });

describe('isRetryableTxError', () => {
  it.each([
    [pgErr('40P01'), true],
    [pgErr('40001'), true],
    [{ code: 'P2034' }, true],
    [{ cause: { originalCode: '40P01' } }, true],
    [{ meta: { code: '40001' } }, true],
    [pgErr('23505'), false],
    [new Error('boom'), false],
    [undefined, false],
  ])('%o → %s', (e, expected) => expect(isRetryableTxError(e)).toBe(expected));
});

describe('runWithRetry', () => {
  it('réessaie jusqu’au succès', async () => {
    const fn = vi.fn().mockRejectedValueOnce(pgErr('40P01')).mockResolvedValueOnce('ok');
    await expect(runWithRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it('abandonne après 3 essais et renvoie la dernière erreur d’origine', async () => {
    const last = pgErr('40001');
    const fn = vi.fn().mockRejectedValueOnce(pgErr('40P01')).mockRejectedValueOnce(pgErr('40P01')).mockRejectedValueOnce(last);
    await expect(runWithRetry(fn)).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it('ne réessaie pas une erreur non concernée', async () => {
    const e = pgErr('23505');
    const fn = vi.fn().mockRejectedValue(e);
    await expect(runWithRetry(fn)).rejects.toBe(e);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2 : Lancer**

Run : `pnpm vitest run apps/api/src/database/tx.spec.ts`
Expected : FAIL — module introuvable.

- [ ] **Step 3 : Implémenter**

`apps/api/src/database/tx.ts` :

```ts
const RETRYABLE_SQLSTATES = new Set(['40P01', '40001']);
const RETRYABLE_PRISMA_CODES = new Set(['P2034']);

function codeOf(v: unknown, key: string): string | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const value = (v as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function isRetryableTxError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = codeOf(e, 'code');
  if (code && (RETRYABLE_SQLSTATES.has(code) || RETRYABLE_PRISMA_CODES.has(code))) return true;
  const o = e as Record<string, unknown>;
  const nested = [codeOf(o.cause, 'originalCode'), codeOf(o.cause, 'code'), codeOf(o.meta, 'code')];
  return nested.some((c) => c !== undefined && RETRYABLE_SQLSTATES.has(c));
}

export async function runWithRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (!isRetryableTxError(e) || attempt === maxAttempts) throw e;
    }
  }
  throw lastError;
}
```

- [ ] **Step 4 : Relancer**

Run : `pnpm vitest run apps/api/src/database/tx.spec.ts`
Expected : PASS (11 tests).

- [ ] **Step 5 : Écrire le test d'intégration (il échoue)**

`apps/api/test/integration/database.int.spec.ts` :

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/database/prisma.service.js';
import { isRetryableTxError } from '../../src/database/tx.js';
import { createTestDatabase, dbConfigFor, runSql } from '../support/pg.js';

let db: string;
let a: PrismaService;
let b: PrismaService;

beforeAll(async () => {
  db = await createTestDatabase();
  // Table de test créée en superutilisateur : initialisation uniquement.
  await runSql(db, `create table app.dl (id int primary key, v int not null); insert into app.dl values (1,0),(2,0); grant select, update on app.dl to cp_app;`);
  a = new PrismaService(dbConfigFor('cp_app', db));
  b = new PrismaService(dbConfigFor('cp_app', db));
});
afterAll(async () => { await a.onModuleDestroy(); await b.onModuleDestroy(); });

describe('module database', () => {
  it('ping renvoie vrai sous cp_app', async () => {
    await expect(a.ping()).resolves.toBe(true);
  });

  it('les transactions sont en READ COMMITTED', async () => {
    const level = await a.withTx((tx) => tx.$queryRaw<{ l: string }[]>`select current_setting('transaction_isolation') as l`);
    expect(level[0]?.l).toBe('read committed');
  });

  it('un interblocage réel est reconnu comme rejouable', async () => {
    const barrier = Promise.withResolvers<void>();
    let seen: unknown;
    const t1 = a.client.$transaction(async (tx) => {
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 1`;
      await barrier.promise;
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 2`;
    }).catch((e) => { seen = e; });
    const t2 = b.client.$transaction(async (tx) => {
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 2`;
      barrier.resolve();
      await tx.$executeRaw`select pg_sleep(0.2)`;
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 1`;
    }).catch((e) => { seen = e; });
    await Promise.all([t1, t2]);
    expect(seen).toBeDefined();
    expect(isRetryableTxError(seen)).toBe(true);
  });

  it('withTx rejoue après un interblocage et aboutit', async () => {
    const barrier = Promise.withResolvers<void>();
    const r1 = a.withTx(async (tx) => {
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 1`;
      await barrier.promise;
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 2`;
      return 'a';
    });
    const r2 = b.withTx(async (tx) => {
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 2`;
      barrier.resolve();
      await tx.$executeRaw`select pg_sleep(0.2)`;
      await tx.$executeRaw`update app.dl set v = v + 1 where id = 1`;
      return 'b';
    });
    await expect(Promise.all([r1, r2])).resolves.toEqual(['a', 'b']);
  });
});
```

Si l'erreur observée au troisième test n'est pas reconnue, **afficher sa forme exacte** (`console.dir(seen, { depth: 5 })`), ajouter le chemin correspondant à `isRetryableTxError` avec un test unitaire de plus, puis relancer.

- [ ] **Step 6 : Implémenter le service**

`apps/api/src/database/prisma.service.ts` :

```ts
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG } from '../config/config.module.js';
import { toPgPoolConfig } from '../config/database-connection.js';
import type { AppConfig, DbConfig } from '../config/load-config.js';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { runWithRetry } from './tx.js';

export type TxClient = Prisma.TransactionClient;

@Injectable()
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(db: DbConfig) {
    this.client = new PrismaClient({ adapter: new PrismaPg(toPgPoolConfig(db)) });
  }

  withTx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return runWithRetry(() =>
      this.client.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10_000 }),
    );
  }

  async ping(): Promise<boolean> {
    const r = await this.client.$queryRaw<{ ok: number }[]>`select 1 as ok`;
    return r[0]?.ok === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}

export const prismaServiceProvider = {
  provide: PrismaService,
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) => new PrismaService(cfg.db),
};
```

`apps/api/src/database/database.module.ts` :

```ts
import { Global, Injectable, Module } from '@nestjs/common';
import { ReadinessProbe } from '../health/readiness.service.js';
import { PrismaService, prismaServiceProvider } from './prisma.service.js';

@Injectable()
export class DatabaseReadinessProbe extends ReadinessProbe {
  constructor(private readonly prisma: PrismaService) { super(); }
  check(): Promise<boolean> { return this.prisma.ping(); }
}

@Global()
@Module({ providers: [prismaServiceProvider, DatabaseReadinessProbe], exports: [PrismaService, DatabaseReadinessProbe] })
export class DatabaseModule {}
```

Dans `apps/api/src/main.ts`, supprimer la classe `AlwaysReady` et remplacer la création de l'application par :

```ts
import { DatabaseModule, DatabaseReadinessProbe } from './database/database.module.js';
// …
const app = await NestFactory.create<NestFastifyApplication>(
  ApiModule.forRoot(config, DatabaseReadinessProbe, [DatabaseModule]),
  new FastifyAdapter(),
);
```

- [ ] **Step 7 : Lancer**

Run : `pnpm vitest run apps/api/src && pnpm test:int -- database`
Expected : PASS (unitaires + 4 tests d'intégration).

- [ ] **Step 8 : Vérifier le démarrage réel**

```bash
docker compose -f docker-compose.dev.yml exec -T -u postgres postgres psql -c "ALTER ROLE cp_owner PASSWORD 'dev-owner'" -c "ALTER ROLE cp_app PASSWORD 'dev-app'"
printf 'dev-owner' > .secrets/dev/cp_owner && printf 'dev-app' > .secrets/dev/cp_app
cd apps/api
NODE_ENV=development HTTP_PORT=3000 READY_PORT=3001 DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=classepulse DB_USER=cp_owner DB_AUTH_MODE=password DB_PASSWORD_FILE=../../.secrets/dev/cp_owner pnpm exec prisma migrate deploy
NODE_ENV=development HTTP_PORT=3000 READY_PORT=3001 DB_HOST=127.0.0.1 DB_PORT=5432 DB_NAME=classepulse DB_USER=cp_app DB_AUTH_MODE=password DB_PASSWORD_FILE=../../.secrets/dev/cp_app pnpm exec tsx src/main.ts &
curl -s localhost:3000/api/health          # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/health/ready   # 404
curl -s localhost:3001/api/health/ready    # {"ready":true}
kill %1; cd ../..
```

(Les mots de passe ci-dessus sont des valeurs de **développement local** uniquement ; ajouter `tsx` en dépendance de développement de l'API si absent : `pnpm --filter @classepulse/api add -D -E tsx`.)

- [ ] **Step 9 : Commit**

```bash
git add apps/api
git commit -m "feat(api): module database (Prisma + adaptateur pg, READ COMMITTED, nouvel essai sur interblocage)"
```

---

### Task 9 : Règles d'architecture (dependency-cruiser)

**Files :**
- Create : `.dependency-cruiser.cjs`, `apps/api/test/architecture/fixtures/src/modules/alpha/alpha.service.ts`, `apps/api/test/architecture/fixtures/src/modules/alpha/alpha.repository.ts`, `apps/api/test/architecture/fixtures/src/modules/beta/beta.service.ts`, `apps/api/test/architecture/fixtures/src/generated/prisma/client.ts`
- Test : `apps/api/test/architecture/depcruise.spec.ts`

**Interfaces :**
- Produces : règles `no-prisma-outside-repositories` et `no-foreign-repository` ; script racine `pnpm depcruise`.

- [ ] **Step 1 : Écrire les fixtures**

`fixtures/src/generated/prisma/client.ts` : `export class PrismaClient {}`

`fixtures/src/modules/alpha/alpha.repository.ts` (autorisé) :

```ts
import { PrismaClient } from '../../generated/prisma/client.js';
export const alphaRepo = new PrismaClient();
```

`fixtures/src/modules/alpha/alpha.service.ts` (**interdit** : importe Prisma hors repository) :

```ts
import { PrismaClient } from '../../generated/prisma/client.js';
export const bad = new PrismaClient();
```

`fixtures/src/modules/beta/beta.service.ts` (**interdit** : importe le repository d'un autre module) :

```ts
import { alphaRepo } from '../alpha/alpha.repository.js';
export const leak = alphaRepo;
```

- [ ] **Step 2 : Écrire le test (il échoue)**

`apps/api/test/architecture/depcruise.spec.ts` :

```ts
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../../..');

function cruise(target: string): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile('pnpm', ['exec', 'depcruise', target, '--config', '.dependency-cruiser.cjs', '--output-type', 'err'], { cwd: root }, (err, stdout, stderr) =>
      done({ code: err ? 1 : 0, out: stdout + stderr }));
  });
}

describe('règles d’architecture', () => {
  it('détecte Prisma importé hors d’un repository et un repository étranger', async () => {
    const r = await cruise('apps/api/test/architecture/fixtures/src');
    expect(r.code).toBe(1);
    expect(r.out).toContain('no-prisma-outside-repositories');
    expect(r.out).toContain('alpha.service.ts');
    expect(r.out).toContain('no-foreign-repository');
    expect(r.out).toContain('beta.service.ts');
    expect(r.out).not.toMatch(/no-prisma-outside-repositories[^\n]*alpha\.repository\.ts/);
  });

  it('le code réel de l’API respecte les règles', async () => {
    const r = await cruise('apps/api/src');
    expect(r.code, r.out).toBe(0);
  });
});
```

- [ ] **Step 3 : Lancer**

Run : `pnpm vitest run apps/api/test/architecture`
Expected : FAIL — fichier de configuration absent.

- [ ] **Step 4 : Écrire la configuration**

`.dependency-cruiser.cjs` :

```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-prisma-outside-repositories',
      comment: 'Seuls les *.repository.ts (et le module database) importent Prisma (§ 1.2, règle 5).',
      severity: 'error',
      from: { pathNot: ['\\.repository\\.ts$', '/src/database/', '/src/generated/'] },
      to: { path: ['/src/generated/prisma/', '^node_modules/@prisma/', '^node_modules/\\.pnpm/@prisma'] },
    },
    {
      name: 'no-foreign-repository',
      comment: "Un module n'importe jamais le repository d'un autre module.",
      severity: 'error',
      from: { path: '/src/modules/([^/]+)/' },
      to: { path: '/src/modules/([^/]+)/[^/]+\\.repository\\.ts$', pathNot: '/src/modules/$1/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'apps/api/tsconfig.json' },
  },
};
```

- [ ] **Step 5 : Relancer**

Run : `pnpm vitest run apps/api/test/architecture`
Expected : PASS (2 tests).

- [ ] **Step 6 : Commit**

```bash
git add .dependency-cruiser.cjs apps/api/test/architecture
git commit -m "chore(api): règles d'architecture (Prisma limité aux repositories)"
```

---

### Task 10 : T-01 — comportement réel de Prisma 7.10.0 (et partie C)

**Files :**
- Create : `apps/api/src/database/catalog-checks.ts`, `apps/api/test/support/certs.ts`, `docs/ops/T-01-prisma.md`
- Test : `apps/api/test/integration/prisma-t01.int.spec.ts`, `apps/api/test/integration/prisma-cert.int.spec.ts`

**Interfaces :**
- Consumes : `runPrisma` (tâche 6), harnais (tâche 5).
- Produces :
  - `findInvalidIndexes(client: pg.Client, schema: string): Promise<string[]>` (index avec `indisvalid = false`)
  - `makeScratchPrismaProject(migrations: Record<string, string>): string` (renvoie le chemin d'un `prisma.config.ts` temporaire)
  - `makeTestPki(): { dir: string; caCrt: string; serverCrt: string; serverKey: string; clientFor(cn: string, password?: string): { crt: string; key: string; p12: string } }`

- [ ] **Step 1 : Écrire le contrôle de catalogue et son test**

`apps/api/src/database/catalog-checks.ts` :

```ts
import type pg from 'pg';

export async function findInvalidIndexes(client: pg.Client, schema: string): Promise<string[]> {
  const r = await client.query<{ name: string }>(
    `select c.relname as name
       from pg_index i
       join pg_class c on c.oid = i.indexrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and not i.indisvalid
      order by 1`,
    [schema],
  );
  return r.rows.map((row) => row.name);
}
```

- [ ] **Step 2 : Utilitaire de projet Prisma temporaire**

Ajouter à `apps/api/test/support/prisma-cli.ts` :

```ts
import { mkdirSync } from 'node:fs';

export function makeScratchPrismaProject(migrations: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-scratch-'));
  mkdirSync(join(dir, 'migrations'));
  writeFileSync(join(dir, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
  for (const [name, sql] of Object.entries(migrations)) {
    mkdirSync(join(dir, 'migrations', name));
    writeFileSync(join(dir, 'migrations', name, 'migration.sql'), sql);
  }
  writeFileSync(join(dir, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  schemas = ["app"]\n}\n');
  const cfg = join(dir, 'prisma.config.ts');
  writeFileSync(
    cfg,
    `import { defineConfig } from 'prisma/config';
import { loadConfig } from '${API_DIR.replaceAll('\\', '/')}/src/config/load-config.ts';
import { toPrismaCliUrl } from '${API_DIR.replaceAll('\\', '/')}/src/config/database-connection.ts';
export default defineConfig({
  schema: '${dir.replaceAll('\\', '/')}/schema.prisma',
  migrations: { path: '${dir.replaceAll('\\', '/')}/migrations' },
  datasource: { url: toPrismaCliUrl(loadConfig(process.env).db) },
});
`,
  );
  return cfg;
}

export function writeMigration(cfgPath: string, name: string, sql: string): void {
  const dir = join(cfgPath, '..', 'migrations', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'migration.sql'), sql);
}
```

- [ ] **Step 3 : Écrire les tests T1 à T4 (ils échouent tant que l'utilitaire n'est pas branché)**

`apps/api/test/integration/prisma-t01.int.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { findInvalidIndexes } from '../../src/database/catalog-checks.js';
import { connectAs, createTestDatabase, dbConfigFor, runSql } from '../support/pg.js';
import { makeScratchPrismaProject, runPrisma, writeMigration } from '../support/prisma-cli.js';

async function tableExists(db: string, name: string): Promise<boolean> {
  const c = await connectAs('cp_owner', db);
  const r = await c.query(`select to_regclass($1) is not null as e`, [`app.${name}`]);
  await c.end();
  return r.rows[0].e;
}

describe('T-01 — Prisma 7.10.0', () => {
  it('T1a : migration avec BEGIN/COMMIT explicites en échec → aucune table créée', async () => {
    const db = await createTestDatabase();
    const cfg = makeScratchPrismaProject({
      '20990101000000_t1a': `-- classification: expand\nBEGIN;\nCREATE TABLE app.t1a (id int);\nSELECT 1/0;\nCOMMIT;\n`,
    });
    const r = await runPrisma(['migrate', 'deploy'], dbConfigFor('cp_owner', db), { configPath: cfg });
    expect(r.code).not.toBe(0);
    expect(await tableExists(db, 't1a')).toBe(false);
  });

  it('T1b : même migration sans BEGIN/COMMIT → comportement constaté (caractérisation)', async () => {
    const db = await createTestDatabase();
    const cfg = makeScratchPrismaProject({
      '20990101000000_t1b': `-- classification: expand\nCREATE TABLE app.t1b (id int);\nSELECT 1/0;\n`,
    });
    const r = await runPrisma(['migrate', 'deploy'], dbConfigFor('cp_owner', db), { configPath: cfg });
    expect({ failed: r.code !== 0, tableLeftBehind: await tableExists(db, 't1b') }).toMatchSnapshot();
  });

  it('T2 : deux deploy simultanés → une seule application, verrou observé', async () => {
    const db = await createTestDatabase();
    const cfg = makeScratchPrismaProject({
      '20990101000000_t2': `-- classification: expand\nBEGIN;\nSELECT pg_sleep(4);\nCREATE TABLE app.t2 (id int);\nCOMMIT;\n`,
    });
    const owner = dbConfigFor('cp_owner', db);
    const p1 = runPrisma(['migrate', 'deploy'], owner, { configPath: cfg });
    const p2 = runPrisma(['migrate', 'deploy'], owner, { configPath: cfg });
    const mon = await connectAs('postgres', db);
    let advisoryWaitSeen = false;
    for (let i = 0; i < 30 && !advisoryWaitSeen; i++) {
      const w = await mon.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
      advisoryWaitSeen = w.rows[0].n > 0;
      await new Promise((res) => setTimeout(res, 200));
    }
    await mon.end();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.code, r2.code]).toEqual([0, 0]);
    expect(advisoryWaitSeen).toBe(true);
    const c = await connectAs('cp_owner', db);
    const n = await c.query(`select count(*)::int as n from app._prisma_migrations where migration_name = '20990101000000_t2'`);
    await c.end();
    expect(n.rows[0].n).toBe(1);
  });

  it('T3 : resolve --rolled-back après un échec, correction, puis deploy réussi', async () => {
    const db = await createTestDatabase();
    const owner = dbConfigFor('cp_owner', db);
    const name = '20990101000000_t3';
    const cfg = makeScratchPrismaProject({ [name]: `-- classification: expand\nBEGIN;\nCREATE TABLE app.t3 (id int);\nSELECT 1/0;\nCOMMIT;\n` });
    expect((await runPrisma(['migrate', 'deploy'], owner, { configPath: cfg })).code).not.toBe(0);
    expect((await runPrisma(['migrate', 'resolve', '--rolled-back', name], owner, { configPath: cfg })).code).toBe(0);
    writeMigration(cfg, name, `-- classification: expand\nBEGIN;\nCREATE TABLE app.t3 (id int);\nCOMMIT;\n`);
    expect((await runPrisma(['migrate', 'deploy'], owner, { configPath: cfg })).code).toBe(0);
    expect(await tableExists(db, 't3')).toBe(true);
  });

  it('T4 : index CONCURRENTLY interrompu → index invalide détecté par le contrôle de catalogue', async () => {
    const db = await createTestDatabase();
    await runSql(db, `create table app.big (id bigint, v text); insert into app.big select g, md5(g::text) from generate_series(1, 3000000) g; alter table app.big owner to cp_owner;`);
    const cfg = makeScratchPrismaProject({
      '20990101000000_t4': `-- classification: expand\nCREATE INDEX CONCURRENTLY big_v_idx ON app.big (v);\n`,
    });
    const deploy = runPrisma(['migrate', 'deploy'], dbConfigFor('cp_owner', db), { configPath: cfg });
    const su = await connectAs('postgres', db);
    let killed = false;
    for (let i = 0; i < 100 && !killed; i++) {
      const r = await su.query(`select pg_terminate_backend(pid) as k from pg_stat_activity where query ilike 'CREATE INDEX CONCURRENTLY%' and datname = current_database()`);
      killed = r.rows.some((row) => row.k);
      await new Promise((res) => setTimeout(res, 100));
    }
    await su.end();
    expect(killed).toBe(true);
    expect((await deploy).code).not.toBe(0);
    const c = await connectAs('cp_owner', db);
    expect(await findInvalidIndexes(c, 'app')).toEqual(['big_v_idx']);
    await c.end();
  });
});
```

- [ ] **Step 4 : Lancer**

Run : `pnpm test:int -- prisma-t01`
Expected : PASS pour T1a, T2, T3, T4 ; T1b écrit son instantané au premier passage, puis le relecteur vérifie son contenu avant le commit.

Si T4 échoue avec `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`, c'est que Prisma enveloppe la migration dans une transaction : **c'est un résultat de T-01**, pas un défaut du test. Le consigner et soumettre au responsable la procédure des migrations non transactionnelles (§ 7.8) avant le lot 1.

- [ ] **Step 5 : Consigner les résultats et la décision BEGIN/COMMIT**

`docs/ops/T-01-prisma.md` : un tableau avec, pour T1a, T1b (contenu de l'instantané), T2, T3 et T4, le résultat constaté, la date, la version de Prisma (`pnpm exec prisma --version`) et l'empreinte de l'image PostgreSQL. Conclure par l'une des deux phrases, selon les résultats :
- « La règle `BEGIN`/`COMMIT` explicite est **confirmée** » (si T1a a réussi et que `migrate deploy` accepte la migration de fondation) ;
- « La règle `BEGIN`/`COMMIT` explicite est **à revoir** : <message constaté> » — dans ce cas, **arrêter le lot** et soumettre la décision au responsable avant de continuer.

Si T2 échoue parce qu'aucun verrou consultatif n'est observé, consigner « verrou de Prisma non démontré : le verrou `flock` de l'hôte (§ 7.2.7) reste obligatoire » ; le test reste en échec jusqu'à la décision du responsable.

- [ ] **Step 6 : PKI de test pour la partie C**

`apps/api/test/support/certs.ts` (certificats de **test uniquement**, générés à chaque exécution) :

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import forge from 'node-forge';

type Pair = { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey };

function issue(cn: string, issuer: Pair | undefined, isCa: boolean, altNames: string[] = []): Pair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(8));
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: 'commonName', value: cn }];
  cert.setSubject(subject);
  cert.setIssuer(issuer ? issuer.cert.subject.attributes : subject);
  const ext: object[] = [{ name: 'basicConstraints', cA: isCa }];
  if (altNames.length) ext.push({ name: 'subjectAltName', altNames: altNames.map((v) => ({ type: 2, value: v })) });
  cert.setExtensions(ext);
  cert.sign(issuer ? issuer.key : keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

export function makeTestPki(serverHost: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-pki-'));
  const write = (name: string, data: string | Buffer) => { const p = join(dir, name); writeFileSync(p, data); return p; };
  const ca = issue('cp-test-ca', undefined, true);
  const server = issue(serverHost, ca, false, [serverHost, 'localhost']);
  return {
    dir,
    caCrt: write('ca.crt', forge.pki.certificateToPem(ca.cert)),
    serverCrt: write('server.crt', forge.pki.certificateToPem(server.cert)),
    serverKey: write('server.key', forge.pki.privateKeyToPem(server.key)),
    clientFor(cn: string, password = 'p12-test') {
      const c = issue(cn, ca, false);
      const p12 = forge.pkcs12.toPkcs12Asn1(c.key, [c.cert, ca.cert], password, { algorithm: '3des' });
      return {
        crt: write(`${cn}.crt`, forge.pki.certificateToPem(c.cert)),
        key: write(`${cn}.key`, forge.pki.privateKeyToPem(c.key)),
        p12: write(`${cn}.p12`, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary')),
        password,
      };
    },
    foreignCa() { return write('foreign-ca.crt', forge.pki.certificateToPem(issue('other-ca', undefined, true).cert)); },
  };
}
```

- [ ] **Step 7 : Écrire le test de la partie C**

`apps/api/test/integration/prisma-cert.int.spec.ts` (démarre **son propre** conteneur PostgreSQL avec TLS et `pg_hba` en `cert`) :

```ts
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestPki } from '../support/certs.js';
import { PG_IMAGE } from '../support/images.js';
import { makeScratchPrismaProject, runPrisma } from '../support/prisma-cli.js';

let c: StartedPostgreSqlContainer;
let pki: ReturnType<typeof makeTestPki>;

beforeAll(async () => {
  pki = makeTestPki('localhost');
  const hba = join(pki.dir, 'pg_hba.conf');
  writeFileSync(hba, [
    'local all postgres peer',
    'local all all reject',
    'hostssl classepulse cp_owner 0.0.0.0/0 cert map=cp',
    'host all postgres 0.0.0.0/0 scram-sha-256',
    'host all all 0.0.0.0/0 reject',
  ].join('\n') + '\n');
  const ident = join(pki.dir, 'pg_ident.conf');
  writeFileSync(ident, 'cp cp_owner cp_owner\n');
  c = await new PostgreSqlContainer(PG_IMAGE)
    .withUsername('postgres').withPassword('super-test').withDatabase('postgres')
    .withCopyFilesToContainer([
      { source: pki.caCrt, target: '/etc/pgssl/ca.crt', mode: 0o644 },
      { source: pki.serverCrt, target: '/etc/pgssl/server.crt', mode: 0o644 },
      { source: pki.serverKey, target: '/etc/pgssl/server.key', mode: 0o600 },
      { source: hba, target: '/etc/pgssl/pg_hba.conf', mode: 0o644 },
      { source: ident, target: '/etc/pgssl/pg_ident.conf', mode: 0o644 },
    ])
    .withCopyDirectoriesToContainer([{ source: resolve(import.meta.dirname, '../../../../db'), target: '/bootstrap' }])
    .withCommand(['sh', '-c', 'chown postgres /etc/pgssl/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/etc/pgssl/server.crt -c ssl_key_file=/etc/pgssl/server.key -c ssl_ca_file=/etc/pgssl/ca.crt -c hba_file=/etc/pgssl/pg_hba.conf -c ident_file=/etc/pgssl/pg_ident.conf'])
    .start();
  for (const args of [
    ['-d', 'postgres', '-f', '/bootstrap/db-bootstrap-cluster.sql'],
    ['-d', 'postgres', '-v', 'dbname=classepulse', '-f', '/bootstrap/db-bootstrap-database.sql'],
  ]) {
    const r = await c.exec(['psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', ...args], { user: 'postgres' });
    if (r.exitCode !== 0) throw new Error(r.output);
  }
});
afterAll(async () => { await c?.stop(); });

function ownerDb(caFile: string) {
  const id = pki.clientFor('cp_owner');
  return { host: c.getHost(), port: c.getPort(), database: 'classepulse', user: 'cp_owner',
    auth: { mode: 'cert' as const, caFile, certFile: id.crt, keyFile: id.key, p12File: id.p12, p12Password: id.password } };
}

describe('T-01 partie C — certificat client avec Prisma 7.10.0', () => {
  it('cp_owner n’a aucun mot de passe', async () => {
    const r = await c.exec(['psql', '-U', 'postgres', '-tAc', "select rolpassword is null from pg_authid where rolname = 'cp_owner'"], { user: 'postgres' });
    expect(r.output.trim()).toBe('t');
  });

  it('migrate deploy réussit avec sslidentity + sslaccept=strict', async () => {
    const cfg = makeScratchPrismaProject({ '20990101000000_c': '-- classification: expand\nBEGIN;\nCREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE app.c_ok (id int);\nCOMMIT;\n' });
    const r = await runPrisma(['migrate', 'deploy'], ownerDb(pki.caCrt), { configPath: cfg });
    expect(r.stderr + r.stdout).not.toMatch(/sslaccept|sslpassword/i);
    expect(r.code).toBe(0);
  });

  it('migrate deploy échoue si le serveur n’est pas signé par l’autorité attendue', async () => {
    const cfg = makeScratchPrismaProject({ '20990101000001_c2': '-- classification: expand\nBEGIN;\nCREATE TABLE app.c_ko (id int);\nCOMMIT;\n' });
    const r = await runPrisma(['migrate', 'deploy'], ownerDb(pki.foreignCa()), { configPath: cfg });
    expect(r.code).not.toBe(0);
  });
});
```

- [ ] **Step 8 : Lancer et consigner**

Run : `pnpm test:int -- prisma-cert`
Expected : PASS (3 tests).

Ajouter le résultat à `docs/ops/T-01-prisma.md`, section « Partie C ». **Si l'un des deux derniers tests échoue**, écrire « Partie C : compatibilité non démontrée » avec la sortie exacte de Prisma, marquer le test `it.fails` **seulement après accord du responsable**, et **soumettre la décision sur l'authentification de `cp_owner`** avant le lot 1 (feuille de route). Ne pas chercher d'alternative dans ce lot.

- [ ] **Step 9 : Commit**

```bash
git add apps/api docs/ops/T-01-prisma.md
git commit -m "test(db): T-01 — transactionnalité, verrou, resolve, index interrompu, certificat client (Prisma 7.10.0)"
```

---

### Task 11 : T-05 — secrets absents des traces PostgreSQL

**Files :**
- Create : `apps/api/test/support/pg-logs.ts`, `docs/ops/T-05-journaux.md`
- Test : `apps/api/test/integration/t05-logs.int.spec.ts`

**Interfaces :**
- Consumes : harnais (tâche 5).
- Produces : `readPgLogsSince(marker: string): Promise<string>` (journaux du conteneur partagé après un marqueur) ; `setServerLogging(settings: Record<string, string>): Promise<void>` (`ALTER SYSTEM` + rechargement, superutilisateur).

Ce lot ne contient encore aucune fonction qui reçoit un secret. Les tests portent donc sur une **requête sonde paramétrée**, qui reproduit le chemin réel (paramètres liés, texte constant). Les mêmes tests seront rejoués par T-04 (lot 7) sur les fonctions du secours.

- [ ] **Step 1 : Utilitaires de journaux**

`apps/api/test/support/pg-logs.ts` :

```ts
import { getContainerRuntimeClient } from 'testcontainers';
import { inject } from 'vitest';
import { runSql } from './pg.js';

// ALTER SYSTEM ne peut pas s'exécuter dans un bloc de transaction : une instruction par appel.
export async function setServerLogging(settings: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(settings)) await runSql('postgres', `ALTER SYSTEM SET ${k} = '${v}'`);
  await runSql('postgres', 'SELECT pg_reload_conf()');
  await new Promise((r) => setTimeout(r, 500));
}

export async function resetServerLogging(): Promise<void> {
  await runSql('postgres', 'ALTER SYSTEM RESET ALL');
  await runSql('postgres', 'SELECT pg_reload_conf()');
  await new Promise((r) => setTimeout(r, 500));
}

export async function readPgLogsSince(marker: string): Promise<string> {
  const client = await getContainerRuntimeClient();
  const container = client.container.getById(inject('pg').containerId);
  const stream = await client.container.logs(container, { since: 0 });
  const chunks: Buffer[] = [];
  await new Promise<void>((res) => {
    stream.on('data', (d: Buffer) => chunks.push(Buffer.from(d)));
    stream.on('end', () => res());
    setTimeout(res, 1500);
  });
  const all = Buffer.concat(chunks).toString('utf8');
  const i = all.lastIndexOf(marker);
  return i >= 0 ? all.slice(i) : '';
}
```

Si l'API de lecture des journaux diffère dans la version installée de `testcontainers`, utiliser `StartedTestContainer.logs()` en conservant le conteneur dans une variable du module de `global-setup.ts` et en l'exposant par une fonction, avec le même contrat (`readPgLogsSince`).

- [ ] **Step 2 : Écrire les tests**

`apps/api/test/integration/t05-logs.int.spec.ts` :

```ts
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readPgLogsSince, resetServerLogging, setServerLogging } from '../support/pg-logs.js';
import { connectAs, createTestDatabase } from '../support/pg.js';

let db: string;
beforeAll(async () => { db = await createTestDatabase(); });
afterEach(async () => { await resetServerLogging(); });

const secret = () => `S3CRET_${randomBytes(12).toString('hex')}`;
const marker = async (c: Awaited<ReturnType<typeof connectAs>>) => {
  const m = `MARK_${randomBytes(6).toString('hex')}`;
  await c.query(`select '${m}'`);
  return m;
};

describe('T-05 — secrets et traces PostgreSQL', () => {
  it('(b) journalisation forcée : le secret n’est jamais dans le texte des instructions ni dans les vues', async () => {
    await setServerLogging({ log_statement: 'all', log_min_duration_statement: '0', log_parameter_max_length: '-1', log_parameter_max_length_on_error: '-1' });
    const s = secret();
    const app = await connectAs('cp_app', db);
    const watcher = await connectAs('postgres', db); // observation seulement : voit toutes les requêtes
    const m = await marker(app);
    const running = app.query('select pg_sleep(1.5), length($1::text) as n', [s]);
    await new Promise((r) => setTimeout(r, 500));
    const act = await watcher.query(`select query from pg_stat_activity where datname = current_database() and state = 'active'`);
    await running;
    await app.query('select 1/0 where length($1::text) > 0', [s]).catch(() => undefined);
    const stmts = await watcher.query(`select query from public.pg_stat_statements`);
    await app.end(); await watcher.end();
    const logs = await readPgLogsSince(m);
    const statementLines = logs.split('\n').filter((l) => /(statement|execute|STATEMENT):/.test(l));
    expect(statementLines.join('\n')).not.toContain(s);
    expect(act.rows.map((r) => r.query).join('\n')).not.toContain(s);
    expect(stmts.rows.map((r) => r.query).join('\n')).not.toContain(s);
    // Dans ce mode, le secret apparaît attendu dans les lignes « parameters: » : preuve des paramètres liés.
    expect(logs).toMatch(/parameters:.*S3CRET_/);
  });

  it('(c) configuration de production + journalisation forcée : aucun secret dans les journaux', async () => {
    await setServerLogging({ log_statement: 'all', log_min_duration_statement: '0', log_parameter_max_length: '0', log_parameter_max_length_on_error: '0' });
    const s = secret();
    const app = await connectAs('cp_app', db);
    const m = await marker(app);
    await app.query('select length($1::text) as n', [s]);
    await app.query('select 1/0 where length($1::text) > 0', [s]).catch(() => undefined);
    await app.end();
    expect(await readPgLogsSince(m)).not.toContain(s);
  });

  it('(c, caractérisation) une erreur de conversion recopie la valeur dans le MESSAGE, quels que soient les réglages', async () => {
    await setServerLogging({ log_statement: 'all', log_parameter_max_length: '0', log_parameter_max_length_on_error: '0' });
    const s = secret();
    const app = await connectAs('cp_app', db);
    const m = await marker(app);
    const err = await app.query('select $1::int', [s]).catch((e: Error) => e);
    await app.end();
    expect(String((err as Error).message)).toContain(s);
    expect(await readPgLogsSince(m)).toContain(s);
    // Conséquence (contrainte de conception) : une fonction qui reçoit un secret le prend en text/bytea,
    // sans conversion côté serveur ; le format est validé côté client avant l'appel.
  });

  it('(d) cp_app, cp_ops et cp_monitor ne peuvent pas modifier les réglages de longueur', async () => {
    for (const role of ['cp_app', 'cp_ops', 'cp_monitor'] as const) {
      const c = await connectAs(role, db);
      await expect(c.query(`set log_parameter_max_length = -1`)).rejects.toMatchObject({ code: '42501' });
      await expect(c.query(`set log_parameter_max_length_on_error = -1`)).rejects.toMatchObject({ code: '42501' });
      await c.end();
    }
  });
});
```

- [ ] **Step 3 : Lancer**

Run : `pnpm test:int -- t05-logs`
Expected : PASS (4 tests). Le troisième test **doit** passer : il démontre un risque réel (le secret est recopié par le message d'erreur).

- [ ] **Step 4 : Consigner**

`docs/ops/T-05-journaux.md` : résultats (a) à (d) du § 9 de la spécification (le point (a) — `rolpassword` NULL — est couvert par la tâche 10, test « cp_owner n'a aucun mot de passe »), date, versions, et la **contrainte de conception** issue du troisième test : « Toute fonction recevant un secret le prend en `text` ou `bytea`, sans conversion côté serveur ; le format est vérifié côté client avant l'appel. » Cette contrainte est reprise dans le plan du lot 7 (secours à deux parts) et du lot 1 (codes, jetons).

- [ ] **Step 5 : Commit**

```bash
git add apps/api/test docs/ops/T-05-journaux.md
git commit -m "test(db): T-05 — secrets absents des journaux et des vues PostgreSQL"
```

---

### Task 12 : Squelette web, identité visuelle B et thèmes

**Files :**
- Create : `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/theme/tokens.ts`, `apps/web/src/theme/contrast.ts`, `apps/web/src/theme/theme.ts`, `apps/web/scripts/gen-tokens.ts`, `apps/web/src/theme/tokens.css` (généré)
- Test : `apps/web/src/theme/contrast.spec.ts`, `apps/web/src/theme/tokens.spec.ts`, `apps/web/src/theme/theme.spec.tsx`

**Interfaces :**
- Produces :
  - `tokens: { light: ThemeTokens; dark: ThemeTokens }` avec les clés `bg, side, surface, ink, muted, line, line2, navon, brand, onbrand, brandtx, red, amb, grn`
  - `contrastRatio(fg: string, bg: string): number`
  - `renderTokensCss(t: typeof tokens): string`
  - `type ThemePreference = 'system'|'light'|'dark'` ; `applyTheme(pref: ThemePreference, prefersDark: boolean): void` ; `loadPreference(): ThemePreference` ; `savePreference(p: ThemePreference): void`

- [ ] **Step 1 : Créer l'application**

```bash
mkdir -p apps/web/src/theme apps/web/scripts
cd apps/web
pnpm init
pnpm add -E react react-dom @fontsource/figtree
pnpm add -E -D vite @vitejs/plugin-react @types/react @types/react-dom jsdom @testing-library/react @testing-library/jest-dom tsx
cd ../..
```

`apps/web/package.json` : `"name": "@classepulse/web"`, `"type": "module"`, `"private": true`, scripts `"dev": "vite"`, `"build": "vite build"`, `"typecheck": "tsc -p tsconfig.json --noEmit"`, `"gen:tokens": "tsx scripts/gen-tokens.ts"`.

`apps/web/tsconfig.json` :

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "jsx": "react-jsx", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2023", "DOM"], "types": ["vite/client"] }, "include": ["src", "scripts"] }
```

`apps/web/vite.config.ts` :

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: { name: 'web', environment: 'jsdom', include: ['src/**/*.spec.{ts,tsx}'] },
});
```

- [ ] **Step 2 : Écrire les tests du contraste et des couleurs (ils échouent)**

`apps/web/src/theme/contrast.spec.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';

describe('contrastRatio', () => {
  it('noir sur blanc = 21', () => expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1));
  it('blanc sur blanc = 1', () => expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5));
  it('est symétrique', () => expect(contrastRatio('#C2461F', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#C2461F'), 5));
});
```

`apps/web/src/theme/tokens.spec.ts` :

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { renderTokensCss, tokens } from './tokens';

describe('couleurs de la direction B (UX § 4.1)', () => {
  it('reprennent exactement les valeurs validées (thème clair)', () => {
    expect(tokens.light).toMatchObject({ bg: '#FFF9F4', surface: '#FFFFFF', ink: '#2A211C', brand: '#C2461F', onbrand: '#FFFFFF', red: '#B42318', amb: '#A15C07', grn: '#1E7A46' });
  });
  it('reprennent exactement les valeurs validées (thème sombre)', () => {
    expect(tokens.dark).toMatchObject({ bg: '#1A1411', surface: '#241C18', ink: '#F6EDE6', brand: '#E8703F', onbrand: '#1A1411', brandtx: '#F08A5D', red: '#FF8A7A', amb: '#F2C063', grn: '#72D49B' });
  });
  it.each(['light', 'dark'] as const)('contraste AA du texte dans le thème %s', (mode) => {
    const t = tokens[mode];
    for (const [fg, bg] of [[t.ink, t.bg], [t.ink, t.surface], [t.onbrand, t.brand], [t.brandtx, t.surface], [t.red, t.surface], [t.amb, t.surface], [t.grn, t.surface]] as const) {
      expect(contrastRatio(fg, bg), `${fg} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('tokens.css est à jour (pnpm --filter @classepulse/web gen:tokens)', () => {
    const onDisk = readFileSync(resolve(import.meta.dirname, 'tokens.css'), 'utf8');
    expect(onDisk).toBe(renderTokensCss(tokens));
  });
});
```

- [ ] **Step 3 : Lancer**

Run : `pnpm vitest run --project web`
Expected : FAIL — modules introuvables.

- [ ] **Step 4 : Implémenter**

`apps/web/src/theme/contrast.ts` :

```ts
function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
```

`apps/web/src/theme/tokens.ts` :

```ts
export type ThemeTokens = {
  bg: string; side: string; surface: string; ink: string; muted: string; line: string; line2: string;
  navon: string; brand: string; onbrand: string; brandtx: string; red: string; amb: string; grn: string;
};

export const tokens: { light: ThemeTokens; dark: ThemeTokens } = {
  light: { bg: '#FFF9F4', side: '#FFFFFF', surface: '#FFFFFF', ink: '#2A211C', muted: '#8C7E73', line: '#F0E3D8', line2: '#DFCBBB', navon: '#FCEBE1', brand: '#C2461F', onbrand: '#FFFFFF', brandtx: '#C2461F', red: '#B42318', amb: '#A15C07', grn: '#1E7A46' },
  dark: { bg: '#1A1411', side: '#1F1814', surface: '#241C18', ink: '#F6EDE6', muted: '#B3A398', line: '#382B24', line2: '#54443A', navon: '#33241D', brand: '#E8703F', onbrand: '#1A1411', brandtx: '#F08A5D', red: '#FF8A7A', amb: '#F2C063', grn: '#72D49B' },
};

const vars = (t: ThemeTokens) => Object.entries(t).map(([k, v]) => `  --cp-${k}: ${v};`).join('\n');

export function renderTokensCss(t: typeof tokens): string {
  return [
    '/* Généré par scripts/gen-tokens.ts — ne pas modifier à la main. */',
    `:root {\n${vars(t.light)}\n  color-scheme: light;\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${vars(t.dark).replaceAll('\n', '\n  ')}\n    color-scheme: dark;\n  }\n}`,
    `:root[data-theme="dark"] {\n${vars(t.dark)}\n  color-scheme: dark;\n}`,
    'body { margin: 0; background: var(--cp-bg); color: var(--cp-ink); font-family: Figtree, system-ui, sans-serif; font-size: 16px; }',
    '',
  ].join('\n\n');
}
```

`apps/web/scripts/gen-tokens.ts` :

```ts
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderTokensCss, tokens } from '../src/theme/tokens';

writeFileSync(resolve(import.meta.dirname, '../src/theme/tokens.css'), renderTokensCss(tokens));
```

Run : `pnpm --filter @classepulse/web gen:tokens`

- [ ] **Step 5 : Relancer**

Run : `pnpm vitest run --project web`
Expected : PASS. Si un contraste échoue, **ne pas modifier le test** : signaler la paire au responsable (les valeurs viennent de l'UX § 4.1 validée).

- [ ] **Step 6 : Écrire le test de préférence de thème (il échoue)**

`apps/web/src/theme/theme.spec.tsx` :

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, loadPreference, savePreference } from './theme';

afterEach(() => { localStorage.clear(); delete document.documentElement.dataset.theme; vi.restoreAllMocks(); });

describe('thème', () => {
  it('par défaut : système', () => expect(loadPreference()).toBe('system'));
  it('mémorise un choix manuel', () => { savePreference('dark'); expect(loadPreference()).toBe('dark'); });
  it('ignore une valeur inconnue', () => { localStorage.setItem('cp.theme', 'pink'); expect(loadPreference()).toBe('system'); });
  it('reste utilisable si le stockage est indisponible', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => savePreference('light')).not.toThrow();
    expect(loadPreference()).toBe('system');
  });
  it('applique le thème choisi ou celui du système', () => {
    applyTheme('light', true); expect(document.documentElement.dataset.theme).toBe('light');
    applyTheme('system', true); expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('system', false); expect(document.documentElement.dataset.theme).toBe('light');
  });
});
```

- [ ] **Step 7 : Implémenter**

`apps/web/src/theme/theme.ts` :

```ts
export type ThemePreference = 'system' | 'light' | 'dark';
const KEY = 'cp.theme';
const VALID: readonly ThemePreference[] = ['system', 'light', 'dark'];

export function loadPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v as ThemePreference) ? (v as ThemePreference) : 'system';
  } catch {
    return 'system';
  }
}

export function savePreference(p: ThemePreference): void {
  try { localStorage.setItem(KEY, p); } catch { /* préférence non mémorisée : comportement par défaut conservé */ }
}

export function applyTheme(pref: ThemePreference, prefersDark: boolean): void {
  const mode = pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = mode;
}
```

`apps/web/src/main.tsx` :

```tsx
import '@fontsource/figtree/latin-400.css';
import '@fontsource/figtree/latin-600.css';
import '@fontsource/figtree/latin-800.css';
import './theme/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyTheme, loadPreference } from './theme/theme';

const media = window.matchMedia('(prefers-color-scheme: dark)');
applyTheme(loadPreference(), media.matches);
media.addEventListener('change', (e) => applyTheme(loadPreference(), e.matches));

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

`apps/web/src/App.tsx` :

```tsx
export function App() {
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
        Classe<span style={{ color: 'var(--cp-brandtx)' }}>Pulse</span>
      </h1>
      <p>Les écrans arrivent avec les lots 1 à 6.</p>
    </main>
  );
}
```

`apps/web/index.html` :

```html
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ClassePulse</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8 : Relancer et construire**

Run : `pnpm vitest run --project web && pnpm --filter @classepulse/web build`
Expected : tests PASS ; build réussi ; `dist/` contient les fichiers `figtree-latin-{400,600,800}-normal*.woff2` et **aucune** requête vers `fonts.googleapis.com` (`grep -r googleapis apps/web/dist` ne renvoie rien).

- [ ] **Step 9 : Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): squelette React, couleurs de la direction B, thèmes clair et sombre, Figtree hébergée"
```

---

### Task 13 : Intégration continue (bloquée par D-1)

**Files :**
- Create : `.github/workflows/rapide.yml`, `.github/workflows/integration.yml`

**Interfaces :**
- Consumes : scripts racine (tâche 1), tests (tâches 2 à 12).

- [ ] **Step 1 : Vérifier que D-1 est tranchée**

Ouvrir `docs/superpowers/specs/2026-10-13-classepulse-v2-design.md` § 10. **Si D-1 est encore « ouverte », s'arrêter ici** et demander au responsable : option (a), (b) ou (c), plafond du premier mois, seuils d'alerte, durée de conservation des artefacts. Ne rien choisir à sa place. Une fois la décision prise, l'inscrire au § 10 (commit séparé) et créer la variable de dépôt :

```bash
gh variable set ARTIFACT_RETENTION_DAYS --body "<valeur décidée dans D-1>"
```

- [ ] **Step 2 : Workflow « rapide »**

`.github/workflows/rapide.yml` :

```yaml
name: rapide
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: rapide-${{ github.ref }}
  cancel-in-progress: true
jobs:
  rapide:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @classepulse/api prisma:generate
      - run: pnpm --filter @classepulse/web gen:tokens && git diff --exit-code apps/web/src/theme/tokens.css
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm depcruise
      - run: pnpm audit --audit-level high
      - name: gitleaks
        run: docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source /repo --redact --no-banner
```

Fixer l'image `zricethezav/gitleaks` et les actions (`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`) par empreinte de commit ou d'image avant la fusion.

- [ ] **Step 3 : Workflow « intégration »**

`.github/workflows/integration.yml` :

```yaml
name: integration
on:
  pull_request:
concurrency:
  group: integration-${{ github.ref }}
  cancel-in-progress: true
jobs:
  integration:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @classepulse/api prisma:generate
      - run: pnpm test:int
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: integration-logs
          path: apps/api/test/**/__snapshots__/**
          retention-days: ${{ vars.ARTIFACT_RETENTION_DAYS }}
```

- [ ] **Step 4 : Vérifier sur une pull request**

```bash
git checkout -b chore/ci
git add .github
git commit -m "ci: workflows rapide et intégration"
git push -u origin chore/ci
gh pr create --fill
gh pr checks --watch
```

Expected : `rapide` et `integration` verts. Noter dans `docs/ops/T-12-ci.md` la durée et les **minutes facturées par job** visibles dans l'onglet « Usage » de la PR (première mesure pour T-12).

- [ ] **Step 5 : Fusionner** après relecture, selon la procédure du dépôt.

---

### Task 14 : T-06 — protocole B2 (manuel, en parallèle)

**Files :**
- Create : `docs/ops/T-06-b2-locktest.md`

- [ ] **Step 1 : Préparer le compte-rendu**

Copier dans `docs/ops/T-06-b2-locktest.md` le tableau du protocole (§ 7.3.5 de la spécification, étapes 0 à 12) avec trois colonnes ajoutées : **Date et heure**, **Résultat observé**, **Conforme (oui/non)**.

- [ ] **Step 2 : Exécuter le protocole sur `cp-locktest-<date>`**

Suivre exactement les étapes 0 à 12 du § 7.3.5 (verrouillage en mode conformité d'un jour, préfixes `lc/` et `hide/`, clé de test avec les droits du VPS, puis clé complète). Consigner chaque résultat **au moment où il est observé**, avec l'heure, sans arrondir. Relevé quotidien jusqu'au jour 5 (étape 9), prolongé jusqu'au jour 10 si non concluant.

- [ ] **Step 3 : Conclure sans trancher D-2**

Écrire en fin de document : « Immuabilité démontrée : oui/non » et les **délais réels mesurés** du cycle de vie. Ne pas fixer les durées de D-2 : les soumettre au responsable.

- [ ] **Step 4 : Commit**

```bash
git add docs/ops/T-06-b2-locktest.md
git commit -m "docs(ops): T-06 — résultats du protocole B2"
```

---

### Task 15 : T-10 — reconnaissance du VPS (manuel, en parallèle)

**Files :**
- Create : `docs/ops/T-10-reconnaissance-vps.md`, `docs/ops/ACCESS.md`

- [ ] **Step 1 : Inventaire en lecture seule**

Sur le VPS, en lecture seule, sans rien modifier :

```bash
ss -tlnp
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
systemctl list-units --type=service --state=running --no-pager
ls /etc/caddy 2>/dev/null; caddy version 2>/dev/null
df -h; free -h; nproc
```

Consigner les sorties dans `docs/ops/T-10-reconnaissance-vps.md` (masquer les noms de projets tiers si le responsable le demande). Conclure : « Reverse proxy en place : <Caddy | autre | aucun> » ; si ce n'est pas Caddy, noter que le § 7.2.2 devra être adapté **avant** le lot 7. **Aucune modification des autres projets.**

- [ ] **Step 2 : Opérateurs A et B**

`docs/ops/ACCESS.md` : pour chacun des deux opérateurs **désignés par le responsable** (ne pas inventer de nom), une ligne par vérification du § 7.5 : clé SSH, groupe Telegram, double authentification Cloudflare / Backblaze / GitHub, clé age hors ligne (déchiffrement réussi), part du secret de secours (à faire au lot 7). Colonne « Vérifié le / par ». Le document est relu par une seconde personne.

- [ ] **Step 3 : Commit**

```bash
git add docs/ops/T-10-reconnaissance-vps.md docs/ops/ACCESS.md
git commit -m "docs(ops): T-10 — reconnaissance du VPS et accès des opérateurs"
```

---

## Critères de sortie du lot 0

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:int`, `pnpm depcruise` verts en local.
- [ ] API démarrée en local : `/api/health` → `{"status":"ok"}` ; `/api/health/ready` → `404` sur 3000, `200` sur 3001.
- [ ] `docs/ops/T-01-prisma.md` : T1 à T4 consignés, décision `BEGIN`/`COMMIT` confirmée ou soumise ; partie C démontrée ou soumise.
- [ ] `docs/ops/T-05-journaux.md` : (a) à (d) consignés, contrainte « pas de conversion côté serveur des secrets » écrite.
- [ ] D-1 tranchée par le responsable et CI verte sur une pull request (sinon, lot 0 terminé **sauf** tâche 13).
- [ ] T-06 et T-10 en cours ou terminés, sans bloquer le lot 1.
