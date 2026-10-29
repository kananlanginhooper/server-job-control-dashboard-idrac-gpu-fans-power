/* eslint-disable @typescript-eslint/no-explicit-any */
import { t } from '../site';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../dashboard.store';
import { LineChart } from '../shared/charts/line-chart';
import { LineOpts, Point } from '../shared/charts/chart-types';
import { Legend, LegendItem } from '../ui/legend';
import { envData } from '../derived';
import { fitRange, gpuFanPct, keyStyle, num } from '../fmt';

/** cause = which sensor or reason; effect = what the fans or GPU did */
function fanEventRow(host: string, t: number, m: string) {
  let c = m, e = '', r: RegExpMatchArray | null;
  if ((r = m.match(/^adaptive: (\d+) -> (\d+) RPM \((.*?)\)(; .*)?$/))) { c = r[3]; e = `fan target ${num(+r[1])} → ${num(+r[2])} RPM`; }
  else if ((r = m.match(/^adaptive: level (\d+) RPM blocked (.*)$/))) { c = 'anti-hunt (a step down was undone)'; e = `${num(+r[1])} RPM blocked ${r[2]}`; }
  else if ((r = m.match(/^EMERGENCY: (\S+) \((\S+)\) (\S+) >= (\S+)/))) { c = `${r[1]} (${r[2]}) ${r[3]} ≥ ${r[4]}`; e = 'Emergency Cool: fans up; GPU power cut if the GPU is hot'; }
  else if ((r = m.match(/^emergency cleared: (.*)$/))) { c = r[1]; e = 'Emergency ended; back to normal control'; }
  else if ((r = m.match(/^mode (\S+) -> ([^:]+): fans (\d+)% \((.*)\)$/))) { c = r[4]; e = `${r[1]} → ${r[2]}, fans ${r[3]}%`; }
  else if ((r = m.match(/^power limit (\d+) -> (\d+) W \((.*)\)$/))) { c = r[3]; e = `GPU power limit ${r[1]} → ${r[2]} W`; }
  else if ((r = m.match(/^run profile -> (.*)$/))) { c = 'run profile changed'; e = r[1]; }
  else if ((r = m.match(/^note: (.*)$/))) { c = r[1]; e = 'no change (noted)'; }
  return { tm: new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), host, c, e };
}

const FOOT = t(' All three charts are WORST CASE: power is the highest DCMI reading (read every 1 s), temperature the hottest sensor, fan speed the fastest fan; every 5 s point, stored minute and longer bucket keeps the highest value (PSU voltage keeps the lowest). DCMI\'s own reading is a 1 s average, so sub-second inrush is not visible. Servers: wall power (IPMI DCMI); the {node} line is wall power minus the {nodeGpu} board power (its dotted line), so PSU losses on the GPU\'s share stay in the {node} line. Temperatures: hottest of CPUs, exhaust, drives and NVMe (the GPU has its own dotted line), the fastest of 6 fans. Dotted lines are the {nodeGpu}. The laptop isn\'t charted here (it\'s on its own card). Sampled every 5 s (10m view).');

@Component({
  selector: '[app-env]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart, Legend],
  template: `
    <div class="h2row"><h2>Power, temperature &amp; fans</h2><span class="sub" id="env-range">last {{ store.rangeLabel() }}</span></div>
    <div class="envsplit"><div class="envgrid envcol">
      @for (c of v()?.charts; track c.g) {
        <div>@if (c.g === 'fan') {<div class="h2row" style="margin-bottom:4px"><h3 style="margin:0">{{ c.title }}</h3></div>} @else {<h3>{{ c.title }}</h3>}
          <app-legend [items]="c.legend" /><app-line-chart [opts]="c.opts" /></div>
      }
    </div>
    <div class="fanev"><h3 class="gpu-h" style="margin-top:0">Why the fans changed <span class="muted" style="text-transform:none;letter-spacing:0">· newest first, both servers, live from fan-control (every 5 s); every mode change is also in MySQL <span class="mono">fan_modes</span></span></h3>
      <div id="fan-events">
        @if (!v()) { <p class="muted">waiting for fan-control…</p> }
        @else if (v()!.events.length) {
          <table><tr><th class="num">Time</th><th>Server</th><th>Cause (sensor or reason)</th><th>Effect</th></tr>
            @for (e of v()!.events; track $index) { <tr><td class="num">{{ e.tm }}</td><td>{{ e.host }}</td><td>{{ e.c }}</td><td>{{ e.e }}</td></tr> }
          </table>
        } @else { <p class="muted">No fan decisions since fan-control last started.</p> }
      </div></div></div>
    <p class="sub" id="power-foot">{{ v()?.foot }}</p>`,
})
export class Env {
  protected readonly store = inject(DashboardStore);

  protected readonly v = computed(() => {
    const s = this.store.state(); if (!s) return null;
    const range = this.store.range(), RL = this.store.rangeLabel(), env = envData(s, this.store.series(), range), envPts = env.pts, envNow = env.now;
    const Wf = (v: any) => v == null ? '—' : Math.round(v) + ' W', Cf = (v: any) => v == null ? '—' : Math.round(v) + '°C', Rf = (v: any) => v == null ? '—' : num(Math.round(v)) + ' RPM';
    type H = [string, string, string, boolean | 'dot'];
    const HOSTS: H[] = [[t('{main}'), t('{main}'), '--s3', false], [t('{node}'), t('{node}'), '--s2', false]];
    const PWR: H[] = [...HOSTS, [t('{node}_gpu'), t('{nodeGpu}'), '--s1', false], ['tug_gpu', t('{boxGpu}'), '--t4', false], [t('{main}_peak'), t('{main} peak'), '--s3', true], [t('{node}_peak'), t('{node} peak'), '--s2', true]];   // peaks: iDRAC 30-s true peak
    const ENV = [
      { g: 'power', title: 'Power draw (peak)', fmt: Wf, axis: (v: number) => v ? Math.round(v) + ' W' : '0', minMax: 100, yRange: [0, 300], yStep: 50, hosts: PWR,
        lab: (k: string) => k === t('{node}_gpu') ? t('{nodeGpu} (in {node})') : k === 'tug_gpu' ? t('{boxGpu} (in {Box})') : k === t('{node}') ? t('{node} (without GPU)') : k === t('{main}_peak') ? t('{main} peak (iDRAC, sub-second)') : k === t('{node}_peak') ? t('{node} peak (iDRAC, incl. GPU)') : k },
      { g: 'temp', title: 'Hottest sensor (peak)', fmt: Cf, axis: (v: number) => Math.round(v) + '°', minMax: 40, yRange: [45, 65], yStep: undefined, hosts: [...HOSTS, [t('{node}_gpu'), t('{nodeGpu}'), '--s2', 'dot']] as H[],
        lab: (k: string) => k === t('{node}_gpu') ? t('{nodeGpu} (in {node})') : k + ' hottest' },
      { g: 'fan', title: 'Fan speed (fastest fan, peak)', fmt: Rf, axis: (v: number) => v ? (v / 1000).toFixed(0) + 'k' : '0', minMax: 2000, yRange: [4000, 8000], yStep: 1000, hosts: [...HOSTS, [t('{node}_gpu'), t('{nodeGpu}'), '--s2', 'dot']] as H[],
        lab: (k: string) => k === t('{node}_gpu') ? t('{nodeGpu} (in {node})') : k + ' (fastest of 6 fans)' }];
    const others = (g: string, p: Point): [string, string][] => ENV.filter(e => e.g !== g).flatMap(e => e.hosts.filter(([k]) => p[e.g + '_' + k] != null).map(([k, l]) => [`${l} ${e.g === 'temp' ? 'hottest' : e.g}`, e.fmt(p[e.g + '_' + k])] as [string, string]));
    const fc = (s.fast || {}).fan_control, f7 = ((s.remote || {}).fast || {}).fan_control, rg = ((s.remote || {}).fast || {}).gpu || {};
    const fanPct = (k: string) => k === t('{main}') ? (fc && fc.fan_pct != null && s.now - (fc.ts || 0) < 300 ? ` · ${fc.fan_pct}%` : '')
      : k === t('{node}_gpu') ? (gpuFanPct(rg) != null ? ` · ${gpuFanPct(rg)}%` : '')
      : k === t('{node}') ? (f7 && f7.fan_pct != null && s.now - (f7.ts || 0) < 300 ? ` · ${f7.fan_pct}%` : '') : '';
    const charts = ENV.map(e => {
      const legend: LegendItem[] = e.hosts.map(([k, , c, d]) => ({ sw: keyStyle(c, d), name: e.lab(k), val: e.fmt(envNow[e.g + '_' + k]), note: e.g === 'fan' ? fanPct(k) : '' }));
      const yr = e.g === 'power' ? (fitRange(envPts.flatMap(p => e.hosts.map(([k]) => p['power_' + k])), 20, 50) || e.yRange) : e.yRange;
      const opts: LineOpts = { id: 'env-' + e.g, points: envPts, range_s: range, bucket_s: env.bucket, height: 170, left: 56, right: 92, fmt: e.fmt, axis: e.axis, minMax: e.minMax, yRange: yr, yStep: e.yStep,
        empty: 'collecting…', label: `${e.g} by computer, last ${RL}`,
        series: e.hosts.map(([k, l, c, d]) => ({ k: e.g + '_' + k, label: e.lab(k), short: l, color: c, dash: d })),
        // total = main server + GPU node (plotted without GPU) + GPU = both iDRAC readings (verified 2026-09-28: the GPU node iDRAC includes the GPU)
        extra: p => ((e.g === 'power' && (p[t('power_{main}')] != null || p[t('power_{node}')] != null) ? [['Total (both servers)', Wf((p[t('power_{main}')] || 0) + (p[t('power_{node}')] || 0) + (p[t('power_{node}_gpu')] || 0))] as [string, string]]
          .concat(p[t('power_{main}_peak')] != null && p[t('power_{node}_peak')] != null ? [['Peak total (iDRAC)', Wf(p[t('power_{main}_peak')] + p[t('power_{node}_peak')])]] : []) : []) as [string, string][]).concat(others(e.g, p)) };
      return { g: e.g, title: e.title, legend, opts };
    });
    const ev = [[t('{main}'), (fc || {}).events], [t('{node}'), (f7 || {}).events]]
      .flatMap(([h, l]: any[]) => (l || []).map(([t, m]: [number, string]) => [h, t, m] as [string, number, string])).sort((x, y) => y[1] - x[1]).slice(0, 25);
    const avgE = (k: string) => { const v = envPts.map(p => p[k]).filter(x => x != null); return v.length ? v.reduce((a: number, b: number) => a + b, 0) / v.length : null; };
    return { charts, events: ev.map(([h, t, m]) => fanEventRow(h, t, m)), foot: t(`Averages over the view: power {main} ${Wf(avgE(t('power_{main}')))}, {node} ${Wf(avgE(t('power_{node}')))}.`) + FOOT };
  });
}
