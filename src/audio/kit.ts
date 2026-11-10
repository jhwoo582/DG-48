import type { Sound } from '../types';
import { normalize } from './dsp';

/**
 * 기본 키트: 외부 파일 없이 OfflineAudioContext로 합성해서 만든다 (저작권 걱정 없음).
 * 그룹 A = 드럼, B = 베이스/신스, C = 드럼 2 + 퍼커션, D = 건반/신스 2 + FX
 */
const SR = 48000;

export interface KitPad {
  id: string;
  name: string;
  sound?: Partial<Sound>;
}

type Build = (c: OfflineAudioContext, out: AudioNode) => void;

async function render(dur: number, build: Build): Promise<AudioBuffer> {
  const c = new OfflineAudioContext(1, Math.ceil(dur * SR), SR);
  const out = c.createGain();
  out.connect(c.destination);
  build(c, out);
  const buf = await c.startRendering();
  const ch = [buf.getChannelData(0)];
  normalize(ch, 0.9);
  return buf;
}

function noise(c: BaseAudioContext, dur: number): AudioBufferSourceNode {
  const b = c.createBuffer(1, Math.ceil(dur * SR), SR);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource();
  s.buffer = b;
  return s;
}

/** 지수 감쇠 엔벌로프 */
function perc(p: AudioParam, t: number, peak: number, decay: number, attack = 0.001) {
  p.setValueAtTime(0.0001, t);
  p.exponentialRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** attack → hold → release 엔벌로프 */
function ahr(p: AudioParam, a: number, h: number, r: number, peak = 1) {
  p.setValueAtTime(0, 0);
  p.linearRampToValueAtTime(peak, a);
  p.setValueAtTime(peak, a + h);
  p.linearRampToValueAtTime(0, a + h + r);
}

function filter(c: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.7) {
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function osc(c: BaseAudioContext, type: OscillatorType, freq: number, dur: number) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(0);
  o.stop(dur);
  return o;
}

function saturate(c: BaseAudioContext, k: number) {
  const ws = c.createWaveShaper();
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  ws.curve = curve;
  return ws;
}

/** 808 스타일 금속성 소리 (6개 사각파) */
function metal(c: BaseAudioContext, out: AudioNode, decay: number, hp: number) {
  const sum = c.createGain();
  sum.gain.value = 0.25;
  [205.3, 304.4, 369.6, 522.7, 540, 800].forEach((f) => osc(c, 'square', f, decay + 0.1).connect(sum));
  const env = c.createGain();
  perc(env.gain, 0, 1, decay);
  sum.connect(filter(c, 'bandpass', 10000, 0.8)).connect(filter(c, 'highpass', hp)).connect(env).connect(out);
}

const builders: Record<string, [number, Build]> = {
  'kit:kick': [0.9, (c, out) => {
    const o = osc(c, 'sine', 170, 0.9);
    o.frequency.setValueAtTime(170, 0);
    o.frequency.exponentialRampToValueAtTime(48, 0.13);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.7, 0.002);
    o.connect(g).connect(saturate(c, 2.5)).connect(out);
    const n = noise(c, 0.02);
    const ng = c.createGain();
    perc(ng.gain, 0, 0.4, 0.01);
    n.connect(filter(c, 'highpass', 3000)).connect(ng).connect(out);
    n.start(0);
  }],
  'kit:snare': [0.4, (c, out) => {
    const o = osc(c, 'triangle', 190, 0.3);
    o.frequency.exponentialRampToValueAtTime(160, 0.1);
    const g = c.createGain();
    perc(g.gain, 0, 0.7, 0.12);
    o.connect(g).connect(out);
    const n = noise(c, 0.4);
    const ng = c.createGain();
    perc(ng.gain, 0, 0.8, 0.22);
    n.connect(filter(c, 'highpass', 1500)).connect(ng).connect(out);
    n.start(0);
  }],
  'kit:clap': [0.45, (c, out) => {
    const n = noise(c, 0.45);
    const g = c.createGain();
    g.gain.setValueAtTime(0, 0);
    [0, 0.011, 0.022].forEach((t) => {
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.1, t + 0.009);
    });
    g.gain.setValueAtTime(0.9, 0.033);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.33);
    n.connect(filter(c, 'bandpass', 1100, 1.2)).connect(g).connect(out);
    n.start(0);
  }],
  'kit:ch': [0.15, (c, out) => metal(c, out, 0.05, 7000)],
  'kit:oh': [0.7, (c, out) => metal(c, out, 0.45, 7000)],
  'kit:rim': [0.1, (c, out) => {
    const o = osc(c, 'triangle', 1700, 0.1);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.03);
    o.connect(g).connect(out);
    const n = noise(c, 0.05);
    const ng = c.createGain();
    perc(ng.gain, 0, 0.5, 0.01);
    n.connect(filter(c, 'bandpass', 3000, 2)).connect(ng).connect(out);
    n.start(0);
  }],
  'kit:tomlo': [0.6, (c, out) => {
    const o = osc(c, 'sine', 130, 0.6);
    o.frequency.exponentialRampToValueAtTime(80, 0.3);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.45);
    o.connect(g).connect(out);
  }],
  'kit:tomhi': [0.5, (c, out) => {
    const o = osc(c, 'sine', 220, 0.5);
    o.frequency.exponentialRampToValueAtTime(140, 0.25);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.35);
    o.connect(g).connect(out);
  }],
  'kit:cowbell': [0.4, (c, out) => {
    const sum = c.createGain();
    osc(c, 'square', 540, 0.4).connect(sum);
    osc(c, 'square', 800, 0.4).connect(sum);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.3);
    sum.connect(filter(c, 'bandpass', 800, 1.5)).connect(g).connect(out);
  }],
  'kit:shaker': [0.15, (c, out) => {
    const n = noise(c, 0.15);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.08, 0.02);
    n.connect(filter(c, 'bandpass', 6000, 1.5)).connect(g).connect(out);
    n.start(0);
  }],
  'kit:zap': [0.3, (c, out) => {
    const o = osc(c, 'sine', 1400, 0.3);
    o.frequency.exponentialRampToValueAtTime(70, 0.15);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.2);
    o.connect(g).connect(out);
  }],
  'kit:crash': [1.6, (c, out) => {
    metal(c, out, 1.3, 4500);
    const n = noise(c, 1.6);
    const g = c.createGain();
    perc(g.gain, 0, 0.35, 1.2);
    n.connect(filter(c, 'highpass', 6000)).connect(g).connect(out);
    n.start(0);
  }],

  // --- 그룹 B: 멜로딕 (KEYS 모드로 연주해 보세요) ---
  'kit:bass': [0.8, (c, out) => {
    const f = filter(c, 'lowpass', 2000, 6);
    f.frequency.setValueAtTime(2000, 0);
    f.frequency.exponentialRampToValueAtTime(120, 0.3);
    osc(c, 'sawtooth', 55, 0.8).connect(f);
    const sq = c.createGain();
    sq.gain.value = 0.3;
    osc(c, 'square', 55, 0.8).connect(sq).connect(f);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.6, 0.003);
    f.connect(g).connect(out);
  }],
  'kit:sub': [1.8, (c, out) => {
    const o = osc(c, 'sine', 70, 1.8);
    o.frequency.setValueAtTime(70, 0);
    o.frequency.exponentialRampToValueAtTime(55, 0.06);
    const g = c.createGain();
    perc(g.gain, 0, 1, 1.6, 0.003);
    o.connect(g).connect(saturate(c, 1.8)).connect(out);
  }],
  'kit:pluck': [0.6, (c, out) => {
    const f = filter(c, 'lowpass', 4000, 3);
    f.frequency.setValueAtTime(4000, 0);
    f.frequency.exponentialRampToValueAtTime(300, 0.25);
    osc(c, 'sawtooth', 220, 0.6).connect(f);
    osc(c, 'sawtooth', 220.8, 0.6).connect(f);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.45, 0.002);
    f.connect(g).connect(out);
  }],
  'kit:bell': [1.8, (c, out) => {
    const car = osc(c, 'sine', 880, 1.8);
    const mod = osc(c, 'sine', 880 * 1.4, 1.8);
    const idx = c.createGain();
    idx.gain.setValueAtTime(1200, 0);
    idx.gain.exponentialRampToValueAtTime(1, 1.2);
    mod.connect(idx).connect(car.frequency);
    const g = c.createGain();
    perc(g.gain, 0, 1, 1.5);
    car.connect(g).connect(out);
  }],
  'kit:stab': [0.7, (c, out) => {
    const f = filter(c, 'lowpass', 2600, 2);
    f.frequency.setValueAtTime(2600, 0);
    f.frequency.exponentialRampToValueAtTime(800, 0.4);
    [220, 261.63, 329.63, 392].forEach((hz) => osc(c, 'sawtooth', hz, 0.7).connect(f));
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.5, 0.005);
    f.connect(g).connect(out);
  }],
  'kit:pad': [2.6, (c, out) => {
    const f = filter(c, 'lowpass', 1400, 1);
    [174.61, 220, 261.63, 329.63].forEach((hz) => {
      const a = osc(c, 'sawtooth', hz, 2.6);
      a.detune.value = 6;
      const b = osc(c, 'sawtooth', hz, 2.6);
      b.detune.value = -6;
      a.connect(f);
      b.connect(f);
    });
    const g = c.createGain();
    ahr(g.gain, 0.4, 1.4, 0.75);
    f.connect(g).connect(out);
  }],
  'kit:lead': [0.9, (c, out) => {
    const o = osc(c, 'square', 440, 0.9);
    const lfo = osc(c, 'sine', 5.5, 0.9);
    const depth = c.createGain();
    depth.gain.value = 6;
    lfo.connect(depth).connect(o.frequency);
    const g = c.createGain();
    ahr(g.gain, 0.01, 0.6, 0.25);
    o.connect(filter(c, 'lowpass', 3000)).connect(g).connect(out);
  }],
  'kit:organ': [1.1, (c, out) => {
    const sum = c.createGain();
    [[220, 1], [440, 0.6], [660, 0.4], [880, 0.3], [1320, 0.15]].forEach(([hz, a]) => {
      const g = c.createGain();
      g.gain.value = a;
      osc(c, 'sine', hz, 1.1).connect(g).connect(sum);
    });
    const g = c.createGain();
    ahr(g.gain, 0.01, 0.9, 0.15);
    sum.connect(g).connect(out);
  }],
  'kit:vox': [1.0, (c, out) => {
    const o = osc(c, 'sawtooth', 220, 1.0);
    const lfo = osc(c, 'sine', 5, 1.0);
    const depth = c.createGain();
    depth.gain.value = 3;
    lfo.connect(depth).connect(o.frequency);
    const g = c.createGain();
    ahr(g.gain, 0.05, 0.7, 0.2);
    [[800, 1], [1150, 0.5], [2900, 0.25]].forEach(([hz, a]) => {
      const fg = c.createGain();
      fg.gain.value = a;
      o.connect(filter(c, 'bandpass', hz, 8)).connect(fg).connect(g);
    });
    g.connect(out);
  }],
  'kit:riser': [2.0, (c, out) => {
    const n = noise(c, 2.0);
    const f = filter(c, 'bandpass', 300, 4);
    f.frequency.setValueAtTime(300, 0);
    f.frequency.exponentialRampToValueAtTime(8000, 2.0);
    const g = c.createGain();
    g.gain.setValueAtTime(0, 0);
    g.gain.linearRampToValueAtTime(1, 1.9);
    g.gain.linearRampToValueAtTime(0, 2.0);
    n.connect(f).connect(g).connect(out);
    n.start(0);
  }],
  'kit:vinyl': [2.0, (c, out) => {
    const b = c.createBuffer(1, 2 * SR, SR);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      d[i] = (Math.random() * 2 - 1) * 0.03 + (Math.random() < 0.0006 ? Math.random() * 2 - 1 : 0);
    }
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(filter(c, 'lowpass', 5000)).connect(out);
    s.start(0);
  }],
};

export const KIT_A: KitPad[] = [
  { id: 'kit:kick', name: 'KICK' },
  { id: 'kit:snare', name: 'SNARE', sound: { fxSend: 0.15 } },
  { id: 'kit:clap', name: 'CLAP', sound: { fxSend: 0.3 } },
  { id: 'kit:ch', name: 'HAT CL', sound: { muteGroup: 1, volume: 0.6 } },
  { id: 'kit:oh', name: 'HAT OP', sound: { muteGroup: 1, volume: 0.55 } },
  { id: 'kit:rim', name: 'RIM', sound: { volume: 0.6, fxSend: 0.3 } },
  { id: 'kit:tomlo', name: 'TOM LO' },
  { id: 'kit:tomhi', name: 'TOM HI' },
  { id: 'kit:cowbell', name: 'COWBELL', sound: { volume: 0.5 } },
  { id: 'kit:shaker', name: 'SHAKER', sound: { volume: 0.5 } },
  { id: 'kit:zap', name: 'ZAP' },
  { id: 'kit:crash', name: 'CRASH', sound: { volume: 0.55 } },
];

const key = (o: Partial<Sound> = {}): Partial<Sound> => ({ mode: 'key', release: 0.15, ...o });
export const KIT_B: KitPad[] = [
  { id: 'kit:bass', name: 'BASS', sound: key() },
  { id: 'kit:sub', name: '808 SUB', sound: key({ release: 0.3 }) },
  { id: 'kit:pluck', name: 'PLUCK', sound: key({ fxSend: 0.35 }) },
  { id: 'kit:bell', name: 'BELL', sound: key({ release: 0.6, volume: 0.6, fxSend: 0.35 }) },
  { id: 'kit:stab', name: 'STAB', sound: key({ volume: 0.6 }) },
  { id: 'kit:pad', name: 'PAD', sound: key({ release: 0.8, volume: 0.6 }) },
  { id: 'kit:lead', name: 'LEAD', sound: key({ volume: 0.5, fxSend: 0.3 }) },
  { id: 'kit:organ', name: 'ORGAN', sound: key({ volume: 0.6 }) },
  { id: 'kit:vox', name: 'VOX', sound: key({ volume: 0.7 }) },
  { id: 'kit:riser', name: 'RISER', sound: { volume: 0.5 } },
  { id: 'kit:vinyl', name: 'VINYL', sound: { volume: 0.5 } },
  { id: 'kit:crash', name: 'REV CRASH', sound: { reverse: true, volume: 0.5 } },
];

/** 기본 데모 패턴: 처음 실행할 때 들어가는 예시 */
export interface DemoPattern {
  group: number;
  pattern: number;
  bars?: number;
  notes: [pad: number, steps: number[]][];
}
const range = (a: number, b: number, step = 1) => Array.from({ length: Math.ceil((b - a) / step) }, (_, i) => a + i * step);
export const DEMO_PATTERNS: DemoPattern[] = [
  // A-1: 기본 붐뱁
  { group: 0, pattern: 0, notes: [[0, [0, 6, 10]], [1, [4, 12]], [3, range(0, 14, 2)], [4, [14]], [9, [3, 11]]] },
  // A-2: 2마디 변주 + 필인
  {
    group: 0,
    pattern: 1,
    bars: 2,
    notes: [
      [0, [0, 6, 10, 16, 22, 26, 27]],
      [1, [4, 12, 20, 28]],
      [2, [12, 28]],
      [3, [...range(0, 16, 2), ...range(16, 28, 2)]],
      [4, [14]],
      [6, [30, 31]],
      [7, [29]],
      [11, [0]],
    ],
  },
  // B-1: 베이스 라인
  { group: 1, pattern: 0, notes: [[0, [0, 3, 7, 10]]] },
];

export async function renderKit(): Promise<Map<string, AudioBuffer>> {
  const entries = await Promise.all(
    Object.entries({ ...builders, ...builders2 }).map(async ([id, [dur, build]]) => [id, await render(dur, build)] as const),
  );
  return new Map(entries);
}

// ---------------------------------------------------------------- 그룹 C, D

function fm(c: BaseAudioContext, freq: number, ratio: number, index: number, decay: number, dur: number) {
  const car = osc(c, 'sine', freq, dur);
  const mod = osc(c, 'sine', freq * ratio, dur);
  const idx = c.createGain();
  idx.gain.setValueAtTime(index, 0);
  idx.gain.exponentialRampToValueAtTime(1, decay);
  mod.connect(idx).connect(car.frequency);
  return car;
}

const builders2: Record<string, [number, Build]> = {
  'kit:kick2': [0.6, (c, out) => {
    const o = osc(c, 'sine', 230, 0.6);
    o.frequency.setValueAtTime(230, 0);
    o.frequency.exponentialRampToValueAtTime(52, 0.08);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.42, 0.001);
    o.connect(g).connect(saturate(c, 3)).connect(out);
    const n = noise(c, 0.03);
    const ng = c.createGain();
    perc(ng.gain, 0, 0.6, 0.015);
    n.connect(filter(c, 'highpass', 1500)).connect(ng).connect(out);
    n.start(0);
  }],
  'kit:snare2': [0.3, (c, out) => {
    [180, 330].forEach((hz) => {
      const g = c.createGain();
      perc(g.gain, 0, 0.5, 0.08);
      osc(c, 'triangle', hz, 0.3).connect(g).connect(out);
    });
    const n = noise(c, 0.3);
    const ng = c.createGain();
    perc(ng.gain, 0, 1, 0.17);
    n.connect(filter(c, 'highpass', 2000)).connect(ng).connect(out);
    n.start(0);
  }],
  'kit:clap2': [0.8, (c, out) => {
    const n = noise(c, 0.8);
    const g = c.createGain();
    g.gain.setValueAtTime(0, 0);
    [0, 0.008, 0.018, 0.026].forEach((t) => {
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.1, t + 0.007);
    });
    g.gain.setValueAtTime(0.7, 0.034);
    g.gain.exponentialRampToValueAtTime(0.0001, 0.7);
    n.connect(filter(c, 'bandpass', 1500, 0.8)).connect(g).connect(out);
    n.start(0);
  }],
  'kit:ch2': [0.1, (c, out) => {
    const n = noise(c, 0.1);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.035);
    n.connect(filter(c, 'highpass', 9000)).connect(g).connect(out);
    n.start(0);
  }],
  'kit:oh2': [0.5, (c, out) => {
    const n = noise(c, 0.5);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.32);
    n.connect(filter(c, 'highpass', 8000)).connect(g).connect(out);
    n.start(0);
    metal(c, out, 0.3, 9000);
  }],
  'kit:ride': [2.0, (c, out) => {
    metal(c, out, 1.7, 3000);
    const b = c.createGain();
    perc(b.gain, 0, 0.25, 1.2);
    osc(c, 'sine', 3150, 2).connect(b).connect(out);
  }],
  'kit:congalo': [0.4, (c, out) => {
    const o = osc(c, 'sine', 210, 0.4);
    o.frequency.exponentialRampToValueAtTime(190, 0.1);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.3);
    o.connect(g).connect(out);
  }],
  'kit:congahi': [0.3, (c, out) => {
    const o = osc(c, 'sine', 320, 0.3);
    o.frequency.exponentialRampToValueAtTime(300, 0.08);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.22);
    o.connect(g).connect(out);
  }],
  'kit:bongo': [0.2, (c, out) => {
    const o = osc(c, 'sine', 440, 0.2);
    o.frequency.exponentialRampToValueAtTime(390, 0.05);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.12);
    o.connect(g).connect(out);
  }],
  'kit:clave': [0.12, (c, out) => {
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.05);
    osc(c, 'triangle', 2500, 0.12).connect(g).connect(out);
  }],
  'kit:tamb': [0.35, (c, out) => {
    const n = noise(c, 0.35);
    const g = c.createGain();
    g.gain.setValueAtTime(0, 0);
    [0, 0.03, 0.06].forEach((t, i) => {
      g.gain.setValueAtTime(1 - i * 0.25, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.025);
    });
    g.gain.exponentialRampToValueAtTime(0.0001, 0.3);
    n.connect(filter(c, 'bandpass', 7500, 1.2)).connect(g).connect(out);
    n.start(0);
  }],
  'kit:snap': [0.15, (c, out) => {
    const n = noise(c, 0.15);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.04);
    n.connect(filter(c, 'bandpass', 2500, 3)).connect(g).connect(out);
    n.start(0);
    const tg = c.createGain();
    perc(tg.gain, 0, 0.4, 0.015);
    osc(c, 'sine', 1800, 0.1).connect(tg).connect(out);
  }],

  'kit:epiano': [2.0, (c, out) => {
    const g = c.createGain();
    perc(g.gain, 0, 1, 1.6, 0.003);
    fm(c, 440, 1, 300, 0.8, 2).connect(g);
    const tine = c.createGain();
    perc(tine.gain, 0, 0.3, 0.06);
    fm(c, 440, 14, 400, 0.1, 2).connect(tine).connect(g);
    g.connect(out);
  }],
  'kit:marimba': [0.7, (c, out) => {
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.5, 0.002);
    osc(c, 'sine', 440, 0.7).connect(g);
    const h = c.createGain();
    perc(h.gain, 0, 0.4, 0.06);
    osc(c, 'sine', 440 * 4, 0.7).connect(h).connect(g);
    g.connect(out);
  }],
  'kit:chord': [1.2, (c, out) => {
    const f = filter(c, 'lowpass', 1800, 1);
    [261.63, 329.63, 392, 493.88, 587.33].forEach((hz) => {
      osc(c, 'sawtooth', hz, 1.2).connect(f);
      osc(c, 'square', hz * 0.5, 1.2).connect(f);
    });
    const g = c.createGain();
    perc(g.gain, 0, 1, 1.0, 0.005);
    f.connect(g).connect(out);
  }],
  'kit:brass': [0.9, (c, out) => {
    const f = filter(c, 'lowpass', 400, 2);
    f.frequency.setValueAtTime(400, 0);
    f.frequency.linearRampToValueAtTime(2600, 0.08);
    f.frequency.exponentialRampToValueAtTime(1400, 0.5);
    [-8, 8].forEach((d) => {
      const o = osc(c, 'sawtooth', 220, 0.9);
      o.detune.value = d;
      o.connect(f);
    });
    const g = c.createGain();
    ahr(g.gain, 0.05, 0.55, 0.25);
    f.connect(g).connect(out);
  }],
  'kit:strings': [2.4, (c, out) => {
    const f = filter(c, 'lowpass', 2500, 0.7);
    const lfo = osc(c, 'sine', 5, 2.4);
    const depth = c.createGain();
    depth.gain.value = 1.5;
    lfo.connect(depth);
    [-12, 0, 12].forEach((d) => {
      const o = osc(c, 'sawtooth', 220, 2.4);
      o.detune.value = d;
      depth.connect(o.frequency);
      o.connect(f);
    });
    const g = c.createGain();
    ahr(g.gain, 0.35, 1.3, 0.7);
    f.connect(g).connect(out);
  }],
  'kit:choir': [2.2, (c, out) => {
    const g = c.createGain();
    ahr(g.gain, 0.25, 1.3, 0.6);
    [-7, 7].forEach((d) => {
      const o = osc(c, 'sawtooth', 220, 2.2);
      o.detune.value = d;
      [[300, 1], [870, 0.5], [2240, 0.2]].forEach(([hz, a]) => {
        const fg = c.createGain();
        fg.gain.value = a;
        o.connect(filter(c, 'bandpass', hz, 10)).connect(fg).connect(g);
      });
    });
    g.connect(out);
  }],
  'kit:blip': [0.12, (c, out) => {
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.08);
    osc(c, 'sine', 1760, 0.12).connect(g).connect(out);
  }],
  'kit:laser': [0.35, (c, out) => {
    const o = osc(c, 'square', 3000, 0.35);
    o.frequency.exponentialRampToValueAtTime(200, 0.25);
    const g = c.createGain();
    perc(g.gain, 0, 0.6, 0.3);
    o.connect(filter(c, 'lowpass', 6000)).connect(g).connect(out);
  }],
  'kit:glitch': [0.5, (c, out) => {
    const g = c.createGain();
    g.gain.setValueAtTime(0, 0);
    let t = 0;
    while (t < 0.45) {
      const len = 0.01 + Math.random() * 0.04;
      const o = c.createOscillator();
      o.type = Math.random() < 0.5 ? 'square' : 'sawtooth';
      o.frequency.value = 100 + Math.random() * 3000;
      const og = c.createGain();
      og.gain.setValueAtTime(Math.random() < 0.75 ? 0.6 : 0, t);
      og.gain.setValueAtTime(0, t + len * 0.8);
      o.connect(og).connect(out);
      o.start(t);
      o.stop(t + len);
      t += len;
    }
  }],
  'kit:whoosh': [1.3, (c, out) => {
    const n = noise(c, 1.3);
    const f = filter(c, 'bandpass', 6000, 3);
    f.frequency.setValueAtTime(6000, 0);
    f.frequency.exponentialRampToValueAtTime(300, 1.2);
    const g = c.createGain();
    ahr(g.gain, 0.15, 0.55, 0.55);
    n.connect(f).connect(g).connect(out);
    n.start(0);
  }],
  'kit:impact': [2.2, (c, out) => {
    const o = osc(c, 'sine', 70, 2.2);
    o.frequency.exponentialRampToValueAtTime(30, 1.5);
    const g = c.createGain();
    perc(g.gain, 0, 1, 1.9, 0.002);
    o.connect(g).connect(saturate(c, 2)).connect(out);
    const n = noise(c, 1);
    const ng = c.createGain();
    perc(ng.gain, 0, 0.7, 0.6);
    n.connect(filter(c, 'lowpass', 500)).connect(ng).connect(out);
    n.start(0);
  }],
  'kit:noisehit': [0.4, (c, out) => {
    const n = noise(c, 0.4);
    const g = c.createGain();
    perc(g.gain, 0, 1, 0.25);
    n.connect(filter(c, 'highpass', 500)).connect(g).connect(saturate(c, 4)).connect(out);
    n.start(0);
  }],
};

export const KIT_C: KitPad[] = [
  { id: 'kit:kick2', name: 'KICK 2' },
  { id: 'kit:snare2', name: 'SNARE 2' },
  { id: 'kit:clap2', name: 'CLAP 2', sound: { fxSend: 0.3 } },
  { id: 'kit:ch2', name: 'HAT CL 2', sound: { muteGroup: 1, volume: 0.55 } },
  { id: 'kit:oh2', name: 'HAT OP 2', sound: { muteGroup: 1, volume: 0.5 } },
  { id: 'kit:ride', name: 'RIDE', sound: { volume: 0.45 } },
  { id: 'kit:congalo', name: 'CONGA LO' },
  { id: 'kit:congahi', name: 'CONGA HI' },
  { id: 'kit:bongo', name: 'BONGO' },
  { id: 'kit:clave', name: 'CLAVE', sound: { volume: 0.5 } },
  { id: 'kit:tamb', name: 'TAMB', sound: { volume: 0.5 } },
  { id: 'kit:snap', name: 'SNAP', sound: { fxSend: 0.3 } },
];

export const KIT_D: KitPad[] = [
  { id: 'kit:epiano', name: 'E.PIANO', sound: key({ release: 0.4, volume: 0.7 }) },
  { id: 'kit:marimba', name: 'MARIMBA', sound: key({ release: 0.2 }) },
  { id: 'kit:chord', name: 'CHORD', sound: key({ volume: 0.55, fxSend: 0.25 }) },
  { id: 'kit:brass', name: 'BRASS', sound: key({ volume: 0.6 }) },
  { id: 'kit:strings', name: 'STRINGS', sound: key({ release: 0.7, volume: 0.6 }) },
  { id: 'kit:choir', name: 'CHOIR', sound: key({ release: 0.7, volume: 0.7 }) },
  { id: 'kit:blip', name: 'BLIP', sound: key({ volume: 0.5, fxSend: 0.4 }) },
  { id: 'kit:laser', name: 'LASER', sound: { volume: 0.5 } },
  { id: 'kit:glitch', name: 'GLITCH', sound: { volume: 0.5 } },
  { id: 'kit:whoosh', name: 'WHOOSH', sound: { volume: 0.55 } },
  { id: 'kit:impact', name: 'IMPACT' },
  { id: 'kit:noisehit', name: 'NOISE', sound: { volume: 0.5 } },
];

export const KITS: KitPad[][] = [KIT_A, KIT_B, KIT_C, KIT_D];
