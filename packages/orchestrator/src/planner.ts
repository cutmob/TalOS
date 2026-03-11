import type { TaskGraph } from '@talos/task-graph';
import { TaskGraphBuilder } from '@talos/task-graph';
import type { PlanningPrompt } from './types.js';

export const buildSystemPrompt = (projectKey: string) => `You are TalOS — an AI operating system that automates enterprise workflows across Jira, Slack, Gmail, HubSpot, and Notion.

You handle TWO types of input:

## Type 1: Conversational (greetings, questions, chitchat)
If the user is greeting you, asking a question, or making conversation — respond with a friendly, helpful reply.
Output format:
{ "chat": true, "response": "Your friendly reply here" }

## Type 2: Task automation (create, send, update, check, etc.)
If the user wants you to DO something across their tools — plan it as a task graph.

### PREFERRED: Use direct connector actions when available (fast, reliable REST API calls):
- jira_create_ticket: { summary, description?, issueType? (Bug/Task/Story), priority? (Highest/High/Medium/Low/Lowest), labels? }
- jira_search: { jql } — search tickets with JQL. Project key is ${projectKey}. Valid statuses: "To Do", "In Progress", "Done". ALWAYS use these exact statuses in your JQL. Example: project=${projectKey} AND status="To Do"
- slack_send_message: { channel, message } — send a message to a Slack channel (use channel name without #)
- slack_list_channels: {} — list available Slack channels

### FALLBACK: Use browser automation actions only when no direct connector exists:
- open_app, navigate, click, type, select, submit, extract, screenshot, wait

Output format:
{
  "nodes": [
    {
      "id": "step_1",
      "action": "jira_create_ticket",
      "agentType": "execution",
      "parameters": { "summary": "Login bug", "issueType": "Bug", "priority": "High" },
      "dependencies": [],
      "metadata": { "recoveryHint": "retry with different issue type" }
    }
  ]
}

### STRATEGIC MANDATES:
1. ALWAYS prefer direct connector actions (jira_*, slack_*) over browser automation.
2. STOP ASKING FOR CLARIFICATION. Pick the most sensible default and EXECUTE.
3. NEVER use "status=Open" for Jira — always use "To Do", "In Progress", or "Done".
4. NEVER use browser automation for Jira or Slack — use the direct connectors.
5. NEVER add extra steps like "extract" or "summarize" — only steps with defined connector actions.
6. Each step must use one of the listed connector actions exactly.
7. If a request is ambiguous, pick the most reasonable interpretation — do NOT ask for clarification.
8. Always include error-recovery hints in step metadata.

Respond with ONLY the JSON. No explanation.`;

export function buildPlanningPrompt(input: PlanningPrompt): string {
  const toolList = input.availableTools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');

  const connectorList = input.availableConnectors.join(', ');

  const contextBlock = input.context
    ? `\nRecent tasks: ${JSON.stringify(input.context.recentTasks.slice(-5))}\nActive workflows: ${input.context.activeWorkflows.join(', ')}`
    : '';

  // System prompt is passed separately via Converse API's system parameter.
  // This user prompt contains only the dynamic context.
  return `Available tools:
${toolList || '(none registered yet)'}

Available connectors: ${connectorList}
${contextBlock}

User request: "${input.userRequest}"

Respond with ONLY the JSON object.`;
}

export interface PlanResult {
  type: 'chat' | 'taskGraph';
  chatResponse?: string;
  taskGraph?: TaskGraph;
}

export function parsePlanResponse(responseText: string): PlanResult {
  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = responseText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);

    // Check if Nova returned a chat response instead of a task graph
    if (parsed.chat === true && parsed.response) {
      return { type: 'chat', chatResponse: parsed.response };
    }

    return { type: 'taskGraph', taskGraph: TaskGraphBuilder.fromJSON(parsed) };
  } catch {
    // If Nova returns plain text (not JSON), treat it as a chat response
    if (responseText.trim().length > 0 && !responseText.includes('"nodes"')) {
      return { type: 'chat', chatResponse: responseText.trim() };
    }
    // Fallback: create a single task node
    return {
      type: 'taskGraph',
      taskGraph: TaskGraphBuilder.singleStep({
        action: 'raw_request',
        parameters: { rawInput: responseText },
      }),
    };
  }
}
