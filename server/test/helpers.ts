import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createDb, type Db } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import type { AppConfig } from '../src/config.js';
import { createOrganisation } from '../src/services/organisations.js';
import { createMember } from '../src/services/members.js';

let db: Db | null = null;

export function getDb(): Db {
  if (!db) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
      throw new Error(
        'TEST_DATABASE_URL must point at a throwaway Postgres database to run integration tests',
      );
    }
    db = createDb(url);
  }
  return db;
}

export const testConfig: AppConfig = {
  host: '127.0.0.1',
  port: 3001,
  logLevel: 'silent',
  databaseUrl: 'postgres://unused',
  jwtSecret: 'test-jwt-secret',
  jwtTtl: '1h',
  cookieSecret: 'test-cookie-secret',
  baseUrl: 'http://localhost:3000',
  tokenEncryptionKey: 'a'.repeat(64),
  corsOrigins: ['tauri://localhost', 'http://tauri.localhost'],
  syncPollSeconds: 0,
  syncLookbackSeconds: 600,
  syncPollEnabled: false,
  accessRecheckSeconds: 0,
  accessMaxStaleSeconds: 3600,
  projectionHorizonDays: 30,
  fxProviderUrl: 'http://127.0.0.1:1/latest',
  fxRefreshHours: 0,
  bootstrap: {
    orgName: 'Test',
    email: 'bootstrap@test.local',
    password: 'password123',
    displayName: 'Bootstrap',
  },
  oidc: null,
};

export async function setupSchema(): Promise<void> {
  await runMigrations(getDb().pool);
}

export async function resetData(): Promise<void> {
  await getDb().query(
    `TRUNCATE organisations, members, projects, rates, budgets, time_entries,
              audit_log, plane_connections, work_items, plane_sync_runs,
              timers, time_entry_history, fx_rates, feedback_events, expenses,
              project_access CASCADE`,
  );
}

export async function makeApp(
  overrides: Partial<AppConfig> = {},
): Promise<FastifyInstance> {
  return buildApp({
    db: getDb(),
    config: { ...testConfig, ...overrides },
    oidc: null,
  });
}

export type SeedResult = {
  organisationId: string;
  admin: { id: string; email: string; password: string };
  manager: { id: string; email: string; password: string };
  member: { id: string; email: string; password: string };
};

export async function seed(): Promise<SeedResult> {
  const db = getDb();
  const organisation = await createOrganisation(db, 'Test Org', 'USD');
  const password = 'password123';

  const admin = await createMember(db, {
    organisationId: organisation.id,
    email: 'admin@test.local',
    displayName: 'Admin',
    role: 'administrator',
    password,
  });
  const manager = await createMember(db, {
    organisationId: organisation.id,
    email: 'manager@test.local',
    displayName: 'Manager',
    role: 'manager',
    password,
  });
  const member = await createMember(db, {
    organisationId: organisation.id,
    email: 'member@test.local',
    displayName: 'Member',
    role: 'member',
    password,
  });

  return {
    organisationId: organisation.id,
    admin: { id: admin.id, email: admin.email, password },
    manager: { id: manager.id, email: manager.email, password },
    member: { id: member.id, email: member.email, password },
  };
}

export async function login(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${response.statusCode}`);
  }
  return response.json().token as string;
}

export function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/**
 * Gives every active member of the organisation current Plane membership of
 * the project, as a sync would after Plane lists them in it.
 */
export async function grantProjectAccess(
  organisationId: string,
  projectId: string,
  memberIds?: string[],
): Promise<void> {
  await getDb().query(
    `INSERT INTO project_access (member_id, project_id, organisation_id, status)
     SELECT m.id, $2, $1, 'member'
       FROM members m
      WHERE m.organisation_id = $1
        AND ($3::uuid[] IS NULL OR m.id = ANY($3::uuid[]))
     ON CONFLICT (member_id, project_id) DO UPDATE SET status = 'member'`,
    [organisationId, projectId, memberIds ?? null],
  );
}
