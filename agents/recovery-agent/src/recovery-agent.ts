import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { BaseAgent } from '@talos/agent-runtime';
import type { AgentType, AgentTask, AgentCapability } from '@talos/agent-runtime';
import type { MemoryManager } from '@talos/memory-engine';

const RECOVERY_SYSTEM_PROMPT =
  'You are the TalOS Recovery Agent — a specialist in diagnosing and fixing UI automation failures.\n' +
  'You reason precisely about broken selectors, changed UIs, and failed actions.\n' +
  'Always respond with valid JSON only. No explanation text outside the JSON object.\n' +
  'Be conservative with confidence scores — only score > 0.8 when you are highly certain.';

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

    // Cap at 30 elements — more than this degrades model accuracy without adding signal
    const capped = elements.slice(0, 30);
    const elementList = capped.map((e) => `- "${e}"`).join('\n');
    const truncationNote = elements.length > 30
      ? `\n(${elements.length - 30} additional elements omitted for clarity)`
      : '';

    const prompt = `<task>
A UI automation script failed because the element "${oldSelector}" no longer exists in ${app}.
Find the best replacement element from the list below.
</task>

<available_elements>
${elementList}${truncationNote}
</available_elements>

<instructions>
1. Identify which element most likely replaced "${oldSelector}" based on label similarity, position, and common UI patterns.
2. If no reasonable match exists, return match: null with confidence: 0.
3. Score conservatively — only > 0.8 when you are highly certain.
</instructions>

<example>
Old selector: "Submit Order"
Available: ["Place Order", "Cancel", "Back", "Continue Shopping"]
Output: {"match":"Place Order","confidence":0.92,"reasoning":"'Place Order' is a direct semantic equivalent to 'Submit Order' — both complete a purchase action."}
</example>

Respond with JSON only: { "match": "element_label" | null, "confidence": 0.0-1.0, "reasoning": "..." }`;

    const result = await this.invokeNova(prompt, RECOVERY_SYSTEM_PROMPT);

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

    const prompt = `<task>
Analyze a UI automation failure and determine its root cause and recoverability.
</task>

<failure>
Error: ${error}
Context: ${context}
</failure>

<categories>
- selector_changed:   A UI element moved, was renamed, or the DOM structure changed
- page_not_loaded:    The target page did not load or timed out
- auth_required:      The action requires authentication that is missing or expired
- element_hidden:     The element exists but is not visible or interactable
- network_error:      An API call or resource failed to load
- other:              Failure does not match the above categories
</categories>

<example>
Error: "Element 'Create Issue' not found after 10s"
Context: "Attempting to click Create button on Jira board"
Output: {"category":"selector_changed","recoverable":true,"suggestedAction":"Search for alternative elements containing 'Create' or '+'","explanation":"The 'Create Issue' button was likely renamed or moved in a Jira UI update."}
</example>

Respond with JSON only: { "category": "...", "recoverable": true|false, "suggestedAction": "...", "explanation": "..." }`;

    const result = await this.invokeNova(prompt, RECOVERY_SYSTEM_PROMPT);
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
    const prompt = `<task>
A UI automation task failed. Determine the most likely cause and the concrete fix.
</task>

<failed_task>
${JSON.stringify(originalTask, null, 2)}
</failed_task>

<error>
${error}
</error>

<instructions>
Provide a specific, actionable fix — not a generic suggestion.
- If the selector likely changed, suggest the new selector label based on the task context.
- If the action sequence is wrong, suggest the corrected sequence.
- If this is unrecoverable (e.g. auth expired, app unavailable), set suggestedFix to null.
</instructions>

<example>
Task: {"action":"click","target":"Submit","app":"jira"}
Error: "Element 'Submit' not found"
Output: {"suggestedFix":"Create","explanation":"Jira's ticket creation dialog uses 'Create' not 'Submit' as the confirmation button label."}
</example>

Respond with JSON only: { "suggestedFix": "new_selector_or_action" | null, "explanation": "..." }`;

    const result = await this.invokeNova(prompt, RECOVERY_SYSTEM_PROMPT);
    try {
      return JSON.parse(result);
    } catch {
      return { suggestedFix: null, explanation: result };
    }
  }

  private async invokeNova(userPrompt: string, systemPrompt?: string): Promise<string> {
    // Use Converse API — AWS-recommended for all Nova text models
    const command = new ConverseCommand({
      modelId: this.modelId,
      ...(systemPrompt ? { system: [{ text: systemPrompt }] } : {}),
      messages: [
        {
          role: 'user',
          content: [{ text: userPrompt }],
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
