# EKG Layout Viewer

Interactive swim-lane layout prototype for Event Knowledge Graphs, built with D3.js.

The viewer now supports a two-stage exploration flow:
- `Overview` shows a case meta-graph, where purchase orders are connected through a generic k-nearest-neighbor similarity model built from activity profile, resource overlap, stable context attributes, temporal proximity, and case size. Each detected community also exposes its participating resources and stable attributes as satellite nodes.
- `Selected PO` reuses the same left-to-right scaffold for one PO, then progressively reveals POItems and timelines for detail without switching to a different visual grammar.

## File structure

```
viewer/
├── index.html   — entry point, app wiring
├── style.css    — design system (CSS variables, all component styles)
├── layout.js    — pure layout computation (no DOM access)
├── filters.js   — data loading, CSV parsing, filter logic
└── render.js    — all SVG drawing, consumes layout output
```

## Running

### Option 1 — Local server (recommended)

From the repo root:
```bash
npx serve .
```
Then open `http://localhost:3000/viewer/index.html`.

The viewer will automatically load `output/events.csv`, `output/entities.csv`,
`output/corr.csv`, and `output/df.csv`.

### Option 2 — File picker

Open `viewer/index.html` directly in a browser (double-click).
Click "Select CSV files…" and select all four CSVs from `output/` at once.

> Note: `log.csv` and `has.csv` are not used by the viewer — only the four files above.

## Controls

| Control | Description |
|---|---|
| PO selector | Click any PO in the list to visualise it |
| Overview / Selected PO | Toggle between full-graph overview and detailed PO view |
| PO search | Filter the PO list by ID |
| DF (item) toggle | Show/hide directly-follows edges within each POItem |
| DF (PO) toggle | Show/hide cross-item directly-follows arcs |
| CORR toggle | Show/hide event→entity correlation edges |
| Opacity sliders | Reduce visual weight of each edge type independently |
| Max items slider | Cap the number of POItems shown (clutter guard) |
| Activity filter | Checkboxes to hide/show specific activity types |
| Fit view | Zoom to fit all lanes in the viewport |
| Reset zoom | Return to 1:1 scale |
| Scroll | Zoom in/out |
| Drag | Pan the canvas |
| Click event node | Select and highlight that event |

## Clutter safeguards

The viewer automatically warns when:
- A PO has more than 8 POItems (use the max items slider)
- More than 120 events are shown after filtering (use activity filter)

CORR edges are hidden by default as they are the largest source of visual noise.

## Layout rationale

The overview is aggregate-first on purpose. Showing every event for every PO at once destroys readability, so the global mode derives a sparse case-similarity network, detects communities with weighted label propagation, and places those communities as stable bubbles in a deterministic spiral. Resources and stable attributes are shown as community satellites so the process context is visible immediately. Clicking a PO opens the detailed swim-lane view with the same anchors (`PO -> item lane -> timeline`), which preserves mental continuity and keeps navigation smooth.
