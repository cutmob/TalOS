export { SlackConnector } from './slack-connector.js';

export interface SlackConfig {
  botToken: string;
  signingSecret: string;
}

export interface SlackMessage {
  channel: string;
  text: string;
  threadTs?: string;
}
