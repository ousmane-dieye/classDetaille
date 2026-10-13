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
| (d) `SET log_parameter_max_length_on_error` | **ÉCHEC D'EXIGENCE.** Autorisé pour les trois rôles : le paramètre est de contexte `user` dans PostgreSQL 18. |

## Constat de sécurité (décision requise)

Une session `cp_app` (ou `cp_ops`, `cp_monitor`) peut exécuter `SET log_parameter_max_length_on_error = -1`. Mesure : ensuite, une requête paramétrée en erreur écrit dans le journal
`CONTEXT:  unnamed portal with parameters: $1 = '<secret>'` : le secret fuit dans les journaux du serveur, même si la configuration serveur est à 0.
Conséquence : l'hypothèse « les rôles ne peuvent pas rétablir la journalisation des paramètres » est **fausse** pour ce paramètre. Un attaquant capable d'exécuter du SQL arbitraire sous `cp_app` obtient déjà le secret par d'autres voies ; le risque réel est une fuite accidentelle ou une injection SQL qui combinerait `SET` et une erreur provoquée. Le test `(d, exigence)` est marqué `it.fails` pour garder l'exigence visible sans casser la suite ; `(d, caractérisation)` documente le comportement observé.

Pistes à évaluer (non mesurées) : `log_error_verbosity=terse` côté serveur (supprime CONTEXT/STATEMENT) ; ne jamais passer un secret à une instruction pouvant échouer côté serveur ; interdire `SET` des paramètres de journalisation en amont (couche applicative / pooler).

## Contrainte de conception

Toute fonction recevant un secret le prend en `text` ou `bytea`, sans conversion côté serveur ; le format est vérifié côté client avant l'appel.
Reprise dans le plan du lot 7 (secours à deux parts) et du lot 1 (codes, jetons).

## Notes de harnais

- Les réglages de production sont sur la ligne de commande du serveur : ils **priment** sur `ALTER SYSTEM`. `ALTER SYSTEM SET` + `pg_reload_conf()` est sans effet sur eux (mesuré : aucune ligne `statement:` ni `parameters:`). `setServerLogging` pose donc les réglages avec `ALTER ROLE cp_app SET …` (effectif à la connexion suivante) et `resetServerLogging` les retire clé par clé (cp_app porte d'autres réglages de rôle).
- `afterAll` vérifie que `log_statement=none` et les deux longueurs à 0 sont restaurés.
- `readPgLogsSince` décode le flux Docker multiplexé (en-têtes de 8 octets).
