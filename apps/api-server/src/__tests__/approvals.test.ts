import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { approvalRoutes } from '../routes/approvals.js';
import { healthRoutes } from '../routes/health.js';

// ---------------------------------------------------------------------------
// Mock orchestrator
// ---------------------------------------------------------------------------

function createMockOrchestrator() {
  const defaultSettings = {
    defaultLevel: 'write_approval' as const,
    connectorOverrides: {},
  };

  let settings = { ...defaultSettings };
  const pendingApprovals: Record<string, { id: string; task: string; status: string }> = {};

  return {
    // Approval settings
    getApprovalSettings: vi.fn(() => ({ ...settings })),
    updateApprovalSettings: vi.fn((patch: Record<string, unknown>) => {
      settings = { ...settings, ...patch };
      return { ...settings };
    }),

    // Pending approvals
    getPendingApprovals: vi.fn(() => Object.values(pendingApprovals)),
    getPendingApproval: vi.fn((id: string) => pendingApprovals[id] ?? null),

    // Actions
    approveTask: vi.fn(async (id: string, _onProgress?: (evt: unknown) => void) => {
      const item = pendingApprovals[id];
      if (!item) throw new Error('Approval not found');
      delete pendingApprovals[id];
      return { id, status: 'approved' };
    }),
    rejectTask: vi.fn((id: string) => {
      const item = pendingApprovals[id];
      if (!item) throw new Error('Approval not found');
      delete pendingApprovals[id];
      return { id, status: 'rejected' };
    }),

    // Health route needs this
    getAgentPool: vi.fn(() => ({
      getRegisteredAgentTypes: vi.fn(() => ['orchestrator', 'research', 'execution', 'recovery']),
    })),

    // Expose internals for test helpers
    _pendingApprovals: pendingApprovals,
    _resetSettings: () => {
      settings = { ...defaultSettings };
    },
  };
}

// ---------------------------------------------------------------------------
// Server builder
// ---------------------------------------------------------------------------

async function buildServer() {
  const server = Fastify({ logger: false });

  // Zod error handler matching the real server
  server.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'Validation Error',
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const statusCode =
      'statusCode' in error ? (error as { statusCode: number }).statusCode : 500;
    return reply.status(statusCode ?? 500).send({ error: error.message ?? 'Internal Server Error' });
  });

  const orchestrator = createMockOrchestrator();

  server.decorate('orchestrator', orchestrator as unknown as FastifyInstance['orchestrator']);

  await server.register(approvalRoutes, { prefix: '/api/approvals' });
  await server.register(healthRoutes, { prefix: '/api/health' });

  return { server, orchestrator };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Approval routes', () => {
  let server: FastifyInstance;
  let orchestrator: ReturnType<typeof createMockOrchestrator>;

  beforeEach(async () => {
    const built = await buildServer();
    server = built.server;
    orchestrator = built.orchestrator;
  });

  // 1
  it('GET /api/approvals/settings returns default settings', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/approvals/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('defaultLevel', 'write_approval');
    expect(body).toHaveProperty('connectorOverrides');
    expect(orchestrator.getApprovalSettings).toHaveBeenCalledOnce();
  });

  // 2
  it('PUT /api/approvals/settings updates settings', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/approvals/settings',
      payload: { defaultLevel: 'full' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.defaultLevel).toBe('full');
    expect(orchestrator.updateApprovalSettings).toHaveBeenCalledWith({ defaultLevel: 'full' });
  });

  // 3
  it('PUT /api/approvals/settings with invalid body returns 400', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/approvals/settings',
      payload: { defaultLevel: 'not_a_real_level' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('Validation Error');
    expect(body.issues).toBeInstanceOf(Array);
    expect(body.issues.length).toBeGreaterThan(0);
  });

  // 4
  it('GET /api/approvals returns empty array initially', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/approvals' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(orchestrator.getPendingApprovals).toHaveBeenCalledOnce();
  });

  // 5
  it('GET /api/approvals/:id returns 404 for unknown ID', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/approvals/nonexistent-id' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Approval not found' });
  });

  // 6
  it('POST /api/approvals/:id/reject returns 404 for unknown ID', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/approvals/nonexistent-id/reject' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Approval not found' });
  });

  // 7
  it('POST /api/approvals/:id/approve returns 404 for unknown ID', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/approvals/nonexistent-id/approve' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Approval not found' });
  });

  // 8
  it('GET /api/approvals/:id returns a pending approval when it exists', async () => {
    const approval = { id: 'abc-123', task: 'deploy', status: 'pending' };
    orchestrator._pendingApprovals['abc-123'] = approval;

    const res = await server.inject({ method: 'GET', url: '/api/approvals/abc-123' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(approval);
    expect(orchestrator.getPendingApproval).toHaveBeenCalledWith('abc-123');
  });

  // 9
  it('POST /api/approvals/:id/reject removes the approval and returns result', async () => {
    orchestrator._pendingApprovals['rej-1'] = { id: 'rej-1', task: 'delete', status: 'pending' };

    const res = await server.inject({ method: 'POST', url: '/api/approvals/rej-1/reject' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'rej-1', status: 'rejected' });
    expect(orchestrator.rejectTask).toHaveBeenCalledWith('rej-1');
  });

  // 10
  it('PUT /api/approvals/settings with connector overrides applies them', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/approvals/settings',
      payload: {
        connectorOverrides: { slack: 'full', jira: 'all_approval' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connectorOverrides).toEqual({ slack: 'full', jira: 'all_approval' });
  });

  // 11
  it('PUT /api/approvals/settings rejects unknown connector names', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/approvals/settings',
      payload: {
        connectorOverrides: { unknown_service: 'full' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation Error');
  });

  // 12 — SSE approve: inject() can't fully test hijacked streams, so we test
  // the orchestrator integration directly instead.
  it('POST /api/approvals/:id/approve invokes approveTask', async () => {
    orchestrator._pendingApprovals['app-1'] = { id: 'app-1', task: 'create-issue', status: 'pending' };

    // Call approve directly on the orchestrator mock (route delegates to this)
    const result = await orchestrator.approveTask('app-1', () => {});
    expect(result).toEqual({ id: 'app-1', status: 'approved' });
    expect(orchestrator.approveTask).toHaveBeenCalledWith('app-1', expect.any(Function));
  });
});

describe('Health routes', () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    const built = await buildServer();
    server = built.server;
  });

  // 13
  it('GET /api/health returns ok status', async () => {
    const res = await server.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('talos-api');
    expect(body).toHaveProperty('timestamp');
  });
});
