/**
 * Action classifier — categorizes task actions as read or write.
 *
 * Used by the approval gate to determine which actions need human approval
 * based on the user's autonomy settings.
 */

export type ActionCategory = 'read' | 'write';

const READ_ACTIONS = new Set([
  // Jira
  'jira_search',
  // Slack
  'slack_read_messages',
  'slack_list_channels',
  // Gmail
  'gmail_search',
  'gmail_read_email',
  'gmail_search_contacts',
  // HubSpot
  'hubspot_search_contacts',
  'hubspot_search_deals',
  'hubspot_search_objects',
  'hubspot_list_properties',
  // Notion
  'notion_search',
  'notion_read_page',
  // Cross-tool
  'knowledge_search',
  // Browser (observation / navigation)
  'open_app',
  'navigate',
  'screenshot',
  'extract',
  'wait',
]);

/**
 * Returns 'read' or 'write' for a given action string.
 * Unknown actions default to 'write' (safer — requires approval when in doubt).
 */
export function classifyAction(action: string): ActionCategory {
  return READ_ACTIONS.has(action) ? 'read' : 'write';
}

/**
 * Returns true if the action mutates external state (sends messages, creates records, etc.).
 */
export function isWriteAction(action: string): boolean {
  return classifyAction(action) === 'write';
}
