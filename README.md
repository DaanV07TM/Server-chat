# Server-chat

An anonymous, real-time chat with separate channels, optional voice chat, and peer-to-peer screen sharing.

## Live chat

**Public website URL:** The actual Render URL is not recorded in this repository. Copy the exact `https://…onrender.com` address from the web service page in your Render dashboard before sharing this README. I have intentionally not guessed the URL.

## What users can do

- **`#general`** — casual public conversation.
- **`#help`** — ask questions and help other users.
- **`#announcements`** — official updates from moderators. Both posts written directly in this channel and global announcements sent by moderators are copied into the channel archive. They do not expire while the server is running. Four pinned guide posts are built into the app and reappear after restarts.
- **`#voice`** — chat by text, optionally join live voice, mute/unmute, leave voice, and share your screen.
- **`#music`** — search the configured music addon and queue tracks for shared playback, or optionally upload MP3, M4A, AAC, OGG, OPUS, WAV, WEBM or FLAC files (8 MB per upload, up to 24 MB uploaded audio in memory, 20 queue entries and 5 tracks per user).

To use catalogue search, open `#music`, enter a song title or artist, and click **Search music**. Search runs from the chat server to `MUSIC_ADDON_BASE_URL` (default `https://bppcaf.bot-keep.xyz`); the browser never requests the addon directly. Add a result to the shared queue, then use **Play for everyone**, **Pause everyone**, or **Next track**. Audio is fetched by the chat server once from the stream URL returned by the addon and cached temporarily (up to 120 MB per track) before being served from `/music/stream/<track-id>`. All listeners use the local cache and byte-range requests, which reduces upstream requests but means the first playback may wait for the cache to finish downloading. A provider's HTTP 429 is respected using its `Retry-After` value (or a 60-second fallback), not bypassed. The browser receives neither the provider stream URL nor artwork URL. The addon and audio host see the server's outgoing connection/IP rather than each listener's IP. The hosting platform still handles each visitor's connection metadata. The privacy relay currently accepts direct HTTPS audio streams only; encrypted or HLS/DASH segmented tracks are refused because they need a separate manifest/segment proxy. When a selected stream fails, the player asks the chat server for a small range-based diagnostic and displays a safe error without exposing upstream stream URLs. Browser policy and network buffering can still cause minor playback differences. Use this only for tracks and services you are legally entitled to stream or share. Optionally, users may upload their own permitted audio files (8 MB per file and 24 MB total uploaded audio in memory); uploaded audio is cleared on restart or when skipped.

To use voice, open `#voice`, click **Join voice**, and allow microphone access in your browser. Voice is off until you choose to join. You can mute or leave at any time. Screen sharing is opt-in and room members may see your screen; moderators may monitor or stop an active share.

## Privacy and safety

- No user account is required. Display names are not identity verification.
- Ordinary chat messages are held in server memory and expire after about one hour.
- The shared music queue, uploaded audio files, temporary catalogue cache and synchronized playback clock are held in memory and are cleared if the service restarts or redeploys. Catalogue audio cache files are kept only in the host's temporary directory, removed when a track is skipped, and cleared at process startup.
- Moderator posts in `#announcements` are retained during the life of the current server process (up to 1,000 recent posts). Because this app does not yet use a persistent database, custom posts are cleared if the service restarts or redeploys. The built-in pinned guide information returns automatically.
- The application does not maintain an account database or intentionally save IP addresses in chat history. Requests from the browser to music search and playback go to this chat server; the external addon/media host sees the server's outgoing connection rather than each listener's IP. The hosting provider still handles visitor connection metadata under its own policies.
- Do not post passwords, private addresses, personal documents, authentication tokens, or other sensitive information.
- Be respectful. No harassment, hate, threats, scams, or illegal content. Use the ⚑ report control for messages that break the rules.

## Public repository and secrets

The source code is public by design. Do not commit secrets here. Set `ADMIN_PASSWORD`, Discord webhook URLs, ntfy topics, Resend API keys, and any other credentials only in your host's environment-variable settings. `MUSIC_ADDON_BASE_URL` can override the public music addon URL, and `MUSIC_ADDON_QUALITY` may be set to `LOW`, `HIGH`, or `LOSSLESS`; no API key is required for the default addon. Never put them in `public/index.html`, the README, workflow files, or screenshots. The keep-alive workflow uses the non-secret repository variable `RENDER_URL` for the public service address.

A quick review of the currently tracked files did not find hardcoded API tokens, private keys, or webhook credentials, and no `.env` file is tracked in the current tree. This is a source-code review, not a guarantee against every historical commit, dependency vulnerability, or live deployment issue. Public Git commits also expose their author metadata; use GitHub's noreply email for future commits if you don't want your personal email shown.

## Hosting and maintenance

This project uses Node.js, Express, and Socket.IO, and is intended to run as a Render web service. The `/healthz` endpoint is used by the keep-alive workflow.

If Render restarts the service, messages in regular rooms and custom announcement posts are cleared because they are held in memory. The built-in pinned guide posts return when users open `#announcements`.

## Developer setup

1. Install Node.js 22 or newer.
2. Run `npm install`.
3. Set `ADMIN_PASSWORD` in your environment before exposing the server publicly.
4. Run `npm start` and open the local URL printed or configured by your environment.

Never use a real production password or webhook when testing locally.
