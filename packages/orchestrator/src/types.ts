import type { TaskGraph } from '@talos/task-graph';
import type { AgentType } from '@talos/agent-runtime';
import type { ActionCategory } from './action-classifier.js';

// ── Autonomy & Approval ──────────────────────────────────────────────────────

/** Controls when the system pauses for human approval before executing actions. */
export type AutonomyLevel = 'full' | 'write_approval' | 'all_approval';

/** Per-connector autonomy overrides. Missing keys fall back to the global default. */
export type ConnectorOverrides = Partial<Record<'jira' | 'slack' | 'gmail' | 'hubspot' | 'notion' | 'browser', AutonomyLevel>>;

export interface ApprovalSettings {
  /** Global default autonomy level. */
  defaultLevel: AutonomyLevel;
  /** Per-connector overrides — e.g. { gmail: 'write_approval', jira: 'full' }. */
  connectorOverrides: ConnectorOverrides;
}

/** A write action awaiting user approval. */
export interface ApprovalPreviewNode {
  nodeId: string;
  action: string;
  category: ActionCategory;
  /** Human-readable description of what this action will do. */
  description: string;
  parameters: Record<string, unknown>;
}

/** A task graph paused for approval before execution. */
export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  userId: string;
  createdAt: number;
  /** The full planned task graph. */
  taskGraph: TaskGraph;
  /** Human-readable preview of write actions that need approval. */
  writeActions: ApprovalPreviewNode[];
  /** Read actions that will auto-execute (shown for context). */
  readActions: ApprovalPreviewNode[];
  /** The original user input that triggered this request. */
  originalInput: string;
  /** Original request for re-submission after approval. */
  request: OrchestratorRequest;
}

// ── Core Config ──────────────────────────────────────────────────────────────

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
  phase: 'planning' | 'executing' | 'node_complete' | 'completed' | 'failed' | 'chat' | 'clarification' | 'pending_approval';
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
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'clarification' | 'pending_approval';
  results: TaskResult[];
  /** Full response — used by dashboard (supports markdown) */
  message: string;
  /** Voice-optimized response — plain text, ≤3 spoken sentences, sent to Nova Sonic */
  voiceMessage: string;
  /** Present when status is 'pending_approval' — details of what needs approval. */
  approval?: PendingApproval;
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
  action?: string;
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
