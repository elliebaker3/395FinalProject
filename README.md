# CallWizard

Behaviorally lighter catch-up calls: nudges and one-tap dialer flows (mobile + API), plus a simple web intake form.

## Intake form (GitHub Pages)

**Live site:** [https://marinamancoridis.github.io/395FinalProject/](https://marinamancoridis.github.io/395FinalProject/)

The form posts to your deployed API. In the GitHub repo, set the Actions **repository variable** `API_BASE_URL` to your public API origin (no trailing slash), then re-run the **Deploy intake website** workflow or push to `main`.

If the site 404s, enable **Settings → Pages → Build and deployment → Source: GitHub Actions** and confirm the latest **Deploy intake website** run in **Actions** succeeded.

## Deploy API + database (Render + Neon)

Step-by-step for the whole team (accounts, Neon schema, Render web service, `API_BASE_URL`): **[docs/SETUP-RENDER-NEON.md](docs/SETUP-RENDER-NEON.md)**.

## Repo layout

| Folder   | What it is |
|----------|------------|
| `web/`   | Vite intake UI; deployed to GitHub Pages via `.github/workflows/deploy-web.yml` |
| `server/` | Express API + Postgres (Neon) |
| `mobile/` | Expo (React Native) app for push + `tel:` dialer |

## Quick start (local)

Use the **conda** environment **`395final`** for every shell where you run Node or npm (including Expo). Avoid relying on Homebrew’s `node`/`npm` for this repo—activate conda first so those binaries win on your `PATH`.

```bash
conda activate 395final
cd /path/to/395FinalProject   # repo root
npm run install:all
```

Confirm Node/npm resolve inside the env (paths should mention `395final` or `conda`, not only `/opt/homebrew`):

```bash
which node npm
node -v
```

Then:

- **API:** copy `server/.env.example` to `server/.env`, set `DATABASE_URL`, then `npm run db:init` and `npm run server`.
- **Web (dev):** `npm run web` — proxies `/api` to `http://localhost:3001`.
- **Mobile:** `npm run mobile` (Expo). From `mobile/`: `npx expo start`, `npm run ios`, `npm run android` — always with **`conda activate 395final`** first.

If `conda activate 395final` does not put `node` on your PATH, install Node **inside** that environment (e.g. `conda install -n 395final nodejs` from conda-forge, or `npm`/`nodejs` packages your course recommends), not via Homebrew for project work.

### Alternative: nvm

If you use **nvm** instead of conda for Node:

```bash
nvm use
npm run install:all
```

See `.nvmrc` (Node 22).

## Node version

Target **Node 22** (see `.nvmrc`) and `engines` in the root `package.json`. Match that inside conda (`nodejs` package version) when possible.

## Google Calendar integration
Currently using Sulekha's "395final" Google Cloud project with test users able to integrate with Google Calendar. Need to add additional emails to project to test authentication.

Two modes of Calendar usage:
- General Call Times: users can set one or more call-time slots per day of week, timezone, and minimum call duration.
- This Week: server and client compute current-week (Sunday-Saturday) free slots from Google Calendar FreeBusy, constrained by General Call Times and minimum call duration.

### Weekly availability redesign notes
- Backend persistence now includes:
  - `users.min_call_minutes`
  - `user_week_availability` (week-specific override slots)
  - `user_google_tokens` (encrypted refresh/access tokens for server sync)
- Run migration:
  - `npm run db:migrate:weekly-availability --prefix server`
- Required backend env:
  - `GOOGLE_TOKEN_ENCRYPTION_KEY`
  - optional token-refresh vars: `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
