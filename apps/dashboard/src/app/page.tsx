'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  // Jira
  jira_create_ticket:       'Created Jira ticket',
  jira_search:              'Searched Jira',
  jira_update_ticket:       'Updated Jira ticket',
  // Slack
  slack_send_message:       'Sent Slack message',
  slack_read_messages:      'Read Slack messages',
  slack_list_channels:      'Listed Slack channels',
  slack_reply_in_thread:    'Replied in thread',
  slack_send_dm:            'Sent direct message',
  slack_add_reaction:       'Added reaction',
  slack_upload_file:        'Uploaded file',
  // Gmail
  gmail_send_email:         'Sent email',
  gmail_search:             'Searched Gmail',
  gmail_read_email:         'Read email',
  gmail_reply:              'Replied to email',
  gmail_modify_labels:      'Updated email labels',
  // HubSpot
  hubspot_create_contact:   'Created HubSpot contact',
  hubspot_search_contacts:  'Searched HubSpot contacts',
  hubspot_update_contact:   'Updated HubSpot contact',
  hubspot_create_deal:      'Created HubSpot deal',
  hubspot_search_deals:     'Searched HubSpot deals',
  hubspot_update_deal:      'Updated HubSpot deal',
  hubspot_log_activity:     'Logged HubSpot activity',
  // Notion
  notion_search:            'Searched Notion',
  notion_read_page:         'Read Notion page',
  notion_create_page:       'Created Notion page',
  notion_update_page:       'Updated Notion page',
  notion_append_block:      'Appended to Notion page',
  // Browser
  open_app: 'Opened app', navigate: 'Navigated', click: 'Clicked',
  type: 'Typed', extract: 'Extracted data', screenshot: 'Took screenshot',
  // Agent ops
  recover: 'Recovered from error',
};

const MSG_TRUNC = 42;
function trunc(text: string): string {
  return text.length > MSG_TRUNC ? text.slice(0, MSG_TRUNC) + '…' : text;
}

function stripMd(text: string | undefined): string {
  if (!text) return '';
  return text
    .replace(/#{1,6}\s+/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/gs, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/\n{2,}/g, ' ')
    .trim();
}

function labelAction(action: string | undefined, taskId: string): string {
  if (!action) return taskId.replace(/_/g, ' ');
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaskResult {
  taskId: string;
  agentType: string;
  action?: string;
  status: 'success' | 'failure' | 'retry';
  output: unknown;
  duration: number;
  error?: string;
}

interface PendingStep {
  nodeId: string;
  action: string;
  agentType: string;
  status: 'running' | 'success' | 'failure';
}

interface TaskEntry {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  duration?: number;
  results?: TaskResult[];
  message?: string;
  progressLabel?: string;
  pendingSteps?: PendingStep[];
}

interface ApprovalPreviewNode {
  nodeId: string;
  action: string;
  category: 'read' | 'write';
  description: string;
  parameters: Record<string, unknown>;
}

interface PendingApprovalData {
  approvalId: string;
  sessionId: string;
  writeActions: ApprovalPreviewNode[];
  readActions: ApprovalPreviewNode[];
  originalInput: string;
  createdAt: number;
}

type AutonomyLevel = 'full' | 'write_approval' | 'all_approval';

interface ApprovalSettings {
  defaultLevel: AutonomyLevel;
  connectorOverrides: Partial<Record<string, AutonomyLevel>>;
}

interface Metrics {
  totalTasks: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  averageDuration: number;
}

// ── Greetings (50 total, by time of day) ──────────────────────────────────────

type Pair = [string, string];

const GREETINGS: Record<'morning' | 'afternoon' | 'evening' | 'night', Pair[]> = {
  morning: [
    ['Good morning —', 'the world runs on your words.'],
    ['Morning.', 'What would you like done?'],
    ['Rise and operate.', ''],
    ['Good morning.', 'Your software is waiting.'],
    ['Morning —', "let's make things happen."],
    ['Good morning.', 'Say the word.'],
    ['Morning.', 'What shall we automate?'],
    ['Good morning —', 'speak and it shall be done.'],
    ['A new morning.', 'A new set of tasks.'],
    ['Good morning.', 'Your AI is ready.'],
    ["You're up early.", 'So is TalOS.'],
    ['Morning —', "what's first on the list?"],
    ['Good morning.', "Let's move fast."],
  ],
  afternoon: [
    ['Good afternoon.', 'What can TalOS do for you?'],
    ['Afternoon —', 'still a lot of day left.'],
    ['Good afternoon.', 'Say the word.'],
    ["It's afternoon.", "Let's keep momentum."],
    ['Afternoon.', 'What would you like automated?'],
    ['Good afternoon —', 'your AI is listening.'],
    ['Afternoon.', "What's next?"],
    ['Good afternoon.', 'Speak and it shall be done.'],
    ['Midday.', 'What do you need done?'],
    ['Good afternoon.', 'The work continues.'],
    ['Afternoon.', "Let's move."],
    ['Good afternoon —', 'what are we doing today?'],
  ],
  evening: [
    ['Good evening.', 'What would you like wrapped up?'],
    ['Evening —', "let's finish strong."],
    ['Good evening.', 'TalOS is listening.'],
    ["It's evening.", "What's left to do?"],
    ['Evening.', 'Say the word.'],
    ['Good evening —', 'still getting things done.'],
    ['Evening.', 'What should we take care of?'],
    ['Good evening.', "Let's close out the day."],
    ["It's evening.", 'Your AI is ready.'],
    ['Evening —', 'what can we automate?'],
    ['Good evening.', "What's next?"],
    ['Evening.', "Let's wrap this up."],
    ['Good evening —', 'speak and it shall be done.'],
  ],
  night: [
    ['Working late?', "TalOS doesn't sleep."],
    ['Night mode.', 'What needs to get done?'],
    ['Late night.', 'TalOS is still with you.'],
    ['Burning the midnight oil?', 'Say the word.'],
    ['Night.', 'What would you like automated?'],
    ["It's late.", "Let's keep it moving."],
    ['Night shift.', 'TalOS is listening.'],
    ['Working late —', 'what can we do for you?'],
    ['Night.', 'Speak and it shall be done.'],
    ['The night is quiet.', 'Your AI is not.'],
    ['Late night.', 'Say the word.'],
    ['Night —', "what's next?"],
  ],
};

function pickGreeting(): Pair {
  const h = new Date().getHours();
  const pool =
    h >= 5 && h < 12 ? GREETINGS.morning :
    h >= 12 && h < 17 ? GREETINGS.afternoon :
    h >= 17 && h < 21 ? GREETINGS.evening :
    GREETINGS.night;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Voice plasma canvas ───────────────────────────────────────────────────────

function VoicePlasma({ active, size = 180, light = false }: { active: boolean; size?: number; light?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2;
    const s = size / 180;
    let t = 0, opacity = 0;

    // Orbs: orbit radius, angular speed, orb render size, phase, vertical wobble freq
    const ORBS = [
      { or: 28, sp: 0.9,  sz: 26, ph: 0,    wy: 0.6  },
      { or: 22, sp: -0.6, sz: 22, ph: 2.09, wy: 1.1  },
      { or: 32, sp: 0.4,  sz: 20, ph: 4.19, wy: 0.8  },
      { or: 16, sp: -1.3, sz: 18, ph: 1.05, wy: 1.4  },
      { or: 36, sp: 0.7,  sz: 16, ph: 3.14, wy: 0.5  },
    ];

    // Colors per mode
    const orbInner = light ? 'rgba(30,30,50,0.30)'   : 'rgba(255,255,255,0.30)';
    const orbOuter = light ? 'rgba(30,30,50,0)'      : 'rgba(255,255,255,0)';
    const coreIn   = light ? 'rgba(20,20,40,0.20)'   : 'rgba(255,255,255,0.20)';
    const coreOut  = light ? 'rgba(20,20,40,0)'      : 'rgba(255,255,255,0)';
    const blend    = light ? 'multiply' : 'screen';

    function drawOrb(x: number, y: number, r: number, inner: string, outer: string) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, inner);
      g.addColorStop(1, outer);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
    }

    function frame() {
      opacity += active ? 0.05 : -0.07;
      opacity = Math.max(0, Math.min(1, opacity));

      ctx.clearRect(0, 0, W, H);
      if (opacity > 0) {
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = blend as GlobalCompositeOperation;

        // Static core glow
        drawOrb(cx, cy, 32 * s, coreIn, coreOut);

        // Orbiting orbs
        for (const o of ORBS) {
          const angle = o.sp * t + o.ph;
          const wobble = Math.sin(o.wy * t + o.ph) * 8 * s;
          const ox = cx + o.or * s * Math.cos(angle);
          const oy = cy + o.or * s * Math.sin(angle) + wobble;
          const sz = o.sz * s * (1 + 0.18 * Math.sin(1.7 * o.sp * t + o.ph));
          drawOrb(ox, oy, sz, orbInner, orbOuter);
        }

        ctx.restore();
      }

      t += 0.018;
      rafRef.current = requestAnimationFrame(frame);
    }

    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [active, size, light]);

  return (
    <canvas ref={canvasRef} width={size} height={size} style={{
      position: 'absolute', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      pointerEvents: 'none',
      filter: `blur(${Math.round(size * 0.072)}px)`,
    }} />
  );
}

// ── Mic SVG icon ──────────────────────────────────────────────────────────────

function MicIcon({ size = 26, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <line x1="9" y1="21" x2="15" y2="21" />
    </svg>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [command, setCommand] = useState('');
  const [tasks, setTasks] = useState<TaskEntry[]>([]);

  const [_isVoiceConnected, setIsVoiceConnected] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [expandedMsgId, setExpandedMsgId] = useState<string | null>(null);
  const [micState, setMicState] = useState<'idle' | 'connecting' | 'listening'>('idle');
  const [greeting, setGreeting] = useState<Pair>(['', '']);
  const [miniMode, setMiniMode] = useState(false);
  const [lightMode, setLightMode] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApprovalData | null>(null);
  const [approvalSettings, setApprovalSettings] = useState<ApprovalSettings>({ defaultLevel: 'write_approval', connectorOverrides: {} });
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState(false);
  useEffect(() => { setGreeting(pickGreeting()); }, []);

  // Stable session ID for the entire browser session — persists across tasks
  const sessionIdRef = useRef<string>(`session_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(0);
  const taskHistoryRef = useRef<TaskEntry[]>([]);
  const pendingTaskIdRef = useRef<string | null>(null);
  // Track when each agent dot was activated so we can enforce a minimum visible duration
  const agentActivatedAtRef = useRef<Map<string, number>>(new Map());
  // Track the active voice task so progress events can attach to it
  const voiceTaskIdRef = useRef<string | null>(null);
  // Track transcript source to prevent voice textOutput from overwriting task result markdown.
  // When set to 'result', voice transcript text is suppressed so the markdown stays visible
  // until the user's next voice input clears it.
  const transcriptSourceRef = useRef<'voice' | 'result' | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  // Poll /api/metrics every 5s
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/metrics');
        if (res.ok) setMetrics(await res.json());
      } catch { /* api may not be up yet */ }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // Load autonomy settings on mount
  useEffect(() => {
    const load = async () => {
      try {
        const apiBase = process.env.NEXT_PUBLIC_API_SERVER_URL ?? '';
        const res = await fetch(`${apiBase}/api/approvals/settings`);
        if (res.ok) setApprovalSettings(await res.json());
      } catch { /* api may not be up yet */ }
    };
    load();
  }, []);

  // Keep history ref in sync (tasks array is the source of truth)
  useEffect(() => { taskHistoryRef.current = tasks; }, [tasks]);

  // Auto-scroll transcript to bottom when content changes
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  // Timeout stuck running tasks after 60s
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTasks((prev) => prev.map((t) => {
        if (t.status !== 'running') return t;
        if (now - t.startedAt > 60_000) {
          return { ...t, status: 'failed' as const, completedAt: now, duration: now - t.startedAt, message: 'Timed out' };
        }
        return t;
      }));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // ── Voice output ─────────────────────────────────────────────────────────

  // Shared AudioContext + next-chunk scheduler for glitch-free PCM playback
  const sonicCtxRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);

  const playPCM24k = useCallback((b64: string) => {
    try {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const pcm16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

      // Reuse single AudioContext — create lazily
      if (!sonicCtxRef.current || sonicCtxRef.current.state === 'closed') {
        sonicCtxRef.current = new AudioContext({ sampleRate: 24000 });
        nextPlayTimeRef.current = 0;
      }
      const ctx = sonicCtxRef.current;

      const buf = ctx.createBuffer(1, float32.length, 24000);
      buf.copyToChannel(float32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);

      // Schedule chunks sequentially — no gaps, no overlaps
      const startAt = Math.max(ctx.currentTime, nextPlayTimeRef.current);
      src.start(startAt);
      nextPlayTimeRef.current = startAt + buf.duration;
    } catch { /* audio decode error — ignore */ }
  }, []);

  // ── Submit command ────────────────────────────────────────────────────────

  const submitCommand = useCallback(async (text?: string) => {
    const input = (text ?? command).trim();
    if (!input) return;

    // New command — clear the result lock so transcript updates normally
    transcriptSourceRef.current = null;

    const isContinuing = !!pendingTaskIdRef.current;
    const taskId = pendingTaskIdRef.current ?? `task_${Date.now()}`;
    const startedAt = Date.now();
    pendingTaskIdRef.current = null; // Consume the pending state

    setTasks((prev) => {
      if (isContinuing) {
        // Update the existing task in place
        return prev.map((t) => t.id === taskId ? {
          ...t,
          command: `${t.command}\n> ${input}`,
          status: 'running',
          progressLabel: 'planning',
          pendingSteps: [],
        } : t);
      }
      // Prepend a new task
      return [{ id: taskId, command: input, status: 'running', startedAt, progressLabel: 'planning', pendingSteps: [] }, ...prev];
    });

    setCommand('');
    activeRef.current += 1;
    setActiveAgents(new Set(['orchestrator']));

    const updateTask = (patch: Partial<TaskEntry>) => {
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, ...patch } : t));
    };

    const updatePendingStep = (nodeId: string, patch: Partial<PendingStep>) => {
      setTasks((prev) => prev.map((t) => {
        if (t.id !== taskId) return t;
        const steps = (t.pendingSteps ?? []).map((s) => s.nodeId === nodeId ? { ...s, ...patch } : s);
        return { ...t, pendingSteps: steps };
      }));
    };

    // Set true when result event fires — tells finally not to wipe agents
    // (the result handler's setTimeout handles the flash + clear itself)
    let resultReceived = false;

    try {
      const apiBase = process.env.NEXT_PUBLIC_API_SERVER_URL ?? '';
      const res = await fetch(`${apiBase}/api/tasks/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, sessionId: sessionIdRef.current }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // SSE parser: accumulate chunks, split on double-newline event boundaries
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Each SSE event ends with \n\n
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? ''; // last partial event stays in buffer

        for (const rawEvent of events) {
          let evtType = '';
          let evtData = '';
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            else if (line.startsWith('data: ')) evtData = line.slice(6).trim();
          }
          if (!evtType || !evtData) continue;

          let parsed: Record<string, unknown>;
          try { parsed = JSON.parse(evtData); } catch { continue; }

          if (evtType === 'progress') {
            const phase = parsed.phase as string;
            const action = parsed.action as string | undefined;
            const agentType = parsed.agentType as string | undefined;
            const nodeId = parsed.nodeId as string | undefined;
            const status = parsed.status as string | undefined;

            if (phase === 'planning') {
              setActiveAgents((prev) => new Set([...prev, 'orchestrator']));
              updateTask({ progressLabel: 'planning' });

            } else if (phase === 'executing' && nodeId && agentType) {
              // Light up the correct agent dot, add a live step entry
              const agent = visualAgent(action, agentType);
              agentActivatedAtRef.current.set(agent, Date.now());
              setActiveAgents((prev) => new Set([...prev, 'orchestrator', agent]));
              updateTask({ progressLabel: labelAction(action, nodeId) });
              setTasks((prev) => prev.map((t) => {
                if (t.id !== taskId) return t;
                const alreadyExists = (t.pendingSteps ?? []).some((s) => s.nodeId === nodeId);
                if (alreadyExists) return t;
                return {
                  ...t,
                  pendingSteps: [...(t.pendingSteps ?? []), {
                    nodeId,
                    action: action ?? nodeId,
                    agentType,
                    status: 'running' as const,
                  }],
                };
              }));

            } else if (phase === 'node_complete' && nodeId) {
              updatePendingStep(nodeId, { status: status === 'success' ? 'success' : 'failure' });
              const completedAgent = visualAgent(action, agentType);

              // Enforce minimum 2s visibility so dots don't flash invisibly fast
              const activatedAt = agentActivatedAtRef.current.get(completedAgent) ?? 0;
              const elapsed = Date.now() - activatedAt;
              const minVisible = 2000;
              const remainingDelay = Math.max(minVisible - elapsed, 300);

              // Recompute active agents: keep orchestrator + still-running agents + completed (for now)
              setActiveAgents(() => {
                const current = taskHistoryRef.current.find((tt) => tt.id === taskId);
                const stillRunning = (current?.pendingSteps ?? []).filter(
                  (s) => s.nodeId !== nodeId && s.status === 'running'
                );
                const next = new Set<string>(['orchestrator']);
                for (const s of stillRunning) {
                  next.add(visualAgent(s.action, s.agentType));
                }
                next.add(completedAgent);
                return next;
              });

              // Remove completed agent after remaining minimum-visibility delay
              setTimeout(() => {
                setActiveAgents((prev) => {
                  const updated = new Set(prev);
                  const latest = taskHistoryRef.current.find((tt) => tt.id === taskId);
                  const stillActive = (latest?.pendingSteps ?? []).some(
                    (s) => s.status === 'running' && visualAgent(s.action, s.agentType) === completedAgent
                  );
                  if (!stillActive) updated.delete(completedAgent);
                  return updated;
                });
              }, remainingDelay);
            }

          } else if (evtType === 'result') {
            resultReceived = true;
            const result = parsed as {
              status?: string;
              message?: string;
              results?: TaskResult[];
              approval?: PendingApprovalData;
            };
            const duration = Date.now() - startedAt;
            const isClarification = result.status === 'clarification';
            const isPendingApproval = result.status === 'pending_approval';
            const ok = isClarification || isPendingApproval || (result.results?.every((r) => r.status === 'success') ?? result.status === 'completed');
            const summary = result.message ?? (ok ? 'Done.' : 'Some tasks failed.');

            transcriptSourceRef.current = 'result';
            setTranscript(summary);

            // Approval gate — store pending approval for the approval card
            if (isPendingApproval && result.approval) {
              const approval = result.approval as PendingApprovalData;
              setPendingApproval(approval);
            }

            // Merge result agents into existing active set (don't overwrite progress state).
            // Then fade out after a generous delay so users actually see what ran.
            const resultAgents = (result.results ?? []).map((r) => visualAgent(r.action as string | undefined, r.agentType as string | undefined));
            setActiveAgents((prev) => {
              const merged = new Set(prev);
              merged.add('orchestrator');
              for (const a of resultAgents) merged.add(a);
              return merged;
            });
            // Graceful fade-out: keep dots visible for 2.5s after completion
            setTimeout(() => setActiveAgents(new Set()), 2500);

            if (isClarification || isPendingApproval) {
              pendingTaskIdRef.current = taskId;
            } else {
              pendingTaskIdRef.current = null;
            }

            const patch: Partial<TaskEntry> = {
              status: (isClarification || isPendingApproval) ? 'running' : ok ? 'completed' : 'failed',
              completedAt: (isClarification || isPendingApproval) ? undefined : Date.now(),
              duration: (isClarification || isPendingApproval) ? undefined : duration,
              results: result.results,
              message: summary,
            };
            if (!isClarification && !isPendingApproval) patch.pendingSteps = undefined;
            updateTask(patch);

          } else if (evtType === 'error') {
            pendingTaskIdRef.current = null; // Clear on error
            throw new Error((parsed.message as string) ?? 'Stream error');
          }
        }
      }
    } catch (err) {
      pendingTaskIdRef.current = null; // Clear on error
      updateTask({
        status: 'failed',
        completedAt: Date.now(),
        duration: Date.now() - startedAt,
        message: String(err),
        pendingSteps: undefined,
      });
    } finally {
      activeRef.current -= 1;
      // Don't wipe agents here if a result was received — the result handler's
      // setTimeout(clear, 1500) owns the flash. Without this guard, finally runs
      // immediately after the stream closes and kills the dots before they flash.
      if (activeRef.current === 0 && !resultReceived) setActiveAgents(new Set());
    }
  }, [command]);

  // ── PCM helpers ───────────────────────────────────────────────────────────

  const resampleTo16k = (buf: Float32Array, srcRate: number): Float32Array => {
    if (srcRate === 16000) return buf;
    const ratio = srcRate / 16000;
    const out = new Float32Array(Math.round(buf.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = buf[Math.round(i * ratio)] ?? 0;
    return out;
  };

  const floatToPCM16 = (buf: Float32Array): Int16Array => {
    const pcm = new Int16Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      const s = Math.max(-1, Math.min(1, buf[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
  };

  const toBase64 = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  // ── Voice WebSocket ───────────────────────────────────────────────────────

  const connectVoiceWS = useCallback((): WebSocket => {
    const voiceUrl = process.env.NEXT_PUBLIC_VOICE_GATEWAY_URL
      ?? `ws://${window.location.hostname}:3002`;
    const ws = new WebSocket(`${voiceUrl}/ws/voice`);
    wsRef.current = ws;
    ws.onopen = () => { /* wait for 'ready' before marking live */ };
    ws.onclose = () => { setIsVoiceConnected(false); setMicState('idle'); wsRef.current = null; };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
        // Session ready — Bedrock init complete, browser can now send audio
        if (msg.type === 'ready') { setIsVoiceConnected(true); setMicState('listening'); }
        // Nova Sonic speaking — play PCM audio
        if (msg.type === 'audio' && msg.audio) playPCM24k(msg.audio as string);
        // Live transcript — role=USER is the user speaking, role=ASSISTANT is Nova's spoken reply.
        // When a rich markdown result is showing (transcriptSourceRef === 'result'):
        //   - USER transcript: clear the lock — user is starting a new command, show what they're saying
        //   - ASSISTANT transcript: suppress — user already sees the markdown, no need for voice text
        if (msg.type === 'transcript' && msg.text) {
          const role = msg.role as string | undefined;
          if (role === 'USER') {
            // User is speaking again — unlock and show their input
            transcriptSourceRef.current = 'voice';
            setTranscript(msg.text as string);
          } else if (transcriptSourceRef.current !== 'result') {
            // Assistant transcript, but no markdown result showing — display it
            transcriptSourceRef.current = 'voice';
            setTranscript(msg.text as string);
          }
          // else: Assistant transcript while markdown is showing — suppress
        }
        // Real-time progress from voice gateway — light up agent dots as steps execute
        if (msg.type === 'progress') {
          const phase = msg.phase as string;
          const action = msg.action as string | undefined;
          const agentType = msg.agentType as string | undefined;
          const nodeId = msg.nodeId as string | undefined;
          const status = msg.status as string | undefined;

          // Create a running voice task entry on first progress event
          if (!voiceTaskIdRef.current) {
            const id = `voice_${Date.now()}`;
            voiceTaskIdRef.current = id;
            setTasks((prev) => [{
              id,
              command: transcript || 'Voice command',
              status: 'running',
              startedAt: Date.now(),
              progressLabel: 'planning',
              pendingSteps: [],
            }, ...prev]);
          }

          const taskId = voiceTaskIdRef.current;

          if (phase === 'planning') {
            setActiveAgents((prev) => new Set([...prev, 'orchestrator']));
          } else if (phase === 'executing' && nodeId && agentType) {
            const agent = visualAgent(action, agentType);
            agentActivatedAtRef.current.set(agent, Date.now());
            setActiveAgents((prev) => new Set([...prev, 'orchestrator', agent]));
            setTasks((prev) => prev.map((t) => {
              if (t.id !== taskId) return t;
              const alreadyExists = (t.pendingSteps ?? []).some((s) => s.nodeId === nodeId);
              if (alreadyExists) return t;
              return {
                ...t,
                progressLabel: labelAction(action, nodeId),
                pendingSteps: [...(t.pendingSteps ?? []), {
                  nodeId,
                  action: action ?? nodeId,
                  agentType: agentType,
                  status: 'running' as const,
                }],
              };
            }));
          } else if (phase === 'node_complete' && nodeId) {
            // Update step status
            setTasks((prev) => prev.map((t) => {
              if (t.id !== taskId) return t;
              const steps = (t.pendingSteps ?? []).map((s) =>
                s.nodeId === nodeId ? { ...s, status: (status === 'success' ? 'success' : 'failure') as PendingStep['status'] } : s
              );
              return { ...t, pendingSteps: steps };
            }));

            const completedAgent = visualAgent(action, agentType);
            const activatedAt = agentActivatedAtRef.current.get(completedAgent) ?? 0;
            const elapsed = Date.now() - activatedAt;
            const remainingDelay = Math.max(2000 - elapsed, 300);

            setTimeout(() => {
              setActiveAgents((prev) => {
                const updated = new Set(prev);
                updated.delete(completedAgent);
                return updated;
              });
            }, remainingDelay);
          }
        }

        // Nova Sonic executed a command via tool use — show it in task feed
        if (msg.type === 'task_result') {
          const result = msg.result as {
            message?: string;
            status?: string;
            results?: TaskResult[];
          };

          if (result?.message) {
            transcriptSourceRef.current = 'result';
            setTranscript(result.message);
          }

          const now = Date.now();
          const ok =
            result.results?.every((r) => r.status === 'success') ??
            result.status === 'completed';

          if (voiceTaskIdRef.current) {
            // Finalize the task entry created by progress events
            const taskId = voiceTaskIdRef.current;
            voiceTaskIdRef.current = null;
            setTasks((prev) => prev.map((t) => t.id !== taskId ? t : {
              ...t,
              status: ok ? 'completed' : 'failed',
              completedAt: now,
              duration: now - t.startedAt,
              results: result.results as TaskResult[] | undefined,
              message: result.message,
              pendingSteps: undefined,
            }));
          } else {
            // No progress events were received — create a completed entry directly
            setTasks((prev) => [{
              id: `voice_${now}`,
              command: transcript || 'Voice command',
              status: ok ? 'completed' : 'failed',
              startedAt: now,
              completedAt: now,
              duration: 0,
              results: result.results as TaskResult[] | undefined,
              message: result.message,
            }, ...prev]);
          }

          // Flash remaining agent dots from results then clear
          if (result?.results && result.results.length > 0) {
            const types = new Set<string>(result.results.map((r) => visualAgent(r.action as string | undefined, r.agentType)));
            types.add('orchestrator');
            setActiveAgents(types);
            setTimeout(() => setActiveAgents(new Set()), 1500);
          } else {
            setTimeout(() => setActiveAgents(new Set()), 500);
          }
        }
        // Voice approval — show the approval card when voice gateway sends pending_approval
        if (msg.type === 'pending_approval' && msg.approvalId) {
          // Fetch full approval details from the API so the card can render write/read actions
          const apiBase = process.env.NEXT_PUBLIC_API_SERVER_URL ?? '';
          fetch(`${apiBase}/api/approvals/${msg.approvalId}`)
            .then((r) => r.ok ? r.json() : null)
            .then((data) => {
              if (data) setPendingApproval(data as PendingApprovalData);
            })
            .catch(() => { /* approval card won't show — voice can still approve */ });
        }

        // Voice approval resolved — dismiss the approval card
        if (msg.type === 'approval_resolved') {
          setPendingApproval(null);
          setApprovalLoading(false);
        }

        if (msg.type === 'error' && msg.message) console.error('Voice error:', typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message));
      } catch { /* ignore */ }
    };
    return ws;
  }, [submitCommand, playPCM24k]);

  // ── Mic start / stop ──────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: { ideal: 16000 } },
      });
      streamRef.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      const srcRate = ctx.sampleRate;
      await ctx.audioWorklet.addModule('/pcm-processor.js');
      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, 'pcm-processor');
      processorRef.current = worklet;
      setMicState('connecting');
      const ws = connectVoiceWS();
      worklet.port.onmessage = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const raw = e.data as Float32Array;
        const pcm = floatToPCM16(resampleTo16k(raw, srcRate));
        ws.send(JSON.stringify({ type: 'audio', audio: toBase64(pcm.buffer as ArrayBuffer) }));
      };
      source.connect(worklet);
      worklet.connect(ctx.destination);
      // micState transitions to 'listening' when Bedrock sends 'ready'
    } catch {
      setMicState('idle');
      alert('Microphone access denied. Please allow mic permissions and try again.');
    }
  }, [connectVoiceWS]);

  const stopListening = useCallback(() => {
    processorRef.current?.disconnect();
    audioCtxRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    wsRef.current?.send(JSON.stringify({ type: 'end' }));
    wsRef.current?.close();
    processorRef.current = null;
    audioCtxRef.current = null;
    streamRef.current = null;
    wsRef.current = null;
    setIsVoiceConnected(false);
    setMicState('idle');
    setTranscript('');
    transcriptSourceRef.current = null;
    sonicCtxRef.current?.close();
    sonicCtxRef.current = null;
    nextPlayTimeRef.current = 0;
  }, []);

  // ── Approval actions ─────────────────────────────────────────────────────

  const handleApprove = useCallback(async () => {
    if (!pendingApproval) return;
    setApprovalLoading(true);
    try {
      const apiBase = process.env.NEXT_PUBLIC_API_SERVER_URL ?? '';
      const res = await fetch(`${apiBase}/api/approvals/${pendingApproval.approvalId}/approve`, { method: 'POST' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      // Parse SSE stream from approval execution
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const rawEvent of events) {
          let evtType = '';
          let evtData = '';
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            else if (line.startsWith('data: ')) evtData = line.slice(6).trim();
          }
          if (!evtType || !evtData) continue;
          try {
            const data = JSON.parse(evtData);
            if (evtType === 'result') {
              transcriptSourceRef.current = 'result';
              setTranscript(data.message ?? 'Done.');
              // Update the task entry
              const taskId = pendingTaskIdRef.current;
              if (taskId) {
                setTasks((prev) => prev.map((t) => t.id === taskId ? {
                  ...t,
                  status: data.results?.every((r: TaskResult) => r.status === 'success') ? 'completed' : 'failed',
                  completedAt: Date.now(),
                  duration: Date.now() - t.startedAt,
                  results: data.results,
                  message: data.message,
                  pendingSteps: undefined,
                } : t));
                pendingTaskIdRef.current = null;
              }
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      setTranscript(`Approval failed: ${err}`);
    } finally {
      setPendingApproval(null);
      setApprovalLoading(false);
    }
  }, [pendingApproval]);

  const handleReject = useCallback(async () => {
    if (!pendingApproval) return;
    setApprovalLoading(true);
    try {
      const apiBase = process.env.NEXT_PUBLIC_API_SERVER_URL ?? '';
      await fetch(`${apiBase}/api/approvals/${pendingApproval.approvalId}/reject`, { method: 'POST' });
      transcriptSourceRef.current = 'result';
      setTranscript('Action cancelled — no changes were made.');
      const taskId = pendingTaskIdRef.current;
      if (taskId) {
        setTasks((prev) => prev.map((t) => t.id === taskId ? {
          ...t, status: 'failed', completedAt: Date.now(), duration: Date.now() - t.startedAt, message: 'Rejected by user',
        } : t));
        pendingTaskIdRef.current = null;
      }
    } finally {
      setPendingApproval(null);
      setApprovalLoading(false);
    }
  }, [pendingApproval]);

  const updateAutonomySetting = useCallback(async (patch: Partial<ApprovalSettings>) => {
    const apiBase = process.env.NEXT_PUBLIC_API_SERVER_URL ?? '';
    const res = await fetch(`${apiBase}/api/approvals/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) setApprovalSettings(await res.json());
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  // Map backend agentType + action to the correct visual agent dot.
  // If the backend explicitly says 'research' or 'recovery', trust that.
  // For 'execution' nodes, visually distinguish reads (research) from writes (execution).
  const visualAgent = (action: string | undefined, backendAgent?: string): string => {
    if (backendAgent && backendAgent !== 'execution' && backendAgent !== 'orchestrator') {
      return backendAgent; // trust backend for research, recovery, etc.
    }
    if (!action) return backendAgent || 'execution';
    const reads = [
      'jira_search', 'gmail_search', 'gmail_read_email',
      'slack_read_messages', 'slack_list_channels',
      'hubspot_search_contacts', 'hubspot_search_deals', 'hubspot_search_objects',
      'hubspot_list_properties', 'notion_search', 'notion_read_page', 'knowledge_search',
      'gmail_search_contacts',
    ];
    return reads.includes(action) ? 'research' : backendAgent || 'execution';
  };

  const fmtMs = (ms?: number) =>
    ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  const isProcessing = activeAgents.size > 0 || tasks.some((t) => t.status === 'running');

  // Speed up background video while processing
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = isProcessing ? 2 : 1;
    }
  }, [isProcessing]);

  const visibleTasks = tasks.filter((t) => {
    if (t.status === 'running') return true;
    if (!t.completedAt) return true;
    return Date.now() - t.completedAt < 6000;
  });

  // Real-time status from backend progress events
  const TaskStatus = ({ taskId }: { taskId: string }) => {
    const task = tasks.find((t) => t.id === taskId);
    const label = task?.progressLabel ?? 'thinking';
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span className="task-spinner" />
        <span style={{ fontSize: '0.62rem', letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</span>
      </span>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────────

  // True light-mode palette — no CSS filter trickery, proper colors throughout
  const t = lightMode ? {
    // Backgrounds
    bg:          '#f2f2f2',
    bgPanel:     '#ffffff',
    bgMini:      'rgba(245,245,245,0.96)',
    // Text
    text1:       '#111111',   // primary / greeting line 1
    text2:       '#c0c0c0',   // greeting line 2 / muted
    text3:       '#888888',   // secondary labels
    textFaint:   '#d8d8d8',   // very faint (metrics, placeholder ghost)
    // Borders
    border1:     '#e2e2e2',
    border2:     '#d0d0d0',
    // Agent dots
    dotOff:      '#dddddd',   // inactive — barely visible on light bg
    dotTextOff:  '#d0d0d0',
    dotOn:       '#111111',   // active — bold dark
    dotGlow:     '#11111130',
    dotTextOn:   '#111111',
    // Logo
    logoRing1:   '#aaaaaa',
    logoRing2:   '#cccccc',
    logoCore:    '#777777',
    logoTal:     '#111111',
    logoOS:      '#aaaaaa',
    // Mic
    micBorderIdle:      '#cccccc',
    micBorderActive:    '#777777',
    micBorderConnecting:'#e0e0e0',
    micBorderProcess:   '#cccccc80',
    micColor:           '#888888',
    micColorActive:     '#333333',
    // Transcript
    transcriptText:  '#555555',
    mdStrong:        '#111111',
    mdHeading:       '#222222',
    mdCode:          '#f0f0f0',
    mdCodeText:      '#333333',
    // Input
    inputBorder:  '#e0e0e0',
    inputText:    '#444444',
    inputCaret:   '#666666',
    // Tasks
    taskTextRun:     '#111111',
    taskTextDone:    '#999999',
    taskBorderRun:   '#aaaaaa',
    taskBorderDone:  '#dddddd',
    taskBorderFail:  '#f0cccc',
    taskStepFail:    '#cc8888',
    taskMsg:         '#777777',
    // Panel
    panelBg:         '#fafafa',
    panelBorder:     '#e8e8e8',
    panelLabel:      '#bbbbbb',
    panelClear:      '#bbbbbb',
    // Chevron / controls
    chevron:     '#bbbbbb',
    iconBtn:     '#cccccc',
    // Video
    videoOpacity: 0.07,
    videoBlend:   'multiply' as const,
  } : {
    bg:          'transparent',
    bgPanel:     '#0a0a0a',
    bgMini:      'rgba(8,8,8,0.92)',
    text1:       '#e8e8e8',
    text2:       '#383838',
    text3:       '#555555',
    textFaint:   '#2a2a2a',
    border1:     '#1a1a1a',
    border2:     '#1e1e1e',
    dotOff:      '#1e1e1e',
    dotTextOff:  '#2a2a2a',
    dotOn:       '#909090',
    dotGlow:     '#90909060',
    dotTextOn:   '#909090',
    logoRing1:   '#606060',
    logoRing2:   '#404040',
    logoCore:    '#808080',
    logoTal:     '#e8e8e8',
    logoOS:      '#707070',
    micBorderIdle:      '#222222',
    micBorderActive:    '#555555',
    micBorderConnecting:'#2a2a2a',
    micBorderProcess:   '#55555580',
    micColor:           '#555555',
    micColorActive:     '#aaaaaa',
    transcriptText:  '#a0a0a0',
    mdStrong:        '#e0e0e0',
    mdHeading:       '#e0e0e0',
    mdCode:          '#1a1a1a',
    mdCodeText:      'inherit',
    inputBorder:  '#1a1a1a',
    inputText:    '#888888',
    inputCaret:   '#888888',
    taskTextRun:     '#e8e8e8',
    taskTextDone:    '#555555',
    taskBorderRun:   '#666666',
    taskBorderDone:  '#3a3a3a',
    taskBorderFail:  '#3a1a1a',
    taskStepFail:    '#6a3a3a',
    taskMsg:         '#606060',
    panelBg:         '#0a0a0a',
    panelBorder:     '#1a1a1a',
    panelLabel:      '#333333',
    panelClear:      '#333333',
    chevron:     '#333333',
    iconBtn:     '#282828',
    videoOpacity: 0.04,
    videoBlend:   'normal' as const,
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      fontWeight: 300,
      background: t.bg,
      color: t.text1,
      transition: 'background 0.3s, color 0.3s',
    }}>
      <style>{`
        .md-scroll::-webkit-scrollbar { display: none; }
        @keyframes expandRing {
          0%   { transform: scale(1);   opacity: 0.5; }
          100% { transform: scale(2.8); opacity: 0;   }
        }
        @keyframes processRing {
          0%, 100% { opacity: 0.15; transform: scale(1);    }
          50%       { opacity: 0.35; transform: scale(1.12); }
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0; }
        }
        @keyframes spin {
          0%   { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .task-spinner {
          display: inline-block;
          width: 10px; height: 10px;
          border: 1.5px solid #333;
          border-top-color: #888;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }
        /* Liquid glass mic button */
        .mic-btn {
          backdrop-filter: blur(16px) saturate(160%) brightness(1.04);
          -webkit-backdrop-filter: blur(16px) saturate(160%) brightness(1.04);
        }
        .mic-throbber {
          display: inline-block;
          width: 18px; height: 18px;
          border-radius: 50%;
          border: 1.5px solid #2a2a2a;
          border-top-color: #555;
          animation: spin 0.9s linear infinite;
        }
        /* Liquid mist rings — morph in place, no outward wave */
        @keyframes mistA {
          0%   { opacity: 0.5;  transform: scale(1.02); }
          28%  { opacity: 0.78; transform: scale(1.05); }
          62%  { opacity: 0.22; transform: scale(1.01); }
          100% { opacity: 0.5;  transform: scale(1.02); }
        }
        @keyframes mistB {
          0%   { opacity: 0.22; transform: scale(1.12); }
          40%  { opacity: 0.5;  transform: scale(1.16); }
          100% { opacity: 0.22; transform: scale(1.12); }
        }
        @keyframes mistC {
          0%   { opacity: 0.1;  transform: scale(1.26); }
          50%  { opacity: 0.26; transform: scale(1.3);  }
          100% { opacity: 0.1;  transform: scale(1.26); }
        }
        @keyframes processMist {
          0%, 100% { opacity: 0.18; transform: scale(1.08); }
          50%       { opacity: 0.36; transform: scale(1.12); }
        }
        .mist-ring {
          position: absolute;
          width: 72px; height: 72px;
          border-radius: 50%;
          border-width: 1px;
          border-style: solid;
          pointer-events: none;
          filter: url(#liquid-filter);
        }
        .mist-ring-a { animation: mistA 3.2s ease-in-out infinite; }
        .mist-ring-b { animation: mistB 4.5s ease-in-out infinite 0.7s; }
        .mist-ring-c { animation: mistC 5.8s ease-in-out infinite 1.4s; }
        .process-mist {
          position: absolute;
          width: 90px; height: 90px;
          border-radius: 50%;
          border: 1px solid;
          animation: processMist 2.2s ease-in-out infinite;
          pointer-events: none;
          filter: url(#liquid-filter);
        }
        @keyframes greetFade {
          0%   { opacity: 0; transform: translateY(8px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .greeting-line {
          opacity: 0;
          animation: greetFade 0.6s ease-out forwards;
        }
        @keyframes slideUp {
          0%   { transform: translateY(100%); }
          100% { transform: translateY(0); }
        }
      `}</style>

      {/* ── SVG liquid filter (referenced by mist rings) ── */}
      <svg style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }} aria-hidden="true">
        <defs>
          <filter id="liquid-filter" x="-30%" y="-30%" width="160%" height="160%">
            <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="4" result="noise">
              <animate attributeName="baseFrequency" values="0.014;0.022;0.016;0.014" dur="7s" repeatCount="indefinite" />
              <animate attributeName="seed" values="4;11;7;4" dur="14s" repeatCount="indefinite" />
            </feTurbulence>
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </defs>
      </svg>

      {/* ── Background video ── */}
      <video
        ref={videoRef}
        autoPlay
        muted
        loop
        playsInline
        style={{
          position: 'fixed',
          top: 0, left: 0,
          width: '100%', height: '100%',
          objectFit: 'cover',
          opacity: t.videoOpacity,
          mixBlendMode: t.videoBlend,
          zIndex: 0,
          pointerEvents: 'none',
          transition: 'opacity 0.4s',
        }}
      >
        <source src="/bg.mp4" type="video/mp4" />
      </video>

      {/* ── Content (above video) ── */}
      <div style={{ position: 'relative', zIndex: 1, display: 'contents' }}>

      {/* ── Top bar ── */}
      <header style={{
        padding: '1.5rem 2rem',
        display: miniMode ? 'none' : 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {/* Logo mark — precision gear */}
          {(() => {
            const cx = 12, cy = 12, ro = 10, ri = 7.4, teeth = 10;
            const step = (Math.PI * 2) / teeth;
            const hw = step * 0.26;
            let d = '';
            for (let i = 0; i < teeth; i++) {
              const base = i * step - Math.PI / 2;
              const a1 = base - hw, a2 = base + hw;
              const a3 = base + step - hw;
              const x1 = cx + ro * Math.cos(a1), y1 = cy + ro * Math.sin(a1);
              const x2 = cx + ro * Math.cos(a2), y2 = cy + ro * Math.sin(a2);
              const x3 = cx + ri * Math.cos(a2), y3 = cy + ri * Math.sin(a2);
              const x4 = cx + ri * Math.cos(a3), y4 = cy + ri * Math.sin(a3);
              d += `${i === 0 ? 'M' : 'L'}${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} L${x3.toFixed(2)} ${y3.toFixed(2)} L${x4.toFixed(2)} ${y4.toFixed(2)} `;
            }
            d += 'Z';
            return (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d={d} fill={t.logoCore} stroke={t.logoRing1} strokeWidth="0.5" strokeLinejoin="round" />
                <circle cx={cx} cy={cy} r="4.2" fill="none" stroke={t.logoRing2} strokeWidth="1.2" />
                <circle cx={cx} cy={cy} r="1.4" fill={t.logoRing1} />
              </svg>
            );
          })()}
          <span style={{ fontSize: '1.05rem', fontWeight: 600, letterSpacing: '0.04em', color: t.logoTal }}>
            Tal<span style={{ color: t.logoOS }}>OS</span>
          </span>
        </div>

        {/* Agent status dots */}
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {(['orchestrator', 'research', 'execution', 'recovery'] as const).map((name) => {
            const on = activeAgents.has(name);
            return (
              <span key={name} title={name} style={{
                display: 'flex', alignItems: 'center', gap: '0.3rem',
                fontSize: '0.65rem', color: on ? t.dotTextOn : t.dotTextOff,
                transition: 'color 0.3s',
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: on ? t.dotOn : t.dotOff,
                  display: 'inline-block',
                  transition: 'background 0.3s',
                  boxShadow: on ? `0 0 6px ${t.dotGlow}` : 'none',
                }} />
                {name}
              </span>
            );
          })}
          {metrics && metrics.totalTasks > 0 && (
            <span style={{ fontSize: '0.65rem', color: t.textFaint, marginLeft: '0.75rem', letterSpacing: '0.04em' }}>
              {metrics.totalTasks} tasks · {Math.round(metrics.successRate * 100)}%
            </span>
          )}
          {/* Light mode toggle */}
          <button
            onClick={() => setLightMode((v) => !v)}
            aria-label="Toggle light mode"
            title="Toggle light mode"
            style={{
              background: 'transparent', border: 'none',
              color: t.iconBtn,
              cursor: 'pointer', padding: '4px', outline: 'none',
              display: 'flex', alignItems: 'center', marginLeft: '0.25rem',
              transition: 'color 0.2s',
            }}
          >
            {lightMode ? (
              /* moon */
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            ) : (
              /* sun */
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            )}
          </button>
          {/* Mini mode toggle */}
          <button
            onClick={() => setMiniMode(true)}
            aria-label="Compact mode"
            title="Compact mode"
            style={{
              background: 'transparent', border: 'none', color: t.iconBtn,
              cursor: 'pointer', padding: '4px', outline: 'none',
              display: 'flex', alignItems: 'center', marginLeft: '0.25rem',
              transition: 'color 0.2s',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
              <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Hero ── */}
      <main style={{
        display: miniMode ? 'none' : 'flex',
        flex: 1,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '2.75rem',
        textAlign: 'center',
      }}>

        {/* Greeting */}
        <div style={{ lineHeight: 1.25, userSelect: 'none' }}>
          <p className="greeting-line" style={{
            fontSize: 'clamp(1.8rem, 5vw, 2.8rem)', fontWeight: 300, margin: 0,
            letterSpacing: '-0.02em', color: t.text1,
            animationDelay: '0.1s',
          }}>
            {greeting[0]}
          </p>
          {greeting[1] && (
            <p className="greeting-line" style={{
              fontSize: 'clamp(1.8rem, 5vw, 2.8rem)', fontWeight: 300, margin: 0,
              letterSpacing: '-0.02em', color: t.text2,
              animationDelay: '0.35s',
            }}>
              {greeting[1]}
            </p>
          )}
        </div>

        {/* Mic button */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <VoicePlasma active={micState === 'listening'} light={lightMode} />
          {isProcessing && micState === 'idle' && (
            <span className="process-mist" style={{ borderColor: t.micBorderProcess }} />
          )}
          <button
            onClick={() => micState !== 'idle' ? stopListening() : startListening()}
            aria-label={micState !== 'idle' ? 'Stop listening' : 'Start voice command'}
            disabled={micState === 'connecting'}
            className="mic-btn"
            style={{
              position: 'relative', zIndex: 1,
              width: 72, height: 72,
              borderRadius: '50%',
              background: lightMode
                ? micState === 'listening'
                  ? 'rgba(255,255,255,0.65)'
                  : 'rgba(255,255,255,0.45)'
                : micState === 'listening'
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(255,255,255,0.03)',
              border: `1.5px solid ${micState === 'listening' ? t.micBorderActive : micState === 'connecting' ? t.micBorderConnecting : isProcessing ? t.micBorderProcess : t.micBorderIdle}`,
              color: micState === 'listening' ? t.micColorActive : t.micColor,
              cursor: micState === 'connecting' ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.4s, border-color 0.4s, color 0.4s, box-shadow 0.4s',
              outline: 'none',
              boxShadow: lightMode
                ? micState === 'listening'
                  ? 'inset 0 1.5px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(0,0,0,0.06), 0 6px 24px rgba(0,0,0,0.1)'
                  : 'inset 0 1.5px 0 rgba(255,255,255,0.8), inset 0 -1px 0 rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.07)'
                : micState === 'listening'
                  ? 'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.25), 0 8px 32px rgba(0,0,0,0.35)'
                  : 'inset 0 1px 0 rgba(255,255,255,0.1), inset 0 -1px 0 rgba(0,0,0,0.2), 0 4px 20px rgba(0,0,0,0.25)',
            }}
          >
            <span style={{
              position: 'absolute',
              opacity: micState === 'connecting' ? 0 : 1,
              transition: 'opacity 0.35s ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <MicIcon size={22} />
            </span>
            <span style={{
              position: 'absolute',
              opacity: micState === 'connecting' ? 1 : 0,
              transition: 'opacity 0.35s ease',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span className="mic-throbber" />
            </span>
          </button>
        </div>

        {/* Live transcript — rendered as markdown, scrollable for long responses */}
        {transcript ? (
          <div
            ref={transcriptScrollRef}
            style={{
              fontSize: '1rem', fontWeight: 300, color: t.transcriptText,
              letterSpacing: '-0.01em', lineHeight: 1.6,
              maxWidth: 560, width: '100%',
              maxHeight: '40vh', overflowY: 'auto',
              padding: '0.5rem 0.75rem',
              scrollbarWidth: 'thin',
              scrollbarColor: `${t.border1} transparent`,
              transition: 'opacity 0.2s ease',
            }} className="md-scroll">
            <ReactMarkdown
              components={{
                p: ({ children }) => <p style={{ margin: '0.25rem 0' }}>{children}</p>,
                strong: ({ children }) => <strong style={{ color: t.mdStrong, fontWeight: 500 }}>{children}</strong>,
                ul: ({ children }) => <ul style={{ textAlign: 'left', paddingLeft: '1.2rem', margin: '0.25rem 0' }}>{children}</ul>,
                ol: ({ children }) => <ol style={{ textAlign: 'left', paddingLeft: '1.2rem', margin: '0.25rem 0' }}>{children}</ol>,
                li: ({ children }) => <li style={{ margin: '0.15rem 0' }}>{children}</li>,
                h1: ({ children }) => <h1 style={{ color: t.mdHeading, fontSize: '1.1rem', fontWeight: 500, margin: '0.5rem 0 0.25rem' }}>{children}</h1>,
                h2: ({ children }) => <h2 style={{ color: t.mdHeading, fontSize: '1rem', fontWeight: 500, margin: '0.4rem 0 0.2rem' }}>{children}</h2>,
                h3: ({ children }) => <h3 style={{ color: t.mdHeading, fontSize: '0.95rem', fontWeight: 500, margin: '0.3rem 0 0.15rem' }}>{children}</h3>,
                a: ({ children }) => <span style={{ color: t.transcriptText, textDecoration: 'underline' }}>{children}</span>,
                code: ({ children }) => <code style={{ background: t.mdCode, color: t.mdCodeText, padding: '0.1rem 0.3rem', borderRadius: 3, fontSize: '0.85rem' }}>{children}</code>,
              }}
            >{transcript}</ReactMarkdown>
            <span style={{ opacity: 0.5, animation: 'blink 1s step-end infinite' }}>▮</span>
          </div>
        ) : (
          <p style={{ minHeight: '1.5rem', margin: 0 }} />
        )}

        {/* ── Approval card ─────────────────────────────────────────────── */}
        {pendingApproval && (
          <div style={{
            maxWidth: 520, width: '100%',
            background: lightMode ? 'rgba(255,255,255,0.85)' : 'rgba(30,30,30,0.85)',
            backdropFilter: 'blur(12px)',
            border: `1px solid ${lightMode ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius: 12, padding: '1rem 1.25rem',
            animation: 'slideUp 0.3s ease',
          }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: t.text1, marginBottom: '0.5rem' }}>
              Approval Required
            </div>
            <div style={{ fontSize: '0.85rem', color: t.text2, lineHeight: 1.5, marginBottom: '0.75rem' }}>
              <ReactMarkdown components={{
                p: ({ children }) => <p style={{ margin: '0.2rem 0' }}>{children}</p>,
                strong: ({ children }) => <strong style={{ color: t.mdStrong, fontWeight: 500 }}>{children}</strong>,
                ul: ({ children }) => <ul style={{ textAlign: 'left', paddingLeft: '1.2rem', margin: '0.2rem 0' }}>{children}</ul>,
                li: ({ children }) => <li style={{ margin: '0.1rem 0' }}>{children}</li>,
                code: ({ children }) => <code style={{ background: t.mdCode, color: t.mdCodeText, padding: '0.1rem 0.3rem', borderRadius: 3, fontSize: '0.8rem' }}>{children}</code>,
              }}>
                {pendingApproval.writeActions.map((w) => `- **${w.action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}**: ${w.description}`).join('\n')}
              </ReactMarkdown>
              {pendingApproval.readActions.length > 0 && (
                <p style={{ margin: '0.4rem 0 0', fontSize: '0.78rem', color: t.text3 }}>
                  Also planned (auto-approved): {pendingApproval.readActions.map((r) => r.action.replace(/_/g, ' ')).join(', ')}
                </p>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                onClick={handleReject}
                disabled={approvalLoading}
                style={{
                  padding: '0.4rem 1rem', borderRadius: 6,
                  border: `1px solid ${lightMode ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.12)'}`,
                  background: 'transparent', color: t.text2,
                  fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
                  opacity: approvalLoading ? 0.5 : 1,
                }}
              >
                Reject
              </button>
              <button
                onClick={handleApprove}
                disabled={approvalLoading}
                style={{
                  padding: '0.4rem 1rem', borderRadius: 6,
                  border: `1px solid ${lightMode ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.2)'}`,
                  background: lightMode ? '#111' : '#e8e8e8',
                  color: lightMode ? '#fff' : '#111',
                  fontSize: '0.8rem', fontWeight: 500, cursor: 'pointer',
                  opacity: approvalLoading ? 0.5 : 1,
                }}
              >
                {approvalLoading ? 'Executing...' : 'Approve'}
              </button>
            </div>
          </div>
        )}

        {/* Type instead input */}
        <div style={{ width: '100%', maxWidth: 420 }}>
          <textarea
            value={command}
            rows={1}
            onChange={(e) => {
              setCommand(e.target.value);
              e.target.style.height = 'auto';
              const maxPx = 144;
              if (e.target.scrollHeight > maxPx) {
                e.target.style.height = maxPx + 'px';
                e.target.style.overflowY = 'auto';
              } else {
                e.target.style.height = e.target.scrollHeight + 'px';
                e.target.style.overflowY = 'hidden';
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitCommand();
                const ta = e.target as HTMLTextAreaElement;
                ta.style.height = 'auto';
              }
            }}
            placeholder="or type a command..."
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              borderBottom: `1px solid ${t.inputBorder}`,
              outline: 'none',
              color: t.inputText,
              fontSize: '0.9rem',
              fontWeight: 300,
              fontFamily: 'inherit',
              padding: '0.5rem 0',
              textAlign: 'center',
              letterSpacing: '-0.01em',
              caretColor: t.inputCaret,
              boxSizing: 'border-box',
              resize: 'none',
              overflow: 'hidden',
              lineHeight: '1.5',
              display: 'block',
            }}
          />
        </div>
      </main>

      {/* ── Mini mode pill floater ── */}
      {miniMode && (
        <div style={{
          position: 'fixed', bottom: 32, left: '50%', transform: 'translateX(-50%)',
          zIndex: 100,
          display: 'flex', alignItems: 'center', gap: '0.75rem',
          background: t.bgMini,
          border: `1px solid ${t.border2}`,
          borderRadius: 40,
          padding: '10px 18px 10px 14px',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          boxShadow: lightMode ? '0 4px 32px rgba(0,0,0,0.08)' : '0 4px 32px rgba(0,0,0,0.6)',
          minWidth: 260, maxWidth: 400,
          userSelect: 'none',
        }}>
          <button
            onClick={() => micState !== 'idle' ? stopListening() : startListening()}
            aria-label={micState !== 'idle' ? 'Stop listening' : 'Start voice command'}
            disabled={micState === 'connecting'}
            style={{
              flexShrink: 0,
              width: 36, height: 36, borderRadius: '50%',
              background: 'transparent',
              border: `1.5px solid ${micState === 'listening' ? t.micBorderActive : t.micBorderConnecting}`,
              color: micState === 'listening' ? t.micColorActive : t.micColor,
              cursor: micState === 'connecting' ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'border-color 0.4s, color 0.4s',
              outline: 'none', position: 'relative',
            }}
          >
            <VoicePlasma active={micState === 'listening'} size={90} light={lightMode} />
            <span style={{ opacity: micState === 'connecting' ? 0 : 1, transition: 'opacity 0.35s', display: 'flex' }}>
              <MicIcon size={14} />
            </span>
            <span style={{ position: 'absolute', opacity: micState === 'connecting' ? 1 : 0, transition: 'opacity 0.35s', display: 'flex' }}>
              <span className="mic-throbber" style={{ width: 12, height: 12 } as React.CSSProperties} />
            </span>
          </button>

          <span style={{
            flex: 1, minWidth: 0,
            fontSize: '0.72rem', fontWeight: 300, color: transcript ? t.text3 : t.textFaint,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            letterSpacing: '-0.01em',
          }}>
            {transcript
              ? transcript
              : isProcessing
                ? tasks.find((t2) => t2.status === 'running')?.command ?? 'processing…'
                : 'TalOS'}
          </span>

          {isProcessing && (
            <span style={{
              width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
              background: t.dotOn, boxShadow: `0 0 6px ${t.dotGlow}`,
            }} />
          )}

          <button
            onClick={() => setMiniMode(false)}
            aria-label="Expand dashboard"
            title="Expand"
            style={{
              flexShrink: 0, background: 'transparent', border: 'none',
              color: t.iconBtn, cursor: 'pointer', padding: '2px',
              outline: 'none', display: 'flex', alignItems: 'center',
              transition: 'color 0.2s',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </div>
      )}

      {/* ── Floating task feed (latest task, auto-fades) ── */}
      {visibleTasks.length > 0 && !taskPanelOpen && !miniMode && (
        <div style={{
          position: 'fixed', bottom: 48, left: '50%', transform: 'translateX(-50%)',
          maxWidth: 480, width: '90%', zIndex: 10,
        }}>
          {visibleTasks.slice(0, 2).map((task) => {
            const fading = task.completedAt && Date.now() - task.completedAt > 4000;
            const isChat = task.status !== 'running' && (!task.results || task.results.length === 0) && !!task.message;
            const isExpanded = expandedTaskId === task.id;
            const taskBorder = task.status === 'completed' ? t.taskBorderDone : task.status === 'running' ? t.taskBorderRun : t.taskBorderFail;
            return (
              <div key={task.id} style={{
                padding: '0.5rem 0.75rem',
                borderLeft: `1.5px solid ${taskBorder}`,
                opacity: fading ? 0 : 1,
                transition: 'opacity 2s ease-out',
                marginBottom: '0.5rem',
                cursor: task.status !== 'running' ? 'pointer' : 'default',
              }} onClick={() => task.status !== 'running' && setExpandedTaskId(isExpanded ? null : task.id)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                  <span style={{
                    fontSize: '0.8rem', fontWeight: 300,
                    color: task.status === 'running' ? t.taskTextRun : t.taskTextDone,
                    flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {task.command}
                  </span>
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 400, flexShrink: 0,
                    color: task.status === 'completed' ? t.taskTextDone : task.status === 'running' ? t.text3 : t.taskStepFail,
                    display: 'flex', alignItems: 'center', gap: '0.35rem',
                  }}>
                    {task.status === 'running' ? (
                      <TaskStatus taskId={task.id} />
                    ) : task.status === 'completed' ? (
                      <>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4a7a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        {fmtMs(task.duration)}
                      </>
                    ) : (
                      <>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#7a4a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                        {fmtMs(task.duration)}
                      </>
                    )}
                  </span>
                  {task.status !== 'running' && (
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                      style={{ color: t.taskTextDone, opacity: 0.5, flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  )}
                </div>
                {isChat && (
                  <p style={{ fontSize: '0.72rem', fontWeight: 300, color: t.taskMsg, margin: '0.3rem 0 0', lineHeight: 1.5 }}>
                    {isExpanded ? stripMd(task.message) : trunc(stripMd(task.message))}
                  </p>
                )}
                {task.status === 'running' && task.pendingSteps && task.pendingSteps.length > 0 && (
                  <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {task.pendingSteps.map((s) => (
                      <div key={s.nodeId} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        {s.status === 'running' ? (
                          <span className="task-spinner" style={{ width: 7, height: 7, flexShrink: 0 }} />
                        ) : s.status === 'success' ? (
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#4a7a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#7a4a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        )}
                        <span style={{ fontSize: '0.7rem', fontWeight: 300, color: s.status === 'failure' ? t.taskStepFail : t.taskTextDone, lineHeight: 1.4 }}>
                          {labelAction(s.action, s.nodeId)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {isExpanded && !isChat && task.results && (
                  <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {task.results.map((r) => (
                      <div key={r.taskId} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem' }}>
                        {r.status === 'success' ? (
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#4a7a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 2, flexShrink: 0 }}>
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#7a4a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 2, flexShrink: 0 }}>
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        )}
                        <span style={{ fontSize: '0.7rem', fontWeight: 300, color: r.status === 'success' ? t.taskTextDone : t.taskStepFail, lineHeight: 1.4 }}>
                          {labelAction((r.output as Record<string, unknown>)?.action as string, r.taskId)}
                          {r.error ? ` — ${r.error}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {isExpanded && task.message && !isChat && (() => {
                  const msgExpanded = expandedMsgId === task.id;
                  const stripped = stripMd(task.message);
                  const needsExpand = stripped.length > MSG_TRUNC;
                  return (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.25rem', marginTop: '0.3rem', cursor: needsExpand ? 'pointer' : 'default' }}
                      onClick={(e) => { if (needsExpand) { e.stopPropagation(); setExpandedMsgId(msgExpanded ? null : task.id); } }}>
                      <p style={{ fontSize: '0.72rem', fontWeight: 300, color: t.taskMsg, margin: 0, lineHeight: 1.5, flex: 1 }}>
                        {msgExpanded ? stripped : trunc(stripped)}
                      </p>
                      {needsExpand && (
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                          style={{ color: t.taskMsg, opacity: 0.5, flexShrink: 0, marginTop: 3, transform: msgExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Task panel toggle (bottom center) ── */}
      {tasks.length > 0 && !miniMode && (
        <button
          onClick={() => setTaskPanelOpen((v) => !v)}
          aria-label={taskPanelOpen ? 'Close task panel' : 'Open task panel'}
          style={{
            position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
            zIndex: 20, background: 'transparent', border: 'none',
            color: t.chevron, cursor: 'pointer', padding: '4px 12px',
            outline: 'none', transition: 'color 0.3s',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: taskPanelOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.3s' }}>
            <polyline points="18 15 12 9 6 15" />
          </svg>
        </button>
      )}

      {/* ── Settings gear (bottom right) ── */}
      {!miniMode && (
        <button
          onClick={() => setSettingsPanelOpen((v) => !v)}
          aria-label="Autonomy settings"
          style={{
            position: 'fixed', bottom: 16, right: 20,
            zIndex: 20, background: 'transparent', border: 'none',
            color: t.text3, cursor: 'pointer', padding: 6,
            outline: 'none', opacity: 0.6, transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '1'; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '0.6'; }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}

      {/* ── Autonomy settings panel ── */}
      {settingsPanelOpen && !miniMode && (
        <div style={{
          position: 'fixed', bottom: 40, right: 20,
          zIndex: 25, width: 300,
          background: lightMode ? 'rgba(255,255,255,0.95)' : 'rgba(24,24,24,0.95)',
          backdropFilter: 'blur(16px)',
          border: `1px solid ${lightMode ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: 12, padding: '1rem 1.25rem',
          animation: 'slideUp 0.2s ease-out',
        }}>
          <p style={{ fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: t.text3, margin: '0 0 0.75rem' }}>
            Autonomy Settings
          </p>

          {/* Global default */}
          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ fontSize: '0.78rem', color: t.text2, display: 'block', marginBottom: '0.3rem' }}>Default Level</label>
            <select
              value={approvalSettings.defaultLevel}
              onChange={(e) => updateAutonomySetting({ defaultLevel: e.target.value as AutonomyLevel })}
              style={{
                width: '100%', padding: '0.35rem 0.5rem', borderRadius: 6,
                border: `1px solid ${lightMode ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.12)'}`,
                background: lightMode ? '#fff' : 'rgba(40,40,40,0.8)', color: t.text1,
                fontSize: '0.78rem', outline: 'none',
              }}
            >
              <option value="write_approval">Approve writes (recommended)</option>
              <option value="all_approval">Approve everything</option>
              <option value="full">Full autonomy</option>
            </select>
          </div>

          {/* Per-connector overrides */}
          <p style={{ fontSize: '0.68rem', fontWeight: 500, color: t.text3, margin: '0.5rem 0 0.4rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Per-connector overrides
          </p>
          {(['slack', 'gmail', 'jira', 'hubspot', 'notion'] as const).map((connector) => (
            <div key={connector} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
              <span style={{ fontSize: '0.75rem', color: t.text2, textTransform: 'capitalize' }}>{connector}</span>
              <select
                value={approvalSettings.connectorOverrides[connector] ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  const overrides = { ...approvalSettings.connectorOverrides };
                  if (val === '') { delete overrides[connector]; } else { overrides[connector] = val as AutonomyLevel; }
                  updateAutonomySetting({ connectorOverrides: overrides });
                }}
                style={{
                  padding: '0.2rem 0.4rem', borderRadius: 4,
                  border: `1px solid ${lightMode ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.08)'}`,
                  background: lightMode ? '#fff' : 'rgba(40,40,40,0.8)', color: t.text2,
                  fontSize: '0.72rem', outline: 'none',
                }}
              >
                <option value="">(use default)</option>
                <option value="write_approval">Approve writes</option>
                <option value="all_approval">Approve all</option>
                <option value="full">Full autonomy</option>
              </select>
            </div>
          ))}
        </div>
      )}

      {/* ── Full task panel (slide up) ── */}
      {taskPanelOpen && !miniMode && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          zIndex: 15, maxHeight: '40vh', overflowY: 'auto',
          background: t.panelBg, borderTop: `1px solid ${t.panelBorder}`,
          padding: '1.5rem 2rem 2.5rem',
          animation: 'slideUp 0.25s ease-out',
        }}>
          <div style={{ maxWidth: 560, margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <p style={{
                fontSize: '0.6rem', fontWeight: 600, color: t.panelLabel,
                textTransform: 'uppercase', letterSpacing: '0.1em', margin: 0,
              }}>
                Task History
              </p>
              <button
                onClick={() => { setTasks([]); setTaskPanelOpen(false); }}
                style={{
                  background: 'transparent', border: 'none', color: t.panelClear,
                  fontSize: '0.6rem', cursor: 'pointer', textTransform: 'uppercase',
                  letterSpacing: '0.08em', outline: 'none',
                }}
              >
                Clear
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {tasks.map((task) => {
                const isExpanded = expandedTaskId === task.id;
                const taskBorder = task.status === 'completed' ? t.taskBorderDone : task.status === 'running' ? t.taskBorderRun : t.taskBorderFail;
                return (
                  <div key={task.id} style={{
                    paddingLeft: '0.65rem',
                    borderLeft: `1.5px solid ${taskBorder}`,
                    cursor: task.status !== 'running' ? 'pointer' : 'default',
                  }} onClick={() => task.status !== 'running' && setExpandedTaskId(isExpanded ? null : task.id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                      <span style={{
                        fontSize: '0.8rem', fontWeight: 300,
                        color: task.status === 'running' ? t.taskTextRun : t.taskTextDone,
                        flex: 1, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {task.command}
                      </span>
                      <span style={{
                        fontSize: '0.65rem', fontWeight: 400, flexShrink: 0,
                        color: task.status === 'completed' ? t.taskTextDone : task.status === 'running' ? t.text3 : t.taskStepFail,
                        display: 'flex', alignItems: 'center', gap: '0.35rem',
                      }}>
                        {task.status === 'running' ? (
                          <TaskStatus taskId={task.id} />
                        ) : task.status === 'completed' ? (
                          <>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#4a7a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                            {fmtMs(task.duration)}
                          </>
                        ) : (
                          <>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#7a4a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                            {fmtMs(task.duration)}
                          </>
                        )}
                      </span>
                      {task.status !== 'running' && (
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                          style={{ color: t.taskTextDone, opacity: 0.5, flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      )}
                    </div>
                    {task.status === 'running' && task.pendingSteps && task.pendingSteps.length > 0 && (
                      <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        {task.pendingSteps.map((s) => (
                          <div key={s.nodeId} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            {s.status === 'running' ? (
                              <span className="task-spinner" style={{ width: 7, height: 7, flexShrink: 0 }} />
                            ) : s.status === 'success' ? (
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#4a7a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : (
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#7a4a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            )}
                            <span style={{ fontSize: '0.7rem', fontWeight: 300, color: s.status === 'failure' ? t.taskStepFail : t.taskTextDone, lineHeight: 1.4 }}>
                              {labelAction(s.action, s.nodeId)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {isExpanded && task.results && (
                      <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        {task.results.map((r) => (
                          <div key={r.taskId} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem' }}>
                            {r.status === 'success' ? (
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#4a7a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 2, flexShrink: 0 }}>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : (
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#7a4a4a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginTop: 2, flexShrink: 0 }}>
                                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            )}
                            <span style={{ fontSize: '0.7rem', fontWeight: 300, color: r.status === 'success' ? t.taskTextDone : t.taskStepFail, lineHeight: 1.4 }}>
                              {labelAction((r.output as Record<string, unknown>)?.action as string, r.taskId)}
                              {r.error ? ` — ${r.error}` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {isExpanded && task.message && (() => {
                      const msgExpanded = expandedMsgId === task.id;
                      const stripped = stripMd(task.message);
                      const needsExpand = stripped.length > MSG_TRUNC;
                      return (
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.25rem', marginTop: '0.3rem', cursor: needsExpand ? 'pointer' : 'default' }}
                          onClick={(e) => { if (needsExpand) { e.stopPropagation(); setExpandedMsgId(msgExpanded ? null : task.id); } }}>
                          <p style={{ fontSize: '0.72rem', fontWeight: 300, color: t.taskMsg, margin: 0, lineHeight: 1.4, flex: 1 }}>
                            {msgExpanded ? stripped : trunc(stripped)}
                          </p>
                          {needsExpand && (
                            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                              style={{ color: t.taskMsg, opacity: 0.5, flexShrink: 0, marginTop: 3, transform: msgExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      </div>{/* end content wrapper */}
    </div>
  );
}
