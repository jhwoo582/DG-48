import './style.css';
import { Engine, type Voice } from './audio/engine';
import { Sequencer } from './audio/sequencer';
import { Recorder, RING_SECONDS, type SourceKind } from './audio/recorder';
import { Fader, XYPad, hud, wheelDelta, getWheelInvert, setWheelInvert } from './ui/controls';
import { YouTubePlayer, YT_ERRORS, parseYouTubeId } from './ui/youtube';
import { Library, LIB_DRAG_TYPE, type LibItem } from './ui/library';
import { DEMO_PATTERNS, KITS, renderKit } from './audio/kit';
import { FX_NAMES, FX_PARAM_NAMES, FX_TYPES, PUNCH, fxValueLabel, type PunchKind } from './audio/fx';
import * as dsp from './audio/dsp';
import { db } from './db';
import { Waveform } from './ui/waveform';
import {
  type Pattern,
  type Project,
  type Sound,
  type TimeMode,
  type StretchMode,
  BAR_CHOICES,
  LENGTHS,
  LENGTH_LABELS,
  defaultFx,
  guessBpm,
  GROUP_NAMES,
  GROUPS,
  PAD_KEYS,
  PADS,
  PATTERNS,
  SONG_MAX,
  STEPS_PER_BAR,
  patternBars,
  patternUsed,
  setPatternBars,
  emptyProject,
  emptySound,
  migrate,
  patternHasNotes,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------- state
let project: Project = emptyProject();
let selG = 0;
let selP = 0;
let keysMode = false;
let recArm = false;
let recTarget = { g: 0, p: 0 };
let recStartedAt = 0;
let page = 0; // 시퀀서 그리드에 보이는 마디
let follow = true;
let clipboard: Pattern[] | null = null;

const engine = new Engine(() => project);
const seq = new Sequencer(engine, () => project);
const recorder = new Recorder(engine);
const wave = new Waveform($<HTMLCanvasElement>('#wave'), () => engine.ctx.currentTime);
const held = new Map<number, Voice | null>();
// 개발 중 디버깅용 (프로덕션 빌드에는 포함되지 않음)
if (import.meta.env.DEV) Object.assign(window, { __seq: seq, __engine: engine, __project: () => project, __yt: () => yt });
const cur = (): Sound => project.groups[selG].sounds[selP];
const curPattern = (): Pattern => {
  const g = project.groups[selG];
  return g.patterns[project.pattern];
};
/** 패드 이름 = 그룹 + 키 (예: "A Q") */
const padName = (g: number, p: number) => `${GROUP_NAMES[g]} ${PAD_KEYS[p].toUpperCase()}`;

// ---------------------------------------------------------------- persistence
let saveTimer = 0;
let savePending = false;
function save() {
  clearTimeout(saveTimer);
  savePending = true;
  saveTimer = window.setTimeout(async () => {
    savePending = false;
    snapshot();
    try {
      await db.putProject(project);
    } catch (e) {
      console.warn('save failed', e);
    }
  }, 400);
}

// ---------------------------------------------------------------- undo / redo
// 저장할 때마다(0.4초 묶음) 프로젝트 상태를 쌓아 두고, 되돌릴 때 통째로 바꿔 끼운다.
// 샘플 원본은 세션 중에는 지우지 않으므로(정리는 시작할 때만) 되돌려도 소리가 살아 있다.
const past: string[] = [];
const future: string[] = [];
function snapshot() {
  const json = JSON.stringify(project);
  if (past[past.length - 1] === json) return;
  past.push(json);
  if (past.length > 40) past.shift();
  future.length = 0;
}
function restore(json: string) {
  project = JSON.parse(json) as Project;
  engine.syncMix();
  engine.syncFx();
  renderAll();
  void db.putProject(project).catch(() => {});
}
function undo() {
  if (savePending) {
    clearTimeout(saveTimer);
    savePending = false;
    snapshot();
  }
  if (past.length < 2) return toast('Nothing to undo');
  future.push(past.pop()!);
  restore(past[past.length - 1]);
  toast('Undone');
}
function redo() {
  const json = future.pop();
  if (!json) return toast('Nothing to redo');
  past.push(json);
  restore(json);
  toast('Redone');
}

/** 어떤 패드도 쓰지 않는 샘플은 DB에서 삭제 */
async function gcSamples() {
  const used = new Set<string>();
  project.groups.forEach((g) => g.sounds.forEach((s) => s.sampleId && used.add(s.sampleId)));
  for (const k of await db.sampleKeys()) {
    const id = String(k);
    if (!used.has(id)) {
      await db.deleteSample(id);
      engine.deleteBuffer(id);
    }
  }
}

const kitSound = (g: number, i: number): Sound => {
  const k = KITS[g][i];
  return { ...emptySound(), sampleId: k.id, name: k.name, ...k.sound };
};

function defaultProject(): Project {
  const p = emptyProject();
  p.bpm = 90;
  p.swing = 56;
  p.groups.forEach((grp, g) => grp.sounds.forEach((_, i) => (grp.sounds[i] = kitSound(g, i))));
  for (const d of DEMO_PATTERNS) {
    const pat = p.groups[d.group].patterns[d.pattern];
    pat.bars = d.bars ?? 1;
    d.notes.forEach(([pad, steps]) => steps.forEach((s) => (pat.steps[pad][s] = 1)));
  }
  // 패턴 2(2마디 필인)에도 베이스가 이어지게: B 패턴 1을 두 번 복사
  const bassA = p.groups[1].patterns[0].steps;
  p.groups[1].patterns[1].steps = bassA.map((row) => row.map((v, i) => (i < 32 ? row[i % 16] : v)));
  for (let i = 0; i < 2; i++) setPatternBars(p, i, patternBars(p, i));
  // 송: 패턴 1 → 1 → 2
  p.song = [0, 0, 1];
  return p;
}

const newId = () => `u:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function assignSample(g: number, p: number, chs: Float32Array[], sr: number, name: string) {
  const id = newId();
  engine.setBuffer(id, dsp.makeBuffer(chs, sr));
  project.groups[g].sounds[p] = { ...emptySound(), sampleId: id, name: name.slice(0, 16) };
  save();
  renderAll();
  try {
    await db.putSample(id, { name, sampleRate: sr, channels: chs });
  } catch (e) {
    console.warn(e);
    toast('Browser storage is full. This sample will be gone after a reload.');
  }
}

// ---------------------------------------------------------------- audio unlock
function unlockAudio() {
  if (engine.ctx.state !== 'running') void engine.ctx.resume();
  $('#overlay').classList.add('hidden');
}

// ---------------------------------------------------------------- pads
const padEls: HTMLButtonElement[] = [];

function padDown(i: number, shift = false) {
  unlockAudio();
  if (held.has(i)) return;
  if (cueMode) return cueDown(i, shift);
  const now = engine.ctx.currentTime;
  if (keysMode) {
    // 아래 줄부터 반음씩 올라감 (Z=0 ... 3=+11)
    const row = Math.floor(i / 3);
    const col = i % 3;
    const semis = (3 - row) * 3 + col;
    held.set(i, engine.trigger(selG, selP, now, 1, semis));
    flashPad(i, 0.15);
    return;
  }
  if (selP !== i) selectPad(i);
  held.set(i, engine.trigger(selG, i, now, 1));
  if (recArm && seq.playing && project.groups[selG].sounds[i].sampleId) {
    const q = seq.quantize(now);
    if (q) {
      const pos = q.pos[selG];
      const pat = q.pat[selG];
      project.groups[selG].patterns[pat].steps[i][pos] = 1;
      if (!q.scheduled) seq.skipOnce(selG, pat, i, pos);
      renderGrid();
      renderPatterns();
      renderGroups();
      save();
    }
  }
}

function padUp(i: number) {
  if (!held.has(i)) return;
  const v = held.get(i);
  held.delete(i);
  if (cueMode) return cueUp(i);
  if (v) engine.release(v, engine.ctx.currentTime);
}

// ---------------------------------------------------------------- youtube cue pads
// 앱 안 유튜브 플레이어는 녹음하지 않는다(유튜브 정책). 대신 패드 = 영상의 시점.
// 누르는 동안 그 시점부터 소리를 켜고, 떼면 끈다 (kofigumbs/yt, YPC 방식).
let cueMode = false;
const fmtTime = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

function cueDown(i: number, shift: boolean) {
  if (!yt.loaded) {
    toast('Load a YouTube video first');
    return;
  }
  held.set(i, null);
  const cues = project.yt.cues;
  if (cues[i] === null || shift) {
    cues[i] = Math.round(yt.time * 100) / 100;
    hud(`${PAD_KEYS[i].toUpperCase()} cue at ${fmtTime(cues[i]!)}`, padEls[i]);
    renderPads();
    save();
  }
  yt.playFrom(cues[i]!);
  padEls[i].classList.add('hit');
}

function cueUp(i: number) {
  padEls[i].classList.remove('hit');
  if (held.size === 0) yt.mute();
}

function setCueMode(on: boolean) {
  releaseAllHeld();
  cueMode = on;
  if (on) {
    keysMode = false;
    // 영상은 소리 끈 채 계속 돌려 둬야 점프가 빠르다
    yt.mute();
    yt.play();
  } else yt.unMute();
  $('#cue-mode').classList.toggle('on', cueMode);
  renderTransport();
  renderPads();
}

function releaseAllHeld() {
  [...held.keys()].forEach(padUp);
}

const flashTimers: number[] = [];
function flashPad(p: number, dur: number) {
  const el = padEls[p];
  el.classList.add('hit');
  clearTimeout(flashTimers[p]);
  flashTimers[p] = window.setTimeout(() => el.classList.remove('hit'), Math.max(90, Math.min(dur * 1000, 220)));
}

engine.onTrigger = ({ g, p, time, duration }) => {
  if (g === selG && p === selP) wave.playFrom(time, duration);
  if (keysMode && g === selG && p === selP) return;
  const delay = Math.max(0, (time - engine.ctx.currentTime) * 1000);
  window.setTimeout(() => g === selG && flashPad(p, duration), delay);
};

seq.onPatternChange = () => {
  page = 0;
  renderSong();
  renderPatterns();
  renderSeqBar();
  renderGrid();
  renderGroups();
};
seq.onStopped = () => {
  renderTransport();
  renderSong();
  renderPatterns();
};

function selectPad(i: number) {
  selP = i;
  nextTarget = null;
  renderPads();
  renderEditor();
  renderGrid();
}

function setGroup(g: number) {
  releaseAllHeld();
  selG = g;
  page = 0;
  renderAll();
}

function selectPattern(idx: number) {
  seq.requestPattern(idx);
  if (!seq.playing) page = 0;
  renderPatterns();
  renderSeqBar();
  renderGrid();
  renderGroups();
  save();
}

// ---------------------------------------------------------------- song
function toggleSongMode() {
  project.songMode = !project.songMode;
  if (project.songMode && project.song.length === 0) toast('The song is empty. Pick a pattern and press Add pattern.');
  seq.songModeChanged();
  renderTransport();
  renderSong();
  save();
}

// ---------------------------------------------------------------- slider helper
interface Slider {
  label: HTMLSpanElement;
  refresh(): void;
}
function slider(
  parent: HTMLElement,
  o: {
    label: string;
    min: number;
    max: number;
    step: number;
    def: number | (() => number);
    get: () => number;
    set: (v: number) => void;
    fmt: (v: number) => string;
  },
): Slider {
  // 드래그 · 트랙패드 스크롤 · 더블클릭 초기화 · 방향키를 지원하는 커스텀 페이더
  return new Fader(parent, {
    ...o,
    set: (v) => {
      o.set(v);
      save();
    },
  });
}

// ---------------------------------------------------------------- build static DOM
const ms = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const pct = (v: number) => `${Math.round(v * 100)}`;
const soundSliders: Slider[] = [];
const fxSliders: Slider[] = [];
const masterSliders: Slider[] = [];
const cells: HTMLDivElement[][] = [];
const rows: HTMLDivElement[] = [];
const rowLabels: HTMLButtonElement[] = [];
const groupEls: HTMLButtonElement[] = [];
const patEls: HTMLButtonElement[] = [];
const punchEls = new Map<PunchKind, HTMLButtonElement>();
const transportFaders: Fader[] = [];
let xy: XYPad | null = null;
let xySnap = false;
let sbpmFader: Fader | null = null;
const GRAB_SECONDS = [2, 4, 8, 16, 30];
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function buildStatic() {
  // groups
  const groupsEl = $('#groups');
  for (let g = 0; g < GROUPS; g++) {
    const b = document.createElement('button');
    b.className = 'group-btn';
    b.textContent = GROUP_NAMES[g];
    b.addEventListener('click', () => setGroup(g));
    b.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { x, y } = wheelDelta(e);
        const grp = project.groups[g];
        grp.volume = Math.round(clamp(grp.volume + (Math.abs(y) >= Math.abs(x) ? y : x) / 300, 0, 1.2) * 100) / 100;
        engine.syncMix();
        hud(`Group ${GROUP_NAMES[g]} volume ${pct(grp.volume)}`, b);
        transportFaders.forEach((f) => f.refresh());
        save();
      },
      { passive: false },
    );
    groupsEl.append(b);
    groupEls.push(b);
  }

  // pads
  const padsEl = $('#pads');
  for (let i = 0; i < PADS; i++) {
    const b = document.createElement('button');
    b.className = 'pad';
    b.innerHTML = `<span class="pad-key">${PAD_KEYS[i].toUpperCase()}</span><span class="pad-name"></span>`;
    b.setAttribute('aria-label', `Pad ${PAD_KEYS[i].toUpperCase()}`);
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* 합성 이벤트 등 */
      }
      padDown(i, e.shiftKey);
    });
    b.addEventListener('pointerup', () => padUp(i));
    b.addEventListener('pointercancel', () => padUp(i));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('dragover', (e) => {
      e.preventDefault();
      b.classList.add('drop');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop'));
    // 트랙패드: 위아래로 쓸기 = 볼륨, 좌우로 쓸기 = FX SEND
    b.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const snd = project.groups[selG].sounds[i];
        if (!snd.sampleId) return;
        const { x, y } = wheelDelta(e);
        if (Math.abs(y) >= Math.abs(x)) snd.volume = Math.round(clamp(snd.volume + y / 300, 0, 1.5) * 100) / 100;
        else snd.fxSend = Math.round(clamp(snd.fxSend + x / 300, 0, 1) * 100) / 100;
        hud(`${PAD_KEYS[i].toUpperCase()}  volume ${pct(snd.volume)}, send ${pct(snd.fxSend)}`, b);
        if (i === selP) soundSliders.forEach((f) => f.refresh());
        save();
      },
      { passive: false },
    );
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('drop');
      const lib = e.dataTransfer?.getData(LIB_DRAG_TYPE);
      if (lib) void dropLibraryItem(JSON.parse(lib) as LibItem, selG, i);
      else if (e.dataTransfer?.files.length) void loadFiles([...e.dataTransfer.files], selG, i);
    });
    padsEl.append(b);
    padEls.push(b);
  }

  // sound params
  const paramsEl = $('#params');
  const sp = (
    key: 'volume' | 'pitch' | 'pan' | 'attack' | 'release' | 'fxSend',
    label: string,
    min: number,
    max: number,
    step: number,
    fmt: (v: number) => string,
  ) =>
    soundSliders.push(
      slider(paramsEl, {
        label,
        min,
        max,
        step,
        fmt,
        def: () => emptySound()[key],
        get: () => cur()[key],
        set: (v) => {
          cur()[key] = v;
          if (key === 'pitch') schedulePrepare();
        },
      }),
    );
  sp('volume', 'Volume', 0, 1.5, 0.01, pct);
  sp('pitch', 'Pitch', -24, 24, 1, (v) => `${v > 0 ? '+' : ''}${v} st`);
  sp('pan', 'Pan', -1, 1, 0.02, (v) =>
    Math.abs(v) < 0.01 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`,
  );
  sp('attack', 'Attack', 0, 1, 0.001, ms);
  sp('release', 'Release', 0, 3, 0.001, ms);
  sp('fxSend', 'FX send', 0, 1, 0.01, pct);
  // Length: 템포 기준으로 자르는 길이
  const lenIndex = (v: number) => LENGTHS.reduce((bi, l, i) => (Math.abs(l - v) < Math.abs(LENGTHS[bi] - v) ? i : bi), 0);
  soundSliders.push(
    new Fader($('#len-f'), {
      label: 'Length',
      min: 0,
      max: LENGTHS.length - 1,
      step: 1,
      def: 0,
      get: () => lenIndex(cur().length),
      set: (v) => {
        cur().length = LENGTHS[v];
        save();
      },
      fmt: (v) => LENGTH_LABELS[v],
    }),
  );

  // send fx
  const fxType = $('#fx-type');
  for (const t of FX_TYPES) {
    const b = document.createElement('button');
    b.dataset.v = t;
    b.textContent = FX_NAMES[t];
    b.addEventListener('click', () => {
      project.fx.type = t;
      engine.syncFx();
      renderFx();
      save();
    });
    fxType.append(b);
  }
  const fxParams = $('#fx-params');
  ([0, 1] as const).forEach((which) =>
    fxSliders.push(
      slider(fxParams, {
        label: '',
        min: 0,
        max: 1,
        step: 0.001,
        def: () => [0.5, 0.5][which],
        get: () => project.fx.params[project.fx.type][which],
        set: (v) => {
          project.fx.params[project.fx.type][which] = v;
          engine.syncFx();
          xy?.refresh();
        },
        fmt: (v) => fxValueLabel(project.fx.type, which, v),
      }),
    ),
  );
  fxSliders.push(
    slider(fxParams, {
      label: 'Return',
      min: 0,
      max: 1,
      step: 0.01,
      def: 0.6,
      get: () => project.fx.ret,
      set: (v) => {
        project.fx.ret = v;
        engine.syncFx();
      },
      fmt: pct,
    }),
  );

  // master
  const mp = $('#master-params');
  masterSliders.push(
    slider(mp, {
      label: 'Filter',
      min: -1,
      max: 1,
      step: 0.01,
      def: 0,
      get: () => project.fx.filter,
      set: (v) => {
        project.fx.filter = Math.abs(v) < 0.02 ? 0 : v;
        engine.syncFx();
      },
      fmt: (v) => (Math.abs(v) < 0.02 ? 'Open' : v < 0 ? `Low-pass ${Math.round(-v * 100)}` : `High-pass ${Math.round(v * 100)}`),
    }),
    slider(mp, {
      label: 'Compress',
      min: 0,
      max: 1,
      step: 0.01,
      def: 0.3,
      get: () => project.fx.comp,
      set: (v) => {
        project.fx.comp = v;
        engine.syncFx();
      },
      fmt: pct,
    }),
  );

  // transport faders
  transportFaders.push(
    new Fader($('#swing-f'), {
      label: 'Swing',
      min: 50,
      max: 75,
      step: 1,
      def: 50,
      get: () => project.swing,
      set: (v) => {
        project.swing = v;
        save();
      },
      fmt: (v) => `${v}%`,
    }),
    new Fader($('#master-f'), {
      label: 'Master',
      min: 0,
      max: 1.2,
      step: 0.01,
      def: 0.8,
      get: () => project.masterVolume,
      set: (v) => {
        project.masterVolume = v;
        engine.syncMix();
        save();
      },
      fmt: pct,
    }),
    new Fader($('#gvol-f'), {
      label: 'Group volume',
      min: 0,
      max: 1.2,
      step: 0.01,
      def: 0.8,
      get: () => project.groups[selG].volume,
      set: (v) => {
        project.groups[selG].volume = v;
        engine.syncMix();
        save();
      },
      fmt: pct,
    }),
  );

  // FX XY 패드: X/Y = 현재 FX의 두 파라미터
  xy = new XYPad($('#xy-wrap'), {
    get: () => project.fx.params[project.fx.type],
    set: (x, y) => {
      project.fx.params[project.fx.type] = [x, y];
      engine.syncFx();
      fxSliders[0].refresh();
      fxSliders[1].refresh();
      save();
    },
    names: () => FX_PARAM_NAMES[project.fx.type],
    values: () => {
      const [x, y] = project.fx.params[project.fx.type];
      return [fxValueLabel(project.fx.type, 0, x), fxValueLabel(project.fx.type, 1, y)];
    },
    reset: () => {
      const [x, y] = defaultFx().params[project.fx.type];
      project.fx.params[project.fx.type] = [x, y];
      engine.syncFx();
      renderFx();
      save();
    },
    snapBack: () => xySnap,
  });

  // time stretch
  sbpmFader = new Fader($('#sbpm-f'), {
    label: 'Sample BPM',
    min: 40,
    max: 240,
    step: 0.1,
    def: () => project.bpm,
    get: () => cur().sampleBpm,
    set: (v) => {
      cur().sampleBpm = v;
      schedulePrepare();
      renderTime();
      save();
    },
    fmt: (v) => v.toFixed(1),
  });
  const barsSeg = $('#bars-seg');
  for (const b of BAR_CHOICES) {
    const btn = document.createElement('button');
    btn.dataset.v = String(b);
    btn.textContent = b === 0.25 ? '1/4' : b === 0.5 ? '1/2' : `${b} bar`;
    btn.addEventListener('click', () => {
      cur().bars = b;
      schedulePrepare();
      renderTime();
      save();
    });
    barsSeg.append(btn);
  }

  // grab
  const grabEl = $('#grab');
  for (const sec of GRAB_SECONDS) {
    const btn = document.createElement('button');
    btn.textContent = `${sec}s`;
    btn.title = `Keep the last ${sec} seconds`;
    btn.addEventListener('click', () => void grabLast(sec));
    grabEl.append(btn);
  }

  // punch-in
  const punchEl = $('#punch');
  for (const p of PUNCH) {
    const b = document.createElement('button');
    b.innerHTML = `${p.label}<small>${p.key}</small>`;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.setPointerCapture(e.pointerId);
      punchDown(p.kind);
    });
    b.addEventListener('pointerup', () => punchUp(p.kind));
    b.addEventListener('pointercancel', () => punchUp(p.kind));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    punchEl.append(b);
    punchEls.set(p.kind, b);
  }

  // patterns
  const patsEl = $('#patterns');
  for (let i = 0; i < PATTERNS; i++) {
    const b = document.createElement('button');
    b.className = 'pat-btn';
    b.textContent = String(i + 1);
    b.addEventListener('click', () => selectPattern(i));
    patsEl.append(b);
    patEls.push(b);
  }

  // sequencer grid (항상 한 마디 = 16칸을 보여주고, BAR 페이지로 넘김)
  const grid = $('#grid');
  let paint: number | null = null;
  window.addEventListener('pointerup', () => {
    if (paint !== null) {
      save();
      renderPatterns();
      renderGroups();
    }
    paint = null;
  });
  for (let r = 0; r < PADS; r++) {
    const row = document.createElement('div');
    row.className = 'grow';
    const label = document.createElement('button');
    label.className = 'glabel';
    label.addEventListener('click', () => selectPad(r));
    row.append(label);
    const rowCells: HTMLDivElement[] = [];
    for (let s = 0; s < STEPS_PER_BAR; s++) {
      const c = document.createElement('div');
      c.className = 'cell' + (s % 4 === 0 ? ' beat' : '');
      const set = (v: number) => {
        curPattern().steps[r][page * STEPS_PER_BAR + s] = v;
        c.classList.toggle('on', !!v);
      };
      c.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try {
          c.releasePointerCapture(e.pointerId); // 터치 드래그로 여러 칸 칠하기
        } catch {
          /* 캡처 없음 */
        }
        paint = curPattern().steps[r][page * STEPS_PER_BAR + s] ? 0 : 1;
        set(paint);
      });
      c.addEventListener('pointerenter', () => paint !== null && set(paint));
      row.append(c);
      rowCells.push(c);
    }
    grid.append(row);
    rows.push(row);
    rowLabels.push(label);
    cells.push(rowCells);
  }
}

// ---------------------------------------------------------------- punch-in
const punchHeld = new Set<PunchKind>();
let activeLoop: PunchKind | null = null;

function startLoop(kind: PunchKind) {
  const def = PUNCH.find((p) => p.kind === kind)!;
  const now = engine.ctx.currentTime;
  const t = seq.playing ? seq.nextGridTime(now) : now;
  engine.chain.loopStart(t, (def.beats! * 60) / project.bpm);
  activeLoop = kind;
}

function punchDown(kind: PunchKind) {
  unlockAudio();
  if (punchHeld.has(kind)) return;
  punchHeld.add(kind);
  if (kind === 'lpf' || kind === 'hpf') engine.chain.punchFilter(kind, true);
  else startLoop(kind);
  renderPunch();
}

function punchUp(kind: PunchKind) {
  if (!punchHeld.delete(kind)) return;
  if (kind === 'lpf' || kind === 'hpf') engine.chain.punchFilter(kind, false);
  else if (activeLoop === kind) {
    // 다른 루프 버튼을 아직 누르고 있으면 그걸로 넘어감
    const other = [...punchHeld].find((k) => k !== 'lpf' && k !== 'hpf');
    if (other) startLoop(other);
    else {
      activeLoop = null;
      engine.chain.loopStop();
    }
  }
  renderPunch();
}

function releaseAllPunch() {
  [...punchHeld].forEach(punchUp);
}

// ---------------------------------------------------------------- render
function renderGroups() {
  groupEls.forEach((b, g) => {
    const grp = project.groups[g];
    b.classList.toggle('active', g === selG);
    b.classList.toggle('has', patternHasNotes(grp.patterns[grp.pattern]));
  });
}

function renderPads() {
  const grp = project.groups[selG];
  $('#pads').classList.toggle('cue', cueMode);
  padEls.forEach((el, i) => {
    const s = grp.sounds[i];
    const name = el.querySelector('.pad-name')!;
    if (cueMode) {
      const c = project.yt.cues[i];
      el.classList.remove('selected');
      el.classList.toggle('empty', c === null);
      name.textContent = c === null ? 'Empty' : fmtTime(c);
      return;
    }
    el.classList.toggle('selected', i === selP && !keysMode);
    el.classList.toggle('empty', !s.sampleId);
    name.textContent = keysMode ? noteName(i) : s.sampleId ? s.name || 'SAMPLE' : '—';
  });
}

function noteName(i: number) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const semis = (3 - Math.floor(i / 3)) * 3 + (i % 3);
  return `+${semis} ${names[semis]}`;
}

function renderEditor() {
  const s = cur();
  $('#ed-title').textContent = `Pad ${GROUP_NAMES[selG]}${PAD_KEYS[selP].toUpperCase()}`;
  $<HTMLInputElement>('#ed-name').value = s.name;
  soundSliders.forEach((sl) => sl.refresh());
  document
    .querySelectorAll<HTMLButtonElement>('#mode button')
    .forEach((b) => b.classList.toggle('on', b.dataset.v === s.mode));
  $('#reverse').classList.toggle('on', s.reverse);
  $<HTMLSelectElement>('#choke').value = String(s.muteGroup);
  wave.set(s.sampleId ? (engine.getBuffer(s.sampleId) ?? null) : null, s.start, s.end, s.reverse);
  renderWaveInfo();
  renderTime();
  renderSampleRec();
}

/** TIME 영역 + 파형 위 박자 격자 */
function renderTime() {
  const s = cur();
  document.querySelectorAll<HTMLButtonElement>('#time-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.timeMode));
  document.querySelectorAll<HTMLButtonElement>('#stretch-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.stretch));
  document.querySelectorAll<HTMLButtonElement>('#bars-seg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === s.bars));
  $('#time-bpm').style.display = s.timeMode === 'bpm' ? '' : 'none';
  $('#time-bars').style.display = s.timeMode === 'bars' ? '' : 'none';
  $('#stretch-mode').style.display = s.timeMode === 'off' ? 'none' : '';
  sbpmFader?.refresh();
  const info = engine.timeInfo(s);
  const buf = s.sampleId ? engine.getBuffer(s.sampleId) : undefined;
  if (!info || info.target === null || !buf) {
    $('#time-info').textContent = '';
    wave.setGrid(null);
    return;
  }
  const ratio = info.target / info.len;
  $('#time-info').textContent = `${info.len.toFixed(2)} s stretched to ${info.target.toFixed(2)} s (×${(1 / ratio).toFixed(2)} speed${s.stretch === 'stretch' ? ', same pitch' : ''})`;
  // 한 박의 길이 (원본 샘플 기준, 버퍼 길이 대비 비율)
  const beatSec = s.timeMode === 'bpm' ? 60 / s.sampleBpm : info.len / (s.bars * 4);
  wave.setGrid(beatSec / buf.duration);
}

let prepTimer = 0;
/** 타임스트레치 결과를 미리 계산 (값을 바꾸는 동안은 기다렸다가 한 번만) */
function schedulePrepare(all = false) {
  clearTimeout(prepTimer);
  prepTimer = window.setTimeout(() => (all ? engine.prepareAll() : engine.prepare(cur())), 150);
}

function setBpm(v: number) {
  project.bpm = Math.round(clamp(v, 40, 300));
  engine.syncFx(); // 딜레이 타임이 BPM 동기
  schedulePrepare(true);
  renderTransport();
  renderSong();
  renderTime();
  save();
}

function renderWaveInfo() {
  const s = cur();
  const buf = s.sampleId ? engine.getBuffer(s.sampleId) : undefined;
  $('#wave-info').textContent = buf
    ? `${((s.end - s.start) * buf.duration).toFixed(3)} s from ${(s.start * buf.duration).toFixed(3)} s, of ${buf.duration.toFixed(2)} s ${buf.numberOfChannels > 1 ? 'stereo' : 'mono'}`
    : '';
}

function renderFx() {
  const t = project.fx.type;
  document
    .querySelectorAll<HTMLButtonElement>('#fx-type button')
    .forEach((b) => b.classList.toggle('on', b.dataset.v === t));
  fxSliders[0].label.textContent = FX_PARAM_NAMES[t][0];
  fxSliders[1].label.textContent = FX_PARAM_NAMES[t][1];
  fxSliders.forEach((s) => s.refresh());
  masterSliders.forEach((s) => s.refresh());
  xy?.refresh();
}

function renderPunch() {
  punchEls.forEach((b, k) => b.classList.toggle('on', punchHeld.has(k)));
}

function renderPatterns() {
  const queued = seq.queuedPattern;
  patEls.forEach((b, i) => {
    b.classList.toggle('active', i === project.pattern);
    b.classList.toggle('queued', i === queued);
    b.classList.toggle('has', patternUsed(project, i));
  });
  $('#seq-pattern').textContent = String(project.pattern + 1);
  $('#seq-clear').textContent = `Clear ${GROUP_NAMES[selG]}`;
}

function renderSong() {
  const el = $('#song');
  el.innerHTML = '';
  if (project.song.length === 0) {
    el.innerHTML = '<span class="song-empty">Pick a pattern and press Add pattern to build a song.</span>';
  }
  if (seq.songPos >= project.song.length) seq.songPos = Math.max(0, project.song.length - 1);
  const songPlaying = seq.playing && project.songMode;
  project.song.forEach((pi, i) => {
    const b = document.createElement('button');
    b.className = 'song-chip';
    b.innerHTML = `<span class="idx">${i + 1}</span>Pattern ${pi + 1}<span class="x" title="Remove">×</span>`;
    b.classList.toggle('invalid', !patternUsed(project, pi));
    b.classList.toggle('playing', songPlaying && i === seq.songPos);
    b.classList.toggle('cursor', !songPlaying && project.songMode && i === seq.songPos);
    b.classList.toggle('queued', seq.queuedSongPos === i);
    b.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('x')) {
        project.song.splice(i, 1);
        if (i < seq.songPos) seq.songPos--;
        save();
      } else {
        seq.requestSongPos(i);
      }
      renderSong();
    });
    el.append(b);
  });
  // 전체 길이
  let steps = 0;
  for (const pi of project.song) steps += patternBars(project, pi) * STEPS_PER_BAR;
  const sec = (steps * 60) / project.bpm / 4;
  $('#song-info').textContent = project.song.length
    ? `${steps / STEPS_PER_BAR} bars, ${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`
    : '';
  $('#song-loop').classList.toggle('on', project.songLoop);
}

const pageEls: HTMLButtonElement[] = [];
function renderSeqBar() {
  const pat = curPattern();
  if (page >= pat.bars) page = pat.bars - 1;
  $<HTMLSelectElement>('#pat-len').value = String(pat.bars);
  const pagesEl = $('#pages');
  if (pageEls.length !== pat.bars) {
    pagesEl.innerHTML = '';
    pageEls.length = 0;
    for (let i = 0; i < pat.bars; i++) {
      const b = document.createElement('button');
      b.textContent = String(i + 1);
      b.addEventListener('click', () => {
        page = i;
        if (seq.playing) follow = false;
        renderSeqBar();
        renderGrid();
      });
      pagesEl.append(b);
      pageEls.push(b);
    }
  }
  pageEls.forEach((b, i) => b.classList.toggle('on', i === page));
  $('#follow').classList.toggle('on', follow);
}

function renderGrid() {
  const grp = project.groups[selG];
  const pat = grp.patterns[project.pattern];
  $('#seq-group').textContent = GROUP_NAMES[selG];
  const base = page * STEPS_PER_BAR;
  for (let r = 0; r < PADS; r++) {
    const s = grp.sounds[r];
    rowLabels[r].innerHTML = `<kbd>${PAD_KEYS[r].toUpperCase()}</kbd>${s.sampleId ? escapeHtml(s.name || 'SAMPLE') : 'empty'}`;
    rows[r].classList.toggle('selected', r === selP);
    rows[r].classList.toggle('empty', !s.sampleId);
    for (let st = 0; st < STEPS_PER_BAR; st++) cells[r][st].classList.toggle('on', !!pat.steps[r][base + st]);
  }
}

function renderTransport() {
  $('#play').classList.toggle('on', seq.playing);
  $('#play').textContent = seq.playing ? '■' : '▶';
  $('#seqrec').classList.toggle('on', recArm);
  $('#metro').classList.toggle('on', project.metronome);
  $('#keys').classList.toggle('on', keysMode);
  $('#songmode').classList.toggle('on', project.songMode);
  $<HTMLInputElement>('#bpm').value = String(project.bpm);
  transportFaders.forEach((f) => f.refresh());
}

function renderSampleRec() {
  const btn = $<HTMLButtonElement>('#sample-rec');
  btn.classList.toggle('on', recorder.recording);
  btn.disabled = !recorder.connected && !recorder.recording;
  const next = nextTarget && nextTarget.g === selG ? nextTarget : { g: selG, p: selP };
  btn.textContent = recorder.recording
    ? `Stop and save to ${padName(recTarget.g, recTarget.p)}`
    : `Record to ${padName(next.g, next.p)}`;
  $('#grab').title = `Save to ${padName(next.g, next.p)}`;
  library.renderTarget();
  renderSource();
}

const SRC_HINTS: Record<SourceKind['type'], { idle: string; ok: string; btn: string }> = {
  display: { idle: 'Pick the tab that plays the music and turn on “Share tab audio”.', ok: 'Listening to the shared tab.', btn: 'Connect' },
  device: { idle: '', ok: 'Listening.', btn: 'Connect' },
  resample: { idle: 'Records what this sampler is playing.', ok: 'Listening to the master output.', btn: 'Connect' },
};

function renderSource() {
  $<HTMLSelectElement>('#src-kind').value = srcKind;
  $('#device').style.display = srcKind === 'device' ? '' : 'none';
  const here = !!recorder.connected && recorder.kind === srcKind;
  const h = SRC_HINTS[srcKind];
  $('#src-row').classList.toggle('ok', here);
  $('#src-hint').textContent = here ? h.ok : h.idle;
  $('#connect').textContent = here ? 'Disconnect' : recorder.connected ? 'Switch' : h.btn;
  $('#src-status').textContent = recorder.connected ?? '';
  document.querySelectorAll<HTMLButtonElement>('#grab button').forEach((b) => (b.disabled = !recorder.connected));
  renderHold();
}

/** 큰 샘플링 버튼 표시 */
function renderHold() {
  const btn = $('#hold');
  const next = nextTarget && nextTarget.g === selG ? nextTarget : { g: selG, p: selP };
  btn.classList.toggle('on', holdStart !== null);
  btn.classList.toggle('off', !recorder.connected);
  if (holdStart !== null) {
    $('#hold-main').textContent = `Recording ${((performance.now() - holdStart) / 1000).toFixed(1)} s`;
    $('#hold-sub').textContent = `Let go to save to ${padName(holdTarget.g, holdTarget.p)}`;
  } else {
    $('#hold-main').textContent = `Hold to sample into ${padName(next.g, next.p)}`;
    $('#hold-sub').textContent = recorder.connected
      ? 'Tap to keep the last 4 seconds, or hold G'
      : 'Connect a source first';
  }
}

function renderAll() {
  renderGroups();
  renderPads();
  renderEditor();
  renderPatterns();
  renderSeqBar();
  renderGrid();
  renderTransport();
  renderFx();
  renderSong();
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let toastTimer = 0;
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 2800);
}

// ---------------------------------------------------------------- controls
function togglePlay() {
  unlockAudio();
  if (seq.playing) {
    seq.stop();
  } else {
    page = 0;
    seq.start();
  }
  renderTransport();
  renderPatterns();
  renderSeqBar();
  renderGrid();
  renderSong();
}

function bindControls() {
  $('#overlay').addEventListener('click', unlockAudio);
  $('#play').addEventListener('click', togglePlay);
  $('#seqrec').addEventListener('click', () => {
    recArm = !recArm;
    renderTransport();
  });
  $('#metro').addEventListener('click', () => {
    project.metronome = !project.metronome;
    renderTransport();
    save();
  });
  $('#keys').addEventListener('click', () => {
    keysMode = !keysMode;
    if (keysMode && cueMode) setCueMode(false);
    releaseAllHeld();
    renderTransport();
    renderPads();
  });
  $('#kit-restore').addEventListener('click', () => {
    project.groups[selG].sounds = project.groups[selG].sounds.map((_, i) => kitSound(selG, i));
    renderAll();
    save();
    toast(`Group ${GROUP_NAMES[selG]} is back to the built-in kit`);
  });
  const bpmEl = $<HTMLInputElement>('#bpm');
  bpmEl.addEventListener('change', () => setBpm(Number(bpmEl.value) || 90));
  // BPM 칸 위에서 스크롤 = ±1 (Shift는 미세하게)
  let bpmAcc = 0;
  bpmEl.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { x, y } = wheelDelta(e);
      bpmAcc += Math.abs(y) >= Math.abs(x) ? y : x;
      const unit = e.shiftKey ? 60 : 18;
      const steps = Math.trunc(bpmAcc / unit);
      if (steps) {
        bpmAcc -= steps * unit;
        setBpm(project.bpm + steps);
      }
    },
    { passive: false },
  );
  $('#tap').addEventListener('click', tapTempo);
  const help = $<HTMLDialogElement>('#help');
  $('#help-btn').addEventListener('click', () => help.showModal());
  $('#lib-btn').addEventListener('click', () => library.toggle());
  $('#len-all').addEventListener('click', () => {
    const len = cur().length;
    project.groups[selG].sounds.forEach((snd) => (snd.length = len));
    save();
    toast(`Every pad in group ${GROUP_NAMES[selG]} now plays ${LENGTH_LABELS[LENGTHS.indexOf(len)] ?? 'full'}`.replace('plays Full', 'plays in full'));
  });
  $('#cue-mode').addEventListener('click', () => setCueMode(!cueMode));
  $('#cue-spread').addEventListener('click', () => {
    if (!yt.loaded || !yt.duration) return toast('Load a YouTube video first');
    project.yt.cues = project.yt.cues.map((_, i) => Math.round(((yt.duration * i) / PADS) * 100) / 100);
    if (!cueMode) setCueMode(true);
    renderPads();
    save();
    toast('Spread 12 cues across the video');
  });
  $('#cue-clear').addEventListener('click', () => {
    project.yt.cues = new Array(PADS).fill(null);
    renderPads();
    save();
  });
  $('#yt-open').addEventListener('click', () => {
    if (!project.yt.videoId) return toast('Load a YouTube video first');
    window.open(`https://www.youtube.com/watch?v=${project.yt.videoId}&t=${Math.floor(yt.time)}s`, '_blank', 'noopener');
    yt.mute();
    srcKind = 'display';
    renderSource();
    toast('Opened on YouTube. Press Connect in Sample and share that tab to record it.');
  });

  // FX XY
  $('#xy-snap').addEventListener('click', () => {
    xySnap = !xySnap;
    $('#xy-snap').classList.toggle('on', xySnap);
  });

  // time stretch
  document.querySelectorAll<HTMLButtonElement>('#time-mode button').forEach((b) =>
    b.addEventListener('click', () => {
      const s = cur();
      const mode = b.dataset.v as TimeMode;
      const info = engine.timeInfo(s);
      // 처음 켤 때는 trim 길이로 BPM/마디를 추정해서 채워 줌
      if (info && mode !== 'off' && s.timeMode === 'off') {
        const g = guessBpm(info.len, project.bpm);
        if (g) {
          if (mode === 'bpm') s.sampleBpm = Math.round(g.bpm * 10) / 10;
          if (mode === 'bars') s.bars = BAR_CHOICES.reduce((a, c) => (Math.abs(Math.log(c / g.bars)) < Math.abs(Math.log(a / g.bars)) ? c : a));
        }
      }
      s.timeMode = mode;
      schedulePrepare();
      renderTime();
      save();
    }),
  );
  document.querySelectorAll<HTMLButtonElement>('#stretch-mode button').forEach((b) =>
    b.addEventListener('click', () => {
      cur().stretch = b.dataset.v as StretchMode;
      schedulePrepare();
      renderTime();
      save();
    }),
  );
  $('#bpm-auto').addEventListener('click', () => {
    const info = engine.timeInfo(cur());
    const g = info && guessBpm(info.len, project.bpm);
    if (!g) return toast('Couldn’t detect a tempo. Trim the region to exactly 1, 2 or 4 bars and try again.');
    cur().sampleBpm = Math.round(g.bpm * 10) / 10;
    schedulePrepare();
    renderTime();
    save();
    toast(`Read as a ${g.bars < 1 ? `${g.bars * 4}-beat` : `${g.bars}-bar`} loop at ${cur().sampleBpm} BPM`);
  });
  const scaleBpm = (k: number) => {
    cur().sampleBpm = Math.round(clamp(cur().sampleBpm * k, 40, 240) * 10) / 10;
    schedulePrepare();
    renderTime();
    save();
  };
  $('#bpm-half').addEventListener('click', () => scaleBpm(0.5));
  $('#bpm-double').addEventListener('click', () => scaleBpm(2));

  // scenes & song
  $('#songmode').addEventListener('click', toggleSongMode);
  $('#song-loop').addEventListener('click', () => {
    project.songLoop = !project.songLoop;
    renderSong();
    save();
  });
  $('#song-add').addEventListener('click', () => {
    if (project.song.length >= SONG_MAX) return toast(`A song holds up to ${SONG_MAX} patterns`);
    project.song.push(seq.queuedPattern ?? project.pattern);
    renderSong();
    save();
  });
  $('#song-clear').addEventListener('click', () => {
    project.song = [];
    seq.songPos = 0;
    renderSong();
    save();
  });

  // patterns
  $<HTMLSelectElement>('#pat-len').addEventListener('change', (e) => {
    setPatternBars(project, project.pattern, Number((e.target as HTMLSelectElement).value));
    renderSeqBar();
    renderGrid();
    renderPatterns();
    renderSong();
    save();
  });
  $('#follow').addEventListener('click', () => {
    follow = !follow;
    renderSeqBar();
  });
  // 복사/붙여넣기는 패턴 통째로 (A·B·C·D 모두)
  $('#pat-copy').addEventListener('click', () => {
    clipboard = project.groups.map((g) => structuredClone(g.patterns[project.pattern]));
    toast(`Copied pattern ${project.pattern + 1}`);
  });
  $('#pat-paste').addEventListener('click', () => {
    if (!clipboard) return toast('Copy a pattern first');
    clipboard.forEach((pat, g) => (project.groups[g].patterns[project.pattern] = structuredClone(pat)));
    renderPatterns();
    renderSeqBar();
    renderGrid();
    renderGroups();
    renderSong();
    save();
    toast(`Pasted into pattern ${project.pattern + 1}`);
  });
  // 지우기는 지금 보이는 그룹만
  $('#seq-clear').addEventListener('click', () => {
    curPattern().steps.forEach((r) => r.fill(0));
    renderGrid();
    renderPatterns();
    renderGroups();
    save();
    toast(`Cleared group ${GROUP_NAMES[selG]} in pattern ${project.pattern + 1}`);
  });

  // editor
  $<HTMLInputElement>('#ed-name').addEventListener('input', (e) => {
    cur().name = (e.target as HTMLInputElement).value;
    renderPads();
    renderGrid();
    save();
  });
  document.querySelectorAll<HTMLButtonElement>('#mode button').forEach((b) =>
    b.addEventListener('click', () => {
      cur().mode = b.dataset.v as Sound['mode'];
      renderEditor();
      save();
    }),
  );
  $('#reverse').addEventListener('click', () => {
    cur().reverse = !cur().reverse;
    schedulePrepare();
    renderEditor();
    save();
  });
  $<HTMLSelectElement>('#choke').addEventListener('change', (e) => {
    cur().muteGroup = Number((e.target as HTMLSelectElement).value);
    save();
  });
  wave.onChange = (a, b) => {
    cur().start = a;
    cur().end = b;
    renderWaveInfo();
    renderTime();
    schedulePrepare();
    save();
  };
  const editor = $('#editor');
  editor.addEventListener('dragover', (e) => e.preventDefault());
  editor.addEventListener('drop', (e) => {
    e.preventDefault();
    const lib = e.dataTransfer?.getData(LIB_DRAG_TYPE);
    if (lib) void dropLibraryItem(JSON.parse(lib) as LibItem, selG, selP);
    else if (e.dataTransfer?.files.length) void loadFiles([...e.dataTransfer.files], selG, selP);
  });

  // sampler
  $<HTMLSelectElement>('#src-kind').addEventListener('change', (e) => {
    srcKind = (e.target as HTMLSelectElement).value as SourceKind['type'];
    try {
      localStorage.setItem('src-kind', srcKind);
    } catch {
      /* noop */
    }
    renderSource();
  });
  // 큰 버튼: 누르고 있는 동안 샘플링
  const holdBtn = $('#hold');
  holdBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      holdBtn.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    sampleDown();
  });
  holdBtn.addEventListener('pointerup', () => void sampleUp());
  holdBtn.addEventListener('pointercancel', () => void sampleUp());
  holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#connect').addEventListener('click', () => void toggleConnect());
  const ytUrl = $<HTMLInputElement>('#yt-url');
  ytUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void loadYouTube();
  });
  ytUrl.addEventListener('paste', () => setTimeout(() => parseYouTubeId(ytUrl.value) && void loadYouTube(), 0));
  $('#yt-play').addEventListener('click', () => yt.toggle());
  $('#yt-back').addEventListener('click', () => yt.seek(-5));
  $('#yt-fwd').addEventListener('click', () => yt.seek(5));
  yt.onError = (code) => toast(YT_ERRORS[code] ?? `YouTube error ${code}`);
  const inv = $<HTMLInputElement>('#wheel-inv');
  inv.checked = getWheelInvert();
  inv.addEventListener('change', () => setWheelInvert(inv.checked));
  $('#sample-rec').addEventListener('click', () => void toggleSampleRec());
  $<HTMLInputElement>('#opt-mon').addEventListener('change', (e) =>
    recorder.setMonitor((e.target as HTMLInputElement).checked && recorder.kind === 'device'),
  );
  $<HTMLInputElement>('#file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) void loadFiles([...input.files], selG, selP);
    input.value = '';
  });
  $('#chop').addEventListener('click', chop);
  $('#export').addEventListener('click', exportWav);
  $('#clear').addEventListener('click', () => {
    project.groups[selG].sounds[selP] = emptySound();
    renderAll();
    save();
  });

  recorder.onSourceEnded = () => {
    if (recorder.recording) void finishRecording();
    renderSampleRec();
    toast('The source was disconnected');
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void refreshDevices());

  // keyboard: 글자(e.key) 대신 물리 키 위치(e.code)로 판단 → 한글 입력 상태에서도 동작
  const punchKey = (k: string) => PUNCH.find((p) => p.key === k);
  const CODE_MAP: Record<string, string> = {
    Space: ' ',
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Slash: '/',
    ArrowUp: 'arrowup',
    ArrowDown: 'arrowdown',
    ArrowLeft: 'arrowleft',
    ArrowRight: 'arrowright',
  };
  const keyOf = (e: KeyboardEvent): string => {
    const c = e.code;
    if (c.startsWith('Key')) return c.slice(3).toLowerCase();
    if (c.startsWith('Digit')) return c.slice(5);
    return CODE_MAP[c] ?? e.key.toLowerCase();
  };
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.matches('input[type=number], input:not([type]), input[type=text], select, textarea')) return;
    if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = keyOf(e);
    const i = PAD_KEYS.indexOf(k);
    if (i >= 0) {
      e.preventDefault();
      if (!e.repeat) padDown(i, e.shiftKey);
      return;
    }
    const pk = punchKey(k);
    if (pk) {
      e.preventDefault();
      if (!e.repeat) punchDown(pk.kind);
      return;
    }
    if (k === 'g') {
      e.preventDefault();
      if (!e.repeat) sampleDown();
      return;
    }
    if (t.closest('.fader, .xy') && k.startsWith('arrow')) return;
    if (e.repeat) return;
    const shown = seq.queuedPattern ?? project.pattern;
    if (k === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (k === 'arrowup') {
      e.preventDefault();
      setGroup((selG + GROUPS - 1) % GROUPS);
    } else if (k === 'arrowdown') {
      e.preventDefault();
      setGroup((selG + 1) % GROUPS);
    } else if (k === '[') selectPattern((shown + PATTERNS - 1) % PATTERNS);
    else if (k === ']') selectPattern((shown + 1) % PATTERNS);
    else if (k === 'n') toggleSongMode();
    else if (k === 'r') $('#seqrec').click();
    else if (k === 'm') $('#metro').click();
    else if (k === 'k') $('#keys').click();
    else if (k === 't') tapTempo();
    else if (k === 'y') setCueMode(!cueMode);
    else if (k === 'l') {
      e.preventDefault();
      library.toggle();
    }
    else if (k === '?' || k === '/') $<HTMLDialogElement>('#help').showModal();
  });
  window.addEventListener('keyup', (e) => {
    const k = keyOf(e);
    const i = PAD_KEYS.indexOf(k);
    if (i >= 0) padUp(i);
    const pk = punchKey(k);
    if (pk) punchUp(pk.kind);
    if (k === 'g') void sampleUp();
  });
  window.addEventListener('blur', () => {
    releaseAllHeld();
    releaseAllPunch();
    void sampleUp();
  });
  // 버튼 클릭 후 포커스가 남으면 Space가 버튼을 다시 눌러버리므로 해제
  document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) (document.activeElement as HTMLElement)?.blur?.();
  });
}

// ---------------------------------------------------------------- library
const library = new Library($('#library'), {
  ctx: engine.ctx,
  out: engine.master,
  target: () => {
    const t = nextTarget && nextTarget.g === selG ? nextTarget : { g: selG, p: selP };
    return padName(t.g, t.p);
  },
  onAdd: async (buf, it) => {
    const t = takeTarget();
    await putLibrarySound(buf, it, t.g, t.p);
    if ($<HTMLInputElement>('#opt-next').checked) nextTarget = { g: t.g, p: (t.p + 1) % PADS };
    renderSampleRec();
  },
  toast,
});

async function putLibrarySound(buf: AudioBuffer, it: LibItem, g: number, p: number) {
  unlockAudio();
  selG = g;
  selP = p;
  // 라이브러리 소리도 앞뒤 무음을 자르고 볼륨을 맞춰서 패드끼리 고르게
  let chs = dsp.collapseMono(dsp.bufferChannels(buf));
  if ($<HTMLInputElement>('#opt-trim').checked) chs = dsp.trimSilence(chs, buf.sampleRate);
  if ($<HTMLInputElement>('#opt-norm').checked) dsp.normalize(chs, 0.9);
  await assignSample(g, p, chs, buf.sampleRate, it.name);
  toast(`Added ${it.name} to ${padName(g, p)}${it.license === 'CC BY' || it.license === 'CC BY-NC' ? `. ${it.license}: credit the author if you release this.` : ''}`);
}

async function dropLibraryItem(it: LibItem, g: number, p: number) {
  try {
    await putLibrarySound(await library.load(it.url), it, g, p);
  } catch {
    toast(`Couldn’t load ${it.name}`);
  }
}

// ---------------------------------------------------------------- tap tempo
let taps: number[] = [];
function tapTempo() {
  const now = performance.now();
  taps = taps.filter((t) => now - t < 2500).slice(-7);
  taps.push(now);
  if (taps.length >= 2) {
    const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    setBpm(60000 / iv);
  }
  hud(taps.length >= 2 ? `${project.bpm} BPM` : 'Keep tapping', $('#tap'));
}

// ---------------------------------------------------------------- sampling
let srcKind: SourceKind['type'] = 'display';
const yt = new YouTubePlayer($('#yt-frame'));

async function refreshDevices() {
  const sel = $<HTMLSelectElement>('#device');
  const prev = sel.value;
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch {
    /* 권한 전 */
  }
  sel.innerHTML = '';
  const opts: [string, string][] = devices.length
    ? devices.map((d, i) => [d.deviceId, d.label || `Input ${i + 1}`])
    : [['default', 'Default input']];
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.append(o);
  }
  if (opts.some(([v]) => v === prev)) sel.value = prev;
}

async function connectSource(type: SourceKind['type']): Promise<boolean> {
  unlockAudio();
  const sel = $<HTMLSelectElement>('#device');
  const kind: SourceKind = type === 'device' ? { type, deviceId: sel.value } : { type };
  const labels: Record<SourceKind['type'], string> = {
    display: 'Shared tab',
    device: sel.selectedOptions[0]?.textContent ?? 'Input',
    resample: 'Master output',
  };
  try {
    if (recorder.recording) await finishRecording();
    await recorder.connect(kind, labels[type]);
    // 모니터링은 마이크/라인일 때만 (탭 소리는 이미 들리고 있으므로 두 번 들림)
    recorder.setMonitor(type === 'device' && $<HTMLInputElement>('#opt-mon').checked);
    if (type === 'device') await refreshDevices();
    return true;
  } catch (e) {
    const err = e as Error;
    if (err.message === 'NO_AUDIO') toast('No audio came through. Share again and turn on “Share tab audio”.');
    else if (err.name === 'NotAllowedError') toast('Sharing was cancelled or blocked');
    else toast(`Couldn’t connect: ${err.message}`);
    return false;
  } finally {
    renderSampleRec();
  }
}

async function toggleConnect() {
  if (recorder.connected && recorder.kind === srcKind) {
    if (recorder.recording) await finishRecording();
    recorder.disconnect();
    renderSampleRec();
    return;
  }
  if (await connectSource(srcKind)) toast('Connected. Play something, then hold the red button.');
}

async function loadYouTube(quiet = false) {
  const id = parseYouTubeId($<HTMLInputElement>('#yt-url').value);
  if (!id) return quiet ? undefined : toast('That doesn’t look like a YouTube link');
  if (!quiet) unlockAudio();
  const empty = document.querySelector('#yt-frame .yt-empty');
  if (empty) empty.textContent = 'Loading…';
  try {
    await yt.load(id);
  } catch {
    if (!quiet) toast('The YouTube player didn’t load. Check your connection.');
    return;
  }
  if (project.yt.videoId !== id) {
    project.yt.videoId = id;
    project.yt.cues = new Array(PADS).fill(null);
    save();
  }
  renderPads();
  if (quiet) return;
  yt.play();
  if (cueMode) yt.mute();
  else toast('Turn on Cue pads (Y), then tap empty pads while it plays to mark moments.');
}

/** 방금 들은 N초를 선택한 패드에 */
async function grabLast(sec: number) {
  unlockAudio();
  if (!recorder.connected) return toast('Connect a source first');
  const target = takeTarget();
  const chs = await recorder.grab(sec);
  await storeCapture(chs, target, `GRAB ${sec}s`);
}

/**
 * 누르고 있는 동안 샘플링.
 * 실제로는 링버퍼(최근 60초)에서 "누른 시간 + 0.3초"를 꺼내 온다 →
 * 누르는 게 조금 늦어도 앞부분이 잘리지 않음. 짧게 누르면 방금 4초.
 */
let holdStart: number | null = null;
let holdTarget = { g: 0, p: 0 };
function sampleDown() {
  unlockAudio();
  if (holdStart !== null) return;
  if (!recorder.connected) {
    toast('Connect a source first');
    const c = $('#connect');
    c.classList.remove('attention');
    void c.offsetWidth;
    c.classList.add('attention');
    return;
  }
  holdStart = performance.now();
  holdTarget = takeTarget();
  renderHold();
}

async function sampleUp() {
  if (holdStart === null) return;
  const held = (performance.now() - holdStart) / 1000;
  holdStart = null;
  renderHold();
  const quick = held < 0.3;
  const sec = quick ? 4 : Math.min(RING_SECONDS, held + 0.3);
  const chs = await recorder.grab(sec);
  await storeCapture(chs, holdTarget, quick ? 'GRAB 4s' : `SMP ${held.toFixed(1)}s`);
}

/** 녹음/GRAB 결과 정리 → 패드에 저장 → (옵션) 다음 패드로 */
async function storeCapture(raw: Float32Array[], target: { g: number; p: number }, name: string) {
  const sr = engine.ctx.sampleRate;
  if (!raw.length || raw[0].length < sr * 0.01) return toast('Nothing was recorded');
  let chs = dsp.collapseMono(raw);
  if ($<HTMLInputElement>('#opt-trim').checked) chs = dsp.trimSilence(chs, sr);
  if (chs[0].length < sr * 0.01) return toast('Only silence came in. Is the video playing?');
  if ($<HTMLInputElement>('#opt-norm').checked) dsp.normalize(chs);
  selG = target.g;
  selP = target.p;
  await assignSample(target.g, target.p, chs, sr, name);
  toast(`Saved ${(chs[0].length / sr).toFixed(2)} s to ${padName(target.g, target.p)}. Drag the markers to trim.`);
  if ($<HTMLInputElement>('#opt-next').checked) {
    // 방금 담은 패드는 편집할 수 있게 선택 유지하되, 다음 GRAB/REC 대상은 다음 패드
    nextTarget = { g: target.g, p: (target.p + 1) % PADS };
    renderSampleRec();
  }
}

/** "다음 패드로 이동" 옵션: 다음 캡처가 들어갈 자리 (패드를 직접 고르면 해제) */
let nextTarget: { g: number; p: number } | null = null;
function takeTarget() {
  const t = nextTarget && nextTarget.g === selG ? nextTarget : { g: selG, p: selP };
  nextTarget = null;
  return t;
}

async function toggleSampleRec() {
  unlockAudio();
  if (recorder.recording) return finishRecording();
  if (!recorder.connected) return toast('Connect a source first');
  recTarget = takeTarget();
  recStartedAt = performance.now();
  recorder.start();
  renderSampleRec();
}

async function finishRecording() {
  const target = recTarget;
  const chs = await recorder.stop();
  renderSampleRec();
  const t = new Date();
  const name = `REC ${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}`;
  await storeCapture(chs, target, name);
}

async function loadFiles(files: File[], g: number, startP: number) {
  unlockAudio();
  let ok = 0;
  for (const [n, f] of files.entries()) {
    const p = (startP + n) % PADS;
    try {
      const buf = await engine.ctx.decodeAudioData(await f.arrayBuffer());
      const chs = dsp.collapseMono(dsp.bufferChannels(buf));
      const name = f.name.replace(/\.[^.]+$/, '').toUpperCase();
      await assignSample(g, p, chs, buf.sampleRate, name);
      ok++;
    } catch {
      toast(`Couldn’t read ${f.name}`);
    }
  }
  if (ok) toast(`Loaded ${ok} file${ok > 1 ? 's' : ''}`);
}

function chop() {
  const s = cur();
  if (!s.sampleId) return toast('This pad is empty');
  const n = Number($<HTMLSelectElement>('#chop-n').value);
  const hits = $<HTMLSelectElement>('#chop-mode').value === 'hits';
  const a = Math.min(s.start, s.end);
  const b = Math.max(s.start, s.end);
  // 경계 목록: 타격점마다(오토 촙) 또는 균등하게
  const bounds = hits
    ? [...dsp.detectOnsets(engine.getBuffer(s.sampleId)!, a, b, n), b]
    : Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  const count = bounds.length - 1;
  const base = (s.name || 'SMP').slice(0, 10);
  for (let i = 0; i < count; i++) {
    const p = (selP + i) % PADS;
    project.groups[selG].sounds[p] = {
      ...s,
      start: bounds[i],
      end: bounds[i + 1],
      name: `${base} ${i + 1}`,
      mode: 'oneshot',
      reverse: false,
      bars: (s.bars * (bounds[i + 1] - bounds[i])) / (b - a), // BAR 모드였다면 조각도 같은 템포로
    };
  }
  renderAll();
  save();
  toast(
    hits
      ? `Found ${count} hit${count > 1 ? 's' : ''}, placed from ${padName(selG, selP)}`
      : `Chopped into ${count} slices starting at ${padName(selG, selP)}`,
  );
}

function exportWav() {
  const s = cur();
  const buf = s.sampleId ? engine.getBuffer(s.sampleId) : undefined;
  if (!buf) return toast('This pad is empty');
  const blob = dsp.encodeWav(buf, s.start, s.end, s.reverse);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(s.name || 'sample').replace(/[^\w\- ]+/g, '_')}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- frame loop
let lastCol = -1;
let lastPlayPage = -1;
const meterBar = $('#meter-bar');
let meterLevel = 0;
let frameCount = 0;
function frame() {
  const now = engine.ctx.currentTime;
  const grp = project.groups[selG];
  const snap = seq.playing ? seq.snapshotAt(now) : null;
  const pos = snap && snap.pat[selG] === grp.pattern ? snap.pos[selG] : -1;
  const playPage = pos >= 0 ? Math.floor(pos / STEPS_PER_BAR) : -1;
  if (follow && playPage >= 0 && playPage !== page) {
    page = playPage;
    renderSeqBar();
    renderGrid();
  }
  if (playPage !== lastPlayPage) {
    pageEls.forEach((b, i) => b.classList.toggle('playing', i === playPage));
    lastPlayPage = playPage;
  }
  const col = playPage === page ? pos % STEPS_PER_BAR : -1;
  if (col !== lastCol) {
    if (lastCol >= 0) cells.forEach((r) => r[lastCol].classList.remove('ph'));
    if (col >= 0) cells.forEach((r) => r[col].classList.add('ph'));
    lastCol = col;
  }
  wave.tick();
  const pk = recorder.connected ? recorder.peak() : 0;
  const level = pk > 0 ? 20 * Math.log10(pk) : -60;
  const target = Math.max(0, Math.min(1, (level + 60) / 60));
  meterLevel = target > meterLevel ? target : meterLevel * 0.92;
  meterBar.style.width = `${meterLevel * 100}%`;
  if (recorder.recording) $('#rec-time').textContent = `${((performance.now() - recStartedAt) / 1000).toFixed(1)}s`;
  if (holdStart !== null && frameCount % 3 === 0) renderHold();
  if (++frameCount % 10 === 0) {
    const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    $('#yt-time').textContent = yt.loaded ? `${mmss(yt.time)} / ${mmss(yt.duration)}` : '';
    $('#buf-info').textContent = recorder.connected ? `${Math.floor(recorder.bufferedSeconds)} s buffered` : '';
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- boot
async function boot() {
  buildStatic();
  bindControls();
  const kit = await renderKit();
  kit.forEach((b, id) => engine.setBuffer(id, b));

  let migrated: ReturnType<typeof migrate> = null;
  try {
    migrated = migrate(await db.getProject());
  } catch {
    /* IndexedDB 사용 불가 */
  }
  project = migrated?.project ?? defaultProject();
  // 씬 기능 이전에 저장된 프로젝트: 지금 조합을 씬 1로
  if (migrated?.fromV1) {
    // 예전 버전은 C/D가 비어 있었음 → 빈 패드에만 새 키트 채우기
    for (const g of [2, 3]) {
      project.groups[g].sounds.forEach((s, i) => {
        if (!s.sampleId) project.groups[g].sounds[i] = kitSound(g, i);
      });
    }
    save();
  }

  const ids = new Set<string>();
  project.groups.forEach((g) =>
    g.sounds.forEach((s) => s.sampleId && !s.sampleId.startsWith('kit:') && ids.add(s.sampleId)),
  );
  for (const id of ids) {
    try {
      const st = await db.getSample(id);
      if (st) engine.setBuffer(id, dsp.makeBuffer(st.channels, st.sampleRate));
    } catch {
      /* noop */
    }
  }
  project.groups.forEach((g) =>
    g.sounds.forEach((s, i) => {
      if (s.sampleId && !engine.hasBuffer(s.sampleId)) g.sounds[i] = emptySound();
    }),
  );

  engine.syncMix();
  engine.syncFx();
  engine.prepareAll();
  try {
    const k = localStorage.getItem('src-kind') as SourceKind['type'] | null;
    if (k && k in SRC_HINTS) srcKind = k;
  } catch {
    /* noop */
  }
  renderAll();
  await refreshDevices();
  renderSource();
  // 쓰이지 않는 샘플 정리는 시작할 때만 (세션 중엔 undo로 되살릴 수 있게 남겨 둠)
  void gcSamples().catch(() => {});
  snapshot();
  if (project.yt.videoId) {
    $<HTMLInputElement>('#yt-url').value = `https://youtu.be/${project.yt.videoId}`;
    void loadYouTube(true);
  }
  if (engine.ctx.state === 'running') $('#overlay').classList.add('hidden');
  requestAnimationFrame(frame);
}

void boot();
