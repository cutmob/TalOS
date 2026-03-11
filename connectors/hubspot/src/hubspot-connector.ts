import type { HubSpotConfig, HubSpotContact, HubSpotCampaign } from './index.js';

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

export class HubSpotConnector {
  private config: HubSpotConfig;
  private baseUrl = 'https://api.hubapi.com';

  constructor(config: HubSpotConfig) {
    this.config = config;
  }

  async createContact(contact: HubSpotContact): Promise<{ id: string }> {
    const response = await withRetry(() => fetch(`${this.baseUrl}/crm/v3/objects/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          email: contact.email,
          firstname: contact.firstName,
          lastname: contact.lastName,
          company: contact.company,
        },
      }),
    }));

    if (!response.ok) throw new Error(`HubSpot API error: ${response.status}`);
    const data = await response.json() as { id: string };
    return { id: data.id };
  }

  async searchContacts(query: string): Promise<HubSpotContact[]> {
    const response = await withRetry(() => fetch(`${this.baseUrl}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        limit: 20,
        properties: ['email', 'firstname', 'lastname', 'company'],
      }),
    }));

    if (!response.ok) throw new Error(`HubSpot search error: ${response.status}`);
    const data = await response.json() as { results: Array<{ properties: Record<string, string> }> };
    return data.results.map((r) => ({
      email: r.properties.email ?? '',
      firstName: r.properties.firstname ?? '',
      lastName: r.properties.lastname ?? '',
      company: r.properties.company,
    }));
  }

  getUIWorkflow(action: string): Array<{ action: string; target?: string; value?: string }> {
    switch (action) {
      case 'create_campaign':
        return [
          { action: 'navigate', target: 'https://app.hubspot.com/marketing' },
          { action: 'click', target: 'Create campaign' },
          { action: 'type', target: 'Campaign name', value: '' },
          { action: 'click', target: 'Create' },
        ];
      default:
        return [];
    }
  }
}
