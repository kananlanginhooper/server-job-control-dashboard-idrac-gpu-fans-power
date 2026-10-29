import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LineChart } from './charts/line-chart';
import { TrackChart } from './charts/track-chart';
import { LineOpts, TrackOpts } from './charts/chart-types';
import { Legend, LegendItem } from './legend';

/** A titled chart in a card grid: heading (+ muted note), legend, then a line chart or a track chart. */
@Component({
  selector: 'app-chart-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LineChart, TrackChart, Legend],
  host: { class: 'srvchart' },
  template: `
    <h4 class="srvh">{{ title() }}@if (note()) { <span class="muted">{{ note() }}</span>}</h4>
    @if (legend(); as l) { <app-legend [items]="l" /> }
    @if (line(); as o) { <app-line-chart [opts]="o" /> }
    @if (track(); as o) { <app-track-chart [opts]="o" /> }`,
})
export class ChartTile {
  readonly title = input.required<string>();
  readonly note = input('');
  readonly legend = input<LegendItem[] | null>(null);
  readonly line = input<LineOpts | null>(null);
  readonly track = input<TrackOpts | null>(null);
}
