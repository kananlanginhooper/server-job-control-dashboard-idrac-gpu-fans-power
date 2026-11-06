import { SITE } from './core/site';
import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  computed,
  inject,
  signal,
} from '@angular/core';
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
import { Offsite } from './features/offsite-carve/offsite';
import { Carve } from './features/offsite-carve/carve';
import { LiveHw } from './features/live-hardware/live-hardware';
import { Board } from './shared/board/board';
import { Tile } from './shared/board/tile';
import { ViewsBar } from './shared/board/views-bar';

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
  host: { '[class.show-volt]': 'store.showVolt()', '(click)': 'tapTitle($event)' },
  imports: [
    RangeSeg,
    NowTasks,
    Pipeline,
    FanControls,
    EmergencyPop,
    Gpus,
    Servers,
    Env,
    DriveHealth,
    DriveRegistry,
    Storage,
    Procs,
    Catalogue,
    Offsite,
    Carve,
    LiveHw,
    Board,
    Tile,
    ViewsBar,
  ],
  template: ` <header>
      <h1>Data Recovery &amp; Intake</h1>
      <span class="sub"
        >{{ S.main }} ·
        <span id="upd">
          @if (upd(); as u) {
            @if (u.stale) {
              <span class="stale">{{ u.text }}</span>
            } @else {
              {{ u.text }}
            }
          } @else {
            loading…
          }
        </span></span
      >
      <app-range-seg />
    </header>
    <app-emergency-pop />
    <main>
      <app-views-bar />
      <!-- movable, resizable cards in saved views ({{ S.owner }} 2026-11-06): order and sizes in core/layout/board-layout.ts -->
      <app-board>
        <app-tile tileKey="attention">
          <section class="card" id="leftcol">
            @if (alerts().length) {
              <div id="alerts-card">
                <h2>Needs attention</h2>
                <div class="alerts" id="alerts">
                  @for (a of alerts(); track a.key) {
                    <div class="alert {{ a.cls }}">
                      <button
                        class="dx"
                        title="Dismiss (comes back if it recurs after 24 h)"
                        (click)="store.dismiss('alerts', a.key)"
                      >
                        ✕</button
                      ><span [innerHTML]="a.html"></span>
                    </div>
                  }
                </div>
              </div>
            }
            <div id="now-card" app-now-tasks></div>
          </section>
        </app-tile>
        <app-tile tileKey="pipeline"
          ><section class="card"><div app-pipeline></div></section
        ></app-tile>
        <app-tile tileKey="controls"
          ><section class="card"><div id="ctl-card" app-fan-controls></div></section
        ></app-tile>
        <app-tile tileKey="gpus"><section class="card" app-gpus></section></app-tile>
        <app-tile tileKey="env"><section class="card" app-env></section></app-tile>
        <app-tile tileKey="servers"><section class="card" app-servers></section></app-tile>
        <!-- live iDRAC / GPU / safety per server from the sjc backend (no room taken without it) -->
        <app-tile tileKey="live-hw"><section class="card" app-live-hw></section></app-tile>
        <app-tile tileKey="drive-health"
          ><section class="card" app-drive-health></section
        ></app-tile>
        <app-tile tileKey="drive-registry"
          ><section class="card" app-drive-registry></section
        ></app-tile>
        <app-tile tileKey="storage"><section class="card" app-storage></section></app-tile>
        <app-tile tileKey="procs"><section class="card" app-procs></section></app-tile>
        <app-tile tileKey="catalogue"><section class="card" app-catalogue></section></app-tile>
        <app-tile tileKey="offsite"><section class="card" app-offsite></section></app-tile>
        <app-tile tileKey="carve"><section class="card" app-carve></section></app-tile>
      </app-board>
    </main>
    <footer class="credit">
      Built by <a href="https://github.com/kananlanginhooper" target="_blank" rel="noopener">Kanan Hooper</a>
    </footer>
    @if (tapTip(); as t) {
      <div class="taptip" role="status" (click)="tapTip.set('')">{{ t }}</div>
    }`,
})
export class App {
  protected readonly S = SITE;
  protected readonly store = inject(DashboardStore);

  protected readonly upd = computed(() => {
    if (this.store.unreachable()) return { stale: true, text: 'dashboard server unreachable' };
    const s = this.store.state();
    if (!s) return null;
    const age = s.now - (s.updated || 0);
    return age > 30
      ? { stale: true, text: `stats ${dur(age)} old` }
      : { stale: false, text: 'live · ' + new Date(s.now * 1000).toLocaleTimeString() };
  });

  /** Phones have no hover: a tap on a non-control element with a title shows that title for a few seconds. */
  protected readonly tapTip = signal('');
  private tapTimer = 0;
  protected tapTitle(ev: Event) {
    if (!matchMedia('(hover: none)').matches) return;
    let text = '';
    for (const t of ev.composedPath()) {
      if (!(t instanceof Element) || t.classList.contains('taptip')) break;
      if (t.matches('button, a[href], input, select, textarea, [role=button]')) break;
      const title = t.getAttribute('title');
      if (title) {
        text = title;
        break;
      }
    }
    clearTimeout(this.tapTimer);
    this.tapTip.set(text);
    if (text) this.tapTimer = window.setTimeout(() => this.tapTip.set(''), 5000);
  }

  protected readonly alerts = computed(() => {
    const s = this.store.state();
    return s ? buildAlerts(s) : [];
  });
}
