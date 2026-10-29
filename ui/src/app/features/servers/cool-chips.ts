import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { CoolView } from './servers.model';

/** A server's thermal chips: fans, board sensors, drives, GPU; hover a chip for its limits. */
@Component({
  selector: 'app-cool-chips',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'cool' },
  template: ` @for (r of cool().rows; track r.lbl) {
      <div class="chips">
        <span class="lbl">{{ r.lbl }}</span>
        @if (r.gpuName) {
          <span class="muted">{{ r.gpuName }}</span>
        }
        @for (c of r.chips; track $index) {
          <span class="chip {{ c.cls || '' }}" [attr.title]="c.title || null"
            >{{ c.name }} <b>{{ c.val }}</b></span
          >
        }
        @if (!r.chips.length && r.empty) {
          <span class="muted">{{ r.empty }}</span>
        }
        @if (r.note) {
          <span class="muted">{{ r.note }}</span>
        }
      </div>
    }
    @if (cool().err) {
      <div class="stale">{{ cool().err }}</div>
    }`,
})
export class CoolChips {
  readonly cool = input.required<CoolView>();
}
