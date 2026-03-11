import type { Orchestrator } from '@talos/orchestrator';
import type { WorkflowRegistry } from '@talos/workflow-engine';
import type { ExecutionMonitor } from '@talos/execution-monitor';

declare module 'fastify' {
  interface FastifyInstance {
    orchestrator: Orchestrator;
    workflows: WorkflowRegistry;
    monitor: ExecutionMonitor;
  }
}
