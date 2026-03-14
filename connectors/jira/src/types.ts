export interface JiraConfig {
  baseUrl: string;
  apiToken: string;
  email: string;
  projectKey: string;
}

export interface JiraTicket {
  summary: string;
  description?: string;
  issueType: 'Bug' | 'Task' | 'Story' | 'Epic';
  priority?: 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';
  assignee?: string;
  labels?: string[];
}

export interface JiraSearchResult {
  id: string;
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  priority?: string;
  description?: string;
  labels?: string[];
}
