import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool.js';
import {
  categorizePlaneError,
  describePlaneError,
  isIssueOpen,
  PlaneClient,
  PlaneError,
  type PlaneIssue,
  type PlaneProject,
  type WorkspaceErrorCategory,
} from './client.js';
import { applyMemberAccess, type AccessibleProject } from '../services/access.js';
import { memberProjects } from '../services/accessCheck.js';
import {
  connectionWorkspaces,
  markConnectionError,
  markConnectionSynced,
  markWorkspaceSynced,
  openConnectionToken,
  recordWorkspaceCheck,
  type PlaneConnectionRow,
} from '../services/connections.js';

export type WorkspaceSyncResult = {
  slug: string;
  status: 'ok' | 'failed';
  projects: number;
  workItems: number;
  errorCategory: WorkspaceErrorCategory | null;
  error: string | null;
};

export type SyncSummary = {
  projects: number;
  workItems: number;
  workspaces: WorkspaceSyncResult[];
};

const inFlight = new Map<string, Promise<SyncSummary>>();

/**
 * Triggers that read every work item of every project. An explicit connect or
 * manual refresh is a full read; a poll or webhook reads only what changed
 * since the workspace last synced.
 */
const FULL_SYNC_TRIGGERS = new Set(['connect', 'manual']);

export type SyncOptions = {
  /** A webhook delivery names one workspace; only that one is read. */
  onlyWorkspace?: string;
  /** Seconds of overlap an incremental read keeps behind the last sync. */
  lookbackSeconds?: number;
};

/** Seconds of overlap when the caller does not say: absorbs clock skew and slow reads. */
export const DEFAULT_SYNC_LOOKBACK_SECONDS = 600;

/**
 * The instant an incremental read starts from: the workspace's last successful
 * sync, pulled back by the lookback buffer. `null` means a full read (the
 * workspace has never synced, so there is no watermark).
 */
export function incrementalSince(
  lastSyncedAt: Date | null | undefined,
  lookbackSeconds: number,
): Date | null {
  if (!lastSyncedAt) {
    return null;
  }
  const lookbackMs = Math.max(0, lookbackSeconds) * 1000;
  return new Date(lastSyncedAt.getTime() - lookbackMs);
}

/**
 * Syncs every workspace of the connection. With `onlyWorkspace` (a webhook
 * delivery names one workspace) just that one is read and the member's project
 * access is left to the next full sync or access check.
 */
export function syncConnection(
  db: Db,
  connection: PlaneConnectionRow,
  key: Buffer,
  trigger: string,
  options: SyncOptions = {},
): Promise<SyncSummary> {
  const running = inFlight.get(connection.id);
  if (running) {
    return running;
  }
  const promise = performSync(db, connection, key, trigger, options).finally(() => {
    inFlight.delete(connection.id);
  });
  inFlight.set(connection.id, promise);
  return promise;
}

async function upsertProject(
  db: Db,
  organisationId: string,
  workspaceSlug: string,
  project: PlaneProject,
): Promise<string> {
  const existing = await db.query<{ id: string }>(
    'SELECT id FROM projects WHERE organisation_id = $1 AND plane_project_id = $2',
    [organisationId, project.id],
  );
  const identifier = project.identifier ?? null;
  const archived = Boolean(project.archived_at);
  const startDate = toDateOnly(project.start_date);
  const targetDate = toDateOnly(project.target_date);

  if (existing[0]) {
    await db.query(
      `UPDATE projects
          SET name = $1, identifier = $2, archived = $3,
              start_date = $4, target_date = $5, workspace_slug = $6,
              synced_at = now(), updated_at = now()
        WHERE id = $7`,
      [project.name, identifier, archived, startDate, targetDate, workspaceSlug, existing[0].id],
    );
    return existing[0].id;
  }

  const id = randomUUID();
  await db.query(
    `INSERT INTO projects
       (id, organisation_id, plane_project_id, workspace_slug, name, identifier, archived,
        start_date, target_date, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      id,
      organisationId,
      project.id,
      workspaceSlug,
      project.name,
      identifier,
      archived,
      startDate,
      targetDate,
    ],
  );
  return id;
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.slice(0, 10);
}

async function upsertWorkItem(
  db: Db,
  organisationId: string,
  projectId: string,
  workspaceSlug: string,
  projectIdentifier: string | null,
  issue: PlaneIssue,
): Promise<void> {
  const identifier =
    projectIdentifier && issue.sequence_id !== undefined
      ? `${projectIdentifier}-${issue.sequence_id}`
      : null;
  const stateGroup = issue.state_detail?.group ?? issue.state_group ?? null;

  await db.query(
    `INSERT INTO work_items
       (id, organisation_id, project_id, workspace_slug, plane_work_item_id, identifier, name,
        state_group, is_open, plane_updated_at, synced_at, raw)
     VALUES ($1, $2, $3, $11, $4, $5, $6, $7, $8, $9, now(), $10)
     ON CONFLICT (organisation_id, plane_work_item_id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           workspace_slug = EXCLUDED.workspace_slug,
           identifier = EXCLUDED.identifier,
           name = EXCLUDED.name,
           state_group = EXCLUDED.state_group,
           is_open = EXCLUDED.is_open,
           plane_updated_at = EXCLUDED.plane_updated_at,
           synced_at = now(),
           raw = EXCLUDED.raw`,
    [
      randomUUID(),
      organisationId,
      projectId,
      issue.id,
      identifier,
      issue.name,
      stateGroup,
      isIssueOpen(issue),
      issue.updated_at ? new Date(issue.updated_at) : null,
      JSON.stringify(issue),
      workspaceSlug,
    ],
  );
}

type WorkspaceRead = {
  projects: number;
  workItems: number;
  accessible: AccessibleProject[];
};

/**
 * Reads one workspace. With `since` only work items changed at or after that
 * instant are read; without it every work item is read. Throws on the first
 * request that fails.
 */
async function syncWorkspace(
  db: Db,
  connection: PlaneConnectionRow,
  token: string,
  workspaceSlug: string,
  since: Date | null,
): Promise<WorkspaceRead> {
  const client = new PlaneClient({
    baseUrl: connection.base_url,
    workspaceSlug,
    token,
  });
  const projects = await client.listProjects();
  // Throws when Plane reports no membership, so access is left as it was.
  const accessible = memberProjects(workspaceSlug, projects);
  let workItems = 0;
  for (const project of projects) {
    const projectId = await upsertProject(
      db,
      connection.organisation_id,
      workspaceSlug,
      project,
    );
    const issues = await client.listIssues(project.id, since);
    for (const issue of issues) {
      await upsertWorkItem(
        db,
        connection.organisation_id,
        projectId,
        workspaceSlug,
        project.identifier ?? null,
        issue,
      );
      workItems += 1;
    }
  }
  return { projects: projects.length, workItems, accessible };
}

/** True when Plane itself answered "no" (so access there is really gone). */
function isAuthoritativeRefusal(error: unknown): boolean {
  return (
    error instanceof PlaneError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

async function performSync(
  db: Db,
  connection: PlaneConnectionRow,
  key: Buffer,
  trigger: string,
  options: SyncOptions,
): Promise<SyncSummary> {
  const onlyWorkspace = options.onlyWorkspace;
  const lookbackSeconds = options.lookbackSeconds ?? DEFAULT_SYNC_LOOKBACK_SECONDS;
  const incremental = !FULL_SYNC_TRIGGERS.has(trigger);

  const runId = randomUUID();
  await db.query(
    `INSERT INTO plane_sync_runs (id, organisation_id, connection_id, trigger, status)
     VALUES ($1, $2, $3, $4, 'error')`,
    [runId, connection.organisation_id, connection.id, trigger],
  );

  try {
    const token = openConnectionToken(connection, key);
    const slugs = connectionWorkspaces(connection).filter(
      (slug) => !onlyWorkspace || slug.toLowerCase() === onlyWorkspace.toLowerCase(),
    );
    if (slugs.length === 0) {
      throw new Error('no_workspaces_configured');
    }

    let projectCount = 0;
    let workItems = 0;
    const accessible: AccessibleProject[] = [];
    const results: WorkspaceSyncResult[] = [];
    // True when access cannot be judged: a workspace failed without Plane
    // giving a definite answer, so nothing may be revoked on the strength of it.
    let accessUncertain = false;

    // One workspace failing never stops the others.
    for (const workspaceSlug of slugs) {
      try {
        const workspace = connection.workspaces.find(
          (entry) => entry.slug.toLowerCase() === workspaceSlug.toLowerCase(),
        );
        const since = incremental
          ? incrementalSince(workspace?.last_synced_at, lookbackSeconds)
          : null;
        const read = await syncWorkspace(db, connection, token, workspaceSlug, since);
        accessible.push(...read.accessible);
        projectCount += read.projects;
        workItems += read.workItems;
        await markWorkspaceSynced(db, connection.id, workspaceSlug, read.projects);
        results.push({
          slug: workspaceSlug,
          status: 'ok',
          projects: read.projects,
          workItems: read.workItems,
          errorCategory: null,
          error: null,
        });
      } catch (error) {
        if (!isAuthoritativeRefusal(error)) {
          accessUncertain = true;
        }
        const errorCategory = categorizePlaneError(error);
        const message = describePlaneError(error);
        await recordWorkspaceCheck(db, connection.id, {
          slug: workspaceSlug,
          status: 'failed',
          errorCategory,
          error: message,
          projectCount: null,
        });
        results.push({
          slug: workspaceSlug,
          status: 'failed',
          projects: 0,
          workItems: 0,
          errorCategory,
          error: message,
        });
      }
    }

    const failed = results.filter((result) => result.status === 'failed');
    if (failed.length === results.length) {
      throw new Error(failed.map((result) => `${result.slug}: ${result.error}`).join('; '));
    }

    // The projects now exist locally; record which of them this member belongs
    // to. A webhook names one workspace and leaves the rest of the access
    // picture alone; so does any run that could not read every workspace.
    if (!onlyWorkspace && !accessUncertain) {
      await applyMemberAccess(db, {
        organisationId: connection.organisation_id,
        memberId: connection.member_id,
        connectionId: connection.id,
        previousHash: connection.access_hash,
        accessible,
      });
    }

    await db.query(
      `UPDATE plane_sync_runs
          SET status = $4, projects_synced = $1, work_items_synced = $2,
              error = $5, finished_at = now()
        WHERE id = $3`,
      [
        projectCount,
        workItems,
        runId,
        failed.length > 0 ? 'partial' : 'ok',
        failed.length > 0
          ? failed.map((result) => `${result.slug}: ${result.error}`).join('; ').slice(0, 500)
          : null,
      ],
    );
    if (connection.status !== 'active' || connection.last_error) {
      await markConnectionSynced(db, connection.id);
    } else {
      await db.query(
        'UPDATE plane_connections SET last_synced_at = now(), updated_at = now() WHERE id = $1',
        [connection.id],
      );
    }
    return { projects: projectCount, workItems, workspaces: results };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.query(
      `UPDATE plane_sync_runs SET status = 'error', error = $1, finished_at = now() WHERE id = $2`,
      [message.slice(0, 500), runId],
    );
    await markConnectionError(db, connection.id, message);
    throw error;
  }
}
