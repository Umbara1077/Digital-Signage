/* Who may use DVG Intelligence. Must stay in step with public/auth-guard.js
 * and firestore.rules — three copies of one list, by design: the browser
 * decides what to show, the rules decide what the database accepts, and this
 * decides who may spend Gemini tokens. */
'use strict';

const ALLOWED_EMAILS = ['corsodante8@gmail.com', 'nick@dolcevitagelateria.com'];
const ALLOWED_DOMAINS = ['dolcevitasewell.com'];

function isAllowed(email) {
    const e = String(email == null ? '' : email).trim().toLowerCase();
    if (!e || e.indexOf('@') < 0) return false;
    if (ALLOWED_EMAILS.includes(e)) return true;
    return ALLOWED_DOMAINS.includes(e.slice(e.lastIndexOf('@') + 1));
}

module.exports = { ALLOWED_EMAILS, ALLOWED_DOMAINS, isAllowed };
