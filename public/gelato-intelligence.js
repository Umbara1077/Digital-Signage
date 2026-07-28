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

    /* ----- Weather (Sewell, NJ via Open-Meteo — no API key) -------------- */
    async function refreshWeather() {
        const url = 'https://api.open-meteo.com/v1/forecast'
            + `?latitude=${SHOP.lat}&longitude=${SHOP.lon}`
            + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature'
            + '&temperature_unit=fahrenheit&wind_speed_unit=mph'
            + `&timezone=${encodeURIComponent(SHOP.timezone)}`;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error('weather http ' + res.status);
            const data = await res.json();
            const c = data.current || {};
            weather = {
                tempF: Math.round(c.temperature_2m),
                feelsF: Math.round(c.apparent_temperature),
                humidity: Math.round(c.relative_humidity_2m),
                windMph: Math.round(c.wind_speed_10m),
                code: c.weather_code,
                label: WMO[c.weather_code] || 'Local weather',
                fetchedAt: Date.now()
            };
            updateWeatherUi();
            updateBanner();
        } catch (e) {
            console.warn('GelatoIntelligence weather', e);
            const el = document.getElementById('gi-weather');
            if (el) el.innerHTML = `<span class="gi-weather-fallback">Sewell, NJ · weather unavailable</span>`;
        }
    }

    function updateWeatherUi() {
        const el = document.getElementById('gi-weather');
        if (!el || !weather) return;
        el.innerHTML = `
            <div class="gi-weather-card">
                <div class="gi-weather-temp">${weather.tempF}°</div>
                <div class="gi-weather-meta">
                    <strong>Sewell, NJ</strong>
                    <span>${esc(weather.label)} · feels ${weather.feelsF}°</span>
                    <span>Humidity ${weather.humidity}% · Wind ${weather.windMph} mph</span>
                </div>
            </div>`;
    }

    /* ----- Banner + live insight chips ----------------------------------- */
    function buildLocalInsights(shop) {
        const chips = [];
        if (!shop || !shop.totals) {
            chips.push({ tone: 'soon', label: 'Waiting on live inventory…' });
            return chips;
        }
        const t = shop.totals;
        const low = shop.lowPans || [];
        chips.push({ tone: 'value', label: `On-hand ≈ ${money(t.totalValue)}` });
        chips.push({ tone: 'case', label: `Case ${t.casePans || 0} pans · ${t.caseSlots || 0} slots` });
        if (low.length) {
            chips.push({ tone: 'warn', label: `${low.length} low pan${low.length === 1 ? '' : 's'} ≤ 0.5` });
        } else {
            chips.push({ tone: 'ok', label: 'Case levels look healthy' });
        }
        if (shop.usage && shop.usage.usedPans > 0) {
            chips.push({ tone: 'usage', label: `Today served ${shop.usage.usedPans} pans` });
        }
        if (weather) {
            const hot = weather.tempF >= 80;
            const cold = weather.tempF <= 40;
            chips.push({
                tone: hot ? 'hot' : (cold ? 'cold' : 'wx'),
                label: hot
                    ? 'Warm Sewell day — expect scoop demand ↑'
                    : cold
                        ? 'Chilly outside — watch indoor traffic'
                        : `${weather.tempF}° in Sewell · good gelato weather`
            });
        }
        if (isCollecting()) {
            chips.push({ tone: 'soon', label: 'Gemini learning from every move' });
        } else {
            chips.push({ tone: 'ready', label: 'Deep insights ready' });
        }
        return chips;
    }

    function leadMessage(shop) {
        if (isCollecting()) {
            const left = Math.max(0, MIN_EVENTS_FOR_READY - eventCount);
            if (eventCount === 0) {
                return 'Still collecting shop data — every scoop, swap, and stock move is being saved for Gelato Intelligence. Insights & Gemini chat coming soon.';
            }
            return `Still collecting shop data · ${eventCount} event${eventCount === 1 ? '' : 's'} logged · ~${left} more before deep Gemini oversight unlocks. Live shop pulse is already on — full production intelligence coming soon.`;
        }
        const low = (shop && shop.lowPans) || [];
        if (low.length) {
            return `Intelligence is live. ${low.length} case pan${low.length === 1 ? '' : 's'} running low — ask me what to produce next for Sewell.`;
        }
        return 'Gelato Intelligence is live. Ask about production for today, profit on the case, or what Sewell weather means for scoops.';
    }

    function updateBanner() {
        const root = document.getElementById('gelato-intelligence');
        if (!root) return;
        const shop = getSnapshot() || {};
        root.classList.toggle('gi-collecting', isCollecting());
        root.classList.toggle('gi-ready', !isCollecting());

        const lead = document.getElementById('gi-lead');
        if (lead) lead.textContent = leadMessage(shop);

        const badge = document.getElementById('gi-collect-badge');
        if (badge) {
            badge.textContent = isCollecting() ? 'Collecting data' : 'Intelligence live';
            badge.className = 'gi-badge ' + (isCollecting() ? 'is-collecting' : 'is-ready');
        }

        const count = document.getElementById('gi-event-count');
        if (count) {
            count.textContent = `${eventCount} event${eventCount === 1 ? '' : 's'} stored for Gemini`;
        }

        const chips = document.getElementById('gi-chips');
        if (chips) {
            chips.innerHTML = buildLocalInsights(shop).map(c =>
                `<span class="gi-chip gi-chip-${c.tone}">${esc(c.label)}</span>`).join('');
        }

        updateWeatherUi();
    }

    /* ----- Chat ---------------------------------------------------------- */
    function wireUi() {
        const toggle = document.getElementById('gi-chat-toggle');
        const panel = document.getElementById('gi-chat');
        const form = document.getElementById('gi-chat-form');
        const input = document.getElementById('gi-chat-input');
        if (toggle && panel) {
            toggle.addEventListener('click', () => {
                const open = panel.hasAttribute('hidden');
                if (open) panel.removeAttribute('hidden');
                else panel.setAttribute('hidden', '');
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                toggle.textContent = open ? 'Hide chat' : 'Ask Intelligence';
                if (open && input) input.focus();
            });
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
        document.querySelectorAll('[data-gi-prompt]').forEach(btn => {
            btn.addEventListener('click', () => sendChat(btn.getAttribute('data-gi-prompt')));
        });
    }

    function listenChat() {
        const box = document.getElementById('gi-chat-log');
        if (!box) return;
        chatCol().orderBy('at', 'desc').limit(40).onSnapshot(snap => {
            if (snap.empty) {
                box.innerHTML = `<div class="gi-msg gi-msg-ai"><div class="gi-msg-bubble">
                    <strong>Gelato Intelligence</strong>
                    <p>Hi — I’m learning Dolce Vita’s Sewell shop. Ask about today’s case, what to make, or the weather. While Gemini finishes warming up, I’ll share live pulse insights from your inventory.</p>
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
            // Missing index — fall back to unordered recent
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
        const collectingBlurb = isCollecting()
            ? `\n\n📡 Still collecting data for full Gemini oversight (${eventCount}/${MIN_EVENTS_FOR_READY} events). Keep running the shop normally — every move trains Gelato Intelligence. Coming soon: day-by-day make lists, profit estimates, and weather-aware production.`
            : '';

        if (/weather|sewell|hot|cold|rain|temp/.test(q)) {
            if (!weather) {
                return 'I couldn’t reach Sewell weather just now. Try again in a moment.' + collectingBlurb;
            }
            return `Sewell, NJ is ${weather.tempF}°F (${weather.label}), feels like ${weather.feelsF}°, humidity ${weather.humidity}%, wind ${weather.windMph} mph.`
                + (weather.tempF >= 80
                    ? ' Warm days usually lift scoop traffic — keep short-term backed up on top sellers.'
                    : weather.tempF <= 40
                        ? ' Colder days can slow walk-ups; lean the case toward proven favorites and watch waste.'
                        : ' Mild gelato weather — a balanced case should move steadily.')
                + collectingBlurb;
        }

        if (/profit|value|price|money|\$/.test(q)) {
            return `Live inventory pulse: case ≈ ${money(t.caseValue || 0)}, short-term ≈ ${money(t.shortValue || 0)}, long-term ≈ ${money(t.longValue || 0)}, on-hand total ≈ ${money(t.totalValue || 0)} at your current $${(shop.pricing && shop.pricing.pricePerGram) || '—'} /g.`
                + (used ? ` Today you’ve served about ${used} pans from the case.` : '')
                + collectingBlurb;
        }

        if (/make|produc|order|batch|what should/.test(q)) {
            if (low.length) {
                const names = low.slice(0, 5).map(p => `${p.name} (Pan ${p.pan}, ${p.active})`).join('; ');
                return `Based on the live case, prioritize refills for: ${names}. Pull from short-term when you can — that’s how this shop feeds the case.`
                    + collectingBlurb;
            }
            return `No pans are in the red right now. Case holds ${t.casePans || 0} pans across ${t.caseSlots || 0} slots. Keep short-term stocked on your best movers; Gemini will sharpen day-of make lists once more history lands.`
                + collectingBlurb;
        }

        if (/case|inventory|stock|freezer|short|long/.test(q)) {
            return `Case ${t.casePans || 0} pans · Short-Term ${t.shortPans || 0} · Long-Term ${t.longPans || 0} · Queue ${shop.queueLength || 0}.`
                + (low.length ? ` Low now: ${low.map(p => p.name).join(', ')}.` : ' Levels look steady.')
                + collectingBlurb;
        }

        return `I’m Dolce Vita Gelato Intelligence for the Sewell shop. I can talk weather, case value, low pans, and production hints from live inventory while Gemini learns from every move you log.`
            + `\n\nTry: “What’s the weather?”, “What should we make?”, or “How’s our profit on the case?”`
            + collectingBlurb;
    }

    // Public API used by gelato.js
    global.GelatoIntelligence = {
        init,
        recordEvent,
        refreshBanner: updateBanner,
        SHOP
    };
})(window);
