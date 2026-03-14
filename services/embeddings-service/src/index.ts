import type { MemoryEntry, MemoryStore, MemoryQuery } from '@talos/memory-engine';

/**
 * In-memory implementation of MemoryStore for development/hackathon.
 * Production would use OpenSearch with vector search or DynamoDB.
 */
export class InMemoryStore implements MemoryStore {
  private entries: Map<string, MemoryEntry> = new Map();

  async save(entry: MemoryEntry): Promise<void> {
    this.entries.set(entry.id, entry);
  }

  async query(query: MemoryQuery): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    const now = Date.now();
    // Half-life for freshness decay: 7 days in ms.
    // A semantic entry created 7 days ago scores at 50% of its raw similarity;
    // one created today scores at 100%. Short-term entries (with expiresAt) are
    // excluded from decay — they expire hard via cleanup() instead.
    const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

    const results: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const entry of this.entries.values()) {
      if (query.category && entry.category !== query.category) continue;

      let score = 0;

      // Vector similarity if embeddings available
      if (query.embedding && entry.embedding) {
        score = this.cosineSimilarity(query.embedding, entry.embedding);
      }

      // Text matching fallback
      if (query.text) {
        const content = JSON.stringify(entry.content).toLowerCase();
        const terms = query.text.toLowerCase().split(/\s+/);
        const matches = terms.filter((t) => content.includes(t)).length;
        score = Math.max(score, matches / terms.length);
      }

      // Freshness decay for long-term / semantic entries (not short-term, which expire hard).
      // Exponential decay: score *= e^(-age / halfLife).
      // This means stale UI snapshots and old workflow corrections rank below recent ones
      // even when their cosine similarity is similar.
      if (score > 0 && !entry.expiresAt && entry.createdAt) {
        const ageMs = now - entry.createdAt;
        const decayFactor = Math.exp(-ageMs / HALF_LIFE_MS);
        score *= decayFactor;
      }

      if (score >= (query.minScore ?? 0)) {
        results.push({ entry, score });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit ?? 10);
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

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
