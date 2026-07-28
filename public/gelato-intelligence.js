/* ===========================================================================
 * Dolce Vita · Gelato Intelligence
 * ---------------------------------------------------------------------------
 * Advanced oversight layer for the gelato management panel.
 *
 * - Logs structured shop events to Firestore (`gelatoIntelligenceEvents`)
 *   alongside daily rollups (`gelatoIntelligenceDaily`) and chat turns
 *   (`gelatoIntelligenceChat`) so Gemini can learn production patterns,
 *   pricing, and profit once enabled in the Firebase project.
 * - Renders a Gemini/Copilot-style intelligence banner with Sewell, NJ weather,
 *   live shop chips, and an in-panel chat.
 * - Until Gemini is enabled / enough history exists, the banner stays useful
 *   with live inventory insights and a clear "still collecting data" state.
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

    const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: SHOP.timezone });
    const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
    const money = n => '$' + (Math.round((n || 0) * 100) / 100)
        .toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const eventsCol = () => db.collection('gelatoIntelligenceEvents');
    const dailyCol = () => db.collection('gelatoIntelligenceDaily');
    const chatCol = () => db.collection('gelatoIntelligenceChat');
    const settingsRef = () => db.collection('gelatoSettings').doc('intelligence');

    function isCollecting() {
        return !settings.geminiReady || eventCount < MIN_EVENTS_FOR_READY;
    }

    /* ----- Boot ---------------------------------------------------------- */
    function init(opts) {
        if (started) return;
        db = opts && opts.db;
        getSnapshot = (opts && opts.getSnapshot) || (() => null);
        if (!db || !document.getElementById('gelato-intelligence')) return;
        started = true;

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
        const payload = {
            type: partial.type || 'note',
            text: partial.text || '',
            source: 'gelato-panel',
            shopId: SHOP.id,
            shopName: SHOP.name,
            city: SHOP.city,
            date: todayStr(),
            at: stamp(),
            pricing: shop.pricing || null,
            totals: shop.totals || null,
            case: Array.isArray(shop.case) ? shop.case : null,
            usage: shop.usage || null,
            queueLength: shop.queueLength != null ? shop.queueLength : null,
            weather: weather ? {
                tempF: weather.tempF,
                code: weather.code,
                label: weather.label,
                humidity: weather.humidity,
                windMph: weather.windMph
            } : null,
            meta: partial.meta || null
        };

        eventsCol().add(payload)
            .then(() => settingsRef().set({
                eventCount: firebase.firestore.FieldValue.increment(1),
                lastEventAt: stamp(),
                updatedAt: stamp()
            }, { merge: true }))
            .catch(err => console.error('GelatoIntelligence recordEvent', err));

        maybeWriteDailySnapshot('event');
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
            updateWeatherUi();
            updateBanner();
        } catch (e) {
            console.warn('GelatoIntelligence weather', e);
            weather = null;
            updateWeatherUi();
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

    function updateWeatherUi() {
        const value = document.getElementById('gi-wx-value');
        const note = document.getElementById('gi-wx-note');
        const card = document.getElementById('gi-metric-weather');
        if (!value || !note) return;
        if (!weather) {
            value.textContent = '—';
            note.textContent = 'Unavailable';
            if (card) card.classList.remove('is-wet');
            return;
        }
        value.textContent = `${weather.tempF}°`;
        note.textContent = weather.wet
            ? `${weather.dayLabel} · scoop demand soft`
            : `${weather.dayLabel} · ${weatherDemandNote()}`;
        if (card) card.classList.toggle('is-wet', !!weather.wet);
    }

    /* Headline: collecting OR a short "what's going on today" */
    function heroMessage(shop) {
        if (isCollecting()) {
            return {
                text: 'Still collecting shop data',
                sub: 'Gelato Intelligence will recommend what to make, estimate daily profit, and read Sewell demand from weather + history. Right now every scoop and stock move is being saved — insights unlock when Gemini is connected and enough data is in.'
            };
        }
        const t = (shop && shop.totals) || {};
        const low = (shop && shop.lowPans) || [];
        const used = (shop && shop.usage && shop.usage.usedPans) || 0;
        if (weather && weather.wet && low.length) {
            return {
                text: `Rainy day · ${low.length} pan${low.length === 1 ? '' : 's'} running low`,
                sub: 'Sewell is wet — expect softer walk-up traffic. Refill red pans from short-term when you can.'
            };
        }
        if (weather && weather.wet) {
            return {
                text: 'Rainy in Sewell — quieter scoop day',
                sub: 'Live case, profit, and stock are on the cards. Ask Intelligence for a production read anytime.'
            };
        }
        if (low.length) {
            return {
                text: `${low.length} case pan${low.length === 1 ? '' : 's'} need attention`,
                sub: `Low now: ${low.slice(0, 4).map(p => p.name).join(', ')}. Pull from short-term to keep the case healthy.`
            };
        }
        if (used > 0) {
            return {
                text: `Served ${used} pans so far today`,
                sub: `Case holds ${t.caseSlots || 0} pans · on-hand about ${money(t.totalValue || 0)}.`
            };
        }
        return {
            text: 'Shop pulse looks healthy',
            sub: `Case ${t.caseSlots || 0} pans · on-hand about ${money(t.totalValue || 0)}. Ask for production or profit details anytime.`
        };
    }

    function setCollapsed(collapsed) {
        const root = document.getElementById('gelato-intelligence');
        const body = document.getElementById('gi-body');
        const strip = document.getElementById('gi-expand');
        if (!root || !body || !strip) return;
        root.classList.toggle('is-collapsed', collapsed);
        body.hidden = !!collapsed;
        strip.hidden = !collapsed;
        try { localStorage.setItem('giCollapsed', collapsed ? '1' : '0'); } catch (_) { /* ignore */ }
    }

    function setChatOpen(open) {
        const panel = document.getElementById('gi-chat');
        const toggle = document.getElementById('gi-chat-toggle');
        const input = document.getElementById('gi-chat-input');
        if (!panel) return;
        if (open) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        if (toggle) {
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            toggle.textContent = open ? 'Close chat' : 'Ask Intelligence';
        }
        if (open && input) input.focus();
    }

    function updateBanner() {
        const root = document.getElementById('gelato-intelligence');
        if (!root) return;
        const shop = getSnapshot() || {};
        root.classList.toggle('gi-collecting', isCollecting());
        root.classList.toggle('gi-ready', !isCollecting());

        const hero = heroMessage(shop);
        const lead = document.getElementById('gi-lead');
        const sub = document.getElementById('gi-sub');
        const collapsedMsg = document.getElementById('gi-collapsed-msg');
        if (lead) lead.textContent = hero.text;
        if (sub) sub.textContent = hero.sub;
        if (collapsedMsg) collapsedMsg.textContent = hero.text;

        const badge = document.getElementById('gi-collect-badge');
        if (badge) {
            if (!settings.geminiReady || eventCount < MIN_EVENTS_FOR_READY) {
                badge.textContent = 'Still collecting data';
                badge.className = 'gi-badge is-collecting';
            } else {
                badge.textContent = 'Gemini live';
                badge.className = 'gi-badge is-ready';
            }
        }

        const t = shop.totals || {};
        const used = (shop.usage && shop.usage.usedPans) || 0;
        const cost = (shop.pricing && shop.pricing.costPerPan) || 0;
        const profitToday = r2Money(used * cost);

        const profitVal = document.getElementById('gi-profit-value');
        const profitNote = document.getElementById('gi-profit-note');
        if (profitVal) profitVal.textContent = used > 0 ? money(profitToday) : '$0';
        if (profitNote) profitNote.textContent = used > 0 ? `${used} pans served today` : 'No pans served yet';

        const stockVal = document.getElementById('gi-stock-value');
        const stockNote = document.getElementById('gi-stock-note');
        if (stockVal) stockVal.textContent = t.totalValue != null ? money(t.totalValue) : '—';
        if (stockNote) {
            const pans = t.totalPans != null ? t.totalPans : '—';
            stockNote.textContent = `${pans} pans on hand`;
        }

        const caseVal = document.getElementById('gi-case-value');
        const caseNote = document.getElementById('gi-case-note');
        if (caseVal) {
            const slots = t.caseSlots != null ? t.caseSlots : '—';
            caseVal.textContent = `${slots}`;
        }
        if (caseNote) {
            const low = (shop.lowPans || []).length;
            caseNote.textContent = low
                ? `${low} low · ${used} served`
                : `${used} served today`;
        }

        updateWeatherUi();
    }

    function r2Money(n) {
        return Math.round((Number(n) || 0) * 100) / 100;
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

        if (toggle && panel) {
            toggle.addEventListener('click', () => {
                const open = panel.hasAttribute('hidden');
                setChatOpen(open);
            });
        }
        if (closeChat) closeChat.addEventListener('click', () => setChatOpen(false));
        if (minimize) minimize.addEventListener('click', () => {
            setChatOpen(false);
            setCollapsed(true);
        });
        if (expand) expand.addEventListener('click', () => setCollapsed(false));

        try {
            if (localStorage.getItem('giCollapsed') === '1') setCollapsed(true);
        } catch (_) { /* ignore */ }

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
                    <strong>Gelato Intelligence</strong>
                    <p>Gemini isn’t connected yet. I can still answer from today’s case, usage, and Sewell weather while shop data collects.</p>
                </div></div>`;
                return;
            }
            const docs = snap.docs.slice().reverse();
            box.innerHTML = docs.map(d => {
                const m = d.data();
                const role = m.role === 'user' ? 'user' : 'ai';
                return `<div class="gi-msg gi-msg-${role}"><div class="gi-msg-bubble">
                    <strong>${role === 'user' ? 'You' : 'Gelato Intelligence'}</strong>
                    <p>${esc(m.text)}</p>
                </div></div>`;
            }).join('');
            box.scrollTop = box.scrollHeight;
        }, err => {
            console.warn('chat listen', err);
            chatCol().limit(40).onSnapshot(snap => {
                const docs = snap.docs.slice().sort((a, b) => {
                    const ta = (a.data().at && a.data().at.toMillis) ? a.data().at.toMillis() : 0;
                    const tb = (b.data().at && b.data().at.toMillis) ? b.data().at.toMillis() : 0;
                    return ta - tb;
                });
                box.innerHTML = docs.map(d => {
                    const m = d.data();
                    const role = m.role === 'user' ? 'user' : 'ai';
                    return `<div class="gi-msg gi-msg-${role}"><div class="gi-msg-bubble">
                        <strong>${role === 'user' ? 'You' : 'Gelato Intelligence'}</strong>
                        <p>${esc(m.text)}</p>
                    </div></div>`;
                }).join('');
                box.scrollTop = box.scrollHeight;
            });
        });
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
        const note = !settings.geminiReady
            ? '\n\nGemini isn’t connected yet — this is a live shop pulse while data collects.'
            : (isCollecting() ? '\n\nStill collecting history for deeper insights.' : '');

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

        return 'Ask about weather, what to make, or case value. Gemini isn’t connected yet — answers use today’s live shop data.' + note;
    }

    // Public API used by gelato.js
    global.GelatoIntelligence = {
        init,
        recordEvent,
        refreshBanner: updateBanner,
        SHOP
    };
})(window);
