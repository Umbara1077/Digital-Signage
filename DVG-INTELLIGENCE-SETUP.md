# DVG Intelligence — setup

Nothing here is deployed yet. This is the checklist to switch it on.

## What is already true

The panel has been quietly collecting since June. As of 2026-09-17:

| | |
|---|---|
| Structured events | 3,568 |
| Daily rollups (with weather) | 51 |
| Days with per-flavor movement | 37 |
| Distinct flavors seen | 48 |
| Movement events parsed | 3,462 of 3,568 (97%) |
| Move-log entries | 8,468 |

The only reason the panel says "still gathering information" is that
`gelatoSettings/intelligence.geminiReady` is `false` and `geminiEndpoint` is
empty. The data was never the problem.

## What you need to turn on

1. **Blaze plan** on the `dolcevitasinage` project.
   Cloud Functions require it. At this volume expect well under a dollar a
   month — the free tier covers most of it. Console → ⚙ → Usage and billing →
   Modify plan.

2. **A Gemini API key** from Google AI Studio (aistudio.google.com → Get API
   key). Then, from the repo root:

   ```
   firebase functions:secrets:set GEMINI_API_KEY
   ```

   Paste the key when prompted. It is stored in Secret Manager and never
   touches the repo or the browser.

3. **Enable two APIs** in the Google Cloud console for this project (Firebase
   usually does this for you on first deploy, listed here in case it does not):
   Cloud Functions, Cloud Scheduler, Secret Manager, Generative Language API.

## Deploying, when you are ready

```
cd Digital-Signage
cd functions && npm install && cd ..
firebase deploy --only functions
```

Three functions land in `us-east4`:

| Function | Type | Does |
|---|---|---|
| `dvgChat` | HTTPS | Answers chat questions. Verifies the caller's Firebase ID token against the same allowlist as the admin pages. |
| `dvgNightly` | Cron, 03:20 ET | Backfills real daily weather, rebuilds the stats document. |
| `dvgRebuild` | HTTPS | The same rebuild on demand — run this once after the first deploy. |

## Switching the panel on

After the first deploy, set two fields on `gelatoSettings/intelligence`:

```
geminiReady:    true
geminiEndpoint: https://us-east4-dolcevitasinage.cloudfunctions.net/dvgChat
geminiModel:    gemini-2.5-flash      (optional — change the model without redeploying)
```

Then call `dvgRebuild` once so `gelatoIntelligenceStats/current` exists.

## What it writes

Two collections of its own. It never touches inventory, menu or settings data.

- `gelatoIntelligenceStats/current` — leaderboards, day-of-week averages,
  weather correlation, 7-day forecast. Rebuilt nightly.
- `gelatoIntelligenceWeather/<date>` — cached real daily highs.

## A note on honesty

`stats.weather.reliable` is a flag the analytics engine sets itself, and the
model is instructed never to claim a weather effect while it is `false`.

Right now it is **false**, and correctly so. With the point-in-time weather the
panel had been storing, temperature-to-demand correlation was **0.06** — noise.
Using real daily highs from Open-Meteo's archive instead lifts it to **0.23**,
and the bands finally order the way you would expect (90°F+: 5.8 pans/day,
80s: 4.82, 70s: 4.49). Wet days run 3.86 pans against 5.07 on dry days.

That is a real signal but a thin one — 35 matched days, all from one late-summer
stretch with only a 16°F spread in the days that have movement data. The gate
opens at 45 days and a 25°F spread. Give it through autumn and it should clear.

Day-of-week, by contrast, is already strong and used with confidence:
Saturday 7.8 pans against Tuesday 2.14.

## Correction applied 2026-09-17

The first version of `analytics.js` decided whether gelato was served or binned
from the event's `type`. That was wrong. `"Used the rest of Pan 4 (Nocciola,
0.3)"` is filed under type `empty` but is gelato SERVED, and the engine was
dropping every one of them — **38.5 pans, 19% of all consumption, invisible**.
Kind is now read from the sentence, never the type, and the leaderboard moved
as a result (Vaniglia rose above Menta).

Corrected totals: 206.4 pans served, not 167.9. Dead stock is 11 flavors, not
6 — Cappuccino, Cassata, BubbleGum, Blue Sky Vaniglia, Banana, Millefoglie,
Sbagliato, Peach, Banana Nut, Amarena Amore Mio and Alfajores all went into the
case, moved nothing, and were thrown out. Worst waste rate is Sicilian Cannoli
at 50% — 2.2 pans served, 2.2 binned.

## What every event now stores

Each event was already carrying the full case, totals, pricing and weather.
It now also carries:

- **Time** — hour, minute, local time, minutes into day, weekday, weekend flag,
  part of day, month, year. Flat fields, so "what hour do we move most" is a
  query rather than a full scan.
- **Who** — the signed-in account, plus a per-page-load session id so one
  person's shift can be followed end to end.
- **What moved** — `movement` {kind, flavor, amount, pan, from, to, remaining},
  derived at write time so nothing downstream has to read prose. Fifteen
  patterns cover 100% of every event type that names a flavor.
- **Where from** — page, view mode, screen size.
- **Fuller weather** — feels-like, precipitation, chance of rain, wet and
  snowy flags alongside the temperature.

And `gelatoIntelligenceDaily/<date>` now keeps running, atomically-incremented
tallies: events by type, by hour and by staff member; pans used, wasted and
made; and per-flavor usage — so a day can be read without touching the event
log.
