import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { OffsiteBatch } from './offsite-carve.model';

/** Upload progress per push batch: name, %, bar, uploaded / left, files left. */
@Component({
  selector: 'app-batch-bars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h3>By batch</h3>
    @for (b of batches(); track b.name) {
      <div class="offb"><span class="n">{{ b.name }}</span><span class="m">{{ b.pct.toFixed(0) }}%</span>
        <div class="bar"><i [style.width.%]="+b.pct.toFixed(1)"></i></div>
        <span class="m">{{ b.up }} up · {{ b.left }} left</span><span class="m">{{ b.files }}</span></div>
    }`,
})
export class BatchBars {
  readonly batches = input.required<OffsiteBatch[]>();
}
