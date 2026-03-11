import type { FastifyInstance } from 'fastify';

export async function metricsRoutes(server: FastifyInstance) {
  // Aggregate metrics for the dashboard
  server.get('/', async (_, reply) => {
    const metrics = server.monitor.getMetrics();
    return reply.send(metrics);
  });

  // Recent execution events (for live dashboard feed)
  server.get('/events', async (_, reply) => {
    const events = server.monitor.getRecentEvents(50);
    return reply.send({ events });
  });
}
