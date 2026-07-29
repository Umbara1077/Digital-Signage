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

        if (toggle && panel) {
            toggle.addEventListener('click', () => setChatOpen(panel.hasAttribute('hidden')));
        }
        if (closeChat) closeChat.addEventListener('click', () => setChatOpen(false));
        if (minimize) minimize.addEventListener('click', () => {
            setChatOpen(false);
            setCollapsed(true);
        });
        if (expand) expand.addEventListener('click', () => setCollapsed(false));

        // Default to MINIMIZED so the panel doesn't take over the view on load.
        // Only stay expanded if the user explicitly expanded it before ('0'); a
        // missing/unavailable preference falls through to minimized.
        let giPref = null;
        try { giPref = localStorage.getItem('giCollapsed'); } catch (_) { /* ignore */ }
        if (giPref !== '0') setCollapsed(true);

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
