# Orbit

A calm, single-screen **personal tracker** for the disciplines you practise — **Focus**, **Reading**, **Breath**, **Caffeine**, and **Projects** — each with a quick Log view and a clean Insights view. Built as an installable PWA, it works offline and syncs across devices.

> *A ledger for the disciplines you practise — measured daily.*

## Features

- ⏱️ **Focus** — Pomodoro-style timer with subjects, plus blocks/hours insights
- 📖 **Reading** — per-book reading stopwatch, page tracking, and a small library
- 🌬️ **Breath** — guided breathing patterns (box, 4·7·8, …) and meditation, with custom patterns
- ☕ **Caffeine** — one-tap coffee logging with configurable mg and daily insights
- 🛠️ **Projects** — a stopwatch for the things you're building, broken down by project
- 📊 **Insights** — bar charts, hour-of-day heatmaps, streaks, and 1W/4W/3M/1Y windows
- 📴 **Offline-first** — local cache + an outbox queue that flushes when you reconnect
- 🔄 **Cross-device sync** — enter the same sync phrase anywhere to see your history
- 📦 **Export** — download all your data as JSON

## Tech

Vanilla JS, HTML, and CSS — **no build step**. A service worker handles offline; [Supabase](https://supabase.com) (Postgres + RPC) is the backend. Deploys as static files (e.g. on Vercel).

## Quick start

The app ships with **no backend credentials**. Bring your own Supabase project:

1. Follow **[SUPABASE_SETUP.md](SUPABASE_SETUP.md)** to create a project and run [`supabase/schema.sql`](supabase/schema.sql).
2. `cp config.example.js config.js` and fill in your Project URL + publishable key.
3. Serve the folder: `npx serve .` (or any static server) and open it.

## Project layout

| Path | What |
|---|---|
| `index.html` | App shell + all views/sheets |
| `app.js` | All logic — timers, charts, sync, offline queue |
| `styles.css` | The editorial look |
| `sw.js` / `manifest.webmanifest` | PWA offline + install |
| `config.example.js` | Config template (copy to gitignored `config.js`) |
| `supabase/schema.sql` | Database tables + RPC functions |
| `make-icons.js` | Generates the app icons |

## Security note

There is **no real authentication** — your data is namespaced by a SHA-256 hash of your sync phrase. It's great for personal/self-hosted use, but not hardened for serving untrusted multi-tenant users. See the note in [SUPABASE_SETUP.md](SUPABASE_SETUP.md) before exposing it publicly.

## Contributing

Issues and PRs welcome — fork it, experiment, and send improvements back. If you build something interesting on top of it, I'd love to see it.

## License

[AGPL-3.0](LICENSE). In short: you're free to use, modify, and self-host Orbit, but if you distribute it **or run a modified version as a network service**, you must publish your source changes under the same license. (Prefer something more permissive for your fork? Open an issue — but this is chosen deliberately so improvements flow back to the community.)
