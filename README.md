# CallWizard

Behaviorally lighter catch-up calls: nudges and one-tap dialer flows (mobile + API), plus a simple web intake form.

## Deploy API + database (Render + Neon)

Step-by-step for the whole team (accounts, Neon schema, Render web service, `API_BASE_URL`): **[docs/SETUP-RENDER-NEON.md](docs/SETUP-RENDER-NEON.md)**.

## Repo layout

| Folder   | What it is |
|----------|------------|
| `web/`   | Vite intake UI; deployed to GitHub Pages via `.github/workflows/deploy-web.yml` |
| `server/` | Express API + Postgres (Neon) |
| `mobile/` | Expo (React Native) app for push + `tel:` dialer |

# Quick start (local)

Note! Use the **conda** environment **`395final`** for every shell where you run Node or npm (including Expo).

## 1. Clone the repository

Clone the GitHub repo to a local directory:
```bash
git clone <YOUR_REPO_URL>
cd 395FinalProject
```
## 2. Create Conda Environment
```bash
conda env create -f environment.yml
conda activate 395final
```

Make sure you are in the project root directory
```bash
cd /path/to/395FinalProject   # make sure you're in repo root
npm run install:all
```

Say yes to downloading everything. Confirm Node/npm resolve inside the env (paths should mention `395final` or `conda`) by running the following:

```bash
which node npm
node -v
```
## 3. Update GoogleCloud permissions
For GoogleCloud service to work, you MUST do the following:
Copy the content of tab /mobile/.env in our Proposal Google Doc to a new file you create /mobile/.env

## 4. Set Up Expo Go
To set up the mobile testing via ExpoGo:
```bash
npm run mobile
```
This should launch the project build in the terminal. Type `-s` in the terminal to launch the ExpoGo interface
Download the Expo Go app from the Apple App Store
Make an account for Expo Go
Make sure your device and computer running the code are on same wifi (allow all permissions)

## 5. Moment of truth
```bash 
npm run mobile
```
------ Old stuff ------
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
