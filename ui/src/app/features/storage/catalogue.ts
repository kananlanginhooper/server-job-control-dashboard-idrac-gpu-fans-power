/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { DashboardStore } from '../../core/dashboard.store';
import { fb, num } from '../../shared/format';

/** Catalogue database (MySQL recovery): every table, largest first, plus the catalog.py scan log. */
@Component({
  selector: '[app-catalogue]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTableModule],
  template: ` <div class="h2row">
      <h2>Catalogue database (MySQL <span class="mono">recovery</span>)</h2>
      <span class="muted" id="tables-sub">{{ v().sub }}</span>
    </div>
    <p class="sub" style="margin-top:0">
      Every table in the recovery catalogue with its approximate row count and size on disk, largest
      first. This is the database the pipeline threads write their results to.
    </p>
    <div class="scroll" style="max-height:300px;overflow-y:auto">
      <table mat-table id="tables" [dataSource]="v().rows">
        <ng-container matColumnDef="name"
          ><th mat-header-cell *matHeaderCellDef>Table</th>
          <td mat-cell *matCellDef="let r" class="mono">{{ r.name }}</td></ng-container
        >
        <ng-container matColumnDef="rows"
          ><th mat-header-cell *matHeaderCellDef class="num">Rows (est.)</th>
          <td mat-cell *matCellDef="let r" class="num">{{ r.rows }}</td></ng-container
        >
        <ng-container matColumnDef="size"
          ><th mat-header-cell *matHeaderCellDef class="num">Size</th>
          <td mat-cell *matCellDef="let r" class="num">{{ r.size }}</td></ng-container
        >
        <tr mat-header-row *matHeaderRowDef="cols"></tr>
        <tr mat-row *matRowDef="let row; columns: cols"></tr>
      </table>
    </div>
    <h2 style="margin-top:14px">catalog.py scan log</h2>
    <div class="log" id="scanlog" style="max-height:180px;overflow-y:auto">{{ v().log }}</div>`,
})
export class Catalogue {
  private readonly store = inject(DashboardStore);
  protected readonly cols = ['name', 'rows', 'size'];

  protected readonly v = computed(() => {
    const s = this.store.state() || {};
    const tbs = ((s.db || {}).tables || [])
      .slice()
      .sort((a: any, b: any) => (b.bytes || 0) - (a.bytes || 0));
    const tot = tbs.reduce((n: number, x: any) => n + (x.bytes || 0), 0);
    return {
      sub: s.db ? `${tbs.length} tables · ${fb(tot)} on disk` : '',
      rows: tbs.map((x: any) => ({
        name: x.TABLE_NAME || x.table_name,
        rows: num(x.TABLE_ROWS ?? x.table_rows),
        size: fb(x.bytes),
      })),
      log: ((s.slow || {}).scan_log || []).join('\n') || 'no log',
    };
  });
}
