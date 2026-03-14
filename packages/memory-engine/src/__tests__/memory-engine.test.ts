import { describe, it, expect } from 'vitest';
import type { MemoryEntry, MemoryStore, MemoryQuery } from '../types.js';

/**
 * In-memory MemoryStore for testing — no AWS dependencies.
 */
class InMemoryStore implements MemoryStore {
  private entries: Map<string, MemoryEntry> = new Map();

  async save(entry: MemoryEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async query(query: MemoryQuery): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    const results: Array<{ entry: MemoryEntry; score: number }> = [];
    for (const entry of this.entries.values()) {
      if (query.category && entry.category !== query.category) continue;
      // Simple: return all non-expired entries with score 1
      if (entry.expiresAt && entry.expiresAt < Date.now()) continue;
      results.push({ entry, score: 1 });
    }
    return results.slice(0, query.limit ?? 10);
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async getBySession(sessionId: string): Promise<MemoryEntry[]> {
    return [...this.entries.values()].filter((e) => e.sessionId === sessionId);
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.entries.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

describe('InMemoryStore', () => {
  it('stores and retrieves a memory entry', async () => {
    const store = new InMemoryStore();

    const entry: MemoryEntry = {
      id: 'mem_1',
      type: 'short_term',
      category: 'task',
      content: { action: 'create_ticket', title: 'Fix login bug' },
      sessionId: 'session_abc',
      createdAt: Date.now(),
    };

    await store.save(entry);

    const results = await store.query({ limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].entry.id).toBe('mem_1');
    expect(results[0].entry.content).toEqual(entry.content);
  });

  it('getBySession filters entries by session', async () => {
    const store = new InMemoryStore();

    await store.save({
      id: 'mem_1',
      type: 'short_term',
      category: 'task',
      content: { action: 'a' },
      sessionId: 'session_1',
      createdAt: Date.now(),
    });

    await store.save({
      id: 'mem_2',
      type: 'short_term',
      category: 'task',
      content: { action: 'b' },
      sessionId: 'session_2',
      createdAt: Date.now(),
    });

    const session1 = await store.getBySession('session_1');
    expect(session1).toHaveLength(1);
    expect(session1[0].id).toBe('mem_1');
  });

  it('deletes an entry', async () => {
    const store = new InMemoryStore();

    await store.save({
      id: 'mem_del',
      type: 'long_term',
      category: 'workflow',
      content: { name: 'test' },
      createdAt: Date.now(),
    });

    await store.delete('mem_del');

    const results = await store.query({ limit: 10 });
    expect(results).toHaveLength(0);
  });

  it('cleanup removes expired entries', async () => {
    const store = new InMemoryStore();

    // Entry that expired in the past
    await store.save({
      id: 'mem_expired',
      type: 'short_term',
      category: 'task',
      content: { action: 'old' },
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 60_000,
    });

    // Entry that has not expired
    await store.save({
      id: 'mem_active',
      type: 'short_term',
      category: 'task',
      content: { action: 'new' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    const removed = await store.cleanup();
    expect(removed).toBe(1);

    const results = await store.query({ limit: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].entry.id).toBe('mem_active');
  });

  it('query filters by category', async () => {
    const store = new InMemoryStore();

    await store.save({
      id: 'mem_task',
      type: 'short_term',
      category: 'task',
      content: { action: 'do_stuff' },
      createdAt: Date.now(),
    });

    await store.save({
      id: 'mem_wf',
      type: 'long_term',
      category: 'workflow',
      content: { name: 'My Workflow' },
      createdAt: Date.now(),
    });

    const tasks = await store.query({ category: 'task', limit: 10 });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].entry.category).toBe('task');
  });

  it('query excludes expired entries', async () => {
    const store = new InMemoryStore();

    await store.save({
      id: 'mem_gone',
      type: 'short_term',
      category: 'task',
      content: {},
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() - 1_000,
    });

    const results = await store.query({ limit: 10 });
    expect(results).toHaveLength(0);
  });
});
