/* =========================================================
   STAFF MANAGEMENT  (directory, attendance, payroll)

   1. Run staff.sql once in Supabase (SQL Editor).
   2. Load this file AFTER script.js / scripttt.js and fees.js:
          <script src="staff.js"></script>
   3. Add a menu link to index.html:
          <li class="srg-group-app srg-owner-only"><a href="#schoolStaffMenu">👥 Staff management</a></li>

   School owner only (staff accounts don't see it).
   - Staff: everyone in the school, their role and responsibilities.
     Teachers who joined with the school code can be linked, so their
     classes/subjects (from Staff access) show on their profile.
   - Attendance: the owner marks each day; monthly summary + print.
   - Payroll: monthly pay per person, mark paid, payslip, Excel.
   PAYROLL LOCK: payroll and each person's salary/bank details are behind
   their own password (separate from the fees password), asked each time
   they are opened and locked again after 10 minutes of no use or when
   Staff Management is closed. Forgot it? A confirmation link is sent to
   the owner's email, exactly like the fees password.
   ========================================================= */

(function () {
    "use strict";

    const ROLES = ["Principal", "Vice Principal", "Head Teacher", "Teacher", "Form Master", "Bursar", "Secretary",
        "Librarian", "Counsellor", "Driver", "Security", "Cleaner", "Cook", "Other"];
    const ATT = [["Present", "P", "#0b8f4d"], ["Late", "L", "#c77d00"], ["Absent", "A", "#b00020"], ["Leave", "Lv", "#555555"]];
    const METHODS = ["Bank transfer", "Cash", "Cheque"];
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const SETUP_HELP = "The staff tables are not set up yet. Run staff.sql in Supabase first.";
    const PASSWORD_KEY = "payrollPassword";          /* kept in the school settings, so it follows the school login */
    const RESET_KEY = "payrollResetPending";         /* remembers, in this browser, that a reset link was sent */
    const RESET_QUERY = "payroll_reset";             /* comes back on the address when the email link is opened */
    const RESET_TTL_MS = 30 * 60 * 1000;             /* the email link is only good for 30 minutes here */
    const IDLE_MS = 10 * 60 * 1000;                  /* payroll locks again after 10 minutes without use */

    let modal = null;
    let busy = false;
    let tab = "staff";
    let staff = [], logins = [], assigns = [];
    let attRows = [], attMonth = "";
    let attDate = today();
    let payPeriod = today().slice(0, 7);
    let payRows = [];
    let view = { form: false, id: null, payId: null, filter: "" };
    let payUnlocked = false;
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

    function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

    function money(n) {
        try {
            return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN" }).format(Number(n) || 0);
        } catch (e) { return "₦" + (Number(n) || 0).toFixed(2); }
    }

    function isOwner() { return typeof staffContext === "undefined" || !staffContext; }

    function today() {
        const d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    function prettyDate(iso) {
        if (!iso) return "";
        const d = new Date(iso + "T00:00:00");
        return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    }

    function prettyPeriod(p) {
        const parts = String(p || "").split("-");
        const m = Number(parts[1]);
        return m >= 1 && m <= 12 ? MONTHS[m - 1] + " " + parts[0] : String(p || "");
    }

    function monthRange(period) {
        const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
        const last = new Date(y, m, 0).getDate();
        return { start: period + "-01", end: period + "-" + String(last).padStart(2, "0") };
    }

    function friendlyError(error, fallback) {
        const text = String((error && (error.message || error.code)) || "");
        if (/staff_members|staff_attendance|staff_payroll|schema cache|does not exist|42P01|PGRST205/i.test(text) &&
            !/duplicate|violates/i.test(text)) return SETUP_HELP;
        return fallback + (text ? " (" + text + ")" : "");
    }

    function numberWords(n) {
        try {
            const f = window.SchoolFees && window.SchoolFees._test && window.SchoolFees._test.nairaInWords;
            return f ? f(n) : "";
        } catch (e) { return ""; }
    }

    function staffById(id) {
        for (let i = 0; i < staff.length; i++) if (staff[i].id === id) return staff[i];
        return null;
    }

    /* ------------------------------------------------------
       Loading from Supabase
       ------------------------------------------------------ */
    async function readOwn(table, columns, orderCol, extra) {
        const rows = [];
        for (let from = 0; ; from += 1000) {
            let q = supabaseClient.from(table).select(columns)
                .eq("owner_user_id", currentUserId).eq("website_id", WEBSITE_ID);
            if (extra) q = extra(q);
            if (orderCol) q = q.order(orderCol, { ascending: true });
            const res = await q.range(from, from + 999);
            if (res.error) throw res.error;
            (res.data || []).forEach(function (r) { rows.push(r); });
            if (!res.data || res.data.length < 1000) break;
        }
        return rows;
    }

    async function loadStaff() {
        staff = await readOwn("staff_members", "*", "full_name");
        try { logins = await readOwn("school_staff", "staff_user_id,full_name,email,status", "full_name"); } catch (e) { logins = []; }
        try { assigns = await readOwn("staff_assignments", "staff_user_id,class_name,subject", "class_name"); } catch (e) { assigns = []; }
    }

    async function loadAttendance() {
        attMonth = attDate.slice(0, 7);
        const r = monthRange(attMonth);
        attRows = await readOwn("staff_attendance", "*", null, function (q) { return q.gte("att_date", r.start).lte("att_date", r.end); });
    }

    async function loadPayroll() {
        payRows = await readOwn("staff_payroll", "*", "staff_name", function (q) { return q.eq("period", payPeriod); });
    }

    /* ------------------------------------------------------
       Styles and shell
       ------------------------------------------------------ */
    const PRINT_CSS =
        "body{margin:16px;font:14px system-ui,Arial,sans-serif;color:#000;background:#fff}" +
        "@page{margin:12mm}" +
        ".p-box{max-width:480px;margin:0 auto}.p-wide{max-width:none}" +
        ".p-head{text-align:center;border-bottom:2px solid #000;padding-bottom:8px;margin-bottom:10px}" +
        ".p-head img{max-height:60px;max-width:120px;object-fit:contain}.p-school{font-size:18px;font-weight:700}" +
        ".p-title{text-align:center;font-weight:700;letter-spacing:1px;margin:6px 0 10px}" +
        ".p-line{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dotted #999}" +
        ".p-net{text-align:center;font-size:22px;font-weight:700;margin:12px 0 2px}.p-words{text-align:center;font-style:italic;margin-bottom:12px}" +
        ".p-sign{margin-top:28px;border-top:1px solid #000;width:55%;padding-top:3px;font-size:12px}" +
        "table{border-collapse:collapse;width:100%}th,td{border:1px solid #777;padding:5px 7px;text-align:left}th{background:#eee}td.n,th.n{text-align:center}";

    function injectStyles() {
        if (document.getElementById("stfStyles")) return;
        const st = document.createElement("style");
        st.id = "stfStyles";
        st.textContent =
            "#stfOverlay{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:10px}" +
            "#stfBox{background:#fff;color:#222;width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:12px;padding:14px;font:14px system-ui,sans-serif}" +
            "#stfBox h3{margin:0;font-size:18px}#stfBox h4{margin:14px 0 6px}#stfBox .s-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}" +
            "#stfBox .s-x{border:0;background:none;font-size:24px;line-height:1;cursor:pointer;color:#555}" +
            "#stfBox select,#stfBox input,#stfBox textarea{width:100%;padding:8px;border:1px solid #bbb;border-radius:8px;font-size:14px;background:#fff;color:#222;box-sizing:border-box;font-family:inherit}" +
            "#stfBox label{display:block;font-size:12px;color:#555;margin:8px 0 2px}" +
            "#stfBox .s-tabs{display:flex;gap:6px;margin-bottom:10px}#stfBox .s-tab{flex:1;padding:8px 4px;border:1px solid #1b2a4a;border-radius:8px;background:#fff;color:#1b2a4a;font-weight:600;cursor:pointer}" +
            "#stfBox .s-tab.on{background:#1b2a4a;color:#fff}" +
            "#stfBox .s-row{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 8px;border:1px solid #ddd;border-radius:8px;margin-bottom:6px;cursor:pointer}" +
            "#stfBox .s-row.plain{cursor:default}#stfBox .s-meta{color:#666;font-size:12px}" +
            "#stfBox .s-ok{color:#0b8f4d;font-weight:700;white-space:nowrap}#stfBox .s-owe{color:#b00020;font-weight:700;white-space:nowrap}#stfBox .s-off{opacity:.55}" +
            "#stfBox .s-btn{width:100%;padding:11px;border:0;border-radius:8px;background:#1b2a4a;color:#fff;font-weight:700;margin-top:8px;cursor:pointer}" +
            "#stfBox .s-btn.alt{background:#fff;color:#1b2a4a;border:1px solid #1b2a4a}#stfBox .s-btn.red{background:#fff;color:#b00020;border:1px solid #b00020}#stfBox .s-btn:disabled{opacity:.5}" +
            "#stfBox .s-small{padding:6px 10px;border:1px solid #1b2a4a;border-radius:6px;background:#fff;color:#1b2a4a;font-size:12px;cursor:pointer;white-space:nowrap}" +
            "#stfBox .s-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}" +
            "#stfBox .s-box{background:#f1f3f4;border-radius:8px;padding:8px;margin:8px 0}" +
            "#stfBox .s-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}#stfBox .s-chip{padding:4px 9px;border:1px solid #1b2a4a;border-radius:14px;background:#fff;font-size:12px;cursor:pointer}" +
            "#stfBox .s-line{display:flex;justify-content:space-between;padding:2px 0}#stfBox .s-line.total{border-top:1px solid #bbb;margin-top:4px;padding-top:6px;font-weight:700}" +
            "#stfBox .s-att{min-width:38px;padding:7px 6px;border:1px solid var(--c);border-radius:6px;background:#fff;color:var(--c);font-weight:700;cursor:pointer}" +
            "#stfBox .s-att.on{background:var(--c);color:#fff}#stfBox .s-atts{display:flex;gap:4px}" +
            "#stfBox .s-status{margin-top:8px;padding:8px;border-radius:8px;background:#f1f3f4;white-space:pre-wrap;display:none}" +
            "#stfBox .s-status.err{background:#fde8e8;color:#a00}#stfBox .s-status.ok{background:#e6f4ea;color:#0a5}" +
            "#stfBox .s-back{border:0;background:none;color:#1b2a4a;font-weight:700;padding:4px 0;margin-bottom:6px;cursor:pointer}";
        document.head.appendChild(st);
    }

    function setStatus(text, kind) {
        const el = modal && modal.querySelector(".s-status");
        if (!el) return;
        el.textContent = text || "";
        el.className = "s-status" + (text && kind ? " " + kind : "");
        el.style.display = text ? "block" : "none";
    }

    function closeModal() {
        if (modal) { modal.remove(); modal = null; }
        payUnlocked = false;
        if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
    }

    function $(sel) { return modal ? modal.querySelector(sel) : null; }

    /* ------------------------------------------------------
       The payroll lock (same pop-up and method as School Fees,
       but its own separate password)
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
            title: isFirst ? "🔒 Set the payroll password" : "Change the payroll password",
            message: "Payroll and salary details will ask for this password each time they are opened. It is separate from the fees password and the section password. " +
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
       A separate temporary connection sends it, so the current sign-in is
       never disturbed. */
    function tempClient() {
        return supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "payroll-verify" }
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
        if (!confirm("To reset the payroll password, a confirmation link will be sent to:\n\n" + email + "\n\nOpen the link in this same browser, then you can set a new payroll password. Send the link now?")) return false;

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
        alert("A confirmation link has been sent to " + email + ".\n\nOpen it from your email in this browser. You will then be asked to set a new payroll password.");
        return false;    /* payroll stays locked until the link is opened */
    }

    /* Runs when the page loads. If the address carries the reset code, the
       email link was just opened. */
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
            alert("This confirmation link has expired, was already used, or was not requested from this browser.\n\nOpen Staff Management, tap Payroll, then \"Forgot password?\" and ask for a new link.");
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
        if (await setNewPassword(false)) open({ unlocked: true, tab: "payroll" });   /* they just proved who they are */
    }

    /* Resolves true when the person may see payroll and salary details. */
    async function ensurePayUnlocked() {
        if (!lockToolsReady()) {
            alert("The payroll lock could not start. Please refresh the page and try again.");
            return false;
        }
        const record = passwordRecord();
        if (!record) return setNewPassword(true);      /* first time: a password must be set */
        if (payUnlocked) return true;

        const result = await srgPasswordDialog({
            title: "🔒 Payroll",
            message: "Enter the payroll password to open this area.",
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
                title: "🔒 Payroll password",
                message: "Enter the current password to change it.",
                confirmText: "Continue",
                verify: function (value) { return checkPassword(value, record); }
            });
            if (!current || current.action !== "ok") return;
        }
        if (await setNewPassword(!record)) setStatus("✔ Payroll password changed.", "ok");
    }

    function setTabUI(name) {
        if (!modal) return;
        modal.querySelectorAll(".s-tab").forEach(function (x) { x.classList.toggle("on", x.dataset.tab === name); });
    }

    async function selectTab(name) {
        if (busy) return;
        if (name === "payroll" && !payUnlocked) {
            if (!(await ensurePayUnlocked())) return;
            payUnlocked = true;
            lastActive = Date.now();
        }
        if (!modal) return;
        tab = name;
        view.form = false; view.id = null; view.payId = null; view.draft = null;
        setTabUI(name);
        refresh();
    }

    /* Locks payroll again after a stretch of no use */
    function relockPay() {
        if (!payUnlocked) return;
        payUnlocked = false;
        if (!modal) return;
        if (tab === "payroll") {
            tab = "staff";
            view.form = false; view.id = null; view.payId = null; view.draft = null;
            setTabUI("staff");
            refresh();
            setStatus("Payroll locked after a period of no use.");
        } else if (tab === "staff" && view.form) {
            render();
        }
    }

    async function open(opts) {
        if (!isOwner()) { alert("Only the school owner can manage staff records."); return; }
        if (typeof currentUserId === "undefined" || !currentUserId) { alert("Please sign in first."); return; }
        if (modal) return;
        injectStyles();
        tab = (opts && opts.tab) || "staff";
        payUnlocked = !!(opts && opts.unlocked);
        view = { form: false, id: null, payId: null, filter: "", draft: null };

        modal = document.createElement("div");
        modal.id = "stfOverlay";
        modal.innerHTML =
            '<div id="stfBox"><div class="s-head"><h3>👥 Staff Management</h3><div><button class="s-x" id="sLock" type="button" title="Change the payroll password" style="font-size:18px;margin-right:6px">🔒</button><button class="s-x" id="sClose" type="button" title="Close and lock payroll">×</button></div></div>' +
            '<div class="s-tabs"><button class="s-tab on" data-tab="staff" type="button">Staff</button>' +
            '<button class="s-tab" data-tab="attendance" type="button">Attendance</button>' +
            '<button class="s-tab" data-tab="payroll" type="button">Payroll</button></div>' +
            '<div id="sBody"></div><div class="s-status"></div></div>';
        document.body.appendChild(modal);

        $("#sClose").onclick = closeModal;
        $("#sLock").onclick = changePassword;
        modal.addEventListener("click", function (e) { if (e.target === modal && !busy) closeModal(); });

        /* payroll locks again after a stretch of no use */
        lastActive = Date.now();
        ["click", "keydown", "input", "touchstart"].forEach(function (name) {
            modal.addEventListener(name, function () { lastActive = Date.now(); }, true);
        });
        if (idleTimer) clearInterval(idleTimer);
        idleTimer = setInterval(function () {
            if (modal && !busy && payUnlocked && Date.now() - lastActive > IDLE_MS) relockPay();
        }, 30000);

        modal.querySelectorAll(".s-tab").forEach(function (b) {
            b.onclick = function () { selectTab(b.dataset.tab); };
        });
        setTabUI(tab);
        refresh();
    }

    async function refresh() {
        const body = $("#sBody");
        if (!body) return;
        body.innerHTML = '<p class="s-meta">Loading…</p>';
        setStatus("");
        try {
            await loadStaff();
            if (tab === "attendance") await loadAttendance();
            if (tab === "payroll") await loadPayroll();
            if (!modal) return;
            render();
        } catch (e) {
            if (modal) { body.innerHTML = ""; setStatus("✖ " + friendlyError(e, "Could not load"), "err"); }
        }
    }

    function render() {
        if (!modal) return;
        if (tab === "attendance") renderAttendance();
        else if (tab === "payroll") { if (view.payId) renderPayEdit(); else renderPayroll(); }
        else if (view.form) renderStaffForm();
        else renderStaffList();
    }

    /* ------------------------------------------------------
       STAFF tab
       ------------------------------------------------------ */
    function renderStaffList() {
        const body = $("#sBody");
        const active = staff.filter(function (s) { return s.status === "active"; });
        const byRole = {};
        active.forEach(function (s) { byRole[s.role_title] = (byRole[s.role_title] || 0) + 1; });
        const roleNames = Object.keys(byRole).sort();

        body.innerHTML =
            '<div class="s-box"><div class="s-line"><span>Active staff</span><strong>' + active.length + "</strong></div>" +
            '<div class="s-line"><span>Inactive</span><strong>' + (staff.length - active.length) + "</strong></div>" +
            (roleNames.length ? '<div class="s-chips">' + roleNames.map(function (r) {
                return '<span class="s-chip" data-role="' + esc(r) + '">' + esc(r) + " · " + byRole[r] + "</span>";
            }).join("") + "</div>" : "") + "</div>" +
            '<div class="s-grid" style="grid-template-columns:1fr auto"><input id="sSearch" type="search" placeholder="Search name, role, department" value="' + esc(view.filter) + '">' +
            '<button class="s-small" id="sAdd" type="button">+ Add staff</button></div>' +
            '<div id="sList" style="margin-top:8px"></div>' +
            '<button class="s-btn alt" id="sImport" type="button">Import approved teachers from Staff access</button>';

        const draw = function () {
            const q = view.filter.trim().toLowerCase();
            const shown = staff.filter(function (s) {
                return !q || [s.full_name, s.role_title, s.department, s.staff_no].join(" ").toLowerCase().indexOf(q) !== -1;
            });
            $("#sList").innerHTML = shown.map(function (s) {
                return '<div class="s-row' + (s.status === "active" ? "" : " s-off") + '" data-id="' + esc(s.id) + '"><div><strong>' + esc(s.full_name) + "</strong>" +
                    '<div class="s-meta">' + esc(s.role_title) + (s.department ? " · " + esc(s.department) : "") + (s.status === "active" ? "" : " · inactive") + "</div></div>" +
                    '<span class="s-meta">›</span></div>';
            }).join("") || '<p class="s-meta">' + (staff.length ? "No match." : "No staff yet. Tap “+ Add staff”, or import your approved teachers below.") + "</p>";
            modal.querySelectorAll("#sList .s-row").forEach(function (el) {
                el.onclick = function () { view.form = true; view.id = el.dataset.id; render(); };
            });
        };
        $("#sSearch").oninput = function (e) { view.filter = e.target.value; draw(); };
        $("#sAdd").onclick = function () { view.form = true; view.id = null; render(); };
        $("#sImport").onclick = importLogins;
        modal.querySelectorAll(".s-chip").forEach(function (c) {
            c.onclick = function () { view.filter = c.dataset.role; $("#sSearch").value = view.filter; draw(); };
        });
        draw();
    }

    function assignmentsFor(userId) {
        if (!userId) return [];
        return assigns.filter(function (a) { return a.staff_user_id === userId; });
    }

    function renderStaffForm() {
        const body = $("#sBody");
        const s = view.id ? staffById(view.id) : null;
        if (view.id && !s) { view.form = false; renderStaffList(); return; }
        const v0 = s || {
            full_name: "", staff_no: "", role_title: "Teacher", department: "", phone: "", email: "", date_employed: "",
            status: "active", responsibilities: "", base_salary: "", default_allowance: "", default_deduction: "",
            bank_name: "", account_no: "", staff_user_id: null
        };
        /* values typed before tapping "Unlock pay details" are kept (a copy, so the saved list is never changed) */
        const v = Object.assign({}, v0, view.draft || {});
        view.draft = null;

        const taken = {};
        staff.forEach(function (x) { if (x.staff_user_id && x.id !== view.id) taken[x.staff_user_id] = true; });
        const loginOpts = logins.filter(function (l) {
            return !taken[l.staff_user_id] && (l.status === "approved" || l.staff_user_id === v.staff_user_id);
        });
        const mine = assignmentsFor(v.staff_user_id);

        body.innerHTML =
            '<button class="s-back" type="button">‹ Back to staff</button>' +
            "<h3>" + (s ? "Edit staff" : "Add staff") + "</h3>" +
            '<label>Full name</label><input id="fName" type="text" value="' + esc(v.full_name) + '">' +
            '<div class="s-grid"><div><label>Staff no (optional)</label><input id="fNo" type="text" value="' + esc(v.staff_no) + '"></div>' +
            '<div><label>Date employed</label><input id="fDate" type="date" value="' + esc(v.date_employed || "") + '"></div></div>' +
            '<div class="s-grid"><div><label>Role</label><input id="fRole" type="text" list="sRoles" value="' + esc(v.role_title) + '">' +
            '<datalist id="sRoles">' + ROLES.map(function (r) { return '<option value="' + esc(r) + '">'; }).join("") + "</datalist></div>" +
            '<div><label>Department (optional)</label><input id="fDept" type="text" placeholder="e.g. Sciences" value="' + esc(v.department) + '"></div></div>' +
            '<label>Responsibilities / duties</label><textarea id="fResp" rows="3" placeholder="e.g. Form master JSS1, games master, handles school accounts">' + esc(v.responsibilities) + "</textarea>" +
            '<div class="s-grid"><div><label>Phone</label><input id="fPhone" type="tel" value="' + esc(v.phone) + '"></div>' +
            '<div><label>Email</label><input id="fEmail" type="email" value="' + esc(v.email) + '"></div></div>' +
            '<label>Status</label><select id="fStatus"><option value="active"' + (v.status === "active" ? " selected" : "") + '>Active</option><option value="inactive"' + (v.status === "inactive" ? " selected" : "") + ">Inactive (left or on long leave)</option></select>" +
            (!payUnlocked ? '<h4>Pay</h4><div class="s-meta">Salary and bank details are locked.</div><button class="s-btn alt" id="fUnlock" type="button">🔒 Unlock pay details</button>' : "<h4>Pay</h4>" +
            '<div class="s-grid"><div><label>Monthly salary (₦)</label><input id="fBase" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(v.base_salary || "") + '"></div>' +
            '<div><label>Regular allowance (₦)</label><input id="fAllow" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(v.default_allowance || "") + '"></div></div>' +
            '<label>Regular deduction (₦, e.g. tax or pension)</label><input id="fDed" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(v.default_deduction || "") + '">' +
            '<div class="s-grid"><div><label>Bank (optional)</label><input id="fBank" type="text" value="' + esc(v.bank_name) + '"></div>' +
            '<div><label>Account no (optional)</label><input id="fAcct" type="text" inputmode="numeric" value="' + esc(v.account_no) + '"></div></div>') +
            "<h4>App login (optional)</h4>" +
            '<select id="fLogin"><option value="">Not linked</option>' + loginOpts.map(function (l) {
                return '<option value="' + esc(l.staff_user_id) + '"' + (l.staff_user_id === v.staff_user_id ? " selected" : "") + ">" + esc(l.full_name || l.email) + (l.email ? " · " + esc(l.email) : "") + "</option>";
            }).join("") + "</select>" +
            '<div class="s-meta" style="margin-top:4px">Link a teacher who joined with the school code to show their classes and subjects here.</div>' +
            (v.staff_user_id ? '<div class="s-box"><strong>Classes &amp; subjects</strong>' + (mine.map(function (a) {
                return '<div class="s-line"><span>' + esc(a.class_name) + "</span><span>" + (a.subject ? esc(a.subject) : "Form master") + "</span></div>";
            }).join("") || '<div class="s-meta">None assigned yet (set in Staff access).</div>') + "</div>" : "") +
            '<button class="s-btn" id="fSave" type="button">Save</button>' +
            (s ? '<button class="s-btn red" id="fDelete" type="button">Delete this staff member</button>' : "");

        body.querySelector(".s-back").onclick = function () { view.form = false; view.id = null; setStatus(""); render(); };
        $("#fSave").onclick = saveStaff;
        const unlock = $("#fUnlock");
        if (unlock) unlock.onclick = async function () {
            if (busy) return;
            const g = function (id) { return $("#" + id).value.trim(); };
            const draft = {
                full_name: g("fName"), staff_no: g("fNo"), date_employed: g("fDate"), role_title: g("fRole"),
                department: g("fDept"), responsibilities: g("fResp"), phone: g("fPhone"), email: g("fEmail"),
                status: $("#fStatus").value, staff_user_id: $("#fLogin").value || null
            };
            if (await ensurePayUnlocked()) {
                payUnlocked = true;
                lastActive = Date.now();
                view.draft = draft;
                render();
            }
        };
        const del = $("#fDelete");
        if (del) del.onclick = deleteStaff;
    }

    async function saveStaff() {
        if (busy) return;
        const g = function (id) { return $("#" + id).value.trim(); };
        const name = g("fName").replace(/\s+/g, " ");
        if (!name) { setStatus("Enter the staff member's name.", "err"); return; }
        const payload = {
            full_name: name,
            staff_no: g("fNo") || null,
            role_title: g("fRole") || "Teacher",
            department: g("fDept") || null,
            responsibilities: g("fResp") || null,
            phone: g("fPhone") || null,
            email: g("fEmail") || null,
            date_employed: g("fDate") || null,
            status: $("#fStatus").value,
            staff_user_id: $("#fLogin").value || null
        };
        /* pay details are only read and saved while payroll is unlocked; otherwise they stay as they are */
        if (payUnlocked && $("#fBase")) {
            payload.base_salary = round2(g("fBase"));
            payload.default_allowance = round2(g("fAllow"));
            payload.default_deduction = round2(g("fDed"));
            payload.bank_name = g("fBank") || null;
            payload.account_no = g("fAcct") || null;
            if (payload.base_salary < 0 || payload.default_allowance < 0 || payload.default_deduction < 0) {
                setStatus("Pay amounts cannot be negative.", "err"); return;
            }
        }
        busy = true;
        try {
            let res;
            if (view.id) {
                res = await supabaseClient.from("staff_members").update(payload)
                    .eq("id", view.id).eq("owner_user_id", currentUserId);
            } else {
                res = await supabaseClient.from("staff_members").insert(Object.assign({
                    owner_user_id: currentUserId, website_id: WEBSITE_ID
                }, payload));
            }
            if (res.error) {
                if (res.error.code === "23505") throw new Error("That app login is already linked to another staff member.");
                throw res.error;
            }
            await loadStaff();
            view.form = false; view.id = null;
            render();
            setStatus("✔ " + name + " saved.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not save"), "err");
        } finally { busy = false; }
    }

    async function deleteStaff() {
        if (busy || !view.id) return;
        if (!confirm("Delete this staff member and their attendance records? This cannot be undone.")) return;
        busy = true;
        try {
            const res = await supabaseClient.from("staff_members").delete().eq("id", view.id).eq("owner_user_id", currentUserId);
            if (res.error) {
                if (res.error.code === "23503") throw new Error("This person has payroll records, so they can't be deleted. Set their status to Inactive instead.");
                throw res.error;
            }
            await loadStaff();
            view.form = false; view.id = null;
            render();
            setStatus("Staff member deleted.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not delete"), "err");
        } finally { busy = false; }
    }

    async function importLogins() {
        if (busy) return;
        const linked = {};
        staff.forEach(function (s) { if (s.staff_user_id) linked[s.staff_user_id] = true; });
        const fresh = logins.filter(function (l) { return l.status === "approved" && l.staff_user_id && !linked[l.staff_user_id]; });
        if (!fresh.length) { setStatus("No new approved teachers to import.", "ok"); return; }
        if (!confirm("Add " + fresh.length + " approved teacher(s) from Staff access to the staff list?")) return;
        busy = true;
        try {
            const rows = fresh.map(function (l) {
                return {
                    owner_user_id: currentUserId, website_id: WEBSITE_ID, staff_user_id: l.staff_user_id,
                    full_name: l.full_name || l.email || "Teacher", email: l.email || null, role_title: "Teacher"
                };
            });
            const res = await supabaseClient.from("staff_members").insert(rows);
            if (res.error) throw res.error;
            await loadStaff();
            render();
            setStatus("✔ Imported " + rows.length + " teacher(s). Open each one to set role, duties and pay.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not import"), "err");
        } finally { busy = false; }
    }

    /* ------------------------------------------------------
       ATTENDANCE tab
       ------------------------------------------------------ */
    function attFor(staffId, date) {
        for (let i = 0; i < attRows.length; i++) {
            if (attRows[i].staff_id === staffId && attRows[i].att_date === date) return attRows[i];
        }
        return null;
    }

    function attSummary(active) {
        return active.map(function (s) {
            const c = { Present: 0, Late: 0, Absent: 0, Leave: 0 };
            attRows.forEach(function (r) { if (r.staff_id === s.id && c[r.status] !== undefined) c[r.status]++; });
            return { staff: s, c: c };
        });
    }

    function renderAttendance() {
        const body = $("#sBody");
        const active = staff.filter(function (s) { return s.status === "active"; });
        const month = attDate.slice(0, 7);
        const sum = attSummary(active);

        body.innerHTML =
            '<div class="s-grid" style="grid-template-columns:1fr auto"><input id="aDate" type="date" value="' + esc(attDate) + '">' +
            '<button class="s-small" id="aAllP" type="button">All present</button></div>' +
            '<div class="s-meta" style="margin:6px 0">Tap a button to mark; tap it again to clear. ' + ATT.map(function (a) { return a[1] + " = " + a[0]; }).join(", ") + ".</div>" +
            (active.length ? active.map(function (s) {
                const cur = attFor(s.id, attDate);
                return '<div class="s-row plain"><div><strong>' + esc(s.full_name) + '</strong><div class="s-meta">' + esc(s.role_title) + "</div></div>" +
                    '<div class="s-atts">' + ATT.map(function (a) {
                        return '<button class="s-att' + (cur && cur.status === a[0] ? " on" : "") + '" style="--c:' + a[2] + '" data-id="' + esc(s.id) + '" data-st="' + a[0] + '" type="button">' + a[1] + "</button>";
                    }).join("") + "</div></div>";
            }).join("") : '<p class="s-box">No active staff yet. Add staff in the Staff tab first.</p>') +
            (active.length ? "<h4>Summary for " + esc(prettyPeriod(month)) + "</h4>" +
                '<table style="width:100%;border-collapse:collapse;font-size:13px"><tr><th style="text-align:left">Name</th>' +
                ATT.map(function (a) { return '<th style="text-align:center" title="' + a[0] + '">' + a[1] + "</th>"; }).join("") + "</tr>" +
                sum.map(function (r) {
                    return '<tr><td style="padding:4px 0;border-top:1px solid #ddd">' + esc(r.staff.full_name) + "</td>" + ATT.map(function (a) {
                        return '<td style="text-align:center;border-top:1px solid #ddd">' + r.c[a[0]] + "</td>";
                    }).join("") + "</tr>";
                }).join("") + "</table>" +
                '<button class="s-btn alt" id="aPrint" type="button">Print monthly summary</button>' : "");

        $("#aDate").onchange = function (e) {
            if (busy || !e.target.value) return;
            attDate = e.target.value;
            if (attDate.slice(0, 7) !== attMonth) refresh(); else renderAttendance();
        };
        $("#aAllP").onclick = markAllPresent;
        modal.querySelectorAll(".s-att").forEach(function (b) {
            b.onclick = function () { markAtt(b.dataset.id, b.dataset.st); };
        });
        const pr = $("#aPrint");
        if (pr) pr.onclick = function () { printAttendance(sum, month); };
    }

    async function markAtt(staffId, status) {
        if (busy) return;
        busy = true;
        const box = $("#stfBox");
        const top = box ? box.scrollTop : 0;
        try {
            const cur = attFor(staffId, attDate);
            if (cur && cur.status === status) {
                const r = await supabaseClient.from("staff_attendance").delete().eq("id", cur.id).eq("owner_user_id", currentUserId);
                if (r.error) throw r.error;
                attRows = attRows.filter(function (x) { return x.id !== cur.id; });
            } else {
                const r = await supabaseClient.from("staff_attendance").upsert({
                    owner_user_id: currentUserId, website_id: WEBSITE_ID, staff_id: staffId, att_date: attDate, status: status
                }, { onConflict: "staff_id,att_date" }).select().single();
                if (r.error) throw r.error;
                attRows = attRows.filter(function (x) { return !(x.staff_id === staffId && x.att_date === attDate); });
                attRows.push(r.data);
            }
            renderAttendance();
            if (box) box.scrollTop = top;
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not save attendance"), "err");
        } finally { busy = false; }
    }

    async function markAllPresent() {
        if (busy) return;
        const rows = staff.filter(function (s) { return s.status === "active" && !attFor(s.id, attDate); }).map(function (s) {
            return { owner_user_id: currentUserId, website_id: WEBSITE_ID, staff_id: s.id, att_date: attDate, status: "Present" };
        });
        if (!rows.length) { setStatus("Everyone is already marked for this day.", "ok"); return; }
        busy = true;
        try {
            const r = await supabaseClient.from("staff_attendance").upsert(rows, { onConflict: "staff_id,att_date" }).select();
            if (r.error) throw r.error;
            (r.data || []).forEach(function (n) {
                attRows = attRows.filter(function (x) { return !(x.staff_id === n.staff_id && x.att_date === n.att_date); });
                attRows.push(n);
            });
            renderAttendance();
            setStatus("✔ Marked " + rows.length + " present. Now change the exceptions.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not save attendance"), "err");
        } finally { busy = false; }
    }

    function schoolHeader() {
        const name = (typeof schoolNameInput !== "undefined" && schoolNameInput && schoolNameInput.value) || "";
        const address = (typeof schoolAddressInput !== "undefined" && schoolAddressInput && schoolAddressInput.value) || "";
        const logo = (typeof reportSettings !== "undefined" && reportSettings && typeof reportSettings.schoolLogo === "string") ? reportSettings.schoolLogo : "";
        return '<div class="p-head">' + (logo ? '<img src="' + esc(logo) + '" alt=""><br>' : "") +
            '<div class="p-school">' + esc(name || "School") + "</div>" + (address ? "<div>" + esc(address) + "</div>" : "") + "</div>";
    }

    function printAttendance(sum, month) {
        const html = schoolHeader() + '<div class="p-title">STAFF ATTENDANCE · ' + esc(prettyPeriod(month).toUpperCase()) + "</div>" +
            "<table><tr><th>Name</th><th>Role</th>" + ATT.map(function (a) { return '<th class="n">' + a[0] + "</th>"; }).join("") + "</tr>" +
            sum.map(function (r) {
                return "<tr><td>" + esc(r.staff.full_name) + "</td><td>" + esc(r.staff.role_title) + "</td>" +
                    ATT.map(function (a) { return '<td class="n">' + r.c[a[0]] + "</td>"; }).join("") + "</tr>";
            }).join("") + "</table>";
        printHtml('<div class="p-box p-wide">' + html + "</div>", "Staff attendance");
    }

    /* ------------------------------------------------------
       PAYROLL tab
       ------------------------------------------------------ */
    function payName(r) {
        const s = staffById(r.staff_id);
        return s ? s.full_name : r.staff_name;
    }

    function renderPayroll() {
        const body = $("#sBody");
        const total = payRows.reduce(function (n, r) { return n + Number(r.net_pay); }, 0);
        const paid = payRows.filter(function (r) { return r.status === "Paid"; }).reduce(function (n, r) { return n + Number(r.net_pay); }, 0);
        const sorted = payRows.slice().sort(function (a, b) { return payName(a).localeCompare(payName(b)); });

        body.innerHTML =
            '<label style="margin-top:0">Month</label><input id="pMonth" type="month" value="' + esc(payPeriod) + '">' +
            '<button class="s-btn" id="pGen" type="button">Generate payroll for ' + esc(prettyPeriod(payPeriod)) + "</button>" +
            (payRows.length ? '<div class="s-box"><div class="s-line"><span>Total net pay</span><strong>' + esc(money(total)) + "</strong></div>" +
                '<div class="s-line"><span>Paid</span><span class="s-ok">' + esc(money(paid)) + "</span></div>" +
                '<div class="s-line total"><span>Still to pay</span><span class="s-owe">' + esc(money(total - paid)) + "</span></div></div>" : "") +
            '<div style="margin-top:8px">' + (sorted.map(function (r) {
                return '<div class="s-row" data-id="' + esc(r.id) + '"><div><strong>' + esc(payName(r)) + '</strong><div class="s-meta">' + esc(r.role_title || "") + "</div></div>" +
                    "<div style='text-align:right'><div>" + esc(money(r.net_pay)) + '</div><div class="' + (r.status === "Paid" ? "s-ok" : "s-owe") + '" style="font-size:12px">' + r.status + "</div></div></div>";
            }).join("") || '<p class="s-meta">No payroll for this month yet. Tap the button above to create it from each person\'s salary.</p>') + "</div>" +
            (payRows.length ? '<button class="s-btn alt" id="pExcel" type="button">Download this month (Excel)</button>' : "");

        $("#pMonth").onchange = function (e) {
            if (busy || !e.target.value) return;
            payPeriod = e.target.value;
            refresh();
        };
        $("#pGen").onclick = generatePayroll;
        modal.querySelectorAll("#sBody .s-row").forEach(function (el) {
            el.onclick = function () { view.payId = el.dataset.id; render(); };
        });
        const ex = $("#pExcel");
        if (ex) ex.onclick = downloadPayroll;
    }

    async function generatePayroll() {
        if (busy) return;
        const have = {};
        payRows.forEach(function (r) { have[r.staff_id] = true; });
        const missing = staff.filter(function (s) { return s.status === "active" && !have[s.id]; });
        if (!missing.length) { setStatus("Every active staff member already has an entry for this month.", "ok"); return; }
        const noPay = missing.filter(function (s) { return !(Number(s.base_salary) > 0); }).length;
        if (!confirm("Create " + prettyPeriod(payPeriod) + " payroll for " + missing.length + " staff member(s)?" +
            (noPay ? "\n\n" + noPay + " of them have no salary set yet (they will show ₦0.00; you can edit each entry)." : ""))) return;
        busy = true;
        try {
            const rows = missing.map(function (s) {
                const base = Number(s.base_salary) || 0, al = Number(s.default_allowance) || 0, de = Number(s.default_deduction) || 0;
                return {
                    owner_user_id: currentUserId, website_id: WEBSITE_ID, staff_id: s.id, period: payPeriod,
                    staff_name: s.full_name, role_title: s.role_title, base_salary: base, allowances: al, deductions: de,
                    net_pay: round2(base + al - de), status: "Unpaid"
                };
            });
            const res = await supabaseClient.from("staff_payroll").upsert(rows, { onConflict: "staff_id,period", ignoreDuplicates: true });
            if (res.error) throw res.error;
            await loadPayroll();
            render();
            setStatus("✔ Payroll created. Tap a person to adjust, mark paid or print a payslip.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not create payroll"), "err");
        } finally { busy = false; }
    }

    function renderPayEdit() {
        const body = $("#sBody");
        const r = payRows.filter(function (x) { return x.id === view.payId; })[0];
        if (!r) { view.payId = null; renderPayroll(); return; }
        const s = staffById(r.staff_id);

        body.innerHTML =
            '<button class="s-back" type="button">‹ Back to payroll</button>' +
            "<h3>" + esc(payName(r)) + "</h3>" +
            '<div class="s-meta">' + esc(r.role_title || "") + " · " + esc(prettyPeriod(r.period)) + (s && s.bank_name ? " · " + esc(s.bank_name) + " " + esc(s.account_no || "") : "") + "</div>" +
            '<div class="s-meta" id="pAbs" style="margin-top:4px"></div>' +
            '<div class="s-grid"><div><label>Salary (₦)</label><input id="eBase" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(r.base_salary) + '"></div>' +
            '<div><label>Allowances (₦)</label><input id="eAllow" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(r.allowances) + '"></div></div>' +
            '<div class="s-grid"><div><label>Deductions (₦)</label><input id="eDed" type="number" inputmode="decimal" min="0" step="0.01" value="' + esc(r.deductions) + '"></div>' +
            '<div><label>Note (optional)</label><input id="eNote" type="text" value="' + esc(r.note || "") + '"></div></div>' +
            '<div class="s-box"><div class="s-line total" style="border:0;margin:0;padding:0"><span>Net pay</span><span id="eNet">' + esc(money(r.net_pay)) + "</span></div></div>" +
            '<button class="s-btn alt" id="eSave" type="button">Save changes</button>' +
            (r.status === "Paid"
                ? '<div class="s-box s-ok">Paid on ' + esc(prettyDate(r.paid_on)) + (r.method ? " · " + esc(r.method) : "") + "</div>" +
                  '<button class="s-btn alt" id="eUnpay" type="button">Mark as unpaid</button>'
                : '<div class="s-grid"><div><label>Paid on</label><input id="ePaidOn" type="date" value="' + today() + '"></div>' +
                  '<div><label>Method</label><select id="eMethod">' + METHODS.map(function (m) { return "<option>" + esc(m) + "</option>"; }).join("") + "</select></div></div>" +
                  '<button class="s-btn" id="ePay" type="button">Save and mark as paid</button>') +
            '<button class="s-btn alt" id="ePrint" type="button">Print payslip</button>' +
            (r.status !== "Paid" ? '<button class="s-btn red" id="eRemove" type="button">Remove this month\'s entry</button>' : "");

        const recalc = function () {
            const n = round2($("#eBase").value) + round2($("#eAllow").value) - round2($("#eDed").value);
            $("#eNet").textContent = money(n);
        };
        ["eBase", "eAllow", "eDed"].forEach(function (id) { $("#" + id).oninput = recalc; });

        body.querySelector(".s-back").onclick = function () { view.payId = null; setStatus(""); render(); };
        $("#eSave").onclick = function () { savePay(false); };
        const pay = $("#ePay");
        if (pay) pay.onclick = function () { savePay(true); };
        const un = $("#eUnpay");
        if (un) un.onclick = markUnpaid;
        $("#ePrint").onclick = function () { printPayslip(r); };
        const rm = $("#eRemove");
        if (rm) rm.onclick = removePay;

        /* helpful hint when working out deductions */
        const range = monthRange(r.period);
        supabaseClient.from("staff_attendance").select("status")
            .eq("owner_user_id", currentUserId).eq("staff_id", r.staff_id)
            .gte("att_date", range.start).lte("att_date", range.end)
            .then(function (res) {
                const el = $("#pAbs");
                if (!el || res.error) return;
                const c = { Absent: 0, Late: 0, Leave: 0 };
                (res.data || []).forEach(function (x) { if (c[x.status] !== undefined) c[x.status]++; });
                el.textContent = "This month: " + c.Absent + " absent, " + c.Late + " late, " + c.Leave + " on leave (from attendance).";
            });
    }

    async function savePay(markPaid) {
        if (busy) return;
        const r = payRows.filter(function (x) { return x.id === view.payId; })[0];
        if (!r) return;
        const base = round2($("#eBase").value), al = round2($("#eAllow").value), de = round2($("#eDed").value);
        if (base < 0 || al < 0 || de < 0) { setStatus("Amounts cannot be negative.", "err"); return; }
        const net = round2(base + al - de);
        if (net < 0) { setStatus("Deductions are more than the pay. Check the amounts.", "err"); return; }
        const patch = { base_salary: base, allowances: al, deductions: de, net_pay: net, note: $("#eNote").value.trim() || null };
        if (markPaid) {
            if (!confirm("Mark " + payName(r) + " as paid " + money(net) + "?")) return;
            patch.status = "Paid";
            patch.paid_on = $("#ePaidOn").value || today();
            patch.method = $("#eMethod").value;
        }
        await updatePay(r.id, patch, markPaid ? "✔ Marked as paid." : "✔ Changes saved.");
    }

    async function markUnpaid() {
        if (busy) return;
        if (!confirm("Mark this payment as unpaid?")) return;
        await updatePay(view.payId, { status: "Unpaid", paid_on: null, method: null }, "Marked as unpaid.");
    }

    async function updatePay(id, patch, message) {
        busy = true;
        try {
            const res = await supabaseClient.from("staff_payroll").update(patch)
                .eq("id", id).eq("owner_user_id", currentUserId);
            if (res.error) throw res.error;
            await loadPayroll();
            render();
            setStatus(message, "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not save"), "err");
        } finally { busy = false; }
    }

    async function removePay() {
        if (busy) return;
        if (!confirm("Remove this month's entry for this person?")) return;
        busy = true;
        try {
            const res = await supabaseClient.from("staff_payroll").delete()
                .eq("id", view.payId).eq("owner_user_id", currentUserId).eq("status", "Unpaid");
            if (res.error) throw res.error;
            view.payId = null;
            await loadPayroll();
            render();
            setStatus("Entry removed.", "ok");
        } catch (e) {
            setStatus("✖ " + friendlyError(e, "Could not remove"), "err");
        } finally { busy = false; }
    }

    /* ------------------------------------------------------
       Payslip, printing and Excel
       ------------------------------------------------------ */
    function printPayslip(r) {
        const words = numberWords(r.net_pay);
        const html = schoolHeader() + '<div class="p-title">PAYSLIP · ' + esc(prettyPeriod(r.period).toUpperCase()) + "</div>" +
            '<div class="p-line"><span>Name</span><strong>' + esc(payName(r)) + "</strong></div>" +
            '<div class="p-line"><span>Role</span><span>' + esc(r.role_title || "") + "</span></div>" +
            '<div class="p-line"><span>Salary</span><span>' + esc(money(r.base_salary)) + "</span></div>" +
            '<div class="p-line"><span>Allowances</span><span>' + esc(money(r.allowances)) + "</span></div>" +
            '<div class="p-line"><span>Deductions</span><span>' + esc(money(r.deductions)) + "</span></div>" +
            (r.note ? '<div class="p-line"><span>Note</span><span>' + esc(r.note) + "</span></div>" : "") +
            '<div class="p-net">' + esc(money(r.net_pay)) + "</div>" +
            (words ? '<div class="p-words">' + esc(words) + "</div>" : "") +
            '<div class="p-line"><span>Status</span><strong>' + (r.status === "Paid"
                ? "Paid " + esc(prettyDate(r.paid_on)) + (r.method ? " (" + esc(r.method) + ")" : "") : "Not yet paid") + "</strong></div>" +
            '<div class="p-sign">Authorised signature</div>';
        printHtml('<div class="p-box">' + html + "</div>", "Payslip");
    }

    function getPrintPlugin() {
        const c = window.Capacitor;
        if (!c) return null;
        if (c.Plugins && c.Plugins.PrintPlugin) return c.Plugins.PrintPlugin;
        try {
            if (typeof c.registerPlugin === "function") return c.registerPlugin("PrintPlugin");
        } catch (e) { /* not available */ }
        return null;
    }

    function printHtml(inner, title) {
        const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) + "</title><style>" + PRINT_CSS +
            "</style></head><body>" + inner + "</body></html>";

        const pp = getPrintPlugin();
        if (pp) {
            Promise.resolve()
                .then(function () { return pp.printHtml({ html: html, name: title }); })
                .catch(function (e) {
                    alert("Could not open the printer: " + ((e && (e.message || e.errorMessage)) || e) +
                        "\n\nIf it says the method is not implemented, the app needs the latest update.");
                });
            return;
        }
        if (typeof isNativeApp === "function" && isNativeApp()) {
            alert("The print plugin was not found in this app. Please update the app.");
            return;
        }
        const w = window.open("", "_blank");
        if (w) {
            w.document.open(); w.document.write(html); w.document.close(); w.focus();
            setTimeout(function () { try { w.print(); } catch (e) { /* print from the tab */ } }, 400);
            return;
        }
        const frame = document.createElement("iframe");
        frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
        document.body.appendChild(frame);
        const doc = frame.contentWindow.document;
        doc.open(); doc.write(html); doc.close();
        setTimeout(function () {
            try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (e) { /* ignore */ }
            setTimeout(function () { frame.remove(); }, 3000);
        }, 400);
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

    async function downloadPayroll() {
        if (busy) return;
        busy = true;
        try {
            setStatus("Preparing Excel file…");
            await loadXlsxLibrary();
            const sorted = payRows.slice().sort(function (a, b) { return payName(a).localeCompare(payName(b)); });
            const sheet = [["Name", "Role", "Salary", "Allowances", "Deductions", "Net pay", "Status", "Paid on", "Method", "Bank", "Account no"]].concat(
                sorted.map(function (r) {
                    const s = staffById(r.staff_id);
                    return [payName(r), r.role_title || "", Number(r.base_salary), Number(r.allowances), Number(r.deductions), Number(r.net_pay),
                        r.status, r.paid_on || "", r.method || "", s && s.bank_name || "", s && s.account_no || ""];
                }));
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.aoa_to_sheet(sheet);
            ws["!cols"] = [30, 18, 14, 14, 14, 14, 10, 12, 14, 18, 16].map(function (w) { return { wch: w }; });
            XLSX.utils.book_append_sheet(wb, ws, "Payroll");
            const fileName = "Payroll_" + payPeriod + ".xlsx";

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
       Menu link ("👥 Staff management" in the hamburger menu)
       ------------------------------------------------------ */
    document.addEventListener("click", function (event) {
        const link = event.target.closest && event.target.closest('a[href="#schoolStaffMenu"]');
        if (!link) return;
        event.preventDefault();
        open();
    });

    /* Back from the email link? */
    (function () {
        const code = takeResetCodeFromAddress();
        if (code) finishResetFromEmail(code);
    })();

    /* Call SchoolStaff.open() from your own button if you prefer. */
    window.SchoolStaff = { open: open };
})();
