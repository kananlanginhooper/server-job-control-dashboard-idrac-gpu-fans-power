/* eslint-disable @typescript-eslint/no-explicit-any */
import { SITE, t } from '../../core/site';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { DashboardStore } from '../../core/dashboard.store';
import { Bar } from '../../shared/bar';

const PIPE_STG: [RegExp, string][] = [[new RegExp(`^${SITE.node} evidence|^1a`, 'i'), '1a'], [/^1b/i, '1b'], [/^2-|Catalog and dedup/i, '2'], [/^3-/, '3'], [/^4-/, '4'], [/^5a/i, '5a'], [/^5b/i, '5b'],
  [/^Offsite/i, '6'], [/^7-/, '7'], [/Copilot/i, 'AI'], [/Dashboard|RunModes/i, 'dash'], [/Power and Jobs/i, 'power'], [/Server infra|Coordination/i, 'infra']];
const PIPE_ORD = ['1a', '1b', '2', '3', '4', '5a', '5b', '6', '7', 'AI', 'dash', 'power', 'infra', '–'];
const PS: Record<string, string> = { running: 'running', paused: 'paused', blocked: 'failed', failed: 'failed', idle: 'queued', done: 'done', role: 'queued' };

/** Pipeline status: one row per job lock: step, status, progress, detail */
@Component({
  selector: '[app-pipeline]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Bar],
  template: `
    <h2>Pipeline status</h2>
    <div id="pipe">
      @if (!store.state()) { <p class="muted">loading…</p> }
      @else if (!jobs().rows.length) { <p class="muted">no job locks held</p> }
      @else {
        <div class="pjh muted">{{ jobs().head }}</div>
        @for (j of jobs().rows; track j.job) {
          <div class="pj" [title]="j.tip"><span class="stg">{{ j.stg }}</span><span class="mono jn">{{ j.job }}</span>
            <span class="pill {{ j.pill }}">{{ j.status }}</span>
            <span class="pjb">@if (j.pct != null) { <app-bar [frac]="j.pct" [cls]="j.pct >= 0.999 ? 'ok' : ''" /> }</span>
            <span class="muted pjd">{{ j.txt }}</span></div>
        }
      }
    </div>`,
})
export class Pipeline {
  protected readonly store = inject(DashboardStore);
  protected readonly jobs = computed(() => {
    const s = this.store.state() || {};
    const stage = (j: any) => { const w = ((j.what || '').match(/\[was: ([^;\]]*)/) || [])[1] || j.owner || ''; return (PIPE_STG.find(([r]) => r.test(w)) || [, '–'])[1] as string; };
    const jl = (s.job_locks || []).map((j: any) => ({ stg: stage(j), ...j }));
    jl.sort((a: any, b: any) => PIPE_ORD.indexOf(a.stg) - PIPE_ORD.indexOf(b.stg) || a.job.localeCompare(b.job));
    const cnt: Record<string, number> = {};
    for (const j of jl) cnt[j.status || '?'] = (cnt[j.status || '?'] || 0) + 1;
    const owner = [...new Set(jl.map((j: any) => String(j.owner || '?').replace(/\s*\(.*$/, '')))].join(', ');
    return {
      head: t(`${jl.length} jobs · ${Object.entries(cnt).map(([k, n]) => `${n} ${k}`).join(' · ')}${owner ? t(` · owner: ${owner}`) : ''}`),
      rows: jl.map((j: any) => {
        const p = j.progress;
        return { job: j.job, stg: j.stg, status: j.status || '?', pill: PS[j.status] || 'queued',
          tip: (j.what || '') + (j.claimed ? '\nclaimed ' + j.claimed : ''),
          pct: p && p.pct != null ? Math.min(1, p.pct / 100) : null,
          txt: [p && p.text, j.detail].filter(Boolean).join(' · ') };
      }),
    };
  });
}
