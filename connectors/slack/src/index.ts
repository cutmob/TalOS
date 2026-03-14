export { SlackConnector } from './slack-connector.js';

export interface SlackConfig {
  botToken: string;
  signingSecret: string;
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<{ type: string; text?: { type: string; text: string }; url?: string; action_id?: string }>;
  fields?: Array<{ type: string; text: string }>;
  accessory?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SlackMessage {
  channel: string;
  text: string;
  blocks?: SlackBlock[];
  threadTs?: string;
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
}
