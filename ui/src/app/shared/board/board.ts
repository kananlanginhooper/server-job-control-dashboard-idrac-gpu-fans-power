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
 * .grid-stack-item children of this element; gridstack only positions them. 'list' mode keeps the cards in order and
 * reflows the rest while one is dragged (live placeholder); a card fits its content until it's resized by hand, and
 * its height is capped at the window's. Below STACK_BELOW px the grid is one column and nothing moves.
 * gridstack's CSS is imported in styles.css (the app renders in a shadow root with one stylesheet).
 */
/** px from the window's top or bottom edge where a drag scrolls the page */
const EDGE = 50;

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
          mode: 'list',
          sizeToContent: true,
          animate: true,
          handle: '.gs-grab',
          resizable: { handles: 'se,e' },
          columnOpts: { breakpoints: [{ w: STACK_BELOW, c: 1 }], layout: 'list' },
        },
        this.el,
      )!);
      this.apply();
      // a card being resized stops fitting its content (gridstack only lets a fitted card change width), and keeps
      // the height it's given; the rest still fit their content
      // (on the press itself: by gridstack's 'resizestart' event it has already locked the height)
      const unfit = (e: Event) => {
        const t = e.target as HTMLElement;
        if (!t.classList?.contains('ui-resizable-handle')) return;
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

  /** the active view onto the grid. 'list' mode packs the cards row by row in order, so a view is its cards' order,
   *  widths and hand-set heights; positions are given as that order and gridstack places each one. */
  private apply() {
    this.grid!.load(
      this.layout.items().map((it, i) => ({
        id: it.id,
        x: 0,
        y: i,
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
    const stacked = grid.getColumn() === 1;
    this.layout.stacked.set(stacked);
    grid.setStatic(stacked);
  }

  private save() {
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
