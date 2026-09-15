/* =========================================================================
 * Google-only access gate for the Dolce Vita admin surfaces.
 *
 * Loaded by:  admin.html and gelato.html (Digital-Signage)
 *             admin.html (CaffeDigitalSignage)
 * NEVER loaded by index.html / early.html / menu-*.html — the TV displays
 * run unauthenticated and must keep working with no sign-in at all.
 *
 * This file is the convenience half of the lock: it decides what the
 * browser will show. The half that actually ENFORCES anything is
 * firestore.rules / storage.rules, which carry this same list. If you add
 * or remove someone here, change the rules files too or the two will
 * disagree.
 * ========================================================================= */
(function (global) {
    'use strict';

    /* Individual accounts, matched exactly (case-insensitive). */
    var ALLOWED_EMAILS = [
        'corsodante8@gmail.com',
        'nick@dolcevitagelateria.com'
    ];

    /* Whole domains: anyone@<domain> is allowed in. */
    var ALLOWED_DOMAINS = [
        'dolcevitasewell.com'
    ];

    var LOGIN_PAGE = 'login.html';

    function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

    /* The single source of truth for "may this address open an admin page". */
    function isAllowed(email) {
        var e = norm(email);
        if (!e || e.indexOf('@') < 0) return false;
        if (ALLOWED_EMAILS.indexOf(e) !== -1) return true;
        return ALLOWED_DOMAINS.indexOf(e.slice(e.lastIndexOf('@') + 1)) !== -1;
    }

    function auth() { return firebase.auth(); }

    function googleProvider() {
        var p = new firebase.auth.GoogleAuthProvider();
        /* Always show the account chooser, so signing in with the wrong
         * Google account isn't a dead end. */
        p.setCustomParameters({ prompt: 'select_account' });
        return p;
    }

    /* Popup first; browsers that block popups fall back to a full redirect. */
    function signIn() {
        return auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
            .then(function () { return auth().signInWithPopup(googleProvider()); })
            .catch(function (err) {
                var code = err && err.code;
                if (code === 'auth/popup-blocked' ||
                    code === 'auth/cancelled-popup-request' ||
                    code === 'auth/operation-not-supported-in-this-environment') {
                    return auth().signInWithRedirect(googleProvider());
                }
                throw err;
            });
    }

    function signOut() { return auth().signOut(); }

    /* ----- the covering gate --------------------------------------------
     * An opaque overlay sits over the page until the account is known to be
     * on the list, so no admin content is ever briefly visible to someone
     * who shouldn't see it. It injects its own CSS rather than relying on
     * the host page's stylesheet. */
    var STYLE_ID = 'dv-auth-style';

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent =
            '#dv-auth-gate{position:fixed;inset:0;z-index:2147483647;display:flex;' +
            'align-items:center;justify-content:center;padding:24px;background:#10141c;' +
            'color:#eef2f8;text-align:center;' +
            'font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
            '#dv-auth-gate .dv-card{max-width:440px;width:100%;background:#182030;' +
            'border:1px solid #2a3550;border-radius:16px;padding:32px 28px;' +
            'box-shadow:0 24px 60px rgba(0,0,0,.45)}' +
            '#dv-auth-gate h1{margin:0 0 10px;font-size:1.22rem;letter-spacing:.2px}' +
            '#dv-auth-gate p{margin:0 0 8px;color:#a8b3c7;font-size:.94rem}' +
            '#dv-auth-gate .dv-who{color:#ffd166;font-weight:600;word-break:break-all}' +
            '#dv-auth-gate .dv-actions{display:flex;gap:10px;justify-content:center;' +
            'flex-wrap:wrap;margin-top:20px}' +
            '#dv-auth-gate button{font:inherit;font-weight:600;cursor:pointer;' +
            'border-radius:10px;padding:11px 18px;border:1px solid transparent}' +
            '#dv-auth-gate .dv-primary{background:#e0b64a;color:#231b06}' +
            '#dv-auth-gate .dv-ghost{background:transparent;color:#cfd8e8;border-color:#39456a}' +
            '#dv-auth-gate .dv-spin{width:30px;height:30px;margin:0 auto 14px;border-radius:50%;' +
            'border:3px solid #2a3550;border-top-color:#e0b64a;animation:dv-spin .8s linear infinite}' +
            '@keyframes dv-spin{to{transform:rotate(360deg)}}';
        (document.head || document.documentElement).appendChild(s);
    }

    function gateCard() {
        injectStyle();
        var el = document.getElementById('dv-auth-gate');
        if (!el) {
            el = document.createElement('div');
            el.id = 'dv-auth-gate';
            el.innerHTML = '<div class="dv-card"></div>';
            (document.body || document.documentElement).appendChild(el);
        }
        return el.querySelector('.dv-card');
    }

    function showChecking() {
        gateCard().innerHTML = '<div class="dv-spin"></div><h1>Checking access…</h1>';
    }

    /* Names the account rather than bouncing silently, so a wrong address or
     * a typo in the list above is obvious instead of looking like an outage. */
    function showDenied(email) {
        var card = gateCard();
        card.innerHTML =
            '<h1>This account can’t open the admin panel</h1>' +
            '<p>Signed in as <span class="dv-who"></span></p>' +
            '<p>Switch to an approved account, or ask an owner to add this address.</p>' +
            '<div class="dv-actions">' +
            '<button type="button" class="dv-primary" id="dv-switch">Use a different account</button>' +
            '<button type="button" class="dv-ghost" id="dv-signout">Sign out</button>' +
            '</div>';
        card.querySelector('.dv-who').textContent = email || '(unknown account)';
        card.querySelector('#dv-switch').addEventListener('click', function () {
            signOut().then(signIn).catch(function (e) { console.error('account switch failed', e); });
        });
        card.querySelector('#dv-signout').addEventListener('click', function () {
            signOut().then(function () { window.location.replace(LOGIN_PAGE); });
        });
    }

    function clearGate() {
        var el = document.getElementById('dv-auth-gate');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    /* Guard an admin page. Signed out -> login. Signed in but not on the
     * list -> the explanatory screen above. On the list -> reveal the page. */
    function guard(opts) {
        opts = opts || {};
        var onReady = typeof opts.onReady === 'function' ? opts.onReady : null;

        function start() {
            showChecking();
            auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
                .catch(function (e) { console.error('auth persistence failed', e); })
                .then(function () {
                    auth().onAuthStateChanged(function (user) {
                        if (!user) { window.location.replace(LOGIN_PAGE); return; }
                        if (!isAllowed(user.email)) { showDenied(user.email); return; }
                        clearGate();
                        if (onReady) { try { onReady(user); } catch (e) { console.error(e); } }
                    }, function (err) {
                        console.error('auth state error', err);
                        window.location.replace(LOGIN_PAGE);
                    });
                });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
    }

    global.DVAuth = {
        isAllowed: isAllowed,
        signIn: signIn,
        signOut: signOut,
        guard: guard,
        allowedEmails: ALLOWED_EMAILS.slice(),
        allowedDomains: ALLOWED_DOMAINS.slice()
    };
})(window);
