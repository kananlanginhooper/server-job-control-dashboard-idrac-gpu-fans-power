/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { DashboardStore } from '../../core/dashboard.store';
import { emergGpu, emergSens } from './alerts';
import { dur, hhmm } from '../../shared/format';
import { lsKey } from '../../core/module-context';

const eKey = (e: any) => e.host + '@' + Math.round(e.start);
/** dismissed / notified emergency keys, per browser (last 50) */
function seen(set: string, k?: string): string[] {
  try {
    const v: string[] = JSON.parse(localStorage.getItem(lsKey(set)) || '[]');
    if (k !== undefined && !v.includes(k)) { v.push(k); localStorage.setItem(lsKey(set), JSON.stringify(v.slice(-50))); }
    return v;
  } catch { return []; }
}
const KIND: Record<string, string> = { cpu: 'CPU', gpu: 'GPU', nvme: 'NVMe', ssd: 'SSD', hdd: 'HDD', toshiba: 'HDD', exhaust: 'Exhaust' };
const kindOf = (n: string, v: any) => KIND[(v.kind || '').toLowerCase()] || (/^cpu/i.test(n) ? 'CPU' : /^gpu/i.test(n) ? 'GPU' : /nvme/i.test(n) ? 'NVMe' : /exhaust/i.test(n) ? 'Exhaust' : /^(sd|bay)/i.test(n) ? 'Drive' : n);

/** Emergency Cool pop-up: big host + component badge, why, desktop notification + beep once per emergency. */
@Component({
  selector: 'app-emergency-pop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (pop(); as p) {
      <div id="emerg-pop" class="epop" [class.cleared]="!p.live" role="alertdialog" aria-live="assertive" aria-label="Emergency Cool">
        <div class="epop-top"><span class="epop-host">{{ p.host }}</span>@for (k of p.comps; track k) {<span class="epop-host epop-comp">{{ k }}</span>}<span class="epop-h">{{ p.live ? '⚠ EMERGENCY COOL' : '✓ Emergency Cool cleared' }}</span></div>
        <div class="muted" style="margin-top:4px">sensor{{ p.nSens > 1 ? 's' : '' }}: {{ p.sensNames }}</div>
        <div class="epop-t">{{ p.when }} · fans {{ p.fan }}%</div>
        <div class="epop-why"><b>Why:</b><ul>@for (x of p.why; track $index) {<li [innerHTML]="x"></li>}</ul>
          @if (p.gpu) {<div>{{ p.gpu }}</div>}@if (p.fcWhy) {<div class="muted">fan-control: {{ p.fcWhy }}</div>}</div>
        @if (p.open > 1) { <div class="muted">{{ p.open }} servers in Emergency Cool right now.</div> }
        <div class="epop-b"><button (click)="dismiss(p.key)">Dismiss</button>@if (p.perm === 'default') {<button (click)="askNotify()">Also alert me on the desktop</button>}</div>
      </div>
    }`,
})
export class EmergencyPop {
  private readonly store = inject(DashboardStore);
  private readonly bump = signal(0);   // re-evaluate after a local dismiss / permission change
  private shown: string | null = null;
  private readonly baseTitle = document.title;

  constructor() {
    inject(DestroyRef).onDestroy(() => { document.title = this.baseTitle; });   // unmounted by the wrapper
    effect(() => {   // notify + beep once per open emergency; tab title shows the emergency
      const s = this.store.state(); if (!s) return;
      const open = (s.emergencies || []).filter((e: any) => e.end == null), notified = seen('emergNotified');
      for (const e of open) if (!notified.includes(eKey(e))) {
        seen('emergNotified', eKey(e));
        try { if ('Notification' in window && Notification.permission === 'granted')
          new Notification(`${e.host} EMERGENCY COOL`, { body: emergSens(e).join('; ').replace(/<[^>]+>/g, ''), requireInteraction: true, tag: eKey(e) }); } catch { /* no notifications */ }
        try { const a = new (window.AudioContext || (window as any).webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
          o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.6); } catch { /* no audio */ }
      }
      document.title = open.length ? `⚠ EMERGENCY · ${this.baseTitle}` : this.baseTitle;
    });
  }

  protected readonly pop = computed(() => {
    this.bump();
    const s = this.store.state(); if (!s) return null;
    const eps = s.emergencies || [], dismissed = seen('emergDismissed'), open = eps.filter((e: any) => e.end == null);
    const cand = open.find((e: any) => !dismissed.includes(eKey(e))) || (this.shown && eps.find((e: any) => eKey(e) === this.shown && !dismissed.includes(this.shown!)));
    if (!cand) { this.shown = null; return null; }
    this.shown = eKey(cand);
    const live = cand.end == null, sens = Object.keys(cand.sensors || {});
    return {
      key: eKey(cand), live, host: cand.host, comps: [...new Set(Object.entries(cand.sensors || {}).map(([n, v]) => kindOf(n, v)))],
      nSens: sens.length, sensNames: sens.join(', '), fan: cand.fan_pct ?? '?', open: open.length,
      when: live ? `since ${hhmm(cand.start)} (${dur(s.now - cand.start)})` : `${hhmm(cand.start)}–${hhmm(cand.end)} (${dur(cand.end - cand.start)})`,
      why: emergSens(cand), gpu: emergGpu(cand), fcWhy: cand.why || '',
      perm: 'Notification' in window ? Notification.permission : 'unsupported',
    };
  });

  protected dismiss(key: string) { seen('emergDismissed', key); this.shown = null; this.bump.update(n => n + 1); }
  protected askNotify() { try { Notification.requestPermission().then(() => this.bump.update(n => n + 1)); } catch { /* unsupported */ } }
}
