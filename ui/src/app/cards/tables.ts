/* eslint-disable @typescript-eslint/no-explicit-any */
import { t, SITE } from '../site';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../dashboard.store';
import { Bar } from '../ui/bar';
import { dur, fb, num, numSort, rate } from '../fmt';

/** Drive health — SMART, every 10 minutes */
@Component({
  selector: '[app-drive-health]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h2row"><h2>Drive health — SMART, every 10 minutes</h2>
      <div class="batches" id="health-sum">@for (c of v().sum; track c.t) {<span class="pill {{ c.c }}">{{ c.n }} {{ c.t }}</span>}</div></div>
    <div class="scroll" style="max-height:560px;overflow-y:auto"><table id="health"><thead><tr><th>Status</th><th>Host</th><th>Drive</th><th>Model · serial</th><th class="num">Temp</th><th class="num">Power-on</th><th>Counters</th><th>Notes</th></tr></thead><tbody>
      @for (d of v().rows; track $index) {
        <tr><td><span class="pill {{ d.pill }}">{{ d.level }}</span></td>
          <td class="mono">{{ d.host }}</td><td class="mono">{{ d.dev }}</td><td>{{ d.model }}<br><span class="mono muted">{{ d.serial }}</span></td>
          <td class="num">{{ d.temp }}@if (d.trip) {<br><span class="muted">trip {{ d.trip }}°</span>}</td>
          <td class="num">{{ d.hours }}<br><span class="muted">{{ d.years }}</span></td>
          <td>@if (d.cnt == null) {<span class="muted">—</span>} @else { {{ d.cnt }}@if (d.rate) { <span class="muted">{{ d.rate }}</span>} }</td>
          <td>@for (i of d.issues; track $index) {<div [class]="i.cls">{{ i.t }}</div>} @empty {<span class="muted">nothing to report</span>}</td></tr>
      } @empty { <tr><td colspan="8" class="muted">first SMART pass runs within a minute of the dashboard starting…</td></tr> }
    </tbody></table></div>
    <p class="sub" id="health-foot">Kernel disk errors in the last hour: {{ S.main }} <b>{{ v().k730 }}</b> · {{ S.node }} <b>{{ v().k720 }}</b>{{ v().k720detail }}.@if (v().nodeErr) { <span class="stale">{{ S.node }}: {{ v().nodeErr }}</span>} {{ S.node }} drives are read through the PERC H710 (smartctl -d megaraid,N, bay = N). Status compares each drive with its first dashboard reading; counts that were already non-zero are shown in grey unless they grow. Any uncorrected, pending or media error is a problem. The dashboard never starts self-tests.</p>`,
})
export class DriveHealth {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly v = computed(() => {
    const s = this.store.state() || {}, HL = s.health || {}, hd = (HL.drives || []).slice();
    const RANK: Record<string, number> = { bad: 0, watch: 1, unknown: 2, ok: 3 }, HP: Record<string, string> = { bad: 'failed', watch: 'queued', unknown: 'queued', ok: 'done' };
    hd.sort((a: any, b: any) => (RANK[a.level] - RANK[b.level]) || String(a.host).localeCompare(b.host) || numSort(a.dev, b.dev));
    const cnt = (d: any) => d.proto === 'SAS'
      ? `grown defects ${num(d.grown)} · uncorrected ${num(d.unc)} · delayed-corrected r/w/v ${['read', 'write', 'verify'].map(k => num((d.dcorr || {})[k])).join(' / ')}`
      : d.proto === 'NVMe' ? `media errors ${num(d.media)} · wear ${num(d.wear)}% · spare ${num(d.spare)}% · critical ${num(d.crit)} · error log ${num(d.errlog)}`
      : `reallocated ${num(d.realloc)} · pending ${num(d.pending)} · uncorrectable ${num(d.uncorrect)} · CRC ${num(d.crc)}`;
    const nlev = (l: string) => hd.filter((d: any) => d.level === l).length;
    const kh = HL.kernel || {}, ksum = (k: any) => k ? Object.values(k).reduce((a: any, b: any) => a + b, 0) : null;
    return {
      rows: hd.map((d: any) => ({
        pill: HP[d.level] || 'queued', level: d.level === 'bad' ? 'problem' : d.level, host: d.host, dev: d.dev, model: d.model || '', serial: d.serial || '',
        temp: d.temp == null ? '—' : d.temp + '°C', trip: d.trip, hours: d.hours == null ? '—' : num(d.hours) + ' h', years: d.hours ? (d.hours / 8766).toFixed(1) + ' y' : '',
        cnt: d.error ? null : cnt(d),
        rate: !d.error && d.proto === 'SAS' && Object.keys(d.rate_h || {}).length ? `(${['read', 'write', 'verify'].map(k => '+' + Math.round(d.rate_h[k] || 0)).join(' / ')} per h)` : '',
        issues: (d.issues || []).map(([l, t]: [string, string]) => ({ cls: l === 'bad' ? 'stale' : l === 'info' ? 'muted' : '', t })),
      })),
      sum: [['bad', 'failed', 'problem'], ['watch', 'queued', 'watch'], ['ok', 'done', 'ok']].filter(([l]) => nlev(l)).map(([l, c, t]) => ({ n: nlev(l), c, t })),
      k730: ksum(kh[SITE.main]) ?? '—', k720: ksum(kh[SITE.node]) ?? '—',
      k720detail: kh[SITE.node] && ksum(kh[SITE.node]) ? ` (${Object.entries(kh[SITE.node]).map(([k, v]) => k + ' ' + v).join(', ')})` : '', nodeErr: HL[`${SITE.node}_error`] || '',
    };
  });
}

/** Drive registry — every drive we know, by serial */
@Component({
  selector: '[app-drive-registry]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Drive registry — every drive we know, by serial</h2>
    <div class="scroll" style="max-height:560px;overflow-y:auto"><table id="drives"><thead><tr><th>Serial</th><th>Model</th><th class="num">Size</th><th>Status</th><th class="num">Hours</th><th>Errors</th><th>Recovery?</th><th>Where</th><th>Role</th><th>Last check</th><th class="num">Checks</th><th>Last seen</th></tr></thead><tbody>
      @for (d of rows(); track $index) {
        <tr><td class="mono">{{ d.serial }}</td><td>{{ d.model }}</td><td class="num">{{ d.size }}</td>
          <td><span class="pill {{ d.pill }}">{{ d.status }}</span></td>
          <td class="num" [title]="d.hoursTip">{{ d.hours }}</td><td class="muted jd">{{ d.errors }}</td><td>{{ d.recovery }}</td>
          <td class="mono">{{ d.where }}</td><td>{{ d.role }}</td><td>{{ d.lastCheck }}</td><td class="num">{{ d.checks }}</td><td class="muted">{{ d.lastSeen }}</td></tr>
      }
    </tbody></table></div>
    <p class="sub">Drives the {{ S.main }} can see are registered automatically every minute. Anything new shows as <b>new — not checked</b>. Drives behind a PERC virtual disk (all {{ S.node }} drives) are only visible with perccli. They were entered from the plan.</p>`,
})
export class DriveRegistry {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly rows = computed(() => {
    const DS: Record<string, string> = { spare: 'done', new: 'failed', failed: 'failed', under_recovery: 'hashing', evidence: 'hashing', in_use: 'done', checked_clean: 'done', recovered: 'done', wiped: 'queued', retired: 'queued' };
    return (((this.store.state() || {}).db || {}).drives || []).map((d: any) => ({
      serial: d.serial, model: d.model, size: fb(d.size_bytes, 0), pill: DS[d.status] || 'queued',
      status: d.status === 'new' ? 'new — not checked' : String(d.status || '').replace('_', ' '),
      hours: d.power_on_hours != null ? num(d.power_on_hours) : '—', hoursTip: d.power_on_hours != null ? (d.power_on_hours / 8766).toFixed(1) + ' years powered on' : 'no SMART hours yet',
      errors: [['realloc', d.reallocated], ['pending', d.pending], ['uncorr', d.uncorrectable], ['crc', d.crc_errors], ['other', d.other_error_count]].filter(([, v]) => v).map(([k, v]) => `${k} ${num(v)}`).join(' · ') || (d.health_checked_at ? 'none' : '—'),
      recovery: d.recovery_needed, where: [d.last_host, d.last_slot && 'slot ' + d.last_slot, d.last_dev].filter(Boolean).join(' · '),
      role: d.role || '', lastCheck: d.last_check || '—', checks: d.checks, lastSeen: String(d.last_seen || '').slice(0, 16),
    }));
  });
}

const ROLE: Record<string, string> = { '/': 'OS + MySQL', '/b': 'earlier files', '/c': t('{node} prior output (Step A)'), '/d': 'intake batch 2 + Step A samba',
  '/e': 'intake batch 1 (slot-5 SSD)', '/n2': 'Acer NVMe', '/n4': '990 PRO NVMe — no sustained writes' };
const DEVMOUNT: Record<string, string> = { sda: '/', sdb: '/b', sdc: '/c', sdd: '/d', sde: '/e', nvme0n1: '/n2', nvme1n1: '/n4' };
const ROLE720: Record<string, string> = { '/': 'OS (boot RAID 5, 4 TB disks, DEGRADED: 3 of 4)', '/raid6': t('backup copy of the {main} (RAID 6, 4×18 TB)') };   // 2026-09-30
const DEV720: Record<string, string> = { sda: '/raid6 (RAID 6)', sdb: '/ (RAID 5 boot)' };
const MEMBERS720: Record<string, number[]> = { sdb: [3, 6, 7], sda: [0, 1, 4, 5] };

/** Storage & disk activity: mounts, use, read/write, hottest member drive temperature */
@Component({
  selector: '[app-storage]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Bar],
  template: `
    <h2>Storage &amp; disk activity</h2>
    <div class="scroll"><table id="storage"><thead><tr><th>Host</th><th>Mount</th><th>Role</th><th>Device</th><th style="width:20%">Used</th><th class="num">Free</th><th class="num">Read</th><th class="num">Write</th><th class="num">Temp</th></tr></thead><tbody>
      @for (r of rows(); track $index) {
        <tr><td class="mono">{{ r.host }}</td><td class="mono">{{ r.mount }}</td><td>{{ r.role }}</td><td class="mono">{{ r.dev }}</td>
          @switch (r.used.kind) {
            @case ('none') { <td class="muted">{{ r.used.text }}</td> }
            @case ('bad') { <td><span class="pill failed">{{ r.used.text }}</span></td> }
            @default { <td [title]="r.used.tip"><app-bar [frac]="r.used.frac" [cls]="r.used.cls" /><span class="muted">{{ r.used.text }}</span></td> }
          }
          <td class="num">{{ r.free }}</td><td class="num">{{ r.rd }}</td><td class="num">{{ r.wr }}</td>
          @if (r.temp; as t) { <td class="num {{ t.cls }}" [title]="t.tip">{{ t.v }}@if (t.of) {<br><span class="muted">{{ t.of }}</span>}</td> } @else { <td class="num muted">—</td> }
        </tr>
      }
    </tbody></table></div>
    <p class="sub">{{ S.node }} devices are PERC virtual disks: the temperature is the hottest member drive. <b>/raid6</b> = RAID 6 on the four 18 TB drives (bays 0/1/4/5, built 2026-09-30); <b>/</b> = the boot RAID 5 on the 4 TB drives (bays 3/6/7, degraded: its 4th disk is missing). Hover a temperature for every member.</p>`,
})
export class Storage {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly rows = computed(() => {
    const s = this.store.state(); if (!s) return [];
    const L = this.store.limits(), HDR = (s.health || {}).drives || [];
    const both: [string, any, Record<string, string>, Record<string, string>][] = [[t('{main}'), s.fast || {}, ROLE, DEVMOUNT], [t('{node}'), (s.remote || {}).fast || {}, ROLE720, DEV720]];
    const diskTemp = (host: string, d: string | null) => {
      if (!d) return null;
      const ds = host === t('{main}') ? HDR.filter((x: any) => x.host === t('{main}') && x.dev === d)
        : HDR.filter((x: any) => x.host === t('{node}') && (MEMBERS720[d] || []).includes(+String(x.dev).replace('bay ', '')));
      const tv = ds.filter((x: any) => x.temp != null);
      if (!tv.length) return null;
      const hot = tv.reduce((a: any, b: any) => (b.temp - L.driveThr(b)[1]) > (a.temp - L.driveThr(a)[1]) ? b : a);
      const [w, bad] = L.driveThr(hot);
      return { v: hot.temp + '°C', cls: hot.temp >= bad ? 'stale' : hot.temp >= w ? 'warnc' : '',
        tip: tv.map((x: any) => `${x.dev} ${x.temp}°C`).join(' · ') + ` · yellow ${w}°C, red ${bad}°C`,
        of: tv.length > 1 ? `max of ${tv.length} (${tv.map((x: any) => String(x.dev).replace('bay ', 'b')).join(',')})` : '' };
    };
    return both.flatMap(([host, F, roles, devs]) => {
      const devOf: Record<string, string> = {};
      for (const [d, m] of Object.entries(devs)) devOf[String(m).split(' ')[0]] = d;
      const io = F.disks || {}, seen = new Set<string>(), rows: any[] = [];
      const row = (m: any, d: string | null) => {
        if (d) seen.add(d);
        const u = m && m.usage, used = u && !m.shutdown ? (u.total - u.free) / u.total : null, v = d ? io[d] : null;
        const usedCell = !m ? { kind: 'none', text: 'no mount' } : !m.mounted ? { kind: 'none', text: 'not mounted' }
          : used == null ? { kind: 'bad', text: m.shutdown ? 'shut down' : 'unreadable' }
          : { kind: 'bar', frac: used, cls: used > .9 ? 'bad' : used > .75 ? 'warn' : '', text: `${(used * 100).toFixed(0)}% of ${fb(u.total, 1)}`, tip: `${fb(u.total - u.free)} used of ${fb(u.total)} (${(used * 100).toFixed(0)}%)` };
        return { host, mount: m ? m.mount : '—', role: m ? roles[m.mount] || '' : '', dev: d || '—', used: usedCell as any, free: used == null ? '' : fb(u.free),
          rd: v ? rate(v.read) : '—', wr: v ? rate(v.write) : '—', temp: diskTemp(host, d) };
      };
      for (const m of F.mounts || []) rows.push(row(m, devOf[m.mount] || null));
      for (const d of Object.keys(io).sort()) if (!seen.has(d)) rows.push(row(null, d));
      return rows;
    });
  });
}

/** Running on the server + Connected machines */
@Component({
  selector: '[app-procs]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2>Running on the server</h2>
    <div class="scroll" style="max-height:260px;overflow-y:auto"><table id="procs"><thead><tr><th>Host</th><th>Job</th><th class="num">Procs</th><th class="num">CPU</th><th class="num">Running for</th></tr></thead><tbody>
      @for (p of v().procs; track $index) {
        <tr><td class="mono">{{ p.host }}</td><td [title]="p.sample">{{ p.label }}</td><td class="num">{{ p.count }}@if (p.stopped) { <span class="pill queued">{{ p.stopped }} paused</span>}</td><td class="num">{{ p.cpu }}</td><td class="num">{{ p.age }}</td></tr>
      } @empty { <tr><td class="muted" colspan="5">nothing watched is running</td></tr> }
    </tbody></table></div>
    <h2 style="margin-top:14px">Connected machines</h2>
    <div class="scroll"><table id="peers"><thead><tr><th>Address</th><th>Services</th></tr></thead><tbody>
      @for (p of v().peers; track p.ip) { <tr><td class="mono">{{ p.ip }} <span class="muted">{{ p.name }}</span></td><td>{{ p.sv }}</td></tr> }
    </tbody></table></div>`,
})
export class Procs {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly v = computed(() => {
    const s = this.store.state() || {};
    const LABEL: Record<string, string> = { rsync: t('rsync (Step A: {node} → {main})'), 'catalog.py': 'catalog.py scan', mkfs: 'mkfs', immich: 'Immich', mysqld: 'MySQL',
      smbd: 'Samba', photorec: 'PhotoRec (carving)', ddrescue: 'ddrescue (imaging)', zeromap: 'zeromap.py (zero-scan)', sshfs: t('sshfs (output to {main})') };
    const NAMES: Record<string, string> = SITE.peers;
    const both: [string, any][] = [[t('{main}'), s.fast || {}], [t('{node}'), (s.remote || {}).fast || {}]];
    return {
      procs: both.flatMap(([host, F]) => Object.entries(F.procs || {}).map(([k, v]: [string, any]) => ({ host, label: LABEL[k] || k, sample: v.sample, count: v.count, stopped: v.stopped, cpu: v.cpu.toFixed(0) + '%', age: dur(v.oldest_s) }))),
      peers: Object.entries((s.fast || {}).peers || {}).map(([ip, sv]: [string, any]) => ({ ip, name: NAMES[ip] || '', sv: sv.join(', ') })),
    };
  });
}

/** Catalogue database (MySQL recovery): every table, largest first, plus the catalog.py scan log */
@Component({
  selector: '[app-catalogue]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="h2row"><h2>Catalogue database (MySQL <span class="mono">recovery</span>)</h2><span class="muted" id="tables-sub">{{ v().sub }}</span></div>
    <p class="sub" style="margin-top:0">Every table in the recovery catalogue with its approximate row count and size on disk, largest first. This is the database the pipeline threads write their results to.</p>
    <div class="scroll" style="max-height:300px;overflow-y:auto"><table id="tables"><thead><tr><th>Table</th><th class="num">Rows (est.)</th><th class="num">Size</th></tr></thead><tbody>
      @for (t of v().rows; track t.name) { <tr><td class="mono">{{ t.name }}</td><td class="num">{{ t.rows }}</td><td class="num">{{ t.size }}</td></tr> }
    </tbody></table></div>
    <h2 style="margin-top:14px">catalog.py scan log</h2>
    <div class="log" id="scanlog" style="max-height:180px;overflow-y:auto">{{ v().log }}</div>`,
})
export class Catalogue {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly v = computed(() => {
    const s = this.store.state() || {};
    const tbs = ((s.db || {}).tables || []).slice().sort((a: any, b: any) => (b.bytes || 0) - (a.bytes || 0));
    const tot = tbs.reduce((n: number, t: any) => n + (t.bytes || 0), 0);
    return {
      sub: s.db ? `${tbs.length} tables · ${fb(tot)} on disk` : '',
      rows: tbs.map((t: any) => ({ name: t.TABLE_NAME || t.table_name, rows: num(t.TABLE_ROWS ?? t.table_rows), size: fb(t.bytes) })),
      log: ((s.slow || {}).scan_log || []).join('\n') || 'no log',
    };
  });
}
