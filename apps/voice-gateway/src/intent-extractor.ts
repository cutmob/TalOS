export interface Intent {
  action: string;
  platform: string | null;
  content: string;
  isComplete: boolean;
  confidence: number;
  raw: string;
}

/**
 * Extracts structured intents from transcribed voice commands.
 *
 * Supported intent patterns:
 * - "create a [thing] in [app]"
 * - "schedule a [thing]"
 * - "send [thing] to [target]"
 * - "open [app]"
 * - "show me [thing]"
 * - "update [thing] in [app]"
 */
export class IntentExtractor {
  private readonly platformKeywords: Record<string, string[]> = {
    jira: ['jira', 'ticket', 'issue', 'bug', 'story', 'sprint'],
    slack: ['slack', 'channel', 'message', 'dm'],
    gmail: ['gmail', 'email', 'mail', 'send email'],
    calendar: ['calendar', 'meeting', 'schedule', 'event', 'appointment'],
    hubspot: ['hubspot', 'crm', 'contact', 'deal', 'campaign'],
    notion: ['notion', 'page', 'database', 'wiki'],
  };

  private readonly actionPatterns: Array<{ pattern: RegExp; action: string }> = [
    { pattern: /^(create|make|add|new)\b/i, action: 'create' },
    { pattern: /^(schedule|book|plan)\b/i, action: 'schedule' },
    { pattern: /^(send|post|share|notify)\b/i, action: 'send' },
    { pattern: /^(open|go to|show|launch)\b/i, action: 'open' },
    { pattern: /^(update|edit|change|modify)\b/i, action: 'update' },
    { pattern: /^(delete|remove|cancel)\b/i, action: 'delete' },
    { pattern: /^(find|search|look up|get)\b/i, action: 'search' },
  ];

  extract(text: string): Intent {
    const cleaned = text.trim().toLowerCase();

    // Strip wake word
    const withoutWake = cleaned
      .replace(/^(hey\s+)?operon[\s,]*/i, '')
      .trim();

    // Detect action
    let action = 'unknown';
    for (const { pattern, action: act } of this.actionPatterns) {
      if (pattern.test(withoutWake)) {
        action = act;
        break;
      }
    }

    // Detect platform
    let platform: string | null = null;
    for (const [name, keywords] of Object.entries(this.platformKeywords)) {
      if (keywords.some((kw) => withoutWake.includes(kw))) {
        platform = name;
        break;
      }
    }

    const isComplete = action !== 'unknown';

    return {
      action,
      platform,
      content: withoutWake,
      isComplete,
      confidence: isComplete ? 0.85 : 0.3,
      raw: text,
    };
  }
}
