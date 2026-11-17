import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { GridItemHTMLElement, GridStack } from 'gridstack';
import { BoardLayout, CELL, COLUMNS, Item, STACK_BELOW } from '../../core/layout/board-layout';

/**
 * The movable, resizable card grid (owner 2026-11-06), by gridstack (MIT, gridstack.js). Angular renders the cards as
 * .grid-stack-item children of this element; gridstack only positions them. 3 columns (owner 2026-11-16): drag a card
 * from anywhere on it into any column, under another card too ('top' mode: cards rise into free space above them but
 * keep their column; a dashed placeholder shows where it lands). Resize snaps to 1-3 columns; the side edges change
 * only the width (the card still fits its content), the corner also fixes the height (capped at the window's).
 * Below STACK_BELOW px the grid is one column and nothing moves; widening again re-applies the saved view, so
 * narrowing and widening the window never reshuffles it.
 * gridstack's CSS is imported in styles.css (the app renders in a shadow root with one stylesheet).
 */
/** px from the window's top or bottom edge where a drag scrolls the page */
const EDGE = 50;
/** a press on these starts no drag: they keep their own clicks, selection and scrolling */
const DRAG_CANCEL =
  'button, a, input, textarea, select, label, [role=button], mat-button-toggle, table, pre, code, .seg, .views-panel';

@Directive({ selector: '[appBoard]' })
export class Board {
  private readonly layout = inject(BoardLayout);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private grid?: GridStack;

  constructor() {
    const destroy = inject(DestroyRef);
    afterNextRender(() => {
      const grid = (this.grid = GridStack.init(
        {
          column: COLUMNS,
          cellHeight: CELL,
          margin: 8,
          mode: 'top',
          sizeToContent: true,
          animate: true,
          // the whole card is the handle; pressing a control, a link, a table or a field does what it did before
          draggable: { cancel: DRAG_CANCEL },
          resizable: { handles: 'e,se,w' },
          // above the last breakpoint gridstack uses columnMax (default 12), not 'column'
          columnOpts: {
            columnMax: COLUMNS,
            breakpoints: [{ w: STACK_BELOW, c: 1 }],
            layout: 'list',
          },
        },
        this.el,
      )!);
      this.apply();
      // a card resized by its corner stops fitting its content and keeps the height it's given (gridstack only lets a
      // fitted card change width); the side edges keep it fitting. On the press itself: by gridstack's 'resizestart'
      // event it has already locked the height.
      const unfit = (e: Event) => {
        const t = e.target as HTMLElement;
        if (!t.classList?.contains('ui-resizable-se')) return;
        const item = t.closest<GridItemHTMLElement>('.grid-stack-item');
        if (item?.gridstackNode) item.gridstackNode.sizeToContent = false;
        item?.classList.remove('size-to-content');
      };
      this.el.addEventListener('pointerdown', unfit, true);
      this.el.addEventListener('mousedown', unfit, true);
      this.el.addEventListener('touchstart', unfit, true);
      grid.on('resizestop', () => this.save());
      // the page is long and the grip sits at the card's top, which gridstack's own autoscroll (it scrolls by how far
      // the card is clipped) barely moves upward: with the pointer near the window's top or bottom edge, scroll
      // steadily, then replay the pointer so the placeholder follows
      let px = 0,
        py = 0,
        scroller = 0;
      const track = (e: MouseEvent) => {
        if (e.isTrusted) [px, py] = [e.clientX, e.clientY];
      };
      grid.on('dragstart', () => {
        document.addEventListener('mousemove', track, true);
        scroller = window.setInterval(() => {
          const dy = py < EDGE ? -1 : py > innerHeight - EDGE ? 1 : 0;
          if (!dy || !py) return;
          window.scrollBy(0, dy * 28);
          document.dispatchEvent(
            new MouseEvent('mousemove', { clientX: px, clientY: py, bubbles: true }),
          );
        }, 30);
      });
      grid.on('dragstop', () => {
        document.removeEventListener('mousemove', track, true);
        clearInterval(scroller);
      });
      grid.on('dragstop', () => this.save());
      // cards change height as their data arrives: refit those that size to content
      const ro = new ResizeObserver((entries) => {
        for (const e of entries) {
          const item = e.target.closest<GridItemHTMLElement>('.grid-stack-item');
          if (item?.gridstackNode?.sizeToContent) grid.resizeToContent(item);
        }
      });
      this.el
        .querySelectorAll('.grid-stack-item-content > :first-child')
        .forEach((c) => ro.observe(c));
      // after gridstack has switched its column count for the new width
      let t = 0;
      const fit = () => {
        clearTimeout(t);
        t = window.setTimeout(() => this.fit(), 150);
      };
      window.addEventListener('resize', fit);
      destroy.onDestroy(() => {
        ro.disconnect();
        clearTimeout(t);
        window.removeEventListener('resize', fit);
        grid.destroy(false);
      });
    });
    // a view switch, reset or load lays the cards out again
    effect(() => {
      this.layout.applied();
      untracked(() => this.grid && this.apply());
    });
  }

  /** the active view onto the grid: each card's column, row and width (and a corner-set height) */
  private apply() {
    const items = [...this.layout.items()].sort(
      (a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0),
    );
    this.grid!.load(
      items.map((it) => ({
        id: it.id,
        x: it.x ?? 0,
        y: it.y ?? 0,
        w: it.w,
        ...(it.h ? { h: it.h, sizeToContent: false } : { sizeToContent: true }),
      })),
      false,
    );
    this.fit();
  }

  /** caps every card at the window's height, and locks moving and resizing in the one-column phone layout */
  private fit() {
    const grid = this.grid;
    if (!grid) return;
    const maxH = Math.max(10, Math.floor((window.innerHeight - 120) / CELL));
    for (const el of grid.getGridItems()) {
      const n = el.gridstackNode!;
      if (n.maxH !== maxH)
        grid.update(el, { maxH, ...(n.h && n.h > maxH && !n.sizeToContent ? { h: maxH } : {}) });
      if (n.sizeToContent) grid.resizeToContent(el);
    }
    const stacked = grid.getColumn() !== COLUMNS;
    const was = this.layout.stacked();
    this.layout.stacked.set(stacked);
    grid.setStatic(stacked);
    // back to full width: lay out the saved view again, rather than gridstack's guess from the one-column order
    if (was && !stacked) this.apply();
  }

  private save() {
    if (this.grid!.getColumn() !== COLUMNS) return; // the phone's one-column stack is never saved
    const nodes = this.grid!.getGridItems()
      .map((el) => el.gridstackNode!)
      .sort((a, b) => a.y! - b.y! || a.x! - b.x!);
    this.layout.saveItems(
      nodes.map(
        (n) =>
          ({
            id: String(n.id),
            x: n.x,
            y: n.y,
            w: n.w!,
            ...(n.sizeToContent ? {} : { h: n.h }),
          }) as Item,
      ),
    );
    this.layout.persist(false);
  }
}
