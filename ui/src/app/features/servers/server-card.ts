import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { KpiRow } from '../../shared/kpi-row';
import { ChartTile } from '../../shared/chart-tile';
import { CoolChips } from './cool-chips';
import { ServerCardView } from './servers.model';

/** One machine: name, live/offline, red count, role line, KPIs, thermal chips and its four charts. */
@Component({
  selector: 'app-server-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KpiRow, ChartTile, CoolChips],
  host: { class: 'server', '[class.srv-red]': 'sv().hot' },
  template: `
    @let sv = this.sv();
    <h3>{{ sv.name }} <span class="pill {{ sv.ok ? 'done' : 'failed' }}">{{ sv.ok ? 'live' : 'offline' }}</span>@if (sv.hot) {<span class="pill failed" [title]="sv.hot + ' component(s) above their maximum operating temperature: hover the red chips'">{{ sv.hot }} red</span>}<span class="role">{{ sv.role }}</span></h3>
    @if (sv.err) { <p class="stale">{{ sv.err }}</p> }
    <app-kpi-row [kpis]="sv.kpis" />
    @if (sv.cool; as cool) { <app-cool-chips [cool]="cool" /> }
    <div class="srvgrid">
      <app-chart-tile title="Temperatures (every sensor, last 2 h max)" [legend]="sv.th?.legend ?? null" [line]="sv.th?.opts ?? null" />
      <app-chart-tile title="Network per NIC" note="(solid in, dashed out)" [legend]="sv.net?.legend ?? null" [line]="sv.net?.opts ?? null" />
      <app-chart-tile title="Disk activity per drive" note="(solid read, dashed write)" [legend]="sv.disk?.legend ?? null" [line]="sv.disk?.opts ?? null" />
      <app-chart-tile title="Memory: RAM used and RAM bandwidth" note="(bandwidth: solid read, dashed write)" [legend]="sv.mem?.legend ?? null" [track]="sv.mem?.opts ?? null" />
    </div>`,
})
export class ServerCard {
  readonly sv = input.required<ServerCardView>();
}
