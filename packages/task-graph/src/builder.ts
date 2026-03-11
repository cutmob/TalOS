import type { TaskGraph, TaskNode, TaskNodeInput } from './types.js';

export class TaskGraphBuilder {
  private nodes: TaskNode[] = [];
  private idCounter = 0;

  addNode(input: TaskNodeInput): string {
    const id = `task_${++this.idCounter}`;
    this.nodes.push({
      id,
      action: input.action,
      agentType: input.agentType ?? 'execution',
      parameters: input.parameters ?? {},
      dependencies: input.dependencies ?? [],
      metadata: input.metadata,
    });
    return id;
  }

  addSequence(inputs: TaskNodeInput[]): string[] {
    const ids: string[] = [];
    for (const input of inputs) {
      const deps = ids.length > 0 ? [ids[ids.length - 1]] : [];
      const id = this.addNode({ ...input, dependencies: [...(input.dependencies ?? []), ...deps] });
      ids.push(id);
    }
    return ids;
  }

  addParallel(inputs: TaskNodeInput[]): string[] {
    return inputs.map((input) => this.addNode(input));
  }

  build(): TaskGraph {
    this.validateNoCycles();
    return {
      nodes: [...this.nodes],
      createdAt: Date.now(),
    };
  }

  private validateNoCycles(): void {
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (nodeId: string): void => {
      if (visiting.has(nodeId)) {
        throw new Error(`Cycle detected in task graph at node: ${nodeId}`);
      }
      if (visited.has(nodeId)) return;

      visiting.add(nodeId);
      const node = this.nodes.find((n) => n.id === nodeId);
      if (node) {
        for (const dep of node.dependencies) {
          visit(dep);
        }
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
    };

    for (const node of this.nodes) {
      visit(node.id);
    }
  }

  static fromJSON(json: { nodes: Array<Record<string, unknown>> }): TaskGraph {
    const nodes: TaskNode[] = (json.nodes ?? []).map((raw, i) => ({
      id: (raw.id as string) ?? `task_${i + 1}`,
      action: (raw.action as string) ?? 'unknown',
      agentType: (raw.agentType as TaskNode['agentType']) ?? 'execution',
      parameters: (raw.parameters as Record<string, unknown>) ?? {},
      dependencies: (raw.dependencies as string[]) ?? [],
      metadata: raw.metadata as Record<string, unknown> | undefined,
    }));

    return { nodes, createdAt: Date.now() };
  }

  static singleStep(input: { action: string; parameters: Record<string, unknown> }): TaskGraph {
    return {
      nodes: [
        {
          id: 'task_1',
          action: input.action,
          agentType: 'execution',
          parameters: input.parameters,
          dependencies: [],
        },
      ],
      createdAt: Date.now(),
    };
  }
}
