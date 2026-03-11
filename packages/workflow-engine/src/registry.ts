import type { Workflow, WorkflowStore, WorkflowMatch } from './types.js';

/**
 * Registry for reusable automation workflows.
 * Workflows are learned, stored, and retrieved for future use.
 */
export class WorkflowRegistry {
  private store: WorkflowStore;

  constructor(store: WorkflowStore) {
    this.store = store;
  }

  async registerWorkflow(workflow: Omit<Workflow, 'id' | 'version' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    await this.store.save({
      ...workflow,
      id,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });

    return id;
  }

  async findWorkflow(query: string): Promise<WorkflowMatch[]> {
    return this.store.search(query);
  }

  async getWorkflow(id: string): Promise<Workflow | null> {
    return this.store.get(id);
  }

  async evolveWorkflow(id: string, updatedSteps: Workflow['steps']): Promise<void> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new Error(`Workflow not found: ${id}`);
    }

    await this.store.update(id, {
      steps: updatedSteps,
      version: existing.version + 1,
      updatedAt: Date.now(),
    });
  }

  async getConnectorWorkflows(connector: string): Promise<Workflow[]> {
    return this.store.listByConnector(connector);
  }
}
