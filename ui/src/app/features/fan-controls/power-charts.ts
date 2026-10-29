import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TrackChart } from '../../shared/charts/track-chart';
import { ChartsView } from './fan-controls.model';

/** Total power vs the Adaptive line, the power scaler's caps, and (Low Power only, via CSS) PSU input voltage. */
@Component({
  selector: 'app-power-charts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrackChart],
  template: ` @let c = charts();
    <div class="power-hi" id="ctl-power">
      <div class="legend" id="leg-power-hi">
        <span
          ><i style="background:var(--s1)"></i>Total (both servers) <b>{{ c.legTotal }}</b></span
        ><span
          ><i style="background:var(--t6)"></i>Peak <b>{{ c.legPeak }}</b
          ><span class="muted"> (iDRAC, sub-second)</span></span
        ><span class="muted">Adaptive line {{ c.line }} W</span>
      </div>
      <app-track-chart [opts]="c.powerHi" />
    </div>
    <div class="throttle-chart" id="ctl-throttle">
      <div class="legend" id="leg-throttle">
        <span
          ><b>Throttling by the power scaler</b> (caps it sets to hold the line; normal cap when
          none)</span
        >
        @for (e of c.guardEv; track $index) {
          <span [title]="e.tip"
            >{{ e.at }} <b>{{ e.lab }}</b> {{ e.what }}</span
          >
        } @empty {
          <span class="muted">no cap changes in this window</span>
        }
      </div>
      <app-track-chart [opts]="c.throttle" />
    </div>
    <div class="volt-chart" id="ctl-volt">
      <div class="legend" id="leg-volt">
        @for (p of c.psus; track p.l) {
          <span
            ><i [style]="p.key"></i>{{ p.l }} <b>{{ p.v }}</b
            ><span [class]="p.warn ? 'warnc' : 'muted'"> {{ p.note }}</span></span
          >
        }
      </div>
      <app-track-chart [opts]="c.volt" />
    </div>`,
})
export class PowerCharts {
  readonly charts = input.required<ChartsView>();
}
