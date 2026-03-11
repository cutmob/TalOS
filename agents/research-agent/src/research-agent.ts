import { BaseAgent } from '@operon/agent-runtime';
import type { AgentType, AgentTask, AgentCapability } from '@operon/agent-runtime';
import type { MemoryManager } from '@operon/memory-engine';
import type { WorkflowRegistry } from '@operon/workflow-engine';

/**
 * Research Agent — retrieves information from the knowledge base.
 *
 * Responsibilities:
 * - Search workflow database for reusable templates
 * - Retrieve UI snapshots for self-healing
 * - Analyze stored corrections for element mapping
 * - Query semantic memory for relevant context
 *
 * This agent does NOT execute actions — it only retrieves information.
 */
export class ResearchAgent extends BaseAgent {
  readonly type: AgentType = 'research';
  private memory: MemoryManager;
  private workflows: WorkflowRegistry;

  constructor(config: { memory: MemoryManager; workflows: WorkflowRegistry }) {
    super();
    this.memory = config.memory;
    this.workflows = config.workflows;
  }

  async execute(task: AgentTask): Promise<unknown> {
    switch (task.action) {
      case 'search_workflows':
        return this.searchWorkflows(task);
      case 'recall_ui':
        return this.recallUI(task);
      case 'find_corrections':
        return this.findCorrections(task);
      case 'get_context':
        return this.getContext(task);
      default:
        throw new Error(`Unknown research action: ${task.action}`);
    }
  }

  private async searchWorkflows(task: AgentTask): Promise<unknown> {
    const query = task.parameters.query as string;
    this.validateTask(task, ['query']);
    const results = await this.workflows.findWorkflow(query);
    return {
      workflows: results.map((r) => ({
        id: r.workflow.id,
        name: r.workflow.name,
        score: r.score,
        steps: r.workflow.steps,
      })),
    };
  }

  private async recallUI(task: AgentTask): Promise<unknown> {
    const app = task.parameters.app as string;
    const page = task.parameters.page as string | undefined;
    const query = `${app} ${page ?? ''} UI elements`;
    const memories = await this.memory.recall(query, 5);
    return {
      snapshots: memories
        .filter((m) => m.entry.category === 'ui_snapshot')
        .map((m) => ({ ...m.entry.content, score: m.score })),
    };
  }

  private async findCorrections(task: AgentTask): Promise<unknown> {
    const app = task.parameters.app as string;
    const selector = task.parameters.selector as string;
    const query = `${app} ${selector} correction`;
    const memories = await this.memory.recall(query, 3);
    return {
      corrections: memories
        .filter((m) => m.entry.category === 'correction')
        .map((m) => m.entry.content),
    };
  }

  private async getContext(task: AgentTask): Promise<unknown> {
    return this.memory.getSessionContext(task.sessionId);
  }

  getCapabilities(): AgentCapability[] {
    return [
      {
        name: 'search_workflows',
        description: 'Search for matching automation workflows',
        parameters: { query: { type: 'string', description: 'Search query', required: true } },
      },
      {
        name: 'recall_ui',
        description: 'Retrieve stored UI snapshots for an application',
        parameters: {
          app: { type: 'string', description: 'Application name', required: true },
          page: { type: 'string', description: 'Page identifier', required: false },
        },
      },
      {
        name: 'find_corrections',
        description: 'Find stored selector corrections for self-healing',
        parameters: {
          app: { type: 'string', description: 'Application name', required: true },
          selector: { type: 'string', description: 'Original selector', required: true },
        },
      },
      {
        name: 'get_context',
        description: 'Retrieve current session context',
        parameters: {},
      },
    ];
  }
}
