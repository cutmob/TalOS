import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { NovaSonicClient } from './nova-sonic.js';
import { IntentExtractor } from './intent-extractor.js';

const server = Fastify({ logger: true });

async function start() {
  await server.register(websocket);

  const sonicConfig = {
    region: process.env.BEDROCK_REGION ?? 'us-east-1',
    modelId: process.env.NOVA_SONIC_MODEL_ID ?? 'amazon.nova-2-sonic-v1:0',
    voice: process.env.NOVA_SONIC_VOICE ?? 'tiffany',
  };

  const intentExtractor = new IntentExtractor();

  // TalOS tools that Nova Sonic can invoke via voice commands
  const talosTools = [
    {
      name: 'executeCommand',
      description: 'Execute a TalOS automation command',
      inputSchema: {
        type: 'object' as const,
        properties: {
          command: { type: 'string', description: 'The automation command to execute' },
          platform: { type: 'string', description: 'Target platform (jira, slack, gmail, etc.)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'getTaskStatus',
      description: 'Get the status of currently running automation tasks',
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [] as string[],
      },
    },
  ];

  // WebSocket endpoint for real-time voice streaming
  server.register(async (fastify) => {
    fastify.get('/ws/voice', { websocket: true }, (socket, request) => {
      server.log.info('Voice client connected');

      // Each connection gets its own Nova Sonic session
      const sonicClient = new NovaSonicClient(sonicConfig);
      const initEvents = sonicClient.buildSessionInitEvents(talosTools);

      // Send initialization protocol to client
      socket.send(JSON.stringify({
        type: 'session_init',
        events: initEvents,
        config: {
          inputFormat: 'audio/lpcm',
          inputSampleRate: 16000,
          inputSampleSize: 16,
          inputChannels: 1,
          inputEncoding: 'base64',
          outputSampleRate: 24000,
        },
      }));

      const apiServerUrl = process.env.API_SERVER_URL ?? 'http://localhost:3001';

      socket.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());

          switch (message.type) {
            case 'audio': {
              // Client sends base64 PCM audio chunks
              const audioEvent = sonicClient.buildAudioInputEvent(message.audio);
              socket.send(JSON.stringify({ type: 'bedrock_event', event: audioEvent }));
              break;
            }

            case 'transcription': {
              // Process transcription from Bedrock output stream
              const intent = intentExtractor.extract(message.text);
              socket.send(JSON.stringify({ type: 'intent', intent, timestamp: Date.now() }));

              if (intent.isComplete) {
                socket.send(JSON.stringify({ type: 'command', intent, timestamp: Date.now() }));
              }
              break;
            }

            case 'tool_use': {
              // Nova Sonic wants to call a tool — execute via the API server
              const { toolName, toolUseId, input } = message;
              let result: Record<string, unknown> = {};

              if (toolName === 'executeCommand') {
                try {
                  const res = await fetch(`${apiServerUrl}/api/tasks/submit`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ input: input.command, sessionId: `voice_${Date.now()}` }),
                    signal: AbortSignal.timeout(30_000),
                  });
                  result = await res.json() as Record<string, unknown>;
                  // Notify dashboard of the task
                  socket.send(JSON.stringify({ type: 'task_result', result }));
                } catch (err) {
                  result = { error: String(err), status: 'failed' };
                }
              } else if (toolName === 'getTaskStatus') {
                try {
                  const res = await fetch(`${apiServerUrl}/api/metrics`);
                  result = await res.json() as Record<string, unknown>;
                } catch {
                  result = { status: 'unknown' };
                }
              }

              // Send tool result back to Nova Sonic — it will speak the response
              const toolEvents = sonicClient.buildToolResultEvents(toolUseId, result);
              socket.send(JSON.stringify({ type: 'bedrock_events', events: toolEvents }));
              break;
            }

            case 'tool_result': {
              const toolEvents = sonicClient.buildToolResultEvents(message.toolUseId, message.result);
              socket.send(JSON.stringify({ type: 'bedrock_events', events: toolEvents }));
              break;
            }

            case 'end': {
              const endEvents = sonicClient.buildEndSessionEvents();
              socket.send(JSON.stringify({ type: 'session_end', events: endEvents }));
              break;
            }
          }
        } catch (err) {
          server.log.error({ err }, 'Voice processing error');
          socket.send(JSON.stringify({ type: 'error', message: 'Failed to process message' }));
        }
      });

      socket.on('close', () => {
        server.log.info('Voice client disconnected');
        if (sonicClient.isActive()) {
          sonicClient.buildEndSessionEvents();
        }
      });
    });
  });

  server.get('/health', async () => ({
    status: 'ok',
    service: 'talos-voice-gateway',
    model: sonicConfig.modelId,
    voice: sonicConfig.voice,
  }));

  const port = parseInt(process.env.VOICE_GATEWAY_PORT ?? '3002', 10);
  await server.listen({ port, host: '0.0.0.0' });
  server.log.info(`TalOS Voice Gateway running on port ${port}`);
}

start().catch((err) => {
  console.error('Failed to start voice gateway:', err);
  process.exit(1);
});
