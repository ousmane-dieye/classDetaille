# T-05 — secrets absents des traces PostgreSQL

Date : 2026-10-13. PostgreSQL 18.6 (postgres:18, Debian), Testcontainers, `pg_stat_statements` préchargé.
Réglages de production du serveur (ligne de commande) : `log_statement=none`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`.
Tests : `apps/api/test/integration/t05-logs.int.spec.ts`. Cible : requête sonde paramétrée (aucune fonction du lot 0 ne reçoit de secret) ; à rejouer par T-04 (lot 7).

## Résultats

| Point | Résultat |
|---|---|
| (a) `rolpassword` NULL | PARTIEL. Seul `cp_owner` est vérifié, dans le conteneur de la partie C (`prisma-cert.int.spec.ts`, « cp_owner n'a aucun mot de passe »). Les trois autres rôles et l'absence du mot de passe du superutilisateur dans les journaux (journalisation complète dès le premier démarrage) restent à vérifier : T-09 (lot 7). |
| (b) journalisation forcée (`log_statement=all`, `log_min_duration_statement=0`, longueurs `-1`) | PASS. Le secret n'apparaît ni dans les lignes `statement:`/`execute:`/`STATEMENT:`, ni dans `pg_stat_activity` (requête observée en cours d'exécution), ni dans `pg_stat_statements`. Il apparaît dans les lignes `parameters:` (preuve que les paramètres sont bien liés, pas interpolés). |
| (c) production + `log_statement=all` | PASS. Aucun secret dans les journaux, y compris sur une erreur d'exécution (`1/0`). |
| (c, caractérisation) erreur de conversion | PASS (risque confirmé). `select $1::int` avec un texte secret : le MESSAGE d'erreur (`invalid input syntax for type integer: "<secret>"`) recopie la valeur, côté client et dans le journal du serveur, malgré les longueurs à 0. |
| (d) `SET log_parameter_max_length` par cp_app / cp_ops / cp_monitor | PASS. Refusé, SQLSTATE 42501 (contexte `superuser`). |
| (d2) `SET log_parameter_max_length_on_error` | Caractérisé : autorisé (contexte `user`), effet limité à la session (d3). |
| (d3) autre session | PASS. Le secret d'une session B n'apparaît pas quand la session A a mis le réglage à -1. |
| (d4) `ALTER ROLE cp_app SET log_parameter_max_length_on_error = -1` par `cp_app` | Caractérisé : autorisé ; toute nouvelle connexion `cp_app` affiche `-1` (réglage durable, enregistré dans `pg_db_role_setting`). Vaut aussi pour `cp_ops` et `cp_monitor` sur leur propre rôle (constaté par la revue finale du lot 0 ; seul `cp_app` est testé). |
| (d5) `ALTER DATABASE <base> SET log_parameter_max_length_on_error = -1` par `cp_owner` | Caractérisé : autorisé (propriétaire de la base) ; une nouvelle connexion `cp_monitor` affiche `-1` : le réglage vaut pour tous les rôles (`setrole = 0`). |
| Garde-fou | PASS. Aucune forme interdite dans `apps/api/src`, `apps/api/prisma/migrations` ni `db/` ; détection de chaque forme prouvée sur fixture. |
| Détection | PASS. Un réglage `log_*` enregistré (sur la base, sur un rôle dans la base, sur un rôle pour tout le serveur) rend la sonde de disponibilité fausse ; elle redevient vraie après retrait (`database.int.spec.ts`). `cp_app` peut lire `pg_db_role_setting`. |

## Constat de sécurité (G4, version 2)

`log_parameter_max_length_on_error` est de contexte `user` dans PostgreSQL 18. PostgreSQL ne permet pas d'en interdire la modification, qui prend trois formes :
- **par session** (d2, d3) : `SET log_parameter_max_length_on_error = -1` par `cp_app`, `cp_ops` ou `cp_monitor` ; une requête paramétrée en erreur de la même session écrit alors `CONTEXT:  unnamed portal with parameters: $1 = '<secret>'` ; une autre session aux réglages par défaut ne laisse aucun secret dans les journaux ;
- **durablement sur son propre rôle** (d4) : `ALTER ROLE <soi> SET …`, autorisé à `cp_app`, `cp_ops` et `cp_monitor` ; s'applique à toutes leurs sessions suivantes ;
- **pour toute la base** (d5) : `ALTER DATABASE … SET …` par son propriétaire `cp_owner` ; s'applique à tous les rôles.

Une session, un rôle ou le propriétaire peut donc exposer, au-delà de ses propres valeurs, celles de toutes les sessions concernées par le réglage durable.

Décision (spécification, G4 version 2 : garde-fou + détection) :
- `log_parameter_max_length` reste réservé au superutilisateur ;
- **garde-fou** : aucune des formes `SET [SESSION|LOCAL] log_…`, `set_config('log_…`, `ALTER ROLE|USER … SET log_…`, `ALTER DATABASE … SET log_…`, ni aucune mention de `log_parameter_max_length`, dans `apps/api/src`, `apps/api/prisma/migrations` et `db/` (test unitaire `apps/api/test/architecture/no-log-settings.spec.ts`, qui prouve la détection de chaque forme sur des fixtures) ;
- **détection** : `DatabaseReadinessProbe` interroge `pg_db_role_setting` (booléen seulement, jamais les valeurs) ; si un réglage `log_*` est enregistré sur un rôle ou sur la base courante, `/api/health/ready` répond 503 et `/api/health` `degraded`, avec une seule ligne WARN sans valeur (`log_* override detected on role/database`) ;
- limite conservée : root ou superutilisateur peut changer ces réglages pour tout le serveur. Un `SET` de session n'est pas détectable de l'extérieur : il reste couvert par le garde-fou seul.

## Contrainte de conception

Toute fonction recevant un secret le prend en `text` ou `bytea`, sans conversion côté serveur ; le format est vérifié côté client avant l'appel.
Reprise dans le plan du lot 7 (secours à deux parts) et du lot 1 (codes, jetons).

## Notes de harnais

- Les réglages de production sont sur la ligne de commande du serveur : ils **priment** sur `ALTER SYSTEM` (sans effet, mesuré). `setServerLogging` pose donc les réglages avec `ALTER ROLE cp_app SET …` (effectif à la connexion suivante) et `resetServerLogging` les retire clé par clé (cp_app porte d'autres réglages de rôle).
- `afterAll` vérifie dans `pg_db_role_setting` que seuls `transaction_timeout=10s` et `idle_in_transaction_session_timeout=10s` restent pour `cp_app`, et qu'aucune clé `log_*` ne reste, ni pour `cp_app` (toutes bases), ni pour tous les rôles (`setrole = 0`) sur le serveur, la base de test ou la base modèle. (d4) et (d5) retirent leur réglage dans un bloc `finally`.
- `readPgLogsSince` décode le flux Docker multiplexé (en-têtes de 8 octets).
