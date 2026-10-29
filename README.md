# Server-chat

A real-time chat with temporary username/password accounts, plaintext public/official channels, browser-side end-to-end encrypted text in private rooms, moderator image review, optional voice chat, and peer-to-peer screen sharing.

## Live chat

**Public website URL:** The actual Render URL is not recorded in this repository. Copy the exact `https://…onrender.com` address from the web service page in your Render dashboard before sharing this README. I have intentionally not guessed the URL.

## Login anti-bot check

Every password-based login requests a short-lived, one-time proof-of-work challenge from the chat server. The browser performs a small SHA-256 search and the server validates the answer, connection binding, expiry and one-time use. It uses built-in cryptography rather than an external CAPTCHA provider. This raises the cost of scripted login attempts but cannot prove that a visitor is human or make automation impossible; keep the existing login rate limit in place. Session-token resume is a separate flow and does not ask for the password again.

## Patch notes

The in-app release history is available at [`/patch-notes.html`](https://github.com/DaanV07TM/Server-chat/blob/main/public/patch-notes.html) and from the Patch notes link in the main navigation. It lists user-facing changes by date.

## What users can do

- **`#general`** — casual public conversation.
- **`#help`** — ask questions and help other users.
- **`#announcements`** — official updates from moderators. Both posts written directly in this channel and global announcements sent by moderators are copied into the channel archive. They do not expire while the server is running. Four pinned guide posts are built into the app and reappear after restarts.
- **`#voice`** — chat by text, optionally join live voice, mute/unmute, leave voice, and share your screen.
- **`#music`** — search the configured music addon and queue tracks for shared playback, or optionally upload MP3, M4A, AAC, OGG, OPUS, WAV, WEBM or FLAC files (8 MB per upload, up to 24 MB uploaded audio in memory, 20 queue entries and 5 tracks per user).
- **`#ai` / AI Studio** — a separate private AI workspace with per-account conversation history, new conversations, shareable read-only snapshots, and a link to a free external image generator.

To use catalogue search, open `#music`, enter a song title or artist, and click **Search music**. Search runs from the chat server through the official Audius API (`https://api.audius.co/v1` by default); the browser never requests Audius directly. Most read-only API endpoints work without a key; `AUDIUS_API_KEY` is optional and can be configured in the Render environment for higher API limits. Add a result to the shared queue. The server fetches one copy of each current track, then shares that local server copy with all listeners. Playback starts when the copy is ready. Regular users can add tracks and join playback locally; only admins can start/resume, pause or skip the shared playback. Audio is fetched by the chat server once from the stream URL returned by Audius and cached temporarily (up to 120 MB per track) before being served from `/music/stream/<track-id>`. All listeners use the local cache and byte-range requests, which reduces upstream requests but means the first playback may wait for the cache to finish downloading. A provider's HTTP 429 is respected using its `Retry-After` value (or a 60-second fallback), not bypassed. The browser receives neither the provider stream URL nor upstream artwork URL. Audius and the audio host see the server's outgoing connection/IP rather than each listener's IP. Search results include creator attribution and an optional link back to Audius. The hosting platform still handles each visitor's connection metadata. The server downloads each Audius stream once into a temporary cache file (maximum 120 MB per track) and serves that copy to all listeners with byte-range support. Tracks that are unavailable, stream-gated, or not enabled for API streaming are excluded from search results. Respect creator rights and Audius API terms. When a selected stream fails, the player asks the chat server for a small range-based diagnostic and displays a safe error without exposing upstream stream URLs. Browser policy and network buffering can still cause minor playback differences. Use this only for tracks and services you are legally entitled to stream or share. Optionally, users may upload their own permitted audio files (8 MB per file and 24 MB total uploaded audio in memory); uploaded audio is cleared on restart or when skipped.

To use voice, open `#voice`, click **Join voice**, and allow microphone access in your browser. Voice is off until you choose to join. You can mute or leave at any time. Screen sharing is opt-in and room members may see your screen; moderators may monitor or stop an active share.

## Chat experience

- **Replies:** Use **Reply** on a message to attach a reference to the original message. The server stores only the referenced message ID and author label, not a quoted copy of private-room text.
- **Edit and delete:** A message author can delete their own messages. Text-only messages can be edited for 15 minutes. The server verifies ownership using the browser token; private-room edits are encrypted in the browser before being sent.
- **Message search:** Search matches in the currently loaded history of the current room. It is a local browser filter, not a server-wide search.
- **Mail.tm-style temporary accounts:** Create an account in one click; the server generates a random username and a strong random password, which is shown once so you can copy it. Only the salted scrypt hash is retained on the server. You can change the password later (including generating a new random one) from account settings. Log out and sign back in using the generated credentials while the server process is running. Account records and sessions live in memory and disappear on restart/redeploy; no real Mail.tm mailbox or email address is created, and there is no password-recovery flow.
- **Delete account and data:** Account settings can permanently delete the temporary account, every remaining chat message/image and command response it authored, its report activity, and music tracks uploaded/queued by that account. Reports already sent to external moderation integrations (if configured) cannot be recalled. Messages from other users are not deleted.
- **Profile:** Choose a display name and a simple status (Online, Gaming, Away, or Do not disturb). Your display name can differ from your account username.
- **Appearance:** The light/dark toggle remembers the current browser's preference. The channel switcher is available with **Ctrl+K**, room search with **Ctrl+F**, and **/** focuses the composer when you are not already typing.
- **Desktop notifications:** Optional notifications can be enabled explicitly from the status menu. Notifications for private-room text only say that an encrypted message arrived; the decrypted message body is not copied onto the operating system's lock screen.
- **Installable app:** Compatible browsers can install Server Chat from the browser's install action. The service worker caches only the visual shell; sending messages, voice, TURN credentials and other live features still require a network connection. If offline, the app shows a reconnect page.
- **Moderation:** Every non-admin message can be reported, including your own. Admin messages and built-in bot notices cannot be reported. The server enforces this rule, rather than relying only on the button being hidden.

## Administrator access and global alerts

There is no separate Admin button. Use the ordinary **Log in** form and enter the configured `ADMIN_PASSWORD` into the password field (the username field can contain a valid placeholder such as `admin`). The server recognizes that password before looking up a temporary account and creates an administrator session directly; it does **not** create a temporary user account. Admin sessions are held in memory and expire when the server process restarts. Keep `ADMIN_PASSWORD` private and use a strong value.

The admin panel now has a jump navigation, a **Global Announcement Studio**, and an **AI Control Center**. Normal global announcements display an animated banner over every connected channel, including AI Studio, and are archived in `#announcements`. The alarm announcement option asks browsers to play a short alert tone and uses a brighter animated banner. Browser autoplay restrictions, muted device volume, or disabled audio can still prevent a sound from being heard; users can enable audio or replay the tone from the banner. The visual announcement does not depend on audio working.

AI admin controls show provider/model status, current temporary conversation and share counts, and daily request usage. Administrators can pause or resume the text AI without deleting private conversation history, or clear all temporary AI conversations and revoke their share links. The pause setting is runtime-only; set `AI_ENABLED=0` in the hosting environment to keep AI disabled after a restart. Existing conversations and counts remain memory-only and are cleared on restart.

## Built-in AI Studio

Open **AI Studio** from the channel sidebar or channel switcher. It is separate from shared chat rooms and never joins a Socket.IO room. Each signed-in temporary account has its own server-side conversation list and messages. A direct administrator login also gets a separate admin-only AI workspace without creating a temporary user account. The AI receives only the prompts and conversation context sent from that workspace; it does not automatically read normal channels, private-room messages, or account data. Text requests are sent to Groq's API, and the API key remains on the server.

- **Private by default:** AI conversations are visible only to the matching signed-in account while this server process is running. They are held in memory, so a Render restart/redeploy clears them along with temporary accounts.
- **Shareable on purpose:** Click **Share** to create a random, unlisted read-only snapshot link. Anyone who has the link can read the messages in that snapshot. The link expires after seven days. New messages do not silently appear in an existing shared snapshot; click **Update link** to refresh it. **Stop sharing** revokes the link, and deleting a conversation or account removes its active shares.
- **Create images externally:** Click **Create image** in AI Studio to open [Microsoft Bing Image Creator](https://www.bing.com/images/create) in a new tab. It offers free image creation, although a personal Microsoft account and usage limits may apply. This app does not generate images itself or send prompts to an image-generation API.
- The server caps text requests to 18 per IP per 10 minutes and 300 requests per rolling 24 hours. Text history, shared links, and these limits are held in memory and reset on a server restart.

### Enable the text AI without paying

1. Create a free account at [Groq Console](https://console.groq.com/) and generate a key at [API Keys](https://console.groq.com/keys).
2. In Render, open the web service and go to **Environment**. Add `GROQ_API_KEY` with that key as its value. Never put the key in GitHub or browser code.
3. Leave `GROQ_MODEL` unset to use `openai/gpt-oss-20b`. You do not need to configure OpenAI API billing for this provider.
4. Save the environment changes and let Render redeploy/restart the service.

**Cost note:** Keep Groq on the Free plan. Its request/token limits may temporarily block further responses rather than requiring an upgrade. Check its current [model list](https://console.groq.com/docs/models), [rate limits](https://console.groq.com/docs/rate-limits), and [billing FAQ](https://console.groq.com/docs/billing-faqs). Image creation opens the external Bing Image Creator website; this app does not call an image-generation API.

## Terms, privacy and abuse protection

- **Terms and privacy:** `/legal.html` contains the Terms of Service and Privacy Notice. Registration now requires agreeing to the current Terms and acknowledging the Privacy Notice; the server checks this rather than trusting only the browser. The accepted version and time are held with the temporary account in memory, so this is not a durable legal acceptance record. Before public launch, replace the operator/contact placeholders in `public/legal.html` and confirm that the notice fits the real deployment.
- **IP-based abuse protection:** the server uses trusted-proxy-aware client IP resolution and temporary in-memory counters. Current thresholds are 180 API requests in 10 seconds, 240 Socket.IO events in 10 seconds, or 40 new Socket.IO connections in 60 seconds. Exceeding a threshold creates a 10-minute temporary IP block and disconnects current sockets from that address. The registration rate limit is 12 attempts per IP per hour. Raw IP addresses are not intentionally written to the application log or chat history, but they are processed in memory for these controls. Hosting/proxy providers may independently retain connection logs.
- **Shared networks:** IP-based controls can affect other people using the same household, school, mobile carrier or public Wi-Fi connection. The counters and blocks are cleared on process restart and the block expires automatically. Review thresholds if legitimate users are being blocked.
- **Bot verification (optional Cloudflare Turnstile):** create a Turnstile widget in Cloudflare and configure both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in the hosting environment. Use the site key for the intended domain and keep the secret key server-side; never commit the secret to GitHub. When both values are present, registration requires a valid server-verified Turnstile token. If they are not configured, the app still has a hidden honeypot and rate limits, but there is no interactive CAPTCHA. Turnstile sends verification data to Cloudflare according to its own terms and privacy notice.
- **Limits of this protection:** these are application-layer controls, not a network firewall. They cannot prevent bandwidth exhaustion or a large distributed denial-of-service attack before traffic reaches the application. Use hosting-provider or edge-network DDoS/WAF protections as an additional layer.

## Privacy and safety

- A temporary account is required to join chat and send messages. Authentication sessions are random, server-validated tokens; the account store is memory-only.
- **Text messages:** only text in `private-*` rooms is end-to-end encrypted in the browser using AES-GCM. Its 256-bit key is carried in the private invite-link URL fragment, which is not included in HTTP requests. Use **Copy link** inside that private room to share the same key with intended participants. Anyone holding the link can decrypt messages sent with that key. Text in public/official rooms (`#general`, `#help`, `#announcements`, `#voice`, and `#music`) is plaintext and can be read by the server. Slash commands are control actions and are not ordinary chat messages.
- **Security limitation:** this implementation has not been independently audited. Because the browser JavaScript is served by the same site, a compromised deployment could serve modified code that reads the key or plaintext. Do not treat this as equivalent to an independently audited secure messenger.
- **Images:** images are not end-to-end encrypted. They are sent to the server and appear immediately in the chat; the same uploaded image is also sent to the authenticated admin review panel, including for private rooms. Moderators can mark an image reviewed, delete image posts, and ban the uploader's browser token for 24 hours or until the current server process restarts. These bans are memory-only and are not reliable identity-level bans; clearing browser storage or using another device may evade them. Image uploads are enabled in all rooms by default and can be changed with `/images off|private|on`.
- **Illegal-content caveat:** image review is manual, not automated detection, and cannot guarantee that illegal images will never be uploaded or seen by other participants before a moderator acts. Because images appear immediately, admins should regularly review the image panel and remove illegal or harmful posts promptly. Server-side text filtering can inspect public/official channel text but cannot inspect end-to-end encrypted text in private rooms.
- Ordinary chat history is held in server memory and expires after about one hour.
- The shared music queue, uploaded audio files, temporary Audius catalogue cache and synchronized playback clock are held in memory and are cleared if the service restarts or redeploys. Catalogue audio cache files are kept only in the host's temporary directory, removed when a track is skipped, and cleared at process startup.
- Moderator posts in `#announcements` are retained during the life of the current server process (up to 1,000 recent posts). Because this app does not yet use a persistent database, custom posts are cleared if the service restarts or redeploys. The built-in pinned guide information returns automatically.
- The application keeps temporary accounts in memory rather than a persistent database and does not intentionally save IP addresses in chat history or its application log. It does process client IP addresses in memory for anti-abuse rate counters and temporary blocks, which last up to 10 minutes. Requests from the browser to music search and playback go to this chat server; the external addon/media host sees the server's outgoing connection rather than each listener's IP. The hosting provider still handles visitor connection metadata under its own policies.
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


## In-chat admin announcements and events

Admin announcements are shown as large, animated messages directly in each user's current chat, including AI Studio. They are not a floating overlay and there is no dismiss button. The card automatically disappears after two minutes; an archived copy is retained in **#announcements**. Use `/announce message` for a normal broadcast and `/announcealarm urgent message` to request the built-in alarm sound (browser autoplay policies may still prevent audio until the page has been interacted with).

Admins can trigger a server-wide party event with `/party` or `/party your message`. It adds animated celebration styling to the in-chat announcement for two minutes. Use `/partyoff` to end the event early in all open chats. The admin panel also has buttons for starting and stopping Party Mode.


Party Mode additionally runs lightweight visual effects in each connected browser: a gentle chat-panel shake, dancing message bubbles and a single batch of at most 24 confetti pieces. Animations use CSS transforms, confetti is removed as it falls, and the effect stops automatically after the event's remaining two-minute lifetime or immediately with `/partyoff`. Browsers configured to prefer reduced motion skip the motion and confetti. The server only broadcasts the event; it does not send repeated animation work or load-generating requests.


## Admin desktop workspace and staff messages

The admin console uses a desktop-style workspace with a title bar, a navigable sidebar on wider screens, grouped cards, and a compact horizontal navigation on phones. Its selected section and scroll position are preserved during live status refreshes. Messages sent by an authenticated admin in regular chat receive a distinctive animated gradient staff card and a staff label, but behave like normal chat messages and are not automatically removed after two minutes. Global announcements remain time-limited and visually separate.


## Windows-style admin desktop

The admin console opens to an app desktop with separate windows for overview, performance, connection, screen shares, image review, chat controls, announcements, live events, reports, blocked words, notifications, AI, logs, restart and danger-zone actions. An app window can return to the desktop via its own toolbar or the taskbar. The console overlay is fixed to the full viewport above channel navigation. Five-second live polling updates summary and load values in place rather than replacing the app DOM; explicit actions and the app Refresh button can rebuild content while preserving the selected app and scroll position.


## Live Server Center, stickers and chat assistant

- **Public status page:** Visit `/status.html` or choose Server status in the channel navigation. It polls `/api/server-status` every 15 seconds and shows aggregate online clients, active public channels, uptime, CPU, process memory, JavaScript heap, warnings and a generic recent-activity feed. It never publishes names, chat contents, private room names or AI Studio participant counts. Resource alerts are threshold-based with a 10-minute notification cooldown and use configured notification providers only.
- **Admin Live Server Center:** The admin desktop includes a Live Server Center app with active public channels plus AI Studio counts visible only to admins, generic recent activity and resource warnings. Five-second dashboard updates patch values in place rather than rebuilding the workspace.
- **Emoji and stickers:** Use the 😊 button beside the message box to insert emoji or send one of the built-in shared stickers. The list is fixed and size-bounded, avoiding external image downloads and uncontrolled uploads. Stickers work as predefined IDs, including in private rooms without sending user-entered plaintext to the server.
- **Slash assistant:** `/help`, `/roll [sides]`, `/coinflip`, `/8ball question`, `/poll Question? | Option A | Option B`, `/quiz`, and `/rules`. Polls support 2–5 unique options, one vote per account (votes can be changed), and quizzes reveal whether your answer was correct only to you. Interactive polls and quizzes are disabled in end-to-end encrypted private rooms. Polls, votes and history remain in server memory, like other chat history.


## Ubuntu COSMIC visual refresh

The current interface uses a shared Ubuntu COSMIC / macOS / Windows / Discord-inspired design system. The desktop layout has an aubergine channel rail with workspace sections and quick-launch dock; Ubuntu orange and aubergine accents; translucent desktop-style top chrome; rounded chat, composer and dialog surfaces; and coordinated AI Studio, admin desktop, account dialogs, stickers and status dashboard styling. On narrower screens the sidebar becomes a horizontal room switcher. The selected light/dark theme continues to apply, reduced-motion settings remain respected, and the service worker cache was bumped so stale CSS is replaced. This change is visual and layout-oriented; it intentionally preserves existing chat behavior and API flows.

Theme personalization also includes an accent palette picker alongside the light/dark toggle. Four presets are available: Ubuntu COSMIC (orange/aubergine), Arctic Blue, Matrix Green, and Rose Quartz. The palette is stored only in the browser's local storage; it does not create a profile record or send appearance preferences to the server.
