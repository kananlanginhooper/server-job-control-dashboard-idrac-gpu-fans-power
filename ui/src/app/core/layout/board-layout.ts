import { Injectable, computed, signal } from '@angular/core';
import { lsKey } from '../module-context';

/**
 * Card arrangement for the page (owner 2026-11-06, 3 columns since 11-16), laid out by gridstack
 * (shared/board/board.ts): each card's column, row and width (1-3 columns), and a fixed height only for cards resized
 * by their corner (the rest fit their content). Cards rise to fill the space above them but keep their column. Kept in named views in this browser only (localStorage); a view's text export is for sharing it or for
 * pasting into DEFAULT_ITEMS below to change the default.
 */

/** one card: gridstack's saved position and size (x/y in columns/rows; h only when resized by hand) */
export interface Item {
  id: string;
  x?: number;
  y?: number;
  w: number;
  h?: number;
}
interface Views {
  active: string;
  views: Record<string, Item[]>;
}

/** the page is 3 columns wide; a card spans 1, 2 or 3 (owner 2026-11-16) */
export const COLUMNS = 3;
/** gridstack row height in px: fine enough that a resized card's height is close to what was dragged */
export const CELL = 8;
/** below this board width the cards stack in one column and don't move */
export const STACK_BELOW = 900;

/** the cards, in the page's default order and the order new cards join a saved view in */
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

/** the default: the top three side by side, the wide cards full width, then the smaller ones three or two to a row.
 *  y is a row order here (each row starts below the tallest card of the one before; cards then rise into free space). */
export const DEFAULT_ITEMS: Item[] = [
  ['attention', 0, 0, 1],
  ['pipeline', 1, 0, 1],
  ['controls', 2, 0, 1],
  ['gpus', 0, 1, 3],
  ['env', 0, 2, 3],
  ['servers', 0, 3, 3],
  ['live-hw', 0, 4, 3],
  ['drive-health', 0, 5, 1],
  ['drive-registry', 1, 5, 2],
  ['storage', 0, 6, 1],
  ['procs', 1, 6, 1],
  ['catalogue', 2, 6, 1],
  ['offsite', 0, 7, 1],
  ['carve', 1, 7, 2],
].map(([id, x, y, w]) => ({ id: id as string, x: x as number, y: y as number, w: w as number }));

const KEY = 'layout.views.v3'; // v3: 3 columns (v2 was 12, 'list' order)
const FIRST = 'Main';

/** A view from anything (stored or pasted): known cards only, each once, sizes clamped, missing cards appended. */
export function cleanItems(v: unknown): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const id = String(x?.id ?? '');
    if (!TILE_ORDER.includes(id) || seen.has(id)) continue;
    seen.add(id);
    const n = (k: string) => (Number.isFinite(+x[k]) ? Math.max(0, Math.round(+x[k])) : undefined);
    const it: Item = { id, w: Math.min(COLUMNS, Math.max(1, n('w') || 1)) };
    if (n('x') != null) it.x = Math.min(COLUMNS - it.w, n('x')!);
    if (n('y') != null) it.y = n('y');
    if (n('h')) it.h = n('h');
    out.push(it);
  }
  for (const d of DEFAULT_ITEMS) if (!seen.has(d.id)) out.push({ ...d });
  return out;
}

function load(): Views {
  try {
    const v = JSON.parse(localStorage.getItem(lsKey(KEY)) || 'null');
    if (v?.views && typeof v.views === 'object' && Object.keys(v.views).length) {
      const views = Object.fromEntries(Object.entries(v.views).map(([n, x]) => [n, cleanItems(x)]));
      return { active: v.active in views ? v.active : Object.keys(views)[0], views };
    }
  } catch {
    // storage blocked or a bad value: start from the default
  }
  return { active: FIRST, views: { [FIRST]: DEFAULT_ITEMS.map((d) => ({ ...d })) } };
}

@Injectable({ providedIn: 'root' })
export class BoardLayout {
  private readonly store = signal<Views>(load());
  readonly active = computed(() => this.store().active);
  readonly names = computed(() => Object.keys(this.store().views));
  /** the active view's cards; the board re-applies them when this changes (a view switch, reset or load) */
  readonly items = computed(() => this.store().views[this.active()]);
  /** bumped when the board must re-apply the view (switch, reset, load), not on its own drags */
  readonly applied = signal(0);
  /** the board's width is below STACK_BELOW: one column, nothing moves */
  readonly stacked = signal(false);

  /** the board's arrangement after a drag or resize */
  saveItems(items: Item[]) {
    this.setView(cleanItems(items));
  }

  select(name: string) {
    if (!(name in this.store().views) || name === this.active()) return;
    this.store.update((s) => ({ ...s, active: name }));
    this.persist(true);
  }
  /** a copy of the active view under a new name, which becomes the active one */
  saveAs(name: string): string {
    const n = this.freeName(name.trim() || 'View');
    this.store.update((s) => ({
      active: n,
      views: { ...s.views, [n]: this.items().map((i) => ({ ...i })) },
    }));
    this.persist(false);
    return n;
  }
  rename(name: string) {
    const to = name.trim();
    const from = this.active();
    if (!to || to === from || to in this.store().views) return;
    this.store.update((s) => ({
      active: to,
      views: Object.fromEntries(Object.entries(s.views).map(([n, v]) => [n === from ? to : n, v])),
    }));
    this.persist(false);
  }
  /** the active view back to the default arrangement */
  resetView() {
    this.setView(DEFAULT_ITEMS.map((d) => ({ ...d })));
    this.persist(true);
  }
  /** delete the active view (never the last one) */
  remove() {
    const s = this.store();
    const rest = Object.fromEntries(Object.entries(s.views).filter(([n]) => n !== s.active));
    if (!Object.keys(rest).length) return this.resetView();
    this.store.set({ active: Object.keys(rest)[0], views: rest });
    this.persist(true);
  }

  /** a view as text, for sharing or for pasting into DEFAULT_ITEMS */
  exportText(name = this.active()): string {
    return JSON.stringify({ layoutVersion: 3, name, items: cleanItems(this.store().views[name]) });
  }
  /** a pasted view added (or replacing one of the same name) and made active; returns its name, or an error */
  importText(text: string): { name?: string; error?: string } {
    let v: any;
    try {
      v = JSON.parse(text.trim());
    } catch {
      return { error: "That isn't a layout: paste the text a view's Copy gave you." };
    }
    if (v?.layoutVersion !== 3 || !Array.isArray(v.items))
      return { error: 'That text has no 3-column layout in it (layoutVersion 3).' };
    const name = String(v.name || 'Imported').trim() || 'Imported';
    this.store.update((s) => ({
      active: name,
      views: { ...s.views, [name]: cleanItems(v.items) },
    }));
    this.persist(true);
    return { name };
  }

  /** writes the views to this browser; `reapply` makes the board lay the view out again */
  persist(reapply: boolean) {
    try {
      localStorage.setItem(lsKey(KEY), JSON.stringify(this.store()));
    } catch {
      // private window or storage blocked: the layout still works until reload
    }
    if (reapply) this.applied.update((n) => n + 1);
  }

  private freeName(base: string) {
    let n = base,
      i = 2;
    while (n in this.store().views) n = `${base} ${i++}`;
    return n;
  }
  private setView(items: Item[]) {
    this.store.update((s) => ({ ...s, views: { ...s.views, [s.active]: items } }));
  }
}
