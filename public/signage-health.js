/* =========================================================================
 * Signage health — diagnostics for the gelato TV screens.
 *
 * Two jobs, and neither is allowed to affect what is on screen:
 *
 * 1. A CRASH-PROOF LOCAL LOG. The browser console is wiped whenever the page
 *    reloads or the tab dies — exactly when you need it. This keeps the last
 *    400 lines in localStorage, which is disk-backed and survives a crash, a
 *    reload and a full browser restart. On the TV, open the console (F12) and
 *    run either of:
 *        signageDiagnostics()              -> the log as an array
 *        copy(localStorage.signageLog)     -> the log onto the clipboard
 *
 * 2. A HEARTBEAT DOCUMENT, signageHealth/<screenId>, written once a minute,
 *    that the admin panel reads: when the screen was last seen, what it is
 *    showing, and every video failure with its reason.
 *
 * Every Firestore write in here is fire-and-forget. If the rules reject it or
 * the network is down, it is dropped — reporting must never be the thing that
 * takes the screen down. The logger also rate-limits itself so that some
 * future runaway loop can't turn the logger into the thing that hangs the tab.
 * ========================================================================= */
(function (global) {
    'use strict';

    const VERSION = '2026-09-19';

    /* The gelato signage project. index.html and early.html both load
     * firebaseConfig.js first, so this is normally the default app already;
     * the named app is only a fallback. */
    const SIGNAGE_CONFIG = {
        apiKey: 'AIzaSyAQTwB6-NdzeaiqsoeIDCCtWuxf-2oxmIQ',
        authDomain: 'dolcevitasinage.firebaseapp.com',
        projectId: 'dolcevitasinage',
        storageBucket: 'dolcevitasinage.appspot.com',
        messagingSenderId: '525631031898',
        appId: '1:525631031898:web:53dfa013799a41ab1c2663'
    };

    const LOG_KEY = 'signageLog';
    const LOG_MAX = 400;
    const LOG_BURST_MAX = 40;          // lines per second before we start dropping
    const MAX_RECENT = 20;
    /* Warnings older than this are dropped. Without an age limit the list is
     * simply "the last 20 things that ever went wrong", so a bad evening days
     * ago keeps showing in the admin panel as if it were happening now. */
    const RECENT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
    const MAX_FAILURE_KEYS = 50;
    const HEARTBEAT_MS = 60000;
    const WRITE_MIN_GAP_MS = 5000;

    /* One doc per physical screen. Override on a second TV with ?screen=case-tv
     * once; it is remembered in that browser. */
    function resolveScreenId() {
        let id = null;
        try {
            const q = new URLSearchParams(location.search).get('screen');
            if (q && /^[a-z0-9-]{1,40}$/.test(q)) { localStorage.setItem('signageScreenId', q); id = q; }
            if (!id) id = localStorage.getItem('signageScreenId');
        } catch (e) { /* storage unavailable */ }
        return (id && /^[a-z0-9-]{1,40}$/.test(id)) ? id : 'gelato-tv';
    }

    const screenId = resolveScreenId();
    const page = (location.pathname.split('/').pop() || 'index.html').slice(0, 40);
    const startedAt = new Date();

    const state = {
        state: page === 'early.html' ? 'closed-screen' : 'booting',
        current: page === 'early.html' ? 'Closed screen' : null,
        videosAvailable: 0,
        videosQuarantined: 0,
        consecutiveFailures: 0,
        circuitOpenUntilISO: null
    };
    let recentErrors = [];
    let failures = {};
    /* Successful plays, per video. Without these, "no failures" can't be told
     * apart from "never played", and the admin panel couldn't honestly say a
     * video is working. */
    let played = {};
    let db = null;
    let seeded = false;
    let writeTimer = null;
    let lastWriteAt = 0;
    let warnedWriteRejected = false;
    let reporting = false;

    /* ---- local log ------------------------------------------------------ */
    let burstSecond = 0, burstCount = 0, burstDropped = 0;

    function safeText(x, max) {
        let s;
        try { s = (typeof x === 'string') ? x : JSON.stringify(x); } catch (e) { s = String(x); }
        return String(s == null ? '' : s).slice(0, max || 300);
    }

    function log(level, msg, extra) {
        const now = Date.now();
        const sec = Math.floor(now / 1000);
        if (sec !== burstSecond) {
            if (burstDropped) writeLine('warn', `log flood: dropped ${burstDropped} line(s)`);
            burstSecond = sec; burstCount = 0; burstDropped = 0;
        }
        if (++burstCount > LOG_BURST_MAX) { burstDropped++; return; }
        writeLine(level, msg, extra);
    }

    function writeLine(level, msg, extra) {
        try {
            const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
            fn.call(console, '[signage]', msg, extra == null ? '' : extra);
        } catch (e) { /* console unavailable */ }
        try {
            const arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
            arr.push({
                t: new Date().toISOString(),
                level: level,
                page: page,
                msg: safeText(msg, 300),
                extra: extra == null ? undefined : safeText(extra, 400)
            });
            while (arr.length > LOG_MAX) arr.shift();
            localStorage.setItem(LOG_KEY, JSON.stringify(arr));
        } catch (e) { /* quota or storage unavailable — console still has it */ }
    }

    /* ---- Firestore ------------------------------------------------------ */
    function getDb() {
        if (db) return db;
        try {
            if (typeof firebase === 'undefined' || typeof firebase.firestore !== 'function') return null;
            const def = firebase.apps.find(a => a.name === '[DEFAULT]');
            if (def && def.options && def.options.projectId === SIGNAGE_CONFIG.projectId) {
                db = def.firestore();
                return db;
            }
            let app = firebase.apps.find(a => a.name === 'signageHealthApp');
            if (!app) app = firebase.initializeApp(SIGNAGE_CONFIG, 'signageHealthApp');
            db = app.firestore();
            return db;
        } catch (e) {
            log('warn', 'health reporting unavailable', e && e.message);
            return null;
        }
    }

    const docRef = () => getDb() && getDb().collection('signageHealth').doc(screenId);

    /* Pick up the warnings already on the doc, so a page reload (which
     * happens twice a day at open and close) doesn't erase them. */
    function seed() {
        const ref = docRef();
        if (!ref) { seeded = true; return; }
        ref.get().then(s => {
            if (s.exists) {
                const x = s.data() || {};
                if (Array.isArray(x.recentErrors)) recentErrors = freshOnly(x.recentErrors).slice(-MAX_RECENT);
                if (x.failures && typeof x.failures === 'object') failures = x.failures;
                if (x.played && typeof x.played === 'object') played = x.played;
            }
        }).catch(() => { /* first run, or rules not deployed yet */ })
          .then(() => { seeded = true; scheduleWrite(); });
        /* never wait forever on the seed */
        setTimeout(() => { if (!seeded) { seeded = true; scheduleWrite(); } }, 10000);
    }

    function freshOnly(list) {
        const cutoff = Date.now() - RECENT_MAX_AGE_MS;
        return (list || []).filter(e => {
            const at = Date.parse(e && e.at);
            return !isNaN(at) && at >= cutoff;
        });
    }

    function payload() {
        return {
            screenId: screenId,
            page: page,
            version: VERSION,
            lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
            lastSeenISO: new Date().toISOString(),
            startedAtISO: startedAt.toISOString(),
            uptimeMin: Math.round((Date.now() - startedAt.getTime()) / 60000),
            userAgent: safeText(navigator.userAgent, 180),
            state: safeText(state.state, 30),
            current: state.current == null ? null : safeText(state.current, 120),
            videosAvailable: Number(state.videosAvailable) || 0,
            videosQuarantined: Number(state.videosQuarantined) || 0,
            consecutiveFailures: Number(state.consecutiveFailures) || 0,
            circuitOpenUntilISO: state.circuitOpenUntilISO || null,
            recentErrors: (recentErrors = freshOnly(recentErrors)).slice(-MAX_RECENT),
            failures: failures,
            played: played
        };
    }

    function flush() {
        const ref = docRef();
        if (!ref || !seeded) return;
        lastWriteAt = Date.now();
        try {
            ref.set(payload()).catch(e => {
                if (!warnedWriteRejected) {
                    warnedWriteRejected = true;
                    log('warn', 'health write rejected — deploy firestore.rules to enable admin warnings',
                        e && (e.code || e.message));
                }
            });
        } catch (e) { /* never throw into the page */ }
    }

    function scheduleWrite() {
        if (writeTimer) return;
        const wait = Math.max(0, WRITE_MIN_GAP_MS - (Date.now() - lastWriteAt));
        writeTimer = setTimeout(() => { writeTimer = null; flush(); }, wait);
    }

    /* ---- public API ----------------------------------------------------- */
    function hashKey(s) {
        let h = 5381;
        const str = String(s || '');
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        return 'v' + (h >>> 0).toString(36);
    }

    /* "videos%2Fsummer-promo.mp4?alt=media&token=…" -> "summer-promo.mp4" */
    function fileName(url) {
        try {
            const path = String(url || '').split('?')[0];
            const last = decodeURIComponent(path.split('/').pop() || '');
            /* uploads are stored as videos/<timestamp>_<name>; show just the name */
            return (last.split('/').pop() || last || String(url)).replace(/^\d{13}_/, '').slice(0, 120);
        } catch (e) { return String(url || '').slice(0, 120); }
    }

    /* Trim a per-video map to its most recently touched entries. */
    function capMap(map, dateField) {
        const keys = Object.keys(map);
        if (keys.length <= MAX_FAILURE_KEYS) return;
        keys.sort((a, b) => String(map[a][dateField]).localeCompare(String(map[b][dateField])));
        for (const k of keys.slice(0, keys.length - MAX_FAILURE_KEYS)) delete map[k];
    }

    /* A video reached its end (or its length) — it works on this screen.
     * Memory only; the next heartbeat carries it, so plays cost no writes. */
    function markPlayed(url) {
        try {
            const key = hashKey(url);
            const p = played[key] || { file: fileName(url), plays: 0 };
            p.plays = (Number(p.plays) || 0) + 1;
            p.lastPlayedISO = new Date().toISOString();
            played[key] = p;
            capMap(played, 'lastPlayedISO');
        } catch (e) { /* never throw into the player */ }
    }

    function report(kind, detail, url, extra) {
        if (reporting) return;                 // an error inside reporting must not recurse
        reporting = true;
        try {
            const entry = {
                at: new Date().toISOString(),
                kind: safeText(kind, 40),
                detail: safeText(detail, 300),
                file: url ? fileName(url) : null
            };
            recentErrors.push(entry);
            while (recentErrors.length > MAX_RECENT) recentErrors.shift();

            if (url) {
                const key = hashKey(url);
                const f = failures[key] || { file: fileName(url), count: 0 };
                f.count = (Number(f.count) || 0) + 1;
                f.lastError = safeText(detail, 200);
                f.lastAtISO = entry.at;
                /* when the player benches a video it says until when, so the
                 * admin panel can show "skipped until 3:40" */
                f.benchedUntilISO = (extra && extra.benchedUntilISO) || null;
                failures[key] = f;
                capMap(failures, 'lastAtISO');
            }
            log(kind === 'menus-only' ? 'warn' : 'error', `${kind}: ${detail}`, url ? fileName(url) : undefined);
            scheduleWrite();
        } catch (e) { /* swallow */ }
        finally { reporting = false; }
    }

    function setState(partial) {
        try { Object.assign(state, partial || {}); } catch (e) { /* ignore */ }
    }

    let heartbeatStarted = false;
    function startHeartbeat() {
        if (heartbeatStarted) return;
        heartbeatStarted = true;
        seed();
        setInterval(() => { scheduleWrite(); }, HEARTBEAT_MS);
    }

    /* Anything that escapes a handler anywhere on the page ends up here, so
     * next time the screen dies we have the cause instead of an empty console. */
    global.addEventListener('error', e => {
        if (!e || e.target !== global) return;         // media/resource errors handled by the player
        report('page-error', `${e.message || 'error'} @ ${String(e.filename || '').split('/').pop()}:${e.lineno || '?'}`);
    });
    global.addEventListener('unhandledrejection', e => {
        const r = e && e.reason;
        report('unhandled-rejection', r && (r.message || r.code || r.name) ? (r.name || '') + ' ' + (r.message || r.code || '') : safeText(r, 200));
    });

    global.SignageHealth = { log, report, markPlayed, setState, startHeartbeat, fileName, hashKey, screenId, VERSION };
    global.signageDiagnostics = () => {
        try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
    };

    log('info', `signage-health ${VERSION} started on ${page} as "${screenId}"`);

    /* The closed screen has no player to start the heartbeat, so it starts
     * itself; index.html's player starts it once it is running. */
    if (page === 'early.html') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startHeartbeat);
        else startHeartbeat();
    }
})(window);
