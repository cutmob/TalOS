import type { FastifyInstance } from 'fastify';
import { taskRoutes } from './tasks.js';
import { workflowRoutes } from './workflows.js';
import { healthRoutes } from './health.js';
import { metricsRoutes } from './metrics.js';
import { chatRoutes } from './chat.js';
import { approvalRoutes } from './approvals.js';

export async function registerRoutes(server: FastifyInstance) {
  await server.register(healthRoutes, { prefix: '/api/health' });
  await server.register(taskRoutes, { prefix: '/api/tasks' });
  await server.register(workflowRoutes, { prefix: '/api/workflows' });
  await server.register(metricsRoutes, { prefix: '/api/metrics' });
  await server.register(chatRoutes, { prefix: '/api/chat' });
  await server.register(approvalRoutes, { prefix: '/api/approvals' });
}
