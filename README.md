# TalOS — The AI Operating System

> **Amazon Nova Hackathon Submission** | **Category: Agentic AI** | #AmazonNova

**TalOS is a voice-controlled AI operating system that turns a single spoken sentence into a fully automated, multi-step enterprise workflow.** Say _"create a Jira ticket for the login bug and post a Slack update to engineering"_ — TalOS plans the steps, executes them in parallel across your tools, and self-heals if anything goes wrong.

Built entirely on the **Amazon Nova model family** — Nova 2 Pro for orchestration, Nova 2 Lite for recovery, Nova 2 Sonic for real-time voice, Nova Multimodal Embeddings for semantic memory, and Nova Act for browser automation.

---

## Why TalOS?

Knowledge workers spend hours every day context-switching between apps — filing tickets, posting updates, sending emails, logging CRM data. TalOS eliminates that friction entirely: **speak once, and every downstream action happens automatically.**

| Role | How TalOS helps |
|---|---|
| **Software engineers & tech leads** | Voice-create Jira tickets, trigger CI updates, post incident alerts to Slack — hands-free while staying in flow |
| **Product managers** | Dictate tasks across Jira + Notion + Slack without switching tabs |
| **Sales & revenue teams** | Create HubSpot contacts, log deals, and send follow-up emails by speaking one sentence |
| **Operations & support** | Automate cross-platform runbooks — escalate, notify, log, and document in one voice command |

## Example commands

```
"Create a P1 Jira ticket for the checkout bug and alert #incidents on Slack"
"Add John Smith to HubSpot and send him an intro email via Gmail"
"Summarize my open Jira tickets and post a standup to #engineering"
"Log today's sprint retro notes in Notion and share the link on Slack"
"Check if we have a HubSpot deal for Acme Corp — if not, create one"
```

Each command fans out into a dependency-aware task graph, executing independent steps in parallel and retrying failed steps automatically.

---

## Powered by Amazon Nova

TalOS uses **five Amazon Nova models** working together — every AI capability in the system is powered by Nova:

| Component | Model | API | Model ID |
|---|---|---|---|
| **Orchestrator / Planner** | Nova 2 Pro | Converse API | `us.amazon.nova-2-pro-v1:0` |
| **Recovery Agent** | Nova 2 Lite | Converse API | `us.amazon.nova-2-lite-v1:0` |
| **Voice Gateway** | Nova 2 Sonic | Bidirectional Streaming | `amazon.nova-2-sonic-v1:0` |
| **Memory Engine** | Nova Multimodal Embeddings | InvokeModel | `amazon.nova-2-multimodal-embeddings-v1:0` |
| **Browser Automation** | Nova Act | Python SDK | `pip install nova-act` |

### How each model is used

**Nova 2 Pro** — The brain. Receives the user's natural language request, decomposes it into a dependency-aware task graph, selects which connectors to invoke, and synthesizes a coherent response from all results. Uses the Converse API with structured system prompts that encode routing rules for 30+ connector actions.

**Nova 2 Lite** — The recovery specialist. When a task fails (API error, selector mismatch, timeout), Lite performs fast structured JSON diagnosis: identifies the failure class, generates a correction strategy, and stores the fix in semantic memory so the same failure never happens twice. Lite's 1M-token context and low latency make it ideal for high-frequency retry loops.

**Nova 2 Sonic** — The voice interface. Real-time speech-to-speech via HTTP/2 bidirectional streaming (`InvokeModelWithBidirectionalStream`). The dashboard sends PCM audio (16-bit, 16kHz, mono) from the browser microphone; Sonic transcribes, reasons, invokes tools (triggering the orchestrator), and speaks the response back as PCM audio (24kHz). Supports barge-in (user can interrupt), multi-turn conversation, and tool use mid-stream.

**Nova Multimodal Embeddings** — The memory. Powers a three-layer semantic memory system and a cross-tool knowledge index. Uses asymmetric embedding: documents are indexed with `GENERIC_INDEX` purpose, queries use `GENERIC_RETRIEVAL` purpose — the correct pattern per AWS docs for maximum recall on paraphrase queries. This means _"push to prod"_ matches a workflow named _"deploy to production"_.

**Nova Act** — The hands. When API access isn't available or the user needs to automate a web UI, Nova Act drives a real browser with natural language instructions. The TypeScript backend communicates with a Python subprocess bridge via JSON over stdin/stdout. Each `act()` call targets one specific action for >90% reliability.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Next.js Dashboard                  │
│   Voice Button → WebSocket → Nova Sonic Gateway      │
│   Text Input  → REST API  → Orchestrator             │
│   Live agent status, task history, approval cards     │
└────────────────────┬────────────────────────────────┘
                     │ /api/*  (rewritten to :3001)
┌────────────────────▼────────────────────────────────┐
│              Fastify API Server (:3001)              │
│  POST /api/tasks/stream (SSE)  GET /api/metrics      │
│  /api/approvals  /api/workflows  /api/health         │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│                   Orchestrator                       │
│   Nova 2 Pro → Task Graph → topological dispatch     │
│                                                      │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ Orchestrator │ │   Research   │ │  Execution   │  │
│  │   Agent      │ │    Agent     │ │    Agent     │  │
│  │ (Nova 2 Pro) │ │ (memory/RAG) │ │ (connectors) │  │
│  └─────────────┘ └──────────────┘ └──────────────┘  │
│  ┌─────────────┐                                     │
│  │  Recovery    │  Semantic Memory (Nova Embeddings)  │
│  │   Agent      │  Workflow Registry                  │
│  │(Nova 2 Lite) │  Execution Monitor                  │
│  └─────────────┘                                     │
└────────────────────┬────────────────────────────────┘
                     │ HTTP (:3003)
┌────────────────────▼────────────────────────────────┐
│          Automation Runner (Nova Act bridge)         │
│   Python subprocess → real browser automation       │
└─────────────────────────────────────────────────────┘
```

### How it works

1. **Input** — User speaks (via Nova Sonic) or types a command
2. **Planning** — Nova 2 Pro decomposes the request into a task graph with dependency edges
3. **Approval gate** — Write actions pause for user confirmation (configurable per connector)
4. **Execution** — Independent tasks run in parallel; dependent tasks wait for upstream results
5. **Recovery** — If a task fails, Nova 2 Lite diagnoses the failure and retries with corrections
6. **Response** — Results aggregate into a markdown summary (dashboard) and voice confirmation (Sonic)

### Orchestrator-subagent pattern

The orchestrator is the single decision-maker. Four specialist agents handle execution:

- **Orchestrator Agent** — Task decomposition and planning via Nova 2 Pro
- **Research Agent** — Context-aware lookup from semantic memory and workflow registry
- **Execution Agent** — Routes actions to the 5 connectors or Nova Act automation
- **Recovery Agent** — Failure diagnosis via Nova 2 Lite; stores corrections in semantic memory for future self-healing

All agents are **stateless and independently retryable**. The task graph engine enables true parallel execution — a 4-step workflow with 2 independent branches runs in 2 batches, not 4.

### Human-in-the-loop approval gate

Write actions (sending emails, posting messages, creating tickets) pause for user approval before executing:

| Autonomy Level | Behavior |
|---|---|
| **Approve writes** (default) | Reads auto-execute, writes pause for approval |
| **Approve everything** | All actions require approval |
| **Full autonomy** | Execute everything immediately |

Configurable per connector — e.g., auto-approve Jira but require approval for Gmail sends. Works in both dashboard (visual approval card with action preview) and voice ("Should I go ahead?").

---

## Connectors

TalOS connects to **5 enterprise platforms** with 30+ actions:

### Jira
`jira_create_ticket` · `jira_search` · `jira_update_ticket`
- Create tickets with summary, description, issue type, priority, and labels
- Search via JQL with status/priority/assignee filtering
- Bulk status transitions across multiple tickets

### Slack
`slack_send_message` · `slack_read_messages` · `slack_list_channels` · `slack_reply_in_thread` · `slack_send_dm` · `slack_add_reaction` · `slack_upload_file`
- Post to channels, reply in threads, send DMs
- Rich message formatting with Block Kit support

### Gmail
`gmail_send_email` · `gmail_search` · `gmail_read_email` · `gmail_reply` · `gmail_modify_labels` · `gmail_search_contacts`
- Send, search, read, and reply to emails (OAuth2 with auto-refresh)
- Contact lookup via Google People API — say a name, TalOS finds the email

### HubSpot
`hubspot_create_contact` · `hubspot_search_contacts` · `hubspot_update_contact` · `hubspot_create_deal` · `hubspot_search_deals` · `hubspot_update_deal` · `hubspot_log_activity` · `hubspot_list_properties` · `hubspot_search_objects`
- Full CRM pipeline management — contacts, deals, activities
- Generic object search across any HubSpot entity

### Notion
`notion_search` · `notion_read_page` · `notion_create_page` · `notion_update_page` · `notion_append_block`
- Fuzzy search across all pages; read full page content via markdown endpoint
- Create and update pages with rich text blocks

### Cross-tool knowledge search
`knowledge_search` — When the user doesn't name a specific tool ("find the Acme renewal doc"), TalOS searches **all 5 connectors in parallel** and returns a unified result set ranked by relevance:

```
knowledge_search("Acme renewal")
  → Notion pages       (roadmaps, specs, docs)
  → Jira issues        (tickets, bugs, stories)
  → Gmail threads      (emails, threads)
  → HubSpot deals      (pipeline, revenue)
  → HubSpot contacts   (people, accounts)
```

All connectors include exponential-backoff retry and Nova Act fallback for UI automation when APIs are unavailable.

---

## Knowledge System

### Three-tier agent memory

| Tier | What it stores | Lifetime |
|---|---|---|
| **Short-term** | Tasks and commands from the current session | Configurable TTL (default 1hr) |
| **Long-term** | Learned workflows, self-healed corrections | Permanent |
| **Semantic** | UI element snapshots, embedded workflow definitions | Permanent with freshness decay |

Retrieval uses **hybrid search**: Nova Multimodal cosine similarity first, keyword overlap fallback. Long-term entries apply **exponential freshness decay** (`score * e^(-age / 7days)`) so stale corrections rank below recent ones.

### Semantic workflow matching

Workflows are embedded at registration time (`GENERIC_INDEX` purpose) and queries are embedded at retrieval time (`GENERIC_RETRIEVAL` purpose). This asymmetric pattern is what the Nova embeddings API is designed for — _"push to prod"_ finds a workflow named _"deploy to production"_, something keyword matching cannot do.

---

## Monorepo Structure

```
TalOS/
├── apps/
│   ├── api-server/          Fastify REST API (port 3001)
│   ├── voice-gateway/       Nova Sonic WebSocket gateway (port 3002)
│   ├── automation-runner/   Nova Act HTTP bridge (port 3003)
│   └── dashboard/           Next.js web UI (port 3000)
├── packages/
│   ├── orchestrator/        Core orchestration + task graph planning
│   ├── task-graph/          Topological sort, parallel batching, cycle detection
│   ├── agent-runtime/       BaseAgent, AgentPool, type definitions
│   ├── workflow-engine/     Workflow registry + semantic search
│   └── memory-engine/       Nova embeddings semantic memory
├── agents/
│   ├── orchestrator-agent/  Nova 2 Pro planning agent
│   ├── research-agent/      Memory/workflow lookup
│   ├── execution-agent/     API connectors + Nova Act routing
│   └── recovery-agent/      Nova 2 Lite failure diagnosis + self-healing
├── connectors/
│   ├── jira/                Jira Cloud REST API v3
│   ├── slack/               Slack Web API
│   ├── gmail/               Gmail API + Google People API (OAuth2)
│   ├── hubspot/             HubSpot CRM v3
│   └── notion/              Notion API v1
├── services/
│   ├── embeddings-service/  Vector store (InMemory → OpenSearch)
│   ├── workflow-db/         Workflow store (InMemory → DynamoDB)
│   ├── execution-monitor/   Real-time metrics + event tracking
│   └── auth-service/        JWT session management
└── infra/
    └── terraform/           DynamoDB, S3, EventBridge, ECS
```

---

## Quick Start

### Prerequisites
- Node.js 22+
- Python 3.10+ with `pip install nova-act` (for browser automation)
- AWS credentials with Bedrock access (us-east-1)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your AWS credentials and connector API keys
```

### 3. Start all services

**Option A — Single command (Turborepo)**
```bash
npx turbo dev
```

**Option B — Docker Compose**
```bash
docker-compose up
```

**Option C — Individual services (4 terminals)**
```bash
npm run dev:api        # API server (:3001)
npm run dev:voice      # Voice gateway (:3002)
npm run dev:runner     # Automation runner (:3003)
npm run dev:dashboard  # Next.js dashboard (:3000)
```

Open **http://localhost:3000** — click the microphone button and speak a command, or type in the text input.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BEDROCK_REGION` | `us-east-1` | AWS region for Bedrock |
| `NOVA_PRO_MODEL_ID` | `us.amazon.nova-2-pro-v1:0` | Orchestrator/Planner — complex reasoning |
| `NOVA_LITE_MODEL_ID` | `us.amazon.nova-2-lite-v1:0` | Recovery Agent — fast failure diagnosis |
| `NOVA_SONIC_MODEL_ID` | `amazon.nova-2-sonic-v1:0` | Voice Gateway — speech-to-speech |
| `NOVA_EMBEDDINGS_MODEL_ID` | `amazon.nova-2-multimodal-embeddings-v1:0` | Memory Engine — semantic RAG |
| `NOVA_EMBEDDING_DIMENSION` | `1024` | Embedding dimension (256/384/1024/3072) |
| `NOVA_SONIC_VOICE` | `tiffany` | Voice ID for spoken responses |
| `NOVA_ACT_API_KEY` | — | Nova Act API key for browser automation |
| `AUTOMATION_RUNNER_URL` | `http://localhost:3003` | Nova Act bridge URL |
| `MAX_CONCURRENT_AGENTS` | `4` | Max parallel agent execution slots |
| `TASK_TIMEOUT` | `30000` | Per-task timeout (ms) |
| `RETRY_LIMIT` | `3` | Orchestrator retry attempts |
| `API_PORT` | `3001` | API server port |
| `VOICE_GATEWAY_PORT` | `3002` | Voice WebSocket port |

See [`.env.example`](.env.example) for the full list including connector credentials (Jira, Slack, Gmail, HubSpot, Notion).

---

## API Reference

### Submit a task (SSE streaming)
```
POST /api/tasks/stream
Content-Type: application/json

{ "input": "Create a Jira ticket for the login bug", "sessionId": "uuid" }

→ event: progress
→ data: { "phase": "planning", "action": "jira_create_ticket", "agentType": "execution" }

→ event: result
→ data: { "sessionId": "...", "taskGraph": {...}, "status": "completed", "results": [...], "message": "..." }
```

### Search workflows
```
POST /api/workflows/search
{ "query": "send slack message", "limit": 5 }
```

### Metrics
```
GET /api/metrics
→ { totalTasks, completedTasks, failedTasks, avgDuration, successRate }
```

### Approval gate
```
GET  /api/approvals               → pending approvals list
POST /api/approvals/:id/approve   → SSE stream of execution
POST /api/approvals/:id/reject    → cancellation
GET  /api/approvals/settings      → { defaultLevel, connectorOverrides }
PUT  /api/approvals/settings      → update autonomy levels
```

### Health check
```
GET /api/health
→ { status: "ok"|"degraded", agents: {...}, automationRunner: {...} }
```

---

## Key Design Decisions

**Why an orchestrator-subagent pattern?**
Separating planning (Nova 2 Pro) from execution (specialist agents) makes each agent stateless, independently retryable, and swappable. The task graph engine enables true parallel execution of independent subtasks — something a single-agent architecture cannot do efficiently.

**Why Nova 2 Lite for recovery instead of Pro?**
Recovery needs fast structured JSON inference, not deep reasoning. Lite's low latency and 1M-token context make it ideal for high-frequency retry loops where every millisecond counts. It's also significantly cheaper per failure event.

**Why asymmetric embedding purposes?**
Nova Multimodal Embeddings support distinct `GENERIC_INDEX` (optimized for storage) and `GENERIC_RETRIEVAL` (optimized for querying) purposes. Using them asymmetrically — index at write time, retrieve at query time — is the correct pattern per AWS docs and improves recall on paraphrase queries.

**Why a Python subprocess for Nova Act?**
Nova Act is Python-only. Rather than limiting the entire backend to Python, we bridge via JSON over stdin/stdout: the TypeScript ExecutionAgent sends commands to the Python process, which drives a real browser via Playwright. This keeps the core TypeScript architecture intact while gaining full Nova Act capability.

**Why InMemory stores?**
For hackathon demo velocity. The interfaces are identical to DynamoDB/OpenSearch, so swapping is a one-line config change. All stores implement the same abstract interface.

---

## Production Upgrade Path

| Component | Demo (current) | Production |
|---|---|---|
| Memory store | InMemoryStore | Amazon OpenSearch |
| Workflow DB | InMemoryWorkflowStore | Amazon DynamoDB |
| Task queue | In-process | Amazon SQS |
| Deployment | Local / Docker Compose | Amazon ECS (Terraform in `/infra`) |

Terraform configurations for DynamoDB, S3, EventBridge, and ECS are in [`infra/terraform/`](./infra/terraform/).

---

## CI/CD

GitHub Actions pipeline ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on every push and PR:

1. **Build** — `npx turbo build` compiles all 20+ packages
2. **Test** — `npx turbo test` runs Vitest suites across all packages
3. **Lint** — `npx turbo lint` enforces ESLint 9 flat config

---

## Built With

- **Amazon Bedrock** — Nova 2 Pro, Nova 2 Lite, Nova 2 Sonic, Nova Multimodal Embeddings
- **Amazon Nova Act** — Natural language browser automation (Python SDK)
- **TypeScript** — Monorepo managed by Turborepo
- **Fastify** — API server, voice gateway, automation runner
- **Next.js 15 + React 19** — Dashboard with real-time agent visualization
- **Web Audio API** — Real-time PCM mic capture and audio playback for Nova Sonic
- **Zod** — Runtime schema validation across all connector actions
- **Vitest** — Test framework across all packages

---

## License

TalOS is dual-licensed under **AGPL-3.0** and a **commercial license**. See [LICENSE](./LICENSE) and [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md) for details.

---

*TalOS — The AI Operating System | Amazon Nova Hackathon 2026 | #AmazonNova*
