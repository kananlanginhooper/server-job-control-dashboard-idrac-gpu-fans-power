import { t } from '../site';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartBase } from './chart-base';
import { TrackOpts, Point, dashArray, keyBg } from './chart-types';
import { fmtT, niceMax } from '../fmt';

/** Port of trackChart(): stacked tracks sharing one time axis, each with its own y scale. */
@Component({
  selector: 'app-track-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'lc chartwrap', style: 'display:block' },
  template: `
    @let m = model();
    <svg #svg role="img" [attr.aria-label]="o().label || ''" [attr.viewBox]="'0 0 ' + m.W + ' ' + m.H" [style.height.px]="m.H">
      @for (ln of m.tracks; track $index) {
        <text class="axis" [attr.x]="m.L" [attr.y]="ln.top - 5" style="font-weight:600;fill:var(--ink)">{{ ln.title }}</text>
        @for (g of ln.grid; track $index) {
          <line class="grid" [attr.x1]="m.L" [attr.x2]="m.W - m.R" [attr.y1]="g.y" [attr.y2]="g.y" />
          <text class="axis" [attr.x]="m.L - 8" [attr.y]="g.y + 4" text-anchor="end">{{ g.label }}</text>
        }
        @for (p of ln.paths; track p.k) {
          <path class="ln" [attr.d]="p.d" [attr.stroke]="'var(' + p.color + ')'" [attr.stroke-dasharray]="p.dash" />
        }
        @for (l of ln.labels; track $index) { <text class="dl" [attr.x]="l.x" [attr.y]="l.y">{{ l.text }}</text> }
      }
      @for (t of m.ticks; track $index) {
        <text class="axis" [attr.x]="t.x" [attr.y]="m.H - 6" [attr.text-anchor]="t.anchor">{{ t.label }}</text>
      }
      @if (hov(); as h) {
        <g class="xhair">
          <line class="xh" [attr.x1]="h.px" [attr.x2]="h.px" [attr.y1]="m.tracks[0].top" [attr.y2]="m.H - m.B" />
          @for (c of h.marks; track $index) { <circle class="mk" r="4" [attr.fill]="'var(' + c.color + ')'" [attr.cx]="h.px" [attr.cy]="c.y" /> }
        </g>
      }
      <rect class="hit" [attr.x]="m.L" y="0" [attr.width]="m.hitW" [attr.height]="m.H" fill="transparent"
            (pointermove)="move($event, svg, m.W)" (pointerleave)="leave()" />
      @if (!m.n) { <text class="axis" [attr.x]="(m.L + m.W - m.R) / 2" [attr.y]="m.H / 2" text-anchor="middle">collecting…</text> }
    </svg>
    <div #tip class="tip" [hidden]="!hov()" [style.left.px]="tipPos().left" [style.top.px]="tipPos().top">
      @if (hov(); as h) {
        <div class="tt">{{ h.title }}</div>
        @for (r of h.rows; track $index) {
          @if (r.head) { <div class="row x"><i></i><span style="font-weight:600">{{ r.label }}</span></div> }
          @else { <div class="row"><i [style.background]="r.bg"></i><b>{{ r.value }}</b><span>{{ r.label }}</span></div> }
        }
      }
    </div>`,
})
export class TrackChart extends ChartBase {
  readonly o = input.required<TrackOpts>({ alias: 'opts' });

  protected readonly model = computed(() => {
    const o = this.o(), W = this.width(), L = o.left ?? 58, R = o.right ?? 104, TITLE = 16, GAP = 14, B = 24;
    let y = 0;
    const pts: Point[] = o.points || [], x1 = Date.now() / 1000, x0 = x1 - o.range_s;
    const X = (t: number) => L + (t - x0) / (x1 - x0) * (W - L - R);
    const gap = (o.bucket_s || 60) * 2.5;
    const tracks = o.tracks.map(ln => {
      const top = y + TITLE, h = ln.height;
      y = top + h + GAP;
      const vals: number[] = [];
      for (const p of pts) for (const s of ln.series) if (p[s.k] != null) vals.push(p[s.k]);
      const y0 = ln.yRange ? ln.yRange[0] : 0;
      let mx = ln.minMax || 1; for (const v of vals) if (v > mx) mx = v;
      const ymax = ln.yRange ? ln.yRange[1] : niceMax(mx, ln.minMax || 1);
      const Y = (v: number) => top + (1 - (Math.min(ymax, Math.max(y0, v)) - y0) / (ymax - y0)) * h;
      const grid = [0, 1, 2].map(i => { const v = y0 + (ymax - y0) * i / 2; return { y: +Y(v).toFixed(1), label: ln.axis(v) }; });
      const paths = [], labels: { x: number; y: number; text: string }[] = [];
      for (const s of ln.series) {
        let d = '', prev: number | null = null, last: Point | null = null;
        for (const p of pts) {
          if (p.t < x0 || p[s.k] == null) { prev = null; continue; }
          d += `${prev == null || p.t - prev > gap ? 'M' : 'L'}${X(p.t).toFixed(1)},${Y(p[s.k]).toFixed(1)}`;
          prev = p.t; last = p;
        }
        if (d) paths.push({ k: s.k, d, color: s.color, dash: dashArray(s.dash) });
        if (last) labels.push({ y: Y(last[s.k]), x: X(last.t), text: `${s.short} ${ln.fmt(last[s.k])}` });
      }
      labels.sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
      return { ...ln, top, h, Y, grid, paths, labels: labels.map(l => ({ x: +(l.x + 8).toFixed(1), y: +(l.y + 4).toFixed(1), text: l.text })) };
    });
    const H = y - GAP + B;
    const ticks = Math.max(2, Math.min(6, Math.floor((W - L - R) / 110)));
    const tickRows = [];
    for (let i = 0; i <= ticks; i++) {
      const t = x0 + (x1 - x0) * i / ticks;
      tickRows.push({ x: +X(t).toFixed(1), label: fmtT(t, o.range_s), anchor: i === 0 ? 'start' : i === ticks ? 'end' : 'middle' });
    }
    return { W, H, L, R, B, x0, x1, X, tracks, ticks: tickRows, n: pts.length, hitW: Math.max(0, W - L - R) };
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
    const title = new Date(best.t * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      + (b >= 3600 ? ' · 1-hour avg' : b >= 60 ? ` · ${Math.round(b / 60)}-min avg` : ' · 30-s sample');
    const rows: { head: boolean; label: string; value?: string; bg?: string }[] = [];
    const marks: { color: string; y: number }[] = [];
    for (const ln of m.tracks) {
      rows.push({ head: true, label: ln.title });
      for (const s of ln.series) {
        rows.push({ head: false, label: s.label, value: ln.fmt(best[s.k]), bg: keyBg(s) });
        if (best[s.k] != null) marks.push({ color: s.color, y: ln.Y(best[s.k]) });
      }
    }
    return { px: m.X(best.t), title, rows, marks };
  });
}
