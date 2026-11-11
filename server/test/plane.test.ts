import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { decryptToken, parseEncryptionKey } from '../src/crypto/tokens.js';
import { syncConnection } from '../src/plane/sync.js';
import { listActiveConnections } from '../src/services/connections.js';
import {
  auth,
  getDb,
  login,
  makeApp,
  resetData,
  seed,
  setupSchema,
} from './helpers.js';

const VALID_TOKEN = 'plane_api_test_token';
const OTHER_TOKEN = 'plane_api_other_token';

type Recorded = { method: string; url: string };

type MockIssue = {
  id: string;
  sequence_id: number;
  name: string;
  state_detail?: { group: string };
  completed_at?: string | null;
  updated_at?: string;
};

function recentIso(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

/** Two fresh work items (one completed), so a full read sees both. */
function defaultIssues(): Record<string, MockIssue[]> {
  const stamp = recentIso(30_000);
  return {
    p1: [
      {
        id: 'i1',
        sequence_id: 1,
        name: 'Fix login',
        state_detail: { group: 'backlog' },
        updated_at: stamp,
      },
      {
        id: 'i2',
        sequence_id: 2,
        name: 'Ship it',
        state_detail: { group: 'completed' },
        completed_at: stamp,
        updated_at: stamp,
      },
    ],
    p2: [],
  };
}

let projectIssues: Record<string, MockIssue[]> = defaultIssues();

function startPlaneServer(): {
  server: Server;
  requests: Recorded[];
  baseUrl: () => string;
} {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '' });
    const send = (code: number, body: unknown): void => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

    if (request.method !== 'GET') {
      send(405, { error: 'read_only' });
      return;
    }
    if (request.headers['x-api-key'] !== VALID_TOKEN) {
      send(401, { error: 'unauthorized' });
      return;
    }

    const parsed = new URL(`http://localhost${request.url ?? ''}`);
    const issueMatch = /^\/api\/v1\/workspaces\/atakumi\/projects\/([^/]+)\/issues\/$/.exec(
      parsed.pathname,
    );
    if (issueMatch) {
      const items = (projectIssues[issueMatch[1]!] ?? []).slice();
      if (parsed.searchParams.get('order_by') === '-updated_at') {
        items.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
      }
      const perPage = Math.max(
        1,
        Number(parsed.searchParams.get('per_page') ?? '1000') || 1000,
      );
      const cursor = parsed.searchParams.get('cursor');
      const page = cursor ? Number(cursor.split(':')[1] ?? '0') || 0 : 0;
      const start = page * perPage;
      const slice = items.slice(start, start + perPage);
      const hasMore = start + perPage < items.length;
      send(200, {
        results: slice,
        next_cursor: hasMore ? `${perPage}:${page + 1}:0` : null,
        next_page_results: hasMore,
      });
      return;
    }
    if (parsed.pathname.startsWith('/api/v1/workspaces/atakumi/projects/')) {
      send(200, {
        results: [
          { id: 'p1', identifier: 'WEB', name: 'Website', is_member: true, member_role: 20 },
          { id: 'p2', identifier: 'APP', name: 'App', is_member: true, member_role: 20 },
        ],
        next_page_results: false,
      });
      return;
    }
    send(404, { error: 'not_found' });
  });

  return {
    server,
    requests,
    baseUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

let app: FastifyInstance;
let plane: ReturnType<typeof startPlaneServer>;

before(async () => {
  await setupSchema();
  app = await makeApp();
  plane = startPlaneServer();
  await new Promise<void>((resolve) => plane.server.listen(0, resolve));
});

beforeEach(async () => {
  await resetData();
  projectIssues = defaultIssues();
  plane.requests.length = 0;
});

after(async () => {
  await app.close();
  await new Promise<void>((resolve) => plane.server.close(() => resolve()));
  await getDb().close();
});

async function connect(token: string, managerEmail: string): Promise<string> {
  const userToken = await login(app, managerEmail, 'password123');
  await app.inject({
    method: 'PUT',
    url: '/api/plane/connection',
    headers: auth(userToken),
    payload: {
      baseUrl: plane.baseUrl(),
      workspaceSlug: 'atakumi',
      token,
    },
  });
  return userToken;
}

test('saving a valid connection verifies, stores the token encrypted and syncs', async () => {
  const { manager } = await seed();
  const userToken = await login(app, manager.email, manager.password);

  const response = await app.inject({
    method: 'PUT',
    url: '/api/plane/connection',
    headers: auth(userToken),
    payload: {
      baseUrl: plane.baseUrl(),
      workspaceSlug: 'atakumi',
      token: VALID_TOKEN,
    },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.connection.workspaces.length, 1);
  assert.equal(body.connection.workspaces[0].slug, 'atakumi');
  assert.equal(body.connection.workspaces[0].status, 'verified');
  assert.equal(body.connection.workspaces[0].projectCount, 2);
  assert.equal(body.sync.projects, 2);
  assert.equal(body.sync.workItems, 2);

  const rows = await getDb().query<{ encrypted_token: string }>(
    'SELECT encrypted_token FROM plane_connections',
  );
  assert.equal(rows.length, 1);
  assert.ok(
    !rows[0]!.encrypted_token.includes(VALID_TOKEN),
    'raw token must not be stored',
  );
  const decrypted = decryptToken(
    rows[0]!.encrypted_token,
    parseEncryptionKey('a'.repeat(64)),
  );
  assert.equal(decrypted, VALID_TOKEN);

  assert.ok(
    plane.requests.every((request) => request.method === 'GET'),
    'Airtime must never write to Plane',
  );
});

test('an invalid token is rejected and stores nothing', async () => {
  const { manager } = await seed();
  const userToken = await login(app, manager.email, manager.password);

  const response = await app.inject({
    method: 'PUT',
    url: '/api/plane/connection',
    headers: auth(userToken),
    payload: {
      baseUrl: plane.baseUrl(),
      workspaceSlug: 'atakumi',
      token: OTHER_TOKEN,
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'plane_verification_failed');

  const rows = await getDb().query('SELECT id FROM plane_connections');
  assert.equal(rows.length, 0);
});

test('only open work items are listed after sync', async () => {
  const { manager } = await seed();
  const userToken = await connect(VALID_TOKEN, manager.email);

  const response = await app.inject({
    method: 'GET',
    url: '/api/plane/work-items',
    headers: auth(userToken),
  });
  assert.equal(response.statusCode, 200);
  const items = response.json().workItems as {
    identifier: string;
    name: string;
    project_name: string;
  }[];
  assert.equal(items.length, 1);
  assert.equal(items[0]!.identifier, 'WEB-1');
  assert.equal(items[0]!.name, 'Fix login');
  assert.equal(items[0]!.project_name, 'Website');
});

test('a webhook triggers a sync for its connection', async () => {
  const { manager } = await seed();
  const userToken = await connect(VALID_TOKEN, manager.email);

  const connection = await app.inject({
    method: 'GET',
    url: '/api/plane/connection',
    headers: auth(userToken),
  });
  const webhookPath = connection.json().connection.workspaces[0].webhookPath as string;
  assert.ok(webhookPath.startsWith('/api/plane/webhook/'));

  const response = await app.inject({
    method: 'POST',
    url: webhookPath,
    payload: { event: 'issue.updated', data: { id: 'i1' } },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().sync.workItems, 2);
});

test('a poll reads only what changed since the last sync, newest first', async () => {
  const { manager } = await seed();
  await connect(VALID_TOKEN, manager.email);
  plane.requests.length = 0;

  const fresh = recentIso(30_000);
  const stale = recentIso(6 * 60 * 60 * 1000);
  projectIssues = {
    p1: [
      {
        id: 'i-fresh',
        sequence_id: 100,
        name: 'Just changed',
        state_detail: { group: 'backlog' },
        updated_at: fresh,
      },
      ...Array.from({ length: 150 }, (_, index) => ({
        id: `i-old-${index}`,
        sequence_id: 200 + index,
        name: `Old ${index}`,
        state_detail: { group: 'backlog' },
        updated_at: stale,
      })),
    ],
    p2: [],
  };

  const db = getDb();
  // Clear the rows the full connect wrote so the poll's own writes are visible.
  await db.query('DELETE FROM work_items');
  const connection = (await listActiveConnections(db))[0]!;
  const summary = await syncConnection(
    db,
    connection,
    parseEncryptionKey('a'.repeat(64)),
    'poll',
    { lookbackSeconds: 600 },
  );

  assert.equal(summary.workItems, 1, 'only the changed work item is read');
  const p1Requests = plane.requests.filter((request) =>
    request.url.startsWith('/api/v1/workspaces/atakumi/projects/p1/issues/'),
  );
  assert.equal(
    p1Requests.length,
    1,
    'paging stops at the first item older than the watermark',
  );
  assert.ok(p1Requests[0]!.url.includes('order_by=-updated_at'));
  assert.ok(p1Requests[0]!.url.includes('per_page='));

  const stored = await db.query<{ plane_work_item_id: string }>(
    'SELECT plane_work_item_id FROM work_items WHERE organisation_id = $1 ORDER BY plane_work_item_id',
    [connection.organisation_id],
  );
  assert.deepEqual(
    stored.map((row) => row.plane_work_item_id),
    ['i-fresh'],
    'the stale items are neither read nor rewritten',
  );
});

test('removing a member stops their Plane sync and keeps their entries', async () => {
  const { admin, member } = await seed();
  const memberToken = await connect(VALID_TOKEN, member.email);

  const entry = await app.inject({
    method: 'POST',
    url: '/api/time-entries',
    headers: auth(memberToken),
    payload: { workItemId: 'i1', date: '2026-09-20', durationMinutes: 30 },
  });
  assert.equal(entry.statusCode, 201);

  const connection = await app.inject({
    method: 'GET',
    url: '/api/plane/connection',
    headers: auth(memberToken),
  });
  const webhookPath = connection.json().connection.workspaces[0].webhookPath as string;

  const adminToken = await login(app, admin.email, admin.password);
  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/members/${member.id}`,
    headers: auth(adminToken),
  });
  assert.equal(removed.statusCode, 200);

  const db = getDb();
  const connections = await db.query(
    'SELECT id FROM plane_connections WHERE member_id = $1',
    [member.id],
  );
  assert.equal(connections.length, 0, 'connection must be deleted');
  assert.equal(
    (await listActiveConnections(db)).length,
    0,
    'poll sync must have nothing to sync',
  );

  const webhook = await app.inject({
    method: 'POST',
    url: webhookPath,
    payload: { event: 'issue.updated', data: { id: 'i1' } },
  });
  assert.equal(webhook.statusCode, 404);

  const manual = await app.inject({
    method: 'POST',
    url: '/api/plane/sync',
    headers: auth(memberToken),
  });
  assert.equal(manual.statusCode, 401);

  const remaining = await db.query(
    'SELECT count(*)::int AS count FROM time_entries WHERE member_id = $1',
    [member.id],
  );
  assert.equal(remaining[0]!.count, 1);
});

test('poll and webhook skip a connection whose member is not active', async () => {
  const { manager } = await seed();
  const managerToken = await connect(VALID_TOKEN, manager.email);

  const db = getDb();
  const rows = await db.query<{ webhook_secret: string }>(
    `SELECT w.webhook_secret FROM plane_connection_workspaces w
       JOIN plane_connections c ON c.id = w.connection_id WHERE c.member_id = $1`,
    [manager.id],
  );
  const webhookSecret = rows[0]!.webhook_secret;

  await db.query(`UPDATE members SET status = 'removed' WHERE id = $1`, [
    manager.id,
  ]);

  assert.equal(
    (await listActiveConnections(db)).length,
    0,
    'removed member connection must not be polled',
  );

  const webhook = await app.inject({
    method: 'POST',
    url: `/api/plane/webhook/${webhookSecret}`,
    payload: { event: 'issue.updated', data: { id: 'i1' } },
  });
  assert.equal(webhook.statusCode, 404);

  const manual = await app.inject({
    method: 'POST',
    url: '/api/plane/sync',
    headers: auth(managerToken),
  });
  assert.equal(manual.statusCode, 401);
});
