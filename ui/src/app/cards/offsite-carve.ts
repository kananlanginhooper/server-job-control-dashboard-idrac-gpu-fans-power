/* eslint-disable @typescript-eslint/no-explicit-any */
import { t, SITE } from '../site';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../dashboard.store';
import { LineChart } from '../charts/line-chart';
import { LineOpts } from '../charts/chart-types';
import { Bar } from '../ui/bar';
import { Legend } from '../ui/legend';
import { dur, keyStyle, num, rate } from '../fmt';

const GB = (v: any) => v == null ? '—' : v >= 1e12 ? (v / 1e12).toFixed(2) + ' TB' : (v / 1e9).toFixed(1) + ' GB';

/** Offsite backup · Google Drive: rclone push progress, Google's 750 GB/day cap, Drive space */
@Component({
  selector: '[app-offsite]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart, Legend],
  template: `
    @let o = v();
    <div class="h2row"><h2>Offsite backup · Google Drive</h2>
      <span class="muted" id="off-sub">@if (!o) {waiting for the first scan (every 10 min)} @else { {{ o.sub }}@if (o.refusing) {<br><span class="warnc">{{ o.refusing }}</span>} }</span></div>
    @if (o) {
      <div class="kpis" id="off-kpis">@for (k of o.kpis; track k[0]) {<div class="kpi {{ k[3] || '' }}"><div class="l">{{ k[0] }}</div><div class="v">{{ k[1] }}</div><div class="l">{{ k[2] }}</div></div>}</div>
      <div class="offgrid">
        <div id="off-bars"><h3>By batch</h3>
          @for (b of o.batches; track b.name) {
            <div class="offb"><span class="n">{{ b.name }}</span><span class="m">{{ b.pct.toFixed(0) }}%</span>
              <div class="bar"><i [style.width.%]="+b.pct.toFixed(1)"></i></div>
              <span class="m">{{ b.up }} up · {{ b.left }} left</span><span class="m">{{ b.files }}</span></div>
          }
        </div>
        <div><h3>Uploaded vs left to push</h3><app-legend [items]="o.legend" /><app-line-chart [opts]="o.chart" /></div>
      </div>
    }`,
})
export class Offsite {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly v = computed(() => {
    const s = this.store.state(); if (!s || !s.offsite) return null;
    const o = s.offsite, SER = this.store.series(), range = this.store.range();
    const bs = o.batches || [], done = bs.reduce((a: number, b: any) => a + (b.done_bytes || 0), 0), cap = 750e9;
    const perDay = Math.min(cap, (o.rate_1h || 0) * 86400), eta = o.left_bytes > 0 && perDay > 0 ? o.left_bytes / perDay * 86400 : null;
    const ab = o.about || {}, notes = Object.entries(o.notes || {}), staleLeft = o.left_at && o.at - o.left_at > 900;
    const sr = (SER && SER.offsite) || { points: [], bucket_s: 600 };
    const chart: LineOpts = { id: 'offsite', points: sr.points || [], range_s: range, bucket_s: sr.bucket_s || 600, height: 170, left: 64, right: 80,
      fmt: GB, axis: v => v ? GB(v).replace('.00 ', ' ').replace('.0 ', ' ') : '0', minMax: 1e11, empty: SER ? 'no upload history in this range' : 'loading…',
      label: `offsite backup, last ${this.store.rangeLabel()}`,
      series: [{ k: 'uploaded', label: 'uploaded', short: 'up', color: '--s3' }, { k: 'left', label: 'left to push', short: 'left', color: '--s2', dash: true }] };
    return {
      sub: t(`rclone to gdrive-offsite:offsite-{main}/ · scanned ${dur(s.now - o.at)} ago · ${bs.length} batches`),
      refusing: notes.length ? `Push scripts are refusing to run: ${notes[0][1]}${notes.length > 1 ? ` (${notes.length} scripts)` : ''}. "Left to push" is the last known figure${o.left_at ? ', from ' + dur(s.now - o.left_at) + ' ago' : ''}.` : '',
      kpis: [
        ['Left to push', GB(o.left_bytes), `${num(o.left_hashes || 0)} files (unique)${staleLeft ? ` · as of ${dur(s.now - o.left_at)} ago` : ''}`, staleLeft ? 'warn' : ''],
        ['Uploaded (verified)', GB(done), `${num(bs.reduce((a: number, b: any) => a + (b.done_files || 0), 0))} files by rclone push`],
        ['Upload rate', o.rate_1h ? rate(o.rate_1h) : 'idle', 'average over the last hour'],
        ['Last 24 h', GB(o.done_24h), 'Google cap about 750 GB/day', o.done_24h > 0.9 * cap ? 'warn' : ''],
        ['Done in', o.left_bytes <= 0 ? 'done' : eta ? '~' + dur(eta) : '—', eta ? 'at this rate, capped at 750 GB/day' : 'no uploads in the last hour'],
        ['Drive space', ab.total ? `${GB(ab.free)} free` : '—', ab.total ? `${GB(ab.total - ab.free)} used of ${GB(ab.total)} (Drive ${GB(ab.used)}, Photos/Gmail ${GB(ab.other)})` : 'rclone about (every 30 min)', ab.total && o.left_bytes > ab.free ? 'bad' : ''],
      ] as string[][],
      batches: bs.map((b: any) => { const tot = (b.done_bytes || 0) + (b.left_bytes || 0);
        return { name: b.batch, pct: tot ? (b.done_bytes || 0) / tot * 100 : 0, up: GB(b.done_bytes), left: GB(b.left_bytes), files: b.left_hashes != null ? num(b.left_hashes) + ' files left' : 'not in the push queue' }; }),
      legend: [{ sw: keyStyle('--s3'), name: 'uploaded (cumulative)', val: GB(done) }, { sw: keyStyle('--s2', true), name: 'left to push', val: GB(o.left_bytes) }],
      chart,
    };
  });
}

/** Carve · GPU node evidence drives: from 1a's ram-carve-progress.json; verified % and assumed shown apart, never summed (2026-09-29) */
@Component({
  selector: '[app-carve]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Bar],
  template: `
    <div class="h2row"><h2>Carve · {{ S.node }} evidence drives</h2><span class="muted" id="carve-sub">{{ v().sub }}</span></div>
    <div class="kpis" id="carve-kpis"></div>
    <div class="jobwrap"><table id="carve-drives"><thead><tr><th>Loop</th><th>Status</th><th class="prog">Verified</th><th>Assumed (not verified)</th><th class="num">ETA</th></tr></thead><tbody>
      @for (r of v().rows; track r.k) {
        <tr><td class="mono">{{ r.k }} <span class="muted">{{ r.device }}</span></td>
          <td><span class="pill {{ r.pill }}">{{ r.status }}</span>@if (r.photorec) { <span class="muted">{{ r.photorec }} photorec</span>}</td>
          <td class="prog"><app-bar [frac]="r.pct / 100" [cls]="r.pct >= 99.9 ? 'ok' : ''" /><div class="muted jd"><b>{{ r.pct.toFixed(1) }}% verified</b> · {{ r.done }} of {{ r.total }}</div></td>
          <td class="muted jd">{{ r.assumed }}</td><td class="num">{{ r.eta }}</td></tr>
      } @empty { <tr><td colspan="5" class="muted">no carve progress feed (/c/{{ S.node }}-prior/ram-carve-progress.json)</td></tr> }
    </tbody></table></div>
    <p class="sub">From 1a's <span class="mono">ram-carve-progress.json</span> ({{ S.node }} /dev/shm, copied to {{ S.main }} /c/{{ S.node }}-prior/). "Verified" is each loop's own confirmed coverage; "assumed" is a region excluded because another pass was assumed to cover it, shown separately and never added in.</p>`,
})
export class Carve {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly v = computed(() => {
    const cp = (this.store.state() || {}).carve_progress || {};
    const TB = (b: any) => b == null ? '—' : (b / 1e12).toFixed(2) + ' TB', upd = cp.updated_at ? new Date(cp.updated_at) : null;
    return {
      sub: upd ? `1a progress feed · updated ${upd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'no progress feed',
      rows: Object.entries(cp.loops || {}).map(([k, v]: [string, any]) => ({
        k, device: v.device || '', status: v.status || '?', pill: v.status === 'running' ? 'running' : v.status === 'finished' ? 'done' : 'queued', photorec: v.photorec_running,
        pct: v.pct_done || 0, done: TB(v.unique_done_bytes), total: TB(v.target_total_bytes),
        assumed: v.assumed_done_bytes ? `${TB(v.assumed_done_bytes)} assumed${v.assumed_done_source ? ' (' + v.assumed_done_source + ')' : ''}, unverified` : 'none',
        eta: v.eta_hours != null ? v.eta_hours.toFixed(1) + ' h' : '—',
      })),
    };
  });
}
