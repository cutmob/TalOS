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
  const required: string[] = ['BEDROCK_REGION'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn(`[TalOS] Warning: missing recommended env vars: ${missing.join(', ')}`);
    console.warn('[TalOS] Falling back to defaults — OK for local dev, set these for production');
  }
}

const server = Fastify({ logger: true });

async function start() {
  validateEnv();
  await server.register(cors, { origin: true });

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
