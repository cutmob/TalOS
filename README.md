# TalOS — The AI Operating System

> **Amazon Nova Hackathon Submission** | #AmazonNova

**TalOS is a voice-controlled AI operating system that turns a single spoken sentence into a fully automated, multi-step enterprise workflow.** Say _"create a Jira ticket for the login bug and post a Slack update to engineering"_ — TalOS plans the steps, executes them in parallel across your tools, and self-heals if anything goes wrong.

## Who is it for?

| Role | How TalOS helps |
|---|---|
| **Software engineers & tech leads** | Voice-create Jira tickets, trigger CI updates, post incident alerts to Slack — hands-free while staying in flow |
| **Product managers** | Dictate tasks across Jira + Notion + Slack without switching tabs |
| **Sales & revenue teams** | Create HubSpot contacts, log deals, and send follow-up emails by speaking one sentence |
| **Operations & support** | Automate cross-platform runbooks — escalate, notify, log, and document in one voice command |

Basically: **if your job involves moving information between apps**, TalOS eliminates that manual work.

## Example commands you can say

```
"Create a P1 Jira ticket for the checkout bug and alert #incidents on Slack"
"Add John Smith to HubSpot and send him an intro email via Gmail"
"Summarize my open Jira tickets and post a standup to #engineering"
"Log today's sprint retro notes in Notion and share the link on Slack"
"Check if we have a HubSpot deal for Acme Corp — if not, create one"
```

Each command fans out into a dependency-aware task graph, executing independent steps in parallel and retrying failed steps automatically.

---

Built on Amazon Nova's full model portfolio:
- **Nova 2 Pro** powers the orchestrator's reasoning engine, decomposing complex requests into dependency-aware task graphs executed by specialist agents (research, execution, recovery)
- **Nova 2 Lite** powers the recovery agent — fast, cost-effective structured failure diagnosis and self-healing selector resolution (1M context)
- **Nova 2 Sonic** enables real-time speech-to-speech voice control via bidirectional HTTP/2 streaming
- **Nova Act** drives browser-based UI automation with natural language, making workflows resilient to UI changes
- **Nova Multimodal Embeddings** power a three-layer semantic memory system and a cross-tool knowledge index — indexing at `GENERIC_INDEX` purpose, retrieving at `GENERIC_RETRIEVAL` purpose (asymmetric embedding, the correct pattern per AWS docs)

TalOS connects to Jira, Slack, Gmail, HubSpot, and Notion, orchestrating multi-step workflows across platforms with automatic recovery and correction learning.

### Powered by Amazon Nova

| Component | Model | API Model ID |
|---|---|---|
| Orchestrator / Planner | **Nova 2 Pro** — flagship reasoning, long-range planning | `us.amazon.nova-2-pro-v1:0` |
| Recovery Agent | **Nova 2 Lite** — fast structured failure diagnosis | `us.amazon.nova-2-lite-v1:0` |
| Voice Gateway | **Nova 2 Sonic** — real-time speech-to-speech | `amazon.nova-2-sonic-v1:0` |
| Memory Engine | **Nova 2 Multimodal Embeddings** — semantic RAG | `amazon.nova-2-multimodal-embeddings-v1:0` |
| Browser Automation | **Nova Act** — natural language UI automation | Python SDK |

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
│  │ (Nova 2 Pro)│ │ (memory/RAG) │ │ (Nova Act)   │  │
│  └─────────────┘ └──────────────┘ └──────────────┘  │
│  ┌─────────────┐                                     │
│  │  Recovery   │  Semantic Memory (Nova Embeddings)  │
│  │   Agent     │  Workflow Registry                  │
│  │ (Nova 2 Lite)│  Execution Monitor                  │
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
│   ├── orchestrator-agent/ Nova 2 Pro planning agent
│   ├── research-agent/     Memory/workflow lookup
│   ├── execution-agent/    API connectors + Nova Act
│   └── recovery-agent/     Nova 2 Lite failure diagnosis + self-healing
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
| `NOVA_PRO_MODEL_ID` | `us.amazon.nova-2-pro-v1:0` | **Orchestrator/Planner** — complex reasoning (1M context) |
| `NOVA_LITE_MODEL_ID` | `us.amazon.nova-2-lite-v1:0` | **Recovery Agent** — fast failure diagnosis (1M context) |
| `NOVA_SONIC_MODEL_ID` | `amazon.nova-2-sonic-v1:0` | **Voice Gateway** — speech-to-speech (300k context) |
| `NOVA_EMBEDDINGS_MODEL_ID` | `amazon.nova-2-multimodal-embeddings-v1:0` | **Memory Engine** — semantic RAG |
| `NOVA_EMBEDDING_DIMENSION` | `1024` | Embedding vector dimension (256/384/1024/3072) |
| `NOVA_SONIC_VOICE` | `tiffany` | Voice ID for Nova Sonic responses |
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

## Knowledge System

TalOS has a two-layer knowledge architecture:

### Layer 1 — Three-tier agent memory (`packages/memory-engine/`)
| Tier | What it stores | TTL |
|---|---|---|
| **Short-term** | Tasks and commands from the current session | Configurable (default 1hr) |
| **Long-term** | Learned workflows, self-healed selector corrections | Permanent |
| **Semantic** | UI element snapshots for browser automation recovery | Permanent with freshness decay |

Retrieval uses **hybrid search**: Nova Multimodal cosine similarity first, keyword overlap fallback. Long-term entries apply **exponential freshness decay** (`score × e^(-age / 7days)`) so stale corrections rank below recent ones even at similar cosine distance.

### Layer 2 — Cross-tool knowledge search (`knowledge_search` action)
When the user refers to something without naming a specific tool — _"find the Acme renewal doc"_, _"what's the status of the checkout bug"_ — the planner emits a `knowledge_search` node. The execution agent fans out across **all 5 connectors in parallel**, merges results by relevance, and returns a unified `KnowledgeObject[]` with `source`, `objectType`, `externalId`, and `url` for every result.

```
knowledge_search("Acme renewal")
  → Notion pages       (roadmaps, specs, docs)
  → Jira issues        (tickets, bugs, stories)
  → Gmail threads      (emails, threads)
  → HubSpot deals      (pipeline, revenue)
  → HubSpot contacts   (people, accounts)
```

Results are truncated to ~400 chars each so the model receives focused snippets. Set `KNOWLEDGE_SERVICE_URL` to plug in a dedicated vector store (OpenSearch, Pinecone) — the inline fallback activates automatically when it's absent.

### Semantic workflow matching
Workflows are embedded at registration time (`GENERIC_INDEX` purpose) and queries are embedded at retrieval time (`GENERIC_RETRIEVAL` purpose). This asymmetric pattern is what the Nova embeddings API is designed for — it means _"push to prod"_ finds a workflow named _"deploy to production"_, something keyword matching cannot do.

---

## Key Design Decisions

**Why an orchestrator-subagent pattern?**
Separating planning (OrchestratorAgent with **Nova 2 Pro**) from execution (specialist agents) allows each agent to be stateless, independently retryable, and swappable. The task graph engine enables true parallel execution of independent subtasks. The Recovery Agent uses **Nova 2 Lite** — it only needs fast structured JSON inference, not Pro-level reasoning, making it significantly cheaper per failure event. Both Pro and Lite offer a massive 1M token context window.

**Why asymmetric embedding purposes?**
Nova Multimodal Embeddings support distinct `GENERIC_INDEX` (optimised for storage) and `GENERIC_RETRIEVAL` (optimised for querying) purposes. Using them asymmetrically — index at write time, retrieve at query time — is the correct pattern per AWS docs and improves recall on paraphrase queries.

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

- **Amazon Bedrock** — Nova 2 Pro, Nova 2 Lite, Nova 2 Sonic, Nova 2 Multimodal Embeddings, Nova Act
- **TypeScript** + Turborepo monorepo
- **Fastify** — API server and automation runner
- **Next.js** — Dashboard
- **Web Audio API** — Real-time PCM mic capture for Nova Sonic

---

## Deployment

Deployed on Railway (4 services: dashboard, api-server, voice-gateway, automation-runner). See demo video for live walkthrough.

---

## License

TalOS is dual-licensed under **AGPL-3.0** and a **commercial license**. See [LICENSE](./LICENSE) and [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md) for details.

---

*TalOS — The AI Operating System | Amazon Nova Hackathon 2026 | #AmazonNova*
