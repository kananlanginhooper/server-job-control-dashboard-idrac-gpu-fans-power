/* eslint-disable @typescript-eslint/no-explicit-any */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatTableModule } from '@angular/material/table';
import { DashboardStore } from '../../core/dashboard.store';
import { SITE, t } from '../../core/site';
import { Bar } from '../../shared/bar';
import { fb, rate } from '../../shared/format';

// What a mount holds; everything else on the row (device, model, network source, other mount points) comes live from
// the hub's /proc/mounts reading (2026-11-18: the old fixed device list went stale when /b-/e moved to {node} /raid6).
const ROLE: Record<string, string> = {
  '/': 'OS',
  '/data': 'RAID 5 · carve output',
  '/n4': 'no sustained writes',
};
const ROLE_NODE: Record<string, string> = {
  '/': 'OS (boot RAID 5, 4 TB disks, DEGRADED: 3 of 4)',
  '/raid6': t('backup copy of the {main} (RAID 6, 4×18 TB)'),
}; // 2026-09-30
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
    const s = this.store.state();
    if (!s) return [];
    const L = this.store.limits(),
      HDR = (s.health || {}).drives || [];
    const both: [string, any, Record<string, string>, Record<string, string>][] = [
      [SITE.main, s.fast || {}, ROLE, {}],
      [SITE.node, (s.remote || {}).fast || {}, ROLE_NODE, DEV_NODE],
    ];
    const diskTemp = (host: string, d: string | null) => {
      if (!d) return null;
      const ds =
        host === SITE.main
          ? HDR.filter((x: any) => x.host === SITE.main && x.dev === d)
          : HDR.filter(
              (x: any) =>
                x.host === SITE.node &&
                (MEMBERS_NODE[d] || []).includes(+String(x.dev).replace('bay ', '')),
            );
      const tv = ds.filter((x: any) => x.temp != null);
      if (!tv.length) return null;
      const hot = tv.reduce((a: any, b: any) =>
        b.temp - L.driveThr(b)[1] > a.temp - L.driveThr(a)[1] ? b : a,
      );
      const [w, bad] = L.driveThr(hot);
      return {
        v: hot.temp + '°C',
        cls: hot.temp >= bad ? 'stale' : hot.temp >= w ? 'warnc' : '',
        tip:
          tv.map((x: any) => `${x.dev} ${x.temp}°C`).join(' · ') + ` · yellow ${w}°C, red ${bad}°C`,
        of:
          tv.length > 1
            ? `max of ${tv.length} (${tv.map((x: any) => String(x.dev).replace('bay ', 'b')).join(',')})`
            : '',
      };
    };
    return both.flatMap(([host, F, roles, devs]) => {
      const devOf: Record<string, string> = {};
      for (const [d, m] of Object.entries(devs)) devOf[String(m).split(' ')[0]] = d;
      const io = F.disks || {},
        seen = new Set<string>(),
        rows: any[] = [];
      const row = (m: any, d: string | null) => {
        const first = !!d && !seen.has(d); // two mounts on one disk: its read/write rate shows once
        if (d) seen.add(d);
        const u = m && m.usage,
          // like df: used over (used + available), so blocks reserved for root don't count as used
          used = u && !m.shutdown ? (u.used != null ? u.used / (u.used + u.free) : (u.total - u.free) / u.total) : null,
          v = d && first ? io[d] : null;
        const g: any[] = m?.group || (m ? [m] : []);
        const role = !m
          ? ''
          : [
              roles[m.mount],
              m.source ? (g.length > 1 ? `network mounts (${g.length}), one filesystem` : 'network mount') : '',
              g.every((x) => x.ro) ? 'read-only' : '',
            ]
              .filter(Boolean)
              .join(' · ');
        const usedCell = !m
          ? { kind: 'none', text: 'no mount' }
          : !m.mounted
            ? { kind: 'none', text: 'not mounted' }
            : used == null
              ? { kind: 'bad', text: m.shutdown ? 'shut down' : 'unreadable' }
              : {
                  kind: 'bar',
                  frac: used,
                  cls: used > 0.9 ? 'bad' : used > 0.75 ? 'warn' : '',
                  text: `${Math.ceil(used * 100)}% of ${fb(u.total, 1)}`,
                  tip: `${fb(u.used ?? u.total - u.free)} used of ${fb(u.total)} (${Math.ceil(used * 100)}%)${m.source ? ` · on ${m.source}, shared with every mount from there` : ''}`,
                };
        return {
          host,
          mounts: m ? g.map((x) => x.mount) : ['—'],
          mountTip: m?.also?.length ? 'also mounted at ' + m.also.join(', ') : '',
          also: m?.also?.length || 0,
          role,
          dev: m?.source ? m.share : (m?.part ?? d) || '—',
          devTip: m?.source
            ? g.map((x) => `${x.mount} ← ${x.source}${x.ro ? ' (read-only)' : ''}`).join('\n')
            : m?.model || '',
          used: usedCell as any,
          free: used == null ? '' : fb(u.free),
          rd: v ? rate(v.read) : d && !first ? '″' : '—',
          wr: v ? rate(v.write) : d && !first ? '″' : '—',
          temp: first ? diskTemp(host, d) : null,
        };
      };
      // network mounts of one filesystem (same server, same size) share one row: their use is the same number
      const ms: any[] = [],
        net: Record<string, any> = {};
      for (const m of F.mounts || []) {
        if (!m.source) {
          ms.push(m);
          continue;
        }
        const [srv, path] = [m.source.split(':')[0], m.source.slice(m.source.indexOf(':') + 1)];
        const k = srv + '|' + (m.usage?.total ?? m.mount);
        const n = net[k];
        if (!n) {
          ms.push((net[k] = { ...m, group: [m], share: m.source, dir: path }));
          continue;
        }
        n.group.push(m);
        while (n.dir.length > 1 && !(path + '/').startsWith(n.dir + '/'))
          n.dir = n.dir.slice(0, n.dir.lastIndexOf('/')) || '/';
        n.share = `${srv}:${n.dir}`;
      }
      for (const m of ms) rows.push(row(m, m.source ? null : m.dev || devOf[m.mount] || null));
      for (const d of Object.keys(io).sort()) if (!seen.has(d)) rows.push(row(null, d));
      return rows;
    });
  });
}
