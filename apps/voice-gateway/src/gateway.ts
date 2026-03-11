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

const server = Fastify({ logger: true });

const REGION = process.env.BEDROCK_REGION ?? 'us-east-1';
const MODEL_ID = process.env.NOVA_SONIC_MODEL_ID ?? 'amazon.nova-2-sonic-v1:0';
const VOICE = process.env.NOVA_SONIC_VOICE ?? 'tiffany';
const API_SERVER_URL = process.env.API_SERVER_URL ?? 'http://localhost:3001';

const SYSTEM_PROMPT =
  'You are TalOS, a voice-controlled AI operating system. ' +
  'Your only job is to listen for commands and execute them using the executeCommand tool. ' +
  'When the user speaks a command, immediately call executeCommand with their exact intent. ' +
  'Confirm in one short sentence what you did after execution. ' +
  'Do NOT explain settings, give advice, or add commentary. Just execute and confirm. ' +
  'STOP ASKING FOR CLARIFICATION. Pick the most sensible default and EXECUTE.';

const TALOS_TOOLS = [
  {
    toolSpec: {
      name: 'executeCommand',
      description: 'Execute a TalOS automation command across enterprise tools',
      inputSchema: {
        json: JSON.stringify({
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The automation command to execute' },
          },
          required: ['command'],
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
            } catch {
              continue;
            }

            const inner = (parsed as any).event ?? parsed;

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
              } catch { /* keep empty */ }

              server.log.info({ toolName, toolUseId, input }, 'Nova Sonic tool use');
              socket.send(JSON.stringify({ type: 'tool_start', toolName, toolUseId }));

              let result: Record<string, unknown> = { status: 'ok' };

              if (toolName === 'executeCommand' && input.command) {
                try {
                  const res = await fetch(`${API_SERVER_URL}/api/tasks/stream`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input: input.command, sessionId: `voice_${Date.now()}` }),
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
                          } catch { /* skip malformed line */ }
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

              // Always return tool result to Nova Sonic so it can continue speaking
              const toolContentName = `tool-result-${randomUUID()}`;
              enqueue({ event: { contentStart: { promptName, contentName: toolContentName, interactive: false, type: 'TOOL', role: 'TOOL', toolResultInputConfiguration: { toolUseId, type: 'TEXT', textInputConfiguration: { mediaType: 'text/plain' } } } } });
              enqueue({ event: { toolResult: { promptName, contentName: toolContentName, content: JSON.stringify(result) } } });
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
