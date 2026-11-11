export type PlaneProject = {
  id: string;
  identifier?: string;
  name: string;
  archived_at?: string | null;
  start_date?: string | null;
  target_date?: string | null;
  /** True when the calling user is an active member of the project. */
  is_member?: boolean | null;
  /** The calling user's project role; null for a non-member who only sees a public project. */
  member_role?: number | null;
};

/**
 * Plane lists every project the token's user may see, which includes public
 * projects they have not joined. Membership is what grants access in Airtime.
 * Returns null when the response carries no membership information at all.
 */
export function isProjectMember(project: PlaneProject): boolean | null {
  if (project.is_member === true) {
    return true;
  }
  if (typeof project.member_role === 'number') {
    return true;
  }
  if (project.is_member === false || project.member_role === null) {
    return false;
  }
  return null;
}

export type PlaneIssue = {
  id: string;
  sequence_id?: number;
  name: string;
  state?: string;
  state_group?: string;
  state_detail?: { group?: string };
  project?: string;
  updated_at?: string;
  completed_at?: string | null;
  archived_at?: string | null;
};

export class PlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlaneError';
  }
}

export type WorkspaceErrorCategory = 'unauthorised' | 'not_found' | 'network';

/** Plane's own answer (401, 403, 404) versus a failure to get an answer at all. */
export function categorizePlaneError(error: unknown): WorkspaceErrorCategory {
  if (error instanceof PlaneError) {
    if (error.status === 401 || error.status === 403) {
      return 'unauthorised';
    }
    if (error.status === 404) {
      return 'not_found';
    }
  }
  return 'network';
}

/**
 * A short reason that is safe to store and show: it names the category and the
 * status, never the raw error text (which could carry request details).
 */
export function describePlaneError(error: unknown): string {
  const category = categorizePlaneError(error);
  if (error instanceof Error && error.message === 'plane_membership_unavailable') {
    return 'Plane did not report project membership for this workspace.';
  }
  if (category === 'unauthorised') {
    return 'Plane refused the token for this workspace.';
  }
  if (category === 'not_found') {
    return 'Plane has no workspace with this slug.';
  }
  if (error instanceof PlaneError) {
    return `Plane answered with status ${error.status}.`;
  }
  return 'Plane could not be reached.';
}

export type PlaneClientOptions = {
  baseUrl: string;
  workspaceSlug: string;
  token: string;
  fetchImpl?: typeof fetch;
};

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

const CLOSED_GROUPS = new Set(['completed', 'cancelled']);

/**
 * How many work items an incremental read asks for at once. A full read uses
 * Plane's default page size; an incremental read uses a small first page so a
 * quiet project costs one small request rather than the whole list.
 */
const INCREMENTAL_ISSUE_PAGE_SIZE = 100;

/** A cursor page can never run away: 100 pages is far more than a real sync needs. */
const MAX_PAGES = 100;

export function isIssueOpen(issue: PlaneIssue): boolean {
  if (issue.completed_at || issue.archived_at) {
    return false;
  }
  const group = issue.state_detail?.group ?? issue.state_group;
  if (group && CLOSED_GROUPS.has(group)) {
    return false;
  }
  return true;
}

export class PlaneClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PlaneClientOptions) {
    this.apiBase = `${normalizeBaseUrl(options.baseUrl)}/api/v1`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'GET',
      headers: {
        'X-API-Key': this.options.token,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new PlaneError(
        response.status,
        `Plane request to ${path} failed with status ${response.status}`,
      );
    }
    return response.json();
  }

  /** Builds a query string, leaving out empty parameters. */
  private query(params: Record<string, string | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        search.set(key, value);
      }
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  }

  /**
   * Reads one page and returns its items plus the cursor for the next page, if
   * Plane says there is one. Handles both the bare-array and the paginated shape.
   */
  private readPage<T>(body: unknown): { items: T[]; nextCursor: string | null } {
    if (Array.isArray(body)) {
      return { items: body as T[], nextCursor: null };
    }
    const pageBody = body as {
      results?: T[];
      next_cursor?: string | null;
      next_page_results?: boolean;
    };
    const items = Array.isArray(pageBody.results) ? pageBody.results : [];
    const nextCursor =
      pageBody.next_page_results && pageBody.next_cursor ? pageBody.next_cursor : null;
    return { items, nextCursor };
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.getJson(`${path}${this.query({ cursor: cursor ?? undefined })}`);
      const { items, nextCursor } = this.readPage<T>(body);
      results.push(...items);
      if (!nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return results;
  }

  async verify(): Promise<{ projectCount: number }> {
    const projects = await this.paginate<PlaneProject>(
      `/workspaces/${encodeURIComponent(this.options.workspaceSlug)}/projects/`,
    );
    return { projectCount: projects.length };
  }

  async listProjects(): Promise<PlaneProject[]> {
    return this.paginate<PlaneProject>(
      `/workspaces/${encodeURIComponent(this.options.workspaceSlug)}/projects/`,
    );
  }

  /**
   * Lists a project's work items.
   *
   * With no `since` this is a full read of the project, in Plane's own order.
   *
   * With `since` it is an incremental read: Plane is asked for the items ordered
   * by `updated_at` descending (most recently changed first) and only a small
   * first page. Paging stops as soon as an item older than `since` appears,
   * because everything after it is older still. That way a quiet project costs
   * one small request instead of its whole history, while every item changed
   * since the watermark is still read. Plane's Community API has no
   * `updated_at` filter, so ordering by `updated_at` and stopping early is the
   * supported way to read only what changed.
   */
  async listIssues(projectId: string, since?: Date | null): Promise<PlaneIssue[]> {
    const path = `/workspaces/${encodeURIComponent(this.options.workspaceSlug)}/projects/${encodeURIComponent(projectId)}/issues/`;
    if (!since) {
      return this.paginate<PlaneIssue>(path);
    }
    const sinceMs = since.getTime();
    const results: PlaneIssue[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await this.getJson(
        `${path}${this.query({
          order_by: '-updated_at',
          per_page: String(INCREMENTAL_ISSUE_PAGE_SIZE),
          cursor: cursor ?? undefined,
        })}`,
      );
      const { items, nextCursor } = this.readPage<PlaneIssue>(body);
      let reachedOlder = false;
      for (const issue of items) {
        const updatedMs = issue.updated_at ? Date.parse(issue.updated_at) : Number.NaN;
        if (Number.isFinite(updatedMs) && updatedMs < sinceMs) {
          reachedOlder = true;
          continue;
        }
        results.push(issue);
      }
      if (reachedOlder || !nextCursor) {
        break;
      }
      cursor = nextCursor;
    }
    return results;
  }
}
