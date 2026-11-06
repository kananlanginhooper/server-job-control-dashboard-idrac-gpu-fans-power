import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { BoardLayout, GAP, MIN_HEIGHT, ROW, TILE_LABELS } from '../../core/layout/board-layout';

const INTERACTIVE = 'button, a, input, textarea, select, label, [role=button], mat-button-toggle';
/** pointer travel before a press on a title turns into a move */
const SLOP = 5;
/** px from the window's top or bottom edge where a drag scrolls the page */
const EDGE = 60;

/**
 * One card on the board. Move it by its title (mouse) or the handle on its top edge (any pointer, or arrow keys);
 * resize it from its lower-right corner, double-click the corner to reset it.
 */
@Component({
  selector: 'app-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tile-body" [style.height.px]="height()">
      <div class="tile-content" #content><ng-content /></div>
    </div>
    @if (editable()) {
      <button
        class="tile-grab"
        type="button"
        [attr.aria-label]="'Move ' + name() + ' (arrow keys)'"
        [title]="'Drag to move ' + name()"
        (pointerdown)="press($event, true)"
        (keydown)="key($event)"
      ></button>
      <span
        class="tile-corner"
        aria-hidden="true"
        title="Drag to resize · double-click to reset"
        (pointerdown)="startResize($event)"
        (dblclick)="layout.resetTile(tileKey())"
      ></span>
    }
  `,
  host: {
    '[attr.data-tile]': 'tileKey()',
    '[style.order]': 'layout.orderOf(tileKey())',
    '[style.grid-column]': '"span " + span()',
    '[style.grid-row]': '"span " + rows()',
    '[class.sized]': 'height() != null',
    '[class.vacant]': 'vacant()',
    '[class.hidden]': 'layout.isHidden(tileKey())',
    '[class.moving]': 'layout.moving()?.key === tileKey()',
    '[class.resizing]': 'layout.resizing() === tileKey()',
    '(pointerdown)': 'titleDown($event)',
  },
})
export class Tile {
  readonly tileKey = input.required<string>();
  readonly name = computed(() => TILE_LABELS[this.tileKey()] ?? this.tileKey());

  readonly layout = inject(BoardLayout);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly contentRef = viewChild.required<ElementRef<HTMLElement>>('content');
  private readonly measured = signal(0);

  readonly editable = computed(() => this.layout.band() !== 'stack');
  readonly span = computed(() =>
    Math.min(this.layout.cols(), this.layout.sizeOf(this.tileKey()).w),
  );
  readonly height = computed(() => (this.editable() ? this.layout.sizeOf(this.tileKey()).h : null));
  /** nothing to show right now (Live hardware without its data source): takes no room, even when sized */
  readonly vacant = computed(() => this.measured() === 0);
  /** grid rows of ROW px; the tile's bottom padding is the gap to the next card */
  readonly rows = computed(() =>
    this.vacant() ? 1 : Math.ceil(((this.height() ?? this.measured()) + GAP) / ROW),
  );

  private stop?: () => void;

  constructor() {
    const ro = new ResizeObserver(([e]) => this.measured.set(Math.ceil(e.contentRect.height)));
    afterNextRender(() => ro.observe(this.contentRef().nativeElement));
    inject(DestroyRef).onDestroy(() => {
      ro.disconnect();
      this.stop?.();
    });
  }

  /** a mouse press on the card's title (h2) starts a move; buttons and fields inside keep working */
  titleDown(e: PointerEvent) {
    const t = e.target as HTMLElement;
    if (e.pointerType === 'touch' || !t.closest('h2, .h2row')) return;
    if (t.closest(INTERACTIVE)) return;
    this.press(e, false);
  }

  press(e: PointerEvent, handle: boolean) {
    if (!this.editable() || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX,
      y0 = e.clientY;
    // the app renders in a shadow root: hit-test inside it, not on the outer document
    const root = this.host.getRootNode() as Document | ShadowRoot;
    let started = false;
    let last: string | null = null;
    let px = x0,
      py = y0;
    const hit = () => {
      const over = root
        .elementFromPoint(px, py)
        ?.closest<HTMLElement>('app-tile')
        ?.getAttribute('data-tile');
      if (!over || over === this.tileKey()) {
        last = null;
      } else if (over !== last) {
        // only once per card entered, so two cards of different sizes don't keep swapping
        last = over;
        this.layout.move(this.tileKey(), over);
      }
    };
    // the page is long: holding the pointer near the top or bottom edge scrolls it, so a card can go anywhere
    const scroller = setInterval(() => {
      if (!started) return;
      const dy = py < EDGE ? -1 : py > innerHeight - EDGE ? 1 : 0;
      if (!dy) return;
      window.scrollBy(0, dy * 24);
      hit();
    }, 30);
    this.track(
      (m) => {
        if (!started) {
          if (!handle && Math.hypot(m.clientX - x0, m.clientY - y0) < SLOP) return;
          started = true;
        }
        px = m.clientX;
        py = m.clientY;
        this.layout.moving.set({ key: this.tileKey(), label: this.name(), x: px, y: py });
        hit();
      },
      () => {
        clearInterval(scroller);
        this.layout.moving.set(null);
        if (started) this.layout.persist();
      },
    );
  }

  /** arrow keys on the handle move the card one place */
  key(e: KeyboardEvent) {
    const step = (
      { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 } as Record<string, number>
    )[e.key];
    if (!step) return;
    e.preventDefault();
    const order = this.layout.current().order;
    const target = order[order.indexOf(this.tileKey()) + step];
    if (!target) return;
    this.layout.move(this.tileKey(), target);
    this.layout.persist();
  }

  startResize(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cols = this.layout.cols();
    const boardW = this.host.parentElement?.clientWidth ?? 0;
    const colW = (boardW - GAP * (cols - 1)) / cols;
    const w0 = this.span();
    const px0 = w0 * colW + (w0 - 1) * GAP;
    const h0 = this.height() ?? this.measured();
    this.layout.resizing.set(this.tileKey());
    let size = { w: w0, h: this.height() };
    this.track(
      (m) => {
        const w = Math.round((px0 + m.clientX - e.clientX + GAP) / (colW + GAP));
        const h = Math.round((h0 + m.clientY - e.clientY) / ROW) * ROW;
        size = { w: Math.min(cols, Math.max(1, w)), h: Math.max(MIN_HEIGHT, h) };
        this.layout.resize(this.tileKey(), size, false);
      },
      () => {
        this.layout.resizing.set(null);
        this.layout.resize(this.tileKey(), size, true);
      },
    );
  }

  private track(move: (e: PointerEvent) => void, end: () => void) {
    this.stop?.();
    const up = () => {
      this.stop?.();
      end();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    this.stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      this.stop = undefined;
    };
  }
}
