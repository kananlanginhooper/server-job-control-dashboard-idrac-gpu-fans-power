/* eslint-disable @typescript-eslint/no-explicit-any */
// Data shaping shared by more than one card (power / temperature / fan history).
import { Point } from '../shared/charts/chart-types';
import { SITE } from './site';

export interface EnvData {
  liveMode: boolean;
  pts: Point[];
  now: any;
  bucket: number;
}

/** env points for the view, from this app's /api/v1/env-history (2026-11-01): the metrics recorder's stored buckets
 *  with the live MQTT points (~5 s) over them, topped up every 5 s. Same keys as the hub's old env series.
 *  The GPU node line is plotted without the GPU (noGpu); total = main server + GPU node + GPU = both iDRAC readings. */
export function envData(eh: any, range: number): EnvData {
  const all: Point[] = eh?.points || [];
  const noGpu = (p: any) => {
    const n = `power_${SITE.node}`,
      g = n + '_gpu';
    return p[n] != null && p[g] != null ? { ...p, [n]: Math.max(0, p[n] - p[g]) } : p;
  };
  const from = Date.now() / 1000 - range,
    pts = all.filter((p) => p.t >= from).map(noGpu);
  return {
    liveMode: !eh?.stored,
    pts,
    now: pts.length ? pts[pts.length - 1] : {},
    bucket: eh?.bucket_s || 60,
  };
}

/** total power + iDRAC peak per point (peak: each server's 30-s peak, summed) */
export const withTotals = (pts: Point[]): Point[] =>
  pts.map((p) => {
    const a = `power_${SITE.main}`,
      b = `power_${SITE.node}`;
    return p[a] != null && p[b] != null
      ? {
          ...p,
          power_total: p[a] + p[b] + (p[b + '_gpu'] || 0),
          power_peak:
            p[a + '_peak'] != null && p[b + '_peak'] != null
              ? p[a + '_peak'] + p[b + '_peak']
              : undefined,
        }
      : p;
  });

/** Adaptive target line: follows the Adaptive variant (1 kW / 1.25 kW / 1.5 kW), 2026-09-30 */
export const powerLine = (s: any) => {
  const d = (s.runprofile || {}).desired || {};
  return (d.profile === 'adaptive' && d.power_w) || 1250;
};
