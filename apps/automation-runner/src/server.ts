/**
 * Automation Runner HTTP Server
 *
 * Exposes AutomationRunner as a microservice so the ExecutionAgent
 * (running in the api-server process) can delegate browser automation
 * actions via HTTP.
 *
 * POST /sessions                          - create a browser session
 * POST /sessions/:sessionId/action        - execute an automation action
 * DELETE /sessions/:sessionId             - close a session
 * GET  /health                            - status + Nova Act availability
 */
import Fastify from 'fastify';
import { AutomationRunner } from './runner.js';
import type { AutomationAction } from './runner.js';

const server = Fastify({ logger: { level: 'info' } });
const runner = new AutomationRunner();

server.post<{ Body: { sessionId: string; startUrl: string } }>(
  '/sessions',
  async (req, reply) => {
    const { sessionId, startUrl } = req.body;
    await runner.createSession(sessionId, startUrl);
    return reply.status(201).send({ sessionId, status: 'created' });
  }
);

server.post<{ Params: { sessionId: string }; Body: AutomationAction }>(
  '/sessions/:sessionId/action',
  async (req, reply) => {
    try {
      const result = await runner.executeAction(req.params.sessionId, req.body);
      return reply.send({ result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If session doesn't exist, create one at about:blank then retry
      if (msg.includes('No session')) {
        await runner.createSession(req.params.sessionId, 'about:blank');
        const result = await runner.executeAction(req.params.sessionId, req.body);
        return reply.send({ result });
      }
      return reply.status(500).send({ error: msg });
    }
  }
);

server.delete<{ Params: { sessionId: string } }>(
  '/sessions/:sessionId',
  async (req, reply) => {
    await runner.closeSession(req.params.sessionId);
    return reply.send({ status: 'closed' });
  }
);

server.get('/health', async () => ({
  status: 'ok',
  service: 'operon-automation-runner',
  novaActAvailable: runner.isNovaActAvailable(),
}));

async function start() {
  await runner.initialize();

  const port = parseInt(process.env.AUTOMATION_RUNNER_PORT ?? '3003', 10);
  await server.listen({ port, host: '0.0.0.0' });
  console.log(`Automation runner HTTP server on port ${port}`);
}

start().catch((err) => {
  console.error('Failed to start automation runner:', err);
  process.exit(1);
});
