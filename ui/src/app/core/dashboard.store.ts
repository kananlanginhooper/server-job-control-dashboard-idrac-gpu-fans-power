/* eslint-disable @typescript-eslint/no-explicit-any */
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Limits, RLABEL } from '../shared/format';
import { lsKey } from './module-context';

/**
 * All live data for the page, polled from the same app.py endpoints the original page uses:
 * /api/state every 5 s, /api/series?range= every 60 s, /api/iohist + /api/temphist every 30 s, /api/guardhist every 60 s.
 * Control POSTs (run profile, Quick Cool, Meeting Mode, GPU switch, dismiss) update the state optimistically, like the original.
 */
@Injectable({ providedIn: 'root' })
export class DashboardStore {
  private readonly http = inject(HttpClient);

  readonly state = signal<any>(null);
  readonly unreachable = signal(false);
  readonly series = signal<any>(null);      // SER: /api/series?range=
  readonly ioh = signal<any>(null);         // /api/iohist
  readonly th = signal<any>(null);          // /api/temphist
  readonly guard = signal<any>({ points: [], events: [] });
  readonly range = signal(3600);
  readonly rangeLabel = computed(() => RLABEL[this.range()] || '');
  readonly limits = computed(() => new Limits(this.state()?.limits));

  readonly busy = signal({ rp: false, qc: false, meeting: false, gpu: false });
  readonly showVolt = signal(false);   // Low Power / Meeting Mode: PSU voltage chart instead of total power (fan-controls)

  constructor() {
    try { const v = +(localStorage.getItem(lsKey('graphRange')) || 0); if (RLABEL[v]) this.range.set(v); } catch { /* storage blocked */ }
    const timers = [
      setInterval(() => this.tick(), 5000), setInterval(() => this.loadSeries(), 60000),
      setTimeout(() => this.loadIO(), 2000), setInterval(() => this.loadIO(), 30000),
      setTimeout(() => this.loadTH(), 1500), setInterval(() => this.loadTH(), 30000),
      setTimeout(() => this.loadGuard(), 1500), setInterval(() => this.loadGuard(), 60000)];
    inject(DestroyRef).onDestroy(() => timers.forEach(t => clearTimeout(t)));   // the wrapper unmounts modules it switches away from
    this.tick(); this.loadSeries();
  }

  /** GET as text and parse here: app.py's json.dumps can emit bare Infinity / NaN (e.g. an ETA at rate 0, 2026-10-05),
   *  which JSON.parse rejects and which blanked the original page; read them as null instead. */
  private async get<T>(url: string): Promise<T> {
    const txt = await firstValueFrom(this.http.get(url, { headers: { 'Cache-Control': 'no-store' }, responseType: 'text' }));
    try { return JSON.parse(txt); }
    catch { return JSON.parse(txt.replace(/([:,[]\s*)-?(?:Infinity|NaN)(?=\s*[,}\]])/g, '$1null')); }
  }
  private post(url: string, body: any) { return firstValueFrom(this.http.post<any>(url, body)); }

  async tick() {
    try { this.state.set(await this.get('/api/state')); this.unreachable.set(false); }
    catch { this.unreachable.set(true); }
  }
  async loadSeries() {
    const r = this.range();
    try { const d = await this.get(`/api/series?range=${r}`); if (r === this.range()) this.series.set(d); } catch { /* keep last */ }
  }
  async loadIO() { try { this.ioh.set(await this.get('/api/iohist')); } catch { /* keep last */ } }
  async loadTH() { try { this.th.set(await this.get('/api/temphist')); } catch { /* keep last */ } }
  async loadGuard() { try { this.guard.set(await this.get('/api/guardhist')); } catch { /* keep last */ } }

  setRange(r: number) {
    this.range.set(r); this.series.set(null);
    try { localStorage.setItem(lsKey('graphRange'), String(r)); } catch { /* storage blocked */ }
    this.loadSeries();
  }

  private patch(p: any) { const s = this.state(); if (s) this.state.set({ ...s, ...p }); }
  private setBusy(k: 'rp' | 'qc' | 'meeting' | 'gpu', v: boolean) { this.busy.update(b => ({ ...b, [k]: v })); }

  async runProfile(profile: string, power_w?: number) {
    if (this.busy().rp) return;
    this.setBusy('rp', true);
    try {
      const j = await this.post('/api/runprofile', power_w ? { profile, power_w } : { profile });
      if (!j.ok) alert(j.error || 'Run profile change refused');
      else if (j.hosts && Object.values(j.hosts).some(v => v !== 'ok')) alert('Run profile: ' + Object.entries(j.hosts).filter(([, v]) => v !== 'ok').map(([h, v]) => h + ': ' + v).join('; '));
      else { const rp = this.state()?.runprofile || {}; this.patch({ runprofile: { ...rp, desired: { ...(rp.desired || {}), profile: j.profile, at: j.at, by: j.by, power_w: power_w || null } } }); }
    } catch (e: any) { alert(e?.error?.error || "Couldn't reach the dashboard to change the run profile"); }
    this.setBusy('rp', false);
  }
  async quickCool() {
    if (this.busy().qc) return;
    const next = !(this.state()?.quickcool || {}).on;
    this.setBusy('qc', true);
    try { const j = await this.post('/api/quickcool', { on: next }); if (!j.ok) alert(j.error || 'Quick cool change refused'); else this.patch({ quickcool: { on: j.on, at: j.at, by: j.by } }); }
    catch (e: any) { alert(e?.error?.error || "Couldn't reach the dashboard to change Quick cool"); }
    this.setBusy('qc', false);
  }
  async meeting() {
    if (this.busy().meeting) return;
    const next = !(this.state()?.meeting || {}).on;
    this.setBusy('meeting', true);
    try { const j = await this.post('/api/meeting', { on: next }); if (!j.ok) alert(j.error || 'Meeting mode change refused'); else this.patch({ meeting: { on: j.on, at: j.at, by: j.by } }); }
    catch (e: any) { alert(e?.error?.error || "Couldn't reach the dashboard to change meeting mode"); }
    this.setBusy('meeting', false);
  }
  async gpu() {
    if (this.busy().gpu) return;
    const next = !(this.state()?.gpu_switch || {}).off;
    this.setBusy('gpu', true);
    try { const j = await this.post('/api/gpu', { off: next }); if (!j.ok) alert(j.error || 'GPU switch refused'); else this.patch({ gpu_switch: { off: j.off, at: j.at, by: j.by } }); }
    catch (e: any) { alert(e?.error?.error || "Couldn't reach the dashboard to change the GPU switch"); }
    this.setBusy('gpu', false);
  }
  /** ✕ dismiss for finished tasks and alerts; comes back if it recurs after 24 h */
  async dismiss(kind: 'tasks' | 'alerts', key: string) {
    const s = this.state();
    if (s) { const d = { tasks: {}, alerts: {}, ...(s.dismissed || {}) }; d[kind] = { ...(d[kind] || {}), [key]: Date.now() / 1000 }; this.patch({ dismissed: d }); }
    try { await this.post('/api/dismiss', { kind, key }); } catch { /* best effort, like the original */ }
  }
}
