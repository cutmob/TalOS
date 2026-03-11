import type { Orchestrator } from '@operon/orchestrator';
import type { WorkflowRegistry } from '@operon/workflow-engine';
import type { ExecutionMonitor } from '@operon/execution-monitor';

declare module 'fastify' {
  interface FastifyInstance {
    orchestrator: Orchestrator;
    workflows: WorkflowRegistry;
    monitor: ExecutionMonitor;
  }
}
