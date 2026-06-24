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
    const LONG_CAP = 42;       // pans the long-term freezer holds
    const SWAP_THRESHOLD = 0.5; // a pan is "red"/recommended for swap at/below this
    const EPS = 1e-6;

    // 0.1 .. 0.9 options for the per-pan "use" dropdown
    const USE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
        .map(n => `<option value="0.${n}">0.${n}</option>`).join('');

    // ----- Cost model (from "War Plan" sheet) ------------------------------
    // ~$0.035 / gram of gelato on hand.
    // Full pans weigh ~7000-8000 g; 7500 g average -> ~$262 per full pan.
    const PRICE_PER_GRAM = 0.035;
    const GRAMS_PER_PAN = 7500;
    const COST_PER_PAN = PRICE_PER_GRAM * GRAMS_PER_PAN;   // ≈ $255 / pan
    const money = n => '$' + (Math.round((n || 0) * 100) / 100)
        .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const grams = pans => Math.round((pans || 0) * GRAMS_PER_PAN);

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
    let menuFlavors = [];      // all menuItems docs, sorted by name (source of truth for active list)
    let pendingList = [];      // pendingItems docs (off-menu backup flavors)
    let flavors = [];          // visible flavors (on menu OR has stock), sorted
    let queue = [];            // [{ pan, flavorId, name }]
    let moves = [];            // recent move-history entries
    let autoStageLock = false; // guards auto-stage writes between queue snapshots
    let queueLoaded = false;   // true once the saved queue has loaded from the DB
    let usageToday = {};       // today's running usage totals (pans)
    let orderQueue = [];       // flavors flagged to make (production list)
    let statMode = false;
    const queueDocRef = () => db.collection('gelatoSettings').doc('queue');
    const snapshotDocRef = () => db.collection('gelatoSettings').doc('caseSnapshot');
    const orderDocRef = () => db.collection('gelatoSettings').doc('orderQueue');
    const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD (local)
    const usageDocRef = () => db.collection('gelatoUsage').doc(todayStr());

    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;     // pan amounts -> 2dp
    const onMenu = f => !menuIds || menuIds.has(f.id);
    const hasStock = f => (f.active || 0) > EPS || (f.shortTerm || 0) > EPS || (f.longTerm || 0) > EPS;
    const doc = id => db.collection('gelatoInventory').doc(id);

    // The live menu/pending doc is the source of truth for a flavor's name &
    // image. gelatoInventory only stores stock, so its name/image copy can go
    // stale (e.g. after admin "Replace Menu Item" reuses a doc id). Always
    // overlay the live name/image, matched by id.
    const liveMeta = id => menuFlavors.find(x => x.id === id) || pendingList.find(x => x.id === id) || null;
    const nameById = id => { const m = liveMeta(id); return m ? (m.name || '') : ''; };
    function enrich(f) {
        if (!f) return f;
        const m = liveMeta(f.id);
        if (!m) return f;
        return {
            ...f,
            name: m.name || f.name,
            gelatoImage: m.gelatoImage || m.imageURL || f.gelatoImage || '',
            imageURL: m.imageURL || f.imageURL || ''
        };
    }
    const byId = id => enrich(inventory.find(f => f.id === id));

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
            menuFlavors = snap.docs
                .map(d => ({ ...d.data(), id: d.id }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            renderAll();
        }, err => console.error('menuItems snapshot error', err));

        db.collection('gelatoInventory').onSnapshot(snap => {
            inventory = snap.docs.map(d => ({ ...d.data(), id: d.id }));
            renderAll();
        }, err => console.error('inventory snapshot error', err));

        db.collection('pendingItems').onSnapshot(snap => {
            pendingList = snap.docs.map(d => ({ ...d.data(), id: d.id }))
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            renderStockFlavors();
            refreshStockHint();
        }, err => console.error('pendingItems snapshot error', err));

        queueDocRef().onSnapshot(d => {
            queue = (d.exists && Array.isArray(d.data().queue)) ? d.data().queue : [];
            queueLoaded = true;   // safe to auto-stage now that the saved queue is known
            autoStageLock = false;
            renderAll();
        }, err => console.error('queue snapshot error', err));

        db.collection('gelatoMoves').orderBy('at', 'desc').limit(60).onSnapshot(snap => {
            moves = snap.docs.map(d => ({ ...d.data(), id: d.id }));
            renderLog();
        }, err => console.error('moves snapshot error', err));

        usageDocRef().onSnapshot(d => {
            usageToday = d.exists ? d.data() : {};
            renderUsage();
        }, err => console.error('usage snapshot error', err));

        orderDocRef().onSnapshot(d => {
            orderQueue = (d.exists && Array.isArray(d.data().items)) ? d.data().items : [];
            renderOrderQueue();
            if (statMode) renderStatTable();
        }, err => console.error('order snapshot error', err));
    }

    /* Append a human-readable entry to the move-history log in the DB. */
    function logMove(type, text) {
        db.collection('gelatoMoves').add({ type, text, at: stamp() })
            .catch(err => console.error('logMove failed', err));
    }

    /* Accumulate today's case usage so it isn't lost when a pan is served down
     * or emptied. One doc per local day in `gelatoUsage`. */
    function addUsage(field, amount) {
        if (!(amount > 0)) return;
        usageDocRef().set({
            [field]: firebase.firestore.FieldValue.increment(r2(amount)),
            date: todayStr(), updatedAt: stamp()
        }, { merge: true }).catch(err => console.error('addUsage failed', err));
    }

    /* Zero today's running usage totals. Stock and the case are untouched. */
    async function resetUsage() {
        if (!confirm("Reset today's usage totals?\n\nThis clears the day's running \"used / total handled\" count. Stock and the case are NOT affected.")) return;
        try {
            await usageDocRef().set({ usedPans: 0, wastedPans: 0, date: todayStr(), updatedAt: stamp() }, { merge: true });
            logMove('reset', "Reset today's usage totals");
            status("Today's usage totals reset.", true);
        } catch (e) {
            console.error('resetUsage failed', e);
            status('Reset failed — see console.');
        }
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
            logMove('reset', `Reset inventory — zeroed all stock & cleared case for ${count} flavor(s)`);
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
        document.getElementById('save-snapshot').addEventListener('click', saveSnapshot);
        document.getElementById('reload-case').addEventListener('click', reloadCase);
        document.getElementById('reset-usage').addEventListener('click', resetUsage);

        document.getElementById('transferForm').addEventListener('submit', onTransfer);
        document.getElementById('merge-pans-btn').addEventListener('click', openMergeModal);
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

        document.getElementById('orderAddForm').addEventListener('submit', e => {
            e.preventDefault();
            addToOrder(document.getElementById('order-flavor').value);
        });
        document.getElementById('order-clear').addEventListener('click', clearOrder);

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
    // a freezer is divided into physical pan SLOTS: any partial pan still takes
    // a whole slot, so 2.8 pans of a flavor occupies 3 slots (1 + 1 + 0.8).
    const slotsOf = amt => (amt > EPS ? Math.ceil(amt - EPS) : 0);
    const slotsUsed = loc => flavors.reduce((s, f) => s + slotsOf(f[loc] || 0), 0);
    const slotsOpen = loc => (loc === 'shortTerm' ? SHORT_CAP : LONG_CAP) - slotsUsed(loc);
    /* Slots the freezer would use if a flavor's amount in `loc` changed to newAmt. */
    const slotsAfter = (loc, flavorId, newAmt) => {
        const f = byId(flavorId);
        return slotsUsed(loc) - slotsOf(f ? (f[loc] || 0) : 0) + slotsOf(newAmt);
    };
    const casePans = () => flavors.filter(f => f.casePan);
    const storageStock = f => r2((f.shortTerm || 0) + (f.longTerm || 0));
    // the case is only ever filled from SHORT-TERM storage
    const caseStock = f => r2(f.shortTerm || 0);

    /* Always render a flavor's picture from the live menu/pending doc (matched
     * by id) rather than the copy stored in gelatoInventory, so corrected menu
     * images show up and never get crossed with the wrong flavor. */
    function flavorImage(f) {
        const m = menuFlavors.find(x => x.id === f.id) || pendingList.find(x => x.id === f.id);
        return (m && (m.gelatoImage || m.imageURL)) || f.gelatoImage || f.imageURL || '';
    }

    // ----- Rendering -------------------------------------------------------
    function renderAll() {
        // show menu flavors always, plus any off-menu flavor that has stock,
        // with live name/image overlaid so stale stored copies never show
        flavors = inventory.filter(f => onMenu(f) || hasStock(f))
            .map(enrich)
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
        renderPricing();
        renderUsage();
        refreshTransferHint();
        refreshStockHint();
        autoStageLowPans();
    }

    // ----- Pricing / value overview ---------------------------------------
    const activePans = () => r2(casePans().reduce((s, f) => s + (f.active || 0), 0));

    function renderPricing() {
        const a = activePans(), s = sumLoc('shortTerm'), l = sumLoc('longTerm');
        const storage = r2(s + l), total = r2(a + storage);
        const cards = [
            ['Case (active)', a, 'active'],
            ['Short-Term', s, 'short'],
            ['Long-Term', l, 'long'],
            ['On-hand storage', storage, 'storage'],
            ['Grand total', total, 'total']
        ];
        document.getElementById('price-cards').innerHTML = cards.map(([label, pans, key]) => `
            <div class="g-price-card ${key === 'total' ? 'is-total' : ''}">
                <div class="g-price-label">${label}</div>
                <div class="g-price-val">${money(pans * COST_PER_PAN)}</div>
                <div class="g-price-sub">${r2(pans)} pans · ${grams(pans).toLocaleString()} g</div>
            </div>`).join('');
    }

    /* Today's case usage: served (used), emptied (wasted), and what's still in
     * the case right now — so the day's consumption isn't lost as pans drain. */
    function renderUsage() {
        const el = document.getElementById('usage-cards');
        if (!el) return;
        const used = r2(usageToday.usedPans || 0);
        const inCase = activePans();
        const cards = [
            ['Used today (served + emptied)', used, 'used'],
            ['Still in case', inCase, 'incase'],
            ['Total handled today (used + still)', r2(used + inCase), 'total']
        ];
        el.innerHTML = cards.map(([label, pans, key]) => `
            <div class="g-price-card ${key === 'total' ? 'is-total' : ''}">
                <div class="g-price-label">${label}</div>
                <div class="g-price-val">${money(pans * COST_PER_PAN)}</div>
                <div class="g-price-sub">${r2(pans)} pans · ${grams(pans).toLocaleString()} g</div>
            </div>`).join('');
        const d = document.getElementById('usage-date');
        if (d) d.textContent = usageToday.date || todayStr();
    }

    /* Predictively stage a same-flavor refill for any case pan that has
     * short-term stock to pull from — even before it hits the red. */
    function autoStageLowPans() {
        // never write until the saved queue has loaded, or we'd clobber it
        if (!queueLoaded) return;
        const additions = [];
        casePans().forEach(f => {
            // predictive: stage a refill for ANY pan that has a short-term
            // replacement ready, even before it drops into the red
            if (caseStock(f) > EPS && !queue.some(q => q.pan === f.casePan)) {
                additions.push({ pan: f.casePan, flavorId: f.id, name: f.name });
            }
        });
        if (!additions.length || autoStageLock) return;
        autoStageLock = true;
        const next = queue.concat(additions);
        queueDocRef().set({ queue: next }, { merge: true })
            .then(() => additions.forEach(a => logMove('auto-stage', `Auto-staged ${a.name} refill → Pan ${a.pan}`)))
            .catch(err => { autoStageLock = false; console.error('autoStage failed', err); });
    }

    function renderCaps() {
        document.getElementById('case-cap').textContent = `${casePans().length} / ${CASE_SLOTS} pans`;
        document.getElementById('short-cap').textContent =
            `${slotsUsed('shortTerm')} / ${SHORT_CAP} slots · ${slotsOpen('shortTerm')} open`;
        document.getElementById('long-cap').textContent =
            `${slotsUsed('longTerm')} / ${LONG_CAP} slots · ${slotsOpen('longTerm')} open`;
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
                const img = flavorImage(f);
                const swatch = img ? `style="background-image:url('${img}')"` : '';
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
                    <div class="g-pan-amt"><span class="g-pan-qty">${r2(f.active)}</span> pan · <span class="g-pan-pct">${pct}%</span></div>
                    <div class="g-pan-use">
                        <select class="g-use-amt" data-id="${f.id}" aria-label="Amount to use or add">
                            ${USE_OPTIONS}
                        </select>
                        <button type="button" class="g-use-btn" data-act="use" data-id="${f.id}">−<span class="g-btn-word"> Use</span></button>
                        <button type="button" class="g-add-btn" data-act="add" data-id="${f.id}">+<span class="g-btn-word"> Add</span></button>
                    </div>
                    <div class="g-pan-foot">
                        <button type="button" class="g-pan-toshort" data-act="toshort" data-id="${f.id}">Short</button>
                        <button type="button" class="g-pan-empty" data-act="empty" data-id="${f.id}">Empty</button>
                        <button type="button" class="g-pan-discard" data-act="discard" data-id="${f.id}">Trash</button>
                    </div>
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
        wrap.querySelectorAll('[data-act="add"]').forEach(b => b.addEventListener('click', () => {
            const input = wrap.querySelector(`.g-use-amt[data-id="${b.dataset.id}"]`);
            topUpPan(b.dataset.id, parseFloat(input.value));
        }));
        wrap.querySelectorAll('[data-act="empty"]').forEach(b =>
            b.addEventListener('click', () => emptyPan(b.dataset.id)));
        wrap.querySelectorAll('[data-act="discard"]').forEach(b =>
            b.addEventListener('click', () => discardPan(b.dataset.id)));
        wrap.querySelectorAll('[data-act="toshort"]').forEach(b =>
            b.addEventListener('click', () => caseToShort(b.dataset.id)));
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
        const used = slotsUsed(loc);
        const open = cap - used;
        const overPct = Math.min(100, (used / cap) * 100);

        let html = `<div class="g-cap-bar"><div class="g-cap-bar-fill" style="width:${overPct}%"></div>
            <span>${used} / ${cap} slots filled · ${open} open · ${sumLoc(loc)} pans</span></div><div class="g-tubs">`;
        if (!items.length) html += `<p class="g-empty-note">No pans stored here.</p>`;
        items.forEach(f => {
            const amt = f[loc] || 0;
            const tone = freezerTone(amt);
            const whole = Math.floor(amt + EPS);
            const frac = r2(amt - whole);
            let icons = '';
            for (let i = 0; i < whole; i++) icons += `<span class="g-tub-icon ${tone}"></span>`;
            if (frac > EPS) icons += `<span class="g-tub-icon ${tone} part" style="--frac:${frac}"></span>`;
            const img = flavorImage(f);
            const swatch = img ? `style="background-image:url('${img}')"` : '';
            html += `
            <div class="g-frz-tub tone-${tone}">
                <div class="g-frz-swatch" ${swatch}></div>
                <div class="g-frz-info">
                    <div class="g-frz-name">${esc(f.name)}</div>
                    <div class="g-tub-icons">${icons}</div>
                    <div class="g-frz-amt"><span class="g-dot ${tone}"></span>${r2(amt)} pans · ${slotsOf(amt)} slot${slotsOf(amt) === 1 ? '' : 's'}</div>
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
            [`Low pans (≤ ${SWAP_THRESHOLD})`, `${lowCount}`, lowCount ? 1 : 0, lowCount ? 'red' : 'green'],
            ['Case gelato', `${caseFill} pans`, caseFill / CASE_SLOTS],
            ['Short-term slots', `${slotsUsed('shortTerm')} / ${SHORT_CAP}`, slotsUsed('shortTerm') / SHORT_CAP],
            ['Long-term slots', `${slotsUsed('longTerm')} / ${LONG_CAP}`, slotsUsed('longTerm') / LONG_CAP],
            ['Total gelato', `${total} pans`, total / (CASE_SLOTS + SHORT_CAP + LONG_CAP)]
        ]);

        bars('stat-case', casePans().slice().sort((a, b) => a.casePan - b.casePan)
            .map(f => ({ name: `Pan ${f.casePan} · ${f.name}`, val: f.active || 0 })), 1, true, true);
        bars('stat-short', withAmt('shortTerm').map(f => ({ name: f.name, val: f.shortTerm || 0 })),
            Math.max(SHORT_CAP / 4, maxVal('shortTerm')), false);
        bars('stat-long', withAmt('longTerm').map(f => ({ name: f.name, val: f.longTerm || 0 })),
            Math.max(LONG_CAP / 4, maxVal('longTerm')), false);

        renderStatTable();
        renderOrderQueue();
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

    function bars(elId, data, max, lowAware, keepOrder) {
        const el = document.getElementById(elId);
        data = data.filter(d => d.val > EPS);
        if (!keepOrder) data = data.sort((a, b) => b.val - a.val);
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
            id: f.id, name: f.name, pan: f.casePan || null,
            active: r2(f.active), short: r2(f.shortTerm), long: r2(f.longTerm),
            total: r2((f.active || 0) + (f.shortTerm || 0) + (f.longTerm || 0))
        }))
            .filter(r => r.total > EPS)   // hide flavors not in the case or either freezer
            .sort((a, b) => b.total - a.total);

        const head = `<thead><tr>
            <th>Flavor</th><th>Pan</th><th>Case</th><th>Short</th><th>Long</th><th>Total</th><th>Value</th>
        </tr></thead>`;
        // colour storage cells with the same green/yellow/red tiers as the freezers
        const toneCell = v => v > EPS ? `<td class="tone-${freezerTone(v)}">${v}</td>` : `<td>—</td>`;
        const body = rows.map(r => {
            const ordered = orderQueue.some(o => o.flavorId === r.id);
            const lowRow = r.pan && r.active <= SWAP_THRESHOLD + EPS;
            return `
            <tr class="${lowRow ? 'low' : ''} ${ordered ? 'ordered' : ''}">
                <td class="l"><span class="g-order-link" data-order-id="${r.id}" title="Click to queue this flavor for production">${esc(r.name)}</span></td>
                <td>${r.pan || '—'}</td>
                <td>${r.active || '—'}</td>
                ${toneCell(r.short)}
                ${toneCell(r.long)}
                <td><strong>${r.total || '—'}</strong></td>
                <td>${r.total > EPS ? money(r.total * COST_PER_PAN) : '—'}</td>
            </tr>`;
        }).join('');
        const table = document.getElementById('stat-table');
        table.innerHTML = head + `<tbody>${body}</tbody>`;
        table.querySelectorAll('.g-order-link').forEach(el =>
            el.addEventListener('click', () => toggleOrder(el.dataset.orderId)));
    }

    // ----- Order queue (flavors to make) ----------------------------------
    function renderOrderQueue() {
        const sel = document.getElementById('order-flavor');
        if (sel) {
            const prev = sel.value;
            sel.innerHTML = menuFlavors.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
            if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
        }
        const list = document.getElementById('order-list');
        if (!list) return;
        if (!orderQueue.length) {
            list.innerHTML = `<p class="g-empty-note">No flavors queued for production.</p>`;
            return;
        }
        list.innerHTML = orderQueue.map((o, i) => `
            <div class="g-order-item">
                <span class="g-order-num">${i + 1}</span>
                <span class="g-order-iname">${esc(nameById(o.flavorId) || o.name)}</span>
                <button type="button" class="g-order-del" data-i="${i}" aria-label="Remove">✕</button>
            </div>`).join('');
        list.querySelectorAll('.g-order-del').forEach(b =>
            b.addEventListener('click', () => removeFromOrder(Number(b.dataset.i))));
    }

    function toggleOrder(flavorId) {
        if (orderQueue.some(o => o.flavorId === flavorId)) {
            removeFromOrder(orderQueue.findIndex(o => o.flavorId === flavorId));
        } else {
            addToOrder(flavorId);
        }
    }

    async function addToOrder(flavorId) {
        if (!flavorId || orderQueue.some(o => o.flavorId === flavorId)) return;
        const name = nameById(flavorId) || (byId(flavorId) || {}).name || '(unnamed)';
        const next = orderQueue.concat([{ flavorId, name }]);
        await orderDocRef().set({ items: next }, { merge: true });
        status(`Queued ${name} for production (order ${next.length}).`, true);
    }

    async function removeFromOrder(i) {
        const next = orderQueue.slice();
        next.splice(i, 1);
        await orderDocRef().set({ items: next }, { merge: true });
    }

    async function clearOrder() {
        if (!orderQueue.length) return;
        if (!confirm('Clear the entire production order list?')) return;
        await orderDocRef().set({ items: [] });
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
                    ? `<div class="g-reco-queued">✔ Staged: ${esc(nameById(queued.flavorId) || queued.name)} → Pan ${f.casePan} (ready below)</div>`
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

        const avail = flavors.filter(f => caseStock(f) > EPS);
        flavSel.innerHTML = avail.length
            ? avail.map(f => `<option value="${f.id}">${esc(f.name)} (Short: ${r2(f.shortTerm)})</option>`).join('')
            : `<option value="">No short-term stock — move some up first</option>`;

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
                    <div><strong>${esc(nameById(q.flavorId) || q.name)}</strong> → Pan ${q.pan}</div>
                    ${state}
                </div>
                <span class="g-qitem-actions">
                    <button type="button" class="g-q-exec" data-i="${i}">Execute</button>
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

        // the case is fed from short-term only
        if (caseStock(incoming) <= EPS) {
            status(`${incoming.name} has no short-term stock. Move some up from long-term first.`); return;
        }

        const stock = r2(incoming.shortTerm || 0);
        const frac = r2(stock % 1);
        const take = frac > EPS ? frac : Math.min(1, stock);
        const outgoing = flavors.find(f => f.casePan === q.pan);

        const batch = db.batch();
        if (outgoing && outgoing.id !== incoming.id) {
            batch.update(doc(outgoing.id), { active: 0, casePan: null, updatedAt: stamp() });
        }
        batch.update(doc(incoming.id), {
            shortTerm: r2((incoming.shortTerm || 0) - take),
            active: take, casePan: q.pan, updatedAt: stamp()
        });
        await batch.commit();

        const next = queue.slice();
        next.splice(i, 1);
        await queueDocRef().set({ queue: next }, { merge: true });
        logMove('swap', `Swapped ${incoming.name} into Pan ${q.pan} (${take} from Short-Term)`);
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
        addUsage('usedPans', amount);   // count served gelato toward today's usage
        logMove('use', `Used ${amount} ${f.name} (Pan ${f.casePan}) — ${r2(next)} left`);
        status(`Used ${amount} of ${f.name}. ${next <= EPS ? 'Pan emptied.' : r2(next) + ' left.'}`, true);
    }

    /* Top up a case pan. Opens a popup to choose the source: pull from this
     * flavor's short-term storage (if any), or add from thin air. Caps at 1.0. */
    function topUpPan(id, amount) {
        const f = byId(id);
        if (!f) return;
        amount = r2(amount);
        if (!(amount > 0)) { status('Pick an amount to add.'); return; }
        const room = r2(1 - (f.active || 0));
        if (room <= EPS) { status(`Pan ${f.casePan} is already full (1.0).`); return; }
        const add = Math.min(amount, room);                 // never exceed a full pan
        const haveShort = caseStock(f);

        document.getElementById('g-modal-title').textContent = `Add ${add} to ${f.name} (Pan ${f.casePan})`;
        document.getElementById('g-modal-body').innerHTML = `
            <p class="g-modal-hint">Where should this ${add} pan come from?</p>
            <div class="g-modal-actions g-topup-actions">
                ${haveShort > EPS
                ? `<button type="button" class="g-modal-go" id="tu-short">Pull from short-term (have ${r2(haveShort)})</button>`
                : `<p class="g-empty-note">No short-term stock for ${esc(f.name)} to pull from.</p>`}
                <button type="button" class="g-modal-go g-topup-air" id="tu-air">Add from thin air</button>
                <button type="button" class="g-modal-cancel" id="tu-cancel">Cancel</button>
            </div>`;
        showModal();

        const shortBtn = document.getElementById('tu-short');
        if (shortBtn) shortBtn.addEventListener('click', () => doTopUp(id, add, true));
        document.getElementById('tu-air').addEventListener('click', () => doTopUp(id, add, false));
        document.getElementById('tu-cancel').addEventListener('click', closeModal);
    }

    async function doTopUp(id, add, pullShort) {
        const f = byId(id);
        if (!f) return;
        const fromShort = pullShort ? Math.min(caseStock(f), add) : 0;
        const newActive = r2((f.active || 0) + add);
        await doc(id).update({
            active: newActive,
            shortTerm: r2((f.shortTerm || 0) - fromShort),
            updatedAt: stamp()
        });
        closeModal();
        const src = fromShort > EPS
            ? `${r2(fromShort)} from Short-Term${fromShort < add - EPS ? `, ${r2(add - fromShort)} added` : ''}`
            : 'added (thin air)';
        logMove('transfer', `Added ${r2(add)} to Pan ${f.casePan} (${f.name}) — ${src} — now ${newActive}`);
        status(`Added ${r2(add)} to ${f.name}. Now ${newActive}.`, true);
    }

    // ----- Merge into a pan -----------------------------------------------
    /* Parse a merge "FROM" option value of the form "pan:<id>" or "short:<id>"
     * into the source flavor, how much it holds, and which field it lives in. */
    function mergeSource(spec) {
        const sep = spec.indexOf(':');
        const type = spec.slice(0, sep), id = spec.slice(sep + 1);
        const f = byId(id);
        if (!f) return null;
        return { type, id, f, field: type === 'short' ? 'shortTerm' : 'active', amount: type === 'short' ? (f.shortTerm || 0) : (f.active || 0) };
    }

    /* Popup to fill a case pan up to 1.0 from another pan OR from a flavor's
     * short-term storage. e.g. short-term 2.3 + a 0.7 pan -> moves 0.3 so the
     * pan reads 1.0 and short-term reads 2.0. Capped at a full 1.0. */
    function openMergeModal() {
        const pans = casePans().slice().sort((a, b) => a.casePan - b.casePan);
        const shortHoldings = flavors.filter(f => (f.shortTerm || 0) > EPS)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        document.getElementById('g-modal-title').textContent = 'Merge / fill a pan';
        const body = document.getElementById('g-modal-body');
        if (!pans.length) {
            body.innerHTML = `<p class="g-empty-note">You need at least one filled case pan to merge into.</p>`;
            showModal();
            return;
        }
        // short-term sources listed first (the common "top up a pan" case)
        const fromOpts =
            shortHoldings.map(f => `<option value="short:${f.id}">Short-Term · ${esc(f.name)} (${r2(f.shortTerm)})</option>`).join('') +
            pans.map(f => `<option value="pan:${f.id}">Pan ${f.casePan} · ${esc(f.name)} (${r2(f.active)})</option>`).join('');
        const intoOpts = pans.map(f => `<option value="${f.id}">Pan ${f.casePan} · ${esc(f.name)} (${r2(f.active)})</option>`).join('');
        body.innerHTML = `
            <label class="g-modal-label">Merge FROM (short-term, or another pan)</label>
            <select id="merge-from" class="g-modal-select">${fromOpts}</select>
            <label class="g-modal-label">INTO pan in the case (fills up to 1.0)</label>
            <select id="merge-into" class="g-modal-select">${intoOpts}</select>
            <p class="g-modal-hint" id="merge-hint"></p>
            <div class="g-modal-actions">
                <button type="button" class="g-modal-cancel" id="merge-cancel">Cancel</button>
                <button type="button" class="g-modal-go" id="merge-go">Merge</button>
            </div>`;
        showModal();

        const fromSel = document.getElementById('merge-from');
        const intoSel = document.getElementById('merge-into');
        const hint = document.getElementById('merge-hint');

        // when the source is a flavor's short-term, target its own case pan if it has one
        const syncInto = () => {
            const src = mergeSource(fromSel.value);
            if (src && src.type === 'short') {
                const ownPan = pans.find(p => p.id === src.id);
                if (ownPan) intoSel.value = ownPan.id;
            }
        };
        // default to the first short-term holding feeding its own pan, else pan->pan
        if (shortHoldings.length) { fromSel.value = `short:${shortHoldings[0].id}`; syncInto(); }
        else if (pans.length >= 2) { fromSel.value = `pan:${pans[1].id}`; intoSel.value = pans[0].id; }

        const updateHint = () => {
            const src = mergeSource(fromSel.value), tgt = byId(intoSel.value);
            if (!src || !tgt) { hint.textContent = ''; return; }
            if (src.type === 'pan' && src.id === tgt.id) { hint.textContent = 'Source and target are the same pan.'; return; }
            const room = r2(1 - (tgt.active || 0));
            const moved = r2(Math.min(room, src.amount));
            const label = src.type === 'short' ? `Short-Term ${src.f.name}` : `Pan ${src.f.casePan}`;
            if (moved <= EPS) { hint.textContent = `Pan ${tgt.casePan} is already full.`; return; }
            hint.textContent = `Move ${moved} from ${label} → Pan ${tgt.casePan} (now ${r2((tgt.active || 0) + moved)}). ${label} keeps ${r2(src.amount - moved)}.`;
        };
        fromSel.addEventListener('change', () => { syncInto(); updateHint(); });
        intoSel.addEventListener('change', updateHint);
        updateHint();

        document.getElementById('merge-cancel').addEventListener('click', closeModal);
        document.getElementById('merge-go').addEventListener('click', () => doMerge(fromSel.value, intoSel.value));
    }

    async function doMerge(fromSpec, tgtId) {
        const src = mergeSource(fromSpec), tgt = byId(tgtId);
        if (!src || !tgt) return;
        if (src.type === 'pan' && src.id === tgt.id) { status('Pick a different source.'); return; }

        const room = r2(1 - (tgt.active || 0));
        const moved = r2(Math.min(room, src.amount));
        if (moved <= EPS) { status(`Pan ${tgt.casePan} is already full — nothing to merge in.`); return; }
        const newActive = r2((tgt.active || 0) + moved);
        const label = src.type === 'short' ? `Short-Term (${src.f.name})` : `Pan ${src.f.casePan} (${src.f.name})`;

        if (src.type === 'short' && src.id === tgt.id) {
            // same flavor: top its own pan up from its own short-term in one write
            await doc(tgt.id).update({
                active: newActive,
                shortTerm: r2((tgt.shortTerm || 0) - moved),
                updatedAt: stamp()
            });
        } else {
            const batch = db.batch();
            batch.update(doc(tgt.id), { active: newActive, updatedAt: stamp() });
            if (src.type === 'short') {
                batch.update(doc(src.id), { shortTerm: r2((src.f.shortTerm || 0) - moved), updatedAt: stamp() });
            } else {
                const srcNew = r2((src.f.active || 0) - moved);
                const u = { active: srcNew > EPS ? srcNew : 0, updatedAt: stamp() };
                if (srcNew <= EPS) u.casePan = null;   // source pan freed
                batch.update(doc(src.id), u);
            }
            await batch.commit();
        }

        closeModal();
        logMove('transfer', `Merged ${moved} from ${label} into Pan ${tgt.casePan} (${tgt.name}) — now ${newActive}`);
        status(`Merged into Pan ${tgt.casePan}. Now ${newActive}.`, true);
    }

    /* Send a case pan's remaining gelato back into short-term storage. */
    async function caseToShort(id) {
        const f = byId(id);
        if (!f) return;
        const amt = r2(f.active || 0);
        if (amt <= 0) { status('Nothing to send back.'); return; }
        const newAmt = r2((f.shortTerm || 0) + amt);
        if (slotsAfter('shortTerm', f.id, newAmt) > SHORT_CAP) {
            status(`Short-term freezer is full — ${slotsOpen('shortTerm')} slot(s) open.`); return;
        }
        const pan = f.casePan;
        await doc(id).update({
            shortTerm: newAmt, active: 0, casePan: null, updatedAt: stamp()
        });
        logMove('transfer', `${amt} ${f.name}: Case (Pan ${pan}) → Short-Term`);
        status(`Sent ${amt} of ${f.name} back to short-term.`, true);
    }

    async function emptyPan(id) {
        const f = byId(id);
        if (!f) return;
        if (!confirm(`Empty Pan ${f.casePan} (${f.name})? The remaining ${r2(f.active)} pan will be used up.`)) return;
        const pan = f.casePan, used = r2(f.active || 0);
        await doc(id).update({ active: 0, casePan: null, updatedAt: stamp() });
        addUsage('usedPans', used);  // emptying = a fast way to use the whole pan
        logMove('empty', `Used the rest of Pan ${pan} (${f.name}, ${used})`);
        // same swap logic as a low pan: if this flavor still has SHORT-TERM stock,
        // auto-stage a refill for the now-empty pan
        if (caseStock(f) > EPS && !queue.some(q => q.pan === pan)) {
            const next = queue.concat([{ pan, flavorId: f.id, name: f.name }]);
            await queueDocRef().set({ queue: next }, { merge: true });
            logMove('auto-stage', `Auto-staged ${f.name} refill → Pan ${pan} (emptied)`);
        }
    }

    /* Throw a case pan out (trash). NOT counted as used — no cost is recorded. */
    async function discardPan(id) {
        const f = byId(id);
        if (!f) return;
        const amt = r2(f.active || 0);
        if (!confirm(`Discard Pan ${f.casePan} (${f.name})? The remaining ${amt} pan goes in the trash and is NOT counted as used.`)) return;
        const pan = f.casePan;
        await doc(id).update({ active: 0, casePan: null, updatedAt: stamp() });
        logMove('discard', `Discarded Pan ${pan} (${f.name}, ${amt} trashed — not counted)`);
        if (caseStock(f) > EPS && !queue.some(q => q.pan === pan)) {
            const next = queue.concat([{ pan, flavorId: f.id, name: f.name }]);
            await queueDocRef().set({ queue: next }, { merge: true });
            logMove('auto-stage', `Auto-staged ${f.name} refill → Pan ${pan} (discarded)`);
        }
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
        logMove('close', `Closed case for the night — ${inCase.length} pan(s) moved to storage`);
        if (stuck.length) status(`Closed, but storage was full — left in case: ${stuck.join(', ')}.`);
        else status('Case closed for the night — everything moved to storage. 🌙', true);
    }

    // ----- Case snapshot save / reload ------------------------------------
    /* Save the current case layout (which flavor + how full in each pan). */
    async function saveSnapshot() {
        const pans = casePans().sort((a, b) => a.casePan - b.casePan)
            .map(f => ({ pan: f.casePan, flavorId: f.id, name: f.name, active: r2(f.active) }));
        if (!pans.length) { status('The case is empty — nothing to snapshot.'); return; }
        await snapshotDocRef().set({ pans, savedAt: stamp(), count: pans.length });
        logMove('snapshot', `Saved case snapshot (${pans.length} pan(s))`);
        status(`Saved a snapshot of ${pans.length} pan(s). 📸`, true);
    }

    /* Reload the case to the last saved snapshot, pulling each flavor back out
     * of storage. Any flavors currently in the case are returned to storage
     * first so nothing is lost. */
    async function reloadCase() {
        const snap = await snapshotDocRef().get();
        if (!snap.exists || !Array.isArray(snap.data().pans) || !snap.data().pans.length) {
            status('No saved snapshot to reload yet. Use “Save Snapshot” first.'); return;
        }
        const plan = snap.data().pans;
        if (!confirm(`Reload the case to the saved snapshot (${plan.length} pan(s))? Current case pans go back to storage first.`)) return;

        // working copy of every flavor's stock + case state
        const st = {};
        inventory.forEach(f => st[f.id] = {
            shortTerm: f.shortTerm || 0, longTerm: f.longTerm || 0, active: 0, casePan: null
        });
        // return whatever's in the case now to storage (short first, then long)
        casePans().forEach(f => {
            let amt = r2(f.active || 0);
            const toShort = Math.min(amt, Math.max(0, SHORT_CAP - sumOf(st, 'shortTerm')));
            st[f.id].shortTerm = r2(st[f.id].shortTerm + toShort); amt = r2(amt - toShort);
            st[f.id].longTerm = r2(st[f.id].longTerm + amt);
        });
        // place snapshot flavors back into their pans, pulling from storage
        const missing = [];
        plan.forEach(p => {
            const s = st[p.flavorId];
            if (!s) { missing.push(p.name); return; }
            const want = r2(p.active);
            // the case is fed from short-term only
            const fromShort = Math.min(s.shortTerm, want); s.shortTerm = r2(s.shortTerm - fromShort);
            s.active = fromShort;   // capped at short-term availability
            s.casePan = p.pan;
        });
        // write only the docs that changed
        const batch = db.batch();
        inventory.forEach(f => {
            const s = st[f.id];
            const changed = r2(f.shortTerm || 0) !== s.shortTerm || r2(f.longTerm || 0) !== s.longTerm ||
                r2(f.active || 0) !== s.active || (f.casePan || null) !== s.casePan;
            if (changed) batch.update(doc(f.id), {
                shortTerm: s.shortTerm, longTerm: s.longTerm, active: s.active,
                casePan: s.casePan, updatedAt: stamp()
            });
        });
        await batch.commit();
        logMove('reload', `Reloaded case from snapshot (${plan.length} pan(s))`);
        if (missing.length) status(`Reloaded. These flavors no longer exist: ${missing.join(', ')}.`);
        else status('Case reloaded from the saved snapshot. ✅', true);
    }

    const sumOf = (state, key) => r2(Object.values(state).reduce((s, v) => s + (v[key] || 0), 0));

    // ----- Move history ----------------------------------------------------
    function renderLog() {
        const wrap = document.getElementById('move-log');
        if (!wrap) return;
        if (!moves.length) { wrap.innerHTML = `<p class="g-empty-note">No moves recorded yet.</p>`; return; }
        wrap.innerHTML = moves.map(m => {
            const when = m.at && m.at.toDate ? m.at.toDate() : null;
            const t = when ? when.toLocaleString('en-US',
                { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '…';
            return `<div class="g-log-row">
                <span class="g-log-type t-${esc(m.type || 'move')}">${esc(m.type || 'move')}</span>
                <span class="g-log-text">${esc(m.text || '')}</span>
                <span class="g-log-time">${t}</span>
            </div>`;
        }).join('');
    }

    // ----- Assign modal (GUI) ---------------------------------------------
    function openAssignModal(pan) {
        const choices = flavors.filter(f => !f.casePan && caseStock(f) > EPS)
            .sort((a, b) => caseStock(b) - caseStock(a));
        const body = document.getElementById('g-modal-body');
        document.getElementById('g-modal-title').textContent = `Add a flavor to Pan ${pan}`;

        if (!choices.length) {
            body.innerHTML = `<p class="g-empty-note">No flavors have short-term stock yet.
                The case fills from <strong>short-term</strong> — use <strong>Add Stock</strong> or move some up
                from long-term, then assign it here.</p>`;
            showModal();
            return;
        }
        body.innerHTML = `
            <label class="g-modal-label">Flavor (from short-term storage)</label>
            <select id="assign-flavor" class="g-modal-select">
                ${choices.map(f => `<option value="${f.id}">${esc(f.name)} — Short: ${r2(f.shortTerm)}</option>`).join('')}
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
            hint.textContent = `${f.name}: ${r2(f.shortTerm)} pan(s) in short-term.`;
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
        if (casePans().length >= CASE_SLOTS) { status(`The case is full (${CASE_SLOTS} pans).`); return; }
        const stock = caseStock(f);  // case fills from short-term only
        if (amount > stock + EPS) { status(`Only ${stock} pan(s) of ${f.name} in short-term.`); return; }

        await doc(f.id).update({
            shortTerm: r2((f.shortTerm || 0) - amount),
            active: amount,
            casePan: pan,
            updatedAt: stamp()
        });
        closeModal();
        logMove('assign', `Added ${f.name} to Pan ${pan} at ${amount} (from Short-Term)`);
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
                ? pendingList.map(p => {
                    const inv = byId(p.id) || {};
                    return `<option value="${p.id}"
                        data-name="${esc(p.name)}"
                        data-short="${r2(inv.shortTerm || 0)}"
                        data-long="${r2(inv.longTerm || 0)}"
                    >${esc(p.name)}</option>`;
                })
                : [`<option value="">No pending flavors</option>`];
        } else {
            opts = menuFlavors.length
                ? menuFlavors.map(f => {
                    const inv = byId(f.id) || {};
                    return `<option value="${f.id}"
                        data-name="${esc(f.name)}"
                        data-short="${r2(inv.shortTerm || 0)}"
                        data-long="${r2(inv.longTerm || 0)}"
                    >${esc(f.name)}</option>`;
                })
                : [`<option value="">No active flavors on menu</option>`];
        }
        sel.innerHTML = opts.join('');
        if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
    }

    function refreshStockHint() {
        const loc = document.getElementById('as-loc').value;
        const cap = loc === 'shortTerm' ? SHORT_CAP : LONG_CAP;
        const hint = document.getElementById('as-hint');
        const sel = document.getElementById('as-flavor');
        const opt = sel.options[sel.selectedIndex];
        if (!opt || !opt.value) { hint.textContent = ''; return; }
        const name = opt.getAttribute('data-name') || opt.text;
        const cur = loc === 'shortTerm'
            ? parseFloat(opt.getAttribute('data-short') || 0)
            : parseFloat(opt.getAttribute('data-long') || 0);
        hint.textContent = `${name}: ${r2(cur)} in ${LOCATION_LABELS[loc]}. ${slotsOpen(loc)} of ${cap} slots open.`;
    }

    async function onAddStock(e) {
        e.preventDefault();
        const loc = document.getElementById('as-loc').value;
        const amount = r2(document.getElementById('as-amt').value);
        const val = document.getElementById('as-flavor').value;
        if (!val) { status('Pick a flavor.'); return; }
        if (!(amount > 0)) { status('Enter a quantity greater than 0.'); return; }
        const cap = loc === 'shortTerm' ? SHORT_CAP : LONG_CAP;
        const curLoc = ((byId(val) || {})[loc]) || 0;
        if (slotsAfter(loc, val, r2(curLoc + amount)) > cap) {
            status(`${LOCATION_LABELS[loc]} freezer is full — ${slotsOpen(loc)} slot(s) open.`); return;
        }

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
            logMove('intake', `Added ${amount} ${p.name} (pending) → ${LOCATION_LABELS[loc]}`);
            status(`Added ${amount} pan(s) of ${p.name} (pending) to ${LOCATION_LABELS[loc]}.`, true);
        } else {
            const f = byId(val);
            const m = menuFlavors.find(x => x.id === val);
            if (!f && !m) { status('Flavor not found.'); return; }
            const name = (m || f).name;   // prefer the live menu name
            if (f) {
                const heal = m ? { name: m.name || f.name, gelatoImage: m.gelatoImage || m.imageURL || f.gelatoImage || '', imageURL: m.imageURL || f.imageURL || '' } : {};
                await doc(val).update({ [loc]: r2((f[loc] || 0) + amount), ...heal, updatedAt: stamp() });
            } else {
                // inventory doc doesn't exist yet — create it on the fly
                await doc(val).set({
                    name: m.name || '(unnamed)',
                    gelatoImage: m.gelatoImage || m.imageURL || '',
                    imageURL: m.imageURL || '',
                    active: 0, casePan: null,
                    shortTerm: loc === 'shortTerm' ? amount : 0,
                    longTerm: loc === 'longTerm' ? amount : 0,
                    updatedAt: stamp()
                }, { merge: true });
            }
            logMove('intake', `Added ${amount} ${name} → ${LOCATION_LABELS[loc]}`);
            status(`Added ${amount} pan(s) of ${name} to ${LOCATION_LABELS[loc]}.`, true);
        }
    }

    // ----- Transfer form ---------------------------------------------------
    function renderTransferFlavors() {
        const sel = document.getElementById('t-flavor');
        const prev = sel.value;
        // merge: all menu flavors + any off-menu flavors that still have stock
        const offMenu = flavors.filter(f => !menuIds || !menuIds.has(f.id));
        const allOpts = [...menuFlavors, ...offMenu]
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        sel.innerHTML = allOpts.length
            ? allOpts.map(f => {
                const inv = byId(f.id) || {};
                return `<option value="${f.id}"
                    data-name="${esc(f.name)}"
                    data-active="${r2(inv.active || 0)}"
                    data-short="${r2(inv.shortTerm || 0)}"
                    data-long="${r2(inv.longTerm || 0)}"
                >${esc(f.name)}</option>`;
            }).join('')
            : `<option value="">No flavors available</option>`;
        if (prev && allOpts.some(f => f.id === prev)) sel.value = prev;
    }

    function refreshTransferHint() {
        const sel = document.getElementById('t-flavor');
        const opt = sel.options[sel.selectedIndex];
        const from = document.getElementById('t-from').value;
        const to = document.getElementById('t-to').value;
        const hint = document.getElementById('t-hint');
        if (!opt || !opt.value) { hint.textContent = ''; return; }
        const name = opt.getAttribute('data-name') || opt.text;
        const have = from === 'active'
            ? parseFloat(opt.getAttribute('data-active') || 0)
            : from === 'shortTerm'
                ? parseFloat(opt.getAttribute('data-short') || 0)
                : parseFloat(opt.getAttribute('data-long') || 0);
        let msg = `${name}: holds ${r2(have)} in ${LOCATION_LABELS[from]}.`;
        if (to === 'active') msg += ` Case pans cap at 1.0 each.`;
        if (to === 'shortTerm') msg += ` Short-term: ${slotsOpen('shortTerm')} of ${SHORT_CAP} slots open.`;
        if (to === 'longTerm') msg += ` Long-term: ${slotsOpen('longTerm')} of ${LONG_CAP} slots open.`;
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
            if (from !== 'shortTerm') { status('The case can only be filled from short-term storage.'); return; }
            if (!f.casePan && casePans().length >= CASE_SLOTS) { status(`The case is full (${CASE_SLOTS} pans).`); return; }
            const newActive = r2((f.active || 0) + amount);
            if (newActive > 1 + EPS) { status(`A case pan holds max 1.0. ${f.name} would reach ${newActive}.`); return; }
            update.active = newActive;
            if (!f.casePan) update.casePan = firstFreePan();
        } else {
            const cap = to === 'shortTerm' ? SHORT_CAP : LONG_CAP;
            const newAmt = r2((f[to] || 0) + amount);
            if (slotsAfter(to, f.id, newAmt) > cap) {
                status(`${LOCATION_LABELS[to]} freezer is full — ${slotsOpen(to)} slot(s) open.`); return;
            }
            update[to] = newAmt;
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
            logMove('transfer', `${amount} ${f.name}: ${LOCATION_LABELS[from]} → ${LOCATION_LABELS[to]}`);
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
        const total = r2(f.shortTerm || 0);   // case fills from short-term only
        const frac = r2(total % 1);
        return frac > EPS ? frac : Math.min(1, total);
    }

    const stamp = () => firebase.firestore.FieldValue.serverTimestamp();
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
})();
