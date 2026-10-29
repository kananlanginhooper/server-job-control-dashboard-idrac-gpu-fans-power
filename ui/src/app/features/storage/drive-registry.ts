/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { DashboardStore } from '../../dashboard.store';
import { SITE } from '../../site';
import { fb, num } from '../../fmt';

const PILL: Record<string, string> = { spare: 'done', new: 'failed', failed: 'failed', under_recovery: 'hashing', evidence: 'hashing', in_use: 'done',
  checked_clean: 'done', recovered: 'done', wiped: 'queued', retired: 'queued' };

/** Drive registry: every drive we know, by serial. */
@Component({
  selector: '[app-drive-registry]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTableModule],
  templateUrl: './drive-registry.html',
})
export class DriveRegistry {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly cols = ['serial', 'model', 'size', 'status', 'hours', 'errors', 'recovery', 'where', 'role', 'lastCheck', 'checks', 'lastSeen'];

  protected readonly rows = computed(() => (((this.store.state() || {}).db || {}).drives || []).map((d: any) => ({
    serial: d.serial, model: d.model, size: fb(d.size_bytes, 0), pill: PILL[d.status] || 'queued',
    status: d.status === 'new' ? 'new — not checked' : String(d.status || '').replace('_', ' '),
    hours: d.power_on_hours != null ? num(d.power_on_hours) : '—', hoursTip: d.power_on_hours != null ? (d.power_on_hours / 8766).toFixed(1) + ' years powered on' : 'no SMART hours yet',
    errors: [['realloc', d.reallocated], ['pending', d.pending], ['uncorr', d.uncorrectable], ['crc', d.crc_errors], ['other', d.other_error_count]]
      .filter(([, v]) => v).map(([k, v]) => `${k} ${num(v)}`).join(' · ') || (d.health_checked_at ? 'none' : '—'),
    recovery: d.recovery_needed, where: [d.last_host, d.last_slot && 'slot ' + d.last_slot, d.last_dev].filter(Boolean).join(' · '),
    role: d.role || '', lastCheck: d.last_check || '—', checks: d.checks, lastSeen: String(d.last_seen || '').slice(0, 16),
  })));
}
