import { BaseAgent } from '@talos/agent-runtime';
import type { AgentType, AgentTask, AgentCapability } from '@talos/agent-runtime';
import type { MemoryManager, UISnapshot } from '@talos/memory-engine';
import { JiraConnector } from '@talos/connector-jira';
import { SlackConnector } from '@talos/connector-slack';

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
  private jira: JiraConnector | null = null;
  private slack: SlackConnector | null = null;

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

    // Initialize connectors from env if available
    if (process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN) {
      if (!process.env.JIRA_USER_EMAIL) {
        console.warn('[ExecutionAgent] JIRA_USER_EMAIL not set — Jira API calls will fail with 401. Set JIRA_USER_EMAIL to your Atlassian account email.');
      }
      this.jira = new JiraConnector({
        baseUrl: process.env.JIRA_BASE_URL,
        email: process.env.JIRA_USER_EMAIL ?? '',
        apiToken: process.env.JIRA_API_TOKEN,
        projectKey: process.env.JIRA_PROJECT_KEY ?? 'TAL',
      });
    }
    if (process.env.SLACK_BOT_TOKEN) {
      this.slack = new SlackConnector({
        botToken: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
      });
    }
  }

  async execute(task: AgentTask): Promise<unknown> {
    switch (task.action) {
      // ── Direct connector actions (REST API) ──
      case 'jira_create_ticket':  return this.jiraCreateTicket(task);
      case 'jira_search':         return this.jiraSearch(task);
      case 'slack_send_message':  return this.slackSendMessage(task);
      case 'slack_list_channels': return this.slackListChannels(task);
      // ── Browser automation actions (Nova Act) ──
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

  // ── Connector actions ─────────────────────────────────────────────────

  private async jiraCreateTicket(task: AgentTask): Promise<unknown> {
    if (!this.jira) return { error: 'Jira not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.jira.createTicket({
      summary: (p.summary as string) ?? (p.title as string) ?? 'Untitled',
      description: p.description as string | undefined,
      issueType: ((p.issueType as string) ?? 'Task') as 'Bug' | 'Task' | 'Story' | 'Epic',
      priority: p.priority as 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest' | undefined,
      labels: p.labels as string[] | undefined,
    });
    return { action: 'jira_create_ticket', ...result, status: 'created' };
  }

  private async jiraSearch(task: AgentTask): Promise<unknown> {
    if (!this.jira) return { error: 'Jira not configured', status: 'skipped' };
    const jql = (task.parameters.jql as string) ?? (task.parameters.query as string) ?? '';
    const results = await this.jira.searchTickets(jql);
    return { action: 'jira_search', results, count: results.length };
  }

  private async slackSendMessage(task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const p = task.parameters;
    const channel = (p.channel as string | undefined) ?? process.env.SLACK_DEFAULT_CHANNEL;
    if (!channel) throw new Error('Slack channel is required — planner must include a channel parameter in slack_send_message');
    const result = await this.slack.sendMessage({
      channel,
      text: (p.message as string) ?? (p.text as string) ?? '',
    });
    return { action: 'slack_send_message', channel, ...result, status: 'sent' };
  }

  private async slackListChannels(task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const channels = await this.slack.listChannels();
    return { action: 'slack_list_channels', channels, count: channels.length };
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
    // Be defensive: planner sometimes omits target for extract steps.
    const target = (task.parameters.target as string | undefined)
      ?? (task.parameters.field as string | undefined)
      ?? null;

    if (!target) {
      // Log a warning — skipped extract may cause downstream tasks to receive null data
      console.warn(`[ExecutionAgent] extract action skipped for session ${task.sessionId}: no target parameter provided`);
      return {
        action: 'extract',
        status: 'skipped',
        reason: 'No target provided for extract action',
      };
    }

    return this.runAction(task.sessionId, {
      action: 'extract',
      target,
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
      // Direct connector actions (preferred — fast, reliable)
      { name: 'jira_create_ticket', description: 'Create a Jira ticket via REST API', parameters: { summary: { type: 'string', description: 'Ticket title/summary', required: true }, description: { type: 'string', description: 'Ticket description', required: false }, issueType: { type: 'string', description: 'Issue type (Task, Bug, Story)', required: false }, priority: { type: 'string', description: 'Priority (Highest, High, Medium, Low, Lowest)', required: false }, labels: { type: 'array', description: 'Labels', required: false } } },
      { name: 'jira_search', description: 'Search Jira tickets using JQL', parameters: { jql: { type: 'string', description: 'JQL query string', required: true } } },
      { name: 'slack_send_message', description: 'Send a Slack message to a channel', parameters: { channel: { type: 'string', description: 'Channel name or ID', required: true }, message: { type: 'string', description: 'Message text', required: true } } },
      { name: 'slack_list_channels', description: 'List available Slack channels', parameters: {} },
      // Browser automation actions (fallback — Nova Act)
      { name: 'open_app', description: 'Open a web application in the browser', parameters: { app: { type: 'string', description: 'Application name', required: true }, url: { type: 'string', description: 'Direct URL', required: false } } },
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
