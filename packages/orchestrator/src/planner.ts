import type { TaskGraph } from '@talos/task-graph';
import { TaskGraphBuilder } from '@talos/task-graph';
import type { PlanningPrompt } from './types.js';

export const PLANNING_SYSTEM_PROMPT = `You are TalOS — an AI operating system that automates enterprise workflows across Jira, Slack, Gmail, HubSpot, and Notion.

You handle TWO types of input:

## Type 1: Conversational (greetings, questions, chitchat)
If the user is greeting you, asking a question, or making conversation — respond with a friendly, helpful reply.
Output format:
{ "chat": true, "response": "Your friendly reply here" }

## Type 2: Task automation (create, send, update, check, etc.)
If the user wants you to DO something across their tools — plan it as a task graph.
Output format:
{
  "nodes": [
    {
      "id": "step_1",
      "action": "open_app",
      "agentType": "execution",
      "parameters": { "app": "jira", "url": "..." },
      "dependencies": [],
      "metadata": { "recoveryHint": "retry with alternate URL" }
    }
  ]
}

Rules for task graphs:
- Each step must have a clear action and target
- Steps that can run in parallel should have no dependency on each other
- Steps that must run sequentially should declare dependencies
- Use only the available tools and connectors listed below
- If a request is ambiguous, pick the most reasonable interpretation
- Always include error-recovery hints in step metadata

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
