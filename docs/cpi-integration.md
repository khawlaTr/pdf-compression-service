# Intégration côté SAP CPI (Integration Suite)

Ce service n'a pas de client CAP : il est appelé **directement par une iFlow CPI**
dans le flux EDI, en HTTPS, sécurisé par un jeton XSUAA obtenu via
OAuth2ClientCredentials. CPI tourne hors du space Cloud Foundry de ce service :
la route ne peut donc pas être `apps.internal`, elle doit être une route CF
publique classique, protégée uniquement par la validation du jeton (voir
`src/middleware/auth.js`).

## 1. Préparer les credentials côté BTP

1. Créer l'instance XSUAA avec `xs-security.json` :
   ```bash
   cf create-service xsuaa application pdf-compression-xsuaa -c xs-security.json
   ```
2. Créer une service key dessus pour récupérer `clientid`/`clientsecret`/`url` :
   ```bash
   cf create-service-key pdf-compression-xsuaa cpi-key
   cf service-key pdf-compression-xsuaa cpi-key
   ```
3. Ces trois valeurs alimentent l'Integration Suite (étape suivante). **Correction
   suite à un test réel** : un jeton `client_credentials` contre XSUAA ne porte
   *pas* automatiquement les scopes définis dans `xs-security.json` (vérifié en
   décodant un vrai jeton : `scope: ["uaa.resource"]` uniquement) — les scopes
   personnalisés sont un mécanisme utilisateur/rôle, sans effet sur ce flux
   machine-à-machine. L'autorisation ici repose simplement sur le fait que
   seul le détenteur du `clientsecret` de cette instance XSUAA précise peut
   obtenir un jeton qui vérifie correctement — voir `src/middleware/auth.js`.
   Aucun rôle/scope à configurer côté CPI.

## 2. Configurer l'Integration Suite

- **Security Material > OAuth2ClientCredentials** : créer une credential avec
  le `clientid`/`clientsecret`/`token endpoint (url + /oauth/token)` de la
  service key ci-dessus.
- **HTTP Receiver Adapter** de l'iFlow qui appelle ce service :
  - Adresse : `https://pdf-compression-service.<landscape>.cfapps.<region>.hana.ondemand.com/compress`
  - Authentication : `OAuth2ClientCredentials`, credential créée ci-dessus.
  - Method : `POST`.
  - Content-Type : `application/pdf`/`application/octet-stream` si le corps
    du message est déjà le PDF brut, ou `multipart/form-data` si l'iFlow
    construit la requête elle-même (ex. script Groovy) avec un champ fichier
    nommé `fileInput` et, en option, un champ texte `expectedOutputSize`
    (ex. `"10MB"`) — les deux formats sont supportés par `/compress`, aucune
    configuration côté service à changer selon le format choisi.

## 3. Pattern d'appel dans l'iFlow

Le endpoint `/compress` décide seul du mode sync/async selon la taille — l'iFlow
n'a qu'à brancher sur le code HTTP retourné :

```
[Start] → [HTTP Receiver: POST /compress] → [Router]
              │
              ├─ 200 (sync, petit fichier) ──────────────► corps = PDF compressé directement,
              │                                             metadonnees dans les en-tetes X-*
              │                                             (X-Within-Limit, X-Ratio, ...)
              │
              └─ 202 (async, gros fichier) → [extraire jobId du JSON]
                                            → [Local Integration Process: boucle Poll-Enrich]
                                                 │
                                                 ├─ GET /jobs/{jobId} toutes les N secondes
                                                 │  (reponse JSON — Content Modifier + Router:
                                                 │   status == "done"?)
                                                 │
                                                 └─ une fois "done": GET /jobs/{jobId}/result
                                                    → corps = PDF compresse, memes en-tetes X-*
```

Dans les deux cas où le corps est le PDF (`200` direct, ou `GET .../result`),
lisez les métadonnées dans les en-têtes de réponse plutôt que dans le corps —
un Content Modifier peut les copier en propriétés du message pour le `Router`
qui suit (`${header.X-Within-Limit}`, etc.).

Points d'implémentation CPI à prévoir explicitement :

- **Boucle de polling** : un `Local Integration Process` avec une General
  Splitter ou un `Loop` (via un compteur en Content Modifier) + un `Router`
  testant `${property.status}`. Prévoir un **délai** (`Sleep`/timer step, ou
  Content Modifier + wait) entre chaque poll pour ne pas marteler le service —
  2 à 5 s est raisonnable vu les temps de traitement attendus (dizaines de
  secondes pour un fichier proche de 1 Go).
- **Timeout global** : compter les itérations de la boucle et sortir en échec
  après un plafond (ex. 200 itérations × 3 s ≈ 10 min) plutôt qu'une boucle
  infinie, avec un `Exception Subprocess` qui notifie l'échec au flux métier.
- **Job introuvable après un redéploiement du service** : l'état des jobs vit
  en mémoire dans le conteneur (voir README, section "Limites connues") — un
  `GET /jobs/{jobId}` sur un job perdu répond `404`. La boucle de polling doit
  traiter ce cas comme un échec définitif (pas une raison de continuer à
  poller), et le flux métier EDI doit pouvoir **resoumettre le PDF d'origine**
  depuis le début plutôt que d'attendre un job qui n'existe plus.
- **`withinLimit: false`** : le flux métier doit gérer explicitly ce cas
  (alerte, mise en attente manuelle, etc.) — ce n'est pas une erreur HTTP mais
  un champ du résultat à tester dans un `Router` après réception.
