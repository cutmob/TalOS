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
    service: 'operon-voice-gateway',
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
