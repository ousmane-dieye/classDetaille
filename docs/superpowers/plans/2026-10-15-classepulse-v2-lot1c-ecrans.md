# ClassePulse V2 — Lot 1c : écrans d'accès, profil et sessions — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** la SPA `apps/web` devient utilisable : inscription (P1), connexion avec code administrateur (P2), mot de passe oublié, écrans d'état, profil et sessions (P10), avec les écrans M7, M8 et M14 de la maquette, en français et au tutoiement, accessibles (WCAG 2.2 AA) et thème clair/sombre.

**Architecture :** `apps/web` (React 19 + Vite 8) consomme l'API déjà livrée (lots 1a et 1b) **sans la modifier** : un client HTTP mince (`src/api/`) envoie `credentials: 'include'`, respecte le CSRF (même origine) et traduit les codes d'erreur de l'API en textes français. Un routeur (adresse propre par écran, UX § 1.5) rend un écran par route ; `AuthShell` (photo de marque à gauche ≥ 1024 px, formulaire à droite) et `StateScreen` (icône, titre, texte, actions) portent M7/M8/M14. Aucune donnée n'est stockée côté client : le serveur fait foi.

**Tech Stack :** React 19.3, Vite 8.3, `react-router` 8.4.0, `@fontsource/figtree` (déjà présent), Zod 4 via `@classepulse/shared` (schémas des corps), `axe-core` 4.14.0 (tests d'accessibilité), Vitest 5 + Testing Library + jsdom, `selfsigned` 5.5.0 (certificat de développement HTTPS).

**Spec :** `docs/superpowers/specs/2026-10-13-classepulse-v2-design.md` (§ 0.3, § 0.7, § 2.2 « Identité et sessions », § 3.1, § 3.2, § 3.3 (parcours de connexion), § 3.4, § 3.5, § 5.6) et `docs/superpowers/specs/2026-10-13-classepulse-v2-ux-design.md` (§ 1.1, § 1.5, § 2 P1, P2, P10 ; § 3.1 composants ; § 3.2 états ; § 3.3 rédaction ; § 4 identité visuelle ; § 5 accessibilité/responsive). Maquettes : `docs/design/mockups/lot2-acces.html` (M7, M8) et `docs/design/mockups/m14-etats-profil.html` (M14). Contrat des routes : `README.md` (« Contrat pour le lot 1c »). Feuille de route : `docs/superpowers/plans/2026-10-13-classepulse-v2-roadmap.md` (« Décisions du responsable sur le lot 1 »).

## Global Constraints

- Toutes les dépendances en **version exacte** (`pnpm add -E`), `pnpm-lock.yaml` committé ; `pnpm audit --audit-level high` reste vert.
- **Aucune modification de l'API ni de la base** dans ce lot : le web s'adapte au contrat existant (`README.md`, § « Contrat pour le lot 1c »). Si un écran a besoin d'un champ qui n'existe pas, il est **signalé et reporté**, jamais inventé côté serveur.
- **Une seule origine** (§ 3.1) : `/api` est servi par l'origine de l'application ; le web n'envoie **aucun en-tête personnalisé**, le cookie de session suffit (`credentials: 'include'`). Aucune configuration CORS.
- Les requêtes qui modifient portent `Content-Type: application/json` et, implicitement, l'`Origin` de la page ; un corps vide s'envoie `{}`.
- **Les codes d'erreur de l'API sont des identifiants stables en anglais** (lot 1a) ; **tous** les textes affichés sont en français, au tutoiement, phrases courtes, voix active (UX § 3.3).
- Message de connexion **identique dans tous les cas** (§ 3.2) : `INVALID_CREDENTIALS`, `TURNSTILE_FAILED`, `TURNSTILE_REQUIRED`, `TOO_MANY_ATTEMPTS` ne produisent jamais un message qui dénonce l'email ou le mot de passe. Seuls `ACCOUNT_SUSPENDED` (403) et les erreurs de service (503) ont leur propre texte.
- **Turnstile** : le web ne détient que la **clé publique** (`VITE_TURNSTILE_SITEKEY`) ; aucun secret côté client. Le jeton est envoyé **à l'inscription** et au **mot de passe oublié** (toujours), et à la **connexion** seulement quand l'API répond `turnstileRequired` (§ 3.2 : après 3 échecs sur un couple IP + compte).
- **Le compte à rebours et le délai de « Renvoyer » viennent du serveur** (`expiresInSeconds`, `resendAfterSeconds`), jamais de constantes côté client.
- **Cookies `__Host-`** : `Secure`, donc **aucun développement en HTTP clair**. Le serveur de développement Vite sert `https://localhost:5173` avec un certificat auto-signé généré à la première exécution et proxyfie `/api` vers l'API (voir R2).
- **Accessibilité** : `axe-core` exécuté sur chaque écran rendu dans les tests, **zéro violation `serious` ou `critical`** ; libellés visibles, champs liés à leur `label`, erreurs annoncées (`role="alert"`) et liées au champ (`aria-describedby`, `aria-invalid`), cibles ≥ 44 px, focus visible, contour de focus terre cuite, lien « Aller au contenu », `lang="fr"`.
- **Jamais la couleur seule** : une erreur porte un texte et une icône ; un champ invalide porte `aria-invalid` et un message.
- Écrans **responsives** : une colonne sous 640 px, formulaires ≤ 480 px centrés ; textes et champs à **16 px minimum** (UX § 4.2).
- **Identité visuelle** : uniquement les jetons existants (`--cp-bg`, `--cp-surface`, `--cp-ink`, `--cp-muted`, `--cp-line`, `--cp-line2`, `--cp-navon`, `--cp-brand`, `--cp-onbrand`, `--cp-brandtx`, `--cp-red`, `--cp-amb`, `--cp-grn`) ; **bordures fines plutôt qu'ombres** ; une seule ombre légère sur l'écran de marque ; rayons 12 px (boutons, champs), 14–16 px (cartes) ; grille de 4 px ; **aucun marqueur « style IA »** (UX § 4.6) : pas d'étincelle, pas de dégradé, pas d'emoji dans les titres.
- Police Figtree 400/600/800, hébergée par l'application (déjà en place).
- **Tests** : `pnpm test:unit` (projet `web` inclus) et `pnpm typecheck` verts à chaque tâche ; aucun test ne dépend du réseau ni de l'API réelle (fetch est simulé).
- Pas de `console.log` ni de donnée personnelle dans les journaux du navigateur ; le numéro de demande (`requestId`) est affiché en petit sur les erreurs, jamais dans un titre.

## Review Focus

1. **Un écran qui oublie un code d'erreur** : tout code renvoyé par l'API a un texte français ; un code inconnu (ajouté plus tard) donne un texte générique avec le `requestId`, jamais `undefined` ni le JSON cru. → tests en tâche 2 et 13.
2. **Le code administrateur** : collage d'un code complet, flèches/retour arrière, saisie au clavier numérique, expiration pendant la saisie, `CODE_LOCKED` (aucun essai restant), `CHALLENGE_EXPIRED` (renvoi vers la connexion), `TOO_MANY_CODE_REQUESTS` avec `Retry-After`. → tests en tâche 8.
3. **Double saisie du mot de passe** : erreur de correspondance affichée **en quittant le second champ**, contenu **jamais effacé** après une erreur serveur, indicateur « N caractères · 15 minimum » sans jauge de force, bouton « Afficher » sur chaque champ. → tests en tâches 3, 5 et 10.
4. **Session expirée pendant l'usage** : un `401` ramène à la connexion, puis **retour à l'écran d'origine** après connexion (UX § 3.2). → tests en tâche 12.
5. **Turnstile absent, refusé, ou service indisponible** : `TURNSTILE_REQUIRED` → widget affiché et nouveau essai ; `TURNSTILE_FAILED` → message et nouveau widget ; `503 SIGNUP_UNAVAILABLE` / `RESET_UNAVAILABLE` avec compte à rebours depuis `Retry-After`. → tests en tâches 4, 5, 7 et 9.

## Rulings (décisions de rédaction, à relire par le responsable)

- **R1 — Routeur.** `react-router` 8.4.0, rendu client uniquement, `BrowserRouter`. Une adresse par écran (UX § 1.5) : `/`, `/inscription`, `/connexion`, `/connexion/code`, `/mot-de-passe-oublie`, `/reinitialisation`, `/profil`, `/profil/sessions`, `/confidentialite`. Toute adresse inconnue → écran « Cet élément n'existe pas ou n'est plus disponible » (UX § 3.2). *Coût si faux : déplacer des composants.*
- **R2 — Développement en HTTPS.** Les cookies `__Host-` sont `Secure` : en HTTP clair, le navigateur les refuse (déjà documenté dans le README au lot 1b). Le serveur de développement Vite sert donc `https://localhost:5173`, génère à la première exécution un certificat auto-signé (`selfsigned`) dans `.secrets/dev/` (ignoré par git) et proxyfie `/api` vers `http://127.0.0.1:3000`. `APP_ORIGIN=https://localhost:5173` côté API. *Coût si faux : une variable d'environnement.*
- **R3 — Turnstile côté web.** Le widget officiel de Cloudflare est chargé à la demande depuis `https://challenges.cloudflare.com/turnstile/v0/api.js` par le composant `TurnstileField` (aucune dépendance tierce). La clé publique vient de `VITE_TURNSTILE_SITEKEY` ; en développement, la clé de test « toujours accepte » de Cloudflare. Le composant rend `null` (champ masqué) tant que la clé est absente, et l'écran affiche alors la raison : impossible d'envoyer une demande sans clé. *Coût si faux : un composant.*
- **R4 — Aucune donnée de session côté client.** Pas de `localStorage` de profil : `GET /api/me` est appelé au démarrage de chaque écran protégé ; le serveur fait foi. Seule la préférence de **thème** est mémorisée (`cp.theme`, déjà en place). *Coût si faux : une couche de cache à invalider.*
- **R5 — Suppression de compte hors lot 1c.** Décision du responsable du 2026-10-14 (roadmap) : `priv.anonymize_user` et son écran arrivent au lot 2. M14 est donc livré **sans** la section « Supprimer mon compte ». *Coût si faux : une tâche de plus.*
- **R6 — Accessibilité testée.** `axe-core` 4.14.0 en dépendance de développement, exécuté sur chaque écran rendu ; échec du test si une violation `serious` ou `critical` apparaît. Les violations mineures sont consignées dans la tâche 13. *Coût si faux : une dépendance de test.*
- **R7 — Photo d'accueil.** La maquette M7/M8 place une vraie photo d'étudiants à gauche, sur ordinateur (≥ 1024 px), fournie par le responsable. Elle n'existe pas encore : le panneau de marque est livré **avec l'emplacement et sans photo** (texte de marque seulement), et l'image sera ajoutée quand elle sera fournie, sans changer la mise en page. Aucune image de banque n'est achetée. *Coût si faux : un `img` de plus.*
- **R8 — Turnstile à la connexion.** Le widget n'est pas affiché à l'avance : si l'API répond `401 INVALID_CREDENTIALS` avec `turnstileRequired: true`, le champ apparaît au-dessus du bouton et la tentative suivante inclut le jeton (§ 3.2, UX P2 « après plusieurs échecs »). *Coût si faux : un état local.*
- **R9 — Texte du refus d'inscription.** L'inscription peut répondre `409 EMAIL_TAKEN` (arbitrage N de la spec : l'inscription révèle qu'un compte existe). Le web affiche « Un compte existe déjà avec cet email. Essaie de te connecter. » avec un lien vers la connexion. La révélation est assumée et documentée (§ 3.2). *Coût si faux : un texte.*
- **R10 — Pas de gestionnaire d'état global.** Contexte React `SessionProvider` (chargement de `/api/me`, mise à jour après inscription/connexion, déconnexion) + état local par écran. Pas de Redux, pas de TanStack Query : le produit tient dans un contexte et quelques hooks. *Coût si faux : une dépendance.*
- **R11 — `Retry-After` respecté.** Sur `429` et `503`, le bouton est désactivé pendant le délai indiqué par l'en-tête (ou `Retry-After` déjà consommé par l'API ? non : l'en-tête est lisible car même origine) — décision : le web lit l'en-tête `Retry-After` de la réponse et affiche « Réessaie dans X s » avec un compte à rebours. *Coût si faux : quelques lignes.*
- **R12 — Hors ligne.** Bandeau « Connexion perdue — reconnexion… » dès que `navigator.onLine` passe à `false` ou qu'une requête échoue par réseau ; les écritures sont désactivées avec la raison ; le retour en ligne relance automatiquement le chargement (UX § 3.2). *Coût si vrai : un hook `useOnline`.*

---

## Structure des fichiers

```
apps/web/
  .env.development                       VITE_TURNSTILE_SITEKEY (clé de test, jamais un secret)
  index.html                             lang="fr", lien « Aller au contenu »
  vite.config.ts                         + HTTPS auto-signé, proxy /api, cert généré
  scripts/gen-dev-cert.ts                certificat de développement → .secrets/dev/
  src/
    main.tsx                             BrowserRouter + SessionProvider + thème
    App.tsx                              routes
    app.css                              règles globales (focus, lien d'évitement, grille)
    api/
      client.ts                          apiFetch, ApiProblem, lecture de Retry-After
      messages.ts                        codes API → textes français
      messages.spec.ts
      auth.ts                            register, login, verifyCode, resendCode, verifyRecovery,
                                         forgotPassword, resetPassword, logout, me
      account.ts                         profile, preferences, password, sessions, revokeOthers, emailChange
      turnstile.ts                       chargement du script, rendu du widget, expiration du jeton
      turnstile.spec.ts
    session/
      session-context.tsx                SessionProvider, useSession
      session-context.spec.tsx
    routes.tsx                           table des routes (adresse, écran, protection)
    components/
      Button.tsx / Button.spec.tsx       principal, secondaire, lien, destructif, état occupé
      TextField.tsx / *.spec.tsx         libellé visible, erreur, aide
      PasswordField.tsx / *.spec.tsx     « Afficher », compteur, autocomplete correct
      SelectField.tsx / *.spec.tsx       liste des classes actives
      TurnstileField.tsx / *.spec.tsx    widget + jeton
      OtpInput.tsx / *.spec.tsx          6 cases, collage, clavier numérique
      InlineAlert.tsx                    message d'erreur / information
      Banner.tsx                         connexion perdue, lecture seule
      AuthShell.tsx                      panneau de marque + formulaire (M7/M8)
      StateScreen.tsx                    icône, titre, texte, actions, rappel (M14)
      Skeleton.tsx                       chargement au-delà de 300 ms
      SkipLink.tsx                       « Aller au contenu »
      Countdown.tsx                      compte à rebours (code, Renvoyer, Retry-After)
    screens/
      register/RegisterScreen.tsx / *.spec.tsx        M7 (P1)
      states/PendingScreen.tsx / *.spec.tsx           demande envoyée
      states/RefusedScreen.tsx / *.spec.tsx           demande refusée (motif, date, alternative)
      states/NotFoundScreen.tsx / *.spec.tsx
      login/LoginScreen.tsx / *.spec.tsx              M8 (P2)
      login/AdminCodeScreen.tsx / *.spec.tsx          M8 : code à 6 chiffres
      forgot/ForgotPasswordScreen.tsx / *.spec.tsx    demande, confirmation identique
      forgot/ResetPasswordScreen.tsx / *.spec.tsx     nouveau mot de passe en double
      profile/ProfileScreen.tsx / *.spec.tsx          M14 (P10) : nom, mot de passe, préférences, thème
      profile/SessionsScreen.tsx / *.spec.tsx         M14 : sessions actives
      a11y.spec.ts                       axe sur chaque écran
```

---

### Task 1 : Dépendances, routage et squelette

- [x] **Step 1 : Écrire les tests (échouent)** — `routes.spec.tsx` : chaque adresse rend son écran ; une adresse inconnue rend l'écran « Cet élément n'existe pas ou n'est plus disponible » ; `App` monte le lien « Aller au contenu » et déclare `lang="fr"`.
- [x] **Step 2 : Implémenter** — `pnpm --filter @classepulse/web add -E react-router@8.4.0` ; `routes.tsx` (table déclarative), `App.tsx`, `app.css` (focus 2 px `--cp-brand` décalé, styles de base), `SkipLink`, `NotFoundScreen`. `App.tsx` n'affiche plus la page de garde.
- [x] **Step 3 : Vérifier** — `pnpm test:unit` (projet `web`), `pnpm --filter @classepulse/web typecheck`, `pnpm lint`.
- [x] **Step 4 : Commit** — `feat(lot1c): routage, squelette des écrans et lien d'évitement`.

### Task 2 : Client HTTP et traduction des erreurs

- [x] **Step 1 : Écrire les tests (échouent)** — `messages.spec.ts` : chaque code du contrat (§ « Codes d'erreur du lot 1b », plus `INVALID_CREDENTIALS`, `ACCOUNT_SUSPENDED`, `EMAIL_TAKEN`, `SIGNUP_UNAVAILABLE`, `RESET_UNAVAILABLE`, `UNAUTHENTICATED`, `CSRF_REJECTED`, `TOO_MANY_REQUESTS`, `INTERNAL`) a un texte français ; un code inconnu donne le texte générique « Une erreur est survenue. Réessaie. » ; `Retry-After` est lu et converti en délai. `client.spec.ts` : `credentials: 'include'`, `Content-Type` posé seulement s'il y a un corps, `{}` envoyé pour un corps vide, `ApiProblem` porte `status`, `code`, `extra`, `requestId` et `retryAfterSeconds`.
- [x] **Step 2 : Implémenter** — `api/client.ts`, `api/messages.ts`.
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): client HTTP et textes français des erreurs`.

### Task 3 : Composants de saisie et de retour (M14, UX § 3.1)

- [x] **Step 1 : Écrire les tests (échouent)** — `Button` (libellé, état occupé `aria-busy`, jamais désactivé par défaut sans raison), `TextField` (libellé visible lié au champ, `aria-invalid`, message d'erreur annoncé par `role="alert"` et lié par `aria-describedby`, aide en dessous), `PasswordField` (bouton « Afficher »/« Masquer » avec `aria-pressed`, `autocomplete="new-password"` ou `current-password`, compteur « 17 caractères · 15 minimum » sans jauge), `InlineAlert` (icône + texte, jamais la couleur seule), `Skeleton` (masqué sous 300 ms), `Countdown` (affiche `mm:ss`, s'arrête à zéro, annonce polie toutes les minutes).
- [x] **Step 2 : Implémenter** — composants + styles, jetons uniquement.
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): composants de saisie, boutons, alertes et compte à rebours`.

### Task 4 : Turnstile et origine de développement

- [x] **Step 1 : Écrire les tests (échouent)** — `turnstile.spec.ts` : le script est chargé une seule fois, le widget est rendu avec la clé, le jeton est transmis à l'écran, un jeton expiré n'est pas réutilisé, l'échec du script laisse le champ inutilisable avec un message. `vite.config.spec.ts` (lecture du fichier) : HTTPS activé, proxy `/api` présent.
- [x] **Step 2 : Implémenter** — `api/turnstile.ts`, `components/TurnstileField.tsx`, `scripts/gen-dev-cert.ts` + `selfsigned@5.5.0`, `vite.config.ts` (https + proxy), `.env.development` avec la clé de test, README (section « Application web »).
- [x] **Step 3 : Vérifier** — tests, typecheck, lint ; démarrage manuel `pnpm --filter @classepulse/web dev` (certificat généré, page servie en https).
- [x] **Step 4 : Commit** — `feat(lot1c): Turnstile côté web et développement en HTTPS`.

### Task 5 : Inscription (M7, P1)

- [x] **Step 1 : Écrire les tests (échouent)** — formulaire complet : prénom, nom, email **saisi une seule fois** avec l'aide « Tes rappels et la récupération de ton compte arriveront à cette adresse : vérifie-la bien. », mot de passe **en double**, classe parmi les classes actives, Turnstile. Indicateur « N caractères · 15 minimum » ; erreur de correspondance affichée **en quittant le second champ** ; **rien n'est effacé** après une erreur serveur ; `409 EMAIL_TAKEN` → message + lien connexion ; `400 TURNSTILE_FAILED` → nouveau widget ; `503 SIGNUP_UNAVAILABLE` → message avec le compte à rebours ; `429` → message avec `Retry-After` ; succès → écran « Demande envoyée » avec l'email rappelé. Lien « Se connecter » en bas.
- [x] **Step 2 : Implémenter** — `RegisterScreen`, `AuthShell` (M7), `api/auth.ts` (register, classes actives), `SessionProvider` (profil enregistré après inscription).
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): inscription et demande d'adhésion (P1)`.

### Task 6 : Écrans d'état (M7, UX § 1.1)

- [x] **Step 1 : Écrire les tests (échouent)** — après connexion (ou au démarrage) : `enrollment.status === 'PENDING'` → « Demande envoyée » (classe, email, date d'envoi, bouton « Se déconnecter ») ; `REFUSED` → « Demandée refusée » avec le motif entre guillemets s'il existe, la date de nouvelle demande et le bouton « Demander une autre classe » ; `null` (aucune demande) → écran invitant à contacter le délégué ; `ACCEPTED` sans classe → écran de secours. Un `GET /api/me` qui échoue affiche l'état d'erreur avec « Réessayer ».
- [x] **Step 2 : Implémenter** — `PendingScreen`, `RefusedScreen`, `StateScreen`, routage depuis `SessionProvider`.
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): écrans d'état demande envoyée et refusée (M7)`.

### Task 7 : Connexion (M8, P2)

- [x] **Step 1 : Écrire les tests (échouent)** — un seul champ mot de passe ; message **identique** « Email ou mot de passe incorrect. » pour `INVALID_CREDENTIALS`, `TURNSTILE_FAILED`, `TURNSTILE_REQUIRED` et `TOO_MANY_ATTEMPTS` ; `turnstileRequired: true` → widget affiché et inclus dans la tentative suivante ; `403 ACCOUNT_SUSPENDED` → message propre ; `429` → compte à rebours depuis `Retry-After`, bouton désactivé ; réponse `202 ADMIN_CODE_REQUIRED` → redirection vers `/connexion/code` avec `expiresInSeconds` et `resendAfterSeconds` ; étudiant connecté → écran d'état ou profil ; lien « Mot de passe oublié ? » et « Créer un compte ».
- [x] **Step 2 : Implémenter** — `LoginScreen`, `api/auth.ts` (login), `SessionProvider` (mise à jour).
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): écran de connexion avec message unique (M8)`.

### Task 8 : Code administrateur (M8, P2)

- [x] **Step 1 : Écrire les tests (échouent)** — `OtpInput` : 6 cases, saisie numérique, **collage** d'un code complet, retour arrière, navigation ; titre « Vérifie ton email », adresse **masquée** (`a•••••@esp.sn`), compte à rebours de 10 min, « Renvoyer » désactivé pendant 60 s puis actif ; succès → session ouverte et retour à l'écran demandé ; `400 CODE_INVALID` → « Code incorrect. Il te reste 4 essais. » avec les cases conservées et focus au premier champ ; `400 CODE_LOCKED` → message de verrouillage + renvoi vers la connexion ; `400 CHALLENGE_EXPIRED` → renvoi vers la connexion avec un bouton « Renvoyer un code » ; `429 TOO_MANY_CODE_REQUESTS` → compte à rebours ; note « Tu n'arrives pas à recevoir le code ? Contacte un opérateur de la plateforme : il pourra te délivrer un code de récupération. » (le code de récupération n'est **jamais** en libre-service, § 3.3).
- [x] **Step 2 : Implémenter** — `AdminCodeScreen`, `OtpInput`, `api/auth.ts` (verifyCode, resendCode, verifyRecovery désactivé côté formulaire mais présent dans le client pour le lot suivant : **non**, seul `verifyCode` et `resendCode` sont branchés ; la note renvoie vers l'opérateur).
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): écran du code administrateur (M8)`.

### Task 9 : Mot de passe oublié et réinitialisation (§ 3.2)

- [x] **Step 1 : Écrire les tests (échouent)** — demande : champ email, Turnstile **toujours** envoyé, réponse `202` toujours identique (« Si un compte existe avec cet email, tu reçois un message. ») ; `503 RESET_UNAVAILABLE` avec compte à rebours ; `429` ; aucun contenu effacé. Réinitialisation (depuis l'adresse exacte de l'email du lot 1b : `/reinitialiser-mot-de-passe#token=…`, jeton lu dans le **fragment** puis retiré de l'URL, R8 du lot 1b — correction de la tâche : le contrat de l'email prime sur la formulation initiale « `/reinitialisation?token=` ») : nouveau mot de passe **saisi deux fois**, politique 15 caractères, `400 RESET_TOKEN_INVALID` → message + lien vers une nouvelle demande, `503` → message, succès → confirmation et redirection vers la connexion. Un jeton absent de l'URL → « Ce lien n'est plus valable. »
- [x] **Step 2 : Implémenter** — `ForgotPasswordScreen`, `ResetPasswordScreen`, `api/auth.ts` (forgotPassword, resetPassword).
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): mot de passe oublié et réinitialisation`.

### Task 10 : Profil (M14, P10)

- [x] **Step 1 : Écrire les tests (échouent)** — sections « Nom » (prénom + nom, `PATCH /api/me/profile`, confirmation), « Mot de passe » (actuel + nouveau en double, `400 CURRENT_PASSWORD_INVALID` → message sous le champ actuel, `403 REAUTH_REQUIRED` → ressaisie, politique 16 caractères pour un administrateur), « Préférences d'email » (deux interrupteurs `emailReminders` / `emailAnnouncements`, `PATCH /api/me/email-preferences`), « Thème » (système / clair / sombre, mémorisé dans `cp.theme`), email en lecture seule, lien vers « Sessions actives ». Une erreur serveur n'efface jamais le contenu saisi.
- [x] **Step 2 : Implémenter** — `ProfileScreen`, `api/account.ts`.
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): profil, mot de passe, préférences et thème (M14)`.

### Task 11 : Sessions actives (M14, § 3.4)

- [x] **Step 1 : Écrire les tests (échouent)** — liste des sessions (`GET /api/me/sessions`) : date de création, dernière activité, navigateur déduit de l'`userAgent`, badge « Cet appareil » sur la session courante ; bouton « Déconnecter les autres appareils » avec confirmation (« Déconnecter les autres appareils ? ») et retour du nombre ; `401` → retour à la connexion ; chargement et état vide.
- [x] **Step 2 : Implémenter** — `SessionsScreen`, `api/account.ts` (sessions, revokeOthers).
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): sessions actives et déconnexion des autres appareils (M14)`.

### Task 12 : États communs, session expirée et hors ligne (M14, UX § 3.2)

- [x] **Step 1 : Écrire les tests (échouent)** — `401` sur une route protégée → redirection vers `/connexion` avec retour prévu à l'écran d'origine après connexion ; `429` → message avec compte à rebours ; `503` → message de maintenance avec nouvel essai ; `404` de l'API → écran « Cet élément n'existe pas ou n'est plus disponible » ; échec réseau ou `navigator.onLine === false` → bandeau « Connexion perdue — reconnexion… », écritures désactivées avec la raison, rechargement au retour en ligne ; chargement affiché seulement au-delà de 300 ms.
- [x] **Step 2 : Implémenter** — `useOnline`, `Banner`, branchement dans `api/client.ts` et `SessionProvider`.
- [x] **Step 3 : Vérifier** — tests, typecheck, lint.
- [x] **Step 4 : Commit** — `feat(lot1c): états communs, session expirée et hors ligne (M14)`.

### Task 13 : Accessibilité, README et vérification finale

- [x] **Step 1 : Écrire la suite d'accessibilité (échoue tant qu'une violation existe)** — `a11y.spec.ts` : `axe-core` sur chaque écran rendu (inscription, connexion, code, états, profil, sessions, mot de passe oublié), **aucune violation `serious` ou `critical`**, dans les deux thèmes ; vérification du lien « Aller au contenu », de l'ordre de tabulation sur le code à 6 cases, et du couple `aria-invalid` + `aria-describedby` sur chaque champ en erreur.
- [x] **Step 2 : README** — section « Application web » : variables (`VITE_TURNSTILE_SITEKEY`), développement en HTTPS, parcours de vérification manuelle (inscription → demande en attente ; administrateur → code dans Mailpit), rappel du contrat et des codes traduits.
- [x] **Step 3 : Vérification finale** — `pnpm lint`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:int` (aucune régression API), `pnpm depcruise`, `pnpm audit --audit-level high`, `pnpm --filter @classepulse/web build`. Mise à jour de la feuille de route (lot 1c terminé) et relecture de la couverture de la spec ci-dessous.
- [x] **Step 4 : Commit** — `feat(lot1c): accessibilité, README et vérification finale`.

## Critères de sortie du lot 1c

- Parcours **P1, P2 et P10 de bout en bout** dans le navigateur, contre l'API réelle et Mailpit, en HTTPS local.
- Écrans **M7, M8 et M14** (sans la suppression de compte, reportée au lot 2) conformes aux maquettes, dans les deux thèmes.
- **Zéro violation `serious` ou `critical`** détectée par axe sur les écrans livrés ; contraste vérifié par les tests de jetons existants.
- `pnpm test:unit` (projet `web` inclus), `pnpm lint`, `pnpm typecheck`, `pnpm depcruise` verts ; `pnpm test:int` sans régression ; build de production sans erreur.
- Aucune modification de l'API ni de la base ; `pnpm-lock.yaml` committé ; audit des dépendances vert.

## Couverture de la spec (auto-relecture)

| Exigence | Tâche |
|---|---|
| UX § 1.1 « Non connectée » : connexion · inscription · mot de passe oublié · code administrateur · confidentialité | 1, 5, 7, 8, 9 |
| UX § 1.1 « Connectée, sans classe active » : demande en attente, refusée, alternative | 6 |
| UX § 1.5 : une adresse par écran, boutons retour cohérents | 1, 12 |
| UX § 2 P1 : email saisi une fois, mot de passe en double, indicateur de longueur, refus des correspondances en quittant le champ, rien effacé, écran « Demande envoyée » | 3, 5 |
| UX § 2 P2 : message identique, Turnstile après échecs, 6 cases, compte à rebours, renvoi vers l'opérateur | 7, 8 |
| UX § 2 P10 : nom, mot de passe en double, sessions avec « Cet appareil » et « Déconnecter les autres appareils », préférences d'email, thème | 10, 11 |
| UX § 3.1 composants (champs, `OtpInput`, `Toast`/`Banner`, `EmptyState`, `Skeleton`) | 3, 8, 12 |
| UX § 3.2 états (chargement, vide, erreur, hors ligne, 401, 404, 429, 503) | 12, 6 |
| UX § 3.3 rédaction (tutoiement, cause sans accuser, confirmations nommant l'objet) | 5, 7, 10, 11 |
| UX § 4 identité visuelle B (jetons, bordures, rayons, pas de marqueur IA) | 3, 13 |
| UX § 5.1 accessibilité (libellés, focus, annonces, cibles, `lang="fr"`, lien d'évitement) | 1, 3, 13 |
| UX § 5.2 responsive (une colonne, 16 px, formulaires) | 3, 13 |
| UX § 5.3 : photo d'accueil réservée à l'ordinateur (emplacement sans photo, R7), police hébergée | 4 |
| § 3.1 origine unique, aucun CORS | 2, 4 |
| § 3.2 connexion : message identique, Turnstile après 3 échecs, mot de passe oublié (jeton, 30 min, réinitialisation) | 7, 9 |
| § 3.3 code administrateur (6 chiffres, 10 min, 5 essais, renvoi 60 s, opérateur pour la récupération) | 8 |
| § 3.4 sessions (liste, « déconnecter les autres appareils », 401 → reconnexion) | 11, 12 |
| § 3.5 CSRF sans modification (mêmes origines, aucun en-tête personnalisé) | 2 |
| Codes d'erreur du lot 1b traduits en français | 2, 13 |
