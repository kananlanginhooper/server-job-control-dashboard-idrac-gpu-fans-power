import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../../core/dashboard.store';
import { GpuCtx, boxGpuView, nodeGpuView } from './gpus.model';
import { BoxGpuCard } from './box-gpu-card';
import { NodeGpuCard } from './node-gpu-card';

/** "GPUs now": GPU cards above the server cards, the intake box's GPU first, then the GPU node's. */
@Component({
  selector: '[app-gpus]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoxGpuCard, NodeGpuCard],
  template: ` <div class="h2row"><h2>GPUs now</h2></div>
    <div class="gpus" id="gpus">
      @if (box(); as b) {
        <app-box-gpu-card [v]="b" />
      }
      @if (node(); as n) {
        <app-node-gpu-card [v]="n" />
      }
    </div>`,
})
export class Gpus {
  private readonly store = inject(DashboardStore);
  private readonly ctx = computed<GpuCtx>(() => ({
    range: this.store.range(),
    rangeLabel: this.store.rangeLabel(),
    limits: this.store.limits(),
    series: this.store.series(),
    ioh: this.store.ioh(),
  }));

  protected readonly box = computed(() => {
    const s = this.store.state();
    return s ? boxGpuView(s, this.ctx()) : null;
  });
  protected readonly node = computed(() => {
    const s = this.store.state();
    return s ? nodeGpuView(s, this.ctx()) : null;
  });
}
