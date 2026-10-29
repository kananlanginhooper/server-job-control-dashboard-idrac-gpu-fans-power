/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { DashboardStore } from '../../core/dashboard.store';
import { SITE } from '../../core/site';
import { num, numSort } from '../../shared/format';

const RANK: Record<string, number> = { bad: 0, watch: 1, unknown: 2, ok: 3 };
const PILL: Record<string, string> = {
  bad: 'failed',
  watch: 'queued',
  unknown: 'queued',
  ok: 'done',
};

/** SMART counters in one line, by protocol. */
function counters(d: any): string {
  if (d.proto === 'SAS')
    return `grown defects ${num(d.grown)} · uncorrected ${num(d.unc)} · delayed-corrected r/w/v ${['read', 'write', 'verify'].map((k) => num((d.dcorr || {})[k])).join(' / ')}`;
  if (d.proto === 'NVMe')
    return `media errors ${num(d.media)} · wear ${num(d.wear)}% · spare ${num(d.spare)}% · critical ${num(d.crit)} · error log ${num(d.errlog)}`;
  return `reallocated ${num(d.realloc)} · pending ${num(d.pending)} · uncorrectable ${num(d.uncorrect)} · CRC ${num(d.crc)}`;
}

/** Drive health: SMART for every drive, worst first, every 10 minutes. */
@Component({
  selector: '[app-drive-health]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTableModule],
  templateUrl: './drive-health.html',
})
export class DriveHealth {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly cols = [
    'status',
    'host',
    'dev',
    'model',
    'temp',
    'hours',
    'counters',
    'notes',
  ];

  protected readonly v = computed(() => {
    const s = this.store.state() || {},
      HL = s.health || {},
      hd = (HL.drives || []).slice();
    hd.sort(
      (a: any, b: any) =>
        RANK[a.level] - RANK[b.level] ||
        String(a.host).localeCompare(b.host) ||
        numSort(a.dev, b.dev),
    );
    const nlev = (l: string) => hd.filter((d: any) => d.level === l).length;
    const kh = HL.kernel || {},
      ksum = (k: any) => (k ? Object.values(k).reduce((a: any, b: any) => a + b, 0) : null);
    return {
      rows: hd.map((d: any) => ({
        pill: PILL[d.level] || 'queued',
        level: d.level === 'bad' ? 'problem' : d.level,
        host: d.host,
        dev: d.dev,
        model: d.model || '',
        serial: d.serial || '',
        temp: d.temp == null ? '—' : d.temp + '°C',
        trip: d.trip,
        hours: d.hours == null ? '—' : num(d.hours) + ' h',
        years: d.hours ? (d.hours / 8766).toFixed(1) + ' y' : '',
        cnt: d.error ? null : counters(d),
        rate:
          !d.error && d.proto === 'SAS' && Object.keys(d.rate_h || {}).length
            ? `(${['read', 'write', 'verify'].map((k) => '+' + Math.round(d.rate_h[k] || 0)).join(' / ')} per h)`
            : '',
        issues: (d.issues || []).map(([l, t]: [string, string]) => ({
          cls: l === 'bad' ? 'stale' : l === 'info' ? 'muted' : '',
          t,
        })),
      })),
      sum: [
        ['bad', 'failed', 'problem'],
        ['watch', 'queued', 'watch'],
        ['ok', 'done', 'ok'],
      ]
        .filter(([l]) => nlev(l))
        .map(([l, c, t]) => ({ n: nlev(l), c, t })),
      k730: ksum(kh[SITE.main]) ?? '—',
      k720: ksum(kh[SITE.node]) ?? '—',
      k720detail:
        kh[SITE.node] && ksum(kh[SITE.node])
          ? ` (${Object.entries(kh[SITE.node])
              .map(([k, n]) => k + ' ' + n)
              .join(', ')})`
          : '',
      nodeErr: HL[`${SITE.node}_error`] || '',
    };
  });
}
