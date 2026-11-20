/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { dur } from '../../shared/format';
import { ServersResponse, ServerView } from '../../core/api';

/**
 * "Live hardware": one box per server from the sjc backend (/api/v1/servers, fed by each server's agent over MQTT).
 * iDRAC power/fans/temps, GPU, fan-control safety state and run mode. Hidden when the backend isn't there
 * (the UI served by the classic :8094 proxy has no /api/v1).
 */
@Component({
  selector: '[app-live-hw]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` @if (rows(); as rs) {
    <div class="h2row">
      <h2>Live hardware</h2>
      <span class="sub"
        >agents over MQTT · every 5 s
        @if (!mqtt()) {
          · <span class="stale">backend not connected to MQTT</span>
        }
      </span>
    </div>
    <div class="gpus">
      @for (r of rs; track r.host) {
        <div class="server" [class.srv-red]="r.emergency">
          <h3>
            {{ r.host }}
            <span class="pill {{ r.online ? 'done' : 'failed' }}">{{
              r.online ? 'online' : 'offline'
            }}</span>
            @if (r.emergency) {
              <span class="pill failed">Emergency</span>
            }
            @if (r.manual) {
              <span
                class="pill failed"
                title="The agent holds the fans; Dell auto comes back when the lease ends or a sensor reaches its limit"
                >manual fans {{ r.manual }}</span
              >
            }
            <span class="role"
              >{{ r.mode }}
              @if (r.age != null) {
                · {{ r.age }}
              }
            </span>
          </h3>
          <div class="kpis">
            @for (k of r.kpis; track k.l) {
              <div class="kpi {{ k.c || '' }}" [title]="k.tip || ''">
                <div class="l">{{ k.l }}</div>
                <div class="v">{{ k.v }}</div>
                <div class="l">{{ k.sub }}</div>
              </div>
            }
          </div>
          @if (r.driven) {
            <p class="sub" style="margin:4px 0 0">{{ r.driven }}</p>
          }
        </div>
      }
    </div>
  }`,
})
export class LiveHw {
  private readonly http = inject(HttpClient);
  private readonly data = signal<ServersResponse | null>(null);
  protected readonly mqtt = computed(() => !!this.data()?.mqtt);

  constructor() {
    const load = () =>
      this.http
        .get<ServersResponse>('/api/v1/servers')
        .subscribe({ next: (d) => this.data.set(d), error: () => this.data.set(null) });
    load();
    const t = setInterval(load, 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  protected readonly rows = computed(() => {
    const d = this.data();
    if (!d?.servers) return null;
    const list = Object.values(d.servers) as any[];
    return list.length ? list.map((s) => this.row(s, d.at)) : null;
  });

  private row(sv: ServerView, now: number) {
    const s: any = sv; // each part is the agent's own JSON (services repo MQTT contract), read loosely
    const id = s.idrac || {},
      pw = s.power || {},
      sf = s.safety || {},
      fc = sf.fan_control || {},
      lim = sf.emergency_c || {};
    const temps: any[] = id.temps || [],
      fans: any[] = id.fans || [],
      cards: any[] = (s.gpu || {}).cards || [];
    // hosts without a BMC (the laptop, the desktop) report their own sensors instead (owner 2026-11-20: show what
    // each one has, nothing it lacks)
    const sy = s.system || {},
      st: any[] = (s.sensors || {}).temps || [],
      sfans: any[] = ((s.sensors || {}).fans || []).filter((f: any) => f.rpm > 0);
    const hot = (kind: string, c: number) =>
      lim[kind] != null && c >= lim[kind] - 2 ? (c >= lim[kind] ? 'bad' : 'warn') : '';
    const maxC = (ts: any[]) => (ts.length ? Math.max(...ts.map((t) => t.c)) : null);
    const cpuMax =
      maxC(temps.filter((t) => /^CPU/.test(t.name))) ??
      maxC(
        st.filter(
          (t) =>
            (t.chip === 'lenovo' && t.label === 'cpu') ||
            (t.chip === 'k10temp' && /^(Tctl|Tccd)/.test(t.label)) ||
            (t.chip === 'coretemp' && /^Package/.test(t.label)),
        ),
      );
    const exh = temps.find((t) => t.name === 'Exhaust'),
      inlet = temps.find((t) => t.name === 'Inlet'),
      board = exh
        ? null
        : st.find((t) => (t.chip === 'lenovo' && t.label === 'board') || t.label === 'SYSTIN');
    const rpm = fans.length
      ? Math.max(...fans.map((f) => f.rpm))
      : sfans.length
        ? Math.max(...sfans.map((f) => f.rpm))
        : null;
    // no wall meter: CPU package + GPUs, or the battery draw when unplugged
    const pkg = sy.power?.cpu_pkg_w ?? (Object.values(sy.cpu_pkg_w || {}) as number[])[0],
      gpuW = cards.reduce((a, g) => a + (g.power_w || 0), 0),
      parts = pkg != null ? pkg + gpuW : null,
      bat = sy.power?.w;
    const kpis: { l: string; v: string; sub: string; c?: string; tip?: string }[] = [
      pw.w != null
        ? {
            l: 'Power',
            v: `${Math.round(pw.w)} W`,
            sub:
              pw.peak_5s != null
                ? `5 s peak ${Math.round(pw.peak_5s)} · 5 min max ${Math.round(pw.max_5m)}`
                : '',
          }
        : bat != null
          ? { l: 'Power', v: `${Math.round(bat)} W`, sub: 'battery draw' }
          : parts != null
            ? {
                l: 'Power',
                v: `${Math.round(parts)} W`,
                sub: `CPU ${Math.round(pkg)}${cards.length ? ` + GPU ${Math.round(gpuW)}` : ''} W, no wall meter`,
              }
            : null,
      rpm != null
        ? {
            l: 'Fans',
            v: `${(rpm / 1000).toFixed(1)}k RPM`,
            sub: fans.length
              ? fc.fan_pct != null
                ? `${fc.fan_pct}% set · ${id.redundancy || ''}`
                : id.redundancy || ''
              : `fastest of ${sfans.length}`,
          }
        : null,
      cpuMax != null
        ? {
            l: 'CPU',
            v: `${Math.round(cpuMax)}°C`,
            sub: lim.cpu != null ? `limit ${lim.cpu}°C` : '',
            c: hot('cpu', cpuMax),
          }
        : null,
      exh
        ? {
            l: 'Exhaust',
            v: `${exh.c}°C`,
            sub: inlet ? `inlet ${inlet.c}°C` : '',
            c: hot('exhaust', exh.c),
          }
        : board
          ? { l: 'Board', v: `${Math.round(board.c)}°C`, sub: 'motherboard sensor' }
          : null,
    ].filter((k) => k != null);
    for (const g of cards)
      kpis.push({
        l: `GPU${cards.length > 1 ? ' ' + g.index : ''}`,
        v: g.temp != null ? `${Math.round(g.temp)}°C` : '–',
        sub: `${g.power_w != null ? Math.round(g.power_w) : '–'}${g.power_limit_w != null ? ' / ' + Math.round(g.power_limit_w) : ''} W · ${g.util ?? '–'}%`,
        c: g.temp != null ? hot('gpu', g.temp) : '',
        tip: g.name,
      });
    // a host with no BMC still sends empty PSU entries: only those with a reading count
    const psu = Object.entries(id.psu || {})
      .filter(([, p]: [string, any]) => p && (p.v != null || p.status))
      .map(
        ([k, p]: [string, any]) =>
          `${k.toUpperCase()} ${/AC lost|fail/i.test(p.status || '') ? 'no AC' : p.v != null ? p.v + ' V' : 'ok'}`,
      );
    if (psu.length)
      kpis.push({
        l: 'PSUs',
        v: psu.length + '',
        sub: psu.join(' · '),
        c: psu.some((x) => x.includes('no AC')) ? 'warn' : '',
      });
    const ages = Object.values(s.age_s || {}) as number[];
    const newest = ages.length ? Math.min(...ages) : null;
    return {
      host: s.host,
      online: s.status === 'online' && newest != null && newest < 30,
      kpis,
      emergency: !!fc.in_emergency,
      manual: sf.manual?.pct ? `${sf.manual.pct}%` : '',
      mode: [
        fc.running
          ? (s.runlevel?.profile_active || fc.profile || '') + ' · fan-control on'
          : 'fan-control not running',
        fc.mode,
      ]
        .filter(Boolean)
        .join(' · '),
      driven: fc.driven_by || '',
      age: newest != null && newest > 15 ? `last data ${dur(newest)} ago` : null,
      now,
    };
  }
}
