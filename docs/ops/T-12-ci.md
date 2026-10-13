# T-12 — Intégration continue : décision et suivi de consommation

## Décision D-1 (2026-10-13, phase de développement)

Rester dans l'offre GitHub gratuite (2 000 minutes par mois), plafond de dépenses à **0 $** (aucun dépassement payé), artefacts conservés **3 jours**. Seuls les workflows `rapide` et `integration` sont actifs. Aucune suite de nuit pour l'instant.

**À revoir avant la première mise en production** : la suite de nuit exigée par le § 5.6 de la spécification n'est pas encore financée.

## Workflows créés

| Workflow | Fichier | Déclencheurs | Délai maximal |
|---|---|---|---|
| rapide | `.github/workflows/rapide.yml` | pull request, push sur `main` | 10 min |
| integration | `.github/workflows/integration.yml` | pull request | 20 min |

Les actions et l'image gitleaks sont fixées par empreinte (commit ou digest). Conservation des artefacts : `retention-days: 3`, écrit en dur dans le workflow.

## Mesures réelles (à remplir après les premières exécutions)

Source : onglet « Usage » de la pull request, puis rapport d'usage de facturation.

| Workflow | Durée réelle | Minutes facturées | Date |
|---|---|---|---|
| rapide | | | |
| integration | | | |

## Règle de plafond

Avec un plafond de dépenses à 0 $, quand la consommation mensuelle approche 2 000 minutes, **les Actions s'arrêtent** (les workflows ne démarrent plus). Le responsable humain doit alors décider : attendre le mois suivant, réduire les déclenchements, ou financer (offre Pro, dépassement, runner auto-hébergé). Ne rien contourner sans cette décision.
