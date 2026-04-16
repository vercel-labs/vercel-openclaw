This directory defines the high-level concepts, business logic, and architecture of this project using markdown. It is managed by [lat.md](https://www.npmjs.com/package/lat.md) — a tool that anchors source code to these definitions. Install the `lat` command with `npm i -g lat.md` and run `lat --help`.

## Design scratch routes

`src/components/designs/command-shell.tsx` is the production admin shell, mounted by `src/app/page.tsx` (server component fetches initial `StatusPayload`).

Linear-style layout: 240px sidebar with seven nav views (Status, Channels, Firewall, Terminal, Logs, Snapshots, FAQ), main column, and 320px right-rail live log tail (collapses below 900px to a `<details>` block at the bottom of the main column). Sidebar collapses to a hamburger drawer below 900px; hero actions reflow to a 2-column grid below 640px. Polls `/api/status` (5s) + `/api/admin/logs` (8s, live/pause toggle), supports admin-secret login at `/api/auth/login`, and posts mutations to `/api/admin/{ensure,stop,snapshot,reset,ssh,faq}` and `/api/firewall*`. Hero actions: primary "Open Gateway" when running, "Restore" when stopped, always-visible Snapshot + Stop. Destructive "Reset sandbox" lives in the sidebar footer behind `window.confirm` and posts to `/api/admin/reset`. The legacy `AdminShell` (`src/components/admin-shell.tsx`) is still mounted at `/admin` as a fallback control surface.

Static design mockups remain at `/designs/grid/` and `/designs/editorial/` (Vercel Dashboard and Geist.dev inspired) for visual reference. `/designs/command/` mirrors `/`.
