# Refactor: charts to ECharts (before / after)

Screenshots of every chart in the demo (generic mock data), captured with `node ui/demo/shoot.mjs <demo url> <dir>`:
`before/` is the hand-drawn SVG version (main at c01e065), `after/` the ECharts version on `refactor/template`.
File names match by chart title. `after/` has two more charts than `before/`: the intake box's GPU power and memory. In the
before build the demo showed that GPU as offline, because the code read the box's data under its live host name instead of the
site config's name (fixed in the GPU/servers split), so numbers from 03 on are shifted by two. `00-hover-first-chart.png` shows the tooltip.

## Features kept (same `opts` inputs, same selectors; no card changed)

LineChart (`app-line-chart`):
- time on x over the whole window (`range_s`, ending at `x1` or now), evenly spaced ticks (2-6 by width), first label left-aligned, last right-aligned
- one shared y axis: 0 to a nice max over the data (at least `minMax`), or `yRange` stretched to the data in `yStep` steps (at most `yMaxGrid` lines); `grid` lines; `axis` label format; only every `yLabelStep` labelled when set
- several series, CSS-variable colors, solid / dashed (6 4) / dotted (2 3), 2 px round joins
- a line breaks where a value is missing or the gap is over 2.5 buckets
- "short value" labels at the line ends, pushed apart when they collide; no end labels under 520 px (phones), right margin sized to the longest label
- hover: vertical crosshair snapped to the nearest point, a dot on each line, tooltip with the time + bucket ("1-min avg", "live sample"), one row per series (color key, value, label) plus the `extra` rows
- `empty` text when there are no points; `label` as the aria-label; `height`, `left`, `right` as before

TrackChart (`app-track-chart`): stacked tracks on one shared time axis, each with its own title, height, y scale
(0 or `yRange[0]` to a nice max, values clamped into it), 3 grid lines, its own `axis`/`fmt`, end labels pushed apart,
time labels under the last track only, one crosshair through every track, tooltip grouped by track with a dashed key
for dashed series, "collecting…" when empty. (It is a stacked line chart, not a state/timeline chart.)

## Intentional differences (for review)
- The tooltip stays inside the chart (ECharts `confine`) and flips left/up near the edge; before it could hang over the next card.
- In a TrackChart, the hover dot shows on the hovered track's lines only (the crosshair still runs through every track).
- Text uses the page font through ECharts; sizes and weights are the same as before.
