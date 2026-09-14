# Voyage Automation Bridge

Minimal authenticated bridge between Voyage tooling and the TinyFish Agent API.

## What it exposes

- `GET /` — redirects to the mobile console.
- `GET /console` — mobile-first web UI for starting and monitoring TinyFish runs.
- `GET /health` — public liveness/configuration check; never returns secret values.
- `POST /v1/tinyfish/runs` — authenticated async TinyFish run creation.
- `GET /v1/tinyfish/runs/:runId` — authenticated, sanitized run status/result.

The bridge intentionally uses TinyFish's asynchronous Agent API so long browser tasks do not hold an HTTP request open. It also strips streaming/video/step payloads from status responses to reduce accidental disclosure of authenticated browser content.

## Required Render environment variables

Configure these only in **Render > Environment**. Do not commit real values.

```text
TINYFISH_API_KEY=<new TinyFish API key>
BRIDGE_API_KEY=<strong random bridge key>
ALLOWED_HOSTS=console.cloud.google.com,news.ycombinator.com
RATE_LIMIT_PER_MINUTE=20
```

`PORT` is supplied by Render automatically.

## Render service settings

```text
Runtime: Node
Build Command: npm install --ignore-scripts
Start Command: npm start
Health Check Path: /health
```

After deploy, verify:

```text
GET https://voyage-automation-bridge.onrender.com/health
```

Expected shape:

```json
{
  "ok": true,
  "service": "voyage-automation-bridge",
  "tinyfishConfigured": true,
  "bridgeAuthConfigured": true
}
```

## Mobile console

Open:

```text
https://voyage-automation-bridge.onrender.com/console
```

The page is intentionally usable from a phone. It provides short presets for:

- Google OAuth Audience / publishing status
- OAuth client origins and redirect URIs
- Gmail API / OAuth scopes
- a quick Hacker News E2E test

Enter `BRIDGE_API_KEY` only in the password field. The page keeps it in browser memory for the current page only and does not persist it to localStorage or send it to GitHub. The TinyFish API key never reaches the browser.

For an authenticated TinyFish Browser Context Profile, enable **Usar Browser Context Profile salvo** and provide its `prof_...` profile ID. The profile ID is sent only to the bridge/TinyFish for that run.

The audit presets explicitly request read-only behavior and instruct the agent to stop on MFA, password, passkey, or reauthentication requirements.

## Start a TinyFish run programmatically

Send the bridge key only in the `X-Bridge-Key` header.

```bash
curl -X POST https://voyage-automation-bridge.onrender.com/v1/tinyfish/runs \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Key: $BRIDGE_API_KEY" \
  -d '{
    "url": "https://console.cloud.google.com/apis/credentials",
    "goal": "Audit the current OAuth configuration in read-only mode. Do not modify settings or expose secrets.",
    "browserProfile": "stealth",
    "useProfile": true,
    "profileId": "prof_..."
  }'
```

The response contains a `run_id`. Poll it with:

```bash
curl https://voyage-automation-bridge.onrender.com/v1/tinyfish/runs/RUN_ID \
  -H "X-Bridge-Key: $BRIDGE_API_KEY"
```

## Security posture

The service is intentionally small: Node built-ins only, HTTPS target URLs only, hostname allowlist, constant-time bridge-key comparison, request-size cap, basic rate limiting, no TinyFish vault usage, sanitized status responses, no credential values in logs, and no secrets in the repository.

The mobile console adds a restrictive Content Security Policy, denies framing, disables camera/microphone/geolocation permissions, and keeps the bridge key out of persistent browser storage.

If broader automation is needed later, expand `ALLOWED_HOSTS` deliberately rather than removing the allowlist.
