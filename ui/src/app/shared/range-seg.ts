import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DashboardStore } from '../core/dashboard.store';
import { RANGES } from './format';

/** "All graphs" time range buttons (one shared range for every chart). */
@Component({
  selector: 'app-range-seg',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'grange' },
  template: `<span class="sub">All graphs</span>
    <div class="seg ranges" role="group" aria-label="Time range for all graphs">
      @for (r of RANGES; track r[0]) {
        <button [attr.aria-pressed]="store.range() === r[0]" (click)="store.setRange(r[0])">
          {{ r[1] }}
        </button>
      }
    </div>`,
})
export class RangeSeg {
  protected readonly store = inject(DashboardStore);
  protected readonly RANGES = RANGES;
}
