# Server-chat

An anonymous, real-time chat with separate channels, optional voice chat, and peer-to-peer screen sharing.

## Live chat

**Public website URL:** The actual Render URL is not recorded in this repository. Copy the exact `https://…onrender.com` address from the web service page in your Render dashboard before sharing this README. I have intentionally not guessed the URL.

## What users can do

- **`#general`** — casual public conversation.
- **`#help`** — ask questions and help other users.
- **`#announcements`** — official updates from moderators. Both posts written directly in this channel and global announcements sent by moderators are copied into the channel archive. They do not expire while the server is running. Four pinned guide posts are built into the app and reappear after restarts.
- **`#voice`** — chat by text, optionally join live voice, mute/unmute, leave voice, and share your screen.
- **`#music`** — a shared queue for individual YouTube and YouTube Music video links. Tracks are kept in memory, with a maximum of 50 entries and 5 per user.

To use music, open `#music`, paste an individual YouTube or YouTube Music video link, optionally enter its title, and add it to the shared queue. Everyone in `#music` sees the same current track and queue, with a server-authoritative playback clock. Use **Play for everyone**, **Pause everyone**, or **Next track** to control the room; use **Join / resync** on a device when its browser blocks remote playback or it drifts. YouTube's visible player and controls remain present. This is an embedded YouTube player, not an official YouTube Music account integration, and browser autoplay policies, advertisements, buffering, and videos that disallow embedding can prevent perfectly simultaneous playback. Some users may need to click Play/Join on their own device.

To use voice, open `#voice`, click **Join voice**, and allow microphone access in your browser. Voice is off until you choose to join. You can mute or leave at any time. Screen sharing is opt-in and room members may see your screen; moderators may monitor or stop an active share.

## Privacy and safety

- No user account is required. Display names are not identity verification.
- Ordinary chat messages are held in server memory and expire after about one hour.
- The shared music queue and synchronized playback clock are held in server memory and are cleared if the service restarts or redeploys.
- Moderator posts in `#announcements` are retained during the life of the current server process (up to 1,000 recent posts). Because this app does not yet use a persistent database, custom posts are cleared if the service restarts or redeploys. The built-in pinned guide information returns automatically.
- The application does not maintain an account database or intentionally save IP addresses in chat history. However, the hosting provider may process connection metadata under its own policies.
- Do not post passwords, private addresses, personal documents, authentication tokens, or other sensitive information.
- Be respectful. No harassment, hate, threats, scams, or illegal content. Use the ⚑ report control for messages that break the rules.

## Public repository and secrets

The source code is public by design. Do not commit secrets here. Set `ADMIN_PASSWORD`, Discord webhook URLs, ntfy topics, Resend API keys, and any other credentials only in your host's environment-variable settings. Never put them in `public/index.html`, the README, workflow files, or screenshots. The keep-alive workflow uses the non-secret repository variable `RENDER_URL` for the public service address.

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
