/**
 * 샘플 라이브러리 서랍
 *  - Drum machines: ritchse/tidal-drum-machines (클래식 드럼머신 683종, 라이선스 미표기)
 *  - Instruments:   sgossner/VCSL (CC0, 실제 악기·타악기)
 *    위 둘은 Strudel이 쓰는 felixroos/dough-samples의 샘플 맵(JSON)으로 목록을 받는다.
 *    raw.githubusercontent.com은 CORS를 허용하므로 브라우저에서 바로 fetch 가능.
 *  - Freesound:     freesound.org API v2 (무료 API 키 필요). 결과의 미리듣기 MP3를 가져온다.
 *
 * 미리듣기 → Add(또는 패드로 드래그) → 패드에 저장.
 */

export interface LibItem {
  name: string;
  detail: string;
  url: string;
  license?: string;
}

type Tab = 'drums' | 'instruments' | 'freesound';

export const LIB_DRAG_TYPE = 'application/x-dg48-sample';

const PACKS: Record<Exclude<Tab, 'freesound'>, { file: string; license: string }> = {
  drums: { file: 'tidal-drum-machines', license: 'license not stated' },
  instruments: { file: 'vcsl', license: 'CC0' },
};

const DRUM_TYPES: Record<string, string> = {
  bd: 'Kick',
  sd: 'Snare',
  hh: 'Hat',
  oh: 'Open hat',
  cp: 'Clap',
  cr: 'Crash',
  rd: 'Ride',
  rim: 'Rim',
  lt: 'Low tom',
  mt: 'Mid tom',
  ht: 'High tom',
  cb: 'Cowbell',
  sh: 'Shaker',
  tb: 'Tambourine',
  perc: 'Perc',
  fx: 'FX',
  misc: 'Misc',
};

const MAX_ROWS = 150;

function spaced(machine: string) {
  return machine.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2');
}

function basename(path: string) {
  const f = decodeURIComponent(path.split('/').pop() ?? path);
  return f.replace(/\.(wav|mp3|ogg|flac|aif+)$/i, '');
}

function shortLicense(url: string) {
  if (/publicdomain\/zero/.test(url)) return 'CC0';
  if (/by-nc/.test(url)) return 'CC BY-NC';
  if (/by\//.test(url)) return 'CC BY';
  if (/sampling\+/.test(url)) return 'Sampling+';
  return 'CC';
}

async function loadPack(tab: Exclude<Tab, 'freesound'>): Promise<LibItem[]> {
  const { file, license } = PACKS[tab];
  const res = await fetch(`https://raw.githubusercontent.com/felixroos/dough-samples/main/${file}.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const map = (await res.json()) as Record<string, unknown>;
  const base = String(map._base ?? '');
  const items: LibItem[] = [];
  for (const [key, val] of Object.entries(map)) {
    if (key.startsWith('_')) continue;
    // 값은 파일 배열이거나 { 음이름: [파일...] } 형태
    const files = (Array.isArray(val) ? val : Object.values(val as object).flat()) as string[];
    let label = key;
    if (tab === 'drums') {
      const [machine, type] = key.split('_');
      label = `${spaced(machine)} ${DRUM_TYPES[type] ?? type}`;
    } else {
      label = key.replace(/_/g, ' ');
    }
    files.forEach((f, i) =>
      items.push({
        name: files.length > 1 ? `${label} ${i + 1}` : label,
        detail: basename(f),
        url: base + f,
        license,
      }),
    );
  }
  return items;
}

export interface LibraryOpts {
  ctx: AudioContext;
  out: AudioNode;
  /** 지금 Add를 누르면 들어갈 패드 이름 */
  target: () => string;
  onAdd: (buf: AudioBuffer, item: LibItem) => Promise<void>;
  toast: (msg: string) => void;
}

export class Library {
  private tab: Tab = 'drums';
  private packs = new Map<Tab, Promise<LibItem[]>>();
  private results: LibItem[] = [];
  private cache = new Map<string, Promise<AudioBuffer>>();
  private preview: AudioBufferSourceNode | null = null;
  private playingUrl: string | null = null;
  private searchTimer = 0;
  private fsKey = '';
  private el: {
    tabs: HTMLElement;
    q: HTMLInputElement;
    list: HTMLElement;
    status: HTMLElement;
    target: HTMLElement;
    keyRow: HTMLElement;
    keyInput: HTMLInputElement;
  };

  constructor(
    private root: HTMLElement,
    private o: LibraryOpts,
  ) {
    try {
      this.fsKey = localStorage.getItem('freesound-key') ?? '';
    } catch {
      /* noop */
    }
    root.innerHTML = `
      <div class="lib-head">
        <h2>Library</h2>
        <button class="btn" data-close>Close</button>
      </div>
      <div class="seg wide lib-tabs">
        <button data-tab="drums">Drum machines</button>
        <button data-tab="instruments">Instruments</button>
        <button data-tab="freesound">Freesound</button>
      </div>
      <div class="lib-key" hidden>
        <p>Freesound needs a free API key. <a href="https://freesound.org/apiv2/apply" target="_blank" rel="noopener">Get one here</a>, then paste it below.</p>
        <div class="row tight">
          <input class="text" type="password" placeholder="Freesound API key" autocomplete="off" spellcheck="false" />
          <button class="btn" data-savekey>Save</button>
        </div>
      </div>
      <input class="text lib-q" placeholder="Search, e.g. 808 kick" spellcheck="false" />
      <div class="lib-meta"><span class="lib-status dim"></span><span class="lib-target dim"></span></div>
      <div class="lib-list" role="list"></div>`;
    const $ = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    this.el = {
      tabs: $('.lib-tabs'),
      q: $('.lib-q'),
      list: $('.lib-list'),
      status: $('.lib-status'),
      target: $('.lib-target'),
      keyRow: $('.lib-key'),
      keyInput: $('.lib-key input'),
    };
    $('[data-close]').addEventListener('click', () => this.close());
    this.el.tabs.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => this.setTab(b.dataset.tab as Tab)),
    );
    this.el.q.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => void this.search(), this.tab === 'freesound' ? 500 : 120);
    });
    this.el.q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(this.searchTimer);
        void this.search();
      }
      if (e.key === 'Escape') this.close();
    });
    this.el.keyInput.value = this.fsKey;
    $('[data-savekey]').addEventListener('click', () => {
      this.fsKey = this.el.keyInput.value.trim();
      try {
        localStorage.setItem('freesound-key', this.fsKey);
      } catch {
        /* noop */
      }
      this.renderKeyRow();
      void this.search();
    });
  }

  get isOpen() {
    return this.root.classList.contains('open');
  }

  open() {
    this.root.classList.add('open');
    this.renderTarget();
    if (!this.results.length) this.setTab(this.tab);
    this.el.q.focus();
  }

  close() {
    this.root.classList.remove('open');
    this.stopPreview();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  renderTarget() {
    this.el.target.textContent = `Adds to pad ${this.o.target()}`;
  }

  private setTab(tab: Tab) {
    this.tab = tab;
    this.el.tabs.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    this.el.q.placeholder =
      tab === 'drums' ? 'Search, e.g. 808 kick' : tab === 'instruments' ? 'Search, e.g. conga, marimba, bell' : 'Search Freesound, e.g. vinyl crackle';
    this.renderKeyRow();
    void this.search();
  }

  private renderKeyRow() {
    this.el.keyRow.hidden = !(this.tab === 'freesound' && !this.fsKey);
  }

  private async search() {
    const q = this.el.q.value.trim().toLowerCase();
    if (this.tab === 'freesound') return this.searchFreesound(q);
    let all: LibItem[];
    try {
      if (!this.packs.has(this.tab)) this.packs.set(this.tab, loadPack(this.tab));
      this.el.status.textContent = 'Loading…';
      all = await this.packs.get(this.tab)!;
    } catch {
      this.packs.delete(this.tab);
      this.el.status.textContent = 'Couldn’t load the list. Check your connection.';
      return;
    }
    const words = q.split(/\s+/).filter(Boolean);
    const hits = words.length
      ? all.filter((it) => {
          const hay = `${it.name} ${it.detail}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        })
      : all;
    this.results = hits;
    this.el.status.textContent =
      hits.length > MAX_ROWS ? `${MAX_ROWS} of ${hits.length} shown. Narrow the search.` : `${hits.length} sounds`;
    this.renderList();
  }

  private async searchFreesound(q: string) {
    if (!this.fsKey) {
      this.results = [];
      this.el.status.textContent = '';
      this.renderList();
      return;
    }
    if (!q) {
      this.results = [];
      this.el.status.textContent = 'Type something to search.';
      this.renderList();
      return;
    }
    this.el.status.textContent = 'Searching…';
    const url = new URL('https://freesound.org/apiv2/search/text/');
    url.searchParams.set('query', q);
    url.searchParams.set('fields', 'id,name,duration,license,previews,username');
    url.searchParams.set('filter', 'duration:[0 TO 30]');
    url.searchParams.set('page_size', '40');
    try {
      const res = await fetch(url, { headers: { Authorization: `Token ${this.fsKey}` } });
      if (res.status === 401) {
        this.el.status.textContent = 'Freesound rejected the API key.';
        this.fsKey = '';
        this.renderKeyRow();
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as {
        count: number;
        results: { name: string; duration: number; license: string; username: string; previews: Record<string, string> }[];
      };
      this.results = data.results.map((r) => ({
        name: r.name.replace(/\.(wav|mp3|aiff?|flac|ogg)$/i, ''),
        detail: `${r.duration.toFixed(1)} s by ${r.username}`,
        url: r.previews['preview-hq-mp3'],
        license: shortLicense(r.license),
      }));
      this.el.status.textContent = `${data.count} results`;
      this.renderList();
    } catch {
      this.el.status.textContent = 'Search failed. Check your connection.';
    }
  }

  private renderList() {
    const list = this.el.list;
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const it of this.results.slice(0, MAX_ROWS)) {
      const row = document.createElement('div');
      row.className = 'lib-row';
      row.setAttribute('role', 'listitem');
      row.draggable = true;
      row.innerHTML = `
        <button class="lib-play" aria-label="Preview">▶</button>
        <div class="lib-text"><div class="lib-name"></div><div class="lib-detail"></div></div>
        <button class="btn lib-add">Add</button>`;
      row.querySelector('.lib-name')!.textContent = it.name;
      row.querySelector('.lib-detail')!.textContent = it.license ? `${it.detail}, ${it.license}` : it.detail;
      const play = row.querySelector<HTMLButtonElement>('.lib-play')!;
      if (it.url === this.playingUrl) play.classList.add('on');
      play.addEventListener('click', () => void this.togglePreview(it, play));
      row.querySelector('.lib-text')!.addEventListener('click', () => void this.togglePreview(it, play));
      const add = row.querySelector<HTMLButtonElement>('.lib-add')!;
      add.addEventListener('click', () => void this.add(it, add));
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(LIB_DRAG_TYPE, JSON.stringify(it));
        e.dataTransfer!.effectAllowed = 'copy';
      });
      frag.append(row);
    }
    list.append(frag);
    list.scrollTop = 0;
  }

  load(url: string): Promise<AudioBuffer> {
    let p = this.cache.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((ab) => this.o.ctx.decodeAudioData(ab));
      p.catch(() => this.cache.delete(url));
      this.cache.set(url, p);
      if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value!);
    }
    return p;
  }

  private stopPreview() {
    try {
      this.preview?.stop();
    } catch {
      /* noop */
    }
    this.preview = null;
    this.playingUrl = null;
    this.root.querySelectorAll('.lib-play.on').forEach((b) => b.classList.remove('on'));
  }

  private async togglePreview(it: LibItem, btn: HTMLButtonElement) {
    if (this.playingUrl === it.url) return this.stopPreview();
    this.stopPreview();
    this.playingUrl = it.url;
    btn.classList.add('on');
    try {
      if (this.o.ctx.state !== 'running') await this.o.ctx.resume();
      const buf = await this.load(it.url);
      if (this.playingUrl !== it.url) return;
      const src = this.o.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.o.out);
      src.onended = () => {
        if (this.preview === src) this.stopPreview();
      };
      src.start();
      this.preview = src;
    } catch {
      this.stopPreview();
      this.o.toast(`Couldn’t load ${it.name}`);
    }
  }

  private async add(it: LibItem, btn: HTMLButtonElement) {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const buf = await this.load(it.url);
      await this.o.onAdd(buf, it);
      this.renderTarget();
    } catch {
      this.o.toast(`Couldn’t load ${it.name}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Add';
    }
  }
}
