import { t } from '../site';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartBase } from './chart-base';
import { LineOpts, Point, dashArray } from './chart-types';
import { fmtT, niceMax } from '../fmt';

const maxOf = (a: number[]) => { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; };
const minOf = (a: number[]) => { let m = Infinity; for (const v of a) if (v < m) m = v; return m; };

/** Port of lineChart(): time on x, one or more series on a shared y axis, end labels, hover crosshair + tooltip. */
@Component({
  selector: 'app-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'lc chartwrap', style: 'display:block' },
  template: `
    @let m = model();
    <svg #svg role="img" [attr.aria-label]="o().label || ''" [attr.viewBox]="'0 0 ' + m.W + ' ' + m.H" [style.height.px]="m.H">
      @for (g of m.grid; track $index) {
        <line class="grid" [attr.x1]="m.L" [attr.x2]="m.W - m.R" [attr.y1]="g.y" [attr.y2]="g.y" />
        @if (g.label != null) { <text class="axis" [attr.x]="m.L - 8" [attr.y]="g.y + 4" text-anchor="end">{{ g.label }}</text> }
      }
      @for (t of m.ticks; track $index) {
        <text class="axis" [attr.x]="t.x" [attr.y]="m.H - 6" [attr.text-anchor]="t.anchor">{{ t.label }}</text>
      }
      @for (p of m.paths; track p.k) {
        <path class="ln" [attr.d]="p.d" [attr.stroke]="'var(' + p.color + ')'" [attr.stroke-dasharray]="p.dash" />
      }
      @for (l of m.labels; track $index) {
        <text class="dl" [attr.x]="l.x" [attr.y]="l.y">{{ l.text }}</text>
      }
      @if (hov(); as h) {
        <g class="xhair">
          <line class="xh" [attr.x1]="h.px" [attr.x2]="h.px" [attr.y1]="m.T" [attr.y2]="m.H - m.B" />
          @for (c of h.marks; track c.k) { <circle class="mk" r="4.5" [attr.fill]="'var(' + c.color + ')'" [attr.cx]="h.px" [attr.cy]="c.y" /> }
        </g>
      }
      <rect class="hit" [attr.x]="m.L" y="0" [attr.width]="m.hitW" [attr.height]="m.H" fill="transparent"
            (pointermove)="move($event, svg, m.W)" (pointerleave)="leave()" />
      @if (!m.n) { <text class="axis" [attr.x]="(m.L + m.W - m.R) / 2" [attr.y]="m.H / 2" text-anchor="middle">{{ o().empty || 'no data yet' }}</text> }
    </svg>
    <div #tip class="tip" [hidden]="!hov()" [style.left.px]="tipPos().left" [style.top.px]="tipPos().top">
      @if (hov(); as h) {
        <div class="tt">{{ h.title }}</div>
        @for (r of h.rows; track $index) {
          <div class="row" [class.x]="r.x"><i [style.background]="r.color ? 'var(' + r.color + ')' : 'transparent'"></i><b>{{ r.value }}</b><span>{{ r.label }}</span></div>
        }
      }
    </div>`,
})
export class LineChart extends ChartBase {
  readonly o = input.required<LineOpts>({ alias: 'opts' });

  protected readonly model = computed(() => {
    const o = this.o(), W = this.width(), H = o.height || 240, L = o.left ?? 58, T = 10, B = 24;
    const maxLab = Math.max(0, ...(o.series || []).map(x => String(x.short || x.label || '').length)) + 11;   // name + a value like "170.4 MB/s"
    const R = W < 520 ? 12 : Math.min(W * 0.4, Math.max(o.right ?? 104, 16 + 6.6 * maxLab));   // end labels on the right; phones: none
    const pts: Point[] = o.points || [], x1 = o.x1 || Date.now() / 1000, x0 = x1 - o.range_s;
    const dv: number[] = [];
    for (const p of pts) for (const s of o.series) if (p[s.k] != null) dv.push(p[s.k]);
    let ymin = 0, ymax = niceMax(Math.max(o.minMax || 1, maxOf(dv.map(v => v || 0))), o.minMax || 1), grid = o.grid || 4;
    if (o.yRange) {
      let st = o.yStep || 5;
      const lo = Math.min(minOf(dv), o.yRange[0]), hi = Math.max(maxOf(dv), o.yRange[1]);
      while (Math.ceil(hi / st) - Math.floor(lo / st) > (o.yMaxGrid || 8)) st *= 2;
      ymin = Math.floor(lo / st) * st; ymax = Math.ceil(hi / st) * st;
      grid = Math.round((ymax - ymin) / st);
    }
    const X = (t: number) => L + (t - x0) / (x1 - x0) * (W - L - R), Y = (v: number) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
    const ticks = o.ticks || Math.max(2, Math.min(6, Math.floor((W - L - R) / 110)));
    const gridRows = [];
    for (let i = 0; i <= grid; i++) {
      const v = ymin + (ymax - ymin) * i / grid, y = +Y(v).toFixed(1);
      const lab = !o.yLabelStep || i === grid || Math.round(v) % o.yLabelStep === 0;
      gridRows.push({ y, label: lab ? (o.axis ? o.axis(v) : String(v)) : null });
    }
    const tickRows = [];
    for (let i = 0; i <= ticks; i++) {
      const t = x0 + (x1 - x0) * i / ticks;
      tickRows.push({ x: +X(t).toFixed(1), label: fmtT(t, o.range_s), anchor: i === 0 ? 'start' : i === ticks ? 'end' : 'middle' });
    }
    const gap = (o.bucket_s || 60) * 2.5, paths = [], labels: { x: number; y: number; text: string }[] = [];
    for (const s of o.series) {
      let d = '', prev: number | null = null, last: Point | null = null;
      for (const p of pts) {
        if (p.t < x0) continue;
        if (p[s.k] == null) { prev = null; continue; }
        d += `${prev == null || p.t - prev > gap ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p[s.k]).toFixed(1)}`;
        prev = p.t; last = p;
      }
      if (d) paths.push({ k: s.k, d, color: s.color, dash: dashArray(s.dash) });
      if (last && R > 20) labels.push({ y: Y(last[s.k]), x: X(last.t), text: `${s.short || s.label} ${o.fmt(last[s.k])}` });
    }
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    return {
      W, H, L, R, T, B, x0, x1, X, Y, n: pts.length, hitW: Math.max(0, W - L - R), grid: gridRows, ticks: tickRows, paths,
      labels: labels.map(l => ({ x: +(l.x + 8).toFixed(1), y: +(l.y + 4).toFixed(1), text: l.text })),
    };
  });

  protected readonly hov = computed(() => {
    const p = this.pointer(), m = this.model(), o = this.o();
    if (!p) return null;
    const vis = (o.points || []).filter(q => q.t >= m.x0);
    if (!vis.length) return null;
    const t = m.x0 + (p.mx - m.L) / (m.W - m.L - m.R) * (m.x1 - m.x0);
    let best = vis[0];
    for (const q of vis) if (Math.abs(q.t - t) < Math.abs(best.t - t)) best = q;
    const b = o.bucket_s || 60;
    const title = new Date(best.t * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', second: b < 60 ? '2-digit' : undefined })
      + (b >= 3600 ? ` · ${b / 3600}-hour avg` : b >= 60 ? ` · ${Math.round(b / 60)}-min avg` : ' · live sample');
    const rows: { color: string | null; value: string; label: string; x: boolean }[] = o.series.map(s => ({ color: s.color, value: o.fmt(best[s.k]), label: s.label, x: false }));
    for (const [label, value] of (o.extra ? o.extra(best) : [])) rows.push({ color: null, value, label, x: true });
    return {
      px: m.X(best.t), title, rows,
      marks: o.series.filter(s => best[s.k] != null).map(s => ({ k: s.k, color: s.color, y: m.Y(best[s.k]) })),
    };
  });
}
