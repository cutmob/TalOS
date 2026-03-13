import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const ChatRequestSchema = z.object({
  input: z.string().min(1).max(2000),
  sessionId: z.string().max(128).regex(/^[\w-]+$/).optional(),
  userId: z.string().max(128).optional(),
  targetApp: z.enum(['jira', 'slack', 'gmail', 'hubspot', 'notion', 'browser']).optional(),
});

export async function chatRoutes(server: FastifyInstance) {
  server.post('/', async (request, reply) => {
    const body = ChatRequestSchema.parse(request.body);

    const sessionId = body.sessionId ?? `session_${Date.now()}`;
    const userId = body.userId ?? 'anonymous';

    const result = await server.orchestrator.handleRequest({
      sessionId,
      userId,
      input: body.input,
      targetApp: body.targetApp,
    });

    return reply.send({
      sessionId: result.sessionId,
      status: result.status,
      response: result.message,
      taskGraph: result.taskGraph,
      results: result.results,
    });
  });
}

