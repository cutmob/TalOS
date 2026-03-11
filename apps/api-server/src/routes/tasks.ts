import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const TaskRequestSchema = z.object({
  input: z.string().min(1).max(2000),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

export async function taskRoutes(server: FastifyInstance) {
  // Submit a new task for OPERON to execute
  server.post('/submit', async (request, reply) => {
    const body = TaskRequestSchema.parse(request.body);

    const sessionId = body.sessionId ?? `session_${Date.now()}`;
    const userId = body.userId ?? 'anonymous';
    const startTime = Date.now();

    server.monitor.record({
      sessionId,
      taskId: sessionId,
      type: 'task_created',
      agentType: 'orchestrator',
      data: { input: body.input, userId },
    });

    try {
      server.monitor.record({ sessionId, taskId: sessionId, type: 'task_started', agentType: 'orchestrator', data: {} });

      const result = await server.orchestrator.handleRequest({
        sessionId,
        userId,
        input: body.input,
      });

      const duration = Date.now() - startTime;
      const allOk = result.results.every((r) => r.status === 'success');

      server.monitor.record({
        sessionId,
        taskId: sessionId,
        type: allOk ? 'task_completed' : 'task_failed',
        agentType: 'orchestrator',
        data: { duration, taskCount: result.results.length },
      });

      return reply.status(200).send(result);
    } catch (err) {
      server.monitor.record({
        sessionId,
        taskId: sessionId,
        type: 'task_failed',
        agentType: 'orchestrator',
        data: { error: String(err) },
      });
      throw err;
    }
  });

  // Get status of a running task / active count
  server.get<{ Params: { sessionId: string } }>('/:sessionId', async (request) => {
    const { sessionId } = request.params;
    const events = server.monitor.getSessionEvents(sessionId);
    return {
      sessionId,
      activeTasks: server.orchestrator.getActiveTaskCount(),
      events: events.slice(-10),
    };
  });
}
