import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** One stat tile: label, big value, small line under it; c = 'warn' | 'bad' colors it, tip is the hover text. */
export interface Kpi { l: string; v: string; sub: string; c?: string; tip?: string; }

/** A row of stat tiles (the "kpis" grid on server and GPU cards). */
@Component({
  selector: 'app-kpi-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'kpis' },
  template: `
    @for (k of kpis(); track $index) {
      <div class="kpi {{ k.c || '' }}" [attr.title]="k.tip || null"><div class="l">{{ k.l }}</div><div class="v">{{ k.v }}</div><div class="l">{{ k.sub }}</div></div>
    }`,
})
export class KpiRow {
  readonly kpis = input.required<Kpi[]>();
}
