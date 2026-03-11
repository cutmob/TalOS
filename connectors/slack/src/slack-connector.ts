import type { SlackConfig, SlackMessage } from './index.js';

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

export class SlackConnector {
  private config: SlackConfig;

  constructor(config: SlackConfig) {
    this.config = config;
  }

  async sendMessage(message: SlackMessage): Promise<{ ok: boolean; ts: string }> {
    const response = await withRetry(() => fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: message.channel,
        text: message.text,
        thread_ts: message.threadTs,
      }),
    }));

    const data = await response.json() as { ok: boolean; ts: string };
    if (!data.ok) throw new Error('Slack API error');
    return data;
  }

  async listChannels(): Promise<Array<{ id: string; name: string }>> {
    const response = await withRetry(() => fetch('https://slack.com/api/conversations.list?limit=100', {
      headers: { 'Authorization': `Bearer ${this.config.botToken}` },
    }));

    const data = await response.json() as { channels: Array<{ id: string; name: string }> };
    return data.channels.map((c) => ({ id: c.id, name: c.name }));
  }

  getUIWorkflow(action: string): Array<{ action: string; target?: string; value?: string }> {
    switch (action) {
      case 'send_message':
        return [
          { action: 'navigate', target: 'https://app.slack.com' },
          { action: 'click', target: 'channel_name' },
          { action: 'type', target: 'message_input', value: '' },
          { action: 'submit' },
        ];
      default:
        return [];
    }
  }
}
