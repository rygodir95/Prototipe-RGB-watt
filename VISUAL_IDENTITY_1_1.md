# Visual Identity 1.1 - Deep Blue + Performance Lime

Scope: **presentation only**. No BLE, firmware, sensor protocol, telemetry, API,
config-structure or backend change. Existing ids, `data-testid` values, event
bindings and behaviour are untouched, except the one intentional UI removal in
section 6.

## 1. Palette (already present as tokens, now used semantically)

| Role | Dark | Light | Token |
|---|---|---|---|
| Page | Deep Navy `#111C30` | Ice White `#F1F4F8` | `--bg` |
| Card | Racing Graphite `#1B2B45` | Pure Surface `#FFFFFF` | `--card` |
| Elevated surface | `#22344F` | `#F7F9FC` | `--bg-elev` |
| Body text | `#F4F7FB` | Navy Text `#172943` | `--text` |
| Muted text | Titanium `#A9B6C9` | `#5A6B82` | `--muted` |
| Interactive emphasis | Performance Lime `#B9E63B` | Deep Lime `#547F18` | `--lime` |
| Lime as text | `#B9E63B` | Lime Text `#4C7416` | `--lime-text` |
| Content on a lime fill | `#111C30` | `#FFFFFF` | `--on-lime` |
| Power identity / technical | Electric Blue `#3567D4` | `#3567D4` | `--sensor-power`, `--accent` |
| HR identity | `#FF5C8A` | `#D32B3D` | `--sensor-hr` |

New tokens: `--lime-hover`, `--lime-border` (subtle active-card border),
`--lime-tint` (secondary hover wash), and the per-theme `--on-lime` foreground.

## 2. Combined button system

- `.btn.primary` - filled lime, `--on-lime` content, `--lime-hover` on hover.
  Covers Save Power Zones, Save HR Zones, Scan, Save & Reboot, Upload & Flash.
- `.btn` (secondary) - surface background, lime outline, `--lime-text` label,
  `--lime-tint` wash on hover. Covers Reset, Save Settings, Export, Import,
  Copy, Test Lighting, Stop test.
- `.btn.danger` - unchanged error fill. Destructive is never lime.
- Focus ring stays Electric Blue: a lime ring on a lime fill measures 1.09:1
  (light) / 2.29:1 (dark). The 2px offset places the ring on the card, where it
  measures 5.20:1 / 4.27:1, so the indicator stays clearly visible.

## 3. Interactive controls

- ON switch track: `--lime`; knob: `--on-lime` (11.72:1 dark, 4.74:1 light).
- OFF switch track: `--field-border` neutral grey, unchanged.
- Slider thumb: `--lime` with a 2px `--card` ring so it separates from the track.
- Slider active track: lime. Unfilled track: `--field-border`.
  WebKit gets a two-stop gradient whose stop is `--fill`, written by
  `paintSliderFill()` in app.js (reads the input's own value; sends nothing).
  Firefox uses native `::-moz-range-progress`.
- Disabled slider/toggle: neutral track and thumb, no lime, no reduced opacity
  that would leave lime visible.

## 4. Cards and navigation

- Every card keeps its neutral hairline.
- The live power strip is the one ACTIVE card on the Dashboard and the only card
  with the subtle lime border (`--lime-border`, composited 1.85:1 light /
  2.63:1 dark - decorative emphasis, stronger than the 1.51:1 / 1.48:1 neutral
  hairline it replaces, and not a control boundary).
- Active nav indicator: lime, unchanged. Brand mark: fixed lime, unchanged.

## 5. Semantic separation (unchanged)

Lime never replaces a status colour. `--ok` / `--warn` / `--err` / `--err-fill`
keep their own values; the connection banner, demo banner dot, error chip and
toasts are untouched. Zone colours come from Hub config at runtime and are
never recoloured - the 5px live edge paints `zones[t.zone].color` verbatim.

## 6. UI change in Settings

The **Heart Rate Processing / Hysteresis** card is removed from the
user-facing UI. `config.hysteresis` is still a config field: it is exported and
imported by the backup flow, validated, and still read by the firmware
(`hys = float(cfg.hysteresis)` feeding `zoneIndexG(..., useHysteresis, ...)`).
The UI no longer reads it and no longer sends it, so the stored value is left
exactly as the Hub has it. Two assertions in `mobile/tests/test-lighting-logic.cjs`
that asserted the old label were rewritten to assert its absence.

## 7. Contrast verification (measured, sRGB relative luminance)

| Pair | Light | Dark |
|---|---|---|
| primary content on lime fill | 4.74 | 11.72 |
| primary content on lime hover | 6.32 | 9.83 |
| secondary lime text on card | 5.50 | 9.77 |
| secondary lime text on elevated | 5.22 | 8.64 |
| lime outline on card | 4.74 | 9.77 |
| ON track vs card | 4.74 | 9.77 |
| knob vs ON track | 4.74 | 11.72 |
| slider thumb vs card | 4.74 | 9.77 |
| unfilled track vs card | 4.27 | 5.03 |
| focus ring vs card | 5.20 | 4.27 |
| error fill vs its content | 5.46 | 5.46 |

All text pairs >= 4.5:1; all control boundaries >= 3:1. The only sub-3:1
values are the decorative active-card border and the focus ring measured
against the lime fill it is offset away from (see sections 2 and 4).

## 8. Not done here (deliberate)

- Generated bundles are NOT regenerated (WebContent.h, desktop `generated-web`
  copies, bundled `hub-ui`) - Phase 2.8, and the pre-existing
  "desktop generated-web copies match data/web" failure still reports it.
- `.ob-dot` in the onboarding overlay still uses a lime radial gradient. It is
  the last decorative lime in the sheet; left in place pending a decision, since
  removing it changes the first-run screen's brand presence.
- Light theme is retained in full, as instructed.
