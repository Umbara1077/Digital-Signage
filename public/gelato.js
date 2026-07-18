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
    // Price per gram is editable in the "Inventory Value" header and saved in
    // gelatoSettings/pricing so every device shares it. Defaults to $0.035/g.
    // Full pans weigh ~7000-8000 g; 7500 g average -> ~$262 per full pan.
    const DEFAULT_PRICE_PER_GRAM = 0.035;
    const GRAMS_PER_PAN = 7500;
    let PRICE_PER_GRAM = DEFAULT_PRICE_PER_GRAM;
    let COST_PER_PAN = PRICE_PER_GRAM * GRAMS_PER_PAN;
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
    let viewMode = 'visual';   // 'visual' | 'stats' | 'mobile'
    let statMode = false;      // kept in sync with viewMode === 'stats'
    let openPanChips = new Set();   // "id|loc|idx|amt" keys of chips in adjust mode
    let chipHandlersAttached = false;
    let autoStageExcluded = new Set();  // "pan|flavorId" keys excluded from auto-stage (manually removed)
    let _started = false;  // prevents wireUi/start from running twice if auth fires twice
    let pendingDummyFocusId = null;  // id of a just-created dummy pan to auto-focus once rendered
    let longFreezerCtxAttached = false;  // guards the one-time "empty space" right-click listener
    const queueDocRef = () => db.collection('gelatoSettings').doc('queue');
    const snapshotDocRef = () => db.collection('gelatoSettings').doc('caseSnapshot');
    const orderDocRef = () => db.collection('gelatoSettings').doc('orderQueue');
    const pricingDocRef = () => db.collection('gelatoSettings').doc('pricing');
    const menuBackupDocRef = () => db.collection('gelatoSettings').doc('menuBackup');
    const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD (local)
    const usageDocRef = () => db.collection('gelatoUsage').doc(todayStr());

    const r2 = n => Math.round((Number(n) || 0) * 100) / 100;     // pan amounts -> 2dp
    // The same flavor can live under several doc ids (e.g. after admin "Replace
    // Menu Item" reuses/changes an id), so match a flavor to its menu entry and
    // its stock by normalized NAME, not id.
    const normName = s => String(s == null ? '' : s).trim().toLowerCase();
    const onMenu = f => !menuIds || menuIds.has(f.id);
    const hasStock = f => (f.active || 0) > EPS || (f.shortTerm || 0) > EPS || (f.longTerm || 0) > EPS;
    const doc = id => db.collection('gelatoInventory').doc(id);

    /* ----- Freezer pans -------------------------------------------------
     * Short/long-term storage is a list of individual pans (each 0 < x <= 1),
     * so 1.7 + a new 0.5 reads as three pans [1, 0.7, 0.5] instead of merging.
     * The scalar `shortTerm`/`longTerm` totals are kept in sync (= sum of the
     * list) so every existing total/price/capacity calc keeps working. */
    const PAN_FIELD = { shortTerm: 'shortPans', longTerm: 'longPans' };
    const panSum = arr => r2((arr || []).reduce((s, x) => s + (x || 0), 0));
    function splitToPans(total) {                 // a raw amount -> whole pans + remainder
        const arr = []; let n = r2(total);
        while (n > 1 + EPS) { arr.push(1); n = r2(n - 1); }
        if (n > EPS) arr.push(n);
        return arr;
    }
    function normPans(arr, scalar) {              // existing array, or migrate a legacy scalar
        if (Array.isArray(arr)) return arr.map(r2).filter(x => x > EPS);
        return splitToPans(scalar || 0);
    }
    const pansOf = (f, loc) => normPans(f[PAN_FIELD[loc]], f[loc]);
    const addPans = (arr, amount) => (arr || []).concat(splitToPans(amount));   // add as new pan(s)
    function pullPans(arr, amount) {              // remove up to `amount`, smallest pans first
        const a = (arr || []).slice().sort((x, y) => x - y);
        let need = r2(amount); const out = [];
        for (const p of a) {
            if (need <= EPS) { out.push(p); }
            else if (p <= need + EPS) { need = r2(need - p); }   // whole pan consumed
            else { out.push(r2(p - need)); need = 0; }           // part of a pan consumed
        }
        return out.filter(x => x > EPS);
    }
    /* write helper: set both the pan list and its synced scalar total */
    function setPans(update, loc, arr) {
        update[PAN_FIELD[loc]] = arr;
        update[loc] = panSum(arr);
        return update;
    }

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
            if (_started) return; // auth can fire twice (null then user) — only boot once
            _started = true;
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
            inventory = snap.docs.map(d => {
                const data = { ...d.data(), id: d.id };
                // normalize freezer storage into pan lists + synced totals
                data.shortPans = normPans(data.shortPans, data.shortTerm);
                data.longPans = normPans(data.longPans, data.longTerm);
                data.shortTerm = panSum(data.shortPans);
                data.longTerm = panSum(data.longPans);
                return data;
            });
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
            if (viewMode === 'mobile') renderMobilePanel();
        }, err => console.error('moves snapshot error', err));

        usageDocRef().onSnapshot(d => {
            usageToday = d.exists ? d.data() : {};
            renderUsage();
        }, err => console.error('usage snapshot error', err));

        orderDocRef().onSnapshot(d => {
            orderQueue = (d.exists && Array.isArray(d.data().items)) ? d.data().items : [];
            renderOrderQueue();
            if (statMode) renderStatTable();
            if (viewMode === 'mobile') renderMobilePanel();
        }, err => console.error('order snapshot error', err));

        pricingDocRef().onSnapshot(d => {
            const v = d.exists ? Number(d.data().pricePerGram) : NaN;
            applyPricePerGram(v > 0 ? v : DEFAULT_PRICE_PER_GRAM);
        }, err => console.error('pricing snapshot error', err));

        // show the emergency "Undo Menu Sync" button only while a backup exists
        menuBackupDocRef().onSnapshot(d => {
            const btn = document.getElementById('restore-menu');
            if (!btn) return;
            btn.hidden = !d.exists;
            if (d.exists) btn.title = `Undo the sync from ${(d.data() || {}).savedAt || 'the last sync'}`;
        }, err => console.error('menuBackup snapshot error', err));
    }

    /* Swap in a new $/gram rate and refresh everything priced with it. */
    function applyPricePerGram(v) {
        PRICE_PER_GRAM = v;
        COST_PER_PAN = PRICE_PER_GRAM * GRAMS_PER_PAN;
        const input = document.getElementById('price-per-gram');
        if (input && document.activeElement !== input) input.value = PRICE_PER_GRAM;
        const perPan = document.getElementById('cost-per-pan-label');
        if (perPan) perPan.textContent = Math.round(COST_PER_PAN).toLocaleString('en-US');
        renderPricing();
        renderUsage();
        if (statMode) renderStatTable();
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
                    shortTerm: 0, longTerm: 0, shortPans: [], longPans: [],
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
                    active: 0, casePan: null, shortTerm: 0, longTerm: 0, shortPans: [], longPans: [],
                    updatedAt: stamp()
                });
                added++;
            });
            if (added) await batch.commit();
        } catch (e) {
            console.error('seedMissingFromMenu failed', e);
        }
    }

    /* ----- Sync case -> menu (this system as source of truth) --------------
     * Pushes the flavors currently in the display case onto the customer menu:
     * case flavors not on the menu get added, menu flavors not in the case get
     * removed, and everything is ordered by pan. A 1-minute visible countdown
     * gives a coordination window so it can't collide with someone editing the
     * menu elsewhere, and the pre-sync menu is snapshotted to gelatoSettings/
     * menuBackup so the "Undo Menu Sync" button can put everything back. */
    let syncCountdownTimer = null;
    let syncInProgress = false;

    /* What the sync would change, computed from the live case + menu. Matches
     * by flavor NAME so a flavor already on the menu under a different doc id
     * counts as "already on menu" (not a duplicate add). */
    function computeMenuSyncPlan() {
        const caseFlavors = casePans().slice().sort((a, b) => a.casePan - b.casePan);
        const menuNames = new Set(menuFlavors.map(m => normName(m.name)));
        const caseNames = new Set(caseFlavors.map(f => normName(f.name)));
        const toAdd = caseFlavors.filter(f => !menuNames.has(normName(f.name)));
        const stay = caseFlavors.filter(f => menuNames.has(normName(f.name)));
        const toRemove = menuFlavors.filter(m => !caseNames.has(normName(m.name)));
        return { caseFlavors, toAdd, stay, toRemove };
    }

    function openSyncToMenuModal() {
        const { caseFlavors, toAdd, stay, toRemove } = computeMenuSyncPlan();
        document.getElementById('g-modal-title').textContent = 'Sync Case → Menu';
        const body = document.getElementById('g-modal-body');
        document.getElementById('g-modal').classList.add('g-modal-wide');

        if (!caseFlavors.length) {
            body.innerHTML = `<p class="g-empty-note">There are no flavors in the case yet, so there's nothing to sync to the menu.</p>`;
            showModal();
            return;
        }

        const col = (title, items, cls, render) => `
            <div class="g-sync-col ${cls}">
                <h4>${title} <span class="g-sync-count">${items.length}</span></h4>
                ${items.length ? `<ul>${items.map(render).join('')}</ul>` : `<p class="g-empty-note">None.</p>`}
            </div>`;

        body.innerHTML = `
            <p class="g-modal-hint">The menu will be set to exactly the <strong>${caseFlavors.length}</strong> flavor(s) currently in the case, ordered by pan. Review the changes, then start the 1-minute sync window.</p>
            <div class="g-sync-preview">
                ${col('Added to menu', toAdd, 'add', f => `<li>Pan ${f.casePan} · ${esc(f.name)}</li>`)}
                ${col('Replaced (removed)', toRemove, 'remove', m => `<li>${esc(m.name || '(unnamed)')}</li>`)}
                ${col('Already on menu', stay, 'stay', f => `<li>Pan ${f.casePan} · ${esc(f.name)}</li>`)}
            </div>
            <div class="g-modal-actions">
                <button type="button" class="g-modal-cancel" id="sync-cancel">Cancel</button>
                <button type="button" class="g-modal-go" id="sync-start">Start 1-minute sync</button>
            </div>`;
        document.getElementById('sync-cancel').addEventListener('click', closeModal);
        document.getElementById('sync-start').addEventListener('click', startSyncCountdown);
        showModal();
    }

    /* Visible 60-second countdown before the sync commits. */
    function startSyncCountdown() {
        cancelSyncCountdown();
        let remaining = 60;
        const body = document.getElementById('g-modal-body');
        body.innerHTML = `
            <p class="g-modal-hint">Syncing shortly — make sure no one else is editing the menu right now. You can still cancel.</p>
            <div class="g-sync-countdown">${remaining}<span>s</span></div>
            <p class="g-modal-hint" style="text-align:center">The case flavors replace the menu when this reaches zero.</p>
            <div class="g-modal-actions">
                <button type="button" class="g-modal-cancel" id="sync-abort">Cancel sync</button>
                <button type="button" class="g-modal-go" id="sync-now">Sync now</button>
            </div>`;
        document.getElementById('sync-abort').addEventListener('click', closeModal);
        document.getElementById('sync-now').addEventListener('click', executeSyncToMenu);
        syncCountdownTimer = setInterval(() => {
            remaining -= 1;
            const el = document.querySelector('.g-sync-countdown');
            if (!el) { cancelSyncCountdown(); return; }   // modal was closed
            if (remaining <= 0) { executeSyncToMenu(); return; }
            el.innerHTML = `${remaining}<span>s</span>`;
        }, 1000);
    }

    function cancelSyncCountdown() {
        if (syncCountdownTimer) { clearInterval(syncCountdownTimer); syncCountdownTimer = null; }
    }

    /* Commit the sync: snapshot the current menu for undo, then rewrite the
     * menu to match the case. Reads the menu fresh at execution time so a
     * late edit elsewhere is captured in the backup rather than lost. */
    async function executeSyncToMenu() {
        if (syncInProgress) return;
        cancelSyncCountdown();
        const caseFlavors = casePans().slice().sort((a, b) => a.casePan - b.casePan);
        if (!caseFlavors.length) { status('No flavors in the case to sync.'); closeModal(); return; }
        syncInProgress = true;
        try {
            status('Syncing case → menu…');
            const [menuSnap, pendingSnap] = await Promise.all([
                db.collection('menuItems').get(),
                db.collection('pendingItems').get()
            ]);
            const currentMenu = menuSnap.docs.map(d => ({ id: d.id, data: d.data() }));
            const pendingById = new Map(pendingSnap.docs.map(d => [d.id, d.data()]));
            // match to existing menu entries by NAME so we update the right doc
            // instead of creating a duplicate under the case flavor's id
            const menuByName = new Map();
            currentMenu.forEach(m => menuByName.set(normName(m.data.name), m));
            const removedPending = [];
            const keptMenuIds = new Set();
            const writtenNames = new Set();   // one menu write per flavor name

            const batch = db.batch();

            // 1) add/refresh each case flavor on the menu, ordered by pan.
            caseFlavors.forEach(f => {
                const key = normName(f.name);
                if (writtenNames.has(key)) return;   // same flavor already handled
                writtenNames.add(key);
                const existing = menuByName.get(key);
                const targetId = existing ? existing.id : f.id;
                keptMenuIds.add(targetId);
                const meta = liveMeta(f.id) || f;
                const payload = {
                    outOfStock: false,
                    temporarilyUnavailable: false,
                    order: f.casePan
                };
                if (!existing) {
                    // brand-new menu entry: carry the name/image over from the flavor
                    payload.name = meta.name || f.name || '(unnamed)';
                    payload.imageURL = meta.imageURL || f.imageURL || '';
                    payload.gelatoImage = meta.gelatoImage || f.gelatoImage || '';
                    // promoting an off-menu flavor consumes its pendingItems copy
                    if (pendingById.has(f.id)) {
                        removedPending.push({ id: f.id, data: pendingById.get(f.id) });
                        batch.delete(db.collection('pendingItems').doc(f.id));
                    }
                }
                batch.set(db.collection('menuItems').doc(targetId), payload, { merge: true });
            });

            // 2) menu items whose flavor isn't in the case anymore move to
            // pending instead of being deleted outright - preserves the full
            // record (name, description, images, order, flags, etc.) so the
            // flavor can be brought back later. Mirrors the admin panel's
            // "Remove from Menu" action exactly (admin-script.js:
            // db.collection('pendingItems').add(itemData) then delete the
            // menuItems doc) - db.collection('pendingItems').doc() here is
            // the batch-compatible equivalent of .add() (same auto-id
            // behavior), so the pending copy and the menuItems delete land
            // in the same atomic batch as the rest of the sync.
            const toRemove = currentMenu.filter(m => !keptMenuIds.has(m.id));
            const toAdd = caseFlavors.filter(f => !menuByName.has(normName(f.name)));
            toRemove.forEach(m => {
                batch.set(db.collection('pendingItems').doc(), m.data);
                batch.delete(db.collection('menuItems').doc(m.id));
            });

            // 3) snapshot pre-sync state so the emergency undo can restore it
            batch.set(menuBackupDocRef(), {
                at: stamp(),
                savedAt: new Date().toLocaleString(),
                menuItems: currentMenu.map(m => ({ id: m.id, data: m.data })),
                removedPending
            });

            await batch.commit();
            logMove('menu-sync', `Synced case → menu: ${caseFlavors.length} on menu (+${toAdd.length} added, ${toRemove.length} replaced)`);
            status(`Menu synced to the case — ${caseFlavors.length} flavor(s). Use "Undo Menu Sync" to revert.`, true);
            closeModal();
        } catch (e) {
            console.error('executeSyncToMenu failed', e);
            status('Sync failed — see console. The menu was not changed.');
        } finally {
            syncInProgress = false;
        }
    }

    /* Emergency restore: put the menu back exactly as it was before the last
     * sync, and re-create any pendingItems the sync consumed. */
    async function restoreMenuBackup() {
        try {
            const snap = await menuBackupDocRef().get();
            if (!snap.exists) { status('No menu backup found to restore.'); return; }
            const b = snap.data() || {};
            const savedList = Array.isArray(b.menuItems) ? b.menuItems : [];
            const savedPending = Array.isArray(b.removedPending) ? b.removedPending : [];
            if (!confirm(
                `Restore the menu to its state before the last sync (${b.savedAt || 'unknown time'})?\n\n` +
                `This puts back ${savedList.length} menu item(s) and undoes the sync.`
            )) return;

            status('Restoring menu…');
            const menuSnap = await db.collection('menuItems').get();
            const savedIds = new Set(savedList.map(m => m.id));
            const batch = db.batch();
            // Anything on the menu right now that the restored (pre-sync) menu
            // doesn't include moves to pending instead of being deleted outright
            // - same principle as the sync fix: preserves the full record so it
            // can be brought back later. Items present in both just get
            // overwritten by the savedList.forEach below, so they're skipped
            // here to avoid writing them to pending too.
            menuSnap.docs.forEach(d => {
                if (savedIds.has(d.id)) return;
                batch.set(db.collection('pendingItems').doc(), d.data());
                batch.delete(db.collection('menuItems').doc(d.id));
            });
            savedList.forEach(m => batch.set(db.collection('menuItems').doc(m.id), m.data));
            savedPending.forEach(p => batch.set(db.collection('pendingItems').doc(p.id), p.data));
            batch.delete(menuBackupDocRef());   // clears the backup -> hides the Undo button
            await batch.commit();
            logMove('menu-restore', `Emergency restore — put the menu back to ${b.savedAt || 'its pre-sync state'} (${savedList.length} item(s))`);
            status('Menu restored to its pre-sync state.', true);
        } catch (e) {
            console.error('restoreMenuBackup failed', e);
            status('Restore failed — see console.');
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
        document.getElementById('sync-to-menu').addEventListener('click', openSyncToMenuModal);
        document.getElementById('restore-menu').addEventListener('click', restoreMenuBackup);
        const pickMode = m => { localStorage.setItem('gelatoViewMode', m); setMode(m); };
        document.getElementById('mode-visual').addEventListener('click', () => pickMode('visual'));
        document.getElementById('mode-stats').addEventListener('click', () => pickMode('stats'));
        document.getElementById('mode-mobile').addEventListener('click', () => pickMode('mobile'));
        // restore the last chosen view; small screens start in Mobile by default
        const savedMode = localStorage.getItem('gelatoViewMode');
        if (savedMode === 'stats' || savedMode === 'mobile') setMode(savedMode);
        else if (!savedMode && window.matchMedia('(max-width: 640px)').matches) setMode('mobile');

        document.getElementById('price-per-gram').addEventListener('change', async e => {
            const v = Number(e.target.value);
            if (!(v > 0)) {
                status('Price per gram must be greater than 0.');
                e.target.value = PRICE_PER_GRAM;
                return;
            }
            try {
                await pricingDocRef().set({ pricePerGram: v, updatedAt: stamp() }, { merge: true });
                applyPricePerGram(v);
                logMove('adjust', `Set gelato price to $${v}/g (~${money(v * GRAMS_PER_PAN)}/pan)`);
                status(`Price set to $${v}/g (~${money(v * GRAMS_PER_PAN)}/pan).`, true);
            } catch (err) {
                console.error('save price failed', err);
                status('Saving the price failed — see console.');
                e.target.value = PRICE_PER_GRAM;
            }
        });

        document.getElementById('size-18').addEventListener('click', () => setCaseSize(18));
        document.getElementById('size-12').addEventListener('click', () => setCaseSize(12));
        applyCaseSize();

        document.getElementById('add-to-case').addEventListener('click', () => {
            const pan = firstFreePan();
            if (!pan) { status(`The case is full (${CASE_SLOTS} pans).`); return; }
            openAssignModal(pan);
        });
        document.getElementById('assign-long').addEventListener('click', () => openFreezerAssignModal('longTerm'));
        document.getElementById('close-case').addEventListener('click', closeCase);
        document.getElementById('save-snapshot').addEventListener('click', saveSnapshot);
        document.getElementById('reload-case').addEventListener('click', reloadCase);
        document.getElementById('reset-usage').addEventListener('click', resetUsage);

        document.getElementById('transferForm').addEventListener('submit', onTransfer);
        document.getElementById('merge-pans-btn').addEventListener('click', () => openMergeModal());
        document.getElementById('t-from').addEventListener('change', () => { renderTransferAmounts(); refreshTransferHint(); });
        document.getElementById('t-to').addEventListener('change', refreshTransferHint);
        document.getElementById('t-flavor').addEventListener('change', () => { renderTransferAmounts(); refreshTransferHint(); });

        document.getElementById('addStockForm').addEventListener('submit', onAddStock);
        document.getElementById('as-loc').addEventListener('change', refreshStockHint);
        document.getElementById('as-flavor').addEventListener('change', refreshStockHint);
        document.getElementById('as-source').addEventListener('change', () => {
            renderStockFlavors();
            refreshStockHint();
        });

        document.getElementById('stageForm').addEventListener('submit', onStage);
        document.getElementById('queue-clear').addEventListener('click', clearQueue);

        document.getElementById('orderAddForm').addEventListener('submit', e => {
            e.preventDefault();
            addToOrder(document.getElementById('order-flavor').value);
        });
        document.getElementById('order-source').addEventListener('change', renderOrderQueue);
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

    function setMode(mode) {
        viewMode = mode;
        statMode = mode === 'stats';
        [['mode-visual', 'visual'], ['mode-stats', 'stats'], ['mode-mobile', 'mobile']].forEach(([id, m]) => {
            const btn = document.getElementById(id);
            if (btn) btn.classList.toggle('active', mode === m);
        });
        document.querySelectorAll('.visual-only').forEach(el => { el.hidden = mode !== 'visual'; });
        document.querySelectorAll('.stats-only').forEach(el => { el.hidden = mode !== 'stats'; });
        document.querySelectorAll('.mobile-only').forEach(el => { el.hidden = mode !== 'mobile'; });
        // hides the always-on sections (pricing, forms, log…) via CSS in mobile mode
        document.body.classList.toggle('g-mobile', mode === 'mobile');
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
    // a freezer holds a number of physical pan SLOTS: each individual pan
    // (full or partial) takes one slot, so two 0.5 pans use two slots.
    const panCount = (f, loc) => pansOf(f, loc).length;
    const slotsUsed = loc => flavors.reduce((s, f) => s + panCount(f, loc), 0);
    const slotsOpen = loc => (loc === 'shortTerm' ? SHORT_CAP : LONG_CAP) - slotsUsed(loc);
    /* Slots the freezer would use if a flavor's pan list in `loc` became newArr. */
    const slotsAfter = (loc, flavorId, newArr) => {
        const f = byId(flavorId);
        return slotsUsed(loc) - (f ? panCount(f, loc) : 0) + newArr.length;
    };
    const casePans = () => flavors.filter(f => f.casePan);
    const storageStock = f => r2((f.shortTerm || 0) + (f.longTerm || 0));
    // the case is only ever filled from SHORT-TERM storage
    const caseStock = f => r2(f.shortTerm || 0);
    // gelato-only pan total for a location — excludes dummy (non-flavor)
    // placeholder pans so $ value / "gelato" quantity figures aren't polluted
    // by things like a "Mini Cones" pan. Slot/capacity counts (slotsUsed,
    // sumLoc, the freezer cap bars) stay inclusive since dummy pans DO take
    // up real physical space.
    const sumLocGelato = loc => r2(flavors.filter(f => !f.isDummy).reduce((s, f) => s + (f[loc] || 0), 0));

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
        renderTransferAmounts();
        renderStockFlavors();
        if (viewMode === 'stats') {
            renderStatsPanel();
        } else if (viewMode === 'mobile') {
            renderMobilePanel();
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
        // gelato-only for Long-Term: a dummy pan (mini cones, packaging, etc.)
        // isn't worth $262 and shouldn't inflate the inventory value cards
        const a = activePans(), s = sumLoc('shortTerm'), l = sumLocGelato('longTerm');
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
        if (viewMode === 'mobile') renderMobilePanel();
    }

    /* ----- Mobile mode ------------------------------------------------------
     * A single compact overview built for phone screens: headline tiles up
     * top (the "partially graphical" part), then dense info rows for the
     * case, both freezers, the swap queue, the order list and recent moves.
     * The day-to-day actions work right here — serve/empty/return case pans,
     * execute or remove swaps, manage the order list. Bigger jobs (assign,
     * transfer, intake, snapshots) live in Visual mode. */
    function renderMobilePanel() {
        const el = document.getElementById('mobile-body');
        if (!el) return;

        const inCase = casePans().slice().sort((a, b) => a.casePan - b.casePan);
        const lowPans = inCase.filter(f => (f.active || 0) <= SWAP_THRESHOLD + EPS);
        const caseAmt = activePans();
        const total = r2(caseAmt + sumLoc('shortTerm') + sumLocGelato('longTerm'));
        const used = r2(usageToday.usedPans || 0);

        // headline tiles
        const tiles = [
            ['Total value', money(total * COST_PER_PAN), `${total} pans on hand`, ''],
            ['Used today', money(used * COST_PER_PAN), `${used} pans served`, ''],
            ['Case', `${inCase.length} / ${CASE_SLOTS}`, `${caseAmt} pans of gelato`, ''],
            ['Low pans', String(lowPans.length),
                lowPans.length ? 'need a swap soon' : `all above ${SWAP_THRESHOLD}`,
                lowPans.length ? 'red' : 'green']
        ];
        let html = `<div class="g-mob-tiles">` + tiles.map(([label, val, sub, tone]) => `
            <div class="g-mob-tile">
                <div class="g-mob-tile-val ${tone}">${val}</div>
                <div class="g-mob-tile-label">${esc(label)}</div>
                <div class="g-mob-tile-sub">${esc(sub)}</div>
            </div>`).join('') + `</div>`;

        // the case — info line + action line per pan
        html += `<h3 class="g-mob-h">The Case</h3>`;
        html += inCase.length
            ? `<div class="g-mob-list">` + inCase.map(f => {
                const pct = Math.round(Math.max(0, Math.min(1, f.active || 0)) * 100);
                const low = (f.active || 0) <= SWAP_THRESHOLD + EPS;
                return `
                <div class="g-mob-row ${low ? 'low' : ''}">
                    <span class="g-mob-pan">P${f.casePan}</span>
                    <span class="g-mob-name">${esc(f.name)}</span>
                    <span class="g-mob-meter"><span style="width:${pct}%"></span></span>
                    <span class="g-mob-amt">${r2(f.active)}${low ? ' · SWAP' : ''}</span>
                    <span class="g-mob-acts">
                        <select class="g-mob-use-amt" data-id="${f.id}" aria-label="Amount to use">${USE_OPTIONS}</select>
                        <button type="button" class="g-mob-btn" data-act="mob-use" data-id="${f.id}">− Use</button>
                        <button type="button" class="g-mob-btn" data-act="mob-short" data-id="${f.id}">→ Short</button>
                        <button type="button" class="g-mob-btn danger" data-act="mob-empty" data-id="${f.id}">Empty</button>
                    </span>
                </div>`;
            }).join('') + `</div>`
            : `<p class="g-empty-note">The case is empty.</p>`;

        // freezers — capacity bar + a row per stored flavor
        const freezerBlock = (label, loc, cap) => {
            const usedSlots = slotsUsed(loc);
            const items = withAmt(loc);
            let block = `<h3 class="g-mob-h">${label}</h3>
            <div class="g-mob-capbar"><span style="width:${Math.min(100, (usedSlots / cap) * 100)}%"></span>
                <em>${usedSlots} / ${cap} slots · ${sumLoc(loc)} pans</em></div>`;
            block += items.length
                ? `<div class="g-mob-list">` + items.map(f => {
                    const amt = f[loc] || 0;
                    const slots = panCount(f, loc);
                    return `
                    <div class="g-mob-row">
                        <span class="g-dot ${freezerTone(amt)}"></span>
                        <span class="g-mob-name">${esc(f.name)}</span>
                        <span class="g-mob-amt">${r2(amt)} pans · ${slots} slot${slots === 1 ? '' : 's'}</span>
                    </div>`;
                }).join('') + `</div>`
                : `<p class="g-empty-note">No pans stored here.</p>`;
            return block;
        };
        html += freezerBlock('Short-Term Freezer', 'shortTerm', SHORT_CAP);
        html += freezerBlock('Long-Term Freezer', 'longTerm', LONG_CAP);

        // swap queue — execute / remove work right here
        html += `<h3 class="g-mob-h">Swap Queue</h3>`;
        html += queue.length
            ? `<div class="g-mob-list">` + queue.slice().sort((a, b) => a.pan - b.pan).map(q => {
                const i = queue.indexOf(q);
                const target = flavors.find(f => f.casePan === q.pan);
                const ready = !target || (target.active || 0) <= SWAP_THRESHOLD + EPS;
                return `
                <div class="g-mob-row">
                    <span class="g-mob-name">${esc(nameById(q.flavorId) || q.name)} → Pan ${q.pan}</span>
                    <span class="g-mob-state ${ready ? 'ready' : ''}">${ready ? 'READY' : `waiting · ${r2(target.active)}`}</span>
                    <button type="button" class="g-mob-btn go" data-act="mob-exec" data-i="${i}">Execute</button>
                    <button type="button" class="g-mob-btn danger" data-act="mob-qdel" data-i="${i}" aria-label="Remove swap">✕</button>
                </div>`;
            }).join('') + `</div>`
            : `<p class="g-empty-note">Nothing staged.</p>`;

        // production order list — add and remove flavors
        html += `<h3 class="g-mob-h">Order Queue (flavors to make)</h3>`;
        html += orderQueue.length
            ? `<div class="g-mob-list">` + orderQueue.map((o, i) => `
                <div class="g-mob-row">
                    <span class="g-mob-pan">${i + 1}</span>
                    <span class="g-mob-name">${esc(nameById(o.flavorId) || o.name)}</span>
                    <button type="button" class="g-mob-btn go" data-act="mob-odel" data-i="${i}"
                        title="Made it — adds 1.0 pan to Short-Term and clears it from the list"
                        aria-label="Made — move 1 pan to short-term">✕</button>
                </div>`).join('') + `</div>`
            : `<p class="g-empty-note">No flavors queued for production.</p>`;
        html += `<form class="g-mob-add" id="mob-order-form">
            <select id="mob-order-flavor" aria-label="Flavor to queue">${menuFlavors.map(f =>
                `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</select>
            <button type="submit" class="g-mob-btn go">+ Add to order</button>
        </form>`;

        // last few moves
        html += `<h3 class="g-mob-h">Recent Moves</h3>`;
        const recent = moves.slice(0, 6);
        html += recent.length
            ? `<div class="g-mob-list">` + recent.map(m => {
                const when = m.at && m.at.toDate
                    ? m.at.toDate().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' })
                    : '…';
                return `
                <div class="g-mob-row">
                    <span class="g-mob-name g-mob-wrap">${esc(m.text || '')}</span>
                    <span class="g-mob-time">${when}</span>
                </div>`;
            }).join('') + `</div>`
            : `<p class="g-empty-note">No moves recorded yet.</p>`;

        html += `<p class="g-mob-note">Compact view — assigning pans, transfers and intake live in Visual mode.</p>`;
        el.innerHTML = html;

        // wire the actions (innerHTML wiped any previous listeners)
        el.querySelectorAll('[data-act="mob-use"]').forEach(b => b.addEventListener('click', () => {
            const sel = el.querySelector(`.g-mob-use-amt[data-id="${b.dataset.id}"]`);
            serve(b.dataset.id, parseFloat(sel ? sel.value : '0'));
        }));
        el.querySelectorAll('[data-act="mob-short"]').forEach(b =>
            b.addEventListener('click', () => caseToShort(b.dataset.id)));
        el.querySelectorAll('[data-act="mob-empty"]').forEach(b =>
            b.addEventListener('click', () => emptyPan(b.dataset.id)));
        el.querySelectorAll('[data-act="mob-exec"]').forEach(b =>
            b.addEventListener('click', () => executeSwap(Number(b.dataset.i))));
        el.querySelectorAll('[data-act="mob-qdel"]').forEach(b =>
            b.addEventListener('click', () => removeFromQueue(Number(b.dataset.i))));
        el.querySelectorAll('[data-act="mob-odel"]').forEach(b =>
            b.addEventListener('click', () => completeOrder(Number(b.dataset.i))));
        const orderForm = document.getElementById('mob-order-form');
        if (orderForm) orderForm.addEventListener('submit', e => {
            e.preventDefault();
            const sel = document.getElementById('mob-order-flavor');
            if (sel && sel.value) addToOrder(sel.value);
        });
    }

    /* Predictively stage a same-flavor refill for any case pan that has
     * short-term stock to pull from — even before it hits the red. Also
     * reconciles the queue against reality: an entry whose replacement
     * flavor no longer has short-term stock (moved/transferred away after
     * being staged) is dropped instead of sitting there falsely "READY". */
    function autoStageLowPans() {
        // never write until the saved queue has loaded, or we'd clobber it
        if (!queueLoaded) return;

        const stale = queue.filter(q => {
            const f = byId(q.flavorId);
            return !f || caseStock(f) <= EPS;
        });

        const additions = [];
        casePans().forEach(f => {
            // predictive: stage a refill for ANY pan that has a short-term
            // replacement ready, even before it drops into the red
            if (caseStock(f) > EPS && !queue.some(q => q.pan === f.casePan)
                    && !autoStageExcluded.has(`${f.casePan}|${f.id}`)) {
                additions.push({ pan: f.casePan, flavorId: f.id, name: f.name });
            }
        });

        if ((!additions.length && !stale.length) || autoStageLock) return;
        autoStageLock = true;
        const next = queue.filter(q => !stale.includes(q)).concat(additions);
        queueDocRef().set({ queue: next }, { merge: true })
            .then(() => {
                stale.forEach(q => logMove('auto-stage',
                    `Removed stale swap (${nameById(q.flavorId) || q.name} → Pan ${q.pan}) — no longer has short-term backup`));
                additions.forEach(a => logMove('auto-stage', `Auto-staged ${a.name} refill → Pan ${a.pan}`));
            })
            .catch(err => { autoStageLock = false; console.error('autoStage failed', err); });
    }

    /* Bulk-clear the swap queue and let auto-stage reassign fresh
     * recommendations from scratch (unlike per-item Remove, this also drops
     * the manual-exclusion memory so nothing is held back from re-staging). */
    async function clearQueue() {
        if (!queue.length) return;
        if (!confirm('Clear the entire swap queue?\n\nFresh recommendations will be re-staged automatically for any pan that still qualifies.')) return;
        autoStageExcluded.clear();
        await queueDocRef().set({ queue: [] });
        logMove('reset', 'Cleared the swap queue — recommendations will be reassigned');
        status('Swap queue cleared — recommendations refreshing.', true);
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

        // right-click a filled pan for a shortcut menu of the same pan
        // movements as the buttons below it (merge / empty / short / trash)
        wrap.querySelectorAll('.g-pan[data-id]').forEach(panEl => {
            panEl.addEventListener('contextmenu', e => {
                e.preventDefault();
                const id = panEl.dataset.id;
                const f = byId(id);
                if (!f) return;
                showContextMenu(e.clientX, e.clientY, [
                    { label: `Merge into Pan ${f.casePan}…`, action: () => openMergeModal(f.id) },
                    { label: 'Send remainder to Short-Term', action: () => caseToShort(id) },
                    { label: 'Empty pan (use up remainder)', action: () => emptyPan(id) },
                    { divider: true },
                    { label: 'Discard pan (trash, not counted)', danger: true, action: () => discardPan(id) }
                ]);
            });
        });
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
            const arr = pansOf(f, loc);

            if (f.isDummy) {
                // a placeholder pan for whatever isn't a gelato flavor (mini
                // cones, packaging…) — just a "slot occupied" chip + a
                // top-right editable label, no amount/adjust UI since there's
                // no meaningful fractional fill level to speak of
                const chips = arr.map((amt, idx) => {
                    const key = `${f.id}|${loc}|${idx}|${r2(amt)}`;
                    return `<span class="g-pan-chip dummy" data-id="${f.id}" data-loc="${loc}" data-idx="${idx}" data-amt="${r2(amt)}" data-key="${key}">` +
                        `occupied <button type="button" class="g-pan-chip-remove" title="Remove this pan">✕</button>` +
                        `</span>`;
                }).join('');
                html += `
                <div class="g-frz-tub g-frz-dummy">
                    <div class="g-dummy-head">
                        <span class="g-dummy-tag">Dummy pan</span>
                        <input type="text" class="g-dummy-label" data-id="${f.id}" value="${esc(f.name)}"
                            maxlength="60" placeholder="What's in here?" aria-label="Dummy pan label">
                    </div>
                    <div class="g-pan-chips">${chips}</div>
                    <div class="g-frz-amt">${arr.length} slot${arr.length === 1 ? '' : 's'} used · not counted as gelato stock</div>
                </div>`;
                return;
            }

            const tone = freezerTone(f[loc] || 0);
            // one chip per physical pan — collapsed shows amount + ✕; clicking amount expands to −/+
            const chips = arr.map((amt, idx) => {
                const t = freezerTone(amt >= 1 - EPS ? 3 : 1);   // full pan green, partial red-ish
                // key encodes the rendered value so a stale key doesn't match a shifted index
                const key = `${f.id}|${loc}|${idx}|${r2(amt)}`;
                if (openPanChips.has(key)) {
                    return `<span class="g-pan-chip ${t} is-open" data-id="${f.id}" data-loc="${loc}" data-idx="${idx}" data-amt="${r2(amt)}" data-key="${key}">` +
                        `<button type="button" class="g-pan-chip-minus">−</button>` +
                        `<span class="g-pan-chip-val">${r2(amt)}</span>` +
                        `<button type="button" class="g-pan-chip-plus">+</button>` +
                        `<button type="button" class="g-pan-chip-remove" title="Remove this pan">✕</button>` +
                        `</span>`;
                }
                return `<span class="g-pan-chip ${t}" data-id="${f.id}" data-loc="${loc}" data-idx="${idx}" data-amt="${r2(amt)}" data-key="${key}">` +
                    `<button type="button" class="g-pan-chip-amt" title="Adjust amount">${r2(amt)}</button>` +
                    `<button type="button" class="g-pan-chip-remove" title="Remove this pan">✕</button>` +
                    `</span>`;
            }).join('');
            const img = flavorImage(f);
            const swatch = img ? `style="background-image:url('${img}')"` : '';
            html += `
            <div class="g-frz-tub tone-${tone}">
                <div class="g-frz-swatch" ${swatch}></div>
                <div class="g-frz-info">
                    <div class="g-frz-name">${esc(f.name)}</div>
                    <div class="g-pan-chips">${chips}</div>
                    <div class="g-frz-amt"><span class="g-dot ${tone}"></span>${r2(f[loc])} pans · ${arr.length} slot${arr.length === 1 ? '' : 's'}</div>
                </div>
            </div>`;
        });
        html += `</div>`;
        wrap.innerHTML = html;

        // dummy pans: editable label, saved on change/Enter
        wrap.querySelectorAll('.g-dummy-label').forEach(input => {
            input.addEventListener('change', () => renameDummyPan(input.dataset.id, input.value));
            input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
        });
        // auto-focus a just-created dummy pan's label so it's ready to type into
        if (pendingDummyFocusId) {
            const toFocus = wrap.querySelector(`.g-dummy-label[data-id="${pendingDummyFocusId}"]`);
            if (toFocus) { toFocus.focus(); toFocus.select(); pendingDummyFocusId = null; }
        }

        // collapsed: click amount to open
        wrap.querySelectorAll('.g-pan-chip-amt').forEach(btn => {
            const chip = btn.closest('.g-pan-chip');
            btn.addEventListener('click', () => {
                openPanChips.add(chip.dataset.key);
                renderFreezer(prefix, loc, cap);
            });
        });

        // expanded: − and + step by 0.1, save immediately
        wrap.querySelectorAll('.g-pan-chip-minus, .g-pan-chip-plus').forEach(btn => {
            const chip = btn.closest('.g-pan-chip');
            btn.addEventListener('click', () => {
                const valEl = chip.querySelector('.g-pan-chip-val');
                const cur = r2(Number(valEl.textContent));
                const delta = btn.classList.contains('g-pan-chip-plus') ? 0.1 : -0.1;
                const next = r2(Math.max(0.1, Math.min(1.0, cur + delta)));
                if (Math.abs(next - cur) < EPS) return;
                valEl.textContent = next;
                adjustStoragePan(chip.dataset.id, chip.dataset.loc, Number(chip.dataset.idx), next);
            });
        });

        // remove button (works in both states)
        wrap.querySelectorAll('.g-pan-chip-remove').forEach(btn => {
            const chip = btn.closest('.g-pan-chip');
            btn.addEventListener('click', async () => {
                const removed = await emptyStoragePan(
                    chip.dataset.id, chip.dataset.loc, Number(chip.dataset.idx),
                    Number(chip.dataset.amt), chip.dataset.key);
                if (removed) {
                    // a removal shifts all subsequent indices — clear all expand-state
                    // keys for this flavor/loc so no chip re-opens at the wrong position
                    const prefix = `${chip.dataset.id}|${chip.dataset.loc}|`;
                    for (const k of [...openPanChips]) {
                        if (k.startsWith(prefix)) openPanChips.delete(k);
                    }
                }
            });
        });

        // right-click a chip for a shortcut menu of pan movements — always
        // scoped to that exact chip's id+loc+idx+amt, so with more than one
        // pan of a flavor in this freezer the right one is always the target
        wrap.querySelectorAll('.g-pan-chip').forEach(chip => {
            chip.addEventListener('contextmenu', e => {
                e.preventDefault();
                const chipId = chip.dataset.id, chipLoc = chip.dataset.loc;
                const idx = Number(chip.dataset.idx), amt = Number(chip.dataset.amt);
                const f = byId(chipId);
                if (!f) return;

                if (f.isDummy) {
                    const items = [
                        { label: 'Edit label', action: () => focusDummyLabel(chipId) },
                        { divider: true },
                        { label: 'Remove this pan', danger: true, action: () => emptyStoragePan(chipId, chipLoc, idx, amt, chip.dataset.key) }
                    ];
                    if (chipLoc === 'longTerm') items.push({ divider: true }, { label: '+ Add Dummy Pan', action: addDummyPan });
                    showContextMenu(e.clientX, e.clientY, items);
                    return;
                }

                const other = chipLoc === 'shortTerm' ? 'longTerm' : 'shortTerm';
                const items = [
                    { label: `Move this ${amt} pan to Case`, action: () => moveSpecificPan(chipId, chipLoc, idx, amt, 'active') },
                    { label: `Move this ${amt} pan to ${LOCATION_LABELS[other]}`, action: () => moveSpecificPan(chipId, chipLoc, idx, amt, other) },
                    { label: `Use / serve this ${amt} pan`, action: () => moveSpecificPan(chipId, chipLoc, idx, amt, 'use') },
                    { divider: true },
                    { label: 'Remove this pan', danger: true, action: () => emptyStoragePan(chipId, chipLoc, idx, amt, chip.dataset.key) }
                ];
                if (chipLoc === 'longTerm') items.push({ divider: true }, { label: '+ Add Dummy Pan', action: addDummyPan });
                showContextMenu(e.clientX, e.clientY, items);
            });
        });

        // right-click empty freezer background (Long-Term only) to create a
        // new dummy pan — attached once to the wrap itself since innerHTML
        // above only replaces its children, not the wrap element
        if (loc === 'longTerm' && !longFreezerCtxAttached) {
            longFreezerCtxAttached = true;
            wrap.addEventListener('contextmenu', e => {
                if (e.target.closest('.g-pan-chip, .g-frz-tub')) return;  // handled by the chip's own menu above
                e.preventDefault();
                showContextMenu(e.clientX, e.clientY, [
                    { label: '+ Add Dummy Pan (mini cones, packaging, etc.)', action: addDummyPan }
                ]);
            });
        }

        // one-time document handlers for Escape and click-outside
        if (!chipHandlersAttached) {
            chipHandlersAttached = true;
            document.addEventListener('keydown', e => {
                if (e.key === 'Escape' && openPanChips.size) {
                    openPanChips.clear();
                    renderFreezer('short', 'shortTerm', SHORT_CAP);
                    renderFreezer('long', 'longTerm', LONG_CAP);
                }
            });
            document.addEventListener('mousedown', e => {
                if (!openPanChips.size) return;
                if (!e.target.closest('.g-pan-chip.is-open')) {
                    openPanChips.clear();
                    renderFreezer('short', 'shortTerm', SHORT_CAP);
                    renderFreezer('long', 'longTerm', LONG_CAP);
                }
            });
        }
    }

    /* Empty a single freezer pan (click a chip). Removes just that pan.
     * expectedAmt and key come from the chip's data attributes so we can
     * detect stale indices and delete the expand-state key only after confirm. */
    async function emptyStoragePan(id, loc, idx, expectedAmt, key) {
        const f = byId(id);
        if (!f) return false;
        const arr = pansOf(f, loc);
        const amt = arr[idx];
        if (amt == null || Math.abs(r2(amt) - r2(expectedAmt)) > EPS) {
            status('Pan data changed — please wait for the page to refresh.');
            return false;
        }
        if (!confirm(`Empty this ${r2(amt)} pan of ${f.name} from ${LOCATION_LABELS[loc]}?`)) return false;
        if (key) openPanChips.delete(key);  // delete only after the user confirms (not before)
        const next = arr.slice();
        next.splice(idx, 1);
        await doc(id).update(setPans({ updatedAt: stamp() }, loc, next));
        logMove('empty', `Emptied a ${r2(amt)} pan of ${f.name} from ${LOCATION_LABELS[loc]}`);
        return true;
    }

    /* Adjust the fill amount of a single freezer pan. */
    async function adjustStoragePan(id, loc, idx, newAmt) {
        const f = byId(id);
        if (!f) return;
        const arr = pansOf(f, loc);
        if (arr[idx] == null) { status('Pan data changed — please wait for the page to refresh.'); return; }
        const clamped = r2(Math.max(0.1, Math.min(1, newAmt)));
        if (Math.abs(clamped - arr[idx]) < EPS) return;
        const next = arr.slice();
        next[idx] = clamped;
        await doc(id).update(setPans({ updatedAt: stamp() }, loc, next));
        logMove('adjust', `Adjusted pan of ${f.name} in ${LOCATION_LABELS[loc]} from ${r2(arr[idx])} to ${clamped}`);
    }

    // ----- Stat mode -------------------------------------------------------
    function renderStatsPanel() {
        const occ = casePans().length;
        const lowCount = casePans().filter(f => (f.active || 0) <= SWAP_THRESHOLD + EPS).length;
        const caseFill = r2(casePans().reduce((s, f) => s + (f.active || 0), 0));
        const short = sumLoc('shortTerm');
        const long = sumLocGelato('longTerm');  // "Total gelato" shouldn't count dummy pans
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
        bars('stat-long', withAmt('longTerm').filter(f => !f.isDummy).map(f => ({ name: f.name, val: f.longTerm || 0 })),
            Math.max(LONG_CAP / 4, maxVal('longTerm')), false);
        renderCaseBackup();

        renderStatTable();
        renderOrderQueue();
    }

    /* Short-term "backup" for a flavor = every short-term pan sharing that
     * flavor's name, summed across all inventory docs (stock for one flavor
     * can sit under a different doc id than the case pan). Returns the pan
     * total and the number of physical slots. */
    function shortTermBackupFor(name) {
        const key = normName(name);
        let slots = 0, pans = 0;
        flavors.forEach(f => {
            if (normName(f.name) !== key) return;
            slots += panCount(f, 'shortTerm');
            pans += (f.shortTerm || 0);
        });
        return { slots, pans: r2(pans) };
    }

    /* Every flavor currently in the case, alongside whether it has a
     * same-flavor replacement pan sitting in the short-term freezer — i.e.
     * whether it's safe to swap in without waiting on a fresh pan. Reuses the
     * .g-bar-row markup so this card matches "Case fill by pan" next to it:
     * same row height/columns, so the two cards line up at the same size.
     * Rows also flag whether a swap is already staged in the queue. */
    function renderCaseBackup() {
        const el = document.getElementById('stat-case-backup');
        if (!el) return;
        const inCase = casePans().slice().sort((a, b) => a.casePan - b.casePan);
        if (!inCase.length) { el.innerHTML = `<p class="g-empty-note">The case is empty.</p>`; return; }
        const m = Math.max(2, ...inCase.map(f => shortTermBackupFor(f.name).slots));
        el.innerHTML = inCase.map(f => {
            const backupPans = shortTermBackupFor(f.name).slots;
            const hasBackup = backupPans > 0;
            const queued = queue.some(q => q.pan === f.casePan);
            const pct = hasBackup ? Math.max(6, (backupPans / m) * 100) : 3;
            const label = `Pan ${f.casePan} · ${f.name}${queued ? ' 🔄' : ''}`;
            const title = queued
                ? 'Click to see the staged swap'
                : (hasBackup ? `${backupPans} backup pan${backupPans === 1 ? '' : 's'} ready` : 'No backup pan in short-term');
            return `
            <div class="g-bar-row">
                <span class="g-bar-label ${queued ? 'is-queued' : ''}"
                    ${queued ? `data-pan="${f.casePan}"` : ''} title="${esc(title)}">${esc(label)}</span>
                <span class="g-bar-track"><span class="g-bar ${hasBackup ? '' : 'low'}" style="width:${pct}%"></span></span>
                <span class="g-bar-val">${backupPans}</span>
            </div>`;
        }).join('');
        el.querySelectorAll('.g-bar-label.is-queued').forEach(node => {
            node.addEventListener('click', e => {
                e.stopPropagation();
                const info = queueStageMessage(Number(node.dataset.pan));
                if (info) showStagePopup(node, info);
            });
        });
    }

    /* Ready/waiting status for a pan's queued swap — same logic
     * renderQueueList() uses, surfaced here for the click-to-check on the
     * Case → Short-Term Backup card. */
    function queueStageMessage(pan) {
        const q = queue.find(x => x.pan === pan);
        if (!q) return null;
        const name = nameById(q.flavorId) || q.name;
        const target = flavors.find(f => f.casePan === pan);
        if (!target) return { ready: true, text: `${name} → Pan ${pan}: READY (pan is empty).` };
        const lvl = target.active || 0;
        return lvl <= SWAP_THRESHOLD + EPS
            ? { ready: true, text: `${name} → Pan ${pan}: READY — pan is at ${r2(lvl)}.` }
            : { ready: false, text: `${name} → Pan ${pan}: staged, waiting — pan still at ${r2(lvl)} (swaps in at ${SWAP_THRESHOLD}).` };
    }

    /* Popover anchored right next to whatever was clicked, so checking a
     * swap's stage never requires scrolling up to the status bar. */
    let stagePopupHandlersAttached = false;
    function showStagePopup(anchorEl, info) {
        const popup = document.getElementById('g-stage-popup');
        if (!popup) return;
        popup.textContent = info.text;
        popup.className = `g-stage-popup ${info.ready ? 'ready' : 'wait'}`;
        popup.hidden = false;

        const rect = anchorEl.getBoundingClientRect();
        popup.style.top = `${rect.bottom + 8}px`;
        popup.style.left = `${rect.left}px`;
        // clamp inside the viewport once we know the popup's rendered size
        requestAnimationFrame(() => {
            const maxLeft = window.innerWidth - popup.offsetWidth - 8;
            popup.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
            const maxTop = window.innerHeight - popup.offsetHeight - 8;
            if (rect.bottom + 8 > maxTop) popup.style.top = `${Math.max(8, rect.top - popup.offsetHeight - 8)}px`;
        });

        if (!stagePopupHandlersAttached) {
            stagePopupHandlersAttached = true;
            document.addEventListener('click', hideStagePopup);
            document.addEventListener('keydown', e => { if (e.key === 'Escape') hideStagePopup(); });
            window.addEventListener('scroll', hideStagePopup, true);
            window.addEventListener('resize', hideStagePopup);
        }
    }

    function hideStagePopup() {
        const popup = document.getElementById('g-stage-popup');
        if (popup) popup.hidden = true;
    }

    /* ----- Right-click context menu ----------------------------------------
     * Generic small popup menu used by both the case pans and the freezer
     * pan chips (see renderCase()/renderFreezer()) so "any of the pan
     * movements" are reachable with a right-click instead of hunting for the
     * matching button. `items` is [{ label, action, disabled, danger }] or
     * { divider: true } to insert a separator. */
    let ctxMenuHandlersAttached = false;
    function showContextMenu(x, y, items) {
        const menu = document.getElementById('g-ctx-menu');
        if (!menu) return;
        menu.innerHTML = items.map((it, i) => it.divider
            ? `<div class="g-ctx-divider"></div>`
            : `<button type="button" class="g-ctx-item ${it.danger ? 'danger' : ''}" data-i="${i}" ${it.disabled ? 'disabled' : ''}>${esc(it.label)}</button>`
        ).join('');
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;
        menu.hidden = false;
        // clamp inside the viewport once we know the menu's rendered size
        requestAnimationFrame(() => {
            const maxLeft = window.innerWidth - menu.offsetWidth - 8;
            const maxTop = window.innerHeight - menu.offsetHeight - 8;
            menu.style.left = `${Math.max(4, Math.min(x, maxLeft))}px`;
            menu.style.top = `${Math.max(4, Math.min(y, maxTop))}px`;
        });

        menu.querySelectorAll('.g-ctx-item').forEach(btn => {
            btn.addEventListener('click', () => {
                hideContextMenu();
                const item = items[Number(btn.dataset.i)];
                if (item && item.action) item.action();
            });
        });

        if (!ctxMenuHandlersAttached) {
            ctxMenuHandlersAttached = true;
            document.addEventListener('click', hideContextMenu);
            document.addEventListener('contextmenu', e => {
                if (!e.target.closest('.g-pan, .g-pan-chip')) hideContextMenu();
            });
            document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });
            window.addEventListener('scroll', hideContextMenu, true);
            window.addEventListener('resize', hideContextMenu);
        }
    }

    function hideContextMenu() {
        const menu = document.getElementById('g-ctx-menu');
        if (menu) menu.hidden = true;
    }

    /* Move ONE specific physical pan (identified by its exact index in the
     * flavor's pan list, not just an aggregate amount) from a freezer to
     * another location. Same destinations as the Transfer form/onTransfer,
     * but pinned to the exact pan a right-click was made on — critical when
     * a flavor has more than one pan sitting in the same freezer. */
    async function moveSpecificPan(id, loc, idx, expectedAmt, dest) {
        const f = byId(id);
        if (!f || f.isDummy) return;  // dummy pans use their own menu (edit label / remove)
        const arr = pansOf(f, loc);
        const amt = arr[idx];
        if (amt == null || Math.abs(r2(amt) - r2(expectedAmt)) > EPS) {
            status('Pan data changed — please wait for the page to refresh.');
            return;
        }
        if (dest === loc) return;

        if (dest === 'active') {
            if (loc !== 'shortTerm') { status('The case can only be filled from short-term storage.'); return; }
            if (!f.casePan && casePans().length >= CASE_SLOTS) { status(`The case is full (${CASE_SLOTS} pans).`); return; }
            const newActive = r2((f.active || 0) + amt);
            if (newActive > 1 + EPS) { status(`A case pan holds max 1.0 — this ${r2(amt)} pan would push ${f.name} to ${newActive}.`); return; }
            const next = arr.slice(); next.splice(idx, 1);
            const update = setPans({ active: newActive, updatedAt: stamp() }, loc, next);
            if (!f.casePan) update.casePan = firstFreePan();
            await doc(id).update(update);
            logMove('transfer', `${r2(amt)} ${f.name}: ${LOCATION_LABELS[loc]} → Case (Pan ${update.casePan || f.casePan})`);
            status(`Moved ${r2(amt)} pan of ${f.name} into the case.`, true);
            return;
        }

        if (dest === 'use') {
            const next = arr.slice(); next.splice(idx, 1);
            await doc(id).update(setPans({ updatedAt: stamp() }, loc, next));
            addUsage('usedPans', amt);
            logMove('use', `Used a ${r2(amt)} pan of ${f.name} directly from ${LOCATION_LABELS[loc]}`);
            status(`Used ${r2(amt)} of ${f.name} from ${LOCATION_LABELS[loc]}.`, true);
            return;
        }

        // freezer -> freezer (shortTerm <-> longTerm)
        const cap = dest === 'shortTerm' ? SHORT_CAP : LONG_CAP;
        const destArr = addPans(pansOf(f, dest), amt);
        if (slotsAfter(dest, id, destArr) > cap) {
            status(`${LOCATION_LABELS[dest]} freezer is full — ${slotsOpen(dest)} slot(s) open.`); return;
        }
        const next = arr.slice(); next.splice(idx, 1);
        const update = { updatedAt: stamp() };
        setPans(update, loc, next);
        setPans(update, dest, destArr);
        await doc(id).update(update);
        logMove('transfer', `${r2(amt)} ${f.name}: ${LOCATION_LABELS[loc]} → ${LOCATION_LABELS[dest]}`);
        status(`Moved ${r2(amt)} pan of ${f.name}: ${LOCATION_LABELS[loc]} → ${LOCATION_LABELS[dest]}.`, true);
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
        const rows = flavors.filter(f => !f.isDummy).map(f => ({
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
    const orderSource = () => (document.getElementById('order-source') || {}).value || 'active';

    function renderOrderQueue() {
        const sel = document.getElementById('order-flavor');
        if (sel) {
            const prev = sel.value;
            if (orderSource() === 'pending') {
                sel.innerHTML = pendingList.length
                    ? pendingList.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')
                    : `<option value="">No pending flavors</option>`;
            } else {
                // priority: whatever's in the display case right now, then the
                // rest of the active menu — staging for production should look
                // at what's actually running low on the floor first
                const inCase = new Set(casePans().map(f => f.id));
                const cased = menuFlavors.filter(f => inCase.has(f.id));
                const rest = menuFlavors.filter(f => !inCase.has(f.id));
                sel.innerHTML =
                    (cased.length ? `<optgroup label="In the Case (priority)">${cased.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</optgroup>` : '') +
                    (rest.length ? `<optgroup label="Other Active Flavors">${rest.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}</optgroup>` : '');
                if (!cased.length && !rest.length) sel.innerHTML = `<option value="">No active flavors on menu</option>`;
            }
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
                <button type="button" class="g-order-del" data-i="${i}"
                    title="Made it — adds 1.0 pan to Short-Term and clears it from the list"
                    aria-label="Made — move 1 pan to short-term">✕</button>
            </div>`).join('');
        list.querySelectorAll('.g-order-del').forEach(b =>
            b.addEventListener('click', () => completeOrder(Number(b.dataset.i))));
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

    /* ✕ on an order-queue item = that flavor has been made: one full pan
     * (1.0) goes into short-term storage, then the item leaves the list.
     * If the short-term freezer has no free slot, the item stays put. */
    async function completeOrder(i) {
        const o = orderQueue[i];
        if (!o) return;
        const f = byId(o.flavorId);
        const name = nameById(o.flavorId) || o.name || '(unnamed)';
        const newArr = addPans(pansOf(f || {}, 'shortTerm'), 1);
        if (slotsAfter('shortTerm', o.flavorId, newArr) > SHORT_CAP) {
            status(`Short-term freezer is full — ${slotsOpen('shortTerm')} slot(s) open. ${name} stays on the order list.`);
            return;
        }
        try {
            if (f) {
                await doc(f.id).update(setPans({ updatedAt: stamp() }, 'shortTerm', newArr));
            } else {
                // no inventory doc yet — create it on the fly (mirrors onAddStock)
                const m = liveMeta(o.flavorId);
                const u = {
                    name,
                    gelatoImage: (m && (m.gelatoImage || m.imageURL)) || '',
                    imageURL: (m && m.imageURL) || '',
                    active: 0, casePan: null,
                    updatedAt: stamp()
                };
                setPans(u, 'shortTerm', newArr);
                setPans(u, 'longTerm', []);
                await doc(o.flavorId).set(u, { merge: true });
            }
            await removeFromOrder(i);
            logMove('intake', `Made ${name} — 1 pan → Short-Term (from order queue)`);
            status(`${name} made: 1.0 pan added to Short-Term.`, true);
        } catch (e) {
            console.error('completeOrder failed', e);
            status('Completing the order failed — see console.');
        }
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
        const entry = queue[i];
        if (entry) autoStageExcluded.add(`${entry.pan}|${entry.flavorId}`);
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
        // if replacing the same flavor (e.g. Pistachio→Pistachio), the existing
        // case gelato would be silently overwritten — return it to storage first
        const existingActive = (outgoing && outgoing.id === incoming.id) ? r2(outgoing.active || 0) : 0;
        const baseShortPans = existingActive > EPS
            ? addPans(pansOf(incoming, 'shortTerm'), existingActive)
            : pansOf(incoming, 'shortTerm');
        batch.update(doc(incoming.id), setPans(
            { active: take, casePan: q.pan, updatedAt: stamp() },
            'shortTerm', pullPans(baseShortPans, take)));
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
        // only add what was actually pulled — don't invent inventory when shortTerm
        // holds less than the requested amount
        const actualAdd = pullShort ? fromShort : add;
        const newActive = r2((f.active || 0) + actualAdd);
        await doc(id).update(setPans(
            { active: newActive, updatedAt: stamp() },
            'shortTerm', pullPans(pansOf(f, 'shortTerm'), fromShort)));
        closeModal();
        const src = fromShort > EPS ? `${r2(fromShort)} from Short-Term` : 'added (thin air)';
        logMove('transfer', `Added ${r2(actualAdd)} to Pan ${f.casePan} (${f.name}) — ${src} — now ${newActive}`);
        status(`Added ${r2(actualAdd)} to ${f.name}. Now ${newActive}.`, true);
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
    function openMergeModal(preselectPanFlavorId) {
        const pans = casePans().slice().sort((a, b) => a.casePan - b.casePan);
        const shortHoldings = flavors.filter(f => !f.isDummy && (f.shortTerm || 0) > EPS)
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

        // a right-click "Merge into this pan…" wins over the defaults above
        if (preselectPanFlavorId && pans.some(p => p.id === preselectPanFlavorId)) {
            intoSel.value = preselectPanFlavorId;
            const ownShort = shortHoldings.find(f => f.id === preselectPanFlavorId);
            if (ownShort) fromSel.value = `short:${ownShort.id}`;
        }

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
            await doc(tgt.id).update(setPans(
                { active: newActive, updatedAt: stamp() },
                'shortTerm', pullPans(pansOf(tgt, 'shortTerm'), moved)));
        } else {
            const batch = db.batch();
            batch.update(doc(tgt.id), { active: newActive, updatedAt: stamp() });
            if (src.type === 'short') {
                batch.update(doc(src.id), setPans({ updatedAt: stamp() },
                    'shortTerm', pullPans(pansOf(src.f, 'shortTerm'), moved)));
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
        const newArr = addPans(pansOf(f, 'shortTerm'), amt);   // back as its own pan
        if (slotsAfter('shortTerm', f.id, newArr) > SHORT_CAP) {
            status(`Short-term freezer is full — ${slotsOpen('shortTerm')} slot(s) open.`); return;
        }
        const pan = f.casePan;
        await doc(id).update(setPans(
            { active: 0, casePan: null, updatedAt: stamp() }, 'shortTerm', newArr));
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
     * first, overflow to long-term) and clear the case for the night.
     * After the move, if short-term exceeds SHORT_CAP, full (1.0) pans are
     * automatically cascaded to long-term (oldest/first first) in the same
     * batch, so everything commits atomically. */
    async function closeCase() {
        const inCase = casePans();
        if (!inCase.length) { status('The case is already empty.'); return; }
        if (!confirm(`Close the case for the night? This moves all ${inCase.length} pan(s) back into storage and clears the swap queue.`)) return;

        // Working copies of every flavor's pan lists — we never re-query Firestore
        // mid-function because the snapshot hasn't fired yet after a write.
        const shortWork = {}, longWork = {};
        flavors.forEach(f => {
            shortWork[f.id] = pansOf(f, 'shortTerm').slice();
            longWork[f.id]  = pansOf(f, 'longTerm').slice();
        });
        let shortCount = flavors.reduce((s, f) => s + shortWork[f.id].length, 0);
        let longCount  = flavors.reduce((s, f) => s + longWork[f.id].length, 0);

        const changedShort = new Set(), changedLong = new Set();
        const stuckIds = new Set(), stuck = [];

        // Phase 1: return case pans to storage (short-term first)
        inCase.forEach(f => {
            const amt = r2(f.active || 0);
            if (amt <= EPS) return;
            if (shortCount < SHORT_CAP) {
                shortWork[f.id] = addPans(shortWork[f.id], amt);
                shortCount++;
                changedShort.add(f.id);
            } else if (longCount < LONG_CAP) {
                longWork[f.id] = addPans(longWork[f.id], amt);
                longCount++;
                changedLong.add(f.id);
            } else {
                stuckIds.add(f.id);
                stuck.push(`${f.name} (${amt})`);
            }
        });

        // Phase 2: if short-term is over capacity, cascade full (1.0) pans to
        // long-term, oldest first (index 0 of each flavor's array, flavors in
        // alphabetical order), until short-term ≤ SHORT_CAP or no full pans remain.
        const overflowMoves = [];
        if (shortCount > SHORT_CAP) {
            outer: for (const f of flavors) {
                const arr = shortWork[f.id];
                let i = 0;
                while (i < arr.length) {
                    if (shortCount <= SHORT_CAP) break outer;
                    if (Math.abs(arr[i] - 1.0) < EPS) {
                        if (longCount >= LONG_CAP) break outer;  // long-term full — can't move any more
                        arr.splice(i, 1);
                        shortCount--;
                        changedShort.add(f.id);
                        longWork[f.id] = addPans(longWork[f.id], 1.0);
                        longCount++;
                        changedLong.add(f.id);
                        overflowMoves.push(f.name);
                        // don't increment i — next element slid into this slot
                    } else {
                        i++;
                    }
                }
            }
        }

        // Commit everything in one atomic batch
        const batch = db.batch();
        // Case pans: clear slot; include any storage changes for this flavor
        inCase.forEach(f => {
            if (stuckIds.has(f.id)) return;
            const u = { active: 0, casePan: null, updatedAt: stamp() };
            if (changedShort.has(f.id)) setPans(u, 'shortTerm', shortWork[f.id]);
            if (changedLong.has(f.id))  setPans(u, 'longTerm',  longWork[f.id]);
            batch.update(doc(f.id), u);
        });
        // Overflow may have touched flavors that weren't in the case tonight
        for (const id of changedShort) {
            if (inCase.some(f => f.id === id)) continue;
            const u = { updatedAt: stamp() };
            setPans(u, 'shortTerm', shortWork[id]);
            if (changedLong.has(id)) setPans(u, 'longTerm', longWork[id]);
            batch.update(doc(id), u);
        }
        for (const id of changedLong) {
            if (inCase.some(f => f.id === id) || changedShort.has(id)) continue;
            const u = { updatedAt: stamp() };
            setPans(u, 'longTerm', longWork[id]);
            batch.update(doc(id), u);
        }
        // the case is emptied for the night, so staged swaps no longer apply
        batch.set(queueDocRef(), { queue: [] }, { merge: true });
        await batch.commit();

        // Log
        logMove('close', `Closed case for the night — ${inCase.length - stuckIds.size} pan(s) moved to storage, swap queue cleared`);
        if (overflowMoves.length) {
            const counts = {};
            overflowMoves.forEach(n => counts[n] = (counts[n] || 0) + 1);
            const detail = Object.entries(counts).map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(', ');
            logMove('transfer', `Short-term overflow on close: moved ${overflowMoves.length} full pan(s) to Long-Term — ${detail}`);
        }

        // Status
        const stillOver = shortCount > SHORT_CAP;
        if (stuck.length || stillOver) {
            const msgs = [];
            if (stuck.length) msgs.push(`left in case: ${stuck.join(', ')}`);
            if (stillOver) msgs.push(`short-term still over ${SHORT_CAP} slots — no full pans left to move to long-term`);
            status(`Case closed with issues — ${msgs.join('; ')}. Swap queue cleared.`);
        } else {
            status('Case closed for the night — everything moved to storage, swap queue cleared. 🌙', true);
        }
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

        // working copy of every flavor's pan lists + case state
        const st = {};
        inventory.forEach(f => st[f.id] = {
            shortPans: pansOf(f, 'shortTerm').slice(),
            longPans: pansOf(f, 'longTerm').slice(),
            active: 0, casePan: null
        });
        const slotCount = key => Object.values(st).reduce((s, v) => s + v[key].length, 0);
        // return whatever's in the case now to storage as its own pan (short first)
        casePans().forEach(f => {
            const amt = r2(f.active || 0);
            if (amt <= EPS) return;
            if (slotCount('shortPans') < SHORT_CAP) st[f.id].shortPans = addPans(st[f.id].shortPans, amt);
            else if (slotCount('longPans') < LONG_CAP) st[f.id].longPans = addPans(st[f.id].longPans, amt);
        });
        // place snapshot flavors back into their pans, pulling from short-term
        const missing = [];
        plan.forEach(p => {
            const s = st[p.flavorId];
            if (!s) { missing.push(p.name); return; }
            const take = Math.min(panSum(s.shortPans), r2(p.active));   // capped at availability
            s.shortPans = pullPans(s.shortPans, take);
            s.active = take;
            if (take > EPS) s.casePan = p.pan;  // no stock → don't occupy the slot
        });
        // write only the docs that changed
        const batch = db.batch();
        inventory.forEach(f => {
            const s = st[f.id];
            const newShort = panSum(s.shortPans), newLong = panSum(s.longPans);
            const changed = r2(f.shortTerm || 0) !== newShort || r2(f.longTerm || 0) !== newLong ||
                r2(f.active || 0) !== s.active || (f.casePan || null) !== s.casePan;
            if (changed) {
                const u = { active: s.active, casePan: s.casePan, updatedAt: stamp() };
                setPans(u, 'shortTerm', s.shortPans);
                setPans(u, 'longTerm', s.longPans);
                batch.update(doc(f.id), u);
            }
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
        const choices = flavors.filter(f => !f.isDummy && !f.casePan && caseStock(f) > EPS)
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

        await doc(f.id).update(setPans(
            { active: amount, casePan: pan, updatedAt: stamp() },
            'shortTerm', pullPans(pansOf(f, 'shortTerm'), amount)));
        closeModal();
        logMove('assign', `Added ${f.name} to Pan ${pan} at ${amount} (from Short-Term)`);
        status(`${f.name} added to Pan ${pan} at ${amount}.`, true);
    }

    // ----- Freezer assign modal (Long-Term "assign pans" shortcut) --------
    /* Quick intake shortcut scoped to one freezer location, opened right from
     * that freezer's own section instead of scrolling to the general Add
     * Stock form below. Adds brand-new pan(s) of a chosen flavor directly
     * into `loc` (mirrors onAddStock's logic — not pulled from other stock). */
    function openFreezerAssignModal(loc) {
        const offMenu = flavors.filter(f => !f.isDummy && (!menuIds || !menuIds.has(f.id)));
        const choices = [...menuFlavors, ...offMenu]
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        document.getElementById('g-modal-title').textContent = `Assign a flavor to ${LOCATION_LABELS[loc]}`;
        const body = document.getElementById('g-modal-body');
        if (!choices.length) {
            body.innerHTML = `<p class="g-empty-note">No flavors available yet.</p>`;
            showModal();
            return;
        }
        body.innerHTML = `
            <label class="g-modal-label">Flavor</label>
            <select id="frz-assign-flavor" class="g-modal-select">
                ${choices.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('')}
            </select>
            <label class="g-modal-label">Pans to add</label>
            <input type="number" id="frz-assign-amt" class="g-modal-input" list="amt-presets" value="1" min="0.1" step="0.1">
            <p class="g-modal-hint" id="frz-assign-hint"></p>
            <div class="g-modal-actions">
                <button type="button" class="g-modal-cancel" id="frz-assign-cancel">Cancel</button>
                <button type="button" class="g-modal-go" id="frz-assign-go">Add to ${LOCATION_LABELS[loc]}</button>
            </div>`;

        const sel = document.getElementById('frz-assign-flavor');
        const hint = document.getElementById('frz-assign-hint');
        const cap = loc === 'shortTerm' ? SHORT_CAP : LONG_CAP;
        const updateHint = () => {
            const f = byId(sel.value);
            const cur = f ? (f[loc] || 0) : 0;
            const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
            hint.textContent = `${label}: ${r2(cur)} already in ${LOCATION_LABELS[loc]}. ${slotsOpen(loc)} of ${cap} slots open.`;
        };
        sel.addEventListener('change', updateHint);
        updateHint();

        document.getElementById('frz-assign-cancel').addEventListener('click', closeModal);
        document.getElementById('frz-assign-go').addEventListener('click', () =>
            doFreezerAssign(loc, sel.value, parseFloat(document.getElementById('frz-assign-amt').value)));
        showModal();
    }

    async function doFreezerAssign(loc, flavorId, amount) {
        amount = r2(amount);
        if (!flavorId) { status('Pick a flavor.'); return; }
        if (!(amount > 0)) { status('Enter a quantity greater than 0.'); return; }
        const cap = loc === 'shortTerm' ? SHORT_CAP : LONG_CAP;
        const f = byId(flavorId);
        const m = liveMeta(flavorId);
        const newArr = addPans(pansOf(f || {}, loc), amount);
        if (slotsAfter(loc, flavorId, newArr) > cap) {
            status(`${LOCATION_LABELS[loc]} freezer is full — ${slotsOpen(loc)} slot(s) open.`); return;
        }
        if (f) {
            const heal = m ? { name: m.name || f.name, gelatoImage: m.gelatoImage || m.imageURL || f.gelatoImage || '', imageURL: m.imageURL || f.imageURL || '' } : {};
            await doc(flavorId).update(setPans({ ...heal, updatedAt: stamp() }, loc, newArr));
        } else {
            const other = loc === 'shortTerm' ? 'longTerm' : 'shortTerm';
            const u = {
                name: (m && m.name) || '(unnamed)',
                gelatoImage: (m && (m.gelatoImage || m.imageURL)) || '',
                imageURL: (m && m.imageURL) || '',
                active: 0, casePan: null,
                updatedAt: stamp()
            };
            setPans(u, loc, newArr);
            setPans(u, other, []);
            await doc(flavorId).set(u, { merge: true });
        }
        closeModal();
        const name = (m && m.name) || (f && f.name) || '(unnamed)';
        logMove('intake', `Assigned ${amount} ${name} → ${LOCATION_LABELS[loc]}`);
        status(`Added ${amount} pan(s) of ${name} to ${LOCATION_LABELS[loc]}.`, true);
    }

    // ----- Dummy (non-flavor) pans — Long-Term only ------------------------
    /* A placeholder pan for whatever isn't a gelato flavor (mini cones,
     * packaging, etc.) so it can still occupy — and be seen occupying — a
     * real freezer slot. It's just a gelatoInventory doc like any other,
     * flagged `isDummy: true` so every flavor-driven picker/automation
     * (Transfer, Add Stock, case-assign, merge, swap queue, order queue,
     * stat table/bars, $ value) skips it — see the `!f.isDummy` guards and
     * sumLocGelato() above. Physical slot/capacity counts stay inclusive. */
    async function addDummyPan() {
        if (slotsUsed('longTerm') >= LONG_CAP) {
            status(`Long-Term freezer is full — ${slotsOpen('longTerm')} slot(s) open.`);
            return;
        }
        const id = `dummy_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const name = 'New Item';
        const u = { isDummy: true, name, active: 0, casePan: null, updatedAt: stamp() };
        setPans(u, 'longTerm', [1]);
        setPans(u, 'shortTerm', []);
        await db.collection('gelatoInventory').doc(id).set(u);
        pendingDummyFocusId = id;   // renderFreezer() focuses its label input once rendered
        logMove('intake', `Added a dummy pan to Long-Term — edit its label to say what's in it`);
        status('Dummy pan added — type what it holds in the label at top-right.', true);
    }

    async function renameDummyPan(id, name) {
        const clean = String(name || '').trim().slice(0, 60) || 'New Item';
        await doc(id).update({ name: clean, updatedAt: stamp() });
    }

    /* Right-click "Edit label" on an already-rendered dummy chip — no
     * Firestore round-trip needed, the input is already on the page. */
    function focusDummyLabel(id) {
        const el = document.querySelector(`.g-dummy-label[data-id="${id}"]`);
        if (el) { el.focus(); el.select(); }
    }

    function showModal() { document.getElementById('g-modal').hidden = false; }
    function closeModal() {
        cancelSyncCountdown();
        const m = document.getElementById('g-modal');
        m.hidden = true;
        m.classList.remove('g-modal-wide');
    }

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
        const newArr = addPans(pansOf(byId(val) || {}, loc), amount);   // added as new pan(s)
        if (slotsAfter(loc, val, newArr) > cap) {
            status(`${LOCATION_LABELS[loc]} freezer is full — ${slotsOpen(loc)} slot(s) open.`); return;
        }
        const other = loc === 'shortTerm' ? 'longTerm' : 'shortTerm';

        if (stockSource() === 'pending') {
            const p = pendingList.find(x => x.id === val);
            if (!p) { status('Pending flavor not found.'); return; }
            // inventory doc keyed by the pendingItems id; create it if it doesn't exist yet
            const base = byId(val) || {};
            const u = {
                name: base.name || p.name || '(unnamed)',
                gelatoImage: base.gelatoImage || p.gelatoImage || p.imageURL || '',
                imageURL: base.imageURL || p.imageURL || '',
                active: base.active || 0,
                casePan: base.casePan || null,
                updatedAt: stamp()
            };
            setPans(u, loc, newArr);
            setPans(u, other, pansOf(base, other));
            await doc(val).set(u, { merge: true });
            logMove('intake', `Added ${amount} ${p.name} (pending) → ${LOCATION_LABELS[loc]}`);
            status(`Added ${amount} pan(s) of ${p.name} (pending) to ${LOCATION_LABELS[loc]}.`, true);
        } else {
            const f = byId(val);
            const m = menuFlavors.find(x => x.id === val);
            if (!f && !m) { status('Flavor not found.'); return; }
            const name = (m || f).name;   // prefer the live menu name
            if (f) {
                const heal = m ? { name: m.name || f.name, gelatoImage: m.gelatoImage || m.imageURL || f.gelatoImage || '', imageURL: m.imageURL || f.imageURL || '' } : {};
                await doc(val).update(setPans({ ...heal, updatedAt: stamp() }, loc, newArr));
            } else {
                // inventory doc doesn't exist yet — create it on the fly
                const u = {
                    name: m.name || '(unnamed)',
                    gelatoImage: m.gelatoImage || m.imageURL || '',
                    imageURL: m.imageURL || '',
                    active: 0, casePan: null,
                    updatedAt: stamp()
                };
                setPans(u, loc, newArr);
                setPans(u, other, []);
                await doc(val).set(u, { merge: true });
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
        const offMenu = flavors.filter(f => !f.isDummy && (!menuIds || !menuIds.has(f.id)));
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

    /* The transfer amount is a specific physical pan, not a free-typed
     * number — options come straight from that flavor's actual pan volumes
     * in the chosen "From" location (deduped), so you can only pick a value
     * that really exists in the database. The case only ever holds one pan
     * per flavor (the scalar `active` amount), so that's the sole option
     * there. Kept in sync with renderAll() so it never goes stale. */
    function renderTransferAmounts() {
        const sel = document.getElementById('t-amount');
        if (!sel) return;
        const prev = sel.value;
        const f = byId(document.getElementById('t-flavor').value);
        const from = document.getElementById('t-from').value;
        const vols = !f ? [] : from === 'active'
            ? ((f.active || 0) > EPS ? [r2(f.active)] : [])
            : [...new Set(pansOf(f, from))].sort((a, b) => b - a);
        sel.innerHTML = vols.length
            ? vols.map(v => `<option value="${v}">${v} pan${v === 1 ? '' : 's'}</option>`).join('')
            : `<option value="">Nothing to transfer from ${LOCATION_LABELS[from]}</option>`;
        if (prev && vols.some(v => String(v) === prev)) sel.value = prev;
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
        const amountRaw = document.getElementById('t-amount').value;

        if (!f) return;
        if (f.isDummy) { status('Dummy pans aren\'t flavors — use the right-click menu on the pan itself.'); return; }
        if (!amountRaw) { status(`Nothing to transfer from ${LOCATION_LABELS[from]}.`); return; }
        const amount = r2(amountRaw);
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
            const toArr = addPans(pansOf(f, to), amount);   // arrives as its own pan(s)
            if (slotsAfter(to, f.id, toArr) > cap) {
                status(`${LOCATION_LABELS[to]} freezer is full — ${slotsOpen(to)} slot(s) open.`); return;
            }
            setPans(update, to, toArr);
        }

        if (from === 'active') {
            const left = r2((f.active || 0) - amount);
            update.active = (to === 'active') ? update.active : left;
            if (left <= EPS && to !== 'active') update.casePan = null;
        } else {
            setPans(update, from, pullPans(pansOf(f, from), amount));
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
