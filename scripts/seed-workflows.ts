/**
 * Seed script: populate the workflow database with starter templates.
 * Run: npx tsx scripts/seed-workflows.ts
 */

import type { Workflow } from '@operon/workflow-engine';

const SEED_WORKFLOWS: Omit<Workflow, 'id' | 'version' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'Create Jira Ticket',
    description: 'Create a new issue in Jira',
    connector: 'jira',
    tags: ['jira', 'ticket', 'issue', 'bug', 'create'],
    steps: [
      { action: 'open_app', target: 'jira' },
      { action: 'click', target: 'Create' },
      { action: 'wait', waitFor: 'Create issue dialog' },
      { action: 'type', target: 'Summary' },
      { action: 'click', target: 'Create', metadata: { recoveryHint: 'Look for Submit or Save button' } },
    ],
  },
  {
    name: 'Send Slack Message',
    description: 'Post a message to a Slack channel',
    connector: 'slack',
    tags: ['slack', 'message', 'send', 'post', 'channel'],
    steps: [
      { action: 'open_app', target: 'slack' },
      { action: 'click', target: 'channel' },
      { action: 'type', target: 'message_input' },
      { action: 'submit' },
    ],
  },
  {
    name: 'Schedule Calendar Meeting',
    description: 'Create a new event in Google Calendar',
    connector: 'gmail',
    tags: ['calendar', 'meeting', 'schedule', 'event', 'appointment'],
    steps: [
      { action: 'navigate', target: 'https://calendar.google.com' },
      { action: 'click', target: 'Create' },
      { action: 'type', target: 'Add title' },
      { action: 'click', target: 'date_picker' },
      { action: 'click', target: 'Save' },
    ],
  },
  {
    name: 'Send Email',
    description: 'Compose and send an email via Gmail',
    connector: 'gmail',
    tags: ['email', 'gmail', 'send', 'compose', 'mail'],
    steps: [
      { action: 'navigate', target: 'https://mail.google.com' },
      { action: 'click', target: 'Compose' },
      { action: 'type', target: 'To' },
      { action: 'type', target: 'Subject' },
      { action: 'type', target: 'Body' },
      { action: 'click', target: 'Send' },
    ],
  },
  {
    name: 'Create HubSpot Campaign',
    description: 'Create a marketing campaign in HubSpot',
    connector: 'hubspot',
    tags: ['hubspot', 'campaign', 'marketing', 'create'],
    steps: [
      { action: 'open_app', target: 'hubspot' },
      { action: 'navigate', target: 'Marketing > Campaigns' },
      { action: 'click', target: 'Create campaign' },
      { action: 'type', target: 'Campaign name' },
      { action: 'click', target: 'Create' },
    ],
  },
  {
    name: 'Create Notion Page',
    description: 'Create a new page in Notion workspace',
    connector: 'notion',
    tags: ['notion', 'page', 'create', 'document', 'wiki'],
    steps: [
      { action: 'open_app', target: 'notion' },
      { action: 'click', target: 'New page' },
      { action: 'type', target: 'title' },
      { action: 'type', target: 'content' },
    ],
  },
];

console.log('Seed workflows ready:');
SEED_WORKFLOWS.forEach((w) => console.log(`  - ${w.name} (${w.connector})`));
console.log(`\nTotal: ${SEED_WORKFLOWS.length} workflows`);

export { SEED_WORKFLOWS };
