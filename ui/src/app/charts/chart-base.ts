import { Directive, ElementRef, OnDestroy, afterNextRender, inject, signal, viewChild } from '@angular/core';

/** Shared plumbing for the SVG charts: host width (ResizeObserver) and hover pointer + tooltip placement. */
@Directive()
export abstract class ChartBase implements OnDestroy {
  protected readonly host = inject(ElementRef<HTMLElement>);
  protected readonly width = signal(600);
  /** pointer position in viewBox x units plus the client position for the tooltip; null = not hovering */
  protected readonly pointer = signal<{ mx: number; cx: number; cy: number } | null>(null);
  protected readonly tipPos = signal<{ left: number; top: number }>({ left: -9999, top: -9999 });
  private readonly tipEl = viewChild<ElementRef<HTMLDivElement>>('tip');
  private ro?: ResizeObserver;

  constructor() {
    afterNextRender(() => {
      const el = this.host.nativeElement as HTMLElement;
      this.width.set(el.clientWidth || 600);
      this.ro = new ResizeObserver(() => { const w = el.clientWidth; if (w && w !== this.width()) this.width.set(w); });
      this.ro.observe(el);
    });
  }
  ngOnDestroy() { this.ro?.disconnect(); }

  protected move(ev: PointerEvent, svg: Element, W: number) {
    const r = svg.getBoundingClientRect();
    this.pointer.set({ mx: (ev.clientX - r.left) * (W / r.width), cx: ev.clientX, cy: ev.clientY });
    this.place();   // place now with the tooltip's last size, then again once the new rows have rendered
    requestAnimationFrame(() => this.place());
  }
  protected leave() { this.pointer.set(null); }

  /** keep the tooltip on screen: flip to the left/top of the pointer when it would overflow */
  private place() {
    const p = this.pointer(), tip = this.tipEl()?.nativeElement;
    if (!p || !tip) return;
    const tw = tip.offsetWidth, th = tip.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
    let tx = p.cx + 16, ty = p.cy + 16;
    if (tx + tw > vw - 4) tx = p.cx - 16 - tw;
    if (ty + th > vh - 4) ty = p.cy - 16 - th;
    this.tipPos.set({ left: Math.max(4, tx), top: Math.max(4, ty) });
  }
}
