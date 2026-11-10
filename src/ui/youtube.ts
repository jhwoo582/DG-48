/**
 * 앱 안에 넣는 유튜브 플레이어 (YouTube IFrame Player API).
 * youtube.com / music.youtube.com / youtu.be / shorts 링크, 또는 11자리 영상 ID를 받는다.
 * 소리는 "이 탭 캡처"로 샘플러에 들어온다 (recorder의 youtube 소스).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;
function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => {
        apiPromise = null;
        reject(new Error('YT_API'));
      };
      document.head.append(s);
    });
  }
  return apiPromise;
}

export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1, 12) || null;
    const v = u.searchParams.get('v');
    if (v) return v.slice(0, 11);
    const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export const YT_ERRORS: Record<number, string> = {
  2: 'That link has an invalid video ID.',
  5: 'This video can’t play in an embedded player.',
  100: 'Video not found. It may be private or removed.',
  101: 'The owner blocked embedding. Switch the source to “Another tab” and share the YouTube tab instead.',
  150: 'The owner blocked embedding. Switch the source to “Another tab” and share the YouTube tab instead.',
};

export class YouTubePlayer {
  private player: any = null;
  private ready = false;
  onError: ((code: number) => void) | null = null;
  onState: (() => void) | null = null;

  constructor(private mount: HTMLElement) {}

  async load(id: string) {
    await loadApi();
    if (this.player && this.ready) {
      this.player.loadVideoById(id);
      return;
    }
    const div = document.createElement('div');
    this.mount.innerHTML = '';
    this.mount.append(div);
    await new Promise<void>((resolve) => {
      this.player = new window.YT.Player(div, {
        // 로그인 쿠키를 쓰지 않는 도메인 → Premium "동시 스트리밍 기기 수" 제한에 걸리지 않음
        host: 'https://www.youtube-nocookie.com',
        videoId: id,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, autoplay: 0 },
        events: {
          onReady: () => {
            this.ready = true;
            resolve();
          },
          onError: (e: { data: number }) => this.onError?.(e.data),
          onStateChange: () => this.onState?.(),
        },
      });
    });
  }

  get loaded() {
    return this.ready;
  }
  get playing() {
    return this.ready && this.player.getPlayerState?.() === 1;
  }
  get time(): number {
    return this.ready ? (this.player.getCurrentTime?.() ?? 0) : 0;
  }
  get duration(): number {
    return this.ready ? (this.player.getDuration?.() ?? 0) : 0;
  }
  get title(): string {
    return this.ready ? (this.player.getVideoData?.()?.title ?? '') : '';
  }

  get videoId(): string | null {
    return this.ready ? (this.player.getVideoData?.()?.video_id ?? null) : null;
  }

  /** 큐 패드용: 해당 시점으로 점프해서 소리 켜고 재생 */
  playFrom(t: number) {
    if (!this.ready) return;
    this.player.seekTo(Math.max(0, t), true);
    this.player.unMute();
    this.player.playVideo();
  }
  mute() {
    if (this.ready) this.player.mute();
  }
  unMute() {
    if (this.ready) this.player.unMute();
  }
  play() {
    if (this.ready) this.player.playVideo();
  }

  toggle() {
    if (!this.ready) return;
    if (this.playing) this.player.pauseVideo();
    else this.player.playVideo();
  }
  seek(delta: number) {
    if (!this.ready) return;
    this.player.seekTo(Math.max(0, this.time + delta), true);
  }
  seekTo(t: number) {
    if (this.ready) this.player.seekTo(Math.max(0, t), true);
  }
}
