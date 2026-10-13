# Exceptions à `pnpm audit`

L'étape `pnpm audit --audit-level high` de la CI doit rester verte. Les exceptions ci-dessous sont déclarées dans `pnpm-workspace.yaml` (`auditConfig.ignoreGhsas`).

| GHSA | Paquet | Chemin | Pourquoi c'est accepté | Décidé par | Réexamen |
|---|---|---|---|---|---|
| GHSA-86w9-cpqp-85rv | node-forge (<=1.4.0, aucun correctif publié) | `apps__api>node-forge` (devDependency) | Sert uniquement à GÉNÉRER les certificats de test de la partie C. La fonction vulnérable est la VÉRIFICATION de signature RSA PKCS#1 v1.5, que nous n'appelons jamais. Jamais livré dans les images de production. | Responsable du projet, 2026-10-13 | **2027-01-13**, ou plus tôt si un correctif est publié |

## Versions forcées (`overrides` dans `pnpm-workspace.yaml`)

- `deepmerge-ts: 8.0.2` (dépendance de `@prisma/config`), correctif des versions inférieures à 8.0.0.
- `mysql2: 3.24.6` (dépendance de `prisma`), correctif des versions inférieures à 3.22.0.
