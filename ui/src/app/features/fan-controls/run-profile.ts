import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { MatTooltip } from '@angular/material/tooltip';
import { RunProfileButton, TIPS } from './fan-controls.model';

/** Run profile for both servers (Low Power / Adaptive 1, 1.25, 1.5 kW / Unattended). Changes only on a click. */
@Component({
  selector: 'app-run-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonToggleGroup, MatButtonToggle, MatTooltip],
  template: ` <div class="row">
    <span class="muted">Run profile</span>
    <mat-button-toggle-group
      hideSingleSelectionIndicator
      [value]="current()"
      [disabled]="busy()"
      [matTooltip]="T.RP_TIP"
      aria-label="Run profile"
    >
      @for (b of buttons(); track b.label) {
        <mat-button-toggle class="rp-btn" [value]="b.label" (change)="pick(b)">{{
          b.label
        }}</mat-button-toggle>
      }
    </mat-button-toggle-group>
    @for (w of warn(); track $index) {
      <span class="warnc">{{ w }}</span>
    }
    @if (override()) {
      <span class="muted">{{ override() }}</span>
    }
  </div>`,
})
export class RunProfile {
  protected readonly T = TIPS;
  readonly buttons = input.required<RunProfileButton[]>();
  readonly warn = input<string[]>([]);
  readonly override = input('');
  readonly busy = input(false);
  readonly choose = output<{ p: string; w?: number }>();
  protected readonly current = computed(() => this.buttons().find((b) => b.cur)?.label ?? null);
  private readonly group = viewChild.required(MatButtonToggleGroup);

  /** The toggle's own change fires on every click, so re-clicking the highlighted profile re-applies it
   *  (fixes "fan-control is running X, not Y"); the group's change would skip that. */
  protected pick(b: RunProfileButton) {
    this.choose.emit({ p: b.p, w: b.w });
    this.group().value = this.current(); // the highlight follows what the servers report, not the click
  }
}
