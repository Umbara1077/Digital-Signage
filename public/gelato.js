/* ===========================================================================
 * Gelato Inventory Management
 * ---------------------------------------------------------------------------
 * Self-contained inventory tool for the gelato flavors that live on the menu
 * (the `menuItems` collection). Tracks each flavor across three locations:
 *
 *   - active     : the display case. 18 single-pan slots, each filled 0.0..1.0
 *   - shortTerm  : short-term freezer, up to 21 pans total
 *   - longTerm   : long-term freezer, up to 54 pans total
 *
 * Only flavors currently on the menu are shown. Data lives in its own
 * `gelatoInventory` collection (doc id == menuItems id) plus a
 * `gelatoSettings/queue` doc for the swap queue, so nothing here writes to any
 * pre-existing collection and it can't interfere with the rest of the app.
 * ========================================================================= */

(function () {
    'use strict';

    // ----- Constants -------------------------------------------------------
    let CASE_SLOTS = Number(localStorage.getItem('gelatoCaseSize')) || 18;
    const SHORT_CAP = 21;      // pans the short-term freezer holds
    const LONG_CAP = 54;       // pans the long-term freezer holds
    const SWAP_THRESHOLD = 0.3; // recommend a swap at/below this case fill
    const EPS = 1e-6;

    // 0.1 .. 0.9 options for the per-pan "use" dropdown
    const USE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map(n => `<option value="0.${n}">0.${n}</option>`).join('');

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
    let pendingList = [];      // pendingItems docs (off-menu backup flavors)
    let flavors = [];          // visible flavors (on menu OR has stock), sorted
    let queue = [];            // [{ pan, flavorId, name }]
    let statMode = false;
    const queueDocRef = () => db.collection('gelatoSettings').doc('queue');

    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;     // pan amounts -> 2dp
    const byId = id => inventory.find(f => f.id === id);
    const onMenu = f => !menuIds || menuIds.has(f.id);
    const hasStock = f => (f.active || 0) > EPS || (f.shortTerm || 0) > EPS || (f.longTerm || 0) > EPS;
    const doc = id => db.collection('gelatoInventory').doc(id);

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

        db.collection('pendingItems').onSnapshot(snap => {
            pendingList = snap.docs.map(d => ({ id: d.id, ...d.data() }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            renderStockFlavors();
            refreshStockHint();
        }, err => console.error('pendingItems snapshot error', err));

        queueDocRef().onSnapshot(d => {
            queue = (d.exists && Array.isArray(d.data().queue)) ? d.data().queue : [];
            renderAll();
        }, err => console.error('queue snapshot error', err));
    }

    /* Zero out all stock/case data for every gelatoInventory doc and clear the
     * swap queue. Flavor identity fields (name, images) are never touched. */
    async function resetInventory() {
        const count = inventory.length;
        if (!count) { status('No inventory docs found.'); return; }
        if (!confirm(
            `Reset inventory?\n\nThis will zero ALL stock (active, shortTerm, longTerm) and clear the case for ${count} flavor(s).\n\nFlavor names and images are NOT affected. This cannot be undone.`
        )) return;

        try {
            status('Resetting inventory…');
            const batches = [];
            let batch = db.batch();
            let ops = 0;
            inventory.forEach(f => {
                batch.update(doc(f.id), {
                    active: 0, casePan: null,
                    shortTerm: 0, longTerm: 0,
                    updatedAt: stamp()
                });
                ops++;
                if (ops === 499) { batches.push(batch); batch = db.batch(); ops = 0; }
            });
            if (ops) batches.push(batch);
            await Promise.all(batches.map(b => b.commit()));
            await queueDocRef().set({ queue: [] });
            status('Inventory reset. All stock zeroed, case cleared.', true);
        } catch (e) {
            console.error('resetInventory failed', e);
            status('Reset failed — see console.');
        }
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
            menuSnap.forEach(d => {
                if (existing.has(d.id)) return;
                const m = d.data();
                batch.set(doc(d.id), {
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

    // ----- UI wiring -------------------------------------------------------
    function wireUi() {
        document.getElementById('sync-flavors').addEventListener('click', async () => {
            status('Syncing flavors from menu…');
            await seedMissingFromMenu();
            status('Synced.', true);
        });
        document.getElementById('reset-inventory').addEventListener('click', resetInventory);
        document.getElementById('mode-visual').addEventListener('click', () => setMode(false));
        document.getElementById('mode-stats').addEventListener('click', () => setMode(true));

        document.getElementById('size-18').addEventListener('click', () => setCaseSize(18));
        document.getElementById('size-12').addEventListener('click', () => setCaseSize(12));
        applyCaseSize();

        document.getElementById('add-to-case').addEventListener('click', () => {
            const pan = firstFreePan();
            if (!pan) { status('The case is full (18 pans).'); return; }
            openAssignModal(pan);
        });
        document.getElementById('close-case').addEventListener('click', closeCase);

        document.getElementById('transferForm').addEventListener('submit', onTransfer);
        document.getElementById('t-from').addEventListener('change', refreshTransferHint);
        document.getElementById('t-to').addEventListener('change', refreshTransferHint);
        document.getElementById('t-flavor').addEventListener('change', refreshTransferHint);

        document.getElementById('addStockForm').addEventListener('submit', onAddStock);
        document.getElementById('as-loc').addEventListener('change', refreshStockHint);
        document.getElementById('as-flavor').addEventListener('change', refreshStockHint);
        document.getElementById('as-source').addEventListener('change', () => {
            renderStockFlavors();
            refreshStockHint();
        });

        document.getElementById('stageForm').addEventListener('submit', onStage);

        document.getElementById('g-modal-x').addEventListener('click', closeModal);
        document.getElementById('g-modal').addEventListener('click', e => {
            if (e.target.id === 'g-modal') closeModal();
        });
    }

    function setCaseSize(n) {
        CASE_SLOTS = n;
        localStorage.setItem('gelatoCaseSize', n);
        applyCaseSize();
        renderAll();
    }

    function applyCaseSize() {
        document.getElementById('size-18').classList.toggle('active', CASE_SLOTS === 18);
        document.getElementById('size-12').classList.toggle('active', CASE_SLOTS === 12);
        const wrap = document.getElementById('case-visual');
        wrap.classList.toggle('g-case-12', CASE_SLOTS === 12);
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
        if (autoClear) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2800);
    }

    // ----- Derived helpers (menu flavors only) -----------------------------
    const withAmt = loc => flavors.filter(f => (f[loc] || 0) > EPS)
        .sort((a, b) => (b[loc] || 0) - (a[loc] || 0));
    const sumLoc = loc => r2(flavors.reduce((s, f) => s + (f[loc] || 0), 0));
    const casePans = () => flavors.filter(f => f.casePan);
    const storageStock = f => r2((f.shortTerm || 0) + (f.longTerm || 0));

    // ----- Rendering -------------------------------------------------------
    function renderAll() {
        // show menu flavors always, plus any off-menu flavor that has stock
        flavors = inventory.filter(f => onMenu(f) || hasStock(f))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        renderCaps();
        renderTransferFlavors();
        renderStockFlavors();
        if (statMode) {
            renderStatsPanel();
        } else {
            renderCase();
            renderFreezer('short', 'shortTerm', SHORT_CAP);
            renderFreezer('long', 'longTerm', LONG_CAP);
        }
        renderRecos();
        renderStageForm();
        renderQueueList();
        refreshTransferHint();
        refreshStockHint();
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
                        <div class="g-gelato" style="height:${pct}%"><div class="g-gelato-top"></div></div>
                        <div class="g-scoop" ${swatch}></div>
                    </div>
                    <div class="g-pan-name" title="${esc(f.name)}">${esc(f.name)}</div>
                    <div class="g-pan-meter"><span style="width:${pct}%"></span></div>
                    <div class="g-pan-amt">${r2(f.active)} pan · ${pct}%</div>
                    <div class="g-pan-use">
                        <select class="g-use-amt" data-id="${f.id}" aria-label="Amount to use">
                            ${USE_OPTIONS}
                        </select>
                        <button type="button" data-act="use" data-id="${f.id}">Use</button>
                    </div>
                    <button type="button" class="g-pan-empty" data-act="empty" data-id="${f.id}">Empty pan</button>
                </div>`;
            } else {
                html += `
                <div class="g-pan empty">
                    <div class="g-pan-head"><span class="g-pan-num">PAN ${pan}</span></div>
                    <div class="g-tub empty"><span>empty</span></div>
                    <button type="button" class="g-assign-btn" data-pan="${pan}">+ Add flavor</button>
                </div>`;
            }
        }
        wrap.innerHTML = html;

        wrap.querySelectorAll('[data-act="use"]').forEach(b => b.addEventListener('click', () => {
            const input = wrap.querySelector(`.g-use-amt[data-id="${b.dataset.id}"]`);
            serve(b.dataset.id, parseFloat(input.value));
        }));
        wrap.querySelectorAll('[data-act="empty"]').forEach(b =>
            b.addEventListener('click', () => emptyPan(b.dataset.id)));
        wrap.querySelectorAll('.g-assign-btn').forEach(b =>
            b.addEventListener('click', () => openAssignModal(Number(b.dataset.pan))));
    }

    function freezerTone(amt) {
        if (amt >= 3 - EPS) return 'green';
        if (amt >= 2 - EPS) return 'yellow';
        return 'red';
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
            const amt = f[loc] || 0;
            const tone = freezerTone(amt);
            const whole = Math.floor(amt + EPS);
            const frac = r2(amt - whole);
            let icons = '';
            for (let i = 0; i < whole; i++) icons += `<span class="g-tub-icon ${tone}"></span>`;
            if (frac > EPS) icons += `<span class="g-tub-icon ${tone} part" style="--frac:${frac}"></span>`;
            const swatch = f.gelatoImage ? `style="background-image:url('${f.gelatoImage}')"` : '';
            html += `
            <div class="g-frz-tub tone-${tone}">
                <div class="g-frz-swatch" ${swatch}></div>
                <div class="g-frz-info">
                    <div class="g-frz-name">${esc(f.name)}</div>
                    <div class="g-tub-icons">${icons}</div>
                    <div class="g-frz-amt"><span class="g-dot ${tone}"></span>${r2(amt)} pans</div>
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

        bars('stat-case', casePans().map(f => ({ name: `P${f.casePan} ${f.name}`, val: f.active || 0 })), 1, true);
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
        const rows = flavors.map(f => ({
            name: f.name, pan: f.casePan || null,
            active: r2(f.active), short: r2(f.shortTerm), long: r2(f.longTerm),
            total: r2((f.active || 0) + (f.shortTerm || 0) + (f.longTerm || 0))
        })).sort((a, b) => b.total - a.total);

        const head = `<thead><tr>
            <th>Flavor</th><th>Pan</th><th>Case</th><th>Short</th><th>Long</th><th>Total</th>
        </tr></thead>`;
        // colour storage cells with the same green/yellow/red tiers as the freezers
        const toneCell = v => v > EPS ? `<td class="tone-${freezerTone(v)}">${v}</td>` : `<td>—</td>`;
        const body = rows.map(r => `
            <tr class="${r.pan && r.active <= SWAP_THRESHOLD + EPS ? 'low' : ''}">
                <td class="l">${esc(r.name)}</td>
                <td>${r.pan || '—'}</td>
                <td>${r.active || '—'}</td>
                ${toneCell(r.short)}
                ${toneCell(r.long)}
                <td><strong>${r.total || '—'}</strong></td>
            </tr>`).join('');
        document.getElementById('stat-table').innerHTML = head + `<tbody>${body}</tbody>`;
    }

    // ----- Recommendations (red pans) -------------------------------------
    function renderRecos() {
        const wrap = document.getElementById('swap-recos');
        const low = casePans().filter(f => (f.active || 0) <= SWAP_THRESHOLD + EPS)
            .sort((a, b) => (a.active || 0) - (b.active || 0));
        if (!low.length) {
            wrap.innerHTML = `<h3>Recommendations</h3><p class="g-empty-note">All case pans are above ${SWAP_THRESHOLD}. 👍</p>`;
            return;
        }
        wrap.innerHTML = `<h3>Recommendations</h3>` + low.map(f => {
            const queued = queue.find(q => q.pan === f.casePan);
            return `
            <div class="g-reco">
                <div class="g-reco-head">
                    <strong>Pan ${f.casePan}</strong> · ${esc(f.name)} is low
                    <span class="g-reco-amt">${r2(f.active)} pan</span>
                </div>
                ${queued
                    ? `<div class="g-reco-queued">✔ Staged: ${esc(queued.name)} → Pan ${f.casePan} (ready below)</div>`
                    : `<div class="g-reco-note">Stage a replacement in the Swap Queue panel →</div>`}
            </div>`;
        }).join('');
    }

    // ----- Stage form + queue ---------------------------------------------
    function renderStageForm() {
        const panSel = document.getElementById('stage-pan');
        const flavSel = document.getElementById('stage-flavor');
        const prevPan = panSel.value, prevFlav = flavSel.value;

        const pans = casePans().sort((a, b) => a.casePan - b.casePan);
        panSel.innerHTML = pans.length
            ? pans.map(f => `<option value="${f.casePan}">Pan ${f.casePan} — ${esc(f.name)} (${r2(f.active)})</option>`).join('')
            : `<option value="">No pans in the case yet</option>`;

        const avail = flavors.filter(f => storageStock(f) > EPS);
        flavSel.innerHTML = avail.length
            ? avail.map(f => `<option value="${f.id}">${esc(f.name)} (S:${r2(f.shortTerm)} L:${r2(f.longTerm)})</option>`).join('')
            : `<option value="">No freezer stock — add some first</option>`;

        if (prevPan && [...panSel.options].some(o => o.value === prevPan)) panSel.value = prevPan;
        if (prevFlav && [...flavSel.options].some(o => o.value === prevFlav)) flavSel.value = prevFlav;
    }

    async function onStage(e) {
        e.preventDefault();
        const pan = Number(document.getElementById('stage-pan').value);
        const flavorId = document.getElementById('stage-flavor').value;
        if (!pan) { status('Pick a pan to stage.'); return; }
        if (!flavorId) { status('Pick a replacement flavor (needs freezer stock).'); return; }
        await addToQueue(pan, flavorId);
    }

    function renderQueueList() {
        const wrap = document.getElementById('swap-queue-list');
        if (!wrap) return;
        if (!queue.length) {
            wrap.innerHTML = `<p class="g-empty-note">Nothing staged yet.</p>`;
            return;
        }
        const sorted = queue.slice().sort((a, b) => a.pan - b.pan);
        wrap.innerHTML = sorted.map(q => {
            const i = queue.indexOf(q);
            const target = flavors.find(f => f.casePan === q.pan);
            const lvl = target ? (target.active || 0) : null;
            const ready = !target || lvl <= SWAP_THRESHOLD + EPS;
            const state = !target
                ? `<span class="g-q-state ready">PAN EMPTY · READY</span>`
                : ready
                    ? `<span class="g-q-state ready">READY · pan at ${r2(lvl)}</span>`
                    : `<span class="g-q-state wait">staged · pan at ${r2(lvl)}</span>`;
            return `
            <div class="g-qitem ${ready ? 'is-ready' : ''}">
                <div class="g-qitem-main">
                    <div><strong>${esc(q.name)}</strong> → Pan ${q.pan}</div>
                    ${state}
                </div>
                <span class="g-qitem-actions">
                    <button type="button" class="g-q-exec" data-i="${i}" ${ready ? '' : 'disabled title="Waiting until the pan is in the red"'}>Execute</button>
                    <button type="button" class="g-q-del" data-i="${i}">Remove</button>
                </span>
            </div>`;
        }).join('');
        wrap.querySelectorAll('.g-q-exec').forEach(b =>
            b.addEventListener('click', () => executeSwap(Number(b.dataset.i))));
        wrap.querySelectorAll('.g-q-del').forEach(b =>
            b.addEventListener('click', () => removeFromQueue(Number(b.dataset.i))));
    }

    async function addToQueue(pan, flavorId) {
        const f = byId(flavorId);
        if (!f) return;
        const next = queue.filter(q => q.pan !== pan); // one staged swap per pan
        next.push({ pan, flavorId, name: f.name });
        await queueDocRef().set({ queue: next }, { merge: true });
        status(`Staged ${f.name} → Pan ${pan}.`, true);
    }

    async function removeFromQueue(i) {
        const next = queue.slice();
        next.splice(i, 1);
        await queueDocRef().set({ queue: next }, { merge: true });
    }

    /* Pull one whole pan of the staged flavor out of a freezer (short-term
     * preferred) and drop it into the target case slot, replacing whatever was
     * there. */
    async function executeSwap(i) {
        const q = queue[i];
        if (!q) return;
        const incoming = byId(q.flavorId);
        if (!incoming) { status('Replacement flavor no longer exists.'); return; }

        const source = (incoming.shortTerm || 0) > EPS ? 'shortTerm'
            : (incoming.longTerm || 0) > EPS ? 'longTerm' : null;
        if (!source) { status(`${incoming.name} has no pans in either freezer.`); return; }

        const stock = r2(incoming[source]);
        const frac = r2(stock % 1);
        const take = frac > EPS ? frac : Math.min(1, stock);
        const outgoing = flavors.find(f => f.casePan === q.pan);

        const batch = db.batch();
        if (outgoing && outgoing.id !== incoming.id) {
            batch.update(doc(outgoing.id), { active: 0, casePan: null, updatedAt: stamp() });
        }
        batch.update(doc(incoming.id), {
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
        amount = r2(amount);
        if (!(amount > 0)) { status('Enter an amount greater than 0 to use.'); return; }
        const have = f.active || 0;
        if (amount > have + EPS) { status(`Pan only holds ${r2(have)} — can't use ${amount}.`); return; }
        const next = Math.max(0, r2(have - amount));
        const update = { active: next, updatedAt: stamp() };
        if (next <= EPS) update.casePan = null;
        await doc(id).update(update);
        status(`Used ${amount} of ${f.name}. ${next <= EPS ? 'Pan emptied.' : r2(next) + ' left.'}`, true);
    }

    async function emptyPan(id) {
        const f = byId(id);
        if (!f) return;
        if (!confirm(`Empty Pan ${f.casePan} (${f.name})? The remaining ${r2(f.active)} pan will be marked used.`)) return;
        await doc(id).update({ active: 0, casePan: null, updatedAt: stamp() });
    }

    /* Move every case pan's remaining gelato back into storage (short-term
     * first, overflow to long-term) and clear the case for the night. */
    async function closeCase() {
        const inCase = casePans();
        if (!inCase.length) { status('The case is already empty.'); return; }
        if (!confirm(`Close the case for the night? This moves all ${inCase.length} pan(s) back into storage.`)) return;

        let shortRoom = r2(SHORT_CAP - sumLoc('shortTerm'));
        let longRoom = r2(LONG_CAP - sumLoc('longTerm'));
        const batch = db.batch();
        const stuck = [];

        inCase.forEach(f => {
            let amt = r2(f.active || 0);
            const toShort = Math.min(amt, Math.max(0, shortRoom));
            shortRoom = r2(shortRoom - toShort); amt = r2(amt - toShort);
            const toLong = Math.min(amt, Math.max(0, longRoom));
            longRoom = r2(longRoom - toLong); amt = r2(amt - toLong);
            if (amt > EPS) stuck.push(`${f.name} (${amt})`);
            batch.update(doc(f.id), {
                shortTerm: r2((f.shortTerm || 0) + toShort),
                longTerm: r2((f.longTerm || 0) + toLong),
                active: amt > EPS ? amt : 0,
                casePan: amt > EPS ? f.casePan : null,
                updatedAt: stamp()
            });
        });
        await batch.commit();
        if (stuck.length) status(`Closed, but storage was full — left in case: ${stuck.join(', ')}.`);
        else status('Case closed for the night — everything moved to storage. 🌙', true);
    }

    // ----- Assign modal (GUI) ---------------------------------------------
    function openAssignModal(pan) {
        const choices = flavors.filter(f => !f.casePan && storageStock(f) > EPS)
            .sort((a, b) => storageStock(b) - storageStock(a));
        const body = document.getElementById('g-modal-body');
        document.getElementById('g-modal-title').textContent = `Add a flavor to Pan ${pan}`;

        if (!choices.length) {
            body.innerHTML = `<p class="g-empty-note">No flavors have freezer stock yet.
                Use <strong>Add Stock</strong> below to bring some in, then assign it here.</p>`;
            showModal();
            return;
        }
        body.innerHTML = `
            <label class="g-modal-label">Flavor (from storage)</label>
            <select id="assign-flavor" class="g-modal-select">
                ${choices.map(f => `<option value="${f.id}">${esc(f.name)} — S:${r2(f.shortTerm)} L:${r2(f.longTerm)}</option>`).join('')}
            </select>
            <label class="g-modal-label">Fill amount (pans, max 1.0)</label>
            <input type="number" id="assign-amt" class="g-modal-input" list="amt-presets" value="${defaultAssignAmt(choices[0])}" min="0.1" max="1" step="0.1">
            <p class="g-modal-hint" id="assign-hint"></p>
            <div class="g-modal-actions">
                <button type="button" class="g-modal-cancel" id="assign-cancel">Cancel</button>
                <button type="button" class="g-modal-go" id="assign-go">Add to Pan ${pan}</button>
            </div>`;

        const sel = document.getElementById('assign-flavor');
        const amt = document.getElementById('assign-amt');
        const hint = document.getElementById('assign-hint');
        const updateHint = () => {
            const f = byId(sel.value);
            if (!f) { hint.textContent = ''; return; }
            hint.textContent = `${f.name}: ${storageStock(f)} pan(s) in storage. Pulls from short-term first.`;
            amt.value = defaultAssignAmt(f);
        };
        sel.addEventListener('change', updateHint);
        updateHint();

        document.getElementById('assign-cancel').addEventListener('click', closeModal);
        document.getElementById('assign-go').addEventListener('click', () =>
            doAssign(pan, sel.value, parseFloat(amt.value)));
        showModal();
    }

    async function doAssign(pan, flavorId, amount) {
        const f = byId(flavorId);
        if (!f) return;
        amount = r2(amount);
        if (!(amount > 0) || amount > 1 + EPS) { status('Fill amount must be between 0.1 and 1.0.'); return; }
        if (casePans().length >= CASE_SLOTS) { status('The case is full (18 pans).'); return; }
        const stock = storageStock(f);
        if (amount > stock + EPS) { status(`Only ${stock} pan(s) of ${f.name} in storage.`); return; }

        let need = amount;
        const fromShort = Math.min(f.shortTerm || 0, need); need = r2(need - fromShort);
        const fromLong = Math.min(f.longTerm || 0, need); need = r2(need - fromLong);

        await doc(f.id).update({
            shortTerm: r2((f.shortTerm || 0) - fromShort),
            longTerm: r2((f.longTerm || 0) - fromLong),
            active: amount,
            casePan: pan,
            updatedAt: stamp()
        });
        closeModal();
        status(`${f.name} added to Pan ${pan} at ${amount}.`, true);
    }

    function showModal() { document.getElementById('g-modal').hidden = false; }
    function closeModal() { document.getElementById('g-modal').hidden = true; }

    // ----- Add stock (production intake) ----------------------------------
    const stockSource = () => document.getElementById('as-source').value;

    function renderStockFlavors() {
        const sel = document.getElementById('as-flavor');
        const prev = sel.value;
        let opts;
        if (stockSource() === 'pending') {
            opts = pendingList.length
                ? pendingList.map(p => `<option value="${p.id}">${esc(p.name)}</option>`)
                : [`<option value="">No pending flavors</option>`];
        } else {
            const active = flavors.filter(onMenu);
            opts = active.length
                ? active.map(f => `<option value="${f.id}">${esc(f.name)}</option>`)
                : [`<option value="">No active flavors</option>`];
        }
        sel.innerHTML = opts.join('');
        if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    }

    function refreshStockHint() {
        const loc = document.getElementById('as-loc').value;
        const cap = loc === 'shortTerm' ? SHORT_CAP : LONG_CAP;
        const hint = document.getElementById('as-hint');
        const val = document.getElementById('as-flavor').value;

        let name, cur = 0;
        if (stockSource() === 'pending') {
            const p = pendingList.find(x => x.id === val);
            if (!p) { hint.textContent = ''; return; }
            name = p.name;
            const ex = byId(p.id);
            cur = ex ? (ex[loc] || 0) : 0;
        } else {
            const f = byId(val);
            if (!f) { hint.textContent = ''; return; }
            name = f.name;
            cur = f[loc] || 0;
        }
        hint.textContent = `${name}: ${r2(cur)} in ${LOCATION_LABELS[loc]}. Room for ${r2(cap - sumLoc(loc))} more pans.`;
    }

    async function onAddStock(e) {
        e.preventDefault();
        const loc = document.getElementById('as-loc').value;
        const amount = r2(document.getElementById('as-amt').value);
        const val = document.getElementById('as-flavor').value;
        if (!val) { status('Pick a flavor.'); return; }
        if (!(amount > 0)) { status('Enter a quantity greater than 0.'); return; }
        const cap = loc === 'shortTerm' ? SHORT_CAP : LONG_CAP;
        const room = r2(cap - sumLoc(loc));
        if (amount > room + EPS) { status(`${LOCATION_LABELS[loc]} only has room for ${room} more pans.`); return; }

        if (stockSource() === 'pending') {
            const p = pendingList.find(x => x.id === val);
            if (!p) { status('Pending flavor not found.'); return; }
            // inventory doc keyed by the pendingItems id; create it if it doesn't exist yet
            const base = byId(val) || {};
            await doc(val).set({
                name: base.name || p.name || '(unnamed)',
                gelatoImage: base.gelatoImage || p.gelatoImage || p.imageURL || '',
                imageURL: base.imageURL || p.imageURL || '',
                active: base.active || 0,
                casePan: base.casePan || null,
                shortTerm: loc === 'shortTerm' ? r2((base.shortTerm || 0) + amount) : (base.shortTerm || 0),
                longTerm: loc === 'longTerm' ? r2((base.longTerm || 0) + amount) : (base.longTerm || 0),
                updatedAt: stamp()
            }, { merge: true });
            status(`Added ${amount} pan(s) of ${p.name} (pending) to ${LOCATION_LABELS[loc]}.`, true);
        } else {
            const f = byId(val);
            if (!f) { status('Flavor not found.'); return; }
            await doc(f.id).update({ [loc]: r2((f[loc] || 0) + amount), updatedAt: stamp() });
            status(`Added ${amount} pan(s) of ${f.name} to ${LOCATION_LABELS[loc]}.`, true);
        }
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
            await doc(f.id).update(update);
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

    /* Default amount when pulling a flavor into the case: use the fractional
     * pan first (e.g. 0.3 of 1.3) so partial pans get cleared before whole ones. */
    function defaultAssignAmt(f) {
        if (!f) return 1;
        const total = r2((f.shortTerm || 0) + (f.longTerm || 0));
        const frac = r2(total % 1);
        return frac > EPS ? frac : Math.min(1, total);
    }

    const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
})();
