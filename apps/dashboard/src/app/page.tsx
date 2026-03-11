'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

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
  duration?: number;
  results?: TaskResult[];
  message?: string;
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
  const [isListening, setIsListening] = useState(false);
  const [isVoiceConnected, setIsVoiceConnected] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [activeAgents, setActiveAgents] = useState<Set<string>>(new Set());
  const [greeting] = useState<Pair>(pickGreeting);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const activeRef = useRef(0);

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

  // ── Voice output ─────────────────────────────────────────────────────────

  // Play PCM 24kHz audio from Nova Sonic (base64)
  const playPCM24k = useCallback((b64: string) => {
    try {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const pcm16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
      const ctx = new AudioContext({ sampleRate: 24000 });
      const buf = ctx.createBuffer(1, float32.length, 24000);
      buf.copyToChannel(float32, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start();
      src.onended = () => ctx.close();
    } catch { /* audio decode error — ignore */ }
  }, []);

  // ── Submit command ────────────────────────────────────────────────────────

  const submitCommand = useCallback(async (text?: string) => {
    const input = (text ?? command).trim();
    if (!input) return;

    const taskId = `task_${Date.now()}`;
    setTasks((prev) => [{ id: taskId, command: input, status: 'running', startedAt: Date.now() }, ...prev]);
    setCommand('');
    activeRef.current += 1;
    setActiveAgents(new Set(['orchestrator']));

    try {
      const res = await fetch('/api/tasks/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input, sessionId: taskId }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const duration = Date.now() - (tasks.find((t) => t.id === taskId)?.startedAt ?? Date.now());

      const types = new Set<string>(
        (data.results as TaskResult[] | undefined ?? []).map((r) => r.agentType)
      );
      setActiveAgents(types);
      setTimeout(() => setActiveAgents(new Set()), 1500);

      const ok =
        (data.results as TaskResult[] | undefined)?.every((r) => r.status === 'success') ??
        data.status === 'completed';

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, status: ok ? 'completed' : 'failed', duration, results: data.results, message: data.message }
            : t
        )
      );

      // Voice responses handled by Nova Sonic when mic is active
    } catch (err) {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, status: 'failed', duration: Date.now() - t.startedAt, message: String(err) }
            : t
        )
      );
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
    ws.onopen = () => setIsVoiceConnected(true);
    ws.onclose = () => { setIsVoiceConnected(false); wsRef.current = null; };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type: string;
          intent?: { text?: string };
          data?: { audio?: string };
          result?: { message?: string };
        };
        if (msg.type === 'intent' && msg.intent?.text) setTranscript(msg.intent.text);
        if (msg.type === 'command' && msg.intent?.text) {
          const text = msg.intent.text;
          setTranscript('');
          setCommand(text);
          setTimeout(() => submitCommand(text), 500);
        }
        // Nova Sonic audio output — play it (only active during mic session)
        if (msg.type === 'audioOutput' && msg.data?.audio) {
          playPCM24k(msg.data.audio);
        }
      } catch { /* ignore */ }
    };
    return ws;
  }, [submitCommand]);

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
      const ws = connectVoiceWS();
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const raw = e.inputBuffer.getChannelData(0);
        const pcm = floatToPCM16(resampleTo16k(raw, srcRate));
        ws.send(JSON.stringify({ type: 'audio', audio: toBase64(pcm.buffer as ArrayBuffer) }));
      };
      source.connect(processor);
      processor.connect(ctx.destination);
      setIsListening(true);
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
    setIsListening(false);
    setIsVoiceConnected(false);
    setTranscript('');
  }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const fmtMs = (ms?: number) =>
    ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  const isProcessing = activeAgents.size > 0;

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
        display: 'flex',
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
        </div>
      </header>

      {/* ── Hero ── */}
      <main style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        gap: '2.75rem',
        textAlign: 'center',
      }}>

        {/* Greeting */}
        <div style={{ lineHeight: 1.25, userSelect: 'none' }}>
          <p style={{ fontSize: 'clamp(1.8rem, 5vw, 2.8rem)', fontWeight: 300, margin: 0, letterSpacing: '-0.02em', color: '#e8e8e8' }}>
            {greeting[0]}
          </p>
          {greeting[1] && (
            <p style={{ fontSize: 'clamp(1.8rem, 5vw, 2.8rem)', fontWeight: 300, margin: 0, letterSpacing: '-0.02em', color: '#383838' }}>
              {greeting[1]}
            </p>
          )}
        </div>

        {/* Mic button */}
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* Expanding rings when listening */}
          {isListening && (
            <>
              <span className="mic-ring" style={{ animationDelay: '0s' }} />
              <span className="mic-ring" style={{ animationDelay: '0.6s' }} />
              <span className="mic-ring" style={{ animationDelay: '1.2s' }} />
            </>
          )}
          {/* Processing pulse ring */}
          {isProcessing && !isListening && (
            <span className="process-ring" />
          )}
          <button
            onClick={() => isListening ? stopListening() : startListening()}
            aria-label={isListening ? 'Stop listening' : 'Start voice command'}
            style={{
              position: 'relative', zIndex: 1,
              width: 72, height: 72,
              borderRadius: '50%',
              background: 'transparent',
              border: `1.5px solid ${isListening ? '#999' : isProcessing ? '#55555580' : '#222'}`,
              color: isListening ? '#c0c0c0' : '#666',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'border-color 0.3s, color 0.3s, box-shadow 0.3s',
              boxShadow: isListening ? '0 0 24px #ffffff08' : 'none',
              outline: 'none',
            }}
          >
            <MicIcon size={26} />
            {/* Connected dot */}
            {isVoiceConnected && (
              <span style={{
                position: 'absolute', top: 10, right: 10,
                width: 5, height: 5, borderRadius: '50%',
                background: '#22c55e',
              }} />
            )}
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

      {/* ── Task history ── */}
      {tasks.length > 0 && (
        <section style={{
          maxWidth: 560,
          width: '100%',
          margin: '0 auto',
          padding: '0 2rem 3rem',
        }}>
          <p style={{
            fontSize: '0.6rem', fontWeight: 600, color: '#222',
            textTransform: 'uppercase', letterSpacing: '0.1em',
            margin: '0 0 1rem',
          }}>
            Recent
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {tasks.slice(0, 6).map((task) => (
              <div key={task.id} style={{
                paddingLeft: '0.75rem',
                borderLeft: `1.5px solid ${task.status === 'completed' ? '#3a3a3a' : task.status === 'running' ? '#666' : '#3a1a1a'}`,
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '1rem',
                }}>
                  <span style={{
                    fontSize: '0.85rem', fontWeight: 300,
                    color: task.status === 'running' ? '#e8e8e8' : '#555',
                    flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {task.command}
                  </span>
                  <span style={{
                    fontSize: '0.67rem', fontWeight: 400, flexShrink: 0,
                    color: task.status === 'completed' ? '#707070' : task.status === 'running' ? '#a0a0a0' : '#5a3a3a',
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                  }}>
                    {task.status === 'running' ? (
                      <span className="task-spinner" />
                    ) : fmtMs(task.duration)}
                  </span>
                </div>
                {task.message && task.status !== 'running' && (
                  <p style={{
                    fontSize: '0.8rem', fontWeight: 300,
                    color: '#707070',
                    margin: '0.35rem 0 0',
                    lineHeight: 1.45,
                  }}>
                    {task.message}
                  </p>
                )}
              </div>
            ))}
          </div>
        </section>
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
          border: 1px solid #888;
          animation: expandRing 1.8s ease-out infinite;
          pointer-events: none;
        }
        .process-ring {
          position: absolute;
          width: 88px; height: 88px;
          border-radius: 50%;
          border: 1px solid #555;
          animation: processRing 1.5s ease-in-out infinite;
          pointer-events: none;
        }
        input::placeholder { color: #252525; }
        button:hover { border-color: #555 !important; color: #aaa !important; }
      `}</style>
    </div>
  );
}
