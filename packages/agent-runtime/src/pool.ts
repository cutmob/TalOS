import type { Agent, AgentType, AgentPoolConfig, ToolDefinition } from './types.js';

/**
 * Manages a pool of specialist agents.
 * The orchestrator uses this to delegate tasks to the right agent.
 */
export class AgentPool {
  private agents: Map<AgentType, Agent> = new Map();
  private config: AgentPoolConfig;

  constructor(config: AgentPoolConfig) {
    this.config = config;
  }

  registerAgent(agent: Agent): void {
    this.agents.set(agent.type, agent);
  }

  getAgent(type: AgentType): Agent {
    const agent = this.agents.get(type);
    if (!agent) {
      throw new Error(`No agent registered for type: ${type}`);
    }
    return agent;
  }

  hasAgent(type: AgentType): boolean {
    return this.agents.has(type);
  }

  getAvailableTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const agent of this.agents.values()) {
      for (const cap of agent.getCapabilities()) {
        tools.push({
          name: cap.name,
          description: cap.description,
          parameters: cap.parameters,
        });
      }
    }
    return tools;
  }

  getAvailableConnectors(): string[] {
    // Connectors are registered separately — this returns known connector names
    return ['jira', 'slack', 'gmail', 'hubspot', 'notion'];
  }

  getRegisteredAgentTypes(): AgentType[] {
    return [...this.agents.keys()];
  }
}
