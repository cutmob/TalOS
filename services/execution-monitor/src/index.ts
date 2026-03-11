export interface ExecutionEvent {
  id: string;
  sessionId: string;
  taskId: string;
  type: 'task_created' | 'task_started' | 'task_completed' | 'task_failed' | 'recovery_attempted';
  agentType: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface ExecutionMetrics {
  totalTasks: number;
  successCount: number;
  failureCount: number;
  recoveryCount: number;
  averageDuration: number;
  successRate: number;
}

/**
 * Execution Monitor — tracks automation events and computes metrics.
 * Provides the data layer for the OPERON dashboard.
 */
export class ExecutionMonitor {
  private events: ExecutionEvent[] = [];

  record(event: Omit<ExecutionEvent, 'id' | 'timestamp'>): void {
    this.events.push({
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
    });
  }

  getMetrics(since?: number): ExecutionMetrics {
    const filtered = since
      ? this.events.filter((e) => e.timestamp >= since)
      : this.events;

    const completed = filtered.filter((e) => e.type === 'task_completed');
    const failed = filtered.filter((e) => e.type === 'task_failed');
    const recoveries = filtered.filter((e) => e.type === 'recovery_attempted');

    const total = completed.length + failed.length;
    const durations = completed
      .map((e) => (e.data.duration as number) ?? 0)
      .filter((d) => d > 0);

    return {
      totalTasks: total,
      successCount: completed.length,
      failureCount: failed.length,
      recoveryCount: recoveries.length,
      averageDuration: durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0,
      successRate: total > 0 ? completed.length / total : 0,
    };
  }

  getRecentEvents(limit = 50): ExecutionEvent[] {
    return this.events.slice(-limit).reverse();
  }

  getSessionEvents(sessionId: string): ExecutionEvent[] {
    return this.events.filter((e) => e.sessionId === sessionId);
  }
}
