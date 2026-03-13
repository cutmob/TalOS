import type { JiraConfig, JiraTicket, JiraSearchResult } from './types.js';

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === retries - 1) throw err;
      // Retry on 429 (rate limit) or 5xx (server error) — regex avoids false positives from generic '5'
      const retryable = err instanceof Error && /(?:429|5\d\d)/.test(err.message);
      if (!retryable) throw err;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 30_000)));
    }
  }
  throw new Error('unreachable');
}

/**
 * Jira Connector — provides both API and UI automation workflows for Jira.
 *
 * Two modes:
 * 1. API mode: Direct REST API calls (preferred when API access is available)
 * 2. UI mode: Nova Act navigates the Jira web interface (fallback / demo)
 *
 * The connector exposes high-level operations that the orchestrator can invoke.
 */
export class JiraConnector {
  private config: JiraConfig;
  private authHeader: string;

  constructor(config: JiraConfig) {
    this.config = config;
    this.authHeader = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  }

  async createTicket(ticket: JiraTicket): Promise<{ id: string; key: string; url: string }> {
    const response = await withRetry(() => fetch(`${this.config.baseUrl}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${this.authHeader}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        fields: {
          project: { key: this.config.projectKey },
          summary: ticket.summary,
          description: ticket.description ? {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: ticket.description }] }],
          } : undefined,
          issuetype: { name: ticket.issueType },
          priority: ticket.priority ? { name: ticket.priority } : undefined,
          labels: ticket.labels,
        },
      }),
    }));

    if (!response.ok) {
      throw new Error(`Jira API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { id: string; key: string };
    return {
      id: data.id,
      key: data.key,
      url: `${this.config.baseUrl}/browse/${data.key}`,
    };
  }

  async searchTickets(jql: string): Promise<JiraSearchResult[]> {
    const params = new URLSearchParams({
      jql,
      maxResults: '50',
      fields: 'summary,status,assignee',
    });

    const response = await withRetry(() => fetch(
      // Jira Cloud enhanced JQL search endpoint — GET /rest/api/3/search/jql
      `${this.config.baseUrl}/rest/api/3/search/jql?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${this.authHeader}`,
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      }
    ));

    if (!response.ok) {
      throw new Error(`Jira search error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as {
      issues?: Array<{
        id: string;
        key: string;
        fields?: {
          summary?: string;
          status?: { name?: string };
          assignee?: { displayName?: string } | null;
        };
      }>;
    };

    if (!Array.isArray(data.issues)) {
      return [];
    }

    return data.issues
      .filter((issue) => issue && issue.fields && typeof issue.fields.summary === 'string')
      .map((issue) => ({
        id: issue.id,
        key: issue.key,
        summary: issue.fields!.summary as string,
        status: issue.fields!.status?.name ?? 'Unknown',
        assignee: issue.fields!.assignee?.displayName ?? null,
      }));
  }

  /**
   * Returns the UI automation workflow for creating a Jira ticket.
   * Used when API access is unavailable or for demo purposes with Nova Act.
   */
  getUIWorkflow(action: string): Array<{ action: string; target?: string; value?: string }> {
    switch (action) {
      case 'create_ticket':
        return [
          { action: 'navigate', target: this.config.baseUrl },
          { action: 'click', target: 'Create' },
          { action: 'wait', target: 'Create issue dialog' },
          { action: 'type', target: 'Summary', value: '' },
          { action: 'click', target: 'Create' },
        ];
      default:
        return [];
    }
  }
}
