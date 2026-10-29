import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../../core/dashboard.store';
import { RangeSeg } from '../../shared/range-seg';
import { ServerCard } from './server-card';
import { serversView } from './servers.model';

/** "Servers now": one card per machine, with the shared time-range selector. */
@Component({
  selector: '[app-servers]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ServerCard, RangeSeg],
  template: ` <div class="h2row">
      <h2>Servers now</h2>
      <app-range-seg />
    </div>
    <div class="servers" id="servers">
      @for (sv of servers(); track sv.name) {
        <app-server-card [sv]="sv" />
      }
    </div>`,
})
export class Servers {
  private readonly store = inject(DashboardStore);
  protected readonly servers = computed(() => {
    const s = this.store.state();
    return s
      ? serversView(s, {
          limits: this.store.limits(),
          range: this.store.range(),
          th: this.store.th(),
          ioh: this.store.ioh(),
        })
      : [];
  });
}
