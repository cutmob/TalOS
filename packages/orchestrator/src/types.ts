import type { TaskGraph } from '@talos/task-graph';
import type { AgentType } from '@talos/agent-runtime';

export interface OrchestratorConfig {
  bedrockRegion: string;
  novaLiteModelId: string;
  maxConcurrentAgents: number;
  taskTimeout: number;
  retryLimit: number;
}

export interface OrchestratorRequest {
  sessionId: string;
  userId: string;
  input: string;
  context?: SessionContext;
}

export interface SessionContext {
  recentTasks: TaskResult[];
  activeWorkflows: string[];
  userPreferences: Record<string, unknown>;
}

export interface OrchestratorResponse {
  sessionId: string;
  taskGraph: TaskGraph;
  status: 'planning' | 'executing' | 'completed' | 'failed';
  results: TaskResult[];
  message: string;
}

export interface TaskResult {
  taskId: string;
  agentType: AgentType;
  status: 'success' | 'failure' | 'retry';
  output: unknown;
  duration: number;
  error?: string;
}

export interface PlanningPrompt {
  userRequest: string;
  availableTools: ToolDefinition[];
  availableConnectors: string[];
  workflowHistory: string[];
  context: SessionContext | undefined;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
}

export interface ToolParameter {
  type: string;
  description: string;
  required: boolean;
}
