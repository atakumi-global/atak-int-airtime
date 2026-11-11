# Airtime

Time tracking and budget management for self-hosted [Plane](https://plane.so).
Airtime reads projects and work items from Plane with a per-user API token and
adds time-and-materials budgets, rates, burn and export on top, without changing
Plane.

This repository currently contains the **Airtime server** (`server/`): the
service that owns shared state - accounts, roles, projects, rates, budgets and
time entries - plus its PostgreSQL schema, OIDC/local sign-in, role-based access
control, financial audit log and Docker deployment (work item `INTAIRTIME-3`,
v1.1). It reads projects and work items from Plane using a per-user API token,
stored encrypted at rest, kept fresh by webhooks and a polling fallback (work
item `INTAIRTIME-4`, v1.2). It records time with a one-timer-per-member start/stop
and manual back-fill, a 10-minute billable minimum and a full edit history
(work item `INTAIRTIME-5`, v1.3). The **Windows desktop client** lives in
`desktop/` (work item `INTAIRTIME-9`, v1.7) and is described further down.

The coded design system and product screens live under `prototypes/INTAIRTIME-16/v2`.

## Prerequisites

- Docker Desktop (for the documented deployment path), or
- Node.js 20+ and a PostgreSQL 16 database (for local development)

## Deploy with Docker

On a clean host with Docker installed:

```sh
cp .env.example .env   # then edit secrets and the bootstrap admin password
docker compose up -d
```

The command builds the server image, starts PostgreSQL, applies migrations and
reports healthy. Confirm with:

```sh
docker compose ps                    # server should be healthy
curl http://localhost:3000/health    # {"status":"ok","database":"up"}
```

The first start creates a single organisation and a bootstrap administrator from
`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD`. Change the defaults in `.env`
before exposing the server. Generate `APP_JWT_SECRET` and `COOKIE_SECRET` with
`openssl rand -hex 32`.

## Local development

On Windows, `air.ps1` brings up PostgreSQL in Docker and the dev server (tsx
watch) in a psmux session, generating `.env` secrets and a free database port on
first run:

```powershell
.\air.ps1 start     # postgres + npm run dev in session "airtime"
.\air.ps1 status    # containers, session windows and /health
.\air.ps1 attach    # watch the server and postgres logs
.\air.ps1 stop      # stop both
```

Or by hand:

```sh
npm install
cp .env.example .env                 # point DATABASE_URL at your Postgres
npm run dev                          # tsx watch on http://localhost:3000
```

`npm run dev` loads `.env` from the repository root when present. Migrations run
automatically on start.

## Time tracking

`POST /api/timer/start` starts a timer for the signed-in member; starting a
second timer stops the first and records it as an entry. `POST /api/timer/pause`
freezes the timer and `POST /api/timer/resume` continues it; both answer 409
(`no_timer`, `already_paused` or `not_paused`) when the transition does not
apply. The timer carries `state` (`running` or `paused`), `paused_at` and
`paused_seconds`, so a pause survives a restart and paused time is never counted.
`POST /api/timer/stop` creates an entry from the running or paused timer. `POST /api/time-entries` back-fills
manually from a `date` and `durationMinutes`, or from explicit `startedAt` and
`endedAt`.

Every entry stores `duration_minutes` and `billable_minutes`; the billed figure
is floored at 10 minutes. A zero or negative duration, or an end before the
start, is rejected with a 400 and a message. Each create, edit and delete writes
a history row with the previous and new value, the author and a timestamp,
readable at `/api/time-entries/:id/history`. Deleted entries are soft-deleted so
their history survives, and members can only change their own entries.

## Budgets and burn

A time-and-materials budget is an amount and currency per project, set with
`PUT /api/projects/:id/budget`, optionally with `price`, `profitTargetPercent`
and `marginTargetAmount`. Time is costed at read time using the most specific
rate in effect on the entry's UTC date: a project + member rate, then a project
rate, then a member rate, then the organisation default hourly rate (NZD 200 unless
an administrator changes it with `PATCH /api/organisation`). Every rate has a
required `fromDate` (`PUT /api/rates`) and applies from that date until a later-dated
rate for the same target replaces it; if none is in effect the next level is tried.
Changing, back-dating or deleting a rate recosts history on the next read.

`GET /api/projects/:id/summary` returns spend, remaining, percent used, uncosted
hours, any totals in other currencies, the current burn rate per day and a
projected overrun or underrun. It also returns the financial model: `margin`
(available budget minus cost), `price`, `profit` (price minus cost) and both
targets with a met flag. Profit and its target are null until a price is set.
Cost (`spent`) is costed time (`labourCost`) plus expenses (`expenses`, see
Expenses below). The cost build-up
comes back as `billableMinutes`, `costByScope` (cost at member, project,
project + member or default rate level) and `weeklyCost`, the converted cost per ISO week for the
last 12 weeks, which backs the burn chart. The projection runs
from today to the project's `target_date` synced from Plane; `projectionBasis`
reports `project_end_date` when that date is used. Only when a Plane project has
no target date does it fall back to a fixed `PROJECTION_HORIZON_DAYS` (default
30) and report `default_horizon`. A project is flagged `over` when spend exceeds
the budget and `warning` when less than 10 percent remains, or either target is
missed. `GET /api/projects?withBudget=true` adds the same summary to every
project row so lists can flag at-risk projects.

## Expenses

Managers and administrators record non-labour costs (licences, travel, hardware,
subcontractors, other) against a project: `POST /api/projects/:id/expenses` with
`date`, `amount`, `currency`, `category`, optional `note` and optional
`workItemId` (a synced work item of the same project). `GET
/api/projects/:id/expenses` lists them for every member (read-only);
`PATCH` and `DELETE /api/expenses/:id` change them (managers and administrators),
and `GET /api/expenses/:id/history` returns the audit trail with before, after,
author and timestamp. Deletes are soft deletes.

The amount converts to the reporting currency when it is saved, and the
resulting amount, rate and rate date are stored with the expense (a foreign
currency with no stored rate is refused with `422 fx_rate_unavailable`). Editing
the amount or currency records a new rate. Expenses count toward `spent`, so
remaining budget, margin, profit, burn and the weekly series include them; the
summary adds `labourCost` and `expenses` (total, count, per category, original
currency totals). If the reporting currency changes later, expenses are
converted again with the latest rates.

## Multi-currency

Each workspace has a reporting currency (`PATCH /api/organisation`, administrator
only, audited). Amounts are stored in their original currency and converted when
read, using daily rates from Frankfurter (European Central Bank reference rates,
EUR-based), which needs no API key. Set `FX_PROVIDER_URL` to any compatible
endpoint; `FX_REFRESH_HOURS` (default 24) controls the scheduler, and
`POST /api/fx/refresh` forces a fetch.

Every budget summary reports `spent` in the reporting currency, a
`currencyTotals` breakdown of the original amounts, and a `conversions` entry per
currency with the rate and its date. If the provider is unavailable, the last
stored rates are used and marked `fxStale`, so totals still render. A cost in a
currency the provider does not publish is counted under `unconverted` and left
out of totals rather than crashing the view.

## Export

`GET /api/exports/time-entries.csv` exports one row per entry, filterable by
`from`, `to`, `projectId` and `memberId`. Columns cover project, member, date,
duration, work item, rate, currency and cost, plus the converted cost, reporting
currency and the FX rate and date used. The file is UTF-8 with a BOM and CRLF
line endings, and fields containing commas, quotes or newlines are quoted, so it
opens directly in Excel. Expenses follow the time rows with `source` set to
`expense`, the note in `description`, the amount and currency as `cost` and
`currency`, and two extra columns, `type` (`time` or `expense`) and `category`.
A `memberId` filter leaves expenses out.

PDF export is deferred to INTAIRTIME-27 in the backlog so its layout gets a visual
review first.

## Feedback capture

Opt-in per member via `PATCH /api/me/feedback`. While opted in, every create,
edit and delete of a time entry also writes a feedback event for the future
inference engine: action, source, before and after values and a timestamp. The
stored event is anonymised - the member is a keyed hash, and descriptions, cost
and identifiers are stripped - and nothing is written while a member is opted
out. The entry edit history itself is always kept, as v1.3 requires.

Administrators can review events with `GET /api/feedback` and pull the anonymised
dataset with `GET /api/feedback/export`.

## Desktop client (Windows)

`desktop/` is the Tauri v2 + React + TypeScript client, ported from the coded
designs in `prototypes/INTAIRTIME-16/v2`. It signs in to the Airtime server, caches
projects, work items, entries and the running timer to disk so the first screen
renders before any network call, queues back-filled entries while the server is
unreachable, and keeps the session token in Windows Credential Manager - never
in a file.

```powershell
cd desktop
npm install
npm run tauri dev      # development window with hot reload
npm run tauri build    # NSIS installer under src-tauri/target/release
```

Implemented: sign-in and cache-first boot; My time (week summary, entries, edit
and delete with history and undo, loading and empty states); back-fill dialog;
always-visible timer bar with `Ctrl+Alt+T`; Projects with budget health flags
and burn, and a budget dialog for managers; Budgets (member, project and client
rates); Reports with filtered CSV export; Admin (members and roles, audit log,
anonymised feedback review and export); Settings (account, feedback opt-in, FX
status and refresh, reporting currency, Plane connect and sync).

PDF export is deferred to INTAIRTIME-27 so its layout gets a visual review first;
CSV is the supported export in this release.

Checks: `npm test`, `npm run build`, `npm run lint`. The Rust side builds with
`cargo check` inside `desktop/src-tauri` (needs Rust and the MSVC C++ tools).

## Roles

| Role | Capabilities |
| --- | --- |
| `administrator` | Everything a manager can do, plus manage members and read the audit log |
| `manager` | Read projects, create budgets, set rates, read audit-gated data |
| `member` | Read projects and budgets, read own profile |

Every role-gated route enforces the rule server-side and returns `403` for a
caller without the role.

## API (v1.1)

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/health` | public |
| `POST` | `/auth/login` | public |
| `GET` | `/auth/oidc/login`, `/auth/oidc/callback` | public (when OIDC configured) |
| `POST` | `/auth/logout` | public |
| `GET` | `/api/me` | any authenticated member |
| `GET` | `/api/members` | manager, administrator |
| `POST` | `/api/members` | administrator |
| `PATCH` | `/api/members/:id/role` | administrator |
| `DELETE` | `/api/members/:id` | administrator |
| `GET` | `/api/projects` | any authenticated member |
| `POST` | `/api/projects` | manager, administrator |
| `PATCH` | `/api/projects/:id` | manager, administrator |
| `GET` | `/api/projects/:id/summary` | any authenticated member |
| `GET` | `/api/projects/:id/budget` | any authenticated member |
| `PUT` | `/api/projects/:id/budget` | manager, administrator |
| `DELETE` | `/api/projects/:id/budget` | manager, administrator |
| `GET` | `/api/rates` | manager, administrator |
| `PUT` | `/api/rates` | manager, administrator |
| `DELETE` | `/api/rates/:id` | manager, administrator |
| `GET` | `/api/audit` | administrator |
| `GET` | `/api/organisation` | any authenticated member |
| `PATCH` | `/api/organisation` | administrator |
| `GET` | `/api/fx/rates` | any authenticated member |
| `POST` | `/api/fx/refresh` | administrator |
| `GET` | `/api/exports/time-entries.csv` | manager, administrator |
| `PATCH` | `/api/me/feedback` | any authenticated member |
| `GET` | `/api/feedback` | administrator |
| `GET` | `/api/feedback/export` | administrator |
| `GET` | `/api/plane/connection` | any authenticated member |
| `PUT` | `/api/plane/connection` | any authenticated member |
| `DELETE` | `/api/plane/connection` | any authenticated member |
| `POST` | `/api/plane/workspaces/verify` | any authenticated member |
| `POST` | `/api/plane/sync` | any authenticated member |
| `GET` | `/api/plane/work-items` | any authenticated member |
| `POST` | `/api/plane/webhook/:secret` | public (secret path) |
| `GET` | `/api/timer` | any authenticated member |
| `POST` | `/api/timer/start` | any authenticated member |
| `POST` | `/api/timer/pause` | any authenticated member |
| `POST` | `/api/timer/resume` | any authenticated member |
| `POST` | `/api/timer/stop` | any authenticated member |
| `GET` | `/api/time-entries` | any authenticated member (own; managers all) |
| `POST` | `/api/time-entries` | any authenticated member |
| `PATCH` | `/api/time-entries/:id` | entry owner, manager, administrator |
| `DELETE` | `/api/time-entries/:id` | entry owner, manager, administrator |
| `GET` | `/api/time-entries/:id/history` | entry owner, manager, administrator |

Authenticate with `Authorization: Bearer <token>` from `/auth/login`, or the
`airtime_token` cookie set on sign-in. Every rate and budget change is written to
the audit log with actor and timestamp.

## Plane connection and sync

`PUT /api/plane/connection` takes `baseUrl`, `workspaceSlugs` (a list) and a Plane
personal API token (INTAIRTIME-28). One account token covers every workspace its
user can reach, but Plane has no token-authenticated endpoint that lists
workspaces, so the member names the slugs. Slugs are trimmed, de-duplicated
case-insensitively, validated against Plane's slug rule (letters, digits, `-`,
`_`, at most 48) and capped at 20 per connection; an empty slug is rejected with
`400 empty_workspace_slug`. Each slug is verified on its own with a read-only
`GET /workspaces/{slug}/projects/`. A slug the token cannot read is stored with
status `failed`, an `errorCategory` (`unauthorised`, `not_found`, `network`) and a
fixed message (never the token or Plane's response); the others are stored and
synced. The save is refused (`400 plane_verification_failed`, with the per-slug
results) only when no slug can be read. `token` may be omitted to keep the stored
one while the list is edited. The token is stored encrypted with AES-256-GCM under
`TOKEN_ENCRYPTION_KEY`. `POST /api/plane/workspaces/verify` ("Verify all")
re-checks every slug with the stored token. Removing a slug hides its projects
and work items from that member; time entries, budgets, rates and audit records
stay in the database, and projects where the member recorded time stay readable
as history.

Sync reads every configured workspace in one run, each project and its work
items attributed to the workspace they came from (`workspace_slug` on `projects`
and `work_items`). A workspace that fails does not stop the others: the run is
recorded as `partial`, the workspace shows its error, and member access is left
as it was (nothing is revoked on a failed read). When every workspace fails the
sync fails. Airtime only ever issues `GET` requests to Plane.

Connecting and a manual sync read every work item. A poll and a webhook read
only what changed: Plane's Community API has no `updated_at` filter, so the work
items are requested ordered by `updated_at` descending in small pages and paging
stops at the first item older than the workspace's last successful sync minus
`SYNC_LOOKBACK_SECONDS` (default 600). A quiet project therefore costs one small
request instead of its whole history, while anything changed within the lookback
window is still read. The watermark is each workspace's `last_synced_at`; a
workspace that has never synced is read in full.

Plane registers webhooks per workspace (`workspace_webhooks`), and every delivery
names its workspace (`workspace_id` and `workspace_slug` in the payload; the
signature is an HMAC with that webhook's own secret). Each configured workspace
therefore has its own webhook path (`webhookPath` on each entry of
`connection.workspaces`); a delivery syncs only that workspace. Register one
webhook per workspace for the 5 second freshness; a scheduler polls each
connection every `SYNC_POLL_SECONDS` (default 60) as a fallback.
`GET /api/plane/work-items` returns the open work items, optionally filtered by
`projectId` or `workspace` (add `includeClosed=true` for all); each carries
`workspace_slug`. `GET /api/projects` accepts `workspace` too, and with
`withBudget=true` also returns `workspaces`: totals per workspace (budget, cost,
labour, expenses, billable minutes, project counts), each the sum of the project
rows the caller can read. Time entries and the timer carry `workspace_slug`, and
the CSV export has a final `workspace` column.

Archived Plane projects are synced like any other (Plane lists them), flagged
`archived`, and refuse new time (`409 project_archived`); their history stays
readable. A workspace that Plane no longer answers for (deleted, or the token lost
access) shows as `failed`; its projects stay as history.

### Workspace access

Airtime follows Plane's own permissions. A member sees a Plane project, its work
items, time entries, budgets, expenses, rates, reports and CSV rows only while
Plane lists them as a **member of that project**, checked with their own token
(the `is_member` flag of `GET /workspaces/{slug}/projects/`; public projects the
member has not joined do not count). Administrators see every project; managers
only the projects they belong to. Projects with no Plane link are open to the
organisation.

When a member loses a project, the history stays visible but frozen: recorded
entries, budgets and expenses remain readable, and starting a timer, adding,
editing or deleting time, and changing budgets, rates or expenses on it is
refused (`403 project_access_required`; a project the member never had answers
`404`). Work items and projects carry `can_enter_time` so clients can hide what
would be refused.

Permission changes are detected with one hash. Every check stores
`access_hash` (a SHA-256 over the sorted `workspace/project-id` pairs the member
belongs to) on the connection, returned by `GET /api/plane/connection`. Before
time is entered the server re-reads the member's memberships when the last check
is older than `ACCESS_RECHECK_SECONDS` (default 60), compares the new hash with the
stored one and, if it differs, rewrites the stored access and writes an
`access.changed` audit entry. A refused request is re-checked once against Plane
before it stands. `POST /api/plane/access/check` forces a check and returns the
hash. If Plane is unreachable, the last verified access is trusted for
`ACCESS_MAX_STALE_SECONDS` (default 3600), after which time entry fails with
`503 access_unverifiable`. Sync and the poll scheduler apply the same check.
Disconnecting Plane turns a member's current access into history.

`TOKEN_ENCRYPTION_KEY` is required to save a connection and must be 32 bytes as
64 hex characters. Losing it means stored Plane tokens cannot be decrypted and
must be re-entered.

## Scripts

```sh
npm run typecheck
npm run lint
npm run build
npm test          # integration tests; requires TEST_DATABASE_URL
```

The tests need a throwaway PostgreSQL database. For example:

```sh
docker run -d --name airtime-test-pg \
  -e POSTGRES_USER=airtime -e POSTGRES_PASSWORD=airtime -e POSTGRES_DB=airtime_test \
  -p 6010:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://airtime:airtime@localhost:6010/airtime_test npm test
```

## Branches

`dev` is the default branch and integration point; feature branches merge into
it. `stage` is pre-production and `prod` is production. Promotion is manual:
run **Promote to stage** (`dev` -> `stage`) or **Promote to prod**
(`stage` -> `prod`) from the Actions tab. Both are fast-forward only and fail if
the target has diverged. CI runs on pushes and pull requests to these three
branches. The coded design artifacts stay in `design/` as static HTML.

## Licence

Airtime reuses Plane code and tokens and is therefore a derivative work of
Plane, which is licensed AGPL-3.0. Airtime is released under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
Copyright (C) 2026 atakumi-global.
