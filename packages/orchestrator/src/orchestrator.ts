import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { TaskGraph, TaskNode } from '@talos/task-graph';
import { AgentPool } from '@talos/agent-runtime';
import type {
  OrchestratorConfig,
  OrchestratorRequest,
  OrchestratorResponse,
  TaskResult,
  ApprovalSettings,
  PendingApproval,
  ApprovalPreviewNode,
} from './types.js';
import { buildPlanningPrompt, buildSystemPrompt, parsePlanResponse, type PlanResult } from './planner.js';
import { classifyAction } from './action-classifier.js';

/**
 * Central orchestrator that receives user requests, plans task graphs,
 * delegates to specialist agents, and aggregates results.
 *
 * Follows the Orchestrator-Subagent pattern:
 * - Only the orchestrator makes planning decisions
 * - Specialist agents execute domain-specific tasks
 * - Agents are stateless; state lives in the orchestrator
 *
 * Uses Amazon Bedrock Converse API (recommended by AWS for all Nova text models).
 * Ref: https://docs.aws.amazon.com/nova/latest/userguide/using-converse-api.html
 */
export class Orchestrator {
  private client: BedrockRuntimeClient;
  private agentPool: AgentPool;
  private config: OrchestratorConfig;
  private activeTasks: Map<string, TaskGraph> = new Map();
  private sessionHistory: Map<string, Array<{ userInput: string; assistantOutput: string }>> = new Map();
  private pendingPrompts: Map<string, string> = new Map();
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  private approvalSettings: ApprovalSettings = {
    defaultLevel: 'write_approval',
    connectorOverrides: {},
  };

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.client = new BedrockRuntimeClient({ region: config.bedrockRegion });
    this.agentPool = new AgentPool({
      maxConcurrent: config.maxConcurrentAgents,
      taskTimeout: config.taskTimeout,
    });
  }

  /**
   * Main entry point: receive a user request, plan, execute, return results.
   */
  async handleRequest(request: OrchestratorRequest): Promise<OrchestratorResponse> {
    const emit = request.onProgress ?? (() => {});
    let effectiveInput = request.input;

    // Phase 0: Continuity — check if we are answering a pending clarification
    const pending = this.pendingPrompts.get(request.sessionId);
    if (pending) {
      // Intelligently merge the original intent with the new answer.
      effectiveInput = `[Original Context: ${pending}]\nUser Answer: ${request.input}`;
    }

    // Phase 1: Plan — use Nova Pro to reason about and decompose the request
    emit({ phase: 'planning', message: 'Understanding request...' });
    const planResult = await this.plan({ ...request, input: effectiveInput });

    // Chat responses skip task execution entirely
    if (planResult.type === 'chat') {
      const chatResponse = planResult.chatResponse ?? '';
      emit({ phase: 'chat', message: chatResponse });
      this.appendHistory(request.sessionId, request.input, chatResponse);
      return {
        sessionId: request.sessionId,
        taskGraph: { nodes: [], createdAt: Date.now() },
        status: 'completed',
        results: [],
        message: chatResponse,
        voiceMessage: this.buildVoiceMessage(chatResponse),
      };
    }

    // Clarification — model needs one more piece of info before planning can complete.
    if (planResult.type === 'clarify') {
      const question = planResult.clarifyQuestion ?? 'Could you provide more details?';
      emit({ phase: 'clarification', message: question });

      // Record the ORIGINAL input (or the already-effective input)
      this.pendingPrompts.set(request.sessionId, pending ? pending : request.input);

      // Record user input and the clarifying question in history so follow-up works
      this.appendHistory(request.sessionId, request.input, question);
      return {
        sessionId: request.sessionId,
        taskGraph: { nodes: [], createdAt: Date.now() },
        status: 'clarification',
        results: [],
        message: question,
        voiceMessage: question,
      };
    }

    // Clear pending prompt on successful task graph planning
    this.pendingPrompts.delete(request.sessionId);

    const taskGraph = planResult.taskGraph!;
    this.activeTasks.set(request.sessionId, taskGraph);
    emit({ phase: 'planning', message: `Planned ${taskGraph.nodes.length} task${taskGraph.nodes.length === 1 ? '' : 's'}` });

    // Phase 1.5: Approval gate — check if any write actions need human approval
    const approvalCheck = this.checkApprovalRequired(taskGraph, request);
    if (approvalCheck) {
      this.pendingApprovals.set(approvalCheck.approvalId, approvalCheck);
      const previewMessage = this.buildApprovalPreview(approvalCheck);
      emit({ phase: 'pending_approval', message: previewMessage });
      this.appendHistory(request.sessionId, request.input, previewMessage);
      return {
        sessionId: request.sessionId,
        taskGraph,
        status: 'pending_approval',
        results: [],
        message: previewMessage,
        voiceMessage: this.buildVoiceMessage(previewMessage),
        approval: approvalCheck,
      };
    }

    // Phase 2: Execute — delegate tasks to specialist agents
    const results = await this.execute(taskGraph, request.sessionId, emit);

    // Phase 3: Aggregate — collect results and build response
    this.activeTasks.delete(request.sessionId);

    const allSucceeded = results.every((r) => r.status === 'success');

    const summaryMessage = this.buildSummaryMessage(results, allSucceeded);
    const voiceMessage = this.buildVoiceMessage(summaryMessage, results);

    emit({
      phase: allSucceeded ? 'completed' : 'failed',
      message: summaryMessage,
    });

    this.appendHistory(request.sessionId, request.input, summaryMessage);

    return {
      sessionId: request.sessionId,
      taskGraph,
      status: allSucceeded ? 'completed' : 'failed',
      results,
      message: summaryMessage,
      voiceMessage,
    };
  }

  private appendHistory(sessionId: string, userInput: string, assistantOutput: string): void {
    const turns = this.sessionHistory.get(sessionId) ?? [];
    turns.push({ userInput, assistantOutput });
    // Keep last 10 turns to stay within token limits
    if (turns.length > 10) turns.splice(0, turns.length - 10);
    this.sessionHistory.set(sessionId, turns);
  }

  /**
   * Phase 1: Use Nova 2 Pro via Converse API to generate an executable task graph.
   *
   * Nova 2 Pro is the flagship reasoning model — best for complex multi-step
   * planning, agentic coding, and long-range task decomposition.
   *
   * Converse API is the AWS-recommended unified API for all Nova text models.
   * It provides a consistent interface across model providers and supports
   * system prompts, tool use, and structured output natively.
   */
  private async plan(request: OrchestratorRequest): Promise<PlanResult> {
    const history = this.sessionHistory.get(request.sessionId) ?? [];
    const formattedHistory = history.flatMap((turn) => ([
      { role: 'user' as const, content: turn.userInput },
      { role: 'assistant' as const, content: turn.assistantOutput },
    ]));

    const userPrompt = buildPlanningPrompt({
      userRequest: request.input,
      availableTools: this.agentPool.getAvailableTools(),
      availableConnectors: this.agentPool.getAvailableConnectors(),
      workflowHistory: [],
      history: formattedHistory,
      context: request.context,
      targetApp: request.targetApp,
    });
    const command = new ConverseCommand({
      modelId: this.config.novaProModelId,
      system: [{ text: buildSystemPrompt(this.config.jiraProjectKey) }],
      messages: [
        {
          role: 'user',
          content: [{ text: userPrompt }],
        },
      ],
      inferenceConfig: {
        maxTokens: 8192,
        temperature: 0.1,
        topP: 0.9,
      },
    });

    console.log(`[Orchestrator] Planning with model: ${this.config.novaProModelId}`);
    try {
      const response = await this.client.send(command);
      console.log(`[Orchestrator] Bedrock response status: ${response.$metadata.httpStatusCode}`);
      const planText = response.output?.message?.content?.[0]?.text ?? '';
      return parsePlanResponse(planText);
    } catch (error: unknown) {
      console.error(`[Orchestrator] Bedrock Planning Error:`, error);
      throw error;
    }
  }

  /**
   * Phase 2: Walk the task graph, delegate each node to the correct agent.
   * Respects dependency ordering — parallel where possible, sequential where required.
   */
  /**
   * Resolve dependency outputs into a node's parameters.
   * When a node depends on prior steps, inject their results as `_deps`
   * so the execution agent can use them (e.g. contact email from step_1).
   * Also resolves {{step_N.field}} template references in string parameters.
   */
  private resolveDepParams(node: import('@talos/task-graph').TaskNode, resultMap: Map<string, TaskResult>): Record<string, unknown> {
    const params = { ...node.parameters };

    // Collect outputs from all dependency nodes
    if (node.dependencies.length > 0) {
      const deps: Record<string, unknown> = {};
      for (const depId of node.dependencies) {
        const depResult = resultMap.get(depId);
        if (depResult?.output) deps[depId] = depResult.output;
      }
      if (Object.keys(deps).length > 0) params._deps = deps;
    }

    // Resolve {{step_N.field}} templates in string parameter values
    const templateRe = /\{\{(\w+)\.(\w+)\}\}/g;
    for (const [key, val] of Object.entries(params)) {
      if (typeof val === 'string' && val.includes('{{')) {
        params[key] = val.replace(templateRe, (_match, stepId: string, field: string) => {
          const dep = resultMap.get(stepId);
          if (!dep?.output || typeof dep.output !== 'object') return _match;
          const out = dep.output as Record<string, unknown>;
          // Direct field access (e.g. {{step_1.email}})
          if (out[field] !== undefined) return String(out[field]);
          // Nested in first result of an array (e.g. contacts[0].email)
          if (Array.isArray(out.contacts) && out.contacts.length > 0 && out.contacts[0][field]) {
            return String(out.contacts[0][field]);
          }
          if (Array.isArray(out.results) && out.results.length > 0 && out.results[0][field]) {
            return String(out.results[0][field]);
          }
          return _match;
        });
      }
      // Handle array values with templates (e.g. to: ["{{step_1.email}}"])
      if (Array.isArray(val)) {
        params[key] = val.map((item) => {
          if (typeof item !== 'string' || !item.includes('{{')) return item;
          return item.replace(templateRe, (_match, stepId: string, field: string) => {
            const dep = resultMap.get(stepId);
            if (!dep?.output || typeof dep.output !== 'object') return _match;
            const out = dep.output as Record<string, unknown>;
            if (out[field] !== undefined) return String(out[field]);
            if (Array.isArray(out.contacts) && out.contacts.length > 0 && out.contacts[0][field]) {
              return String(out.contacts[0][field]);
            }
            if (Array.isArray(out.results) && out.results.length > 0 && out.results[0][field]) {
              return String(out.results[0][field]);
            }
            return _match;
          });
        });
      }
    }

    return params;
  }

  private async execute(graph: TaskGraph, sessionId: string, emit?: (e: import('./types.js').ProgressEvent) => void): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    const resultMap = new Map<string, TaskResult>();
    const completed = new Set<string>();
    const progress = emit ?? (() => {});

    // Topological execution: process nodes whose dependencies are all met
    while (completed.size < graph.nodes.length) {
      const ready = graph.nodes.filter(
        (node) =>
          !completed.has(node.id) &&
          node.dependencies.every((dep) => completed.has(dep))
      );

      if (ready.length === 0) {
        throw new Error('Deadlock detected in task graph — circular dependency.');
      }

      // Emit progress for each node about to execute
      for (const node of ready) {
        progress({
          phase: 'executing',
          message: `Executing: ${node.action}`,
          nodeId: node.id,
          action: node.action,
          agentType: node.agentType,
        });
      }

      // Execute ready tasks in parallel — resolve dependency outputs into parameters
      const batchResults = await Promise.allSettled(
        ready.map((node) => this.executeNode(node, sessionId, resultMap))
      );

      for (let i = 0; i < ready.length; i++) {
        const node = ready[i];
        const settled = batchResults[i];

        if (settled.status === 'fulfilled') {
          results.push(settled.value);
          resultMap.set(node.id, settled.value);
          progress({
            phase: 'node_complete',
            message: `${node.action} — ${settled.value.status}`,
            nodeId: node.id,
            action: node.action,
            agentType: node.agentType,
            status: settled.value.status,
          });
          if (settled.value.status === 'success') {
            completed.add(node.id);
          } else {
            // Attempt recovery — emit progress so the dashboard lights up the recovery dot
            progress({
              phase: 'executing',
              message: `Recovering: ${node.action}`,
              nodeId: node.id,
              action: 'recover',
              agentType: 'recovery',
            });
            const recovered = await this.attemptRecovery(node, settled.value, sessionId);
            progress({
              phase: 'node_complete',
              message: `Recovery ${recovered.status}: ${node.action}`,
              nodeId: node.id,
              action: 'recover',
              agentType: 'recovery',
              status: recovered.status,
            });
            results.push(recovered);
            if (recovered.status === 'success') {
              completed.add(node.id);
            } else {
              // Mark downstream tasks as failed
              this.markDownstreamFailed(graph, node.id, results);
              completed.add(node.id);
              for (const n of graph.nodes) {
                if (this.isDependentOn(graph, n.id, node.id)) {
                  completed.add(n.id);
                }
              }
            }
          }
        } else {
          const errorResult: TaskResult = {
            taskId: node.id,
            agentType: node.agentType,
            status: 'failure',
            output: null,
            duration: 0,
            error: settled.reason?.message ?? 'Unknown error',
          };
          results.push(errorResult);
          completed.add(node.id);
        }
      }
    }

    return results;
  }

  private async executeNode(node: TaskNode, sessionId: string, resultMap?: Map<string, TaskResult>): Promise<TaskResult> {
    const startTime = Date.now();
    const agent = this.agentPool.getAgent(node.agentType);

    // Resolve dependency outputs into parameters (template refs + _deps context)
    const resolvedParams = resultMap && node.dependencies.length > 0
      ? this.resolveDepParams(node, resultMap)
      : node.parameters;

    const output = await agent.execute({
      taskId: node.id,
      action: node.action,
      parameters: resolvedParams,
      sessionId,
    });

    return {
      taskId: node.id,
      agentType: node.agentType,
      action: node.action,
      status: 'success',
      output,
      duration: Date.now() - startTime,
    };
  }

  private async attemptRecovery(
    node: TaskNode,
    failedResult: TaskResult,
    sessionId: string
  ): Promise<TaskResult> {
    if (!this.agentPool.hasAgent('recovery')) {
      return { ...failedResult, error: 'No recovery agent registered' };
    }
    const recoveryAgent = this.agentPool.getAgent('recovery');
    const startTime = Date.now();

    try {
      const output = await recoveryAgent.execute({
        taskId: `recovery-${node.id}`,
        action: 'recover',
        parameters: {
          originalTask: node,
          error: failedResult.error,
          failedOutput: failedResult.output,
        },
        sessionId,
      });

      return {
        taskId: node.id,
        agentType: 'recovery',
        status: 'success',
        output,
        duration: Date.now() - startTime,
      };
    } catch {
      return {
        taskId: node.id,
        agentType: 'recovery',
        status: 'failure',
        output: null,
        duration: Date.now() - startTime,
        error: 'Recovery failed',
      };
    }
  }

  private markDownstreamFailed(graph: TaskGraph, failedNodeId: string, results: TaskResult[]): void {
    for (const node of graph.nodes) {
      if (node.dependencies.includes(failedNodeId)) {
        results.push({
          taskId: node.id,
          agentType: node.agentType,
          status: 'failure',
          output: null,
          duration: 0,
          error: `Skipped: upstream task ${failedNodeId} failed`,
        });
      }
    }
  }

  private isDependentOn(graph: TaskGraph, nodeId: string, ancestorId: string): boolean {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return false;
    if (node.dependencies.includes(ancestorId)) return true;
    return node.dependencies.some((dep) => this.isDependentOn(graph, dep, ancestorId));
  }

  getAgentPool(): AgentPool {
    return this.agentPool;
  }

  getActiveTaskCount(): number {
    return this.activeTasks.size;
  }

  // ── Approval gate ──────────────────────────────────────────────────────────

  getApprovalSettings(): ApprovalSettings {
    return { ...this.approvalSettings };
  }

  updateApprovalSettings(settings: Partial<ApprovalSettings>): ApprovalSettings {
    if (settings.defaultLevel) this.approvalSettings.defaultLevel = settings.defaultLevel;
    if (settings.connectorOverrides) {
      this.approvalSettings.connectorOverrides = {
        ...this.approvalSettings.connectorOverrides,
        ...settings.connectorOverrides,
      };
    }
    return this.getApprovalSettings();
  }

  getPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()];
  }

  getPendingApproval(approvalId: string): PendingApproval | undefined {
    return this.pendingApprovals.get(approvalId);
  }

  /**
   * Approve a pending task graph — execute it.
   */
  async approveTask(approvalId: string, onProgress?: (e: import('./types.js').ProgressEvent) => void): Promise<OrchestratorResponse> {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error(`No pending approval found: ${approvalId}`);
    }
    this.pendingApprovals.delete(approvalId);

    const emit = onProgress ?? (() => {});
    const { taskGraph, sessionId } = pending;

    this.activeTasks.set(sessionId, taskGraph);
    emit({ phase: 'executing', message: 'Approved — executing tasks...' });

    const results = await this.execute(taskGraph, sessionId, emit);
    this.activeTasks.delete(sessionId);

    const allSucceeded = results.every((r) => r.status === 'success');
    const summaryMessage = this.buildSummaryMessage(results, allSucceeded);
    const voiceMessage = this.buildVoiceMessage(summaryMessage, results);

    emit({ phase: allSucceeded ? 'completed' : 'failed', message: summaryMessage });
    this.appendHistory(sessionId, pending.originalInput, summaryMessage);

    return {
      sessionId,
      taskGraph,
      status: allSucceeded ? 'completed' : 'failed',
      results,
      message: summaryMessage,
      voiceMessage,
    };
  }

  /**
   * Reject a pending task graph — discard it.
   */
  rejectTask(approvalId: string): OrchestratorResponse {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      throw new Error(`No pending approval found: ${approvalId}`);
    }
    this.pendingApprovals.delete(approvalId);

    const message = 'Action cancelled — no changes were made.';
    this.appendHistory(pending.sessionId, pending.originalInput, message);

    return {
      sessionId: pending.sessionId,
      taskGraph: pending.taskGraph,
      status: 'completed',
      results: [],
      message,
      voiceMessage: message,
    };
  }

  /**
   * Check if any nodes in the task graph require approval based on current autonomy settings.
   * Returns a PendingApproval if approval is needed, or null if execution can proceed.
   */
  private checkApprovalRequired(taskGraph: TaskGraph, request: OrchestratorRequest): PendingApproval | null {
    const writeNodes: ApprovalPreviewNode[] = [];
    const readNodes: ApprovalPreviewNode[] = [];

    for (const node of taskGraph.nodes) {
      const category = classifyAction(node.action);
      const preview: ApprovalPreviewNode = {
        nodeId: node.id,
        action: node.action,
        category,
        description: this.describeAction(node),
        parameters: node.parameters,
      };

      if (category === 'write') writeNodes.push(preview);
      else readNodes.push(preview);
    }

    // No write actions → no approval needed regardless of settings
    if (writeNodes.length === 0 && this.approvalSettings.defaultLevel !== 'all_approval') {
      return null;
    }

    // Check if approval is required for any of the actions
    const needsApproval = this.approvalSettings.defaultLevel === 'all_approval'
      || (this.approvalSettings.defaultLevel === 'write_approval' && writeNodes.length > 0)
      || writeNodes.some((w) => {
        const connector = this.actionToConnector(w.action);
        const override = connector ? this.approvalSettings.connectorOverrides[connector] : undefined;
        const level = override ?? this.approvalSettings.defaultLevel;
        return level === 'write_approval' || level === 'all_approval';
      });

    // Full autonomy and no per-connector overrides require approval → skip
    if (!needsApproval) return null;

    return {
      approvalId: `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: request.sessionId,
      userId: request.userId,
      createdAt: Date.now(),
      taskGraph,
      writeActions: writeNodes,
      readActions: readNodes,
      originalInput: request.input,
      request,
    };
  }

  /**
   * Build a human-readable preview of what actions are pending approval.
   */
  private buildApprovalPreview(pending: PendingApproval): string {
    const lines: string[] = ['**Approval required** — the following actions need your confirmation:\n'];

    for (const w of pending.writeActions) {
      lines.push(`- **${this.formatActionName(w.action)}**: ${w.description}`);
    }

    if (pending.readActions.length > 0) {
      lines.push(`\n_Also planned (auto-approved):_ ${pending.readActions.map((r) => this.formatActionName(r.action)).join(', ')}`);
    }

    lines.push(`\nApproval ID: \`${pending.approvalId}\``);
    return lines.join('\n');
  }

  /**
   * Generate a human-readable description of what a task node will do.
   */
  private describeAction(node: TaskNode): string {
    const p = node.parameters;
    switch (node.action) {
      case 'gmail_send_email': {
        const to = (p.to as string[])?.join(', ') ?? 'recipient';
        const subj = p.subject ? `\n  Subject: ${p.subject}` : '';
        const body = p.body ? `\n  Body: ${(p.body as string).slice(0, 200)}${(p.body as string).length > 200 ? '…' : ''}` : '';
        return `Send email to ${to}${subj}${body}`;
      }
      case 'gmail_reply': {
        const subj = p.subject ? `\n  Subject: ${p.subject}` : '';
        const body = p.body ? `\n  Body: ${(p.body as string).slice(0, 200)}${(p.body as string).length > 200 ? '…' : ''}` : '';
        return `Reply to email thread${subj}${body}`;
      }
      case 'gmail_modify_labels':
        return `Modify labels on ${(p.messageIds as string[])?.length ?? 0} email(s)`;
      case 'slack_send_message': {
        const text = p.text as string | undefined;
        return `Send message to #${p.channel ?? 'channel'}${text ? `\n  Message: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}` : ''}`;
      }
      case 'slack_send_dm': {
        const text = p.message as string | undefined;
        return `Send DM to user ${p.userId ?? 'unknown'}${text ? `\n  Message: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}` : ''}`;
      }
      case 'slack_reply_in_thread': {
        const text = p.message as string | undefined;
        return `Reply in thread in #${p.channel ?? 'channel'}${text ? `\n  Message: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}` : ''}`;
      }
      case 'slack_add_reaction':
        return `Add :${p.emoji ?? 'emoji'}: reaction`;
      case 'slack_upload_file':
        return `Upload file "${p.filename ?? 'file'}" to #${p.channel ?? 'channel'}`;
      case 'jira_create_ticket': {
        const desc = p.description ? `\n  Description: ${(p.description as string).slice(0, 200)}${(p.description as string).length > 200 ? '…' : ''}` : '';
        return `Create Jira ticket${p.summary ? `: "${p.summary}"` : ''}${p.priority ? ` [${p.priority}]` : ''}${desc}`;
      }
      case 'jira_update_ticket':
        return `Update Jira ticket${p.key ? ` ${p.key}` : ''}`;
      case 'hubspot_create_contact':
        return `Create HubSpot contact${p.firstName || p.lastName ? `: ${[p.firstName, p.lastName].filter(Boolean).join(' ')}` : ''}${p.email ? ` (${p.email})` : ''}`;
      case 'hubspot_update_contact':
        return `Update HubSpot contact`;
      case 'hubspot_create_deal':
        return `Create HubSpot deal${p.name ? `: "${p.name}"` : ''}${p.amount ? ` — $${p.amount}` : ''}`;
      case 'hubspot_update_deal':
        return `Update HubSpot deal`;
      case 'hubspot_log_activity': {
        const note = p.note as string | undefined;
        return `Log activity in HubSpot${note ? `\n  Note: ${note.slice(0, 200)}${note.length > 200 ? '…' : ''}` : ''}`;
      }
      case 'notion_create_page':
        return `Create Notion page${p.title ? `: "${p.title}"` : ''}`;
      case 'notion_update_page':
        return `Update Notion page`;
      case 'notion_append_block': {
        const content = p.content as string | undefined;
        return `Append to Notion page${content ? `\n  Content: ${content.slice(0, 200)}${content.length > 200 ? '…' : ''}` : ''}`;
      }
      default:
        return `Execute ${this.formatActionName(node.action)}`;
    }
  }

  /** Map an action string to its connector name for autonomy override lookup. */
  private actionToConnector(action: string): 'jira' | 'slack' | 'gmail' | 'hubspot' | 'notion' | 'browser' | null {
    if (action.startsWith('jira_')) return 'jira';
    if (action.startsWith('slack_')) return 'slack';
    if (action.startsWith('gmail_')) return 'gmail';
    if (action.startsWith('hubspot_')) return 'hubspot';
    if (action.startsWith('notion_')) return 'notion';
    if (['open_app', 'navigate', 'click', 'type', 'select', 'submit', 'extract', 'screenshot', 'wait'].includes(action)) return 'browser';
    return null;
  }

  /** Format an action string into a readable label: "slack_send_message" → "Slack Send Message". */
  private formatActionName(action: string): string {
    return action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Build a human-readable summary for the orchestrator response.
   * Handles all connector search actions with meaningful natural-language output.
   */
  private cleanSnippet(text: string, maxLen = 100): string {
    return text
      // eslint-disable-next-line no-misleading-character-class
      .replace(/[\u034F\u200B\u200C\u200D\uFEFF\u00AD]+/g, '') // invisible chars & soft hyphens
      .replace(/<@[A-Z0-9]+>/g, '@user')                        // Slack user mentions <@U123>
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')                // Slack channel mentions <#C123|name>
      .replace(/!\[.*?\]\(.*?\)/g, '[image]')                   // markdown images
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')                  // markdown links → label only
      .replace(/^#{1,6}\s+/gm, '')                              // markdown headings
      .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, '$1')     // bold/italic/code spans
      .replace(/^\s*[-*+]\s+/gm, '')                            // markdown list bullets
      .replace(/<[^>]+>/g, ' ')                                 // strip HTML/XML tags (e.g. Notion <page> elements)
      .replace(/\s{2,}/g, ' ')                                  // collapse whitespace
      .trim()
      .slice(0, maxLen);
  }

  private buildSummaryMessage(results: TaskResult[], allSucceeded: boolean): string {
    const succeeded = results.filter(
      (r) => r.status === 'success' && r.agentType === 'execution' && r.output
    );

    const messages: string[] = [];

    for (const r of succeeded) {
      const out = r.output as Record<string, unknown>;
      const action = out.action as string | undefined;
      if (!action) continue;

      // ── Jira search ──────────────────────────────────────────────────────
      if (action === 'jira_search') {
        const count = out.count as number ?? 0;
        const items = (out.results as Array<{ key?: string; summary?: string; status?: string; assignee?: string | null; priority?: string; description?: string; labels?: string[] }>) ?? [];

        if (count === 0) {
          const fallback = out.allResults as Array<{ key?: string; summary?: string; status?: string }> | undefined;
          if (fallback && fallback.length > 0) {
            const byStatus = new Map<string, string[]>();
            for (const t of fallback) {
              const s = t.status ?? 'Unknown';
              if (!byStatus.has(s)) byStatus.set(s, []);
              byStatus.get(s)!.push(t.key ?? '?');
            }
            const breakdown = [...byStatus.entries()]
              .map(([s, keys]) => `${keys.length} ${s} (${keys.slice(0, 4).join(', ')}${keys.length > 4 ? '…' : ''})`)
              .join(', ');
            messages.push(`No open tickets — none in progress or to do. Found ${fallback.length} ticket${fallback.length === 1 ? '' : 's'} total: ${breakdown}.`);
          } else {
            messages.push('No Jira tickets found matching that filter.');
          }
          continue;
        }

        const header = count === 1 ? 'Found 1 Jira ticket.' : `Found ${count} Jira tickets.`;
        const lines = items.slice(0, 5).map((t) => {
          const meta: string[] = [`[${t.status ?? 'Unknown'}]`];
          if (t.priority) meta.push(t.priority);
          if (t.assignee) meta.push(`→ ${t.assignee}`);
          const descSnippet = t.description ? ` — ${this.cleanSnippet(t.description, 80)}` : '';
          return `- ${t.key ?? '?'} ${meta.join(' ')} ${t.summary ?? '(no summary)'}${descSnippet}`;
        });
        const more = count > 5 ? `\n…and ${count - 5} more.` : '';
        messages.push(`${header}\n${lines.join('\n')}${more}`);
        continue;
      }

      // ── Gmail search ─────────────────────────────────────────────────────
      if (action === 'gmail_search') {
        const count = out.count as number ?? 0;
        const items = (out.results as Array<{ subject?: string; from?: string; snippet?: string }>) ?? [];
        if (count === 0) {
          messages.push('No emails found matching that search.');
          continue;
        }
        const header = count === 1 ? 'Found 1 email.' : `Found ${count} emails.`;
        const lines = items.slice(0, 5).map(
          (e) => `- "${e.subject ?? '(no subject)'}" from ${e.from ?? 'unknown'}${e.snippet ? ` — ${this.cleanSnippet(e.snippet)}` : ''}`
        );
        const more = count > 5 ? `\n…and ${count - 5} more.` : '';
        messages.push(`${header}\n${lines.join('\n')}${more}`);
        continue;
      }

      // ── HubSpot contacts search ───────────────────────────────────────────
      if (action === 'hubspot_search_contacts') {
        const count = out.count as number ?? 0;
        const items = (out.results as Array<{ id?: string; firstName?: string; lastName?: string; email?: string; company?: string }>) ?? [];
        if (count === 0) {
          messages.push('No HubSpot contacts found matching that search.');
          continue;
        }
        const header = count === 1 ? 'Found 1 contact.' : `Found ${count} contacts.`;
        const lines = items.slice(0, 5).map((c) => {
          const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.id || '?';
          return `- ${name}${c.company ? ` (${c.company})` : ''}${c.email ? ` <${c.email}>` : ''}`;
        });
        messages.push(`${header}\n${lines.join('\n')}${count > 5 ? `\n…and ${count - 5} more.` : ''}`);
        continue;
      }

      // ── HubSpot deals search ──────────────────────────────────────────────
      if (action === 'hubspot_search_deals') {
        const count = out.count as number ?? 0;
        const items = (out.results as Array<{ id?: string; name?: string; stage?: string; amount?: string | number; pipeline?: string; closeDate?: string }>) ?? [];
        if (count === 0) {
          messages.push('No HubSpot deals found matching that search.');
          continue;
        }
        const header = count === 1 ? 'Found 1 deal.' : `Found ${count} deals.`;
        const lines = items.slice(0, 5).map((d) => {
          const parts = [`- ${d.name ?? d.id ?? '?'}`];
          if (d.stage) parts.push(`[${d.stage}]`);
          if (d.amount != null && d.amount !== '') parts.push(`$${d.amount}`);
          if (d.closeDate) parts.push(`closes ${d.closeDate.slice(0, 10)}`);
          return parts.join(' — ');
        });
        messages.push(`${header}\n${lines.join('\n')}${count > 5 ? `\n…and ${count - 5} more.` : ''}`);
        continue;
      }

      // ── Gmail read email ──────────────────────────────────────────────────
      if (action === 'gmail_read_email') {
        const subject = out.subject as string | undefined;
        const from = out.from as string | undefined;
        const body = out.body as string | undefined;
        if (!subject && !body) {
          messages.push('Email retrieved but no content found.');
          continue;
        }
        const snippet = body ? this.cleanSnippet(body, 200) : '(no body)';
        messages.push(`Email${subject ? ` "${subject}"` : ''}${from ? ` from ${from}` : ''}:\n${snippet}`);
        continue;
      }

      // ── Notion read page ──────────────────────────────────────────────────
      if (action === 'notion_read_page') {
        if (out.status === 'not_found') {
          const q = out.error as string | undefined;
          const query = q?.match(/query: "([^"]+)"/)?.[1];
          messages.push(`No Notion page found${query ? ` matching "${query}"` : ''}.`);
          continue;
        }
        const title = out.title as string | undefined;
        const content = out.content as string | undefined;
        // For page content, preserve markdown formatting — just strip invisible chars
        // and truncate generously so the full summary comes through.
        const cleanContent = content
          // eslint-disable-next-line no-misleading-character-class
          ? content.replace(/[\u034F\u200B\u200C\u200D\uFEFF\u00AD]+/g, '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 3000)
          : '';
        if (!title && !cleanContent) {
          messages.push('That Notion page appears to be empty.');
          continue;
        }
        messages.push(`${title ? `**${title}**\n` : ''}${cleanContent || '(no text content)'}`);
        continue;
      }

      // ── Notion search ─────────────────────────────────────────────────────
      if (action === 'notion_search') {
        const count = out.count as number ?? 0;
        const items = (out.results as Array<{ id?: string; title?: string; url?: string }>) ?? [];
        if (count === 0) {
          messages.push('No Notion pages found matching that search.');
          continue;
        }
        const header = count === 1 ? 'Found 1 Notion page.' : `Found ${count} Notion pages.`;
        const lines = items.slice(0, 5).map((p) => `- ${p.title ?? p.id ?? '(untitled)'}`);
        messages.push(`${header}\n${lines.join('\n')}${count > 5 ? `\n…and ${count - 5} more.` : ''}`);
        continue;
      }

      // ── Slack read messages ───────────────────────────────────────────────
      if (action === 'slack_read_messages') {
        const msgs = (out.messages as Array<{ text?: string; user?: string; ts?: string; bot_id?: string }>) ?? [];
        // Filter out bot messages and system noise to give purely user-relevant summaries
        const filtered = msgs.filter(m => !m.bot_id && !m.text?.toLowerCase().includes('checking for messages'));
        const count = filtered.length;

        // Clean up channel name (remove # prefix if it exists in the tool output)
        const channelId = out.channel as string ?? 'channel';
        const channelName = out.channelName as string | undefined;
        const cleanChannel = channelName || (channelId.startsWith('#') ? channelId.slice(1) : channelId);

        if (count === 0) {
          messages.push(`No messages found in the ${cleanChannel} channel.`);
          continue;
        }
        const header = `Found ${count} message${count === 1 ? '' : 's'} in the ${cleanChannel} channel.`;
        const lines = filtered.slice(0, 5).map((m) =>
          `- ${m.user ? `<@${m.user}>` : 'user'}: ${this.cleanSnippet(m.text ?? '', 120)}`
        );
        const more = count > 5 ? `\n…and ${count - 5} more.` : '';
        messages.push(`${header}\n${lines.join('\n')}${more}`);
        continue;
      }

      // ── Slack list channels ───────────────────────────────────────────────
      if (action === 'slack_list_channels') {
        const channels = (out.channels as Array<{ name?: string; id?: string }>) ?? [];
        if (channels.length === 0) {
          messages.push('No Slack channels found.');
          continue;
        }
        const names = channels.slice(0, 8).map((c) => `#${c.name ?? c.id}`).join(', ');
        const more = channels.length > 8 ? ` and ${channels.length - 8} more` : '';
        messages.push(`Found ${channels.length} Slack channel${channels.length === 1 ? '' : 's'}: ${names}${more}.`);
        continue;
      }

      // ── Knowledge search (cross-tool semantic index) ─────────────────────
      if (action === 'knowledge_search') {
        const items = (out.results as Array<{
          title?: string;
          text?: string;
          source?: string;
          objectType?: string;
          url?: string;
        }>) ?? [];
        const count = (out.count as number) ?? items.length;

        if (count === 0 || items.length === 0) {
          messages.push('I could not find any documents or records matching that description.');
          continue;
        }

        const header = count === 1
          ? 'Found 1 relevant document.'
          : `Found ${count} relevant documents.`;

        const lines = items.slice(0, 6).map((k, idx) => {
          const title = k.title || `Result ${idx + 1}`;
          const source = k.source ? String(k.source) : undefined;
          const kind = k.objectType;
          const snippet = k.text ? ` — ${this.cleanSnippet(k.text, 300)}` : '';
          const sourceTag = [source, kind].filter(Boolean).join(' · ');
          return `- ${title}${sourceTag ? ` (${sourceTag})` : ''}${snippet}`;
        });

        const more = count > 3 ? `\n…and ${count - 3} more in the index.` : '';
        messages.push(`${header}\n${lines.join('\n')}${more}`);
        continue;
      }

      // ── Write/create/update confirmations ────────────────────────────────
      if (action === 'jira_create_ticket') {
        const key = out.key as string | undefined;
        const url = out.url as string | undefined;
        messages.push(`Created Jira ticket${key ? ` ${key}` : ''}${url ? ` — ${url}` : ''}.`);
        continue;
      }
      if (action === 'jira_update_ticket') {
        const updated = (out.updated as string[]) ?? [];
        const total = (out.keys as string[])?.length ?? updated.length;
        if (updated.length === 0) {
          messages.push('No Jira tickets were updated (no matching transition found).');
        } else {
          messages.push(`Updated ${updated.length} of ${total} Jira ticket${total === 1 ? '' : 's'}: ${updated.slice(0, 6).join(', ')}${updated.length > 6 ? '…' : ''}.`);
        }
        continue;
      }
      if (action === 'slack_send_message' || action === 'slack_reply_in_thread') {
        const channel = out.channel as string | undefined;
        messages.push(`Message sent${channel ? ` to #${channel}` : ''}.`);
        continue;
      }
      if (action === 'slack_send_dm') {
        messages.push('Direct message sent.');
        continue;
      }
      if (action === 'slack_upload_file') {
        messages.push(`File uploaded to Slack.`);
        continue;
      }
      if (action === 'gmail_send_email' || action === 'gmail_reply') {
        messages.push('Email sent.');
        continue;
      }
      if (action === 'gmail_modify_labels') {
        const ids = (out.messageIds as string[]) ?? [];
        messages.push(`Labels updated on ${ids.length} email${ids.length === 1 ? '' : 's'}.`);
        continue;
      }
      if (action === 'hubspot_create_contact') {
        const firstName = out.firstName as string | undefined;
        const lastName = out.lastName as string | undefined;
        const name = [firstName, lastName].filter(Boolean).join(' ');
        messages.push(`HubSpot contact created${name ? ` for ${name}` : ''}.`);
        continue;
      }
      if (action === 'hubspot_update_contact') {
        messages.push('HubSpot contact updated.');
        continue;
      }
      if (action === 'hubspot_create_deal') {
        const dealName = out.name as string | undefined;
        messages.push(`HubSpot deal created${dealName ? `: "${dealName}"` : ''}.`);
        continue;
      }
      if (action === 'hubspot_update_deal') {
        messages.push('HubSpot deal updated.');
        continue;
      }
      if (action === 'hubspot_log_activity') {
        messages.push('Activity logged in HubSpot.');
        continue;
      }
      if (action === 'notion_create_page') {
        const url = out.url as string | undefined;
        messages.push(`Notion page created${url ? ` — ${url}` : ''}.`);
        continue;
      }
      if (action === 'notion_update_page') {
        messages.push('Notion page updated.');
        continue;
      }
      if (action === 'notion_append_block') {
        messages.push('Content appended to Notion page.');
        continue;
      }

      // ── HubSpot generic object search ─────────────────────────────────────
      if (action === 'hubspot_search_objects') {
        const objectType = (out.objectType as string | undefined) ?? 'records';
        const count = (out.count as number) ?? 0;
        const items = (out.results as Array<{ name?: string; email?: string; id?: string }>) ?? [];
        if (count === 0) {
          messages.push(`No HubSpot ${objectType} found matching that search.`);
          continue;
        }
        const names = items.slice(0, 5).map((i) => i.name || i.email || i.id || '?').join(', ');
        messages.push(`Found ${count} HubSpot ${objectType}: ${names}${count > 5 ? `, and ${count - 5} more` : ''}.`);
        continue;
      }

      // ── HubSpot list properties ───────────────────────────────────────────
      if (action === 'hubspot_list_properties') {
        const objectType = (out.objectType as string | undefined) ?? 'object';
        const props = (out.properties as Array<{ name?: string; label?: string }>) ?? [];
        if (props.length === 0) {
          messages.push(`No properties found for HubSpot ${objectType}.`);
          continue;
        }
        const names = props.slice(0, 8).map((p) => p.label || p.name || '?').join(', ');
        messages.push(`HubSpot ${objectType} has ${props.length} properties including: ${names}${props.length > 8 ? '…' : ''}.`);
        continue;
      }
    }

    if (messages.length > 0) {
      return messages.join('\n\n');
    }

    // Generic success/fail for write/action tasks
    if (allSucceeded) {
      return 'Done. All tasks completed successfully.';
    }
    return 'Some tasks failed. Check the task history for details.';
  }

  /**
   * Build a voice-optimized summary for Nova Sonic.
   * Rules: plain text only (no markdown), ≤3 spoken sentences,
   * lists capped at 2 items, page content trimmed to a brief oral summary.
   *
   * Builds voice messages directly from structured results rather than
   * stripping markdown from the text summary — avoids awkward spoken output
   * like "PROJ dash 142 bracket Done bracket".
   */
  private buildVoiceMessage(fullMessage: string, results?: TaskResult[]): string {
    // If we have structured results, build voice output directly from data
    if (results && results.length > 0) {
      const voiceParts: string[] = [];

      for (const r of results) {
        if (r.status !== 'success' || r.agentType !== 'execution' || !r.output) continue;
        const out = r.output as Record<string, unknown>;
        const action = out.action as string | undefined;
        if (!action) continue;

        // ── Search results: count + top 2 items spoken naturally ──
        if (action === 'jira_search') {
          const count = out.count as number ?? 0;
          const items = (out.results as Array<{ key?: string; summary?: string; status?: string }>) ?? [];
          if (count === 0) { voiceParts.push('No Jira tickets found.'); continue; }
          const top = items.slice(0, 2).map(t => `${t.key}, ${t.summary}`).join('. ');
          voiceParts.push(`Found ${count} Jira ticket${count === 1 ? '' : 's'}. ${top}${count > 2 ? `. And ${count - 2} more.` : '.'}`);
        } else if (action === 'gmail_search') {
          const count = out.count as number ?? 0;
          const items = (out.results as Array<{ subject?: string; from?: string }>) ?? [];
          if (count === 0) { voiceParts.push('No emails found.'); continue; }
          const top = items.slice(0, 2).map(e => `"${e.subject}" from ${e.from}`).join('. ');
          voiceParts.push(`Found ${count} email${count === 1 ? '' : 's'}. ${top}${count > 2 ? `. And ${count - 2} more.` : '.'}`);
        } else if (action === 'slack_read_messages') {
          const msgs = (out.messages as Array<{ text?: string }>) ?? [];
          const count = msgs.length;
          const channel = out.channelName as string ?? out.channel as string ?? 'that channel';
          if (count === 0) { voiceParts.push(`No messages in ${channel}.`); continue; }
          voiceParts.push(`Found ${count} message${count === 1 ? '' : 's'} in ${channel}.`);
        } else if (action === 'hubspot_search_deals') {
          const count = out.count as number ?? 0;
          const items = (out.results as Array<{ name?: string; stage?: string }>) ?? [];
          if (count === 0) { voiceParts.push('No deals found.'); continue; }
          const top = items.slice(0, 2).map(d => `${d.name}${d.stage ? `, ${d.stage}` : ''}`).join('. ');
          voiceParts.push(`Found ${count} deal${count === 1 ? '' : 's'}. ${top}.`);
        } else if (action === 'hubspot_search_contacts') {
          const count = out.count as number ?? 0;
          if (count === 0) { voiceParts.push('No contacts found.'); continue; }
          voiceParts.push(`Found ${count} HubSpot contact${count === 1 ? '' : 's'}.`);
        } else if (action === 'notion_search') {
          const count = out.count as number ?? 0;
          const items = (out.results as Array<{ title?: string }>) ?? [];
          if (count === 0) { voiceParts.push('No Notion pages found.'); continue; }
          const top = items.slice(0, 2).map(p => p.title).join(', ');
          voiceParts.push(`Found ${count} Notion page${count === 1 ? '' : 's'}: ${top}${count > 2 ? `, and ${count - 2} more` : ''}.`);
        } else if (action === 'notion_read_page') {
          if (out.status === 'not_found') { voiceParts.push('That Notion page was not found.'); continue; }
          const title = out.title as string | undefined;
          voiceParts.push(title ? `Here's the ${title} page. Want me to read through the details?` : 'Got the Notion page content. Want me to read through it?');
        } else if (action === 'knowledge_search') {
          const count = (out.count as number) ?? 0;
          if (count === 0) { voiceParts.push('I could not find any matching documents.'); continue; }
          voiceParts.push(`Found ${count} relevant document${count === 1 ? '' : 's'} across your tools.`);
        }
        // ── Write confirmations: short spoken confirmations ──
        else if (action === 'jira_create_ticket') {
          const key = out.key as string | undefined;
          voiceParts.push(`Done, created Jira ticket${key ? ` ${key}` : ''}.`);
        } else if (action === 'jira_update_ticket') {
          const updated = (out.updated as string[]) ?? [];
          voiceParts.push(updated.length > 0 ? `Updated ${updated.length} Jira ticket${updated.length === 1 ? '' : 's'}.` : 'No Jira tickets were updated.');
        } else if (action === 'slack_send_message' || action === 'slack_reply_in_thread') {
          voiceParts.push(`Message sent${out.channel ? ` to ${out.channel}` : ''}.`);
        } else if (action === 'gmail_send_email' || action === 'gmail_reply') {
          voiceParts.push('Email sent.');
        } else if (action === 'hubspot_create_deal') {
          voiceParts.push(`Deal created${out.name ? `: ${out.name}` : ''}.`);
        } else if (action === 'hubspot_log_activity') {
          voiceParts.push('Activity logged in HubSpot.');
        } else if (action === 'notion_create_page') {
          voiceParts.push('Notion page created.');
        } else if (action === 'gmail_search_contacts') {
          // Skip — intermediate step, not user-facing
          continue;
        } else {
          voiceParts.push(`${this.formatActionName(action)} complete.`);
        }
      }

      if (voiceParts.length > 0) {
        // Cap total voice output at 3 sentences
        const capped = voiceParts.slice(0, 3);
        return capped.join(' ');
      }
    }

    // Fallback: strip markdown from text summary
    const text = fullMessage
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/[*_`~]{1,3}([^*_`~\n]+)[*_`~]{1,3}/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (sentences.length <= 3) return sentences.join(' ');
    return sentences.slice(0, 2).join(' ') + ' Want me to continue?';
  }
}
