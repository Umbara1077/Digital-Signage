/* ===========================================================================
 * Dolce Vita · DVG Intelligence
 * ---------------------------------------------------------------------------
 * Advanced oversight layer for the gelato management panel. Shown to staff as
 * "DVG Intelligence"; the code, CSS prefix (`gi-`) and Firestore collections
 * keep their original `gelatoIntelligence*` names so stored data stays valid.
 *
 * - Logs structured shop events to Firestore (`gelatoIntelligenceEvents`)
 *   alongside daily rollups (`gelatoIntelligenceDaily`) and chat turns
 *   (`gelatoIntelligenceChat`) so Gemini can learn production patterns,
 *   pricing, and profit once enabled in the Firebase project.
 * - Renders a Gemini/Copilot-style intelligence panel with Sewell, NJ weather,
 *   a live insight deck, and an in-panel chat.
 * - Until Gemini is enabled / enough history exists, the panel stays useful
 *   with live inventory insights and a clear "still gathering information"
 *   state; tiles with no data yet read "Learning".
 *
 * Does not change gelato stock / move logic — it only observes and advises.
 * ========================================================================= */

(function (global) {
    'use strict';

    const SHOP = {
        id: 'sewell-nj',
        name: 'Dolce Vita Gelateria',
        city: 'Sewell, NJ',
        lat: 39.7665,
        lon: -75.1443,
        timezone: 'America/New_York'
    };

    // Enough structured events before we claim "ready for deep insights"
    const MIN_EVENTS_FOR_READY = 40;
    const WEATHER_REFRESH_MS = 20 * 60 * 1000;
    const SNAPSHOT_THROTTLE_MS = 5 * 60 * 1000;

    const WMO = {
        0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
        45: 'Fog', 48: 'Icy fog',
        51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
        61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
        71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
        80: 'Rain showers', 81: 'Showers', 82: 'Heavy showers',
        95: 'Thunderstorm', 96: 'Storm + hail', 99: 'Severe storm'
    };

    let db = null;
    let getSnapshot = () => null;
    let settings = { geminiReady: false, geminiEndpoint: '', collectingSince: null };
    let eventCount = 0;
    let weather = null;
    let lastSnapshotAt = 0;
    let chatBusy = false;
    let started = false;
    /* 'popover' = gelato topbar button (no layout space when closed)
     * 'inline'  = always-visible full banner (admin) */
    let uiMode = 'popover';

    const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: SHOP.timezone });
    const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
    const money = n => '$' + (Math.round((n || 0) * 100) / 100)
        .toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /* One id per page load, so a shift's actions can be grouped together. */
    const SESSION_ID = 'sess_' + Date.now().toString(36) + '_' +
        Math.random().toString(36).slice(2, 8);

    /* ----- Capture helpers ------------------------------------------------
     * Everything below exists so the event log answers questions later that
     * nobody thought to ask today. Storage is the cheap part; a movement that
     * was never recorded is gone for good. */

    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    /* Local (shop-timezone) time parts, stored flat so they can be queried
     * and grouped without pulling every document and re-deriving them. */
    function timeParts() {
        const now = new Date();
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: SHOP.timezone, hour12: false,
            weekday: 'short', hour: '2-digit', minute: '2-digit',
            year: 'numeric', month: '2-digit', day: '2-digit'
        });
        const p = {};
        for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
        let hour = parseInt(p.hour, 10);
        if (hour === 24) hour = 0;               // some ICU builds report 24
        const minute = parseInt(p.minute, 10);
        const weekday = p.weekday;
        return {
            hour,
            minute,
            localTime: String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'),
            minutesIntoDay: hour * 60 + minute,
            weekday,
            weekdayIndex: Math.max(0, WEEKDAYS.indexOf(weekday)),
            isWeekend: weekday === 'Sat' || weekday === 'Sun',
            month: Number(p.month),
            year: Number(p.year),
            partOfDay: hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening',
            tzOffsetMinutes: -now.getTimezoneOffset(),
            clientAt: now.toISOString()
        };
    }

    /* Who is signed in. This is an internal operations log for the shop's own
     * staff — it records the account that performed each action so patterns
     * per person are visible. */
    function actor() {
        try {
            const u = firebase.auth().currentUser;
            if (!u) return null;
            return { uid: u.uid, email: u.email || null, name: u.displayName || null };
        } catch (e) { return null; }
    }

    /* Flavor identity used to live only inside the human-readable text. These
     * patterns lift it back out into structured fields at write time, so
     * nothing downstream has to parse prose. Each returns
     * { kind, flavor, amount, pan, from, to, remaining }. */
    const MOVE_PATTERNS = [
        // Used 0.1 Menta (Pan 9) — 0.7 left
        { kind: 'used', re: /^Used\s+([\d.]+)\s+(.+?)\s+\(Pan\s+(\d+)\)\s*—\s*([\d.]+)\s+left/,
          map: m => ({ amount: +m[1], flavor: m[2], pan: +m[3], remaining: +m[4], from: 'Case' }) },
        // Used a 0.5 pan of X directly from Short-Term
        { kind: 'used', re: /^Used a\s+([\d.]+)\s+pan of\s+(.+?)\s+directly from\s+(.+)$/,
          map: m => ({ amount: +m[1], flavor: m[2], from: m[3] }) },
        // Used the rest of Pan 4 (Nocciola, 0.3)
        { kind: 'used', re: /^Used the rest of Pan\s+(\d+)\s+\((.+?),\s*([\d.]+)\)/,
          map: m => ({ pan: +m[1], flavor: m[2], amount: +m[3], from: 'Case' }) },
        // Emptied a 0.4 pan of Moka from Long-Term
        { kind: 'wasted', re: /^Emptied a\s+([\d.]+)\s+pan of\s+(.+?)\s+from\s+(.+)$/,
          map: m => ({ amount: +m[1], flavor: m[2], from: m[3] }) },
        // Discarded Pan 6 (Limone, 0.4 trashed — not counted)
        { kind: 'wasted', re: /^Discarded Pan\s+(\d+)\s+\((.+?),\s*([\d.]+)\s+trashed/,
          map: m => ({ pan: +m[1], flavor: m[2], amount: +m[3], from: 'Case' }) },
        // 0.5 Menta: Short-Term → Case (Pan 9)
        { kind: 'transfer', re: /^([\d.]+)\s+(.+?):\s+(.+?)\s+→\s+(.+?)\s+\(Pan\s+(\d+)\)/,
          map: m => ({ amount: +m[1], flavor: m[2], from: m[3], to: m[4], pan: +m[5] }) },
        // 0.5 Menta: Case (Pan 9) → Short-Term    /    A → B
        { kind: 'transfer', re: /^([\d.]+)\s+(.+?):\s+(.+?)\s+→\s+(.+)$/,
          map: m => ({ amount: +m[1], flavor: m[2], from: m[3], to: m[4] }) },
        // Added 0.3 to Pan 5 (Pistacchio) — from Short-Term — now 0.9
        { kind: 'transfer', re: /^Added\s+([\d.]+)\s+to Pan\s+(\d+)\s+\((.+?)\)/,
          map: m => ({ amount: +m[1], pan: +m[2], flavor: m[3], to: 'Case' }) },
        // Added Moka to Pan 10 at 1 (from Short-Term)
        { kind: 'in', re: /^Added\s+(.+?)\s+to Pan\s+(\d+)\s+at\s+([\d.]+)/,
          map: m => ({ flavor: m[1], pan: +m[2], amount: +m[3], to: 'Case' }) },
        // Added 1 Moka (pending) → Short-Term   /   Assigned 1 Moka → Short-Term
        { kind: 'in', re: /^(?:Added|Assigned)\s+([\d.]+)\s+(.+?)(?:\s+\(pending\))?\s+→\s+(.+)$/,
          map: m => ({ amount: +m[1], flavor: m[2], to: m[3] }) },
        // Made Moka — 1 pan → Short-Term (from order queue)
        { kind: 'in', re: /^Made\s+(.+?)\s+—\s+([\d.]+)\s+pan\s+→\s+(.+?)(?:\s+\(|$)/,
          map: m => ({ flavor: m[1], amount: +m[2], to: m[3] }) },
        // Swapped/Refilled Moka into Pan 3 (0.5 from Short-Term)
        { kind: 'transfer', re: /^(?:Swapped|Refilled)\s+(.+?)\s+(?:into|in)\s+Pan\s+(\d+)\s+\(\+?([\d.]+)/,
          map: m => ({ flavor: m[1], pan: +m[2], amount: +m[3], to: 'Case' }) },
        // Auto-staged Menta refill → Pan 9   (a recommendation, not a movement,
        // but a useful demand-pressure signal so the flavor is still captured)
        { kind: 'stage', re: /^Auto-staged\s+(.+?)\s+refill\s+→\s+Pan\s+(\d+)/,
          map: m => ({ flavor: m[1], pan: +m[2] }) },
        // Removed stale swap (Extra Noir → Pan 2) — no longer has backup
        { kind: 'unstage', re: /^Removed stale swap\s+\((.+?)\s+→\s+Pan\s+(\d+)\)/,
          map: m => ({ flavor: m[1], pan: +m[2] }) },
        // Adjusted pan of Mango in Short-Term from 0.8 to 0.5  (a correction;
        // amount is the signed delta so shrinkage is visible)
        { kind: 'adjust', re: /^Adjusted pan of\s+(.+?)\s+in\s+(.+?)\s+from\s+([\d.]+)\s+to\s+([\d.]+)/,
          map: m => ({ flavor: m[1], from: m[2], amount: +m[4] - +m[3], remaining: +m[4] }) }
    ];

    function parseMovement(type, text) {
        const s = String(text == null ? '' : text).trim();
        if (!s) return null;
        for (const p of MOVE_PATTERNS) {
            const m = s.match(p.re);
            if (!m) continue;
            const out = Object.assign({ kind: p.kind }, p.map(m));
            if (out.flavor) out.flavor = String(out.flavor).trim();
            if (!isFinite(out.amount)) delete out.amount;
            return out;
        }
        return null;
    }

    /* Firestore map keys, safe for any flavor name. */
    const slug = s => String(s == null ? '' : s).trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';

    const eventsCol = () => db.collection('gelatoIntelligenceEvents');
    const dailyCol = () => db.collection('gelatoIntelligenceDaily');
    const chatCol = () => db.collection('gelatoIntelligenceChat');
    const settingsRef = () => db.collection('gelatoSettings').doc('intelligence');

    function isCollecting() {
        return !settings.geminiReady || eventCount < MIN_EVENTS_FOR_READY;
    }

    function detectMode(opts) {
        if (opts && (opts.mode === 'inline' || opts.mode === 'popover')) return opts.mode;
        const root = document.getElementById('gelato-intelligence');
        const attr = root && root.getAttribute('data-gi-mode');
        if (attr === 'inline' || attr === 'popover') return attr;
        return document.getElementById('gi-open') ? 'popover' : 'inline';
    }

    /* ----- Boot ---------------------------------------------------------- */
    function init(opts) {
        if (started) return;
        db = opts && opts.db;
        getSnapshot = (opts && opts.getSnapshot) || (() => null);
        if (!db || !document.getElementById('gelato-intelligence')) return;
        started = true;
        uiMode = detectMode(opts);
        const root = document.getElementById('gelato-intelligence');
        if (root) root.setAttribute('data-gi-mode', uiMode);

        wireUi();
        ensureSettings();
        listenSettings();
        listenEventCount();
        listenChat();
        refreshWeather();
        setInterval(refreshWeather, WEATHER_REFRESH_MS);
        // first paint + periodic daily rollup (throttled)
        setTimeout(() => { updateBanner(); maybeWriteDailySnapshot('boot'); }, 400);
        setInterval(() => maybeWriteDailySnapshot('heartbeat'), SNAPSHOT_THROTTLE_MS);
    }

    async function ensureSettings() {
        try {
            const snap = await settingsRef().get();
            if (!snap.exists) {
                await settingsRef().set({
                    geminiReady: false,
                    geminiEndpoint: '',
                    shop: SHOP,
                    minEventsForReady: MIN_EVENTS_FOR_READY,
                    collectingSince: stamp(),
                    updatedAt: stamp()
                }, { merge: true });
            } else if (!snap.data().collectingSince) {
                await settingsRef().set({ collectingSince: stamp() }, { merge: true });
            }
        } catch (e) {
            console.error('GelatoIntelligence ensureSettings', e);
        }
    }

    function listenSettings() {
        settingsRef().onSnapshot(d => {
            settings = Object.assign({ geminiReady: false, geminiEndpoint: '' }, d.exists ? d.data() : {});
            updateBanner();
        }, err => console.error('intelligence settings', err));
    }

    function listenEventCount() {
        // lightweight count via recent docs — full count is expensive; we also
        // keep a running counter on the settings doc when we write events
        settingsRef().onSnapshot(d => {
            const n = d.exists ? Number(d.data().eventCount || 0) : 0;
            if (n >= 0) eventCount = n;
            updateBanner();
        });
        eventsCol().orderBy('at', 'desc').limit(1).onSnapshot(() => {
            // nudge UI when new events land even if counter lags
            updateBanner();
        }, () => { /* index may be building — ignore */ });
    }

    /* ----- Structured event logging -------------------------------------- */
    function recordEvent(partial) {
        if (!db || !partial) return;
        const shop = getSnapshot() || {};
        const date = todayStr();
        const tp = timeParts();

        /* Structured movement: explicit meta from the caller wins; otherwise
         * it is lifted out of the text so the fields exist either way. */
        const parsed = parseMovement(partial.type, partial.text);
        const meta = partial.meta || null;
        const movement = (meta && meta.flavorName)
            ? {
                kind: meta.kind || (parsed && parsed.kind) || null,
                flavor: meta.flavorName,
                amount: meta.amount != null ? Number(meta.amount) : (parsed ? parsed.amount : null),
                pan: meta.pan != null ? meta.pan : (parsed ? parsed.pan : null),
                from: meta.from || (parsed ? parsed.from : null) || null,
                to: meta.to || (parsed ? parsed.to : null) || null,
                remaining: meta.remaining != null ? meta.remaining : (parsed ? parsed.remaining : null),
                parsed: false
            }
            : (parsed ? Object.assign({ parsed: true }, parsed, { flavor: parsed.flavor || null }) : null);

        const caseArr = Array.isArray(shop.case) ? shop.case : null;

        const payload = {
            type: partial.type || 'note',
            text: partial.text || '',
            source: 'gelato-panel',
            shopId: SHOP.id,
            shopName: SHOP.name,
            city: SHOP.city,
            date: date,
            at: stamp(),

            /* time, flattened for grouping without re-deriving from `at` */
            hour: tp.hour,
            minute: tp.minute,
            localTime: tp.localTime,
            minutesIntoDay: tp.minutesIntoDay,
            weekday: tp.weekday,
            weekdayIndex: tp.weekdayIndex,
            isWeekend: tp.isWeekend,
            partOfDay: tp.partOfDay,
            month: tp.month,
            year: tp.year,
            clientAt: tp.clientAt,

            /* who and where from */
            actor: actor(),
            sessionId: SESSION_ID,
            page: (location.pathname.split('/').pop() || 'index.html'),
            viewMode: (shop && shop.viewMode) || null,
            screen: (typeof window !== 'undefined' && window.innerWidth)
                ? window.innerWidth + 'x' + window.innerHeight : null,

            /* what moved */
            movement: movement,
            flavor: movement ? movement.flavor : null,
            flavorSlug: movement && movement.flavor ? slug(movement.flavor) : null,
            amount: movement && movement.amount != null ? movement.amount : null,

            /* shop state at the moment it happened */
            pricing: shop.pricing || null,
            totals: shop.totals || null,
            case: caseArr,
            caseFlavors: caseArr ? caseArr.map(c => c.name).filter(Boolean) : null,
            caseCount: caseArr ? caseArr.length : null,
            lowPans: shop.lowPans || null,
            usage: shop.usage || null,
            queueLength: shop.queueLength != null ? shop.queueLength : null,

            weather: weather ? {
                tempF: weather.tempF,
                feelsF: weather.feelsF != null ? weather.feelsF : null,
                code: weather.code,
                label: weather.label,
                dayCode: weather.dayCode != null ? weather.dayCode : null,
                dayLabel: weather.dayLabel || null,
                humidity: weather.humidity,
                windMph: weather.windMph,
                precipIn: weather.precipIn != null ? weather.precipIn : null,
                precipChance: weather.precipChance != null ? weather.precipChance : null,
                wet: !!weather.wet,
                snowy: !!weather.snowy
            } : null,

            meta: meta
        };

        eventsCol().add(payload)
            .then(() => settingsRef().set({
                eventCount: firebase.firestore.FieldValue.increment(1),
                lastEventAt: stamp(),
                updatedAt: stamp()
            }, { merge: true }))
            .catch(err => console.error('GelatoIntelligence recordEvent', err));

        rollUpDaily(date, payload);
        maybeWriteDailySnapshot('event');
    }

    /* Running per-day tallies, incremented as things happen so the day's
     * picture is readable without scanning the event log. Firestore's atomic
     * increment means several tills/tablets can write at once safely. */
    function rollUpDaily(date, ev) {
        if (!db) return;
        const inc = n => firebase.firestore.FieldValue.increment(n);
        const update = {
            date: date,
            shopId: SHOP.id,
            updatedAt: stamp(),
            eventTotal: inc(1),
            eventsByType: { [slug(ev.type)]: inc(1) },
            eventsByHour: { ['h' + String(ev.hour).padStart(2, '0')]: inc(1) },
            weekday: ev.weekday,
            lastEventLocalTime: ev.localTime
        };
        if (ev.actor && ev.actor.email) {
            update.eventsByActor = { [slug(ev.actor.email)]: inc(1) };
        }
        const mv = ev.movement;
        if (mv && mv.flavor && isFinite(mv.amount) && mv.amount > 0) {
            const key = slug(mv.flavor);
            const bucket = mv.kind === 'used' ? 'used'
                : mv.kind === 'wasted' ? 'wasted'
                : mv.kind === 'in' ? 'madeIn' : 'moved';
            update.flavorUsage = { [key]: { name: mv.flavor, [bucket]: inc(mv.amount) } };
            if (bucket === 'used') update.pansUsed = inc(mv.amount);
            if (bucket === 'wasted') update.pansWasted = inc(mv.amount);
            if (bucket === 'madeIn') update.pansMade = inc(mv.amount);
            update.usageByHour = { ['h' + String(ev.hour).padStart(2, '0')]: inc(bucket === 'used' ? mv.amount : 0) };
        }
        dailyCol().doc(date).set(update, { merge: true })
            .catch(err => console.error('GelatoIntelligence rollUpDaily', err));
    }

    async function maybeWriteDailySnapshot(reason) {
        if (!db) return;
        const now = Date.now();
        if (reason !== 'boot' && now - lastSnapshotAt < SNAPSHOT_THROTTLE_MS) return;
        lastSnapshotAt = now;
        const shop = getSnapshot() || {};
        const id = todayStr();
        try {
            await dailyCol().doc(id).set({
                date: id,
                shopId: SHOP.id,
                city: SHOP.city,
                reason: reason || 'heartbeat',
                updatedAt: stamp(),
                pricing: shop.pricing || null,
                totals: shop.totals || null,
                case: Array.isArray(shop.case) ? shop.case : [],
                usage: shop.usage || null,
                queueLength: shop.queueLength != null ? shop.queueLength : 0,
                lowPans: shop.lowPans || [],
                weather: weather || null,
                estimatedCaseValue: shop.totals ? shop.totals.caseValue : null,
                estimatedTotalValue: shop.totals ? shop.totals.totalValue : null
            }, { merge: true });
        } catch (e) {
            console.error('GelatoIntelligence daily snapshot', e);
        }
    }

    function isWetCode(code) {
        const c = Number(code);
        // WMO: drizzle, rain, freezing rain, showers, thunderstorm
        return (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || (c >= 95 && c <= 99);
    }

    function isSnowCode(code) {
        const c = Number(code);
        return (c >= 71 && c <= 77) || c === 85 || c === 86;
    }

    /* ----- Weather (Sewell, NJ via Open-Meteo — no API key) -------------- */
    async function refreshWeather() {
        const url = 'https://api.open-meteo.com/v1/forecast'
            + `?latitude=${SHOP.lat}&longitude=${SHOP.lon}`
            + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature,precipitation'
            + '&daily=weather_code,precipitation_sum,precipitation_probability_max'
            + '&forecast_days=1'
            + '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch'
            + `&timezone=${encodeURIComponent(SHOP.timezone)}`;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('weather http ' + res.status);
            const data = await res.json();
            const c = data.current || {};
            const d = data.daily || {};
            const dayCode = Array.isArray(d.weather_code) ? d.weather_code[0] : c.weather_code;
            const precipIn = Number(c.precipitation || 0);
            const dayPrecipIn = Array.isArray(d.precipitation_sum) ? Number(d.precipitation_sum[0] || 0) : 0;
            const precipChance = Array.isArray(d.precipitation_probability_max)
                ? Number(d.precipitation_probability_max[0] || 0) : 0;
            const wet = isWetCode(c.weather_code) || isWetCode(dayCode) || precipIn > 0.01 || dayPrecipIn > 0.05 || precipChance >= 60;
            const snowy = isSnowCode(c.weather_code) || isSnowCode(dayCode);
            weather = {
                tempF: Math.round(c.temperature_2m),
                feelsF: Math.round(c.apparent_temperature),
                humidity: Math.round(c.relative_humidity_2m),
                windMph: Math.round(c.wind_speed_10m),
                code: c.weather_code,
                dayCode,
                label: WMO[c.weather_code] || 'Local weather',
                dayLabel: WMO[dayCode] || WMO[c.weather_code] || 'Local weather',
                precipIn: Math.round(precipIn * 100) / 100,
                dayPrecipIn: Math.round(dayPrecipIn * 100) / 100,
                precipChance,
                wet,
                snowy,
                fetchedAt: Date.now()
            };
            updateBanner();
        } catch (e) {
            console.warn('GelatoIntelligence weather', e);
            weather = null;
            updateBanner();
        }
    }

    function weatherDemandNote() {
        if (!weather) return '';
        if (weather.snowy) return 'Snowy — expect slower walk-up traffic';
        if (weather.wet) return 'Rainy — scoop demand usually soft';
        if (weather.tempF >= 80) return 'Warm & dry — scoops often pick up';
        if (weather.tempF <= 40) return 'Cold — quieter walk-ups likely';
        return 'Mild & dry';
    }

    function heroMessage(shop) {
        if (isCollecting()) {
            return {
                text: 'Still gathering information',
                sub: 'Soon it will read every pan, price, and Sewell forecast to tell you exactly what to make '
                    + 'and what it earns you.'
            };
        }
        const t = (shop && shop.totals) || {};
        const low = (shop && shop.lowPans) || [];
        const used = (shop && shop.usage && shop.usage.usedPans) || 0;
        if (weather && weather.wet && low.length) {
            return {
                text: `Rainy day · ${low.length} pan${low.length === 1 ? '' : 's'} low`,
                sub: 'Sewell is wet — softer walk-up traffic. Refill red pans from short-term when you can.'
            };
        }
        if (weather && weather.wet) {
            return {
                text: 'Rainy in Sewell — quieter scoop day',
                sub: 'Profit and stock are live below. Chat for a production read anytime.'
            };
        }
        if (low.length) {
            return {
                text: `${low.length} case pan${low.length === 1 ? '' : 's'} need attention`,
                sub: `Low now: ${low.slice(0, 4).map(p => p.name).join(', ')}.`
            };
        }
        if (used > 0) {
            return {
                text: `Served ${used} pans so far today`,
                sub: `On-hand about ${money(t.totalValue || 0)}.`
            };
        }
        return {
            text: 'Shop pulse looks healthy',
            sub: `On-hand about ${money(t.totalValue || 0)}. Chat for production or profit details.`
        };
    }

    function setPanelOpen(open) {
        const root = document.getElementById('gelato-intelligence');
        const wrap = document.getElementById('gi-popover-root');
        const openBtn = document.getElementById('gi-open');
        const body = document.getElementById('gi-body');
        const strip = document.getElementById('gi-expand');
        if (!root) return;

        if (uiMode === 'inline') {
            // Admin: minimized strip in flow; Open expands the same pink banner
            root.classList.toggle('is-collapsed', !open);
            if (body) {
                if (open) body.removeAttribute('hidden');
                else body.setAttribute('hidden', '');
            }
            if (strip) {
                if (open) strip.setAttribute('hidden', '');
                else strip.removeAttribute('hidden');
            }
            try { localStorage.setItem('giAdminCollapsed', open ? '0' : '1'); } catch (_) { /* ignore */ }
            if (!open) setChatOpen(false);
            return;
        }

        // Popover (gelato): closed = zero layout space; open = overlay with same banner
        if (wrap) {
            if (open) wrap.removeAttribute('hidden');
            else wrap.setAttribute('hidden', '');
        } else {
            root.classList.toggle('is-collapsed', !open);
        }
        if (openBtn) {
            openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            openBtn.classList.toggle('is-open', !!open);
        }
        try { localStorage.setItem('giOpen', open ? '1' : '0'); } catch (_) { /* ignore */ }
        if (!open) setChatOpen(false);
    }

    /* Back-compat alias used by older call sites */
    function setCollapsed(collapsed) {
        setPanelOpen(!collapsed);
    }

    function setChatOpen(open) {
        const panel = document.getElementById('gi-chat');
        const toggle = document.getElementById('gi-chat-toggle');
        const label = document.getElementById('gi-chat-toggle-label');
        const input = document.getElementById('gi-chat-input');
        if (!panel) return;
        if (open) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (label) label.textContent = open ? 'Close chat' : 'Chat with DVG Intelligence';
        if (open && input) input.focus();
    }

    function updateBanner() {
        const root = document.getElementById('gelato-intelligence');
        if (!root) return;
        const shop = getSnapshot() || {};
        const collecting = isCollecting();
        root.classList.toggle('gi-collecting', collecting);
        root.classList.toggle('gi-ready', !collecting);

        const hero = heroMessage(shop);
        const lead = document.getElementById('gi-lead');
        const sub = document.getElementById('gi-sub');
        const collapsedMsg = document.getElementById('gi-collapsed-msg');
        if (lead) lead.textContent = hero.text;
        if (sub) sub.textContent = hero.sub;
        if (collapsedMsg) collapsedMsg.textContent = hero.text;

        const label = document.getElementById('gi-progress-label');
        if (label) {
            label.textContent = collecting
                ? `Gathering · ${Math.min(eventCount, MIN_EVENTS_FOR_READY)}/${MIN_EVENTS_FOR_READY} shop signals`
                : 'Trained on your shop';
        }

        const note = document.getElementById('gi-insights-note');
        if (note) {
            note.textContent = collecting
                ? 'Live tiles update now · the rest unlock as data builds'
                : 'Live from today’s shop data';
        }

        renderInsights(shop);
    }

    /* ----- Insight deck --------------------------------------------------
     * Every tile either shows a real number from today's shop or says
     * "Learning" — never a blank or a fake figure. Tiles that have no data
     * at all get the `soon` chip + `is-soon` treatment; tiles with partial
     * data get the `learning` chip. Both read "Learning" to the user. */
    const MOVE_TYPE_LABEL = {
        use: 'serving pans', empty: 'emptying pans', transfer: 'transfers',
        swap: 'swaps', intake: 'production intake', assign: 'case assignments',
        adjust: 'pan adjustments', discard: 'discards', close: 'closing the case',
        snapshot: 'snapshots', reload: 'case reloads', 'auto-stage': 'auto-staged refills'
    };

    const pans = n => (Math.round((Number(n) || 0) * 10) / 10);
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    function weatherCard() {
        if (!weather) {
            return {
                icon: '☁', label: 'Sewell weather', chip: ['Learning', 'soon'], soon: true,
                value: 'Learning', sub: 'Reconnecting to the Sewell, NJ forecast'
            };
        }
        const bits = [weather.dayLabel, weatherDemandNote()];
        if (weather.precipChance) bits.push(`${weather.precipChance}% rain chance`);
        return {
            icon: weather.wet ? '☂' : '☀',
            label: 'Sewell weather',
            chip: ['Live', 'live'],
            cls: weather.wet ? 'is-wet' : '',
            value: `${weather.tempF}°F`,
            sub: bits.filter(Boolean).join(' · ')
        };
    }

    function movementCard(mv) {
        const total = Number(mv.movesToday || 0);
        if (!total) {
            return {
                icon: '⇄', label: 'Movement today', chip: ['Live', 'live'],
                value: 'Quiet so far', sub: 'Every case, freezer, and swap move is logged here'
            };
        }
        const top = mv.topType && MOVE_TYPE_LABEL[mv.topType]
            ? `Mostly ${MOVE_TYPE_LABEL[mv.topType]} (${mv.topTypeCount})`
            : 'Case and freezer activity logged today';
        return {
            icon: '⇄', label: 'Movement today', chip: ['Live', 'live'],
            value: plural(total, 'move'), sub: top
        };
    }

    function popularCard(mv) {
        const top = mv.topFlavor;
        if (!top || !top.name) {
            return {
                icon: '♥', label: 'Most popular flavor', chip: ['Learning', 'soon'], soon: true,
                value: 'Learning', sub: 'Ranks your best sellers once a few days of pans are logged'
            };
        }
        return {
            icon: '♥', label: 'Most popular flavor', chip: ['Learning', 'learning'],
            value: top.name,
            sub: `${plural(top.touches, 'move')} today · full ranking builds as history grows`
        };
    }

    function buildInsights(shop) {
        const t = shop.totals || {};
        const usage = shop.usage || {};
        const mv = shop.movement || {};
        const low = Array.isArray(shop.lowPans) ? shop.lowPans : [];
        const cost = (shop.pricing && shop.pricing.costPerPan) || 0;
        const used = Number(usage.usedPans || 0);
        const wasted = Number(usage.wastedPans || 0);

        return [
            {
                icon: '$', label: 'Price today', chip: ['Live', 'live'],
                value: money(used * cost),
                sub: used > 0
                    ? `${plural(pans(used), 'pan')} out of the case so far`
                    : 'Nothing served from the case yet today'
            },
            {
                icon: '∑', label: 'Total price', chip: ['Learning', 'learning'],
                value: t.totalValue != null ? money(t.totalValue) : 'Learning',
                soon: t.totalValue == null,
                sub: t.totalValue != null
                    ? `${plural(pans(t.totalPans), 'pan')} on hand · needs more history for a true total`
                    : 'Waiting on inventory to load'
            },
            weatherCard(),
            movementCard(mv),
            popularCard(mv),
            {
                icon: '◈', label: 'Case health', chip: low.length ? ['Action', 'learning'] : ['Live', 'live'],
                cls: low.length ? 'is-alert' : '',
                value: low.length ? `${plural(low.length, 'pan')} low` : 'All pans healthy',
                sub: low.length
                    ? low.slice(0, 3).map(p => p.name).filter(Boolean).join(', ') || 'Refill from short-term'
                    : `${t.caseSlots || 0} of ${t.caseSlotsMax || 0} case slots filled`
            },
            {
                icon: '⊘', label: 'Waste today', chip: ['Live', 'live'],
                value: money(wasted * cost),
                sub: wasted > 0
                    ? `${plural(pans(wasted), 'pan')} emptied or discarded`
                    : 'No waste logged today'
            },
            {
                icon: '%', label: 'Profit & margin', chip: ['Learning', 'soon'], soon: true,
                value: 'Learning', sub: 'Unlocks when register sales are matched against pan cost'
            },
            {
                icon: '✦', label: 'Tomorrow’s make list', chip: ['Learning', 'soon'], soon: true,
                value: 'Learning', sub: 'An AI production plan from weather, history, and what is running low'
            }
        ];
    }

    function renderInsights(shop) {
        const box = document.getElementById('gi-insights');
        if (!box) return;
        box.innerHTML = buildInsights(shop).map((c, i) => {
            const cls = ['gi-card', c.soon ? 'is-soon' : '', c.cls || ''].filter(Boolean).join(' ');
            return `<article class="${cls}" style="animation-delay:${i * 35}ms">
                <div class="gi-card-top">
                    <span class="gi-card-icon" aria-hidden="true">${esc(c.icon)}</span>
                    <span class="gi-chip gi-chip-${c.chip[1]}">${esc(c.chip[0])}</span>
                </div>
                <div class="gi-card-label">${esc(c.label)}</div>
                <div class="gi-card-value">${esc(c.value)}</div>
                <div class="gi-card-sub">${esc(c.sub)}</div>
            </article>`;
        }).join('');
    }

    /* ----- Chat ---------------------------------------------------------- */
    function wireUi() {
        const toggle = document.getElementById('gi-chat-toggle');
        const closeChat = document.getElementById('gi-chat-close');
        const panel = document.getElementById('gi-chat');
        const form = document.getElementById('gi-chat-form');
        const input = document.getElementById('gi-chat-input');
        const minimize = document.getElementById('gi-minimize');
        const expand = document.getElementById('gi-expand');
        const openBtn = document.getElementById('gi-open');
        const backdrop = document.getElementById('gi-backdrop');

        if (toggle && panel) {
            toggle.addEventListener('click', () => setChatOpen(panel.hasAttribute('hidden')));
        }
        if (closeChat) closeChat.addEventListener('click', () => setChatOpen(false));
        if (minimize) minimize.addEventListener('click', () => setPanelOpen(false));
        if (expand) expand.addEventListener('click', () => setPanelOpen(true));
        if (openBtn) {
            openBtn.addEventListener('click', () => {
                const wrap = document.getElementById('gi-popover-root');
                const isOpen = wrap ? !wrap.hasAttribute('hidden') : false;
                setPanelOpen(!isOpen);
            });
        }
        if (backdrop) backdrop.addEventListener('click', () => setPanelOpen(false));

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && uiMode === 'popover') setPanelOpen(false);
        });

        if (uiMode === 'inline') {
            // Admin: load minimized (collapsed strip) unless user left it open
            let adminPref = null;
            try { adminPref = localStorage.getItem('giAdminCollapsed'); } catch (_) { /* ignore */ }
            setPanelOpen(adminPref === '0');
        } else {
            // Popover starts closed so the gelato page loses no vertical space.
            // Honor an explicit prior "open" preference only.
            let giPref = null;
            try { giPref = localStorage.getItem('giOpen'); } catch (_) { /* ignore */ }
            setPanelOpen(giPref === '1');
        }

        if (form) {
            form.addEventListener('submit', e => {
                e.preventDefault();
                const text = (input && input.value || '').trim();
                if (!text) return;
                if (input) input.value = '';
                sendChat(text);
            });
        }
    }

    function listenChat() {
        const box = document.getElementById('gi-chat-log');
        if (!box) return;
        chatCol().orderBy('at', 'desc').limit(40).onSnapshot(snap => {
            if (snap.empty) {
                box.innerHTML = `<div class="gi-msg gi-msg-ai"><div class="gi-msg-bubble">
                    <strong>DVG Intelligence</strong>
                    <p>Ask about today’s price, stock, Sewell weather, or what to make — I’m still gathering information, so answers get sharper every day.</p>
                </div></div>`;
                return;
            }
            box.innerHTML = chatBubbles(snap.docs.slice().reverse());
            box.scrollTop = box.scrollHeight;
        }, err => {
            console.warn('chat listen', err);
            chatCol().limit(40).onSnapshot(snap => {
                const docs = snap.docs.slice().sort((a, b) => {
                    const ta = (a.data().at && a.data().at.toMillis) ? a.data().at.toMillis() : 0;
                    const tb = (b.data().at && b.data().at.toMillis) ? b.data().at.toMillis() : 0;
                    return ta - tb;
                });
                box.innerHTML = chatBubbles(docs);
                box.scrollTop = box.scrollHeight;
            });
        });
    }

    function chatBubbles(docs) {
        return docs.map(d => {
            const m = d.data();
            const role = m.role === 'user' ? 'user' : 'ai';
            return `<div class="gi-msg gi-msg-${role}"><div class="gi-msg-bubble">
                <strong>${role === 'user' ? 'You' : 'DVG Intelligence'}</strong>
                <p>${esc(m.text)}</p>
            </div></div>`;
        }).join('');
    }

    async function sendChat(text) {
        if (!db || chatBusy) return;
        chatBusy = true;
        const shop = getSnapshot() || {};
        try {
            await chatCol().add({
                role: 'user',
                text,
                date: todayStr(),
                at: stamp(),
                shopId: SHOP.id
            });
            recordEvent({ type: 'chat', text: `User asked Intelligence: ${text}`, meta: { role: 'user' } });

            const reply = await generateReply(text, shop);
            await chatCol().add({
                role: 'assistant',
                text: reply,
                date: todayStr(),
                at: stamp(),
                shopId: SHOP.id,
                collecting: isCollecting(),
                geminiReady: !!settings.geminiReady
            });
            recordEvent({ type: 'chat', text: `Intelligence replied (${isCollecting() ? 'collecting' : 'live'})`, meta: { role: 'assistant' } });
        } catch (e) {
            console.error('GelatoIntelligence sendChat', e);
        } finally {
            chatBusy = false;
        }
    }

    async function generateReply(text, shop) {
        // When Firebase Gemini / Cloud Function is enabled, call it first.
        if (settings.geminiReady && settings.geminiEndpoint) {
            try {
                const user = firebase.auth().currentUser;
                const token = user ? await user.getIdToken() : null;
                const res = await fetch(settings.geminiEndpoint, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(token ? { Authorization: 'Bearer ' + token } : {})
                    },
                    body: JSON.stringify({
                        message: text,
                        shop: SHOP,
                        snapshot: shop,
                        weather,
                        eventCount
                    })
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.reply) return String(data.reply);
                }
            } catch (e) {
                console.warn('Gemini endpoint failed, using local pulse', e);
            }
        }
        return localReply(text, shop);
    }

    function localReply(text, shop) {
        const q = text.toLowerCase();
        const t = (shop && shop.totals) || {};
        const low = (shop && shop.lowPans) || [];
        const used = (shop && shop.usage && shop.usage.usedPans) || 0;
        const note = isCollecting()
            ? '\n\nStill gathering information — deeper insights unlock as history builds.'
            : '';

        if (/weather|sewell|hot|cold|rain|temp|scoop/.test(q)) {
            if (!weather) return 'Sewell weather unavailable right now.' + note;
            let demand = weatherDemandNote();
            return `Sewell: ${weather.tempF}°F, ${weather.dayLabel}`
                + (weather.precipChance ? ` (${weather.precipChance}% rain chance today)` : '')
                + `. ${demand}.`
                + note;
        }

        if (/profit|value|price|money|\$/.test(q)) {
            return `Case ~${money(t.caseValue || 0)} · storage ~${money((t.shortValue || 0) + (t.longValue || 0))} · total ~${money(t.totalValue || 0)}.`
                + (used ? ` Served ${used} pans today.` : '')
                + note;
        }

        if (/make|produc|order|batch|what should/.test(q)) {
            if (weather && weather.wet) {
                return (low.length
                    ? `Rainy Sewell day — expect softer scoop traffic. Still refill lows: ${low.slice(0, 4).map(p => p.name).join(', ')}.`
                    : 'Rainy Sewell day — scoop demand usually soft. Keep the case tidy; don’t over-produce.')
                    + note;
            }
            if (low.length) {
                return `Refill first: ${low.slice(0, 5).map(p => p.name).join(', ')}.` + note;
            }
            return `Case looks steady (${t.caseSlots || 0} pans). No red pans right now.` + note;
        }

        if (/case|inventory|stock|freezer|short|long/.test(q)) {
            return `Case ${t.casePans || 0} · Short ${t.shortPans || 0} · Long ${t.longPans || 0}.`
                + (low.length ? ` Low: ${low.map(p => p.name).join(', ')}.` : '')
                + note;
        }

        return 'Ask about weather, what to make, profit, or stock. Answers use today’s live shop data.' + note;
    }

    // Public API used by gelato.js
    global.GelatoIntelligence = {
        init,
        recordEvent,
        refreshBanner: updateBanner,
        SHOP
    };
})(window);
