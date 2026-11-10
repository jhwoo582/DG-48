/**
 * 음정을 유지한 타임스트레치 — WSOLA (Waveform Similarity Overlap-Add)
 *
 * 원리:
 *  1. 출력은 일정 간격(Hs = 프레임/2)으로 Hann 창을 씌운 프레임을 겹쳐 더해서 만든다.
 *  2. 입력에서는 Ha = Hs / factor 간격으로 프레임을 가져온다 → 늘리면 촘촘히, 줄이면 듬성듬성.
 *  3. 그냥 가져오면 위상이 어긋나 "웅웅"거리므로, 이전 프레임의 자연스러운 이어짐과
 *     가장 비슷한(상관관계 최대) 위치를 ±10ms 안에서 찾아 그 위치의 프레임을 쓴다.
 *
 * 계산량이 꽤 되므로 Web Worker에서 돌리고, 결과는 (샘플, 구간, 배율) 키로 캐시한다.
 */

const workerSrc = `
function wsola(chs, sr, factor) {
  const inLen = chs[0].length;
  const N = Math.max(256, Math.round(sr * 0.035) & ~1);     // 프레임 35ms
  const Hs = N >> 1;                                          // 출력 홉
  const Ha = Hs / factor;                                     // 입력 홉
  const delta = Math.round(sr * 0.01);                        // 탐색 범위 ±10ms
  const outLen = Math.max(1, Math.round(inLen * factor));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  // 상관관계 계산용: 모노 합 + 4배 다운샘플 (거친 탐색) / 원본 해상도 (정밀 탐색)
  const mono = new Float32Array(inLen);
  for (const c of chs) for (let i = 0; i < inLen; i++) mono[i] += c[i];
  const D = 4;
  const dec = new Float32Array(Math.ceil(inLen / D));
  for (let i = 0; i < dec.length; i++) dec[i] = mono[i * D];
  const L = Hs;  // 비교 길이

  const out = chs.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  let prev = 0;
  for (let k = 0; ; k++) {
    const op = k * Hs;
    if (op >= outLen) break;
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      const target = prev + Hs; // 이전 프레임이 자연스럽게 이어졌을 위치
      // 1) 거친 탐색
      let bestScore = -Infinity, bestS = 0;
      const lo = Math.max(-delta, -nominal), hi = Math.min(delta, inLen - N - nominal);
      for (let s = lo; s <= hi; s += D) {
        const a = (nominal + s) / D | 0, b = target / D | 0;
        let sum = 0;
        for (let i = 0; i < L / D; i++) {
          const x = dec[a + i], y = dec[b + i];
          if (x === undefined || y === undefined) break;
          sum += x * y;
        }
        if (sum > bestScore) { bestScore = sum; bestS = s; }
      }
      // 2) 정밀 탐색 (±D)
      bestScore = -Infinity;
      let fine = bestS;
      for (let s = bestS - D; s <= bestS + D; s++) {
        const a = nominal + s;
        if (a < 0 || a + N > inLen) continue;
        let sum = 0;
        for (let i = 0; i < L; i++) sum += mono[a + i] * (mono[target + i] || 0);
        if (sum > bestScore) { bestScore = sum; fine = s; }
      }
      best = nominal + fine;
    }
    best = Math.max(0, Math.min(best, Math.max(0, inLen - 1)));
    for (let c = 0; c < chs.length; c++) {
      const src = chs[c], dst = out[c];
      for (let i = 0; i < N; i++) {
        const v = src[best + i];
        if (v === undefined) break;
        dst[op + i] += v * win[i];
      }
    }
    for (let i = 0; i < N; i++) norm[op + i] += win[i];
    prev = best;
  }
  return out.map((o) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? o[i] / norm[i] : o[i];
    // 끝 5ms 페이드 (클릭 방지)
    const f = Math.min(outLen, Math.round(sr * 0.005));
    for (let i = 0; i < f; i++) r[outLen - 1 - i] *= i / f;
    return r;
  });
}
onmessage = (e) => {
  const { id, chs, sr, factor } = e.data;
  const out = wsola(chs, sr, factor);
  postMessage({ id, chs: out }, out.map((c) => c.buffer));
};
`;

const MAX_CACHE = 48;

export class Stretcher {
  private worker: Worker;
  private cache = new Map<string, AudioBuffer>();
  private inflight = new Map<number, { key: string; sr: number }>();
  private requested = new Set<string>();
  private nextId = 1;
  /** 새 결과가 준비됐을 때 */
  onReady: ((key: string) => void) | null = null;

  constructor() {
    this.worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
    this.worker.onmessage = (e: MessageEvent<{ id: number; chs: Float32Array[] }>) => {
      const job = this.inflight.get(e.data.id);
      if (!job) return;
      this.inflight.delete(e.data.id);
      this.requested.delete(job.key);
      const chs = e.data.chs;
      const buf = new AudioBuffer({ length: chs[0].length, numberOfChannels: chs.length, sampleRate: job.sr });
      chs.forEach((c, i) => buf.getChannelData(i).set(c));
      this.cache.set(job.key, buf);
      // 간단한 LRU: 오래된 것부터 버림
      while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!);
      this.onReady?.(job.key);
    };
  }

  get(key: string): AudioBuffer | undefined {
    const b = this.cache.get(key);
    if (b) {
      this.cache.delete(key);
      this.cache.set(key, b); // 최근 사용으로 갱신
    }
    return b;
  }

  /** 구간 데이터를 factor배 길이로 늘려 달라고 요청 (이미 있거나 요청 중이면 무시) */
  request(key: string, chs: Float32Array[], sr: number, factor: number) {
    if (this.cache.has(key) || this.requested.has(key)) return;
    this.requested.add(key);
    const id = this.nextId++;
    this.inflight.set(id, { key, sr });
    this.worker.postMessage({ id, chs, sr, factor }, chs.map((c) => c.buffer));
  }
}
