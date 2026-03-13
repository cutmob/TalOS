'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  jira_create_ticket: 'Created Jira ticket',
  jira_search: 'Searched Jira',
  jira_update_ticket: 'Updated Jira ticket',
  slack_send_message: 'Sent Slack message',
  slack_list_channels: 'Listed Slack channels',
  gmail_send_email: 'Sent email',
  gmail_search: 'Searched Gmail',
  hubspot_create_contact: 'Created HubSpot contact',
  hubspot_search: 'Searched HubSpot',
  hubspot_create_deal: 'Created HubSpot deal',
  notion_create_page: 'Created Notion page',
  notion_search: 'Searched Notion',
  browse: 'Browsed web',
  search: 'Searched',
  execute: 'Executed task',
  recover: 'Recovered from error',
};

function labelAction(action: string | undefined, taskId: string): string {
  if (!action) return taskId.replace(/_/g, ' ');
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaskResult {
  taskId: string;
  agentType: string;
  status: 'success' | 'failure' | 'retry';
  output: unknown;
  duration: number;
  error?: string;
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

  const [isVoiceConnected, setIsVoiceConnected] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [micState, setMicState] = useState<'idle' | 'connecting' | 'listening'>('idle');
  const [greeting, setGreeting] = useState<Pair>(['', '']);
  const [miniMode, setMiniMode] = useState(false);
  useEffect(() => { setGreeting(pickGreeting()); }, []);

  // Stable session ID for the entire browser session — persists across tasks
  const sessionIdRef = useRef<string>(`session_${Date.now()}_${Math.random().toString(36).slice(2)}`);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeRef = useRef(0);
  const taskHistoryRef = useRef<TaskEntry[]>([]);

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

  // Keep history ref in sync (tasks array is the source of truth)
  useEffect(() => { taskHistoryRef.current = tasks; }, [tasks]);

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

    const taskId = `task_${Date.now()}`;
    const startedAt = Date.now();
    setTasks((prev) => [{ id: taskId, command: input, status: 'running', startedAt, progressLabel: 'thinking' }, ...prev]);
    setCommand('');
    activeRef.current += 1;
    setActiveAgents(new Set(['orchestrator']));

    const updateTask = (patch: Partial<TaskEntry>) => {
      setTasks((prev) => prev.map((t) => t.id === taskId ? { ...t, ...patch } : t));
    };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, sessionId: sessionIdRef.current }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as {
        status?: string;
        response?: string;
        results?: TaskResult[];
      };

      const duration = Date.now() - startedAt;

      const agentTypes = new Set<string>(
        (data.results ?? []).map((r) => r.agentType)
      );
      if (agentTypes.size > 0) {
        setActiveAgents(agentTypes);
        setTimeout(() => setActiveAgents(new Set()), 1500);
      }

      const ok =
        data.results?.every((r) => r.status === 'success') ??
        data.status === 'completed';

      // Prefer the chat response field directly from the orchestrator;
      // only fall back to a generic summary if it truly returned nothing.
      let summary = data.response ?? '';

      if (!summary) {
        summary = ok
          ? 'All tasks completed successfully.'
          : 'Some tasks failed. Check results for details.';
      }

      setTranscript(summary);

      updateTask({
        status: ok ? 'completed' : 'failed',
        completedAt: Date.now(),
        duration,
        results: data.results as TaskResult[] | undefined,
        message: summary,
      });
    } catch (err) {
      updateTask({
        status: 'failed',
        completedAt: Date.now(),
        duration: Date.now() - startedAt,
        message: String(err),
      });
    } finally {
      activeRef.current -= 1;
      if (activeRef.current === 0) setActiveAgents(new Set());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    ws.onclose = () => { setIsVoiceConnected(false); wsRef.current = null; };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
        // Session ready — Bedrock init complete, browser can now send audio
        if (msg.type === 'ready') { setIsVoiceConnected(true); setMicState('listening'); }
        // Nova Sonic speaking — play PCM audio
        if (msg.type === 'audio' && msg.audio) playPCM24k(msg.audio as string);
        // Live transcript of what Nova Sonic understood
        if (msg.type === 'transcript' && msg.text) setTranscript(msg.text as string);
        // Nova Sonic executed a command via tool use — show it in task feed
        if (msg.type === 'task_result') {
          const result = msg.result as {
            message?: string;
            status?: string;
            results?: TaskResult[];
          };

          if (result?.message) setTranscript(result.message);

          // Light up agent status dots based on which agents actually ran
          if (result?.results && result.results.length > 0) {
            const types = new Set<string>(result.results.map((r) => r.agentType));
            if (types.size > 0) {
              setActiveAgents(types);
              setTimeout(() => setActiveAgents(new Set()), 1500);
            }
          }

          // Mirror voice commands into the same task history as typed commands
          const now = Date.now();
          const taskId = `voice_${now}`;
          const ok =
            result.results?.every((r) => r.status === 'success') ??
            result.status === 'completed';

          setTasks((prev) => [
            {
              id: taskId,
              command: transcript || 'Voice command',
              status: ok ? 'completed' : 'failed',
              startedAt: now,
              completedAt: now,
              duration: 0,
              results: result.results as TaskResult[] | undefined,
              message: result.message,
            },
            ...prev,
          ]);
        }
        if (msg.type === 'error') console.error('Voice error:', msg.message);
      } catch { /* ignore */ }
    };
    return ws;
  }, [submitCommand, playPCM24k, transcript]);

  // ── Mic start / stop ──────────────────────────────────────────────────────

  const startListening = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: { ideal: 16000 } },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const srcRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      setMicState('connecting');
      const ws = connectVoiceWS();
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const raw = e.inputBuffer.getChannelData(0);
        const pcm = floatToPCM16(resampleTo16k(raw, srcRate));
        ws.send(JSON.stringify({ type: 'audio', audio: toBase64(pcm.buffer as ArrayBuffer) }));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      // micState transitions to 'listening' when Bedrock sends 'ready'
    } catch {
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
    sonicCtxRef.current?.close();
    sonicCtxRef.current = null;
    nextPlayTimeRef.current = 0;
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

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

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      fontWeight: 300,
    }}>

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
          opacity: 0.04,
          zIndex: 0,
          pointerEvents: 'none',
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
          {/* Logo mark — orbital rings */}
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">
            <ellipse cx="11" cy="11" rx="9.5" ry="4" stroke="#606060" strokeWidth="1" fill="none" transform="rotate(-35 11 11)" />
            <ellipse cx="11" cy="11" rx="9.5" ry="4" stroke="#404040" strokeWidth="1" fill="none" transform="rotate(35 11 11)" />
            <circle cx="11" cy="11" r="1.5" fill="#808080" />
          </svg>
          <span style={{ fontSize: '1.05rem', fontWeight: 600, letterSpacing: '0.04em', color: '#e8e8e8' }}>
            Tal<span style={{ color: '#707070' }}>OS</span>
          </span>
        </div>

        {/* Agent status dots */}
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {(['orchestrator', 'research', 'execution', 'recovery'] as const).map((name) => {
            const on = activeAgents.has(name);
            return (
              <span key={name} title={name} style={{
                display: 'flex', alignItems: 'center', gap: '0.3rem',
                fontSize: '0.65rem', color: on ? '#909090' : '#2a2a2a',
                transition: 'color 0.3s',
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                <span style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: on ? '#909090' : '#1e1e1e',
                  display: 'inline-block',
                  transition: 'background 0.3s',
                  boxShadow: on ? '0 0 6px #90909060' : 'none',
                }} />
                {name}
              </span>
            );
          })}
          {metrics && metrics.totalTasks > 0 && (
            <span style={{ fontSize: '0.65rem', color: '#2a2a2a', marginLeft: '0.75rem', letterSpacing: '0.04em' }}>
              {metrics.totalTasks} tasks · {Math.round(metrics.successRate * 100)}%
            </span>
          )}
          {/* Mini mode toggle */}
          <button
            onClick={() => setMiniMode(true)}
            aria-label="Compact mode"
            title="Compact mode"
            style={{
              background: 'transparent', border: 'none', color: '#282828',
              cursor: 'pointer', padding: '4px', outline: 'none',
              display: 'flex', alignItems: 'center', marginLeft: '0.5rem',
              transition: 'color 0.2s',
            }}
          >
            {/* compress / minimize icon */}
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
            letterSpacing: '-0.02em', color: '#e8e8e8',
            animationDelay: '0.1s',
          }}>
            {greeting[0]}
          </p>
          {greeting[1] && (
            <p className="greeting-line" style={{
              fontSize: 'clamp(1.8rem, 5vw, 2.8rem)', fontWeight: 300, margin: 0,
              letterSpacing: '-0.02em', color: '#383838',
              animationDelay: '0.35s',
            }}>
              {greeting[1]}
            </p>
          )}
        </div>

        {/* Mic button */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* Single subtle ring when actively listening */}
          {micState === 'listening' && (
            <span className="mic-ring" />
          )}
          {/* Processing pulse ring */}
          {isProcessing && micState === 'idle' && (
            <span className="process-ring" />
          )}
          <button
            onClick={() => micState !== 'idle' ? stopListening() : startListening()}
            aria-label={micState !== 'idle' ? 'Stop listening' : 'Start voice command'}
            disabled={micState === 'connecting'}
            style={{
              position: 'relative', zIndex: 1,
              width: 72, height: 72,
              borderRadius: '50%',
              background: 'transparent',
              border: `1.5px solid ${micState === 'listening' ? '#555' : micState === 'connecting' ? '#2a2a2a' : isProcessing ? '#55555580' : '#222'}`,
              color: micState === 'listening' ? '#aaa' : '#555',
              cursor: micState === 'connecting' ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'border-color 0.4s, color 0.4s',
              outline: 'none',
            }}
          >
            {/* Fade between mic icon and connecting throbber */}
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

        {/* Live transcript */}
        {transcript ? (
          <p style={{
            fontSize: '1rem', fontWeight: 300, color: '#a0a0a0',
            margin: 0, letterSpacing: '-0.01em',
            minHeight: '1.5rem', maxWidth: 480,
          }}>
            {transcript}
            <span style={{ opacity: 0.5, animation: 'blink 1s step-end infinite' }}>▮</span>
          </p>
        ) : (
          <p style={{ minHeight: '1.5rem', margin: 0 }} />
        )}

        {/* Type instead input */}
        <div style={{ width: '100%', maxWidth: 420 }}>
          <textarea
            value={command}
            rows={1}
            onChange={(e) => {
              setCommand(e.target.value);
              e.target.style.height = 'auto';
              const maxPx = 144; // ~6 lines
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
                const t = e.target as HTMLTextAreaElement;
                t.style.height = 'auto';
              }
            }}
            placeholder="or type a command..."
            style={{
              width: '100%',
              background: 'transparent',
              border: 'none',
              borderBottom: '1px solid #1a1a1a',
              outline: 'none',
              color: '#888',
              fontSize: '0.9rem',
              fontWeight: 300,
              fontFamily: 'inherit',
              padding: '0.5rem 0',
              textAlign: 'center',
              letterSpacing: '-0.01em',
              caretColor: '#888',
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
          background: 'rgba(8,8,8,0.92)',
          border: '1px solid #1e1e1e',
          borderRadius: 40,
          padding: '10px 18px 10px 14px',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          boxShadow: '0 4px 32px rgba(0,0,0,0.6)',
          minWidth: 260, maxWidth: 400,
          userSelect: 'none',
        }}>
          {/* Mic button — compact */}
          <button
            onClick={() => micState !== 'idle' ? stopListening() : startListening()}
            aria-label={micState !== 'idle' ? 'Stop listening' : 'Start voice command'}
            disabled={micState === 'connecting'}
            style={{
              flexShrink: 0,
              width: 36, height: 36, borderRadius: '50%',
              background: 'transparent',
              border: `1.5px solid ${micState === 'listening' ? '#555' : micState === 'connecting' ? '#2a2a2a' : '#2a2a2a'}`,
              color: micState === 'listening' ? '#aaa' : '#555',
              cursor: micState === 'connecting' ? 'default' : 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'border-color 0.4s, color 0.4s',
              outline: 'none', position: 'relative',
            }}
          >
            {micState === 'listening' && (
              <span style={{
                position: 'absolute', width: 36, height: 36, borderRadius: '50%',
                border: '1px solid #444',
                animation: 'expandRing 2.4s ease-out infinite',
                pointerEvents: 'none',
              }} />
            )}
            <span style={{ opacity: micState === 'connecting' ? 0 : 1, transition: 'opacity 0.35s', display: 'flex' }}>
              <MicIcon size={14} />
            </span>
            <span style={{ position: 'absolute', opacity: micState === 'connecting' ? 1 : 0, transition: 'opacity 0.35s', display: 'flex' }}>
              <span className="mic-throbber" style={{ width: 12, height: 12 } as React.CSSProperties} />
            </span>
          </button>

          {/* Status / transcript text */}
          <span style={{
            flex: 1, minWidth: 0,
            fontSize: '0.72rem', fontWeight: 300, color: transcript ? '#909090' : '#2e2e2e',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            letterSpacing: '-0.01em',
          }}>
            {transcript
              ? transcript
              : isProcessing
                ? tasks.find((t) => t.status === 'running')?.command ?? 'processing…'
                : 'TalOS'}
          </span>

          {/* Agent activity dot */}
          {isProcessing && (
            <span style={{
              width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
              background: '#606060', boxShadow: '0 0 6px #60606060',
            }} />
          )}

          {/* Expand button */}
          <button
            onClick={() => setMiniMode(false)}
            aria-label="Expand dashboard"
            title="Expand"
            style={{
              flexShrink: 0, background: 'transparent', border: 'none',
              color: '#2a2a2a', cursor: 'pointer', padding: '2px',
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
            return (
              <div key={task.id} style={{
                padding: '0.5rem 0.75rem',
                borderLeft: `1.5px solid ${task.status === 'completed' ? '#3a3a3a' : task.status === 'running' ? '#666' : '#3a1a1a'}`,
                opacity: fading ? 0 : 1,
                transition: 'opacity 2s ease-out',
                marginBottom: '0.5rem',
                cursor: task.status !== 'running' && !isChat ? 'pointer' : 'default',
              }} onClick={() => task.status !== 'running' && !isChat && setExpandedTaskId(isExpanded ? null : task.id)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                  <span style={{
                    fontSize: '0.8rem', fontWeight: 300,
                    color: task.status === 'running' ? '#e8e8e8' : '#555',
                    flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {task.command}
                  </span>
                  <span style={{
                    fontSize: '0.65rem', fontWeight: 400, flexShrink: 0,
                    color: task.status === 'completed' ? '#707070' : task.status === 'running' ? '#a0a0a0' : '#5a3a3a',
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
                </div>
                {isChat && (
                  <p style={{ fontSize: '0.72rem', fontWeight: 300, color: '#606060', margin: '0.3rem 0 0', lineHeight: 1.5 }}>
                    {task.message}
                  </p>
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
                        <span style={{ fontSize: '0.7rem', fontWeight: 300, color: r.status === 'success' ? '#505050' : '#6a3a3a', lineHeight: 1.4 }}>
                          {labelAction((r.output as Record<string, unknown>)?.action as string, r.taskId)}
                          {r.error ? ` — ${r.error}` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {isExpanded && task.message && !isChat && (
                  <p style={{ fontSize: '0.72rem', fontWeight: 300, color: '#606060', margin: '0.3rem 0 0', lineHeight: 1.5 }}>
                    {task.message}
                  </p>
                )}
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
            color: '#333', cursor: 'pointer', padding: '4px 12px',
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

      {/* ── Full task panel (slide up) ── */}
      {taskPanelOpen && !miniMode && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          zIndex: 15, maxHeight: '40vh', overflowY: 'auto',
          background: '#0a0a0a', borderTop: '1px solid #1a1a1a',
          padding: '1.5rem 2rem 2.5rem',
          animation: 'slideUp 0.25s ease-out',
        }}>
          <div style={{ maxWidth: 560, margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <p style={{
                fontSize: '0.6rem', fontWeight: 600, color: '#333',
                textTransform: 'uppercase', letterSpacing: '0.1em', margin: 0,
              }}>
                Task History
              </p>
              <button
                onClick={() => { setTasks([]); setTaskPanelOpen(false); }}
                style={{
                  background: 'transparent', border: 'none', color: '#333',
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
                return (
                  <div key={task.id} style={{
                    paddingLeft: '0.65rem',
                    borderLeft: `1.5px solid ${task.status === 'completed' ? '#3a3a3a' : task.status === 'running' ? '#666' : '#3a1a1a'}`,
                    cursor: task.status !== 'running' ? 'pointer' : 'default',
                  }} onClick={() => task.status !== 'running' && setExpandedTaskId(isExpanded ? null : task.id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                      <span style={{
                        fontSize: '0.8rem', fontWeight: 300,
                        color: task.status === 'running' ? '#e8e8e8' : '#555',
                        flex: 1, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {task.command}
                      </span>
                      <span style={{
                        fontSize: '0.65rem', fontWeight: 400, flexShrink: 0,
                        color: task.status === 'completed' ? '#707070' : task.status === 'running' ? '#a0a0a0' : '#5a3a3a',
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
                    </div>
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
                            <span style={{ fontSize: '0.7rem', fontWeight: 300, color: r.status === 'success' ? '#505050' : '#6a3a3a', lineHeight: 1.4 }}>
                              {labelAction((r.output as Record<string, unknown>)?.action as string, r.taskId)}
                              {r.error ? ` — ${r.error}` : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {isExpanded && task.message && (
                      <p style={{ fontSize: '0.72rem', fontWeight: 300, color: '#505050', margin: '0.3rem 0 0', lineHeight: 1.4 }}>
                        {task.message}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      </div>{/* end content wrapper */}

      <style>{`
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
        .mic-ring {
          position: absolute;
          width: 72px; height: 72px;
          border-radius: 50%;
          border: 1px solid #444;
          animation: expandRing 2.4s ease-out infinite;
          pointer-events: none;
        }
        .mic-throbber {
          display: inline-block;
          width: 18px; height: 18px;
          border-radius: 50%;
          border: 1.5px solid #2a2a2a;
          border-top-color: #555;
          animation: spin 0.9s linear infinite;
        }
        .process-ring {
          position: absolute;
          width: 88px; height: 88px;
          border-radius: 50%;
          border: 1px solid #555;
          animation: processRing 1.5s ease-in-out infinite;
          pointer-events: none;
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
        input::placeholder { color: #252525; }
        button:hover { border-color: #555 !important; color: #aaa !important; }
      `}</style>
    </div>
  );
}
