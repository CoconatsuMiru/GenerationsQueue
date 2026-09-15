# 🥒 RallyQ

**RallyQ** is a digital paddle board & queue management system for pickleball venues — a modern replacement for the physical clipboard/paddle-rack system many community courts still use.

Organizers can check players in, automatically rotate them onto open courts in FIFO order, keep paired players together, run timed or manual game modes, and announce court assignments out loud — all from a live, multi-device dashboard.

## ✨ Features

- **Automatic FIFO queue** — players are added to a waiting list and automatically assigned to the next open court in groups of 4, once a session is started.
- **Player pairing** — link two players (e.g. partners who want to play together) so they always move through the queue and land on a court as a unit.
- **Upcoming Stacks view** — see exactly which groups of 4 are queued up next, at a glance, in a horizontally scrollable strip.
- **Time-based or manual game mode** — run courts on a configurable warmup / game / overtime timer that auto-clears when time's up, or switch to manual mode where an organizer taps "End Game" whenever a match finishes.
- **Voice announcements** — the app can call out court assignments out loud (using the browser's built-in text-to-speech), so players don't need to keep checking a screen. Includes a voice picker and English-only voice filtering.
- **Session controls** — start/pause a session to control when auto-assignment kicks in, and a one-click reset to clear everything between sessions.
- **Manage Queue sidebar** — search, skip, remove, pair, or unpair any player without leaving the dashboard.
- **Admin settings page** — configure the number of courts, rename/remove courts, adjust timer lengths, and switch game modes, all scoped to your own venue.
- **Multi-tenant accounts** — each organizer signs in and gets their own private courts, queue, and settings. Multiple venues can use PickleQueue independently without seeing each other's data.
- **Realtime sync** — changes made from one device (adding a player, ending a game, editing settings) appear instantly on every other connected device, powered by Supabase Realtime.
- **Responsive layout** — works on desktop, tablet, and mobile, with a court grid that adapts to however many courts a venue has.

## 🛠️ Tech Stack

- **[React](https://react.dev/)** + **[TypeScript](https://www.typescriptlang.org/)** — UI and application logic
- **[Vite](https://vite.dev/)** — build tooling and dev server
- **[Tailwind CSS](https://tailwindcss.com/)** — styling
- **[React Router](https://reactrouter.com/)** — client-side routing (dashboard / admin / auth pages)
- **[Supabase](https://supabase.com/)** — Postgres database, authentication, Row Level Security, and Realtime subscriptions
- **Web Speech API** — in-browser text-to-speech for court announcements (no external API required)

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later recommended)
- A free [Supabase](https://supabase.com/) project

### Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-username/pickle-queue.git
   cd pickle-queue
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**

   Create a `.env.local` file in the project root:
   ```
   VITE_SUPABASE_URL=your-supabase-project-url
   VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
   ```

4. **Set up the database**

   In your Supabase project's SQL Editor, create the required tables (`players`, `courts`, `session_state`, `venue_settings`), enable Row Level Security with per-owner policies, and turn on Realtime for `players`, `courts`, and `session_state`.

5. **Run the dev server**
   ```bash
   npm run dev
   ```

   The app will be available at `http://localhost:5173`.

## 📦 Deployment

PickleQueue is a static Vite app and deploys cleanly to **[Vercel](https://vercel.com/)** — connect the repository, add the same environment variables in your Vercel project settings, and deploy.

## 📄 License

This project is open source and available under the [MIT License](LICENSE).

---

Built as a learning project for exploring React, TypeScript, and Supabase — one incremental step at a time.
