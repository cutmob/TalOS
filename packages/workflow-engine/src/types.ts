export interface WorkflowStep {
  action: string;
  target?: string;
  selector?: string;
  value?: string;
  waitFor?: string;
  timeout?: number;
  metadata?: Record<string, unknown>;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  connector: string;
  steps: WorkflowStep[];
  tags: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Pre-computed Nova embedding of name + description + tags for semantic search. */
  embedding?: number[];
}

export interface WorkflowMatch {
  workflow: Workflow;
  score: number;
}

export interface WorkflowStore {
  save(workflow: Workflow): Promise<void>;
  get(id: string): Promise<Workflow | null>;
  /** Pass queryEmbedding to enable cosine-similarity ranking; falls back to keyword. */
  search(query: string, queryEmbedding?: number[]): Promise<WorkflowMatch[]>;
  listByConnector(connector: string): Promise<Workflow[]>;
  delete(id: string): Promise<void>;
  update(id: string, updates: Partial<Workflow>): Promise<void>;
}
