/* =========================================================
   admissions.html - for the school owner and the staff the
   owner has allowed to approve admissions.
   Uses the same login as the report generator.
   ========================================================= */

(function () {

    const $ = function (id) { return document.getElementById(id); };

    let me = null;              /* signed-in user */
    let ownerId = null;         /* the school being managed */
    let isOwner = false;
    let settings = null;        /* admission_settings row */
    let schoolLogo = "";        /* school_profile.school_logo (for the letter) */
    let apps = [];              /* applicants */
    let filter = "pending";
    let schools = [];
    const openIds = new Set();  /* cards the user has expanded */

    /* ---------- gate (not signed in / no access) ---------- */

    function gate(title, text, buttonText, onClick) {

        $("dash").style.display = "none";
        $("gateCard").style.display = "";
        $("gateTitle").textContent = title;
        $("gateText").textContent = text;

        const button = $("gateButton");

        if (buttonText) {
            button.style.display = "";
            button.textContent = buttonText;
            button.onclick = onClick;
        } else {
            button.style.display = "none";
        }

    }

    /* ---------- start ---------- */

    async function start() {

        const sessionResult = await admDb.auth.getSession();
        const session = sessionResult && sessionResult.data ? sessionResult.data.session : null;

        if (!session) {
            gate(
                "Please sign in",
                "Sign in with your school account on the report generator, then open Admissions again.",
                "Go to sign in",
                function () { window.location.href = "./#authSection"; }
            );
            return;
        }

        me = session.user;
        $("signOutBtn").style.display = "";

        /* Staff members already have a row in school_staff. Only a school owner
           gets an admissions record created for their own account. */
        const membership = await admDb
            .from("school_staff")
            .select("id")
            .eq("staff_user_id", me.id)
            .eq("website_id", ADM_SITE)
            .limit(1);

        const isStaffAccount = !membership.error && membership.data && membership.data.length > 0;

        if (!isStaffAccount) {

            const ensured = await admDb.rpc("ensure_admission_settings", { p_website: ADM_SITE });

            if (ensured.error) {
                console.error("ensure_admission_settings:", ensured.error);
                gate("Admissions is not ready", admErrorText(ensured.error));
                return;
            }

        }

        const mine = await admDb.rpc("my_admission_schools", { p_website: ADM_SITE });

        if (mine.error) {
            console.error("my_admission_schools:", mine.error);
            gate("Admissions is not ready", admErrorText(mine.error));
            return;
        }

        schools = mine.data || [];

        if (!schools.length) {
            gate(
                "No admissions access",
                isStaffAccount
                    ? "The school owner has not given you permission to approve admissions. Ask the owner to switch on \"Can approve admissions\" for you."
                    : "No admissions record was found for this account."
            );
            return;
        }

        const pick = $("schoolPick");

        pick.innerHTML = schools.map(function (school) {
            return "<option value=\"" + admEsc(school.owner_user_id) + "\">" +
                admEsc(school.school_name) + (school.is_owner ? " (yours)" : "") + "</option>";
        }).join("");

        $("schoolPickCard").style.display = schools.length > 1 ? "" : "none";

        await openSchool(schools[0].owner_user_id);

    }

    async function openSchool(id) {

        ownerId = id;
        isOwner = !!me && me.id === id;

        $("gateCard").style.display = "none";
        $("dash").style.display = "";
        $("settingsCard").style.display = isOwner ? "" : "none";
        $("staffCard").style.display = isOwner ? "" : "none";

        const link = new URL("apply.html", window.location.href);
        link.search = "";
        link.hash = "";
        link.searchParams.set("apply", ownerId);
        $("applyLink").value = link.href;

        await loadSettings();
        await loadApplications();

        if (isOwner) await loadStaff();

    }

    /* ---------- school details ---------- */

    async function loadSettings() {

        const { data, error } = await admDb
            .from("admission_settings")
            .select("*")
            .eq("owner_user_id", ownerId)
            .eq("website_id", ADM_SITE)
            .maybeSingle();

        if (error) {
            console.error("settings:", error);
            admSetMsg($("settingsMsg"), admErrorText(error), true);
            return;
        }

        settings = data || {};

        /* The logo is saved by the report generator in school_profile. */
        schoolLogo = "";
        const logoRes = await admDb.rpc("get_school_logo", { p_owner: ownerId, p_website: ADM_SITE });
        if (logoRes.error) {
            console.error("get_school_logo:", logoRes.error);
        } else if (typeof logoRes.data === "string") {
            schoolLogo = logoRes.data;
        }

        $("hdrSchool").textContent = settings.school_name || "Review and approve applications";

        if (isOwner) {
            $("sName").value = settings.school_name || "";
            $("sPrincipal").value = settings.principal_name || "";
            $("sPhoneNo").value = settings.phone || "";
            $("sAddress").value = settings.address || "";
            $("sSession").value = settings.current_session || "";
            $("sResume").value = settings.resumption_date || "";
        }

    }

    async function saveSettings() {

        const msg = $("settingsMsg");

        const patch = {
            school_name: $("sName").value.trim(),
            principal_name: $("sPrincipal").value.trim() || null,
            phone: $("sPhoneNo").value.trim() || null,
            address: $("sAddress").value.trim() || null,
            current_session: $("sSession").value.trim(),
            resumption_date: $("sResume").value || null
        };

        if (!patch.school_name || !patch.current_session) {
            admSetMsg(msg, "School name and session are required.", true);
            return;
        }

        admSetMsg(msg, "Saving\u2026", false);

        const { data, error } = await admDb
            .from("admission_settings")
            .update(patch)
            .eq("owner_user_id", ownerId)
            .eq("website_id", ADM_SITE)
            .select()
            .single();

        if (error) {
            console.error("save settings:", error);
            admSetMsg(msg, admErrorText(error, "Could not save."), true);
            return;
        }

        settings = data;
        $("hdrSchool").textContent = settings.school_name;
        admSetMsg(msg, "Saved. New letters will use these details.", false);

    }

    /* ---------- applications ---------- */

    async function loadApplications() {

        const msg = $("listMsg");
        admSetMsg(msg, "Loading\u2026", false);

        const { data, error } = await admDb
            .from("applicants")
            .select("*")
            .eq("owner_user_id", ownerId)
            .eq("website_id", ADM_SITE)
            .order("created_at", { ascending: false })
            .limit(1000);

        if (error) {
            console.error("applicants:", error);
            admSetMsg(msg, admErrorText(error, "Could not load applications."), true);
            return;
        }

        apps = data || [];
        admSetMsg(msg, "", false);
        renderApplications();

    }

    function appMatches(app, query) {

        if (!query) return true;

        const text = [app.full_name, app.ref_no, app.parent_name, app.parent_phone, app.admission_no]
            .join(" ").toLowerCase();

        return text.indexOf(query) !== -1;

    }

    function renderApplications() {

        const counts = { pending: 0, admitted: 0, rejected: 0 };
        apps.forEach(function (app) { if (counts[app.status] !== undefined) counts[app.status]++; });

        $("cPending").textContent = counts.pending;
        $("cAdmitted").textContent = counts.admitted;
        $("cRejected").textContent = counts.rejected;
        $("cTotal").textContent = apps.length;

        const query = $("searchBox").value.trim().toLowerCase();

        const shown = apps.filter(function (app) {
            return (filter === "all" || app.status === filter) && appMatches(app, query);
        });

        if (!shown.length) {
            $("appList").innerHTML = "<div class=\"adm-empty\">No applications here.</div>";
            return;
        }

        $("appList").innerHTML = shown.map(appHtml).join("");

    }

    function appHtml(app) {

        const label = { pending: "Pending", admitted: "Admitted", rejected: "Not admitted" }[app.status] || app.status;

        const info = function (title, value) {
            return value ? "<div><span>" + admEsc(title) + "</span>" + admEsc(value) + "</div>" : "";
        };

        const phone = app.parent_phone
            ? "<div><span>Parent phone</span><a href=\"tel:" + admEsc(app.parent_phone) + "\">" +
              admEsc(app.parent_phone) + "</a></div>"
            : "";

        let actions = "";

        if (app.status === "pending") {

            actions =
                "<div class=\"adm-form adm-two\">" +
                    "<div class=\"adm-field\"><label>Admit into class</label>" +
                        "<input data-f=\"class\" type=\"text\" value=\"" + admEsc(app.class_admitted || app.class_applied) + "\"></div>" +
                    "<div class=\"adm-field\"><label>Note (optional)</label>" +
                        "<input data-f=\"remarks\" type=\"text\" value=\"" + admEsc(app.remarks || "") + "\"></div>" +
                    "<div class=\"adm-full\">" +
                        "<button type=\"button\" data-act=\"admit\">\u2714 Admit</button>" +
                        "<button type=\"button\" class=\"adm-btn-danger\" data-act=\"reject\">\u2716 Do not admit</button>" +
                    "</div>" +
                "</div>";

        } else if (app.status === "admitted") {

            actions =
                "<p><strong>Admission No:</strong> " + admEsc(app.admission_no) +
                " &nbsp;|&nbsp; <strong>Class:</strong> " + admEsc(app.class_admitted) + "</p>" +
                "<button type=\"button\" data-act=\"print\">\uD83D\uDDA8 View / print letter</button>" +
                "<button type=\"button\" class=\"adm-btn-ghost\" data-act=\"withdraw\">Withdraw admission</button>";

        } else {

            actions =
                (app.remarks ? "<p><strong>Note:</strong> " + admEsc(app.remarks) + "</p>" : "") +
                "<button type=\"button\" class=\"adm-btn-ghost\" data-act=\"reopen\">Move back to pending</button>";

        }

        return (
            "<details class=\"adm-app\" data-id=\"" + admEsc(app.id) + "\"" + (openIds.has(app.id) ? " open" : "") + ">" +
                "<summary>" +
                    "<span class=\"adm-app-name\">" + admEsc(app.full_name) + "</span>" +
                    "<span class=\"adm-app-sub\">" + admEsc(app.class_applied) + " \u00B7 " + admEsc(app.ref_no) + "</span>" +
                    "<span class=\"adm-badge " + admEsc(app.status) + "\">" + admEsc(label) + "</span>" +
                "</summary>" +
                "<div class=\"adm-app-body\">" +
                    "<div class=\"adm-grid\">" +
                        info("Date of birth", admFmtDate(app.date_of_birth)) +
                        info("Gender", app.gender) +
                        info("Class applied for", app.class_applied) +
                        info("Parent / guardian", app.parent_name) +
                        phone +
                        info("Parent email", app.parent_email) +
                        info("Address", app.address) +
                        info("Previous school", app.previous_school) +
                        info("Applied on", admFmtDate(app.created_at)) +
                        (app.approved_at ? info("Decided on", admFmtDate(app.approved_at)) : "") +
                    "</div>" +
                    actions +
                "</div>" +
            "</details>"
        );

    }

    async function updateApplication(id, patch, doneText) {

        const msg = $("listMsg");
        admSetMsg(msg, "Saving\u2026", false);

        const { data, error } = await admDb
            .from("applicants")
            .update(patch)
            .eq("id", id)
            .select()
            .single();

        if (error) {
            console.error("update applicant:", error);
            const denied = /no rows|multiple \(or no\) rows/i.test(String(error.message || ""));
            admSetMsg(
                msg,
                denied
                    ? "You do not have permission to change this application."
                    : admErrorText(error, "Could not save."),
                true
            );
            return;
        }

        apps = apps.map(function (app) { return app.id === id ? data : app; });
        admSetMsg(msg, doneText, false);
        renderApplications();

    }

    function letterData(app) {

        return {
            full_name: app.full_name,
            class_admitted: app.class_admitted || app.class_applied,
            admission_no: app.admission_no,
            session: app.session,
            approved_at: app.approved_at,
            parent_name: app.parent_name,
            school_name: settings && settings.school_name,
            principal_name: settings && settings.principal_name,
            school_address: settings && settings.address,
            school_phone: settings && settings.phone,
            resumption_date: settings && settings.resumption_date,
            school_logo: schoolLogo
        };

    }

    async function onListClick(event) {

        const button = event.target.closest("button[data-act]");
        if (!button) return;

        const card = button.closest("details.adm-app");
        if (!card) return;

        const id = card.getAttribute("data-id");
        const app = apps.find(function (item) { return item.id === id; });
        if (!app) return;

        const act = button.getAttribute("data-act");

        if (act === "print") {
            admOpenLetter(letterData(app));
            return;
        }

        const field = function (name) {
            const input = card.querySelector("[data-f=\"" + name + "\"]");
            return input ? input.value.trim() : "";
        };

        button.disabled = true;

        try {

            if (act === "admit") {

                const className = field("class");

                if (!className) {
                    admSetMsg($("listMsg"), "Enter the class the child is admitted into.", true);
                    return;
                }

                await updateApplication(id, {
                    status: "admitted",
                    class_admitted: className,
                    remarks: field("remarks") || null
                }, "\u2705 " + app.full_name + " admitted. The parent can now print the letter.");

            } else if (act === "reject") {

                if (!confirm("Do not admit " + app.full_name + "?")) return;

                await updateApplication(id, {
                    status: "rejected",
                    remarks: field("remarks") || null
                }, app.full_name + " was not admitted.");

            } else if (act === "reopen") {

                await updateApplication(id, { status: "pending" }, app.full_name + " moved back to pending.");

            } else if (act === "withdraw") {

                if (!confirm("Withdraw the admission of " + app.full_name + "?\n\nThe parent will no longer be able to print the letter.")) return;

                await updateApplication(id, { status: "pending" }, "Admission withdrawn. " + app.full_name + " is pending again.");

            }

        } finally {

            button.disabled = false;

        }

    }

    /* ---------- staff permission ---------- */

    async function loadStaff() {

        const box = $("staffList");

        const { data, error } = await admDb
            .from("school_staff")
            .select("id, full_name, email, status, can_approve_admissions")
            .eq("owner_user_id", me.id)
            .eq("website_id", ADM_SITE)
            .order("full_name");

        if (error) {
            console.error("staff:", error);
            box.innerHTML = "";
            admSetMsg($("staffMsg"), admErrorText(error, "Could not load your staff."), true);
            return;
        }

        const approved = (data || []).filter(function (row) { return row.status === "approved"; });
        const pending = (data || []).filter(function (row) { return row.status === "pending"; });

        let html = "";

        if (!approved.length) {
            html += "<div class=\"adm-empty\">No approved staff yet. Staff join from the Staff access section of the report generator.</div>";
        }

        approved.forEach(function (row) {
            html +=
                "<div class=\"adm-staff-row\">" +
                    "<div><strong>" + admEsc(row.full_name || row.email) + "</strong><br>" +
                        "<span class=\"adm-app-sub\">" + admEsc(row.email) + "</span></div>" +
                    "<label><input type=\"checkbox\" data-staff=\"" + admEsc(row.id) + "\"" +
                        (row.can_approve_admissions ? " checked" : "") + "> Can approve admissions</label>" +
                "</div>";
        });

        if (pending.length) {
            html += "<p class=\"adm-note\">" + pending.length + " staff request(s) are waiting for your approval in " +
                "<strong>Staff access</strong> on the report generator.</p>";
        }

        box.innerHTML = html;

    }

    async function onStaffChange(event) {

        const box = event.target.closest("input[data-staff]");
        if (!box) return;

        const msg = $("staffMsg");
        const wanted = box.checked;

        box.disabled = true;
        admSetMsg(msg, "Saving\u2026", false);

        const { error } = await admDb
            .from("school_staff")
            .update({ can_approve_admissions: wanted })
            .eq("id", box.getAttribute("data-staff"))
            .eq("owner_user_id", me.id);

        box.disabled = false;

        if (error) {
            console.error("staff update:", error);
            box.checked = !wanted;
            admSetMsg(msg, admErrorText(error, "Could not save."), true);
            return;
        }

        admSetMsg(msg, wanted ? "This staff member can now approve admissions." : "Approval right removed.", false);

    }

    /* ---------- link sharing ---------- */

    async function copyLink() {

        const input = $("applyLink");
        const msg = $("linkMsg");

        try {
            await navigator.clipboard.writeText(input.value);
        } catch (error) {
            input.select();
            try { document.execCommand("copy"); } catch (copyError) { /* ignore */ }
        }

        admSetMsg(msg, "Link copied.", false);

    }

    function shareLink() {

        const school = (settings && settings.school_name) || "our school";
        const text = "Apply for admission at " + school + ": " + $("applyLink").value;

        window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");

    }

    /* ---------- wire up ---------- */

    $("backToSite").addEventListener("click", function () { window.location.href = "./"; });

    $("signOutBtn").addEventListener("click", async function () {
        await admDb.auth.signOut();
        window.location.reload();
    });

    $("copyLink").addEventListener("click", copyLink);
    $("shareLink").addEventListener("click", shareLink);
    $("saveSettings").addEventListener("click", saveSettings);
    $("reloadList").addEventListener("click", loadApplications);
    $("searchBox").addEventListener("input", renderApplications);
    $("appList").addEventListener("click", onListClick);
    $("staffList").addEventListener("change", onStaffChange);

    $("appList").addEventListener("toggle", function (event) {

        const card = event.target;
        if (!card || !card.getAttribute) return;

        const id = card.getAttribute("data-id");
        if (!id) return;

        if (card.open) openIds.add(id); else openIds.delete(id);

    }, true);

    $("filterTabs").addEventListener("click", function (event) {

        const tab = event.target.closest("button[data-filter]");
        if (!tab) return;

        filter = tab.getAttribute("data-filter");

        document.querySelectorAll("#filterTabs .adm-tab").forEach(function (button) {
            button.classList.toggle("active", button === tab);
        });

        renderApplications();

    });

    $("schoolPick").addEventListener("change", function () {
        openSchool($("schoolPick").value);
    });

    start();

})();
