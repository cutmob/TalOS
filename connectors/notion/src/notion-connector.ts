import type { NotionConfig, NotionPage } from './index.js';

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

export class NotionConnector {
  private config: NotionConfig;
  private baseUrl = 'https://api.notion.com/v1';

  constructor(config: NotionConfig) {
    this.config = config;
  }

  async createPage(page: NotionPage): Promise<{ id: string; url: string }> {
    const response = await withRetry(() => fetch(`${this.baseUrl}/pages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: page.parentId
          ? { page_id: page.parentId }
          : { type: 'workspace', workspace: true },
        properties: {
          title: { title: [{ text: { content: page.title } }] },
        },
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ text: { content: page.content } }],
            },
          },
        ],
      }),
    }));

    if (!response.ok) throw new Error(`Notion API error: ${response.status}`);
    const data = await response.json() as { id: string; url: string };
    return { id: data.id, url: data.url };
  }

  async search(query: string): Promise<Array<{ id: string; title: string }>> {
    const response = await withRetry(() => fetch(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, page_size: 10 }),
    }));

    if (!response.ok) throw new Error(`Notion search error: ${response.status}`);
    const data = await response.json() as { results: Array<{ id: string; properties: { title?: { title: Array<{ plain_text: string }> } } }> };
    return data.results.map((r) => ({
      id: r.id,
      title: r.properties.title?.title?.[0]?.plain_text ?? 'Untitled',
    }));
  }
}
