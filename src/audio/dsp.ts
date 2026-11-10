/** 샘플 데이터 가공 유틸 (Float32 PCM 채널 배열 기준) */

export function makeBuffer(chs: Float32Array[], sampleRate: number): AudioBuffer {
  const length = Math.max(1, chs[0]?.length ?? 1);
  const buf = new AudioBuffer({ length, numberOfChannels: Math.max(1, chs.length), sampleRate });
  chs.forEach((c, i) => buf.getChannelData(i).set(c));
  return buf;
}

export function bufferChannels(buf: AudioBuffer): Float32Array[] {
  return Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
}

export function reverseBuffer(buf: AudioBuffer): AudioBuffer {
  const chs = bufferChannels(buf);
  chs.forEach((c) => c.reverse());
  return makeBuffer(chs, buf.sampleRate);
}

/** 앞뒤 무음 제거. 앞은 5ms, 뒤는 20ms 여유를 남긴다. */
export function trimSilence(chs: Float32Array[], sampleRate: number, threshold = 0.003): Float32Array[] {
  const n = chs[0].length;
  const loud = (i: number) => chs.some((c) => Math.abs(c[i]) > threshold);
  let a = 0;
  while (a < n && !loud(a)) a++;
  if (a >= n) return chs; // 전부 무음이면 그대로
  let b = n - 1;
  while (b > a && !loud(b)) b--;
  a = Math.max(0, a - Math.floor(sampleRate * 0.005));
  b = Math.min(n, b + Math.floor(sampleRate * 0.02));
  return chs.map((c) => c.slice(a, b));
}

export function normalize(chs: Float32Array[], target = 0.95): void {
  let peak = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  if (peak < 1e-6) return;
  const g = target / peak;
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g;
}

/** 좌우가 사실상 같으면 모노로 합쳐서 메모리를 절반으로 */
export function collapseMono(chs: Float32Array[]): Float32Array[] {
  if (chs.length < 2) return chs;
  const [l, r] = chs;
  for (let i = 0; i < l.length; i += 7) if (Math.abs(l[i] - r[i]) > 1e-4) return chs;
  return [l];
}

/** 16-bit PCM WAV 인코딩 (trim 구간, reverse 반영) */
export function encodeWav(buf: AudioBuffer, start = 0, end = 1, reverse = false): Blob {
  const sr = buf.sampleRate;
  const nch = buf.numberOfChannels;
  const a = Math.floor(Math.min(start, end) * buf.length);
  const b = Math.floor(Math.max(start, end) * buf.length);
  const n = Math.max(0, b - a);
  const bytes = n * nch * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o: number, s: string) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, nch, true);
  view.setUint32(24, sr, true);
  view.setUint32(28, sr * nch * 2, true);
  view.setUint16(32, nch * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, bytes, true);
  const chs = Array.from({ length: nch }, (_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) {
    const idx = reverse ? b - 1 - i : a + i;
    for (const c of chs) {
      const s = Math.max(-1, Math.min(1, c[idx]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

/** 파형 표시용: 픽셀 열마다 [min, max] */
export function computePeaks(buf: AudioBuffer, width: number): Float32Array {
  const out = new Float32Array(width * 2);
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const len = buf.length;
  for (let x = 0; x < width; x++) {
    const i0 = Math.floor((x / width) * len);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / width) * len));
    let mn = 0;
    let mx = 0;
    for (const c of chs) {
      for (let i = i0; i < i1 && i < len; i++) {
        const v = c[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    out[x * 2] = mn;
    out[x * 2 + 1] = mx;
  }
  return out;
}

/**
 * 타격점(트랜지언트) 찾기 — 오토 촙용.
 * 5ms 단위 에너지를 구하고, 직전 구간보다 확 커지는 지점을 후보로 잡아
 * 가장 강한 것부터 n개 고른다. 반환: 버퍼 길이 대비 비율(0..1), 정렬됨, 첫 값은 구간 시작.
 */
export function detectOnsets(buf: AudioBuffer, start: number, end: number, n: number): number[] {
  const sr = buf.sampleRate;
  const len = buf.length;
  const a = Math.floor(Math.min(start, end) * len);
  const b = Math.floor(Math.max(start, end) * len);
  const hop = Math.max(64, Math.round(sr * 0.005));
  const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const env: number[] = [];
  for (let i = a; i < b; i += hop) {
    let sum = 0;
    for (const c of chs) for (let j = i; j < Math.min(b, i + hop); j++) sum += c[j] * c[j];
    env.push(Math.sqrt(sum / (hop * chs.length)));
  }
  const peak = Math.max(...env, 1e-9);
  const minGap = Math.round(0.07 / 0.005); // 70ms
  const cands: { i: number; score: number }[] = [];
  for (let i = 1; i < env.length; i++) {
    let prev = 0;
    for (let k = Math.max(0, i - 6); k < i; k++) prev += env[k];
    prev /= Math.min(6, i);
    const rise = env[i] - prev;
    if (env[i] > peak * 0.08 && env[i] > prev * 1.6 && rise > 0) cands.push({ i, score: rise });
  }
  cands.sort((x, y) => y.score - x.score);
  const picked: number[] = [0];
  for (const c of cands) {
    if (picked.length >= n) break;
    if (picked.every((p) => Math.abs(p - c.i) >= minGap)) picked.push(c.i);
  }
  picked.sort((x, y) => x - y);
  // 타격 직전 3ms부터 시작하도록 살짝 당김
  const pre = Math.round(sr * 0.003);
  return picked.map((fi, k) => (k === 0 ? a : Math.max(a, a + fi * hop - pre)) / len);
}
