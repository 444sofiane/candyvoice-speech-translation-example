# Exemple d'intégration — traduction vocale CandyVoice en visioconférence

Ce dépôt montre une intégration complète de la route de traduction vocale en
direct de CandyVoice (`/ws/speech-translation`) dans une application de
visioconférence. Il complète le guide d'intégration Kizwork : chaque
recommandation du guide est appliquée dans le code, que vous pouvez reprendre
tel quel.

Pour rester simple, il n'y a pas de réseau entre participants : toute la salle
tient dans un onglet, et le micro de l'ordinateur est attribué au participant
qui parle. Les échanges avec CandyVoice sont, eux, exactement ceux d'une
intégration réelle.

## Démarrage rapide

Prérequis : Node.js 18 ou plus récent, une clé API CandyVoice (`cvk_…`).

```bash
git clone <ce dépôt>
cd IntegrationTest
cp .env.example .env     # renseignez CANDYVOICE_API_KEY
npm install
npm start                # http://127.0.0.1:8090
```

| Variable | Rôle |
|---|---|
| `CANDYVOICE_API_KEY` | Votre clé `cvk_…`. Elle reste côté serveur et n'est jamais envoyée au navigateur. |
| `CANDYVOICE_API_URL` | `https://saas-api.candyvoice.com` (par défaut) |
| `INTEGRATION_HOST` / `INTEGRATION_PORT` | Adresse d'écoute, `127.0.0.1:8090` par défaut |

Le navigateur n'autorise le micro que sur `localhost` ou en HTTPS. Si
l'exemple tourne sur une machine distante, passez par un tunnel SSH :

```bash
ssh -L 8090:127.0.0.1:8090 <serveur>
# puis http://localhost:8090
```

> **Attention :** ce serveur d'exemple n'a pas d'authentification et fait ses
> appels avec votre clé API. Ne l'exposez pas sur Internet.

## Architecture

```
Navigateur ──WS  /ws/translate──────▶ server.js ──WSS /ws/speech-translation─────▶ CandyVoice
           ──HTTP /voice/:speakerId─▶ (votre    ──HTTPS /api/speech-translation/voice─▶
                                       backend)    + X-API-Key
```

`server.js` joue le rôle de **votre backend**. C'est lui qui détient la clé
API et l'ajoute aux appels : message `auth` sur le WebSocket, en-tête
`X-API-Key` sur les routes HTTP. Le navigateur ne se connecte jamais
directement à CandyVoice, qui refuse les origines inconnues (code de
fermeture `4403`).

| Fichier | Contenu |
|---|---|
| [`server.js`](server.js) | Relais WebSocket authentifié et proxy HTTP des routes de voix (~200 lignes, seule dépendance : `ws`) |
| [`public/app.js`](public/app.js) | Client : capture micro, sessions, sous-titres, lecture des phrases traduites, enrôlement |
| [`public/pcm-worklet.js`](public/pcm-worklet.js) | `AudioWorklet` qui découpe le micro en blocs d'environ 85 ms |
| [`corpus/`](corpus/) | Textes à lire pour l'enrôlement de la voix, un fichier par langue |

## Le protocole en bref

### 1. Authentification (côté serveur)

À l'ouverture du WebSocket, votre backend envoie la clé, puis attend
`auth_ok` avant de relayer quoi que ce soit (voir le relais dans
[`server.js`](server.js)) :

```json
{ "type": "auth", "api_key": "cvk_..." }
```

### 2. Ouverture de la session

```json
{
  "type": "start",
  "sample_rate": 48000,
  "source_language": "fr",
  "target_language": "en",
  "speaker_id": "a1b2c3d4"
}
```

- **Une session par micro et par langue cible.** Si trois auditeurs écoutent
  en anglais, espagnol et allemand, l'app ouvre trois sessions qui reçoivent
  le même flux audio. Sans `target_language`, la session ne fait que la
  transcription (utile pour les sous-titres quand personne n'a besoin de
  traduction).
- `speaker_id` est un identifiant **opaque et stable** de l'orateur. Il
  permet de retrouver sa voix enrôlée. N'y mettez pas d'e-mail ni de nom.

La session répond `ready` (avec `max_seconds`, la durée maximale autorisée
par votre offre). Vous pouvez alors envoyer l'audio.

### 3. Envoi de l'audio

Trames **binaires** de PCM 16 bits signé, mono, à la fréquence annoncée dans
`sample_rate`, par blocs d'environ 85 ms (voir `toPcm16` et `onMicChunk`
dans [`public/app.js`](public/app.js)). Activez l'annulation d'écho du
micro : sinon il capte la traduction diffusée par les haut-parleurs.

### 4. Messages reçus

| Message | Usage |
|---|---|
| `live` | Sous-titres : `transcript`, `translation` et leurs parties encore en cours `transcript_pending`, `translation_pending` |
| `live_audio` | En-tête d'une phrase traduite (`index`, `text`, `delay_ms`, `imitation_applied`), **immédiatement suivi d'une trame binaire WAV** contenant sa voix |
| `stage` | Avancement, par exemple `finishing` après `stop` |
| `limit_reached` | `max_seconds` atteint : la session se termine |
| `result` | Bilan final : texte complet, `output_url` (piste traduite entière, lien valable 1 h), délais, avertissements |
| `error` | Erreur de la session |

Jouez les WAV **dans l'ordre d'arrivée et sans trou** : la file de lecture de
[`public/app.js`](public/app.js) (`enqueuePlayback`) montre comment
enchaîner les phrases avec la Web Audio API.

### 5. Fin de session

Envoyez `{ "type": "stop" }`, puis attendez le message `result` avant de
fermer la connexion.

## Voix de l'orateur (enrôlement)

Par défaut, la traduction est lue avec une voix de synthèse standard. Si
l'orateur enregistre sa voix une fois, les phrases traduites sont lues avec
**sa propre voix** (`imitation_applied: true`).

| Requête | Effet |
|---|---|
| `POST /api/speech-translation/voice` | Enrôle la voix (WAV, de 30 s à 10 min) |
| `GET /api/speech-translation/voice` | État de la voix enrôlée |
| `DELETE /api/speech-translation/voice` | Supprime la voix et les enregistrements de l'orateur |

En-têtes : `X-API-Key`, `X-Speaker-Id`, et pour le `POST`
`X-Source-Language` et `X-Speaker-Consent: true`.

**Consentement :** `X-Speaker-Consent: true` atteste que l'orateur a
accepté l'enregistrement de sa voix. Dans cet exemple, il n'est envoyé que si
l'orateur a coché la case de consentement ; sans lui, l'API répond `403`.
Proposez toujours aussi la suppression (« Supprimer ma voix »).

Dans l'UI, l'orateur lit les premières phrases du corpus de sa langue
(`corpus/<code>.txt`). L'enregistrement est rééchantillonné en 16 kHz avant
l'envoi.

## Utiliser l'interface

- **Participants** : chacun a un nom, un `speaker_id` (gardé dans le
  `localStorage`), une langue parlée et une langue d'écoute.
- **Je parle en tant que** : attribue le micro à un participant. L'app
  ouvre une session par langue d'écoute des autres participants.
- **J'écoute en tant que** : choisit le participant dont vous entendez la
  traduction. Les autres phrases restent réécoutables dans l'onglet
  *Phrases*.
- **Sous-titres** : sur chaque tuile, la transcription pour l'orateur, la
  traduction pour les autres. La partie encore en cours est en italique.
- **Sessions / Journal** : état de chaque session, délais, résultat final,
  et tous les messages échangés avec l'API. Le journal est le meilleur point
  de départ pour comprendre le protocole.

## Scénarios à essayer

1. Avec Moi (fr), Alice (en) et Bruno (es), parlez en tant que Moi : deux
   sessions s'ouvrent, `fr→en` et `fr→es`. Écoutez en tant qu'Alice, puis
   passez à Bruno en cours de session.
2. Enrôlez la voix de Moi, puis refaites le scénario 1 : les phrases sont
   lues avec la voix de l'orateur.
3. Cliquez sur « Supprimer ma voix », puis relancez : retour à la voix
   standard.
4. Choisissez une langue d'écoute sans voix de synthèse (`ga`, `zh`) : la
   traduction est disponible en sous-titres seulement.

## Langues

Les listes des langues parlées, des langues de traduction et des langues
disponibles en voix sont en tête de [`public/app.js`](public/app.js). Elles
suivent le guide d'intégration Kizwork, qui fait référence.
