import type { GmailConfig, EmailDraft } from './index.js';

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

export class GmailConnector {
  private config: GmailConfig;

  constructor(config: GmailConfig) {
    this.config = config;
  }

  async sendEmail(draft: EmailDraft): Promise<{ messageId: string }> {
    const rawMessage = this.buildRawMessage(draft);
    const token = await this.getAccessToken();

    const response = await withRetry(() => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: rawMessage }),
    }));

    if (!response.ok) throw new Error(`Gmail API error: ${response.status}`);
    const data = await response.json() as { id: string };
    return { messageId: data.id };
  }

  private buildRawMessage(draft: EmailDraft): string {
    const headers = [
      `To: ${draft.to.join(', ')}`,
      `Subject: ${draft.subject}`,
      'Content-Type: text/plain; charset=utf-8',
    ];
    if (draft.cc?.length) headers.push(`Cc: ${draft.cc.join(', ')}`);

    const message = `${headers.join('\r\n')}\r\n\r\n${draft.body}`;
    return Buffer.from(message).toString('base64url');
  }

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

  getUIWorkflow(action: string): Array<{ action: string; target?: string; value?: string }> {
    switch (action) {
      case 'send_email':
        return [
          { action: 'navigate', target: 'https://mail.google.com' },
          { action: 'click', target: 'Compose' },
          { action: 'type', target: 'To', value: '' },
          { action: 'type', target: 'Subject', value: '' },
          { action: 'type', target: 'Body', value: '' },
          { action: 'click', target: 'Send' },
        ];
      default:
        return [];
    }
  }
}
