import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { BaseAgent } from '@operon/agent-runtime';
import type { AgentType, AgentTask, AgentCapability } from '@operon/agent-runtime';
import type { MemoryManager } from '@operon/memory-engine';

/**
 * Recovery Agent — handles automation failures and self-healing.
 *
 * This is OPERON's killer differentiator:
 * When UI elements change and automation breaks, this agent:
 * 1. Analyzes the failure context
 * 2. Uses Nova Lite to reason about the current UI state
 * 3. Finds alternative selectors/actions via semantic similarity
 * 4. Stores corrections for future use (self-learning)
 *
 * The system continuously improves as it encounters and resolves failures.
 */
export class RecoveryAgent extends BaseAgent {
  readonly type: AgentType = 'recovery';
  private client: BedrockRuntimeClient;
  private modelId: string;
  private memory: MemoryManager;

  constructor(config: {
    bedrockRegion: string;
    modelId: string;
    memory: MemoryManager;
  }) {
    super();
    this.client = new BedrockRuntimeClient({ region: config.bedrockRegion });
    this.modelId = config.modelId;
    this.memory = config.memory;
  }

  async execute(task: AgentTask): Promise<unknown> {
    switch (task.action) {
      case 'recover':
        return this.recover(task);
      case 'heal_selector':
        return this.healSelector(task);
      case 'analyze_failure':
        return this.analyzeFailure(task);
      default:
        throw new Error(`Unknown recovery action: ${task.action}`);
    }
  }

  /**
   * Main recovery flow:
   * 1. Analyze what went wrong
   * 2. Check memory for known corrections
   * 3. Use Nova Lite to reason about alternatives
   * 4. Store the correction for future use
   */
  private async recover(task: AgentTask): Promise<unknown> {
    const originalTask = task.parameters.originalTask as Record<string, unknown>;
    const error = task.parameters.error as string;

    // Check if we have a known correction
    const app = (originalTask.parameters as Record<string, unknown>)?.app as string ?? 'unknown';
    const target = (originalTask.parameters as Record<string, unknown>)?.target as string ?? '';

    const knownCorrections = await this.memory.recall(`${app} ${target} correction`, 3);

    if (knownCorrections.length > 0 && knownCorrections[0].score > 0.8) {
      const correction = knownCorrections[0].entry.content;
      return {
        strategy: 'known_correction',
        originalTarget: target,
        correctedTarget: correction.newSelector,
        confidence: knownCorrections[0].score,
      };
    }

    // Use Nova Lite to reason about the failure
    const analysis = await this.reasonAboutFailure(originalTask, error);

    // Store the correction for future use
    if (analysis.suggestedFix) {
      await this.memory.storeCorrection(
        app,
        target,
        analysis.suggestedFix,
        `Recovery from: ${error}`
      );
    }

    return {
      strategy: 'ai_reasoning',
      analysis,
    };
  }

  private async healSelector(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['app', 'oldSelector', 'availableElements']);
    const app = task.parameters.app as string;
    const oldSelector = task.parameters.oldSelector as string;
    const elements = task.parameters.availableElements as string[];

    const prompt = `A UI automation script failed because the element "${oldSelector}" no longer exists in ${app}.

Available elements on the current page:
${elements.map((e) => `- "${e}"`).join('\n')}

Which element is the most likely replacement for "${oldSelector}"?
Respond with JSON: { "match": "element_label", "confidence": 0.0-1.0, "reasoning": "..." }`;

    const result = await this.invokeNova(prompt);

    // Store the correction
    try {
      const parsed = JSON.parse(result);
      if (parsed.match && parsed.confidence > 0.5) {
        await this.memory.storeCorrection(app, oldSelector, parsed.match, 'self-healing');
      }
      return parsed;
    } catch {
      return { match: null, confidence: 0, reasoning: result };
    }
  }

  private async analyzeFailure(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['error', 'context']);
    const error = task.parameters.error as string;
    const context = task.parameters.context as string;

    const prompt = `Analyze this UI automation failure:
Error: ${error}
Context: ${context}

Determine:
1. Root cause category (selector_changed, page_not_loaded, auth_required, element_hidden, other)
2. Suggested recovery action
3. Whether this is recoverable

Respond with JSON: { "category": "...", "recoverable": true/false, "suggestedAction": "...", "explanation": "..." }`;

    const result = await this.invokeNova(prompt);
    try {
      return JSON.parse(result);
    } catch {
      return { category: 'other', recoverable: false, suggestedAction: null, explanation: result };
    }
  }

  private async reasonAboutFailure(
    originalTask: Record<string, unknown>,
    error: string
  ): Promise<{ suggestedFix: string | null; explanation: string }> {
    const prompt = `UI automation failed.
Task: ${JSON.stringify(originalTask)}
Error: ${error}

What is the most likely cause and fix? Respond with JSON: { "suggestedFix": "new_selector_or_action", "explanation": "..." }`;

    const result = await this.invokeNova(prompt);
    try {
      return JSON.parse(result);
    } catch {
      return { suggestedFix: null, explanation: result };
    }
  }

  private async invokeNova(prompt: string): Promise<string> {
    // Use Converse API — AWS-recommended for all Nova text models
    const command = new ConverseCommand({
      modelId: this.modelId,
      messages: [
        {
          role: 'user',
          content: [{ text: prompt }],
        },
      ],
      inferenceConfig: {
        maxTokens: 2048,
        temperature: 0.1,
        topP: 0.9,
      },
    });

    const response = await this.client.send(command);
    return response.output?.message?.content?.[0]?.text ?? '';
  }

  getCapabilities(): AgentCapability[] {
    return [
      {
        name: 'recover',
        description: 'Recover from a failed automation task',
        parameters: {
          originalTask: { type: 'object', description: 'The task that failed', required: true },
          error: { type: 'string', description: 'Error message', required: true },
        },
      },
      {
        name: 'heal_selector',
        description: 'Find replacement UI element when selector breaks',
        parameters: {
          app: { type: 'string', description: 'Application name', required: true },
          oldSelector: { type: 'string', description: 'Broken selector', required: true },
          availableElements: { type: 'array', description: 'Current page elements', required: true },
        },
      },
      {
        name: 'analyze_failure',
        description: 'Analyze root cause of automation failure',
        parameters: {
          error: { type: 'string', description: 'Error message', required: true },
          context: { type: 'string', description: 'Task context', required: true },
        },
      },
    ];
  }
}
