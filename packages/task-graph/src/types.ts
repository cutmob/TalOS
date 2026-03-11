import type { AgentType } from '@talos/agent-runtime';

export interface TaskNode {
  id: string;
  action: string;
  agentType: AgentType;
  parameters: Record<string, unknown>;
  dependencies: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskGraph {
  nodes: TaskNode[];
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface TaskNodeInput {
  action: string;
  agentType?: AgentType;
  parameters?: Record<string, unknown>;
  dependencies?: string[];
  metadata?: Record<string, unknown>;
}
