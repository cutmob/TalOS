# TalOS — The AI Operating System

> **Amazon Nova Hackathon Submission** — Enterprise-grade voice-controlled AI orchestration platform powered entirely by Amazon Nova models.

## What It Does

TalOS listens to your voice, understands your intent, and autonomously operates software on your behalf. Say *"Create a Jira ticket for the login bug and notify the team in Slack"* — TalOS plans the steps, executes them across your tools, and confirms completion, all without you touching a keyboard.

### Powered by Amazon Nova

| Capability | Model |
|---|---|
| Intent understanding & planning | `amazon.nova-2-lite-v1:0` (Converse API) |
| Voice input / output (speech-to-speech) | `amazon.nova-2-sonic-v1:0` (bidirectional stream) |
| Semantic memory & workflow search | `amazon.nova-2-multimodal-embeddings-v1:0` |
| Browser / UI automation | Nova Act (Python SDK) |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Next.js Dashboard                  │
│   Voice Button → WebSocket → Nova Sonic Gateway      │
│   Live metrics, agent status, task history           │
└────────────────────┬────────────────────────────────┘
                     │ /api/*  (rewritten to :3001)
┌────────────────────▼────────────────────────────────┐
│              Fastify API Server (:3001)              │
│   /api/tasks  /api/workflows  /api/metrics  /health  │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│                   Orchestrator                       │
│   Task Graph Engine → topological parallel dispatch  │
│                                                      │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ Orchestrator│ │   Research   │ │  Execution   │  │
│  │   Agent     │ │    Agent     │ │    Agent     │  │
│  │ (Nova Lite) │ │ (memory/RAG) │ │ (Nova Act)   │  │
│  └─────────────┘ └──────────────┘ └──────────────┘  │
│  ┌─────────────┐                                     │
│  │  Recovery   │  Semantic Memory (Nova Embeddings)  │
│  │   Agent     │  Workflow Registry                  │
│  │ (Nova Lite) │  Execution Monitor                  │
│  └─────────────┘                                     │
└────────────────────┬────────────────────────────────┘
                     │ HTTP (:3003)
┌────────────────────▼────────────────────────────────┐
│          Automation Runner (Nova Act bridge)         │
│   Python subprocess → real browser automation       │
└─────────────────────────────────────────────────────┘
```

### Connectors
Jira · Slack · Gmail · HubSpot · Notion — all with exponential-backoff retry and UI-automation fallback via Nova Act.

---

## Monorepo Structure

```
TalOS/
├── apps/
│   ├── api-server/        Fastify REST API (port 3001)
│   ├── voice-gateway/     Nova Sonic WebSocket gateway (port 3002)
│   ├── automation-runner/ Nova Act HTTP bridge (port 3003)
│   └── dashboard/         Next.js web UI (port 3000)
├── packages/
│   ├── orchestrator/      Core orchestration engine
│   ├── task-graph/        Topological task scheduling
│   ├── agent-runtime/     BaseAgent, AgentPool, types
│   ├── workflow-engine/   Workflow registry + search
│   └── memory-engine/     Nova embeddings semantic memory
├── agents/
│   ├── orchestrator-agent/ Nova Lite planning agent
│   ├── research-agent/     Memory/workflow lookup
│   ├── execution-agent/    Nova Act UI automation
│   └── recovery-agent/     Error recovery + retry logic
├── connectors/
│   └── jira/ slack/ gmail/ hubspot/ notion/
└── services/
    ├── embeddings-service/ InMemoryStore (swap → OpenSearch)
    ├── workflow-db/        InMemoryWorkflowStore (swap → DynamoDB)
    └── execution-monitor/  Real-time metrics + event tracking
```

---

## Quick Start

### Prerequisites
- Node.js 20+
- Python 3.10+ with `pip install nova-act`
- AWS credentials with Bedrock access (us-east-1)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env — minimum required: AWS credentials (BEDROCK_REGION defaults to us-east-1)
```

### 3. Start all services (4 terminals or use tmux)
```bash
# Terminal 1 — API server
npm run dev --workspace=apps/api-server

# Terminal 2 — Voice gateway
npm run dev --workspace=apps/voice-gateway

# Terminal 3 — Automation runner (Nova Act)
npm run dev --workspace=apps/automation-runner

# Terminal 4 — Dashboard
npm run dev --workspace=apps/dashboard
```

Open **http://localhost:3000** — click the microphone button and speak a command.

### Single command (Turborepo)
```bash
npx turbo dev
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BEDROCK_REGION` | `us-east-1` | AWS region for Bedrock |
| `NOVA_LITE_MODEL_ID` | `amazon.nova-2-lite-v1:0` | Text model ID |
| `NOVA_EMBEDDINGS_MODEL_ID` | `amazon.nova-2-multimodal-embeddings-v1:0` | Embeddings model ID |
| `NOVA_EMBEDDING_DIMENSION` | `1024` | Embedding vector dimension |
| `AUTOMATION_RUNNER_URL` | `http://localhost:3003` | Nova Act bridge URL |
| `MAX_CONCURRENT_AGENTS` | `4` | Max parallel agent slots |
| `TASK_TIMEOUT` | `30000` | Per-task timeout (ms) |
| `RETRY_LIMIT` | `3` | Orchestrator retry attempts |
| `API_PORT` | `3001` | API server port |
| `VOICE_GATEWAY_PORT` | `3002` | Voice WebSocket port |

---

## API Reference

### Submit a task
```
POST /api/tasks/submit
{ "input": "Create a Jira ticket for the login bug", "userId": "user-1" }
```

### Search workflows
```
POST /api/workflows/search
{ "query": "send slack message", "limit": 5 }
```

### Get metrics
```
GET /api/metrics
→ { totalTasks, completedTasks, failedTasks, avgDuration, successRate }
```

### Health check
```
GET /api/health
→ { status: "ok"|"degraded", agents: {...}, automationRunner: {...} }
```

---

## Key Design Decisions

**Why an orchestrator-subagent pattern?**
Separating planning (OrchestratorAgent with Nova Lite) from execution (specialist agents) allows each agent to be stateless, independently retryable, and swappable. The task graph engine enables true parallel execution of independent subtasks.

**Why a Python subprocess for Nova Act?**
Nova Act is Python-only. Rather than limiting the entire backend to Python, we bridge via HTTP: the TypeScript ExecutionAgent POSTs actions to the AutomationRunner microservice, which spawns the Python process. This keeps the core TypeScript architecture intact while gaining full Nova Act capability.

**Why InMemory stores?**
For hackathon demo velocity — the interfaces are identical to DynamoDB/OpenSearch, so swapping is a one-line config change. The `InMemoryStore` and `InMemoryWorkflowStore` are production-interface-compatible.

---

## Production Upgrade Path

| Component | Demo (current) | Production |
|---|---|---|
| Memory store | InMemoryStore | Amazon OpenSearch |
| Workflow DB | InMemoryWorkflowStore | Amazon DynamoDB |
| Task queue | In-process | Amazon SQS |
| Deployment | Local processes | Amazon ECS (Terraform in `/infra`) |

Terraform configurations for DynamoDB, S3, EventBridge, and ECS are in [`/infra/`](./infra/).

---

## Built With

- **Amazon Bedrock** — Nova Lite, Nova Sonic, Nova Multimodal Embeddings, Nova Act
- **TypeScript** + Turborepo monorepo
- **Fastify** — API server and automation runner
- **Next.js** — Dashboard
- **Web Audio API** — Real-time PCM mic capture for Nova Sonic

---

*TalOS — Amazon Nova Hackathon 2025*
