import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../../core/dashboard.store';
import { LineChart } from '../../shared/charts/line-chart';
import { Legend } from '../../shared/legend';
import { KpiRow } from '../../shared/kpi-row';
import { BatchBars } from './batch-bars';
import { offsiteView } from './offsite-carve.model';

/** Offsite backup · Google Drive: rclone push progress, Google's 750 GB/day cap, Drive space. */
@Component({
  selector: '[app-offsite]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart, Legend, KpiRow, BatchBars],
  template: ` @let o = v();
    <div class="h2row">
      <h2>Offsite backup · Google Drive</h2>
      <span class="muted" id="off-sub">
        @if (!o) {
          waiting for the first scan (every 10 min)
        } @else {
          {{ o.sub }}
          @if (o.refusing) {
            <br /><span class="warnc">{{ o.refusing }}</span>
          }
        }
      </span>
    </div>
    @if (o) {
      <app-kpi-row id="off-kpis" [kpis]="o.kpis" />
      <div class="offgrid">
        <app-batch-bars id="off-bars" [batches]="o.batches" />
        <div>
          <h3>Uploaded vs left to push</h3>
          <app-legend [items]="o.legend" /><app-line-chart [opts]="o.chart" />
        </div>
      </div>
    }`,
})
export class Offsite {
  private readonly store = inject(DashboardStore);
  protected readonly v = computed(() =>
    offsiteView(
      this.store.state(),
      this.store.series(),
      this.store.range(),
      this.store.rangeLabel(),
    ),
  );
}
