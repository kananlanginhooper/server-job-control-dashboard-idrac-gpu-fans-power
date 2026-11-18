import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { GridItemHTMLElement, GridStack, GridStackNode } from 'gridstack';
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
/** height in px of the window's top and bottom bands where a drag scrolls the page (shown with an arrow) */
const EDGE = 64;
const ARROW = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
/** px the pointer must move from where a drag began before the edge zone scrolls (a card grabbed low doesn't) */
const ARM = 24;
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
          draggable: { cancel: DRAG_CANCEL, scroll: false }, // scrolling: see 'dragstart' below
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
      // Scrolling while dragging follows the pointer only (owner 2026-11-16: the page kept scrolling on its own).
      // gridstack's own autoscroll is off (draggable.scroll: false): it scrolls whenever the dragged card is clipped
      // by the window, and most cards here are about as tall as the window, so it ran on with the pointer still; and
      // as gridstack grows the grid under a card dragged low, the page kept getting longer. Here the page scrolls
      // only with the pointer inside the band shown at the window's top or bottom (owner 2026-11-17: an overlay with an
      // up and a down arrow; EDGE px tall, faster nearer the edge), only once the pointer has moved from where the drag
      // began, and never past the bottom of the other cards plus room to drop one. A band shows only while the page
      // can scroll that way. After each step the pointer is replayed so the placeholder follows.
      const band = (dir: 'up' | 'down', d: string) => {
        const z = document.createElement('div');
        z.className = `drag-zone drag-zone-${dir}`;
        z.style.height = `${EDGE}px`;
        z.setAttribute('aria-hidden', 'true');
        z.innerHTML = ARROW(d);
        return z;
      };
      const up = band('up', 'M5 15l7-7 7 7'),
        down = band('down', 'M5 9l7 7 7-7');
      // at the top level of the app's shadow root, so they sit over the sticky header and the dragged card
      const root = this.el.getRootNode() as ShadowRoot | Document;
      (root instanceof ShadowRoot ? root : document.body).append(up, down);
      // the top band starts under the sticky header; the pointer over the header also scrolls up (at full speed)
      let top = 0;
      let px = 0,
        py = 0,
        x0 = 0,
        y0 = 0,
        armed = false,
        floor = 0,
        scroller = 0;
      const track = (e: MouseEvent) => {
        if (!e.isTrusted) return;
        [px, py] = [e.clientX, e.clientY];
        if (!x0 && !y0) [x0, y0] = [px, py];
        armed ||= Math.hypot(px - x0, py - y0) > ARM;
      };
      // Where a dragged card lands follows the pointer (owner 2026-11-18: "it looks to be trying to fit the entire card
      // before snapping"). gridstack places by the dragged card's top-left corner and only passes another card once
      // the whole card's rectangle covers half of it, which with cards nearly a window tall is far from the pointer.
      // So a drag's placement step is replaced: the card goes in the column under the pointer (keeping the column of
      // the card that was grabbed), below every card in those columns whose middle is above the pointer and above
      // every one whose middle is below it; cards in its way move down, then everything rises into free space.
      let downX = 0,
        grabCol = 0;
      this.el.addEventListener('mousedown', (e) => (downX = e.clientX), true);
      type N = GridStackNode & { _dirty?: boolean; _lastUiPosition?: unknown };
      const g = grid as unknown as {
        _dragOrResize(el: HTMLElement, ev: Event, ui: { position: unknown }, n: N, cw: number, ch: number): void;
        _updateContainerHeight(): void;
        _writePosAttr(el: HTMLElement, n: N): void;
        engine: { nodes: N[]; _packNodes(): { _notify(): void } };
      };
      const place = g._dragOrResize.bind(grid);
      g._dragOrResize = (el, ev, ui, n, cw, ch) => {
        if (ev.type !== 'drag' || !(px || py)) return place(el, ev, ui, n, cw, ch);
        const w = n.w ?? 1;
        const box = this.el.getBoundingClientRect();
        const x = Math.max(0, Math.min(COLUMNS - w, Math.floor((px - box.left) / cw) - grabCol));
        const row = (py - box.top) / ch;
        const others = g.engine.nodes.filter((o) => o !== n);
        const shares = (o: N) => o.x! < x + w && x < o.x! + o.w!;
        const y = Math.max(
          0,
          ...others.filter((o) => shares(o) && o.y! + o.h! / 2 <= row).map((o) => o.y! + o.h!),
        );
        if (n.x === x && n.y === y) return;
        Object.assign(n, { x, y, _dirty: true });
        // push down whatever now overlaps, top to bottom, so the order below is kept
        const placed: N[] = [n];
        const hit = (a: N, b: N) =>
          a.x! < b.x! + b.w! && b.x! < a.x! + a.w! && a.y! < b.y! + b.h! && b.y! < a.y! + a.h!;
        for (const o of others.sort((a, b) => a.y! - b.y! || a.x! - b.x!)) {
          for (let c = placed.find((p) => hit(o, p)); c; c = placed.find((p) => hit(o, p)))
            Object.assign(o, { y: c.y! + c.h!, _dirty: true });
          placed.push(o);
        }
        g.engine._packNodes()._notify();
        n._lastUiPosition = ui.position;
        g._updateContainerHeight();
        g._writePosAttr(ev.target as HTMLElement, n);
      };
      grid.on('dragstart', (_e, item) => {
        [px, py, x0, y0, armed] = [0, 0, 0, 0, false];
        const cw = grid.cellWidth();
        grabCol = Math.max(
          0,
          Math.min((item.gridstackNode?.w ?? 1) - 1, Math.floor((downX - item.getBoundingClientRect().left) / cw)),
        );
        // the lowest page y the drag may scroll to: the bottom of every other card, plus room for this one
        floor =
          Math.max(
            0,
            ...grid
              .getGridItems()
              .filter((el) => el !== item)
              .map((el) => el.getBoundingClientRect().bottom + scrollY),
          ) + Math.min(item.getBoundingClientRect().height, innerHeight / 2);
        top = Math.max(0, root.querySelector('header')?.getBoundingClientRect().bottom ?? 0);
        up.style.top = `${top}px`;
        document.addEventListener('mousemove', track, true);
        const tick = () => {
          const roomUp = scrollY,
            roomDown = floor - (scrollY + innerHeight);
          up.classList.toggle('idle', roomUp < 1);
          down.classList.toggle('idle', roomDown < 1);
          const near = !armed
            ? 0
            : py < top + EDGE
              ? py - (top + EDGE)
              : py > innerHeight - EDGE
                ? py - (innerHeight - EDGE)
                : 0;
          up.classList.toggle('in', near < 0);
          down.classList.toggle('in', near > 0);
          if (!near) return;
          // 2 px per tick at the band's inner edge, up to 30 at the window's edge (or past it)
          const step = Math.sign(near) * Math.min(30, 2 + (Math.abs(near) / EDGE) * 28);
          const dy = step > 0 ? Math.min(step, roomDown) : Math.max(step, -roomUp);
          if (Math.abs(dy) < 1) return;
          window.scrollBy(0, dy);
          document.dispatchEvent(
            new MouseEvent('mousemove', { clientX: px, clientY: py, bubbles: true }),
          );
        };
        tick();
        up.classList.add('on');
        down.classList.add('on');
        scroller = window.setInterval(tick, 16);
      });
      // one handler per drag event: gridstack keeps only the last one given for a name
      grid.on('dragstop', () => {
        document.removeEventListener('mousemove', track, true);
        clearInterval(scroller);
        for (const z of [up, down]) z.classList.remove('on', 'in', 'idle');
        this.save();
      });
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
        clearInterval(scroller);
        up.remove();
        down.remove();
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
