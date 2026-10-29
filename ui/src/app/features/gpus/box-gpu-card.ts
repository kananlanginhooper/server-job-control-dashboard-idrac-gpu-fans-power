import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SITE } from '../../core/site';
import { KpiRow } from '../../shared/kpi-row';
import { ChartTile } from '../../shared/chart-tile';
import { BoxGpuView } from './gpus.model';

/** The intake box's GPU: live/offline, PCIe width, KPIs, power and memory charts. */
@Component({
  selector: 'app-box-gpu-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KpiRow, ChartTile],
  host: { class: 'server', '[class.srv-red]': 'v().hot' },
  template: ` @let g = v();
    <h3>
      {{ S.boxGpu }}
      <span class="pill {{ g.live ? 'done' : 'failed' }}">{{ g.live ? 'live' : 'offline' }}</span>
      @if (g.hot) {
        <span class="pill failed">1 red</span>
      }
      <span class="role"
        >in {{ S.Box }}
        @if (g.pcie) {
          · PCIe x{{ g.pcie }}
          @if (g.pcieMax) {
            <span class="warnc">(max x{{ g.pcieMax }})</span>
          }
        }
        · <span id="tgpu-src">{{ g.src }}</span></span
      >
    </h3>
    @if (!g.live) {
      <p class="stale" [title]="g.err">{{ g.offline }}</p>
    } @else {
      <app-kpi-row [kpis]="g.kpis" />
      <div class="srvgrid">
        @for (c of g.charts; track c.id) {
          <app-chart-tile [title]="c.title" [legend]="c.legend" [line]="c.opts" />
        }
      </div>
    }`,
})
export class BoxGpuCard {
  protected readonly S = SITE;
  readonly v = input.required<BoxGpuView>();
}
