import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatTooltip } from '@angular/material/tooltip';
import { HostStatus } from './fan-controls.model';

/** One server's fan-control state: name, mode pill and fan %; hover for what is driving the fans. */
@Component({
  selector: 'app-host-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTooltip],
  template: `
    <div class="fhost" [matTooltip]="st().tip" matTooltipClass="pre-tip" style="cursor:help">
      <span class="fhn">{{ name() }}</span>
      <span class="fmode m-{{ st().k }}" [matTooltip]="st().modeTip">{{ st().label }}</span>
      @if (st().pct != null) { <span class="fpct">fans {{ st().pct }}% <span class="muted">ⓘ</span></span> }
    </div>`,
})
export class HostStatusView {
  readonly name = input.required<string>();
  readonly st = input.required<HostStatus>();
}
