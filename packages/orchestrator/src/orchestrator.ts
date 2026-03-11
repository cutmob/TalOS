import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { TaskGraph, TaskNode } from '@operon/task-graph';
import { TaskGraphBuilder } from '@operon/task-graph';
import type { Agent } from '@operon/agent-runtime';
import { AgentPool } from '@operon/agent-runtime';
import type {
  OrchestratorConfig,
  OrchestratorRequest,
  OrchestratorResponse,
  TaskResult,
  PlanningPrompt,
} from './types.js';
import { buildPlanningPrompt, PLANNING_SYSTEM_PROMPT, parsePlanResponse } from './planner.js';

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
    // Phase 1: Plan — use Nova 2 Lite to decompose request into task graph
    const taskGraph = await this.plan(request);
    this.activeTasks.set(request.sessionId, taskGraph);

    // Phase 2: Execute — delegate tasks to specialist agents
    const results = await this.execute(taskGraph, request.sessionId);

    // Phase 3: Aggregate — collect results and build response
    this.activeTasks.delete(request.sessionId);

    const allSucceeded = results.every((r) => r.status === 'success');

    return {
      sessionId: request.sessionId,
      taskGraph,
      status: allSucceeded ? 'completed' : 'failed',
      results,
      message: allSucceeded
        ? 'All tasks completed successfully.'
        : 'Some tasks failed. Check results for details.',
    };
  }

  /**
   * Phase 1: Use Nova 2 Lite via Converse API to generate an executable task graph.
   *
   * Converse API is the AWS-recommended unified API for all Nova text models.
   * It provides a consistent interface across model providers and supports
   * system prompts, tool use, and structured output natively.
   */
  private async plan(request: OrchestratorRequest): Promise<TaskGraph> {
    const userPrompt = buildPlanningPrompt({
      userRequest: request.input,
      availableTools: this.agentPool.getAvailableTools(),
      availableConnectors: this.agentPool.getAvailableConnectors(),
      workflowHistory: [],
      context: request.context,
    });

    const command = new ConverseCommand({
      modelId: this.config.novaLiteModelId,
      system: [{ text: PLANNING_SYSTEM_PROMPT }],
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
  private async execute(graph: TaskGraph, sessionId: string): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    const completed = new Set<string>();

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

      // Execute ready tasks in parallel (up to concurrency limit)
      const batchResults = await Promise.allSettled(
        ready.map((node) => this.executeNode(node, sessionId))
      );

      for (let i = 0; i < ready.length; i++) {
        const node = ready[i];
        const settled = batchResults[i];

        if (settled.status === 'fulfilled') {
          results.push(settled.value);
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
}
