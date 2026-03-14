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
  private pendingPrompts: Map<string, string> = new Map();

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
      };
    }

    // Clear pending prompt on successful task graph planning
    this.pendingPrompts.delete(request.sessionId);

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
        maxTokens: 4096,
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
    } catch (error: any) {
      console.error(`[Orchestrator] Bedrock Planning Error:`, error);
      throw error;
    }
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
        const title = out.title as string | undefined;
        const content = out.content as string | undefined;
        if (!title && !content) {
          messages.push('Notion page retrieved but no content found.');
          continue;
        }
        const snippet = content ? this.cleanSnippet(content, 300) : '(empty page)';
        messages.push(`Notion page${title ? ` "${title}"` : ''}:\n${snippet}`);
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

        const lines = items.slice(0, 3).map((k, idx) => {
          const title = k.title || `Result ${idx + 1}`;
          const source = k.source ? String(k.source) : undefined;
          const kind = k.objectType;
          const snippet = k.text ? ` — ${this.cleanSnippet(k.text, 180)}` : '';
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
        const id = out.id as string | undefined;
        messages.push(`HubSpot contact created${id ? ` (id: ${id})` : ''}.`);
        continue;
      }
      if (action === 'hubspot_update_contact') {
        messages.push('HubSpot contact updated.');
        continue;
      }
      if (action === 'hubspot_create_deal') {
        const id = out.id as string | undefined;
        messages.push(`HubSpot deal created${id ? ` (id: ${id})` : ''}.`);
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
