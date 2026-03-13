import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const API_KEY = env.NOTION_API_KEY ?? process.env.NOTION_API_KEY;
const HEADERS = {
  'Authorization': `Bearer ${API_KEY}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

function richText(content) {
  return [{ type: 'text', text: { content } }];
}

function paragraph(content) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(content) } };
}

function heading(content, level = 2) {
  const type = `heading_${level}`;
  return { object: 'block', type, [type]: { rich_text: richText(content) } };
}

async function createPage(title, children) {
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      parent: { page_id: '32231716e4aa80afb85cdac1311e826a' },
      properties: { title: { title: richText(title) } },
      children,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`❌ Failed to create "${title}":`, data.message ?? data);
    return null;
  }
  console.log(`✅ Created: ${title} → ${data.url}`);
  return data;
}

const pages = [
  {
    title: 'TalOS Product Roadmap',
    children: [
      heading('Q1 — Voice Orchestration MVP', 2),
      paragraph('Launch TalOS with full voice-controlled task orchestration powered by Amazon Nova Sonic. Integrate Jira, Slack, Gmail, HubSpot, and Notion connectors. Deploy orchestrator-subagent architecture with parallel task execution.'),
      heading('Q2 — CRM Automation', 2),
      paragraph('Deep HubSpot integration: auto-create deals from email threads, sync Jira milestones to HubSpot deal stages, Slack notifications on deal close. AI-powered lead scoring using Nova embeddings.'),
      heading('Q3 — Enterprise Scale', 2),
      paragraph('SSO (SAML/OIDC), role-based access control, audit logs, SOC 2 compliance. Multi-tenant workspace isolation. Advanced workflow builder with conditional branching.'),
      heading('Q4 — Nova Act Browser Automation', 2),
      paragraph('Full browser automation via Nova Act. Auto-fill forms, scrape competitor data, execute multi-step web workflows from voice commands. Python bridge to JS orchestrator.'),
    ],
  },
  {
    title: 'Team Meeting Notes',
    children: [
      heading('March 13, 2026 — Demo Prep Standup', 2),
      paragraph('Attendees: Engineering, Product, Design'),
      heading('Status Updates', 3),
      paragraph('✅ AWS Nova integration complete — Converse API wired up for planning, Nova Sonic for voice, Nova embeddings for semantic memory.'),
      paragraph('✅ All 5 connectors live: Jira, Slack, Gmail, HubSpot, Notion.'),
      paragraph('✅ Parallel task execution working — orchestrator batches independent tasks.'),
      paragraph('🔄 In progress: session context memory (last 10 turns sent as conversation history).'),
      paragraph('⏳ Pending: final demo recording, slide deck polish.'),
      heading('Action Items', 3),
      paragraph('• Run full end-to-end demo test before submission deadline'),
      paragraph('• Record 3-minute demo video showing voice + multi-platform orchestration'),
      paragraph('• Submit to Amazon Nova hackathon by deadline'),
    ],
  },
  {
    title: 'Sprint Planning — March 2026',
    children: [
      heading('Sprint Goal', 2),
      paragraph('Complete all connector integrations and ship a fully working demo of TalOS for the Amazon Nova hackathon.'),
      heading('Priority Items', 2),
      paragraph('1. Gmail search + smart summaries — read recent emails, surface key info'),
      paragraph('2. Notion indexing — search workspace pages, create new pages from voice'),
      paragraph('3. HubSpot deal tracking — list contacts, deals, pipeline stages'),
      paragraph('4. Slack notifications — post messages, list channels'),
      paragraph('5. Jira ticket management — create, search, update tickets via JQL'),
      heading('Definition of Done', 2),
      paragraph('Each connector must handle: search/list, create, and error recovery. All actions must return structured data that the orchestrator can summarize in natural language.'),
      heading('Tech Debt', 2),
      paragraph('• Add integration tests for all connectors'),
      paragraph('• Improve planner prompt for ambiguous multi-step requests'),
      paragraph('• Add streaming SSE progress to dashboard task feed'),
    ],
  },
  {
    title: 'TalOS Architecture Overview',
    children: [
      heading('Core Concept', 2),
      paragraph('TalOS is a voice-first AI operating system that lets users control all their enterprise software through natural language. Built on Amazon Nova, it orchestrates tasks across Jira, Slack, Gmail, HubSpot, Notion, and the browser.'),
      heading('How It Works', 2),
      paragraph('1. User speaks or types a command'),
      paragraph('2. Nova 2 Lite (Converse API) plans a task graph — breaks the request into discrete actions'),
      paragraph('3. Specialist agents (Research, Execution, Recovery) execute tasks in parallel where possible'),
      paragraph('4. Results are summarized in natural language and spoken back via Nova 2 Sonic'),
      heading('Amazon Nova Models Used', 2),
      paragraph('• Nova 2 Lite — planning, reasoning, natural language summaries (Converse API)'),
      paragraph('• Nova 2 Sonic — bidirectional voice streaming, speech-to-speech (InvokeModelWithBidirectionalStream)'),
      paragraph('• Nova Multimodal Embeddings — semantic memory, context retrieval (InvokeModel)'),
      paragraph('• Nova Act — browser automation via Python subprocess bridge'),
      heading('Why It Wins', 2),
      paragraph('No other tool lets you say "create a Jira ticket, notify the team on Slack, and log it in Notion" in one voice command. TalOS makes enterprise software feel like talking to a brilliant assistant who knows every tool you use.'),
    ],
  },
];

console.log('Seeding Notion pages...\n');
for (const page of pages) {
  await createPage(page.title, page.children);
}
console.log('\nDone! Now connect TalOS integration to each page via ... → Connections in Notion.');
