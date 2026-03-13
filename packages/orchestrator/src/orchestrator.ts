import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { TaskGraph, TaskNode } from '@talos/task-graph';
import { TaskGraphBuilder } from '@talos/task-graph';
import type { Agent } from '@talos/agent-runtime';
import { AgentPool } from '@talos/agent-runtime';
import type {
  OrchestratorConfig,
  OrchestratorRequest,
  OrchestratorResponse,
  TaskResult,
  PlanningPrompt,
} from './types.js';
import { buildPlanningPrompt, buildSystemPrompt, parsePlanResponse, type PlanResult } from './planner.js';

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

    // Phase 1: Plan — use Nova 2 Lite to understand the request
    emit({ phase: 'planning', message: 'Understanding request...' });
    const planResult = await this.plan(request);

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
      };
    }

    const taskGraph = planResult.taskGraph!;
    this.activeTasks.set(request.sessionId, taskGraph);
    emit({ phase: 'planning', message: `Planned ${taskGraph.nodes.length} task${taskGraph.nodes.length === 1 ? '' : 's'}` });

    // Phase 2: Execute — delegate tasks to specialist agents
    const results = await this.execute(taskGraph, request.sessionId, emit);

    // Phase 3: Aggregate — collect results and build response
    this.activeTasks.delete(request.sessionId);

    const allSucceeded = results.every((r) => r.status === 'success');

    const summaryMessage = this.buildSummaryMessage(results, allSucceeded);

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
   * Phase 1: Use Nova 2 Lite via Converse API to generate an executable task graph.
   *
   * Converse API is the AWS-recommended unified API for all Nova text models.
   * It provides a consistent interface across model providers and supports
   * system prompts, tool use, and structured output natively.
   */
  private async plan(request: OrchestratorRequest): Promise<PlanResult> {
    const userPrompt = buildPlanningPrompt({
      userRequest: request.input,
      availableTools: this.agentPool.getAvailableTools(),
      availableConnectors: this.agentPool.getAvailableConnectors(),
      workflowHistory: [],
      context: request.context,
      targetApp: request.targetApp,
    });

    // Build conversation history as alternating user/assistant turns
    const history = this.sessionHistory.get(request.sessionId) ?? [];
    const priorMessages = history.flatMap((turn) => ([
      { role: 'user' as const, content: [{ text: turn.userInput }] },
      { role: 'assistant' as const, content: [{ text: turn.assistantOutput }] },
    ]));

    const command = new ConverseCommand({
      modelId: this.config.novaLiteModelId,
      system: [{ text: buildSystemPrompt(this.config.jiraProjectKey) }],
      messages: [
        ...priorMessages,
        {
          role: 'user',
          content: [{ text: userPrompt }],
        },
      ],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.1,
        topP: 0.9,
      },
    });

    const response = await this.client.send(command);
    const planText = response.output?.message?.content?.[0]?.text ?? '';

    return parsePlanResponse(planText);
  }

  /**
   * Phase 2: Walk the task graph, delegate each node to the correct agent.
   * Respects dependency ordering — parallel where possible, sequential where required.
   */
  private async execute(graph: TaskGraph, sessionId: string, emit?: (e: import('./types.js').ProgressEvent) => void): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
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

      // Execute ready tasks in parallel (up to concurrency limit)
      const batchResults = await Promise.allSettled(
        ready.map((node) => this.executeNode(node, sessionId))
      );

      for (let i = 0; i < ready.length; i++) {
        const node = ready[i];
        const settled = batchResults[i];

        if (settled.status === 'fulfilled') {
          results.push(settled.value);
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
            // Attempt recovery
            const recovered = await this.attemptRecovery(node, settled.value, sessionId);
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

  private async executeNode(node: TaskNode, sessionId: string): Promise<TaskResult> {
    const startTime = Date.now();
    const agent = this.agentPool.getAgent(node.agentType);

    const output = await agent.execute({
      taskId: node.id,
      action: node.action,
      parameters: node.parameters,
      sessionId,
    });

    return {
      taskId: node.id,
      agentType: node.agentType,
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

  /**
   * Build a human-readable summary for the orchestrator response.
   * Handles all connector search actions with meaningful natural-language output.
   */
  private cleanSnippet(text: string, maxLen = 100): string {
    return text
      .replace(/[\u034F\u200B\u200C\u200D\uFEFF\u00AD]+/g, '') // invisible chars & soft hyphens
      .replace(/\s{2,}/g, ' ')                                   // collapse whitespace
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
        const items = (out.results as Array<{ key?: string; summary?: string; status?: string }>) ?? [];

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
        const lines = items.slice(0, 5).map(
          (t) => `- ${t.key ?? '?'} [${t.status ?? 'Unknown'}] — ${t.summary ?? '(no summary)'}`
        );
        const more = count > 5 ? `\n…and ${count - 5} more.` : '';
        messages.push(`${header} Here are the most relevant ones:\n${lines.join('\n')}${more}`);
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
        const items = (out.results as Array<{ id?: string; name?: string; stage?: string; amount?: number }>) ?? [];
        if (count === 0) {
          messages.push('No HubSpot deals found matching that search.');
          continue;
        }
        const header = count === 1 ? 'Found 1 deal.' : `Found ${count} deals.`;
        const lines = items.slice(0, 5).map((d) =>
          `- ${d.name ?? d.id ?? '?'}${d.stage ? ` [${d.stage}]` : ''}${d.amount != null ? ` — $${d.amount}` : ''}`
        );
        messages.push(`${header}\n${lines.join('\n')}${count > 5 ? `\n…and ${count - 5} more.` : ''}`);
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

      // ── Write/create/update actions — brief confirmation ─────────────────
      if (['jira_create_ticket', 'slack_send_message', 'slack_send_dm', 'gmail_send_email',
           'hubspot_create_contact', 'hubspot_create_deal', 'notion_create_page',
           'jira_update_ticket', 'hubspot_update_contact', 'hubspot_update_deal',
           'notion_update_page', 'notion_append_block', 'gmail_reply', 'gmail_modify_labels',
           'hubspot_log_activity', 'slack_reply_in_thread', 'slack_upload_file'].includes(action)) {
        // These are confirmed by status — don't add noise, let the generic success handle it
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
}
