import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/pool.js';
import { normalizeBaseUrl } from '../plane/client.js';
import { syncConnection } from '../plane/sync.js';
import {
  checkWorkspace,
  normaliseWorkspaceSlugs,
  WorkspaceSlugError,
} from '../plane/workspaces.js';
import {
  deleteConnection,
  getConnectionByWebhookSecret,
  getConnectionForMember,
  openConnectionToken,
  recordWorkspaceCheck,
  toPublicConnection,
  upsertConnection,
} from '../services/connections.js';
import { viewerOf } from '../services/access.js';
import {
  refreshMemberAccessQuietly,
  verifyMemberAccess,
  type AccessCheckDeps,
} from '../services/accessCheck.js';
import { listWorkItems } from '../services/workItems.js';

// A connection is a base URL, the member's account token and the workspace slugs
// to read. `workspaceSlug` (one slug) is still accepted from older clients. The
// token may be left out to keep the stored one while the slug list is edited.
const connectionSchema = z
  .object({
    baseUrl: z.string().url(),
    workspaceSlugs: z.array(z.string().max(200)).max(100).optional(),
    workspaceSlug: z.string().max(200).optional(),
    token: z.string().min(1).optional(),
  })
  .refine((value) => value.workspaceSlugs !== undefined || value.workspaceSlug !== undefined);

const webhookBodySchema = z.object({ workspace_slug: z.string().max(200).optional() }).passthrough();

export type PlaneRouteDeps = {
  db: Db;
  encryptionKey: Buffer | null;
  access: AccessCheckDeps;
};

export function planeRoutes(app: FastifyInstance, deps: PlaneRouteDeps): void {
  const { db, encryptionKey } = deps;
  const anyMember = app.authenticate;

  const keyOr503 = (reply: FastifyReply): Buffer | null => {
    if (!encryptionKey) {
      void reply.code(503).send({ error: 'token_encryption_not_configured' });
      return null;
    }
    return encryptionKey;
  };

  app.get('/api/plane/connection', { preHandler: anyMember }, async (request) => {
    const connection = await getConnectionForMember(
      db,
      request.member!.organisation_id,
      request.member!.id,
    );
    return { connection: connection ? toPublicConnection(connection) : null };
  });

  app.put('/api/plane/connection', { preHandler: anyMember }, async (request, reply) => {
    const key = keyOr503(reply);
    if (!key) return;

    const parsed = connectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    let slugs: string[];
    try {
      slugs = normaliseWorkspaceSlugs(
        parsed.data.workspaceSlugs ?? [parsed.data.workspaceSlug ?? ''],
      );
    } catch (error) {
      if (error instanceof WorkspaceSlugError) {
        return reply.code(400).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    const existing = await getConnectionForMember(
      db,
      request.member!.organisation_id,
      request.member!.id,
    );
    const token = parsed.data.token ?? (existing ? openConnectionToken(existing, key) : null);
    if (!token) {
      return reply.code(400).send({ error: 'token_required' });
    }

    const baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
    // Each slug is verified on its own: one that fails does not stop the others.
    const checks = await Promise.all(
      slugs.map((slug) => checkWorkspace({ baseUrl, token, slug, fetchImpl: deps.access.fetchImpl })),
    );
    if (!checks.some((check) => check.status === 'verified')) {
      return reply.code(400).send({
        error: 'plane_verification_failed',
        workspaces: checks.map((check) => ({
          slug: check.slug,
          status: check.status,
          errorCategory: check.errorCategory,
          error: check.error,
        })),
      });
    }

    const { connection, removedSlugs } = await upsertConnection(db, {
      organisationId: request.member!.organisation_id,
      memberId: request.member!.id,
      baseUrl,
      workspaces: checks,
      token,
      key,
    });

    let sync: Awaited<ReturnType<typeof syncConnection>> | null = null;
    let warning: string | null = null;
    try {
      sync = await syncConnection(db, connection, key, 'connect');
    } catch (error) {
      warning = error instanceof Error ? error.message : 'sync_failed';
    }

    // The sync has updated the workspace rows; send the stored state back.
    const fresh = (await getConnectionForMember(
      db,
      request.member!.organisation_id,
      request.member!.id,
    ))!;
    return {
      connection: toPublicConnection(fresh),
      removedWorkspaces: removedSlugs,
      sync,
      warning,
    };
  });

  // "Verify all": re-checks every configured slug with the stored token.
  app.post('/api/plane/workspaces/verify', { preHandler: anyMember }, async (request, reply) => {
    const key = keyOr503(reply);
    if (!key) return;

    const connection = await getConnectionForMember(
      db,
      request.member!.organisation_id,
      request.member!.id,
    );
    if (!connection) {
      return reply.code(404).send({ error: 'connection_not_found' });
    }
    const token = openConnectionToken(connection, key);
    const checks = await Promise.all(
      connection.workspaces.map((workspace) =>
        checkWorkspace({
          baseUrl: connection.base_url,
          token,
          slug: workspace.slug,
          fetchImpl: deps.access.fetchImpl,
        }),
      ),
    );
    for (const check of checks) {
      await recordWorkspaceCheck(db, connection.id, check);
    }
    const fresh = (await getConnectionForMember(
      db,
      request.member!.organisation_id,
      request.member!.id,
    ))!;
    return { connection: toPublicConnection(fresh) };
  });

  // Re-reads the member's project memberships from Plane and returns the
  // permission fingerprint, so a client can check for a change with one compare.
  app.post('/api/plane/access/check', { preHandler: anyMember }, async (request, reply) => {
    const connection = await getConnectionForMember(
      db,
      request.member!.organisation_id,
      request.member!.id,
    );
    if (!connection) {
      return reply.code(404).send({ error: 'connection_not_found' });
    }
    const result = await verifyMemberAccess(deps.access, request.member!, { force: true });
    const fresh = await getConnectionForMember(
      db,
      request.member!.organisation_id,
      request.member!.id,
    );
    return {
      checked: result.checked,
      changed: result.changed,
      accessHash: fresh?.access_hash ?? null,
      accessCheckedAt: fresh?.access_checked_at ?? null,
    };
  });

  app.delete('/api/plane/connection', { preHandler: anyMember }, async (request) => {
    const removed = await deleteConnection(
      db,
      request.member!.organisation_id,
      request.member!.id,
    );
    return { ok: removed };
  });

  app.post('/api/plane/sync', { preHandler: anyMember }, async (request, reply) => {
    const key = keyOr503(reply);
    if (!key) return;

    const connection = await getConnectionForMember(
      db,
      request.member!.organisation_id,
      request.member!.id,
    );
    if (!connection) {
      return reply.code(404).send({ error: 'connection_not_found' });
    }

    try {
      const summary = await syncConnection(db, connection, key, 'manual');
      return { sync: summary };
    } catch (error) {
      return reply.code(502).send({
        error: 'plane_sync_failed',
        message: error instanceof Error ? error.message : 'sync_failed',
      });
    }
  });

  app.get(
    '/api/plane/work-items',
    { preHandler: anyMember },
    async (request) => {
      const query = request.query as {
        projectId?: string;
        workspace?: string;
        includeClosed?: string;
      };
      await refreshMemberAccessQuietly(deps.access, request.member!);
      const workItems = await listWorkItems(
        db,
        request.member!.organisation_id,
        viewerOf(request.member!),
        {
          projectId: query.projectId,
          workspace: query.workspace,
          includeClosed: query.includeClosed === 'true',
        },
      );
      return { workItems };
    },
  );

  app.post(
    '/api/plane/webhook/:secret',
    async (request, reply) => {
      const key = keyOr503(reply);
      if (!key) return;

      const { secret } = request.params as { secret: string };
      const match = await getConnectionByWebhookSecret(db, secret);
      if (!match) {
        return reply.code(404).send({ error: 'connection_not_found' });
      }
      const { connection } = match;

      // The secret belongs to one workspace. Plane's delivery names the workspace
      // too (`workspace_slug`); when it names another workspace of the same
      // connection, that one is synced instead.
      const body = webhookBodySchema.safeParse(request.body ?? {});
      const named = body.success ? body.data.workspace_slug?.toLowerCase() : undefined;
      const scoped =
        connection.workspaces.find((workspace) => workspace.slug.toLowerCase() === named)?.slug ??
        match.workspaceSlug;

      try {
        const summary = await syncConnection(db, connection, key, 'webhook', {
          onlyWorkspace: scoped,
        });
        return reply.code(202).send({ sync: summary });
      } catch (error) {
        return reply.code(502).send({
          error: 'plane_sync_failed',
          message: error instanceof Error ? error.message : 'sync_failed',
        });
      }
    },
  );
}
