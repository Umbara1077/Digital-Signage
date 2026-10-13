/* =========================================================================
 * TV Screen Health dashboard — admin side.
 *
 * Reads signageHealth/* (written by each TV via signage-health.js) and the
 * `videos` collection, and renders: an overall banner, a card per screen, a
 * per-video health summary, and a 12-hour warning timeline. Also publishes
 * window.DVHealth.videoStatus(url) so the Videos grid can badge each video.
 *
 * Read-only. Nothing here writes anything or can change what a TV shows, and
 * the whole thing is wrapped so a failure here cannot break the rest of the
 * admin page.
 * ========================================================================= */
(function () {
    'use strict';

    const $ = id => document.getElementById(id);
    const els = {
        live: $('hlLive'), ack: $('shAck'), banner: $('hlBanner'), screens: $('hlScreens'),
        videos: $('hlVideos'), timeline: $('hlTimeline'), nav: $('navHealthStatus')
    };
    if (!els.banner || typeof db === 'undefined') return;

    const STALE_MS = 3 * 60 * 1000;          // a screen reports every 60s
    const RECENT_FAIL_MS = 60 * 60 * 1000;   // a failure newer than this, and newer than the last good play, is a live problem
    const TIMELINE_HOURS = 12;
    const ACK_KEY = 'shAckedAt';

    let screens = [];
    let videos = [];
    let gotHealth = false;
    let gotVideos = false;

    /* ---- helpers -------------------------------------------------------- */
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const t = iso => { const n = Date.parse(iso || ''); return isNaN(n) ? 0 : n; };
    const ackedAt = () => { try { return t(localStorage.getItem(ACK_KEY)); } catch (e) { return 0; } };

    function ago(ms) {
        if (!ms) return 'never';
        const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
        if (s < 60) return s + 's ago';
        if (s < 3600) return Math.round(s / 60) + ' min ago';
        if (s < 86400) return Math.round(s / 3600) + ' h ago';
        return Math.round(s / 86400) + ' d ago';
    }
    const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    function duration(min) {
        if (min == null || isNaN(min)) return '—';
        if (min < 60) return min + ' min';
        const h = Math.floor(min / 60);
        return h < 48 ? h + ' h ' + (min % 60) + ' min' : Math.round(h / 24) + ' days';
    }

    /* Same key the TV uses (signage-health.js hashKey) — keep them identical. */
    function hashKey(s) {
        let h = 5381;
        const str = String(s || '');
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
        return 'v' + (h >>> 0).toString(36);
    }
    function fileName(url) {
        try {
            const last = decodeURIComponent(String(url || '').split('?')[0].split('/').pop() || '');
            return (last.split('/').pop() || last).replace(/^\d{13}_/, '').slice(0, 120);
        } catch (e) { return String(url || '').slice(0, 120); }
    }
    const menuLabel = f => f || 'Gelato menu';

    /* ---- status vocabulary: every level has a shape AND a label --------- */
    const ICON = {
        good: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="currentColor"/><path d="M5.8 10.3l2.8 2.8 5.6-6" fill="none" stroke="#0b0b0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        warning: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.6 19 17.6H1z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 7v5" stroke="#0b0b0b" stroke-width="2.2" stroke-linecap="round"/><circle cx="10" cy="14.9" r="1.25" fill="#0b0b0b"/></svg>',
        serious: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 .8 19.2 10 10 19.2.8 10z" fill="currentColor"/><path d="M10 5.6v5.2" stroke="#0b0b0b" stroke-width="2.2" stroke-linecap="round"/><circle cx="10" cy="13.9" r="1.25" fill="#0b0b0b"/></svg>',
        critical: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.3 1h7.4L19 6.3v7.4L13.7 19H6.3L1 13.7V6.3z" fill="currentColor"/><path d="M7 7l6 6M13 7l-6 6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
        neutral: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10 6v4.5l2.8 1.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    };
    const RANK = { good: 0, neutral: 0, warning: 1, serious: 2, critical: 3 };
    const icon = lvl => `<span class="st-icon st-${lvl}">${ICON[lvl] || ICON.neutral}</span>`;
    const chip = (lvl, label) => `<span class="st-chip lvl-${lvl}">${icon(lvl)}${esc(label)}</span>`;

    const TV_ICON = {
        video: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 8.2v7.6l6-3.8z" fill="currentColor"/></svg>',
        menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        loading: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="4 3"/></svg>',
        closed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="currentColor"/></svg>',
        off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v8M7.1 6.3a7.5 7.5 0 1 0 9.8 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
    };

    /* ---- the status model ---------------------------------------------- */
    /* A warning counts as new if nobody has marked it seen AND it is from
     * the last 24 hours. Older ones stay on the TV's record but no longer
     * turn the screen yellow — a problem from three days ago that hasn't
     * happened since is history, not something to act on. */
    const NEW_WINDOW_MS = 24 * 60 * 60 * 1000;
    function newWarningsOf(s) {
        const since = Math.max(ackedAt(), Date.now() - NEW_WINDOW_MS);
        return (Array.isArray(s.recentErrors) ? s.recentErrors : []).filter(e => t(e.at) > since);
    }

    function screenStatus(s) {
        const now = Date.now();
        const seen = t(s.lastSeenISO);
        const until = t(s.circuitOpenUntilISO);
        const warnings = newWarningsOf(s);
        if (!seen || now - seen > STALE_MS) {
            return { level: 'critical', label: 'Offline', live: false,
                detail: seen ? 'Not heard from since ' + clock(seen) + ' (' + ago(seen) + ')' : 'Has never reported in' };
        }
        if (until > now) {
            return { level: 'serious', label: 'Menu only', live: true,
                detail: 'Every video was failing — trying videos again at ' + clock(until) };
        }
        if (warnings.length || Number(s.videosQuarantined) > 0) {
            const n = warnings.length;
            return { level: 'warning', label: 'Working — needs a look', live: true,
                detail: n ? n + ' new warning' + (n === 1 ? '' : 's') + ' — a video was skipped'
                          : s.videosQuarantined + ' video(s) currently skipped' };
        }
        if (s.state === 'closed-screen') {
            return { level: 'good', label: 'Working', live: true, detail: 'Showing the closed screen (after hours)' };
        }
        return { level: 'good', label: 'Working', live: true, detail: 'Everything normal' };
    }

    /* One video's health, combined across every reporting screen. */
    function videoStatus(url) {
        if (!screens.length) return { level: 'neutral', label: 'No data yet', detail: 'No screen is reporting yet' };
        const key = hashKey(url);
        const now = Date.now();
        let benchedUntil = 0, lastFail = 0, lastError = '', lastPlay = 0, plays = 0;
        for (const s of screens) {
            const f = s.failures && s.failures[key];
            if (f) {
                benchedUntil = Math.max(benchedUntil, t(f.benchedUntilISO));
                if (t(f.lastAtISO) > lastFail) { lastFail = t(f.lastAtISO); lastError = f.lastError || ''; }
            }
            const p = s.played && s.played[key];
            if (p) { lastPlay = Math.max(lastPlay, t(p.lastPlayedISO)); plays += Number(p.plays) || 0; }
        }
        const reason = String(lastError).split(' — ')[0];
        if (benchedUntil > now) {
            return { level: 'critical', label: 'Skipped', detail: 'Failed repeatedly — skipped until ' + clock(benchedUntil) + (reason ? '. ' + reason : '') };
        }
        if (lastFail && now - lastFail < RECENT_FAIL_MS && lastFail > lastPlay) {
            return { level: 'warning', label: 'Failed recently', detail: ago(lastFail) + (reason ? ': ' + reason : '') };
        }
        if (lastPlay) {
            return { level: 'good', label: 'Playing fine', detail: 'Played ' + ago(lastPlay) + ' · ' + plays + ' play' + (plays === 1 ? '' : 's') };
        }
        return { level: 'neutral', label: 'Not played yet', detail: 'Hasn’t come up in the rotation since the screen started reporting' };
    }

    /* A failure's detail is written for one event; in a list only the cause
     * matters, so everything after the first em dash is dropped. */
    const causeOf = d => String(d || '').split(' — ')[0].replace(/\s*\(PipelineStatus[^)]*\)/, '').trim();

    /* Collapse repeats of the same cause on the same file into one line. */
    function groupWarnings(list) {
        const by = new Map();
        list.forEach(e => {
            const cause = causeOf(e.detail);
            const key = e.kind + '|' + (e.file || '') + '|' + cause;
            const g = by.get(key) || { kind: e.kind, file: e.file, text: cause, count: 0, at: 0 };
            g.count++;
            g.at = Math.max(g.at, t(e.at));
            by.set(key, g);
        });
        return [...by.values()].sort((a, b) => b.at - a.at);
    }

    /* Why a run of video failures happens, in words the shop can act on. */
    function downloadAdvice(list) {
        const vids = list.filter(e => /^video/.test(String(e.kind)));
        if (vids.length < 3) return '';
        const net = vids.filter(e => /network error|data source|not start|froze|missing or unsupported/i.test(e.detail)).length;
        if (net / vids.length < 0.6) return '';
        return 'These are download failures: the TV could not pull the file down, which is not the same as a broken video. ' +
            'The usual causes are the TV\'s Wi-Fi and the daily download allowance on the Firebase free plan — a large video ' +
            'replayed all day can use it up, and every video then fails until it resets the next day.';
    }

    /* ---- banner --------------------------------------------------------- */
    function renderBanner() {
        if (!gotHealth) {
            els.banner.className = 'hl-banner lvl-neutral';
            els.banner.innerHTML = `<div class="hl-banner-icon">${icon('neutral')}</div>
                <div class="hl-banner-text"><p class="hl-banner-title">Connecting&hellip;</p></div>`;
            return;
        }
        if (!screens.length) {
            els.banner.className = 'hl-banner lvl-neutral';
            els.banner.innerHTML = `<div class="hl-banner-icon">${icon('neutral')}</div>
                <div class="hl-banner-text"><p class="hl-banner-title">Waiting for a screen to report in</p>
                <p class="hl-banner-sub">Screens start reporting once the updated signage is deployed and the TV reloads.</p></div>`;
            setNav(null);
            return;
        }
        const statuses = screens.map(screenStatus);
        const worst = statuses.reduce((w, s) => RANK[s.level] > RANK[w.level] ? s : w, statuses[0]);
        const working = statuses.filter(s => s.level === 'good' || s.level === 'warning').length;
        const n = screens.length;
        const TITLES = {
            good: n === 1 ? 'The screen is working' : 'All screens working',
            warning: 'Working — there’s something to look at',
            serious: statuses.filter(s => s.level === 'serious').length > 1 ? 'Screens are showing the menu only' : 'A screen is showing the menu only',
            critical: statuses.filter(s => s.level === 'critical').length > 1 ? 'Screens are offline' : 'A screen is offline'
        };
        const SUBS = {
            good: 'Videos and the menu are rotating normally.',
            warning: 'A video was skipped. The screen kept going on its own — details below.',
            serious: 'Every video was failing, so the TV fell back to the menu. It will try videos again on its own.',
            critical: 'It hasn’t reported in over 3 minutes. It may be off, asleep, disconnected or frozen.'
        };
        els.banner.className = 'hl-banner lvl-' + worst.level;
        els.banner.innerHTML = `
            <div class="hl-banner-icon st-${worst.level}">${ICON[worst.level]}</div>
            <div class="hl-banner-text">
                <p class="hl-banner-title">${esc(TITLES[worst.level])}</p>
                <p class="hl-banner-sub">${esc(SUBS[worst.level])}</p>
            </div>
            <div class="hl-hero">
                <span class="hl-hero-value">${working}<span style="color:var(--dash-ink-3)"> / ${n}</span></span>
                <span class="hl-hero-label">screen${n === 1 ? '' : 's'} working</span>
            </div>`;
        setNav(worst.level);
    }

    function setNav(level) {
        if (!els.nav) return;
        els.nav.innerHTML = level ? icon(level) : '';
        els.nav.parentElement && els.nav.parentElement.setAttribute('aria-label',
            level ? 'Screen health: ' + ({ good: 'working', warning: 'needs a look', serious: 'menu only', critical: 'offline' }[level]) : 'Screen health');
    }

    /* ---- screen cards --------------------------------------------------- */
    function tvFor(s, st) {
        let mode, caption;
        if (!st.live) { mode = 'off'; caption = 'No signal'; }
        else if (s.state === 'closed-screen') { mode = 'closed'; caption = 'Closed screen'; }
        else if (s.state === 'video') { mode = 'video'; caption = s.current || 'Video'; }
        else if (s.state === 'loading-video') { mode = 'loading'; caption = 'Loading ' + (s.current || 'video'); }
        else { mode = 'menu'; caption = menuLabel(s.current) || 'Menu'; }
        const iconKey = mode === 'loading' ? 'loading' : mode;
        return `<div class="tv" aria-label="On screen now: ${esc(caption)}">
            <div class="tv-frame">
                <div class="tv-screen m-${mode}">${TV_ICON[iconKey]}<span class="tv-caption">${esc(caption)}</span></div>
                <span class="tv-power${st.live ? ' on' : ''}"></span>
            </div>
            <div class="tv-stand"></div>
        </div>`;
    }

    function renderScreens() {
        if (!screens.length) { els.screens.innerHTML = ''; return; }
        const STATE_WORDS = {
            video: 'Playing a video', 'loading-video': 'Loading a video', menu: 'Showing a menu',
            'menus-only': 'Menu only', 'closed-screen': 'Closed screen', booting: 'Starting up'
        };
        els.screens.innerHTML = screens.map(s => {
            const st = screenStatus(s);
            const warnings = newWarningsOf(s).slice().reverse();
            const avail = Number(s.videosAvailable) || 0;
            const skipped = Number(s.videosQuarantined) || 0;
            const alert = st.level === 'serious'
                ? `<div class="hl-alert lvl-serious">${icon('serious')}<span>Every video failed in a row, so this TV is showing the menu only until ${esc(clock(t(s.circuitOpenUntilISO)))}. Check the Videos panel below for the ones marked Skipped.</span></div>`
                : st.level === 'critical'
                ? `<div class="hl-alert lvl-critical">${icon('critical')}<span>No report in over 3 minutes. Check the TV is on and the browser is open. If it froze, the log on the TV will say why — see below.</span></div>`
                : '';
            /* The same video failing over and over is ONE problem, not twenty.
             * Repeats collapse into a single line with a count. */
            const groups = groupWarnings(warnings);
            const list = groups.length ? `
                <details class="hl-warnings">
                    <summary>${groups.length} thing${groups.length === 1 ? '' : 's'} to look at${
                        warnings.length > groups.length ? ` <span class="file">(${warnings.length} warnings in total)</span>` : ''}</summary>
                    <ul>${groups.map(g => {
                        const lvl = /menus-only/.test(g.kind) ? 'serious'
                            : /video/.test(g.kind) ? 'warning' : 'critical';
                        return `<li>${icon(lvl)}<span>${esc(g.text)}${g.file ? ` <span class="file">(${esc(g.file)})</span>` : ''}${
                            g.count > 1 ? ` <span class="file">&times;${g.count}</span>` : ''}</span><span class="when">${esc(ago(g.at))}</span></li>`;
                    }).join('')}</ul>
                </details>` : '';
            return `<article class="hl-screen">
                ${tvFor(s, st)}
                <div class="hl-screen-main">
                    <div class="hl-screen-top">
                        <div>
                            <h3 class="hl-screen-name">${esc(s.screenId || s.id)}</h3>
                            <p class="hl-screen-detail">${esc(st.detail)}</p>
                        </div>
                        ${chip(st.level, st.label)}
                    </div>
                    <div class="hl-stats">
                        <div class="hl-stat"><span class="hl-stat-label">Last seen</span><span class="hl-stat-value">${esc(ago(t(s.lastSeenISO)))}</span></div>
                        <div class="hl-stat"><span class="hl-stat-label">Running for</span><span class="hl-stat-value">${esc(st.live ? duration(s.uptimeMin) : '—')}</span></div>
                        <div class="hl-stat"><span class="hl-stat-label">Videos in rotation</span><span class="hl-stat-value">${st.live ? esc(avail - skipped) + ' of ' + esc(avail) : '—'}</span></div>
                        <div class="hl-stat"><span class="hl-stat-label">On screen</span><span class="hl-stat-value">${esc(st.live ? (STATE_WORDS[s.state] || s.state || '—') : 'Nothing')}</span></div>
                    </div>
                    ${alert}${list}
                </div>
            </article>`;
        }).join('');
    }

    /* ---- per-video summary --------------------------------------------- */
    function renderVideoSummary() {
        if (!gotVideos) { els.videos.innerHTML = '<p class="hl-empty">Loading videos&hellip;</p>'; return; }
        const head = `<h3 class="hl-panel-title">Videos</h3><p class="hl-panel-sub">How each video in the rotation is doing, across every screen.</p>`;
        if (!videos.length) {
            els.videos.innerHTML = head + '<p class="hl-empty">No videos uploaded — the TV is showing menus only. Add one under <a href="#wb-content" style="color:inherit">Content → Add Video</a>.</p>';
            return;
        }
        const advice = downloadAdvice([].concat(...screens.map(s => Array.isArray(s.recentErrors) ? s.recentErrors : [])));
        const counts = { good: 0, neutral: 0, warning: 0, critical: 0 };
        videos.forEach(v => { counts[videoStatus(v.url).level]++; });
        const total = videos.length;
        const order = [
            ['good', 'Playing fine'], ['neutral', 'Not played yet'],
            ['warning', 'Failed recently'], ['critical', 'Skipped']
        ];
        const bar = order.filter(([k]) => counts[k] > 0)
            .map(([k, label]) => `<span class="seg-${k}" style="flex:${counts[k]}" title="${counts[k]} ${label.toLowerCase()}"></span>`).join('');
        els.videos.innerHTML = head + `
            <div class="hl-big"><span class="hl-big-value">${counts.good} / ${total}</span><span class="hl-big-label">playing fine</span></div>
            <div class="hl-segbar" role="img" aria-label="${order.map(([k, l]) => counts[k] + ' ' + l.toLowerCase()).join(', ')}">${bar}</div>
            <ul class="hl-legend">${order.map(([k, label]) =>
                `<li>${icon(k)}<b>${counts[k]}</b>${esc(label)}</li>`).join('')}</ul>
            <ul class="hl-vlist">${videos.slice()
                .map(v => ({ v, st: videoStatus(v.url) }))
                .sort((a, b) => RANK[b.st.level] - RANK[a.st.level] || fileName(a.v.url).localeCompare(fileName(b.v.url)))
                .map(({ v, st }) => `<li>
                    <span class="hl-vname" title="${esc(fileName(v.url))}">${esc(fileName(v.url))}</span>
                    ${chip(st.level, st.label)}
                    <span class="hl-vdetail">${esc(st.detail)}</span>
                </li>`).join('')}</ul>${advice ? `<p class="hl-note">${esc(advice)}</p>` : ''}`;
    }

    /* ---- 12-hour timeline ---------------------------------------------- */
    const LANES = [
        { key: 'warning', label: 'Video skipped', match: k => /^video/.test(k) },
        { key: 'serious', label: 'Menu only', match: k => k === 'menus-only' },
        { key: 'critical', label: 'Screen error', match: k => !/^video/.test(k) && k !== 'menus-only' }
    ];
    let tipEl = null;
    let tlGroups = [];

    function renderTimeline() {
        const head = `<h3 class="hl-panel-title">Last ${TIMELINE_HOURS} hours</h3><p class="hl-panel-sub">Every warning from every screen, by the time it happened. Hover one for details.</p>`;
        if (!gotHealth) { els.timeline.innerHTML = head + '<p class="hl-empty">Connecting&hellip;</p>'; return; }
        const now = Date.now();
        const start = now - TIMELINE_HOURS * 3600 * 1000;
        const acked = ackedAt();
        const events = [];
        screens.forEach(s => (Array.isArray(s.recentErrors) ? s.recentErrors : []).forEach(e => {
            const at = t(e.at);
            if (at >= start && at <= now + 60000) events.push({ ...e, at, screen: s.screenId || s.id });
        }));
        if (!events.length) {
            els.timeline.innerHTML = head + `<div class="hl-empty-good">${icon('good')}<span>No problems in the last ${TIMELINE_HOURS} hours${screens.length ? '' : ' (no screen reporting yet)'}.</span></div>`;
            return;
        }
        const pos = at => Math.min(100, Math.max(0, (at - start) / (now - start) * 100));
        tlGroups = [];
        const ticks = [0, 3, 6, 9, 12].map(h => {
            const hoursAgo = TIMELINE_HOURS - h;
            const label = hoursAgo === 0 ? 'Now' : hoursAgo + 'h ago';
            return `<span style="left:${(h / TIMELINE_HOURS * 100).toFixed(2)}%">${esc(label)}</span>`;
        }).join('');
        /* Draw the empty strips first, MEASURE one, then place the markers.
         * The merge distance has to come from the strip's real width — read
         * before it exists (or before the panel has been laid out) it comes
         * back as zero, and then every marker in a lane merges into one. */
        els.timeline.innerHTML = head + `<div class="tl">` +
            LANES.map(l => `<div class="tl-lane" data-lane="${l.key}"><span class="tl-lane-label">${icon(l.key)}${esc(l.label)}</span><div class="tl-track"></div></div>`).join('') +
            `<div class="tl-axis"><span></span><div class="tl-axis-ticks">${ticks}</div></div></div>`;

        const firstTrack = els.timeline.querySelector('.tl-track');
        const trackPx = Math.max(120, (firstTrack && firstTrack.clientWidth) || 340);
        /* 26px = the 18px marker plus room for its count badge */
        const mergePct = Math.min(6, Math.max(1, 26 / trackPx * 100));

        LANES.forEach(l => {
            const evs = events.filter(e => l.match(String(e.kind)))
                .map(e => ({ ...e, p: pos(e.at) })).sort((a, b) => a.p - b.p);
            const groups = [];
            evs.forEach(e => {
                const g = groups[groups.length - 1];
                /* measured against the group's FIRST marker, so a long drizzle
                 * of failures can't chain-merge into one lump */
                if (g && e.p - g.first < mergePct) { g.items.push(e); }
                else groups.push({ items: [e], first: e.p });
            });
            const marks = groups.map(g => {
                const idx = tlGroups.push({ lane: l, items: g.items }) - 1;
                const p = g.items.reduce((s, e) => s + e.p, 0) / g.items.length;
                const n = g.items.length;
                const seen = g.items.every(e => e.at <= acked);
                const newest = g.items[g.items.length - 1];
                return `<button type="button" class="tl-mark st-${l.key}${seen ? ' is-seen' : ''}" style="left:${p.toFixed(2)}%" data-g="${idx}"
                    aria-label="${esc((n > 1 ? n + ' × ' : '') + l.label + ', latest at ' + clock(newest.at) + ': ' + newest.detail)}">${ICON[l.key]}${n > 1 ? `<span class="tl-count">${n}</span>` : ''}</button>`;
            }).join('');
            const track = els.timeline.querySelector(`.tl-lane[data-lane="${l.key}"] .tl-track`);
            if (track) track.innerHTML = marks;
        });
        wireTips();
    }

    function wireTips() {
        const box = els.timeline.querySelector('.tl');
        if (!box) return;
        if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tl-tip'; tipEl.hidden = true; }
        box.appendChild(tipEl);
        const show = m => {
            const g = tlGroups[Number(m.dataset.g)];
            if (!g) return;
            const items = g.items.slice().reverse();          /* newest first */
            const shown = items.slice(0, 4);
            tipEl.innerHTML = `<div class="tip-head">${icon(g.lane.key)}${items.length > 1 ? items.length + ' × ' : ''}${esc(g.lane.label)}</div>` +
                shown.map(e => `<div class="tip-item">${esc(e.detail)}${e.file ? ' — <em>' + esc(e.file) + '</em>' : ''}
                    <div class="tip-meta">${esc(e.screen)} · ${esc(clock(e.at))} (${esc(ago(e.at))})</div></div>`).join('') +
                (items.length > shown.length ? `<div class="tip-meta">+ ${items.length - shown.length} more</div>` : '');
            tipEl.hidden = false;
            const b = box.getBoundingClientRect(), r = m.getBoundingClientRect();
            const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
            let left = r.left - b.left + r.width / 2 - w / 2;
            left = Math.max(0, Math.min(left, b.width - w));
            let top = r.top - b.top - h - 8;
            if (top < 0) top = r.bottom - b.top + 8;
            tipEl.style.left = left + 'px';
            tipEl.style.top = top + 'px';
        };
        const hide = () => { tipEl.hidden = true; };
        box.querySelectorAll('.tl-mark').forEach(m => {
            m.addEventListener('mouseenter', () => show(m));
            m.addEventListener('focus', () => show(m));
            m.addEventListener('mouseleave', hide);
            m.addEventListener('blur', hide);
        });
    }

    /* ---- orchestration -------------------------------------------------- */
    function renderAll() {
        try {
            renderBanner();
            renderScreens();
            renderVideoSummary();
            renderTimeline();
        } catch (e) {
            console.error('screen health render', e);
        }
        try { window.dispatchEvent(new CustomEvent('dvhealth:update')); } catch (e) { /* ignore */ }
    }

    window.DVHealth = { videoStatus, icon, chip };

    function setLive(ok) {
        if (!els.live) return;
        els.live.innerHTML = ok ? '<span class="live-dot"></span>Live' : 'Connection problem — retrying';
    }

    db.collection('signageHealth').onSnapshot(snap => {
        gotHealth = true;
        screens = snap.docs.map(d => Object.assign({ id: d.id }, d.data()))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
        setLive(true);
        renderAll();
    }, err => { console.error('screen health', err); setLive(false); });

    db.collection('videos').onSnapshot(snap => {
        gotVideos = true;
        videos = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(v => typeof v.url === 'string');
        renderAll();
    }, err => console.error('screen health videos', err));

    if (els.ack) els.ack.addEventListener('click', () => {
        try { localStorage.setItem(ACK_KEY, new Date().toISOString()); } catch (e) { /* ignore */ }
        renderAll();
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderAll, 250);   /* the timeline is measured, so it re-measures */
    });

    renderAll();
    setInterval(renderAll, 20000);   // keeps "last seen", staleness and the timeline current
})();
