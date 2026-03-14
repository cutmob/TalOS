import type { SlackConfig, SlackMessage } from './index.js';

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

export class SlackConnector {
  private config: SlackConfig;

  constructor(config: SlackConfig) {
    this.config = config;
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.config.botToken}`,
      'Content-Type': 'application/json',
    };
  }

  // ── chat.postMessage ──────────────────────────────────────────────────────
  // Scope: chat:write
  async sendMessage(message: SlackMessage): Promise<{ ok: boolean; ts: string }> {
    const response = await withRetry(() => fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        channel: message.channel,
        text: message.text,
        ...(message.threadTs && { thread_ts: message.threadTs }),
      }),
      signal: AbortSignal.timeout(30_000),
    }));

    const data = await response.json() as { ok: boolean; ts: string; error?: string };
    if (!data.ok) throw new Error(`Slack API error: ${data.error ?? 'unknown'}`);
    return data;
  }

  // ── conversations.open + chat.postMessage (DM) ────────────────────────────
  // Scopes: im:write, chat:write
  async sendDm(params: { userId: string; message: string }): Promise<{ ok: boolean; ts: string; channel: string }> {
    const openRes = await withRetry(() => fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ users: params.userId }),
      signal: AbortSignal.timeout(30_000),
    }));
    const openData = await openRes.json() as { ok: boolean; channel?: { id: string }; error?: string };
    if (!openData.ok) throw new Error(`Slack conversations.open error: ${openData.error ?? 'unknown'}`);
    const channelId = openData.channel!.id;
    const result = await this.sendMessage({ channel: channelId, text: params.message });
    return { ...result, channel: channelId };
  }

  // ── chat.postMessage with thread_ts (reply in thread) ────────────────────
  // Scope: chat:write
  async replyInThread(params: { channel: string; threadTs: string; message: string }): Promise<{ ok: boolean; ts: string }> {
    return this.sendMessage({ channel: params.channel, text: params.message, threadTs: params.threadTs });
  }

  // ── reactions.add ─────────────────────────────────────────────────────────
  // Scope: reactions:write
  async addReaction(params: { channel: string; timestamp: string; emoji: string }): Promise<{ ok: boolean }> {
    const response = await withRetry(() => fetch('https://slack.com/api/reactions.add', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        name: params.emoji.replace(/:/g, ''),
        channel: params.channel,
        timestamp: params.timestamp,
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    const data = await response.json() as { ok: boolean; error?: string };
    if (!data.ok) throw new Error(`Slack reactions.add error: ${data.error ?? 'unknown'}`);
    return data;
  }

  // ── files.getUploadURLExternal → PUT → files.completeUploadExternal ───────
  // Scope: files:write  (2024+ upload API — replaces deprecated files.upload)
  async uploadFile(params: { channel: string; filename: string; content: string | Buffer }): Promise<{ fileId: string }> {
    const buffer = typeof params.content === 'string' ? Buffer.from(params.content) : params.content;

    // Step 1: get upload URL + file_id
    const urlRes = await withRetry(() => fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ filename: params.filename, length: buffer.length }),
      signal: AbortSignal.timeout(30_000),
    }));
    const urlData = await urlRes.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
    if (!urlData.ok) throw new Error(`Slack getUploadURLExternal error: ${urlData.error ?? 'unknown'}`);

    // Step 2: PUT file bytes directly to the pre-signed URL (no auth header needed)
    const putRes = await fetch(urlData.upload_url!, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
      signal: AbortSignal.timeout(60_000),
    });
    if (!putRes.ok) throw new Error(`Slack file PUT error: ${putRes.status}`);

    // Step 3: complete upload and share to channel
    const completeRes = await withRetry(() => fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title: params.filename }],
        channel_id: params.channel,
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    const completeData = await completeRes.json() as { ok: boolean; error?: string };
    if (!completeData.ok) throw new Error(`Slack completeUploadExternal error: ${completeData.error ?? 'unknown'}`);

    return { fileId: urlData.file_id! };
  }

  // ── conversations.history ───────────────────────────────────────────────────
  // Scope: channels:history
  async getChannelHistory(params: { channel: string; limit?: number }): Promise<Array<{ text: string; user: string; ts: string }>> {
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', params.channel);
    if (params.limit) url.searchParams.set('limit', String(params.limit));

    const response = await withRetry(() => fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${this.config.botToken}` }, // No Content-Type for GET
      signal: AbortSignal.timeout(30_000),
    }));

    const data = await response.json() as { ok: boolean; messages?: Array<{ text: string; user: string; ts: string }>; error?: string };
    if (!data.ok) throw new Error(`Slack conversations.history error: ${data.error ?? 'unknown'}`);
    return (data.messages ?? []).map((m) => ({ text: m.text ?? '', user: m.user ?? 'unknown', ts: m.ts }));
  }

  // ── conversations.list ────────────────────────────────────────────────────
  // Scope: channels:read
  async listChannels(): Promise<Array<{ id: string; name: string }>> {
    const response = await withRetry(() => fetch('https://slack.com/api/conversations.list?limit=200&exclude_archived=true', {
      headers: { 'Authorization': `Bearer ${this.config.botToken}` },
      signal: AbortSignal.timeout(30_000),
    }));

    const data = await response.json() as { ok: boolean; channels: Array<{ id: string; name: string }>; error?: string };
    if (!data.ok) throw new Error(`Slack conversations.list error: ${data.error ?? 'unknown'}`);
    return data.channels.map((c) => ({ id: c.id, name: c.name }));
  }
}
