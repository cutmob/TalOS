import type { JiraConfig, JiraTicket, JiraSearchResult } from './types.js';

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === retries - 1) throw err;
      const retryable = err instanceof Error && (
        err.message.includes('429') || err.message.includes('5')
      );
      if (!retryable) throw err;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
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
    const response = await withRetry(() => fetch(
      `${this.config.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=20`,
      { headers: { 'Authorization': `Basic ${this.authHeader}` } }
    ));

    if (!response.ok) throw new Error(`Jira search error: ${response.status}`);

    const data = await response.json() as { issues: Array<{ id: string; key: string; fields: { summary: string; status: { name: string }; assignee: { displayName: string } | null } }> };
    return data.issues.map((issue) => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      assignee: issue.fields.assignee?.displayName ?? null,
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
