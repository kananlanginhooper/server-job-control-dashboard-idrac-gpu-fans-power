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
    const hot = (kind: string, c: number) =>
      lim[kind] != null && c >= lim[kind] - 2 ? (c >= lim[kind] ? 'bad' : 'warn') : '';
    const cpu = temps.filter((t) => /^CPU/.test(t.name)),
      cpuMax = cpu.length ? Math.max(...cpu.map((t) => t.c)) : null;
    const exh = temps.find((t) => t.name === 'Exhaust'),
      inlet = temps.find((t) => t.name === 'Inlet');
    const rpm = fans.length ? Math.max(...fans.map((f) => f.rpm)) : null;
    const kpis: { l: string; v: string; sub: string; c?: string; tip?: string }[] = [
      {
        l: 'Power',
        v: pw.w != null ? `${Math.round(pw.w)} W` : '–',
        sub:
          pw.peak_5s != null
            ? `5 s peak ${Math.round(pw.peak_5s)} · 5 min max ${Math.round(pw.max_5m)}`
            : '',
      },
      {
        l: 'Fans',
        v: rpm != null ? `${(rpm / 1000).toFixed(1)}k RPM` : '–',
        sub:
          fc.fan_pct != null ? `${fc.fan_pct}% set · ${id.redundancy || ''}` : id.redundancy || '',
      },
      {
        l: 'CPU',
        v: cpuMax != null ? `${cpuMax}°C` : '–',
        sub: lim.cpu != null ? `limit ${lim.cpu}°C` : '',
        c: cpuMax != null ? hot('cpu', cpuMax) : '',
      },
      {
        l: 'Exhaust',
        v: exh ? `${exh.c}°C` : '–',
        sub: inlet ? `inlet ${inlet.c}°C` : '',
        c: exh ? hot('exhaust', exh.c) : '',
      },
    ];
    for (const g of cards)
      kpis.push({
        l: `GPU${cards.length > 1 ? ' ' + g.index : ''}`,
        v: g.temp != null ? `${g.temp}°C` : '–',
        sub: `${g.power_w != null ? Math.round(g.power_w) : '–'} / ${g.power_limit_w != null ? Math.round(g.power_limit_w) : '–'} W · ${g.util ?? '–'}%`,
        c: g.temp != null ? hot('gpu', g.temp) : '',
        tip: g.name,
      });
    const psu = Object.entries(id.psu || {}).map(
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
