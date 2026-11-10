import { computePeaks } from '../audio/dsp';

/** 파형 + trim 핸들(start/end 드래그) + 재생 위치 표시 */
export class Waveform {
  private buf: AudioBuffer | null = null;
  private start = 0;
  private end = 1;
  private reverse = false;
  private peaks: Float32Array | null = null;
  private peaksFor: AudioBuffer | null = null;
  private peaksW = 0;
  private play: { t0: number; dur: number } | null = null;
  private drag: 'start' | 'end' | null = null;
  private dirty = true;
  /** 박자 격자: 한 박의 길이(버퍼 길이 대비 비율). trim 시작점부터 그린다 */
  private beat: number | null = null;
  private colors: Record<string, string> = {};
  onChange: (start: number, end: number) => void = () => {};

  constructor(
    private cv: HTMLCanvasElement,
    private now: () => number,
  ) {
    const css = getComputedStyle(document.documentElement);
    for (const k of ['wave-bg', 'wave', 'wave-dim', 'region', 'accent', 'playhead', 'text-dim']) {
      this.colors[k] = css.getPropertyValue(`--${k}`).trim() || '#888';
    }
    new ResizeObserver(() => (this.dirty = true)).observe(cv);
    cv.addEventListener('pointerdown', (e) => {
      if (!this.buf) return;
      cv.setPointerCapture(e.pointerId);
      const f = this.frac(e);
      this.drag = Math.abs(f - this.start) <= Math.abs(f - this.end) ? 'start' : 'end';
      this.apply(f);
    });
    cv.addEventListener('pointermove', (e) => this.drag && this.apply(this.frac(e)));
    const up = () => (this.drag = null);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', () => {
      if (!this.buf) return;
      this.start = 0;
      this.end = 1;
      this.onChange(0, 1);
      this.dirty = true;
    });
  }

  private frac(e: PointerEvent) {
    const r = this.cv.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  }

  private apply(f: number) {
    const gap = 0.002;
    if (this.drag === 'start') this.start = Math.max(0, Math.min(f, this.end - gap));
    else this.end = Math.min(1, Math.max(f, this.start + gap));
    this.onChange(this.start, this.end);
    this.dirty = true;
  }

  set(buf: AudioBuffer | null, start: number, end: number, reverse: boolean) {
    this.buf = buf;
    this.start = start;
    this.end = end;
    this.reverse = reverse;
    this.play = null;
    this.dirty = true;
  }

  setGrid(beat: number | null) {
    if (beat !== this.beat) {
      this.beat = beat;
      this.dirty = true;
    }
  }

  playFrom(t0: number, dur: number) {
    this.play = { t0, dur };
  }

  /** 매 프레임 호출 */
  tick() {
    if (this.play) {
      this.dirty = true;
      if (this.now() > this.play.t0 + this.play.dur) this.play = null;
    }
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
  }

  private draw() {
    const cv = this.cv;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr));
    const h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const g = cv.getContext('2d')!;
    const C = this.colors;
    g.fillStyle = C['wave-bg'];
    g.fillRect(0, 0, w, h);

    if (!this.buf) {
      g.fillStyle = C['text-dim'];
      g.font = `${13 * dpr}px Archivo, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('Empty pad. Sample something or drop an audio file here.', w / 2, h / 2);
      return;
    }
    if (this.peaksFor !== this.buf || this.peaksW !== w) {
      this.peaks = computePeaks(this.buf, w);
      this.peaksFor = this.buf;
      this.peaksW = w;
    }
    const peaks = this.peaks!;
    const mid = h / 2;
    const amp = mid * 0.9;
    const xs = this.start * w;
    const xe = this.end * w;

    g.fillStyle = C.region;
    g.fillRect(xs, 0, xe - xs, h);
    for (let x = 0; x < w; x++) {
      const mn = peaks[x * 2];
      const mx = peaks[x * 2 + 1];
      g.fillStyle = x >= xs && x <= xe ? C.wave : C['wave-dim'];
      g.fillRect(x, mid - mx * amp, 1, Math.max(1, (mx - mn) * amp));
    }
    // 박자 격자 (4박마다 진하게)
    if (this.beat && this.beat * w > 3) {
      for (let i = 1; ; i++) {
        const f = this.start + i * this.beat;
        if (f >= this.end - 1e-6) break;
        g.fillStyle = i % 4 === 0 ? 'rgba(90, 209, 230, 0.75)' : 'rgba(90, 209, 230, 0.28)';
        g.fillRect(f * w, 0, dpr, h);
      }
    }
    // 핸들
    g.fillStyle = C.accent;
    g.fillRect(xs - dpr, 0, 2 * dpr, h);
    g.fillRect(xs, 0, 9 * dpr, 12 * dpr);
    g.fillRect(xe - dpr, 0, 2 * dpr, h);
    g.fillRect(xe - 9 * dpr, h - 12 * dpr, 9 * dpr, 12 * dpr);
    // 재생 위치
    if (this.play) {
      const p = (this.now() - this.play.t0) / this.play.dur;
      if (p >= 0 && p <= 1) {
        const f = this.reverse ? this.end - p * (this.end - this.start) : this.start + p * (this.end - this.start);
        g.fillStyle = C.playhead;
        g.fillRect(f * w, 0, 1.5 * dpr, h);
      }
    }
  }
}
