# T-05 — secrets absents des traces PostgreSQL

Date : 2026-10-13. PostgreSQL 18.6 (postgres:18, Debian), Testcontainers, `pg_stat_statements` préchargé.
Réglages de production du serveur (ligne de commande) : `log_statement=none`, `log_parameter_max_length=0`, `log_parameter_max_length_on_error=0`.
Tests : `apps/api/test/integration/t05-logs.int.spec.ts`. Cible : requête sonde paramétrée (aucune fonction du lot 0 ne reçoit de secret) ; à rejouer par T-04 (lot 7).

## Résultats

| Point | Résultat |
|---|---|
| (a) `rolpassword` NULL | Couvert par la tâche 10 (« cp_owner n'a aucun mot de passe »). |
| (b) journalisation forcée (`log_statement=all`, `log_min_duration_statement=0`, longueurs `-1`) | PASS. Le secret n'apparaît ni dans les lignes `statement:`/`execute:`/`STATEMENT:`, ni dans `pg_stat_activity` (requête observée en cours d'exécution), ni dans `pg_stat_statements`. Il apparaît dans les lignes `parameters:` (preuve que les paramètres sont bien liés, pas interpolés). |
| (c) production + `log_statement=all` | PASS. Aucun secret dans les journaux, y compris sur une erreur d'exécution (`1/0`). |
| (c, caractérisation) erreur de conversion | PASS (risque confirmé). `select $1::int` avec un texte secret : le MESSAGE d'erreur (`invalid input syntax for type integer: "<secret>"`) recopie la valeur, côté client et dans le journal du serveur, malgré les longueurs à 0. |
| (d) `SET log_parameter_max_length` par cp_app / cp_ops / cp_monitor | PASS. Refusé, SQLSTATE 42501 (contexte `superuser`). |
| (d2) `SET log_parameter_max_length_on_error` | Caractérisé : autorisé (contexte `user`), effet limité à la session (d3). |
| (d3) autre session | PASS. Le secret d'une session B n'apparaît pas quand la session A a mis le réglage à -1. |
| Garde-fou | PASS. Aucun `SET log_*` dans `apps/api/src` ; détection prouvée sur fixture. |

## Constat de sécurité (G4 corrigé)

`log_parameter_max_length_on_error` est de contexte `user` dans PostgreSQL 18 : toute session (`cp_app`, `cp_ops`, `cp_monitor`) peut exécuter `SET log_parameter_max_length_on_error = -1`. Mesures :
- (d2) contexte = `user`, le `SET` par `cp_app` réussit ;
- avec ce réglage, une requête paramétrée en erreur de la même session écrit `CONTEXT:  unnamed portal with parameters: $1 = '<secret>'` ;
- (d3) l'effet est limité à la session : une autre session `cp_app` aux réglages par défaut, qui exécute une requête en erreur avec son propre secret, ne laisse aucun secret dans les journaux. Une session ne peut exposer que les valeurs qu'elle envoie elle-même.

Décision (spécification, G4 corrigé) : `log_parameter_max_length` reste réservé au superutilisateur ; `log_parameter_max_length_on_error` est caractérisé (session seule) ; garde-fou automatique : aucune instruction `SET log_*` (`set log_`, `set local log_`, `set_config('log_`, `log_parameter_max_length`) dans `apps/api/src` (test unitaire `apps/api/test/architecture/no-log-settings.spec.ts`, qui prouve sa détection sur une fixture). Limite conservée : root ou superutilisateur peut changer ces réglages pour tout le serveur.

## Contrainte de conception

Toute fonction recevant un secret le prend en `text` ou `bytea`, sans conversion côté serveur ; le format est vérifié côté client avant l'appel.
Reprise dans le plan du lot 7 (secours à deux parts) et du lot 1 (codes, jetons).

## Notes de harnais

- Les réglages de production sont sur la ligne de commande du serveur : ils **priment** sur `ALTER SYSTEM` (sans effet, mesuré). `setServerLogging` pose donc les réglages avec `ALTER ROLE cp_app SET …` (effectif à la connexion suivante) et `resetServerLogging` les retire clé par clé (cp_app porte d'autres réglages de rôle).
- `afterAll` vérifie dans `pg_db_role_setting` que seuls `transaction_timeout=10s` et `idle_in_transaction_session_timeout=10s` restent pour `cp_app`, sans clé `log_*`.
- `readPgLogsSince` décode le flux Docker multiplexé (en-têtes de 8 octets).
