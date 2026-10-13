/* ===========================================================================
 * DVG Intelligence — Cloud Functions
 * ---------------------------------------------------------------------------
 *   dvgChat     HTTPS  — the endpoint gelato-intelligence.js already calls.
 *                        Verifies the caller's Firebase ID token against the
 *                        same allowlist as the admin pages, then answers from
 *                        pre-computed stats via Gemini.
 *   dvgNightly  CRON   — 03:20 America/New_York. Backfills real daily weather
 *                        and rebuilds gelatoIntelligenceStats/current.
 *   dvgRebuild  HTTPS  — the same rebuild on demand, for the first run and
 *                        after changing the analytics.
 *
 * Nothing here writes to gelatoInventory, menuItems or any collection the
 * shop runs on. It reads the event log and writes two documents of its own.
 * ========================================================================= */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const analytics = require('./analytics');
const weather = require('./weather');
const gemini = require('./gemini');
const { isAllowed } = require('./allowlist');

admin.initializeApp();
const db = admin.firestore();

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const REGION = 'us-east4';                 // closest region to Sewell, NJ

const SETTINGS = () => db.collection('gelatoSettings').doc('intelligence');
const STATS = () => db.collection('gelatoIntelligenceStats').doc('current');
const EVENTS = () => db.collection('gelatoIntelligenceEvents');
const WEATHER = () => db.collection('gelatoIntelligenceWeather');

const SHOP_FALLBACK = {
    id: 'sewell-nj', name: 'Dolce Vita Gelateria', city: 'Sewell, NJ',
    lat: 39.7665, lon: -75.1443, timezone: 'America/New_York'
};

async function shopConfig() {
    const s = await SETTINGS().get();
    return Object.assign({}, SHOP_FALLBACK, (s.exists && s.data().shop) || {});
}

/* ---- CORS ------------------------------------------------------------- */
/* The panel is served from Firebase Hosting on these origins only. */
const ALLOWED_ORIGINS = [
    'https://dolcevitasinage.web.app',
    'https://dolcevitasinage.firebaseapp.com'
];
function applyCors(req, res) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
    }
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '3600');
}

/* Returns the decoded token, or null after having already answered. */
async function requireAllowedCaller(req, res) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) { res.status(401).json({ error: 'Sign in required.' }); return null; }
    let decoded;
    try {
        decoded = await admin.auth().verifyIdToken(token);
    } catch (e) {
        logger.warn('bad id token', e.message);
        res.status(401).json({ error: 'Sign in required.' });
        return null;
    }
    if (!isAllowed(decoded.email)) {
        logger.warn('blocked caller', decoded.email);
        res.status(403).json({ error: 'This account is not approved for DVG Intelligence.' });
        return null;
    }
    return decoded;
}

/* ---- Rebuild ----------------------------------------------------------- */
/* Reads the whole event log. At ~3,600 documents that is a few hundred
 * kilobytes and well inside a function's memory; if it ever grows past ~50k
 * events this should switch to reading only since the last rebuild. */
async function rebuildStats() {
    const shop = await shopConfig();

    const snap = await EVENTS().get();
    const events = snap.docs.map(d => d.data());
    const { days } = analytics.buildDailyConsumption(events);
    const dates = Object.keys(days).sort();
    if (!dates.length) {
        logger.warn('rebuildStats: no dated movement events found');
        return { written: false, reason: 'no movement events' };
    }

    /* Real daily highs, cached in Firestore so we are not re-fetching the
     * same history every night. */
    const cached = {};
    const cachedSnap = await WEATHER().get();
    cachedSnap.docs.forEach(d => { cached[d.id] = d.data(); });

    const missing = dates.filter(d => !cached[d] || cached[d].tempMaxF == null);
    let fetched = {};
    if (missing.length) {
        fetched = await weather.fetchHistory(shop, dates[0], dates[dates.length - 1])
            .catch(e => { logger.error('weather history failed', e.message); return {}; });

        /* Cache only days that are new or whose high changed, one doc per
         * date, in batches — a full backfill can exceed the 500-write limit. */
        const toWrite = Object.entries(fetched)
            .filter(([date, w]) => !cached[date] || cached[date].tempMaxF !== w.tempMaxF);
        for (let i = 0; i < toWrite.length; i += 400) {
            const batch = db.batch();
            for (const [date, w] of toWrite.slice(i, i + 400)) {
                batch.set(WEATHER().doc(date), w, { merge: true });
            }
            await batch.commit();
        }
        logger.info(`weather: ${missing.length} missing, ${Object.keys(fetched).length} fetched, ${toWrite.length} cached`);
    }

    const weatherByDate = Object.assign({}, cached, fetched);
    const stats = analytics.buildStats(events, weatherByDate);

    const forecast = await weather.fetchForecast(shop, 7)
        .catch(e => { logger.warn('forecast failed', e.message); return {}; });

    await STATS().set({
        ...stats,
        forecast,
        shop,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        generatedAtISO: new Date().toISOString()
    });
    logger.info('stats rebuilt', {
        days: stats.coverage.daysWithData,
        flavors: stats.coverage.flavorsSeen,
        weatherReliable: stats.weather.reliable
    });
    return { written: true, coverage: stats.coverage, weatherReliable: stats.weather.reliable };
}

/* ---- The briefing handed to Gemini ------------------------------------- */
/* Deliberately trimmed: the model gets conclusions, not 3,600 raw events. */
function buildBriefing(stats, liveSnapshot, forecast) {
    return {
        generatedAt: stats.generatedAtISO || null,
        shop: stats.shop || SHOP_FALLBACK,
        dataCoverage: stats.coverage,
        overallTotals: stats.totals,
        topMovers: stats.topMovers,
        slowMovers: stats.slowMovers,
        deadStock: stats.deadStock,
        worstWaste: stats.worstWaste,
        byDayOfWeek: stats.byDayOfWeek,
        weather: stats.weather,
        recentDays: (stats.dailySeries || []).slice(-21),
        upcomingWeather: forecast || stats.forecast || {},
        rightNow: liveSnapshot || null
    };
}

/* ---- dvgChat ----------------------------------------------------------- */
exports.dvgChat = onRequest(
    { region: REGION, secrets: [GEMINI_API_KEY], cors: false, maxInstances: 5 },
    async (req, res) => {
        applyCors(req, res);
        if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
        if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

        const caller = await requireAllowedCaller(req, res);
        if (!caller) return;

        try {
            const body = req.body || {};
            const message = String(body.message || '').slice(0, 2000).trim();
            if (!message) { res.status(400).json({ error: 'Empty message.' }); return; }

            const [statsSnap, settingsSnap] = await Promise.all([STATS().get(), SETTINGS().get()]);
            if (!statsSnap.exists) {
                res.json({ reply: 'I have not built the shop statistics yet — run the rebuild once and I will have history to work from.' });
                return;
            }
            const stats = statsSnap.data();
            const model = (settingsSnap.exists && settingsSnap.data().geminiModel) || gemini.DEFAULT_MODEL;

            /* Last few turns, so follow-up questions make sense. */
            const historySnap = await db.collection('gelatoIntelligenceChat')
                .orderBy('at', 'desc').limit(8).get().catch(() => null);
            const history = historySnap
                ? historySnap.docs.map(d => d.data()).reverse()
                    .map(t => ({ role: t.role, text: t.text }))
                : [];

            const briefing = buildBriefing(stats, body.snapshot, stats.forecast);
            const reply = await gemini.ask(GEMINI_API_KEY.value(), model, briefing, history, message);
            res.json({ reply });
        } catch (e) {
            logger.error('dvgChat failed', e);
            res.status(502).json({ error: 'DVG Intelligence could not answer just now.' });
        }
    }
);

/* ---- dvgNightly -------------------------------------------------------- */
exports.dvgNightly = onSchedule(
    { region: REGION, schedule: '20 3 * * *', timeZone: 'America/New_York', maxInstances: 1 },
    async () => {
        const out = await rebuildStats();
        logger.info('nightly rebuild', out);
    }
);

/* ---- dvgRebuild -------------------------------------------------------- */
exports.dvgRebuild = onRequest(
    { region: REGION, cors: false, maxInstances: 1, timeoutSeconds: 540 },
    async (req, res) => {
        applyCors(req, res);
        if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
        const caller = await requireAllowedCaller(req, res);
        if (!caller) return;
        try {
            const out = await rebuildStats();
            res.json(out);
        } catch (e) {
            logger.error('dvgRebuild failed', e);
            res.status(500).json({ error: String(e.message || e) });
        }
    }
);
