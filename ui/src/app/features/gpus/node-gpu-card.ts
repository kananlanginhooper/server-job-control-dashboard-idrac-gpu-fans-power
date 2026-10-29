import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SITE } from '../../core/site';
import { KpiRow } from '../../shared/kpi-row';
import { ChartTile } from '../../shared/chart-tile';
import { NodeGpuView } from './gpus.model';

/** The GPU node's card: KPIs (with one per job feed), power + tokens/s, memory, and a chart per GPU job. */
@Component({
  selector: 'app-node-gpu-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KpiRow, ChartTile],
  host: { class: 'server', '[class.srv-red]': 'v().hot' },
  template: ` @let g = v();
    <h3>
      {{ S.nodeGpu }} <span class="pill done">live</span>
      @if (g.hot) {
        <span class="pill failed">1 red</span>
      }
      <span class="role"
        >in {{ S.node }} · <span id="gpu-src">{{ g.src }}</span></span
      >
    </h3>
    <app-kpi-row [kpis]="g.kpis" />
    <div class="srvgrid">
      @for (c of g.charts; track c.id) {
        <app-chart-tile [title]="c.title" [legend]="c.legend" [line]="c.opts" />
      }
      @for (j of g.jobs; track j.key) {
        <app-chart-tile [title]="j.title" [legend]="j.legend" [line]="j.opts" />
      }
    </div>`,
})
export class NodeGpuCard {
  protected readonly S = SITE;
  readonly v = input.required<NodeGpuView>();
}
