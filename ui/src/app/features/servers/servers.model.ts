/* eslint-disable @typescript-eslint/no-explicit-any */
import { SITE } from '../../core/site';
import {
  GPU_FAN_MAX_RPM,
  Limits,
  driveKind,
  dur,
  fb,
  gpuFanPct,
  ipmiKind,
  num,
  numSort,
  rate,
} from '../../shared/format';
import { ioChart, memChart, tempChart } from './server-charts';
import { Kpi } from '../../shared/kpi-row';

/** A server card's role line from the site config; {nics} and {via} are filled with live values. */
const role = (host: string, live: Record<string, string>) =>
  (SITE.roles[host] || host).replace(/\{(\w+)\}/g, (m, k) => live[k] ?? m);

export interface Chip {
  name: string;
  val: string;
  cls?: string;
  title?: string;
}
export interface ChipRow {
  lbl: string;
  chips: Chip[];
  empty: string;
  note?: string;
  gpuName?: string;
}

/** Thermal chips for a server (coolHtml): fans, board, drives, GPU; colours from the shared component limits. */
function coolRows(sv: any, F: any, s: any, L: Limits): { rows: ChipRow[]; err: string } {
  const ip = F.ipmi || {},
    t = F.temps || {};
  const tc = (c: number, warn: number, bad: number) => (c >= bad ? 'bad' : c >= warn ? 'warn' : '');
  const lim = (k: string, d: number[]) => L.lim(k, d, sv.name);
  const LIM: Record<string, number[]> = {
    Inlet: lim('inlet', [36, 38]),
    Exhaust: lim('exhaust', [50, 60]),
    CPU1: lim('cpu', [80, 90]),
    CPU2: lim('cpu', [80, 90]),
  };
  const fans: Chip[] = (ip.fans || []).map((f: any) => ({
    name: f.name,
    val: num(Math.round(f.rpm)),
    cls: f.ok ? '' : 'bad',
  }));
  if (ip.power_w != null) fans.push({ name: 'Power', val: ip.power_w.toFixed(0) + ' W' });
  const board: Chip[] = (ip.temps || []).map((x: any) => {
    const c = x.ok
      ? tc(x.c, ...((LIM[x.name] || lim('ipmi_other', [60, 75])) as [number, number]))
      : 'bad';
    return {
      name: x.name,
      val: x.c.toFixed(0) + '°',
      cls: /inlet/i.test(x.name) && c ? c + ' info' : c,
      title: L.bandTip(ipmiKind(x.name), sv.name),
    };
  });
  for (const [i, c] of (t.coretemp || []).entries())
    board.push({
      name: 'pkg' + i,
      val: c.toFixed(0) + '°',
      cls: tc(c, ...(lim('cpu', [80, 90]) as [number, number])),
      title: 'coretemp package max\n' + L.bandTip('cpu', sv.name),
    });
  for (const [i, c] of (t.nvme || []).entries())
    board.push({
      name: 'NVMe' + i,
      val: c.toFixed(0) + '°',
      cls: tc(c, ...(lim('nvme', [80, 81]) as [number, number])),
      title: L.bandTip('nvme', sv.name),
    });
  for (const c of Object.values((F.fan_control || {}).raid || {}) as number[])
    board.push({
      name: 'RAID',
      val: c.toFixed(0) + '°',
      cls: tc(c, ...(lim('raid', [95, 96]) as [number, number])),
      title: L.bandTip('raid', sv.name),
    });
  const drives: Chip[] = ((s.health || {}).drives || [])
    .filter((d: any) => d.host === sv.name && d.temp != null)
    .sort((a: any, b: any) => numSort(a.dev, b.dev))
    .map((d: any) => {
      const [w, b] = L.driveThr(d);
      return {
        name: d.dev,
        val: d.temp + '°',
        cls: tc(d.temp, w, b),
        title:
          `${d.model || ''} ${d.serial || ''}\n` +
          (L.bandTip(driveKind(d), sv.name) || `yellow ${w}°C, red ${b}°C`),
      };
    });
  const rows: ChipRow[] = [
    { lbl: 'Fans', chips: fans, empty: '—', note: ip.redundancy ? '· ' + ip.redundancy : '' },
    { lbl: 'Board', chips: board, empty: '' },
    { lbl: 'Drives', chips: drives, empty: 'first SMART pass pending' },
  ];
  if (F.gpu) {
    const g = F.gpu,
      gp = gpuFanPct(g),
      chips: Chip[] = [
        {
          name: 'temp',
          val: g.temp.toFixed(0) + '°',
          cls: tc(g.temp, ...(lim('gpu', [90, 91]) as [number, number])),
          title:
            L.bandTip('gpu', sv.name) +
            (g.tlimit_margin != null ? `\n${g.tlimit_margin}°C below its slowdown limit` : ''),
        },
      ];
    if (gp != null)
      chips.push({
        name: 'fan',
        val: gp + '%' + (g.fan_rpm ? ' · ' + Math.round(g.fan_rpm).toLocaleString() + ' rpm' : ''),
        cls: gp >= lim('gpu_fan_pct', [98])[0] ? 'warn' : '',
        title: `percent of the card's full speed (${GPU_FAN_MAX_RPM.toLocaleString()} rpm, measured 2026-09-24); nvidia-smi says ${g.fan_pct ?? '?'}%\n${L.bandTip('gpu_fan_pct', sv.name)}`,
      });
    if (g.power_w != null)
      chips.push({
        name: 'power',
        val:
          g.power_w.toFixed(0) + (g.power_limit_w ? ' / ' + g.power_limit_w.toFixed(0) : '') + ' W',
      });
    chips.push(
      { name: 'load', val: g.util.toFixed(0) + '%' },
      { name: 'VRAM', val: fb(g.mem_used, 1) + ' / ' + fb(g.mem_total, 0) },
    );
    rows.push({ lbl: 'GPU', chips, empty: '', gpuName: g.name });
  }
  const age = ip.at ? s.now - ip.at : null;
  return {
    rows,
    err: ip.error ? ip.error : age != null && age > 120 ? `IPMI reading ${dur(age)} old` : '',
  };
}

/** What the server cards read from the store. */
export interface ServersCtx {
  limits: Limits;
  range: number;
  th: any;
  ioh: any;
  mq: any; // /api/v1/servers: host -> its MQTT parts
}

/**
 * A server's MQTT report (sjc/<host>/system, sensors, power, idrac, gpu, safety) in the shape the cards read, for what
 * MQTT carries. It's laid over the hub's data, which still supplies the rest (the "stuck" list, which needs the hub's
 * age rule; drive temperatures) and every chart's history.
 */
export function mqFast(v: any): any {
  if (v?.status !== 'online') return {};
  const out: any = {},
    sy = v.system;
  if (sy) {
    const io = Object.values<any>(sy.net_io || {}),
      nics = Object.entries<any>(sy.nics || {}).filter(([, n]) => n.up && n.speed_mbit);
    Object.assign(out, {
      cpu: sy.cpu_pct / 100,
      ncpu: sy.cpu_count,
      uptime_s: sy.uptime_s,
      mem: { total: sy.mem?.total, avail: sy.mem?.avail },
      net: {
        rx: io.reduce((a, n) => a + (n.rx_bps || 0), 0),
        tx: io.reduce((a, n) => a + (n.tx_bps || 0), 0),
        speed_mbit: Math.max(0, ...nics.map(([, n]) => n.speed_mbit)) || null,
        nics: Object.fromEntries(nics.map(([k, n]) => [k, { speed_mbit: n.speed_mbit }])),
      },
    });
    if (sy.load) out.load = sy.load;
    if (sy.dstate) out.dstate = sy.dstate.count; // processes in disk wait (D state) right now
    // RAPL per CPU package; {} on the agent's first sample after a restart
    if (sy.cpu_pkg_w && Object.keys(sy.cpu_pkg_w).length) out.power_watch = { pkg_w: sy.cpu_pkg_w };
  }
  const ts: any[] = v.sensors?.temps || [];
  if (ts.length) {
    const pick = (chip: string, label: RegExp) =>
      ts.filter((x) => x.chip === chip && label.test(x.label || '')).map((x) => x.c);
    // only the chips a machine has: an empty coretemp list would hide an AMD CPU's k10temp
    out.temps = Object.fromEntries(
      Object.entries({
        coretemp: pick('coretemp', /^Package/),
        k10temp: pick('k10temp', /^Tctl$/),
        nvme: pick('nvme', /^Composite$/),
      }).filter(([, v]) => v.length),
    );
  }
  if (v.power?.w != null) out.power = { w: v.power.w, max: v.power.max_60s, avg: v.power.avg_60s };
  if (v.idrac) out.ipmi = v.idrac;
  if (v.safety?.fan_control?.raid) out.fan_control = { raid: v.safety.fan_control.raid };
  const g = v.gpu?.cards?.[0];
  if (g) out.gpu = g;
  return out;
}

/** One card per machine (main server, GPU node, intake box): KPIs, thermal chips, and its four charts. */
export function serversView(s: any, ctx: ServersCtx) {
  const { limits: L, range, th, ioh } = ctx;
  const f = s.fast || {},
    rem = s.remote || {},
    rf = rem.fast || {},
    tugS = s[SITE.box] || {},
    age = s.now - (s.updated || 0);
  const list = [
    { name: SITE.main, role: role(SITE.main, {}), F: f, ok: age <= 30, primary: 'net-in', err: '' },
    {
      name: SITE.node,
      role: role(SITE.node, {
        nics: `${
          Object.entries((rf.net || {}).nics || {})
            .map(
              ([n, v]: [string, any]) =>
                `${n} ${v.speed_mbit >= 1000 ? v.speed_mbit / 1000 + ' Gb' : v.speed_mbit + ' Mb'}`,
            )
            .join(' + ') || 'NICs ?'
        }`,
        via: `${rem.via === 'db' ? 'via database' : 'direct link'}`,
      }),
      F: rf,
      ok: !!rem.ok,
      primary: 'net-out',
      err: rem.ok ? '' : rem.error ? 'agent unreachable: ' + rem.error : 'waiting for agent…',
    },
    // Tug server card
    {
      name: SITE.box,
      role: role(SITE.box, {}),
      F: tugS.fast || {},
      ok: !!tugS.ok,
      primary: 'net-in',
      err: tugS.ok ? '' : tugS.error ? 'agent unreachable: ' + tugS.error : 'waiting for agent…',
    },
  ];
  return list.map((sv0) => {
    const m = mqFast(ctx.mq?.[sv0.name]),
      online = ctx.mq?.[sv0.name]?.status === 'online';
    // MQTT readings over the hub's; the GPU keeps the hub's measured fan rpm, which MQTT doesn't carry
    const sv = {
      ...sv0,
      F: { ...sv0.F, ...m, ...(m.gpu ? { gpu: { ...sv0.F.gpu, ...m.gpu } } : {}) },
      ok: sv0.ok || online,
      err: sv0.ok || online ? '' : sv0.err,
    };
    const F = sv.F,
      mem = F.mem || {},
      net = F.net || {},
      t = F.temps || {};
    const cpuT = Math.max(0, ...(t.coretemp || t.k10temp || [0])),
      nvT: number[] = t.nvme || [],
      g = F.gpu;
    const link = `${net.speed_mbit >= 1000 ? net.speed_mbit / 1000 + ' Gb' : (net.speed_mbit || '?') + ' Mb'} link`;
    const kpis: Kpi[] = [
      { l: 'CPU', v: ((F.cpu || 0) * 100).toFixed(0) + '%', sub: `${F.ncpu || '?'} threads` },
      {
        l: 'Load',
        v: ((F.load || [0])[0] || 0).toFixed(1),
        sub: `${F.dstate || 0} in disk wait${(F.stuck || []).length ? ` · ${F.stuck.length} stuck` : ''}`,
        c: (F.stuck || []).length ? 'bad' : '',
      },
      { l: 'Memory', v: fb((mem.total || 0) - (mem.avail || 0), 0), sub: `of ${fb(mem.total, 0)}` },
      sv.primary === 'net-out'
        ? { l: 'Network out', v: rate(net.tx), sub: `in ${rate(net.rx)} · ${link}` }
        : { l: 'Network in', v: rate(net.rx), sub: `out ${rate(net.tx)} · ${link}` },
      {
        l: 'CPU temp',
        v: cpuT ? cpuT.toFixed(0) + '°C' : '—',
        sub: nvT.length
          ? 'NVMe ' + nvT.map((x) => x.toFixed(0) + '°').join(' / ')
          : g
            ? `GPU ${g.temp.toFixed(0)}° · ${g.util.toFixed(0)}%`
            : '',
        c: cpuT > 85 ? 'warn' : '',
      },
      { l: 'Uptime', v: F.uptime_s ? dur(F.uptime_s) : '—', sub: '' },
      sv.name === SITE.box
        ? ((pk: any) => ({
            l: 'CPU power',
            v: pk != null ? Math.round(pk) + ' W' : '—',
            sub: 'CPU package (RAPL) · wall power needs a metering plug',
          }))(((F.power_watch || {}).pkg_w || {})['package-0']) // no IPMI on Tug
        : {
            l: 'Power',
            v: F.power && F.power.w != null ? Math.round(F.power.w) + ' W' : '—',
            sub:
              F.power && F.power.avg != null
                ? `last 60 s: peak ${Math.round(F.power.max || 0)} W · avg ${Math.round(F.power.avg)} W`
                : 'IPMI DCMI',
          },
    ];
    const cool = sv.name === SITE.box ? null : coolRows(sv, F, s, L);
    // red only when a component is red; yellow is normal
    const hot = cool
      ? cool.rows.reduce((n, r) => n + r.chips.filter((c) => c.cls === 'bad').length, 0)
      : 0;
    return {
      name: sv.name,
      role: sv.role,
      ok: sv.ok,
      err: sv.err,
      kpis,
      cool,
      hot,
      th: tempChart(th, sv.name, range),
      net: ioChart(ioh, sv.name, 'net', range),
      disk: ioChart(ioh, sv.name, 'disk', range),
      mem: memChart(ioh, sv.name, range),
    };
  });
}
export type ServerCardView = ReturnType<typeof serversView>[number];
export type CoolView = NonNullable<ServerCardView['cool']>;
