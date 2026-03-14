import { describe, it, expect } from 'vitest';
import { AgentPool } from '../pool.js';
import type { Agent, AgentType, AgentCapability } from '../types.js';

function createMockAgent(type: AgentType, capabilities: AgentCapability[] = []): Agent {
  return {
    type,
    execute: async () => ({ success: true }),
    getCapabilities: () => capabilities,
  };
}

describe('AgentPool', () => {
  it('registers and retrieves an agent', () => {
    const pool = new AgentPool({ maxConcurrent: 5, taskTimeout: 30_000 });
    const agent = createMockAgent('execution');

    pool.registerAgent(agent);

    expect(pool.getAgent('execution')).toBe(agent);
  });

  it('hasAgent returns true for registered agents', () => {
    const pool = new AgentPool({ maxConcurrent: 5, taskTimeout: 30_000 });
    pool.registerAgent(createMockAgent('research'));

    expect(pool.hasAgent('research')).toBe(true);
    expect(pool.hasAgent('recovery')).toBe(false);
  });

  it('getRegisteredAgentTypes returns all registered types', () => {
    const pool = new AgentPool({ maxConcurrent: 5, taskTimeout: 30_000 });
    pool.registerAgent(createMockAgent('execution'));
    pool.registerAgent(createMockAgent('research'));

    const types = pool.getRegisteredAgentTypes();
    expect(types).toContain('execution');
    expect(types).toContain('research');
    expect(types).toHaveLength(2);
  });

  it('getAgent throws for unknown agent type', () => {
    const pool = new AgentPool({ maxConcurrent: 5, taskTimeout: 30_000 });

    expect(() => pool.getAgent('recovery')).toThrow(/No agent registered/);
  });

  it('getAvailableTools aggregates capabilities from all agents', () => {
    const pool = new AgentPool({ maxConcurrent: 5, taskTimeout: 30_000 });

    pool.registerAgent(
      createMockAgent('execution', [
        { name: 'run_command', description: 'Run a shell command', parameters: {} },
      ]),
    );
    pool.registerAgent(
      createMockAgent('research', [
        { name: 'web_search', description: 'Search the web', parameters: {} },
      ]),
    );

    const tools = pool.getAvailableTools();
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name)).toEqual(['run_command', 'web_search']);
  });

  it('replaces agent when registering same type twice', () => {
    const pool = new AgentPool({ maxConcurrent: 5, taskTimeout: 30_000 });

    const agentV1 = createMockAgent('execution');
    const agentV2 = createMockAgent('execution');

    pool.registerAgent(agentV1);
    pool.registerAgent(agentV2);

    expect(pool.getAgent('execution')).toBe(agentV2);
    expect(pool.getRegisteredAgentTypes()).toHaveLength(1);
  });
});
