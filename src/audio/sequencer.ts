import { GROUPS, STEPS_PER_BAR, selectPatternAll, type Project } from '../types';
import type { Engine } from './engine';

/**
 * Lookahead 스케줄러 ("A Tale of Two Clocks" 방식)
 * - 타이머(Web Worker, 25ms)는 "언제 다음 이벤트를 예약할지"만 판단
 * - 실제 발음 시각은 AudioContext 시계로 미리 예약 → 지터 없음
 * - Worker를 쓰는 이유: 메인 스레드 setInterval은 탭이 백그라운드면 1초로 늦춰짐
 *
 * 패턴: 패턴 하나가 A·B·C·D 네 그룹을 함께 담는다. 그룹을 오가도 패턴은 그대로.
 *   재생 중 다른 패턴을 고르면 예약되고, 지금 패턴이 한 바퀴 끝나는 순간 네 그룹이 함께 넘어간다.
 * 송: 패턴 번호 목록을 순서대로 재생.
 */
const LOOKAHEAD = 0.12; // 초
const workerSrc = `let id=null;onmessage=e=>{if(e.data==='start'){clearInterval(id);id=setInterval(()=>postMessage(0),25)}else{clearInterval(id);id=null}}`;

/** 한 스텝이 예약된 시점의 위치 */
export interface StepSnapshot {
  time: number;
  pos: number[]; // 그룹별 패턴 안 위치 (보통 모두 같음)
  pat: number[]; // 그룹별 패턴 번호 (모두 같음)
}

export interface QuantizeResult extends StepSnapshot {
  scheduled: boolean;
}

export class Sequencer {
  playing = false;
  private count = 0; // 시작 후 16분음표 개수 (스윙, 메트로놈용)
  private cyc = 0; // 현재 패턴 안 위치
  private pos: number[] = new Array(GROUPS).fill(0);
  private pendingPattern: number | null = null;
  private pendingSongPos: number | null = null;
  private ending = false;
  private nextTime = 0;
  private worker: Worker;
  private history: StepSnapshot[] = [];
  private skip = new Set<string>();
  /** 송에서 현재(정지 중이면 시작할) 위치 */
  songPos = 0;
  /** 재생 중 패턴이 실제로 바뀌는 순간 (UI 갱신용) */
  onPatternChange: (() => void) | null = null;
  /** 송이 끝나서 스스로 멈췄을 때 */
  onStopped: (() => void) | null = null;

  constructor(
    private engine: Engine,
    private getProject: () => Project,
  ) {
    this.worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
    this.worker.onmessage = () => this.tick();
  }

  get stepDur() {
    return 60 / this.getProject().bpm / 4; // 16분음표
  }

  private get songActive() {
    const p = this.getProject();
    return p.songMode && p.song.length > 0;
  }

  start() {
    if (this.playing) return;
    const p = this.getProject();
    this.playing = true;
    this.ending = false;
    this.count = 0;
    this.cyc = 0;
    this.pos.fill(0);
    if (this.songActive) {
      this.songPos = Math.min(this.songPos, p.song.length - 1);
      this.applyPattern(p.song[this.songPos], null);
    } else if (this.pendingPattern !== null) {
      this.applyPattern(this.pendingPattern, null);
    }
    this.pendingPattern = null;
    this.pendingSongPos = null;
    this.nextTime = this.engine.ctx.currentTime + 0.05;
    this.history = [];
    this.skip.clear();
    this.tick();
    this.worker.postMessage('start');
  }

  stop() {
    this.playing = false;
    this.ending = false;
    this.worker.postMessage('stop');
    this.history = [];
    this.pendingPattern = null;
    this.pendingSongPos = null;
    this.engine.stopScheduled();
  }

  /** 스윙: 홀수 16분음표를 뒤로 민다. 50% = 정박, 66% ≈ 셔플, 75% = 점8분 느낌 */
  private swingOffset(count: number) {
    const sw = this.getProject().swing;
    return count % 2 === 1 ? (sw / 100 - 0.5) * 2 * this.stepDur : 0;
  }

  private tick() {
    if (!this.playing || this.ending) return;
    const ctx = this.engine.ctx;
    while (!this.ending && this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.scheduleStep(this.nextTime + this.swingOffset(this.count));
      this.nextTime += this.stepDur;
      this.count++;
    }
  }

  /** 현재 패턴 길이(16분음표 수) */
  private cycleLen() {
    const p = this.getProject();
    return Math.max(...p.groups.map((g) => g.patterns[p.pattern].bars * STEPS_PER_BAR));
  }

  /** 패턴 적용: 네 그룹 모두 같은 번호로, 처음부터. t가 있으면 그 시각에 UI 알림 */
  private applyPattern(idx: number, t: number | null) {
    selectPatternAll(this.getProject(), idx);
    this.pos.fill(0);
    this.cyc = 0;
    const delay = t === null ? 0 : Math.max(0, (t - this.engine.ctx.currentTime) * 1000);
    setTimeout(() => this.onPatternChange?.(), delay);
  }

  /** 패턴 한 바퀴가 끝났을 때. false면 송이 끝나서 더 이상 예약하지 않음 */
  private atBoundary(t: number): boolean {
    const p = this.getProject();
    if (this.songActive) {
      let next: number;
      if (this.pendingSongPos !== null) {
        next = Math.min(this.pendingSongPos, p.song.length - 1);
        this.pendingSongPos = null;
      } else {
        next = this.songPos + 1;
        if (next >= p.song.length) {
          if (!p.songLoop) {
            this.ending = true;
            setTimeout(
              () => {
                this.stop();
                this.songPos = 0;
                this.onStopped?.();
              },
              Math.max(0, (t - this.engine.ctx.currentTime) * 1000),
            );
            return false;
          }
          next = 0;
        }
      }
      this.songPos = next;
      this.applyPattern(p.song[next], t);
    } else if (this.pendingPattern !== null) {
      this.applyPattern(this.pendingPattern, t);
      this.pendingPattern = null;
    } else {
      this.pos.fill(0); // 그룹 길이가 달라도 패턴 단위로 맞춰서 다시 시작
    }
    return true;
  }

  private scheduleStep(t: number) {
    if (this.count > 0 && this.cyc >= this.cycleLen()) {
      this.cyc = 0;
      if (!this.atBoundary(t)) return;
    }
    const p = this.getProject();
    const gate = this.stepDur * 0.9;
    const snap: StepSnapshot = { time: t, pos: [], pat: [] };
    p.groups.forEach((grp, g) => {
      const pat = grp.patterns[p.pattern];
      const len = pat.bars * STEPS_PER_BAR;
      if (this.pos[g] >= len) this.pos[g] %= len; // 재생 중 길이를 줄인 경우
      const pos = this.pos[g];
      snap.pos[g] = pos;
      snap.pat[g] = p.pattern;
      pat.steps.forEach((row, pad) => {
        const vel = row[pos];
        if (!vel) return;
        if (this.skip.delete(`${g}:${p.pattern}:${pad}:${pos}`)) return; // 방금 라이브로 친 노트 → 중복 방지
        this.engine.trigger(g, pad, t, vel);
        if (grp.sounds[pad].mode === 'key') this.engine.noteOff(g, pad, t + gate);
      });
      this.pos[g] = (pos + 1) % len;
    });
    this.cyc++;
    if (p.metronome && this.count % 4 === 0) this.engine.click(t, this.count % 16 === 0);
    this.history.push(snap);
    if (this.history.length > 64) this.history.shift();
  }

  /** 지금 "들리고 있는" 스텝 (UI 플레이헤드용) */
  snapshotAt(now: number): StepSnapshot | null {
    for (let i = this.history.length - 1; i >= 0; i--) if (this.history[i].time <= now) return this.history[i];
    return null;
  }

  /** 실시간 녹음: 지금 시각에 가장 가까운 16분음표 스텝 */
  quantize(now: number): QuantizeResult | null {
    let best: QuantizeResult | null = null;
    const consider = (s: StepSnapshot, scheduled: boolean) => {
      if (!best || Math.abs(s.time - now) < Math.abs(best.time - now)) best = { ...s, scheduled };
    };
    for (const h of this.history) consider(h, true);
    // 다음 스텝이 패턴 경계면 위치를 확실히 알 수 없으니 이미 예약된 스텝만 사용
    if (this.cyc < this.cycleLen()) {
      const p = this.getProject();
      consider({ time: this.nextTime + this.swingOffset(this.count), pos: [...this.pos], pat: p.groups.map(() => p.pattern) }, false);
    }
    return best;
  }

  /** 다음 16분음표 그리드 시각 (punch-in 루프를 박자에 맞춰 시작) */
  nextGridTime(now: number): number {
    for (const h of this.history) if (h.time >= now) return h.time;
    return this.nextTime + this.swingOffset(this.count);
  }

  skipOnce(g: number, pat: number, pad: number, pos: number) {
    this.skip.add(`${g}:${pat}:${pad}:${pos}`);
  }

  /** 패턴 선택. 정지 중이면 즉시, 재생 중이면 지금 패턴이 끝난 뒤 네 그룹이 함께 전환 */
  requestPattern(idx: number) {
    const p = this.getProject();
    if (!this.playing) {
      selectPatternAll(p, idx);
      this.pendingPattern = null;
      return;
    }
    this.pendingPattern = idx === p.pattern ? null : idx;
  }

  get queuedPattern() {
    return this.pendingPattern;
  }

  /** 송 위치 지정. 정지 중이면 시작 위치, 재생 중이면 지금 패턴이 끝난 뒤 점프 */
  requestSongPos(i: number) {
    if (!this.playing) this.songPos = i;
    else this.pendingSongPos = this.pendingSongPos === i ? null : i;
  }

  get queuedSongPos() {
    return this.pendingSongPos;
  }

  /** 송 모드를 재생 중에 켰을 때: 다음 경계에서 송 처음으로 */
  songModeChanged() {
    if (this.playing && this.getProject().songMode) this.pendingSongPos = 0;
    else this.pendingSongPos = null;
  }
}
