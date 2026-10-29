import { t, SITE } from './core/site';
import { ChangeDetectionStrategy, Component, ViewEncapsulation, computed, inject } from '@angular/core';
import { DashboardStore } from './core/dashboard.store';
import { buildAlerts } from './features/alerts/alerts';
import { dur } from './shared/format';
import { RangeSeg } from './shared/range-seg';
import { NowTasks } from './features/now-tasks/now-tasks';
import { Pipeline } from './features/pipeline/pipeline';
import { FanControls } from './features/fan-controls/fan-controls';
import { EmergencyPop } from './features/alerts/emergency-pop';
import { Servers } from './features/servers/servers';
import { Gpus } from './features/gpus/gpus';
import { Env } from './features/environment/environment';
import { DriveHealth } from './features/storage/drive-health';
import { DriveRegistry } from './features/storage/drive-registry';
import { Storage } from './features/storage/storage';
import { Procs } from './features/storage/procs';
import { Catalogue } from './features/storage/catalogue';
import { Carve, Offsite } from './features/offsite-carve/offsite-carve';
import { LiveHw } from './features/live-hardware/live-hardware';

/**
 * Data Recovery & Intake dashboard, Angular rewrite of main server :8090 (dashboard/index.html).
 * Same DOM structure and class names as the original so its CSS (src/styles.css) applies unchanged.
 * Retired sections the original kept hidden (tasks table, Copilot runs, copy speed, archive batches, laptop copy) are left out.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // own shadow root: the page CSS stays inside this module when the wrapper hosts it (MODULES.md)
  encapsulation: ViewEncapsulation.ShadowDom,
  styleUrl: '../styles.css',
  host: { '[class.show-volt]': 'store.showVolt()' },
  imports: [RangeSeg, NowTasks, Pipeline, FanControls, EmergencyPop, Gpus, Servers, Env, DriveHealth, DriveRegistry, Storage, Procs, Catalogue, Offsite, Carve, LiveHw],
  template: `
    <header>
      <h1>Data Recovery &amp; Intake</h1>
      <span class="sub">{{ S.main }} · <span id="upd">
        @if (upd(); as u) { @if (u.stale) {<span class="stale">{{ u.text }}</span>} @else { {{ u.text }} } } @else { loading… }
      </span></span>
      <app-range-seg />
    </header>
    <app-emergency-pop />
    <main>
      <section class="card s12" id="top-card"><div class="topsplit">
        <div id="leftcol">
          @if (alerts().length) {
            <div id="alerts-card"><h2>Needs attention</h2><div class="alerts" id="alerts">
              @for (a of alerts(); track a.key) {
                <div class="alert {{ a.cls }}"><button class="dx" title="Dismiss (comes back if it recurs after 24 h)" (click)="store.dismiss('alerts', a.key)">✕</button><span [innerHTML]="a.html"></span></div>
              }
            </div></div>
          }
          <div id="now-card" app-now-tasks></div>
        </div>
        <div app-pipeline></div>
        <div id="ctl-card" app-fan-controls></div>
      </div></section>

      <!-- live iDRAC / GPU / safety per server from the sjc backend (hidden without it) -->
      <div class="col c-live"><section class="card s12" app-live-hw></section></div>
      <!-- GPUs first, then power, then servers ({{ S.owner }} 2026-10-26) -->
      <div class="col c-gpu"><section class="card s12" app-gpus></section></div>
      <div class="col c-env"><section class="card s12" app-env></section></div>
      <div class="col c-srv"><section class="card s12" app-servers></section></div>
      <div class="col c2">
        <!-- Drive health + Drive registry side by side ({{ S.owner }} 2026-09-29) -->
        <section class="card s6" app-drive-health></section>
        <section class="card s6" app-drive-registry></section>
      </div>
      <div class="col c3">
        <section class="card s12" app-storage></section>
        <section class="card s6" app-procs></section>
        <section class="card s6" app-catalogue></section>
      </div>
      <div class="col c-off"><section class="card s4" app-offsite></section></div>
      <div class="col c-carve"><section class="card s8" app-carve></section></div>
    </main>`,
})
export class App {
  protected readonly S = SITE;
  protected readonly store = inject(DashboardStore);

  protected readonly upd = computed(() => {
    if (this.store.unreachable()) return { stale: true, text: 'dashboard server unreachable' };
    const s = this.store.state(); if (!s) return null;
    const age = s.now - (s.updated || 0);
    return age > 30 ? { stale: true, text: `stats ${dur(age)} old` } : { stale: false, text: 'live · ' + new Date(s.now * 1000).toLocaleTimeString() };
  });

  protected readonly alerts = computed(() => { const s = this.store.state(); return s ? buildAlerts(s) : []; });
}
