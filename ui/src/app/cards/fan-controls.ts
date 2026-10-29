/* eslint-disable @typescript-eslint/no-explicit-any */
import { t, SITE } from '../site';
import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { DashboardStore } from '../dashboard.store';
import { TrackChart } from '../shared/charts/track-chart';
import { TrackOpts } from '../shared/charts/chart-types';
import { envData, powerLine, withTotals } from '../derived';
import { esc, fitRange, gpuFanPct, hhmm, keyStyle, num, plainText } from '../fmt';

const MODE_TIP: Record<string, string> = {
  normal: t('Automatic: the server is idle. Case fans 4,000 RPM, {node} card fan 75%, GPU at the active profile\'s limit (thermal-profiles.md).'),
  run: t('Automatic while the server is working (CPU 20%+, a disk 25%+ busy, or the {node} GPU busy); off after 120 s idle. Daytime and Unattended are profiles with their own case-fan speed, card fan and GPU power; the live values are shown in this card, and the settings are in C:\\claude\\thermal-profiles.md. Profile file: /run/run-profile.json ({main}), /dev/shm/run-profile.json ({node}).'),
  emergency: t('Automatic when any sensor (drive, NVMe, CPU, exhaust, GPU) reaches its emergency limit: fans at the emergency speed; on the {node} the card fan goes to 100% and GPU power steps down if the GPU is the hot one. Needs attention says which sensor and how hot.'),
  quick: 'Manual Quick Cool from this dashboard: case fans at 80% until it is turned off.',
};
const RP_TIP = t('Run profile for both servers (thermal-profiles.md). Low Power: Adaptive fan control plus the low-mode power caps (GPU 100 W, {node} CPU 55 W/pkg and minimum clock, {main} DCMI 280 W and minimum clock). Adaptive: equilibrium fan control at full power. Unattended: fixed high fans. Modes change only when you click.');
const QC_TIP = t('Manual: both servers\' case fans at 80% (and the {nodeGpu} fan at 100%). Click to turn on or off; off returns to the plan.');
const MT_TIP = t('Meeting Mode (back 2026-09-30, {owner}: priority is lower fan speeds): case fans held at max 4,000 RPM, card fan 75%, low power caps (~600 W combined, GPU jobs pause). An overlay: the run profile is unchanged. Emergency (a sensor past its limit) still overrides it for safety.');
const GPU_TIP = t('Manual GPU switch ({owner} 2026-09-30), independent of the run mode: On = no GPU work at all. The {node} gpu-switch service pauses the Copilot runner (HOLD + graceful stop) and stops Ollama (frees VRAM); the image runner waits and resumes when switched back.');
const tm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Fan & quiet controls: fan-control status per server, Quick Cool / Meeting / GPU switch, run profile, total power + power-scaler caps, PSU voltage in Low Power. */
@Component({
  selector: '[app-fan-controls]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrackChart],
  template: `
    <h2>Fan &amp; quiet controls</h2>
    <div class="fanctl" id="fanctl">
      @if (v(); as v) {
        <div class="fstat">
          <div class="fhost" [title]="v.st730.tip" style="cursor:help"><span class="fhn">{{ S.main }}</span><span class="fmode m-{{ v.st730.k }}" [title]="v.st730.modeTip">{{ v.st730.label }}</span>@if (v.st730.pct != null) {<span class="fpct">fans {{ v.st730.pct }}% <span class="muted">ⓘ</span></span>}</div>
          <div class="fhost-wrap" [title]="v.gpuTip" style="cursor:help">
            <div class="fhost" [title]="v.st720.tip" style="cursor:help"><span class="fhn">{{ S.node }}</span><span class="fmode m-{{ v.st720.k }}" [title]="v.st720.modeTip">{{ v.st720.label }}</span>@if (v.st720.pct != null) {<span class="fpct">fans {{ v.st720.pct }}% <span class="muted">ⓘ</span></span>}</div>
            @if (v.gpuPaused) { <div class="fwhy warnc">GPU jobs paused for Low Power: {{ v.gpuPaused }} (resume when Low Power is switched off)</div> }
          </div>
        </div>
        <div class="row">
          <button id="qc-btn" class="tog" [class.on]="v.qc" [attr.aria-pressed]="v.qc" [disabled]="store.busy().qc" [title]="QC_TIP" (click)="store.quickCool()">Quick Cool <b>{{ v.qc ? 'On' : 'Off' }}</b></button>
          <button id="meeting-btn" class="tog" [class.on-m]="v.mt.want" [attr.aria-pressed]="v.mt.want" [disabled]="store.busy().meeting" [title]="MT_TIP" (click)="store.meeting()">Meeting Mode <b>{{ v.mt.want ? 'On' : 'Off' }}</b></button>
          <button id="gpu-btn" class="tog" [class.on-m]="v.gpuOff" [attr.aria-pressed]="v.gpuOff" [disabled]="store.busy().gpu" [title]="GPU_TIP" (click)="store.gpu()">Disable GPU <b>{{ v.gpuOff ? 'On' : 'Off' }}</b></button>
        </div>
        @if (v.hold) { <div class="row"><span class="pill queued">plan</span><span class="muted">{{ v.hold }}</span></div> }
        <div class="row"><span class="muted">Run profile</span>
          <span class="seg rp">
            @for (b of v.rpButtons; track b.label) {
              <button class="rp-btn" [class.cur]="b.cur" [attr.aria-pressed]="b.cur" [disabled]="store.busy().rp" [title]="RP_TIP" (click)="store.runProfile(b.p, b.w)">{{ b.label }}</button>
            }
          </span>
          @for (w of v.rpWarn; track $index) { <span class="warnc">{{ w }}</span> }
          @if (v.override) { <span class="muted">{{ v.override }}</span> }
        </div>
        @if (v.qc) { <div class="row" [innerHTML]="v.qcText"></div> }
        @if (v.mt.want || v.mt.turning) { <div class="row"><span>Meeting Mode:</span><span [innerHTML]="v.mt.text"></span></div> }
      }
    </div>
    @if (charts(); as c) {
      <div class="power-hi" id="ctl-power">
        <div class="legend" id="leg-power-hi">
          <span><i style="background:var(--s1)"></i>Total (both servers) <b>{{ c.legTotal }}</b></span><span><i style="background:var(--t6)"></i>Peak <b>{{ c.legPeak }}</b><span class="muted"> (iDRAC, sub-second)</span></span><span class="muted">Adaptive line {{ c.line }} W</span>
        </div>
        <app-track-chart [opts]="c.powerHi" />
      </div>
      <div class="throttle-chart" id="ctl-throttle">
        <div class="legend" id="leg-throttle">
          <span><b>Throttling by the power scaler</b> (caps it sets to hold the line; normal cap when none)</span>
          @for (e of c.guardEv; track $index) { <span [title]="e.tip">{{ e.at }} <b>{{ e.lab }}</b> {{ e.what }}</span> }
          @empty { <span class="muted">no cap changes in this window</span> }
        </div>
        <app-track-chart [opts]="c.throttle" />
      </div>
      <div class="volt-chart" id="ctl-volt">
        <div class="legend" id="leg-volt">
          @for (p of c.psus; track p.l) { <span><i [style]="p.key"></i>{{ p.l }} <b>{{ p.v }}</b><span [class]="p.warn ? 'warnc' : 'muted'"> {{ p.note }}</span></span> }
        </div>
        <app-track-chart [opts]="c.volt" />
      </div>
    }`,
})
export class FanControls {
  protected readonly S = SITE;
  protected readonly store = inject(DashboardStore);
  protected readonly QC_TIP = QC_TIP; protected readonly MT_TIP = MT_TIP; protected readonly GPU_TIP = GPU_TIP; protected readonly RP_TIP = RP_TIP;

  constructor() {
    // PSU input voltage shows only in Low Power or Meeting Mode: .show-volt on the app host drives the CSS
    effect(() => { const v = this.v(); this.store.showVolt.set(!!(v && v.lowOn)); });
  }

  protected readonly v = computed(() => {
    const s = this.store.state(); if (!s) return null;
    const now = s.now;
    const fc730 = (s.fast || {}).fan_control || {}, r7 = (s.remote || {}).fast || {}, fc720 = r7.fan_control || {}, fg = fc720.gpu, gpu = r7.gpu || {};
    const lowOn = ((s.meeting || {}).on) || [fc730, fc720].some(f => f.profile === 'lowpower' || f.mode === 'meeting');
    const want = !!(s.quickcool || {}).on;
    const fresh = (x: any) => x && x.ts && now - x.ts < 120;
    const hostState = (name: string, fc: any) => !fresh(fc) ? `${name} ?` : `${name} ${fc.fan_pct}%${fc.quick_cool ? ' (quick cool)' : ''}`;
    const honoured = [fc730, fc720].every(fc => fresh(fc) && 'quick_cool' in fc);
    const qcText = want ? t(`on since ${tm((s.quickcool || {}).at || now)} · ${hostState(t('{main}'), fc730)} · ${hostState(t('{node}'), fc720)} · GPU fan ${gpuFanPct(gpu) ?? '?'}%`)
      + (honoured ? '' : ` · <span class="warnc">fan controllers haven't picked up quick cool yet</span>`) : '';
    const pw = (((s.runprofile || {}).desired || {}).power_w) || 1250;   // 2026-09-30: show the actual Adaptive variant

    const status = (fc: any, isGpu: boolean) => {
      if (!fresh(fc) || !fc.mode) return { k: 'none', label: 'no data', pct: null, tip: '', modeTip: '' };
      const k = ({ 'quick cool': 'quick', emergency: 'emergency', normal: 'normal' } as any)[fc.mode] || (/^run/.test(fc.mode) ? 'run' : 'other');
      const RUNL: Record<string, string> = { 'run-lowpower': 'Low Power Mode', 'run-daytime': 'Daytime Run Mode', 'run-unattended': 'Unattended Run Mode', 'run-adaptive': 'Adaptive Run Mode', run: isGpu && fg && fg.run_mode ? 'GPU run mode' : 'Run mode' };
      if (fc.profile === 'adaptive' || fc.mode === 'run-adaptive') RUNL['run-adaptive'] = `Adaptive ${pw === 1000 ? '1' : pw === 1500 ? '1.5' : '1.25'} kW`;
      const label = k === 'run' ? RUNL['run-' + fc.profile] || RUNL[fc.mode] || String(fc.mode).replace(/^run-/, '').replace(/\b\w/g, c => c.toUpperCase()) + ' Run Mode'
        : ({ quick: 'Quick Cool', emergency: 'Emergency Cool', normal: 'Normal' } as any)[k] || String(fc.mode).replace(/\b\w/g, c => c.toUpperCase());
      const a = fc.adaptive;
      // 2026-10-01: detail text only as a hover tooltip
      const detail = `<div>${esc(fc.driven_by || '')}</div>`
        + (fc.mode === 'run-adaptive' && a ? `<div>adaptive: target ${num(a.target_rpm || 0)} RPM (floor ${num(a.floor_rpm || 0)}${a.gpu_floor_rpm ? `, GPU-limited floor ${num(a.gpu_floor_rpm)}${a.gpu_floor_until ? ' until ' + tm(a.gpu_floor_until) : ''}` : ''}, max ${num(a.max_rpm || 0)}) · ${esc(a.phase || '?')}${a.phase_ends ? ` until ${tm(a.phase_ends)}` : ''}${a.step_size ? ` · step ${num(a.step_size)}` : ''}${a.projection && a.projection.sensor ? ` · look-ahead ${esc(a.projection.sensor)} ${Number(a.projection.c).toFixed(0)}°C vs ${Number(a.projection.limit).toFixed(0)}°C${a.projection.c >= a.projection.limit ? ' (holding)' : ''}` : ''}${a.settle_reason ? ` · settle: ${esc(a.settle_reason)}` : ''}${a.blocked && Object.keys(a.blocked).length ? ` · blocked ${Object.entries(a.blocked).map(([r, u]: any) => `${num(+r)} until ${tm(u)}`).join(', ')}` : ''}${a.last_change ? ` · last ${num(a.last_change.from || 0)}→${num(a.last_change.to || 0)} (${esc(a.last_change.why || '')})` : ''}</div>`
          + (a.card ? ((c: any) => `<div>adaptive card fan: target ${c.target_pct ?? '?'}% (floor ${c.floor_pct ?? '?'}%, max ${c.max_pct ?? '?'}%) · ${esc(c.phase || '?')}${c.phase_ends ? ` until ${tm(c.phase_ends)}` : ''}${c.last_change ? ` · last ${c.last_change.from ?? 'off'}→${c.last_change.to}% (${esc(c.last_change.why || '')})` : ''}</div>`)(a.card) : '') : '');
      return { k, label, pct: fc.fan_pct, tip: plainText(detail), modeTip: MODE_TIP[k] || `fan-control mode "${fc.mode}"` };
    };

    // live GPU census from GPU node fan-control: who is on the GPU and who pauses it in Low Power
    const gp = gpuFanPct(gpu), gps = fc720.gpu_procs || [];
    const procName = (w: string[]) => { const b = (w[0] || '').replace(/^.*\//, ''); if (!/^python/.test(b)) return b; const i = w.indexOf('-m'); const arg = (xs: string[]) => xs.find(x => !x.startsWith('-') && !x.includes('/')); return i >= 0 ? w[i + 1] + (arg(w.slice(i + 2)) ? ' ' + arg(w.slice(i + 2)) : '') : (w.find((x, k) => k && !x.startsWith('-')) || b).replace(/^.*\//, ''); };
    const gpuPaused = fc720.gpu_paused && fc720.gpu_paused.length ? fc720.gpu_paused.join(', ') : '';
    const gpuTip = [
      gps.length ? 'On the GPU: ' + gps.map((p: any) => `${p.role} ${procName((p.cmd || '').split(' '))}${p.vram_mib ? ' ' + num(p.vram_mib) + ' MiB' : ''}${p.state === 'T' ? ' (paused)' : ''} · ${p.role === 'server' && !p.handler ? 'left running (server)' : p.handler ? 'hook ' + p.handler : 'no hook: fan-control pauses it'}${(p.remote_clients || []).length ? ` · remote clients ${p.remote_clients.join(', ')}` : ''}`).join('; ') : '',
      gpuPaused ? `GPU jobs paused for Low Power: ${gpuPaused} (resume when Low Power is switched off)` : '',
      fg ? t(`{nodeGpu} ${fg.temp ?? '?'}°C · ${fg.draw != null ? Math.round(fg.draw) : '?'} of ${fg.limit_set ?? fg.limit ?? '?'} W · load ${fg.util ?? '?'}% · card fan set ${fg.card_manual ?? fg.card_fan ?? 'auto'}${typeof (fg.card_manual ?? fg.card_fan) === 'number' ? '%' : ''}`)
        + `${typeof (fg.card_manual ?? fg.card_fan) === 'number' ? ' (nvidia scale)' : ''}${gp != null ? `, actual ${gp}% of full speed${gpu.fan_rpm ? ' (' + Math.round(gpu.fan_rpm).toLocaleString() + ' rpm)' : ''}` : ''}` : '',
    ].filter(Boolean).join('\n');

    // run profile row (profRow)
    const rp = s.runprofile || {}, des = rp.desired || {}, files: Record<string, any> = { [SITE.main]: rp[SITE.main], [SITE.node]: r7.run_profile };
    const fcs: Record<string, any> = { [SITE.main]: fc730, [SITE.node]: fc720 };
    const cur = Object.fromEntries(Object.keys(files).map(h => [h, fcs[h].profile || (files[h] && files[h].profile) || 'daytime']));
    const same = cur[t('{main}')] === cur[t('{node}')] ? cur[t('{main}')] : null;
    const pending = des.at && now - des.at < 60 && Object.values(cur).some(p => p !== des.profile);
    const ov = Object.entries(files).map(([h, f]) => [h, Object.entries(f || {}).filter(([k]) => !['profile', 'dashboard_at'].includes(k))] as [string, [string, any][]]).filter(([, kv]) => kv.length);
    const recent = des.at && now - des.at < 60, sel = recent ? des.profile : same;   // 2026-09-30: highlight the choice at once
    const pwNow = des.power_w || 1250, isCur = (k: string, w?: number) => sel === k && (k !== 'adaptive' || (w || 1250) === pwNow);
    const rpButtons = [['lowpower', 'Low Power'], ['adaptive', 'Adaptive 1 kW', 1000], ['adaptive', 'Adaptive', 1250], ['adaptive', 'Adaptive 1.5 kW', 1500], ['unattended', 'Unattended']]
      .map(([p, label, w]) => ({ p: p as string, label: label as string, w: w as number | undefined, cur: isCur(p as string, w as number | undefined) }));
    const rpWarn: string[] = [];
    if (!same) rpWarn.push(t(`{main} ${cur[t('{main}')]} · {node} ${cur[t('{node}')]}`));
    if (pending) rpWarn.push('applying…');
    const u = Object.keys(files).filter(h => files[h] && files[h].profile && fcs[h].profile && files[h].profile !== fcs[h].profile && now - (files[h].dashboard_at || 0) > 30);
    if (u.length) rpWarn.push(u.map(h => `${h}: fan-control is running ${fcs[h].profile}, not ${files[h].profile}${files[h].profile === 'adaptive' ? ' (Adaptive not in fan-control yet)' : ''}`).join(' · '));
    const hold = rp.hold, holdOn = hold && hold.until && now < hold.until;

    // Meeting Mode state as the laptop agent reports it (renderMeeting)
    const mwant = !!(s.meeting || {}).on, rep = ((s.laptop || {}).fast || {}).meeting, have = rep ? !!rep.on : null;
    const held = (rep && rep.held) || [], lapOk = s.laptop && now - (s.laptop.at || 0) <= 30;
    let mtext: string;
    if (!lapOk) mtext = `<span class="stale">laptop agent offline</span>`;
    else if (have === null) mtext = `<span class="muted">laptop hasn't reported meeting state yet</span>`;
    else if (mwant !== have) mtext = `<span class="warnc">turning ${mwant ? 'on' : 'off'}…</span>`;
    else if (have) mtext = `on since ${rep.since ? tm(rep.since) : '?'} · ${held.length ? held.length + ' paused: ' + esc([...new Set(held.map((h: any) => h.target))].join(', ')) : 'nothing to pause right now'}`;
    else mtext = `<span class="muted">off</span>`;

    return {
      lowOn, qc: want, qcText, st730: status(fc730, false), st720: status(fc720, true), gpuTip, gpuPaused, gpuOff: !!((s.gpu_switch || {}).off),
      rpButtons, rpWarn,
      override: ov.length ? 'test override: ' + ov.map(([h, kv]) => `${h} ${kv.map(([k, v]) => `${k} ${String(v)}`).join(', ')}`).join(' · ') : '',
      hold: holdOn ? `Planned: ${hold.profile} until ${new Date(hold.until * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (${hold.why || ''}). Nothing switches automatically; any manual change (switch, Meeting Mode, Quick Cool) applies as normal.` : '',
      mt: { want: mwant, text: mtext, turning: /turning/.test(mtext) },
    };
  });

  protected readonly charts = computed(() => {
    const s = this.store.state(); if (!s) return null;
    const range = this.store.range(), RL = this.store.rangeLabel();
    const env = envData(s, this.store.series(), range), tp = withTotals(env.pts), line = powerLine(s);
    const Wf = (v: any) => v == null ? '—' : Math.round(v) + ' W', Vf = (v: any) => v == null ? '—' : Math.round(v) + ' V';
    const cur = tp.filter(p => p['power_total'] != null).slice(-1)[0], pkc = tp.filter(p => p['power_peak'] != null).slice(-1)[0];
    const pr = fitRange(tp.flatMap(p => [p['power_total'], p['power_peak']]), 25, 25) || [800, 1300];
    pr[1] = Math.max(pr[1], line + 25);   // 2026-09-30: always extend the range so the target line shows
    const powerHi: TrackOpts = { id: 'power-hi', points: tp.map(p => p['power_total'] != null ? { ...p, power_line: line } : p), range_s: range, bucket_s: env.bucket, left: 50, right: 96,
      label: `Total power, both servers, last ${RL}`,
      tracks: [{ title: 'Total power (both servers)', height: 220, fmt: Wf, axis: v => Math.round(v) + ' W', yRange: pr,
        series: [{ k: 'power_total', label: 'Total', short: 'Total', color: '--s1' }, { k: 'power_peak', label: 'Peak (iDRAC)', short: 'Peak', color: '--t6' }, { k: 'power_line', label: 'Adaptive line', short: 'line', color: '--s2', dash: true }] }] };

    // power scaler throttle activity to hold the line: one chart, all caps in watts; without a throttle each line sits at its normal cap
    const G = this.store.guard() || {}, nowS = Date.now() / 1000, x0 = nowS - range, P = (G.points || []).slice().sort((a: any, b: any) => a[0] - b[0]);
    const N = G.normal || { [SITE.main]: 550, [`${SITE.node}_total`]: 190, gpu: 210 };
    const step = Math.max(60, Math.round(range / 400)), gpts: any[] = [];
    let i = 0, c: any = null;
    for (let t = x0; t <= nowS; t += step) {
      while (i < P.length && P[i][0] <= t) c = P[i++];
      const fresh = c && t - c[0] <= 1200;   // no guard line for 20 min = guard not reporting
      gpts.push(fresh ? { t, cap_main: c[1] ?? N[SITE.main], cap_node: c[2] != null ? 2 * c[2] : N[`${SITE.node}_total`], cap_gpu: c[5] ?? N.gpu } : { t });
    }
    const ev = (G.events || []).filter((e: any) => e[0] >= x0);
    const lab = (e: any) => e[1] === 'DOWN' ? '▼ cap down' : e[1] === 'UP' ? '▲ step up' : e[1] === 'CLEAR' ? '▲ cleared' : '▲ expired';
    const vals = gpts.flatMap(p => [p.cap_main, p.cap_node, p.cap_gpu]).filter(v => v != null);
    const throttle: TrackOpts = { id: 'throttle', points: gpts, range_s: range, bucket_s: step, left: 50, right: 110, label: t('power-scaler caps: {main} server, {node} CPUs, {node} GPU'),
      tracks: [{ title: 'Power caps in force (W)', height: 120, fmt: Wf, axis: v => Math.round(v) + ' W', yRange: fitRange(vals, 20, 50) || [0, 600],
        series: [{ k: 'cap_main', label: t('{main} server cap'), short: t('{main}'), color: '--s3' }, { k: 'cap_node', label: t('{node} CPUs (both packages)'), short: t('{node} CPUs'), color: '--s2' }, { k: 'cap_gpu', label: t('{node} GPU limit'), short: 'GPU', color: '--t6' }] }] };

    // PSU input voltage + total power, shown in Low Power only
    const PSUS: [string, string, string, boolean][] = [[t('{main}_ps1'), t('{main} PS1'), '--s3', false], [t('{main}_ps2'), t('{main} PS2'), '--s3', true], [t('{node}_ps1'), t('{node} PS1'), '--s2', false], [t('{node}_ps2'), t('{node} PS2'), '--s2', true]];
    const psuOf = (k: string) => { const [h, ps] = k.split('_'); const F = h === t('{main}') ? (s.fast || {}) : ((s.remote || {}).fast || {}); return ((F.ipmi || {}).psu || {})[ps] || {}; };
    const psus = PSUS.map(([k, l, col, d]) => {
      const p = psuOf(k), st = p.status || '';
      const off = /ac lost/i.test(st) || p.v == null || (/failure/i.test(st) && !(p.a > 0));   // delivering current = working, even with a latched failure flag
      const flag = !off && /failure/i.test(st);
      return { l, key: keyStyle(col, d), v: off ? '—' : Vf(p.v), warn: off || flag,
        note: off ? (/ac lost/i.test(st) ? 'no AC' : /failure/i.test(st) ? 'failed' : 'no reading') : (p.a != null ? p.a.toFixed(1) + ' A' : '') + (flag ? ' (iDRAC failure flag)' : '') };
    });
    const volt: TrackOpts = { id: 'volt', points: tp.map(p => p['power_total'] != null ? { ...p, power_lowline: 600 } : p), range_s: range, bucket_s: env.bucket, left: 50, right: 96,
      label: `PSU input voltage and total power, last ${RL}`,
      tracks: [{ title: 'Total power (both servers)', height: 70, fmt: Wf, axis: v => Math.round(v) + ' W', yRange: [400, 700], series: [{ k: 'power_total', label: 'Total', short: 'Total', color: '--s1' }, { k: 'power_peak', label: 'Peak (iDRAC)', short: 'Peak', color: '--t6' }, { k: 'power_lowline', label: 'Low Power target', short: 'target', color: '--s2', dash: true }] },
        { title: 'PSU input voltage (lowest per interval)', height: 80, fmt: Vf, axis: v => Math.round(v) + ' V', yRange: [110, 125], series: PSUS.map(([k, l, col, d]) => ({ k: 'volt_' + k, label: l, short: l, color: col, dash: d })) }] };

    return {
      line: num(line), legTotal: cur ? Wf(cur['power_total']) : '—', legPeak: pkc ? Wf(pkc['power_peak']) : '—', powerHi, throttle, volt, psus,
      guardEv: ev.slice(-4).reverse().map((e: any) => ({ at: hhmm(e[0]), lab: lab(e), what: String(e[2]).replace(t('{node}gpu'), 'GPU'), tip: e[3] })),
    };
  });
}
