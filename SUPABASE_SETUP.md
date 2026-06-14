# Bring your own Supabase

Orbit stores everything in a [Supabase](https://supabase.com) project. The app ships with **no backend credentials** — you connect it to a free Supabase project of your own in a few minutes.

## 1. Create a project

1. Sign in at [supabase.com](https://supabase.com) and create a new project (the free tier is plenty).
2. Wait for it to finish provisioning.

## 2. Create the database schema

1. In the dashboard, open **SQL Editor → New query**.
2. Paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql) and run it.

This creates the tables (focus blocks, books, reading/wellness/project sessions, caffeine logs, projects) and the RPC functions the client calls.

> ⚠️ **Note on the schema:** `supabase/schema.sql` was reconstructed from the client code, so it's a faithful starting point but may differ slightly from the original author's live database. If you ever get access to an authoritative dump, prefer it:
> ```bash
> supabase db dump --schema public -f supabase/schema.sql
> ```

## 3. Get your API credentials

In the dashboard: **Settings → API**. Copy:

- **Project URL** — e.g. `https://abcdefgh.supabase.co`
- **Publishable key** (newer projects) **or anon key** (older projects) — the public client key. Safe to ship in the browser.

> Never put the **service_role** / secret key in `config.js` or anywhere client-side.

## 4. Configure the app

```bash
cp config.example.js config.js
```

Edit `config.js` with your two values:

```js
window.ORBIT_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_KEY: "YOUR-PUBLISHABLE-OR-ANON-KEY",
};
```

`config.js` is gitignored, so your credentials stay on your machine.

## 5. Run it

It's a static PWA — any static server works:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Open the printed URL, enter any **sync phrase** (it's hashed locally into your data "vault"), and start logging. Use the same phrase on another device to sync.

## Deploying

- **Vercel CLI** (`vercel`): `config.js` is uploaded with your deploy even though it's gitignored, so this works out of the box.
- **Vercel Git integration** (auto-deploy from GitHub): gitignored files are **not** in the repo, so `config.js` won't be present. Either commit a deploy-only config, or inject the two values at build time. (The current app reads `window.ORBIT_CONFIG`, so a tiny build step that writes `config.js` from environment variables is the cleanest option.)

## Security note

The current model has **no real user authentication** — data is namespaced by a SHA-256 hash of your sync phrase ("vault"), and access is gated by `SECURITY DEFINER` RPC functions plus RLS that blocks direct table access. This is fine for personal/self-hosted use. **Do not** treat it as multi-tenant-secure for untrusted users without adding real Supabase Auth + per-user RLS first.
