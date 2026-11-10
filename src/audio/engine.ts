import { GROUPS, MAX_VOICES, type PlayMode, type Project, type FxType, type Sound } from '../types';
import { Stretcher } from './stretch';
import { reverseBuffer } from './dsp';
import { MasterChain, SendFx } from './fx';

export interface Voice {
  g: number;
  p: number;
  src: AudioBufferSourceNode;
  env: GainNode;
  start: number;
  mode: PlayMode;
  release: number;
  released: boolean;
}

export interface TriggerInfo {
  g: number;
  p: number;
  time: number;
  duration: number;
}

/** 진행 중인 램프를 현재 값에서 멈춘다 (Firefox엔 cancelAndHoldAtTime이 없어 대체) */
function holdParam(param: AudioParam, t: number) {
  const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
  else {
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
  }
}

/**
 * 신호 흐름:
 *   BufferSource → env → panner ─┬─▶ groupBus[g] ───────────────┐
 *                                └─▶ send ─▶ groupSend[g] ─▶ SendFx ─▶ return ─┤
 *                                                                  ▼
 *                                       master ─▶ MasterChain(filter/loop/comp) ─▶ out
 */
export class Engine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  readonly master: GainNode;
  readonly chain: MasterChain;
  readonly fx: SendFx;
  /** 마스터 최종 출력 (리샘플링할 때 여기를 녹음한다) */
  readonly out: AudioNode;
  readonly groupBuses: GainNode[];
  readonly groupSends: GainNode[];
  private buffers = new Map<string, AudioBuffer>();
  private reversed = new Map<string, AudioBuffer>();
  private voices: Voice[] = [];
  onTrigger: ((info: TriggerInfo) => void) | null = null;
  readonly stretcher = new Stretcher();

  constructor(private getProject: () => Project) {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.chain = new MasterChain(ctx);
    this.fx = new SendFx(ctx);
    this.master.connect(this.chain.input);
    this.chain.output.connect(ctx.destination);
    this.out = this.chain.output;
    this.fx.ret.connect(this.master);
    this.groupBuses = Array.from({ length: GROUPS }, () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    });
    this.groupSends = Array.from({ length: GROUPS }, () => {
      const g = ctx.createGain();
      g.connect(this.fx.input);
      return g;
    });
  }

  setBuffer(id: string, buf: AudioBuffer) {
    this.buffers.set(id, buf);
    this.reversed.delete(id);
  }
  getBuffer(id: string) {
    return this.buffers.get(id);
  }
  hasBuffer(id: string) {
    return this.buffers.has(id);
  }
  deleteBuffer(id: string) {
    this.buffers.delete(id);
    this.reversed.delete(id);
  }

  private bufferFor(id: string, reverse: boolean): AudioBuffer | undefined {
    const buf = this.buffers.get(id);
    if (!buf || !reverse) return buf;
    let r = this.reversed.get(id);
    if (!r) {
      r = reverseBuffer(buf);
      this.reversed.set(id, r);
    }
    return r;
  }

  syncMix() {
    const p = this.getProject();
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(p.masterVolume, t, 0.02);
    p.groups.forEach((g, i) => {
      this.groupBuses[i].gain.setTargetAtTime(g.volume, t, 0.02);
      this.groupSends[i].gain.setTargetAtTime(g.volume, t, 0.02);
    });
  }

  private fxType: FxType | null = null;
  syncFx() {
    const { fx, bpm } = this.getProject();
    if (this.fxType !== fx.type) {
      this.fx.setType(fx.type);
      this.fxType = fx.type;
    }
    const [x, y] = fx.params[fx.type];
    this.fx.set(fx.type, x, y, bpm);
    this.fx.setReturn(fx.ret);
    this.chain.setFilter(fx.filter);
    this.chain.setComp(fx.comp);
  }

  /** 패드 하나를 time(AudioContext 시간)에 재생. semis는 KEYS 모드용 추가 음정. */
  trigger(g: number, p: number, time: number, velocity = 1, semis = 0): Voice | null {
    const project = this.getProject();
    const s = project.groups[g].sounds[p];
    if (!s.sampleId) return null;
    const buf = this.bufferFor(s.sampleId, s.reverse);
    if (!buf) return null;
    const ctx = this.ctx;
    const t = Math.max(time, ctx.currentTime);

    // 1) choke: oneshot은 같은 패드를 다시 치면 이전 소리를 끊고, mute group은 같은 번호끼리 끊는다
    for (const v of [...this.voices]) {
      if (v.g !== g) continue;
      const vs = project.groups[g].sounds[v.p];
      const samePadMono = v.p === p && s.mode === 'oneshot';
      const choked = s.muteGroup > 0 && vs.muteGroup === s.muteGroup && v.p !== p;
      if (samePadMono || choked) this.kill(v, t);
    }
    // 2) 동시 발음 수 제한: 가장 오래된 보이스를 훔친다
    while (this.voices.length >= MAX_VOICES) this.kill(this.voices[0], t);

    // 3) 재생 구간 계산 (reverse면 뒤집힌 버퍼에서 구간도 뒤집는다)
    const { a, len } = this.region(s, buf);
    const pitchRate = Math.pow(2, (s.pitch + semis) / 12);

    // 4) 타임스트레치
    //    repitch: playbackRate만 바꿈 (빠르면 음정도 올라감)
    //    stretch: Worker가 미리 늘려둔 버퍼를 재생 (아직 없으면 이번만 repitch로 대신)
    let playBuf = buf;
    let offset = a;
    let playLen = len;
    let rate = pitchRate;
    const target = this.targetSeconds(s, len);
    if (target !== null) {
      const factor = target / len;
      rate = pitchRate / factor;
      if (s.stretch === 'stretch') {
        const sf = factor * pitchRate;
        const sb = this.stretcher.get(this.stretchKey(s, sf));
        if (sb) {
          playBuf = sb;
          offset = 0;
          playLen = sb.duration;
          rate = pitchRate;
        } else this.requestStretch(s, buf, a, len, sf);
      }
    }
    // Length: 템포 기준 길이에서 잘라냄 (샘플마다 길이가 들쭉날쭉한 걸 맞추기)
    const fullLen = playLen / rate;
    const cut = s.length > 0 ? (s.length * 60) / this.getProject().bpm : Infinity;
    const realLen = Math.min(fullLen, cut);

    const src = ctx.createBufferSource();
    src.buffer = playBuf;
    src.playbackRate.value = rate;
    const env = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = s.pan;

    // 4) 앰프 엔벌로프: attack 상승 + 구간 끝에서 짧은 페이드(클릭 방지)
    const peak = s.volume * velocity;
    const atk = Math.max(0.002, s.attack);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + atk);
    const fade = cut < fullLen ? Math.min(0.012, realLen / 3) : Math.min(0.005, realLen / 4);
    if (realLen > atk + fade) {
      env.gain.setValueAtTime(peak, t + realLen - fade);
      env.gain.linearRampToValueAtTime(0, t + realLen);
    }

    src.connect(env).connect(pan).connect(this.groupBuses[g]);
    let send: GainNode | null = null;
    if (s.fxSend > 0) {
      send = ctx.createGain();
      send.gain.value = s.fxSend;
      pan.connect(send).connect(this.groupSends[g]);
    }
    src.start(t, offset, playLen);
    if (cut < fullLen) src.stop(t + realLen + 0.01);

    const v: Voice = { g, p, src, env, start: t, mode: s.mode, release: s.release, released: false };
    src.onended = () => {
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      src.disconnect();
      env.disconnect();
      pan.disconnect();
      send?.disconnect();
    };
    this.voices.push(v);
    this.onTrigger?.({ g, p, time: t, duration: realLen });
    return v;
  }

  // ---------------------------------------------------------------- time stretch
  private region(s: Sound, buf: AudioBuffer) {
    const dur = buf.duration;
    let a = Math.min(s.start, s.end) * dur;
    let b = Math.max(s.start, s.end) * dur;
    if (s.reverse) [a, b] = [dur - b, dur - a];
    return { a, len: Math.max(0.001, b - a) };
  }

  /** 타임 모드가 켜져 있으면 trim 구간이 차지해야 할 길이(초), 아니면 null */
  targetSeconds(s: Sound, len: number): number | null {
    const bpm = this.getProject().bpm;
    if (s.timeMode === 'bpm' && s.sampleBpm > 0) return (len * s.sampleBpm) / bpm;
    if (s.timeMode === 'bars' && s.bars > 0) return (s.bars * 4 * 60) / bpm;
    return null;
  }

  /** UI 표시용: 구간 길이, 목표 길이, 배율 */
  timeInfo(s: Sound): { len: number; target: number | null } | null {
    const buf = s.sampleId ? this.buffers.get(s.sampleId) : undefined;
    if (!buf) return null;
    const { len } = this.region(s, buf);
    return { len, target: this.targetSeconds(s, len) };
  }

  private stretchKey(s: Sound, sf: number) {
    return `${s.sampleId}|${s.reverse ? 1 : 0}|${s.start.toFixed(5)}|${s.end.toFixed(5)}|${sf.toFixed(4)}`;
  }

  private requestStretch(s: Sound, buf: AudioBuffer, a: number, len: number, sf: number) {
    const key = this.stretchKey(s, sf);
    const sr = buf.sampleRate;
    const i0 = Math.floor(a * sr);
    const i1 = Math.min(buf.length, i0 + Math.ceil(len * sr));
    const chs = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(i0, i1));
    this.stretcher.request(key, chs, sr, sf);
  }

  /** 파라미터나 BPM이 바뀌었을 때 미리 계산해 두기 (첫 타격부터 음정 유지되게) */
  prepare(s: Sound, semis = 0) {
    if (!s.sampleId || s.timeMode === 'off' || s.stretch !== 'stretch') return;
    const buf = this.bufferFor(s.sampleId, s.reverse);
    if (!buf) return;
    const { a, len } = this.region(s, buf);
    const target = this.targetSeconds(s, len);
    if (target === null) return;
    const sf = (target / len) * Math.pow(2, (s.pitch + semis) / 12);
    if (!this.stretcher.get(this.stretchKey(s, sf))) this.requestStretch(s, buf, a, len, sf);
  }

  prepareAll() {
    this.getProject().groups.forEach((g) => g.sounds.forEach((s) => this.prepare(s)));
  }

  /** key 모드 보이스 놓기 (oneshot은 무시하고 끝까지 재생) */
  release(v: Voice, time: number) {
    if (v.mode !== 'key' || v.released) return;
    v.released = true;
    const t = Math.max(time, this.ctx.currentTime);
    holdParam(v.env.gain, t);
    v.env.gain.setTargetAtTime(0, t, Math.max(0.003, v.release / 4));
    try {
      v.src.stop(t + v.release + 0.05);
    } catch {
      /* 이미 멈춤 */
    }
  }

  noteOff(g: number, p: number, time: number) {
    for (const v of this.voices) if (v.g === g && v.p === p) this.release(v, time);
  }

  /** 시퀀서 정지 시: 미리 예약돼 있던(아직 안 울린) 보이스 제거 + key 보이스 놓기 */
  stopScheduled() {
    const now = this.ctx.currentTime;
    for (const v of [...this.voices]) {
      if (v.start > now) this.kill(v, now);
      else this.release(v, now);
    }
  }

  private kill(v: Voice, time: number) {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    const t = Math.max(time, this.ctx.currentTime);
    holdParam(v.env.gain, t);
    v.env.gain.setTargetAtTime(0, t, 0.004); // 5ms 정도 페이드아웃 → 클릭 방지
    try {
      v.src.stop(t + 0.03);
    } catch {
      /* noop */
    }
  }

  click(time: number, accent: boolean) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = accent ? 1760 : 1100;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.25, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.04);
    o.connect(g).connect(this.ctx.destination);
    o.start(time);
    o.stop(time + 0.05);
  }
}
