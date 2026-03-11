import { BaseAgent } from '@talos/agent-runtime';
import type { AgentType, AgentTask, AgentCapability } from '@talos/agent-runtime';
import type { MemoryManager, UISnapshot } from '@talos/memory-engine';

/**
 * Execution Agent — performs UI automation by delegating to the
 * AutomationRunner microservice (Nova Act Python bridge via HTTP).
 *
 * Two modes:
 *  1. Runner available (AUTOMATION_RUNNER_URL set): forwards actions to the
 *     automation-runner HTTP server which drives Nova Act + real browser.
 *  2. Runner unavailable: returns graceful stub responses so the orchestrator
 *     can still produce meaningful output (useful for demo w/o a browser).
 *
 * Nova Act best practices (from official docs):
 *  - Each act() call targets ONE specific action
 *  - Natural language prompts beat CSS selectors for resilience
 *  - Use act_get() with schemas for structured extraction
 */
export class ExecutionAgent extends BaseAgent {
  readonly type: AgentType = 'execution';
  private memory: MemoryManager;
  private runnerUrl: string;

  constructor(config: {
    memory: MemoryManager;
    novaActApiKey?: string;
    automationRunnerUrl?: string;
  }) {
    super();
    this.memory = config.memory;
    this.runnerUrl =
      config.automationRunnerUrl ??
      process.env.AUTOMATION_RUNNER_URL ??
      'http://localhost:3003';
  }

  async execute(task: AgentTask): Promise<unknown> {
    switch (task.action) {
      case 'open_app':   return this.openApp(task);
      case 'navigate':   return this.navigate(task);
      case 'click':      return this.click(task);
      case 'type':       return this.typeText(task);
      case 'select':     return this.select(task);
      case 'submit':     return this.submit(task);
      case 'extract':    return this.extract(task);
      case 'screenshot': return this.captureScreenshot(task);
      case 'wait':       return this.waitFor(task);
      default:
        throw new Error(`Unknown execution action: ${task.action}`);
    }
  }

  // ── Automation runner bridge ─────────────────────────────────────────────

  private async runAction(
    sessionId: string,
    action: Record<string, unknown>
  ): Promise<unknown> {
    try {
      const res = await fetch(`${this.runnerUrl}/sessions/${sessionId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
        signal: AbortSignal.timeout(60_000),
      });
      const data = await res.json() as { result?: unknown; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Runner HTTP ${res.status}`);
      return data.result;
    } catch (err) {
      // Automation runner unavailable — return stub so flow continues
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return { ...action, status: 'simulated', note: 'automation-runner offline' };
      }
      throw err;
    }
  }

  // ── Action handlers ──────────────────────────────────────────────────────

  private async openApp(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['app']);
    const app = task.parameters.app as string;
    const url = (task.parameters.url as string | undefined) ?? `https://${app}.com`;

    // Ensure a browser session exists for this task
    await this.ensureSession(task.sessionId, url);
    return this.runAction(task.sessionId, { action: 'open_app', target: app, url });
  }

  private async navigate(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['url']);
    await this.ensureSession(task.sessionId, task.parameters.url as string);
    return this.runAction(task.sessionId, { action: 'navigate', url: task.parameters.url });
  }

  private async click(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['target']);
    return this.runAction(task.sessionId, {
      action: 'click',
      target: task.parameters.target,
      selector: task.parameters.selector,
    });
  }

  private async typeText(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['field', 'value']);
    return this.runAction(task.sessionId, {
      action: 'type',
      target: task.parameters.field,
      value: task.parameters.value,
    });
  }

  private async select(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['field', 'value']);
    return this.runAction(task.sessionId, {
      action: 'select',
      target: task.parameters.field,
      value: task.parameters.value,
    });
  }

  private async submit(task: AgentTask): Promise<unknown> {
    return this.runAction(task.sessionId, {
      action: 'submit',
      target: task.parameters.target,
    });
  }

  private async extract(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['target']);
    return this.runAction(task.sessionId, {
      action: 'extract',
      target: task.parameters.target,
    });
  }

  private async captureScreenshot(task: AgentTask): Promise<unknown> {
    const result = await this.runAction(task.sessionId, { action: 'screenshot' });

    // Store snapshot in semantic memory for self-healing
    const snapshot: UISnapshot = {
      app: (task.parameters.app as string) ?? 'unknown',
      page: (task.parameters.page as string) ?? 'unknown',
      elements: [],
      capturedAt: Date.now(),
    };
    const snapshotId = await this.memory.storeUISnapshot(snapshot);
    return { ...(result as object), snapshotId };
  }

  private async waitFor(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['condition']);
    return this.runAction(task.sessionId, {
      action: 'wait',
      target: task.parameters.condition,
      timeout: task.parameters.timeout,
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async ensureSession(sessionId: string, startUrl: string): Promise<void> {
    try {
      await fetch(`${this.runnerUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, startUrl }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Best-effort — runAction will handle the offline case
    }
  }

  getCapabilities(): AgentCapability[] {
    return [
      { name: 'open_app', description: 'Open a web application', parameters: { app: { type: 'string', description: 'Application name', required: true }, url: { type: 'string', description: 'Direct URL', required: false } } },
      { name: 'navigate', description: 'Navigate to a URL', parameters: { url: { type: 'string', description: 'Target URL', required: true } } },
      { name: 'click', description: 'Click a UI element via Nova Act natural language', parameters: { target: { type: 'string', description: 'Element label to click', required: true } } },
      { name: 'type', description: 'Type text into a field', parameters: { field: { type: 'string', description: 'Field name', required: true }, value: { type: 'string', description: 'Text to type', required: true } } },
      { name: 'select', description: 'Select from a dropdown', parameters: { field: { type: 'string', description: 'Dropdown name', required: true }, value: { type: 'string', description: 'Option to select', required: true } } },
      { name: 'submit', description: 'Submit the current form', parameters: {} },
      { name: 'extract', description: 'Extract text from the page', parameters: { target: { type: 'string', description: 'Element to read', required: true } } },
      { name: 'screenshot', description: 'Capture UI state and store in memory', parameters: { app: { type: 'string', description: 'App name', required: false } } },
      { name: 'wait', description: 'Wait for a condition', parameters: { condition: { type: 'string', description: 'What to wait for', required: true }, timeout: { type: 'number', description: 'Timeout ms', required: false } } },
    ];
  }
}
