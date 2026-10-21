/* =========================================================
   SCHOOL FEES  (record payments, balances, receipts)

   1. Run fees.sql once in Supabase (SQL Editor).
   2. Load this file AFTER script.js / scripttt.js:
          <script src="fees.js"></script>

   A student who is not in the saved class list can be added by hand.
   School owner only (staff accounts don't see it).
   LOCK: the fees area has its own password (separate from the section
   password). It is asked every time the area is opened, and the area
   locks again when closed or after 10 minutes of no use.
   Forgot the fees password? A confirmation link is sent to the owner's
   email. Only after the link is opened can a new fees password be set.
   Fees are set per class, session and term. The bursar records
   each payment (cash, transfer, POS...) and prints a receipt.
   Balances carry forward from earlier terms in the same session.
   A wrong payment is cancelled, never deleted, so there is a record.
   ========================================================= */

(function () {
    "use strict";

    const TERMS = (typeof ACADEMIC_TERMS !== "undefined")
        ? ACADEMIC_TERMS : ["First Term", "Second Term", "Third Term"];
    const METHODS = ["Cash", "Bank transfer", "POS", "Cheque", "Waiver"];
    const PASSWORD_KEY = "feesPassword";            /* kept in the school settings, so it follows the school login */
    const RESET_KEY = "feesResetPending";            /* remembers, in this browser, that a reset link was sent */
    const RESET_QUERY = "fees_reset";                /* comes back on the address when the email link is opened */
    const RESET_TTL_MS = 30 * 60 * 1000;             /* the email link is only good for 30 minutes here */
    const IDLE_MS = 10 * 60 * 1000;                  /* auto-lock after 10 minutes without use */
    const SHOW_FLOATING_BUTTON = false;              /* the hamburger menu opens Fees now */
    const SETUP_HELP = "The fees tables are not set up yet. Run fees.sql in Supabase first (run it again if you updated fees.js).";

    let modal = null;
    let busy = false;
    let sel = { session: "", term: TERMS[0], className: "" };
    let data = { students: [], items: [], payments: [] };
    let view = { tab: "students", key: null, filter: "" };
    let feesUnlocked = false;
    let lastActive = Date.now();
    let idleTimer = null;

    /* ------------------------------------------------------
       Small helpers
       ------------------------------------------------------ */
    function esc(v) {
        return String(v == null ? "" : v)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function round2(n) { return Math.round(Number(n) * 100) / 100; }

    /* Same key the class list uses, so payments still match once the list is saved. */
    function keyFor(admissionNo, studentName) {
        if (typeof computeMatchKey === "function") return computeMatchKey(admissionNo, studentName);
        return String(admissionNo || "").trim() + "|" + String(studentName || "").trim().toLowerCase().replace(/\s+/g, " ");
    }

    function money(n) {
        try {
            return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(Number(n) || 0);
        } catch (e) { return "₦" + (Number(n) || 0).toFixed(2); }
    }

    function isOwner() { return typeof staffContext === "undefined" || !staffContext; }
    function inNativeApp() { return typeof isNativeApp === "function" && isNativeApp(); }

    function today() {
        const d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    function prettyDate(iso) {
        if (!iso) return "";
        const d = new Date(iso + "T00:00:00");
        return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    }

    function startYear() {
        if (typeof defaultAcademicSession === "function") {
            const y = Number(String(defaultAcademicSession()).split("/")[0]);
            if (y) return y;
        }
        const n = new Date();
        return n.getMonth() >= 8 ? n.getFullYear() : n.getFullYear() - 1;
    }

    function sessionList() {
        const first = typeof SESSION_LIST_START_YEAR !== "undefined" ? SESSION_LIST_START_YEAR : 2020;
        const list = [];
        for (let y = startYear(); y >= first; y--) list.push(y + "/" + (y + 1));
        return list;
    }

    function classList() {
        const names = (typeof schoolClasses !== "undefined" ? schoolClasses : [])
            .map(function (c) { return c.class_name; }).filter(Boolean);
        return names.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); });
    }

    function friendlyError(error, fallback) {
        const text = String((error && (error.message || error.code)) || "");
        if (/fee_items|fee_payments|fee_students|schema cache|does not exist|42P01|PGRST205/i.test(text)) return SETUP_HELP;
        return fallback + (text ? " (" + text + ")" : "");
    }

    /* ------------------------------------------------------
       Money in words (for receipts)
       ------------------------------------------------------ */
    const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven",
        "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

    function wordsBelow1000(n) {
        let s = "";
        if (n >= 100) {
            s += ONES[Math.floor(n / 100)] + " Hundred";
            n = n % 100;
            if (n) s += " and ";
        }
        if (n >= 20) {
            s += TENS[Math.floor(n / 10)];
            if (n % 10) s += "-" + ONES[n % 10];
        } else if (n > 0) {
            s += ONES[n];
        }
        return s;
    }

    function wordsInteger(n) {
        if (n === 0) return "Zero";
        const parts = [];
        [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]].forEach(function (pair) {
            if (n >= pair[0]) {
                parts.push(wordsBelow1000(Math.floor(n / pair[0])) + " " + pair[1]);
                n = n % pair[0];
            }
        });
        if (n > 0) parts.push((parts.length && n < 100 ? "and " : "") + wordsBelow1000(n));
        return parts.join(" ");
    }

    function nairaInWords(amount) {
        const total = Math.round(Number(amount) * 100);
        const naira = Math.floor(total / 100);
        const kobo = total % 100;
        let text = wordsInteger(naira) + " Naira";
        if (kobo) text += " and " + wordsInteger(kobo) + " Kobo";
        return text + " only";
    }

    /* ------------------------------------------------------
       The ledger calculation
       balance = brought forward (earlier terms, same session)
                 + fees this term - payments this term
       ------------------------------------------------------ */
    function computeLedger(students, items, payments, term) {
        const termIndex = TERMS.indexOf(term);
        const dueByTerm = {};
        items.forEach(function (i) { dueByTerm[i.term] = (dueByTerm[i.term] || 0) + Number(i.amount); });

        const paid = {};
        payments.forEach(function (p) {
            if (p.voided) return;
            if (!paid[p.match_key]) paid[p.match_key] = {};
            paid[p.match_key][p.term] = (paid[p.match_key][p.term] || 0) + Number(p.amount);
        });

        return students.map(function (s) {
            const mine = paid[s.match_key] || {};
            let carry = 0;
            for (let i = 0; i < termIndex; i++) {
                carry += (dueByTerm[TERMS[i]] || 0) - (mine[TERMS[i]] || 0);
            }
            const due = dueByTerm[term] || 0;
            const paidNow = mine[term] || 0;
            return {
                student: s,
                carry: round2(carry),
                due: round2(due),
                paid: round2(paidNow),
                balance: round2(carry + due - paidNow)
            };
        });
    }

    /* ------------------------------------------------------
       Loading from Supabase
       ------------------------------------------------------ */
    async function readAll(table, columns, orderCol) {
        const rows = [];
        for (let from = 0; ; from += 1000) {
            const res = await supabaseClient.from(table).select(columns)
                .eq("owner_user_id", currentUserId).eq("website_id", WEBSITE_ID)
                .eq("class_name", sel.className).eq("session", sel.session)
                .order(orderCol, { ascending: true }).range(from, from + 999);
            if (res.error) throw res.error;
            (res.data || []).forEach(function (r) { rows.push(r); });
            if (!res.data || res.data.length < 1000) break;
        }
        return rows;
    }

    async function loadData() {
        if (!sel.className) { data = { students: [], items: [], payments: [] }; return; }
        const results = await Promise.all([
            readAll("class_students", "admission_no,student_name,match_key,sort_order", "sort_order"),
            readAll("fee_items", "*", "created_at"),
            readAll("fee_payments", "*", "created_at"),
            readAll("fee_students", "id,admission_no,student_name,match_key", "student_name").catch(function () { return []; })
        ]);
        const students = results[0].sort(function (a, b) {
            return ((a.sort_order || 0) - (b.sort_order || 0)) ||
                String(a.student_name || "").localeCompare(String(b.student_name || ""));
        });
        /* students added by hand who are not (yet) in the saved class list */
        const seen = {};
        students.forEach(function (st) { seen[st.match_key] = true; });
        results[3].forEach(function (m) {
            if (seen[m.match_key]) return;
            seen[m.match_key] = true;
            students.push(Object.assign({}, m, { manual: true, sort_order: 1000000 }));
        });
        data = { students: students, items: results[1], payments: results[2] };
    }

    function ledger() { return computeLedger(data.students, data.items, data.payments, sel.term); }

    /* Receipt look: used on screen and in the separate print window */
    const RECEIPT_CSS =
        "#feesReceiptBox{max-width:420px;margin:0 auto}" +
        "#feesReceiptBox .r-head{text-align:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:10px}" +
        "#feesReceiptBox .r-head img{max-height:60px;max-width:120px;object-fit:contain}#feesReceiptBox .r-school{font-size:18px;font-weight:700}" +
        "#feesReceiptBox .r-title{text-align:center;font-weight:700;letter-spacing:1px;margin:6px 0 10px}" +
        "#feesReceiptBox .r-line{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dotted #999}" +
        "#feesReceiptBox .r-amount{text-align:center;font-size:22px;font-weight:700;margin:12px 0 2px}#feesReceiptBox .r-words{text-align:center;font-style:italic;margin-bottom:12px}" +
        "#feesReceiptBox .r-sign{margin-top:28px;border-top:1px solid #000;width:55%;padding-top:3px;font-size:12px}";

    /* ------------------------------------------------------
       Styles and shell
       ------------------------------------------------------ */
    function injectStyles() {
        if (document.getElementById("feesStyles")) return;
        const st = document.createElement("style");
        st.id = "feesStyles";
        st.textContent =
            "#feesButton{position:fixed;left:10px;bottom:14px;z-index:9997;padding:6px 10px;border:0;border-radius:20px;background:#0b8f4d;color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;width:auto!important;min-width:0!important;margin:0!important;display:inline-block}" +
            "#feesOverlay,#feesReceiptOverlay{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:10px}" +
            "#feesBox,#feesReceiptBox{background:#fff;color:#222;width:100%;max-width:520px;max-height:92vh;overflow:auto;border-radius:12px;padding:14px;font:14px system-ui,sans-serif}" +
            "#feesBox h3{margin:0;font-size:18px}#feesBox .f-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}" +
            "#feesBox .f-x{border:0;background:none;font-size:24px;line-height:1;cursor:pointer;color:#555}" +
            "#feesBox .f-sel{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px}#feesBox .f-sel select:last-child{grid-column:1/3}" +
            "#feesBox select,#feesBox input{width:100%;padding:8px;border:1px solid #bbb;border-radius:8px;font-size:14px;background:#fff;color:#222;box-sizing:border-box}" +
            "#feesBox .f-tabs{display:flex;gap:6px;margin-bottom:10px}#feesBox .f-tab{flex:1;padding:8px 4px;border:1px solid #0b8f4d;border-radius:8px;background:#fff;color:#0b8f4d;font-weight:600;cursor:pointer}" +
            "#feesBox .f-tab.on{background:#0b8f4d;color:#fff}" +
            "#feesBox .f-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 8px;border:1px solid #ddd;border-radius:8px;margin-bottom:6px;cursor:pointer}" +
            "#feesBox .f-row.plain{cursor:default}#feesBox .f-meta{color:#666;font-size:12px}" +
            "#feesBox .f-owe{color:#b00020;font-weight:700;white-space:nowrap}#feesBox .f-ok{color:#0b8f4d;font-weight:700;white-space:nowrap}#feesBox .f-void{text-decoration:line-through;opacity:.55}" +
            "#feesBox .f-btn{width:100%;padding:11px;border:0;border-radius:8px;background:#0b8f4d;color:#fff;font-weight:700;margin-top:8px;cursor:pointer}" +
            "#feesBox .f-btn.alt{background:#fff;color:#0b8f4d;border:1px solid #0b8f4d}#feesBox .f-btn:disabled{opacity:.5}" +
            "#feesBox .f-small{padding:5px 9px;border:1px solid #0b8f4d;border-radius:6px;background:#fff;color:#0b8f4d;font-size:12px;cursor:pointer}" +
            "#feesBox .f-small.red{border-color:#b00020;color:#b00020}" +
            "#feesBox .f-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:6px 0}" +
            "#feesBox .f-box{background:#f1f3f4;border-radius:8px;padding:8px;margin:8px 0}" +
            "#feesBox .f-line{display:flex;justify-content:space-between;padding:2px 0}#feesBox .f-line.total{border-top:1px solid #bbb;margin-top:4px;padding-top:6px;font-weight:700}" +
            "#feesBox .f-status{margin-top:8px;padding:8px;border-radius:8px;background:#f1f3f4;white-space:pre-wrap;display:none}" +
            "#feesBox .f-status.err{background:#fde8e8;color:#a00;display:block}#feesBox .f-status.ok{background:#e6f4ea;color:#0a5;display:block}" +
            "#feesBox .f-back{border:0;background:none;color:#0b8f4d;font-weight:700;padding:4px 0;margin-bottom:6px;cursor:pointer}" +
            "#feesReceiptBox{background:#fff;color:#000}" + RECEIPT_CSS +
            "#feesReceiptBox .r-actions{display:flex;gap:8px;margin-top:14px}#feesReceiptBox .r-actions button{flex:1;padding:10px;border:0;border-radius:8px;background:#0b8f4d;color:#fff;font-weight:700;cursor:pointer}#feesReceiptBox .r-actions button.alt{background:#eee;color:#222}";
        document.head.appendChild(st);
    }

    function setStatus(text, kind) {
        const el = modal && modal.querySelector(".f-status");
        if (!el) return;
        el.textContent = text || "";
        el.className = "f-status" + (text && kind ? " " + kind : "");
        if (!text) el.style.display = "none"; else el.style.display = "block";
    }

    function closeModal() {
        if (modal) { modal.remove(); modal = null; }
        feesUnlocked = false;
        if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    }

    /* ------------------------------------------------------
       The password lock (uses the same password pop-up as the
       school sections, but its own separate password)
       ------------------------------------------------------ */
    function lockToolsReady() {
        return typeof srgPasswordDialog === "function" && typeof srgHashPassword === "function" &&
            typeof srgRandomSalt === "function" && typeof saveAppData === "function" &&
            typeof reportSettings !== "undefined" && !!reportSettings;
    }

    function passwordRecord() {
        const r = reportSettings ? reportSettings[PASSWORD_KEY] : null;
        return r && r.hash && r.salt ? r : null;
    }

    async function checkPassword(value, record) {
        if (!value) return "Enter the password.";
        const hash = await srgHashPassword(value, record.salt);
        return hash === record.hash ? "" : "Wrong password. Try again.";
    }

    async function setNewPassword(isFirst) {
        const result = await srgPasswordDialog({
            title: isFirst ? "🔒 Set the fees password" : "Change the fees password",
            message: "The fees area will ask for this password each time it is opened. It is separate from the section password. " +
                "If it is forgotten, a confirmation link can be sent to the owner's email to reset it.",
            confirmText: "Save password",
            confirmField: true,
            verify: function (value, confirm) {
                if (value.length < 4) return "Use at least 4 characters.";
                if (value !== confirm) return "The two passwords do not match.";
                return "";
            }
        });
        if (!result || result.action !== "ok") return false;
        const salt = srgRandomSalt();
        const hash = await srgHashPassword(result.value, salt);
        reportSettings[PASSWORD_KEY] = { salt: salt, hash: hash };
        saveAppData();
        return true;
    }

    /* Forgot the password: a confirmation link is sent to the owner's email.
       The new fees password can only be set after that link is opened.
       A separate temporary connection sends it, so the current sign-in is
       never disturbed. */
    function tempClient() {
        return supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "fees-verify" }
        });
    }

    function randomToken() {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    }

    async function sendResetLink() {
        let email = "";
        try {
            const u = await supabaseClient.auth.getUser();
            email = u && u.data && u.data.user && u.data.user.email;
        } catch (e) { /* handled below */ }
        if (!email || typeof supabase === "undefined" || typeof SUPABASE_URL === "undefined") {
            alert("Could not confirm your account right now. Sign out, sign in again, and try once more.");
            return false;
        }
        if (!confirm("To reset the fees password, a confirmation link will be sent to:\n\n" + email + "\n\nOpen the link in this same browser, then you can set a new fees password. Send the link now?")) return false;

        const token = randomToken();
        const redirect = location.origin + location.pathname + "?" + RESET_QUERY + "=" + token;
        try {
            const res = await tempClient().auth.signInWithOtp({
                email: email,
                options: { emailRedirectTo: redirect, shouldCreateUser: false }
            });
            if (res.error) {
                alert("Could not send the link: " + res.error.message + "\n\nIf you just asked for one, wait a minute and try again.");
                return false;
            }
        } catch (e) {
            alert("Could not send the link. Check your internet connection and try again.");
            return false;
        }
        try {
            localStorage.setItem(RESET_KEY, JSON.stringify({ token: token, email: email, exp: Date.now() + RESET_TTL_MS }));
        } catch (e) { /* if storage is blocked the link cannot be matched later */ }
        alert("A confirmation link has been sent to " + email + ".\n\nOpen it from your email in this browser. You will then be asked to set a new fees password.");
        return false;    /* the fees area stays closed until the link is opened */
    }

    /* Runs when the page loads. If the address carries the reset code, the
       email link was just opened: check it matches the one we sent, then let
       the owner choose a new fees password. */
    function takeResetCodeFromAddress() {
        let code = "";
        try {
            const params = new URLSearchParams(location.search);
            code = params.get(RESET_QUERY) || "";
            if (code) {
                params.delete(RESET_QUERY);
                const rest = params.toString();
                history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
            }
        } catch (e) { /* ignore */ }
        return code;
    }

    async function finishResetFromEmail(code) {
        let pending = null;
        try { pending = JSON.parse(localStorage.getItem(RESET_KEY) || "null"); } catch (e) { /* ignore */ }
        try { localStorage.removeItem(RESET_KEY); } catch (e) { /* ignore */ }   /* a link works once */
        if (!pending || pending.token !== code || Date.now() > pending.exp) {
            alert("This confirmation link has expired, was already used, or was not requested from this browser.\n\nOpen School Fees, tap \"Forgot password?\" and ask for a new link.");
            return;
        }
        /* wait for the website to finish signing the owner in */
        let ready = false;
        for (let i = 0; i < 120 && !ready; i++) {
            ready = lockToolsReady() && typeof currentUserId !== "undefined" && !!currentUserId;
            if (!ready) await new Promise(function (r) { setTimeout(r, 500); });
        }
        let email = "";
        try {
            const u = await supabaseClient.auth.getUser();
            email = u && u.data && u.data.user && u.data.user.email;
        } catch (e) { /* handled below */ }
        if (!ready || !email || email !== pending.email || !isOwner()) {
            alert("Could not confirm the link. Sign in as the school owner and ask for a new link.");
            return;
        }
        if (await setNewPassword(false)) {
            feesUnlocked = true;                           /* they just proved who they are */
            open();
        }
    }

    /* Resolves true when the person may open the fees area. */
    async function ensureUnlocked() {
        if (!lockToolsReady()) {
            alert("The fees lock could not start. Please refresh the page and try again.");
            return false;
        }
        const record = passwordRecord();
        if (!record) return setNewPassword(true);      /* first time: a password must be set */
        if (feesUnlocked) return true;

        const result = await srgPasswordDialog({
            title: "🔒 School fees",
            message: "Enter the fees password to open this area.",
            confirmText: "Open",
            secondaryText: "Forgot password?",
            verify: function (value) { return checkPassword(value, record); }
        });
        if (!result) return false;
        if (result.action === "secondary") return sendResetLink();
        return result.action === "ok";
    }

    async function changePassword() {
        if (busy || !lockToolsReady()) return;
        const record = passwordRecord();
        if (record) {
            const current = await srgPasswordDialog({
                title: "🔒 Fees password",
                message: "Enter the current password to change it.",
                confirmText: "Continue",
                verify: function (value) { return checkPassword(value, record); }
            });
            if (!current || current.action !== "ok") return;
        }
        if (await setNewPassword(!record)) setStatus("✔ Fees password changed.", "ok");
    }

    async function open() {
        if (!isOwner()) { alert("Only the school owner can manage school fees."); return; }
        if (typeof currentUserId === "undefined" || !currentUserId) { alert("Please sign in first."); return; }
        const classes = classList();
        if (!classes.length) { alert("Add your classes first, then open School Fees."); return; }
        if (modal) return;                                 /* already open */
        if (!(await ensureUnlocked())) return;
        feesUnlocked = true;

        injectStyles();
        const sessions = sessionList();
        if (!sel.session || sessions.indexOf(sel.session) === -1) sel.session = sessions[0];
        if (!sel.className || classes.indexOf(sel.className) === -1) sel.className = classes[0];
        view = { tab: "students", key: null, filter: "" };

        modal = document.createElement("div");
        modal.id = "feesOverlay";
        modal.innerHTML =
            '<div id="feesBox"><div class="f-head"><h3>₦ School Fees</h3><div><button class="f-x" id="fLock" type="button" title="Change the fees password" style="font-size:18px;margin-right:6px">🔒</button><button class="f-x" id="fClose" type="button" title="Close and lock">×</button></div></div>' +
            '<div class="f-sel">' +
            '<select id="fSession">' + sessions.map(function (s) { return '<option' + (s === sel.session ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + "</select>" +
            '<select id="fTerm">' + TERMS.map(function (t) { return '<option' + (t === sel.term ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") + "</select>" +
            '<select id="fClass">' + classes.map(function (c) { return '<option' + (c === sel.className ? " selected" : "") + ">" + esc(c) + "</option>"; }).join("") + "</select>" +
            "</div>" +
            '<div class="f-tabs"><button class="f-tab on" data-tab="students" type="button">Students</button>' +
            '<button class="f-tab" data-tab="setup" type="button">Fee setup</button>' +
            '<button class="f-tab" data-tab="summary" type="button">Summary</button></div>' +
            '<div id="fBody"></div><div class="f-status"></div></div>';
        document.body.appendChild(modal);

        modal.querySelector("#fClose").onclick = closeModal;
        modal.querySelector("#fLock").onclick = changePassword;

        /* lock again after a stretch of no use */
        lastActive = Date.now();
        ["click", "keydown", "input", "touchstart"].forEach(function (name) {
            modal.addEventListener(name, function () { lastActive = Date.now(); }, true);
        });
        idleTimer = setInterval(function () {
            if (modal && !busy && Date.now() - lastActive > IDLE_MS) closeModal();
        }, 30000);
        modal.addEventListener("click", function (e) { if (e.target === modal && !busy) closeModal(); });
        ["fSession", "fTerm", "fClass"].forEach(function (id) {
            modal.querySelector("#" + id).onchange = function () {
                if (busy) return;
                sel.session = modal.querySelector("#fSession").value;
                sel.term = modal.querySelector("#fTerm").value;
                sel.className = modal.querySelector("#fClass").value;
                view.key = null;
                refresh();
            };
        });
        modal.querySelectorAll(".f-tab").forEach(function (b) {
            b.onclick = function () {
                if (busy) return;
                view.tab = b.dataset.tab;
                view.key = null;
                modal.querySelectorAll(".f-tab").forEach(function (x) { x.classList.toggle("on", x === b); });
                setStatus("");
                render();
            };
        });
        refresh();
    }

    async function refresh() {
        const body = modal && modal.querySelector("#fBody");
        if (!body) return;
        body.innerHTML = '<p class="f-meta">Loading…</p>';
        setStatus("");
        try {
            await loadData();
            if (!modal) return;
            render();
        } catch (e) {
            if (modal) { body.innerHTML = ""; setStatus("✖ " + friendlyError(e, "Could not load fees"), "err"); }
        }
    }

    function render() {
        if (!modal) return;
        if (view.tab === "setup") renderSetup();
        else if (view.tab === "summary") renderSummary();
        else if (view.key) renderStudent(view.key);
        else renderStudents();
    }

    /* ------------------------------------------------------
       Students tab
       ------------------------------------------------------ */
    function balanceChip(row) {
        if (row.due === 0 && row.carry === 0 && row.paid === 0) return '<span class="f-meta">No fees set</span>';
        if (row.balance > 0) return '<span class="f-owe">Owes ' + esc(money(row.balance)) + "</span>";
        if (row.balance < 0) return '<span class="f-ok">Credit ' + esc(money(-row.balance)) + "</span>";
        return '<span class="f-ok">Paid in full</span>';
    }

    function renderStudents() {
        const body = modal.querySelector("#fBody");
        if (!data.items.some(function (i) { return i.term === sel.term; })) {
            body.innerHTML = '<p class="f-box">No fees are set for ' + esc(sel.className) + ", " + esc(sel.term) + " yet. Open the <strong>Fee setup</strong> tab first.</p>";
            return;
        }
        const rows = ledger();
        body.innerHTML =
            '<div class="f-grid" style="grid-template-columns:1fr auto"><input id="fSearch" type="search" placeholder="Search student name or admission no" value="' + esc(view.filter) + '">' +
            '<button class="f-small" id="fAddToggle" type="button">+ Add student</button></div>' +
            '<div id="fAddBox" class="f-box" style="display:' + (data.students.length ? "none" : "block") + '">' +
            '<div class="f-meta" style="margin-bottom:6px">For a student who is not in the saved class list. Use the same admission number and spelling as the class list, so the records match when the list is saved.</div>' +
            '<div class="f-grid"><input id="sName" type="text" placeholder="Student name"><input id="sAdm" type="text" placeholder="Admission no (optional)"></div>' +
            '<button class="f-btn" id="sAddSave" type="button">Add student</button></div>' +
            '<div id="fList" style="margin-top:8px"></div>';
        const draw = function () {
            const q = view.filter.trim().toLowerCase();
            const shown = rows.filter(function (r) {
                return !q || String(r.student.student_name || "").toLowerCase().indexOf(q) !== -1 ||
                    String(r.student.admission_no || "").toLowerCase().indexOf(q) !== -1;
            });
            modal.querySelector("#fList").innerHTML = shown.map(function (r) {
                return '<div class="f-row" data-key="' + esc(r.student.match_key) + '"><div><strong>' + esc(r.student.student_name) + "</strong>" +
                    '<div class="f-meta">' + esc(r.student.admission_no || "") + (r.student.manual ? " · added by hand" : "") + "</div></div>" + balanceChip(r) + "</div>";
            }).join("") || '<p class="f-meta">' + (data.students.length ? "No match." : "No students yet. Add one above, or save the class list in the app.") + "</p>";
            modal.querySelectorAll("#fList .f-row").forEach(function (el) {
                el.onclick = function () { view.key = el.dataset.key; render(); };
            });
        };
        modal.querySelector("#fSearch").oninput = function (e) { view.filter = e.target.value; draw(); };
        modal.querySelector("#fAddToggle").onclick = function () {
            const box = modal.querySelector("#fAddBox");
            box.style.display = box.style.display === "none" ? "block" : "none";
        };
        modal.querySelector("#sAddSave").onclick = addStudent;
        draw();
    }

    async function addStudent() {
        if (busy) return;
        const name = modal.querySelector("#sName").value.trim().replace(/\s+/g, " ");
        const adm = modal.querySelector("#sAdm").value.trim();
        if (!name) { setStatus("Enter the student's name.", "err"); return; }
        const key = keyFor(adm, name);
        if (data.students.some(function (st) { return st.match_key === key; })) { setStatus("This student is already in the list.", "err"); return; }
        busy = true;
        try {
            const res = await supabaseClient.from("fee_students").insert({
                owner_user_id: currentUserId, website_id: WEBSITE_ID, class_name: sel.className,
                session: sel.session, admission_no: adm, student_name: name, match_key: key
            });
            if (res.error) {
                if (res.error.code === "23505") throw new Error("This student is already added.");
                throw res.error;
            }
            view.filter = "";
            await loadData();
            render();
            setStatus("✔ " + name + " added. Tap the name to record a payment.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not add the student"), "err");
        } finally { busy = false; }
    }

    async function removeManualStudent(id) {
        if (busy) return;
        if (!confirm("Remove this student from the fees list? They have no payments recorded.")) return;
        busy = true;
        try {
            const res = await supabaseClient.from("fee_students").delete().eq("id", id).eq("owner_user_id", currentUserId);
            if (res.error) throw res.error;
            view.key = null;
            await loadData();
            render();
            setStatus("Student removed.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not remove the student"), "err");
        } finally { busy = false; }
    }

    function renderStudent(key) {
        const body = modal.querySelector("#fBody");
        const row = ledger().filter(function (r) { return r.student.match_key === key; })[0];
        if (!row) { view.key = null; renderStudents(); return; }
        const s = row.student;
        const termItems = data.items.filter(function (i) { return i.term === sel.term; });
        const history = data.payments.filter(function (p) { return p.match_key === key && p.term === sel.term; })
            .sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });

        body.innerHTML =
            '<button class="f-back" type="button">‹ Back to students</button>' +
            "<h3>" + esc(s.student_name) + "</h3>" +
            '<div class="f-meta">' + esc(s.admission_no || "") + " · " + esc(sel.className) + " · " + esc(sel.term) + ", " + esc(sel.session) + "</div>" +
            '<div class="f-box">' +
            (row.carry !== 0 ? '<div class="f-line"><span>Brought forward</span><span>' + esc(money(row.carry)) + "</span></div>" : "") +
            termItems.map(function (i) { return '<div class="f-line"><span>' + esc(i.item_name) + "</span><span>" + esc(money(i.amount)) + "</span></div>"; }).join("") +
            '<div class="f-line"><span>Total due</span><span>' + esc(money(row.carry + row.due)) + "</span></div>" +
            '<div class="f-line"><span>Paid</span><span>' + esc(money(row.paid)) + "</span></div>" +
            '<div class="f-line total"><span>Balance</span><span>' + esc(money(row.balance)) + "</span></div></div>" +
            "<strong>Record a payment</strong>" +
            '<div class="f-grid"><input id="pAmount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount (₦)">' +
            '<select id="pMethod">' + METHODS.map(function (m) { return "<option>" + esc(m) + "</option>"; }).join("") + "</select>" +
            '<input id="pDate" type="date" value="' + today() + '">' +
            '<input id="pRef" type="text" placeholder="Reference (optional)"></div>' +
            '<input id="pNote" type="text" placeholder="Note (optional)">' +
            '<button class="f-btn" id="pSave" type="button">Save payment and show receipt</button>' +
            '<div style="margin-top:14px"><strong>Payments this term</strong></div>' +
            (history.map(function (p) {
                return '<div class="f-row plain' + (p.voided ? " f-void" : "") + '"><div><strong>' + esc(money(p.amount)) + "</strong> · " + esc(p.method) +
                    '<div class="f-meta">' + esc(prettyDate(p.paid_on)) + " · " + esc(p.receipt_no) + (p.reference ? " · " + esc(p.reference) : "") +
                    (p.voided ? " · cancelled: " + esc(p.void_reason || "") : "") + "</div></div>" +
                    (p.voided ? "" :
                        '<div><button class="f-small" data-receipt="' + esc(p.id) + '" type="button">Receipt</button> ' +
                        '<button class="f-small red" data-cancel="' + esc(p.id) + '" type="button">Cancel</button></div>') + "</div>";
            }).join("") || '<p class="f-meta">No payments yet.</p>') +
            ((s.manual && s.id && !data.payments.some(function (p) { return p.match_key === key; }))
                ? '<button class="f-btn alt" id="sRemove" type="button">Remove this student</button>' : "");

        const rm = body.querySelector("#sRemove");
        if (rm) rm.onclick = function () { removeManualStudent(s.id); };
        body.querySelector(".f-back").onclick = function () { view.key = null; setStatus(""); render(); };
        body.querySelector("#pSave").onclick = function () { savePayment(s, row); };
        body.querySelectorAll("[data-receipt]").forEach(function (b) {
            b.onclick = function () { showReceipt(b.dataset.receipt); };
        });
        body.querySelectorAll("[data-cancel]").forEach(function (b) {
            b.onclick = function () { cancelPayment(b.dataset.cancel); };
        });
    }

    function makeReceiptNo() {
        const d = new Date();
        const stamp = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
        return "R" + stamp + "-" + String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    }

    async function savePayment(student, row) {
        if (busy) return;
        const amount = round2(modal.querySelector("#pAmount").value);
        const method = modal.querySelector("#pMethod").value;
        const paidOn = modal.querySelector("#pDate").value || today();
        const reference = modal.querySelector("#pRef").value.trim();
        const note = modal.querySelector("#pNote").value.trim();

        if (!(amount > 0)) { setStatus("Enter an amount greater than zero.", "err"); return; }
        if (amount > row.balance && row.balance >= 0 &&
            !confirm("This is more than the balance of " + money(row.balance) + ". Record it anyway?")) return;

        busy = true;
        const btn = modal.querySelector("#pSave");
        btn.disabled = true;
        try {
            let saved = null;
            for (let attempt = 0; attempt < 4 && !saved; attempt++) {
                const res = await supabaseClient.from("fee_payments").insert({
                    owner_user_id: currentUserId, website_id: WEBSITE_ID,
                    class_name: sel.className, session: sel.session, term: sel.term,
                    match_key: student.match_key, admission_no: student.admission_no || "",
                    student_name: student.student_name || "",
                    amount: amount, method: method, reference: reference || null, note: note || null,
                    receipt_no: makeReceiptNo(), paid_on: paidOn, recorded_by: currentUserId
                }).select().single();
                if (res.error) {
                    if (res.error.code === "23505") continue;   /* receipt number clash: try another */
                    throw res.error;
                }
                saved = res.data;
            }
            if (!saved) throw new Error("Could not create a receipt number. Try again.");
            await loadData();
            render();
            setStatus("✔ Payment saved · " + saved.receipt_no, "ok");
            showReceipt(saved.id);
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not save the payment"), "err");
        } finally {
            busy = false;
            const b = modal && modal.querySelector("#pSave");
            if (b) b.disabled = false;
        }
    }

    async function cancelPayment(id) {
        if (busy) return;
        const reason = (prompt("Why is this payment being cancelled?") || "").trim();
        if (!reason) { setStatus("A reason is needed to cancel a payment.", "err"); return; }
        busy = true;
        try {
            const res = await supabaseClient.from("fee_payments")
                .update({ voided: true, void_reason: reason })
                .eq("id", id).eq("owner_user_id", currentUserId);
            if (res.error) throw res.error;
            await loadData();
            render();
            setStatus("Payment cancelled. It stays in the record, marked cancelled.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not cancel the payment"), "err");
        } finally { busy = false; }
    }

    /* ------------------------------------------------------
       Receipt
       ------------------------------------------------------ */
    function receiptMarkup(p, balance) {
        const name = (typeof schoolNameInput !== "undefined" && schoolNameInput && schoolNameInput.value) || "";
        const address = (typeof schoolAddressInput !== "undefined" && schoolAddressInput && schoolAddressInput.value) || "";
        const logo = (typeof reportSettings !== "undefined" && reportSettings && typeof reportSettings.schoolLogo === "string") ? reportSettings.schoolLogo : "";
        return '<div class="r-head">' +
            (logo ? '<img src="' + esc(logo) + '" alt=""><br>' : "") +
            '<div class="r-school">' + esc(name || "School") + "</div>" +
            (address ? "<div>" + esc(address) + "</div>" : "") + "</div>" +
            '<div class="r-title">PAYMENT RECEIPT</div>' +
            '<div class="r-line"><span>Receipt no.</span><strong>' + esc(p.receipt_no) + "</strong></div>" +
            '<div class="r-line"><span>Date</span><span>' + esc(prettyDate(p.paid_on)) + "</span></div>" +
            '<div class="r-line"><span>Received from</span><strong>' + esc(p.student_name) + "</strong></div>" +
            (p.admission_no ? '<div class="r-line"><span>Admission no.</span><span>' + esc(p.admission_no) + "</span></div>" : "") +
            '<div class="r-line"><span>Class</span><span>' + esc(p.class_name) + "</span></div>" +
            '<div class="r-line"><span>Session / Term</span><span>' + esc(p.session) + " · " + esc(p.term) + "</span></div>" +
            '<div class="r-line"><span>Payment method</span><span>' + esc(p.method) + "</span></div>" +
            (p.reference ? '<div class="r-line"><span>Reference</span><span>' + esc(p.reference) + "</span></div>" : "") +
            '<div class="r-amount">' + esc(money(p.amount)) + "</div>" +
            '<div class="r-words">' + esc(nairaInWords(p.amount)) + "</div>" +
            '<div class="r-line"><span>Balance after this payment</span><strong>' + esc(money(balance)) + "</strong></div>" +
            '<div class="r-sign">Received by (signature)</div>';
    }

    /* Prints in its own window, so nothing else on the page (such as
       generated reports) can end up in the print preview. */
    function printReceipt(markup) {
        const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt</title>' +
            '<style>@page{margin:12mm}body{margin:16px;font:14px system-ui,Arial,sans-serif;color:#000;background:#fff}' + RECEIPT_CSS + "</style></head>" +
            '<body><div id="feesReceiptBox">' + markup + "</div></body></html>";

        /* Inside the Android app: use the app's own print plugin (ReceiptPrint) */
        const cap = window.Capacitor;
        if (cap && cap.Plugins && cap.Plugins.ReceiptPrint) {
            cap.Plugins.ReceiptPrint.print({ html: html, title: "Receipt" })
                .catch(function () { alert("Could not open the printer. Please try again."); });
            return;
        }

        const w = window.open("", "_blank");
        if (w) {
            w.document.open();
            w.document.write(html);
            w.document.close();
            w.focus();
            setTimeout(function () { try { w.print(); } catch (e) { /* the person can print from the tab */ } }, 400);
            return;
        }

        /* pop-up blocked: print from a hidden frame instead */
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
        document.body.appendChild(frame);
        const doc = frame.contentWindow.document;
        doc.open();
        doc.write(html);
        doc.close();
        setTimeout(function () {
            try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { /* ignore */ }
            setTimeout(function () { frame.remove(); }, 3000);
        }, 400);
    }

    function showReceipt(paymentId) {
        const p = data.payments.filter(function (x) { return x.id === paymentId; })[0];
        if (!p) return;

        /* balance right after this payment: only payments made up to this one count */
        const upTo = data.payments.filter(function (x) {
            return !x.voided && (x.id === p.id || String(x.created_at) <= String(p.created_at));
        });
        const row = computeLedger(data.students, data.items, upTo, p.term)
            .filter(function (r) { return r.student.match_key === p.match_key; })[0];
        const markup = receiptMarkup(p, row ? row.balance : 0);

        const old = document.getElementById("feesReceiptOverlay");
        if (old) old.remove();
        const overlay = document.createElement("div");
        overlay.id = "feesReceiptOverlay";
        overlay.innerHTML = '<div id="feesReceiptBox">' + markup +
            '<div class="r-actions"><button type="button" id="rPrint">Print</button><button type="button" class="alt" id="rClose">Close</button></div></div>';
        document.body.appendChild(overlay);
        overlay.querySelector("#rClose").onclick = function () { overlay.remove(); };
        overlay.querySelector("#rPrint").onclick = function () {
            const cap = window.Capacitor;
            if (inNativeApp() && !(cap && cap.Plugins && cap.Plugins.ReceiptPrint)) {
                alert("Printing receipts needs the latest app update. Please update the app, print from the website, or take a screenshot of the receipt.");
                return;
            }
            printReceipt(markup);
        };
    }

    /* ------------------------------------------------------
       Fee setup tab
       ------------------------------------------------------ */
    function renderSetup() {
        const body = modal.querySelector("#fBody");
        const items = data.items.filter(function (i) { return i.term === sel.term; });
        const total = items.reduce(function (n, i) { return n + Number(i.amount); }, 0);

        body.innerHTML =
            '<p class="f-meta">Fees for <strong>' + esc(sel.className) + "</strong>, " + esc(sel.term) + ", " + esc(sel.session) + "</p>" +
            (items.map(function (i) {
                return '<div class="f-row plain"><div><strong>' + esc(i.item_name) + "</strong></div><div>" + esc(money(i.amount)) +
                    ' <button class="f-small red" data-del="' + esc(i.id) + '" type="button">Delete</button></div></div>';
            }).join("") || '<p class="f-box">No fees yet. Add the first one below, for example Tuition.</p>') +
            (items.length ? '<div class="f-line total"><span>Total per student</span><span>' + esc(money(total)) + "</span></div>" : "") +
            '<div class="f-grid" style="margin-top:12px"><input id="iName" type="text" placeholder="Fee name (e.g. Tuition)">' +
            '<input id="iAmount" type="number" inputmode="decimal" min="0" step="0.01" placeholder="Amount (₦)"></div>' +
            '<button class="f-btn" id="iAdd" type="button">Add fee</button>' +
            (items.length ? '<button class="f-btn alt" id="iCopy" type="button">Copy these fees to all other classes</button>' : "");

        body.querySelector("#iAdd").onclick = addItem;
        const copy = body.querySelector("#iCopy");
        if (copy) copy.onclick = copyToOtherClasses;
        body.querySelectorAll("[data-del]").forEach(function (b) {
            b.onclick = function () { deleteItem(b.dataset.del); };
        });
    }

    async function addItem() {
        if (busy) return;
        const name = modal.querySelector("#iName").value.trim();
        const amount = round2(modal.querySelector("#iAmount").value);
        if (!name) { setStatus("Enter the fee name.", "err"); return; }
        if (!(amount >= 0) || modal.querySelector("#iAmount").value === "") { setStatus("Enter the amount.", "err"); return; }
        busy = true;
        try {
            const res = await supabaseClient.from("fee_items").upsert({
                owner_user_id: currentUserId, website_id: WEBSITE_ID, class_name: sel.className,
                session: sel.session, term: sel.term, item_name: name, amount: amount
            }, { onConflict: "owner_user_id,website_id,class_name,session,term,item_name" });
            if (res.error) throw res.error;
            await loadData();
            render();
            setStatus("✔ Fee saved.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not save the fee"), "err");
        } finally { busy = false; }
    }

    async function deleteItem(id) {
        if (busy) return;
        if (!confirm("Delete this fee? Balances for this class and term will change.")) return;
        busy = true;
        try {
            const res = await supabaseClient.from("fee_items").delete().eq("id", id).eq("owner_user_id", currentUserId);
            if (res.error) throw res.error;
            await loadData();
            render();
            setStatus("Fee deleted.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not delete the fee"), "err");
        } finally { busy = false; }
    }

    async function copyToOtherClasses() {
        if (busy) return;
        const items = data.items.filter(function (i) { return i.term === sel.term; });
        const others = classList().filter(function (c) { return c !== sel.className; });
        if (!items.length || !others.length) { setStatus("There are no other classes to copy to.", "err"); return; }
        if (!confirm("Copy these " + items.length + " fee(s) to " + others.length + " other class(es) for " + sel.term + ", " + sel.session +
            "?\n\nA fee with the same name in another class will be replaced by this amount.")) return;
        busy = true;
        try {
            const rows = [];
            others.forEach(function (cls) {
                items.forEach(function (i) {
                    rows.push({
                        owner_user_id: currentUserId, website_id: WEBSITE_ID, class_name: cls,
                        session: sel.session, term: sel.term, item_name: i.item_name, amount: i.amount
                    });
                });
            });
            for (let k = 0; k < rows.length; k += 500) {
                const res = await supabaseClient.from("fee_items")
                    .upsert(rows.slice(k, k + 500), { onConflict: "owner_user_id,website_id,class_name,session,term,item_name" });
                if (res.error) throw res.error;
            }
            setStatus("✔ Copied to " + others.length + " class(es).", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not copy the fees"), "err");
        } finally { busy = false; }
    }

    /* ------------------------------------------------------
       Summary tab (+ Excel)
       ------------------------------------------------------ */
    function renderSummary() {
        const body = modal.querySelector("#fBody");
        if (!data.students.length) { body.innerHTML = "<p>No students in this class and session.</p>"; return; }
        const rows = ledger();
        const expected = rows.reduce(function (n, r) { return n + r.due; }, 0);
        const collected = rows.reduce(function (n, r) { return n + r.paid; }, 0);
        const owing = rows.filter(function (r) { return r.balance > 0; }).sort(function (a, b) { return b.balance - a.balance; });
        const outstanding = owing.reduce(function (n, r) { return n + r.balance; }, 0);

        body.innerHTML =
            '<div class="f-box"><div class="f-line"><span>Fees expected this term</span><span>' + esc(money(expected)) + "</span></div>" +
            '<div class="f-line"><span>Collected this term</span><span>' + esc(money(collected)) + "</span></div>" +
            '<div class="f-line total"><span>Total outstanding (' + owing.length + " owing)</span><span>" + esc(money(outstanding)) + "</span></div></div>" +
            (owing.length ? "<strong>Students owing</strong>" : "<p>No student owes anything for " + esc(sel.term) + ".</p>") +
            owing.map(function (r) {
                return '<div class="f-row" data-key="' + esc(r.student.match_key) + '"><div><strong>' + esc(r.student.student_name) + "</strong>" +
                    '<div class="f-meta">' + esc(r.student.admission_no || "") + '</div></div><span class="f-owe">' + esc(money(r.balance)) + "</span></div>";
            }).join("") +
            '<button class="f-btn alt" id="sExcel" type="button">Download class ledger (Excel)</button>';

        body.querySelectorAll(".f-row").forEach(function (el) {
            el.onclick = function () {
                view.tab = "students"; view.key = el.dataset.key;
                modal.querySelectorAll(".f-tab").forEach(function (x) { x.classList.toggle("on", x.dataset.tab === "students"); });
                render();
            };
        });
        body.querySelector("#sExcel").onclick = downloadLedger;
    }

    function loadXlsxLibrary() {
        if (typeof XLSX !== "undefined") return Promise.resolve();
        return new Promise(function (resolve, reject) {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
            s.onload = resolve;
            s.onerror = function () { reject(new Error("Could not load the Excel library. Check your internet connection.")); };
            document.head.appendChild(s);
        });
    }

    async function downloadLedger() {
        if (busy) return;
        busy = true;
        try {
            setStatus("Preparing Excel file…");
            await loadXlsxLibrary();
            const rows = ledger();
            const ledgerSheet = [["Student Name", "Admission No", "Brought forward", "Fees this term", "Paid this term", "Balance"]].concat(
                rows.map(function (r) { return [r.student.student_name || "", r.student.admission_no || "", r.carry, r.due, r.paid, r.balance]; }));
            const payRows = data.payments.filter(function (p) { return p.term === sel.term; })
                .sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });
            const paySheet = [["Receipt no", "Date", "Student Name", "Admission No", "Amount", "Method", "Reference", "Status"]].concat(
                payRows.map(function (p) {
                    return [p.receipt_no, p.paid_on, p.student_name || "", p.admission_no || "", Number(p.amount), p.method, p.reference || "",
                        p.voided ? "Cancelled: " + (p.void_reason || "") : "Valid"];
                }));
            const wb = XLSX.utils.book_new();
            const ws1 = XLSX.utils.aoa_to_sheet(ledgerSheet);
            ws1["!cols"] = [32, 16, 16, 16, 16, 16].map(function (w) { return { wch: w }; });
            const ws2 = XLSX.utils.aoa_to_sheet(paySheet);
            ws2["!cols"] = [14, 12, 32, 16, 14, 14, 20, 28].map(function (w) { return { wch: w }; });
            XLSX.utils.book_append_sheet(wb, ws1, "Ledger");
            XLSX.utils.book_append_sheet(wb, ws2, "Payments");

            const fileName = "Fees_" + sel.className.replace(/[^A-Za-z0-9]+/g, "-") + "_" + sel.session.replace("/", "-") + "_" + sel.term.replace(/\s+/g, "") + ".xlsx";

            /* Inside the Android app: save the file, then open Android's share list (Drive, Files, WhatsApp...) */
            const cap = window.Capacitor;
            if (cap && cap.Plugins && cap.Plugins.Filesystem && cap.Plugins.Share) {
                const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
                await cap.Plugins.Filesystem.writeFile({ path: fileName, data: b64, directory: "CACHE" });
                const f = await cap.Plugins.Filesystem.getUri({ path: fileName, directory: "CACHE" });
                await cap.Plugins.Share.share({ title: fileName, url: f.uri, dialogTitle: "Save or send this file" });
                setStatus("✔ File ready: " + fileName, "ok");
                return;
            }

            const bytes = XLSX.write(wb, { bookType: "xlsx", type: "array" });
            const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 2000);
            setStatus("✔ Downloaded " + fileName, "ok");
        } catch (e) {
            setStatus("✖ " + (e && e.message ? e.message : "Could not create the Excel file."), "err");
        } finally { busy = false; }
    }

    /* ------------------------------------------------------
       Floating button (hidden for staff accounts)
       ------------------------------------------------------ */
    function addButton() {
        if (!SHOW_FLOATING_BUTTON || document.getElementById("feesButton")) return;
        injectStyles();
        const b = document.createElement("button");
        b.id = "feesButton";
        b.type = "button";
        b.textContent = "₦ Fees";
        b.onclick = open;
        document.body.appendChild(b);
        setInterval(function () { b.style.display = isOwner() ? "" : "none"; }, 1500);
    }

    /* The "₦ School fees" item in the hamburger menu */
    document.addEventListener("click", function (event) {
        const link = event.target.closest && event.target.closest('a[href="#schoolFeesMenu"]');
        if (!link) return;
        event.preventDefault();
        open();
    });

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButton);
    else addButton();

    /* Back from the email link? */
    (function () {
        const code = takeResetCodeFromAddress();
        if (code) finishResetFromEmail(code);
    })();

    /* Call SchoolFees.open() from your own button if you prefer. */
    window.SchoolFees = { open: open, _test: { computeLedger: computeLedger, nairaInWords: nairaInWords } };
})();
