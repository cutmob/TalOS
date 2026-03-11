import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export interface NovaSonicConfig {
  region: string;
  modelId: string;
  voice?: string;
  systemPrompt?: string;
}

export type SonicEventType = 'transcription' | 'audioOutput' | 'toolUse' | 'error' | 'completionEnd';

/**
 * Client for Amazon Nova 2 Sonic — real-time speech-to-speech AI.
 *
 * Model ID: amazon.nova-2-sonic-v1:0
 *
 * Uses HTTP/2 bidirectional event streaming via InvokeModelWithBidirectionalStream.
 * NOT WebSocket. NOT standard InvokeModel.
 *
 * Audio format:
 * - Input:  PCM 16-bit, 16kHz, mono, base64 encoded
 * - Output: PCM 16-bit, 24kHz, mono, base64 encoded
 *
 * Available voices:
 * - English US: tiffany (F), matthew (M)
 * - English GB: amy (F)
 * - French: ambre (F), florian (M)
 * - Spanish: lupe (F), carlos (M)
 * - German: greta (F), lennart (M)
 * - Italian: beatrice (F), lorenzo (M)
 *
 * Event flow:
 * 1. sessionStart → inference config
 * 2. promptStart → voice config, optional tool definitions
 * 3. contentStart (TEXT, SYSTEM) → system prompt
 * 4. textInput → system prompt text
 * 5. contentEnd → close system prompt
 * 6. contentStart (AUDIO, USER) → begin user audio stream
 * 7. audioInput → continuous PCM audio chunks (base64)
 * ...model responds with textOutput + audioOutput events...
 * 8. contentEnd → end audio
 * 9. promptEnd
 * 10. sessionEnd
 *
 * Ref: https://docs.aws.amazon.com/nova/latest/userguide/speech-bidirection.html
 * Ref: https://docs.aws.amazon.com/nova/latest/userguide/s2s-example.html
 * Ref: https://docs.aws.amazon.com/nova/latest/userguide/speech-tools-use.html
 */
export class NovaSonicClient extends EventEmitter {
  private client: BedrockRuntimeClient;
  private modelId: string;
  private voice: string;
  private systemPrompt: string;
  private sessionActive = false;
  private promptName = '';
  private audioContentName = '';

  constructor(config: NovaSonicConfig) {
    super();
    this.client = new BedrockRuntimeClient({ region: config.region });
    this.modelId = config.modelId;
    this.voice = config.voice ?? 'tiffany';
    this.systemPrompt = config.systemPrompt ??
      'You are TalOS, an AI operating system that runs software for users. ' +
      'You help users automate tasks across web applications like Jira, Slack, Gmail, and more. ' +
      'When users give you commands, acknowledge them and confirm what you will do.';
  }

  /**
   * Build the initialization event sequence per Nova Sonic protocol.
   * These events must be sent in order to establish a session.
   */
  buildSessionInitEvents(
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
  ): Array<Record<string, unknown>> {
    this.promptName = `prompt-${randomUUID()}`;
    this.audioContentName = `audio-${randomUUID()}`;
    const systemContentName = `system-${randomUUID()}`;

    const events: Array<Record<string, unknown>> = [
      // 1. sessionStart — inference parameters
      {
        event: {
          sessionStart: {
            inferenceConfiguration: {
              maxTokens: 1024,
              topP: 0.9,
              temperature: 0.7,
            },
          },
        },
      },
      // 2. promptStart — voice + tool config
      {
        event: {
          promptStart: {
            promptName: this.promptName,
            textOutputConfiguration: { mediaType: 'text/plain' },
            audioOutputConfiguration: {
              mediaType: 'audio/lpcm',
              sampleRateHertz: 24000,
              sampleSizeBits: 16,
              channelCount: 1,
              voiceId: this.voice,
              encoding: 'base64',
              audioType: 'SPEECH',
            },
            ...(tools && tools.length > 0 ? {
              toolUseOutputConfiguration: { mediaType: 'application/json' },
              toolConfiguration: {
                tools: tools.map((t) => ({
                  toolSpec: {
                    name: t.name,
                    description: t.description,
                    inputSchema: { json: JSON.stringify(t.inputSchema) },
                  },
                })),
              },
            } : {}),
          },
        },
      },
      // 3-5. System prompt
      {
        event: {
          contentStart: {
            promptName: this.promptName,
            contentName: systemContentName,
            type: 'TEXT',
            role: 'SYSTEM',
            interactive: false,
            textInputConfiguration: { mediaType: 'text/plain' },
          },
        },
      },
      {
        event: {
          textInput: {
            promptName: this.promptName,
            contentName: systemContentName,
            content: this.systemPrompt,
          },
        },
      },
      {
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName: systemContentName,
          },
        },
      },
      // 6. Begin user audio stream
      {
        event: {
          contentStart: {
            promptName: this.promptName,
            contentName: this.audioContentName,
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
      },
    ];

    this.sessionActive = true;
    return events;
  }

  /**
   * Build an audioInput event for streaming audio to Nova Sonic.
   * Audio must be PCM 16-bit, 16kHz, mono, base64 encoded.
   */
  buildAudioInputEvent(audioBase64: string): Record<string, unknown> {
    return {
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: audioBase64,
        },
      },
    };
  }

  /**
   * Build tool result events to send back to Nova Sonic after a toolUse event.
   * Returns 3 events: contentStart, toolResult, contentEnd.
   */
  buildToolResultEvents(
    toolUseId: string,
    result: Record<string, unknown>
  ): Array<Record<string, unknown>> {
    const toolContentName = `tool-result-${randomUUID()}`;

    return [
      {
        event: {
          contentStart: {
            promptName: this.promptName,
            contentName: toolContentName,
            interactive: false,
            type: 'TOOL',
            role: 'TOOL',
            toolResultInputConfiguration: {
              toolUseId,
              type: 'TEXT',
              textInputConfiguration: { mediaType: 'text/plain' },
            },
          },
        },
      },
      {
        event: {
          toolResult: {
            promptName: this.promptName,
            contentName: toolContentName,
            content: JSON.stringify(result),
          },
        },
      },
      {
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName: toolContentName,
          },
        },
      },
    ];
  }

  /**
   * Build the session teardown events.
   */
  buildEndSessionEvents(): Array<Record<string, unknown>> {
    this.sessionActive = false;
    return [
      { event: { contentEnd: { promptName: this.promptName, contentName: this.audioContentName } } },
      { event: { promptEnd: { promptName: this.promptName } } },
      { event: { sessionEnd: {} } },
    ];
  }

  /**
   * Parse an output event from the Nova Sonic response stream.
   * Returns a typed event object.
   */
  parseOutputEvent(event: Record<string, unknown>): {
    type: SonicEventType;
    data: Record<string, unknown>;
  } | null {
    if ((event as any).textOutput) {
      const textOutput = (event as any).textOutput;
      const content = textOutput.content ?? '';

      // Check for barge-in signal
      try {
        const parsed = JSON.parse(content);
        if (parsed.interrupted) return null;
      } catch { /* not JSON, normal text */ }

      return {
        type: 'transcription',
        data: { text: content, role: textOutput.role ?? 'ASSISTANT' },
      };
    }

    if ((event as any).audioOutput) {
      return {
        type: 'audioOutput',
        data: { audio: (event as any).audioOutput.content },
      };
    }

    if ((event as any).toolUse) {
      const tu = (event as any).toolUse;
      let input = tu.content;
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch { /* keep as string */ }
      }
      return {
        type: 'toolUse',
        data: { toolName: tu.toolName, toolUseId: tu.toolUseId, input },
      };
    }

    if ((event as any).completionEnd) {
      return { type: 'completionEnd', data: {} };
    }

    return null;
  }

  isActive(): boolean {
    return this.sessionActive;
  }

  getPromptName(): string {
    return this.promptName;
  }
}
