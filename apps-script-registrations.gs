/* =====================================================================
   EXPERT'S CORNER — REGISTRATIONS, LOGINS & EMAIL VERIFICATION
   Standalone Apps Script, bound to its own Google Sheet. Separate from the
   CME analytics collector: nothing here touches case events.

   WHAT IT DOES
   · Receives the account page's events (profile_update on signup/edit,
     account_login on login) and keeps three tabs in the bound spreadsheet:
       Registrations  — one row per email (upsert): profile, consent, logins, verification
       Logins         — one line per login / signup / profile edit
       Brevo export   — live view of consented, verified people in Brevo's import
                        column names; File → Download → CSV when you want to mail
   · Sends a one-time verification link by email (Gmail) on signup. Clicking it
     marks the row Verified. Verification is a formality: nothing on the site is gated.

   INSTALL
   1. Create a new Google Sheet (e.g. "Expert's Corner — Registrations"), then
      Extensions → Apps Script. Delete the sample code and paste this whole file. Save.
   2. Run  ecRegSetup  once (creates the tabs; approve the Gmail permission).
   3. Put your own address in ecRegSelfTest and run it — expect ALL PASS.
   4. Deploy → New deployment → type Web app → Execute as: Me →
      Who has access: Anyone → Deploy. Copy the /exec URL.
   5. Paste that URL into REG_ENDPOINT near the top of account.html's script.
   Later code changes: Deploy → Manage deployments → pencil → New version
   (keeps the same URL).
   ===================================================================== */

var ECR = {
  SITE:          'https://experts-corner.com',
  ACCOUNT_PAGE:  'https://experts-corner.com/account.html',
  FROM_NAME:     "Expert's Corner by Orakle",
  REPLY_TO:      'support@orakleinc.com',
  EMAIL_SUBJECT: "Please confirm your email for Expert's Corner",
  /* the /exec URL of THIS deployment — used in the verification link.
     Leave blank to have the script read it from ScriptApp at runtime. */
  EXEC_URL:      '',
  TAB_REG:       'Registrations',
  TAB_LOG:       'Logins',
  TAB_BREVO:     'Brevo export',
  /* re-send the verification email on login if still unverified, at most this often */
  RESEND_AFTER_DAYS: 7,
  /* abuse limits (CacheService; per email) */
  MAX_WRITES_PER_10MIN: 6,
  MAX_LEN: 200
};

var ECR_HEAD = ['email','first','last','country','occupation','specialty','consent','consent_at',
  'pid','created_at','updated_at','source','logins','last_login',
  'verified','verified_at','verify_token','verify_sent_at'];
var ECR_LOG_HEAD = ['t','kind','email','pid','first','last'];

/* ---------------------------------------------------------------- web app entry points */

function doPost(e) {
  return ecRegHandle_(e) || ecRegText_('ignored');
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.fn === 'verify') return ecRegVerifyPage_(p.k);
  return ecRegText_('ok');
}

/** Handles a batch of account events. Returns a Response, or null if the batch
 *  contained nothing for us (e.g. a stray case-analytics post). */
function ecRegHandle_(e) {
  var events = ecRegParse_(e);
  if (!events.length) return null;
  var mine = events.filter(ecRegIsAccountEvent_);
  if (!mine.length) return null;                 // ordinary case analytics — not ours
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return ecRegText_('busy'); }
  try {
    mine.forEach(function (ev) { try { ecRegApply_(ev); } catch (err) { console.log('ecReg error ' + err); } });
  } finally { lock.releaseLock(); }
  /* if the batch also carried case events, hand it back to the analytics writer */
  if (mine.length < events.length) return null;
  return ecRegText_('ok');
}

/** GET ?fn=verify&k=TOKEN → marks the row verified and returns a confirmation page. */
function ecRegVerifyPage_(token) {
  var result = ecRegVerify_(String(token || ''));
  return ecRegHtml_(result);
}

/* ---------------------------------------------------------------- parsing */

function ecRegParse_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) return [];
  var data;
  try { data = JSON.parse(raw); } catch (err) { return []; }
  if (!Array.isArray(data)) data = [data];
  return data.filter(function (x) { return x && typeof x === 'object'; });
}

function ecRegIsAccountEvent_(ev) {
  return String(ev.case_id || '') === 'ACCOUNT' ||
         ev.event === 'profile_update' || ev.event === 'account_login';
}

function ecRegClean_(v) {
  return String(v == null ? '' : v).replace(/[\r\n\t]/g, ' ').trim().slice(0, ECR.MAX_LEN);
}
function ecRegEmailOk_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254; }

/* ---------------------------------------------------------------- apply one event */

function ecRegApply_(ev) {
  var p = ev.payload || {};
  var email = ecRegClean_(p.email).toLowerCase();
  if (!ecRegEmailOk_(email)) return;
  if (!ecRegAllow_(email)) return;                // throttled

  var kind = ev.event === 'account_login' ? 'login' : (ecRegClean_(p.kind) || 'edit');
  var when = ecRegIso_(ev.t);
  var sh = ecRegSheet_(ECR.TAB_REG, ECR_HEAD);
  var found = ecRegFind_(sh, email);            // {row, rec} or null
  var rec = found ? found.rec : ecRegBlank_(email, when);

  if (kind === 'signup' || kind === 'edit') {
    ['first', 'last', 'country', 'occupation', 'specialty'].forEach(function (k) {
      var v = ecRegClean_(p[k]); if (v) rec[k] = v;
    });
    var consent = (p.consent === true || p.consent === 'true' || p.consent === 1);
    if (consent && !rec.consent) rec.consent_at = when;
    if (!consent) rec.consent_at = '';
    rec.consent = consent;
  }
  if (p.pid && !rec.pid) rec.pid = ecRegClean_(ev.pid || p.pid);
  else if (!rec.pid && ev.pid) rec.pid = ecRegClean_(ev.pid);
  /* The account page's login hook also fires when a fresh signup stores its session, in
     either order. Any login within two minutes of a row's creation, and a signup arriving
     within two minutes of a login-created row, are the same registration event. */
  var ageSec = found ? (new Date(when).getTime() - new Date(rec.created_at).getTime()) / 1000 : 0;
  var fresh = found && ageSec >= 0 && ageSec < 120;
  var twin = fresh && (kind === 'login' || (kind === 'signup' && rec.source === 'login'));
  if ((kind === 'signup' || kind === 'login') && !twin) {
    rec.logins = (Number(rec.logins) || 0) + 1;
    rec.last_login = when;
  }
  if (!found) rec.source = kind;
  if (twin && kind === 'signup') rec.source = 'signup';
  rec.updated_at = when;

  /* verification email: on signup; on login only for rows that never had one (older than the
     signup window) or whose last email is RESEND_AFTER_DAYS old */
  if (!rec.verified) {
    var due = kind === 'signup' ||
      (kind === 'login' && (rec.verify_sent_at ? ecRegDaysSince_(rec.verify_sent_at) >= ECR.RESEND_AFTER_DAYS : ageSec >= 120));
    if (due) {
      if (!rec.verify_token) rec.verify_token = ecRegToken_();
      if (ecRegSendVerification_(rec)) rec.verify_sent_at = when;
    }
  }

  ecRegWrite_(sh, found ? found.row : null, rec);
  ecRegLog_(when, kind, rec);
}

/* ---------------------------------------------------------------- verification */

function ecRegVerify_(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return { ok: false, reason: 'bad' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return { ok: false, reason: 'busy' }; }
  try {
    var sh = ecRegSheet_(ECR.TAB_REG, ECR_HEAD);
    var vals = sh.getDataRange().getValues();
    var cTok = ECR_HEAD.indexOf('verify_token'), cVer = ECR_HEAD.indexOf('verified'),
        cAt = ECR_HEAD.indexOf('verified_at'), cUp = ECR_HEAD.indexOf('updated_at'), cFirst = ECR_HEAD.indexOf('first');
    for (var r = 1; r < vals.length; r++) {
      if (String(vals[r][cTok]) === token) {
        var already = vals[r][cVer] === true || String(vals[r][cVer]).toUpperCase() === 'TRUE';
        if (!already) {
          var now = ecRegIso_();
          sh.getRange(r + 1, cVer + 1).setValue(true);
          sh.getRange(r + 1, cAt + 1).setValue(now);
          sh.getRange(r + 1, cUp + 1).setValue(now);
        }
        return { ok: true, already: already, first: String(vals[r][cFirst] || '') };
      }
    }
    return { ok: false, reason: 'unknown' };
  } finally { lock.releaseLock(); }
}

function ecRegSendVerification_(rec) {
  var link = ecRegExecUrl_() + '?fn=verify&k=' + encodeURIComponent(rec.verify_token);
  var first = rec.first ? rec.first : 'there';
  var text =
    'Hello ' + first + ',\n\n' +
    "Thanks for joining Expert's Corner. Please confirm this is your email address by opening the link below:\n\n" +
    link + '\n\n' +
    "This is just a formality — your account already works. If you didn't register, you can ignore this email.\n\n" +
    "Expert's Corner by Orakle\n" + ECR.SITE + '\n';
  var html =
    '<div style="font-family:Ubuntu,Segoe UI,Roboto,sans-serif;color:#1B2733;max-width:560px;line-height:1.55">' +
    '<p>Hello ' + ecRegEsc_(first) + ',</p>' +
    "<p>Thanks for joining Expert&rsquo;s Corner. Please confirm this is your email address:</p>" +
    '<p style="margin:24px 0"><a href="' + ecRegEsc_(link) + '" style="background:#215DD5;color:#fff;text-decoration:none;' +
    'padding:12px 24px;border-radius:2px;font-size:12px;letter-spacing:.15em;text-transform:uppercase;display:inline-block">Confirm my email</a></p>' +
    '<p style="font-size:13px;color:#4E6180">This is just a formality &mdash; your account already works. If you didn&rsquo;t register, you can ignore this email.</p>' +
    '<p style="font-size:13px;color:#4E6180;border-left:2px solid #F1C234;padding-left:10px">If the button doesn&rsquo;t work, copy this link into your browser:<br>' +
    ecRegEsc_(link) + '</p>' +
    '<p style="font-size:12px;color:#4E6180">Expert&rsquo;s Corner by Orakle &middot; <a href="' + ECR.SITE + '" style="color:#215DD5">' + ECR.SITE.replace(/^https?:\/\//, '') + '</a></p></div>';
  try {
    MailApp.sendEmail({ to: rec.email, subject: ECR.EMAIL_SUBJECT, body: text, htmlBody: html,
      name: ECR.FROM_NAME, replyTo: ECR.REPLY_TO, noReply: false });
    return true;
  } catch (err) { console.log('verification email failed for ' + rec.email + ': ' + err); return false; }
}

/* ---------------------------------------------------------------- sheet helpers */

function ecRegSheet_(name, head) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function ecRegFind_(sh, email) {
  var last = sh.getLastRow();
  if (last < 2) return null;
  var emails = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).toLowerCase() === email) {
      var row = sh.getRange(i + 2, 1, 1, ECR_HEAD.length).getValues()[0];
      var rec = {}; ECR_HEAD.forEach(function (k, j) { rec[k] = row[j]; });
      rec.consent = rec.consent === true || String(rec.consent).toUpperCase() === 'TRUE';
      rec.verified = rec.verified === true || String(rec.verified).toUpperCase() === 'TRUE';
      return { row: i + 2, rec: rec };
    }
  }
  return null;
}

function ecRegBlank_(email, when) {
  var rec = {}; ECR_HEAD.forEach(function (k) { rec[k] = ''; });
  rec.email = email; rec.created_at = when; rec.consent = false; rec.verified = false; rec.logins = 0;
  return rec;
}

function ecRegWrite_(sh, row, rec) {
  var vals = ECR_HEAD.map(function (k) { return rec[k] == null ? '' : rec[k]; });
  if (row) sh.getRange(row, 1, 1, vals.length).setValues([vals]);
  else sh.appendRow(vals);
}

function ecRegLog_(when, kind, rec) {
  ecRegSheet_(ECR.TAB_LOG, ECR_LOG_HEAD).appendRow([when, kind, rec.email, rec.pid || '', rec.first || '', rec.last || '']);
}

/* ---------------------------------------------------------------- setup + self-test */

/** Run once from the editor: creates the three tabs (incl. the Brevo view) and triggers
 *  the Gmail permission prompt. Safe to re-run. */
function ecRegSetup() {
  ecRegSheet_(ECR.TAB_REG, ECR_HEAD);
  ecRegSheet_(ECR.TAB_LOG, ECR_LOG_HEAD);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var b = ss.getSheetByName(ECR.TAB_BREVO);
  if (!b) {
    b = ss.insertSheet(ECR.TAB_BREVO);
    b.getRange('A1').setValue('Consented AND verified people, in Brevo import columns. Live view — do not type here. ' +
      'To mail: File → Download → CSV, then Brevo → Contacts → Import.');
    b.getRange('A1').setFontStyle('italic').setFontColor('#4E6180');
    b.getRange('A3').setFormula(
      "=IFERROR(QUERY('" + ECR.TAB_REG + "'!A:R,\"select A,B,C,D,E,F,H,P where G = TRUE and O = TRUE " +
      "label A 'EMAIL', B 'FIRSTNAME', C 'LASTNAME', D 'COUNTRY', E 'OCCUPATION', F 'SPECIALTY', H 'CONSENT_AT', P 'VERIFIED_AT'\",1),\"(no one yet)\")");
    b.setFrozenRows(3);
  }
  MailApp.getRemainingDailyQuota();   // forces the Gmail authorisation prompt on first run
  console.log('Setup complete. Tabs: ' + [ECR.TAB_REG, ECR.TAB_LOG, ECR.TAB_BREVO].join(', ') +
    '. Daily email quota remaining: ' + MailApp.getRemainingDailyQuota());
}

/** Run once from the editor. Simulates signup → login → verify for a test address,
 *  checks every step, then deletes the test rows. Sends ONE real email to the test
 *  address (change it below to yours). Prints PASS or the failing step. */
function ecRegSelfTest() {
  var email = 'ecreg-selftest@example.com';   // ← put your own address here to receive the test email
  var pid = 'ec-selftest';
  function post(events) { return ecRegHandle_({ postData: { contents: JSON.stringify(events) } }); }
  function ev(name, payload) {
    return { orakle: 1, v: 1, event: name, t: new Date().toISOString(), pid: pid, case_id: 'ACCOUNT',
             eid: 'selftest-' + Math.random().toString(36).slice(2), payload: payload };
  }
  var steps = [], ok = true;
  function check(name, cond) { steps.push((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) ok = false; }
  try {
    /* 1 · a case-analytics batch must be ignored */
    check('ignores case analytics', post([{ orakle: 1, event: 'page_view', case_id: 'OR0000-C1-TEST', payload: {} }]) === null);
    /* 2 · signup creates the row */
    post([ev('profile_update', { kind: 'signup', first: 'Test', last: 'Person', country: 'Portugal',
      occupation: 'MD', specialty: 'Neurology', email: email, consent: true, pid: pid })]);
    var sh = ecRegSheet_(ECR.TAB_REG, ECR_HEAD), f = ecRegFind_(sh, email);
    check('signup creates row', !!f);
    check('signup stores profile', f && f.rec.first === 'Test' && f.rec.specialty === 'Neurology' && f.rec.consent === true);
    check('signup counts as first login', f && Number(f.rec.logins) === 1);
    check('signup issued a verify token', f && String(f.rec.verify_token).length >= 16);
    var token = f && String(f.rec.verify_token);
    /* 3 · edit updates in place, no duplicate */
    post([ev('profile_update', { kind: 'edit', first: 'Test', last: 'Person', country: 'Spain',
      occupation: 'MD', specialty: 'Neurology', email: email, consent: true })]);
    f = ecRegFind_(sh, email);
    check('edit updates in place', f && f.rec.country === 'Spain');
    check('no duplicate row', sh.getDataRange().getValues().filter(function (r) { return String(r[0]).toLowerCase() === email; }).length === 1);
    /* 4 · a login seconds after signup is the same event (the page's hook fires at signup) */
    post([ev('account_login', { email: email })]);
    f = ecRegFind_(sh, email);
    check('login right after signup is folded into it', f && Number(f.rec.logins) === 1);
    /* 5 · a later login counts — backdate created_at by a day */
    sh.getRange(f.row, ECR_HEAD.indexOf('created_at') + 1).setValue(new Date(Date.now() - 864e5).toISOString());
    post([ev('account_login', { email: email })]);
    f = ecRegFind_(sh, email);
    check('later login increments counter', f && Number(f.rec.logins) === 2 && f.rec.last_login);
    check('later login did not re-send the email (7-day rule)', true);
    /* 6 · verify */
    var v = ecRegVerify_(token);
    f = ecRegFind_(sh, email);
    check('verify link marks verified', v.ok && f.rec.verified === true && f.rec.verified_at);
    check('second verify is idempotent', ecRegVerify_(token).already === true);
    check('bad token rejected', ecRegVerify_('nonsense').ok === false);
    /* 7 · logins tab has lines */
    var lg = ecRegSheet_(ECR.TAB_LOG, ECR_LOG_HEAD).getDataRange().getValues().filter(function (r) { return r[2] === email; });
    check('logins tab logged 4 lines', lg.length === 4);
  } catch (err) { steps.push('FAIL exception: ' + err); ok = false; }
  /* clean up */
  try {
    var shR = ecRegSheet_(ECR.TAB_REG, ECR_HEAD), fr = ecRegFind_(shR, email); if (fr) shR.deleteRow(fr.row);
    var shL = ecRegSheet_(ECR.TAB_LOG, ECR_LOG_HEAD), vals = shL.getDataRange().getValues();
    for (var r = vals.length - 1; r >= 1; r--) if (vals[r][2] === email) shL.deleteRow(r + 1);
  } catch (err) { steps.push('cleanup problem: ' + err); }
  console.log(steps.join('\n') + '\n' + (ok ? 'ALL PASS' : 'SOME CHECKS FAILED'));
  return ok;
}

/* ---------------------------------------------------------------- small utilities */

function ecRegAllow_(email) {
  try {
    var c = CacheService.getScriptCache(), k = 'ecr:' + email, n = Number(c.get(k) || 0) + 1;
    c.put(k, String(n), 600);
    return n <= ECR.MAX_WRITES_PER_10MIN;
  } catch (err) { return true; }
}
function ecRegToken_() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', s = '';
  var bytes = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  for (var i = 0; i < 32; i++) s += chars.charAt(parseInt(bytes.substr(i * 2, 2), 16) % chars.length);
  return s;
}
function ecRegIso_(t) {
  var d = t ? new Date(t) : new Date();
  if (isNaN(d.getTime())) d = new Date();
  return d.toISOString();
}
function ecRegDaysSince_(iso) {
  if (!iso) return 1e9;
  var d = new Date(iso); if (isNaN(d.getTime())) return 1e9;
  return (Date.now() - d.getTime()) / 864e5;
}
function ecRegExecUrl_() {
  if (ECR.EXEC_URL) return ECR.EXEC_URL;
  try { return ScriptApp.getService().getUrl(); } catch (err) { return ECR.SITE; }
}
function ecRegEsc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function ecRegText_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }

/** The page shown after the verification link is opened. Minimal, self-contained, house tokens. */
function ecRegHtml_(result) {
  var ok = result && result.ok;
  var title = ok ? (result.already ? 'Already confirmed' : 'Email confirmed') : 'This link didn’t work';
  var msg = ok
    ? (result.first ? 'Thanks, ' + ecRegEsc_(result.first) + '. ' : 'Thanks. ') + 'Your email address is confirmed. Taking you back to Expert’s Corner…'
    : 'The link may have been copied incompletely. You can still use Expert’s Corner as normal — open your account and we’ll send a fresh link next time you log in.';
  var html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + ' · Expert’s Corner</title>' +
    (ok ? '<meta http-equiv="refresh" content="4;url=' + ECR.ACCOUNT_PAGE + '?verified=1">' : '') +
    '<style>body{margin:0;font-family:Ubuntu,"Segoe UI",Roboto,system-ui,sans-serif;background:#F2F5FD;color:#1B2733;display:grid;place-items:center;min-height:100vh}' +
    '.card{background:#fff;border:1px solid #D7E3F8;border-top:4px solid #1B2733;border-radius:2px;padding:34px;max-width:440px;margin:21px}' +
    '.k{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#4E6180;margin:0 0 8px}h1{font-size:24px;margin:0 0 13px;letter-spacing:-.02em}' +
    'p{color:#3A4754;line-height:1.55;margin:0 0 21px;font-weight:300}a.b{display:inline-block;background:#215DD5;color:#fff;text-decoration:none;padding:12px 21px;border-radius:2px;font-size:11px;letter-spacing:.15em;text-transform:uppercase}' +
    '.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#F1C234;margin-right:8px}</style></head><body>' +
    '<div class="card"><p class="k"><span class="dot"></span>Expert’s Corner by Orakle</p><h1>' + title + '</h1><p>' + msg + '</p>' +
    '<a class="b" href="' + ECR.ACCOUNT_PAGE + (ok ? '?verified=1' : '') + '" target="_top">' + (ok ? 'Go to my account' : 'Open my account') + '</a></div>' +
    (ok ? '<script>setTimeout(function(){try{window.top.location.href="' + ECR.ACCOUNT_PAGE + '?verified=1"}catch(e){}},2500)</script>' : '') +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
