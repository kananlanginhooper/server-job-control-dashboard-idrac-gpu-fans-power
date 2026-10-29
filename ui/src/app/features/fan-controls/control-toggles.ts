import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatTooltip } from '@angular/material/tooltip';
import { TIPS } from './fan-controls.model';

/** Quick Cool, Meeting Mode and the GPU switch: each button shows On/Off and flips it (live controls). */
@Component({
  selector: 'app-control-toggles',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButton, MatTooltip],
  template: `
    <div class="row">
      <button id="qc-btn" [matButton]="qc() ? 'filled' : 'outlined'" [attr.aria-pressed]="qc()" [disabled]="busy().qc"
              [matTooltip]="T.QC_TIP" (click)="quickCool.emit()">Quick Cool <b>{{ qc() ? 'On' : 'Off' }}</b></button>
      <button id="meeting-btn" [matButton]="meeting() ? 'filled' : 'outlined'" [attr.aria-pressed]="meeting()" [disabled]="busy().meeting"
              [matTooltip]="T.MT_TIP" (click)="meetingMode.emit()">Meeting Mode <b>{{ meeting() ? 'On' : 'Off' }}</b></button>
      <button id="gpu-btn" [matButton]="gpuOff() ? 'filled' : 'outlined'" [attr.aria-pressed]="gpuOff()" [disabled]="busy().gpu"
              [matTooltip]="T.GPU_TIP" (click)="gpu.emit()">Disable GPU <b>{{ gpuOff() ? 'On' : 'Off' }}</b></button>
    </div>`,
})
export class ControlToggles {
  protected readonly T = TIPS;
  readonly qc = input.required<boolean>();
  readonly meeting = input.required<boolean>();
  readonly gpuOff = input.required<boolean>();
  readonly busy = input.required<{ qc: boolean; meeting: boolean; gpu: boolean }>();
  readonly quickCool = output();
  readonly meetingMode = output();
  readonly gpu = output();
}
