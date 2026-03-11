export { GmailConnector } from './gmail-connector.js';

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface EmailDraft {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}
