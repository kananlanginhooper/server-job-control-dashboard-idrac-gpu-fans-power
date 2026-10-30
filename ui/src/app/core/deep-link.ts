/**
 * Shareable deep links (DASHBOARD-REQUIREMENTS 3.7). The page has no tabs, so its one view setting is the graph
 * range, kept in the address as ?range=1h (the RANGES button labels). The store reads it on load, and every change
 * rewrites it here and tells the wrapper, which shows /<tab id>/?range=1h in its own address bar.
 * There's no Angular router, so this is the helper's "anything else" form (wrapper ui/src/for-apps/README.md).
 */
import { RANGES } from '../shared/format';

let frameParents: readonly string[] = [];

/** From GET /api/config, before the app starts. */
export function setFrameParents(p: readonly string[] | undefined) {
  frameParents = p ?? [];
}

/** The ?range= in the address, in seconds (0 when absent or unknown). */
export function rangeFromUrl(): number {
  const label = new URLSearchParams(location.search).get('range');
  return RANGES.find((r) => r[1] === label)?.[0] ?? 0;
}

/** Put the range in the address (no reload) and report the page to the wrapper when framed. */
export function showRange(seconds: number) {
  const q = new URLSearchParams(location.search);
  const label = RANGES.find((r) => r[0] === seconds)?.[1];
  if (label) q.set('range', label);
  const search = q.toString() ? `?${q}` : '';
  history.replaceState(history.state, '', location.pathname + search + location.hash);

  if (window.parent === window) return;
  // the page that framed us: ancestorOrigins where the browser has it (Chrome, Safari), else the referrer (Firefox)
  const parent =
    location.ancestorOrigins?.[0] ?? (document.referrer && new URL(document.referrer).origin);
  if (!parent || !frameParents.includes(parent)) return;
  // the path relative to <base href>, starting with exactly one /
  const base = new URL(document.baseURI).pathname;
  const rel = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : '';
  window.parent.postMessage({ type: 'route', path: '/' + rel + search + location.hash }, parent);
}
