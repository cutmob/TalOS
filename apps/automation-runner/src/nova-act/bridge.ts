import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NovaActCommand {
  type: 'start' | 'act' | 'act_get' | 'screenshot' | 'elements' | 'stop';
  url?: string;
  headless?: boolean;
  userDataDir?: string;
  prompt?: string;
  maxSteps?: number;
  schema?: Record<string, unknown>;
  timeout?: number;
}

export interface NovaActResult {
  status?: string;
  response?: string;
  matchesSchema?: boolean;
  parsedResponse?: unknown;
  screenshot?: string;
  elements?: string[];
  error?: string;
  novaActAvailable?: boolean;
}

/**
 * TypeScript bridge to the Nova Act Python SDK.
 *
 * Nova Act (pip install nova-act) is Python-only. This bridge spawns
 * the Python subprocess and communicates via JSON lines over stdin/stdout.
 *
 * Architecture:
 * Node.js (TypeScript) ←→ stdin/stdout JSON ←→ Python (nova-act SDK)
 *
 * The Python process:
 * - Controls a real Chrome browser via Playwright
 * - Uses Nova Act's AI model to understand and interact with web UIs
 * - Returns structured results back to Node.js
 *
 * Ref: https://docs.aws.amazon.com/nova-act/latest/userguide/what-is-nova-act.html
 */
export class NovaActBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private pendingRequests: Map<number, {
    resolve: (value: NovaActResult) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private requestId = 0;
  private responseQueue: Array<(result: NovaActResult) => void> = [];
  private pythonPath: string;
  private ready = false;

  constructor(pythonPath?: string) {
    super();
    this.pythonPath = pythonPath ?? process.env.NOVA_ACT_PYTHON_PATH ?? 'python3';
  }

  /**
   * Spawn the Python bridge process.
   */
  async initialize(): Promise<{ novaActAvailable: boolean }> {
    const scriptPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../python/nova_act_bridge.py'
    );

    this.process = spawn(this.pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    this.readline = createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    // Handle stderr for debugging
    this.process.stderr!.on('data', (data: Buffer) => {
      this.emit('debug', data.toString());
    });

    this.process.on('exit', (code) => {
      this.ready = false;
      this.emit('exit', code);
      // Reject all pending requests
      for (const [, { reject }] of this.pendingRequests) {
        reject(new Error(`Nova Act bridge process exited with code ${code}`));
      }
      this.pendingRequests.clear();
    });

    // Parse JSON responses line by line
    this.readline.on('line', (line: string) => {
      try {
        const result = JSON.parse(line) as NovaActResult;
        const resolver = this.responseQueue.shift();
        if (resolver) {
          resolver(result);
        }
      } catch {
        this.emit('debug', `Non-JSON output: ${line}`);
      }
    });

    // Wait for the "ready" signal
    const readyResult = await this.waitForResponse();
    this.ready = true;
    return { novaActAvailable: readyResult.novaActAvailable ?? false };
  }

  /**
   * Send a command to the Nova Act Python process and wait for the response.
   */
  async send(command: NovaActCommand): Promise<NovaActResult> {
    if (!this.process || !this.ready) {
      throw new Error('Nova Act bridge not initialized. Call initialize() first.');
    }

    const json = JSON.stringify(command) + '\n';
    this.process.stdin!.write(json);

    const result = await this.waitForResponse();

    if (result.error) {
      throw new Error(`Nova Act error: ${result.error}`);
    }

    return result;
  }

  /**
   * High-level: Start a browser session.
   */
  async startSession(url: string, options?: { headless?: boolean; userDataDir?: string }): Promise<void> {
    await this.send({
      type: 'start',
      url,
      headless: options?.headless ?? true,
      userDataDir: options?.userDataDir,
    });
  }

  /**
   * High-level: Execute a natural language action.
   * Nova Act interprets the prompt and interacts with the browser UI.
   */
  async act(prompt: string, options?: { maxSteps?: number; timeout?: number }): Promise<{
    response: string;
  }> {
    const result = await this.send({
      type: 'act',
      prompt,
      maxSteps: options?.maxSteps ?? 30,
      timeout: options?.timeout,
    });
    return { response: result.response ?? '' };
  }

  /**
   * High-level: Execute an action and extract structured data.
   */
  async actGet<T = unknown>(prompt: string, schema: Record<string, unknown>): Promise<{
    data: T | null;
    matchesSchema: boolean;
    response: string;
  }> {
    const result = await this.send({ type: 'act_get', prompt, schema });
    return {
      data: (result.parsedResponse as T) ?? null,
      matchesSchema: result.matchesSchema ?? false,
      response: result.response ?? '',
    };
  }

  /**
   * High-level: Get visible interactive elements on the current page.
   * Used by the recovery agent for self-healing automation.
   */
  async getPageElements(): Promise<string[]> {
    const result = await this.send({ type: 'elements' });
    return result.elements ?? [];
  }

  /**
   * High-level: Capture a screenshot.
   */
  async screenshot(): Promise<string> {
    const result = await this.send({ type: 'screenshot' });
    return result.screenshot ?? '';
  }

  /**
   * Stop the browser session.
   */
  async stopSession(): Promise<void> {
    if (this.ready) {
      await this.send({ type: 'stop' });
    }
  }

  /**
   * Kill the Python bridge process.
   */
  async shutdown(): Promise<void> {
    try {
      await this.stopSession();
    } catch { /* ignore */ }
    this.process?.kill();
    this.process = null;
    this.readline = null;
    this.ready = false;
  }

  private waitForResponse(): Promise<NovaActResult> {
    return new Promise((resolve) => {
      this.responseQueue.push(resolve);
    });
  }

  isReady(): boolean {
    return this.ready;
  }
}
