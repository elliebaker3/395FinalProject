# CallWizard

Behaviorally lighter catch-up calls: nudges and one-tap dialer flows (mobile + API), plus a simple web intake form.

## Intake form (GitHub Pages)

**Live site:** [https://marinamancoridis.github.io/395FinalProject/](https://marinamancoridis.github.io/395FinalProject/)

The form posts to your deployed API. In the GitHub repo, set the Actions **repository variable** `API_BASE_URL` to your public API origin (no trailing slash), then re-run the **Deploy intake website** workflow or push to `main`.

If the site 404s, enable **Settings → Pages → Build and deployment → Source: GitHub Actions** and confirm the latest **Deploy intake website** run in **Actions** succeeded.

## Repo layout

| Folder   | What it is |
|----------|------------|
| `web/`   | Vite intake UI; deployed to GitHub Pages via `.github/workflows/deploy-web.yml` |
| `server/` | Express API + Postgres (Neon) |
| `mobile/` | Expo (React Native) app for push + `tel:` dialer |

## Quick start (local)

```bash
nvm use
npm run install:all
```

- **API:** copy `server/.env.example` to `server/.env`, set `DATABASE_URL`, then `npm run db:init` and `npm run server`.
- **Web (dev):** `npm run web` — proxies `/api` to `http://localhost:3001`.
- **Mobile:** `npm run mobile` (Expo).

## Node version

See `.nvmrc` (Node 22) and `engines` in the root `package.json`.
