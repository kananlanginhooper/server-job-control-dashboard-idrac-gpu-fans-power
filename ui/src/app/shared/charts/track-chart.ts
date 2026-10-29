/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import { maxOf, niceMax } from '../format';
import { Point, TrackOpts, keyBg } from './chart-types';
import { chartHost, pageFont, lineData, lineSeries, nearest, esc, timeAxis, tipBox, tipTitle } from './chart-kit';

const TITLE = 16, GAP = 14, B = 24;

/**
 * Stacked tracks sharing one time axis, each with its own y scale and title (ECharts, one grid per track).
 * Same `opts` as the hand-drawn SVG chart it replaces: per track a fixed height, 3 grid lines (0, middle, max),
 * y from 0 (or yRange) to a nice max (at least minMax) with values clamped into it, end labels pushed apart,
 * time labels under the last track only, one crosshair through every track, and a tooltip grouped by track.
 */
@Component({
  selector: 'app-track-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxEchartsDirective],
  host: { class: 'lc chartwrap', style: 'display:block' },
  template: `<div echarts [options]="options()" [initOpts]="{ renderer: 'svg' }" [autoResize]="true"
                  role="img" [attr.aria-label]="opts().label || ''" [style.height.px]="height()"></div>`,
})
export class TrackChart {
  readonly opts = input.required<TrackOpts>();
  private readonly h = chartHost();

  protected readonly height = computed(() => this.opts().tracks.reduce((y, ln) => y + TITLE + ln.height + GAP, 0) - GAP + B);

  protected readonly options = computed(() => {
    const o = this.opts(), W = this.h.width(); this.h.theme();
    const css = this.h.css, muted = css('--muted'), ink = css('--ink'), card = css('--card');
    const L = o.left ?? 58, R = o.right ?? 104, bucket = o.bucket_s || 60;
    const pts: Point[] = o.points || [], x1 = Date.now() / 1000, x0 = x1 - o.range_s;
    const ticks = Math.max(2, Math.min(6, Math.floor((W - L - R) / 110)));
    const last = o.tracks.length - 1;

    let y = 0;
    const grids: any[] = [], xAxes: any[] = [], yAxes: any[] = [], series: any[] = [], titles: any[] = [];
    o.tracks.forEach((ln, i) => {
      const top = y + TITLE; y = top + ln.height + GAP;
      const vals: number[] = [];
      for (const p of pts) for (const s of ln.series) if (p[s.k] != null) vals.push(p[s.k]);
      const y0 = ln.yRange ? ln.yRange[0] : 0;
      const ymax = ln.yRange ? ln.yRange[1] : niceMax(maxOf(vals, ln.minMax || 1), ln.minMax || 1);
      grids.push({ left: L, right: R, top, height: ln.height });
      xAxes.push(timeAxis(x0, x1, ticks, o.range_s, muted, i, i === last));
      yAxes.push({ type: 'value', gridIndex: i, min: y0, max: ymax, interval: (ymax - y0) / 2,
        axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { color: css('--line'), width: 1 } },
        axisLabel: { formatter: (v: number) => ln.axis(v), color: muted, fontSize: 11, margin: 8 } });
      titles.push({ type: 'text', left: L, top: top - 16, silent: true, style: { text: ln.title, fill: ink, fontSize: 11, fontWeight: 600 } });
      for (const s of ln.series) {
        series.push(lineSeries(s, css(s.color), card, lineData(pts, s.k, x0, bucket, [y0, ymax]), {
          xAxisIndex: i, yAxisIndex: i,
          endLabel: { show: true, distance: 8, color: ink, fontSize: 11.5, fontWeight: 600, formatter: () => {
            const lastPt = [...pts].reverse().find(p => p.t >= x0 && p[s.k] != null);
            return `${s.short} ${ln.fmt(lastPt?.[s.k])}`;
          } },
        }));
      }
    });

    return {
      animation: false,
      textStyle: { fontFamily: pageFont(this.h.el) },
      grid: grids, xAxis: xAxes, yAxis: yAxes, series,
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      labelLayout: { moveOverlap: 'shiftY' },
      graphic: titles.concat(pts.length ? [] : [{ type: 'text', left: 'center', top: 'middle', silent: true,
        style: { text: 'collecting…', fill: muted, fontSize: 11 } }]),
      tooltip: {
        ...tipBox(css),
        formatter: (ps: any[]) => {
          const best = nearest(pts, x0, ps?.[0]?.axisValue ?? 0);
          if (!best) return '';
          const rows = o.tracks.flatMap(ln => [
            `<div class="row x"><i></i><span style="font-weight:600">${esc(ln.title)}</span></div>`,
            ...ln.series.map(s => `<div class="row"><i style="background:${keyBg(s).replace(/var\((--[\w-]+)\)/g, (_, v) => css(v))}"></i><b>${esc(ln.fmt(best[s.k]))}</b><span>${esc(s.label)}</span></div>`),
          ]);
          return `<div class="tt">${esc(tipTitle(best.t, bucket, ' · 30-s sample', false))}</div>${rows.join('')}`;
        },
      },
    };
  });
}
