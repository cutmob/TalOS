import type { Workflow, WorkflowStore, WorkflowMatch } from '@talos/workflow-engine';
import { WorkflowMatcher } from '@talos/workflow-engine';

/**
 * In-memory workflow store for development.
 * Production would use DynamoDB with GSIs for connector-based queries.
 */
export class InMemoryWorkflowStore implements WorkflowStore {
  private workflows: Map<string, Workflow> = new Map();
  private matcher = new WorkflowMatcher();

  async save(workflow: Workflow): Promise<void> {
    this.workflows.set(workflow.id, workflow);
  }

  async get(id: string): Promise<Workflow | null> {
    return this.workflows.get(id) ?? null;
  }

  async search(query: string): Promise<WorkflowMatch[]> {
    return this.matcher.match(query, [...this.workflows.values()]);
  }

  async listByConnector(connector: string): Promise<Workflow[]> {
    return [...this.workflows.values()].filter((w) => w.connector === connector);
  }

  async delete(id: string): Promise<void> {
    this.workflows.delete(id);
  }

  async update(id: string, updates: Partial<Workflow>): Promise<void> {
    const existing = this.workflows.get(id);
    if (!existing) throw new Error(`Workflow not found: ${id}`);
    this.workflows.set(id, { ...existing, ...updates });
  }
}
