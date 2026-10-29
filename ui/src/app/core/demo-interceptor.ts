import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { of } from 'rxjs';
import { map } from 'rxjs/operators';
import { DEMO } from './demo';

/** When the mock was captured (config.demo.capturedAt); timestamps are moved forward by (now - capturedAt). */
let capturedAt = 0;
export const setDemoCapture = (t: number | undefined) => {
  capturedAt = t || 0;
};

const EPOCH_LO = 1.6e9,
  EPOCH_HI = 2.0e9; // numbers in this range are Unix seconds
function shift(v: unknown, d: number): unknown {
  if (typeof v === 'number') return v > EPOCH_LO && v < EPOCH_HI ? v + d : v;
  if (Array.isArray(v)) return v.map((x) => shift(x, d));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x, d)]));
  return v;
}

/**
 * Demo only: GETs read the static mock files (<path>.json; query strings dropped) with every timestamp
 * moved to "now", so live views and charts look current. POSTs (controls) answer ok and change nothing.
 */
export const demoInterceptor: HttpInterceptorFn = (req, next) => {
  if (!DEMO) return next(req);
  if (req.method !== 'GET')
    return of(
      new HttpResponse({
        status: 200,
        body: { ...(req.body as object), ok: true, at: Date.now() / 1000, by: 'demo' },
      }),
    );
  const d = capturedAt ? Date.now() / 1000 - capturedAt : 0;
  return next(req.clone({ url: req.url.split('?')[0] + '.json' })).pipe(
    map((ev) => {
      if (!(ev instanceof HttpResponse) || !d) return ev;
      const text = typeof ev.body === 'string';
      let body: unknown = text ? JSON.parse(ev.body as string) : ev.body;
      body = shift(body, d);
      return ev.clone({ body: text ? JSON.stringify(body) : body });
    }),
  );
};
