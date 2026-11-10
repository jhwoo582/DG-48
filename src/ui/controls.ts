/**
 * 트랙패드/마우스 친화적인 컨트롤 모음
 *  - Fader: 드래그(가로·세로 아무 방향), 두 손가락 스크롤, 더블클릭 초기화, 방향키, Shift = 미세 조정
 *  - XYPad: 클릭·드래그로 위치 지정, 두 손가락 스와이프로 X/Y 동시에 이동
 *  - hud: 값을 바꿀 때 잠깐 띄우는 표시
 */

let invertWheel = false;
try {
  invertWheel = localStorage.getItem('wheel-invert') === '1';
} catch {
  /* 저장소 사용 불가 */
}
export const getWheelInvert = () => invertWheel;
export function setWheelInvert(v: boolean) {
  invertWheel = v;
  try {
    localStorage.setItem('wheel-invert', v ? '1' : '0');
  } catch {
    /* noop */
  }
}

/**
 * 휠/트랙패드 → 증감량 (px 단위).
 * macOS 기본(자연스러운 스크롤)에서 손가락을 위로/오른쪽으로 쓸면 +.
 */
export function wheelDelta(e: WheelEvent): { x: number; y: number } {
  const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  let y = e.deltaY * m;
  let x = -e.deltaX * m;
  if (invertWheel) {
    y = -y;
    x = -x;
  }
  return { x, y };
}

// ---------------------------------------------------------------- HUD
let hudEl: HTMLDivElement | null = null;
let hudTimer = 0;
export function hud(text: string, anchor?: Element) {
  if (!hudEl) {
    hudEl = document.createElement('div');
    hudEl.className = 'hud';
    document.body.append(hudEl);
  }
  hudEl.textContent = text;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    hudEl.style.left = `${r.left + r.width / 2}px`;
    hudEl.style.top = `${Math.max(8, r.top - 8)}px`;
  }
  hudEl.classList.add('show');
  clearTimeout(hudTimer);
  hudTimer = window.setTimeout(() => hudEl!.classList.remove('show'), 700);
}

// ---------------------------------------------------------------- Fader
export interface FaderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  def: number | (() => number);
  get: () => number;
  set: (v: number) => void;
  fmt: (v: number) => string;
}

export class Fader {
  readonly el: HTMLDivElement;
  readonly label: HTMLSpanElement;
  private val: HTMLSpanElement;
  private fill: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    private o: FaderOpts,
  ) {
    const el = document.createElement('div');
    el.className = 'fader';
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', o.label);
    this.fill = document.createElement('div');
    this.fill.className = 'fader-fill';
    this.label = document.createElement('span');
    this.label.className = 'fader-label';
    this.label.textContent = o.label;
    this.val = document.createElement('span');
    this.val.className = 'fader-val';
    el.append(this.fill, this.label, this.val);
    parent.append(el);
    this.el = el;

    const range = o.max - o.min;
    let start: { x: number; y: number; v: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.focus({ preventScroll: true });
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      start = { x: e.clientX, y: e.clientY, v: o.get() };
      el.classList.add('active');
    });
    el.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = start.y - e.clientY;
      const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
      this.setValue(start.v + (d / (e.shiftKey ? 900 : 220)) * range);
    });
    const end = () => {
      start = null;
      el.classList.remove('active');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { x, y } = wheelDelta(e);
        const d = Math.abs(y) >= Math.abs(x) ? y : x;
        this.setValue(o.get() + (d / (e.shiftKey ? 1600 : 350)) * range);
        el.classList.add('active');
        clearTimeout(this.wheelTimer);
        this.wheelTimer = window.setTimeout(() => el.classList.remove('active'), 250);
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => this.setValue(typeof o.def === 'function' ? o.def() : o.def));
    el.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      const inc = Math.max(o.step, range / (e.shiftKey ? 200 : 50));
      this.setValue(o.get() + dir * inc);
    });
    this.refresh();
  }

  private wheelTimer = 0;

  private setValue(v: number) {
    const o = this.o;
    v = Math.min(o.max, Math.max(o.min, v));
    v = Math.round(v / o.step) * o.step;
    v = parseFloat(v.toFixed(6));
    if (v !== o.get()) o.set(v);
    this.refresh();
  }

  refresh() {
    const o = this.o;
    const v = o.get();
    const pos = (x: number) => ((x - o.min) / (o.max - o.min)) * 100;
    if (o.min < 0 && o.max > 0) {
      const z = pos(0);
      const p = pos(v);
      this.fill.style.left = `${Math.min(z, p)}%`;
      this.fill.style.width = `${Math.abs(p - z)}%`;
    } else {
      this.fill.style.left = '0';
      this.fill.style.width = `${pos(v)}%`;
    }
    this.val.textContent = o.fmt(v);
    this.el.setAttribute('aria-valuetext', o.fmt(v));
  }
}

// ---------------------------------------------------------------- XY pad
export interface XYOpts {
  get: () => [number, number];
  set: (x: number, y: number) => void;
  names: () => [string, string];
  values: () => [string, string];
  reset: () => void;
  /** 놓으면 원래 값으로 돌아갈지 (Kaoss 패드 스타일) */
  snapBack: () => boolean;
}

export class XYPad {
  readonly el: HTMLDivElement;
  private dot: HTMLDivElement;
  private info: HTMLDivElement;
  private cross: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    private o: XYOpts,
  ) {
    const el = document.createElement('div');
    el.className = 'xy';
    el.tabIndex = 0;
    this.cross = document.createElement('div');
    this.cross.className = 'xy-cross';
    this.dot = document.createElement('div');
    this.dot.className = 'xy-dot';
    this.info = document.createElement('div');
    this.info.className = 'xy-info mono';
    el.append(this.cross, this.dot, this.info);
    parent.append(el);
    this.el = el;

    let saved: [number, number] | null = null;
    const fromEvent = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
      o.set(x, y);
      this.refresh();
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      saved = o.get();
      el.classList.add('active');
      fromEvent(e);
    });
    el.addEventListener('pointermove', (e) => saved && fromEvent(e));
    const end = () => {
      if (saved && o.snapBack()) {
        o.set(saved[0], saved[1]);
        this.refresh();
      }
      saved = null;
      el.classList.remove('active');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const { x, y } = wheelDelta(e);
        const [cx, cy] = o.get();
        const k = e.shiftKey ? 1500 : 400;
        o.set(Math.min(1, Math.max(0, cx + x / k)), Math.min(1, Math.max(0, cy + y / k)));
        this.refresh();
      },
      { passive: false },
    );
    el.addEventListener('dblclick', () => {
      o.reset();
      this.refresh();
    });
    this.refresh();
  }

  refresh() {
    const [x, y] = this.o.get();
    this.dot.style.left = `${x * 100}%`;
    this.dot.style.top = `${(1 - y) * 100}%`;
    this.cross.style.setProperty('--x', `${x * 100}%`);
    this.cross.style.setProperty('--y', `${(1 - y) * 100}%`);
    const [nx, ny] = this.o.names();
    const [vx, vy] = this.o.values();
    this.info.innerHTML = `<span>${nx} <b>${vx}</b></span><span>${ny} <b>${vy}</b></span>`;
  }
}
