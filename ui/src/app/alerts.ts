/* eslint-disable @typescript-eslint/no-explicit-any */
import { t } from './site';
// "Needs attention" rules, ported 1:1 from render() / renderTasks() / addAlert() in the original page.
// Each alert is [cls, html]; cls "" = red, "warn" = yellow. The html only carries <b> and values already escaped.
import { dur, esc, fb, hhmm } from './fmt';

export type Alert = [string, string];

export const emergSens = (e: any): string[] => Object.entries(e.sensors || {}).map(([n, v]: [string, any]) =>
  `${esc(n)}${v.kind ? ' (' + esc(v.kind) + ')' : ''} ${v.first ?? '?'}°C at trigger${v.enter != null ? ` (limit ${v.enter}°C)` : ''}${v.peak != null && v.peak !== v.first ? `, peak ${v.peak}°C` : ''}${e.end == null && e.now && e.now[n] != null ? `, now ${e.now[n]}°C` : ''}`);
export const emergGpu = (e: any) => e.gpu && e.host === t('{node}') ? `GPU ${e.gpu.temp ?? '?'}°C, power limit ${e.gpu.limit_set ?? '?'} W, card fan ${e.gpu.card_fan ?? '?'}%.` : '';
/** dismiss key: same as the server-side key (digits folded so a changing number doesn't bring it back) */
export const akey = (h: string) => String(h).replace(/<[^>]*>/g, '').replace(/[\d.,:]+/g, '#').slice(0, 200);

function mainAlerts(s: any): Alert[] {
  const f = s.fast || {}, alerts: Alert[] = [];
  for (const [n, st] of Object.entries(f.nvme || {})) if (st && st !== 'live')
    alerts.push(['', `<b>${esc(n)} is ${esc(st)}</b> — ${n === 'nvme1' ? '/n4 (990 PRO) dropped off the bus 2026-09-23 19:13. Needs a full power-off; then catalogue it read-only and copy files found nowhere else to /e.' : 'NVMe controller not live.'}`]);
  for (const m of f.mounts || []) if (m.shutdown) alerts.push(['', `<b>${esc(m.mount)} filesystem is shut down</b> (emergency read-only). No writes, no fsck until copied off.`]);
  if (f.edac && (f.edac.ce || f.edac.ue)) alerts.push([f.edac.ue ? '' : 'warn', `<b>Memory errors:</b> ${f.edac.ce} corrected, ${f.edac.ue} uncorrected (EDAC). Verify copies by hash.`]);
  if ((f.stuck || []).length) alerts.push(['', t(`<b>${f.stuck.length} process${f.stuck.length > 1 ? 'es' : ''} stuck in disk wait on the {main}</b> (no CPU progress for ${dur(Math.min(...f.stuck.map((x: any) => x.for_s)))}+): ${esc(f.stuck.slice(0, 3).map((x: any) => x.pid + ' ' + x.name.split(' ')[0]).join(', '))}. A drive or mount may be hung.`)]);
  for (const e of (s.emergencies || []).slice().reverse()) {
    const sens = emergSens(e).join('; '), gpuBit = emergGpu(e) ? ' ' + emergGpu(e) : '';
    if (e.end == null) alerts.unshift(['', `<b>${esc(e.host)} Emergency Cool since ${hhmm(e.start)} (${dur(s.now - e.start)})</b>: ${sens}. Fans ${e.fan_pct ?? '?'}%.${gpuBit}`]);
    else if (s.now - e.end < 12 * 3600) alerts.push(['warn', `<b>${esc(e.host)} was in Emergency Cool ${hhmm(e.start)}–${hhmm(e.end)} (${dur(e.end - e.start)})</b>: ${sens}.`]);
  }
  const des = (s.runprofile || {}).desired || {};
  const pk = (P: any) => P ? (P.max ?? P.peak_5s ?? P.w) : null, p730 = pk(f.power), p720 = pk(((s.remote || {}).fast || {}).power);
  if (p730 != null && p720 != null && p730 + p720 >= ((des.profile === 'adaptive' && des.power_w) || 1250))
    alerts.unshift(['', t(`<b>Combined server power peak ${Math.round(p730 + p720)} W</b> ({main} ${Math.round(p730)} + {node} ${Math.round(p720)} W, 60 s peaks) is over the ${des.power_w || 1250} W Adaptive target. The 01:19 outage happened at about 1,040 W average plus spikes.`)]);
  const pw = ((s.remote || {}).fast || {}).power_watch || {};
  if (pw.ts && s.now - pw.ts < 120) {
    const P = ((s.remote || {}).fast || {}).power || {}, w = P.max ?? P.peak_5s ?? (pw.power || {}).w, cap = pw.capacity_w, g = pw.gpu_throttle || {};
    if (cap && w != null && w >= 0.9 * cap) alerts.unshift(['', t(`<b>{node} power peak (last 60 s) ${Math.round(w)} W is ${Math.round(w / cap * 100)}% of its PSU capacity (${cap} W: ${pw.psu_healthy} working × ${pw.psu_rating_w} W).</b> ${w >= cap ? 'Over capacity: expect CPU/GPU clamping or a PSU trip.' : 'At or above the 90% line (' + Math.round(0.9 * cap) + ' W).'} 5-min peak ${P.max_5m != null ? Math.round(P.max_5m) + ' W' : '?'}.`)]);
    else if (cap && w != null && w >= 0.85 * cap) alerts.push(['warn', t(`<b>{node} power peak ${Math.round(w)} W is ${Math.round(w / cap * 100)}% of its PSU capacity (${cap} W).</b>`)]);
    if (pw.psu_rating_w && pw.psu_healthy != null && pw.psu_healthy < 2) alerts.push(['warn', t(`<b>{node} is on ${pw.psu_healthy} of 2 PSUs</b> (no redundancy; ${pw.psu_rating_w} W each).`)]);
    if ((pw.psu_flagged || []).length) alerts.push(['warn', t(`<b>{node} ${pw.psu_flagged.map((x: string) => x.toUpperCase()).join(', ')} is delivering power but the iDRAC still flags "Failure detected"</b> (latched since 09-26). Check the iDRAC PSU page; reseat or clear the log if it stays.`)]);
    if (pw.low_clock_s >= 30) alerts.unshift(['', t(`<b>{node} CPU clock low under load:</b> median ${Math.round(pw.median_busy_mhz)} MHz across ${pw.busy_cpus} busy CPUs for ${dur(pw.low_clock_s)} (below 1,800). A PSU overload clamps these CPUs to about 1.2 GHz.`)]);
    if (pw.pkg_throttle_delta_60s > 0) alerts.push(['warn', t(`<b>{node} CPU package throttling:</b> +${pw.pkg_throttle_delta_60s} throttle events in the last minute.`)]);
    if (g.hw_slowdown || g.hw_power_brake) alerts.unshift(['', t(`<b>{node} GPU hardware ${g.hw_power_brake ? 'power-brake' : 'slowdown'} active</b> (SM ${g.sm_mhz ?? '?'} MHz). That's the board or PSU pulling the brake, not a temperature limit.`)]);
    const psel = ((pw.sel || {}).events || []).filter((e: any) => s.now - e.ts < 86400 && !/deasserted/i.test(e.text));
    if (psel.length) alerts.push(['warn', t(`<b>{node} power events in the last 24 h:</b> ${psel.slice(-4).map((e: any) => `${esc(e.sensor)}: ${esc(e.text.replace(/\s*\|\s*Asserted/, ''))} at ${hhmm(e.ts)}`).join('; ')}.`)]);
  }
  const sel = s.sel || {};
  if (sel.events) {
    const acLost = sel.events.filter((e: any) => /AC lost/i.test(e.text)).map((e: any) => e.ts);
    const ecc = sel.events.filter((e: any) => e.ecc_uncorr).map((e: any) => ({ ...e, afterPower: acLost.some((t: number) => e.ts >= t && e.ts - t <= 120) })), byDimm: Record<string, any[]> = {};
    ecc.forEach((e: any) => { const k = e.dimm || '?'; (byDimm[k] = byDimm[k] || []).push(e); });
    const fmt = (t: number) => new Date(t * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    for (const [dimm, list] of Object.entries(byDimm)) {
      const alone = list.filter(e => !e.afterPower), last = list[list.length - 1];
      const a: Alert = [alone.length ? '' : 'warn', t(`<b>{main} memory: ${list.length} uncorrectable ECC error${list.length > 1 ? 's' : ''} on DIMM ${esc(dimm)} in 7 days</b> (last ${fmt(last.ts)}).`)
        + (alone.length ? ` <b>${alone.length} not near a power loss</b> (${alone.map(e => fmt(e.ts)).join(', ')}): watch or replace this DIMM.` : ' All within 2 min after an AC power loss, so likely a symptom of the power loss rather than a bad DIMM.')];
      if (alone.length) alerts.unshift(a); else alerts.push(a);
    }
    const psu = sel.events.filter((e: any) => /power supply/i.test(e.sensor) && s.now - e.ts < 86400);
    if (psu.length) alerts.push(['warn', t(`<b>{main} power supply events in the last 24 h:</b> ${psu.map((e: any) => `${esc(e.text)} at ${hhmm(e.ts)}`).join('; ')}.`)]);
  }
  if (sel.percent_used != null && sel.percent_used >= 90) alerts.push(['warn', t(`<b>{main} hardware event log (SEL) is ${sel.percent_used}% full.</b> New events may not be recorded. A copy is saved in {main} ~/dashboard/sel-archive/; clearing it is {owner}'s call.`)]);
  for (const a of (s.roadmap && s.roadmap.alerts) || []) alerts.push([a.level === 'warn' ? 'warn' : '', a.html]);
  return alerts;
}

/** alerts the original appended later with addAlert(): new drives, laptop copy errors, tasks, drive health (in that order) */
function lateAlerts(s: any): Alert[] {
  const out: Alert[] = [], db = s.db || {};
  const drives = db.drives || [];
  const nNew = drives.filter((d: any) => d.status === 'new' || (d.status === 'evidence' && /^auto-registered/.test(d.notes || ''))).length;   // every new drive is a recovery drive until fully scanned
  if (nNew) out.push(['warn', `<b>${nNew} new drive${nNew > 1 ? 's' : ''} not checked yet</b> — see the drive registry.`]);

  const lf = (s.laptop || {}).fast || {}, ljdu = (s.lapjobs || {}).du || {};
  const rcArgs = (((lf.procs || {}).robocopy || {}).args || []).join(' | ').toLowerCase();
  const NET = new Set([53, 59, 64, 67, 121, 1231, 1232]);
  for (const j of (lf.copy_jobs || [])) {
    const dest = String(j.dest || '').replace(/\\+$/, '').toLowerCase();
    if (dest && rcArgs.includes(dest)) continue;
    if (j.finished) continue;
    if (j.last_error && NET.has(j.last_error.code) && !/abort/i.test(j.log) && s.now - j.mtime < 6 * 3600) {
      const le = j.last_error || {};
      out.push(['warn', t(`<b>Laptop copy ${esc(j.log)} stopped: network errors</b> at ${esc(String(le.t || '').slice(11, 16))} (ERROR ${le.code}: ${esc(le.msg || '')}); ${fb(ljdu[j.dest])} on the {main} so far. The copy scripts skip files already copied, so a rerun resumes.`)]);
    }
  }

  for (const t of s.tasks || []) {
    const bad = ['failed', 'blocked'].includes(t.state) && s.now - (t.updated_at || s.now) < 86400;
    if (bad || t.stale === 3)
      out.push([t.state === 'failed' ? '' : 'warn', `<b>Task ${esc(t.title || t.id)} ${bad ? esc(t.state) : 'has not reported for ' + dur(t.age)}</b>${t.host ? ' on ' + esc(t.host) : ''}${t.error ? ': ' + esc(t.error) : ''}.`]);
  }

  const RANK: Record<string, number> = { bad: 0, watch: 1, unknown: 2, ok: 3 };
  const hd = ((s.health || {}).drives || []).slice().sort((a: any, b: any) => (RANK[a.level] - RANK[b.level]) || String(a.host).localeCompare(b.host) || String(a.dev).localeCompare(b.dev, undefined, { numeric: true }));
  for (const d of hd.filter((d: any) => d.level === 'bad' || d.level === 'watch'))
    out.push([d.level === 'bad' ? '' : 'warn', `<b>${esc(d.host)} ${esc(d.dev)} (${esc(d.model || '')} ${esc(d.serial || '')}):</b> ${esc((d.issues || []).filter(([l]: any) => l !== 'info').map(([, t]: any) => t).join('; '))}`]);
  return out;
}

/** Every alert to show, with its dismiss key, minus the dismissed ones. */
export function buildAlerts(s: any): { cls: string; html: string; key: string }[] {
  const dAl = ((s.dismissed || {}).alerts) || {};
  return [...mainAlerts(s), ...lateAlerts(s)].map(([cls, html]) => ({ cls, html, key: akey(html) })).filter(a => !dAl[a.key]);
}
