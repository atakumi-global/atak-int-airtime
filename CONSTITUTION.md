# Project Constitution — Airtime

> Governing principles for this project, in the GitHub Spec-Driven Development
> sense: a short, stable set of rules that every specification, plan, task and
> commit must comply with. Where this constitution conflicts with any other
> instruction — chat, ticket, habit — **this document wins**. Amend it
> deliberately; never silently.

Version: 1.0.0 · Ratified: 2026-09-28

---

## Article I — Approval authority (NON-NEGOTIABLE)

A human owns approval. An agent may create, move, comment on, and provide
evidence for work; it must never approve its own work or anyone else's, and must
never move an item past **In Review** without a recorded human approval.

- Design approval and lifecycle approval are separate acts.
- Every approval records who approved, when, and — for designs — the exact
  version approved.
- Approving one version never implies approval of the next.

## Article II — Specification before implementation

Thinking happens before code. Every non-trivial piece of work has a written
problem, scope, and testable acceptance criteria before implementation begins.

- Acceptance criteria are numbered and pass/fail verifiable. "Fast", "clean"
  and "user-friendly" are not criteria.
- If the specification and reality conflict mid-build, the specification is
  updated first, then re-checked.
- A task no one can verify is not ready to be started.

## Article III — Plane is the source of truth

Lifecycle, estimates and approval live in Plane for the project named in
`.plane.json` — workspace `atakumi`, project `AIRTIME`. Documents describe how to
work; Plane records where work stands.

- Work-item identifiers are assigned automatically by Plane. Never choose,
  invent or reuse one. Branches are named after their item (`feature/AIRTIME-33`).
- Estimates are Fibonacci points (1, 2, 3, 5, 8, 13) set via the project's estimate system (`estimate_point`); above 13 means split.
- The lifecycle is: Backlog → Prepare → Todo → In Progress → Blocked →
  In Review → Approved → Deployed to stage → Approved by client →
  In production → Done / Cancelled.
- This Plane build has no custom fields or relations: approval is the item's state - a human moves it from **In Review** to **Approved** or later; labels and comments are not required; a design links to its feature as a **child** item.
- Every mention of a work item carries its clickable Plane link.

## Article IV — Security and secrets

- Secrets are never committed: `APP_JWT_SECRET`, `COOKIE_SECRET`,
  `BOOTSTRAP_ADMIN_*`, database credentials and any Plane token live in the
  environment (`opencode.json` and `.env*` are gitignored).
- Any leaked secret is rotated, not merely removed.
- **Plane per-user API tokens are stored encrypted at rest** and must never be
  logged, echoed or committed.
- Authorisation is enforced **server-side in every route**; the desktop client is
  never trusted.
- This tool reads a third party's Plane workspace: request the narrowest scope
  that works, and never widen it silently.

## Article V — Quality gates

No work is called done until its gate has been run and its evidence recorded:
`npm run lint && npm run typecheck && npm test && npm run build`, plus the
desktop checks (`cd desktop && npm run lint && npm test && npm run build`).
Degrees of "should pass" are failures.

- A regression test is only proven when it has been seen to fail against the
  old behaviour.
- An agent's success report is a claim, not evidence.

## Article VI — Surgical change and simplicity

The minimum change that satisfies the criteria, nothing speculative.

- No unrequested abstractions, dependencies or features.
- Match the existing server/desktop split and the coding style already in place.
- Every changed line traces to the work being done. Unrelated improvements are
  raised as their own item, not smuggled into a diff.
- Migrations run automatically on start — never introduce a destructive step
  that a boot can trigger.

## Article VII — Design precedes build

Any design outcome — new or changed screen, layout, styling, user-visible copy,
interaction — is designed, reviewed and approved before it is implemented.

- `prototypes/AIRTIME-16/v2` is the approved coded design set; `v1` is history.
- `design-system/DESIGN.md` is the enforceable summary.
- Designs are versioned records under `prototypes/<work-item-id>/v1`, `v2`, …
  A previous version is never overwritten or edited.
- **WCAG 2.2 AA is a target in both light and dark**, not a later pass.

## Article VIII — Version control discipline

- Conventional Commits; one focused commit per task; each message references the
  work-item identifier.
- Branch flow is `feature/<ITEM>` → `dev` (default) → `stage` → `prod`, promoted
  only by the manual **Promote to stage** / **Promote to prod** actions. Commits
  to `stage` and `prod` are forbidden; promotion is explicit and approved.
- `HANDOVER.md` is tracked and updated when state changes.
- History is readable: no force-push to shared branches, no rewriting published
  history.

---

## Governance

- **Supremacy.** This constitution supersedes conflicting instructions, however
  they arrive.
- **Compliance.** Every specification, plan, task and commit checks against these
  articles. A violation blocks the gate.
- **Amendment.** Changes are proposed as a work item, reviewed, and ratified as a
  version bump with a note of what changed and why.
- **Versioning.** MAJOR for removing or redefining a principle, MINOR for adding
  one, PATCH for clarifications.
