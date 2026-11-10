import type { Engine } from './engine';

/**
 * 샘플링 입력.
 * (앱 안 유튜브 플레이어는 녹음하지 않는다 — 유튜브 정책. 큐 패드로만 연주)
 * - display: 다른 브라우저 탭·시스템 오디오 (getDisplayMedia)
 * - device: 마이크 / 라인 입력 / 오디오 인터페이스 (getUserMedia)
 * - resample: 이 샘플러의 마스터 출력 자체를 녹음
 *
 * MediaRecorder는 압축(opus)되므로 쓰지 않고, AudioWorklet에서 원본 PCM을 직접 받는다.
 * 연결돼 있는 동안 항상 최근 60초를 링버퍼에 담아 둔다 → "방금 들은 거 잡기"(GRAB)
 */
export type SourceKind =
  | { type: 'display' }
  | { type: 'device'; deviceId: string }
  | { type: 'resample' };

export const RING_SECONDS = 60;

const workletSrc = `
class RecProc extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.on = false; this.buf = null; this.n = 0; this.SIZE = 16384;
    this.ringLen = Math.floor(sampleRate * ${RING_SECONDS});
    this.ring = [new Float32Array(this.ringLen), new Float32Array(this.ringLen)];
    this.w = 0; this.filled = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m === 'start') { this.on = true; this.buf = null; this.n = 0; }
      else if (m === 'stop') { this.flush(); this.on = false; this.port.postMessage({ type: 'done' }); }
      else if (m === 'reset') { this.w = 0; this.filled = 0; this.ring[0].fill(0); this.ring[1].fill(0); }
      else if (m && m.type === 'grab') {
        const n = Math.min(this.filled, Math.floor(m.seconds * sampleRate));
        const out = [new Float32Array(n), new Float32Array(n)];
        const start = (this.w - n + this.ringLen) % this.ringLen;
        for (let c = 0; c < 2; c++) {
          const first = Math.min(n, this.ringLen - start);
          out[c].set(this.ring[c].subarray(start, start + first), 0);
          if (first < n) out[c].set(this.ring[c].subarray(0, n - first), first);
        }
        this.port.postMessage({ type: 'grab', data: out }, [out[0].buffer, out[1].buffer]);
      }
    };
  }
  flush() {
    if (this.buf && this.n > 0) this.port.postMessage({ type: 'chunk', data: this.buf.map(c => c.slice(0, this.n)) });
    this.buf = null; this.n = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const frames = inp[0].length;
    // 링버퍼 (항상)
    for (let c = 0; c < 2; c++) {
      const src = inp[c] || inp[0];
      const r = this.ring[c];
      for (let i = 0; i < frames; i++) r[(this.w + i) % this.ringLen] = src[i];
    }
    this.w = (this.w + frames) % this.ringLen;
    this.filled = Math.min(this.ringLen, this.filled + frames);
    // 녹음 (REC 중일 때만)
    if (this.on) {
      if (!this.buf) this.buf = [new Float32Array(this.SIZE), new Float32Array(this.SIZE)];
      for (let c = 0; c < 2; c++) this.buf[c].set(inp[c] || inp[0], this.n);
      this.n += frames;
      if (this.n + frames > this.SIZE) this.flush();
    }
    return true;
  }
}
registerProcessor('rec-proc', RecProc);
`;

const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export class Recorder {
  private node: AudioWorkletNode | null = null;
  private input: GainNode;
  private analyser: AnalyserNode;
  private monitor: GainNode;
  private srcNode: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[][] = [];
  private onDone: (() => void) | null = null;
  private onGrab: ((d: Float32Array[]) => void) | null = null;
  private meterBuf = new Float32Array(1024);
  recording = false;
  connected: string | null = null;
  kind: SourceKind['type'] | null = null;
  connectedAt = 0;
  onSourceEnded: (() => void) | null = null;

  constructor(private engine: Engine) {
    const ctx = engine.ctx;
    this.input = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.monitor = ctx.createGain();
    this.monitor.gain.value = 0;
    this.input.connect(this.analyser);
    this.input.connect(this.monitor).connect(ctx.destination);
  }

  private async ensureNode() {
    if (this.node) return;
    const ctx = this.engine.ctx;
    const url = URL.createObjectURL(new Blob([workletSrc], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    this.node = new AudioWorkletNode(ctx, 'rec-proc', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 2,
      channelCountMode: 'explicit', // 모노 입력은 L/R로 복제(upmix)
      channelInterpretation: 'speakers',
    });
    this.input.connect(this.node);
    // 그래프에 연결돼 있어야 process()가 돈다 → 무음 게인으로 destination에 연결
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.node.connect(sink).connect(ctx.destination);
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'chunk') this.chunks.push(e.data.data);
      else if (e.data.type === 'done') this.onDone?.();
      else if (e.data.type === 'grab') this.onGrab?.(e.data.data);
    };
  }

  /**
   * 주의: getDisplayMedia/getUserMedia는 "사용자 클릭 직후"에만 허용되므로
   * 다른 await보다 먼저 호출한다.
   */
  async connect(kind: SourceKind, label: string) {
    let stream: MediaStream | null = null;
    if (kind.type === 'device') {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...RAW,
          channelCount: 2,
          deviceId: kind.deviceId && kind.deviceId !== 'default' ? { exact: kind.deviceId } : undefined,
        },
      });
    } else if (kind.type === 'display') {
      // Chrome은 오디오만 단독 요청 불가 → video도 요청하되 쓰지 않음.
      // 이 탭(앱 안 유튜브 플레이어)은 고를 수 없게 막아 둔다.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { ...RAW, suppressLocalAudioPlayback: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
      } as DisplayMediaStreamOptions);
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('NO_AUDIO');
      }
      // 화면은 필요 없으니 영상 트랙은 꺼서 부하를 줄임
      stream.getVideoTracks().forEach((t) => (t.enabled = false));
    }

    this.disconnect();
    await this.ensureNode();
    this.node!.port.postMessage('reset');
    const ctx = this.engine.ctx;
    if (kind.type === 'resample') {
      this.engine.out.connect(this.input);
      this.srcNode = this.engine.out;
    } else if (stream) {
      this.stream = stream;
      const src = ctx.createMediaStreamSource(stream);
      src.connect(this.input);
      this.srcNode = src;
      stream.getTracks().forEach((t) => {
        t.onended = () => {
          if (this.stream !== stream) return;
          this.disconnect();
          this.onSourceEnded?.();
        };
      });
    }
    this.connected = label;
    this.kind = kind.type;
    this.connectedAt = performance.now();
  }

  disconnect() {
    if (this.srcNode) {
      try {
        this.srcNode.disconnect(this.input);
      } catch {
        /* noop */
      }
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.srcNode = null;
    this.connected = null;
    this.kind = null;
  }

  setMonitor(on: boolean) {
    this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.engine.ctx.currentTime, 0.01);
  }

  start() {
    if (!this.node) return;
    this.chunks = [];
    this.recording = true;
    this.node.port.postMessage('start');
  }

  stop(): Promise<Float32Array[]> {
    return new Promise((resolve) => {
      if (!this.node || !this.recording) return resolve([]);
      this.onDone = () => {
        this.onDone = null;
        this.recording = false;
        const total = this.chunks.reduce((n, c) => n + c[0].length, 0);
        const out = [new Float32Array(total), new Float32Array(total)];
        let o = 0;
        for (const c of this.chunks) {
          out[0].set(c[0], o);
          out[1].set(c[1], o);
          o += c[0].length;
        }
        this.chunks = [];
        resolve(total ? out : []);
      };
      this.node.port.postMessage('stop');
    });
  }

  /** 링버퍼에서 최근 seconds초를 꺼내 온다 */
  grab(seconds: number): Promise<Float32Array[]> {
    return new Promise((resolve) => {
      if (!this.node || !this.connected) return resolve([]);
      this.onGrab = (d) => {
        this.onGrab = null;
        resolve(d[0].length ? d : []);
      };
      this.node.port.postMessage({ type: 'grab', seconds });
    });
  }

  /** 연결 후 링버퍼에 쌓인 시간(초) */
  get bufferedSeconds() {
    return this.connected ? Math.min(RING_SECONDS, (performance.now() - this.connectedAt) / 1000) : 0;
  }

  /** 입력 레벨 (0..1 피크) */
  peak(): number {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let p = 0;
    for (let i = 0; i < this.meterBuf.length; i++) p = Math.max(p, Math.abs(this.meterBuf[i]));
    return p;
  }
}
