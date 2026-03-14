import { describe, it, expect } from 'vitest';
import { WorkflowRegistry } from '../registry.js';
import type { Workflow, WorkflowStore, WorkflowMatch } from '../types.js';

/**
 * In-memory WorkflowStore for testing — no external dependencies.
 */
class InMemoryWorkflowStore implements WorkflowStore {
  private workflows: Map<string, Workflow> = new Map();

  async save(workflow: Workflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
  }

  async get(id: string): Promise<Workflow | null> {
    return this.workflows.get(id) ?? null;
  }

  async search(query: string): Promise<WorkflowMatch[]> {
    const q = query.toLowerCase();
    const results: WorkflowMatch[] = [];
    for (const wf of this.workflows.values()) {
      const text = `${wf.name} ${wf.description} ${wf.tags.join(' ')}`.toLowerCase();
      if (text.includes(q)) {
        results.push({ workflow: wf, score: 1 });
      }
    }
    return results;
  }

  async listByConnector(connector: string): Promise<Workflow[]> {
    return [...this.workflows.values()].filter((wf) => wf.connector === connector);
  }

  async delete(id: string): Promise<void> {
    this.workflows.delete(id);
  }

  async update(id: string, updates: Partial<Workflow>): Promise<void> {
    const existing = this.workflows.get(id);
    if (existing) {
      this.workflows.set(id, { ...existing, ...updates });
    }
  }
}

describe('WorkflowRegistry', () => {
  function createRegistry(): WorkflowRegistry {
    return new WorkflowRegistry(new InMemoryWorkflowStore());
  }

  it('registers a workflow and returns an id', async () => {
    const registry = createRegistry();

    const id = await registry.registerWorkflow({
      name: 'Create JIRA Ticket',
      description: 'Creates a JIRA ticket from a Slack message',
      connector: 'jira',
      steps: [{ action: 'create_issue', target: 'jira' }],
      tags: ['jira', 'ticket'],
    });

    expect(id).toMatch(/^wf_/);
  });

  it('retrieves a registered workflow by id', async () => {
    const registry = createRegistry();

    const id = await registry.registerWorkflow({
      name: 'Send Report',
      description: 'Sends a weekly report via email',
      connector: 'gmail',
      steps: [{ action: 'send_email' }],
      tags: ['report', 'email'],
    });

    const workflow = await registry.getWorkflow(id);
    expect(workflow).not.toBeNull();
    expect(workflow!.name).toBe('Send Report');
    expect(workflow!.version).toBe(1);
  });

  it('findWorkflow returns matches by keyword', async () => {
    const registry = createRegistry();

    await registry.registerWorkflow({
      name: 'Deploy Service',
      description: 'Deploys a microservice to ECS',
      connector: 'aws',
      steps: [{ action: 'deploy' }],
      tags: ['deploy', 'ecs'],
    });

    await registry.registerWorkflow({
      name: 'Update Notion Page',
      description: 'Updates a Notion page with meeting notes',
      connector: 'notion',
      steps: [{ action: 'update_page' }],
      tags: ['notion', 'meeting'],
    });

    const results = await registry.findWorkflow('deploy');
    expect(results).toHaveLength(1);
    expect(results[0].workflow.name).toBe('Deploy Service');
  });

  it('findWorkflow returns empty for no matches', async () => {
    const registry = createRegistry();

    const results = await registry.findWorkflow('nonexistent');
    expect(results).toEqual([]);
  });

  it('evolveWorkflow increments version and updates steps', async () => {
    const registry = createRegistry();

    const id = await registry.registerWorkflow({
      name: 'Onboard User',
      description: 'Onboarding workflow',
      connector: 'slack',
      steps: [{ action: 'send_welcome' }],
      tags: ['onboard'],
    });

    await registry.evolveWorkflow(id, [
      { action: 'send_welcome' },
      { action: 'create_account' },
    ]);

    const updated = await registry.getWorkflow(id);
    expect(updated!.version).toBe(2);
    expect(updated!.steps).toHaveLength(2);
  });

  it('evolveWorkflow throws for unknown workflow', async () => {
    const registry = createRegistry();

    await expect(
      registry.evolveWorkflow('wf_nonexistent', [{ action: 'noop' }]),
    ).rejects.toThrow(/not found/i);
  });
});
