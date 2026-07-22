import { useEffect, useRef, useState } from 'react';
import { SpeechSession, speechSupported } from '../lib/speech';
import { useAppStore } from '../store/useAppStore';

export function VoiceInput() {
  const inputMode = useAppStore((s) => s.inputMode);
  if (inputMode === 'voice' && speechSupported) return <VoicePill />;
  return <KeyboardRow />;
}

function VoicePill() {
  const setInterim = useAppStore((s) => s.setInterim);
  const setInputMode = useAppStore((s) => s.setInputMode);
  const sendUserMessage = useAppStore((s) => s.sendUserMessage);
  const showToast = useAppStore((s) => s.showToast);

  const [recording, setRecording] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const sessionRef = useRef<SpeechSession | null>(null);
  const cancellingRef = useRef(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const levelsRef = useRef<number[]>([]);

  const start = () => {
    if (sessionRef.current) return;
    cancellingRef.current = false;
    setCancelling(false);
    levelsRef.current = [];
    try {
      const session = new SpeechSession({
        onInterim: (t) => setInterim(t),
        onFinish: (t) => {
          sessionRef.current = null;
          setRecording(false);
          setInterim(null);
          if (t) void sendUserMessage(t);
        },
        onCancel: () => {
          sessionRef.current = null;
          setRecording(false);
          setInterim(null);
        },
        onLevel: (l) => {
          const arr = levelsRef.current;
          arr.push(l);
          if (arr.length > 48) arr.shift();
        },
      });
      sessionRef.current = session;
      setRecording(true);
      setInterim('');
      void session.start();
    } catch {
      showToast('这个浏览器不支持语音输入,已切换为键盘');
      setInputMode('keyboard');
    }
  };

  const finish = () => {
    if (!sessionRef.current) return;
    if (cancellingRef.current) sessionRef.current.cancel();
    else sessionRef.current.stop();
  };

  const cancel = () => sessionRef.current?.cancel();

  // spacebar hold-to-talk
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      start();
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') finish();
      if (e.code === 'Escape') cancel();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      sessionRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // waveform
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = waveRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d')!;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const levels = levelsRef.current;
      const mid = height / 2;
      for (let x = 0; x < width; x++) {
        const idx = (x / width) * (levels.length - 1);
        const l = levels.length ? (levels[Math.floor(idx)] ?? 0) : 0;
        const y = mid + Math.sin(x * 0.25 + performance.now() * 0.01) * l * mid * 0.9;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!sessionRef.current || !pillRef.current) return;
    const r = pillRef.current.getBoundingClientRect();
    const out =
      e.clientY < r.top - 36 || e.clientY > r.bottom + 36 || e.clientX < r.left - 36 || e.clientX > r.right + 36;
    cancellingRef.current = out;
    setCancelling(out);
  };

  return (
    <div className="voice-area">
      {recording && (
        <div className={`voice-tip ${cancelling ? 'voice-tip--cancel' : ''}`}>
          {cancelling ? '松开取消' : '长按说话 (上滑或移出取消)'}
        </div>
      )}
      <div className="voice-row">
        <button
          ref={pillRef}
          className={`voice-pill ${recording ? 'voice-pill--rec' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={cancel}
          onContextMenu={(e) => e.preventDefault()}
        >
          {recording ? (
            <canvas ref={waveRef} width={200} height={30} className="voice-wave" />
          ) : (
            <>
              <MicIcon /> 按住说话 / 空格键
            </>
          )}
        </button>
        <button
          className="icon-btn"
          title="键盘输入"
          onClick={() => setInputMode('keyboard')}
        >
          ⌨
        </button>
      </div>
    </div>
  );
}

function KeyboardRow() {
  const [text, setText] = useState('');
  const sendUserMessage = useAppStore((s) => s.sendUserMessage);
  const setInputMode = useAppStore((s) => s.setInputMode);
  const busy = useAppStore((s) => s.busy);

  const send = () => {
    if (!text.trim() || busy) return;
    void sendUserMessage(text);
    setText('');
  };

  return (
    <div className="voice-area">
      <div className="keyboard-row">
        {speechSupported && (
          <button className="icon-btn" title="语音输入" onClick={() => setInputMode('voice')}>
            <MicIcon />
          </button>
        )}
        <input
          className="chat-input"
          value={text}
          placeholder="说点什么…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            send();
          }}
          autoFocus
        />
        <button className="send-btn" onClick={send} disabled={!text.trim() || busy}>
          发送
        </button>
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
    </svg>
  );
}
