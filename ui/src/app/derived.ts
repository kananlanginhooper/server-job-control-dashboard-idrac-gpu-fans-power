/* eslint-disable @typescript-eslint/no-explicit-any */
// Data shaping shared by more than one card (power / temperature / fan history).
import { Point } from './shared/charts/chart-types';
import { SITE } from './site';

export interface EnvData { liveMode: boolean; pts: Point[]; now: any; bucket: number; }

/** env points for the view: live 5-s samples for 10m (or when no stored series yet), else /api/series env buckets.
 *  The GPU node line is plotted without the GPU (noGpu); total = main server + GPU node + GPU = both iDRAC readings. */
export function envData(s: any, ser: any, range: number): EnvData {
  const envLive: Point[] = s.env_live || [];
  const liveMode = range <= 600 || !(ser && ser.env && (ser.env.points || []).length > 1);
  const noGpu = (p: any) => { const n = `power_${SITE.node}`, g = n + '_gpu'; return p[n] != null && p[g] != null ? { ...p, [n]: Math.max(0, p[n] - p[g]) } : p; };
  const pts = (liveMode ? envLive.filter(p => p.t >= s.now - range) : ser.env.points).map(noGpu);
  return { liveMode, pts, now: envLive.length ? noGpu(envLive[envLive.length - 1]) : {}, bucket: liveMode ? 5 : (ser.env.bucket_s || 60) };
}

/** total power + iDRAC peak per point (peak: each server's 30-s peak, summed) */
export const withTotals = (pts: Point[]): Point[] => pts.map(p => { const a = `power_${SITE.main}`, b = `power_${SITE.node}`; return p[a] != null && p[b] != null ? {
  ...p, power_total: p[a] + p[b] + (p[b + '_gpu'] || 0),
  power_peak: p[a + '_peak'] != null && p[b + '_peak'] != null ? p[a + '_peak'] + p[b + '_peak'] : undefined,
} : p; });

/** Adaptive target line: follows the Adaptive variant (1 kW / 1.25 kW / 1.5 kW), 2026-09-30 */
export const powerLine = (s: any) => { const d = (s.runprofile || {}).desired || {}; return (d.profile === 'adaptive' && d.power_w) || 1250; };
