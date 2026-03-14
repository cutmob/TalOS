import type { TaskGraph } from '@talos/task-graph';
import type { AgentType } from '@talos/agent-runtime';

export interface OrchestratorConfig {
  bedrockRegion: string;
  /** Nova 2 Pro — used by the Orchestrator/Planner for complex multi-step task graph reasoning */
  novaProModelId: string;
  jiraProjectKey: string;
  maxConcurrentAgents: number;
  taskTimeout: number;
  retryLimit: number;
}

export interface ProgressEvent {
  phase: 'planning' | 'executing' | 'node_complete' | 'completed' | 'failed' | 'chat' | 'clarification';
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
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'clarification';
  results: TaskResult[];
  message: string;
}

/**
 * Unified knowledge object used by the knowledge_search tool and any
 * downstream summarization. This allows the planner to resolve fuzzy,
 * natural-language references (e.g. "the product roadmap") to concrete
 * records from HubSpot, Notion, Jira, etc. without hard-coding per-app
 * field names in prompts.
 */
export interface KnowledgeObject {
  id: string;
  title: string;
  text: string;
  source: 'hubspot' | 'jira' | 'notion' | 'gmail' | 'slack' | 'custom';
  objectType: string;
  externalId?: string;
  url?: string;
  metadata?: Record<string, unknown>;
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
  history?: { role: 'user' | 'assistant'; content: string }[];
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
