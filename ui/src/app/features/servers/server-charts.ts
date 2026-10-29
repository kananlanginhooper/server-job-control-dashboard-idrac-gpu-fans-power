/* eslint-disable @typescript-eslint/no-explicit-any */
import { SITE, t } from '../../core/site';
// Per-server history charts from /api/temphist and /api/iohist: every sensor, net per NIC, disk per drive, RAM used + bandwidth;
// and one chart per GPU job feed (paused/stopped jobs hide, 2026-10-01).
import { TrackOpts, LineOpts, Series } from '../../shared/charts/chart-types';
import { hhmm, keyStyle, numSort, rate } from '../../shared/format';
import { LegendItem } from '../../shared/legend';

export interface ChartBlock<T> { legend: LegendItem[]; opts: T; }

const col = (i: number) => '--t' + (i % 10 + 1);

export function tempChart(th: any, host: string, range: number): ChartBlock<LineOpts> | null {
  const rows: any[] = (th || {})[host] || [];
  if (!rows.length) return null;
  const names = [...new Set(rows.flatMap(([, m]) => Object.keys(m)))].sort(numSort);
  const last = rows[rows.length - 1][1];
  const series: Series[] = names.map((n, i) => ({ k: n, label: n, short: n, color: col(i) }));
  return {
    legend: series.map(x => ({ sw: keyStyle(x.color), name: x.k, val: last[x.k] != null ? Math.round(last[x.k]) + '°' : '—' })),
    opts: { id: 'th-' + host, points: rows.map(([t, m]) => ({ t, ...m })), range_s: Math.min(range, 7200), bucket_s: 15,
      x1: rows[rows.length - 1][0], height: 200, left: 44, right: 60, fmt: v => v == null ? '—' : Math.round(v) + '°C', axis: v => Math.round(v) + '°',
      yRange: [20, 100], yStep: 20, empty: 'collecting…', label: `${host} temperature of every sensor`, series },
  };
}

export function ioChart(ioh: any, host: string, kind: 'net' | 'disk', range: number): ChartBlock<LineOpts> | null {
  const [a, b] = kind === 'net' ? ['rx', 'tx'] : ['r', 'w'];
  const rows: any[] = ((ioh || {})[host] || {})[kind] || [];
  if (!rows.length) return null;
  const names = [...new Set(rows.flatMap(([, m]) => Object.keys(m)))].sort(numSort);
  const last = rows[rows.length - 1][1];
  const series: Series[] = names.flatMap((n, i) => [{ k: n + ':' + a, label: n + (kind === 'net' ? ' in' : ' read'), short: n, color: col(i) },
    { k: n + ':' + b, label: n + (kind === 'net' ? ' out' : ' write'), short: n, color: col(i), dash: true }]);
  const pts = rows.map(([t, m]) => { const p: any = { t }; for (const n in m) { p[n + ':' + a] = m[n][a]; p[n + ':' + b] = m[n][b]; } return p; });
  return {
    legend: names.map((n, i) => ({ sw: keyStyle(col(i)), name: n, val: rate((last[n] || {})[a] || 0), note: ' / ' + rate((last[n] || {})[b] || 0) })),
    opts: { id: (kind === 'net' ? 'ion-' : 'iod-') + host, points: pts, range_s: Math.min(range, 7200), bucket_s: 15, x1: rows[rows.length - 1][0], height: 180, left: 64, right: 60,
      fmt: rate, axis: v => v ? rate(v).replace('.0 ', ' ') : '0', minMax: 1e6, empty: 'collecting…', label: `${host} ${kind} per device`, series },
  };
}

/** RAM used + RAM bandwidth (IMC counters) per server */
export function memChart(ioh: any, host: string, range: number): ChartBlock<TrackOpts> | null {
  const rows: any[] = ((ioh || {})[host] || {}).mem || [];
  if (!rows.length) return null;
  const last = rows[rows.length - 1][1], tot = last.total || 1, GB = (v: any) => v == null ? '—' : (v / 1e9).toFixed(0) + ' GB';
  const dashed = 'background:repeating-linear-gradient(90deg,var(--t3) 0 5px,transparent 5px 8px)';
  return {
    legend: [
      { sw: 'background:var(--t1)', name: 'used', val: GB(last.used), note: ` of ${GB(tot)} (${Math.round(100 * last.used / tot)}%)` },
      { sw: 'background:var(--t3)', name: 'read', val: last.rd == null ? '—' : rate(last.rd) },
      { sw: dashed, name: 'write', val: last.wr == null ? '—' : rate(last.wr) }],
    opts: { id: 'mem-' + host, points: rows.map(([t, m]) => ({ t, used: m.used, rd: m.rd, wr: m.wr })), range_s: Math.min(range, 7200), bucket_s: 15, left: 64, right: 96, label: `${host} RAM used and bandwidth`,
      tracks: [{ title: 'RAM used', height: 70, fmt: GB, axis: v => (v / 1e9).toFixed(0) + ' GB', yRange: [0, tot], series: [{ k: 'used', label: 'used', short: 'used', color: '--t1' }] },
        { title: 'RAM bandwidth', height: 90, fmt: rate, axis: v => v ? rate(v).replace('.0 ', ' ') : '0', minMax: 1e9,
          series: [{ k: 'rd', label: 'read', short: 'read', color: '--t3' }, { k: 'wr', label: 'write', short: 'write', color: '--t3', dash: true }] }] },
  };
}

export interface GpuJobChart { key: string; title: string; legend: LegendItem[]; opts: LineOpts; }
/** one chart per GPU job feed on the GPU card; stopped/idle state + per-minute for slow jobs */
export function gpuJobCharts(ioh: any, range: number): GpuJobChart[] {
  const rows: any[] = ((ioh || {})[SITE.node] || {}).gpujobs || [];
  if (!rows.length) return [];
  const latest = rows[rows.length - 1][1], newest = rows[rows.length - 1][0];
  // 2026-10-01: a paused or stopped job's graph hides (it comes back when the job runs again)
  const keys = [...new Set(rows.flatMap(([, m]) => Object.keys(m)))].sort().filter(k => latest[k] && !['paused', 'stopped'].includes(latest[k].state));
  return keys.map(k => {
    const mine = rows.filter(([, m]) => m[k]), last = mine[mine.length - 1];
    const stopped = !latest[k] || newest - last[0] > 90;   // not in the newest sample = its feed has stopped
    const idle = !stopped && !(last[1][k].rate > 0);
    const perMin = Math.max(...mine.map(([, m]) => m[k].rate || 0)) < 1;   // slow job: show per minute
    const mul = perMin ? 60 : 1, per = perMin ? '/min' : '/s';
    const unit = last[1][k].unit || '', f = (v: any) => v == null ? '—' : `${Number(v).toFixed(v < 10 ? 1 : 0)} ${unit}${per}`;
    const state = stopped ? `stopped · last update ${hhmm(last[0])}` : idle ? 'idle' : '';
    return {
      key: k, title: `Job output · ${k}${stopped ? ' — stopped' : idle ? ' — idle' : ''}`,
      legend: [{ sw: `background:var(${stopped ? '--muted' : '--ok'})`, name: last[1][k].job || k, val: stopped ? '' : f((last[1][k].rate || 0) * mul), note: state ? ' ' + state : '', noteCls: stopped ? 'warnc' : 'muted' }],
      opts: { id: 'gj-' + k, points: mine.map(([t, m]) => ({ t, v: (m[k].rate || 0) * mul })), range_s: Math.min(range, 7200), bucket_s: 15, x1: newest,
        height: 170, left: 56, right: 70, fmt: f, axis: v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : (v < 10 ? v.toFixed(1) : Math.round(v)) + '', minMax: perMin ? 1 : 10, empty: 'collecting…',
        label: `GPU job ${k} output`, series: [{ k: 'v', label: k, short: unit + per, color: stopped ? '--muted' : '--ok' }] },
    };
  });
}
