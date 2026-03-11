import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { BaseAgent } from '@operon/agent-runtime';
import type { AgentType, AgentTask, AgentCapability } from '@operon/agent-runtime';
import type { WorkflowRegistry } from '@operon/workflow-engine';
import type { MemoryManager } from '@operon/memory-engine';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './prompts.js';

/**
 * The orchestrator agent is the brain of OPERON.
 * It receives user intent and decomposes it into a task plan
 * by querying existing workflows and reasoning about the request.
 *
 * Pattern: Orchestrator-Subagent
 * - This agent PLANS but does not EXECUTE
 * - Execution is delegated to specialist agents
 */
export class OrchestratorAgent extends BaseAgent {
  readonly type: AgentType = 'orchestrator';
  private client: BedrockRuntimeClient;
  private modelId: string;
  private workflows: WorkflowRegistry;
  private memory: MemoryManager;

  constructor(config: {
    bedrockRegion: string;
    modelId: string;
    workflows: WorkflowRegistry;
    memory: MemoryManager;
  }) {
    super();
    this.client = new BedrockRuntimeClient({ region: config.bedrockRegion });
    this.modelId = config.modelId;
    this.workflows = config.workflows;
    this.memory = config.memory;
  }

  async execute(task: AgentTask): Promise<unknown> {
    const userRequest = task.parameters.input as string;

    // Step 1: Check memory for session context
    const sessionContext = await this.memory.getSessionContext(task.sessionId);

    // Step 2: Search for matching workflows
    const matchingWorkflows = await this.workflows.findWorkflow(userRequest);

    // Step 3: Use Nova Lite to plan
    const prompt = this.buildPrompt(userRequest, sessionContext, matchingWorkflows);

    // Use Converse API — AWS-recommended for all Nova text models
    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: ORCHESTRATOR_SYSTEM_PROMPT }],
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
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

    // Step 4: Remember this task
    await this.memory.rememberTask(task.sessionId, {
      request: userRequest,
      plan: planText,
      timestamp: Date.now(),
    });

    return JSON.parse(planText);
  }

  private buildPrompt(
    request: string,
    context: unknown[],
    workflows: Array<{ workflow: { name: string; steps: unknown[] }; score: number }>
  ): string {
    const workflowInfo =
      workflows.length > 0
        ? `\nExisting similar workflows:\n${workflows.map((w) => `- ${w.workflow.name} (score: ${w.score.toFixed(2)})`).join('\n')}`
        : '\nNo matching workflows found. Create a new plan.';

    const contextInfo =
      context.length > 0
        ? `\nSession context: ${JSON.stringify(context.slice(-3))}`
        : '';

    return `User request: "${request}"${workflowInfo}${contextInfo}\n\nGenerate the task graph as JSON.`;
  }

  getCapabilities(): AgentCapability[] {
    return [
      {
        name: 'plan_workflow',
        description: 'Decompose a user request into an executable task graph',
        parameters: {
          input: { type: 'string', description: 'Natural language user request', required: true },
        },
      },
    ];
  }
}
