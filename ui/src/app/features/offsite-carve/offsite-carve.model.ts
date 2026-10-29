/* eslint-disable @typescript-eslint/no-explicit-any */
import { t } from '../../core/site';
import { LineOpts } from '../../shared/charts/chart-types';
import { Kpi } from '../../shared/kpi-row';
import { dur, keyStyle, num, rate } from '../../shared/format';

const GB = (v: any) =>
  v == null ? '—' : v >= 1e12 ? (v / 1e12).toFixed(2) + ' TB' : (v / 1e9).toFixed(1) + ' GB';

/** Offsite backup to Google Drive: rclone push progress, Google's 750 GB/day cap, Drive space, history chart. */
export function offsiteView(s: any, SER: any, range: number, rangeLabel: string) {
  if (!s || !s.offsite) return null;
  const o = s.offsite;
  const bs = o.batches || [],
    done = bs.reduce((a: number, b: any) => a + (b.done_bytes || 0), 0),
    cap = 750e9;
  const perDay = Math.min(cap, (o.rate_1h || 0) * 86400),
    eta = o.left_bytes > 0 && perDay > 0 ? (o.left_bytes / perDay) * 86400 : null;
  const ab = o.about || {},
    notes = Object.entries(o.notes || {}),
    staleLeft = o.left_at && o.at - o.left_at > 900;
  const sr = (SER && SER.offsite) || { points: [], bucket_s: 600 };
  const chart: LineOpts = {
    id: 'offsite',
    points: sr.points || [],
    range_s: range,
    bucket_s: sr.bucket_s || 600,
    height: 170,
    left: 64,
    right: 80,
    fmt: GB,
    axis: (v) => (v ? GB(v).replace('.00 ', ' ').replace('.0 ', ' ') : '0'),
    minMax: 1e11,
    empty: SER ? 'no upload history in this range' : 'loading…',
    label: `offsite backup, last ${rangeLabel}`,
    series: [
      { k: 'uploaded', label: 'uploaded', short: 'up', color: '--s3' },
      { k: 'left', label: 'left to push', short: 'left', color: '--s2', dash: true },
    ],
  };
  return {
    sub: t(
      `rclone to gdrive-offsite:offsite-{main}/ · scanned ${dur(s.now - o.at)} ago · ${bs.length} batches`,
    ),
    refusing: notes.length
      ? `Push scripts are refusing to run: ${notes[0][1]}${notes.length > 1 ? ` (${notes.length} scripts)` : ''}. "Left to push" is the last known figure${o.left_at ? ', from ' + dur(s.now - o.left_at) + ' ago' : ''}.`
      : '',
    kpis: (
      [
        [
          'Left to push',
          GB(o.left_bytes),
          `${num(o.left_hashes || 0)} files (unique)${staleLeft ? ` · as of ${dur(s.now - o.left_at)} ago` : ''}`,
          staleLeft ? 'warn' : '',
        ],
        [
          'Uploaded (verified)',
          GB(done),
          `${num(bs.reduce((a: number, b: any) => a + (b.done_files || 0), 0))} files by rclone push`,
        ],
        ['Upload rate', o.rate_1h ? rate(o.rate_1h) : 'idle', 'average over the last hour'],
        [
          'Last 24 h',
          GB(o.done_24h),
          'Google cap about 750 GB/day',
          o.done_24h > 0.9 * cap ? 'warn' : '',
        ],
        [
          'Done in',
          o.left_bytes <= 0 ? 'done' : eta ? '~' + dur(eta) : '—',
          eta ? 'at this rate, capped at 750 GB/day' : 'no uploads in the last hour',
        ],
        [
          'Drive space',
          ab.total ? `${GB(ab.free)} free` : '—',
          ab.total
            ? `${GB(ab.total - ab.free)} used of ${GB(ab.total)} (Drive ${GB(ab.used)}, Photos/Gmail ${GB(ab.other)})`
            : 'rclone about (every 30 min)',
          ab.total && o.left_bytes > ab.free ? 'bad' : '',
        ],
      ] as string[][]
    ).map(([l, v, sub, c]) => ({ l, v, sub, c }) as Kpi),
    batches: bs.map((b: any) => {
      const tot = (b.done_bytes || 0) + (b.left_bytes || 0);
      return {
        name: b.batch,
        pct: tot ? ((b.done_bytes || 0) / tot) * 100 : 0,
        up: GB(b.done_bytes),
        left: GB(b.left_bytes),
        files: b.left_hashes != null ? num(b.left_hashes) + ' files left' : 'not in the push queue',
      };
    }),
    legend: [
      { sw: keyStyle('--s3'), name: 'uploaded (cumulative)', val: GB(done) },
      { sw: keyStyle('--s2', true), name: 'left to push', val: GB(o.left_bytes) },
    ],
    chart,
  };
}
export type OffsiteView = NonNullable<ReturnType<typeof offsiteView>>;
export type OffsiteBatch = OffsiteView['batches'][number];

/** Carve progress on the GPU node's evidence drives: verified % and assumed regions shown apart, never summed. */
export function carveView(s: any) {
  const cp = (s || {}).carve_progress || {};
  const TB = (b: any) => (b == null ? '—' : (b / 1e12).toFixed(2) + ' TB'),
    upd = cp.updated_at ? new Date(cp.updated_at) : null;
  return {
    sub: upd
      ? `1a progress feed · updated ${upd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'no progress feed',
    rows: Object.entries(cp.loops || {}).map(([k, v]: [string, any]) => ({
      k,
      device: v.device || '',
      status: v.status || '?',
      pill: v.status === 'running' ? 'running' : v.status === 'finished' ? 'done' : 'queued',
      photorec: v.photorec_running,
      pct: v.pct_done || 0,
      done: TB(v.unique_done_bytes),
      total: TB(v.target_total_bytes),
      assumed: v.assumed_done_bytes
        ? `${TB(v.assumed_done_bytes)} assumed${v.assumed_done_source ? ' (' + v.assumed_done_source + ')' : ''}, unverified`
        : 'none',
      eta: v.eta_hours != null ? v.eta_hours.toFixed(1) + ' h' : '—',
    })),
  };
}
