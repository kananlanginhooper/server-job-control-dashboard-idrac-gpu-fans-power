/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared pieces of the ECharts wrappers: theme colors from the page's CSS variables, the time axis, line data with
// gaps, and the tooltip markup (same classes as before, so the page CSS styles it).
import { DestroyRef, ElementRef, afterNextRender, inject, signal } from '@angular/core';
import { fmtT } from '../format';
import { Dash, Point, Series } from './chart-types';

/** Host width (for the end-label margin) and a theme tick that changes when light/dark flips. */
export function chartHost() {
  const el = inject(ElementRef<HTMLElement>).nativeElement as HTMLElement;
  const width = signal(600), theme = signal(0);
  let ro: ResizeObserver | undefined;
  const mq = window.matchMedia('(prefers-color-scheme: dark)'), flip = () => theme.update(v => v + 1);
  afterNextRender(() => {
    width.set(el.clientWidth || 600);
    ro = new ResizeObserver(() => { const w = el.clientWidth; if (w && w !== width()) width.set(w); });
    ro.observe(el);
    mq.addEventListener('change', flip);
    theme.update(v => v + 1);   // first real read of the CSS variables, now that the element is in the page
  });
  inject(DestroyRef).onDestroy(() => { ro?.disconnect(); mq.removeEventListener('change', flip); });
  /** a CSS variable as the chart's host sees it (the page tokens live on the app's :host) */
  const css = (name: string) => getComputedStyle(el).getPropertyValue(name).trim() || '#888';
  return { el, width, theme, css };
}

export const lineType = (d: Dash): any => d ? (d === 'dot' ? [2, 3] : [6, 4]) : 'solid';

/** [t, v] pairs inside [x0, ...]; a null breaks the line where a value is missing or the gap is over 2.5 buckets. */
export function lineData(pts: Point[], key: string, x0: number, bucket: number, clamp?: [number, number]) {
  const gap = bucket * 2.5, out: [number, number | null][] = [];
  let prev: number | null = null;
  for (const p of pts) {
    if (p.t < x0) continue;
    const v = p[key];
    if (v == null) { if (prev != null) out.push([p.t, null]); prev = null; continue; }
    if (prev != null && p.t - prev > gap) out.push([(prev + p.t) / 2, null]);
    out.push([p.t, clamp ? Math.min(clamp[1], Math.max(clamp[0], v)) : v]);
    prev = p.t;
  }
  while (out.length && out[out.length - 1][1] == null) out.pop();   // the end label sits on the last real value
  return out;
}

/** Time axis with evenly spaced ticks across the whole window; the first label left-aligned, the last right-aligned. */
export function timeAxis(x0: number, x1: number, ticks: number, range: number, muted: string, gridIndex = 0, labels = true) {
  return {
    type: 'value', gridIndex, min: x0, max: x1, interval: (x1 - x0) / ticks,
    axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
    axisLabel: { show: labels, formatter: (v: number) => fmtT(v, range), color: muted, fontSize: 11, margin: 8,
      showMinLabel: true, showMaxLabel: true, alignMinLabel: 'left', alignMaxLabel: 'right' },
    axisPointer: { snap: true },
  };
}

/** Nearest point to time t (the hovered one). */
export function nearest(pts: Point[], x0: number, t: number): Point | null {
  let best: Point | null = null;
  for (const q of pts) if (q.t >= x0 && (!best || Math.abs(q.t - t) < Math.abs(best.t - t))) best = q;
  return best;
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Tooltip title: when, plus what one point stands for. */
export function tipTitle(t: number, bucket: number, liveText: string, seconds: boolean) {
  return new Date(t * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', second: seconds && bucket < 60 ? '2-digit' : undefined })
    + (bucket >= 3600 ? ` · ${bucket / 3600}-hour avg` : bucket >= 60 ? ` · ${Math.round(bucket / 60)}-min avg` : liveText);
}

/** The page font, so ECharts text matches the rest of the page. */
export const pageFont = (el: HTMLElement) => getComputedStyle(el).fontFamily || 'system-ui, sans-serif';

/** Tooltip box: ECharts draws the box, the rows use the same markup and classes as the old hand-drawn tooltip. */
export function tipBox(css: (n: string) => string) {
  return {
    trigger: 'axis', confine: true, className: 'chart-tip', transitionDuration: 0, padding: [7, 10],
    backgroundColor: css('--card'), borderColor: css('--line'), borderWidth: 1,
    textStyle: { color: css('--ink'), fontSize: 12.5 },
    extraCssText: 'border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.12);min-width:170px;position:absolute',
    axisPointer: { type: 'line', lineStyle: { color: css('--muted'), width: 1, type: 'solid' }, label: { show: false } },
    // like the old tooltip: 16 px down-right of the pointer, flipped left/up when it would leave the chart
    position: (pt: number[], _p: unknown, _d: unknown, _r: unknown, size: { contentSize: number[]; viewSize: number[] }) => {
      const [w, h] = size.contentSize, [vw, vh] = size.viewSize;
      return [pt[0] + 16 + w > vw ? Math.max(0, pt[0] - 16 - w) : pt[0] + 16, pt[1] + 16 + h > vh ? Math.max(0, pt[1] - 16 - h) : pt[1] + 16];
    },
  };
}

export const row = (color: string | null, value: string, label: string, extra = false) =>
  `<div class="row${extra ? ' x' : ''}"><i style="background:${color || 'transparent'}"></i><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

/** Line series shared settings: no symbols until hover, then a dot like the old crosshair marker. */
export function lineSeries(s: Series, color: string, card: string, data: [number, number | null][], extra: Record<string, unknown> = {}) {
  return {
    type: 'line', name: s.label, data, showSymbol: false, symbol: 'circle', symbolSize: 9, connectNulls: false, animation: false,
    lineStyle: { color, width: 2, type: lineType(s.dash), cap: 'round', join: 'round' },
    itemStyle: { color, borderColor: card, borderWidth: 2 },
    emphasis: { disabled: false, scale: false, focus: 'none', lineStyle: { width: 2 } },
    ...extra,
  };
}
