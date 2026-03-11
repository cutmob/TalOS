export type AgentType = 'orchestrator' | 'research' | 'execution' | 'recovery';

export interface AgentTask {
  taskId: string;
  action: string;
  parameters: Record<string, unknown>;
  sessionId: string;
}

export interface AgentResult {
  taskId: string;
  success: boolean;
  output: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface Agent {
  type: AgentType;
  execute(task: AgentTask): Promise<unknown>;
  getCapabilities(): AgentCapability[];
}

export interface AgentCapability {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required: boolean }>;
}

export interface AgentPoolConfig {
  maxConcurrent: number;
  taskTimeout: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required: boolean }>;
}
