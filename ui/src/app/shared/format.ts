// Formatting helpers, ported 1:1 from the live dashboard (dashboard/index.html).
/* eslint-disable @typescript-eslint/no-explicit-any */

export const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);

export function fb(n: any, d = 1): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  n = Number(n);
  while (Math.abs(n) >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return n.toFixed(i ? d : 0) + ' ' + u[i];
}
export const rate = (n: any) => fb(n) + '/s';
export const num = (n: any) => n == null ? '—' : Number(n).toLocaleString();
export function dur(s: number): string {
  s = Math.round(s);
  if (s < 90) return s + 's';
  if (s < 5400) return Math.round(s / 60) + 'm';
  if (s < 172800) return (s / 3600).toFixed(1) + 'h';
  return (s / 86400).toFixed(1) + 'd';
}
export const mbs = (v: any) => v == null ? '—' : (v / 1e6 >= 100 ? (v / 1e6).toFixed(0) : (v / 1e6).toFixed(1)) + ' MB/s';
export const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const pct1 = (f: number) => (f * 100).toFixed(f < 0.1 ? 1 : 0) + '%';

export function niceMax(v: number, floor = 1e6): number {
  if (v <= 0) return floor;
  const e = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= v) return m * e;
  return 10 * e;
}
export function fmtT(t: number, range: number): string {
  const d = new Date(t * 1000);
  return range > 2 * 86400 ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit' })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
/** y range gauged to the data: min..max plus padding, rounded to step */
export function fitRange(vals: any[], pad: number, step: number): [number, number] | null {
  const v = vals.filter(x => x != null && isFinite(x));
  if (!v.length) return null;
  const lo = Math.min(...v), hi = Math.max(...v), p = Math.max(pad, (hi - lo) * 0.12);
  return [Math.max(0, Math.floor((lo - p) / step) * step), Math.ceil((hi + p) / step) * step];
}
/** HTML fragment -> tooltip text, one line per block */
export function plainText(html: string): string {
  const d = document.createElement('div');
  d.innerHTML = String(html || '').replace(/<\/div>/g, '\n');
  return (d.textContent || '').replace(/\n{2,}/g, '\n').trim();
}
export const shortRoot = (r: string) => r.replace(/^C:\\Users\\[^\\]+\\/i, '~\\');
export const numSort = (a: any, b: any) => String(a).localeCompare(String(b), undefined, { numeric: true });

/** Legend key swatch style (solid, dashed or dotted line in a CSS colour token). */
export function keyStyle(c: string, dash?: boolean | string): string {
  return dash === 'dot' ? `background:repeating-linear-gradient(90deg,var(${c}) 0 2px,transparent 2px 4px)`
    : dash ? `background:repeating-linear-gradient(90deg,var(${c}) 0 4px,transparent 4px 7px)` : `background:var(${c})`;
}

export const RLABEL: Record<number, string> = { 600: '10 minutes', 3600: 'hour', 21600: '6 hours', 86400: 'day', 604800: 'week' };
export const RANGES: [number, string][] = [[600, '10m'], [3600, '1h'], [21600, '6h'], [86400, '1d'], [604800, '1w']];

// component limits (component-limits.json via /api/state, shared with fan-control); the literals are fallbacks
export class Limits {
  constructor(private j: any) {}
  kind(k: string, host?: string): any {
    const b = this.j && this.j.kinds && this.j.kinds[k];
    if (!b) return null;
    return Object.assign({}, b, ((this.j.hosts || {})[host || ''] || {})[k] || {});
  }
  lim(k: string, dflt: number[], host?: string): number[] {
    const v = this.kind(k, host);
    return v && v.yellow != null ? [v.yellow, v.red ?? 999] : dflt;
  }
  bandTip(k: string, host?: string): string {
    const v = this.kind(k, host);
    if (!v) return '';
    const e = v.emergency, u = k === 'gpu_fan_pct' ? '%' : '°C';
    return `${v.label}${v.detail ? '\n' + v.detail : ''}
green below ${v.yellow}${u} · yellow ${v.yellow}${u} = target${v.red != null ? ` · red from ${v.red}${u}` : ''}`
      + (e ? `
Emergency Cool at ${e[0]}${u}, clears at ${e[1]}${u} (shown as the pop-up, not a colour)` : v.tune ? ` · no Emergency Cool (throttles itself); Adaptive steers to stay under ${v.tune[0]}${u}` : k === 'gpu_fan_pct' ? '' : ' · no Emergency Cool');
  }
  nvme(host?: string) { return this.lim('nvme', [80, 81], host); }
  driveThr(d: any): number[] {
    return d.proto === 'NVMe' ? this.lim('nvme', this.nvme(), d.host)
      : /WD Red/i.test(d.model || '') ? this.lim('ssd', this.lim('ssd', [69, 70]), d.host)
      : /MG03SCA/i.test(d.model || '') ? this.lim('toshiba', [45, 50], d.host)
      : this.lim('hdd', (t => [t - 5, t])(d.trip || 60), d.host);
  }
}
export const ipmiKind = (n: string) => /inlet/i.test(n) ? 'inlet' : /exhaust/i.test(n) ? 'exhaust' : /^CPU/i.test(n) ? 'cpu' : 'ipmi_other';
export const driveKind = (d: any) => d.proto === 'NVMe' ? 'nvme' : /WD Red/i.test(d.model || '') ? 'ssd' : /MG03SCA/i.test(d.model || '') ? 'toshiba' : 'hdd';
export const GPU_FAN_MAX_RPM = 6030;
/** no 100% cap: firmware boosts run above it */
export const gpuFanPct = (g: any): number | null => g && g.fan_rpm ? Math.round(g.fan_rpm / GPU_FAN_MAX_RPM * 100) : g && g.fan_pct != null ? Math.round(g.fan_pct) : null;
