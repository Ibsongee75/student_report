/* =========================================================
   ADMISSIONS MODULE - SHARED CODE
   Used by apply.html (parents) and admissions.html (school).
   Needs the Supabase library loaded first:
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   ========================================================= */

/* Same website id / Supabase project as the report generator
   (scripttt.js). Because both pages live on the same site, the
   school owner's login is shared automatically. */
const ADM_SITE = "ibsongee75";

const ADM_SUPABASE_URL = "https://nzeddvcmabfodmvmgsyg.supabase.co";
const ADM_SUPABASE_KEY = "sb_publishable_Iaro_sV4r31wPbLycRB4Eg_OCDBy2u3";

const admDb = supabase.createClient(ADM_SUPABASE_URL, ADM_SUPABASE_KEY);

/* ---------- small helpers ---------- */

function admEsc(value) {
    return String(value === null || value === undefined ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function admQuery(name) {
    try {
        return new URLSearchParams(window.location.search).get(name) || "";
    } catch (error) {
        return "";
    }
}

/* Phone numbers are matched exactly, so spaces, dashes and brackets are
   removed the same way when applying and when checking. */
function admNormalizePhone(value) {
    return String(value || "").replace(/[\s\-().]/g, "").trim();
}

function admFmtDate(value) {

    if (!value) return "";

    const text = String(value);
    const date = new Date(text.length === 10 ? text + "T00:00:00" : text);

    if (isNaN(date.getTime())) return text;

    return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

}

function admSetMsg(element, text, isError) {

    if (!element) return;

    element.textContent = text || "";
    element.className = "adm-msg" + (text ? (isError ? " err" : " ok") : "");

}

function admErrorText(error, fallback) {

    const text = String((error && error.message) || "");

    if (error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(text))) {
        return "The admissions database is not set up yet. Run admissions_setup.sql in Supabase.";
    }

    if (error && (error.code === "42P01" || error.code === "PGRST205")) {
        return "The admissions tables are missing. Run admissions_setup.sql in Supabase.";
    }

    return text || fallback || "Something went wrong. Please try again.";

}

/* ---------- the admission letter ----------
   data = {
     full_name, class_admitted, admission_no, session, approved_at,
     parent_name, school_name, principal_name, school_address,
     school_phone, resumption_date, school_logo
   } */

function admLetterHtml(data) {

    const school = data.school_name || "School";
    const contact = [data.school_address, data.school_phone].filter(Boolean).map(admEsc).join(" &nbsp;|&nbsp; ");
    const parent = data.parent_name ? "Dear " + admEsc(data.parent_name) + "," : "Dear Parent / Guardian,";
    const signer = data.principal_name || "The Principal";

    /* The logo is a saved image (data URL or link). Only accept image sources. */
    const logoSrc = /^(data:image\/|https?:\/\/)/i.test(String(data.school_logo || "")) ? data.school_logo : "";
    const logoImg = logoSrc ? "<img class=\"adm-letter-logo\" src=\"" + admEsc(logoSrc) + "\" alt=\"\">" : "";
    const watermark = logoSrc ? "<img class=\"adm-letter-watermark\" src=\"" + admEsc(logoSrc) + "\" alt=\"\" aria-hidden=\"true\">" : "";

    const resumption = data.resumption_date
        ? "<p>Resumption date: <strong>" + admEsc(admFmtDate(data.resumption_date)) + "</strong>.</p>"
        : "";

    return (
        "<div class=\"adm-letter\">" +
            watermark +
            "<div class=\"adm-letter-stamp\">APPROVED</div>" +

            "<div class=\"adm-letter-head\">" +
                logoImg +
                "<div class=\"adm-letter-head-text\">" +
                    "<h1>" + admEsc(school) + "</h1>" +
                    (contact ? "<p>" + contact + "</p>" : "") +
                "</div>" +
                (logoImg ? "<span class=\"adm-letter-head-balance\"></span>" : "") +
            "</div>" +

            "<div class=\"adm-letter-title\">OFFER OF ADMISSION</div>" +

            "<div class=\"adm-letter-meta\">" +
                "<span>Date: " + admEsc(admFmtDate(data.approved_at)) + "</span>" +
                "<span>Admission No: <strong>" + admEsc(data.admission_no) + "</strong></span>" +
            "</div>" +

            "<p style=\"margin-top:16px;\">" + parent + "</p>" +

            "<p>We are pleased to inform you that <strong>" + admEsc(data.full_name) + "</strong> " +
            "has been offered admission into <strong>" + admEsc(data.class_admitted) + "</strong> of " +
            admEsc(school) + " for the <strong>" + admEsc(data.session) + "</strong> academic session.</p>" +

            "<div class=\"adm-letter-box\">" +
                "<div><span>Student</span><strong>" + admEsc(data.full_name) + "</strong></div>" +
                "<div><span>Class admitted</span><strong>" + admEsc(data.class_admitted) + "</strong></div>" +
                "<div><span>Admission number</span><strong>" + admEsc(data.admission_no) + "</strong></div>" +
                "<div><span>Session</span><strong>" + admEsc(data.session) + "</strong></div>" +
            "</div>" +

            resumption +

            "<p>Please bring this letter to the school when you come to complete the admission " +
            "(registration and any other requirements the school will tell you about).</p>" +

            "<p>Congratulations, and welcome to the " + admEsc(school) + " family.</p>" +

            "<div class=\"adm-letter-sign\">" +
                "<div class=\"line\"></div>" +
                "<strong>" + admEsc(signer) + "</strong><br>" +
                "<small>" + (data.principal_name ? "Principal" : "School Management") + "</small>" +
            "</div>" +

            "<p class=\"adm-letter-foot\">This letter is valid only for the admission number shown above. " +
            "The school can confirm it using that number.</p>" +

            "<div class=\"adm-letter-footer-band\">" + admEsc(school) + "</div>" +
        "</div>"
    );

}

function admCloseLetter() {

    const old = document.getElementById("admLetterOverlay");
    if (old && old.parentNode) old.parentNode.removeChild(old);

    document.body.classList.remove("adm-letter-open");

}

function admOpenLetter(data) {

    admCloseLetter();

    const overlay = document.createElement("div");
    overlay.id = "admLetterOverlay";
    overlay.className = "adm-overlay";

    overlay.innerHTML =
        "<div class=\"adm-modal-bar\">" +
            "<button type=\"button\" id=\"admLetterPrint\">\uD83D\uDDA8 Print / Save as PDF</button>" +
            "<button type=\"button\" class=\"adm-btn-ghost\" id=\"admLetterClose\">Close</button>" +
        "</div>" +
        "<div class=\"adm-letter-wrap\">" + admLetterHtml(data) + "</div>";

    document.body.appendChild(overlay);
    document.body.classList.add("adm-letter-open");

    document.getElementById("admLetterPrint").addEventListener("click", function () {
        window.print();
    });

    document.getElementById("admLetterClose").addEventListener("click", admCloseLetter);

}

document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") admCloseLetter();
});
