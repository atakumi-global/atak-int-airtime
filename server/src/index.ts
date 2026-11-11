import { loadConfig } from './config.js';
import { createDb } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { bootstrap } from './services/bootstrap.js';
import { OidcService } from './auth/oidc.js';
import { buildApp } from './app.js';
import { parseEncryptionKey } from './crypto/tokens.js';
import { startSyncScheduler } from './plane/scheduler.js';
import { startFxScheduler } from './fx/scheduler.js';

const config = loadConfig();
const db = createDb(config.databaseUrl);
const app = await buildApp({
  db,
  config,
  oidc: config.oidc ? new OidcService(config.oidc) : null,
});

const stopSchedulers: Array<() => void> = [];

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  for (const stop of stopSchedulers) {
    stop();
  }
  await app.close();
  await db.close();
  process.exit(0);
}

try {
  const applied = await runMigrations(db.pool);
  if (applied.length > 0) {
    app.log.info({ applied }, 'applied migrations');
  }
  await bootstrap(db, config, app.log);
  await app.listen({ host: config.host, port: config.port });

  if (
    config.syncPollEnabled &&
    config.syncPollSeconds > 0 &&
    config.tokenEncryptionKey
  ) {
    stopSchedulers.push(
      startSyncScheduler(
        db,
        parseEncryptionKey(config.tokenEncryptionKey),
        config.syncPollSeconds,
        config.syncLookbackSeconds,
        app.log,
      ),
    );
    app.log.info(
      { intervalSeconds: config.syncPollSeconds },
      'started Plane polling scheduler',
    );
  }

  if (config.fxRefreshHours > 0) {
    stopSchedulers.push(
      startFxScheduler(db, config.fxProviderUrl, config.fxRefreshHours, app.log),
    );
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await db.close();
  process.exit(1);
}
