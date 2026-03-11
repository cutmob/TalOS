import type { FastifyInstance } from 'fastify';

export async function healthRoutes(server: FastifyInstance) {
  // Liveness
  server.get('/', async () => ({
    status: 'ok',
    service: 'operon-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  }));

  // Readiness — checks agents registered + automation runner reachable
  server.get('/ready', async (_, reply) => {
    const pool = server.orchestrator.getAgentPool();
    const registeredAgents = pool.getRegisteredAgentTypes();
    const expectedAgents = ['orchestrator', 'research', 'execution', 'recovery'];
    const allAgentsReady = expectedAgents.every((a) => (registeredAgents as string[]).includes(a));

    let automationRunnerOk = false;
    try {
      const runnerUrl = process.env.AUTOMATION_RUNNER_URL ?? 'http://localhost:3003';
      const res = await fetch(`${runnerUrl}/health`, { signal: AbortSignal.timeout(2000) });
      automationRunnerOk = res.ok;
    } catch { /* runner may not be started yet */ }

    return reply.status(allAgentsReady ? 200 : 503).send({
      status: allAgentsReady ? 'ready' : 'degraded',
      checks: {
        orchestrator: allAgentsReady ? 'ok' : 'degraded',
        agents: registeredAgents,
        automationRunner: automationRunnerOk ? 'ok' : 'unavailable',
      },
    });
  });
}
