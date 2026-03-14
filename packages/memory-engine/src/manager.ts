import type { MemoryEntry, MemoryStore, MemoryConfig, UISnapshot } from './types.js';
import { SemanticMemory } from './semantic.js';

/**
 * Manages OPERON's three-layer memory system:
 * - Short-term: session context (active tasks, recent commands)
 * - Long-term: stored workflows and corrections
 * - Semantic: embedding-based search for UI elements and knowledge
 */
export class MemoryManager {
  private store: MemoryStore;
  private semantic: SemanticMemory;
  private config: MemoryConfig;

  constructor(store: MemoryStore, config: MemoryConfig) {
    this.store = store;
    this.config = config;
    this.semantic = new SemanticMemory(config);
  }

  async rememberTask(sessionId: string, task: Record<string, unknown>): Promise<string> {
    const entry: MemoryEntry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'short_term',
      category: 'task',
      content: task,
      sessionId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.shortTermTTL,
    };
    await this.store.save(entry);
    return entry.id;
  }

  async storeUISnapshot(snapshot: UISnapshot): Promise<string> {
    const embedding = await this.semantic.embed(
      `${snapshot.app} ${snapshot.page} ${snapshot.elements.map((e) => e.label).join(' ')}`
    );

    const entry: MemoryEntry = {
      id: `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'semantic',
      category: 'ui_snapshot',
      content: snapshot as unknown as Record<string, unknown>,
      embedding,
      createdAt: Date.now(),
    };
    await this.store.save(entry);
    return entry.id;
  }

  async storeCorrection(
    app: string,
    oldSelector: string,
    newSelector: string,
    context: string
  ): Promise<void> {
    const embedding = await this.semantic.embed(`${app} ${context} ${oldSelector} ${newSelector}`);

    const entry: MemoryEntry = {
      id: `corr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'long_term',
      category: 'correction',
      content: { app, oldSelector, newSelector, context },
      embedding,
      createdAt: Date.now(),
    };
    await this.store.save(entry);
  }

  async recall(query: string, limit = 5): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    const embedding = await this.semantic.embed(query);
    return this.store.query({ embedding, limit, minScore: 0.5 });
  }

  async getSessionContext(sessionId: string): Promise<MemoryEntry[]> {
    return this.store.getBySession(sessionId);
  }

  async cleanup(): Promise<number> {
    return this.store.cleanup();
  }
}
