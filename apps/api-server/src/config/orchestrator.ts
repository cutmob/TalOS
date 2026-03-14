import { Orchestrator } from '@talos/orchestrator';
import type { OrchestratorConfig } from '@talos/orchestrator';
import { MemoryManager, SemanticMemory } from '@talos/memory-engine';
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
  // Nova 2 Pro (cross-region) — Orchestrator/Planner: flagship reasoning, 1M context.
  const novaProModelId = process.env.NOVA_PRO_MODEL_ID ?? 'us.amazon.nova-2-pro-v1:0';
  // Nova 2 Lite (cross-region) — Recovery Agent: fast structured failure diagnosis
  const novaLiteModelId = process.env.NOVA_LITE_MODEL_ID ?? 'us.amazon.nova-2-lite-v1:0';
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

  // SemanticMemory provides the embed function for workflow matching.
  // Workflows registered via registerWorkflow() will be embedded at index time
  // (GENERIC_INDEX) and queries will be embedded at retrieval time (GENERIC_RETRIEVAL),
  // replacing the previous keyword-only WorkflowMatcher with real Nova cosine search.
  const semanticMemory = new SemanticMemory({ bedrockRegion, embeddingModelId, embeddingDimension });
  const workflows = new WorkflowRegistry(workflowStore, (text) => semanticMemory.embed(text));
  const monitor = new ExecutionMonitor();

  const config: OrchestratorConfig = {
    bedrockRegion,
    novaProModelId,
    jiraProjectKey: process.env.JIRA_PROJECT_KEY ?? 'KAN',
    maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS ?? '4', 10),
    taskTimeout: parseInt(process.env.TASK_TIMEOUT ?? '30000', 10),
    retryLimit: parseInt(process.env.RETRY_LIMIT ?? '3', 10),
  };

  const orchestrator = new Orchestrator(config);
  const pool = orchestrator.getAgentPool();

  // Register all specialist agents with their optimal Nova 2 models
  pool.registerAgent(new OrchestratorAgent({ bedrockRegion, modelId: novaProModelId, workflows, memory }));
  pool.registerAgent(new ResearchAgent({ memory, workflows }));
  pool.registerAgent(new ExecutionAgent({ memory, automationRunnerUrl }));
  // Recovery Agent uses Nova 2 Lite — fast, cost-effective for structured failure diagnosis
  pool.registerAgent(new RecoveryAgent({ bedrockRegion, modelId: novaLiteModelId, memory }));

  return { orchestrator, workflows, monitor };
}
