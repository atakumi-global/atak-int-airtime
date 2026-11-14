# Airtime — Handover

Time tracking and budget management for self-hosted Plane. This file records
where the build stands, what is verified, and what is left.

## Branch and state

- Branch model: `dev` (GitHub default) -> `stage` -> `prod`, promoted by the
  manual **Promote to stage** / **Promote to prod** actions. `prototypes/INTAIRTIME-16`
  keeps the coded design artifacts; GitHub Pages is disabled.
- Work sits on a local stack: `feature/INTAIRTIME-31` -> `feature/INTAIRTIME-32` ->
  `feature/INTAIRTIME-33` (current), based on `dev` at `9c80586`. Nothing is
  pushed; `dev`, `stage` and `prod` are unchanged.
- Working tree clean after this handover is committed.
- Local stack is up and healthy: PostgreSQL container and the dev server
  (`.\air.ps1 status` reports `/health` ok).
- Work is tracked in Plane — workspace `atakumi`, project **Airtime**
  (`INTAIRTIME`); ids in `.plane.json`. Standard docs: `AGENTS.md`,
  `CONSTITUTION.md`, `design-system/DESIGN.md`.

## What was completed

The server (v1.1–v1.8) was already built. This session completed the Windows
desktop client to the approved coded designs in `prototypes/INTAIRTIME-16/v2`, closing
the v1.3–v1.8 client criteria.
  (`/health` reports ok). A browser preview also works (`npm run dev` on
  `http://localhost:5173`); the API client falls back to the web fetch outside
  Tauri and the server allows that origin.

## What was completed

The server (v1.1–v1.8) and the Windows desktop client were built in earlier
sessions. This session closed three QA-audit items from the approved v2 design:
the duration parser, the week/month timesheet view and bulk row entry.

| Commit | Work |
| --- | --- |
| `2b6075e` | Duration parser, `DurationInput`, wired into back-fill and edit (INTAIRTIME-31) |
| `2346c0e` | Review change: top-aligned date/duration, quick chips removed (INTAIRTIME-31) |
| `fbd69ab` | `GET /api/time-entries/summary`: costed entries and period totals (INTAIRTIME-32) |
| `d4b97c8` | Desktop types, `ApiClient.timesheet`, `loadTimesheet`, `periodRange` (INTAIRTIME-32) |
| `cc77cc5` | Week/month timesheet screen with stats, table and states (INTAIRTIME-32) |
| `0dfba9f` | Use the web fetch outside Tauri so the browser preview can sign in |
| `53628f5` | The timesheet replaces My time, keeping the name (INTAIRTIME-32) |
| `c7e977e` | Bulk row entry with save-all and keyboard flow (INTAIRTIME-33) |

Installer built (earlier session):

```
desktop/src-tauri/target/release/bundle/nsis/Airtime_0.1.0_x64-setup.exe
```

Repository hygiene (earlier session) is unchanged: synced lockfiles, trimmed
Docker context, CI on `dev`/`stage`/`prod`, manual fast-forward promotion
actions, `HANDOVER.md` tracked.

## Repository layout

- `server/` — TypeScript, Fastify, PostgreSQL. Accounts, roles, server-side
  authorisation, audit log, Plane sync, time tracking, budgets/rates/burn,
  multi-currency, CSV export, feedback capture. 41 tests.
- `desktop/` — Tauri v2, React, TypeScript. The Windows client.
- `prototypes/INTAIRTIME-16/v1` and `v2` — coded design artifacts (static HTML,
  multi-currency, CSV export, feedback capture, and the timesheet summary
  endpoint with read-time costing. 45 tests.
- `desktop/` — Tauri v2, React, TypeScript. The Windows client. My time is the
  week/month timesheet with bulk entry; the duration parser is shared by the
  timesheet, back-fill dialog and entry edit.
- `design/INTAIRTIME-16/v1` and `v2` — coded design artifacts (static HTML,
  light/dark, WCAG 2.2 AA target). `v2` is the approved set.
- `air.ps1` — brings up PostgreSQL and the dev server locally.

## How to run and verify

```
.\air.ps1 start                 # postgres + dev server, http://localhost:3000
cd desktop
npm install
npm run dev                     # browser preview at http://localhost:5173
npm run tauri dev               # development window (needs Rust on PATH)
npm run tauri build             # NSIS installer
```

Sign in as the bootstrap administrator from `.env` and check:

- **My time** — Week/Month ranges with `‹ ›`, period totals (Total, Billable,
  Uncosted, Cost), entry table with edit; bulk entry: Add row, `1h 30m` in the
  duration cell, Enter saves and opens the next row, Shift+Enter repeats the
  work item, Ctrl+Enter or Save N entries saves all valid rows, an invalid
  duration stays inline.
- **Back-fill / Edit entry** — duration formats `1h 30m`, `1h30m`, `90m`, `2h`,
  `1d` (8h), `1w` (40h), `0.5d`, `+15m`; parsed value echoed; save blocked while
  invalid.
- **Projects** — set or edit a budget per project; budget health, burn and flags.
- **Rates** — dated member, project and project + member rates plus an administrator-set default hourly rate (INTAIRTIME-89); client rates are removed.
- **Reports** — filter by date/project/member and export CSV.
- **Admin** — add/role/remove members, read the audit log, review and export the
  anonymised feedback dataset.
- **Settings** — reporting currency and FX refresh.

## Verification results

- Server: `npm run typecheck`, `npm run lint` and `npm run build` clean;
  `npm test` 45 passed (41 before, 4 for the timesheet summary) against a
  throwaway `airtime_test` database in the local Postgres container.
- Desktop: `npm test` 40 passed (22 at the start of the session), `npm run lint`
  0 errors (2 pre-existing warnings), `npm run build` clean.
- Live check: `/health` ok; `GET /api/time-entries/summary` is registered
  (401 unauthenticated, not 404).
- Rust: release build and NSIS bundle succeed (earlier session).
- Note: a branch push made by the promote actions with `GITHUB_TOKEN` does not
  re-trigger CI on the target branch, so confirm the source branch was green
  before promoting.

## Plane status

State map: Backlog `50c450d6`, Todo `7da2cc89`, In Progress `9b44d5a7`,
Done `463fbefb`.

### Done and signed off

INTAIRTIME-1, 3, 4, 5, 7, 8, 9, 10, 16, 17–24, 26, 31, 32, 33, 53, 55.

### In Progress

- **INTAIRTIME-2** (epic) — closes when its children close.
- **INTAIRTIME-6** v1.4 budgets, rates, burn — meets its child criteria and awaits
  the PO moving it to Done. Caveat: the epic criterion "manager opens the
  project" is served by the Projects list, not a project detail screen; that is
  INTAIRTIME-43.

### In Review

- **INTAIRTIME-34** paused timer state — `POST /api/timer/pause` and `/resume`,
  migration `009_timer_pause`, timer bar Pause/Resume and paused state; the
  desktop context exposes `timerState` (`idle`, `running`, `paused`),
  `pauseTimer` and `resumeTimer` for the tray work (INTAIRTIME-35–37). The tray
  itself is not part of this item.

- **INTAIRTIME-35** system tray and close-to-tray — `desktop/src-tauri/src/tray/`
  (`model.rs`, `icon.rs`, `mod.rs`), frameless window with the 36px
  `TitleBar` and live mini-timer, `TrayBridge` mirroring `timerState` into the
  tray. The Tauri v2 Windows capability matrix is recorded in
  `desktop/README.md`. Not yet run on Windows (built and type-checked on Linux
  only). Manual pass on Windows with `npm run tauri dev`: tray icon appears and
  swaps glyph for idle / running / paused / offline; left click restores the
  window; right-click menu shows the state's primary action; Close hides to the
  tray and the running timer keeps counting in the tray tooltip and menu;
  Quit Airtime exits; title bar drags, double-click maximises, controls work.
  INTAIRTIME-36 and 37 add modules beside `tray/`.

- **INTAIRTIME-36** desktop notifications with actions — desktop only.
  `desktop/src-tauri/src/notify/` (`model.rs` pure, `mod.rs` Windows toast glue
  on `tauri-winrt-notification`, new Windows-only dependency),
  `NotificationBridge` + `lib/notifications.ts` on the web side. Success "Entry
  saved" (View), warning "Margin below target" (Open), error "Timer stopped
  unexpectedly" (Restart). Withheld while the window is in view and under Focus
  Assist / full-screen; no animation of its own (reduced motion follows the
  Windows setting). Details in `desktop/README.md`. Compiles for Windows and the
  Rust model has 14 unit tests (standalone harness); not run on Windows. Manual
  pass: stop a timer with the window minimised and see "Entry saved"; turn on
  Focus Assist and confirm nothing appears; stop the timer server-side and see
  "Timer stopped unexpectedly" with Restart; check a release build shows the
  Airtime name and icon.

- **INTAIRTIME-37** shortcut help surface and remaining shortcuts — desktop only.
  `lib/shortcuts.ts` holds the map (Ctrl+Alt+T timer, Ctrl+Alt+B back-fill,
  Ctrl+K search work items, Ctrl+Alt+S timesheet, Ctrl+Alt+M tray menu,
  Ctrl+Enter save) and `state/ShortcutsContext.tsx` the bindings, stored per
  device in `localStorage` (`airtime.shortcuts`). Help is Shell nav "Keyboard
  shortcuts"; rebinding is in Settings. Dialogs share `ModalDialog` (focus trap,
  Escape, save shortcut). Ctrl+Alt+M opens an in-window copy of the tray menu
  (`TrayMenuDialog`, same actions as the tray through `useTrayActions`). Limits:
  shortcuts work while the Airtime window has focus; OS-wide hotkeys (a hidden
  window) would need the Tauri global-shortcut plugin and are not built. Not run
  on Windows.

### Not fully done

- **INTAIRTIME-27** PDF export — not started; needs a template review and a server
  PDF library. Blocks INTAIRTIME-69 (invoicing).
- **INTAIRTIME-28** multi-workspace sync — not started; sized L.
- **INTAIRTIME-25** track expenses — built (migration `010_expenses`, `/api/projects/:id/expenses`, `/api/expenses/:id`, cost and CSV export include expenses, desktop Expenses panel and dialog); In Review.
- **INTAIRTIME-11–15** future activity capture — backlog by design.
- **INTAIRTIME-17–24** Design 1–8 — coded work exists in `prototypes/INTAIRTIME-16/v2`,
  but the tickets are still Todo; they need a decision to close, not code.
- **INTAIRTIME-30, 35–52, 54, 56** — the rest of the QA-audit batch. High-priority
  missing items: 42 (Price, Profit and targets), 43 (project detail).
- **INTAIRTIME-57–70** — the newer roadmap batch, untouched.
- **INTAIRTIME-33 follow-up** — the PO-added bulk update/delete was descoped; it
  needs INTAIRTIME-64's lock state and a selection design.
- Copy-last-week, split and duplicate (PO additions to INTAIRTIME-32) were
  descoped for the same reason: no design reference.

### Dev preview

- **INTAIRTIME-95** (dev preview did not start) — root cause was in `stack.sh`, not in a
  migration: the preview's Postgres container was running and healthy but had lost its
  published port 3502, and `docker compose up --wait` accepted it. `stack.sh start` now
  checks that the database port listens and otherwise recreates the services (volumes
  and data kept). Test: `server/test/stack.test.ts`.

- **INTAIRTIME-102** (dev fails factory-check) — `desktop/src-tauri/Cargo.lock` pinned
  `quinn-proto` 0.11.18 and `quinn-udp` 0.5.15, both flagged by osv-scanner
  (RUSTSEC-2026-0523, RUSTSEC-2026-0524, RUSTSEC-2026-0538). Updated to 0.11.19 and
  0.5.16 with `cargo update -p quinn-proto -p quinn-udp`; regenerating the lock also
  corrected a few dependency edges (`syn`, `windows-sys`) that pointed at versions the
  crates' registry metadata does not allow. `factory-check` and the gate pass on `dev`.
  Note for the owner: `osv-scanner.toml` reports an unused ignore for
  RUSTSEC-2024-0429 (already covered by its GHSA alias); the file is governed and was
  left untouched.

## Remaining work, in order

1. Push the stack (`feature/INTAIRTIME-31`..`33`) and open PRs into `dev`; promote
   when the build is signed off.
2. INTAIRTIME-42 Price/Profit/targets: record the two open definitions first
   (how Profit is defined, whether the margin target is an amount or a
   percentage), then build.
3. INTAIRTIME-43 project detail screen (needs 42 for the five-number summary; also
   closes the INTAIRTIME-6 caveat).
4. INTAIRTIME-27 PDF export: template, then generation.
5. INTAIRTIME-28 multi-workspace: built (server and desktop), awaiting review.
6. Remaining QA-audit items (30, 34–52, 54, 56).
7. Ask the PO to move INTAIRTIME-6 to Done.

## Decisions and assumptions

- INTAIRTIME-90 workspace access: a member sees and enters time on a Plane project
  only while Plane lists them as a member of it (their own token). History stays
  visible but frozen. A SHA-256 over the member's project memberships
  (`plane_connections.access_hash`) is the permission-change check before time
  entry. Administrators see all projects; managers only theirs. Details in
  README "Workspace access". INTAIRTIME-28 builds on `connectionWorkspaces()` and
  `project_access`.

- INTAIRTIME-28 multi-workspace: a connection (base URL + account token) reads a
  list of workspace slugs (`plane_connection_workspaces`, migration 013); each
  slug is verified alone and one failure never stops the rest. Projects and work
  items carry `workspace_slug`; webhooks are per workspace (Plane stores
  webhooks per workspace and each delivery names it), and the old connection
  webhook secret moved to the migrated workspace row, so existing webhook URLs
  keep working. Plane UUIDs are primary keys generated per record
  (`BaseModel.id = UUIDField(default=uuid4, unique=True)`), so the existing
  `(organisation_id, plane_*_id)` keys stay. Archived projects are synced,
  flagged and refuse new time. Visibility follows INTAIRTIME-90 (project
  membership; administrators see all). Totals per project and per workspace.
  Details in README "Plane connection and sync".

- INTAIRTIME-100 reduced Plane polling: connect and manual sync still read every
  work item, but a poll and a webhook read only what changed. Plane's Community
  API (the instance runs v1.4.2) rejects the `filters`/`pql` parameters and has
  no `updated_at` filter, so `PlaneClient.listIssues(projectId, since)` requests
  `order_by=-updated_at` with a small page and stops paging at the first item
  older than the workspace's `last_synced_at` minus `SYNC_LOOKBACK_SECONDS`
  (default 600). A workspace that has never synced is read in full, so a quiet
  project costs one small request instead of its whole history. Details in README
  "Plane connection and sync".

- INTAIRTIME-16 v2 is the approved design; screens were implemented without
  per-screen checkpoints, then reviewed.
- My time is now the week/month timesheet; the earlier day-list screen was
  removed.
- Timesheet totals: Total and Billable are summed client-side; Cost and
  Uncosted come from server read-time costing (most specific rate wins), cost
  converted to the reporting currency. Uncosted means no applicable rate.
- The duration parser accepts only the documented formats; bare numbers such as
  `90` are rejected. The quick-duration chips were removed at review.
- Bulk entry: Enter saves the row and appends a fresh row with the same date,
  Shift+Enter keeps the work item, Ctrl+Enter/Save N saves every valid row and
  leaves invalid rows inline with errors. Draft rows preview Billable (10-minute
  floor) and show Cost as `—`; there is no focusable Billable control until
  INTAIRTIME-41.
- Bulk saves are one POST per row with a single refresh afterwards; network
  failures queue each row and leave the grid.
- Entry date/duration edits are sent as `startedAt`/`endedAt`; the server derives
  duration from them and has no `date` field.
- Delete has no undo in the client: the server soft-deletes but exposes no
  restore route. Edit undo re-applies the previous values via another PATCH.
- Edits and deletes are not queued offline; a network error is surfaced instead.
- Rate client scope takes a raw client id (Plane has no clients list).
- Members, roles, audit and feedback are grouped into one tabbed Admin screen.
- CSV download uses a Blob anchor; in the Tauri app all requests go through the
  HTTP plugin (loopback/CORS), in a plain browser through the web fetch.
- Branch model is `dev` -> `stage` -> `prod`; feature branches stay local until
  promoted by PR or push, and promotion is fast-forward only.

## Resume

- Next build: `/work-issue INTAIRTIME-42` (record the two definitions first), then
  `/work-issue INTAIRTIME-43`.
- Also queued: `/work-issue INTAIRTIME-27`, `/work-issue INTAIRTIME-28`.
- Approvals: move INTAIRTIME-6 to Done.
- Publish: push `feature/INTAIRTIME-31`..`33` and PR into `dev`, then run the
  manual **Promote to stage** / **Promote to prod** actions when signed off.
