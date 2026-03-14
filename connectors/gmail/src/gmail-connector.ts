import type { GmailConfig, EmailDraft } from './index.js';

interface GmailMimePart {
  mimeType: string;
  body: { data?: string };
  parts?: GmailMimePart[];
}

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

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailConnector {
  private config: GmailConfig;
  private cachedFromEmail: string | undefined;

  constructor(config: GmailConfig) {
    this.config = config;
    this.cachedFromEmail = config.fromEmail;
  }

  // ── OAuth2 token refresh ──────────────────────────────────────────────────
  private async getAccessToken(): Promise<string> {
    const response = await withRetry(() => fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }),
    }));

    const data = await response.json() as { access_token: string };
    return data.access_token;
  }

  private authHeader(token: string) {
    return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  }

  private async getFromEmail(token: string): Promise<string> {
    if (this.cachedFromEmail) return this.cachedFromEmail;
    const res = await fetch(`${GMAIL_BASE}/profile`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const profile = await res.json() as { emailAddress?: string };
      if (profile.emailAddress) {
        this.cachedFromEmail = profile.emailAddress;
        return profile.emailAddress;
      }
    }
    return 'me';
  }

  // ── users.messages.send ───────────────────────────────────────────────────
  // Scope: gmail.send
  async sendEmail(draft: EmailDraft): Promise<{ messageId: string }> {
    const token = await this.getAccessToken();
    const from = await this.getFromEmail(token);
    const rawMessage = this.buildRaw({
      from,
      to: draft.to.join(', '),
      subject: draft.subject,
      body: draft.body,
      cc: draft.cc,
      bcc: draft.bcc,
    });

    const response = await withRetry(() => fetch(`${GMAIL_BASE}/messages/send`, {
      method: 'POST',
      headers: this.authHeader(token),
      body: JSON.stringify({ raw: rawMessage }),
      signal: AbortSignal.timeout(30_000),
    }));

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Gmail send error: ${response.status} ${errBody}`);
    }
    const data = await response.json() as { id: string };
    return { messageId: data.id };
  }

  // ── users.messages.list + metadata fetch ─────────────────────────────────
  // Scope: gmail.readonly
  async searchEmails(params: { query: string; maxResults?: number }): Promise<Array<{
    id: string;
    threadId: string;
    subject: string;
    from: string;
    snippet: string;
  }>> {
    const token = await this.getAccessToken();
    const url = new URL(`${GMAIL_BASE}/messages`);
    url.searchParams.set('q', params.query);
    url.searchParams.set('maxResults', String(params.maxResults ?? 10));

    const listRes = await withRetry(() => fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    }));
    if (!listRes.ok) throw new Error(`Gmail list error: ${listRes.status}`);
    const listData = await listRes.json() as { messages?: Array<{ id: string; threadId: string }> };
    const messages = listData.messages ?? [];

    const results = await Promise.all(messages.map(async (m) => {
      const msgRes = await fetch(
        `${GMAIL_BASE}/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
        { headers: { 'Authorization': `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) }
      );
      if (!msgRes.ok) return { id: m.id, threadId: m.threadId, subject: '', from: '', snippet: '' };
      const msgData = await msgRes.json() as {
        snippet?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };
      const hdrs = msgData.payload?.headers ?? [];
      return {
        id: m.id,
        threadId: m.threadId,
        snippet: msgData.snippet ?? '',
        subject: hdrs.find(h => h.name === 'Subject')?.value ?? '',
        from: hdrs.find(h => h.name === 'From')?.value ?? '',
      };
    }));

    return results;
  }

  // ── users.messages.get ────────────────────────────────────────────────────
  // Scope: gmail.readonly
  async readEmail(params: { messageId: string }): Promise<{ subject: string; from: string; body: string }> {
    const token = await this.getAccessToken();
    const response = await withRetry(() => fetch(`${GMAIL_BASE}/messages/${params.messageId}?format=full`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`Gmail read error: ${response.status}`);
    const data = await response.json() as {
      payload?: {
        headers?: Array<{ name: string; value: string }>;
        parts?: GmailMimePart[];
        body?: { data?: string };
      };
    };

    const hdrs = data.payload?.headers ?? [];
    const subject = hdrs.find(h => h.name === 'Subject')?.value ?? '';
    const from = hdrs.find(h => h.name === 'From')?.value ?? '';

    // Extract body (try to find text/plain part)
    let bodyData = data.payload?.body?.data;
    if (!bodyData && data.payload?.parts) {
      const getPlainText = (parts: GmailMimePart[]): string | undefined => {
        for (const p of parts) {
          if (p.mimeType === 'text/plain' && p.body?.data) return p.body.data;
          if (p.parts) {
            const nested = getPlainText(p.parts);
            if (nested) return nested;
          }
        }
        return undefined;
      };
      
      bodyData = getPlainText(data.payload.parts) || data.payload.parts[0]?.body?.data;
    }

    const body = bodyData ? Buffer.from(bodyData, 'base64url').toString('utf8') : '';
    return { subject, from, body };
  }

  // ── users.messages.send (reply — same endpoint, with threadId + RFC headers)
  // Scope: gmail.send
  async replyToEmail(params: {
    threadId: string;
    inReplyToMessageId: string;
    to: string;
    subject: string;
    body: string;
    cc?: string[];
  }): Promise<{ messageId: string }> {
    const subject = params.subject.trimStart().toLowerCase().startsWith('re:')
      ? params.subject
      : `Re: ${params.subject}`;
    const token = await this.getAccessToken();
    const from = await this.getFromEmail(token);
    const raw = this.buildRaw({
      from,
      to: params.to,
      subject,
      body: params.body,
      cc: params.cc,
      extraHeaders: [
        `In-Reply-To: ${params.inReplyToMessageId}`,
        `References: ${params.inReplyToMessageId}`,
      ],
    });
    const response = await withRetry(() => fetch(`${GMAIL_BASE}/messages/send`, {
      method: 'POST',
      headers: this.authHeader(token),
      body: JSON.stringify({ raw, threadId: params.threadId }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`Gmail reply error: ${response.status} ${errBody}`);
    }
    const data = await response.json() as { id: string };
    return { messageId: data.id };
  }

  // ── users.messages.batchModify ────────────────────────────────────────────
  // Scope: gmail.modify
  async modifyLabels(params: {
    messageIds: string[];
    addLabels?: string[];
    removeLabels?: string[];
  }): Promise<void> {
    const token = await this.getAccessToken();
    const response = await withRetry(() => fetch(`${GMAIL_BASE}/messages/batchModify`, {
      method: 'POST',
      headers: this.authHeader(token),
      body: JSON.stringify({
        ids: params.messageIds,
        addLabelIds: params.addLabels ?? [],
        removeLabelIds: params.removeLabels ?? [],
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`Gmail batchModify error: ${response.status}`);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private buildRaw(opts: {
    from: string;
    to: string;
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
    extraHeaders?: string[];
  }): string {
    const lines = [
      'MIME-Version: 1.0',
      `From: ${opts.from}`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      ...(opts.cc?.length ? [`Cc: ${opts.cc.join(', ')}`] : []),
      ...(opts.bcc?.length ? [`Bcc: ${opts.bcc.join(', ')}`] : []),
      ...(opts.extraHeaders ?? []),
    ];
    return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${opts.body}`).toString('base64url');
  }
}
