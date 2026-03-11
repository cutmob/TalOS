export { NotionConnector } from './notion-connector.js';

export interface NotionConfig {
  apiKey: string;
}

export interface NotionPage {
  title: string;
  content: string;
  parentId?: string;
}
