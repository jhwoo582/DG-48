export type PlayMode = 'oneshot' | 'key';
/** off: 그대로 / bpm: 샘플 BPM → 프로젝트 BPM / bars: 정해진 마디 길이에 맞춤 */
export type TimeMode = 'off' | 'bpm' | 'bars';
/** stretch: 음정 유지(WSOLA) / repitch: 테이프처럼 속도와 음정이 같이 변함 */
export type StretchMode = 'stretch' | 'repitch';

/** 패드 하나에 올라가는 "사운드". 샘플 원본은 건드리지 않고 재생 파라미터만 가진다 (비파괴 편집). */
export interface Sound {
  sampleId: string | null;
  name: string;
  volume: number; // 0..1.5
  pitch: number; // semitones
  pan: number; // -1..1
  attack: number; // sec
  release: number; // sec
  start: number; // 0..1 (샘플 길이 대비 비율)
  end: number; // 0..1
  mode: PlayMode; // oneshot: 끝까지 재생(모노), key: 누르는 동안 재생(폴리)
  reverse: boolean;
  muteGroup: number; // 0 = 없음, 1..4 같은 번호끼리 서로 끊음 (choke)
  fxSend: number; // 0..1 센드 FX로 보내는 양
  timeMode: TimeMode;
  sampleBpm: number; // timeMode === 'bpm'일 때 원본 샘플(trim 구간)의 BPM
  bars: number; // timeMode === 'bars'일 때 맞출 마디 수 (0.25 = 4분음표 하나)
  stretch: StretchMode;
  length: number; // 박 단위로 자르기 (0 = 끝까지). 0.25 = 16분음표
}

/** 패턴 = 그룹 하나의 시퀀스. steps는 항상 MAX_STEPS 길이로 보관 → 마디 수를 줄였다 늘려도 데이터 유지 */
export interface Pattern {
  bars: number; // 1..4
  steps: number[][]; // [pad][step] = velocity (0이면 꺼짐)
}

export interface Group {
  volume: number;
  sounds: Sound[]; // 12
  patterns: Pattern[]; // PATTERNS개
  pattern: number; // = Project.pattern (항상 같이 맞춰 둠)
}

export type FxType = 'delay' | 'reverb' | 'chorus' | 'distortion';

export interface FxSettings {
  type: FxType;
  params: Record<FxType, [number, number]>; // 타입별 X, Y (0..1)
  ret: number; // 리턴 레벨 0..1
  filter: number; // 마스터 DJ 필터 -1(LPF)..0..1(HPF)
  comp: number; // 마스터 컴프 양 0..1
}

/**
 * 패턴 하나 = A·B·C·D 네 그룹의 시퀀스를 함께 담는 단위.
 * (데이터는 그룹마다 patterns[i]로 들고 있지만, 재생/선택은 항상 같은 번호 i로 묶여 움직인다)
 */
export interface Project {
  version: 3;
  bpm: number;
  swing: number; // 50..75 (%)
  metronome: boolean;
  masterVolume: number;
  fx: FxSettings;
  groups: Group[]; // 4
  pattern: number; // 현재 패턴 번호 (모든 그룹 공통)
  song: number[]; // 패턴 번호 목록 (재생 순서)
  yt: YouTubeCues;
  songMode: boolean;
  songLoop: boolean;
}

export const PADS = 12;
export const STEPS_PER_BAR = 16;
export const MAX_BARS = 4;
export const MAX_STEPS = STEPS_PER_BAR * MAX_BARS;
export const PATTERNS = 16;
export const SONG_MAX = 64;
export const GROUPS = 4;
export const MAX_VOICES = 16;
export const GROUP_NAMES = ['A', 'B', 'C', 'D'] as const;
/** 패드 배치(4행×3열)에 맞춘 컴퓨터 키보드 매핑 */
export const PAD_KEYS = ['1', '2', '3', 'q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c'];

export function emptySound(): Sound {
  return {
    sampleId: null,
    name: '',
    volume: 0.8,
    pitch: 0,
    pan: 0,
    attack: 0,
    release: 0.08,
    start: 0,
    end: 1,
    mode: 'oneshot',
    reverse: false,
    muteGroup: 0,
    fxSend: 0,
    timeMode: 'off',
    sampleBpm: 120,
    bars: 1,
    stretch: 'stretch',
    length: 0,
  };
}

/** Length 선택지 (박 단위) */
export const LENGTHS = [0, 0.125, 0.25, 0.5, 1, 2, 4];
export const LENGTH_LABELS = ['Full', '1/32', '1/16', '1/8', '1/4', '1/2', '1 bar'];

/** 유튜브 큐 패드: 영상 하나 + 패드 12개의 시점(초) */
export interface YouTubeCues {
  videoId: string | null;
  cues: (number | null)[];
}

export const BAR_CHOICES = [0.25, 0.5, 1, 2, 4, 8];

/** trim 구간 길이(초)로 그럴듯한 BPM 추정: 1/4~16마디 중 70~180 BPM에 들어오는 것, 프로젝트 BPM에 가장 가까운 것 */
export function guessBpm(lenSec: number, projectBpm: number): { bpm: number; bars: number } | null {
  if (lenSec <= 0.05) return null;
  let best: { bpm: number; bars: number } | null = null;
  for (const bars of [0.25, 0.5, 1, 2, 4, 8, 16]) {
    const bpm = (bars * 4 * 60) / lenSec;
    if (bpm < 70 || bpm > 180) continue;
    if (!best || Math.abs(Math.log(bpm / projectBpm)) < Math.abs(Math.log(best.bpm / projectBpm))) best = { bpm, bars };
  }
  return best;
}

export function emptyPattern(): Pattern {
  return { bars: 1, steps: Array.from({ length: PADS }, () => new Array(MAX_STEPS).fill(0)) };
}

export function defaultFx(): FxSettings {
  return {
    type: 'delay',
    params: { delay: [0.57, 0.4], reverb: [0.35, 0.6], chorus: [0.25, 0.5], distortion: [0.4, 0.6] },
    ret: 0.6,
    filter: 0,
    comp: 0.3,
  };
}

export function emptyProject(): Project {
  return {
    version: 3,
    bpm: 90,
    swing: 50,
    metronome: false,
    masterVolume: 0.8,
    fx: defaultFx(),
    groups: Array.from({ length: GROUPS }, () => ({
      volume: 0.8,
      sounds: Array.from({ length: PADS }, emptySound),
      patterns: Array.from({ length: PATTERNS }, emptyPattern),
      pattern: 0,
    })),
    pattern: 0,
    song: [],
    yt: { videoId: null, cues: new Array(PADS).fill(null) },
    songMode: false,
    songLoop: true,
  };
}

/** 패턴 i의 길이(마디). 그룹마다 같게 맞춰 두지만 혹시 다르면 가장 긴 것 */
export function patternBars(p: Project, i: number): number {
  return Math.max(...p.groups.map((g) => g.patterns[i].bars));
}

/** 패턴 i에 어떤 그룹이든 노트가 있는지 */
export function patternUsed(p: Project, i: number): boolean {
  return p.groups.some((g) => patternHasNotes(g.patterns[i]));
}

/** 패턴 i의 길이를 모든 그룹에 똑같이 */
export function setPatternBars(p: Project, i: number, bars: number) {
  p.groups.forEach((g) => (g.patterns[i].bars = bars));
}

/** 모든 그룹이 같은 패턴 번호를 가리키게 */
export function selectPatternAll(p: Project, i: number) {
  p.pattern = i;
  p.groups.forEach((g) => (g.pattern = i));
}

export function patternHasNotes(p: Pattern) {
  const len = p.bars * STEPS_PER_BAR;
  return p.steps.some((r) => r.some((v, i) => i < len && v > 0));
}

/**
 * 저장된 프로젝트를 현재 형식으로 변환.
 * v1(그룹당 16스텝 1개) → v2(그룹당 패턴 16개, FX 추가)
 * 반환값 fromV1이 true면 비어 있는 C/D 패드에 새 기본 키트를 채워준다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function migrate(raw: any): { project: Project; fromV1: boolean } | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.groups)) return null;
  const p = emptyProject();
  const fromV1 = raw.version === 1;
  p.bpm = raw.bpm ?? p.bpm;
  p.swing = raw.swing ?? p.swing;
  p.metronome = !!raw.metronome;
  p.masterVolume = raw.masterVolume ?? p.masterVolume;
  if (raw.fx) p.fx = { ...p.fx, ...raw.fx, params: { ...p.fx.params, ...raw.fx.params } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw.groups.slice(0, GROUPS).forEach((rg: any, g: number) => {
    const grp = p.groups[g];
    grp.volume = rg.volume ?? grp.volume;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    grp.sounds = grp.sounds.map((s, i) => ({ ...s, ...(rg.sounds?.[i] ?? {}) }));
    const pad = (row: number[] = []) => Array.from({ length: MAX_STEPS }, (_, i) => row[i] ?? 0);
    if (fromV1) {
      grp.patterns[0].steps = grp.patterns[0].steps.map((_, i) => pad(rg.steps?.[i]));
    } else if (Array.isArray(rg.patterns)) {
      grp.patterns = grp.patterns.map((ep, i) => {
        const rp = rg.patterns[i];
        if (!rp) return ep;
        return {
          bars: Math.min(MAX_BARS, Math.max(1, rp.bars ?? 1)),
          steps: ep.steps.map((_, r) => pad(rp.steps?.[r])),
        };
      });
      grp.pattern = Math.min(PATTERNS - 1, Math.max(0, rg.pattern ?? 0));
    }
  });
  const clampPat = (n: unknown) => Math.min(PATTERNS - 1, Math.max(0, typeof n === 'number' ? n : 0));
  // 현재 패턴: v3는 그대로, 예전 버전은 그룹 A가 보던 패턴으로 통일
  selectPatternAll(p, clampPat(raw.version === 3 ? raw.pattern : raw.groups[0]?.pattern));
  // 같은 번호 패턴은 길이도 하나로 (그룹마다 달랐다면 가장 긴 것)
  for (let i = 0; i < PATTERNS; i++) setPatternBars(p, i, patternBars(p, i));
  if (Array.isArray(raw.song)) {
    // v2의 송은 "씬 번호" 목록 → 씬이 가리키던 그룹 A의 패턴 번호로 변환
    const song: number[] =
      raw.version === 3
        ? raw.song.map(clampPat)
        : raw.song
            .map((si: number) => raw.scenes?.[si]?.patterns?.[0])
            .filter((n: unknown) => typeof n === 'number')
            .map(clampPat);
    p.song = song.slice(0, SONG_MAX);
  }
  if (raw.yt && typeof raw.yt === 'object') {
    p.yt.videoId = typeof raw.yt.videoId === 'string' ? raw.yt.videoId : null;
    if (Array.isArray(raw.yt.cues)) p.yt.cues = p.yt.cues.map((_, i) => (typeof raw.yt.cues[i] === 'number' ? raw.yt.cues[i] : null));
  }
  p.songMode = !!raw.songMode;
  p.songLoop = raw.songLoop ?? true;
  return { project: p, fromV1 };
}
