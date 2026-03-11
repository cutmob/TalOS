import type { Workflow, WorkflowMatch } from './types.js';

/**
 * Matches user intents to stored workflows using keyword and tag similarity.
 * For production, this would use Nova Multimodal Embeddings for semantic search.
 */
export class WorkflowMatcher {
  match(query: string, workflows: Workflow[]): WorkflowMatch[] {
    const queryTerms = this.tokenize(query);

    const scored = workflows.map((workflow) => {
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

      // Normalize by query length
      score = queryTerms.length > 0 ? score / queryTerms.length : 0;

      return { workflow, score };
    });

    return scored
      .filter((m) => m.score > 0.1)
      .sort((a, b) => b.score - a.score);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }
}
