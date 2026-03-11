import { NovaActBridge } from './nova-act/bridge.js';

export interface AutomationAction {
  action: string;
  target?: string;
  value?: string;
  url?: string;
  selector?: string;
  timeout?: number;
}

/**
 * Automation Runner — manages browser automation sessions.
 *
 * Primary: Nova Act (Python SDK via bridge) — intelligent UI interaction
 *   Nova Act uses a custom Nova 2 Lite model with an integrated orchestrator
 *   and Playwright-based browser actuator. It understands semantic meaning
 *   of UI elements, making automation resilient to layout changes.
 *
 * The NovaActBridge spawns a Python subprocess that controls the browser.
 * Communication is via JSON lines over stdin/stdout.
 *
 * Ref: https://docs.aws.amazon.com/nova-act/latest/userguide/what-is-nova-act.html
 * Ref: https://github.com/aws/nova-act
 *
 * Key Nova Act best practices (from official docs):
 * - Decompose tasks into small, explicit act() calls for >90% reliability
 * - Each act() should target one specific action
 * - Use act_get() with Pydantic schemas for structured data extraction
 * - Use page.keyboard.type() directly for sensitive data (passwords)
 * - CAPTCHAs must be solved manually (human-in-the-loop)
 */
export class AutomationRunner {
  private bridges: Map<string, NovaActBridge> = new Map();
  private novaActAvailable = false;

  async initialize(): Promise<void> {
    // Test that Nova Act is available
    const testBridge = new NovaActBridge();
    try {
      const result = await testBridge.initialize();
      this.novaActAvailable = result.novaActAvailable;
      await testBridge.shutdown();
      console.log(`Automation runner initialized (Nova Act: ${this.novaActAvailable ? 'available' : 'not installed'})`);
    } catch (err) {
      console.warn('Nova Act bridge failed to initialize:', err);
      this.novaActAvailable = false;
    }
  }

  async createSession(sessionId: string, startUrl: string): Promise<void> {
    const bridge = new NovaActBridge();
    await bridge.initialize();
    await bridge.startSession(startUrl, {
      headless: process.env.HEADLESS !== 'false',
    });
    this.bridges.set(sessionId, bridge);
  }

  /**
   * Execute an automation action using Nova Act.
   *
   * Nova Act's act() method takes natural language prompts:
   * - "click the Create Issue button"
   * - "type 'Login bug' in the Summary field"
   * - "scroll down until you see Submit and click it"
   *
   * This is far more resilient than CSS selectors because
   * Nova Act understands semantic meaning of UI elements.
   */
  async executeAction(sessionId: string, action: AutomationAction): Promise<unknown> {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) throw new Error(`No session: ${sessionId}`);

    switch (action.action) {
      case 'navigate':
      case 'open_app': {
        const url = action.url ?? (action.target ? `https://${action.target}.com` : 'about:blank');
        // Nova Act navigates by creating a new session at the URL
        await bridge.stopSession();
        await bridge.startSession(url, { headless: process.env.HEADLESS !== 'false' });
        return { action: 'navigate', url, status: 'navigated' };
      }

      case 'click': {
        const prompt = action.target
          ? `Click the "${action.target}" button or link`
          : `Click the element matching "${action.selector}"`;
        const result = await bridge.act(prompt, {
          maxSteps: action.timeout ? Math.ceil(action.timeout / 1000) : 10,
        });
        return { action: 'click', target: action.target, response: result.response };
      }

      case 'type': {
        const prompt = action.value
          ? `Type "${action.value}" into the "${action.target ?? action.selector}" field`
          : `Click on the "${action.target ?? action.selector}" field`;
        const result = await bridge.act(prompt);
        return { action: 'type', field: action.target, value: action.value, response: result.response };
      }

      case 'select': {
        const prompt = `Select "${action.value}" from the "${action.target}" dropdown`;
        const result = await bridge.act(prompt);
        return { action: 'select', field: action.target, value: action.value, response: result.response };
      }

      case 'submit': {
        const prompt = action.target
          ? `Click the "${action.target}" submit button`
          : 'Submit the current form';
        const result = await bridge.act(prompt);
        return { action: 'submit', response: result.response };
      }

      case 'extract': {
        const result = await bridge.actGet(
          `Read the text content of "${action.target}"`,
          { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        );
        return { action: 'extract', target: action.target, data: result.data };
      }

      case 'screenshot': {
        const screenshot = await bridge.screenshot();
        return { action: 'screenshot', screenshot: screenshot.substring(0, 100) + '...' };
      }

      case 'wait': {
        const prompt = action.target
          ? `Wait until you can see "${action.target}" on the page`
          : 'Wait for the page to finish loading';
        const result = await bridge.act(prompt, {
          maxSteps: 5,
          timeout: action.timeout ? action.timeout / 1000 : 10,
        });
        return { action: 'wait', response: result.response };
      }

      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  /**
   * Get visible interactive elements on the current page.
   * Used by the recovery agent for self-healing when selectors break.
   */
  async getPageElements(sessionId: string): Promise<string[]> {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) return [];
    return bridge.getPageElements();
  }

  async closeSession(sessionId: string): Promise<void> {
    const bridge = this.bridges.get(sessionId);
    if (bridge) {
      await bridge.shutdown();
      this.bridges.delete(sessionId);
    }
  }

  async shutdown(): Promise<void> {
    for (const [id] of this.bridges) {
      await this.closeSession(id);
    }
  }

  isNovaActAvailable(): boolean {
    return this.novaActAvailable;
  }
}
