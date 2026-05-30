/* ===========================================================================
 * Gelato Inventory Management
 * ---------------------------------------------------------------------------
 * Self-contained inventory tool for the gelato flavors that live on the menu
 * (the `menuItems` collection). Tracks each flavor across three locations:
 *
 *   - active     : the display case. 18 single-pan slots, each filled 0.0..1.0
 *   - shortTerm  : short-term freezer, up to 20 pans total
 *   - longTerm   : long-term freezer, up to 40 pans total
 *
 * Only flavors currently on the menu are shown. Data lives in its own
 * `gelatoInventory` collection (doc id == menuItems id) plus a
 * `gelatoSettings/queue` doc for the swap queue, so nothing here writes to any
 * pre-existing collection and it can't interfere with the rest of the app.
 * ========================================================================= */

(function () {
    'use strict';

    // ----- Constants -------------------------------------------------------
    const CASE_SLOTS = 18;     // pans in the case
    const SHORT_CAP = 20;      // pans the short-term freezer holds
    const LONG_CAP = 40;       // pans the long-term freezer holds
    const SWAP_THRESHOLD = 0.3; // recommend a swap at/below this case fill
    const EPS = 1e-6;

    const LOCATION_LABELS = {
        active: 'Case',
        shortTerm: 'Short-Term',
        longTerm: 'Long-Term',
        use: 'Used / Served'
    };

    // ----- State -----------------------------------------------------------
    let db = null;
    let inventory = [];        // raw gelatoInventory docs
    let menuIds = null;        // Set of menuItems ids (null until first load)
    let flavors = [];          // inventory filtered to current menu, sorted
    let queue = [];            // [{ pan, flavorId, name }]
    let statMode = false;
    const queueDocRef = () => db.collection('gelatoSettings').doc('queue');

    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;     // pan amounts -> 2dp
    const byId = id => inventory.find(f => f.id === id);
    const onMenu = f => !menuIds || menuIds.has(f.id);

    // ----- Boot ------------------------------------------------------------
    document.addEventListener('DOMContentLoaded', () => {
        firebase.auth().onAuthStateChanged(user => {
            if (!user) return; // auth gate in the page handles redirect
            db = firebase.firestore();
            wireUi();
            start();
        });
    });

    async function start() {
        await seedMissingFromMenu();

        db.collection('menuItems').onSnapshot(snap => {
            menuIds = new Set(snap.docs.map(d => d.id));
            renderAll();
        }, err => console.error('menuItems snapshot error', err));

        db.collection('gelatoInventory').onSnapshot(snap => {
            inventory = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderAll();
        }, err => console.error('inventory snapshot error', err));

        queueDocRef().onSnapshot(doc => {
            queue = (doc.exists && Array.isArray(doc.data().queue)) ? doc.data().queue : [];
            renderQueue();
        }, err => console.error('queue snapshot error', err));
    }

    /* Create an inventory doc for every menu flavor that doesn't have one yet.
     * Additive only -- it never deletes. */
    async function seedMissingFromMenu() {
        try {
            const [menuSnap, invSnap] = await Promise.all([
                db.collection('menuItems').get(),
                db.collection('gelatoInventory').get()
            ]);
            const existing = new Set(invSnap.docs.map(d => d.id));
            const batch = db.batch();
            let added = 0;
            menuSnap.forEach(doc => {
                if (existing.has(doc.id)) return;
                const m = doc.data();
                batch.set(db.collection('gelatoInventory').doc(doc.id), {
                    name: m.name || '(unnamed)',
                    gelatoImage: m.gelatoImage || m.imageURL || '',
                    imageURL: m.imageURL || '',
                    active: 0, casePan: null, shortTerm: 0, longTerm: 0,
                    updatedAt: stamp()
                });
                added++;
            });
            if (added) await batch.commit();
        } catch (e) {
            console.error('seedMissingFromMenu failed', e);
        }
    }

    /* TEST HELPER: fill the long-term freezer from the current menu flavors so
     * there's something to move around. Gives each flavor up to 2 pans, stopping
     * at the 40-pan cap. Safe to click repeatedly -- it only tops up to the cap. */
    async function loadTestStock() {
        await seedMissingFromMenu();
        if (!flavors.length) { status('No menu flavors found. Try Sync first.'); return; }
        let remaining = r2(LONG_CAP - sumLoc('longTerm'));
        if (remaining <= 0) { status('Long-term freezer is already full (40 pans).'); return; }

        const batch = db.batch();
        let added = 0;
        for (const f of flavors) {
            if (remaining <= 0) break;
            const add = Math.min(2, remaining);
            batch.update(db.collection('gelatoInventory').doc(f.id),
                { longTerm: r2((f.longTerm || 0) + add), updatedAt: stamp() });
            remaining = r2(remaining - add);
            added = r2(added + add);
        }
        await batch.commit();
        status(`Loaded ${added} test pans into the long-term freezer.`, true);
    }

    // ----- UI wiring -------------------------------------------------------
    function wireUi() {
        document.getElementById('sync-flavors').addEventListener('click', async () => {
            status('Syncing flavors from menu…');
            await seedMissingFromMenu();
            status('Synced.', true);
        });
        document.getElementById('seed-test').addEventListener('click', loadTestStock);
        document.getElementById('mode-visual').addEventListener('click', () => setMode(false));
        document.getElementById('mode-stats').addEventListener('click', () => setMode(true));
        document.getElementById('transferForm').addEventListener('submit', onTransfer);
        document.getElementById('t-from').addEventListener('change', refreshTransferHint);
        document.getElementById('t-to').addEventListener('change', refreshTransferHint);
        document.getElementById('t-flavor').addEventListener('change', refreshTransferHint);
    }

    function setMode(stats) {
        statMode = stats;
        document.getElementById('mode-stats').classList.toggle('active', stats);
        document.getElementById('mode-visual').classList.toggle('active', !stats);
        document.querySelectorAll('.visual-only').forEach(el => { el.hidden = stats; });
        document.querySelectorAll('.stats-only').forEach(el => { el.hidden = !stats; });
        renderAll();
    }

    function status(msg, autoClear) {
        const el = document.getElementById('g-status');
        el.textContent = msg;
        if (autoClear) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2500);
    }

    // ----- Derived helpers (menu flavors only) -----------------------------
    const withAmt = loc => flavors.filter(f => (f[loc] || 0) > EPS)
        .sort((a, b) => (b[loc] || 0) - (a[loc] || 0));
    const sumLoc = loc => r2(flavors.reduce((s, f) => s + (f[loc] || 0), 0));
    const casePans = () => flavors.filter(f => f.casePan);

    // ----- Rendering -------------------------------------------------------
    function renderAll() {
        flavors = inventory.filter(onMenu)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        renderCaps();
        renderTransferFlavors();
        if (statMode) {
            renderStatsPanel();
        } else {
            renderCase();
            renderFreezer('short', 'shortTerm', SHORT_CAP);
            renderFreezer('long', 'longTerm', LONG_CAP);
        }
        renderRecos();
        renderQueue();
        refreshTransferHint();
    }

    function renderCaps() {
        document.getElementById('case-cap').textContent = `${casePans().length} / ${CASE_SLOTS} pans`;
        document.getElementById('short-cap').textContent = `${sumLoc('shortTerm')} / ${SHORT_CAP} pans`;
        document.getElementById('long-cap').textContent = `${sumLoc('longTerm')} / ${LONG_CAP} pans`;
    }

    function renderCase() {
        const wrap = document.getElementById('case-visual');
        const slots = {};
        flavors.forEach(f => { if (f.casePan) slots[f.casePan] = f; });

        let html = '';
        for (let pan = 1; pan <= CASE_SLOTS; pan++) {
            const f = slots[pan];
            if (f) {
                const lvl = Math.max(0, Math.min(1, f.active || 0));
                const pct = Math.round(lvl * 100);
                const low = (f.active || 0) <= SWAP_THRESHOLD + EPS;
                const swatch = f.gelatoImage ? `style="background-image:url('${f.gelatoImage}')"` : '';
                html += `
                <div class="g-pan ${low ? 'low' : ''}" data-id="${f.id}">
                    <div class="g-pan-head"><span class="g-pan-num">PAN ${pan}</span>${low ? '<span class="g-pan-flag">SWAP</span>' : ''}</div>
                    <div class="g-tub">
                        <div class="g-tub-rim"></div>
                        <div class="g-gelato" style="height:${pct}%">
                            <div class="g-gelato-top"></div>
                        </div>
                        <div class="g-scoop" ${swatch}></div>
                    </div>
                    <div class="g-pan-name" title="${esc(f.name)}">${esc(f.name)}</div>
                    <div class="g-pan-meter"><span style="width:${pct}%"></span></div>
                    <div class="g-pan-amt">${r2(f.active)} pan · ${pct}%</div>
                    <div class="g-pan-actions">
                        <button type="button" data-act="use" data-id="${f.id}">Serve 0.1</button>
                        <button type="button" data-act="empty" data-id="${f.id}">Empty</button>
                    </div>
                </div>`;
            } else {
                html += `
                <div class="g-pan empty">
                    <div class="g-pan-head"><span class="g-pan-num">PAN ${pan}</span></div>
                    <div class="g-tub empty"><span>empty</span></div>
                    <button type="button" class="g-assign-btn" data-pan="${pan}">+ Assign flavor</button>
                </div>`;
            }
        }
        wrap.innerHTML = html;

        wrap.querySelectorAll('[data-act="use"]').forEach(b =>
            b.addEventListener('click', () => serve(b.dataset.id, 0.1)));
        wrap.querySelectorAll('[data-act="empty"]').forEach(b =>
            b.addEventListener('click', () => emptyPan(b.dataset.id)));
        wrap.querySelectorAll('.g-assign-btn').forEach(b =>
            b.addEventListener('click', () => assignToPan(Number(b.dataset.pan))));
    }

    function renderFreezer(prefix, loc, cap) {
        const wrap = document.getElementById(`${prefix}-visual`);
        const items = withAmt(loc);
        const used = sumLoc(loc);
        const overPct = Math.min(100, (used / cap) * 100);

        let html = `<div class="g-cap-bar"><div class="g-cap-bar-fill" style="width:${overPct}%"></div>
            <span>${used} / ${cap} pans</span></div><div class="g-tubs">`;
        if (!items.length) html += `<p class="g-empty-note">No pans stored here.</p>`;
        items.forEach(f => {
            const whole = Math.floor((f[loc] || 0) + EPS);
            const frac = r2((f[loc] || 0) - whole);
            let icons = '';
            for (let i = 0; i < whole; i++) icons += `<span class="g-tub-icon full"></span>`;
            if (frac > EPS) icons += `<span class="g-tub-icon" style="--frac:${frac}"></span>`;
            const swatch = f.gelatoImage ? `style="background-image:url('${f.gelatoImage}')"` : '';
            html += `
            <div class="g-frz-tub">
                <div class="g-frz-swatch" ${swatch}></div>
                <div class="g-frz-info">
                    <div class="g-frz-name">${esc(f.name)}</div>
                    <div class="g-tub-icons">${icons}</div>
                    <div class="g-frz-amt">${r2(f[loc])} pans</div>
                </div>
            </div>`;
        });
        html += `</div>`;
        wrap.innerHTML = html;
    }

    // ----- Stat mode -------------------------------------------------------
    function renderStatsPanel() {
        const occ = casePans().length;
        const lowCount = casePans().filter(f => (f.active || 0) <= SWAP_THRESHOLD + EPS).length;
        const caseFill = r2(casePans().reduce((s, f) => s + (f.active || 0), 0));
        const short = sumLoc('shortTerm');
        const long = sumLoc('longTerm');
        const total = r2(caseFill + short + long);

        kpiCards([
            ['Case pans filled', `${occ} / ${CASE_SLOTS}`, occ / CASE_SLOTS],
            ['Low pans (≤ 0.3)', `${lowCount}`, lowCount ? 1 : 0, lowCount ? 'red' : 'green'],
            ['Case gelato', `${caseFill} pans`, caseFill / CASE_SLOTS],
            ['Short-term', `${short} / ${SHORT_CAP}`, short / SHORT_CAP],
            ['Long-term', `${long} / ${LONG_CAP}`, long / LONG_CAP],
            ['Total gelato', `${total} pans`, total / (CASE_SLOTS + SHORT_CAP + LONG_CAP)]
        ]);

        bars('stat-case', casePans().map(f => ({ name: `P${f.casePan} ${f.name}`, val: f.active || 0 })),
            1, true);
        bars('stat-short', withAmt('shortTerm').map(f => ({ name: f.name, val: f.shortTerm || 0 })),
            Math.max(SHORT_CAP / 4, maxVal('shortTerm')), false);
        bars('stat-long', withAmt('longTerm').map(f => ({ name: f.name, val: f.longTerm || 0 })),
            Math.max(LONG_CAP / 4, maxVal('longTerm')), false);

        renderStatTable();
    }

    const maxVal = loc => flavors.reduce((m, f) => Math.max(m, f[loc] || 0), 0) || 1;

    function kpiCards(rows) {
        document.getElementById('stat-kpis').innerHTML = rows.map(([label, value, frac, tone]) => {
            const pct = Math.max(0, Math.min(100, (frac || 0) * 100));
            return `
            <div class="g-kpi">
                <div class="g-kpi-val ${tone || ''}">${value}</div>
                <div class="g-kpi-label">${label}</div>
                <div class="g-kpi-bar"><span class="${tone || ''}" style="width:${pct}%"></span></div>
            </div>`;
        }).join('');
    }

    function bars(elId, data, max, lowAware) {
        const el = document.getElementById(elId);
        data = data.filter(d => d.val > EPS).sort((a, b) => b.val - a.val);
        if (!data.length) { el.innerHTML = `<p class="g-empty-note">Nothing here yet.</p>`; return; }
        const m = Math.max(max, ...data.map(d => d.val), 0.0001);
        el.innerHTML = data.map(d => {
            const pct = (d.val / m) * 100;
            const low = lowAware && d.val <= SWAP_THRESHOLD + EPS;
            return `
            <div class="g-bar-row">
                <span class="g-bar-label" title="${esc(d.name)}">${esc(d.name)}</span>
                <span class="g-bar-track"><span class="g-bar ${low ? 'low' : ''}" style="width:${pct}%"></span></span>
                <span class="g-bar-val">${r2(d.val)}</span>
            </div>`;
        }).join('');
    }

    function renderStatTable() {
        const rows = flavors
            .map(f => ({
                name: f.name,
                pan: f.casePan || null,
                active: r2(f.active),
                short: r2(f.shortTerm),
                long: r2(f.longTerm),
                total: r2((f.active || 0) + (f.shortTerm || 0) + (f.longTerm || 0))
            }))
            .sort((a, b) => b.total - a.total);

        const head = `<thead><tr>
            <th>Flavor</th><th>Pan</th><th>Case</th><th>Short</th><th>Long</th><th>Total</th>
        </tr></thead>`;
        const body = rows.map(r => `
            <tr class="${r.pan && r.active <= SWAP_THRESHOLD + EPS ? 'low' : ''}">
                <td class="l">${esc(r.name)}</td>
                <td>${r.pan || '—'}</td>
                <td>${r.active || '—'}</td>
                <td>${r.short || '—'}</td>
                <td>${r.long || '—'}</td>
                <td><strong>${r.total || '—'}</strong></td>
            </tr>`).join('');
        document.getElementById('stat-table').innerHTML = head + `<tbody>${body}</tbody>`;
    }

    // ----- Swap recommendations + queue -----------------------------------
    function renderRecos() {
        const wrap = document.getElementById('swap-recos');
        const low = casePans().filter(f => (f.active || 0) <= SWAP_THRESHOLD + EPS)
            .sort((a, b) => (a.active || 0) - (b.active || 0));
        if (!low.length) {
            wrap.innerHTML = `<h3>Recommendations</h3><p class="g-empty-note">All case pans are above ${SWAP_THRESHOLD}. 👍</p>`;
            return;
        }
        const avail = flavors.filter(f => (f.shortTerm || 0) > EPS || (f.longTerm || 0) > EPS);
        const opts = avail.map(f =>
            `<option value="${f.id}">${esc(f.name)} (S:${r2(f.shortTerm)} L:${r2(f.longTerm)})</option>`).join('');

        wrap.innerHTML = `<h3>Recommendations</h3>` + low.map(f => {
            const queued = queue.find(q => q.pan === f.casePan);
            return `
            <div class="g-reco">
                <div class="g-reco-head">
                    <strong>Pan ${f.casePan}</strong> · ${esc(f.name)} is low
                    <span class="g-reco-amt">${r2(f.active)} pan</span>
                </div>
                ${queued
                    ? `<div class="g-reco-queued">Queued: ${esc(queued.name)} → Pan ${f.casePan}</div>`
                    : `<div class="g-reco-pick">
                          <select data-pan="${f.casePan}" class="g-reco-select">
                             <option value="">Pick replacement…</option>${opts}
                          </select>
                          <button type="button" class="g-reco-add" data-pan="${f.casePan}">Queue swap</button>
                       </div>`}
            </div>`;
        }).join('');

        wrap.querySelectorAll('.g-reco-add').forEach(b => b.addEventListener('click', () => {
            const pan = Number(b.dataset.pan);
            const sel = wrap.querySelector(`.g-reco-select[data-pan="${pan}"]`);
            if (!sel || !sel.value) { status('Pick a replacement flavor first.'); return; }
            addToQueue(pan, sel.value);
        }));
    }

    function renderQueue() {
        const wrap = document.getElementById('swap-queue');
        if (!wrap) return;
        if (!queue.length) {
            wrap.innerHTML = `<h3>Swap Queue</h3><p class="g-empty-note">Queue is empty.</p>`;
            return;
        }
        wrap.innerHTML = `<h3>Swap Queue</h3>` + queue.map((q, i) => `
            <div class="g-qitem">
                <span><strong>${esc(q.name)}</strong> → Pan ${q.pan}</span>
                <span class="g-qitem-actions">
                    <button type="button" class="g-q-exec" data-i="${i}">Execute</button>
                    <button type="button" class="g-q-del" data-i="${i}">Remove</button>
                </span>
            </div>`).join('');
        wrap.querySelectorAll('.g-q-exec').forEach(b =>
            b.addEventListener('click', () => executeSwap(Number(b.dataset.i))));
        wrap.querySelectorAll('.g-q-del').forEach(b =>
            b.addEventListener('click', () => removeFromQueue(Number(b.dataset.i))));
    }

    async function addToQueue(pan, flavorId) {
        const f = byId(flavorId);
        if (!f) return;
        const next = queue.filter(q => q.pan !== pan);
        next.push({ pan, flavorId, name: f.name });
        await queueDocRef().set({ queue: next }, { merge: true });
        status(`Queued ${f.name} → Pan ${pan}.`, true);
    }

    async function removeFromQueue(i) {
        const next = queue.slice();
        next.splice(i, 1);
        await queueDocRef().set({ queue: next }, { merge: true });
    }

    /* Pull one whole pan of the queued flavor out of a freezer (short-term
     * preferred) and drop it into the target case slot. The outgoing flavor's
     * remaining amount is consumed (it was already low). */
    async function executeSwap(i) {
        const q = queue[i];
        if (!q) return;
        const incoming = byId(q.flavorId);
        if (!incoming) { status('Replacement flavor no longer exists.'); return; }

        const source = (incoming.shortTerm || 0) > EPS ? 'shortTerm'
            : (incoming.longTerm || 0) > EPS ? 'longTerm' : null;
        if (!source) { status(`${incoming.name} has no pans in either freezer.`); return; }

        const take = Math.min(1, r2(incoming[source]));
        const outgoing = flavors.find(f => f.casePan === q.pan);

        const batch = db.batch();
        if (outgoing && outgoing.id !== incoming.id) {
            batch.update(db.collection('gelatoInventory').doc(outgoing.id),
                { active: 0, casePan: null, updatedAt: stamp() });
        }
        batch.update(db.collection('gelatoInventory').doc(incoming.id), {
            [source]: r2((incoming[source] || 0) - take),
            active: take, casePan: q.pan, updatedAt: stamp()
        });
        await batch.commit();

        const next = queue.slice();
        next.splice(i, 1);
        await queueDocRef().set({ queue: next }, { merge: true });
        status(`Swapped ${incoming.name} into Pan ${q.pan}.`, true);
    }

    // ----- Case slot actions ----------------------------------------------
    async function serve(id, amount) {
        const f = byId(id);
        if (!f) return;
        const next = Math.max(0, r2((f.active || 0) - amount));
        const update = { active: next, updatedAt: stamp() };
        if (next <= EPS) update.casePan = null;
        await db.collection('gelatoInventory').doc(id).update(update);
    }

    async function emptyPan(id) {
        const f = byId(id);
        if (!f) return;
        if (!confirm(`Empty Pan ${f.casePan} (${f.name})? The remaining ${r2(f.active)} pan will be marked used.`)) return;
        await db.collection('gelatoInventory').doc(id).update({ active: 0, casePan: null, updatedAt: stamp() });
    }

    function assignToPan(pan) {
        const choices = flavors.filter(f => !f.casePan &&
            ((f.shortTerm || 0) > EPS || (f.longTerm || 0) > EPS));
        if (!choices.length) {
            status('No flavors with freezer stock are available. Add stock via Transfer first.');
            return;
        }
        const list = choices.map((f, i) =>
            `${i + 1}. ${f.name} (S:${r2(f.shortTerm)} L:${r2(f.longTerm)})`).join('\n');
        const pick = prompt(`Assign which flavor to Pan ${pan}? Enter a number:\n\n${list}`);
        const idx = Number(pick) - 1;
        if (isNaN(idx) || idx < 0 || idx >= choices.length) return;
        const f = choices[idx];
        const source = (f.shortTerm || 0) > EPS ? 'shortTerm' : 'longTerm';
        const take = Math.min(1, r2(f[source]));
        db.collection('gelatoInventory').doc(f.id).update({
            [source]: r2((f[source] || 0) - take),
            active: take, casePan: pan, updatedAt: stamp()
        }).then(() => status(`${f.name} assigned to Pan ${pan}.`, true));
    }

    // ----- Transfer form ---------------------------------------------------
    function renderTransferFlavors() {
        const sel = document.getElementById('t-flavor');
        const prev = sel.value;
        sel.innerHTML = flavors.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
        if (prev && flavors.some(f => f.id === prev)) sel.value = prev;
    }

    function refreshTransferHint() {
        const f = byId(document.getElementById('t-flavor').value);
        const from = document.getElementById('t-from').value;
        const to = document.getElementById('t-to').value;
        const hint = document.getElementById('t-hint');
        if (!f) { hint.textContent = ''; return; }
        const have = from === 'active' ? (f.active || 0) : (f[from] || 0);
        let msg = `${f.name}: holds ${r2(have)} in ${LOCATION_LABELS[from]}.`;
        if (to === 'active') msg += ` Case pans cap at 1.0 each.`;
        if (to === 'shortTerm') msg += ` Short-term free: ${r2(SHORT_CAP - sumLoc('shortTerm'))} pans.`;
        if (to === 'longTerm') msg += ` Long-term free: ${r2(LONG_CAP - sumLoc('longTerm'))} pans.`;
        hint.textContent = msg;
    }

    async function onTransfer(e) {
        e.preventDefault();
        const f = byId(document.getElementById('t-flavor').value);
        const from = document.getElementById('t-from').value;
        const to = document.getElementById('t-to').value;
        const amount = r2(document.getElementById('t-amount').value);

        if (!f) return;
        if (amount <= 0) { status('Amount must be greater than 0.'); return; }
        if (from === to) { status('Pick two different locations.'); return; }

        const have = from === 'active' ? (f.active || 0) : (f[from] || 0);
        if (amount > have + EPS) { status(`Only ${r2(have)} pan(s) available in ${LOCATION_LABELS[from]}.`); return; }

        const update = { updatedAt: stamp() };

        if (to === 'use') {
            // consume from source, nothing to add
        } else if (to === 'active') {
            if (!f.casePan && casePans().length >= CASE_SLOTS) { status('The case is full (18 pans).'); return; }
            const newActive = r2((f.active || 0) + amount);
            if (newActive > 1 + EPS) { status(`A case pan holds max 1.0. ${f.name} would reach ${newActive}.`); return; }
            update.active = newActive;
            if (!f.casePan) update.casePan = firstFreePan();
        } else {
            const cap = to === 'shortTerm' ? SHORT_CAP : LONG_CAP;
            const room = cap - sumLoc(to);
            if (amount > room + EPS) { status(`${LOCATION_LABELS[to]} freezer only has room for ${r2(room)} more pans.`); return; }
            update[to] = r2((f[to] || 0) + amount);
        }

        if (from === 'active') {
            const left = r2((f.active || 0) - amount);
            update.active = (to === 'active') ? update.active : left;
            if (left <= EPS && to !== 'active') update.casePan = null;
        } else {
            update[from] = r2((f[from] || 0) - amount);
        }

        try {
            await db.collection('gelatoInventory').doc(f.id).update(update);
            status(`Moved ${amount} pan(s) of ${f.name}: ${LOCATION_LABELS[from]} → ${LOCATION_LABELS[to]}.`, true);
        } catch (err) {
            console.error('transfer failed', err);
            status('Transfer failed — see console.');
        }
    }

    function firstFreePan() {
        const used = new Set(casePans().map(f => f.casePan));
        for (let p = 1; p <= CASE_SLOTS; p++) if (!used.has(p)) return p;
        return null;
    }

    // ----- helpers ---------------------------------------------------------
    const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
})();
