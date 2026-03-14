import type { HubSpotConfig, HubSpotContact } from './index.js';

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

const BASE = 'https://api.hubapi.com';

export class HubSpotConnector {
  private config: HubSpotConfig;

  constructor(config: HubSpotConfig) {
    this.config = config;
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  // ── Contacts ─────────────────────────────────────────────────────────────

  // POST /crm/v3/objects/contacts
  async createContact(contact: HubSpotContact): Promise<{ id: string }> {
    const response = await withRetry(() => fetch(`${BASE}/crm/v3/objects/contacts`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        properties: {
          email: contact.email,
          firstname: contact.firstName,
          lastname: contact.lastName,
          ...(contact.company && { company: contact.company }),
          ...(contact.phone && { phone: contact.phone }),
          ...(contact.jobTitle && { jobtitle: contact.jobTitle }),
        },
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot createContact error: ${response.status}`);
    const data = await response.json() as { id: string };
    return { id: data.id };
  }

  // POST /crm/v3/objects/contacts/search
  async searchContacts(query: string): Promise<Array<HubSpotContact & { id: string }>> {
    const response = await withRetry(() => fetch(`${BASE}/crm/v3/objects/contacts/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        query,
        limit: 20,
        properties: ['email', 'firstname', 'lastname', 'company', 'phone', 'jobtitle'],
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot searchContacts error: ${response.status}`);
    const data = await response.json() as { results: Array<{ id: string; properties: Record<string, string> }> };
    return data.results.map((r) => ({
      id: r.id,
      email: r.properties.email ?? '',
      firstName: r.properties.firstname ?? '',
      lastName: r.properties.lastname ?? '',
      company: r.properties.company,
      phone: r.properties.phone,
      jobTitle: r.properties.jobtitle,
    }));
  }

  // PATCH /crm/v3/objects/contacts/{id}
  async updateContact(params: { id: string; fields: Partial<HubSpotContact> }): Promise<{ id: string }> {
    const props: Record<string, string> = {};
    if (params.fields.email) props.email = params.fields.email;
    if (params.fields.firstName) props.firstname = params.fields.firstName;
    if (params.fields.lastName) props.lastname = params.fields.lastName;
    if (params.fields.company) props.company = params.fields.company;
    if (params.fields.phone) props.phone = params.fields.phone;
    if (params.fields.jobTitle) props.jobtitle = params.fields.jobTitle;

    const response = await withRetry(() => fetch(`${BASE}/crm/v3/objects/contacts/${params.id}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({ properties: props }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot updateContact error: ${response.status}`);
    const data = await response.json() as { id: string };
    return { id: data.id };
  }

  // ── Deals ─────────────────────────────────────────────────────────────────

  // POST /crm/v3/objects/deals
  async createDeal(params: {
    name: string;
    amount?: number;
    stage?: string;
    pipeline?: string;
    closeDate?: string;
    contactId?: string;
  }): Promise<{ id: string }> {
    const response = await withRetry(() => fetch(`${BASE}/crm/v3/objects/deals`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        properties: {
          dealname: params.name,
          ...(params.amount !== undefined && { amount: String(params.amount) }),
          ...(params.stage && { dealstage: params.stage }),
          ...(params.pipeline && { pipeline: params.pipeline }),
          ...(params.closeDate && { closedate: params.closeDate }),
        },
        ...(params.contactId && {
          associations: [{
            to: { id: params.contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
          }],
        }),
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot createDeal error: ${response.status}`);
    const data = await response.json() as { id: string };
    return { id: data.id };
  }

  // POST /crm/v3/objects/deals/search
  async searchDeals(query: string): Promise<Array<{ id: string; name: string; stage: string; amount: string; pipeline: string; closeDate?: string }>> {
    const response = await withRetry(() => fetch(`${BASE}/crm/v3/objects/deals/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        query,
        limit: 20,
        properties: ['dealname', 'dealstage', 'amount', 'pipeline', 'closedate'],
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot searchDeals error: ${response.status}`);
    const data = await response.json() as { results: Array<{ id: string; properties: Record<string, string> }> };
    return data.results.map(r => ({
      id: r.id,
      name: r.properties.dealname ?? '',
      stage: r.properties.dealstage ?? '',
      amount: r.properties.amount ?? '',
      pipeline: r.properties.pipeline ?? '',
      closeDate: r.properties.closedate || undefined,
    }));
  }

  // PATCH /crm/v3/objects/deals/{id}
  async updateDeal(params: { id: string; fields: Record<string, string | number> }): Promise<{ id: string }> {
    const response = await withRetry(() => fetch(`${BASE}/crm/v3/objects/deals/${params.id}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify({
        properties: Object.fromEntries(
          Object.entries(params.fields).map(([k, v]) => [k, String(v)])
        ),
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot updateDeal error: ${response.status}`);
    const data = await response.json() as { id: string };
    return { id: data.id };
  }

  // ── Notes / Activity ──────────────────────────────────────────────────────

  // POST /crm/v3/objects/notes  (Scope: crm.objects.notes.write)
  async logActivity(params: {
    note: string;
    dealId?: string;
    contactId?: string;
  }): Promise<{ id: string }> {
    const associations: Array<{
      to: { id: string };
      types: Array<{ associationCategory: string; associationTypeId: number }>;
    }> = [];

    // HubSpot defined association type IDs: note→deal=214, note→contact=202
    if (params.dealId) {
      associations.push({ to: { id: params.dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] });
    }
    if (params.contactId) {
      associations.push({ to: { id: params.contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] });
    }

    const response = await withRetry(() => fetch(`${BASE}/crm/v3/objects/notes`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        properties: {
          hs_note_body: params.note,
          hs_timestamp: new Date().toISOString(),
        },
        ...(associations.length > 0 && { associations }),
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot logActivity error: ${response.status}`);
    const data = await response.json() as { id: string };
    return { id: data.id };
  }

  // ── Metadata / schema helpers ─────────────────────────────────────────────

  async listProperties(objectType: 'contacts' | 'deals'): Promise<Array<{
    name: string;
    label: string;
    description?: string;
    type: string;
    fieldType: string;
  }>> {
    const response = await withRetry(() => fetch(`${BASE}/crm/v3/properties/${objectType}`, {
      method: 'GET',
      headers: this.headers,
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot listProperties error: ${response.status}`);
    const data = await response.json() as { results: Array<{ name: string; label: string; description?: string; type: string; fieldType: string }> };
    return data.results.map((p) => ({
      name: p.name,
      label: p.label,
      description: p.description,
      type: p.type,
      fieldType: p.fieldType,
    }));
  }

  async searchObjects(params: {
    objectType: 'contacts' | 'deals';
    query: string;
    properties?: string[];
    limit?: number;
  }): Promise<Array<{ id: string; properties: Record<string, unknown> }>> {
    const { objectType, query, properties, limit = 20 } = params;
    const response = await withRetry(() => fetch(`${BASE}/crm/v3/objects/${objectType}/search`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        query,
        limit,
        ...(properties && properties.length > 0 ? { properties } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    }));
    if (!response.ok) throw new Error(`HubSpot searchObjects error: ${response.status}`);
    const data = await response.json() as { results: Array<{ id: string; properties: Record<string, unknown> }> };
    return data.results;
  }
}
