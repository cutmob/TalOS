import { Orchestrator } from '@talos/orchestrator';
import type { OrchestratorConfig } from '@talos/orchestrator';
import { MemoryManager } from '@talos/memory-engine';
import { WorkflowRegistry } from '@talos/workflow-engine';
import { OrchestratorAgent } from '@talos/orchestrator-agent';
import { ResearchAgent } from '@talos/research-agent';
import { ExecutionAgent } from '@talos/execution-agent';
import { RecoveryAgent } from '@talos/recovery-agent';
import { InMemoryStore } from '@talos/embeddings-service';
import { InMemoryWorkflowStore } from '@talos/workflow-db';
import { ExecutionMonitor } from '@talos/execution-monitor';

export interface SystemServices {
  orchestrator: Orchestrator;
  workflows: WorkflowRegistry;
  monitor: ExecutionMonitor;
}

export function createSystemFromEnv(): SystemServices {
  const bedrockRegion = process.env.BEDROCK_REGION ?? 'us-east-1';
  const novaLiteModelId = process.env.NOVA_LITE_MODEL_ID ?? 'amazon.nova-2-lite-v1:0';
  const embeddingModelId = process.env.NOVA_EMBEDDINGS_MODEL_ID ?? 'amazon.nova-2-multimodal-embeddings-v1:0';
  const embeddingDimension = parseInt(process.env.NOVA_EMBEDDING_DIMENSION ?? '1024', 10);
  const automationRunnerUrl = process.env.AUTOMATION_RUNNER_URL ?? 'http://localhost:3003';

  // Shared stores — swap for DynamoDB/OpenSearch in production
  const memoryStore = new InMemoryStore();
  const workflowStore = new InMemoryWorkflowStore();

  const memory = new MemoryManager(memoryStore, {
    bedrockRegion,
    embeddingModelId,
    embeddingDimension,
    shortTermTTL: parseInt(process.env.MEMORY_TTL ?? '3600000', 10),
    maxShortTermEntries: 100,
  });

  const workflows = new WorkflowRegistry(workflowStore);
  const monitor = new ExecutionMonitor();

  const config: OrchestratorConfig = {
    bedrockRegion,
    novaLiteModelId,
    maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS ?? '4', 10),
    taskTimeout: parseInt(process.env.TASK_TIMEOUT ?? '30000', 10),
    retryLimit: parseInt(process.env.RETRY_LIMIT ?? '3', 10),
  };

  const orchestrator = new Orchestrator(config);
  const pool = orchestrator.getAgentPool();

  // Register all specialist agents with shared dependencies
  pool.registerAgent(new OrchestratorAgent({ bedrockRegion, modelId: novaLiteModelId, workflows, memory }));
  pool.registerAgent(new ResearchAgent({ memory, workflows }));
  pool.registerAgent(new ExecutionAgent({ memory, automationRunnerUrl }));
  pool.registerAgent(new RecoveryAgent({ bedrockRegion, modelId: novaLiteModelId, memory }));

  return { orchestrator, workflows, monitor };
}
