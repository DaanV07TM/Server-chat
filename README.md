# Server-chat

A lightweight anonymous room-based chat built with Node.js, Express and Socket.IO.

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
