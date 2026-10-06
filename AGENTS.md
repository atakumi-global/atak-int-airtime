# AGENTS.md — Airtime

> Master contract for this repository: what it is, how it is worked, and what is
> never allowed. `README.md` covers setup and deployment; `HANDOVER.md` covers
> current state.

## What this is

Time tracking and budget management for self-hosted **Plane**. Airtime reads
projects and work items from Plane (per-user API token, encrypted at rest) and
adds time-and-materials budgets, rates, burn and export on top — without changing
Plane.

- **Repo:** https://github.com/atakumi-global/airtime
- **Plane project:** `AIRTIME` — see `.plane.json`
- **Branch flow:** `dev` (default) → `stage` → `prod`, promoted only by the manual
  **Promote to stage** / **Promote to prod** actions.

## Plane — source of truth

Work is tracked in Plane: workspace **`atakumi`**, project **Airtime**, identifier **`AIRTIME`**. Ids live in `.plane.json` — that file is the only authoritative source for the workspace.

- **Identifiers are automatic.** Plane assigns the next number (`AIRTIME-42`). Never choose, invent or reuse one.
- Estimates are Fibonacci points (1, 2, 3, 5, 8, 13) set via the project's estimate system (`estimate_point`); above 13 means split.
- **Lifecycle:** Backlog → Prepare → Todo → In Progress → Blocked → In Review → Approved → Deployed to stage → Approved by client → In production → Done / Cancelled.
- **Approval is human.** An agent moves work and records evidence; it never approves, and never moves an item past **In Review** without a recorded human approval. On this Plane build there are no custom fields: approval is the item's state - a human moves it from **In Review** to **Approved** or later; labels and comments are not required. Designs link to features as **child** items.
- **Pickup:** only items assigned to `martijn+opencode@atakumi.com` in **Todo**. Set **In Progress** before changing anything; never touch a ticket that is not yours.
- **Workspace is confirmed, never assumed.** Never infer a workspace from another repo, an old config, or a previous session.

### Links — always clickable

- Base `https://plane.atakumi.net`; workspace `atakumi`, project `AIRTIME` (`e7756e01-aeaf-4c66-9dfe-cc189a792546`).
- **Issue list:** `https://plane.atakumi.net/atakumi/projects/e7756e01-aeaf-4c66-9dfe-cc189a792546/issues/`
- **Work item:** that path plus `{work-item-uuid}/` — trailing slash is fine. The bare project root 404s, so link the `/issues/` list instead.
- **Format:** `[AIRTIME-32 — Short title](https://plane.atakumi.net/atakumi/projects/e7756e01-aeaf-4c66-9dfe-cc189a792546/issues/<work-item-uuid>/)`
- The work-item UUID is the item's `id` field (`workitem retrieve`, or `retrieve_by_identifier`). The human identifier (`AIRTIME-32`) is not in the URL.
- Every mention of a work item in a reply carries its link. No link means an incomplete answer.

## Stack

| Area | Tech |
| --- | --- |
| Server | TypeScript, Fastify, PostgreSQL 16 — accounts, roles, RBAC, audit log, Plane sync, time tracking, budgets/rates/burn, multi-currency, CSV export |
| Desktop | Tauri v2 + React + TypeScript (Windows client) |
| Runtime | Node 20+ |
| Package manager | npm (workspaces: root → `server`) |
| Deploy | Docker Compose; Coolify |

## Layout

```
server/                    Fastify API + PostgreSQL schema + tests
desktop/                   Tauri v2 Windows client (Vite + React)
prototypes/AIRTIME-16/v1   coded design artifacts (superseded)
prototypes/AIRTIME-16/v2   coded design artifacts — the APPROVED set
design-system/DESIGN.md    binding visual contract
air.ps1                    local stack: PostgreSQL + dev server
```

## Key commands

```bash
# Root (proxies the server workspace)
npm run dev          # dev server
npm run build        # build server
npm run typecheck
npm run lint
npm test             # server tests (45)

# Desktop
cd desktop && npm run dev && npm test && npm run build

# Local stack (Windows)
.\air.ps1 start|status|attach|stop
```

## Done-gate

Run before calling anything done:

```bash
npm run lint && npm run typecheck && npm test && npm run build
cd desktop && npm run lint && npm test && npm run build
```

For design work, confirm the change matches `prototypes/AIRTIME-16/v2`.

## Conventions

- Server code in `server/src`; tests in `server/test/*.test.ts`
  (`node --test`, concurrency 1).
- Authorisation is enforced server-side in every route; the desktop client is
  never trusted.
- Secrets come from the environment (`.env`, gitignored); `opencode.json` is
  gitignored too.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
  `test:`, `perf:`, `ci:`.

## Design

- `prototypes/AIRTIME-16/v2` is the approved coded design set — implement against
  it, not from memory.
- `design-system/DESIGN.md` is the binding contract; the target is **WCAG 2.2 AA**
  in both light and dark.
- New design outcomes are versioned under `prototypes/<work-item-id>/v<n>/`; a
  previous version is never overwritten.

## Handover

`HANDOVER.md` records current state, verified work and what is left. Update it
whenever state changes.

## Work item discipline (agent directives)

- **Always re-retrieve a work item immediately before reporting on it or acting
  on it.** State seen earlier may be stale - fetch the item again, then act, and
  quote the fields you saw.
- **Always link work items directly.** Every mention of a work item in any reply
  carries a clickable link to the item in the format
  `[PROJ-32 - Short title](https://plane.atakumi.net/{workspace}/projects/{project-uuid}/issues/<work-item-uuid>/)`.
  No link means an incomplete answer.

**Repository workflow:** `C:\Users\mdver\Projects\_STANDARD\WORKFLOW.md` - canonical branch/finish sequence; supersedes conflicting prose in this file.
