# Satellite Supply Plan

Decision tool for the satellite supply case: turns the launch plan into SKU demand, tests it against supplier machine capacity, and shows the gaps and actions to close them. All data is fictional, taken from `Intern Case Inputs.xlsx`.

## Files
- `index.html`, `styles.css`: page and styling
- `data.js`: case inputs, generated from the workbook
- `engine.js`: the model (same type-by-type greedy allocation and build-ahead logic as the Excel)
- `app.js`: charts, tables, controls, recommendations
- `vendor/chart.umd.min.js`: Chart.js 4.4.1, bundled so the app works offline

## Offline fallback
Open `index.html` directly in a browser by double-clicking it. Everything runs locally. Without internet the only change is the font, which falls back to Helvetica/Arial.

## Reconciliation to Excel
With default inputs the app matches the Excel (workbook of 2026-10-29 11:30) month by month, including per-SKU gaps, machines to add by group (24 / 12) and Shared supplier/buyer attribution:

| Case | Gap hrs (G / G+P) | Gap units | Satellites short |
|---|---|---|---|
| No stockpiling (base) | 46,969.2 / 12,528.5 | 28,469 / 10,033 | 1,220 / 702 |
| Stockpiling allowed (directional) | 45,483.9 / 10,651.1 | 27,504 / 8,562 | 1,118 / 465 |

The hero shows a ✓ badge when this check passes for the selected build-ahead mode.
