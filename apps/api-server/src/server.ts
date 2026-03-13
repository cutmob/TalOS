import dotenv from 'dotenv';
import { resolve } from 'node:path';

// Load .env from monorepo root — walk up from __dirname until we find it
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
let envDir = __dirname;
while (envDir !== resolve(envDir, '..')) {
  if (existsSync(resolve(envDir, '.env'))) break;
  envDir = resolve(envDir, '..');
}
dotenv.config({ path: resolve(envDir, '.env') });
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes/index.js';
import { createSystemFromEnv } from './config/orchestrator.js';

function validateEnv() {
  const recommended = ['BEDROCK_REGION', 'JIRA_BASE_URL', 'JIRA_API_TOKEN', 'SLACK_BOT_TOKEN'];
  const missing = recommended.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`[TalOS] Warning: missing recommended env vars: ${missing.join(', ')}`);
    console.warn('[TalOS] Falling back to defaults — OK for local dev, set these for production');
  }
  if (process.env.JIRA_PROJECT_KEY === undefined) {
    console.warn('[TalOS] JIRA_PROJECT_KEY not set — defaulting to "KAN". Jira operations may fail if this project does not exist.');
  }
  if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
    console.warn('[TalOS] CORS_ORIGIN not set in production — API will reject cross-origin requests. Set CORS_ORIGIN to your dashboard URL.');
  }
}

/** Returns allowed CORS origin(s). Configurable via CORS_ORIGIN env var (comma-separated). */
function getCorsOrigin(): string | string[] | boolean {
  const envOrigin = process.env.CORS_ORIGIN;
  if (envOrigin) return envOrigin.split(',').map((s) => s.trim());
  if (process.env.NODE_ENV === 'production') return false; // same-origin only if not configured
  return true; // allow all origins in development
}

const server = Fastify({ logger: true });

async function start() {
  validateEnv();
  await server.register(cors, { origin: getCorsOrigin() });

  // Initialize TalOS system — orchestrator + all agents + services
  const { orchestrator, workflows, monitor } = createSystemFromEnv();

  // Decorate fastify instance — types defined in src/types.d.ts
  server.decorate('orchestrator', orchestrator);
  server.decorate('workflows', workflows);
  server.decorate('monitor', monitor);

  // Register API routes
  await registerRoutes(server);

  const port = parseInt(process.env.API_PORT ?? '3001', 10);
  await server.listen({ port, host: '0.0.0.0' });

  server.log.info(`TalOS API server running on port ${port}`);
}

start().catch((err) => {
  console.error('Failed to start TalOS API server:', err);
  process.exit(1);
});

// Graceful shutdown — allow in-flight requests to complete before exiting
const shutdown = async (signal: string) => {
  server.log.info(`${signal} received — shutting down gracefully`);
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
