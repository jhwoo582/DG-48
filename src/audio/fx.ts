import type { FxType } from '../types';

/**
 * 이펙트 구성 (EP-133 구조를 참고)
 *
 * 1) 센드 FX — 한 번에 하나의 타입만 활성. 사운드마다 FX SEND 양으로 보낸다.
 *      voice ─┬─▶ groupBus (dry)
 *             └─▶ send ─▶ SendFx(delay|reverb|chorus|distortion) ─▶ return ─▶ master
 *
 * 2) 마스터 체인 — 전체 출력에 직렬로 걸림
 *      master ─▶ LPF ─▶ HPF ─▶ Looper(punch-in) ─▶ Compressor ─▶ makeup ─▶ out
 */

export const FX_TYPES: FxType[] = ['delay', 'reverb', 'chorus', 'distortion'];
export const FX_NAMES: Record<FxType, string> = {
  delay: 'Delay',
  reverb: 'Reverb',
  chorus: 'Chorus',
  distortion: 'Drive',
};
export const FX_PARAM_NAMES: Record<FxType, [string, string]> = {
  delay: ['Time', 'Feedback'],
  reverb: ['Decay', 'Tone'],
  chorus: ['Rate', 'Depth'],
  distortion: ['Drive', 'Tone'],
};

/** 딜레이 타임: BPM 동기 (박 단위) */
const DELAY_DIVS: [number, string][] = [
  [1 / 8, '1/32'],
  [1 / 4, '1/16'],
  [3 / 8, '1/16.'],
  [1 / 2, '1/8'],
  [2 / 3, '1/4T'],
  [3 / 4, '1/8.'],
  [1, '1/4'],
  [1.5, '1/4.'],
  [2, '1/2'],
];
const delayDiv = (x: number) => DELAY_DIVS[Math.round(x * (DELAY_DIVS.length - 1))];
const expMap = (x: number, a: number, b: number) => a * Math.pow(b / a, x);
const reverbDecay = (x: number) => 0.3 + x * x * 7.7;

export function fxValueLabel(type: FxType, which: 0 | 1, v: number): string {
  switch (type) {
    case 'delay':
      return which === 0 ? delayDiv(v)[1] : `${Math.round(v * 100)}%`;
    case 'reverb':
      return which === 0 ? `${reverbDecay(v).toFixed(1)}s` : `${Math.round(expMap(v, 1500, 16000) / 100) / 10}k`;
    case 'chorus':
      return which === 0 ? `${(0.1 + v * 4.9).toFixed(1)}Hz` : `${Math.round(v * 100)}%`;
    case 'distortion':
      return which === 0 ? `${Math.round(v * 100)}%` : `${Math.round(expMap(v, 800, 14000) / 100) / 10}k`;
  }
}

const smooth = (p: AudioParam, v: number, ctx: BaseAudioContext, tc = 0.03) =>
  p.setTargetAtTime(v, ctx.currentTime, tc);

interface Proc {
  input: AudioNode;
  output: AudioNode;
  set(x: number, y: number, bpm: number): void;
}

// ---------------------------------------------------------------- 센드 FX 프로세서들

/** 핑퐁 딜레이: 왼쪽 → 오른쪽 → (피드백) → 왼쪽 ... 피드백 경로에 로우패스로 테이프 느낌 */
function makeDelay(ctx: AudioContext): Proc {
  const input = ctx.createGain();
  input.channelCount = 1;
  input.channelCountMode = 'explicit';
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 5000;
  const dL = ctx.createDelay(4);
  const dR = ctx.createDelay(4);
  const fb = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  input.connect(tone).connect(dL);
  dL.connect(merger, 0, 0);
  dL.connect(dR);
  dR.connect(merger, 0, 1);
  dR.connect(fb).connect(tone);
  return {
    input,
    output: merger,
    set(x, y, bpm) {
      const t = (delayDiv(x)[0] * 60) / bpm;
      smooth(dL.delayTime, t, ctx, 0.05);
      smooth(dR.delayTime, t, ctx, 0.05);
      smooth(fb.gain, y * 0.92, ctx);
    },
  };
}

/** 리버브: 지수 감쇠 노이즈로 임펄스 응답(IR)을 만들어 Convolver에 넣는다 */
function makeReverb(ctx: AudioContext): Proc {
  const input = ctx.createGain();
  const pre = ctx.createDelay(0.1);
  pre.delayTime.value = 0.012;
  const conv = ctx.createConvolver();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  input.connect(pre).connect(conv).connect(tone);
  let lastDecay = -1;
  const buildIR = (decay: number) => {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * decay);
    const ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        // -60dB 지점이 decay초가 되도록
        d[i] = (Math.random() * 2 - 1) * Math.exp((-6.9 * t) / decay);
      }
    }
    conv.buffer = ir;
  };
  return {
    input,
    output: tone,
    set(x, y) {
      const decay = Math.round(reverbDecay(x) * 10) / 10;
      if (decay !== lastDecay) {
        lastDecay = decay;
        buildIR(decay);
      }
      smooth(tone.frequency, expMap(y, 1500, 16000), ctx);
    },
  };
}

/** 코러스: LFO로 짧은 딜레이 시간을 흔든다. 좌우 LFO 위상을 반대로 → 스테레오 폭 */
function makeChorus(ctx: AudioContext): Proc {
  const input = ctx.createGain();
  const dL = ctx.createDelay(0.1);
  const dR = ctx.createDelay(0.1);
  dL.delayTime.value = 0.018;
  dR.delayTime.value = 0.022;
  const lfo = ctx.createOscillator();
  const depthL = ctx.createGain();
  const depthR = ctx.createGain();
  lfo.connect(depthL).connect(dL.delayTime);
  lfo.connect(depthR).connect(dR.delayTime);
  lfo.start();
  const merger = ctx.createChannelMerger(2);
  input.connect(dL).connect(merger, 0, 0);
  input.connect(dR).connect(merger, 0, 1);
  return {
    input,
    output: merger,
    set(x, y) {
      smooth(lfo.frequency, 0.1 + x * 4.9, ctx);
      const d = y * 0.007;
      smooth(depthL.gain, d, ctx);
      smooth(depthR.gain, -d, ctx);
    },
  };
}

/** 디스토션: 드라이브 → tanh 웨이브셰이퍼 → 톤(로우패스) → 레벨 보정 */
function makeDistortion(ctx: AudioContext): Proc {
  const input = ctx.createGain();
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * 3);
  shaper.curve = curve;
  shaper.oversample = '4x';
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  const post = ctx.createGain();
  input.connect(shaper).connect(tone).connect(post);
  return {
    input,
    output: post,
    set(x, y) {
      const drive = expMap(x, 1, 40);
      smooth(input.gain, drive, ctx);
      smooth(post.gain, 0.6 / Math.sqrt(drive), ctx);
      smooth(tone.frequency, expMap(y, 800, 14000), ctx);
    },
  };
}

export class SendFx {
  readonly input: GainNode;
  readonly ret: GainNode;
  private procs: Record<FxType, Proc>;
  private active: FxType | null = null;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.ret = ctx.createGain();
    this.procs = {
      delay: makeDelay(ctx),
      reverb: makeReverb(ctx),
      chorus: makeChorus(ctx),
      distortion: makeDistortion(ctx),
    };
    for (const p of Object.values(this.procs)) p.output.connect(this.ret);
  }

  setType(t: FxType) {
    if (t === this.active) return;
    if (this.active) this.input.disconnect(this.procs[this.active].input);
    this.input.connect(this.procs[t].input);
    this.active = t;
  }

  set(t: FxType, x: number, y: number, bpm: number) {
    this.procs[t].set(x, y, bpm);
  }

  setReturn(v: number) {
    smooth(this.ret.gain, v, this.ctx);
  }
}

// ---------------------------------------------------------------- 마스터 체인

export type PunchKind = 'loop4' | 'loop8' | 'loop16' | 'loop32' | 'lpf' | 'hpf';
export const PUNCH: { kind: PunchKind; label: string; key: string; beats?: number }[] = [
  { kind: 'loop4', label: 'Loop 1/4', key: '7', beats: 1 },
  { kind: 'loop8', label: 'Loop 1/8', key: '8', beats: 1 / 2 },
  { kind: 'loop16', label: 'Loop 1/16', key: '9', beats: 1 / 4 },
  { kind: 'loop32', label: 'Loop 1/32', key: '0', beats: 1 / 8 },
  { kind: 'lpf', label: 'Low-pass', key: '-' },
  { kind: 'hpf', label: 'High-pass', key: '=' },
];

export class MasterChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private lp: BiquadFilterNode;
  private hp: BiquadFilterNode;
  private dry: GainNode;
  private loopIn: GainNode;
  private loopDelay: DelayNode;
  private loopFb: GainNode;
  private loopOut: GainNode;
  private comp: DynamicsCompressorNode;
  private filterValue = 0;
  private punchLP = false;
  private punchHP = false;

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain();
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 20;
    this.dry = ctx.createGain();
    this.loopIn = ctx.createGain();
    this.loopIn.gain.value = 0;
    this.loopDelay = ctx.createDelay(4);
    this.loopFb = ctx.createGain();
    this.loopFb.gain.value = 0;
    this.loopOut = ctx.createGain();
    this.loopOut.gain.value = 0;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 6;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.15;
    this.output = ctx.createGain();

    this.input.connect(this.lp).connect(this.hp);
    this.hp.connect(this.dry).connect(this.comp);
    this.hp.connect(this.loopIn).connect(this.loopDelay);
    this.loopDelay.connect(this.loopFb).connect(this.loopDelay);
    this.loopDelay.connect(this.loopOut).connect(this.comp);
    this.comp.connect(this.output);
  }

  /** DJ 필터: 왼쪽(-)으로 돌리면 로우패스, 오른쪽(+)이면 하이패스 */
  setFilter(v: number) {
    this.filterValue = v;
    this.applyFilter(0.03);
  }

  private applyFilter(tc: number) {
    const v = this.filterValue;
    const lpF = this.punchLP ? 320 : v < 0 ? expMap(-v, 20000, 150) : 20000;
    const hpF = this.punchHP ? 2200 : v > 0 ? expMap(v, 20, 5000) : 20;
    smooth(this.lp.frequency, lpF, this.ctx, tc);
    smooth(this.hp.frequency, hpF, this.ctx, tc);
    smooth(this.lp.Q, this.punchLP || v < -0.02 ? 4 : 0.707, this.ctx, tc);
    smooth(this.hp.Q, this.punchHP || v > 0.02 ? 4 : 0.707, this.ctx, tc);
  }

  /** 컴프 양: 스레시홀드를 내리고 비율을 올린 뒤 메이크업 게인으로 보정 */
  setComp(a: number) {
    smooth(this.comp.threshold, -2 - a * 28, this.ctx);
    smooth(this.comp.ratio, 2 + a * 10, this.ctx);
    smooth(this.output.gain, Math.pow(10, (a * 10) / 20), this.ctx);
  }

  punchFilter(kind: 'lpf' | 'hpf', on: boolean) {
    if (kind === 'lpf') this.punchLP = on;
    else this.punchHP = on;
    this.applyFilter(on ? 0.12 : 0.05);
  }

  /**
   * 비트 리피트 (DelayNode 하나로 구현)
   * time부터 L초 동안 입력을 딜레이 버퍼에 담고, 피드백 1로 무한 반복.
   * L초 뒤부터는 원음(dry)을 끄고 반복음(loopOut)만 들려준다.
   */
  loopStart(time: number, lengthSec: number) {
    const L = Math.min(3.9, Math.max(0.01, lengthSec));
    const t = Math.max(time, this.ctx.currentTime);
    const set = (p: AudioParam, v: number, at: number) => {
      p.cancelScheduledValues(at);
      p.setTargetAtTime(v, at, 0.002);
    };
    this.loopDelay.delayTime.cancelScheduledValues(t);
    this.loopDelay.delayTime.setValueAtTime(L, t);
    set(this.loopIn.gain, 1, t);
    // 담는 동안엔 피드백 0 (이전 루프 잔향이 섞이지 않게), 다 담은 뒤 1로 반복
    set(this.loopFb.gain, 0, t);
    this.loopFb.gain.setTargetAtTime(1, t + L, 0.002);
    this.loopIn.gain.setTargetAtTime(0, t + L, 0.002);
    this.loopOut.gain.setTargetAtTime(1, t + L, 0.002);
    this.dry.gain.cancelScheduledValues(t);
    this.dry.gain.setTargetAtTime(0, t + L, 0.002);
  }

  loopStop() {
    const t = this.ctx.currentTime;
    for (const [p, v] of [
      [this.dry.gain, 1],
      [this.loopOut.gain, 0],
      [this.loopFb.gain, 0],
      [this.loopIn.gain, 0],
    ] as [AudioParam, number][]) {
      p.cancelScheduledValues(t);
      p.setTargetAtTime(v, t, 0.003);
    }
  }
}
