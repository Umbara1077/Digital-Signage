/* ===========================================================================
 * DVG Intelligence — analytics engine
 * ---------------------------------------------------------------------------
 * Turns the raw `gelatoIntelligenceEvents` log into the numbers the panel and
 * Gemini actually reason over. Pure functions with no Firestore or network in
 * them, so they can be unit-tested against fixtures.
 *
 * WHY TEXT PARSING: the move log records a flavor's identity only inside its
 * human-readable `text` ("Used 0.1 Menta (Pan 9) — 0.7 left"); `meta` is null
 * on every historical event. The format has been stable for the whole history
 * (1,679 use events parsed with zero failures as of 2026-09-17), so parsing it
 * recovers per-flavor demand for data already on disk. New events also carry
 * structured `meta.flavorName` / `meta.amount`, and readers below prefer that
 * whenever it is present — text parsing is the fallback for old rows.
 * ========================================================================= */
'use strict';

/* The full movement vocabulary of the move log, verified against all 3,568
 * historical events: 100% of every event type that names a flavor (use,
 * empty, assign, transfer, intake, adjust, auto-stage) is matched by one of
 * these. The unmatched 3% are menu-sync / reset / chat / close, none of which
 * involve gelato moving.
 *
 * Mirrored in public/gelato-intelligence.js, which now writes the parsed
 * result onto each new event as `movement` — so this table is mainly here to
 * read the history written before that change.
 *
 * CLASSIFICATION MATTERS: "Used the rest of Pan 4 (Nocciola, 0.3)" is logged
 * under type `empty` but is gelato SERVED, not binned. An earlier version of
 * this file keyed on the event type and silently dropped ~120 real
 * consumption events. Kind comes from the sentence, never from the type. */
const MOVE_PATTERNS = [
    { kind: 'used', re: /^Used\s+([\d.]+)\s+(.+?)\s+\(Pan\s+(\d+)\)\s*—\s*([\d.]+)\s+left/,
      map: m => ({ amount: +m[1], flavor: m[2], pan: +m[3], remaining: +m[4], from: 'Case' }) },
    { kind: 'used', re: /^Used a\s+([\d.]+)\s+pan of\s+(.+?)\s+directly from\s+(.+)$/,
      map: m => ({ amount: +m[1], flavor: m[2], from: m[3] }) },
    { kind: 'used', re: /^Used the rest of Pan\s+(\d+)\s+\((.+?),\s*([\d.]+)\)/,
      map: m => ({ pan: +m[1], flavor: m[2], amount: +m[3], from: 'Case' }) },
    { kind: 'wasted', re: /^Emptied a\s+([\d.]+)\s+pan of\s+(.+?)\s+from\s+(.+)$/,
      map: m => ({ amount: +m[1], flavor: m[2], from: m[3] }) },
    { kind: 'wasted', re: /^Discarded Pan\s+(\d+)\s+\((.+?),\s*([\d.]+)\s+trashed/,
      map: m => ({ pan: +m[1], flavor: m[2], amount: +m[3], from: 'Case' }) },
    { kind: 'transfer', re: /^([\d.]+)\s+(.+?):\s+(.+?)\s+→\s+(.+?)\s+\(Pan\s+(\d+)\)/,
      map: m => ({ amount: +m[1], flavor: m[2], from: m[3], to: m[4], pan: +m[5] }) },
    { kind: 'transfer', re: /^([\d.]+)\s+(.+?):\s+(.+?)\s+→\s+(.+)$/,
      map: m => ({ amount: +m[1], flavor: m[2], from: m[3], to: m[4] }) },
    { kind: 'transfer', re: /^Added\s+([\d.]+)\s+to Pan\s+(\d+)\s+\((.+?)\)/,
      map: m => ({ amount: +m[1], pan: +m[2], flavor: m[3], to: 'Case' }) },
    { kind: 'in', re: /^Added\s+(.+?)\s+to Pan\s+(\d+)\s+at\s+([\d.]+)/,
      map: m => ({ flavor: m[1], pan: +m[2], amount: +m[3], to: 'Case' }) },
    { kind: 'in', re: /^(?:Added|Assigned)\s+([\d.]+)\s+(.+?)(?:\s+\(pending\))?\s+→\s+(.+)$/,
      map: m => ({ amount: +m[1], flavor: m[2], to: m[3] }) },
    { kind: 'in', re: /^Made\s+(.+?)\s+—\s+([\d.]+)\s+pan\s+→\s+(.+?)(?:\s+\(|$)/,
      map: m => ({ flavor: m[1], amount: +m[2], to: m[3] }) },
    { kind: 'transfer', re: /^(?:Swapped|Refilled)\s+(.+?)\s+(?:into|in)\s+Pan\s+(\d+)\s+\(\+?([\d.]+)/,
      map: m => ({ flavor: m[1], pan: +m[2], amount: +m[3], to: 'Case' }) },
    { kind: 'stage', re: /^Auto-staged\s+(.+?)\s+refill\s+→\s+Pan\s+(\d+)/,
      map: m => ({ flavor: m[1], pan: +m[2] }) },
    { kind: 'unstage', re: /^Removed stale swap\s+\((.+?)\s+→\s+Pan\s+(\d+)\)/,
      map: m => ({ flavor: m[1], pan: +m[2] }) },
    { kind: 'adjust', re: /^Adjusted pan of\s+(.+?)\s+in\s+(.+?)\s+from\s+([\d.]+)\s+to\s+([\d.]+)/,
      map: m => ({ flavor: m[1], from: m[2], amount: +m[4] - +m[3], remaining: +m[4] }) }
];

/* Kinds that represent gelato actually leaving the shop. `transfer`, `stage`,
 * `unstage` and `adjust` move or re-label stock without consuming it, so they
 * must never be added to demand. */
const CONSUMING = { used: 'used', wasted: 'wasted' };

/* Flavor names that are test rows or known typos, folded or dropped so they
 * don't appear as their own product in the leaderboard. */
const NAME_FIXES = { 'alfjores': 'Alfajores', 'cappucinno': 'Cappuccino' };
const IGNORE_NAMES = new Set(['test', 'new item', 'dummy', 'mystery flavor']);

const r2 = n => Math.round((Number(n) || 0) * 100) / 100;

function canonicalFlavor(raw) {
    const name = String(raw == null ? '' : raw).trim();
    if (!name) return null;
    const key = name.toLowerCase();
    if (IGNORE_NAMES.has(key)) return null;
    return NAME_FIXES[key] || name;
}

function parseText(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    for (const p of MOVE_PATTERNS) {
        const m = s.match(p.re);
        if (!m) continue;
        return Object.assign({ kind: p.kind }, p.map(m));
    }
    return null;
}

/* Prefers the structured `movement` the panel now writes, then explicit meta,
 * then the sentence. Returns null for anything that is not consumption. */
function readMovement(ev) {
    if (!ev) return null;
    const src = ev.movement
        || (ev.meta && ev.meta.flavorName
            ? { kind: ev.meta.kind, flavor: ev.meta.flavorName, amount: ev.meta.amount }
            : null)
        || parseText(ev.text);
    if (!src || !src.flavor) return null;

    const bucket = CONSUMING[src.kind];
    if (!bucket) return null;                       // moved, not consumed
    const flavor = canonicalFlavor(src.flavor);
    if (!flavor) return null;
    const amount = Number(src.amount);
    if (!isFinite(amount) || amount <= 0) return null;
    return { kind: bucket, flavor, amount };
}

/* events -> { '2026-09-17': { used, wasted, flavors: { Menta: {used,wasted} } } } */
function buildDailyConsumption(events) {
    const days = {};
    let parsed = 0, skipped = 0;
    for (const ev of events || []) {
        const date = ev && ev.date;
        if (!date) { skipped++; continue; }
        const mv = readMovement(ev);
        if (!mv) { if (ev.type === 'use' || ev.type === 'empty') skipped++; continue; }
        const d = days[date] || (days[date] = { used: 0, wasted: 0, flavors: {} });
        const f = d.flavors[mv.flavor] || (d.flavors[mv.flavor] = { used: 0, wasted: 0 });
        d[mv.kind] = r2(d[mv.kind] + mv.amount);
        f[mv.kind] = r2(f[mv.kind] + mv.amount);
        parsed++;
    }
    return { days, parsed, skipped };
}

/* Per-flavor totals across the whole window. `daysInCase` counts days the
 * flavor actually moved, which is what perDay is divided by — a flavor that
 * sold well on the three days it was out shouldn't look weak next to one
 * that was out all month. */
function flavorLeaderboard(days) {
    const acc = {};
    for (const [date, d] of Object.entries(days)) {
        for (const [name, f] of Object.entries(d.flavors)) {
            const a = acc[name] || (acc[name] = { used: 0, wasted: 0, activeDays: new Set(), lastSeen: null });
            a.used = r2(a.used + f.used);
            a.wasted = r2(a.wasted + f.wasted);
            if (f.used > 0) a.activeDays.add(date);
            if (!a.lastSeen || date > a.lastSeen) a.lastSeen = date;
        }
    }
    return Object.entries(acc).map(([name, a]) => {
        const activeDays = a.activeDays.size;
        const total = a.used + a.wasted;
        return {
            name,
            usedPans: r2(a.used),
            wastedPans: r2(a.wasted),
            activeDays,
            pansPerActiveDay: activeDays ? r2(a.used / activeDays) : 0,
            /* share of this flavor's pans that were binned rather than served */
            wasteRate: total > 0 ? r2(a.wasted / total) : 0,
            lastSeen: a.lastSeen
        };
    }).sort((x, y) => y.usedPans - x.usedPans);
}

/* Flavors that took up a slot and returned nothing. */
function deadStock(leaderboard, minWasted = 0.5) {
    return leaderboard
        .filter(f => f.usedPans === 0 && f.wastedPans >= minWasted)
        .sort((a, b) => b.wastedPans - a.wastedPans);
}

function dayOfWeekAverages(days) {
    const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const acc = {};
    for (const [date, d] of Object.entries(days)) {
        const idx = new Date(date + 'T12:00:00Z').getUTCDay();
        const key = NAMES[idx];
        const a = acc[key] || (acc[key] = { days: 0, used: 0, wasted: 0 });
        a.days++; a.used += d.used; a.wasted += d.wasted;
    }
    return NAMES.filter(n => acc[n]).map(n => ({
        day: n,
        daysObserved: acc[n].days,
        avgPansUsed: r2(acc[n].used / acc[n].days),
        avgPansWasted: r2(acc[n].wasted / acc[n].days)
    })).sort((a, b) => b.avgPansUsed - a.avgPansUsed);
}

function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((s, v) => s + v, 0) / n;
    const my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
        const a = xs[i] - mx, b = ys[i] - my;
        num += a * b; dx += a * a; dy += b * b;
    }
    if (dx === 0 || dy === 0) return null;
    return r2(num / Math.sqrt(dx * dy));
}

/* Joins daily consumption to real daily weather (highs, not point readings).
 * Returns the correlation AND an explicit confidence flag — the panel and the
 * model must not present a weak signal as a finding. */
function weatherCorrelation(days, weatherByDate, minDays = 45) {
    const rows = [];
    for (const [date, d] of Object.entries(days)) {
        const w = weatherByDate && weatherByDate[date];
        if (!w || w.tempMaxF == null) continue;
        rows.push({ date, used: d.used, tempMaxF: w.tempMaxF, precipIn: w.precipIn || 0, label: w.label });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));

    const bandOf = t => t >= 90 ? '90+' : t >= 80 ? '80-89' : t >= 70 ? '70-79' : t >= 60 ? '60-69' : '<60';
    const bands = {};
    for (const r of rows) {
        const b = bandOf(r.tempMaxF);
        const a = bands[b] || (bands[b] = { days: 0, used: 0 });
        a.days++; a.used += r.used;
    }
    const wet = { wet: { days: 0, used: 0 }, dry: { days: 0, used: 0 } };
    for (const r of rows) {
        const k = r.precipIn > 0.05 ? 'wet' : 'dry';
        wet[k].days++; wet[k].used += r.used;
    }
    const corr = pearson(rows.map(r => r.tempMaxF), rows.map(r => r.used));
    const temps = rows.map(r => r.tempMaxF);
    const spread = temps.length ? Math.max(...temps) - Math.min(...temps) : 0;

    return {
        daysMatched: rows.length,
        tempSpreadF: spread,
        tempVsPans: corr,
        byTempBand: Object.entries(bands)
            .map(([band, v]) => ({ band, days: v.days, avgPansUsed: r2(v.used / v.days) }))
            .sort((a, b) => b.avgPansUsed - a.avgPansUsed),
        wetVsDry: Object.entries(wet).filter(([, v]) => v.days)
            .map(([cond, v]) => ({ cond, days: v.days, avgPansUsed: r2(v.used / v.days) })),
        /* Honest gate. Below this the panel says "still learning" instead of
         * quoting a number, and the model is told not to claim a weather effect. */
        reliable: rows.length >= minDays && spread >= 25 && corr != null && Math.abs(corr) >= 0.3,
        whyNotReliable: rows.length < minDays ? 'not enough days'
            : spread < 25 ? 'temperature range too narrow to separate hot from cold'
            : (corr == null || Math.abs(corr) < 0.3) ? 'no meaningful relationship in the data so far'
            : null
    };
}

/* One object holding everything the panel renders and the model reasons over. */
function buildStats(events, weatherByDate, opts) {
    const o = opts || {};
    const { days, parsed, skipped } = buildDailyConsumption(events);
    const dates = Object.keys(days).sort();
    const board = flavorLeaderboard(days);
    const totalUsed = dates.reduce((s, d) => s + days[d].used, 0);
    const totalWasted = dates.reduce((s, d) => s + days[d].wasted, 0);

    return {
        coverage: {
            daysWithData: dates.length,
            firstDate: dates[0] || null,
            lastDate: dates[dates.length - 1] || null,
            movementsParsed: parsed,
            movementsSkipped: skipped,
            flavorsSeen: board.length
        },
        totals: {
            pansUsed: r2(totalUsed),
            pansWasted: r2(totalWasted),
            wasteRate: (totalUsed + totalWasted) > 0 ? r2(totalWasted / (totalUsed + totalWasted)) : 0,
            avgPansPerOpenDay: dates.length ? r2(totalUsed / dates.length) : 0
        },
        topMovers: board.slice(0, 12),
        slowMovers: board.filter(f => f.usedPans > 0).slice(-10).reverse(),
        deadStock: deadStock(board),
        worstWaste: board.filter(f => f.wastedPans > 0)
            .sort((a, b) => b.wastedPans - a.wastedPans).slice(0, 10),
        byDayOfWeek: dayOfWeekAverages(days),
        weather: weatherCorrelation(days, weatherByDate, o.minWeatherDays),
        dailySeries: dates.map(d => ({
            date: d, used: r2(days[d].used), wasted: r2(days[d].wasted),
            tempMaxF: (weatherByDate && weatherByDate[d] && weatherByDate[d].tempMaxF) || null
        }))
    };
}

module.exports = {
    MOVE_PATTERNS, parseText, canonicalFlavor, readMovement,
    buildDailyConsumption, flavorLeaderboard, deadStock,
    dayOfWeekAverages, pearson, weatherCorrelation, buildStats
};
