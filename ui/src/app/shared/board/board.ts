import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject } from '@angular/core';
import { BoardLayout, bandFor } from '../../core/layout/board-layout';

/**
 * The grid the cards sit in. Its width picks the band (phone stack, standard, wide, very wide) and with it the column
 * count; cards are placed by CSS order and spans, so moving one never re-creates it (charts keep their state).
 * Styles: app-board / app-tile in styles.css (the app renders in a shadow root with one stylesheet).
 */
@Component({
  selector: 'app-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-content />
    @if (layout.moving(); as m) {
      <div class="board-chip" [style.left.px]="m.x + 14" [style.top.px]="m.y + 12">
        {{ m.label }}
      </div>
    }
  `,
  host: {
    '[style.grid-template-columns]': '"repeat(" + layout.cols() + ", minmax(0, 1fr))"',
    '[class.stack]': 'layout.band() === "stack"',
    '[class.busy]': '!!layout.moving()',
    '[class.sizing]': '!!layout.resizing()',
  },
})
export class Board {
  readonly layout = inject(BoardLayout);

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const ro = new ResizeObserver(([e]) => this.layout.band.set(bandFor(e.contentRect.width)));
    ro.observe(el);
    inject(DestroyRef).onDestroy(() => ro.disconnect());
  }
}
