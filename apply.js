/* =========================================================
   apply.html - what a parent sees. No login needed.
   The school's link looks like:  apply.html?apply=<school owner id>
   ========================================================= */

(function () {

    const ownerId = admQuery("apply").trim();
    const $ = function (id) { return document.getElementById(id); };

    function showTab(name) {

        ["apply", "status", "verify"].forEach(function (tab) {
            $("tab-" + tab).style.display = tab === name ? "" : "none";
        });

        document.querySelectorAll(".adm-tab").forEach(function (button) {
            button.classList.toggle("active", button.getAttribute("data-tab") === name);
        });

    }

    /* ---------- start: is the link valid? ---------- */

    async function start() {

        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) {
            $("badLink").style.display = "";
            return;
        }

        const { data, error } = await admDb.rpc("get_school_public", {
            p_owner: ownerId,
            p_website: ADM_SITE
        });

        if (error || !data || !data.length) {
            $("badLink").style.display = "";
            if (error) console.error("get_school_public:", error);
            return;
        }

        const school = data[0];

        $("schoolTitle").textContent = school.school_name || "School Admission";
        $("schoolSub").textContent = "Admission application \u2013 " + (school.current_session || "") + " session";
        document.title = (school.school_name || "School") + " \u2013 Admission";

        $("fDob").max = new Date().toISOString().slice(0, 10);
        $("applyArea").style.display = "";

        const ref = admQuery("ref");
        if (ref) { $("sRef").value = ref; showTab("status"); }

    }

    /* ---------- apply ---------- */

    async function submitApplication() {

        const msg = $("applyMsg");
        const button = $("submitApplication");

        const payload = {
            owner_id: ownerId,
            website_id: ADM_SITE,
            full_name: $("fFullName").value.trim(),
            date_of_birth: $("fDob").value,
            gender: $("fGender").value,
            class_applied: $("fClass").value.trim(),
            parent_name: $("fParent").value.trim(),
            parent_phone: admNormalizePhone($("fPhone").value),
            parent_email: $("fEmail").value.trim(),
            address: $("fAddress").value.trim(),
            previous_school: $("fPrevSchool").value.trim()
        };

        if (!payload.full_name || !payload.date_of_birth || !payload.class_applied ||
            !payload.parent_name || !payload.parent_phone) {
            admSetMsg(msg, "Please fill in every field marked *.", true);
            return;
        }

        if (!/^\+?\d{7,15}$/.test(payload.parent_phone)) {
            admSetMsg(msg, "Please enter a valid phone number (digits only, e.g. 08012345678).", true);
            return;
        }

        if (payload.parent_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.parent_email)) {
            admSetMsg(msg, "That email address does not look right.", true);
            return;
        }

        if (payload.date_of_birth > new Date().toISOString().slice(0, 10)) {
            admSetMsg(msg, "The date of birth cannot be in the future.", true);
            return;
        }

        /* Spam trap filled in: pretend it worked, save nothing. */
        if ($("fWebsite").value) {
            $("applyFormBox").style.display = "none";
            $("applyDone").style.display = "";
            $("doneRef").textContent = "APP-" + Math.random().toString(36).slice(2, 10).toUpperCase();
            return;
        }

        if (!payload.gender) delete payload.gender;

        button.disabled = true;
        admSetMsg(msg, "Submitting\u2026", false);

        const { data, error } = await admDb.rpc("submit_application", { p: payload });

        button.disabled = false;

        if (error) {
            console.error("submit_application:", error);
            admSetMsg(msg, admErrorText(error, "Could not submit. Please try again."), true);
            return;
        }

        admSetMsg(msg, "", false);

        $("doneRef").textContent = data;
        $("sRef").value = data;
        $("sPhone").value = payload.parent_phone;

        $("applyFormBox").style.display = "none";
        $("applyDone").style.display = "";

    }

    function applyAnother() {

        ["fFullName", "fDob", "fGender", "fClass", "fAddress", "fPrevSchool"].forEach(function (id) {
            $(id).value = "";
        });

        $("applyDone").style.display = "none";
        $("applyFormBox").style.display = "";

    }

    /* ---------- status + letter ---------- */

    async function checkStatus() {

        const msg = $("statusMsg");
        const result = $("statusResult");
        const ref = $("sRef").value.trim();
        const phone = admNormalizePhone($("sPhone").value);

        result.innerHTML = "";

        if (!ref || !phone) {
            admSetMsg(msg, "Enter the reference number and the phone number.", true);
            return;
        }

        admSetMsg(msg, "Checking\u2026", false);

        const { data, error } = await admDb.rpc("track_application", {
            p_owner: ownerId,
            p_website: ADM_SITE,
            p_ref: ref,
            p_phone: phone
        });

        if (error) {
            console.error("track_application:", error);
            admSetMsg(msg, admErrorText(error, "Could not check right now."), true);
            return;
        }

        if (!data || !data.length) {
            admSetMsg(msg, "No application found. Check the reference number and phone number.", true);
            return;
        }

        admSetMsg(msg, "", false);

        const app = data[0];

        if (app.status === "pending") {

            result.innerHTML =
                "<div class=\"adm-note\"><strong>" + admEsc(app.full_name) + "</strong> \u2013 " +
                admEsc(app.class_applied) + "<br>Status: <strong>Under review.</strong> " +
                "The school has not decided yet. Please check again later.</div>";

        } else if (app.status === "rejected") {

            result.innerHTML =
                "<div class=\"adm-note\"><strong>" + admEsc(app.full_name) + "</strong><br>" +
                "The school was not able to offer admission at this time. " +
                "Please contact the school for more information.</div>";

        } else {

            const letter = await admDb.rpc("get_letter", {
                p_owner: ownerId,
                p_website: ADM_SITE,
                p_ref: ref,
                p_phone: phone
            });

            if (letter.error || !letter.data || !letter.data.length) {
                console.error("get_letter:", letter.error);
                admSetMsg(msg, "Admitted, but the letter could not be loaded. Please try again.", true);
                return;
            }

            const info = letter.data[0];

            result.innerHTML =
                "<div class=\"adm-ok-box\"><strong>Congratulations!</strong><br>" +
                admEsc(info.full_name) + " has been admitted into <strong>" + admEsc(info.class_admitted) +
                "</strong>.<br>Admission number: <strong>" + admEsc(info.admission_no) + "</strong></div>" +
                "<button type=\"button\" id=\"openLetter\">View / print admission letter</button>";

            $("openLetter").addEventListener("click", function () { admOpenLetter(info); });

        }

    }

    /* ---------- verify ---------- */

    async function verifyLetter() {

        const msg = $("verifyMsg");
        const result = $("verifyResult");
        const number = $("vNo").value.trim();

        result.innerHTML = "";

        if (!number) {
            admSetMsg(msg, "Enter the admission number.", true);
            return;
        }

        admSetMsg(msg, "Checking\u2026", false);

        const { data, error } = await admDb.rpc("verify_letter", {
            p_owner: ownerId,
            p_website: ADM_SITE,
            p_admission_no: number
        });

        if (error) {
            console.error("verify_letter:", error);
            admSetMsg(msg, admErrorText(error, "Could not verify right now."), true);
            return;
        }

        if (!data || !data.length) {
            admSetMsg(msg, "No admission found with that number. The letter may not be genuine.", true);
            return;
        }

        admSetMsg(msg, "", false);

        const info = data[0];

        result.innerHTML =
            "<div class=\"adm-ok-box\"><strong>\u2705 Genuine admission</strong><br>" +
            "Student: <strong>" + admEsc(info.full_name) + "</strong><br>" +
            "Class: " + admEsc(info.class_admitted) + "<br>" +
            "Session: " + admEsc(info.session) + "<br>" +
            "Approved: " + admEsc(admFmtDate(info.approved_at)) + "</div>";

    }

    /* ---------- wire up ---------- */

    document.querySelectorAll(".adm-tab").forEach(function (button) {
        button.addEventListener("click", function () { showTab(button.getAttribute("data-tab")); });
    });

    $("submitApplication").addEventListener("click", submitApplication);
    $("applyAnother").addEventListener("click", applyAnother);
    $("goStatus").addEventListener("click", function () { showTab("status"); $("checkStatus").click(); });
    $("checkStatus").addEventListener("click", checkStatus);
    $("verifyLetter").addEventListener("click", verifyLetter);

    start();

})();
