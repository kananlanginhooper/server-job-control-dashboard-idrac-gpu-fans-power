/* eslint-disable @typescript-eslint/no-explicit-any */
export type Dash = boolean | 'dot' | undefined;
export interface Series { k: string; label: string; short?: string; color: string; dash?: Dash; }
export interface Point { t: number; [k: string]: any }

/** Same option shape as lineChart(el, o) in the original page. */
export interface LineOpts {
  id: string;
  points: Point[];
  series: Series[];
  range_s: number;
  bucket_s?: number;
  x1?: number;
  height?: number;
  left?: number;
  right?: number;
  fmt: (v: any) => string;
  axis?: (v: number) => string;
  minMax?: number;
  yRange?: number[];
  yStep?: number;
  yMaxGrid?: number;
  yLabelStep?: number;
  grid?: number;
  ticks?: number;
  empty?: string;
  label?: string;
  extra?: (p: Point) => [string, string][];
}

export interface Track {
  title: string;
  height: number;
  fmt: (v: any) => string;
  axis: (v: number) => string;
  yRange?: number[];
  minMax?: number;
  series: Series[];
}
/** Same option shape as trackChart(el, o) in the original page. */
export interface TrackOpts {
  id: string;
  points: Point[];
  range_s: number;
  bucket_s?: number;
  left?: number;
  right?: number;
  label?: string;
  tracks: Track[];
}

export const dashArray = (d: Dash) => d ? (d === 'dot' ? '2 3' : '6 4') : null;
export const keyBg = (s: Series) => s.dash ? `repeating-linear-gradient(90deg,var(${s.color}) 0 4px,transparent 4px 7px)` : `var(${s.color})`;
