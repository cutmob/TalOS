import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const WorkflowSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().optional().default(10),
});

export async function workflowRoutes(server: FastifyInstance) {
  // Search stored workflows by natural language query
  server.post('/search', async (request) => {
    const body = WorkflowSearchSchema.parse(request.body);
    const results = await server.workflows.findWorkflow(body.query);
    return { workflows: results.slice(0, body.limit), query: body.query };
  });

  // List workflows for a specific connector
  server.get<{ Params: { connector: string } }>('/connector/:connector', async (request) => {
    const { connector } = request.params;
    const workflows = await server.workflows.getConnectorWorkflows(connector);
    return { connector, workflows };
  });
}
