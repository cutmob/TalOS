import { describe, it, expect, vi } from 'vitest';
import { classifyAction, isWriteAction } from '../action-classifier.js';
import { Orchestrator } from '../orchestrator.js';
import type { OrchestratorConfig } from '../types.js';

// ── Mock AWS SDK ────────────────────────────────────────────────────────────

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
    send: vi.fn(),
  })),
  ConverseCommand: vi.fn(),
}));

vi.mock('@talos/agent-runtime', () => ({
  AgentPool: vi.fn().mockImplementation(() => ({
    getAvailableTools: vi.fn().mockReturnValue([]),
    getAvailableConnectors: vi.fn().mockReturnValue([]),
    getAgent: vi.fn().mockReturnValue({ execute: vi.fn() }),
    hasAgent: vi.fn().mockReturnValue(false),
  })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: OrchestratorConfig = {
  bedrockRegion: 'us-east-1',
  novaProModelId: 'amazon.nova-2-lite-v1:0',
  jiraProjectKey: 'TEST',
  maxConcurrentAgents: 4,
  taskTimeout: 30_000,
  retryLimit: 2,
};

function createOrchestrator(config: Partial<OrchestratorConfig> = {}): Orchestrator {
  return new Orchestrator({ ...DEFAULT_CONFIG, ...config });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Action Classifier
// ═══════════════════════════════════════════════════════════════════════════

describe('classifyAction', () => {
  it('classifies Jira search as read', () => {
    expect(classifyAction('jira_search')).toBe('read');
  });

  it('classifies Slack read actions as read', () => {
    expect(classifyAction('slack_read_messages')).toBe('read');
    expect(classifyAction('slack_list_channels')).toBe('read');
  });

  it('classifies Gmail read actions as read', () => {
    expect(classifyAction('gmail_search')).toBe('read');
    expect(classifyAction('gmail_read_email')).toBe('read');
  });

  it('classifies HubSpot search actions as read', () => {
    expect(classifyAction('hubspot_search_contacts')).toBe('read');
    expect(classifyAction('hubspot_search_deals')).toBe('read');
    expect(classifyAction('hubspot_search_objects')).toBe('read');
    expect(classifyAction('hubspot_list_properties')).toBe('read');
  });

  it('classifies Notion read actions as read', () => {
    expect(classifyAction('notion_search')).toBe('read');
    expect(classifyAction('notion_read_page')).toBe('read');
  });

  it('classifies cross-tool and browser observation actions as read', () => {
    expect(classifyAction('knowledge_search')).toBe('read');
    expect(classifyAction('screenshot')).toBe('read');
    expect(classifyAction('extract')).toBe('read');
    expect(classifyAction('wait')).toBe('read');
  });

  it('classifies write actions as write', () => {
    expect(classifyAction('gmail_send_email')).toBe('write');
    expect(classifyAction('slack_send_message')).toBe('write');
    expect(classifyAction('jira_create_ticket')).toBe('write');
    expect(classifyAction('jira_update_ticket')).toBe('write');
    expect(classifyAction('hubspot_create_contact')).toBe('write');
    expect(classifyAction('notion_create_page')).toBe('write');
  });

  it('defaults unknown actions to write (safe default)', () => {
    expect(classifyAction('some_unknown_action')).toBe('write');
    expect(classifyAction('')).toBe('write');
    expect(classifyAction('custom_dangerous_thing')).toBe('write');
  });
});

describe('isWriteAction', () => {
  it('returns true for write actions', () => {
    expect(isWriteAction('gmail_send_email')).toBe(true);
    expect(isWriteAction('jira_create_ticket')).toBe(true);
    expect(isWriteAction('unknown_action')).toBe(true);
  });

  it('returns false for read actions', () => {
    expect(isWriteAction('jira_search')).toBe(false);
    expect(isWriteAction('gmail_read_email')).toBe(false);
    expect(isWriteAction('knowledge_search')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Orchestrator Approval Gate
// ═══════════════════════════════════════════════════════════════════════════

describe('Orchestrator approval settings', () => {
  it('defaults to write_approval autonomy level', () => {
    const orch = createOrchestrator();
    const settings = orch.getApprovalSettings();

    expect(settings.defaultLevel).toBe('write_approval');
    expect(settings.connectorOverrides).toEqual({});
  });

  it('updateApprovalSettings changes the default level', () => {
    const orch = createOrchestrator();
    const updated = orch.updateApprovalSettings({ defaultLevel: 'full' });

    expect(updated.defaultLevel).toBe('full');
    expect(orch.getApprovalSettings().defaultLevel).toBe('full');
  });

  it('updateApprovalSettings merges connector overrides', () => {
    const orch = createOrchestrator();

    orch.updateApprovalSettings({
      connectorOverrides: { gmail: 'write_approval', jira: 'full' },
    });

    const settings = orch.getApprovalSettings();
    expect(settings.connectorOverrides.gmail).toBe('write_approval');
    expect(settings.connectorOverrides.jira).toBe('full');
  });

  it('updateApprovalSettings merges without clobbering existing overrides', () => {
    const orch = createOrchestrator();

    orch.updateApprovalSettings({ connectorOverrides: { gmail: 'write_approval' } });
    orch.updateApprovalSettings({ connectorOverrides: { jira: 'full' } });

    const settings = orch.getApprovalSettings();
    expect(settings.connectorOverrides.gmail).toBe('write_approval');
    expect(settings.connectorOverrides.jira).toBe('full');
  });

  it('getApprovalSettings returns a copy (not a reference)', () => {
    const orch = createOrchestrator();
    const settings = orch.getApprovalSettings();
    settings.defaultLevel = 'full';

    // Original should be unaffected
    expect(orch.getApprovalSettings().defaultLevel).toBe('write_approval');
  });
});

describe('Orchestrator pending approvals', () => {
  it('starts with no pending approvals', () => {
    const orch = createOrchestrator();
    expect(orch.getPendingApprovals()).toEqual([]);
  });

  it('approveTask throws for non-existent approval ID', async () => {
    const orch = createOrchestrator();
    await expect(orch.approveTask('nonexistent_id')).rejects.toThrow(
      /No pending approval found: nonexistent_id/
    );
  });

  it('rejectTask throws for non-existent approval ID', () => {
    const orch = createOrchestrator();
    expect(() => orch.rejectTask('nonexistent_id')).toThrow(
      /No pending approval found: nonexistent_id/
    );
  });

  it('rejectTask returns cancellation message and clears the pending approval', () => {
    const orch = createOrchestrator();

    // Manually inject a pending approval to test rejection
    const pendingMap = (orch as any).pendingApprovals as Map<string, any>;
    const fakeApproval = {
      approvalId: 'test_approval_1',
      sessionId: 'session_1',
      userId: 'user_1',
      createdAt: Date.now(),
      taskGraph: { nodes: [], createdAt: Date.now() },
      writeActions: [],
      readActions: [],
      originalInput: 'send an email',
      request: { sessionId: 'session_1', userId: 'user_1', input: 'send an email' },
    };
    pendingMap.set('test_approval_1', fakeApproval);

    const response = orch.rejectTask('test_approval_1');

    expect(response.message).toBe('Action cancelled — no changes were made.');
    expect(response.status).toBe('completed');
    expect(response.results).toEqual([]);
    expect(response.sessionId).toBe('session_1');

    // Pending approval should be removed
    expect(orch.getPendingApprovals()).toEqual([]);
    expect(orch.getPendingApproval('test_approval_1')).toBeUndefined();
  });

  it('getPendingApproval returns undefined for unknown IDs', () => {
    const orch = createOrchestrator();
    expect(orch.getPendingApproval('does_not_exist')).toBeUndefined();
  });

  it('getPendingApprovals returns all pending items', () => {
    const orch = createOrchestrator();
    const pendingMap = (orch as any).pendingApprovals as Map<string, any>;

    const baseApproval = {
      sessionId: 'session_1',
      userId: 'user_1',
      createdAt: Date.now(),
      taskGraph: { nodes: [], createdAt: Date.now() },
      writeActions: [],
      readActions: [],
      originalInput: 'do something',
      request: { sessionId: 'session_1', userId: 'user_1', input: 'do something' },
    };

    pendingMap.set('approval_a', { ...baseApproval, approvalId: 'approval_a' });
    pendingMap.set('approval_b', { ...baseApproval, approvalId: 'approval_b' });

    const pending = orch.getPendingApprovals();
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.approvalId).sort()).toEqual(['approval_a', 'approval_b']);
  });

  it('approveTask removes the approval from pending list and executes', async () => {
    const orch = createOrchestrator();
    const pendingMap = (orch as any).pendingApprovals as Map<string, any>;

    const fakeApproval = {
      approvalId: 'test_approve_exec',
      sessionId: 'session_2',
      userId: 'user_2',
      createdAt: Date.now(),
      taskGraph: { nodes: [], createdAt: Date.now() },
      writeActions: [],
      readActions: [],
      originalInput: 'create a ticket',
      request: { sessionId: 'session_2', userId: 'user_2', input: 'create a ticket' },
    };
    pendingMap.set('test_approve_exec', fakeApproval);

    // With an empty task graph, execute should succeed immediately
    const response = await orch.approveTask('test_approve_exec');

    expect(response.sessionId).toBe('session_2');
    expect(response.status).toBe('completed');
    expect(orch.getPendingApprovals()).toEqual([]);
  });
});

describe('Orchestrator checkApprovalRequired (via handleRequest)', () => {
  it('full autonomy executes write actions without approval', () => {
    const orch = createOrchestrator();
    orch.updateApprovalSettings({ defaultLevel: 'full' });

    // Access private method via cast
    const checkFn = (orch as any).checkApprovalRequired.bind(orch);
    const taskGraph = {
      nodes: [
        { id: 'n1', action: 'gmail_send_email', agentType: 'execution', parameters: {}, dependencies: [] },
      ],
      createdAt: Date.now(),
    };
    const request = { sessionId: 's1', userId: 'u1', input: 'send email' };

    const result = checkFn(taskGraph, request);
    expect(result).toBeNull();
  });

  it('write_approval pauses write actions for approval', () => {
    const orch = createOrchestrator();
    orch.updateApprovalSettings({ defaultLevel: 'write_approval' });

    const checkFn = (orch as any).checkApprovalRequired.bind(orch);
    const taskGraph = {
      nodes: [
        { id: 'n1', action: 'slack_send_message', agentType: 'execution', parameters: { channel: 'general' }, dependencies: [] },
      ],
      createdAt: Date.now(),
    };
    const request = { sessionId: 's1', userId: 'u1', input: 'send slack msg' };

    const result = checkFn(taskGraph, request);
    expect(result).not.toBeNull();
    expect(result.writeActions).toHaveLength(1);
    expect(result.writeActions[0].action).toBe('slack_send_message');
    expect(result.approvalId).toMatch(/^approval_/);
  });

  it('write_approval lets read-only task graphs execute immediately', () => {
    const orch = createOrchestrator();
    orch.updateApprovalSettings({ defaultLevel: 'write_approval' });

    const checkFn = (orch as any).checkApprovalRequired.bind(orch);
    const taskGraph = {
      nodes: [
        { id: 'n1', action: 'jira_search', agentType: 'execution', parameters: {}, dependencies: [] },
        { id: 'n2', action: 'gmail_read_email', agentType: 'execution', parameters: {}, dependencies: [] },
      ],
      createdAt: Date.now(),
    };
    const request = { sessionId: 's1', userId: 'u1', input: 'search jira and read email' };

    const result = checkFn(taskGraph, request);
    expect(result).toBeNull();
  });

  it('per-connector overrides take effect (gmail write_approval, jira full)', () => {
    const orch = createOrchestrator();
    orch.updateApprovalSettings({
      defaultLevel: 'full',
      connectorOverrides: { gmail: 'write_approval', jira: 'full' },
    });

    const checkFn = (orch as any).checkApprovalRequired.bind(orch);

    // Gmail write action should require approval due to override
    const gmailGraph = {
      nodes: [
        { id: 'n1', action: 'gmail_send_email', agentType: 'execution', parameters: {}, dependencies: [] },
      ],
      createdAt: Date.now(),
    };
    const gmailResult = checkFn(gmailGraph, { sessionId: 's1', userId: 'u1', input: 'send email' });
    expect(gmailResult).not.toBeNull();
    expect(gmailResult.writeActions[0].action).toBe('gmail_send_email');

    // Jira write action should execute freely (full autonomy override)
    const jiraGraph = {
      nodes: [
        { id: 'n1', action: 'jira_create_ticket', agentType: 'execution', parameters: {}, dependencies: [] },
      ],
      createdAt: Date.now(),
    };
    const jiraResult = checkFn(jiraGraph, { sessionId: 's2', userId: 'u1', input: 'create jira ticket' });
    // With defaultLevel 'full' and jira override 'full', this should pass through
    expect(jiraResult).toBeNull();
  });

  it('mixed read+write graph includes both in the approval preview', () => {
    const orch = createOrchestrator();
    orch.updateApprovalSettings({ defaultLevel: 'write_approval' });

    const checkFn = (orch as any).checkApprovalRequired.bind(orch);
    const taskGraph = {
      nodes: [
        { id: 'n1', action: 'jira_search', agentType: 'research', parameters: {}, dependencies: [] },
        { id: 'n2', action: 'jira_create_ticket', agentType: 'execution', parameters: { summary: 'Fix bug' }, dependencies: ['n1'] },
      ],
      createdAt: Date.now(),
    };
    const request = { sessionId: 's1', userId: 'u1', input: 'search and create ticket' };

    const result = checkFn(taskGraph, request);
    expect(result).not.toBeNull();
    expect(result.writeActions).toHaveLength(1);
    expect(result.readActions).toHaveLength(1);
    expect(result.readActions[0].action).toBe('jira_search');
    expect(result.writeActions[0].action).toBe('jira_create_ticket');
  });
});
