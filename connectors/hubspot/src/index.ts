export { HubSpotConnector } from './hubspot-connector.js';

export interface HubSpotConfig {
  apiKey: string;
}

export interface HubSpotContact {
  email: string;
  firstName: string;
  lastName: string;
  company?: string;
}

export interface HubSpotCampaign {
  name: string;
  subject: string;
  content: string;
}
