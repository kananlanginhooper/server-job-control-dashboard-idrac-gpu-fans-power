import { Injectable, computed, signal } from '@angular/core';
import { lsKey } from '../module-context';

/**
 * Card arrangement for the page (owner 2026-11-06): which order the cards go in and how big each one is, in named
 * views. Each screen size ("band") keeps its own arrangement inside a view, so a layout made on a very wide monitor
 * doesn't squash a normal one. Views live in this browser only (localStorage); a view's text export is for sharing it
 * or for pasting into DEFAULT_LAYOUTS below to change the default.
 * Adapted from personal-task-manager-angular's board (core/layout/board-layout.ts).
 */

/** stack = phone/narrow, one column, no moving or resizing */
export type Band = 'stack' | 'standard' | 'wide' | 'ultra';
export type GridBand = Exclude<Band, 'stack'>;

/** w = columns spanned; h = body height in px, or null to fit the content */
export interface TileSize {
  w: number;
  h: number | null;
}
export interface BandLayout {
  order: string[];
  size: Record<string, TileSize>;
}
export type SavedLayouts = Partial<Record<GridBand, BandLayout>>;
/** one named view: an arrangement per screen size, plus the cards switched off */
export interface View {
  bands: SavedLayouts;
  hidden: string[];
}
interface Views {
  active: string;
  views: Record<string, View>;
}

export const BANDS: Record<GridBand, { cols: number; minWidth: number; label: string }> = {
  standard: { cols: 12, minWidth: 900, label: 'Standard screen' },
  wide: { cols: 24, minWidth: 2200, label: 'Wide screen' },
  ultra: { cols: 24, minWidth: 3400, label: 'Very wide screen' },
};
/** grid row unit and the gap between cards, in px */
export const ROW = 4;
export const GAP = 16;
export const MIN_HEIGHT = 80;

/** The page's order on a phone, and the order new cards join a saved layout in. */
export const TILE_ORDER = [
  'attention',
  'pipeline',
  'controls',
  'gpus',
  'env',
  'servers',
  'live-hw',
  'drive-health',
  'drive-registry',
  'storage',
  'procs',
  'catalogue',
  'offsite',
  'carve',
];

/** what each card is called in the move label */
export const TILE_LABELS: Record<string, string> = {
  attention: 'Needs attention / Now',
  pipeline: 'Pipeline status',
  controls: 'Fan & quiet controls',
  gpus: 'GPUs now',
  env: 'Power, temperature & fans',
  servers: 'Servers',
  'live-hw': 'Live hardware',
  'drive-health': 'Drive health',
  'drive-registry': 'Drive registry',
  storage: 'Storage',
  procs: 'Processes',
  catalogue: 'Catalogue',
  offsite: 'Offsite',
  carve: 'Carving',
};

function band(order: string[], w: Record<string, number>): BandLayout {
  return { order, size: Object.fromEntries(order.map((k) => [k, { w: w[k], h: null }])) };
}

/** the page as it was before cards could move: the top three side by side, then full-width cards and pairs */
const STANDARD = {
  attention: 4,
  pipeline: 4,
  controls: 4,
  gpus: 12,
  env: 12,
  servers: 12,
  'live-hw': 12,
  'drive-health': 6,
  'drive-registry': 6,
  storage: 12,
  procs: 6,
  catalogue: 6,
  offsite: 4,
  carve: 8,
};
const double = (w: Record<string, number>) =>
  Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v * 2]));

export const DEFAULT_LAYOUTS: Record<GridBand, BandLayout> = {
  standard: band(TILE_ORDER, STANDARD),
  wide: band(TILE_ORDER, double(STANDARD)),
  ultra: band(TILE_ORDER, double(STANDARD)),
};

const KEY = 'layout.views.v1';
const FIRST = 'Main';

export function bandFor(width: number): Band {
  if (width >= BANDS.ultra.minWidth) return 'ultra';
  if (width >= BANDS.wide.minWidth) return 'wide';
  if (width >= BANDS.standard.minWidth) return 'standard';
  return 'stack';
}

/** A saved layout made whole: unknown cards dropped, new cards added from the defaults, sizes clamped. */
export function normalize(saved: BandLayout | undefined, b: GridBand): BandLayout {
  const def = DEFAULT_LAYOUTS[b];
  const cols = BANDS[b].cols;
  const known = new Set(TILE_ORDER);
  const order = (saved?.order ?? []).filter((k, i, a) => known.has(k) && a.indexOf(k) === i);
  // a card added since the layout was saved goes right after the card it follows by default
  def.order.forEach((k, i) => {
    if (!order.includes(k)) order.splice(i ? order.indexOf(def.order[i - 1]) + 1 : 0, 0, k);
  });
  const size: Record<string, TileSize> = {};
  for (const k of order) {
    const s = saved?.size?.[k] ?? def.size[k];
    const w = Math.round(Number(s?.w)) || def.size[k].w;
    const h = s?.h == null ? null : Math.max(MIN_HEIGHT, Math.round(Number(s.h)) || MIN_HEIGHT);
    size[k] = { w: Math.min(cols, Math.max(1, w)), h };
  }
  return { order, size };
}

/** A view from anything (stored or pasted): only known bands and cards survive. */
function cleanView(v: any): View {
  const bands: SavedLayouts = {};
  for (const b of Object.keys(BANDS) as GridBand[])
    if (v?.bands?.[b]?.order) bands[b] = normalize(v.bands[b], b);
  const hidden = Array.isArray(v?.hidden)
    ? v.hidden.filter((k: unknown) => TILE_ORDER.includes(String(k)))
    : [];
  return { bands, hidden };
}

function load(): Views {
  try {
    const v = JSON.parse(localStorage.getItem(lsKey(KEY)) || 'null');
    if (v?.views && typeof v.views === 'object' && Object.keys(v.views).length) {
      const views = Object.fromEntries(Object.entries(v.views).map(([n, x]) => [n, cleanView(x)]));
      return { active: v.active in views ? v.active : Object.keys(views)[0], views };
    }
  } catch {
    // storage blocked or a bad value: start from the default
  }
  return { active: FIRST, views: { [FIRST]: { bands: {}, hidden: [] } } };
}

@Injectable({ providedIn: 'root' })
export class BoardLayout {
  /** set by the board from its own width */
  readonly band = signal<Band>('standard');
  readonly cols = computed(() =>
    this.band() === 'stack' ? 1 : BANDS[this.band() as GridBand].cols,
  );
  /** the card being moved, for the label that follows the pointer */
  readonly moving = signal<{ key: string; label: string; x: number; y: number } | null>(null);
  readonly resizing = signal<string | null>(null);

  private readonly store = signal<Views>(load());
  readonly active = computed(() => this.store().active);
  readonly names = computed(() => Object.keys(this.store().views));
  private readonly view = computed(() => this.store().views[this.active()]);
  readonly hidden = computed(() => this.view().hidden);

  /** the arrangement in use for the current band */
  readonly current = computed<BandLayout>(() => {
    const b = this.band();
    if (b === 'stack') return band(TILE_ORDER, Object.fromEntries(TILE_ORDER.map((k) => [k, 1])));
    return normalize(this.view().bands[b], b);
  });
  /** the active view differs from the default */
  readonly isCustom = computed(
    () => Object.keys(this.view().bands).length > 0 || this.hidden().length > 0,
  );

  orderOf(key: string) {
    return this.current().order.indexOf(key);
  }
  sizeOf(key: string): TileSize {
    return this.current().size[key] ?? { w: this.cols(), h: null };
  }
  isHidden(key: string) {
    return this.hidden().includes(key);
  }
  toggleHidden(key: string) {
    const h = this.hidden();
    this.setView({
      ...this.view(),
      hidden: h.includes(key) ? h.filter((k) => k !== key) : [...h, key],
    });
    this.persist();
  }

  /** move `key` to where `target` is (after it when moving forward, before it when moving back) */
  move(key: string, target: string) {
    const order = [...this.current().order];
    const from = order.indexOf(key);
    const to = order.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, key);
    this.update({ ...this.current(), order }, false);
  }

  resize(key: string, s: TileSize, persist: boolean) {
    const cur = this.current();
    this.update({ ...cur, size: { ...cur.size, [key]: s } }, persist);
  }

  /** a card back to its default width, fitting its content */
  resetTile(key: string) {
    const b = this.band();
    if (b === 'stack') return;
    this.resize(key, { ...DEFAULT_LAYOUTS[b].size[key], h: null }, true);
  }

  // --- views ----------------------------------------------------------------------------------------------------------
  select(name: string) {
    if (!(name in this.store().views)) return;
    this.store.update((s) => ({ ...s, active: name }));
    this.persist();
  }
  /** a copy of the active view under a new name, which becomes the active one */
  saveAs(name: string): string {
    const n = this.freeName(name.trim() || 'View');
    this.store.update((s) => ({ active: n, views: { ...s.views, [n]: cleanView(this.view()) } }));
    this.persist();
    return n;
  }
  rename(name: string) {
    const to = name.trim();
    const from = this.active();
    if (!to || to === from || to in this.store().views) return;
    this.store.update((s) => {
      const views = Object.fromEntries(
        Object.entries(s.views).map(([n, v]) => [n === from ? to : n, v]),
      );
      return { active: to, views };
    });
    this.persist();
  }
  /** the active view back to the default arrangement */
  resetView() {
    this.setView({ bands: {}, hidden: [] });
    this.persist();
  }
  /** delete the active view (never the last one) */
  remove() {
    const s = this.store();
    const rest = Object.fromEntries(Object.entries(s.views).filter(([n]) => n !== s.active));
    if (!Object.keys(rest).length) return this.resetView();
    this.store.set({ active: Object.keys(rest)[0], views: rest });
    this.persist();
  }

  /** a view as text, for sharing or for pasting into DEFAULT_LAYOUTS (every band it customizes, normalized) */
  exportText(name = this.active()): string {
    const v = cleanView(this.store().views[name]);
    return JSON.stringify({ layoutVersion: 1, name, ...v });
  }
  /** a pasted view added (or replacing one of the same name) and made active; returns its name, or an error */
  importText(text: string): { name?: string; error?: string } {
    let v: any;
    try {
      v = JSON.parse(text.trim());
    } catch {
      return { error: "That isn't a layout: paste the text a view's Copy gave you." };
    }
    if (v?.layoutVersion !== 1 || typeof v.bands !== 'object')
      return { error: 'That text has no layout in it (layoutVersion 1).' };
    const name = String(v.name || 'Imported').trim() || 'Imported';
    this.store.update((s) => ({ active: name, views: { ...s.views, [name]: cleanView(v) } }));
    this.persist();
    return { name };
  }

  /** writes the views to this browser (after a drag ends) */
  persist() {
    try {
      localStorage.setItem(lsKey(KEY), JSON.stringify(this.store()));
    } catch {
      // private window or storage blocked: the layout still works until reload
    }
  }

  private freeName(base: string) {
    let n = base,
      i = 2;
    while (n in this.store().views) n = `${base} ${i++}`;
    return n;
  }
  private setView(v: View) {
    this.store.update((s) => ({ ...s, views: { ...s.views, [s.active]: v } }));
  }
  private update(l: BandLayout, persist: boolean) {
    const b = this.band();
    if (b === 'stack') return;
    this.setView({ ...this.view(), bands: { ...this.view().bands, [b]: l } });
    if (persist) this.persist();
  }
}
