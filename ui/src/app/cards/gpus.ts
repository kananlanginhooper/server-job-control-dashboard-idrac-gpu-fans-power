/* eslint-disable @typescript-eslint/no-explicit-any */
import { t, SITE } from '../site';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../dashboard.store';
import { LineChart } from '../shared/charts/line-chart';
import { LineOpts, Point } from '../shared/charts/chart-types';
import { Legend, LegendItem } from '../ui/legend';
import { GPU_FAN_MAX_RPM, fb, gpuFanPct, keyStyle, num } from '../fmt';
import { gpuJobCharts } from './server-charts';
import { Kpi } from './servers';

/** "GPUs now": GPU cards above the server cards, big GPU in Tug first, then the RTX 2080 Ti in the GPU node. */
@Component({
  selector: '[app-gpus]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart, Legend],
  template: `
    <div class="h2row"><h2>GPUs now</h2></div>
    <div class="gpus" id="gpus">
      @if (tug(); as t) {
        <div class="server" [class.srv-red]="t.hot">
          <h3>{{ S.boxGpu }} <span class="pill {{ t.live ? 'done' : 'failed' }}">{{ t.live ? 'live' : 'offline' }}</span>@if (t.hot) {<span class="pill failed">1 red</span>}<span class="role">in {{ S.Box }}@if (t.pcie) { · PCIe x{{ t.pcie }}@if (t.pcieMax) { <span class="warnc">(max x{{ t.pcieMax }})</span>}} · <span id="tgpu-src">{{ t.src }}</span></span></h3>
          @if (!t.live) {
            <p class="stale" [title]="t.err">{{ t.offline }}</p>
          } @else {
            <div class="kpis">@for (k of t.kpis; track $index) {<div class="kpi {{ k.c || '' }}"><div class="l">{{ k.l }}</div><div class="v">{{ k.v }}</div><div class="l">{{ k.sub }}</div></div>}</div>
            <div class="srvgrid">
              @for (c of t.charts; track c.id) {
                <div class="srvchart"><h4 class="srvh">{{ c.title }}</h4><app-legend [items]="c.legend" /><app-line-chart [opts]="c.opts" /></div>
              }
            </div>
          }
        </div>
      }
      @if (gpu(); as g) {
        <div class="server" [class.srv-red]="g.hot">
          <h3>{{ S.nodeGpu }} <span class="pill done">live</span>@if (g.hot) {<span class="pill failed">1 red</span>}<span class="role">in {{ S.node }} · <span id="gpu-src">{{ g.src }}</span></span></h3>
          <div class="kpis">@for (k of g.kpis; track $index) {<div class="kpi {{ k.c || '' }}" [title]="k.tip"><div class="l">{{ k.l }}</div><div class="v">{{ k.v }}</div><div class="l">{{ k.sub }}</div></div>}</div>
          <div class="srvgrid">
            @for (c of g.charts; track c.id) {
              <div class="srvchart"><h4 class="srvh">{{ c.title }}</h4><app-legend [items]="c.legend" /><app-line-chart [opts]="c.opts" /></div>
            }
            @for (j of g.jobs; track j.key) {
              <div class="srvchart"><h4 class="srvh">{{ j.title }}</h4><app-legend [items]="j.legend" /><app-line-chart [opts]="j.opts" /></div>
            }
          </div>
        </div>
      }
    </div>`,
})
export class Gpus {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);

  /** big GPU in Tug, from Tug's agent (tugGpuCardHtml + drawTugGpu); live only: the main server keeps the last 2 h in memory (5 s points) */
  protected readonly tug = computed(() => {
    const s = this.store.state(); if (!s) return null;
    const tv = s.tug || {}, g = (tv.fast || {}).gpu, live = !!(tv.ok && g), range = this.store.range(), RL = this.store.rangeLabel();
    const src = '· live, every 5 s' + (range > 7200 ? ' (only the last 2 h are kept)' : '');
    if (!live) return { live, hot: false, src, pcie: 0, pcieMax: 0, err: tv.error || '', kpis: [] as Kpi[], charts: [],
      offline: tv.ok ? t("{Box}'s agent reports no GPU (driver not loaded? check gpu-init on {Box})") : t('{Box} is not answering (powered off, moving, or off the network)') };
    const [w, b] = [83, 88], cls = g.temp >= b ? 'bad' : g.temp >= w ? 'warn' : '';   // AD102 slows down near 87-90°C
    const kpis: Kpi[] = [   // same five stats as the RTX 2080 Ti card
      { l: 'Temp', v: g.temp.toFixed(0) + '°C', sub: `yellow ${w} · red ${b}`, c: cls },
      { l: 'Power', v: g.power_w != null ? Math.round(g.power_w) + ' W' : '—', sub: `cap ${g.power_limit_w != null ? Math.round(g.power_limit_w) : '?'} W` },
      { l: 'Load', v: g.util.toFixed(0) + '%', sub: 'GPU busy' },
      { l: 'Card fan', v: g.fan_pct != null ? g.fan_pct.toFixed(0) + '%' : '—', sub: g.fan_rpm ? `actual ${num(Math.round(g.fan_rpm))} rpm (nvidia, auto)` : 'stopped · fans off below ~55°C (nvidia, auto)' },
      { l: 'VRAM', v: fb(g.mem_used, 1), sub: `of ${fb(g.mem_total, 0)}` }];
    const pts: Point[] = (s.tug_gpu_live || []).filter((p: any) => p.t >= s.now - range)
      .map((p: any) => p.mem_bw != null && p.mem_total ? { ...p, mem_bw_scaled: p.mem_bw / 100 * p.mem_total } : p);
    const now: any = pts.length ? pts[pts.length - 1] : {};
    const Wf = (v: any) => v == null ? '—' : Math.round(v) + ' W', Gf = (v: any) => v == null ? '—' : (v / 1e9).toFixed(1) + ' GB', Nf = (v: any) => v == null ? '—' : Math.round(v) + '';
    const C: { id: string; title: string; fmt: (v: any) => string; axis: (v: number) => string; yRange: number[]; yStep: number; series: [string, string, any][]; extra: LegendItem[] }[] = [
      { id: 'power', title: 'Power used vs cap', fmt: Wf, axis: v => v ? Math.round(v) + ' W' : '0', yRange: [0, 450], yStep: 75, series: [['draw', 'used', false], ['cap', 'cap', true]], extra: [] },
      { id: 'mem', title: 'Memory (VRAM)', fmt: Gf, axis: v => v ? (v / 1e9).toFixed(0) + ' GB' : '0', yRange: [0, 24e9], yStep: 4e9,
        series: [['mem', 'used', false], ['mem_total', 'total', true], ['mem_bw_scaled', 'bandwidth', 'dot']],
        extra: [{ sw: keyStyle('--ok', 'dot'), name: 'bandwidth', val: Nf(now.mem_bw) + '%' }, { note: '(dotted; the total line = 100%)' }] }];   // same legend as the 2080 Ti
    const charts = C.map(c => ({
      id: c.id, title: c.title,
      legend: c.series.filter(([k]) => !k.endsWith('_scaled')).map(([k, l, d]) => ({ sw: keyStyle('--s2', d), name: l, val: c.fmt(now[k]) }) as LegendItem).concat(c.extra),
      opts: { id: 'tgpu-' + c.id, points: pts, range_s: range, bucket_s: 5, height: 170, left: 50, right: 70, fmt: c.fmt, axis: c.axis, yRange: c.yRange, yStep: c.yStep,
        empty: 'no readings yet (collecting since the dashboard started)', label: t(`{boxGpu} ${c.id}, last ${RL}`),
        series: c.series.map(([k, l, d]) => ({ k, label: l, short: l, color: k.endsWith('_scaled') ? '--ok' : '--s2', dash: d })) } as LineOpts,
    }));
    return { live, hot: cls === 'bad', src, pcie: g.pcie_width || 0, pcieMax: g.pcie_width_max && g.pcie_width < g.pcie_width_max ? g.pcie_width_max : 0, err: '', kpis, charts, offline: '' };
  });

  /** the GPU gets its own server card */
  protected readonly gpu = computed(() => {
    const s = this.store.state(); if (!s) return null;
    const R = (s.remote || {}).fast || {}, g = R.gpu, fg = (R.fan_control || {}).gpu || {};
    if (!g) return null;
    const L = this.store.limits(), range = this.store.range(), RL = this.store.rangeLabel(), SER = this.store.series();
    const [w, b] = L.lim('gpu', [90, 91], t('{node}')), cls = g.temp >= b ? 'bad' : g.temp >= w ? 'warn' : '';
    const act = gpuFanPct(g), set = fg.card_manual ?? fg.card_fan ?? g.fan_pct, gt = L.bandTip('gpu', t('{node}'));
    const kpis: Kpi[] = [
      { l: 'Temp', v: g.temp.toFixed(0) + '°C', sub: t(`yellow ${w} · red ${b} · Emergency ${(L.kind('gpu', t('{node}')) || {}).emergency?.[0] ?? '?'}`), c: cls, tip: gt },
      { l: 'Power', v: g.power_w != null ? Math.round(g.power_w) + ' W' : '—', sub: `cap ${g.power_limit_w != null ? Math.round(g.power_limit_w) : '?'} W`, tip: gt },
      { l: 'Load', v: g.util.toFixed(0) + '%', sub: 'GPU busy', tip: gt },
      { l: 'Card fan', v: act != null ? act + '%' : '—', sub: `actual of ${GPU_FAN_MAX_RPM.toLocaleString()} rpm · set ${set ?? '?'}% (nvidia)`, c: act != null && act >= 98 ? 'warn' : '', tip: L.bandTip('gpu_fan_pct', t('{node}')) },
      { l: 'VRAM', v: fb(g.mem_used, 1), sub: `of ${fb(g.mem_total, 0)}`, tip: gt }];
    // /dev/shm/gpu-job*.json on the GPU node, one per job
    const jobs = (R.gpu_jobs || []).filter((j: any) => j.updated_at && s.now - j.updated_at < 86400)
      .map((j: any) => s.now - j.updated_at < 120 ? j : { ...j, rate_per_s: 0, owner_thread: 'no update for ' + Math.round((s.now - j.updated_at) / 60) + ' min (paused?) · ' + (j.owner_thread || '') });
    if (!jobs.length) kpis.push({ l: 'Job output', v: '—', sub: 'no job feeds (/dev/shm/gpu-job*.json)', tip: gt });
    for (const j of jobs) kpis.push({ l: j.job || 'job', v: `${Number(j.rate_per_s || 0).toFixed(1)} ${j.unit || ''}/s`, sub: j.owner_thread || '', tip: gt });

    // power (tokens/s merged in, drawn x3 on the W axis, 2026-09-27) and memory charts; SM clock, PCIe, RAM bandwidth removed
    const Wf = (v: any) => v == null ? '—' : Math.round(v) + ' W', Pf = (v: any) => v == null ? '—' : Math.round(v) + '%', Tf = (v: any) => v == null ? '—' : v.toFixed(0) + ' tok/s';
    const gp = (SER && SER.gpu_perf) || { points: [], bucket_s: 60 }, perf: Point[] = gp.points || [];
    const glive: Point[] = (s.gpu_live || []).filter((p: any) => p.t >= s.now - range), live = range <= 600 && glive.length > 1;
    const gnow: any = Object.assign({}, perf.length ? perf[perf.length - 1] : {}, glive.length ? glive[glive.length - 1] : {});
    const tpsAt = (t: number) => { let v = null, at = 0; for (const q of perf) { if (q.t > t) break; if (q['out_tps'] != null) { v = q['out_tps']; at = q.t; } } return v == null ? null : t - at > 180 ? 0 : v; };   // no fresh reading (job paused) -> 0
    const withTps = (pts: Point[]) => pts.map(p => { const v = p['out_tps'] ?? tpsAt(p.t); return v == null ? p : { ...p, tps_scaled: v * 3 }; });
    const withBw = (pts: Point[]) => pts.map(p => p['mem_bw'] != null && p['mem_total'] ? { ...p, mem_bw_scaled: p['mem_bw'] / 100 * p['mem_total'] } : p);
    const base = live ? glive : perf;
    const mk = (id: string, title: string, fmt: (v: any) => string, axis: (v: number) => string, yRange: number[], yStep: number, series: [string, string, any][], pts: Point[], extra: (p: Point) => [string, string][], extraLeg: LegendItem[]) => {
      const opts: LineOpts = { id: 'gpu-' + id, points: pts, range_s: range, bucket_s: live ? 5 : gp.bucket_s || 60, height: 170, left: 50, right: 70, fmt, axis, yRange, yStep,
        empty: SER ? 'no gpu_perf rows in this range' : 'loading…', label: t(`{nodeGpu} ${id}, last ${RL}`), extra,
        series: series.map(([k, l, d]) => ({ k, label: l, short: l, color: /^(tps|mem_bw)_scaled$/.test(k) ? '--ok' : '--s2', dash: d })) };
      const legend: LegendItem[] = series.filter(([k]) => !k.endsWith('_scaled')).map(([k, l, d]) => ({ sw: keyStyle('--s2', d), name: l, val: fmt(gnow[k]) }));
      return { id, title, opts, legend: legend.concat(extraLeg) };
    };
    const charts = [
      mk('power', 'Power used vs cap · output tokens/s', Wf, v => v ? Math.round(v) + ' W' : '0', [0, 250], 50,
        [['draw', 'used', false], ['cap', 'cap', true], ['tps_scaled', 'output tok/s (x3)', 'dot']], withTps(base),
        p => [['output', Tf(p['out_tps'] ?? (p['tps_scaled'] != null ? p['tps_scaled'] / 3 : null))]],
        [{ sw: keyStyle('--ok', 'dot'), name: 'output', val: Tf(gnow.out_tps) }, { note: '(dotted, drawn x3 on the W axis)' }]),
      mk('mem', 'Memory (VRAM)', v => v == null ? '—' : (v / 1e9).toFixed(1) + ' GB', v => v ? (v / 1e9).toFixed(0) + ' GB' : '0', [0, 12e9], 2e9,
        [['mem', 'used', false], ['mem_total', 'total', true], ['mem_bw_scaled', 'bandwidth', 'dot']], withBw(base),
        p => [['bandwidth', Pf(p['mem_bw'])]],
        [{ sw: keyStyle('--ok', 'dot'), name: 'bandwidth', val: Pf(gnow.mem_bw) }, { note: '(dotted; the total line = 100%)' }]),
    ];
    return { hot: cls === 'bad', kpis, charts, jobs: gpuJobCharts(this.store.ioh(), range),
      src: live ? '· live, every 5 s (throughput per minute)' : '· per minute from gpu_perf' };
  });
}
