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

## Résultats T1 à T4 (Task 10)

Date : 2026-10-13. Prisma : 7.10.0 (`prisma`, `@prisma/client`, schema-engine 0edf323efd1d98336f3f0a68684b56f689b900d3). Image PostgreSQL : `postgres:18@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336`. Plateforme de mesure : Windows 11, Node v24.15.0, Docker (moteur Linux). Chaque test lance la CLI Prisma réelle (`migrate deploy` / `migrate resolve`) sur un projet Prisma temporaire (`makeScratchPrismaProject`).

| Test | Résultat constaté | Verdict |
|---|---|---|
| T1a : `BEGIN; CREATE TABLE; SELECT 1/0; COMMIT;` | `migrate deploy` sort avec un code non nul ; `app.t1a` n'existe pas (retour arrière complet). Sortie Prisma : `Applying migration `20990101000000_t1a`` puis `ERROR: current transaction is aborted, commands ignored until end of transaction block` (le message `division by zero` / 22012 n'apparaît pas dans la sortie). Le test vérifie ce message et le nom de la migration, et que la ligne de `app._prisma_migrations` a `finished_at IS NULL`. | conforme |
| T1b : même migration sans `BEGIN`/`COMMIT` | Instantané ci-dessous : l'exécution échoue ET la table reste créée. | caractérisation |
| T2 : deux `migrate deploy` simultanés (migration à `pg_sleep(4)`) | Les deux processus sortent avec le code 0 ; un verrou consultatif non accordé (`pg_locks`, `locktype = 'advisory'`, `granted = false`) est observé ; la migration n'est enregistrée qu'une fois dans `app._prisma_migrations`. | conforme : verrou de Prisma démontré |
| T3 : échec, `migrate resolve --rolled-back`, correction du fichier, `migrate deploy` | Le premier `deploy` échoue (code 1) ; `resolve --rolled-back` sort avec 0 (`Migration ... marked as rolled back.`) ; le `deploy` suivant réussit et `app.t3` existe. | conforme |
| T4 : `CREATE INDEX CONCURRENTLY` interrompu (`pg_terminate_backend`) | Prisma exécute bien la migration hors transaction : aucune erreur `cannot run inside a transaction block` (observation manuelle lors du débogage : sans interruption, `CREATE INDEX CONCURRENTLY` aboutit avec le code 0 ; non couverte par un test automatisé). Une fois la session tuée, `migrate deploy` sort avec un code non nul et `findInvalidIndexes(client, 'app')` renvoie `['big_v_idx']`. | conforme |

### T1b : instantané (`apps/api/test/integration/__snapshots__/prisma-t01.int.spec.ts.snap`)

```
{
  "failed": true,
  "tableLeftBehind": true,
}
```

Sans `BEGIN`/`COMMIT`, Prisma n'enveloppe pas la migration dans une transaction dans ce scénario : l'instruction qui précède l'erreur est appliquée et reste en base, et la migration est marquée en échec. Dans ce scénario (fichier à plusieurs instructions sans `BEGIN`), il n'y a donc pas d'atomicité. Inférence (non mesurée directement) : Prisma envoie le fichier tel quel, en une seule fois, sans l'envelopper dans une transaction ; avec `BEGIN`/`COMMIT` explicites, l'erreur laisse la transaction ouverte puis abandonnée à la fermeture de la connexion (retour arrière côté serveur), ce qui explique le message `current transaction is aborted` : la `COMMIT` reçoit cet état d'échec.

La règle `BEGIN`/`COMMIT` explicite est **confirmée** (T1a réussi : aucune table créée après échec ; la migration de fondation, qui contient `BEGIN`/`COMMIT`, est acceptée par `migrate deploy`, voir plus haut).

Le verrou consultatif de Prisma est démontré (T2) ; le verrou `flock` de l'hôte (§ 7.2.7) peut néanmoins rester une protection supplémentaire, ce point relève du responsable.

### Corrections du harnais en cours de tâche (pas de changement de comportement attendu)

- Le `prisma.config.ts` du projet temporaire est hors de `node_modules` : `import ... from 'prisma/config'` échouait (`Cannot find module 'prisma/config'`). Il est maintenant importé par chemin absolu (résolu depuis l'API, séparateurs `/`). Les imports `.ts` des modules de configuration de l'API par chemin absolu `C:/...` sont résolus par le chargeur de Prisma. Avant ce correctif, T1a, T1b et T3 « passaient » de façon vacue (échec de chargement de la configuration) ; les résultats ci-dessus ont été obtenus après le correctif. Le `prisma.config.ts` temporaire définit toujours `datasource` (les variables `DB_*` sont toujours fournies par `runPrisma`).
- T2 : la sonde du verrou s'arrêtait après 6 s, avant que la CLI Prisma (démarrage de plusieurs secondes sous Windows) n'attende le verrou. La sonde court désormais jusqu'à la fin des deux processus.
- T4 : le filtre `query ilike 'CREATE INDEX CONCURRENTLY%'` ne correspondait pas à cause de la ligne de commentaire `-- classification: expand` qui précède l'instruction dans la requête vue par PostgreSQL. Le filtre est `'%CREATE INDEX CONCURRENTLY%'` et exclut la connexion de la sonde (`pid <> pg_backend_pid()`). La sonde court jusqu'à la fin du `deploy` (au lieu de 10 s).

## Partie C : certificat client (`cp_owner` sans mot de passe)

Conteneur PostgreSQL dédié avec TLS, `pg_hba` en `hostssl ... cert map=cp`, PKI de test générée à chaque exécution (`apps/api/test/support/certs.ts`, rien de versionné). Résultat (2026-10-13, Prisma 7.10.0, même image) : 3 tests sur 3 réussis.

- `cp_owner` n'a aucun mot de passe (`rolpassword is null` = `t`).
- `migrate deploy` avec `sslidentity` (PKCS#12) + `sslaccept=strict` : code 0, migration appliquée, aucun avertissement `sslaccept`/`sslpassword` dans la sortie.
- Autorité attendue différente de celle du serveur : `migrate deploy` échoue (code 1), sortie : `Error: P1011: Error opening a TLS connection: Une chaîne de certificats a été traitée mais s’est terminée par un certificat racine qui n’est pas approuvé par le fournisseur d’approbation. (os error -2146762487)` (message du système Windows, schannel).

Partie C : compatibilité démontrée sous Windows (client Prisma). Non vérifié sous Linux (CI/hôte de production) : le message d'erreur TLS diffère selon la plateforme, le comportement (échec) est le même attendu.
