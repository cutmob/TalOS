import { describe, it, expect } from 'vitest';
import { TaskGraphBuilder } from '../builder.js';

describe('TaskGraphBuilder', () => {
  it('builds an empty graph', () => {
    const builder = new TaskGraphBuilder();
    const graph = builder.build();

    expect(graph.nodes).toEqual([]);
    expect(graph.createdAt).toBeTypeOf('number');
  });

  it('adds nodes and returns generated ids', () => {
    const builder = new TaskGraphBuilder();

    const id1 = builder.addNode({ action: 'lookup_user' });
    const id2 = builder.addNode({
      action: 'send_email',
      agentType: 'execution',
      parameters: { to: 'user@example.com' },
      dependencies: [id1],
    });

    expect(id1).toBe('task_1');
    expect(id2).toBe('task_2');

    const graph = builder.build();
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[1].dependencies).toContain(id1);
  });

  it('addSequence chains dependencies automatically', () => {
    const builder = new TaskGraphBuilder();
    const ids = builder.addSequence([
      { action: 'step_a' },
      { action: 'step_b' },
      { action: 'step_c' },
    ]);

    const graph = builder.build();

    expect(ids).toHaveLength(3);
    expect(graph.nodes[0].dependencies).toEqual([]);
    expect(graph.nodes[1].dependencies).toContain(ids[0]);
    expect(graph.nodes[2].dependencies).toContain(ids[1]);
  });

  it('addParallel creates independent nodes', () => {
    const builder = new TaskGraphBuilder();
    const ids = builder.addParallel([
      { action: 'fetch_a' },
      { action: 'fetch_b' },
    ]);

    const graph = builder.build();

    expect(ids).toHaveLength(2);
    expect(graph.nodes[0].dependencies).toEqual([]);
    expect(graph.nodes[1].dependencies).toEqual([]);
  });

  it('defaults agentType to execution', () => {
    const builder = new TaskGraphBuilder();
    builder.addNode({ action: 'do_thing' });

    const graph = builder.build();
    expect(graph.nodes[0].agentType).toBe('execution');
  });

  it('throws on cycle detection', () => {
    const builder = new TaskGraphBuilder();

    // Manually create a cycle: task_1 depends on task_2, task_2 depends on task_1
    builder.addNode({ action: 'a', dependencies: ['task_2'] });
    builder.addNode({ action: 'b', dependencies: ['task_1'] });

    expect(() => builder.build()).toThrow(/[Cc]ycle/);
  });

  it('fromJSON creates a graph from raw JSON', () => {
    const graph = TaskGraphBuilder.fromJSON({
      nodes: [
        { id: 'n1', action: 'search', agentType: 'research', parameters: { q: 'test' }, dependencies: [] },
        { id: 'n2', action: 'execute', dependencies: ['n1'] },
      ],
    });

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0].action).toBe('search');
    expect(graph.createdAt).toBeTypeOf('number');
  });

  it('singleStep creates a one-node graph', () => {
    const graph = TaskGraphBuilder.singleStep({
      action: 'create_ticket',
      parameters: { title: 'Bug fix' },
    });

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].action).toBe('create_ticket');
    expect(graph.nodes[0].dependencies).toEqual([]);
  });
});
