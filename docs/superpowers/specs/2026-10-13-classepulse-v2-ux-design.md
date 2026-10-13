# ClassePulse V2 — Conception UI/UX

| Élément | Valeur |
|---|---|
| Date | 2026-10-13 |
| Statut | Sections 1 à 6 validées. Maquettes M1 à M14 validées. |
| Référence fonctionnelle | `docs/superpowers/specs/2026-10-13-classepulse-v2-design.md` (aucune règle métier ajoutée ici) |
| Livrables | Ce document, puis les maquettes clés dans `docs/design/mockups/` (HTML statique, versionné) |

## 0. Cadre

| Sujet | Décision |
|---|---|
| Appareils | Mobile et ordinateur traités avec le même soin. Console d'administration surtout sur ordinateur, mais utilisable sur mobile. |
| Lien avec la V1 | Refonte libre : la V1 n'est qu'une référence fonctionnelle. |
| Identité | Propre à ClassePulse, indépendante de l'école. |
| Ton | Base sobre et lisible, avec une touche de chaleur. **Aucun marqueur « style IA » générique** (voir § 4.6). |
| Thèmes | Clair et sombre dès le MVP. Le thème suit le réglage de l'appareil, avec un choix manuel dans le profil. |
| Registre | **Tutoiement partout** : application, console d'administration et emails. |
| Hypothèse à vérifier pendant le pilote | Connexion mobile parfois lente ou coûteuse. |

---

## 1. Architecture de l'information et navigation

### 1.1 Espaces selon le statut
| Statut | Ce que la personne voit |
|---|---|
| Non connectée | Connexion · Inscription · Mot de passe oublié · Code administrateur · Confidentialité |
| Connectée, sans classe active | Écran d'état seulement : demande en attente ; demande refusée (motif éventuel, date à partir de laquelle refaire une demande) ; retrait ; classe archivée. Accès au profil et à la déconnexion. |
| Étudiant | Application de la classe |
| Délégué | Application de la classe, plus la **Gestion** |
| Administrateur | **Console** séparée. Il n'est membre d'aucune classe. |

### 1.2 Application de la classe
**Mobile : barre d'onglets en bas**

| Onglet | Contenu |
|---|---|
| Accueil | Tableau de bord « Aujourd'hui » |
| Devoirs | À faire · Passés. Filtres par matière et par statut. Recherche. Corbeille pour les délégués. |
| Ressources | Documents · Annales · Cours enregistrés. Filtres par matière et par type, tri par date. Recherche. |
| Classe | Sous-onglets **Chat** et **Annonces**. Annonce épinglée en haut du chat. |
| Plus | Profil · Préférences d'email · Sessions actives · Thème · Confidentialité · Assistant (lien de secours) · Déconnexion. Pour un délégué, **Gestion** en tête de liste, avec un badge du nombre de demandes en attente (badge repris sur l'onglet Plus). |

- **Barre du haut** : nom de la classe, cloche des notifications avec le compteur de non-lus, bandeau « Connexion perdue » le cas échéant.
- **Ordinateur** : les mêmes entrées dans une barre latérale. Pour un délégué, Gestion y est une entrée à part entière.
- **Gestion (délégué)** : Demandes · Membres (avec emails) · Matières · Statistiques de la classe.

### 1.3 Assistant IA : bouton flottant
| Règle | Détail |
|---|---|
| Présent sur | Accueil, Devoirs, Ressources et leurs fiches |
| Masqué sur | Chat et Annonces, formulaires, écrans de connexion et d'état, console d'administration |
| Position | En bas à droite, au-dessus de la barre d'onglets. Les listes gardent un espace vide en bas pour que rien ne soit caché. |
| Ouverture | Mobile : panneau qui monte du bas (environ 90 % de la hauteur), fermé par glissement. Ordinateur : panneau latéral à droite. |
| Indisponible ou quota atteint | Le bouton reste visible ; le panneau explique pourquoi et quand l'assistant revient. |
| Accessibilité | Libellé « Ouvrir l'assistant », cible de 56 px, place logique dans l'ordre du clavier, focus retenu dans le panneau, fermeture par Échap. |
| Secours | Lien « Assistant » dans le menu Plus. Historique accessible depuis le panneau. |

### 1.4 Console d'administration
- **Barre latérale** : Vue d'ensemble (totaux, état des emails et des traitements planifiés, consommation de l'IA) · Classes · Utilisateurs (recherche, suspension, rôle administrateur, anonymisation) · Changement d'année.
- **Fiche de classe** : sélecteur de contexte « Classe : … ▾ » toujours visible ; mêmes vues que l'application (devoirs, ressources, chat, en modération), plus la gestion, les statistiques et la **nomination des délégués** (l'administrateur nomme les délégués). Une classe archivée porte le badge « Lecture seule » partout.
- **Actions critiques** (promotion ou rétrogradation, suspension, anonymisation, transfert en masse, archivage) : fenêtre de vérification supplémentaire (mot de passe, puis code) avant l'exécution.
- Sur mobile, la barre latérale devient un menu.

### 1.5 Règles communes
- Chaque écran a une adresse propre (par exemple `/devoirs/<id>`).
- Une notification ouverte mène à l'écran normal de l'élément ; une notification non accessible reste affichée, grisée, avec « Plus disponible ».
- Perte d'accès (`access.revoked`) : retour immédiat à l'écran d'état, avec la raison.
- Les boutons retour du téléphone et du navigateur se comportent de la même façon.

---

## 2. Parcours principaux

| # | Parcours | Points d'interface |
|---|---|---|
| P1 | Inscription et admission | Prénom, nom, email **saisi une seule fois**, avec l'aide « Tes rappels et la récupération de ton compte arriveront à cette adresse : vérifie-la bien » (décision du 2026-10-13, qui modifie § 0.3 de la spécification), mot de passe **saisi deux fois**, classe parmi les classes actives, Turnstile. Indicateur « 15 caractères minimum » sans jauge de force. Bouton « Afficher » sur chaque champ de mot de passe. Erreur de correspondance affichée en quittant le second champ. Écran « Demande envoyée » rappelant l'email. Refus : motif éventuel et date de nouvelle demande. Contenu saisi jamais effacé après une erreur. |
| P2 | Connexion | Message d'erreur identique dans tous les cas. Turnstile après plusieurs échecs. Administrateur : écran « Code envoyé » à 6 cases (collage accepté), compte à rebours de 10 min, « Renvoyer » désactivé 60 s ; en cas de problème, l'écran renvoie vers un opérateur (le code de récupération n'est jamais en libre-service). |
| P3 | Consulter et cocher un devoir | Fiche : matière, consigne, échéance, urgence, ressources liées. « Marquer comme terminé » immédiat et réversible. Après l'échéance : bouton désactivé avec « Échéance passée », mais « Annuler terminé » possible. |
| P4 | Gérer un devoir (délégué) | Échéance affichée « heure de Dakar ». Confirmation que la classe a été notifiée. Suppression : « Le devoir ira dans la corbeille pendant 30 jours », message avec « Annuler », restauration depuis la corbeille. |
| P5 | Ajouter une ressource | Lien vérifié à la saisie (raison du refus affichée). Fichier : barre de progression, « Vérification… », visible pour la classe une fois prêt, rejet expliqué avec nouvel envoi. Annale : année et type d'examen obligatoires. Quota atteint : refus avant l'envoi, avec l'espace restant. |
| P6 | Chat et annonces | Message affiché immédiatement (« Envoi… ») ; échec : « Non envoyé — Réessayer » avec le même identifiant. Suppression par appui long (mobile) ou menu « ⋯ » (ordinateur) ; trace « Message supprimé ». Annonce : case « Envoyer aussi par email » avec le nombre d'envois restants ; épinglage en haut du chat. |
| P7 | Notifications | Panneau (ordinateur) ou écran (mobile). Ouverture = lue + navigation. « Tout marquer comme lu ». Notification non accessible grisée. |
| P8 | Gestion (délégué) | Demandes : fiche avec l'email, Accepter / Refuser (motif facultatif, confirmation « décision définitive »). Retrait d'un membre avec motif facultatif. Matières : suppression désactivée si utilisée, avec la raison. Statistiques simples. |
| P9 | Changement d'année (administrateur) | Assistant en 4 étapes : créer la classe ; cocher les étudiants (tous cochés par défaut, recherche) ; archiver ; copier les annales. Vérification supplémentaire pour le transfert et l'archivage. Récapitulatif avant confirmation, compte rendu à la fin. |
| P10 | Profil et compte | Nom ; mot de passe (nouveau mot de passe saisi deux fois) ; sessions actives avec « Cet appareil » et « Déconnecter les autres appareils » ; préférences d'email ; thème. Suppression du compte : écran expliquant ce qui est conservé sous un nom anonyme, confirmation par mot de passe. |
| P11 | Assistant | 3 suggestions selon l'écran. Mention discrète du fournisseur d'IA, avec lien vers Confidentialité. Réponses en texte ; liens uniquement vers des écrans de l'application. |

La double saisie du mot de passe s'applique aussi à « Nouveau mot de passe » (après « Mot de passe oublié »). La connexion garde un seul champ.

---

## 3. Composants et états

### 3.1 Composants
| Famille | Composants |
|---|---|
| Structure | `AppShell` · `AdminShell` (barre de contexte, badge « Lecture seule ») · `AssistantFab` + `AssistantPanel` · `Sheet` / `Dialog` · `StepUpDialog` · `Wizard` |
| Affichage | `UrgencyBadge` (couleur + texte + repère, jamais la couleur seule) · `TaskCard` · `ResourceCard` · `PinnedAnnouncement` · `ChatMessage` (envoi, échec, supprimé ; badges Délégué / Administration) · `NotificationItem` · `RequestCard` · `MemberRow` · `StatTile` · `EmptyState` · `Skeleton` |
| Saisie | `TextField` · `PasswordField` · `OtpInput` · `DateTimeField` (« heure de Dakar ») · `SubjectSelect` · `FilterChips` · `SearchField` · `FileUpload` (progression, quota) · `Checkbox` · `Switch` · `SegmentedTabs` |
| Retours | `Toast` (avec « Annuler » si possible) · `Banner` (connexion perdue, lecture seule, assistant indisponible, maintenance) · `InlineAlert` · `CountBadge` |

Textes de l'urgence : « Dans 6 jours », « Dans 3 jours », « Demain 08:00 », « Aujourd'hui 18:00 », « 3 h restantes ». La règle de calcul est la fonction partagée de la spécification.

### 3.2 États communs
| État | Comportement |
|---|---|
| Chargement | Formes grises imitant la page, affichées seulement au-delà de 300 ms |
| Vide | `EmptyState` adapté au rôle (par exemple « Aucun devoir à venir », avec « Créer un devoir » pour un délégué) |
| Erreur | Message simple, « Réessayer », numéro de demande en petit |
| Introuvable (`404`) | « Cet élément n'existe pas ou n'est plus disponible », identique pour une autre classe |
| Hors ligne | Bandeau « Connexion perdue — reconnexion… » ; dernières données affichées avec « Mis à jour à 10:42 » ; écritures désactivées avec la raison |
| Lecture seule | Bandeau ; actions d'écriture masquées |
| Accès retiré | Écran d'état avec la raison |
| Session expirée (`401`) | Connexion, puis retour à l'écran d'origine |
| Trop de requêtes (`429`) | Message avec compte à rebours |
| Classe archivée (`409`) | « Cette classe est archivée : modification impossible » |
| Désynchronisation (`410`) | Rechargement automatique, sans message bloquant |
| Maintenance (`503`) | Page de maintenance avec nouvel essai automatique |

### 3.3 Rédaction
- Tutoiement, phrases courtes, voix active, ce qu'il faut faire ensuite. Pas de jargon technique.
- Erreurs : la cause, sans accuser. Exemple : « Ce lien n'est pas autorisé : seuls Google Drive et Docs sont acceptés. »
- Confirmations destructives : nommer l'objet. Exemple : « Supprimer le devoir “TP Réseaux” ? »
- Dates relatives quand elles sont proches (« Demain 08:00 »), absolues au-delà d'une semaine.

---

## 4. Identité visuelle — direction B « Chaleureux »

### 4.1 Couleurs
| Rôle | Clair | Sombre |
|---|---|---|
| Fond | `#FFF9F4` (crème) | `#1A1411` (brun nuit) |
| Barre latérale | `#FFFFFF` | `#1F1814` |
| Surface (cartes) | `#FFFFFF` | `#241C18` |
| Encre (texte) | `#2A211C` | `#F6EDE6` |
| Texte secondaire | `#8C7E73` | `#B3A398` |
| Traits | `#F0E3D8` | `#382B24` |
| Traits appuyés | `#DFCBBB` | `#54443A` |
| Navigation active | `#FCEBE1` | `#33241D` |
| **Principale (terre cuite)** | `#C2461F`, texte blanc dessus | `#E8703F`, texte `#1A1411` dessus ; liens `#F08A5D` |
| Urgence rouge / jaune / vert | `#B42318` / `#A15C07` / `#1E7A46` | `#FF8A7A` / `#F2C063` / `#72D49B` |

- Toutes les combinaisons texte/fond visent au moins 4,5:1 ; les éléments d'interface au moins 3:1. La terre cuite claire est volontairement foncée pour que le texte blanc des boutons reste lisible.
- **Repères de matière** (8 teintes attribuées automatiquement) : Indigo `#4C5FD5`, Prune `#8E44AD`, Sapin `#1F8A5B`, Ocre `#B7791F`, Pétrole `#1F6F8B`, Framboise `#C2416B`, Olive `#6B7F2A`, Ardoise `#5B6573`. En thème sombre, des variantes éclaircies de même teinte. Une matière est toujours affichée par un petit carré de couleur **suivi de son nom**.

### 4.2 Typographie
- **Figtree**, hébergée par l'application (CSP), graisses 400, 600 et 800, caractères latins, woff2.
- Échelle : titre de page 28 (800) · titre de section 20 (700) · titre de carte 16 (600) · texte courant 16 (400) · texte secondaire 13.
- Texte courant et champs à 16 px minimum sur mobile.

### 4.3 Formes et espacements
- Grille de 4 px.
- Rayons : cartes 14–16 px, boutons et champs 12 px, pastilles 999 px.
- **Bordures fines plutôt qu'ombres.** Une seule ombre, légère, pour les éléments flottants (bouton de l'assistant, panneaux).

### 4.4 Éléments de marque
- **Logo** : le mot « Classe**Pulse** » en Figtree ExtraBold, « Pulse » en terre cuite, sans pictogramme. Version courte « CP » pour l'icône d'onglet et d'application.
- **Bandeau d'accueil** : aplat terre cuite, titre « Bonjour <prénom> » et une phrase de résumé de la semaine.
- **Icônes** : style trait fin (1,8 px), cohérent sur tout le produit. L'assistant est représenté par une **bulle avec un point d'interrogation**.

### 4.5 Boutons
Principal (terre cuite plein) · Secondaire (fond blanc, trait appuyé) · Lien (texte terre cuite) · Destructif (rouge plein, libellé qui nomme l'objet).

### 4.6 À éviter (marqueurs « style IA » générique)
Icône étincelle pour l'IA · dégradés décoratifs, halos et textes en dégradé · cartes translucides · emoji dans les titres · pastilles pastel partout · ombres douces sur toutes les cartes · logo carré en dégradé · chiffres décoratifs sans utilité.

---

## 5. Accessibilité, responsive et performance

### 5.1 Accessibilité (WCAG 2.2 AA ; aucune violation axe sérieuse ou critique)
- Contraste : 4,5:1 pour le texte, 3:1 pour les icônes, bordures de champs et contour de focus, dans les deux thèmes.
- Jamais la couleur seule.
- Clavier : toutes les actions ; lien « Aller au contenu » ; contour de focus visible (2 px terre cuite, décalé) ; Échap, focus retenu puis rendu dans les panneaux.
- Lecteurs d'écran : zones balisées, titres hiérarchisés, icônes décoratives ignorées, compteurs lisibles ; messages courts annoncés poliment, erreurs annoncées immédiatement et liées à leur champ.
- Chat : nouveaux messages annoncés de façon regroupée (« 2 nouveaux messages »).
- Cibles : 44 px minimum, 56 px pour le bouton de l'assistant.
- Formulaires : libellés visibles ; champs reconnus par les gestionnaires de mots de passe (email, nouveau mot de passe, mot de passe actuel, code reçu) ; clavier numérique pour le code.
- Animations de 200 ms au plus, supprimées si l'appareil demande moins d'animations.
- Texte agrandi à 200 % sans défilement horizontal à 320 px ; langue déclarée en français.

### 5.2 Responsive
| Largeur | Disposition |
|---|---|
| < 640 px | Barre d'onglets, bouton de l'assistant, une colonne |
| 640 à 1023 px | Barre latérale réduite aux icônes (libellés en infobulle), une colonne élargie |
| ≥ 1024 px | Barre latérale complète ; Accueil sur deux colonnes |
| ≥ 1440 px | Contenu limité à 1 200 px et centré ; chat limité à 760 px |

- Tailles testées : 360×640, 390×844, 768×1024, 1280×800.
- iPhone : la barre d'onglets tient compte de la zone de l'indicateur d'accueil.
- Clavier virtuel ouvert : bouton de l'assistant masqué ; saisie du chat visible au-dessus du clavier.
- Console : tableaux transformés en listes de cartes sur mobile.

### 5.3 Performance
- Polices hébergées par l'application, 3 graisses, police de secours pendant le chargement.
- Chargement par section ; console d'administration jamais téléchargée par les étudiants ; panneau de l'assistant chargé à sa première ouverture.
- Aucune image décorative, **sauf une exception** : une vraie photo d'étudiants sur les pages de connexion et d'inscription, **sur ordinateur uniquement** (≥ 1 024 px). Elle est hébergée par l'application, au format AVIF ou WebP, de 150 Ko au plus, et n'est jamais téléchargée sur mobile. Elle est ignorée par les lecteurs d'écran. Source : photos réelles de l'ESP prises avec l'accord des personnes, ou banque d'images sous licence vérifiée.
- Illustrations des états vides en petits dessins vectoriels (< 3 Ko) ; icônes incluses seulement si utilisées.
- Aucun aperçu de fichier généré ; un document n'est téléchargé que s'il est ouvert.
- **Objectifs, mesurés pendant le pilote** (Android d'entrée de gamme, 4G lente) : code initial < 200 Ko compressés ; contenu principal affiché en moins de 2,5 s ; réaction à une action en moins de 200 ms ; mise en page stable. Ce sont des objectifs, pas des garanties, et ils n'ajoutent aucun contrôle bloquant à l'intégration continue.

---

## 6. Maquettes clés

Direction B, contenus réels en français et au tutoiement, états importants inclus. Tailles de référence : 390 px (mobile) et 1 280 px (ordinateur). Fichiers HTML statiques, validés lot par lot :

- `docs/design/mockups/lot1-etudiant.html` (M1 à M6)
- `docs/design/mockups/lot2-acces.html` (M7, M8)
- `docs/design/mockups/lot3-delegue.html` (M9, M10)
- `docs/design/mockups/lot4-administration.html` (M11 à M13)
- `docs/design/mockups/m14-etats-profil.html` (M14)

Précisions issues des maquettes : sur les écrans Ressources et Devoirs, « Ajouter » / « Nouveau » est dans la barre du haut (le bouton flottant reste à l'assistant) ; l'écran de refus propose « Demander une autre classe » ; l'email est en lecture seule dans le profil d'un étudiant.

| # | Écran | Formats | États |
|---|---|---|---|
| **Lot 1 — Étudiant** | | | |
| M1 | Accueil « Aujourd'hui » | Mobile + ordinateur, clair et sombre | Normal ; aucun devoir à venir |
| M2 | Devoirs : liste et fiche | Mobile + ordinateur | À faire / Passés, filtres, recherche ; « Terminé » ; échéance passée |
| M3 | Ressources : liste et ajout | Mobile + ordinateur | Lien refusé ; envoi ; « Vérification… » ; rejet ; quota atteint |
| M4 | Classe : chat et annonces | Mobile + ordinateur, clair et sombre | Annonce épinglée ; badges ; « Envoi… » ; « Non envoyé — Réessayer » ; « Message supprimé » ; connexion perdue |
| M5 | Notifications | Panneau (ordinateur), écran (mobile) | Non lue ; lue ; « Plus disponible » |
| M6 | Assistant | Bouton + panneau | Suggestions ; réponse ; mention de confidentialité ; indisponible |
| **Lot 2 — Accès** | | | |
| M7 | Inscription et écrans d'état | Mobile + ordinateur (photo à gauche) | Mot de passe en double ; erreurs ; demande envoyée ; refus avec date |
| M8 | Connexion et code administrateur | Mobile + ordinateur | Erreur ; 6 cases ; compte à rebours ; « Renvoyer » désactivé |
| **Lot 3 — Délégué** | | | |
| M9 | Gestion | Mobile + ordinateur | Refus avec motif ; confirmation définitive ; suppression de matière désactivée |
| M10 | Créer / modifier un devoir, corbeille | Mobile + ordinateur | « Heure de Dakar » ; « Annuler » ; restauration |
| **Lot 4 — Administration** | | | |
| M11 | Vue d'ensemble | Ordinateur + aperçu mobile | Totaux ; emails et traitements ; IA |
| M12 | Fiche de classe | Ordinateur | Sélecteur de contexte ; « Lecture seule » ; nomination des délégués |
| M13 | Changement d'année et vérification supplémentaire | Ordinateur | 4 étapes ; récapitulatif ; mot de passe puis code |
| **Commun** | | | |
| M14 | Planche des états, profil et sessions | Mobile | Chargement, vide, erreur, hors ligne, introuvable, trop de requêtes, maintenance ; sessions ; suppression de compte |
