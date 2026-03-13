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
      emit({ phase: 'chat', message: planResult.chatResponse ?? '' });
      return {
        sessionId: request.sessionId,
        taskGraph: { nodes: [], createdAt: Date.now() },
        status: 'completed',
        results: [],
        message: planResult.chatResponse ?? '',
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

    return {
      sessionId: request.sessionId,
      taskGraph,
      status: allSucceeded ? 'completed' : 'failed',
      results,
      message: summaryMessage,
    };
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

    const command = new ConverseCommand({
      modelId: this.config.novaLiteModelId,
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
   * Special-case Jira search so voice/text callers get an actual ticket summary.
   */
  private buildSummaryMessage(results: TaskResult[], allSucceeded: boolean): string {
    // Look for successful execution results from jira_search
    const jiraSearchOutputs = results
      .filter(
        (r) =>
          r.status === 'success' &&
          r.agentType === 'execution' &&
          r.output &&
          (r.output as any).action === 'jira_search' &&
          Array.isArray((r.output as any).results)
      )
      .map((r) => (r.output as any).results as Array<{
        key?: string;
        summary?: string;
        status?: string;
      }>);

    const jiraTickets = jiraSearchOutputs.flat().filter(Boolean);

    if (jiraTickets.length > 0) {
      const count = jiraTickets.length;
      const header =
        count === 1
          ? 'I found 1 Jira ticket:'
          : `I found ${count} Jira tickets:`;

      const lines = jiraTickets.slice(0, 5).map((t) => {
        const key = t.key ?? '(no key)';
        const status = t.status ?? 'Unknown';
        const summary = t.summary ?? '(no summary)';
        return `- ${key} [${status}] — ${summary}`;
      });

      const remainder =
        count > 5 ? `\n…and ${count - 5} more.` : '';

      return `${header}\n${lines.join('\n')}${remainder}`;
    }

    // Fallback generic messages
    if (allSucceeded) {
      return 'All tasks completed successfully.';
    }
    return 'Some tasks failed. Check results for details.';
  }
}
