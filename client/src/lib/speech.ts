/* Minimal ambient types for the Web Speech API (not in lib.dom for all setups). */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | undefined {
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
    | (new () => SpeechRecognitionLike)
    | undefined;
}

export const speechSupported = Boolean(getSpeechRecognition());

export interface SpeechHandlers {
  onInterim: (text: string) => void;
  onFinish: (finalText: string) => void;
  onCancel: () => void;
  onLevel?: (level: number) => void; // 0..1 mic level for the waveform
}

/** One hold-to-talk recording session. */
export class SpeechSession {
  private recognition: SpeechRecognitionLike;
  private finalText = '';
  private interimText = '';
  private stopped = false;
  private cancelled = false;
  private stream?: MediaStream;
  private audioCtx?: AudioContext;
  private levelTimer?: number;
  private settleTimer?: number;
  private startGeneration = 0;

  constructor(private handlers: SpeechHandlers) {
    const Ctor = getSpeechRecognition();
    if (!Ctor) throw new Error('SpeechRecognition unsupported');
    this.recognition = new Ctor();
    this.recognition.lang = 'zh-CN';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i]!;
        if (r.isFinal) this.finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.interimText = interim;
      if (!this.stopped) this.handlers.onInterim(this.finalText + this.interimText);
    };
    this.recognition.onend = () => this.settle();
    this.recognition.onerror = () => this.settle();
  }

  async start(): Promise<void> {
    if (this.stopped || this.settled) return;
    const generation = ++this.startGeneration;
    try {
      this.recognition.start();
    } catch (error) {
      // Browsers throw synchronously when recognition is already running or
      // permission was denied. Turn that into the normal cancelled lifecycle;
      // callers should never have to handle a rejected start promise.
      console.warn('[speech] recognition start failed', error);
      this.cancelled = true;
      this.stopped = true;
      this.settle();
      return;
    }

    // Mic level for the waveform is independent of recognition. Permission
    // can resolve after the user releases the button, so every async step
    // checks the session generation before retaining a resource.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.stopped || this.settled || generation !== this.startGeneration) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.audioCtx = new AudioContext();
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      this.audioCtx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (this.stopped || this.settled) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i]! - 128);
        this.handlers.onLevel?.(Math.min(1, (sum / data.length / 40) * 1.5));
      };
      this.levelTimer = window.setInterval(tick, 50);
    } catch (error) {
      // Speech recognition can still work without a waveform. If the session
      // was already stopped, release any stream that arrived during the race.
      if (this.stopped || this.settled) {
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = undefined;
      } else {
        console.warn('[speech] microphone level unavailable', error);
      }
    }
  }

  /** Release → send whatever was recognized. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.recognition.stop();
    } catch {
      this.settle();
      return;
    }
    // Safety net if onend never fires
    this.settleTimer = window.setTimeout(() => this.settle(), 1500);
  }

  /** Slide-away → discard. */
  cancel(): void {
    if (this.settled) return;
    this.stopped = true;
    this.cancelled = true;
    ++this.startGeneration;
    try {
      this.recognition.abort();
    } catch {
      // Recognition may not have started; local resources still need cleanup.
    }
    this.settle();
  }

  private settled = false;
  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.stopped = true;
    ++this.startGeneration;
    if (this.settleTimer) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
    if (this.levelTimer) window.clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = undefined;
    this.recognition.onresult = null;
    this.recognition.onend = null;
    this.recognition.onerror = null;
    if (this.cancelled) this.handlers.onCancel();
    else this.handlers.onFinish((this.finalText + this.interimText).trim());
  }
}
