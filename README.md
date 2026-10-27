# Server-chat

A real-time chat with temporary username/password accounts, plaintext public/official channels, browser-side end-to-end encrypted text in private rooms, moderator image review, optional voice chat, and peer-to-peer screen sharing.

## Live chat

**Public website URL:** The actual Render URL is not recorded in this repository. Copy the exact `https://…onrender.com` address from the web service page in your Render dashboard before sharing this README. I have intentionally not guessed the URL.

## What users can do

- **`#general`** — casual public conversation.
- **`#help`** — ask questions and help other users.
- **`#announcements`** — official updates from moderators. Both posts written directly in this channel and global announcements sent by moderators are copied into the channel archive. They do not expire while the server is running. Four pinned guide posts are built into the app and reappear after restarts.
- **`#voice`** — chat by text, optionally join live voice, mute/unmute, leave voice, and share your screen.
- **`#music`** — search the configured music addon and queue tracks for shared playback, or optionally upload MP3, M4A, AAC, OGG, OPUS, WAV, WEBM or FLAC files (8 MB per upload, up to 24 MB uploaded audio in memory, 20 queue entries and 5 tracks per user).

To use catalogue search, open `#music`, enter a song title or artist, and click **Search music**. Search runs from the chat server through the official Audius API (`https://api.audius.co/v1` by default); the browser never requests Audius directly. Most read-only API endpoints work without a key; `AUDIUS_API_KEY` is optional and can be configured in the Render environment for higher API limits. Add a result to the shared queue. The server fetches one copy of each current track, then shares that local server copy with all listeners. Playback starts when the copy is ready. Regular users can add tracks and join playback locally; only admins can start/resume, pause or skip the shared playback. Audio is fetched by the chat server once from the stream URL returned by Audius and cached temporarily (up to 120 MB per track) before being served from `/music/stream/<track-id>`. All listeners use the local cache and byte-range requests, which reduces upstream requests but means the first playback may wait for the cache to finish downloading. A provider's HTTP 429 is respected using its `Retry-After` value (or a 60-second fallback), not bypassed. The browser receives neither the provider stream URL nor upstream artwork URL. Audius and the audio host see the server's outgoing connection/IP rather than each listener's IP. Search results include creator attribution and an optional link back to Audius. The hosting platform still handles each visitor's connection metadata. The server downloads each Audius stream once into a temporary cache file (maximum 120 MB per track) and serves that copy to all listeners with byte-range support. Tracks that are unavailable, stream-gated, or not enabled for API streaming are excluded from search results. Respect creator rights and Audius API terms. When a selected stream fails, the player asks the chat server for a small range-based diagnostic and displays a safe error without exposing upstream stream URLs. Browser policy and network buffering can still cause minor playback differences. Use this only for tracks and services you are legally entitled to stream or share. Optionally, users may upload their own permitted audio files (8 MB per file and 24 MB total uploaded audio in memory); uploaded audio is cleared on restart or when skipped.

To use voice, open `#voice`, click **Join voice**, and allow microphone access in your browser. Voice is off until you choose to join. You can mute or leave at any time. Screen sharing is opt-in and room members may see your screen; moderators may monitor or stop an active share.

## Chat experience

- **Replies:** Use **Reply** on a message to attach a reference to the original message. The server stores only the referenced message ID and author label, not a quoted copy of private-room text.
- **Edit and delete:** A message author can delete their own messages. Text-only messages can be edited for 15 minutes. The server verifies ownership using the browser token; private-room edits are encrypted in the browser before being sent.
- **Message search:** Search matches in the currently loaded history of the current room. It is a local browser filter, not a server-wide search.
- **Temporary accounts:** Create a username and password, log out, and sign back in while the server process is running. Usernames are unique case-insensitively; passwords are stored as salted scrypt hashes, never plain text. Accounts and their login sessions are held in server memory and are lost on a server restart or redeploy, by design. There is no password-reset flow because accounts have no email address. Choose a unique password you do not use elsewhere.
- **Profile:** Choose a display name and a simple status (Online, Gaming, Away, or Do not disturb). Your display name can differ from your account username.
- **Appearance:** The light/dark toggle remembers the current browser's preference. The channel switcher is available with **Ctrl+K**, room search with **Ctrl+F**, and **/** focuses the composer when you are not already typing.
- **Desktop notifications:** Optional notifications can be enabled explicitly from the status menu. Notifications for private-room text only say that an encrypted message arrived; the decrypted message body is not copied onto the operating system's lock screen.
- **Installable app:** Compatible browsers can install Server Chat from the browser's install action. The service worker caches only the visual shell; sending messages, voice, TURN credentials and other live features still require a network connection. If offline, the app shows a reconnect page.
- **Moderation:** Every non-admin message can be reported, including your own. Admin messages and built-in bot notices cannot be reported. The server enforces this rule, rather than relying only on the button being hidden.

## Built-in AI assistant

The chat interface includes a private-by-default AI helper for questions, writing help, learning, and ideas. It only receives messages a user deliberately types into the AI panel; it does not automatically read channel history, room messages, or encrypted private chats. The API key stays on the server. Requests go to Groq's OpenAI-compatible chat-completions endpoint; the app does not send the AI conversation to OpenAI's API.

### Enable the AI without paying

1. Create a free account at [Groq Console](https://console.groq.com/) and generate a key at [API Keys](https://console.groq.com/keys).
2. In Render, open the web service and go to **Environment**. Add `GROQ_API_KEY` with that key as its value. Do not put it in GitHub or browser code.
3. Leave `GROQ_MODEL` unset to use `openai/gpt-oss-20b`, which appears in Groq's available model list. You do not need to configure OpenAI API billing for this provider.
4. Save the environment changes and let Render redeploy/restart the service.

**Important:** Keep the Groq account on its **Free** tier and do not upgrade to its paid Developer plan. Groq's Free tier has request/token limits; when those limits are reached, requests may fail temporarily rather than requiring an upgrade. Check the current [model list](https://console.groq.com/docs/models), [rate limits](https://console.groq.com/docs/rate-limits), and [billing FAQ](https://console.groq.com/docs/billing-faqs). The app also caps usage to 18 requests per IP per 10 minutes and 300 requests per rolling 24 hours. The app limits are held in memory and reset on a server restart.

## Privacy and safety

- A temporary account is required to join chat and send messages. Authentication sessions are random, server-validated tokens; the account store is memory-only.
- **Text messages:** only text in `private-*` rooms is end-to-end encrypted in the browser using AES-GCM. Its 256-bit key is carried in the private invite-link URL fragment, which is not included in HTTP requests. Use **Copy link** inside that private room to share the same key with intended participants. Anyone holding the link can decrypt messages sent with that key. Text in public/official rooms (`#general`, `#help`, `#announcements`, `#voice`, and `#music`) is plaintext and can be read by the server. Slash commands are control actions and are not ordinary chat messages.
- **Security limitation:** this implementation has not been independently audited. Because the browser JavaScript is served by the same site, a compromised deployment could serve modified code that reads the key or plaintext. Do not treat this as equivalent to an independently audited secure messenger.
- **Images:** images are not end-to-end encrypted. They are sent to the server and appear immediately in the chat; the same uploaded image is also sent to the authenticated admin review panel, including for private rooms. Moderators can mark an image reviewed, delete image posts, and ban the uploader's browser token for 24 hours or until the current server process restarts. These bans are memory-only and are not reliable identity-level bans; clearing browser storage or using another device may evade them. Image uploads are enabled in all rooms by default and can be changed with `/images off|private|on`.
- **Illegal-content caveat:** image review is manual, not automated detection, and cannot guarantee that illegal images will never be uploaded or seen by other participants before a moderator acts. Because images appear immediately, admins should regularly review the image panel and remove illegal or harmful posts promptly. Server-side text filtering can inspect public/official channel text but cannot inspect end-to-end encrypted text in private rooms.
- Ordinary chat history is held in server memory and expires after about one hour.
- The shared music queue, uploaded audio files, temporary Audius catalogue cache and synchronized playback clock are held in memory and are cleared if the service restarts or redeploys. Catalogue audio cache files are kept only in the host's temporary directory, removed when a track is skipped, and cleared at process startup.
- Moderator posts in `#announcements` are retained during the life of the current server process (up to 1,000 recent posts). Because this app does not yet use a persistent database, custom posts are cleared if the service restarts or redeploys. The built-in pinned guide information returns automatically.
- The application keeps temporary accounts in memory rather than a persistent database and does not intentionally save IP addresses in chat history. Requests from the browser to music search and playback go to this chat server; the external addon/media host sees the server's outgoing connection rather than each listener's IP. The hosting provider still handles visitor connection metadata under its own policies.
- Treat invite links as secret because the URL fragment contains the text-encryption key. Share them only with intended participants.
- Do not post passwords, private addresses, personal documents, authentication tokens, or other sensitive information.
- Be respectful. No harassment, hate, threats, scams, or illegal content. Use the ⚑ report control for messages that break the rules.

## Public repository and secrets

The source code is public by design. Do not commit secrets here. Set `ADMIN_PASSWORD`, Discord webhook URLs, ntfy topics, Resend API keys, and any other credentials only in your host's environment-variable settings. `AUDIUS_API_BASE_URL` can override the Audius API base and defaults to `https://api.audius.co/v1`. `AUDIUS_API_KEY` is optional; `AUDIUS_APP_NAME` defaults to `ServerChat`. Keep keys only in Render environment settings. Most read-only searches can run without a key. Never put them in `public/index.html`, the README, workflow files, or screenshots. The keep-alive workflow uses the non-secret repository variable `RENDER_URL` for the public service address.

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
