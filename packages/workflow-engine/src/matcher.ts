import type { Workflow, WorkflowMatch } from './types.js';

/**
 * Matches user intents to stored workflows.
 *
 * Primary path: cosine similarity on Nova 2 Multimodal embeddings when both
 * the workflow and the query have pre-computed embeddings.
 *
 * Fallback: keyword / tag overlap for workflows that pre-date semantic indexing.
 *
 * Using two strategies lets the system improve over time: new workflows get
 * real embeddings, old ones still surface via keyword until re-indexed.
 */
export class WorkflowMatcher {
  /**
   * @param query       Raw user request string (used for keyword fallback)
   * @param workflows   All candidate workflows
   * @param queryEmbedding  Nova embedding of the query (GENERIC_RETRIEVAL purpose)
   */
  match(query: string, workflows: Workflow[], queryEmbedding?: number[]): WorkflowMatch[] {
    const queryTerms = this.tokenize(query);

    const scored = workflows.map((workflow) => {
      // ── Semantic path (preferred) ──────────────────────────────────────────
      // Both the workflow and query have embeddings → use cosine similarity.
      // This handles paraphrase matching: "deploy to prod" finds "push to production".
      if (queryEmbedding && workflow.embedding && workflow.embedding.length > 0) {
        const score = this.cosineSimilarity(queryEmbedding, workflow.embedding);
        return { workflow, score };
      }

      // ── Keyword fallback ───────────────────────────────────────────────────
      // Workflow predates semantic indexing, or embeddings unavailable.
      const nameTerms = this.tokenize(workflow.name);
      const descTerms = this.tokenize(workflow.description);
      const tagTerms = workflow.tags.map((t) => t.toLowerCase());
      const allTerms = [...nameTerms, ...descTerms, ...tagTerms];

      let score = 0;
      for (const qt of queryTerms) {
        for (const wt of allTerms) {
          if (wt === qt) score += 1.0;
          else if (wt.includes(qt) || qt.includes(wt)) score += 0.5;
        }
      }
      score = queryTerms.length > 0 ? score / queryTerms.length : 0;

      return { workflow, score };
    });

    // Semantic matches: threshold 0.5 cosine. Keyword matches: threshold 0.1.
    return scored
      .filter((m) => {
        const hasSemantic = queryEmbedding && m.workflow.embedding;
        return hasSemantic ? m.score >= 0.5 : m.score > 0.1;
      })
      .sort((a, b) => b.score - a.score);
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

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}
