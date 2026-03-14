import type { FastifyInstance } from 'fastify';
import type { ProgressEvent } from '@talos/orchestrator';
import { z } from 'zod';

const AutonomyLevelSchema = z.enum(['full', 'write_approval', 'all_approval']);

const UpdateSettingsSchema = z.object({
  defaultLevel: AutonomyLevelSchema.optional(),
  connectorOverrides: z
    .record(
      z.enum(['jira', 'slack', 'gmail', 'hubspot', 'notion', 'browser']),
      AutonomyLevelSchema,
    )
    .optional(),
});

export async function approvalRoutes(server: FastifyInstance) {
  // ── Autonomy settings ────────────────────────────────────────────────────

  /** Get current autonomy settings. */
  server.get('/settings', async () => {
    return server.orchestrator.getApprovalSettings();
  });

  /** Update autonomy settings (partial merge). */
  server.put('/settings', async (request, reply) => {
    const body = UpdateSettingsSchema.parse(request.body);
    const updated = server.orchestrator.updateApprovalSettings(body);
    return reply.send(updated);
  });

  // ── Pending approvals ────────────────────────────────────────────────────

  /** List all pending approvals. */
  server.get('/', async () => {
    return server.orchestrator.getPendingApprovals();
  });

  /** Get a single pending approval by ID. */
  server.get<{ Params: { approvalId: string } }>('/:approvalId', async (request, reply) => {
    const pending = server.orchestrator.getPendingApproval(request.params.approvalId);
    if (!pending) return reply.status(404).send({ error: 'Approval not found' });
    return pending;
  });

  /** Approve — execute the pending task graph. Returns SSE stream. */
  server.post<{ Params: { approvalId: string } }>('/:approvalId/approve', async (request, reply) => {
    const { approvalId } = request.params;
    const pending = server.orchestrator.getPendingApproval(approvalId);
    if (!pending) return reply.status(404).send({ error: 'Approval not found' });

    // Stream the execution via SSE
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onProgress = (evt: ProgressEvent) => {
      send('progress', evt);
    };

    try {
      const result = await server.orchestrator.approveTask(approvalId, onProgress);
      send('result', result);
    } catch (err) {
      send('error', { message: String(err) });
    } finally {
      reply.raw.end();
    }
  });

  /** Reject — discard the pending task graph. */
  server.post<{ Params: { approvalId: string } }>('/:approvalId/reject', async (request, reply) => {
    const { approvalId } = request.params;
    try {
      const result = server.orchestrator.rejectTask(approvalId);
      return reply.send(result);
    } catch {
      return reply.status(404).send({ error: 'Approval not found' });
    }
  });
}
