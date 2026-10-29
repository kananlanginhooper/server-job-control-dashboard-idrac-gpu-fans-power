import { HttpInterceptorFn } from '@angular/common/http';

/**
 * What the home-dashboards wrapper passes to mount() (see MODULES.md at the repo root).
 * Standalone (:8094) keeps the defaults: API at /api/, storage keys unprefixed.
 */
export interface ModuleContext { id: string; apiBase: string; }
let ctx: ModuleContext = { id: '', apiBase: 'api/' };   // relative to <base href>, so the app works under any UI_BASE_PATH

export function setContext(c: ModuleContext) { ctx = c; }

/** localStorage key, prefixed with the module id inside the wrapper (all modules share its origin) */
export const lsKey = (k: string) => ctx.id ? `${ctx.id}.${k}` : k;

/** code calls '/api/...'; inside the wrapper that becomes '/m/<id>/api/...' (proxied to app.py by the wrapper's server) */
export const apiBaseInterceptor: HttpInterceptorFn = (req, next) =>
  next(req.url.startsWith('/api/') ? req.clone({ url: ctx.apiBase + req.url.slice(5) }) : req);
