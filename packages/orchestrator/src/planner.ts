import type { TaskGraph } from '@operon/task-graph';
import { TaskGraphBuilder } from '@operon/task-graph';
import type { PlanningPrompt } from './types.js';

export const PLANNING_SYSTEM_PROMPT = `You are the TalOS Orchestrator — an AI planning engine that converts natural language commands into structured automation plans.

Your job:
1. Analyze the user's request
2. Determine which applications and tools are needed
3. Break the request into discrete, ordered steps
4. Output a JSON task graph

Rules:
- Each step must have a clear action and target
- Steps that can run in parallel should have no dependency on each other
- Steps that must run sequentially should declare dependencies
- Use only the available tools and connectors listed below
- If a request is ambiguous, pick the most reasonable interpretation
- Always include error-recovery hints in step metadata

Output format (JSON):
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
}`;

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

Respond with ONLY the JSON task graph. No explanation.`;
}

export function parsePlanResponse(responseText: string): TaskGraph {
  // Extract JSON from response (handle markdown code blocks)
  let jsonStr = responseText.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return TaskGraphBuilder.fromJSON(parsed);
  } catch {
    // If Nova returns malformed JSON, create a single fallback node
    return TaskGraphBuilder.singleStep({
      action: 'raw_request',
      parameters: { rawInput: responseText },
    });
  }
}
