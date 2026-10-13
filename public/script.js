/* =========================================================================
 * Gelato signage — TV rotation:  video -> menu (45s) -> next video -> ...
 *
 * REWRITTEN 2026-09-19. The previous version had one failure mode that left
 * the TV black until someone reloaded it:
 *
 *   The only way out of a video was its `ended` event. If a video failed to
 *   load (deleted file, expired link, Wi-Fi drop, a format the TV can't
 *   decode) or froze mid-play, `ended` never fired — so the black video layer
 *   stayed up over the menu, for good. The unhandled play() rejection that
 *   came with it was never caught either.
 *
 * What replaces it (the same player the Caffe screens now run):
 *  - The menu is ALWAYS rendered underneath. The video layer only appears
 *    once a real frame is playing, and is taken down first whenever a video
 *    ends or fails — so the TV shows the menu, never a black screen.
 *  - WATCHDOGS on every video: it must start within 30s, keep making
 *    progress, and is capped at its own length plus slack.
 *  - SKIP, DON'T STOP. A failing video is skipped and reported. One that
 *    fails 3 times within an hour is benched for 30 minutes. If every video
 *    fails, the TV shows the menu only for 5 minutes, then tries again.
 *  - ONE STEP TIMER, so two rotations can never run at once, and a last-
 *    resort watchdog restarts the rotation if it ever goes quiet.
 *  - Every failure goes to signageHealth/<screen> for the admin panel's
 *    Screen Health section, and to a crash-proof local log (signage-health.js).
 *
 * The menu grid itself is unchanged: same Firestore listener, same cards,
 * same out-of-stock image, same 18-item limit and order.
 * ========================================================================= */
document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    const H = window.SignageHealth || {
        log() {}, report() {}, markPlayed() {}, setState() {}, startHeartbeat() {}, fileName: u => String(u || '')
    };

    const MENU_MS = 45000;                        // how long the menu shows between videos
    /* 30s, not less: the menu stays on screen while a video loads, so waiting
     * costs nothing visually, and a shorter limit falsely fails good videos on
     * slow Wi-Fi or MP4s exported without "fast start". */
    const START_TIMEOUT_MS = 30000;
    const STALL_TIMEOUT_MS = 20000;               // no progress for this long = frozen
    const VIDEO_HARD_CAP_MS = 10 * 60 * 1000;     // no video plays longer than 10 min
    const VIDEO_SLACK_MS = 15000;                 // grace past a video's own length
    const RETRY_GAP_MS = 1500;
    const BENCH_AFTER = 3;
    const BENCH_WINDOW_MS = 60 * 60 * 1000;
    const BENCH_MS = 30 * 60 * 1000;
    const MENUS_ONLY_MS = 5 * 60 * 1000;
    const WATCHDOG_EVERY_MS = 30000;

    const videoContainer = document.getElementById('video-container');
    const video = document.getElementById('intro-video');
    const homePage = document.getElementById('home-page');
    const menuGrid = document.querySelector('.gelato-grid');

    const outOfStockImageURL = 'https://firebasestorage.googleapis.com/v0/b/dolcevitasinage.appspot.com/o/outofstock.png?alt=media&token=803bbfa7-bc4d-45f8-87b7-8ab9dcbc774f';

    /* ---- layout -------------------------------------------------------- *
     * The menu is permanently on screen underneath; the video container
     * (position:fixed, z-index 900 in style.css) covers it only while a video
     * is actually playing. */
    homePage.style.display = 'block';
    videoContainer.style.display = 'none';

    /* ---- the video element --------------------------------------------- */
    /* The markup ships an empty <source src=""> and autoplay; we drive it. */
    video.querySelectorAll('source').forEach(s => s.remove());
    video.removeAttribute('src');
    video.removeAttribute('autoplay');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = 'auto';

    /* ---- menu grid (unchanged behaviour) -------------------------------- */
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function updateMenuGrid(menuItems) {
        menuGrid.innerHTML = '';
        menuItems
            .filter(item => !item.temporarilyUnavailable)
            .slice(0, 18).forEach(item => {
                const menuItem = document.createElement('div');
                menuItem.className = 'gelato-card';
                menuItem.innerHTML = `
                    <img src="${escapeHtml(item.outOfStock ? outOfStockImageURL : item.imageURL)}" alt="${escapeHtml(item.name)}">
                    <h3>${escapeHtml(item.name)}</h3>
                `;
                if (item.outOfStock) menuItem.classList.add('out-of-stock');
                menuGrid.appendChild(menuItem);
            });
    }

    db.collection('menuItems').onSnapshot(snapshot => {
        const menuItems = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            menuItems.push({
                name: data.name,
                imageURL: data.imageURL,
                outOfStock: data.outOfStock || false,
                temporarilyUnavailable: data.temporarilyUnavailable || false,
                order: data.order ?? 999
            });
        });
        menuItems.sort((a, b) => a.order - b.order);
        try { updateMenuGrid(menuItems); }
        catch (e) { H.report('menu-error', 'could not draw the menu: ' + (e && e.message)); }
    }, err => H.report('menu-error', 'menu listener failed: ' + (err && (err.code || err.message))));

    /* ---- the one step timer -------------------------------------------- */
    let stepTimer = null;
    let lastStepAt = Date.now();

    function scheduleStep(fn, ms, label) {
        clearTimeout(stepTimer);
        stepTimer = setTimeout(() => {
            stepTimer = null;
            lastStepAt = Date.now();
            try {
                fn();
            } catch (e) {
                H.report('rotation-error', (label || 'step') + ' threw: ' + (e && e.message));
                scheduleStep(showMenu, 2000, 'recover');
            }
        }, Math.max(0, ms || 0));
    }

    function showMenu() {
        endVideoAttempt();
        H.setState({ state: Date.now() < menusOnlyUntil ? 'menus-only' : 'menu', current: 'Gelato menu' });
        scheduleStep(startVideo, MENU_MS, 'menu->video');
    }

    /* ---- videos --------------------------------------------------------- */
    let videoSources = [];
    let videoIndex = 0;
    let listLoaded = false;
    let consecutiveFailures = 0;
    let menusOnlyUntil = 0;
    const recentFailuresByUrl = {};
    const benchedUntil = {};

    const isBenched = (url, now) => (benchedUntil[url] || 0) > now;
    const liveVideoCount = () => {
        const now = Date.now();
        return videoSources.filter(u => !isBenched(u, now)).length;
    };

    function pickNextVideo() {
        const now = Date.now();
        const n = videoSources.length;
        for (let k = 0; k < n; k++) {
            const idx = (videoIndex + k) % n;
            if (!isBenched(videoSources[idx], now)) {
                videoIndex = (idx + 1) % n;
                return videoSources[idx];
            }
        }
        return null;
    }

    let attempt = null;

    function endVideoAttempt() {
        const a = attempt;
        /* the layer comes down first, even with no attempt, so the menu shows */
        videoContainer.style.display = 'none';
        if (!a) return;
        attempt = null;
        a.settled = true;
        clearTimeout(a.startTimer);
        clearTimeout(a.capTimer);
        clearInterval(a.progressTimer);
        video.onerror = video.onended = video.onplaying = video.onloadedmetadata = video.ontimeupdate = null;
        try { video.pause(); } catch (e) { /* ignore */ }
        /* release the decoder and buffer — the TV runs all day */
        try { video.removeAttribute('src'); video.load(); } catch (e) { /* ignore */ }
    }

    function startVideo() {
        const now = Date.now();
        if (now < menusOnlyUntil) { showMenu(); return; }
        if (!videoSources.length) {
            H.setState({ state: 'menu', current: listLoaded ? 'no videos — menu only' : 'Gelato menu' });
            showMenu();
            return;
        }
        const url = pickNextVideo();
        if (!url) {
            openMenusOnly('every video is benched after repeated failures');
            showMenu();
            return;
        }

        endVideoAttempt();
        const a = { url: url, settled: false, started: false, lastProgressAt: Date.now(), lastTime: -1 };
        attempt = a;
        H.setState({ state: 'loading-video', current: H.fileName(url) });

        const fail = (reason) => {
            if (a.settled || attempt !== a) return;
            endVideoAttempt();
            noteFailure(url, reason);
            consecutiveFailures++;
            H.setState({ consecutiveFailures: consecutiveFailures });
            if (consecutiveFailures >= Math.max(1, liveVideoCount())) {
                openMenusOnly(consecutiveFailures + ' video(s) failed in a row');
                scheduleStep(showMenu, RETRY_GAP_MS, 'fail->menu');
            } else {
                scheduleStep(startVideo, RETRY_GAP_MS, 'fail->next-video');
            }
        };
        const finish = (note) => {
            if (a.settled || attempt !== a) return;
            const didPlay = a.started;
            endVideoAttempt();
            if (didPlay) H.markPlayed(url);
            consecutiveFailures = 0;
            H.setState({ consecutiveFailures: 0 });
            if (note) H.log('warn', note + ' — ' + H.fileName(url));
            scheduleStep(showMenu, 0, 'video->menu');
        };

        video.onerror = () => {
            const err = video.error;
            const names = { 1: 'load aborted', 2: 'network error', 3: 'could not decode', 4: 'file missing or unsupported format' };
            fail('media error: ' + (err ? (names[err.code] || 'code ' + err.code) +
                (err.message ? ' (' + err.message + ')' : '') : 'unknown'));
        };
        video.onplaying = () => {
            if (a.settled || attempt !== a) return;
            a.lastProgressAt = Date.now();
            if (!a.started) {
                a.started = true;
                clearTimeout(a.startTimer);
                videoContainer.style.display = 'block';   // only now: a real frame is up
                H.setState({ state: 'video' });
            }
        };
        video.ontimeupdate = () => {
            if (video.currentTime !== a.lastTime) {
                a.lastTime = video.currentTime;
                a.lastProgressAt = Date.now();
            }
        };
        video.onloadedmetadata = () => {
            const d = video.duration;
            const cap = (isFinite(d) && d > 0)
                ? Math.min(d * 1000 + VIDEO_SLACK_MS, VIDEO_HARD_CAP_MS)
                : VIDEO_HARD_CAP_MS;
            clearTimeout(a.capTimer);
            a.capTimer = setTimeout(overran, cap);
        };
        /* Past its own length plus slack. If it got to (nearly) the end it
         * just didn't fire `ended` — fine. If not, it froze: report it. */
        const overran = () => {
            const d = video.duration, at = video.currentTime;
            if (isFinite(d) && d > 0 && at < d - 1.5) {
                fail('froze mid-play at ' + Math.round(at) + 's of ' + Math.round(d) + 's');
            } else {
                finish('video ran past its own length');
            }
        };
        video.onended = () => finish();

        a.startTimer = setTimeout(() => fail('did not start within ' + (START_TIMEOUT_MS / 1000) + 's'), START_TIMEOUT_MS);
        a.capTimer = setTimeout(() => finish('hit the 10 minute cap'), VIDEO_HARD_CAP_MS);
        a.progressTimer = setInterval(() => {
            if (a.settled) return;
            if (a.started && Date.now() - a.lastProgressAt > STALL_TIMEOUT_MS) {
                fail('froze mid-play — no progress for ' + (STALL_TIMEOUT_MS / 1000) + 's');
            }
        }, 5000);

        video.src = url;
        let p;
        try { p = video.play(); } catch (e) { fail('play() threw: ' + (e && e.message)); return; }
        if (p && typeof p.catch === 'function') {
            p.catch(err => {
                if (err && err.name === 'AbortError') return;   // superseded load, not a failure
                fail('play() rejected: ' + (err ? (err.name + ' ' + (err.message || '')).trim() : 'unknown'));
            });
        }
    }

    function noteFailure(url, reason) {
        const now = Date.now();
        const hits = (recentFailuresByUrl[url] || []).filter(t => now - t < BENCH_WINDOW_MS);
        hits.push(now);
        recentFailuresByUrl[url] = hits;
        let detail = reason;
        let extra = null;
        if (hits.length >= BENCH_AFTER) {
            benchedUntil[url] = now + BENCH_MS;
            recentFailuresByUrl[url] = [];
            detail += ' — skipped for 30 min after ' + BENCH_AFTER + ' failures in an hour';
            extra = { benchedUntilISO: new Date(benchedUntil[url]).toISOString() };
        } else {
            detail += ' — skipped';
        }
        H.report('video-failed', detail, url, extra);
        H.setState({ videosQuarantined: Object.keys(benchedUntil).filter(u => benchedUntil[u] > now).length });
    }

    function openMenusOnly(why) {
        menusOnlyUntil = Date.now() + MENUS_ONLY_MS;
        consecutiveFailures = 0;
        H.report('menus-only', why + ' — showing the menu only for 5 min, then trying videos again');
        H.setState({
            state: 'menus-only',
            consecutiveFailures: 0,
            circuitOpenUntilISO: new Date(menusOnlyUntil).toISOString()
        });
    }

    /* ---- the video list ------------------------------------------------- *
     * Live, as before — but a list change only updates the list. It never
     * starts or restarts the rotation. */
    db.collection('videos').onSnapshot(snapshot => {
        const list = [];
        let bad = 0;
        snapshot.forEach(doc => {
            const u = (doc.data() || {}).url;
            if (typeof u === 'string' && /^https?:\/\//i.test(u)) list.push(u); else bad++;
        });
        if (bad > 0) H.report('video-list', bad + ' video record(s) have no usable URL — ignored');
        const firstLoad = !listLoaded;
        listLoaded = true;
        videoSources = list;
        if (videoIndex >= list.length) videoIndex = 0;
        Object.keys(benchedUntil).forEach(u => { if (!list.includes(u)) delete benchedUntil[u]; });
        H.setState({ videosAvailable: list.length });
        H.log('info', 'video list: ' + list.length + ' video(s)');
        /* The very first list: start with a video, as the TV always has. */
        if (firstLoad && list.length && !attempt) scheduleStep(startVideo, 0, 'first-video');
    }, err => {
        H.report('video-list', 'could not load the video list (' + (err && (err.code || err.message)) +
            ') — keeping ' + videoSources.length + ' already loaded');
    });

    /* ---- last-resort watchdog ------------------------------------------ */
    setInterval(() => {
        if (!stepTimer && !attempt) {
            H.report('watchdog', 'rotation had no next step — restarting it');
            scheduleStep(showMenu, 0, 'watchdog');
            return;
        }
        const idle = Date.now() - lastStepAt;
        const budget = (attempt ? VIDEO_HARD_CAP_MS : MENU_MS) + 2 * 60 * 1000;
        if (idle > budget) {
            H.report('watchdog', 'rotation stuck for ' + Math.round(idle / 1000) + 's — forcing recovery');
            endVideoAttempt();
            scheduleStep(showMenu, 0, 'watchdog');
        }
    }, WATCHDOG_EVERY_MS);

    /* ---- boot ----------------------------------------------------------- */
    H.startHeartbeat();
    showMenu();          // menu up immediately; the first video list starts a video
    window.addEventListener('offline', () => H.log('warn', 'network lost — carrying on with what is loaded'));
});
