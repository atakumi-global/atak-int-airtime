export type AppConfig = {
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  jwtSecret: string;
  jwtTtl: string;
  cookieSecret: string;
  baseUrl: string;
  tokenEncryptionKey: string | null;
  corsOrigins: string[];
  syncPollSeconds: number;
  syncLookbackSeconds: number;
  syncPollEnabled: boolean;
  accessRecheckSeconds: number;
  accessMaxStaleSeconds: number;
  projectionHorizonDays: number;
  fxProviderUrl: string;
  fxRefreshHours: number;
  bootstrap: {
    orgName: string;
    email: string;
    password: string;
    displayName: string;
  };
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  } | null;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${env.PORT}`);
  }

  const baseUrl = (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

  const oidcConfigured =
    env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET;

  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: requireEnv('DATABASE_URL'),
    jwtSecret: requireEnv('APP_JWT_SECRET'),
    jwtTtl: env.APP_JWT_TTL ?? '12h',
    cookieSecret: env.COOKIE_SECRET ?? requireEnv('APP_JWT_SECRET'),
    baseUrl,
    tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY?.trim() || null,
    corsOrigins: (
      env.CORS_ORIGINS ??
      'tauri://localhost,http://tauri.localhost,https://tauri.localhost,http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://localhost:1420'
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    syncPollSeconds: Number(env.SYNC_POLL_SECONDS ?? 60),
    syncLookbackSeconds: positiveNumber(
      env.SYNC_LOOKBACK_SECONDS,
      600,
      'SYNC_LOOKBACK_SECONDS',
    ),
    syncPollEnabled: (env.SYNC_POLL_ENABLED ?? 'true') !== 'false',
    accessRecheckSeconds: positiveNumber(env.ACCESS_RECHECK_SECONDS, 60, 'ACCESS_RECHECK_SECONDS'),
    accessMaxStaleSeconds: positiveNumber(
      env.ACCESS_MAX_STALE_SECONDS,
      3600,
      'ACCESS_MAX_STALE_SECONDS',
    ),
    projectionHorizonDays: Number(env.PROJECTION_HORIZON_DAYS ?? 30),
    fxProviderUrl:
      env.FX_PROVIDER_URL ?? 'https://api.frankfurter.dev/v1/latest',
    fxRefreshHours: Number(env.FX_REFRESH_HOURS ?? 24),
    bootstrap: {
      orgName: env.BOOTSTRAP_ORG_NAME ?? 'Airtime',
      email: env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@example.com',
      password: env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
      displayName: env.BOOTSTRAP_ADMIN_NAME ?? 'Administrator',
    },
    oidc: oidcConfigured
      ? {
          issuer: env.OIDC_ISSUER as string,
          clientId: env.OIDC_CLIENT_ID as string,
          clientSecret: env.OIDC_CLIENT_SECRET as string,
          redirectUri:
            env.OIDC_REDIRECT_URI ?? `${baseUrl}/auth/oidc/callback`,
        }
      : null,
  };
}
