# Jeux entre amis : Poker ♠ et Poulpe 🐙

Deux jeux en ligne sur le même site : chacun joue depuis son ordinateur ou son téléphone, avec un simple lien.
Plusieurs tables en même temps, aucun compte à créer pour jouer. Aucun argent réel.

- Page d'accueil : `/` (choix du jeu)
- Poker (Texas Hold'em, 2 à 20 joueurs) : `/poker`
- Poulpe (jeu de plis, 2 à 20 joueurs) : `/poulpe`

## Contenu
- `server.js` : le serveur principal + règles du poker
- `poulpe.js` : les règles du jeu Poulpe
- `public/index.html` : page d'accueil ; `public/poker.html` et `public/poulpe.html` : les deux jeux
- `package.json`, `render.yaml`, `.gitignore` : configuration

## Tester chez toi (facultatif)
1. Installe Node.js (nodejs.org, version LTS).
2. Dans le dossier : `npm install` puis `npm start`
3. Ouvre http://localhost:3000 dans plusieurs onglets pour simuler plusieurs joueurs.

## Mettre en ligne GRATUITEMENT (Render)
1. Crée un compte gratuit sur github.com, puis un nouveau dépôt (« New repository »), nom : `poker-entre-amis`.
2. Sur la page du dépôt : « Add file » → « Upload files », glisse-y ces fichiers et dossiers
   (SANS le dossier node_modules) : `server.js`, `poulpe.js`, `package.json`, `render.yaml`, `.gitignore`, et le dossier `public`.
   Clique sur « Commit changes ».
3. Crée un compte gratuit sur render.com (connexion possible avec GitHub).
4. Clique sur « New + » → « Web Service » → choisis ton dépôt `poker-entre-amis`.
5. Réglages : Runtime `Node`, Build Command `npm install`, Start Command `npm start`, Instance Type `Free`.
   Clique sur « Create Web Service ».
6. Après quelques minutes, Render te donne une adresse du type https://poker-entre-amis.onrender.com .
   C'est le lien à envoyer à tes amis.

## Bon à savoir
- Offre gratuite : le serveur s'endort quand personne ne joue. La première personne qui ouvre le lien attend
  environ une minute qu'il se réveille ; ensuite tout est fluide. Une partie en cours n'est pas perdue tant que
  des joueurs sont connectés.
- Si le serveur redémarre, les tables en cours sont perdues (rien n'est enregistré) : il suffit d'en recréer une.
- Pour jouer : un joueur clique sur « Créer une table », copie le lien d'invitation et l'envoie ; les autres
  entrent leur pseudo et cliquent sur « Rejoindre ». Le créateur (👑) lance la partie.

## Règles du poker
- Chacun commence avec 1000 jetons, blinds 10 / 20 (fixes).
- 30 secondes par décision (sinon check, ou couché s'il faut payer).
- Un joueur à sec peut « recaver » 1000 jetons.
- Un joueur qui rejoint en cours de main attend la main suivante.

## Règles de Poulpe
- Cartes de 1 à 60 + 4 Poulpes (jokers). Pas de couleur, pas d'atout.
- Un joueur distribue : il choisit le nombre de cartes (le même pour tout le monde).
- À sa gauche, chacun annonce le nombre de plis qu'il va gagner ; le distributeur parle en dernier et ne peut pas
  annoncer un nombre qui rend le total des annonces égal au nombre de cartes.
- Le joueur à gauche du distributeur ouvre, la carte la plus forte gagne le pli et ouvre le suivant.
- Un Poulpe se joue comme la carte la plus grande (bat tout) ou la plus petite (perd contre tout), au choix de celui qui le joue.
  Si plusieurs Poulpes sont joués en « plus » dans le même pli, le dernier Poulpe « plus » posé gagne.
- Fin de manche : chacun prend une barre par pli d'écart avec son annonce, en plus ou en moins
  (ex. : 5 annoncés, 3 réalisés = 2 barres).
- Une roue désigne le prochain distributeur. Celui qui a déjà distribué sort de la roue jusqu'à ce que
  tout le monde ait distribué, puis un nouveau tour commence (tout le monde revient, sauf le dernier distributeur).
- Fin de partie (nombre de manches choisi par l'hôte, de 1 à 30) : celui qui a le plus de barres perd.
  En cas d'égalité, les joueurs concernés tirent une carte ; celui qui a le plus grand chiffre fait tourner la roue pour les autres.
  Dans tous les cas, une roue de 1 à 30 est ensuite tournée pour le perdant.
