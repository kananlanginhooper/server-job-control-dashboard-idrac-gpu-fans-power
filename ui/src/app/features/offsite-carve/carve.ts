import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../../core/dashboard.store';
import { SITE } from '../../core/site';
import { Bar } from '../../shared/bar';
import { carveView } from './offsite-carve.model';

/** Carve · GPU node evidence drives: per loop, verified % and the assumed (unverified) regions, never summed. */
@Component({
  selector: '[app-carve]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Bar],
  template: `
    <div class="h2row"><h2>Carve · {{ S.node }} evidence drives</h2><span class="muted" id="carve-sub">{{ v().sub }}</span></div>
    <div class="jobwrap"><table id="carve-drives"><thead><tr><th>Loop</th><th>Status</th><th class="prog">Verified</th><th>Assumed (not verified)</th><th class="num">ETA</th></tr></thead><tbody>
      @for (r of v().rows; track r.k) {
        <tr><td class="mono">{{ r.k }} <span class="muted">{{ r.device }}</span></td>
          <td><span class="pill {{ r.pill }}">{{ r.status }}</span>@if (r.photorec) { <span class="muted">{{ r.photorec }} photorec</span>}</td>
          <td class="prog"><app-bar [frac]="r.pct / 100" [cls]="r.pct >= 99.9 ? 'ok' : ''" /><div class="muted jd"><b>{{ r.pct.toFixed(1) }}% verified</b> · {{ r.done }} of {{ r.total }}</div></td>
          <td class="muted jd">{{ r.assumed }}</td><td class="num">{{ r.eta }}</td></tr>
      } @empty { <tr><td colspan="5" class="muted">no carve progress feed (/c/{{ S.node }}-prior/ram-carve-progress.json)</td></tr> }
    </tbody></table></div>
    <p class="sub">From 1a's <span class="mono">ram-carve-progress.json</span> ({{ S.node }} /dev/shm, copied to {{ S.main }} /c/{{ S.node }}-prior/). "Verified" is each loop's own confirmed coverage; "assumed" is a region excluded because another pass was assumed to cover it, shown separately and never added in.</p>`,
})
export class Carve {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly v = computed(() => carveView(this.store.state()));
}
