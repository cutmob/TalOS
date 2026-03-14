import type { Workflow, WorkflowStore, WorkflowMatch } from './types.js';

/**
 * Registry for reusable automation workflows.
 * Workflows are learned, stored, and retrieved for future use.
 *
 * Pass an `embed` function at construction time to enable semantic search
 * using Nova 2 Multimodal Embeddings. Workflows are embedded at index time
 * (GENERIC_INDEX purpose) and queries are embedded at retrieval time
 * (GENERIC_RETRIEVAL purpose) — the asymmetry is intentional and is what
 * the Nova embeddings schema is designed for.
 *
 * Without `embed`, the registry falls back to keyword/tag overlap matching.
 */
export class WorkflowRegistry {
  private store: WorkflowStore;
  private embed: ((text: string) => Promise<number[]>) | null;

  constructor(
    store: WorkflowStore,
    embed?: (text: string) => Promise<number[]>
  ) {
    this.store = store;
    this.embed = embed ?? null;
  }

  async registerWorkflow(workflow: Omit<Workflow, 'id' | 'version' | 'createdAt' | 'updatedAt'>): Promise<string> {
    const id = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    // Embed the workflow at index time so future searches can use cosine similarity.
    // Concatenating name + description + tags gives the model the richest possible
    // signal — it's what we want queries to match against.
    let embedding: number[] | undefined;
    if (this.embed) {
      try {
        const text = [workflow.name, workflow.description, ...workflow.tags].join(' ');
        embedding = await this.embed(text);
      } catch (err) {
        console.warn('[WorkflowRegistry] embed failed — workflow will match by keyword only:', err);
      }
    }

    await this.store.save({
      ...workflow,
      id,
      version: 1,
      createdAt: now,
      updatedAt: now,
      embedding,
    });

    return id;
  }

  async findWorkflow(query: string): Promise<WorkflowMatch[]> {
    // Embed the query using GENERIC_RETRIEVAL — the retrieval-optimised counterpart
    // to GENERIC_INDEX used at storage time. Asymmetric purposes improve recall.
    let queryEmbedding: number[] | undefined;
    if (this.embed) {
      try {
        queryEmbedding = await this.embed(query);
      } catch {
        // Fall through to keyword search
      }
    }
    return this.store.search(query, queryEmbedding);
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
