/* Sign-in page controller. Google is the only way in — the old
 * email/password form has been removed, and the allowlist in
 * auth-guard.js decides who may continue to admin.html. */
document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('googleSignInBtn');
    var errorEl = document.getElementById('error-message');
    var ADMIN_PAGE = 'admin.html';
    var settling = false;

    function say(msg) { if (errorEl) errorEl.textContent = msg || ''; }

    /* Decide what to do with whoever ends up signed in — whether that came
     * from the button, from a redirect, or from a session that was already
     * live when the page loaded. */
    function settle(user) {
        if (!user || settling) return;
        if (window.DVAuth && DVAuth.isAllowed(user.email)) {
            window.location.replace(ADMIN_PAGE);
            return;
        }
        /* Not on the list: drop the session here rather than letting them
         * land on an admin page they can't use. */
        settling = true;
        var who = user.email || 'That account';
        firebase.auth().signOut()
            .catch(function (e) { console.error('sign-out failed', e); })
            .then(function () {
                settling = false;
                say(who + ' isn’t approved for the admin panel. Try an approved account.');
                if (btn) btn.disabled = false;
            });
    }

    if (btn) {
        btn.addEventListener('click', function () {
            say('');
            btn.disabled = true;
            DVAuth.signIn()
                .catch(function (err) {
                    var code = err && err.code;
                    /* Closing the Google window isn't an error worth shouting about. */
                    if (code !== 'auth/popup-closed-by-user') {
                        console.error('sign-in failed', err);
                        say((err && err.message) || 'Sign-in failed. Please try again.');
                    }
                })
                .then(function () { btn.disabled = false; });
        });
    }

    /* Completes the redirect fallback used when popups are blocked. */
    firebase.auth().getRedirectResult().catch(function (err) {
        console.error('redirect sign-in failed', err);
        say((err && err.message) || 'Sign-in failed. Please try again.');
    });

    firebase.auth().onAuthStateChanged(settle);
});
