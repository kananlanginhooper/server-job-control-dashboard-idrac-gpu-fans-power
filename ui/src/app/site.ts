/**
 * Site config: the names and descriptions of THIS installation's machines, from GET /api/config (`site`), which the
 * back end reads from the private SJC_SITE_FILE. The code only knows roles:
 *   main = the server that runs the hub API and catalogue, node = the GPU server, box = the intake desktop.
 * The hub API's own data keys use the real host names (e.g. state[<node>], power_<main>_peak), so code builds
 * keys and text from these names with t(). The defaults below are what a fresh clone (or the demo) shows.
 */
export interface Site {
  main: string; node: string; box: string;     // host names as the hub API spells them (keys) and as shown
  Box: string;                                 // the intake box's display name
  nodeGpu: string; boxGpu: string;             // GPU model labels
  owner: string;                               // who makes the calls the page defers to
  roles: Record<string, string>;               // host -> one-line description on its server card
  peers: Record<string, string>;               // LAN address -> label in the connections table
  mounts: Record<string, string>;              // mount point -> what it holds
  devMount: Record<string, string>;            // block device -> mount point
  notes: Record<string, string>;               // free-text notes keyed by name (alert hints, file locations)
}

export const SITE: Site = {
  main: 'server-a', node: 'server-b', box: 'desk-1', Box: 'Desk 1',
  nodeGpu: 'GPU (node)', boxGpu: 'GPU (desk)', owner: 'the owner',
  roles: {}, peers: {}, mounts: {}, devMount: {}, notes: {},
};

export function setSite(s: Partial<Site> | null | undefined) {
  if (s) Object.assign(SITE, s);
}

/** Fill {main} {node} {box} {Box} {nodeGpu} {boxGpu} {owner} in a string with this site's names. */
export const t = (s: string): string =>
  s.replace(/\{(main|node|box|Box|nodeGpu|boxGpu|owner)\}/g, (_, k: keyof Site) => String(SITE[k]));

/** A site note by key ('' when the site doesn't define it). */
export const note = (k: string): string => SITE.notes[k] || '';
