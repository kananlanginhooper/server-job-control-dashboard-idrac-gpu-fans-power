import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { DashboardStore } from '../../dashboard.store';
import { SITE } from '../../site';
import { chartsView, controlsView } from './fan-controls.model';
import { HostStatusView } from './host-status';
import { ControlToggles } from './control-toggles';
import { RunProfile } from './run-profile';
import { PowerCharts } from './power-charts';

/** Fan & quiet controls card: reads the store, lays out the status, controls and power charts. */
@Component({
  selector: '[app-fan-controls]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HostStatusView, ControlToggles, RunProfile, PowerCharts],
  templateUrl: './fan-controls.html',
})
export class FanControls {
  protected readonly S = SITE;
  protected readonly store = inject(DashboardStore);

  protected readonly v = computed(() => { const s = this.store.state(); return s ? controlsView(s) : null; });
  protected readonly charts = computed(() => {
    const s = this.store.state();
    return s ? chartsView(s, this.store.series(), this.store.guard(), this.store.range(), this.store.rangeLabel()) : null;
  });

  constructor() {
    // PSU input voltage shows only in Low Power or Meeting Mode: .show-volt on the app host drives the CSS
    effect(() => { const v = this.v(); this.store.showVolt.set(!!(v && v.lowOn)); });
  }
}
