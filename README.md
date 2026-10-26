# Server-chat

A lightweight anonymous room-based chat built with Node.js, Express and Socket.IO.

## Official channels

- `#general`: the main public chat.
- `#announcements`: official, moderator-posted updates. Ordinary users cannot post here.
- `#help`: a public channel for questions and troubleshooting.
- `#voice`: public text chat with optional voice chat and screen sharing. Voice is off until a user chooses **Join voice**; the browser then asks for microphone access. A user can mute or leave voice at any time.

Voice uses peer-to-peer WebRTC audio and server-routed signaling. It is intended for small groups (up to 8 people in the voice room). This setup uses a STUN server; some NAT/firewall combinations may require a TURN relay server for reliable connectivity.

Screen sharing remains separate from voice transport and is scoped to the current chat room.

## Render free-service keep-alive

This repository includes a GitHub Actions workflow that requests `/healthz` every five minutes. This can prevent the normal 15-minute idle sleep on Render's free web-service plan while the workflow is running.

### One-time setup

1. Deploy the latest `main` branch to Render so the `/healthz` endpoint is available.
2. Open this repository on GitHub and go to **Settings → Secrets and variables → Actions → Variables**.
3. Select **New repository variable** and create:
   - **Name:** `RENDER_URL`
   - **Value:** the public base URL for your Render web service, for example `https://your-service.onrender.com`. Do not include `/healthz`.
4. Open the **Actions** tab and confirm workflows are enabled. Choose **Keep Render chat awake** and use **Run workflow** to test it.

The scheduled workflow runs every five minutes and requests `https://your-service.onrender.com/healthz`. A successful response is a small JSON object confirming the server is responding.

**Limitations:** This prevents the usual idle sleep only while the scheduled workflow keeps running. GitHub may delay scheduled jobs, Render may restart a free service for other reasons, and a running free service consumes its monthly instance hours. Render currently provides 750 free instance hours per workspace per calendar month, shared across free web services.

## Controlled admin restart

The Admin panel's **Server Nuker** is a playful name for a controlled restart: it broadcasts a 15-second countdown, then calls Render's authenticated restart API. It does not generate load or intentionally crash the server.

To enable it:

1. In Render, open **Account Settings → API Keys** and create an API key with only the permissions required to restart the intended service.
2. Open the chat service's Settings page and copy its service ID (usually starts with `srv-`).
3. In **Render → your web service → Environment**, add `RENDER_API_KEY` and `RENDER_SERVICE_ID`. Do not add these credentials to GitHub or the browser code.
4. Save and redeploy. The Admin panel will then show that the restart sequence is configured.

The countdown can be cancelled by a moderator before the API request is submitted. Once Render accepts the restart request, it cannot be cancelled from the chat panel. See [Render's restart API documentation](https://api-docs.render.com/reference/restart-service).
