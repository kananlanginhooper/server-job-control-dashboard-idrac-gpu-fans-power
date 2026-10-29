import { ModuleContext, setContext } from './app/module-context';
import { setSite } from './app/site';

/** Runtime config from the back end (GET api/config, relative to <base href>). Its site block names this
 *  installation's machines and must be in place before the app's modules load, so they're imported afterwards. */
async function loadConfig(apiBase = 'api/'): Promise<void> {
  try {
    const r = await fetch(apiBase + 'config', { cache: 'no-store' });
    if (r.ok) setSite((await r.json()).site);
  } catch { /* no back end (demo, or it's down): generic names */ }
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
