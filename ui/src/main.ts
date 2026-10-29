import { ModuleContext, setContext } from './app/core/module-context';
import { setSite } from './app/core/site';
import { setDemoCapture } from './app/core/demo-interceptor';
import { DEMO } from './app/core/demo';
import { AppConfig } from './app/core/api';

/** Runtime config from the back end (GET api/config, relative to <base href>). Its site block names this
 *  installation's machines and must be in place before the app's modules load, so they're imported afterwards. */
async function loadConfig(apiBase = 'api/'): Promise<void> {
  // The site names are also the hub API's data keys, so a page booted on the generic names shows the intake box
  // as offline. Retry a few times (back end restarting) before falling back to them.
  for (let i = 0, tries = DEMO ? 1 : 4; i < tries; i++) {
    try {
      const r = await fetch(apiBase + (DEMO ? 'config.json' : 'config'), { cache: 'no-store' });
      if (r.ok) { const c: AppConfig & { demo?: { capturedAt?: number } } = await r.json(); setSite(c.site); setDemoCapture(c.demo?.capturedAt); return; }
    } catch { /* back end down: retry */ }
    if (i < tries - 1) await new Promise(res => setTimeout(res, 1000 * 2 ** i));
  }
  console.warn('api/config unavailable: using generic site names (reload once the back end is up)');
}

const loadApp = () => Promise.all([import('@angular/platform-browser'), import('./app/app.config'), import('./app/app')]);

/** Optional embed entry. The wrapper frames the standalone page now; nothing depends on this. */
export async function mount(host: HTMLElement, ctx: ModuleContext): Promise<() => void> {
  setContext(ctx);
  await loadConfig(ctx.apiBase.replace(/^\//, ''));
  const [{ createApplication }, { appConfig }, { App }] = await loadApp();
  const el = host.appendChild(document.createElement('app-root'));
  const app = await createApplication(appConfig);
  app.bootstrap(App, el);
  return () => { app.destroy(); el.remove(); };
}

// standalone page: index.html has <app-root> in the body
if (document.querySelector('body > app-root')) {
  loadConfig()
    .then(loadApp)
    .then(([{ bootstrapApplication }, { appConfig }, { App }]) => bootstrapApplication(App, appConfig))
    .catch(err => console.error(err));
}
