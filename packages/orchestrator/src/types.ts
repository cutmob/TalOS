import type { TaskGraph } from '@talos/task-graph';
import type { AgentType } from '@talos/agent-runtime';

export interface OrchestratorConfig {
  bedrockRegion: string;
  novaLiteModelId: string;
  jiraProjectKey: string;
  maxConcurrentAgents: number;
  taskTimeout: number;
  retryLimit: number;
}

export interface ProgressEvent {
  phase: 'planning' | 'executing' | 'node_complete' | 'completed' | 'failed' | 'chat';
  message: string;
  nodeId?: string;
  action?: string;
  agentType?: string;
  status?: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface OrchestratorRequest {
  sessionId: string;
  userId: string;
  input: string;
  /** Routing hint from voice gateway — speeds up planner by pre-identifying the target tool */
  targetApp?: 'jira' | 'slack' | 'gmail' | 'hubspot' | 'notion' | 'browser';
  context?: SessionContext;
  onProgress?: ProgressCallback;
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
  targetApp?: string;
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
