<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/2c5c946a-bd1f-434c-984c-5880f3999f49

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Production readiness upgrades included

- Input validation and sanitization for room IDs, names, messages, and poll payloads.
- Server-side participant caps with configurable room and waiting room limits.
- Basic socket message rate limiting for chat spam protection.
- Stable poll identifiers (`crypto.randomUUID`) and stricter vote validation.
- Presence robustness: cached mute/video state is sent to newly joined users.
- Health probes for deployments:
  - `GET /healthz`
  - `GET /readyz`
- Graceful shutdown handling for `SIGINT`/`SIGTERM`.

### Optional environment variables

See `.env.example` for:

- `PORT`
- `CORS_ORIGIN`
- `MAX_ROOM_SIZE`
- `MAX_WAITING_ROOM_SIZE`
- `MAX_MESSAGE_LENGTH`
