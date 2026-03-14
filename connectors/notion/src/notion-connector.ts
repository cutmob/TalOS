import type { NotionConfig, NotionPage } from './index.js';

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try { return await fn(); } catch (err) {
      if (attempt === retries - 1) throw err;
      const retryable = err instanceof Error && /(?:429|5\d\d)/.test(err.message);
      if (!retryable) throw err;
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 30_000)));
    }
  }
  throw new Error('unreachable');
}

const BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

export class NotionConnector {
  private config: NotionConfig;

  constructor(config: NotionConfig) {
    this.config = config;
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    };
  }

  private richText(content: string) {
    return [{ type: 'text', text: { content } }];
  }

  private paragraphBlock(content: string) {
    return {
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: this.richText(content) },
    };
  }

  // ── POST /v1/search ───────────────────────────────────────────────────────
  async search(query: string): Promise<Array<{ id: string; title: string; type: string; url?: string }>> {
    const response = await withRetry(() => fetch(`${BASE}/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query, page_size: 20 }),
    }));
    if (!response.ok) throw new Error(`Notion search error: ${response.status}`);
    const data = await response.json() as {
      results: Array<{
        id: string;
        object: string;
        url?: string;
        properties?: { title?: { title: Array<{ plain_text: string }> } };
        title?: Array<{ plain_text: string }>;
      }>;
    };
    return data.results.map((r) => ({
      id: r.id,
      type: r.object,
      url: r.url,
      title:
        r.properties?.title?.title?.[0]?.plain_text ??
        r.title?.[0]?.plain_text ??
        'Untitled',
    }));
  }

  // ── GET /v1/pages/{pageId}/markdown (2026-03-11+) ───────────────────────
  // Uses the markdown endpoint introduced in 2026 — much simpler than block API,
  // returns full nested content including child page text in one request.
  // Falls back to metadata-only if the endpoint returns 404 (older page types).
  async readPage(params: { pageId: string }): Promise<{ title: string; content: string; url: string }> {
    const [metaResponse, markdownResponse] = await Promise.all([
      withRetry(() => fetch(`${BASE}/pages/${params.pageId}`, {
        method: 'GET',
        headers: this.headers,
      })),
      withRetry(() => fetch(`${BASE}/pages/${params.pageId}/markdown`, {
        method: 'GET',
        headers: this.headers,
      })),
    ]);

    if (!metaResponse.ok) throw new Error(`Notion readPage (meta) error: ${metaResponse.status}`);

    const meta = await metaResponse.json() as {
      url?: string;
      properties?: Record<string, { type?: string; title?: Array<{ plain_text: string }> }>;
      title?: Array<{ plain_text: string }>;
    };

    const titleProp = meta.properties
      ? Object.values(meta.properties).find((p) => p.type === 'title')
      : undefined;
    const title =
      titleProp?.title?.[0]?.plain_text ??
      meta.title?.[0]?.plain_text ??
      'Untitled';

    let content = '';
    if (markdownResponse.ok) {
      const md = await markdownResponse.json() as { markdown?: string };
      content = (md.markdown ?? '').trim();
    } else {
      // Fallback: list child blocks for container pages
      const blocksRes = await withRetry(() => fetch(`${BASE}/blocks/${params.pageId}/children`, {
        method: 'GET',
        headers: this.headers,
      }));
      if (blocksRes.ok) {
        const blocksData = await blocksRes.json() as { results: Array<Record<string, unknown>> };
        content = blocksData.results.map(block => {
          const type = block.type as string;
          if (type === 'child_page') {
            const cp = block[type] as { title?: string };
            return cp.title ? `[Subpage: ${cp.title}]` : '';
          }
          const richText = (block[type] as Record<string, unknown>)?.rich_text;
          if (Array.isArray(richText)) {
            return richText.map((t: Record<string, unknown>) => t.plain_text as string).join('');
          }
          return '';
        }).filter(t => t.length > 0).join('\n\n');
      }
    }

    return {
      title,
      content,
      url: meta.url ?? `https://notion.so/${params.pageId.replace(/-/g, '')}`,
    };
  }

  // ── POST /v1/pages ────────────────────────────────────────────────────────
  async createPage(page: NotionPage): Promise<{ id: string; url: string }> {
    const response = await withRetry(() => fetch(`${BASE}/pages`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        parent: page.parentId
          ? { page_id: page.parentId }
          : { type: 'workspace', workspace: true },
        properties: {
          title: { title: this.richText(page.title) },
        },
        ...(page.content && {
          children: [this.paragraphBlock(page.content)],
        }),
      }),
    }));
    if (!response.ok) throw new Error(`Notion createPage error: ${response.status}`);
    const data = await response.json() as { id: string; url: string };
    return { id: data.id, url: data.url };
  }

  // ── PATCH /v1/pages/{pageId} ──────────────────────────────────────────────
  async updatePage(params: {
    pageId: string;
    title?: string;
    properties?: Record<string, unknown>;
    in_trash?: boolean;
  }): Promise<{ id: string; url: string }> {
    const properties: Record<string, unknown> = { ...params.properties };
    if (params.title) {
      properties.title = { title: this.richText(params.title) };
    }
    const body: Record<string, unknown> = {};
    if (Object.keys(properties).length > 0) body.properties = properties;
    if (params.in_trash !== undefined) body.in_trash = params.in_trash;

    const response = await withRetry(() => fetch(`${BASE}/pages/${params.pageId}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    }));
    if (!response.ok) throw new Error(`Notion updatePage error: ${response.status}`);
    const data = await response.json() as { id: string; url: string };
    return { id: data.id, url: data.url };
  }

  // ── PATCH /v1/blocks/{blockId}/children ───────────────────────────────────
  async appendBlock(params: { blockId: string; content: string }): Promise<{ id: string }> {
    const response = await withRetry(() => fetch(`${BASE}/blocks/${params.blockId}/children`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({
        children: [this.paragraphBlock(params.content)],
      }),
    }));
    if (!response.ok) throw new Error(`Notion appendBlock error: ${response.status}`);
    const data = await response.json() as { results: Array<{ id: string }> };
    return { id: data.results[0]?.id ?? params.blockId };
  }
}
