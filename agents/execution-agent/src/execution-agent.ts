import { BaseAgent } from '@talos/agent-runtime';
import type { AgentType, AgentTask, AgentCapability } from '@talos/agent-runtime';
import type { MemoryManager, UISnapshot } from '@talos/memory-engine';
import { JiraConnector } from '@talos/connector-jira';
import { SlackConnector } from '@talos/connector-slack';
import { GmailConnector } from '@talos/connector-gmail';
import { HubSpotConnector } from '@talos/connector-hubspot';
import { NotionConnector } from '@talos/connector-notion';

/**
 * Execution Agent — performs UI automation by delegating to the
 * AutomationRunner microservice (Nova Act Python bridge via HTTP).
 *
 * Two modes:
 *  1. Runner available (AUTOMATION_RUNNER_URL set): forwards actions to the
 *     automation-runner HTTP server which drives Nova Act + real browser.
 *  2. Runner unavailable: returns graceful stub responses so the orchestrator
 *     can still produce meaningful output (useful for demo w/o a browser).
 *
 * Nova Act best practices (from official docs):
 *  - Each act() call targets ONE specific action
 *  - Natural language prompts beat CSS selectors for resilience
 *  - Use act_get() with schemas for structured extraction
 */
export class ExecutionAgent extends BaseAgent {
  readonly type: AgentType = 'execution';
  private memory: MemoryManager;
  private runnerUrl: string;
  private jira: JiraConnector | null = null;
  private slack: SlackConnector | null = null;
  private gmail: GmailConnector | null = null;
  private hubspot: HubSpotConnector | null = null;
  private notion: NotionConnector | null = null;
  private knowledgeServiceUrl: string | null = null;

  constructor(config: {
    memory: MemoryManager;
    novaActApiKey?: string;
    automationRunnerUrl?: string;
  }) {
    super();
    this.memory = config.memory;
    this.runnerUrl =
      config.automationRunnerUrl ??
      process.env.AUTOMATION_RUNNER_URL ??
      'http://localhost:3003';

    if (process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN) {
      if (!process.env.JIRA_USER_EMAIL) {
        console.warn('[ExecutionAgent] JIRA_USER_EMAIL not set — Jira API calls will fail with 401.');
      }
      this.jira = new JiraConnector({
        baseUrl: process.env.JIRA_BASE_URL,
        email: process.env.JIRA_USER_EMAIL ?? '',
        apiToken: process.env.JIRA_API_TOKEN,
        projectKey: process.env.JIRA_PROJECT_KEY ?? 'TAL',
      });
    }
    if (process.env.SLACK_BOT_TOKEN) {
      this.slack = new SlackConnector({
        botToken: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
      });
    }
    if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN) {
      this.gmail = new GmailConnector({
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      });
    }
    if (process.env.HUBSPOT_API_KEY) {
      this.hubspot = new HubSpotConnector({ apiKey: process.env.HUBSPOT_API_KEY });
    }
    if (process.env.NOTION_API_KEY) {
      this.notion = new NotionConnector({ apiKey: process.env.NOTION_API_KEY });
    }

    // Optional semantic knowledge service (cross-tool vector index)
    // When configured, the planner can call knowledge_search to resolve
    // fuzzy natural-language references like "the product roadmap".
    this.knowledgeServiceUrl = process.env.KNOWLEDGE_SERVICE_URL ?? null;
  }

  async execute(task: AgentTask): Promise<unknown> {
    switch (task.action) {
      // ── Jira ──
      case 'jira_create_ticket':      return this.jiraCreateTicket(task);
      case 'jira_search':             return this.jiraSearch(task);
      case 'jira_update_ticket':      return this.jiraUpdateTicket(task);
      // ── Slack ──
      case 'slack_send_message':      return this.slackSendMessage(task);
      case 'slack_list_channels':     return this.slackListChannels(task);
      case 'slack_read_messages':     return this.slackReadMessages(task);
      case 'slack_reply_in_thread':   return this.slackReplyInThread(task);
      case 'slack_send_dm':           return this.slackSendDm(task);
      case 'slack_add_reaction':      return this.slackAddReaction(task);
      case 'slack_upload_file':       return this.slackUploadFile(task);
      // ── Gmail ──
      case 'gmail_send_email':        return this.gmailSendEmail(task);
      case 'gmail_search':            return this.gmailSearch(task);
      case 'gmail_read_email':        return this.gmailReadEmail(task);
      case 'gmail_reply':             return this.gmailReply(task);
      case 'gmail_modify_labels':     return this.gmailModifyLabels(task);
      // ── HubSpot ──
      case 'hubspot_create_contact':  return this.hubspotCreateContact(task);
      case 'hubspot_search_contacts': return this.hubspotSearchContacts(task);
      case 'hubspot_update_contact':  return this.hubspotUpdateContact(task);
      case 'hubspot_create_deal':     return this.hubspotCreateDeal(task);
      case 'hubspot_search_deals':    return this.hubspotSearchDeals(task);
      case 'hubspot_update_deal':     return this.hubspotUpdateDeal(task);
      case 'hubspot_log_activity':    return this.hubspotLogActivity(task);
      case 'hubspot_list_properties': return this.hubspotListProperties(task);
      case 'hubspot_search_objects':  return this.hubspotSearchObjects(task);
      // ── Notion ──
      case 'notion_search':           return this.notionSearch(task);
      case 'notion_read_page':        return this.notionReadPage(task);
      case 'notion_create_page':      return this.notionCreatePage(task);
      case 'notion_update_page':      return this.notionUpdatePage(task);
      case 'notion_append_block':     return this.notionAppendBlock(task);
      // ── Cross-tool knowledge index ──
      case 'knowledge_search':        return this.knowledgeSearch(task);
      // ── Browser automation actions (Nova Act) ──
      case 'open_app':   return this.openApp(task);
      case 'navigate':   return this.navigate(task);
      case 'click':      return this.click(task);
      case 'type':       return this.typeText(task);
      case 'select':     return this.select(task);
      case 'submit':     return this.submit(task);
      case 'extract':    return this.extract(task);
      case 'screenshot': return this.captureScreenshot(task);
      case 'wait':       return this.waitFor(task);
      default:
        throw new Error(`Unknown execution action: ${task.action}`);
    }
  }

  // ── Connector actions ─────────────────────────────────────────────────

  private async jiraCreateTicket(task: AgentTask): Promise<unknown> {
    if (!this.jira) return { error: 'Jira not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.jira.createTicket({
      summary: (p.summary as string) ?? (p.title as string) ?? 'Untitled',
      description: p.description as string | undefined,
      issueType: ((p.issueType as string) ?? 'Task') as 'Bug' | 'Task' | 'Story' | 'Epic',
      priority: p.priority as 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest' | undefined,
      labels: p.labels as string[] | undefined,
    });
    return { action: 'jira_create_ticket', ...result, status: 'created' };
  }

  private async jiraSearch(task: AgentTask): Promise<unknown> {
    if (!this.jira) return { error: 'Jira not configured', status: 'skipped' };
    const jql = (task.parameters.jql as string) ?? (task.parameters.query as string) ?? '';
    const results = await this.jira.searchTickets(jql);

    // When a query returns nothing, fetch all project tickets so the
    // summary can tell the user what's actually there instead of "nothing found".
    let allResults: typeof results | undefined;
    if (results.length === 0) {
      const projectMatch = jql.match(/project\s*=\s*([A-Z0-9_-]+)/i);
      const projectKey = projectMatch?.[1] ?? process.env.JIRA_PROJECT_KEY;
      if (projectKey) {
        const fallback = await this.jira.searchTickets(
          `project=${projectKey} ORDER BY updated DESC`
        );
        if (fallback.length > 0) allResults = fallback;
      }
    }

    return { action: 'jira_search', jql, results, count: results.length, allResults };
  }

  /**
   * Maps any free-form user intent string to a Jira statusCategory key.
   * This allows "start it", "wip", "working on", "finish", "reopen", etc. to work
   * without the planner needing to output exact Jira status names.
   */
  private resolveStatusIntent(input: string): {
    categoryKey: 'new' | 'indeterminate' | 'done' | null;
    aliases: string[];
  } {
    const s = input.toLowerCase().trim();

    // "done" category — closed/finished/resolved/won't fix/cancelled etc.
    if (/\b(done|clos|finish|complet|resolv|fix(ed)?|won.?t.?fix|cancel|archiv|deliver)\b/.test(s)) {
      return {
        categoryKey: 'done',
        aliases: ['done', 'closed', 'resolved', 'finished', 'complete', 'fixed', "won't fix", 'cancelled', 'archived'],
      };
    }

    // "indeterminate" category — in progress / started / working / review / testing etc.
    if (/\b(in.?progress|in.?review|start|begin|work(ing)?|doing|active|wip|develop|review|test(ing)?|pick.?up|assign)\b/.test(s)) {
      return {
        categoryKey: 'indeterminate',
        aliases: ['in progress', 'in development', 'in review', 'review', 'testing', 'started', 'active', 'wip'],
      };
    }

    // "new" category — to do / backlog / reopen / not started etc.
    if (/\b(to.?do|backlog|open|not.?start|todo|reopen|new|pending|unstart|queue|reset|undone)\b/.test(s)) {
      return {
        categoryKey: 'new',
        aliases: ['to do', 'backlog', 'open', 'new', 'pending', 'not started', 'todo'],
      };
    }

    return { categoryKey: null, aliases: [s] };
  }

  private async jiraUpdateTicket(task: AgentTask): Promise<unknown> {
    // Supports three modes:
    // 1) key / issueKey: update a single ticket
    // 2) keys: update multiple explicit tickets
    // 3) jql: search and update all matching tickets
    if (!process.env.JIRA_BASE_URL || !process.env.JIRA_API_TOKEN || !process.env.JIRA_USER_EMAIL) {
      return { error: 'Jira not configured', status: 'skipped' };
    }

    const explicitKeys = (task.parameters.keys as string[] | undefined)?.filter(Boolean) ?? [];
    let keys: string[] = [];

    if (explicitKeys.length > 0) {
      keys = explicitKeys;
    } else {
      const singleKey =
        (task.parameters.key as string | undefined) ??
        (task.parameters.issueKey as string | undefined);

      if (singleKey) {
        keys = [singleKey];
      } else if (task.parameters.jql && this.jira) {
        const searchResults = await this.jira.searchTickets(task.parameters.jql as string);
        keys = searchResults.map((r) => r.key);
      }
    }

    if (keys.length === 0) {
      throw new Error('jira_update_ticket requires a "key"/"keys" parameter or a "jql" query that selects issues');
    }

    const explicitStatus =
      (task.parameters.newStatus as string | undefined) ??
      (task.parameters.status as string | undefined) ??
      undefined;

    const baseUrl = process.env.JIRA_BASE_URL.replace(/\/+$/, '');
    const auth = Buffer.from(
      `${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`
    ).toString('base64');

    const results: Array<{
      key: string;
      status: 'updated' | 'skipped' | 'error';
      transitionId?: string;
      transitionName?: string;
      newStatus?: string;
      reason?: string;
      error?: string;
      availableTransitions?: Array<{ id: string; name: string; to?: string }>;
    }> = [];

    for (const key of keys) {
      try {
        // 1) Fetch available transitions for this issue
        const transitionsRes = await fetch(
          `${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
          {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Accept': 'application/json',
            },
          }
        );

        if (!transitionsRes.ok) {
          const text = await transitionsRes.text();
          results.push({
            key,
            status: 'error',
            error: `Failed to fetch transitions: HTTP ${transitionsRes.status} — ${text}`,
          });
          continue;
        }

        const transitionsJson = await transitionsRes.json() as {
          transitions?: Array<{ id: string; name: string; to?: { name?: string; statusCategory?: { key?: string } } }>;
        };

        const transitions = transitionsJson.transitions ?? [];

        type JiraTransition = { id: string; name: string; to?: { name?: string; statusCategory?: { key?: string } } };
        let target: JiraTransition | undefined;
        let effectiveStatus = explicitStatus;

        if (explicitStatus) {
          // 1. Try semantic intent resolution against statusCategory first (most reliable)
          const { categoryKey } = this.resolveStatusIntent(explicitStatus);

          if (categoryKey) {
            // Map our intent categories to Jira's internal statusCategory keys
            const jiraCategoryKey = categoryKey === 'indeterminate' ? 'indeterminate' : categoryKey;
            target = transitions.find((t) =>
              (t.to?.statusCategory?.key ?? '').toLowerCase() === jiraCategoryKey
            );
          }

          if (!target) {
            // 2. Try exact match on transition name or destination status name
            const desired = explicitStatus.toLowerCase();
            target = transitions.find((t) =>
              (t.name ?? '').toLowerCase() === desired ||
              (t.to?.name ?? '').toLowerCase() === desired
            );
          }

          if (!target) {
            // 3. Fuzzy alias match (e.g. "start it" → alias "in progress" → toName includes it)
            const { aliases: intentAliases } = this.resolveStatusIntent(explicitStatus);
            target = transitions.find((t) => {
              const toName = (t.to?.name ?? '').toLowerCase();
              const tName = (t.name ?? '').toLowerCase();
              return intentAliases.some((a) => toName.includes(a) || tName.includes(a));
            });
          }

          if (!target) {
            // 4. Partial substring match as last resort
            const desired = explicitStatus.toLowerCase();
            target = transitions.find((t) =>
              (t.name ?? '').toLowerCase().includes(desired) ||
              (t.to?.name ?? '').toLowerCase().includes(desired)
            );
          }
        } else {
          // No status specified — default to "done" category (close/resolve)
          const doneCandidates = transitions.filter((t) =>
            (t.to?.statusCategory?.key ?? '').toLowerCase() === 'done'
          );
          if (doneCandidates.length > 0) {
            target = doneCandidates[0];
          } else {
            const closeNames = ['done', 'closed', 'resolved'];
            target = transitions.find((t) => {
              const name = (t.name ?? '').toLowerCase();
              const toName = (t.to?.name ?? '').toLowerCase();
              return closeNames.includes(name) || closeNames.includes(toName);
            });
          }
          if (target) {
            effectiveStatus = target.to?.name ?? target.name ?? 'Done';
          }
        }

        if (!target) {
          results.push({
            key,
            status: 'skipped',
            reason: `No workflow transition found to reach a closed/done state${explicitStatus ? ` ("${explicitStatus}")` : ''}.`,
            availableTransitions: transitions.map((t) => ({
              id: t.id,
              name: t.name,
              to: t.to?.name,
            })),
          });
          continue;
        }

        // 2) Execute the transition
        const transitionRes = await fetch(
          `${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              transition: { id: target.id },
            }),
          }
        );

        if (!transitionRes.ok) {
          const text = await transitionRes.text();
          results.push({
            key,
            status: 'error',
            error: `Failed to update ticket: HTTP ${transitionRes.status} — ${text}`,
          });
          continue;
        }

        results.push({
          key,
          status: 'updated',
          transitionId: target.id,
          transitionName: target.name,
          newStatus: effectiveStatus ?? explicitStatus ?? 'Done',
        });
      } catch (err) {
        results.push({
          key,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const updated = results.filter((r) => r.status === 'updated').map((r) => r.key);

    return {
      action: 'jira_update_ticket',
      status: updated.length > 0 ? 'updated' : 'skipped',
      keys,
      updated,
      results,
      desiredStatus: explicitStatus,
    };
  }

  private async slackSendMessage(task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const p = task.parameters;
    const channel = (p.channel as string | undefined) ?? process.env.SLACK_DEFAULT_CHANNEL;
    if (!channel) throw new Error('Slack channel is required — planner must include a channel parameter in slack_send_message');
    const result = await this.slack.sendMessage({
      channel,
      text: (p.message as string) ?? (p.text as string) ?? '',
    });
    return { action: 'slack_send_message', channel, ...result, status: 'sent' };
  }

  private async slackListChannels(_task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const channels = await this.slack.listChannels();
    return { action: 'slack_list_channels', channels, count: channels.length };
  }

  private async slackReadMessages(task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const p = task.parameters;
    const channel = p.channel as string;
    if (!channel) throw new Error('Slack channel is required for slack_read_messages');
    
    // Convert channel name to ID if needed (though getChannelHistory assumes ID typically, 
    // slackSendMessage in execution-agent seems to handle names? Actually, Slack API needs IDs.
    // Wait, the connector doesn't resolve names to IDs automatically in getChannelHistory, 
    // but the system passes channel IDs if it can, or the prompt might pass exactly what to search.
    // Let's implement name-to-ID lookup like in slackSendMessage if it exists?
    // Wait, let's look at slackSendMessage first: it just passes `channel`. Slack chat.postMessage accepts names (like #general) or IDs.
    // But conversations.history REQUIRES a channel ID.
    
    // Let's resolve channel name to ID
    let channelId = channel;
    if (!channel.startsWith('C') && !channel.startsWith('G') && !channel.startsWith('D')) {
      const channels = await this.slack.listChannels();
      const match = channels.find(c => c.name === channel || c.name === channel.replace(/^#/, ''));
      if (match) {
        channelId = match.id;
      } else {
        throw new Error(`Channel ${channel} not found in workspace`);
      }
    }

    const messages = await this.slack.getChannelHistory({
      channel: channelId,
      limit: (p.limit as number) ?? 20,
    });
    return {
      action: 'slack_read_messages',
      channel: channelId,
      channelName: channel.startsWith('C') || channel.startsWith('G') || channel.startsWith('D') ? channelId : channel.replace(/^#/, ''),
      messages,
      count: messages.length
    };
  }


  private async slackReplyInThread(task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.slack.replyInThread({
      channel: p.channel as string,
      threadTs: (p.threadTs ?? p.thread_ts) as string,
      message: (p.message ?? p.text) as string,
    });
    return { action: 'slack_reply_in_thread', ...result, status: 'sent' };
  }

  private async slackSendDm(task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.slack.sendDm({
      userId: (p.userId ?? p.user) as string,
      message: (p.message ?? p.text) as string,
    });
    return { action: 'slack_send_dm', ...result, status: 'sent' };
  }

  private async slackAddReaction(task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.slack.addReaction({
      channel: p.channel as string,
      timestamp: (p.timestamp ?? p.ts) as string,
      emoji: p.emoji as string,
    });
    return { action: 'slack_add_reaction', ...result, status: 'added' };
  }

  private async slackUploadFile(task: AgentTask): Promise<unknown> {
    if (!this.slack) return { error: 'Slack not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.slack.uploadFile({
      channel: p.channel as string,
      filename: p.filename as string,
      content: (p.content ?? p.text ?? '') as string,
    });
    return { action: 'slack_upload_file', ...result, status: 'uploaded' };
  }

  // ── Gmail ─────────────────────────────────────────────────────────────────

  private async gmailSendEmail(task: AgentTask): Promise<unknown> {
    if (!this.gmail) return { error: 'Gmail not configured', status: 'skipped' };
    const p = task.parameters;
    const to = Array.isArray(p.to) ? p.to as string[] : [(p.to ?? p.email) as string];
    const result = await this.gmail.sendEmail({
      to,
      subject: p.subject as string,
      body: (p.body ?? p.message ?? p.content) as string,
      cc: p.cc as string[] | undefined,
      bcc: p.bcc as string[] | undefined,
    });
    return { action: 'gmail_send_email', ...result, status: 'sent' };
  }

  private async gmailSearch(task: AgentTask): Promise<unknown> {
    if (!this.gmail) return { error: 'Gmail not configured', status: 'skipped' };
    const p = task.parameters;
    const results = await this.gmail.searchEmails({
      query: (p.query ?? p.q) as string,
      maxResults: (p.maxResults ?? p.limit) as number | undefined,
    });
    return { action: 'gmail_search', results, count: results.length };
  }

  private async gmailReadEmail(task: AgentTask): Promise<unknown> {
    if (!this.gmail) return { error: 'Gmail not configured', status: 'skipped' };
    const p = task.parameters;
    if (!p.messageId && !p.id) throw new Error('messageId is required to read email');
    const result = await this.gmail.readEmail({ messageId: (p.messageId ?? p.id) as string });
    return { action: 'gmail_read_email', ...result };
  }

  private async gmailReply(task: AgentTask): Promise<unknown> {
    if (!this.gmail) return { error: 'Gmail not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.gmail.replyToEmail({
      threadId: p.threadId as string,
      inReplyToMessageId: (p.messageId ?? p.inReplyToMessageId) as string,
      to: p.to as string,
      subject: p.subject as string,
      body: (p.body ?? p.message ?? p.content) as string,
      cc: p.cc as string[] | undefined,
    });
    return { action: 'gmail_reply', ...result, status: 'sent' };
  }

  private async gmailModifyLabels(task: AgentTask): Promise<unknown> {
    if (!this.gmail) return { error: 'Gmail not configured', status: 'skipped' };
    const p = task.parameters;
    const messageIds = Array.isArray(p.messageIds) ? p.messageIds as string[] : [(p.messageId ?? p.id) as string];
    await this.gmail.modifyLabels({
      messageIds,
      addLabels: p.addLabels as string[] | undefined,
      removeLabels: p.removeLabels as string[] | undefined,
    });
    return { action: 'gmail_modify_labels', messageIds, status: 'updated' };
  }

  // ── HubSpot ───────────────────────────────────────────────────────────────

  private async hubspotCreateContact(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.hubspot.createContact({
      email: p.email as string,
      firstName: (p.firstName ?? p.firstname ?? '') as string,
      lastName: (p.lastName ?? p.lastname ?? '') as string,
      company: p.company as string | undefined,
      phone: p.phone as string | undefined,
      jobTitle: (p.jobTitle ?? p.job_title) as string | undefined,
    });
    return { action: 'hubspot_create_contact', ...result, status: 'created' };
  }

  private async hubspotSearchContacts(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const results = await this.hubspot.searchContacts((task.parameters.query ?? task.parameters.q) as string);
    return { action: 'hubspot_search_contacts', results, count: results.length };
  }

  private async hubspotUpdateContact(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.hubspot.updateContact({
      id: p.id as string,
      fields: {
        email: p.email as string | undefined,
        firstName: (p.firstName ?? p.firstname) as string | undefined,
        lastName: (p.lastName ?? p.lastname) as string | undefined,
        company: p.company as string | undefined,
        phone: p.phone as string | undefined,
        jobTitle: (p.jobTitle ?? p.job_title) as string | undefined,
      },
    });
    return { action: 'hubspot_update_contact', ...result, status: 'updated' };
  }

  private async hubspotCreateDeal(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.hubspot.createDeal({
      name: (p.name ?? p.dealname) as string,
      amount: p.amount as number | undefined,
      stage: (p.stage ?? p.dealstage) as string | undefined,
      pipeline: p.pipeline as string | undefined,
      closeDate: (p.closeDate ?? p.close_date) as string | undefined,
      contactId: (p.contactId ?? p.contact_id) as string | undefined,
    });
    return { action: 'hubspot_create_deal', ...result, status: 'created' };
  }

  private async hubspotSearchDeals(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const results = await this.hubspot.searchDeals((task.parameters.query ?? task.parameters.q) as string);
    return { action: 'hubspot_search_deals', results, count: results.length };
  }

  private async hubspotUpdateDeal(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.hubspot.updateDeal({
      id: p.id as string,
      fields: (p.fields ?? p.properties ?? {}) as Record<string, string | number>,
    });
    return { action: 'hubspot_update_deal', ...result, status: 'updated' };
  }

  private async hubspotLogActivity(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.hubspot.logActivity({
      note: (p.note ?? p.body ?? p.message ?? p.content) as string,
      dealId: (p.dealId ?? p.deal_id) as string | undefined,
      contactId: (p.contactId ?? p.contact_id) as string | undefined,
    });
    return { action: 'hubspot_log_activity', ...result, status: 'logged' };
  }

  private async hubspotListProperties(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const objectType = (task.parameters.objectType ?? task.parameters.object_type) as 'contacts' | 'deals';
    if (!objectType) throw new Error('hubspot_list_properties requires an objectType of "contacts" or "deals"');
    const properties = await this.hubspot.listProperties(objectType);
    return { action: 'hubspot_list_properties', objectType, properties, count: properties.length };
  }

  private async hubspotSearchObjects(task: AgentTask): Promise<unknown> {
    if (!this.hubspot) return { error: 'HubSpot not configured', status: 'skipped' };
    const objectType = (task.parameters.objectType ?? task.parameters.object_type) as 'contacts' | 'deals';
    const query = (task.parameters.query ?? task.parameters.q) as string;
    const properties = task.parameters.properties as string[] | undefined;
    const limit = (task.parameters.limit as number | undefined) ?? 20;
    if (!objectType) throw new Error('hubspot_search_objects requires an objectType of "contacts" or "deals"');
    if (!query) throw new Error('hubspot_search_objects requires a query string');

    const results = await this.hubspot.searchObjects({
      objectType,
      query,
      properties,
      limit,
    });
    return {
      action: 'hubspot_search_objects',
      objectType,
      query,
      properties,
      results,
      count: results.length,
    };
  }

  // ── Notion ────────────────────────────────────────────────────────────────

  private async notionSearch(task: AgentTask): Promise<unknown> {
    if (!this.notion) return { error: 'Notion not configured', status: 'skipped' };
    const results = await this.notion.search((task.parameters.query ?? task.parameters.q) as string);
    return { action: 'notion_search', results, count: results.length };
  }

  private async notionReadPage(task: AgentTask): Promise<unknown> {
    if (!this.notion) return { error: 'Notion not configured', status: 'skipped' };
    const p = task.parameters;
    let pageId = (p.pageId ?? p.id) as string | undefined;

    // If no pageId, search by query and read the first match
    if (!pageId) {
      const query = (p.query ?? p.title ?? p.name) as string | undefined;
      if (!query) throw new Error('notion_read_page requires either pageId or query');
      const searchResults = await this.notion.search(query);
      if (searchResults.length === 0) return { action: 'notion_read_page', error: `No Notion page found for query: "${query}"`, status: 'not_found' };
      pageId = searchResults[0].id;
    }

    const result = await this.notion.readPage({ pageId });
    return { action: 'notion_read_page', ...result };
  }

  private async notionCreatePage(task: AgentTask): Promise<unknown> {
    if (!this.notion) return { error: 'Notion not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.notion.createPage({
      title: p.title as string,
      content: (p.content ?? p.body ?? '') as string,
      parentId: (p.parentId ?? p.parent_id) as string | undefined,
    });
    return { action: 'notion_create_page', ...result, status: 'created' };
  }

  private async notionUpdatePage(task: AgentTask): Promise<unknown> {
    if (!this.notion) return { error: 'Notion not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.notion.updatePage({
      pageId: (p.pageId ?? p.page_id ?? p.id) as string,
      title: p.title as string | undefined,
      properties: p.properties as Record<string, unknown> | undefined,
      archived: p.archived as boolean | undefined,
    });
    return { action: 'notion_update_page', ...result, status: 'updated' };
  }

  private async notionAppendBlock(task: AgentTask): Promise<unknown> {
    if (!this.notion) return { error: 'Notion not configured', status: 'skipped' };
    const p = task.parameters;
    const result = await this.notion.appendBlock({
      blockId: (p.blockId ?? p.block_id ?? p.pageId ?? p.page_id ?? p.id) as string,
      content: (p.content ?? p.body ?? p.text ?? '') as string,
    });
    return { action: 'notion_append_block', ...result, status: 'appended' };
  }

  // ── Knowledge search (cross-tool semantic index) ──────────────────────────
  /**
   * Delegates to an external "knowledge-service" which indexes content from
   * Jira, Slack, Gmail, HubSpot, Notion, etc. The service is responsible for
   * using the official APIs (including HubSpot CRM v3 objects/properties)
   * when building its index so we stay aligned with vendor docs.
   *
   * Expected response shape from the service:
   *   { results: KnowledgeObject[] }
   *
   * Where KnowledgeObject is:
   *   {
   *     id: string;
   *     title: string;
   *     text: string;
   *     source: 'hubspot' | 'jira' | 'notion' | 'gmail' | 'slack' | 'custom';
   *     objectType: string;
   *     externalId?: string;
   *     url?: string;
   *     metadata?: Record<string, unknown>;
   *   }
   */
  private async knowledgeSearch(task: AgentTask): Promise<unknown> {
    const query = (task.parameters.query ?? task.parameters.q) as string;
    const limit = (task.parameters.limit as number | undefined) ?? 5;
    if (!query) throw new Error('knowledge_search requires a query string');

    // If an external knowledge service is configured, delegate to it so teams
    // can plug in a proper vector database or RAG stack.
    if (this.knowledgeServiceUrl) {
      const res = await fetch(this.knowledgeServiceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`knowledge_search HTTP ${res.status}${body ? ` — ${body}` : ''}`);
      }

      const data = await res.json() as { results?: unknown[] };
      const results = data.results ?? [];

      return {
        action: 'knowledge_search',
        query,
        results,
        count: Array.isArray(results) ? results.length : 0,
        status: 'ok',
        backend: 'external',
      };
    }

    // Built-in fallback: fan out the query across all configured connectors in
    // parallel, then merge in priority order (most doc-like → most structured):
    //   Notion → Jira → Gmail → HubSpot deals → HubSpot contacts
    //
    // Text is truncated to ~400 chars per result so the model receives focused
    // snippets rather than entire page/email dumps.
    const truncate = (text: string, max = 400): string =>
      text.length <= max ? text : text.slice(0, max).replace(/\s+\S*$/, '') + '…';

    const results: Array<Record<string, unknown>> = [];

    const [notionRes, jiraRes, gmailRes, hsDealsRes, hsContactsRes] = await Promise.allSettled([
      // Notion — roadmaps, specs, policies, meeting notes
      this.notion
        ? (async () => {
            const notion = this.notion!;
            const hits = await notion.search(query);
            const pages = await Promise.allSettled(
              hits.slice(0, limit).map((h) => notion.readPage({ pageId: h.id }))
            );
            return hits.slice(0, limit).map((h, i) => {
              const settled = pages[i];
              const page = settled.status === 'fulfilled' ? settled.value : null;
              return {
                title: page?.title ?? h.title ?? 'Untitled',
                text: truncate(page?.content ?? ''),
                source: 'notion',
                objectType: 'page',
                externalId: h.id,
                url: page?.url ?? h.url,
              };
            });
          })()
        : Promise.resolve([]),

      // Jira — tickets, bugs, stories: useful for "what's the status of X"
      this.jira
        ? (async () => {
            const tickets = await this.jira!.searchTickets(
              `project=${process.env.JIRA_PROJECT_KEY ?? 'KAN'} AND text ~ "${query.replace(/"/g, '')}" ORDER BY updated DESC`
            );
            return tickets.slice(0, limit).map((t) => ({
              title: `${t.key}: ${t.summary}`,
              text: truncate([
                t.status && `Status: ${t.status}`,
                t.priority && `Priority: ${t.priority}`,
                t.assignee && `Assignee: ${t.assignee}`,
                t.description,
              ].filter(Boolean).join(' · ')),
              source: 'jira',
              objectType: 'issue',
              externalId: t.key,
            }));
          })()
        : Promise.resolve([]),

      // Gmail — emails: useful for "find emails about the Acme renewal"
      this.gmail
        ? (async () => {
            const emails = await this.gmail!.searchEmails({ query, maxResults: limit });
            return emails.map((e) => ({
              title: e.subject || '(no subject)',
              text: truncate(e.snippet ?? ''),
              source: 'gmail',
              objectType: 'email',
              externalId: e.id,
            }));
          })()
        : Promise.resolve([]),

      // HubSpot deals — pipeline / revenue context
      this.hubspot
        ? (async () => {
            const deals = await this.hubspot!.searchDeals(query);
            return deals.slice(0, limit).map((d) => ({
              title: d.name || d.id,
              text: truncate([
                d.stage && `Stage: ${d.stage}`,
                d.amount && `Amount: $${d.amount}`,
                d.pipeline && `Pipeline: ${d.pipeline}`,
                d.closeDate && `Closes: ${d.closeDate.slice(0, 10)}`,
              ].filter(Boolean).join(' · ')),
              source: 'hubspot',
              objectType: 'deal',
              externalId: d.id,
            }));
          })()
        : Promise.resolve([]),

      // HubSpot contacts — people / accounts
      this.hubspot
        ? (async () => {
            const contacts = await this.hubspot!.searchContacts(query);
            return contacts.slice(0, limit).map((c) => ({
              title: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.id,
              text: truncate([
                c.email && `Email: ${c.email}`,
                c.company && `Company: ${c.company}`,
                c.jobTitle && `Title: ${c.jobTitle}`,
              ].filter(Boolean).join(' · ')),
              source: 'hubspot',
              objectType: 'contact',
              externalId: c.id,
            }));
          })()
        : Promise.resolve([]),
    ]);

    // Merge in priority order, stop once we have enough results
    for (const settled of [notionRes, jiraRes, gmailRes, hsDealsRes, hsContactsRes]) {
      if (settled.status === 'rejected') {
        console.warn('[ExecutionAgent] knowledge_search source failed:', settled.reason);
        continue;
      }
      for (const item of (settled as PromiseFulfilledResult<Array<Record<string, unknown>>>).value) {
        if (results.length >= limit) break;
        if (item.text || item.title) results.push(item);
      }
    }

    return {
      action: 'knowledge_search',
      query,
      results,
      count: results.length,
      status: 'ok',
      backend: 'inline',
    };
  }

  // ── Automation runner bridge ─────────────────────────────────────────────

  private async runAction(
    sessionId: string,
    action: Record<string, unknown>
  ): Promise<unknown> {
    try {
      const res = await fetch(`${this.runnerUrl}/sessions/${sessionId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
        signal: AbortSignal.timeout(60_000),
      });
      const data = await res.json() as { result?: unknown; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Runner HTTP ${res.status}`);
      return data.result;
    } catch (err) {
      // Automation runner unavailable — return stub so flow continues
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        return { ...action, status: 'simulated', note: 'automation-runner offline' };
      }
      throw err;
    }
  }

  // ── Action handlers ──────────────────────────────────────────────────────

  private async openApp(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['app']);
    const app = task.parameters.app as string;
    const url = (task.parameters.url as string | undefined) ?? `https://${app}.com`;

    // Ensure a browser session exists for this task
    await this.ensureSession(task.sessionId, url);
    return this.runAction(task.sessionId, { action: 'open_app', target: app, url });
  }

  private async navigate(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['url']);
    await this.ensureSession(task.sessionId, task.parameters.url as string);
    return this.runAction(task.sessionId, { action: 'navigate', url: task.parameters.url });
  }

  private async click(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['target']);
    return this.runAction(task.sessionId, {
      action: 'click',
      target: task.parameters.target,
      selector: task.parameters.selector,
    });
  }

  private async typeText(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['field', 'value']);
    return this.runAction(task.sessionId, {
      action: 'type',
      target: task.parameters.field,
      value: task.parameters.value,
    });
  }

  private async select(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['field', 'value']);
    return this.runAction(task.sessionId, {
      action: 'select',
      target: task.parameters.field,
      value: task.parameters.value,
    });
  }

  private async submit(task: AgentTask): Promise<unknown> {
    return this.runAction(task.sessionId, {
      action: 'submit',
      target: task.parameters.target,
    });
  }

  private async extract(task: AgentTask): Promise<unknown> {
    // Be defensive: planner sometimes omits target for extract steps.
    const target = (task.parameters.target as string | undefined)
      ?? (task.parameters.field as string | undefined)
      ?? null;

    if (!target) {
      // Log a warning — skipped extract may cause downstream tasks to receive null data
      console.warn(`[ExecutionAgent] extract action skipped for session ${task.sessionId}: no target parameter provided`);
      return {
        action: 'extract',
        status: 'skipped',
        reason: 'No target provided for extract action',
      };
    }

    return this.runAction(task.sessionId, {
      action: 'extract',
      target,
    });
  }

  private async captureScreenshot(task: AgentTask): Promise<unknown> {
    const result = await this.runAction(task.sessionId, { action: 'screenshot' });

    // Store snapshot in semantic memory for self-healing
    const snapshot: UISnapshot = {
      app: (task.parameters.app as string) ?? 'unknown',
      page: (task.parameters.page as string) ?? 'unknown',
      elements: [],
      capturedAt: Date.now(),
    };
    const snapshotId = await this.memory.storeUISnapshot(snapshot);
    return { ...(result as object), snapshotId };
  }

  private async waitFor(task: AgentTask): Promise<unknown> {
    this.validateTask(task, ['condition']);
    return this.runAction(task.sessionId, {
      action: 'wait',
      target: task.parameters.condition,
      timeout: task.parameters.timeout,
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async ensureSession(sessionId: string, startUrl: string): Promise<void> {
    try {
      await fetch(`${this.runnerUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, startUrl }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // Best-effort — runAction will handle the offline case
    }
  }

  getCapabilities(): AgentCapability[] {
    return [
      // ── Jira ──
      { name: 'jira_create_ticket', description: 'Create a Jira ticket', parameters: { summary: { type: 'string', description: 'Ticket summary', required: true }, description: { type: 'string', description: 'Description', required: false }, issueType: { type: 'string', description: 'Bug|Task|Story', required: false }, priority: { type: 'string', description: 'Highest|High|Medium|Low|Lowest', required: false }, labels: { type: 'array', description: 'Labels', required: false } } },
      { name: 'jira_search', description: 'Search Jira tickets using JQL', parameters: { jql: { type: 'string', description: 'JQL query', required: true } } },
      { name: 'jira_update_ticket', description: 'Transition Jira ticket(s) to a new status', parameters: { key: { type: 'string', description: 'Single issue key', required: false }, keys: { type: 'array', description: 'Array of issue keys', required: false }, jql: { type: 'string', description: 'JQL to select issues', required: false }, newStatus: { type: 'string', description: 'Target status intent e.g. Done, In Progress, To Do', required: false } } },
      // ── Slack ──
      { name: 'slack_send_message', description: 'Send a Slack message to a channel', parameters: { channel: { type: 'string', description: 'Channel name (no #)', required: true }, message: { type: 'string', description: 'Message text', required: true } } },
      { name: 'slack_list_channels', description: 'List available Slack channels', parameters: {} },
      { name: 'slack_read_messages', description: 'Read latest messages from a Slack channel', parameters: { channel: { type: 'string', description: 'Channel name (no #)', required: true }, limit: { type: 'number', description: 'Max messages to return', required: false } } },
      { name: 'slack_reply_in_thread', description: 'Reply to a Slack thread', parameters: { channel: { type: 'string', description: 'Channel name or ID', required: true }, threadTs: { type: 'string', description: 'Parent message timestamp', required: true }, message: { type: 'string', description: 'Reply text', required: true } } },
      { name: 'slack_send_dm', description: 'Send a Slack DM to a user', parameters: { userId: { type: 'string', description: 'Slack user ID', required: true }, message: { type: 'string', description: 'Message text', required: true } } },
      { name: 'slack_add_reaction', description: 'Add emoji reaction to a Slack message', parameters: { channel: { type: 'string', description: 'Channel ID', required: true }, timestamp: { type: 'string', description: 'Message timestamp', required: true }, emoji: { type: 'string', description: 'Emoji name without colons', required: true } } },
      { name: 'slack_upload_file', description: 'Upload a file to a Slack channel', parameters: { channel: { type: 'string', description: 'Channel name or ID', required: true }, filename: { type: 'string', description: 'Filename', required: true }, content: { type: 'string', description: 'File text content', required: true } } },
      // ── Gmail ──
      { name: 'gmail_send_email', description: 'Send an email via Gmail', parameters: { to: { type: 'array', description: 'Recipient addresses', required: true }, subject: { type: 'string', description: 'Subject line', required: true }, body: { type: 'string', description: 'Email body', required: true }, cc: { type: 'array', description: 'CC addresses', required: false }, bcc: { type: 'array', description: 'BCC addresses', required: false } } },
      { name: 'gmail_search', description: 'Search Gmail messages', parameters: { query: { type: 'string', description: 'Gmail search query', required: true }, maxResults: { type: 'number', description: 'Max results', required: false } } },
      { name: 'gmail_read_email', description: 'Read full email body', parameters: { messageId: { type: 'string', description: 'Message ID', required: true } } },
      { name: 'gmail_reply', description: 'Reply to a Gmail thread', parameters: { threadId: { type: 'string', description: 'Thread ID', required: true }, messageId: { type: 'string', description: 'Message-ID header value', required: true }, to: { type: 'string', description: 'Reply-to address', required: true }, subject: { type: 'string', description: 'Subject', required: true }, body: { type: 'string', description: 'Reply body', required: true } } },
      { name: 'gmail_modify_labels', description: 'Add or remove Gmail labels', parameters: { messageIds: { type: 'array', description: 'Message IDs', required: true }, addLabels: { type: 'array', description: 'Label IDs to add', required: false }, removeLabels: { type: 'array', description: 'Label IDs to remove', required: false } } },
      // ── HubSpot ──
      { name: 'hubspot_create_contact', description: 'Create a HubSpot contact', parameters: { email: { type: 'string', description: 'Email address', required: true }, firstName: { type: 'string', description: 'First name', required: false }, lastName: { type: 'string', description: 'Last name', required: false }, company: { type: 'string', description: 'Company', required: false } } },
      { name: 'hubspot_search_contacts', description: 'Search HubSpot contacts', parameters: { query: { type: 'string', description: 'Search query', required: true } } },
      { name: 'hubspot_update_contact', description: 'Update a HubSpot contact', parameters: { id: { type: 'string', description: 'Contact ID', required: true }, email: { type: 'string', description: 'Email', required: false }, firstName: { type: 'string', description: 'First name', required: false }, lastName: { type: 'string', description: 'Last name', required: false } } },
      { name: 'hubspot_create_deal', description: 'Create a HubSpot deal', parameters: { name: { type: 'string', description: 'Deal name', required: true }, amount: { type: 'number', description: 'Deal amount', required: false }, stage: { type: 'string', description: 'Deal stage', required: false }, pipeline: { type: 'string', description: 'Pipeline ID', required: false }, contactId: { type: 'string', description: 'Associated contact ID', required: false } } },
      { name: 'hubspot_search_deals', description: 'Search HubSpot deals', parameters: { query: { type: 'string', description: 'Search query', required: true } } },
      { name: 'hubspot_update_deal', description: 'Update a HubSpot deal', parameters: { id: { type: 'string', description: 'Deal ID', required: true }, fields: { type: 'object', description: 'HubSpot property key-value pairs', required: true } } },
      { name: 'hubspot_log_activity', description: 'Log a note on a HubSpot deal or contact', parameters: { note: { type: 'string', description: 'Note body', required: true }, dealId: { type: 'string', description: 'Deal ID', required: false }, contactId: { type: 'string', description: 'Contact ID', required: false } } },
      { name: 'hubspot_list_properties', description: 'List HubSpot CRM v3 properties for an object type, aligned with official HubSpot docs', parameters: { objectType: { type: 'string', description: '"contacts" or "deals"', required: true } } },
      { name: 'hubspot_search_objects', description: 'Generic HubSpot CRM object search using the official CRM v3 search endpoints', parameters: { objectType: { type: 'string', description: '"contacts" or "deals"', required: true }, query: { type: 'string', description: 'Free-text search query', required: true }, properties: { type: 'array', description: 'Optional list of property names to return', required: false }, limit: { type: 'number', description: 'Max results to return', required: false } } },
      // ── Notion ──
      { name: 'notion_search', description: 'Search Notion pages and databases — returns titles + IDs', parameters: { query: { type: 'string', description: 'Search query', required: true } } },
      { name: 'notion_read_page', description: 'Read full Notion page content — pass pageId if known, or query to search-and-read first match', parameters: { pageId: { type: 'string', description: 'Page ID', required: false }, query: { type: 'string', description: 'Search query to find page by title', required: false } } },
      { name: 'notion_create_page', description: 'Create a Notion page', parameters: { title: { type: 'string', description: 'Page title', required: true }, content: { type: 'string', description: 'Initial page content', required: false }, parentId: { type: 'string', description: 'Parent page ID', required: false } } },
      { name: 'notion_update_page', description: 'Update a Notion page title or properties', parameters: { pageId: { type: 'string', description: 'Page ID', required: true }, title: { type: 'string', description: 'New title', required: false }, archived: { type: 'boolean', description: 'Archive the page', required: false } } },
      { name: 'notion_append_block', description: 'Append text to a Notion page', parameters: { blockId: { type: 'string', description: 'Block or page ID', required: true }, content: { type: 'string', description: 'Text to append', required: true } } },
      // ── Knowledge index ──
      { name: 'knowledge_search', description: 'Search a cross-tool semantic index of Jira, Slack, Gmail, HubSpot, Notion, etc. Results are generic knowledge objects resolved via the official vendor APIs at index time.', parameters: { query: { type: 'string', description: 'Natural language query describing the concept or document, e.g. "TalOS product roadmap"', required: true }, limit: { type: 'number', description: 'Max results to return', required: false } } },
      // Browser automation actions (fallback — Nova Act)
      { name: 'open_app', description: 'Open a web application in the browser', parameters: { app: { type: 'string', description: 'Application name', required: true }, url: { type: 'string', description: 'Direct URL', required: false } } },
      { name: 'navigate', description: 'Navigate to a URL', parameters: { url: { type: 'string', description: 'Target URL', required: true } } },
      { name: 'click', description: 'Click a UI element via Nova Act natural language', parameters: { target: { type: 'string', description: 'Element label to click', required: true } } },
      { name: 'type', description: 'Type text into a field', parameters: { field: { type: 'string', description: 'Field name', required: true }, value: { type: 'string', description: 'Text to type', required: true } } },
      { name: 'select', description: 'Select from a dropdown', parameters: { field: { type: 'string', description: 'Dropdown name', required: true }, value: { type: 'string', description: 'Option to select', required: true } } },
      { name: 'submit', description: 'Submit the current form', parameters: {} },
      { name: 'extract', description: 'Extract text from the page', parameters: { target: { type: 'string', description: 'Element to read', required: true } } },
      { name: 'screenshot', description: 'Capture UI state and store in memory', parameters: { app: { type: 'string', description: 'App name', required: false } } },
      { name: 'wait', description: 'Wait for a condition', parameters: { condition: { type: 'string', description: 'What to wait for', required: true }, timeout: { type: 'number', description: 'Timeout ms', required: false } } },
    ];
  }
}
