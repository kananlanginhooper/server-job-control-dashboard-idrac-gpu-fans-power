import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** One legend entry: swatch style, name, bold value, then an optional note (muted by default). */
export interface LegendItem {
  sw?: string;
  name?: string;
  val?: string;
  note?: string;
  noteCls?: string;
  after?: string;
}

@Component({
  selector: 'app-legend',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'legend' },
  template: `@for (x of items(); track $index) {
      <span>
        @if (x.sw) {
          <i [style]="x.sw"></i>
        }
        {{ x.name }} <b>{{ x.val }}</b>
        @if (x.note) {
          <span [class]="x.noteCls ?? 'muted'">{{ x.note }}</span>
        }
        @if (x.after) {
          {{ x.after }}
        }
      </span>
    }
    <ng-content />`,
})
export class Legend {
  readonly items = input<LegendItem[]>([]);
}
