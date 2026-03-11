import type { Agent, AgentType, AgentTask, AgentCapability } from './types.js';

/**
 * Base class for all OPERON specialist agents.
 * Agents are stateless — they receive a task, execute it, return a result.
 */
export abstract class BaseAgent implements Agent {
  abstract readonly type: AgentType;

  abstract execute(task: AgentTask): Promise<unknown>;

  abstract getCapabilities(): AgentCapability[];

  protected validateTask(task: AgentTask, requiredParams: string[]): void {
    for (const param of requiredParams) {
      if (!(param in task.parameters)) {
        throw new Error(`Missing required parameter: ${param} for task ${task.taskId}`);
      }
    }
  }

  protected async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Agent task timed out after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }
}
