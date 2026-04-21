# Team setup: Neon (database) + Render (API)

This guide walks the group through accounts, one shared database, one deployed API, and wiring the GitHub Pages form.

## Roles (keep it simple)

| Who | Does what |
|-----|-----------|
| **One “owner”** | Creates Neon project, Render service, GitHub `API_BASE_URL` variable (or delegates with access). |
| **Everyone else** | Gets invited to Neon org (optional), Render team (optional), and uses the **public API URL** + local `.env` for development. |

Use a **shared password manager** or **GitHub Secrets** for production credentials—do not paste `DATABASE_URL` in Slack or commit it.

---

## Part A — Neon (Postgres)

1. Go to [https://neon.tech](https://neon.tech) and sign up (GitHub login is fine).
2. **Create a project** (pick a region close to your Render region if you can).
3. **Create a database** (default `neondb` is fine).
4. Open the project → **Connection details** (or Dashboard → connect).
5. Copy the **connection string** for `psql` / apps. It must include **`?sslmode=require`** (Neon usually appends this).
6. **Initialize schema** (pick one approach):
   - **From your laptop (recommended):**  
     ```bash
     cd server
     cp .env.example .env
     # Edit .env: set DATABASE_URL=<paste Neon connection string>
     npm install
     npm run db:init
     ```  
     You should see `Schema applied.`  
   - **From Neon SQL Editor:** open `server/src/schema.sql` in the repo, copy its contents, paste into Neon’s SQL editor, run.

7. **Optional — team access:** Neon → project → invite collaborators by email so others can open the console or run SQL.

---

## Part B — Render (Node / Express API)

1. Go to [https://render.com](https://render.com) and sign up (GitHub login is fine).
2. **New +** → **Web Service**.
3. Connect your **GitHub** account and select the **CallWizard** repository.
4. Configure the service:

   | Setting | Value |
   |--------|--------|
   | **Name** | e.g. `callwizard-api` (becomes part of your URL) |
   | **Region** | Choose one; note it for latency vs Neon region. |
   | **Branch** | `main` (or your default branch) |
   | **Root Directory** | `server` |
   | **Runtime** | `Node` |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance type** | Free is OK for class; expect **cold starts** after idle. |

5. **Environment variables** (Render → your service → **Environment**):

   | Key | Value |
   |-----|--------|
   | `DATABASE_URL` | Same Neon connection string as above (`sslmode=require`). |
   | `NODE_VERSION` | `22` (matches `.nvmrc`; or use `20` if Render prompts for LTS). |

   Render injects **`PORT`** automatically—your app already reads `process.env.PORT`, so **do not** set `PORT` yourself unless Render docs say otherwise.

6. **Deploy.** Wait for the log to show the service **live**.
7. **Smoke test:** open `https://<your-service-name>.onrender.com/health` in a browser. You should see JSON like `{"ok":true}`.
8. **Optional — team access:** Render → **Team** → invite members so everyone can view logs and env vars.

---

## Part C — GitHub Pages form → API

Your static site needs the **public API origin** at **build time**.

1. In GitHub: repo → **Settings** → **Secrets and variables** → **Actions** → **Variables**.
2. **New repository variable:**
   - **Name:** `API_BASE_URL`
   - **Value:** `https://<your-service-name>.onrender.com`  
     (no trailing slash, no `/health`)
3. **Actions** → workflow **Deploy intake website** → **Run workflow** (or push to `main`).
4. After it succeeds, open the intake site (see root `README.md`) and submit the form. You should **not** see the “no API URL” warning, and a successful submit should return a success message.

---

## Part D — Local development (everyone)

1. `nvm use` (Node 22 per `.nvmrc`).
2. `npm run install:all`
3. `cd server && cp .env.example .env` → set `DATABASE_URL` to Neon (team-shared dev DB is OK for a class; use a **branch** in Neon if you want isolation later).
4. `npm run server` from repo root (or `npm run dev` inside `server`).
5. `npm run web` for the intake UI; it proxies `/api` to `http://localhost:3001`.

---

## Troubleshooting

| Symptom | What to check |
|--------|----------------|
| Render build fails | **Root Directory** must be `server`; **Start Command** `npm start`. |
| `/health` works but `POST /users` returns 500 | `DATABASE_URL` on Render; run `db:init` against that DB; Neon project active. |
| Form still says no API URL | `API_BASE_URL` variable set? Workflow re-run after adding it? |
| Browser blocks the request | API must be **HTTPS** (Render is). Mixed content or wrong `API_BASE_URL` (typo, `http` vs `https`). |

---

## Cost notes (typical class project)

- **Neon** free tier: generous for development; check current limits on neon.tech.
- **Render** free tier: web service **spins down** when idle; first request after idle can take ~30–60s.

For demos, hit `/health` once before showing the form, or upgrade to a paid instance for always-on.
