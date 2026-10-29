/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import { niceMax } from '../format';
import { LineOpts, Point } from './chart-types';
import { chartHost, pageFont, lineData, lineSeries, nearest, row, esc, timeAxis, tipBox, tipTitle } from './chart-kit';

/**
 * Time on x, one or more series on a shared y axis, end labels, hover crosshair + tooltip (ECharts).
 * Same `opts` as the hand-drawn SVG chart it replaces, so the cards don't change:
 *   y from 0 to a nice max over the data (at least minMax), or a yRange stretched to the data in yStep steps;
 *   `grid` lines with `axis` labels (only every yLabelStep when set); evenly spaced time ticks;
 *   gaps over 2.5 buckets break a line; dashed / dotted series; "short value" labels at the line ends, pushed apart;
 *   no end labels under 520 px (phones); the tooltip lists every series plus the `extra` rows; `empty` text.
 */
@Component({
  selector: 'app-line-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective],
  host: { class: 'lc chartwrap', style: 'display:block' },
  template: `<div echarts [options]="options()" [initOpts]="{ renderer: 'svg' }" [autoResize]="true"
                  role="img" [attr.aria-label]="opts().label || ''" [style.height.px]="opts().height || 240"></div>`,
})
export class LineChart {
  readonly opts = input.required<LineOpts>();
  private readonly h = chartHost();

  protected readonly options = computed(() => {
    const o = this.opts(), W = this.h.width(); this.h.theme();
    const css = this.h.css, muted = css('--muted'), card = css('--card');
    const L = o.left ?? 58;
    const maxLab = Math.max(0, ...(o.series || []).map(x => String(x.short || x.label || '').length)) + 11;
    const R = W < 520 ? 12 : Math.min(W * 0.4, Math.max(o.right ?? 104, 16 + 6.6 * maxLab));   // room for the end labels
    const pts: Point[] = o.points || [], x1 = o.x1 || Date.now() / 1000, x0 = x1 - o.range_s, bucket = o.bucket_s || 60;

    const dv: number[] = [];
    for (const p of pts) for (const s of o.series) if (p[s.k] != null) dv.push(p[s.k]);
    let ymin = 0, ymax = niceMax(Math.max(o.minMax || 1, ...dv.map(v => v || 0)), o.minMax || 1), grid = o.grid || 4;
    if (o.yRange) {
      let st = o.yStep || 5;
      const lo = Math.min(...dv, o.yRange[0]), hi = Math.max(...dv, o.yRange[1]);
      while (Math.ceil(hi / st) - Math.floor(lo / st) > (o.yMaxGrid || 8)) st *= 2;
      ymin = Math.floor(lo / st) * st; ymax = Math.ceil(hi / st) * st;
      grid = Math.round((ymax - ymin) / st);
    }
    const ticks = o.ticks || Math.max(2, Math.min(6, Math.floor((W - L - R) / 110)));
    const yLabel = (v: number) => (!o.yLabelStep || Math.abs(v - ymax) < 1e-9 || Math.round(v) % o.yLabelStep === 0) ? (o.axis ? o.axis(v) : String(v)) : '';

    return {
      animation: false,
      textStyle: { fontFamily: pageFont(this.h.el) },
      grid: { left: L, right: R, top: 10, bottom: 24, containLabel: false },
      xAxis: timeAxis(x0, x1, ticks, o.range_s, muted),
      yAxis: {
        type: 'value', min: ymin, max: ymax, interval: (ymax - ymin) / grid,
        axisLine: { show: false }, axisTick: { show: false },
        splitLine: { lineStyle: { color: css('--line'), width: 1 } },
        axisLabel: { formatter: yLabel, color: muted, fontSize: 11, margin: 8 },
      },
      tooltip: {
        ...tipBox(css),
        formatter: (ps: any[]) => {
          const best = nearest(pts, x0, ps?.[0]?.axisValue ?? 0);
          if (!best) return '';
          const rows = o.series.map(s => row(css(s.color), o.fmt(best[s.k]), s.label))
            .concat((o.extra ? o.extra(best) : []).map(([label, value]) => row(null, value, label, true)));
          return `<div class="tt">${esc(tipTitle(best.t, bucket, ' · live sample', true))}</div>${rows.join('')}`;
        },
      },
      labelLayout: { moveOverlap: 'shiftY' },
      graphic: pts.length ? [] : [{ type: 'text', left: 'center', top: 'middle', silent: true,
        style: { text: o.empty || 'no data yet', fill: muted, fontSize: 11 } }],
      series: o.series.map(s => {
        const color = css(s.color);
        return lineSeries(s, color, card, lineData(pts, s.k, x0, bucket), {
          endLabel: { show: R > 20, distance: 8, color: css('--ink'), fontSize: 11.5, fontWeight: 600,
            formatter: (p: any) => `${s.short || s.label} ${o.fmt(p.value?.[1])}` },
        });
      }),
    };
  });
}
