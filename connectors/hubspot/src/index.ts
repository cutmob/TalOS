export { HubSpotConnector } from './hubspot-connector.js';

export interface HubSpotConfig {
  apiKey: string;
}

export interface HubSpotContact {
  email: string;
  firstName: string;
  lastName: string;
  company?: string;
  phone?: string;
  jobTitle?: string;
}

export interface HubSpotDeal {
  name: string;
  amount?: number;
  stage?: string;
  pipeline?: string;
  closeDate?: string;
  contactId?: string;
}
