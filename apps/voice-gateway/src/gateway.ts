import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load .env from monorepo root
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
let envDir = __dirname;
while (envDir !== resolve(envDir, '..')) {
  if (existsSync(resolve(envDir, '.env'))) break;
  envDir = resolve(envDir, '..');
}
dotenv.config({ path: resolve(envDir, '.env') });

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';

/** Loosely-typed Bedrock stream event — shape varies per event type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BedrockStreamEvent = Record<string, any>;

const server = Fastify({ logger: true });

const REGION = process.env.BEDROCK_REGION ?? 'us-east-1';
const MODEL_ID = process.env.NOVA_SONIC_MODEL_ID ?? 'amazon.nova-2-sonic-v1:0';
const VOICE = process.env.NOVA_SONIC_VOICE ?? 'tiffany';
const API_SERVER_URL = process.env.API_SERVER_URL ?? 'http://localhost:3001';

const SYSTEM_PROMPT =
  'You are TalOS — a voice-controlled AI operating system for enterprise software.\n\n' +
  'PERSONALITY: Professional, warm, extremely concise. No filler words. Never say "Certainly!", "Of course!", "Great question!", or "Sure thing!".\n\n' +
  'WHEN THE USER GIVES A COMMAND:\n' +
  '1. Call executeCommand immediately — do not describe what you are about to do, just do it.\n' +
  '2. After the tool returns, check the status:\n' +
  '   - If status is "clarification", speak the message naturally (e.g. "Which Slack channel should I use?").\n' +
  '   - If status is "ok", confirm in one short sentence: "Done — [summary]." or "[Action] complete."\n' +
  '   - If status is "failed", say: "[Action] failed — [brief reason]. Want me to try a different approach?"\n\n' +
  'MULTI-INTENT EXECUTION STRATEGY:\n' +
  '- PARALLEL (Independent actions): If the user asks for two independent things at once (e.g. "check my emails and check slack"), combine them into ONE executeCommand call (e.g. command: "check my emails and check slack"). This allows the backend to run them simultaneously.\n' +
  '- SEQUENTIAL (Dependent actions): If the user asks for steps in order (e.g. "create a ticket THEN notify slack"), do them turn-by-turn. Call executeCommand for step 1, read the result to the user, then call executeCommand for step 2.\n\n' +
  'WHEN THE USER IS AMBIGUOUS:\n' +
  '- If the app is inferable from context ("create a ticket" → Jira, "send a message" → Slack), execute immediately.\n' +
  '- If genuinely unclear, ask ONE short question only before calling the tool: "Jira ticket or Slack message?"\n\n' +
  'TARGET APP SELECTION:\n' +
  '- Mentions of ticket/bug/issue/story/sprint/backlog → targetApp: "jira"\n' +
  '- Mentions of message/channel/notify/dm/post → targetApp: "slack"\n' +
  '- Mentions of email/mail/send email → targetApp: "gmail"\n' +
  '- Mentions of contact/deal/crm/lead → targetApp: "hubspot"\n' +
  '- Mentions of page/doc/wiki/database/notion → targetApp: "notion"\n' +
  '- Web navigation or apps without a connector → targetApp: "browser"\n\n' +
  'EXAMPLES OF GOOD RESPONSES:\n' +
  '"Done — bug ticket PROJ-142 created in Jira."\n' +
  '"Message sent to the engineering channel."\n' +
  '"Which Slack channel should I check?"\n' +
  '"Ticket creation failed — project key not found. Want me to try a different project?"\n' +
  '"Jira or Slack?"\n\n' +
  'Do NOT explain the plan before executing. Do NOT add commentary after confirming. NEVER use a "#" prefix for Slack channels.';

const TALOS_TOOLS = [
  {
    toolSpec: {
      name: 'executeCommand',
      description:
        'Execute a TalOS automation command across enterprise tools (Jira, Slack, Gmail, HubSpot, Notion, or browser). ' +
        'Call this immediately when the user\'s intent is clear — do not wait or ask for confirmation first.',
      inputSchema: {
        json: JSON.stringify({
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description:
                'The user\'s automation intent in natural language. Be specific and include all relevant details. ' +
                'Examples: "create high-priority bug ticket: login page crashes on mobile Safari" | ' +
                '"send message to channel engineering: deployment to prod is complete" | ' +
                '"search Jira for all in-progress tickets assigned to me"',
            },
            targetApp: {
              type: 'string',
              enum: ['jira', 'slack', 'gmail', 'hubspot', 'notion', 'browser'],
              description:
                'The target enterprise application. Infer from the user\'s words: ' +
                'ticket/bug/issue/sprint → jira | message/channel/notify → slack | ' +
                'email/mail → gmail | contact/deal/crm → hubspot | page/doc/wiki → notion | ' +
                'everything else → browser',
            },
          },
          required: ['command', 'targetApp'],
        }),
      },
    },
  },
];

async function start() {
  await server.register(websocket);

  server.register(async (fastify) => {
    fastify.get('/ws/voice', { websocket: true }, (socket) => {
      server.log.info('Voice client connected');

      const bedrockClient = new BedrockRuntimeClient({ region: REGION });

      // Queue of events to send into Bedrock stream — fed by browser messages
      const inputQueue: Array<Record<string, unknown>> = [];
      let queueResolve: (() => void) | null = null;
      let sessionEnded = false;

      // Stable session ID for this WebSocket connection — reused across all tool calls
      // so the orchestrator maintains conversation history within a voice session.
      const voiceSessionId = `voice_${randomUUID()}`;

      // Names set during session init — needed when enqueuing audio events
      let promptName = '';
      let audioContentName = '';

      const enqueue = (event: Record<string, unknown>) => {
        inputQueue.push(event);
        queueResolve?.();
        queueResolve = null;
      };

      const encode = (event: Record<string, unknown>) => ({
        chunk: { bytes: Buffer.from(JSON.stringify(event)) },
      });

      // Async generator feeds events into the Bedrock bidirectional stream
      async function* inputStream() {
        promptName = `prompt-${randomUUID()}`;
        audioContentName = `audio-${randomUUID()}`;
        const systemContentName = `system-${randomUUID()}`;

        // 1. sessionStart
        yield encode({ event: { sessionStart: { inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 } } } });

        // 2. promptStart — voice + tools
        yield encode({
          event: {
            promptStart: {
              promptName,
              textOutputConfiguration: { mediaType: 'text/plain' },
              audioOutputConfiguration: {
                mediaType: 'audio/lpcm',
                sampleRateHertz: 24000,
                sampleSizeBits: 16,
                channelCount: 1,
                voiceId: VOICE,
                encoding: 'base64',
                audioType: 'SPEECH',
              },
              toolUseOutputConfiguration: { mediaType: 'application/json' },
              toolConfiguration: { tools: TALOS_TOOLS },
            },
          },
        });

        // 3-5. System prompt
        yield encode({ event: { contentStart: { promptName, contentName: systemContentName, type: 'TEXT', role: 'SYSTEM', interactive: false, textInputConfiguration: { mediaType: 'text/plain' } } } });
        yield encode({ event: { textInput: { promptName, contentName: systemContentName, content: SYSTEM_PROMPT } } });
        yield encode({ event: { contentEnd: { promptName, contentName: systemContentName } } });

        // 6. Begin user audio stream
        yield encode({
          event: {
            contentStart: {
              promptName,
              contentName: audioContentName,
              type: 'AUDIO',
              role: 'USER',
              interactive: true,
              audioInputConfiguration: {
                mediaType: 'audio/lpcm',
                sampleRateHertz: 16000,
                sampleSizeBits: 16,
                channelCount: 1,
                audioType: 'SPEECH',
                encoding: 'base64',
              },
            },
          },
        });

        // Signal browser that session is live
        socket.send(JSON.stringify({ type: 'ready' }));

        // Yield queued events (audio chunks + end sequence) as they arrive
        while (!sessionEnded) {
          while (inputQueue.length > 0) {
            yield encode(inputQueue.shift()!);
          }
          if (!sessionEnded) {
            await new Promise<void>((resolve) => { queueResolve = resolve; });
          }
        }
      }

      // Open the real Bedrock bidirectional stream
      const command = new InvokeModelWithBidirectionalStreamCommand({
        modelId: MODEL_ID,
        body: inputStream(),
      });

      bedrockClient.send(command).then(async (response) => {
        try {
          for await (const event of response.body ?? []) {
            const raw = event.chunk?.bytes;
            if (!raw) continue;

            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
            } catch (err) {
              server.log.warn({ err }, 'Skipping unparseable Bedrock stream chunk');
              continue;
            }

            const inner: BedrockStreamEvent = (parsed as BedrockStreamEvent).event ?? parsed;

            // Text transcript from Nova Sonic
            if (inner.textOutput) {
              const content: string = inner.textOutput.content ?? '';
              socket.send(JSON.stringify({ type: 'transcript', text: content, role: inner.textOutput.role }));
            }

            // Audio response — send PCM base64 to browser to play
            if (inner.audioOutput) {
              socket.send(JSON.stringify({ type: 'audio', audio: inner.audioOutput.content }));
            }

            // Tool use — Nova Sonic wants to execute a command
            if (inner.toolUse) {
              const { toolName, toolUseId, content } = inner.toolUse;
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(typeof content === 'string' ? content : JSON.stringify(content));
              } catch (err) {
                server.log.warn({ err, toolName, toolUseId }, 'Failed to parse tool input');
              }

              server.log.info({ toolName, toolUseId, input }, 'Nova Sonic tool use');
              socket.send(JSON.stringify({ type: 'tool_start', toolName, toolUseId }));

              let result: Record<string, unknown> = { status: 'ok' };

              if (toolName === 'executeCommand' && input.command) {
                try {
                  const res = await fetch(`${API_SERVER_URL}/api/tasks/stream`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input: input.command, targetApp: input.targetApp, sessionId: voiceSessionId }),
                    signal: AbortSignal.timeout(60_000),
                  });

                  const reader = res.body?.getReader();
                  const decoder = new TextDecoder();
                  let buf = '';
                  let evtType = '';
                  if (reader) {
                    while (true) {
                      const { done, value } = await reader.read();
                      if (done) break;
                      buf += decoder.decode(value, { stream: true });
                      const lines = buf.split('\n');
                      buf = lines.pop() ?? '';
                      for (const line of lines) {
                        if (line.startsWith('event: ')) { evtType = line.slice(7).trim(); }
                        else if (line.startsWith('data: ')) {
                          try {
                            const data = JSON.parse(line.slice(6));
                            if (evtType === 'progress') socket.send(JSON.stringify({ type: 'progress', ...data }));
                            if (evtType === 'result') result = data;
                          } catch (err) {
                            server.log.warn({ err }, 'Skipping malformed SSE line');
                          }
                          evtType = '';
                        }
                      }
                    }
                  }
                  socket.send(JSON.stringify({ type: 'task_result', result }));
                } catch (err) {
                  server.log.error({ err }, 'executeCommand failed');
                  result = { error: String(err), status: 'failed' };
                  socket.send(JSON.stringify({ type: 'task_result', result }));
                }
              }

              // Always return tool result to Nova Sonic so it can continue speaking.
              // Use voiceMessage (short, plain text) so Nova Sonic doesn't read out
              // full markdown documents or long lists verbatim.
              const r = result as BedrockStreamEvent;

              // If the orchestrator wants approval, tell Nova Sonic to ask the user
              // and include the approvalId so a follow-up voice command can approve.
              if (r.status === 'pending_approval' && r.approval) {
                const writeDescs = (r.approval.writeActions ?? [])
                  .map((w: BedrockStreamEvent) => w.description)
                  .join(', ');
                socket.send(JSON.stringify({ type: 'pending_approval', approvalId: r.approval.approvalId }));
                const approvalVoiceResult = {
                  status: 'pending_approval',
                  approvalId: r.approval.approvalId,
                  message: `I need your approval before proceeding. I would like to: ${writeDescs}. Should I go ahead?`,
                };
                const toolContentName = `tool-result-${randomUUID()}`;
                enqueue({ event: { contentStart: { promptName, contentName: toolContentName, interactive: false, type: 'TOOL', role: 'TOOL', toolResultInputConfiguration: { toolUseId, type: 'TEXT', textInputConfiguration: { mediaType: 'text/plain' } } } } });
                enqueue({ event: { toolResult: { promptName, contentName: toolContentName, content: JSON.stringify(approvalVoiceResult) } } });
                enqueue({ event: { contentEnd: { promptName, contentName: toolContentName } } });
                continue;
              }

              const voiceResult = {
                status: r.status ?? 'ok',
                message: r.voiceMessage ?? r.message ?? JSON.stringify(result),
              };
              const toolContentName = `tool-result-${randomUUID()}`;
              enqueue({ event: { contentStart: { promptName, contentName: toolContentName, interactive: false, type: 'TOOL', role: 'TOOL', toolResultInputConfiguration: { toolUseId, type: 'TEXT', textInputConfiguration: { mediaType: 'text/plain' } } } } });
              enqueue({ event: { toolResult: { promptName, contentName: toolContentName, content: JSON.stringify(voiceResult) } } });
              enqueue({ event: { contentEnd: { promptName, contentName: toolContentName } } });
            }

            if (inner.completionEnd) {
              socket.send(JSON.stringify({ type: 'completion_end' }));
            }
          }
        } catch (err) {
          server.log.error({ err }, 'Bedrock stream error');
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'error', message: String(err) }));
          }
        }
      }).catch((err) => {
        server.log.error({ err }, 'Failed to invoke Nova Sonic');
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'error', message: String(err) }));
        }
      });

      // Handle messages from browser
      socket.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'audio') {
            if (!promptName) return; // session not ready yet
            enqueue({ event: { audioInput: { promptName, contentName: audioContentName, content: msg.audio } } });
          }

          if (msg.type === 'end') {
            if (promptName) {
              enqueue({ event: { contentEnd: { promptName, contentName: audioContentName } } });
              enqueue({ event: { promptEnd: { promptName } } });
              enqueue({ event: { sessionEnd: {} } });
            }
            sessionEnded = true;
            queueResolve?.();
            queueResolve = null;
          }
        } catch (err) {
          server.log.error({ err }, 'Failed to parse browser message');
        }
      });

      socket.on('close', () => {
        server.log.info('Voice client disconnected');
        // Send proper closing sequence so Bedrock doesn't error on unclosed prompts
        if (promptName && !sessionEnded) {
          enqueue({ event: { contentEnd: { promptName, contentName: audioContentName } } });
          enqueue({ event: { promptEnd: { promptName } } });
          enqueue({ event: { sessionEnd: {} } });
        }
        sessionEnded = true;
        queueResolve?.();
        queueResolve = null;
      });
    });
  });

  server.get('/health', async () => ({
    status: 'ok',
    service: 'talos-voice-gateway',
    model: MODEL_ID,
    voice: VOICE,
  }));

  const port = parseInt(process.env.VOICE_GATEWAY_PORT ?? '3002', 10);
  await server.listen({ port, host: '0.0.0.0' });
  server.log.info(`TalOS Voice Gateway running on port ${port}`);
}

start().catch((err) => {
  console.error('Failed to start voice gateway:', err);
  process.exit(1);
});

// Graceful shutdown — close active WebSocket connections before exit
const shutdown = async (signal: string) => {
  server.log.info(`${signal} received — shutting down voice gateway`);
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
