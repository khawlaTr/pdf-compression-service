# pdf-compression-service

Service HTTP autonome (Cloud Foundry, conteneur Docker) qui compresse des PDF
volumineux (jusqu'à ~1 Go) avec Ghostscript, pour rester sous une limite EDI de
100 Mo une fois encodés en base64. Appelé directement par une iFlow **SAP CPI
(Integration Suite)** — voir [docs/cpi-integration.md](docs/cpi-integration.md)
pour le pattern d'appel côté CPI. Ce projet est autonome : pas de dépendance à
une app CAP ni à un Object Store.

## Architecture en bref

- Un seul endpoint métier, `POST /compress`, qui bascule automatiquement entre
  deux modes selon la taille (`Content-Length`) :
  - **synchrone** (`<= SYNC_MAX_BYTES`, défaut 20 Mo) : la requête reste ouverte
    le temps de la compression, réponse `200` avec le résultat directement.
  - **asynchrone** (au-delà) : réponse immédiate `202 {jobId}`, à interroger via
    `GET /jobs/:jobId` jusqu'à `status: "done"`, puis `GET /jobs/:jobId/result`
    pour récupérer le PDF compressé.
- Chaque upload est streamé vers un fichier temporaire sur le disque éphémère
  de l'instance (jamais bufferisé entièrement en mémoire), traité par
  Ghostscript en ligne de commande, puis nettoyé après lecture du résultat ou
  au bout de `RESULT_TTL_SEC`.
- Sécurisé par XSUAA : tout appel (hors `/health`) doit porter un jeton Bearer
  avec le scope `Compress`, obtenu par CPI via OAuth2ClientCredentials.

## API

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/health` | Healthcheck CF, sans authentification |
| `POST` | `/compress` | Soumet un PDF (corps = stream binaire). `?preset=/screen\|/ebook\|/printer` pour surcharger le preset Ghostscript par défaut ; `?async=true` pour forcer le mode asynchrone |
| `GET` | `/jobs/:jobId` | Statut + résultat d'un job asynchrone |
| `GET` | `/jobs/:jobId/result` | Télécharge le PDF compressé une fois `status: "done"` |
| `DELETE` | `/jobs/:jobId` | Annule/nettoie un job |

Réponse type (200 ou `GET /jobs/:jobId` une fois terminé) :

```json
{
  "jobId": "…",
  "status": "done",
  "originalSize": 734003200,
  "compressedSize": 11534336,
  "base64Size": 15379115,
  "ratio": 0.9843,
  "withinLimit": true,
  "lowGain": false
}
```

`lowGain: true` signale un PDF déjà optimisé (texte/vecteurs, peu d'images) —
ce n'est pas une erreur, juste un signal que le gain de compression est faible.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8080` | Port d'écoute |
| `GS_BIN` | `gs` | Binaire Ghostscript |
| `GS_PDFSETTINGS` | `/ebook` | Preset par défaut (`/screen`, `/ebook`, `/printer`) — ajustable par `cf set-env` + restage, sans reconstruire l'image |
| `GS_TIMEOUT_SEC` | `180` | Timeout du process Ghostscript |
| `MAX_CONCURRENT_JOBS` | `2` | Compression simultanées max (Ghostscript est CPU/mémoire-intensif) |
| `SYNC_MAX_BYTES` | `20971520` (20 Mo) | Seuil sync/async |
| `BASE64_LIMIT_BYTES` | `104857600` (100 Mo) | Limite EDI cible pour `withinLimit` |
| `MIN_GAIN_RATIO` | `0.05` | En dessous, `lowGain: true` |
| `RESULT_TTL_SEC` | `1800` | Durée de rétention d'un job terminé avant nettoyage forcé |
| `TMP_DIR` | `/tmp/gs-jobs` | Racine des fichiers temporaires |
| `AUTH_DISABLED` | `false` | **Dev/test uniquement** — désactive la vérification XSUAA |

## Build & déploiement

L'image Docker est construite automatiquement par GitHub Actions
(`.github/workflows/docker-build.yml`) à chaque push sur `main`, et publiée
sur GitHub Container Registry (`ghcr.io/khawlatr/pdf-compression-service`) —
pas besoin de Docker en local. Voir aussi
[docs/cpi-integration.md](docs/cpi-integration.md) pour la suite côté
Integration Suite.

```bash
# 1. Pousser le code (déclenche le build+push de l'image via CI)
git push origin main

# 2. Rendre le package GHCR accessible à Cloud Foundry (une seule fois) :
#    GitHub > votre profil > Packages > pdf-compression-service > Package settings
#    > Change visibility > Public. Sinon (package privé), cf push devra
#    fournir un Personal Access Token GitHub (scope read:packages) via
#    --docker-username et CF_DOCKER_PASSWORD (voir README section suivante).

# 3. Créer l'instance XSUAA (une seule fois)
cf create-service xsuaa application pdf-compression-xsuaa -c xs-security.json

# 4. Déployer (manifest.yml pointe déjà vers l'image GHCR)
cf push -f manifest.yml
```

Voir [docs/cpi-integration.md](docs/cpi-integration.md) pour la suite côté
Integration Suite (service key XSUAA → credential OAuth2ClientCredentials →
HTTP Receiver Adapter → pattern de polling).

## Tests

```bash
# Lancer le serveur en local sans XSUAA pour tester
AUTH_DISABLED=true npm start

# Script CLI: compresse un PDF réel et affiche le rapport
node test/compress-and-report.js /chemin/vers/fichier.pdf

# Images dupliquées (logos, QR codes) — voir l'en-tête du fichier pour générer
# une fixture, puis:
node --test test/duplicate-images.test.js

# Test de charge ~1 Go (surveille aussi la mémoire CF si un nom d'app est fourni)
./test/load-test-1gb.sh /chemin/vers/fichier-1go.pdf [nom-app-cf]
```

## Points d'attention traités

- **Timeout CF / gros fichiers** : mode asynchrone job + polling (voir
  ci-dessus), pas d'appel HTTP synchrone bloquant au-delà de `SYNC_MAX_BYTES`.
- **Mémoire** : Ghostscript alloue de la mémoire proportionnellement à la page
  la plus lourde à rastériser, pas à la taille totale du document — un PDF de
  1 Go sur de nombreuses pages ne charge pas 1 Go en RAM d'un coup. `memory`/
  `disk_quota` dans `manifest.yml` sont volontairement généreux (1536M/4096M) ;
  à surveiller en charge réelle et à ajuster si un OOM apparaît malgré tout —
  un découpage par lot de pages (`qpdf`/`pdftk` en amont) serait la prochaine
  étape si nécessaire, non implémenté ici.
- **PDF déjà optimisé** : signalé explicitement via `lowGain`, jamais un échec.
- **Nettoyage** : `try/finally` autour de chaque job + purge de `TMP_DIR` au
  démarrage du process (couvre le cas d'un crash/redeploy en plein
  traitement) + TTL de rétention (`RESULT_TTL_SEC`) pour les résultats jamais
  récupérés par l'appelant.

## Limites connues

- **État des jobs en mémoire uniquement** : un redémarrage/redeploy du
  conteneur en plein traitement perd l'état des jobs en cours (et les fichiers
  temporaires associés, purgés au redémarrage). Un `GET /jobs/:jobId` sur un
  job perdu répond `404` — l'iFlow CPI doit traiter ce cas comme un échec
  définitif et resoumettre le PDF d'origine plutôt que d'attendre indéfiniment
  (voir docs/cpi-integration.md). Si une durabilité plus forte est nécessaire
  (jobs qui survivent à un redeploy), la prochaine étape serait de persister
  l'état des jobs (fichier JSON à côté du PDF, ou service externe) — non fait
  ici pour garder le service simple, à reconsidérer si les redeploys en
  production s'avèrent fréquents.
- **`@sap/xssec` non testé contre un tenant XSUAA réel dans cet environnement**
  (pas d'accès BTP live ici) — vérifier le comportement exact de
  `middleware/auth.js` (noms de méthodes de l'API `SecurityContext`) une fois
  déployé, avant de considérer la sécurisation validée.
