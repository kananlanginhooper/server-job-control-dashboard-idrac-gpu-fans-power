/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { DashboardStore } from '../../dashboard.store';
import { SITE, t } from '../../site';
import { Bar } from '../../ui/bar';
import { fb, rate } from '../../fmt';

const ROLE: Record<string, string> = { '/': 'OS + MySQL', '/b': 'earlier files', '/c': t('{node} prior output (Step A)'), '/d': 'intake batch 2 + Step A samba',
  '/e': 'intake batch 1 (slot-5 SSD)', '/n2': 'Acer NVMe', '/n4': '990 PRO NVMe — no sustained writes' };
const DEVMOUNT: Record<string, string> = { sda: '/', sdb: '/b', sdc: '/c', sdd: '/d', sde: '/e', nvme0n1: '/n2', nvme1n1: '/n4' };
const ROLE_NODE: Record<string, string> = { '/': 'OS (boot RAID 5, 4 TB disks, DEGRADED: 3 of 4)', '/raid6': t('backup copy of the {main} (RAID 6, 4×18 TB)') };   // 2026-09-30
const DEV_NODE: Record<string, string> = { sda: '/raid6 (RAID 6)', sdb: '/ (RAID 5 boot)' };
const MEMBERS_NODE: Record<string, number[]> = { sdb: [3, 6, 7], sda: [0, 1, 4, 5] };

/** Storage & disk activity: mounts, use, read/write, hottest member drive temperature. */
@Component({
  selector: '[app-storage]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTableModule, Bar],
  templateUrl: './storage.html',
})
export class Storage {
  protected readonly S = SITE;
  private readonly store = inject(DashboardStore);
  protected readonly cols = ['host', 'mount', 'role', 'dev', 'used', 'free', 'rd', 'wr', 'temp'];

  protected readonly rows = computed(() => {
    const s = this.store.state(); if (!s) return [];
    const L = this.store.limits(), HDR = (s.health || {}).drives || [];
    const both: [string, any, Record<string, string>, Record<string, string>][] = [[SITE.main, s.fast || {}, ROLE, DEVMOUNT], [SITE.node, (s.remote || {}).fast || {}, ROLE_NODE, DEV_NODE]];
    const diskTemp = (host: string, d: string | null) => {
      if (!d) return null;
      const ds = host === SITE.main ? HDR.filter((x: any) => x.host === SITE.main && x.dev === d)
        : HDR.filter((x: any) => x.host === SITE.node && (MEMBERS_NODE[d] || []).includes(+String(x.dev).replace('bay ', '')));
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
