import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Progress bar: same markup as bar(frac, cls) in the original page. */
@Component({
  selector: 'app-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display:block' },
  template: `<div class="bar {{ cls() }}"><i [style.width.%]="pct()"></i></div>`,
})
export class Bar {
  readonly frac = input<number | null | undefined>(0);
  readonly cls = input('');
  protected readonly pct = computed(() => +(Math.max(0, Math.min(1, this.frac() || 0)) * 100).toFixed(1));
}
