import type { TaskGraph, TaskNode } from './types.js';

export type NodeExecutor = (node: TaskNode) => Promise<unknown>;

export interface ExecutionResult {
  nodeId: string;
  status: 'success' | 'failure';
  output: unknown;
  error?: string;
}

/**
 * Executes a task graph respecting dependency order.
 * Nodes with satisfied dependencies run in parallel.
 */
export class TaskGraphExecutor {
  async execute(graph: TaskGraph, executor: NodeExecutor): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    const completed = new Set<string>();

    while (completed.size < graph.nodes.length) {
      const ready = graph.nodes.filter(
        (n) =>
          !completed.has(n.id) &&
          n.dependencies.every((d) => completed.has(d))
      );

      if (ready.length === 0 && completed.size < graph.nodes.length) {
        throw new Error('Task graph deadlock: unresolvable dependencies.');
      }

      const batch = await Promise.allSettled(ready.map((n) => executor(n)));

      for (let i = 0; i < ready.length; i++) {
        const node = ready[i];
        const settled = batch[i];
        completed.add(node.id);

        if (settled.status === 'fulfilled') {
          results.push({ nodeId: node.id, status: 'success', output: settled.value });
        } else {
          results.push({
            nodeId: node.id,
            status: 'failure',
            output: null,
            error: settled.reason?.message ?? 'Unknown error',
          });
        }
      }
    }

    return results;
  }

  getExecutionOrder(graph: TaskGraph): string[][] {
    const layers: string[][] = [];
    const completed = new Set<string>();

    while (completed.size < graph.nodes.length) {
      const ready = graph.nodes
        .filter(
          (n) =>
            !completed.has(n.id) &&
            n.dependencies.every((d) => completed.has(d))
        )
        .map((n) => n.id);

      if (ready.length === 0) break;
      layers.push(ready);
      ready.forEach((id) => completed.add(id));
    }

    return layers;
  }
}
