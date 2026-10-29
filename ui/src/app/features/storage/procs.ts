/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { DashboardStore } from '../../dashboard.store';
import { SITE, t } from '../../site';
import { dur } from '../../fmt';

/** Running on the server (watched processes per host) and Connected machines (LAN peers with their services). */
@Component({
  selector: '[app-procs]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTableModule],
  template: `
    <h2>Running on the server</h2>
    <div class="scroll" style="max-height:260px;overflow-y:auto">
      <table mat-table id="procs" [dataSource]="v().procs">
        <ng-container matColumnDef="host"><th mat-header-cell *matHeaderCellDef>Host</th><td mat-cell *matCellDef="let p" class="mono">{{ p.host }}</td></ng-container>
        <ng-container matColumnDef="job"><th mat-header-cell *matHeaderCellDef>Job</th><td mat-cell *matCellDef="let p" [title]="p.sample">{{ p.label }}</td></ng-container>
        <ng-container matColumnDef="count"><th mat-header-cell *matHeaderCellDef class="num">Procs</th>
          <td mat-cell *matCellDef="let p" class="num">{{ p.count }}@if (p.stopped) { <span class="pill queued">{{ p.stopped }} paused</span>}</td></ng-container>
        <ng-container matColumnDef="cpu"><th mat-header-cell *matHeaderCellDef class="num">CPU</th><td mat-cell *matCellDef="let p" class="num">{{ p.cpu }}</td></ng-container>
        <ng-container matColumnDef="age"><th mat-header-cell *matHeaderCellDef class="num">Running for</th><td mat-cell *matCellDef="let p" class="num">{{ p.age }}</td></ng-container>
        <tr mat-header-row *matHeaderRowDef="procCols"></tr>
        <tr mat-row *matRowDef="let row; columns: procCols"></tr>
        <tr class="mat-mdc-no-data-row" *matNoDataRow><td class="muted" colspan="5">nothing watched is running</td></tr>
      </table>
    </div>
    <h2 style="margin-top:14px">Connected machines</h2>
    <div class="scroll">
      <table mat-table id="peers" [dataSource]="v().peers">
        <ng-container matColumnDef="ip"><th mat-header-cell *matHeaderCellDef>Address</th>
          <td mat-cell *matCellDef="let p" class="mono">{{ p.ip }} <span class="muted">{{ p.name }}</span></td></ng-container>
        <ng-container matColumnDef="sv"><th mat-header-cell *matHeaderCellDef>Services</th><td mat-cell *matCellDef="let p">{{ p.sv }}</td></ng-container>
        <tr mat-header-row *matHeaderRowDef="peerCols"></tr>
        <tr mat-row *matRowDef="let row; columns: peerCols"></tr>
      </table>
    </div>`,
})
export class Procs {
  private readonly store = inject(DashboardStore);
  protected readonly procCols = ['host', 'job', 'count', 'cpu', 'age'];
  protected readonly peerCols = ['ip', 'sv'];

  protected readonly v = computed(() => {
    const s = this.store.state() || {};
    const LABEL: Record<string, string> = { rsync: t('rsync (Step A: {node} → {main})'), 'catalog.py': 'catalog.py scan', mkfs: 'mkfs', immich: 'Immich', mysqld: 'MySQL',
      smbd: 'Samba', photorec: 'PhotoRec (carving)', ddrescue: 'ddrescue (imaging)', zeromap: 'zeromap.py (zero-scan)', sshfs: t('sshfs (output to {main})') };
    const both: [string, any][] = [[SITE.main, s.fast || {}], [SITE.node, (s.remote || {}).fast || {}]];
    return {
      procs: both.flatMap(([host, F]) => Object.entries(F.procs || {}).map(([k, v]: [string, any]) =>
        ({ host, label: LABEL[k] || k, sample: v.sample, count: v.count, stopped: v.stopped, cpu: v.cpu.toFixed(0) + '%', age: dur(v.oldest_s) }))),
      peers: Object.entries((s.fast || {}).peers || {}).map(([ip, sv]: [string, any]) => ({ ip, name: SITE.peers[ip] || '', sv: sv.join(', ') })),
    };
  });
}
