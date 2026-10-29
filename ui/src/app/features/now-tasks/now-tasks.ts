/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../../core/dashboard.store';
import { Bar } from '../../shared/bar';
import { dur, fb, num, rate } from '../../shared/format';

export function tFmt(v: any, unit: string): string {
  if (v == null) return '—';
  return unit === 'files' ? num(Math.round(v)) + ' files' : unit === 'items' ? num(Math.round(v)) + ' items'
    : unit === 'percent' ? v.toFixed(v < 10 ? 1 : 0) + '%' : unit === 'seconds' ? dur(v) : fb(v);
}
export function tRate(v: any, unit: string): string {
  if (!v) return '—';
  return unit === 'files' ? num(Math.round(v)) + ' files/s' : unit === 'items' ? (v >= 1 ? num(Math.round(v)) : v.toFixed(2)) + ' items/s'
    : unit === 'percent' ? (v * 3600).toFixed(1) + ' %/h' : unit === 'seconds' ? v.toFixed(2) + '×' : rate(v);
}

/** Current tasks: group "current" from job-progress.py, bar + % + ETA */
@Component({
  selector: '[app-now-tasks]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Bar],
  template: `
    <h2>Current tasks</h2>
    <div id="nowtasks">
      @for (t of rows(); track t.id) {
        <div class="nt">
          <div class="nt-h"><b [title]="t.title">{{ t.title }}</b>
            <span class="muted">{{ t.pct }} {{ t.eta }}@if (t.fin) { <button class="dx" title="Remove this finished task" (click)="store.dismiss('tasks', t.id)">✕</button>}</span></div>
          @if (t.f != null) { <app-bar [frac]="t.f" [cls]="t.done ? 'ok' : ''" /> }
          <div class="muted nt-m">{{ t.meta }}@if (t.stale) { · <span class="warnc">no update {{ t.stale }}</span>}</div>
        </div>
      } @empty { <p class="muted">{{ store.state() ? 'no current tasks reported' : 'loading…' }}</p> }
    </div>`,
})
export class NowTasks {
  protected readonly store = inject(DashboardStore);
  protected readonly rows = computed(() => {
    const s = this.store.state(); if (!s) return [];
    const dTs = ((s.dismissed || {}).tasks) || {}, fin = (t: any) => ['done', 'failed', 'cancelled'].includes(t.state);
    return (s.tasks || []).filter((t: any) => t.group === 'current' && !(fin(t) && dTs[t.id]))
      .sort((a: any, b: any) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || String(a.title).localeCompare(b.title))
      .map((t: any) => {
        const u = t.unit || 'items', f = t.total ? Math.min(1, (t.done || 0) / t.total) : null, r = t.rate ?? t.rate_calc;
        const amt = t.done != null && u !== 'percent' ? tFmt(t.done, u) + (t.total ? ' of ' + tFmt(t.total, u) : '') : '';
        return {
          id: t.id, title: t.title, f, done: t.state === 'done', fin: fin(t),
          pct: f != null ? (f * 100).toFixed(f < 0.1 ? 1 : 0) + '%' : '',
          eta: t.state === 'done' ? 'done' : (t.state === 'running' && t.eta_s ? '~' + dur(t.eta_s) + ' left' : ''),
          meta: [amt, r && t.state === 'running' ? tRate(r, u) : '', t.message || ''].filter(Boolean).join(' · '),
          stale: t.stale ? dur(t.age || 0) : '',
        };
      });
  });
}
