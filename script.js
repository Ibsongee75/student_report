/* =========================================================
   RENEWAL / CARRY-OVER CONTRACT
   =========================================================

   Before payment, the client calculates the unused balance from the
   current subscription and sends it to the paystack-verification1 Edge
   Function as previous_remaining_reports.

   The server-side renewal must store that value in the NEW row as
   carried_over_reports and reset reports_generated to 0.

   Example: old limit 100, old usage 35 -> 65 carried over; new
   Standard limit 500 -> 565 total available.
   ========================================================= */

/* =========================================================
   STUDENT REPORT GENERATOR
   COMPLETE CLEANED script.js
   ========================================================= */
/* =========================================================
   WEBSITE IDENTIFICATION
   ========================================================= */

const WEBSITE_ID = "ibsongee75";

const WEBSITE_NAME = "StudentReport";

const WEBSITE_URL =
    "https://ibsongee75.github.io/Student-report-system-ibsongee75/";
/* =========================================================
   STUDENT REPORT GENERATOR
   COMPLETE CLEANED script.js
   ========================================================= */

/* =========================================================
   SUPABASE
   ========================================================= */

const SUPABASE_URL =
    "https://nzeddvcmabfodmvmgsyg.supabase.co";

const SUPABASE_KEY =
    "sb_publishable_Iaro_sV4r31wPbLycRB4Eg_OCDBy2u3";

const supabaseClient =
    supabase.createClient(
        SUPABASE_URL,
        SUPABASE_KEY
    );


/* =========================================================
   PAYSTACK
   ========================================================= */

const PAYSTACK_PUBLIC_KEY =
    "pk_live_13f21f3e23bb881e317ecafcf21cf4f6acb76144";


/* =========================================================
    GLOBAL VARIABLES
    ========================================================= */

let students = [];

let currentSubscriptionPlan = "";

let reportsGenerated = 0;

let currentUserId = null;

let currentSubscription = null;


/* =========================================================
   LOCAL DATA STORAGE
   ========================================================= */

const STUDENT_DATA_STORAGE_KEY =
    "studentReportGeneratorData";

const STUDENT_SUBJECTS_STORAGE_KEY =
    "studentReportGeneratorSubjects";

const REPORT_SETTINGS_STORAGE_KEY =
    "studentReportGeneratorSettings";

const GENERATED_REPORTS_STORAGE_KEY =
    "studentReportGeneratorGeneratedReports";

/* =========================================================
   REPORT GENERATION LEDGER

   Prevent the same report from consuming another allowance merely
   because the page was refreshed or the user switched between
   Generate Student and Generate All modes.

   The ledger is stored locally and scoped to the active subscription.
   A changed student report/settings produces a new fingerprint and can
   therefore consume a new allowance normally.
   ========================================================= */
const REPORT_GENERATION_LEDGER_KEY =
    "studentReportGeneratorGenerationLedger";

function getGenerationLedger() {
    try {
        const raw = localStorage.getItem(REPORT_GENERATION_LEDGER_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
        console.error("Unable to read report generation ledger:", error);
        return {};
    }
}

function saveGenerationLedger(ledger) {
    try {
        localStorage.setItem(
            REPORT_GENERATION_LEDGER_KEY,
            JSON.stringify(ledger)
        );
    } catch (error) {
        console.error("Unable to save report generation ledger:", error);
    }
}

function getCurrentSubscriptionScope() {
    if (!currentSubscription || !currentUserId) {
        return "no-subscription";
    }

    /* Keep the ledger stable across page refreshes and mode switches.
       A renewal must create a fresh scope, so include the subscription
       identity plus the renewal-changing values. */
    return [
        String(currentUserId),
        String(currentSubscription.website_id || WEBSITE_ID),
        String(currentSubscription.id || currentSubscription.created_at || "subscription"),
        String(currentSubscription.payment_reference || ""),
        String(
            currentSubscription.plan ||
            currentSubscription.subscription_plan ||
            currentSubscription.package ||
            ""
        ),
        String(currentSubscription.expires_at || "")
    ].join("|");
}

function stableValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value !== "object") return String(value);

    if (Array.isArray(value)) {
        return value.map(stableValue);
    }

    const output = {};

    Object.keys(value)
        .sort()
        .forEach(function (key) {
            if (key === "__generationFingerprint") return;
            output[key] = stableValue(value[key]);
        });

    return output;
}

function simpleHash(text) {
    let hash = 2166136261;

    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash +=
            (hash << 1) +
            (hash << 4) +
            (hash << 7) +
            (hash << 8) +
            (hash << 24);
    }

    return (hash >>> 0).toString(16);
}

/* The Automatic Comments feature stores its generated sentences on the student
   and its bank inside the settings. Neither may change a report's fingerprint,
   otherwise editing the comment bank would charge already-generated reports again.
   Comments TYPED by a teacher still count. */
function studentForFingerprint(student) {

    const copy = Object.assign({}, student);
    delete copy.__autoComment;

    if (student && student.__behavior) {

        const flags = student.__autoComment || {};

        copy.__behavior = Object.assign({}, student.__behavior);

        if (flags.teacher) delete copy.__behavior["Class Teacher's Comment"];
        if (flags.principal) delete copy.__behavior["Principal's Comment"];

    }

    return copy;

}

function reportSettingsForFingerprint() {
    const copy = Object.assign({}, reportSettings);
    delete copy.commentBank;
    return copy;
}

function getReportGenerationFingerprint(student) {
    const payload = {
        student: stableValue(studentForFingerprint(student)),
        subjects: stableValue(schoolSubjects),
        settings: stableValue(reportSettingsForFingerprint()),
        website: WEBSITE_ID
    };

    return simpleHash(JSON.stringify(payload));
}

function hasReportBeenGenerated(fingerprint) {
    const ledger = getGenerationLedger();
    const scope = getCurrentSubscriptionScope();

    return !!(
        ledger[scope] &&
        ledger[scope][fingerprint]
    );
}

function markReportsAsGenerated(fingerprints) {
    if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
        return;
    }

    const ledger = getGenerationLedger();
    const scope = getCurrentSubscriptionScope();

    if (!ledger[scope]) {
        ledger[scope] = {};
    }

    fingerprints.forEach(function (fingerprint) {
        if (fingerprint) {
            ledger[scope][fingerprint] = Date.now();
        }
    });

    /* Keep the local ledger small. */
    const keys = Object.keys(ledger);

    if (keys.length > 8) {
        keys.sort(function (a, b) {
            const aTime = Math.max.apply(
                null,
                Object.values(ledger[a] || {})
                    .map(Number)
                    .concat([0])
            );

            const bTime = Math.max.apply(
                null,
                Object.values(ledger[b] || {})
                    .map(Number)
                    .concat([0])
            );

            return bTime - aTime;
        });

        keys.slice(8).forEach(function (key) {
            delete ledger[key];
        });
    }

    saveGenerationLedger(ledger);
}

/* Recognise reports generated before this ledger was introduced when
   those reports are still restored from localStorage. */
function migrateLegacyGeneratedReportsToLedger() {
    if (
        !currentSubscription ||
        !reportContainer ||
        !students ||
        students.length === 0
    ) {
        return;
    }

    const visibleText = reportContainer.textContent || "";
    const fingerprints = [];

    students.forEach(function (student) {
        const name = String(
            student["Student Name"] || ""
        ).trim();

        const admissionNo = String(
            student["Admission No"] || ""
        ).trim();

        if (!name) return;

        if (
            visibleText.includes(name) &&
            (!admissionNo || visibleText.includes(admissionNo))
        ) {
            fingerprints.push(
                getReportGenerationFingerprint(student)
            );
        }
    });

    if (fingerprints.length > 0) {
        markReportsAsGenerated(fingerprints);
    }
}



/* =========================================================
   SAVE APP DATA
   ========================================================= */

function saveAppData() {

    try {

        localStorage.setItem(
            STUDENT_DATA_STORAGE_KEY,
            JSON.stringify(students)
        );

        localStorage.setItem(
            STUDENT_SUBJECTS_STORAGE_KEY,
            JSON.stringify(schoolSubjects)
        );

        localStorage.setItem(
            REPORT_SETTINGS_STORAGE_KEY,
            JSON.stringify(reportSettings)
        );

    } catch (error) {

        console.error(
            "Unable to save app data:",
            error
        );

    }

}


/* =========================================================
   RESTORE APP DATA
   ========================================================= */

function restoreAppData() {

    try {

        const savedStudents =
            localStorage.getItem(
                STUDENT_DATA_STORAGE_KEY
            );

        const savedSubjects =
            localStorage.getItem(
                STUDENT_SUBJECTS_STORAGE_KEY
            );

        const savedSettings =
            localStorage.getItem(
                REPORT_SETTINGS_STORAGE_KEY
            );


        /* =========================
           STUDENTS
           ========================= */

        if (savedStudents) {

            const parsedStudents =
                JSON.parse(savedStudents);

            if (
                Array.isArray(
                    parsedStudents
                )
            ) {

                students =
                    parsedStudents;

            }

        }


        /* =========================
           SUBJECTS
           ========================= */

        if (savedSubjects) {

            const parsedSubjects =
                JSON.parse(savedSubjects);

            if (
                Array.isArray(
                    parsedSubjects
                ) &&
                parsedSubjects.length > 0
            ) {

                schoolSubjects =
                    parsedSubjects;

            }

        }


        /* =========================
           SETTINGS
           ========================= */

        if (savedSettings) {

            const parsedSettings =
                JSON.parse(savedSettings);

            if (
                parsedSettings &&
                typeof parsedSettings === "object"
            ) {

                reportSettings = {
                    ...reportSettings,
                    ...parsedSettings
                };

            }

        }


        /* =========================
           RESTORE STUDENTS
           ========================= */

        if (students.length > 0) {

            students.forEach(
                function (student) {

                    if (
                        !student.__behavior
                    ) {

                        student.__behavior = {};

                    }

                }
            );


            loadStudents();


            if (reportSection) {

                reportSection.style.display =
                    "block";

            }


            updateReportStatus();


            setFileStatus(
                "✅ Previous Excel data restored. " +
                students.length +
                " student record(s) available."
            );

        }


        renderSubjectList();

    } catch (error) {

        console.error(
            "Unable to restore app data:",
            error
        );

    }

}


/* =========================================================
   SAVE GENERATED REPORTS
   ========================================================= */

function saveGeneratedReports() {

    if (!reportContainer) {
        return;
    }

    try {

        const reportsHTML =
            reportContainer.innerHTML;

        localStorage.setItem(
            GENERATED_REPORTS_STORAGE_KEY,
            reportsHTML
        );

    } catch (error) {

        console.error(
            "Unable to save generated reports:",
            error
        );

    }

}


/* =========================================================
   RESTORE GENERATED REPORTS
   ========================================================= */

function restoreGeneratedReports() {

    if (!reportContainer) {
        return;
    }

    try {

        const savedReports =
            localStorage.getItem(
                GENERATED_REPORTS_STORAGE_KEY
            );

        if (
            savedReports &&
            savedReports.trim() !== ""
        ) {

            reportContainer.innerHTML =
                savedReports;

        }

    } catch (error) {

        console.error(
            "Unable to restore generated reports:",
            error
        );

    }

}


/* =========================================================
   CLEAR GENERATED REPORTS
   ========================================================= */

function clearGeneratedReports() {

    try {

        localStorage.removeItem(
            GENERATED_REPORTS_STORAGE_KEY
        );

    } catch (error) {

        console.error(
            "Unable to clear generated reports:",
            error
        );

    }

}


/* =========================================================
   REPORT GENERATION LIMITS
   ========================================================= */

const REPORT_LIMITS = {

    basic: 100,

    standard: 500,

    premium: 1000,

    /* Not a literal Infinity: kept as a large finite number so every
       calculation above (carry-over math, remaining counts, the
       claim_report_allowance RPC) stays well-defined. Must match
       PLAN_CONFIG.unlimited.reports in the paystack-verification1
       edge function and the RPC's own CASE branch. */
    unlimited: 1000000,

    /* One-time allowance for brand-new accounts. */
    free_trial: 10

};

/* Any plan limit at or above this is treated as "Unlimited" for
   on-screen display, instead of printing the raw sentinel number. */
const UNLIMITED_DISPLAY_THRESHOLD = 1000000;

function formatReportCount(n) {

    return (Number(n) || 0) >= UNLIMITED_DISPLAY_THRESHOLD
        ? "Unlimited"
        : n;

}

const FREE_TRIAL_PLAN = "free_trial";
const FREE_TRIAL_STATUS = "trial";
const FREE_TRIAL_REPORTS = 10;
const FREE_TRIAL_DURATION_DAYS = 7;
let freeTrialExpiryTimer = null;


/* =========================================================
   SCHOOL SUBJECTS
   ========================================================= */

let schoolSubjects = [

    "Mathematics",
    "English",
    "Biology",
    "Physics",
    "Chemistry",
    "Computer Science"

];


/* =========================================================
   BEHAVIORAL TRAITS
   ========================================================= */

const behavioralTraits = [

    "Attendance",
    "Punctuality",
    "Class Participation",
    "Neatness",
    "Honesty"

];


/* =========================================================
   REPORT SETTINGS
   ========================================================= */

let reportSettings = {

    schoolName:
        "YOUR SCHOOL NAME",

    schoolAddress:
        "YOUR SCHOOL ADDRESS",

    schoolLogo:
        "",

    firstCAMaximum:
        20,

    secondCAMaximum:
        20,

    examsMaximum:
        60,

    gradeA:
        70,

    gradeB:
        60,

    gradeC:
        50,

    gradeD:
        45,

    gradeE:
        40,

    gradeF:
        0

};


const TEMPLATE_STUDENT_ROWS = 300;


/* =========================================================
   DOM ELEMENTS
   ========================================================= */

let authSection;

let appSection;

let subscriptionPlans;

let subscriptionStatus;

let emailInput;

let passwordInput;

let signUpButton;

let signInButton;

let logoutButton;

let authStatus;

let downloadTemplateButton;

let excelFileInput;

let fileStatus;

let classNameInput;

let newClassNameInput;

let addClassButton;

let classListContainer;

let classManagerStatus;

let subjectTemplateSelect;

let downloadSubjectTemplateButton;

let subjectTemplateFileInput;

let subjectTemplateStatus;

let reportSection;

let studentSelect;

let generateReportButton;

let generateAllButton;
let generateMasterSheetButton;

let reportContainer;

let printReportButton;

let publishResultsSection;

let publishStudentSelect;

let publishSingleResultButton;

let publishAllResultsButton;

let publishResultsStatus;

let publishedResultInfo;

let schoolNameInput;

let schoolAddressInput;

let schoolLogoInput;

let schoolLogoPreview;

let removeSchoolLogoButton;

let saveSchoolInformationButton;

let schoolInformationStatus;


/* =========================================================
   CLICK / NETWORK HELPERS
   - withTimeout: a stalled network request can no longer leave a
     button looking dead; after the limit the caller falls back.
   - guardedClick: shows the button as busy, ignores double clicks,
     always re-enables the button and reports any error.
   ========================================================= */

const NETWORK_TIMEOUT_MS = 8000;

function withTimeout(promise, ms, fallbackValue) {

    return new Promise(function (resolve) {

        const timer = setTimeout(function () {
            console.warn("Request timed out after " + ms + "ms.");
            resolve(fallbackValue);
        }, ms);

        Promise.resolve(promise).then(
            function (value) {
                clearTimeout(timer);
                resolve(value);
            },
            function (error) {
                clearTimeout(timer);
                console.error(error);
                resolve(fallbackValue);
            }
        );

    });

}

/* ---------------------------------------------------------
   ensureXLSX: the Excel library normally loads from the page's
   <script> tag. On a slow or blocked connection (common on a live
   site) that single CDN can fail, leaving every download button
   dead until a refresh. This loads it on demand from backups.
   --------------------------------------------------------- */

let xlsxLoadPromise = null;

function loadScriptOnce(src, ms) {

    return new Promise(function (resolve) {

        const tag = document.createElement("script");
        const timer = setTimeout(function () { tag.remove(); resolve(false); }, ms);

        tag.src = src;
        tag.onload = function () { clearTimeout(timer); resolve(true); };
        tag.onerror = function () { clearTimeout(timer); tag.remove(); resolve(false); };

        document.head.appendChild(tag);

    });

}

function ensureXLSX() {

    if (typeof XLSX !== "undefined") return Promise.resolve(true);

    if (!xlsxLoadPromise) {

        xlsxLoadPromise = (async function () {

            const sources = [
                "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
                "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
                "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"
            ];

            for (let i = 0; i < sources.length; i++) {
                await loadScriptOnce(sources[i], 10000);
                if (typeof XLSX !== "undefined") return true;
            }

            return false;

        })().then(function (ok) {
            if (!ok) xlsxLoadPromise = null;
            return ok;
        });

    }

    return xlsxLoadPromise;

}

function guardedClick(handler) {

    let running = false;

    return function (event) {

        if (running) return;

        const button = event && event.currentTarget ? event.currentTarget : null;
        const originalText = button ? button.textContent : "";

        running = true;

        if (button) {
            button.disabled = true;
            button.textContent = "⏳ Please wait…";
        }

        Promise.resolve()
            .then(function () { return handler(event); })
            .catch(function (error) {
                console.error("Button action failed:", error);
                alert("❌ Something went wrong: " + (error && error.message ? error.message : error));
            })
            .finally(function () {
                running = false;
                if (button) {
                    button.disabled = false;
                    button.textContent = originalText;
                }
            });

    };

}

/* =========================================================
   INITIALIZE
   ========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    function () {

        initializeElements();

        attachAuthenticationEvents();

        attachApplicationEvents();

        createSubjectManager();

        initializeAcademicWorkflow();

        restoreAppData();

        createAutoCommentManager();

        loadSchoolInformation();

        restoreGeneratedReports();

        checkLogin();

    }
);


/* =========================================================
   INITIALIZE ELEMENTS
   ========================================================= */

function initializeElements() {

    authSection =
        document.getElementById(
            "authSection"
        );

    appSection =
        document.getElementById(
            "appSection"
        );

    subscriptionPlans =
        document.getElementById(
            "subscriptionPlans"
        );

    subscriptionStatus =
        document.getElementById(
            "subscriptionStatus"
        );

    emailInput =
        document.getElementById(
            "email"
        );

    passwordInput =
        document.getElementById(
            "password"
        );

    signUpButton =
        document.getElementById(
            "signUpButton"
        );

    signInButton =
        document.getElementById(
            "signInButton"
        );

    logoutButton =
        document.getElementById(
            "logoutButton"
        );

    authStatus =
        document.getElementById(
            "authStatus"
        );

    downloadTemplateButton =
        document.getElementById(
            "downloadTemplate"
        );

    excelFileInput =
        document.getElementById(
            "excelFile"
        );

    fileStatus =
        document.getElementById(
            "fileStatus"
        );

    classNameInput =
        document.getElementById(
            "classNameSelect"
        );

    newClassNameInput =
        document.getElementById(
            "newClassNameInput"
        );

    addClassButton =
        document.getElementById(
            "addClassButton"
        );

    classListContainer =
        document.getElementById(
            "classListContainer"
        );

    classManagerStatus =
        document.getElementById(
            "classManagerStatus"
        );

    subjectTemplateSelect =
        document.getElementById(
            "subjectTemplateSelect"
        );

    downloadSubjectTemplateButton =
        document.getElementById(
            "downloadSubjectTemplate"
        );

    subjectTemplateFileInput =
        document.getElementById(
            "subjectTemplateFile"
        );

    subjectTemplateStatus =
        document.getElementById(
            "subjectTemplateStatus"
        );

    reportSection =
        document.getElementById(
            "reportSection"
        );

    studentSelect =
        document.getElementById(
            "studentSelect"
        );

    generateReportButton =
        document.getElementById(
            "generateReport"
        );

    generateAllButton =
        document.getElementById(
            "generateAll"
        );

    if (generateAllButton) {
        generateAllButton.type = "button";
    }

    generateMasterSheetButton =
        document.getElementById(
            "generateMasterSheet"
        );

    if (generateMasterSheetButton) {
        generateMasterSheetButton.type = "button";
    }

    reportContainer =
        document.getElementById(
            "reportContainer"
        );

    publishResultsSection =
        document.getElementById(
            "publishResultsSection"
        );

    publishStudentSelect =
        document.getElementById(
            "publishStudentSelect"
        );

    publishSingleResultButton =
        document.getElementById(
            "publishSingleResult"
        );

    publishAllResultsButton =
        document.getElementById(
            "publishAllResults"
        );

    publishResultsStatus =
        document.getElementById(
            "publishResultsStatus"
        );

    publishedResultInfo =
        document.getElementById(
            "publishedResultInfo"
        );

  printReportButton =
    document.getElementById(
        "printReportButton"
    );


    schoolNameInput =
        document.getElementById(
            "schoolNameInput"
        );


    schoolAddressInput =
        document.getElementById(
            "schoolAddressInput"
        );


    schoolLogoInput =
        document.getElementById(
            "schoolLogoInput"
        );


    schoolLogoPreview =
        document.getElementById(
            "schoolLogoPreview"
        );


    removeSchoolLogoButton =
        document.getElementById(
            "removeSchoolLogo"
        );


    saveSchoolInformationButton =
        document.getElementById(
            "saveSchoolInformation"
        );


    schoolInformationStatus =
        document.getElementById(
            "schoolInformationStatus"
        );

}


/* =========================================================
   ELEMENT EXISTS
   ========================================================= */

function elementExists(element) {

    return (
        element !== null &&
        element !== undefined
    );

}


/* =========================================================
   SHOW LOGIN
   ========================================================= */

function showLogin() {

    if (
        elementExists(
            authSection
        )
    ) {

        authSection.style.display =
            "block";

    }

    if (
        elementExists(
            subscriptionPlans
        )
    ) {

        subscriptionPlans.style.display =
            "none";

    }

    if (
        elementExists(
            appSection
        )
    ) {

        appSection.style.display =
            "none";

    }

    if (
        elementExists(
            subscriptionStatus
        )
    ) {

        subscriptionStatus.style.display =
            "none";

    }

}


/* =========================================================
   SHOW SUBSCRIPTION
   ========================================================= */

function showSubscription() {

    if (
        elementExists(
            authSection
        )
    ) {

        authSection.style.display =
            "none";

    }

    if (
        elementExists(
            subscriptionPlans
        )
    ) {

        subscriptionPlans.style.display =
            "block";

    }

    if (
        elementExists(
            appSection
        )
    ) {

        appSection.style.display =
            "none";

    }

    if (
        elementExists(
            subscriptionStatus
        )
    ) {

        subscriptionStatus.style.display =
            "block";

    }

}


/* =========================================================
   SHOW APPLICATION
   ========================================================= */

function showApp() {

    if (
        elementExists(
            authSection
        )
    ) {

        authSection.style.display =
            "none";

    }


    if (
        elementExists(
            subscriptionPlans
        )
    ) {

        subscriptionPlans.style.display =
            "none";

    }


    if (
        elementExists(
            appSection
        )
    ) {

        appSection.style.display =
            "block";

    }


    if (
        elementExists(
            subscriptionStatus
        )
    ) {

        subscriptionStatus.style.display =
            "block";

    }


    /* =================================================
       CREATE RENEW / UPGRADE BUTTON
    ================================================= */

    let renewButton =
        document.getElementById(
            "renewUpgradeButton"
        );


    if (!renewButton) {

        renewButton =
            document.createElement(
                "button"
            );


        renewButton.id =
            "renewUpgradeButton";


        renewButton.type =
            "button";


        renewButton.innerHTML =
            "🔄 RENEW / UPGRADE SUBSCRIPTION";


        /* =================================================
           BUTTON STYLE
        ================================================= */

        renewButton.style.display =
            "block";

        renewButton.style.width =
            "100%";

        renewButton.style.margin =
            "20px 0";

        renewButton.style.padding =
            "18px";

        renewButton.style.border =
            "2px solid #ffffff";

        renewButton.style.borderRadius =
            "10px";

        renewButton.style.fontSize =
            "18px";

        renewButton.style.fontWeight =
            "bold";

        renewButton.style.cursor =
            "pointer";

        renewButton.style.boxShadow =
            "0 5px 15px rgba(0,0,0,0.25)";

        renewButton.style.backgroundColor =
            "#198754";

        renewButton.style.color =
            "#ffffff";


        /* =================================================
           BUTTON ACTION
        ================================================= */

        renewButton.addEventListener(
            "click",
            function () {

                if (
                    elementExists(
                        appSection
                    )
                ) {

                    appSection.style.display =
                        "none";

                }


                if (
                    elementExists(
                        subscriptionPlans
                    )
                ) {

                    subscriptionPlans.style.display =
                        "block";

                }


                if (
                    elementExists(
                        subscriptionPlans
                    )
                ) {

                    subscriptionPlans.scrollIntoView({

                        behavior:
                            "smooth",

                        block:
                            "start"

                    });

                }

            }
        );

    }


    /* =================================================
       PLACE BUTTON ABOVE THE APP
    ================================================= */

    if (
        elementExists(
            appSection
        ) &&
        renewButton.parentElement !==
            appSection
    ) {

        appSection.insertBefore(
            renewButton,
            appSection.firstChild
        );

    }

}
/* =========================================================
   AUTHENTICATION EVENTS
   ========================================================= */

function attachAuthenticationEvents() {


    /* =========================
       SIGN UP
       ========================= */

    if (
        elementExists(
            signUpButton
        )
    ) {

        signUpButton.addEventListener(
            "click",
            async function () {

                const email =
                    emailInput.value.trim();

                const password =
                    passwordInput.value;


                if (
                    !email ||
                    !password
                ) {

                    setAuthStatus(
                        "❌ Please enter your email and password."
                    );

                    return;

                }


                if (
                    password.length < 6
                ) {

                    setAuthStatus(
                        "❌ Password must contain at least 6 characters."
                    );

                    return;

                }


                setAuthStatus(
                    "Creating your account..."
                );


                try {

                    const {
                        data,
                        error
                    } =
                        await supabaseClient.auth
                            .signUp({

                                email:
                                    email,

                                password:
                                    password,

                                options: {

                                    emailRedirectTo:
                                        WEBSITE_URL

                                }

                            });


                    if (error) {

                        console.error(
                            "Sign up error:",
                            error
                        );

                        setAuthStatus(
                            "❌ " +
                            error.message
                        );

                        return;

                    }


                    if (
                        data.user &&
                        !data.session
                    ) {

                        setAuthStatus(
                            "✅ Account created. Please check your email and confirm your account before signing in."
                        );

                        return;

                    }


                    setAuthStatus(
                        "✅ Account created successfully."
                    );


                } catch (error) {

                    console.error(
                        error
                    );

                    setAuthStatus(
                        "❌ An unexpected error occurred."
                    );

                }

            }
        );

    }


    /* =========================
       SIGN IN
       ========================= */

    if (
        elementExists(
            signInButton
        )
    ) {

        signInButton.addEventListener(
            "click",
            async function () {

                const email =
                    emailInput.value.trim();

                const password =
                    passwordInput.value;


                if (
                    !email ||
                    !password
                ) {

                    setAuthStatus(
                        "❌ Please enter your email and password."
                    );

                    return;

                }


                setAuthStatus(
                    "Signing in..."
                );


                try {

                    const {
                        data,
                        error
                    } =
                        await supabaseClient.auth
                            .signInWithPassword({

                                email:
                                    email,

                                password:
                                    password

                            });


                    if (error) {

                        console.error(
                            "Sign in error:",
                            error
                        );

                        setAuthStatus(
                            "❌ " +
                            error.message
                        );

                        return;

                    }


                    setAuthStatus(
                        "✅ Login successful."
                    );


                    await checkLogin();


                } catch (error) {

                    console.error(
                        error
                    );

                    setAuthStatus(
                        "❌ Unable to sign in."
                    );

                }

            }
        );

    }


    /* =========================
       LOGOUT
       ========================= */

    if (
        elementExists(
            logoutButton
        )
    ) {

        logoutButton.addEventListener(
            "click",
            async function () {

                try {
                    clearFreeTrialExpiryTimer();

                    const {
                        error
                    } =
                        await supabaseClient.auth
                            .signOut();


                    if (error) {

                        console.error(
                            error
                        );

                        return;

                    }


                    students = [];

                    currentSubscriptionPlan =
                        "";

                    reportsGenerated =
                        0;

                    currentUserId =
                        null;


                    /* =========================
                       CLEAR LOCAL APP DATA
                       ========================= */

                    localStorage.removeItem(
                        STUDENT_DATA_STORAGE_KEY
                    );

                    localStorage.removeItem(
                        STUDENT_SUBJECTS_STORAGE_KEY
                    );

                    localStorage.removeItem(
                        REPORT_SETTINGS_STORAGE_KEY
                    );

                    clearGeneratedReports();


                    /* =========================
                       CLEAR INTERFACE
                       ========================= */

                    if (studentSelect) {

                        studentSelect.innerHTML =
                            "-- Select Student --";

                    }

                    if (reportContainer) {

                        reportContainer.innerHTML =
                            "";

                    }

                    if (reportSection) {

                        reportSection.style.display =
                            "none";

                    }


                    showLogin();


                    setAuthStatus(
                        "You have been logged out."
                    );


                } catch (error) {

                    console.error(
                        error
                    );

                }

            }
        );

    }

}


/* =========================================================
   FORGOT PASSWORD
   ========================================================= */

async function forgotPassword() {

    const email =
        prompt(
            "Enter the email address you used to create your account:"
        );


    if (!email) {
        return;
    }


    const cleanEmail =
        email.trim();


    if (!cleanEmail) {

        alert(
            "Please enter your email address."
        );

        return;

    }


    try {

        const {
            error
        } =
            await supabaseClient.auth
                .resetPasswordForEmail(
                    cleanEmail,
                    {

                        redirectTo:
                            WEBSITE_URL

                    }
                );


        if (error) {

            console.error(
                error
            );

            alert(
                "❌ " +
                error.message
            );

            return;

        }


        alert(
            "✅ Password reset email sent."
        );


    } catch (error) {

        console.error(
            error
        );

        alert(
            "❌ Unable to send password reset email."
        );

    }

}


/* =========================================================
   UPDATE PASSWORD
   ========================================================= */

async function updatePassword() {

    const newPasswordElement =
        document.getElementById(
            "newPassword"
        );

    const confirmPasswordElement =
        document.getElementById(
            "confirmNewPassword"
        );


    if (
        !newPasswordElement ||
        !confirmPasswordElement
    ) {

        alert(
            "Password fields could not be found."
        );

        return;

    }


    const newPassword =
        newPasswordElement.value;

    const confirmPassword =
        confirmPasswordElement.value;


    if (!newPassword) {

        alert(
            "Please enter a new password."
        );

        return;

    }


    if (
        newPassword !==
        confirmPassword
    ) {

        alert(
            "❌ The passwords do not match."
        );

        return;

    }


    if (
        newPassword.length < 6
    ) {

        alert(
            "❌ Password must be at least 6 characters."
        );

        return;

    }


    try {

        const {
            error
        } =
            await supabaseClient.auth
                .updateUser({

                    password:
                        newPassword

                });


        if (error) {

            console.error(
                error
            );

            alert(
                "❌ " +
                error.message
            );

            return;

        }


        alert(
            "✅ Password changed successfully."
        );


        const resetSection =
            document.getElementById(
                "resetPasswordSection"
            );


        if (resetSection) {

            resetSection.style.display =
                "none";

        }


        newPasswordElement.value =
            "";

        confirmPasswordElement.value =
            "";


    } catch (error) {

        console.error(
            error
        );

        alert(
            "❌ Unable to change password."
        );

    }

}


/* =========================================================
   AUTH STATUS
   ========================================================= */

function setAuthStatus(message) {

    if (
        elementExists(
            authStatus
        )
    ) {

        authStatus.innerHTML =
            message;

    }

}


/* =========================================================
   CHECK LOGIN
   ========================================================= */

let checkLoginPromise = null;

/* Several auth events can fire together (login, token refresh, tab
   focus). They now share one running check instead of stacking up
   duplicate database calls. */
function checkLogin() {

    if (!checkLoginPromise) {
        checkLoginPromise = runCheckLogin().finally(function () {
            checkLoginPromise = null;
        });
    }

    return checkLoginPromise;

}

async function runCheckLogin() {

    try {

        const {
            data,
            error
        } =
            await supabaseClient.auth
                .getSession();


        if (error) {

            console.error(
                error
            );

            showLogin();

            return;

        }


        if (!data.session) {

            clearFreeTrialExpiryTimer();

            currentSubscriptionPlan =
                "";

            reportsGenerated =
                0;

            currentUserId =
                null;

            schoolClasses =
                [];

            renderClassList();

            populateClassNameSelect();

            showLogin();

            return;

        }


        const user =
            data.session.user;


        currentUserId =
            user.id;


        await fetchSchoolClasses();


        await checkSubscription(
            user
        );


    } catch (error) {

        console.error(
            error
        );

        showLogin();

    }

}


/* =========================================================
   FREE 7-DAY / 10-REPORT TRIAL
   ========================================================= */

function clearFreeTrialExpiryTimer() {
    if (freeTrialExpiryTimer) {
        clearTimeout(freeTrialExpiryTimer);
        freeTrialExpiryTimer = null;
    }
}

function isFreeTrial(subscription = currentSubscription) {
    return String(
        subscription?.plan ||
        subscription?.subscription_plan ||
        subscription?.package ||
        ""
    ).trim().toLowerCase() === FREE_TRIAL_PLAN;
}

function scheduleFreeTrialExpiryCheck(subscription) {
    clearFreeTrialExpiryTimer();

    if (!subscription || !isFreeTrial(subscription)) return;

    const expiryTime = new Date(subscription.expires_at).getTime();
    if (!Number.isFinite(expiryTime)) return;

    const delay = Math.max(expiryTime - Date.now() + 1000, 1000);

    freeTrialExpiryTimer = setTimeout(function () {
        freeTrialExpiryTimer = null;
        checkLogin();
    }, Math.min(delay, 2147483647));
}

/* =========================================================
   CHECK SUBSCRIPTION
   ========================================================= */

async function checkSubscription(user) {

    try {

        console.log(
            "Checking subscription:",
            {
                user_id: user.id,
                website_id: WEBSITE_ID
            }
        );


        const {
            data: subscription,
            error
        } =
            await supabaseClient
                .from("subscriptions")
                .select("*")
                .eq("user_id", user.id)
                .eq("website_id", WEBSITE_ID)
                .order("created_at", {
                    ascending: false
                })
                .limit(1)
                .maybeSingle();


        /* =================================================
           DATABASE ERROR
        ================================================= */

        if (error) {

            console.error(
                "Subscription database error:",
                error
            );

            currentSubscriptionPlan = "";
            reportsGenerated = 0;

            displaySubscriptionStatus(
                null,
                user
            );

            showSubscription();

            return;

        }


        /* =================================================
           RESET VALUES
        ================================================= */

        currentSubscriptionPlan = "";
        reportsGenerated = 0;
         currentSubscription = null;


        /* =================================================
           NO SUBSCRIPTION FOR THIS WEBSITE
        ================================================= */

        if (!subscription) {

            /*
               Brand-new users receive their free trial automatically from
               the Supabase auth.users trigger. The browser only READS the
               subscription here; it never inserts a subscription row.

               Existing accounts without a subscription remain behind the
               normal paid-subscription gate.
            */
            clearFreeTrialExpiryTimer();

            console.log(
                "No subscription found for website:",
                WEBSITE_ID
            );

            displaySubscriptionStatus(
                null,
                user
            );

            showSubscription();
            return;

        }

      /* =================================================
   STORE CURRENT SUBSCRIPTION
   ================================================= */

currentSubscription =
    subscription;


        /* =================================================
           READ PLAN
        ================================================= */

        currentSubscriptionPlan =
            String(

                subscription.plan ||

                subscription.subscription_plan ||

                subscription.package ||

                ""

            )
                .trim()
                .toLowerCase();

        if (currentSubscriptionPlan === FREE_TRIAL_PLAN) {
            scheduleFreeTrialExpiryCheck(subscription);
        } else {
            clearFreeTrialExpiryTimer();
        }


        /* =================================================
           READ REPORT COUNT
        ================================================= */

        reportsGenerated =
            Number(
                subscription.reports_generated
            ) || 0;


        /* Prevent legacy restored reports from being charged again. */
        migrateLegacyGeneratedReportsToLedger();


        /* =================================================
           READ STATUS
        ================================================= */

        const subscriptionStatusValue =
            String(
                subscription.status ||
                ""
            )
                .trim()
                .toLowerCase();


        /* =================================================
           CHECK EXPIRATION
        ================================================= */

        let subscriptionIsActive = false;


        if (
            subscription.expires_at
        ) {

            const expiryDate =
                new Date(
                    subscription.expires_at
                );


            const now =
                new Date();


            if (

                !isNaN(
                    expiryDate.getTime()
                ) &&

                expiryDate > now

            ) {

                subscriptionIsActive = true;

            }

        }


        /* =================================================
           ACCEPT VALID PAID STATUS VALUES
        ================================================= */

        const validPaidStatuses = [

            "paid",
            "active",
            "success",
            "successful",
            "completed"

        ];


        const paymentStatusIsValid =
            validPaidStatuses.includes(
                subscriptionStatusValue
            );

        const trialStatusIsValid =
            currentSubscriptionPlan === FREE_TRIAL_PLAN &&
            subscriptionStatusValue === FREE_TRIAL_STATUS;

        const subscriptionStatusIsValid =
            paymentStatusIsValid || trialStatusIsValid;


        /* =================================================
           DISPLAY STATUS
        ================================================= */

        displaySubscriptionStatus(
            subscription,
            user
        );


        /* =================================================
           FINAL ACCESS CHECK
        ================================================= */

        if (

            subscriptionStatusIsValid &&

            subscriptionIsActive &&

            currentSubscriptionPlan &&

            REPORT_LIMITS[
                currentSubscriptionPlan
            ]

        ) {

            console.log(
                "ACTIVE SUBSCRIPTION:",
                {
                    website_id:
                        WEBSITE_ID,

                    plan:
                        currentSubscriptionPlan,

                    status:
                        subscriptionStatusValue,

                    expires_at:
                        subscription.expires_at
                }
            );


            showApp();

            updateReportStatus();

            return;

        }


        /* =================================================
           SUBSCRIPTION NOT ACTIVE
        ================================================= */

        console.log(
            "Subscription is not active:",
            {
                website_id:
                    WEBSITE_ID,

                status:
                    subscriptionStatusValue,

                plan:
                    currentSubscriptionPlan,

                expires_at:
                    subscription.expires_at,

                paymentStatusIsValid:
                    paymentStatusIsValid,

                subscriptionIsActive:
                    subscriptionIsActive,

                planExists:
                    !!REPORT_LIMITS[
                        currentSubscriptionPlan
                    ]
            }
        );


        showSubscription();


    } catch (error) {

        console.error(
            "Subscription check failed:",
            error
        );

        currentSubscriptionPlan = "";
        reportsGenerated = 0;

        showSubscription();

    }

}

/* =========================================================
   AUTH STATE
   ========================================================= */

supabaseClient.auth.onAuthStateChange(
    function (event, session) {

        /* Token refreshes and tab-focus SIGNED_IN events for the user who
           is already loaded do not need a full reload of classes and
           subscription. Startup is covered by checkLogin() in DOMContentLoaded. */
        if (event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") {
            return;
        }

        if (
            event === "SIGNED_IN" &&
            session && session.user &&
            session.user.id === currentUserId
        ) {
            return;
        }

        setTimeout(
            function () {

                checkLogin();

            },
            0
        );

    }
);


/* =========================================================
   PASSWORD RECOVERY
   ========================================================= */

supabaseClient.auth.onAuthStateChange(
    function (event) {

        if (
            event ===
            "PASSWORD_RECOVERY"
        ) {

            const resetSection =
                document.getElementById(
                    "resetPasswordSection"
                );


            if (resetSection) {

                resetSection.style.display =
                    "block";

            }

        }

    }
);


/* =========================================================
   DISPLAY SUBSCRIPTION
   ========================================================= */

function displaySubscriptionStatus(
    subscription,
    user
) {

    if (
        !elementExists(
            subscriptionStatus
        )
    ) {

        return;

    }


    subscriptionStatus.style.display =
        "block";


    /* =================================================
       REMOVE OLD RENEW BUTTON
    ================================================= */

    const oldRenewButton =
        document.getElementById(
            "renewUpgradeButton"
        );


    if (oldRenewButton) {

        oldRenewButton.remove();

    }


    /* =================================================
       NO SUBSCRIPTION
    ================================================= */

    if (!subscription) {

        subscriptionStatus.innerHTML = `

            <strong>
                Subscription Status:
            </strong>

            <span style="color:red;">
                UNPAID
            </span>

            <br>

            Account:
            ${escapeHTML(
                user?.email || ""
            )}

            <br><br>

            Please choose a subscription plan
            to access the Student Report Generator.

        `;

        return;

    }


    /* =================================================
       PLAN
    ================================================= */

    const plan =
        String(

            subscription.plan ||

            subscription.subscription_plan ||

            subscription.package ||

            ""

        )
            .trim()
            .toLowerCase();


    /* =================================================
       STATUS
    ================================================= */

    const status =
        String(
            subscription.status ||
            ""
        )
            .trim()
            .toLowerCase();


    /* =================================================
       EXPIRY
    ================================================= */

    let expiryDate =
        null;

    let expiryText =
        "Unknown";


    if (
        subscription.expires_at
    ) {

        expiryDate =
            new Date(
                subscription.expires_at
            );


        if (
            !isNaN(
                expiryDate.getTime()
            )
        ) {

            expiryText =
                expiryDate.toLocaleDateString();

        }

    }


    /* =================================================
       ACTIVE STATUS
    ================================================= */

    const validPaidStatuses = [

        "paid",
        "active",
        "success",
        "successful",
        "completed"

    ];


    const statusIsPaid =
        validPaidStatuses.includes(
            status
        );

    const statusIsTrial =
        plan === FREE_TRIAL_PLAN &&
        status === FREE_TRIAL_STATUS;

    const statusIsValid =
        statusIsPaid || statusIsTrial;


    const isExpired =
        !expiryDate ||
        isNaN(
            expiryDate.getTime()
        ) ||
        expiryDate <= new Date();


    const isActive =
        statusIsValid &&
        !isExpired;


    /* =================================================
       REPORT LIMIT
    ================================================= */

    const limit =
        REPORT_LIMITS[plan] ||
        0;


    const generated =
        Number(
            subscription.reports_generated
        ) || 0;


    /* =================================================
       CARRY-OVER REPORTS
    ================================================= */

    const carriedOver =
        Number(
            subscription.carried_over_reports
        ) || 0;


    /* =================================================
       TOTAL AVAILABLE REPORTS
    ================================================= */

    const totalAvailable =
        limit +
        carriedOver;


    /* =================================================
       REPORTS REMAINING
    ================================================= */

    const remaining =
        Math.max(
            totalAvailable -
            generated,
            0
        );


    /* =================================================
       ACTIVE SUBSCRIPTION
    ================================================= */

    if (isActive) {

        const trialRemaining = isFreeTrial(subscription)
            ? Math.max(totalAvailable - generated, 0)
            : 0;

        const trialNotice = isFreeTrial(subscription)
            ? `
                <br>
                <strong>Free Trial:</strong> 10 reports for 7 days
                <br>
                <strong>Trial Reports Remaining:</strong> ${trialRemaining}
              `
            : "";

        subscriptionStatus.innerHTML = `

            <strong>
                Subscription Status:
            </strong>

            <span style="color:green;">
                ${isFreeTrial(subscription) ? "FREE TRIAL / ACTIVE" : "PAID / ACTIVE"}
            </span>

            <br>

            <strong>
                Plan:
            </strong>

            ${escapeHTML(
                getPlanDisplayNameFromPlan(
                    plan
                )
            )}

            <br>

            <strong>
                Account:
            </strong>

            ${escapeHTML(
                user?.email || ""
            )}

            <br>

            <strong>
                Expires:
            </strong>

            ${escapeHTML(
                expiryText
            )}

            ${trialNotice}

            ${
                limit
                    ? `

                        <br>

                        <strong>
                            Reports Generated:
                        </strong>

                        ${generated}

                        /

                        ${formatReportCount(totalAvailable)}

                        <br>

                        <strong>
                            New Plan Reports:
                        </strong>

                        ${formatReportCount(limit)}

                        <br>

                        <strong>
                            Carried-over Reports:
                        </strong>

                        ${carriedOver}

                        <br>

                        <strong>
                            Reports Remaining:
                        </strong>

                        ${formatReportCount(remaining)}

                    `
                    : ""
            }

        `;


        /* =================================================
           ADD RENEW / UPGRADE BUTTON
        ================================================= */

        


        return;

    }


    /* =================================================
       EXPIRED FREE TRIAL
    ================================================= */

    if (statusIsTrial && isExpired) {
        subscriptionStatus.innerHTML = `
            <strong>Subscription Status:</strong>
            <span style="color:red;">FREE TRIAL EXPIRED</span>
            <br>
            <strong>Trial allowance:</strong>
            ${generated} / ${FREE_TRIAL_REPORTS} reports used
            <br>
            <strong>Expired:</strong> ${escapeHTML(expiryText)}
            <br><br>
            Your free 7-day trial has ended. Please renew or choose a paid
            subscription to continue using the system.
        `;
        showSubscription();
        return;
    }

    /* =================================================
       EXPIRED
    ================================================= */

    if (
        statusIsPaid &&
        isExpired
    ) {

        subscriptionStatus.innerHTML = `

            <strong>
                Subscription Status:
            </strong>

            <span style="color:red;">
                EXPIRED
            </span>

            <br>

            <strong>
                Plan:
            </strong>

            ${escapeHTML(
                getPlanDisplayNameFromPlan(
                    plan
                )
            )}

            <br>

            <strong>
                Expired:
            </strong>

            ${escapeHTML(
                expiryText
            )}

            <br><br>

            Please renew your subscription
            to continue using the system.

        `;

    

    return;

    }


    /* =================================================
       UNPAID / INVALID
    ================================================= */

    subscriptionStatus.innerHTML = `

        <strong>
            Subscription Status:
        </strong>

        <span style="color:red;">
            UNPAID
        </span>

        <br>

        Account:
        ${escapeHTML(
            user?.email || ""
        )}

        <br><br>

        Please choose a subscription plan.

    `;

}



/* =========================================================
   GET PLAN DISPLAY NAME
   ========================================================= */

function getPlanDisplayNameFromPlan(
    plan
) {

    const cleanPlan =
        String(
            plan || ""
        )
            .trim()
            .toLowerCase();


    if (
        cleanPlan ===
        "basic"
    ) {

        return "BASIC";

    }


    if (
        cleanPlan ===
        "standard"
    ) {

        return "STANDARD";

    }


    if (
        cleanPlan ===
        "premium"
    ) {

        return "PREMIUM";

    }


    if (
        cleanPlan ===
        "unlimited"
    ) {

        return "UNLIMITED";

    }


    if (
        cleanPlan ===
        FREE_TRIAL_PLAN
    ) {

        return "FREE 7-DAY TRIAL";

    }


    return "UNKNOWN";

}


/* =========================================================
   SCHOOL INFORMATION
   ========================================================= */

function loadSchoolInformation() {

    if (
        schoolNameInput
    ) {

        schoolNameInput.value =
            reportSettings.schoolName ||
            "";

    }


    if (
        schoolAddressInput
    ) {

        schoolAddressInput.value =
            reportSettings.schoolAddress ||
            "";

    }


    displaySchoolLogoPreview();

}


/* =========================================================
   SAVE SCHOOL INFORMATION
   ========================================================= */

function saveSchoolInformation() {

    const schoolName =
        schoolNameInput
            ? schoolNameInput.value.trim()
            : "";

    const schoolAddress =
        schoolAddressInput
            ? schoolAddressInput.value.trim()
            : "";


    reportSettings.schoolName =
        schoolName ||
        "YOUR SCHOOL NAME";


    reportSettings.schoolAddress =
        schoolAddress ||
        "YOUR SCHOOL ADDRESS";


    saveAppData();


    if (
        schoolInformationStatus
    ) {

        schoolInformationStatus.textContent =
            "✓ School information saved successfully.";

    }


    setTimeout(
        function () {

            if (
                schoolInformationStatus
            ) {

                schoolInformationStatus.textContent =
                    "";

            }

        },
        3000
    );

}


/* =========================================================
   SCHOOL LOGO UPLOAD
   ========================================================= */

function handleSchoolLogoUpload(event) {

    const file =
        event.target.files &&
        event.target.files[0];


    if (!file) {

        return;

    }


    const allowedTypes = [

        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp"

    ];


    if (
        !allowedTypes.includes(
            file.type
        )
    ) {

        alert(
            "Please select a PNG, JPG or WEBP image."
        );

        event.target.value =
            "";

        return;

    }


    if (
        file.size >
        2 * 1024 * 1024
    ) {

        alert(
            "Please choose a logo smaller than 2 MB."
        );

        event.target.value =
            "";

        return;

    }


    const reader =
        new FileReader();


    reader.onload =
        function () {

            reportSettings.schoolLogo =
                reader.result;


            saveAppData();


            displaySchoolLogoPreview();


            if (
                schoolInformationStatus
            ) {

                schoolInformationStatus.textContent =
                    "✓ School logo uploaded.";

            }

        };


    reader.onerror =
        function () {

            alert(
                "Unable to read the school logo."
            );

        };


    reader.readAsDataURL(
        file
    );

}


/* =========================================================
   DISPLAY SCHOOL LOGO PREVIEW
   ========================================================= */

function displaySchoolLogoPreview() {

    if (
        !schoolLogoPreview
    ) {

        return;

    }


    if (
        !reportSettings.schoolLogo
    ) {

        schoolLogoPreview.innerHTML =
            "";


        if (
            removeSchoolLogoButton
        ) {

            removeSchoolLogoButton.style.display =
                "none";

        }

        return;

    }


    schoolLogoPreview.innerHTML = `

        <div
            style="
                display:flex;
                flex-direction:column;
                align-items:flex-start;
                gap:8px;
            "
        >

            <strong>
                Current Logo:
            </strong>

            <img
                src="${reportSettings.schoolLogo}"
                alt="School Logo"
                style="
                    width:120px;
                    height:120px;
                    object-fit:contain;
                    border:1px solid #ccc;
                    padding:5px;
                    background:#fff;
                    border-radius:6px;
                "
            >

        </div>

    `;


    if (
        removeSchoolLogoButton
    ) {

        removeSchoolLogoButton.style.display =
            "inline-block";

    }

}


/* =========================================================
   REMOVE SCHOOL LOGO
   ========================================================= */

function removeSchoolLogo() {

    reportSettings.schoolLogo =
        "";


    saveAppData();


    if (
        schoolLogoInput
    ) {

        schoolLogoInput.value =
            "";

    }


    displaySchoolLogoPreview();


    if (
        schoolInformationStatus
    ) {

        schoolInformationStatus.textContent =
            "School logo removed.";

    }

}


/* =========================================================
   APPLICATION EVENTS
   ========================================================= */

function attachApplicationEvents() {

   /* Safety net: delegated click handler for all download buttons.
   Runs in capture phase so it fires even if the button's own
   listener was lost or the button has default type="submit". */
document.addEventListener("click", async function (event) {
    const target = event.target && event.target.closest
        ? event.target.closest("#downloadTemplate, #downloadSubjectTemplate, #downloadClassListTemplate, #downloadCumulativeButton")
        : null;

    if (!target) return;

    event.preventDefault();
    event.stopPropagation();

    if (target.disabled) return;

    console.log("Download button tapped:", target.id);

    target.disabled = true;
    const originalText = target.textContent;
    target.textContent = "⏳ Please wait…";

    try {
        if (target.id === "downloadTemplate") {
            await downloadExcelTemplate();
        } else if (target.id === "downloadSubjectTemplate") {
            await downloadSubjectTemplate();
        } else if (target.id === "downloadClassListTemplate") {
            await downloadClassListTemplate();
        } else if (target.id === "downloadCumulativeButton") {
            await downloadCumulativeWorkbook();
        }
        console.log("Download OK:", target.id);
    } catch (error) {
        console.error("Download failed:", error);
        alert("❌ Download failed:\n\n" + (error && error.message ? error.message : error));
    } finally {
        target.disabled = false;
        target.textContent = originalText;
    }
}, true);
    
    if (elementExists(printReportButton)) {
    printReportButton.addEventListener(
        "click",
        function () {
            window.print();
        }
    );
}


    if (
        elementExists(
            downloadTemplateButton
        )
    ) {

        downloadTemplateButton.addEventListener(
            "click",
            guardedClick(downloadExcelTemplate)
        );

    }


    if (
        elementExists(
            excelFileInput
        )
    ) {

        excelFileInput.addEventListener(
            "change",
            handleExcelUpload
        );

    }


    if (
        elementExists(
            generateReportButton
        )
    ) {

        generateReportButton.addEventListener(
            "click",
            generateSingleReport
        );

    }

    if (elementExists(publishSingleResultButton)) {
        publishSingleResultButton.addEventListener(
            "click",
            publishSelectedResult
        );
    }

    if (elementExists(publishAllResultsButton)) {
        publishAllResultsButton.addEventListener(
            "click",
            publishAllResults
        );
    }

  const backToAppButton = document.getElementById("backToAppButton");

if (backToAppButton) {
    backToAppButton.addEventListener("click", () => {
        document.getElementById("subscriptionPlans").style.display = "none";
        document.getElementById("appSection").style.display = "block";
    });
}


    if (
        elementExists(
            downloadSubjectTemplateButton
        )
    ) {

        downloadSubjectTemplateButton.addEventListener(
            "click",
            guardedClick(downloadSubjectTemplate)
        );

    }


    if (
        elementExists(
            subjectTemplateFileInput
        )
    ) {

        subjectTemplateFileInput.addEventListener(
            "change",
            handleSubjectTemplateUpload
        );

    }


    if (
        elementExists(
            addClassButton
        )
    ) {

        addClassButton.addEventListener(
            "click",
            async function () {

                const name =
                    elementExists(newClassNameInput)
                        ? newClassNameInput.value
                        : "";

                const added = await addSchoolClass(name);

                if (added && elementExists(newClassNameInput)) {
                    newClassNameInput.value = "";
                }

            }
        );

    }


    if (
        elementExists(
            classListContainer
        )
    ) {

        classListContainer.addEventListener(
            "click",
            function (event) {

                const button = event.target.closest(
                    "[data-remove-class-id]"
                );

                if (!button) return;

                deleteSchoolClass(
                    button.getAttribute("data-remove-class-id"),
                    button.getAttribute("data-remove-class-name")
                );

            }
        );

    }


    /* =====================================================
       GENERATE ALL BUTTON

       Use delegated click handling so the button still works if
       the application UI recreates or inserts it after startup.
       Prevent the default form action so a button inside a form
       cannot silently submit/reload the page instead of generating.
       ===================================================== */
    document.addEventListener(
        "click",
        function (event) {
            const target = event.target &&
                event.target.closest
                    ? event.target.closest("#generateAll")
                    : null;

            if (!target) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (target.disabled) {
                return;
            }

            target.disabled = true;

            Promise.resolve(
                generateAllReports()
            ).catch(function (error) {
                console.error(
                    "Generate All error:",
                    error
                );

                alert(
                    "❌ Generate All could not be completed.\n\n" +
                    (error && error.message
                        ? error.message
                        : String(error))
                );
            }).finally(function () {
                target.disabled = false;
            });
        },
        true
    );


    /* =====================================================
       GENERATE MASTER SHEET BUTTON

       Same delegated-click pattern as Generate All above.
       ===================================================== */
    document.addEventListener(
        "click",
        function (event) {
            const target = event.target &&
                event.target.closest
                    ? event.target.closest("#generateMasterSheet")
                    : null;

            if (!target) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            if (target.disabled) {
                return;
            }

            target.disabled = true;

            Promise.resolve(
                generateMasterSheet()
            ).catch(function (error) {
                console.error(
                    "Generate Master Sheet error:",
                    error
                );

                alert(
                    "❌ Generate Master Sheet could not be completed.\n\n" +
                    (error && error.message
                        ? error.message
                        : String(error))
                );
            }).finally(function () {
                target.disabled = false;
            });
        },
        true
    );


    /* =====================================================
       SCHOOL INFORMATION EVENTS
       ===================================================== */

    if (
        elementExists(
            saveSchoolInformationButton
        )
    ) {

        saveSchoolInformationButton.addEventListener(
            "click",
            saveSchoolInformation
        );

    }


    if (
        elementExists(
            schoolLogoInput
        )
    ) {

        schoolLogoInput.addEventListener(
            "change",
            handleSchoolLogoUpload
        );

    }


    if (
        elementExists(
            removeSchoolLogoButton
        )
    ) {

        removeSchoolLogoButton.addEventListener(
            "click",
            removeSchoolLogo
        );

    }


    attachPaystackButtons();

}


/* =========================================================
   SUBJECT MANAGER
   ========================================================= */

function createSubjectManager() {

    if (
        !elementExists(
            appSection
        )
    ) {

        return;

    }


    const existing =
        document.getElementById(
            "subjectManager"
        );


    if (existing) {

        return;

    }


    const manager =
        document.createElement(
            "section"
        );


    manager.id =
        "subjectManager";


    manager.className =
        "card";


    manager.innerHTML = `

        <h2>
            School Subjects
        </h2>

        <p>
            Add or remove subjects before downloading
            the Excel template.
        </p>

        <div id="subjectList"></div>

        <div style="margin-top:10px;">

            <input
                type="text"
                id="newSubjectInput"
                placeholder="Enter subject name"
            >

            <button
                type="button"
                id="addSubjectButton"
            >
                Add Subject
            </button>

        </div>

    `;


    const firstCard =
        appSection.querySelector(
            ".card"
        );


    if (firstCard) {

        firstCard.parentNode.insertBefore(
            manager,
            firstCard
        );

    } else {

        appSection.prepend(
            manager
        );

    }


    renderSubjectList();


    const addButton =
        document.getElementById(
            "addSubjectButton"
        );


    const input =
        document.getElementById(
            "newSubjectInput"
        );


    if (addButton) {

        addButton.addEventListener(
            "click",
            function () {

                const subject =
                    input.value.trim();


                if (!subject) {

                    alert(
                        "Please enter a subject name."
                    );

                    return;

                }


                addSubject(
                    subject
                );


                input.value =
                    "";

            }
        );

    }

}


/* =========================================================
   RENDER SUBJECT LIST
   ========================================================= */

function renderSubjectList() {

    const list =
        document.getElementById(
            "subjectList"
        );


    if (!list) {

        return;

    }


    list.innerHTML =
        "";


    schoolSubjects.forEach(
        function (
            subject,
            index
        ) {

            const item =
                document.createElement(
                    "div"
                );


            item.style.display =
                "flex";

            item.style.alignItems =
                "center";

            item.style.gap =
                "8px";

            item.style.marginBottom =
                "6px";


            item.innerHTML = `

                <input
                    type="text"
                    value="${escapeHTML(subject)}"
                    data-subject-index="${index}"
                    class="subject-name-input"
                    style="flex:1;"
                >

                <button
                    type="button"
                    data-remove-subject="${index}"
                >
                    Remove
                </button>

            `;


            list.appendChild(
                item
            );

        }
    );


    list.querySelectorAll(
        ".subject-name-input"
    )
        .forEach(
            function (input) {

                input.addEventListener(
                    "change",
                    function () {

                        const index =
                            Number(
                                input.dataset
                                    .subjectIndex
                            );


                        const newName =
                            input.value.trim();


                        if (!newName) {

                            alert(
                                "Subject name cannot be empty."
                            );

                            renderSubjectList();

                            return;

                        }


                        const duplicate =
                            schoolSubjects.some(
                                function (
                                    subject,
                                    subjectIndex
                                ) {

                                    return (

                                        subjectIndex !==
                                        index &&

                                        subject.toLowerCase() ===
                                        newName.toLowerCase()

                                    );

                                }
                            );


                        if (duplicate) {

                            alert(
                                "This subject already exists."
                            );

                            renderSubjectList();

                            return;

                        }


                        schoolSubjects[index] =
                            newName;


                        saveAppData();

                    }
                );

            }
        );


    list.querySelectorAll(
        "[data-remove-subject]"
    )
        .forEach(
            function (button) {

                button.addEventListener(
                    "click",
                    function () {

                        const index =
                            Number(
                                button.dataset
                                    .removeSubject
                            );


                        schoolSubjects.splice(
                            index,
                            1
                        );


                        renderSubjectList();

                        saveAppData();

                    }
                );

            }
        );

    populateSubjectTemplateSelect();

}


/* =========================================================
   ACADEMIC CONTEXT  (Session + Term + Class)

   Step 1A sets the working context. Everything else follows it:
     - the master class list belongs to  Class + Session
       (the same students carry through First/Second/Third Term)
     - subject scores belong to          Class + Session + Term
       so switching to Third Term loads Third Term data and never
       overwrites First or Second Term.
   ========================================================= */

const CLASS_ROSTER_TABLE = "class_students";
const ACADEMIC_TERMS = ["First Term", "Second Term", "Third Term"];
const ACADEMIC_CONTEXT_STORAGE_KEY = "reportgen1_academic_context";

let academicSessionSelect;
let academicTermSelect;
let downloadClassListTemplateButton;
let classListFileInput;
let uploadClassListButton;
let rosterStatus;
let studentPreviewContainer;
let cumulativeStudentSelect;
let showCumulativeButton;
let downloadCumulativeButton;
let cumulativeStatus;
let cumulativeResult;

let classRoster = [];
let rosterFetchFailed = false;
let cumulativeModel = null;

function defaultAcademicSession() {
    const now = new Date();
    const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    return startYear + "/" + (startYear + 1);
}

function buildSessionOptions(selected) {

    if (!elementExists(academicSessionSelect)) return;

    const defaultStart = Number(defaultAcademicSession().split("/")[0]);
    const sessions = [];

    for (let year = defaultStart - 3; year <= defaultStart + 1; year++) {
        sessions.push(year + "/" + (year + 1));
    }

    if (selected && sessions.indexOf(selected) === -1) sessions.push(selected);

    academicSessionSelect.innerHTML = "";

    sessions.forEach(function (session) {
        const option = document.createElement("option");
        option.value = session;
        option.textContent = session;
        academicSessionSelect.appendChild(option);
    });

    academicSessionSelect.value = selected || defaultAcademicSession();

}

function getSelectedSession() {
    return elementExists(academicSessionSelect)
        ? String(academicSessionSelect.value || "").trim()
        : "";
}

function getSelectedTerm() {
    return elementExists(academicTermSelect)
        ? String(academicTermSelect.value || "").trim()
        : "";
}

/* Returns { className, session, term } or null (with an alert) when
   the teacher has not chosen everything yet. */
function getWorkflowContext(required) {

    const className = getActiveClassName(false);
    const session = getSelectedSession();
    const term = getSelectedTerm();

    if (required && (!className || !session || !term)) {
        alert("Please select the Academic Session, Term and Class in Step 1A first.");
        return null;
    }

    return { className: className, session: session, term: term };

}

function contextLabel(context, includeTerm) {

    if (!context || !context.className) {
        return "Select the Academic Session, Term and Class in Step 1A";
    }

    const parts = [context.className, context.session];
    if (includeTerm !== false) parts.push(context.term);

    return parts.join(" | ");

}

function updateContextBanners() {

    const context = getWorkflowContext(false);

    document.querySelectorAll(".context-banner").forEach(function (banner) {
        const annual = banner.getAttribute("data-context") === "annual";
        banner.textContent = contextLabel(context, !annual);
    });

}

function saveAcademicContext() {
    try {
        localStorage.setItem(
            ACADEMIC_CONTEXT_STORAGE_KEY,
            JSON.stringify({
                session: getSelectedSession(),
                term: getSelectedTerm(),
                className: getActiveClassName(false)
            })
        );
    } catch (error) {
        console.error("Unable to save academic context:", error);
    }
}

/* Runs whenever Session, Term or Class changes (and after the class
   list of Step 0 is (re)loaded). */
function onClassContextChanged() {
    updateContextBanners();
    saveAcademicContext();
    loadClassRosterForContext();
    resetCumulativeView();
}

function initializeAcademicWorkflow() {

    academicSessionSelect = document.getElementById("academicSessionSelect");
    academicTermSelect = document.getElementById("academicTermSelect");
    downloadClassListTemplateButton = document.getElementById("downloadClassListTemplate");
    classListFileInput = document.getElementById("classListFile");
    uploadClassListButton = document.getElementById("uploadClassListButton");
    rosterStatus = document.getElementById("rosterStatus");
    studentPreviewContainer = document.getElementById("studentPreviewContainer");
    cumulativeStudentSelect = document.getElementById("cumulativeStudentSelect");
    showCumulativeButton = document.getElementById("showCumulativeButton");
    downloadCumulativeButton = document.getElementById("downloadCumulativeButton");
    cumulativeStatus = document.getElementById("cumulativeStatus");
    cumulativeResult = document.getElementById("cumulativeResult");

    let saved = {};
    try {
        saved = JSON.parse(localStorage.getItem(ACADEMIC_CONTEXT_STORAGE_KEY) || "{}") || {};
    } catch (error) {
        saved = {};
    }

    buildSessionOptions(saved.session);

    if (elementExists(academicTermSelect)) {
        academicTermSelect.innerHTML = "";
        ACADEMIC_TERMS.forEach(function (term) {
            const option = document.createElement("option");
            option.value = term;
            option.textContent = term;
            academicTermSelect.appendChild(option);
        });
        academicTermSelect.value =
            ACADEMIC_TERMS.indexOf(saved.term) !== -1 ? saved.term : ACADEMIC_TERMS[0];
    }

    [academicSessionSelect, academicTermSelect, classNameInput].forEach(function (select) {
        if (elementExists(select)) select.addEventListener("change", onClassContextChanged);
    });

    if (elementExists(downloadClassListTemplateButton)) {
        downloadClassListTemplateButton.addEventListener("click", guardedClick(downloadClassListTemplate));
    }

    if (elementExists(classListFileInput)) {
        classListFileInput.addEventListener("change", function () {
            const file = classListFileInput.files && classListFileInput.files[0];
            setRosterStatus(
                file
                    ? "📄 Selected: " + file.name + ". Click \"Upload Class List\" to save it."
                    : ""
            );
        });
    }

    if (elementExists(uploadClassListButton)) {
        uploadClassListButton.addEventListener("click", handleClassListUploadButton);
    }

    if (elementExists(showCumulativeButton)) {
        showCumulativeButton.addEventListener("click", showCumulativePerformance);
    }

    if (elementExists(downloadCumulativeButton)) {
        downloadCumulativeButton.addEventListener("click", guardedClick(downloadCumulativeWorkbook));
    }

    const cumulativeReportOneButton = document.getElementById("generateCumulativeReportButton");
    const cumulativeReportAllButton = document.getElementById("generateAllCumulativeReportsButton");

    if (elementExists(cumulativeReportOneButton)) {
        cumulativeReportOneButton.addEventListener("click", function () {
            generateCumulativeReports("one");
        });
    }

    if (elementExists(cumulativeReportAllButton)) {
        cumulativeReportAllButton.addEventListener("click", function () {
            generateCumulativeReports("all");
        });
    }

    if (elementExists(cumulativeStudentSelect)) {
        cumulativeStudentSelect.addEventListener("change", renderCumulativeStudent);
    }

    updateContextBanners();

}

/* Remember the last class after Step 0's list has loaded. */
function restoreSavedClassSelection() {

    if (!elementExists(classNameInput) || classNameInput.value) return;

    try {
        const saved = JSON.parse(localStorage.getItem(ACADEMIC_CONTEXT_STORAGE_KEY) || "{}") || {};
        const exists = schoolClasses.some(function (schoolClass) {
            return schoolClass.class_name === saved.className;
        });
        if (exists) classNameInput.value = saved.className;
    } catch (error) {
        /* ignore */
    }

}


/* =========================================================
   NOTIFICATIONS  (pop-up at the top of the screen)
   ========================================================= */
function showRosterNotification(message, isError) {

    let box = document.getElementById("rosterNotification");

    if (!box) {

        box = document.createElement("div");
        box.id = "rosterNotification";
        box.setAttribute("role", "status");
        box.setAttribute("aria-live", "polite");
        box.style.cssText =
            "position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
            "z-index:100000;max-width:90vw;width:420px;padding:14px 40px 14px 16px;" +
            "border-radius:10px;font-weight:600;font-size:15px;line-height:1.4;" +
            "box-shadow:0 6px 24px rgba(0,0,0,.25);color:#fff;display:none;";

        const text = document.createElement("span");
        text.id = "rosterNotificationText";

        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "×";
        close.setAttribute("aria-label", "Dismiss notification");
        close.style.cssText =
            "position:absolute;top:6px;right:10px;background:none;border:none;" +
            "color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0;";
        close.addEventListener("click", function () { box.style.display = "none"; });

        box.appendChild(text);
        box.appendChild(close);
        document.body.appendChild(box);

    }

    box.style.background = isError ? "#b00020" : "#0b6b62";
    document.getElementById("rosterNotificationText").textContent = message;
    box.style.display = "block";

    clearTimeout(showRosterNotification._timer);
    showRosterNotification._timer = setTimeout(function () {
        box.style.display = "none";
    }, isError ? 9000 : 6000);

}

function setRosterStatus(message, isError) {

    if (rosterStatus) {
        rosterStatus.textContent = message || "";
        rosterStatus.style.color = isError ? "#b00020" : "#0b6b62";
    }

    /* Pop up only for finished results, not progress or file-picked hints. */
    const text = String(message || "");

    if (text.indexOf("✅") === 0 || text.indexOf("❌") === 0 || isError) {
        showRosterNotification(text, !!isError || text.indexOf("❌") === 0);
    }

}


/* =========================================================
   MASTER CLASS LIST  (STEP 1A)
   ========================================================= */
function rosterKey(admissionNo, studentName) {
    return computeMatchKey(admissionNo, studentName);
}

async function fetchClassRoster(className, session) {

    rosterFetchFailed = false;

    if (!currentUserId || !className || !session) return [];

    const { data, error } = await withTimeout(
        supabaseClient
            .from(CLASS_ROSTER_TABLE)
            .select("admission_no, student_name, gender, house, sort_order")
            .eq("owner_user_id", currentUserId)
            .eq("website_id", WEBSITE_ID)
            .eq("class_name", className)
            .eq("session", session)
            .order("sort_order", { ascending: true }),
        NETWORK_TIMEOUT_MS,
        { data: null, error: { message: "Request timed out" } }
    );

    if (error) {
        /* Non-fatal: templates fall back to blank name cells. */
        console.error("Fetch class list error:", error);
        rosterFetchFailed = true;
        return [];
    }

    return (data || []).map(function (row) {
        return {
            admission_no: String(row.admission_no || "").trim(),
            student_name: cleanStudentName(row.student_name),
            gender: String(row.gender || "").trim(),
            house: String(row.house || "").trim()
        };
    });

}

/* Step 1B: show the students of the selected class. */
function renderStudentPreview() {

    if (!elementExists(studentPreviewContainer)) return;

    const context = getWorkflowContext(false);

    if (!context.className) {
        studentPreviewContainer.innerHTML = "";
        return;
    }

    if (classRoster.length === 0) {
        studentPreviewContainer.innerHTML =
            "<p><em>No class list has been uploaded for " +
            escapeHTML(context.className) + " (" + escapeHTML(context.session) +
            ") yet. Upload it in Step 1A.</em></p>";
        return;
    }

    let html =
        "<details><summary><strong>" + classRoster.length +
        " student(s) in the class list</strong></summary>" +
        "<table style=\"border-collapse:collapse;width:100%;margin-top:8px;\">" +
        "<tr><th style=\"border:1px solid #ccc;padding:5px;\">#</th>" +
        "<th style=\"border:1px solid #ccc;padding:5px;\">Adm No</th>" +
        "<th style=\"border:1px solid #ccc;padding:5px;text-align:left;\">Student Name</th>" +
        "<th style=\"border:1px solid #ccc;padding:5px;\">Gender</th></tr>";

    classRoster.forEach(function (student, index) {
        html +=
            "<tr><td style=\"border:1px solid #ccc;padding:5px;text-align:center;\">" + (index + 1) + "</td>" +
            "<td style=\"border:1px solid #ccc;padding:5px;text-align:center;\">" + escapeHTML(student.admission_no) + "</td>" +
            "<td style=\"border:1px solid #ccc;padding:5px;\">" + escapeHTML(student.student_name) + "</td>" +
            "<td style=\"border:1px solid #ccc;padding:5px;text-align:center;\">" + escapeHTML(student.gender) + "</td></tr>";
    });

    html += "</table></details>";

    studentPreviewContainer.innerHTML = html;

}

async function loadClassRosterForContext() {

    const context = getWorkflowContext(false);

    if (!context.className || !context.session || !currentUserId) {
        classRoster = [];
        renderStudentPreview();
        return;
    }

    classRoster = await fetchClassRoster(context.className, context.session);
    renderStudentPreview();

    if (rosterFetchFailed) {
        if (rosterStatus) {
            rosterStatus.textContent =
                "⚠ The saved class list could not be loaded (has the class_students SQL been run in Supabase?).";
            rosterStatus.style.color = "#b00020";
        }
        return;
    }

    if (rosterStatus) {
        rosterStatus.textContent = classRoster.length
            ? classRoster.length + " student(s) saved for " + contextLabel(context, false) + "."
            : "No class list saved yet for " + contextLabel(context, false) + ".";
        rosterStatus.style.color = "#0b6b62";
    }

}

/* Merge the master class list with the scores already saved for a
   subject. Class-list order wins. A saved score row is matched by
   Adm No + name, then by Adm No alone, then by name alone when one
   of the two sides has no Adm No - so adding an Adm No later, or
   correcting a spelling, does not orphan scores that were saved. */
function mergeRosterWithSavedScores(roster, savedRows) {

    if (!roster || roster.length === 0) return savedRows || [];

    const byKey = new Map();
    const byAdmission = new Map();
    const byName = new Map();

    (savedRows || []).forEach(function (saved) {

        const key = computeMatchKey(saved.admission_no, saved.student_name);
        if (!byKey.has(key)) byKey.set(key, saved);

        const adm = normalizeStudentAdmissionNo(saved.admission_no);
        if (adm && !byAdmission.has(adm)) byAdmission.set(adm, saved);

        const name = normalizeStudentName(saved.student_name);
        if (name && !byName.has(name)) byName.set(name, saved);

    });

    return roster.map(function (student) {

        const adm = normalizeStudentAdmissionNo(student.admission_no);

        let saved =
            byKey.get(rosterKey(student.admission_no, student.student_name)) ||
            (adm ? byAdmission.get(adm) : null) ||
            null;

        if (!saved) {
            const candidate = byName.get(normalizeStudentName(student.student_name));
            if (
                candidate &&
                (!adm || !normalizeStudentAdmissionNo(candidate.admission_no))
            ) {
                saved = candidate;
            }
        }

        return {
            admission_no: student.admission_no,
            student_name: student.student_name,
            first_ca: saved ? saved.first_ca : null,
            second_ca: saved ? saved.second_ca : null,
            exams: saved ? saved.exams : null
        };

    });

}

/* Writes the master list into the Scores sheet of the general template
   (Admission No, Name, Gender, Class, Term, Session, House). */
function applyRosterToScoresSheet(scoresSheet, roster, context) {

    const text = function (value) {
        return { t: "s", v: String(value ?? ""), z: "@" };
    };

    if (!roster || roster.length === 0) {
        /* No class list: keep the example row, but with the chosen term/session. */
        scoresSheet["D2"] = text(context.className);
        scoresSheet["E2"] = text(context.term);
        scoresSheet["F2"] = text(context.session);
        return 0;
    }

    const limit = Math.min(roster.length, TEMPLATE_STUDENT_ROWS);

    for (let i = 0; i < limit; i++) {
        const row = i + 2;
        scoresSheet["A" + row] = text(roster[i].admission_no);
        scoresSheet["B" + row] = text(roster[i].student_name);
        scoresSheet["C" + row] = text(roster[i].gender);
        scoresSheet["D" + row] = text(context.className);
        scoresSheet["E" + row] = text(context.term);
        scoresSheet["F" + row] = text(context.session);
        scoresSheet["G" + row] = text(roster[i].house);
    }

    return limit;

}

function downloadWorkbook(workbook, fileName) {

    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });

    const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();

    setTimeout(function () {
        URL.revokeObjectURL(url);
        if (link.parentNode) link.parentNode.removeChild(link);
    }, 3000);

}

function safeFilePart(text) {
    return String(text || "").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

async function downloadClassListTemplate() {

    try {

        if (!(await ensureXLSX())) {
            throw new Error("Excel library could not be loaded. Please check your internet connection and try again.");
        }

        const context = getWorkflowContext(true);
        if (!context) return;

        /* Already-saved students are pre-filled so the form master can add to the list. */
        const existing = await fetchClassRoster(context.className, context.session);

        const data = [["Admission No", "Student Name", "Gender", "House", "Class", "Session"]];

        for (let i = 0; i < TEMPLATE_STUDENT_ROWS; i++) {
            const student = existing[i];
            data.push([
                student ? student.admission_no : "",
                student ? student.student_name : "",
                student ? student.gender : "",
                student ? student.house : "",
                context.className,
                context.session
            ]);
        }

        const sheet = XLSX.utils.aoa_to_sheet(data);

        for (let row = 2; row <= TEMPLATE_STUDENT_ROWS + 1; row++) {
            const cell = sheet["A" + row];
            if (cell) { cell.t = "s"; cell.z = "@"; cell.v = String(cell.v ?? ""); }
        }

        sheet["!cols"] = [
            { wch: 14 }, { wch: 28 }, { wch: 9 }, { wch: 12 }, { wch: 14 }, { wch: 11 }
        ];
        sheet["!freeze"] = { xSplit: 2, ySplit: 1 };

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, "Class List");

        downloadWorkbook(
            workbook,
            safeFilePart(context.className) + "_" + safeFilePart(context.session) +
            "_Class_List_Template.xlsx"
        );

        setRosterStatus(
            "✅ Class List Template downloaded for " + contextLabel(context, false) +
            ". Enter each student's name (Admission No is optional), then upload it here."
        );

    } catch (error) {

        console.error("Class list template error:", error);
        setRosterStatus("❌ " + (error.message || "Could not create the Class List Template."), true);

    }

}

async function handleClassListUploadButton() {

    const file = classListFileInput && classListFileInput.files
        ? classListFileInput.files[0]
        : null;

    if (!file) {
        setRosterStatus("❌ Please select a completed Class List Excel file first.", true);
        return;
    }

    await uploadClassListToDatabase(file);

}

async function uploadClassListToDatabase(file) {

    if (typeof XLSX === "undefined") {
        setRosterStatus("❌ Excel library has not loaded. Please refresh the page.", true);
        return;
    }

    if (!currentUserId) {
        setRosterStatus("❌ Please sign in before uploading the class list.", true);
        return;
    }

    const context = getWorkflowContext(true);
    if (!context) return;

    if (uploadClassListButton) uploadClassListButton.disabled = true;
    setRosterStatus("⏳ Reading the Class List…");

    try {

        const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
        const sheetName = workbook.Sheets["Class List"]
            ? "Class List"
            : workbook.SheetNames.find(function (name) { return name !== "Meta"; });

        if (!sheetName) throw new Error("No worksheet was found in the uploaded file.");

        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

        const pick = function (row, names) {
            for (const key of Object.keys(row)) {
                const simple = key.toLowerCase().replace(/[^a-z]/g, "");
                if (names.indexOf(simple) !== -1) return row[key];
            }
            return "";
        };

        const students = [];
        const seenKeys = new Set();
        const seenAdmissions = new Set();

        rows.forEach(function (row, index) {

            const name = cleanStudentName(pick(row, ["studentname", "name", "fullname"]));
            const admission = String(pick(row, ["admissionno", "admno", "admissionnumber"]) ?? "").trim();
            const rowClass = cleanStudentName(pick(row, ["class"]));
            const rowSession = String(pick(row, ["session"]) ?? "").trim();

            if (!name && !admission) return;

            if (!name) {
                throw new Error("Row " + (index + 2) + " has an Admission No but no Student Name.");
            }

            if (rowClass && normalizeClassKey(rowClass) !== normalizeClassKey(context.className)) {
                throw new Error(
                    "This file is for a different class (" + rowClass + "). " +
                    "Please upload the template for " + context.className + "."
                );
            }

            if (rowSession && rowSession !== context.session) {
                throw new Error(
                    "This file is for session " + rowSession + " but " + context.session +
                    " is selected. Change the session or download a new template."
                );
            }

            const key = rosterKey(admission, name);

            if (seenKeys.has(key)) {
                throw new Error(
                    "\"" + name + "\" appears twice" +
                    (admission ? "." : " - add an Admission No to tell them apart.")
                );
            }

            const admKey = normalizeStudentAdmissionNo(admission);

            if (admKey && seenAdmissions.has(admKey)) {
                throw new Error("Admission No \"" + admission + "\" is used by two students.");
            }

            seenKeys.add(key);
            if (admKey) seenAdmissions.add(admKey);

            students.push({
                admission_no: admission,
                student_name: name,
                gender: String(pick(row, ["gender", "sex"]) ?? "").trim(),
                house: String(pick(row, ["house"]) ?? "").trim()
            });

        });

        if (students.length === 0) {
            throw new Error("No student names were found. Please fill the Student Name column.");
        }

        if (students.length > TEMPLATE_STUDENT_ROWS) {
            throw new Error(
                "A class can have at most " + TEMPLATE_STUDENT_ROWS +
                " students (this file has " + students.length + ")."
            );
        }

        const existing = await fetchClassRoster(context.className, context.session);
        const newKeys = new Set(students.map(function (s) { return rosterKey(s.admission_no, s.student_name); }));

        const removed = existing.filter(function (s) {
            return !newKeys.has(rosterKey(s.admission_no, s.student_name));
        });

        if (
            removed.length > 0 &&
            !confirm(
                removed.length + " student(s) on the saved list for " +
                contextLabel(context, false) + " are not in this file and will be removed " +
                "from the list (their saved scores are not deleted).\n\nContinue?"
            )
        ) {
            setRosterStatus("Upload cancelled. The saved class list was not changed.");
            return;
        }

        setRosterStatus("⏳ Saving " + students.length + " student(s)…");

        const now = new Date().toISOString();

        const payload = students.map(function (student, index) {
            return {
                owner_user_id: currentUserId,
                website_id: WEBSITE_ID,
                class_name: context.className,
                session: context.session,
                admission_no: student.admission_no,
                student_name: student.student_name,
                gender: student.gender,
                house: student.house,
                match_key: rosterKey(student.admission_no, student.student_name),
                sort_order: index,
                updated_at: now
            };
        });

        const { error: saveError } = await supabaseClient
            .from(CLASS_ROSTER_TABLE)
            .upsert(payload, {
                onConflict: "owner_user_id,website_id,class_name,session,match_key"
            });

        if (saveError) throw new Error(saveError.message || "Could not save the class list.");

        const removedKeys = removed.map(function (s) { return rosterKey(s.admission_no, s.student_name); });

        for (let i = 0; i < removedKeys.length; i += 100) {

            const { error: deleteError } = await supabaseClient
                .from(CLASS_ROSTER_TABLE)
                .delete()
                .eq("owner_user_id", currentUserId)
                .eq("website_id", WEBSITE_ID)
                .eq("class_name", context.className)
                .eq("session", context.session)
                .in("match_key", removedKeys.slice(i, i + 100));

            if (deleteError) throw new Error(deleteError.message || "Could not remove old names.");

        }

        classRoster = await fetchClassRoster(context.className, context.session);
        renderStudentPreview();

        setRosterStatus(
            "✅ " + students.length + " student(s) uploaded and saved for " +
            contextLabel(context, false) +
            ". They now appear automatically in Step 1B and Step 1C."
        );

    } catch (error) {

        console.error("Class list upload error:", error);
        setRosterStatus("❌ " + (error.message || "Could not upload the Class List."), true);

    } finally {

        if (uploadClassListButton) uploadClassListButton.disabled = false;

    }

}

/* Warn a subject teacher when uploaded rows are not in the class list. */
function describeRosterMismatch(roster, rows) {

    if (!roster || roster.length === 0) return "";

    const keys = new Set(roster.map(function (s) { return rosterKey(s.admission_no, s.student_name); }));
    const admissions = new Set(
        roster.map(function (s) { return normalizeStudentAdmissionNo(s.admission_no); }).filter(Boolean)
    );
    const names = new Set(roster.map(function (s) { return normalizeStudentName(s.student_name); }));

    const unmatched = [];

    rows.forEach(function (row) {

        const admission = String(row["Adm No"] ?? "").trim();
        const name = cleanStudentName(row["Student Name"]);

        if (!admission && !name) return;

        const matched =
            keys.has(computeMatchKey(admission, name)) ||
            (admission && admissions.has(normalizeStudentAdmissionNo(admission))) ||
            (!admission && names.has(normalizeStudentName(name)));

        if (!matched) unmatched.push(name || admission);

    });

    if (unmatched.length === 0) return "";

    return (
        " ⚠ " + unmatched.length + " row(s) are not in the class list (" +
        unmatched.slice(0, 5).join(", ") + (unmatched.length > 5 ? ", …" : "") +
        "). Check the spelling or Adm No."
    );

}


/* =========================================================
   AUTOMATIC COMMENTS

   Class Teacher's and Principal's comments are chosen from the
   student's AVERAGE, using the same A-F boundaries as the report's
   grading. Several comments per band are kept so a whole class does
   not receive the identical sentence; the one used for a given
   student is fixed (derived from Adm No / name), so regenerating a
   report never changes it. A comment typed in the Scores sheet
   always wins. Comments are kept short to fit the report boxes.
   ========================================================= */
const COMMENT_GRADES = ["A", "B", "C", "D", "E", "F"];

const DEFAULT_COMMENT_BANK = {

    teacher: {
        A: [
            "An outstanding result. Keep up this excellent work and remain focused.",
            "Excellent performance across the subjects. Continue to aim high.",
            "A brilliant showing this term. Maintain this commendable standard.",
            "Impressive results. Your dedication and hard work are clearly paying off."
        ],
        B: [
            "A very good result. With a little more effort, you can reach the top.",
            "Good performance overall. Keep working hard and aim even higher.",
            "Commendable effort this term. Stay consistent and keep improving.",
            "A good result. Focus on your weaker subjects to do even better."
        ],
        C: [
            "A fair performance. More effort and consistent study will bring improvement.",
            "Average result. You can do better with more concentration and practice.",
            "Satisfactory work, but there is room for improvement. Study harder.",
            "A decent effort. Pay closer attention in class and revise regularly."
        ],
        D: [
            "A weak performance. You need to study harder and seek help where necessary.",
            "Below average result. Greater effort and regular revision are needed.",
            "Improvement is needed. Attend classes regularly and do all assignments.",
            "A poor showing this term. More seriousness and dedication are required."
        ],
        E: [
            "A marginal pass. Much more effort is needed to improve.",
            "Performance is below expectation. Serious improvement is required.",
            "A weak result. Regular study and extra help are strongly advised."
        ],
        F: [
            "A very poor result. Urgent and serious improvement is required.",
            "Performance is far below the expected standard. Extra support is advised.",
            "Much work is needed. Parents should closely monitor study at home."
        ]
    },

    principal: {
        A: [
            "Excellent result. Keep flying the school's flag high.",
            "Outstanding performance. The school is proud of you; keep it up.",
            "A remarkable achievement. Continue to be a role model to others."
        ],
        B: [
            "A very good result. Keep striving for excellence.",
            "Good performance. Continue to work hard and aim higher.",
            "Commendable result. Keep up the effort."
        ],
        C: [
            "A fair result. You can do better; work harder next term.",
            "Average performance. Greater effort is expected of you.",
            "Satisfactory, but you are capable of much more. Put in more effort."
        ],
        D: [
            "A weak result. Serious effort is needed to improve next term.",
            "Below average. You are advised to work much harder.",
            "Not encouraging. Improve your study habits without delay."
        ],
        E: [
            "A marginal pass. Serious improvement is expected next term.",
            "A poor result. You must sit up and work much harder.",
            "Weak performance. Please work harder; the school will support you."
        ],
        F: [
            "A very poor result. Parents are advised to meet the class teacher.",
            "Urgent improvement is required. Please see the school management.",
            "Far below standard. Much greater seriousness is required next term."
        ]
    }

};

/* Saved settings + defaults. A band left empty falls back to the default. */
function getCommentBank() {

    const saved = reportSettings && reportSettings.commentBank
        ? reportSettings.commentBank
        : null;

    const bank = {
        enabled: !(saved && saved.enabled === false),
        teacher: {},
        principal: {}
    };

    ["teacher", "principal"].forEach(function (kind) {

        COMMENT_GRADES.forEach(function (grade) {

            const custom =
                saved && saved[kind] && Array.isArray(saved[kind][grade])
                    ? saved[kind][grade]
                        .map(function (line) { return String(line).trim(); })
                        .filter(Boolean)
                    : [];

            bank[kind][grade] = custom.length > 0
                ? custom
                : DEFAULT_COMMENT_BANK[kind][grade].slice();

        });

    });

    return bank;

}

function studentHasAnyScore(student) {

    return schoolSubjects.some(function (subject) {
        return ["1st CA", "2nd CA", "Exams"].some(function (part) {
            return String(student[subject + " " + part] ?? "").trim() !== "";
        });
    });

}

function getAutoCommentsForStudent(student) {

    const bank = getCommentBank();

    if (!bank.enabled || !studentHasAnyScore(student)) return null;

    const grade = getGrade(calculateStudentAverage(student));

    const seed =
        String(student["Admission No"] ?? "").trim() + "|" +
        cleanStudentName(student["Student Name"]);

    const pick = function (list, salt) {
        return list[parseInt(simpleHash(seed + salt), 16) % list.length];
    };

    return {
        teacher: pick(bank.teacher[grade], "|t"),
        principal: pick(bank.principal[grade], "|p")
    };

}

/* Fills blank comments (and refreshes ones this function filled before).
   Comments typed by a teacher are never touched. Returns how many
   students received at least one automatic comment. */
function applyAutoCommentsToStudents(list) {

    let touched = 0;

    (list || []).forEach(function (student) {

        if (!student) return;

        if (!student.__behavior) student.__behavior = {};

        const flags = student.__autoComment || {};
        const auto = getAutoCommentsForStudent(student);
        let changed = false;

        [
            ["Class Teacher's Comment", "teacher"],
            ["Principal's Comment", "principal"]
        ].forEach(function (pair) {

            const field = pair[0];
            const kind = pair[1];
            const current = String(student.__behavior[field] ?? "").trim();

            /* A teacher-typed comment always wins. */
            if (current !== "" && !flags[kind]) return;

            if (!auto) {
                if (flags[kind]) {
                    student.__behavior[field] = "";
                    flags[kind] = false;
                }
                return;
            }

            student.__behavior[field] = auto[kind];
            flags[kind] = true;
            changed = true;

        });

        student.__autoComment = flags;

        if (changed) touched++;

    });

    return touched;

}

/* Settings card: on/off switch + editable comments per grade band. */
function createAutoCommentManager() {

    if (document.getElementById("autoCommentManager")) return;

    const card = document.createElement("section");
    card.id = "autoCommentManager";
    card.className = "card";

    card.innerHTML = `
        <h2>Automatic Comments</h2>
        <p>
            Blank Class Teacher's and Principal's comments are filled in from each
            student's average when the completed template is uploaded in Step 2.
            Anything typed in the sheet is kept.
        </p>
        <label>
            <input type="checkbox" id="autoCommentEnabled">
            Fill blank comments automatically
        </label>
        <details style="margin-top:10px;">
            <summary>Customise the comments</summary>
            <div style="margin-top:10px;">
                <label for="autoCommentGrade">Grade band</label>
                <select id="autoCommentGrade">
                    ${COMMENT_GRADES.map(function (grade) {
                        return `<option value="${grade}">Grade ${grade}</option>`;
                    }).join("")}
                </select>
                <span id="autoCommentRange"></span>
            </div>
            <div style="margin-top:10px;">
                <label for="autoCommentTeacher">Class Teacher's comments (one per line)</label>
                <textarea id="autoCommentTeacher" rows="5" style="width:100%;"></textarea>
            </div>
            <div style="margin-top:10px;">
                <label for="autoCommentPrincipal">Principal's comments (one per line)</label>
                <textarea id="autoCommentPrincipal" rows="5" style="width:100%;"></textarea>
            </div>
            <p id="autoCommentLength"></p>
            <div>
                <button type="button" id="autoCommentSave">Save comments</button>
                <button type="button" id="autoCommentReset">Reset to defaults</button>
            </div>
        </details>
        <p id="autoCommentStatus"></p>
    `;

    const step2Card = elementExists(excelFileInput) ? excelFileInput.closest(".card") : null;

    if (step2Card && step2Card.parentNode) {
        step2Card.parentNode.insertBefore(card, step2Card);
    } else if (elementExists(downloadTemplateButton) && downloadTemplateButton.parentNode) {
        downloadTemplateButton.parentNode.appendChild(card);
    } else {
        document.body.appendChild(card);
    }

    const enabledBox = document.getElementById("autoCommentEnabled");
    const gradeSelect = document.getElementById("autoCommentGrade");
    const rangeLabel = document.getElementById("autoCommentRange");
    const teacherBox = document.getElementById("autoCommentTeacher");
    const principalBox = document.getElementById("autoCommentPrincipal");
    const lengthLabel = document.getElementById("autoCommentLength");
    const statusLabel = document.getElementById("autoCommentStatus");

    const MAX_RECOMMENDED = 140;

    /* Working copy of the bank; only written to settings on Save. */
    let draft = getCommentBank();
    let shownGrade = gradeSelect.value;

    function splitLines(text) {
        return String(text || "")
            .split("\n")
            .map(function (line) { return line.trim(); })
            .filter(Boolean);
    }

    function gradeRangeText(grade) {
        const s = reportSettings;
        const ranges = {
            A: "average " + s.gradeA + " and above",
            B: "average " + s.gradeB + " to below " + s.gradeA,
            C: "average " + s.gradeC + " to below " + s.gradeB,
            D: "average " + s.gradeD + " to below " + s.gradeC,
            E: "average " + s.gradeE + " to below " + s.gradeD,
            F: "average below " + s.gradeE
        };
        return " (" + ranges[grade] + ")";
    }

    function storeShownGrade() {
        const teacher = splitLines(teacherBox.value);
        const principal = splitLines(principalBox.value);
        draft.teacher[shownGrade] = teacher.length ? teacher : DEFAULT_COMMENT_BANK.teacher[shownGrade].slice();
        draft.principal[shownGrade] = principal.length ? principal : DEFAULT_COMMENT_BANK.principal[shownGrade].slice();
    }

    function updateLengthNote() {
        const longest = splitLines(teacherBox.value + "\n" + principalBox.value)
            .reduce(function (max, line) { return Math.max(max, line.length); }, 0);
        lengthLabel.textContent =
            "Longest line: " + longest + " characters" +
            (longest > MAX_RECOMMENDED
                ? " - long comments may not fit the report's comment boxes (aim for " +
                  MAX_RECOMMENDED + " or fewer)."
                : " (aim for " + MAX_RECOMMENDED + " or fewer to fit the report).");
    }

    function showGrade() {
        shownGrade = gradeSelect.value;
        teacherBox.value = draft.teacher[shownGrade].join("\n");
        principalBox.value = draft.principal[shownGrade].join("\n");
        rangeLabel.textContent = gradeRangeText(shownGrade);
        updateLengthNote();
    }

    function persist() {
        reportSettings.commentBank = {
            enabled: enabledBox.checked,
            teacher: draft.teacher,
            principal: draft.principal
        };
        const updated = applyAutoCommentsToStudents(students);
        saveAppData();
        return updated;
    }

    enabledBox.checked = draft.enabled;
    showGrade();

    enabledBox.addEventListener("change", function () {
        storeShownGrade();
        persist();
        statusLabel.textContent = enabledBox.checked
            ? "✅ Automatic comments are on."
            : "Automatic comments are off. Comments typed in the sheet are still used.";
    });

    /* Store what was typed for the band being left, then show the new band. */
    gradeSelect.addEventListener("change", function () {
        storeShownGrade();
        showGrade();
    });

    teacherBox.addEventListener("input", updateLengthNote);
    principalBox.addEventListener("input", updateLengthNote);

    document.getElementById("autoCommentSave").addEventListener("click", function () {
        storeShownGrade();
        const updated = persist();
        showGrade();
        statusLabel.textContent =
            "✅ Comments saved." +
            (updated > 0
                ? " Regenerate the reports to see the new comments on " + updated + " student(s)."
                : "");
    });

    document.getElementById("autoCommentReset").addEventListener("click", function () {
        if (!confirm("Reset all automatic comments to the built-in defaults?")) return;
        draft = { enabled: enabledBox.checked, teacher: {}, principal: {} };
        COMMENT_GRADES.forEach(function (grade) {
            draft.teacher[grade] = DEFAULT_COMMENT_BANK.teacher[grade].slice();
            draft.principal[grade] = DEFAULT_COMMENT_BANK.principal[grade].slice();
        });
        persist();
        showGrade();
        statusLabel.textContent = "✅ Comments reset to the defaults.";
    });

}


/* =========================================================
   ANNUAL / CUMULATIVE PERFORMANCE

   Reads every term's saved subject scores for the selected
   Class + Session and shows, per student:
       Subject | First | Second | Third | Cumulative
   A term's subject total is 1st CA + 2nd CA + Exams. Cumulative is
   the average of the terms that have a score (so it is already
   meaningful after two terms).
   ========================================================= */
function formatCumulativeNumber(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return "–";
    return String(Math.round(value * 10) / 10);
}

function averageOf(values) {
    const present = values.filter(function (v) { return v !== null && v !== undefined; });
    if (present.length === 0) return null;
    return present.reduce(function (sum, v) { return sum + v; }, 0) / present.length;
}

function resetCumulativeView() {

    cumulativeModel = null;

    if (elementExists(cumulativeResult)) cumulativeResult.innerHTML = "";
    if (elementExists(cumulativeStatus)) cumulativeStatus.textContent = "";

    if (elementExists(cumulativeStudentSelect)) {
        cumulativeStudentSelect.innerHTML = "";
        cumulativeStudentSelect.style.display = "none";
    }

}

async function buildCumulativeModel(context) {

    const { data, error } = await supabaseClient
        .from(SUBJECT_SCORES_TABLE)
        .select("subject, term, admission_no, student_name, first_ca, second_ca, exams")
        .eq("user_id", currentUserId)
        .eq("website_id", WEBSITE_ID)
        .eq("class_name", context.className)
        .eq("session", context.session);

    if (error) throw new Error(error.message || "Could not load the saved scores.");

    const roster = await fetchClassRoster(context.className, context.session);

    const studentMap = new Map();
    const subjectOrder = [];

    const identity = function (admission, name) {
        const adm = normalizeStudentAdmissionNo(admission);
        return adm ? "adm:" + adm : "name:" + normalizeStudentName(name);
    };

    /* Class-list order first, so the report follows the register. */
    roster.forEach(function (student) {
        studentMap.set(identity(student.admission_no, student.student_name), {
            admission_no: student.admission_no,
            student_name: student.student_name,
            gender: student.gender || "",
            house: student.house || "",
            scores: {}
        });
    });

    schoolSubjects.forEach(function (subject) {
        if (subjectOrder.indexOf(subject) === -1) subjectOrder.push(subject);
    });

    (data || []).forEach(function (row) {

        const parts = [row.first_ca, row.second_ca, row.exams].filter(function (v) {
            return v !== null && v !== undefined && v !== "";
        });

        if (parts.length === 0) return;

        const total = parts.reduce(function (sum, v) { return sum + Number(v); }, 0);

        let key = identity(row.admission_no, row.student_name);

        /* A score saved before an Adm No was added still belongs to the same student. */
        if (!studentMap.has(key)) {
            const byName = "name:" + normalizeStudentName(row.student_name);
            if (studentMap.has(byName)) key = byName;
        }

        if (!studentMap.has(key)) {
            studentMap.set(key, {
                admission_no: row.admission_no || "",
                student_name: cleanStudentName(row.student_name),
                gender: "",
                house: "",
                scores: {}
            });
        }

        if (subjectOrder.indexOf(row.subject) === -1) subjectOrder.push(row.subject);

        const student = studentMap.get(key);
        if (!student.scores[row.subject]) student.scores[row.subject] = {};
        student.scores[row.subject][row.term] = total;

    });

    const students = Array.from(studentMap.values()).filter(function (student) {
        return Object.keys(student.scores).length > 0;
    });

    students.forEach(function (student) {

        student.subjectRows = subjectOrder
            .filter(function (subject) { return student.scores[subject]; })
            .map(function (subject) {
                const terms = ACADEMIC_TERMS.map(function (term) {
                    const value = student.scores[subject][term];
                    return value === undefined ? null : value;
                });
                return { subject: subject, terms: terms, cumulative: averageOf(terms) };
            });

        student.termAverages = ACADEMIC_TERMS.map(function (term, index) {
            return averageOf(student.subjectRows.map(function (r) { return r.terms[index]; }));
        });

        student.cumulativeAverage = averageOf(
            student.subjectRows.map(function (r) { return r.cumulative; })
        );

    });

    /* Position by cumulative average (ties share a position). */
    const ranked = students.slice().sort(function (a, b) {
        return (b.cumulativeAverage ?? -1) - (a.cumulativeAverage ?? -1);
    });

    ranked.forEach(function (student, index) {
        const previous = ranked[index - 1];
        student.position =
            previous && previous.cumulativeAverage === student.cumulativeAverage
                ? previous.position
                : index + 1;
    });

    return { context: context, subjects: subjectOrder, students: students, ranked: ranked };

}

async function showCumulativePerformance() {

    const context = getWorkflowContext(false);

    if (!context.className || !context.session) {
        alert("Please select the Academic Session and Class in Step 1A first.");
        return;
    }

    if (!currentUserId) {
        cumulativeStatus.textContent = "❌ Please sign in first.";
        return;
    }

    cumulativeStatus.textContent = "⏳ Loading all terms…";

    try {

        cumulativeModel = await buildCumulativeModel(context);

        if (cumulativeModel.students.length === 0) {
            cumulativeResult.innerHTML = "";
            cumulativeStudentSelect.style.display = "none";
            cumulativeStatus.textContent =
                "No saved scores found for " + contextLabel(context, false) +
                ". Scores appear here after subject teachers upload their Step 1B templates.";
            return;
        }

        cumulativeStudentSelect.innerHTML = "<option value=\"\">-- Whole class summary --</option>";

        cumulativeModel.students.forEach(function (student, index) {
            const option = document.createElement("option");
            option.value = String(index);
            option.textContent = student.student_name;
            cumulativeStudentSelect.appendChild(option);
        });

        cumulativeStudentSelect.style.display = "block";
        cumulativeStatus.textContent =
            "✅ " + cumulativeModel.students.length + " student(s) with saved scores for " +
            contextLabel(context, false) + ".";

        renderCumulativeStudent();

    } catch (error) {

        console.error("Cumulative performance error:", error);
        cumulativeStatus.textContent = "❌ " + (error.message || "Could not load cumulative data.");

    }

}

function renderCumulativeStudent() {

    if (!cumulativeModel || !elementExists(cumulativeResult)) return;

    const cell = "border:1px solid #ccc;padding:6px;text-align:center;";
    const head = cell + "background:#f0f0f0;";
    const left = "border:1px solid #ccc;padding:6px;text-align:left;";
    const table = "border-collapse:collapse;width:100%;margin-top:10px;";

    const selected = cumulativeStudentSelect.value;

    if (selected === "") {

        let html =
            "<table style=\"" + table + "\"><tr>" +
            "<th style=\"" + head + "\">Position</th>" +
            "<th style=\"" + head + "\">Student</th>" +
            "<th style=\"" + head + "\">First</th>" +
            "<th style=\"" + head + "\">Second</th>" +
            "<th style=\"" + head + "\">Third</th>" +
            "<th style=\"" + head + "\">Cumulative</th></tr>";

        cumulativeModel.ranked.forEach(function (student) {
            html +=
                "<tr><td style=\"" + cell + "\">" + student.position + "</td>" +
                "<td style=\"" + left + "\">" + escapeHTML(student.student_name) + "</td>" +
                student.termAverages.map(function (avg) {
                    return "<td style=\"" + cell + "\">" + formatCumulativeNumber(avg) + "</td>";
                }).join("") +
                "<td style=\"" + cell + "font-weight:700;\">" +
                formatCumulativeNumber(student.cumulativeAverage) + "</td></tr>";
        });

        cumulativeResult.innerHTML = html + "</table>";
        return;

    }

    const student = cumulativeModel.students[Number(selected)];
    if (!student) return;

    let html =
        "<p><strong>" + escapeHTML(student.student_name) + "</strong> &mdash; " +
        escapeHTML(contextLabel(cumulativeModel.context, false)) +
        " &mdash; Position " + student.position + " of " + cumulativeModel.students.length + "</p>" +
        "<table style=\"" + table + "\"><tr>" +
        "<th style=\"" + head + "\">Subject</th>" +
        "<th style=\"" + head + "\">First</th>" +
        "<th style=\"" + head + "\">Second</th>" +
        "<th style=\"" + head + "\">Third</th>" +
        "<th style=\"" + head + "\">Cumulative</th></tr>";

    student.subjectRows.forEach(function (row) {
        html +=
            "<tr><td style=\"" + left + "\">" + escapeHTML(row.subject) + "</td>" +
            row.terms.map(function (value) {
                return "<td style=\"" + cell + "\">" + formatCumulativeNumber(value) + "</td>";
            }).join("") +
            "<td style=\"" + cell + "font-weight:700;\">" + formatCumulativeNumber(row.cumulative) + "</td></tr>";
    });

    html +=
        "<tr><td style=\"" + left + "font-weight:700;\">Average</td>" +
        student.termAverages.map(function (avg) {
            return "<td style=\"" + cell + "font-weight:700;\">" + formatCumulativeNumber(avg) + "</td>";
        }).join("") +
        "<td style=\"" + cell + "font-weight:700;\">" + formatCumulativeNumber(student.cumulativeAverage) + "</td></tr>";

    cumulativeResult.innerHTML = html + "</table>";

}

async function downloadCumulativeWorkbook() {

    if (!(await ensureXLSX())) {
        alert("Excel library could not be loaded. Please check your internet connection and try again.");
        return;
    }

    if (!cumulativeModel) {
        await showCumulativePerformance();
        if (!cumulativeModel) return;
    }

    const model = cumulativeModel;

    const header = ["Position", "Adm No", "Student Name"];

    model.subjects.forEach(function (subject) {
        header.push(subject + " First", subject + " Second", subject + " Third", subject + " Cumulative");
    });

    header.push("First Avg", "Second Avg", "Third Avg", "Cumulative Avg");

    const data = [header];

    model.ranked.forEach(function (student) {

        const row = [student.position, student.admission_no, student.student_name];

        model.subjects.forEach(function (subject) {
            const found = student.subjectRows.find(function (r) { return r.subject === subject; });
            if (found) {
                found.terms.forEach(function (value) {
                    row.push(value === null ? "" : Math.round(value * 10) / 10);
                });
                row.push(found.cumulative === null ? "" : Math.round(found.cumulative * 10) / 10);
            } else {
                row.push("", "", "", "");
            }
        });

        student.termAverages.forEach(function (avg) {
            row.push(avg === null ? "" : Math.round(avg * 10) / 10);
        });

        row.push(student.cumulativeAverage === null ? "" : Math.round(student.cumulativeAverage * 10) / 10);

        data.push(row);

    });

    const sheet = XLSX.utils.aoa_to_sheet(data);
    sheet["!freeze"] = { xSplit: 3, ySplit: 1 };

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Cumulative");

    downloadWorkbook(
        workbook,
        safeFilePart(model.context.className) + "_" + safeFilePart(model.context.session) +
        "_Cumulative_Performance.xlsx"
    );

}



/* =========================================================
   SUBJECT TEMPLATE SELECT (Step 1B dropdown)
   ========================================================= */

function populateSubjectTemplateSelect() {

    if (!elementExists(subjectTemplateSelect)) return;

    const previousValue = subjectTemplateSelect.value;

    subjectTemplateSelect.innerHTML = "";

    schoolSubjects.forEach(function (subject) {
        const option = document.createElement("option");
        option.value = subject;
        option.textContent = subject;
        subjectTemplateSelect.appendChild(option);
    });

    if (schoolSubjects.includes(previousValue)) {
        subjectTemplateSelect.value = previousValue;
    }

}


/* =========================================================
   ADD SUBJECT
   ========================================================= */

function addSubject(
    subject
) {

    const exists =
        schoolSubjects.some(
            function (existing) {

                return (

                    existing.toLowerCase() ===
                    subject.toLowerCase()

                );

            }
        );


    if (exists) {

        alert(
            "This subject already exists."
        );

        return;

    }


    schoolSubjects.push(
        subject
    );


    renderSubjectList();

    saveAppData();

}


/* =========================================================
   SAFE SUBJECT SHEET NAME
   ========================================================= */

function getSubjectSheetName(
    subject,
    workbook
) {

    let clean =
        String(subject)
            .replace(
                /[:\/?*\[\]]/g,
                ""
            )
            .trim();


    if (!clean) {

        clean =
            "Subject";

    }


    clean =
        clean.substring(
            0,
            31
        );


    let finalName =
        clean;


    let counter =
        2;


    while (
        workbook.SheetNames.some(
            function (name) {

                return (

                    name.toLowerCase() ===
                    finalName.toLowerCase()

                );

            }
        )
    ) {

        const suffix =
            " " +
            counter;


        finalName =
            clean.substring(
                0,
                31 -
                suffix.length
            ) +
            suffix;


        counter++;

    }


    return finalName;

}


/* =========================================================
   SCHOOL CLASSES (SUPABASE)

   A single, school-wide list of classes/arms, entered once and
   picked from a dropdown everywhere else. This is what stops two
   teachers on two devices from splitting one class's data into
   two ("SS2 Science 1" vs "SS 2 SCIENCE1") by typing it differently.
   ========================================================= */

const SCHOOL_CLASSES_TABLE = "school_classes";

let schoolClasses = [];

/* Used only for de-duplication (so re-adding "SS2  Science 1" with
   extra spaces or different case doesn't create a second class).
   The class's display spelling — whatever was typed first — is
   what's actually shown and stored as class_name everywhere else. */
function normalizeClassKey(name) {
    return String(name || "")
        .toUpperCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

async function fetchSchoolClasses() {

    if (!currentUserId) {
        schoolClasses = [];
        renderClassList();
        populateClassNameSelect();
        return;
    }

    const { data, error } = await supabaseClient
        .from(SCHOOL_CLASSES_TABLE)
        .select("id, class_name")
        .eq("user_id", currentUserId)
        .eq("website_id", WEBSITE_ID)
        .order("class_name", { ascending: true });

    if (error) {
        console.error("Fetch school classes error:", error);
        return;
    }

    schoolClasses = data || [];

    renderClassList();
    populateClassNameSelect();

}

async function addSchoolClass(rawName) {

    const cleaned = cleanStudentName(rawName);

    if (!cleaned) {
        alert("Please enter a class name.");
        return false;
    }

    if (!currentUserId) {
        alert("You must be signed in to add a class.");
        return false;
    }

    const classKey = normalizeClassKey(cleaned);

    const alreadyExists = schoolClasses.some(function (schoolClass) {
        return normalizeClassKey(schoolClass.class_name) === classKey;
    });

    if (alreadyExists) {
        if (elementExists(classManagerStatus)) {
            classManagerStatus.textContent =
                "That class already exists (matched an existing entry).";
        }
        return false;
    }

    const { error } = await supabaseClient
        .from(SCHOOL_CLASSES_TABLE)
        .insert({
            user_id: currentUserId,
            website_id: WEBSITE_ID,
            class_name: cleaned,
            class_key: classKey
        });

    if (error) {
        console.error("Add school class error:", error);
        if (elementExists(classManagerStatus)) {
            classManagerStatus.textContent =
                "❌ " + (error.message || "Could not add that class.");
        }
        return false;
    }

    if (elementExists(classManagerStatus)) {
        classManagerStatus.textContent = "✅ Added \"" + cleaned + "\".";
    }

    await fetchSchoolClasses();

    if (elementExists(classNameInput)) {
        classNameInput.value = cleaned;
        onClassContextChanged();
    }

    return true;

}

async function deleteSchoolClass(id, className) {

    if (!id) return;

    if (!confirm("Remove \"" + (className || "this class") + "\"? Scores already saved for it are not deleted.")) {
        return;
    }

    const { error } = await supabaseClient
        .from(SCHOOL_CLASSES_TABLE)
        .delete()
        .eq("id", id);

    if (error) {
        console.error("Delete school class error:", error);
        if (elementExists(classManagerStatus)) {
            classManagerStatus.textContent =
                "❌ " + (error.message || "Could not remove that class.");
        }
        return;
    }

    if (elementExists(classManagerStatus)) {
        classManagerStatus.textContent = "Removed \"" + className + "\".";
    }

    await fetchSchoolClasses();

}

function renderClassList() {

    if (!elementExists(classListContainer)) return;

    if (schoolClasses.length === 0) {
        classListContainer.innerHTML =
            "<p style=\"opacity:0.7;\">No classes added yet.</p>";
        return;
    }

    classListContainer.innerHTML = schoolClasses.map(function (schoolClass) {
        return (
            "<div style=\"display:flex; align-items:center; gap:8px; margin-top:4px;\">" +
            "<span>" + escapeHTML(schoolClass.class_name) + "</span>" +
            "<button type=\"button\" data-remove-class-id=\"" + escapeHTML(String(schoolClass.id)) +
            "\" data-remove-class-name=\"" + escapeHTML(schoolClass.class_name) + "\">Remove</button>" +
            "</div>"
        );
    }).join("");

}

function populateClassNameSelect() {

    if (!elementExists(classNameInput)) return;

    const previousValue = classNameInput.value;

    classNameInput.innerHTML =
        "<option value=\"\">-- Select Class --</option>";

    schoolClasses.forEach(function (schoolClass) {
        const option = document.createElement("option");
        option.value = schoolClass.class_name;
        option.textContent = schoolClass.class_name;
        classNameInput.appendChild(option);
    });

    const stillExists = schoolClasses.some(function (schoolClass) {
        return schoolClass.class_name === previousValue;
    });

    if (stillExists) {
        classNameInput.value = previousValue;
    }

    restoreSavedClassSelection();
    onClassContextChanged();

}



/* =========================================================
   CUMULATIVE REPORT SHEETS  (one per student)

   Uses the same look as the term report (same CSS classes), so it
   prints the same way. Built from every term saved for the
   selected Class + Session:
       Subject | First | Second | Third | Cumulative | Grade
   Cumulative Class Teacher's / Principal's comments come from the
   Automatic Comments bank, chosen by the student's CUMULATIVE
   average. Producing these sheets does not use up any report
   allowance and does not change the term reports.
   ========================================================= */
function autoCommentsForCumulative(student) {

    const bank = getCommentBank();

    if (!bank.enabled || student.cumulativeAverage === null) {
        return { teacher: "", principal: "" };
    }

    const grade = getGrade(student.cumulativeAverage);

    const seed =
        String(student.admission_no ?? "").trim() + "|" +
        cleanStudentName(student.student_name) + "|cumulative";

    const pick = function (list, salt) {
        return list[parseInt(simpleHash(seed + salt), 16) % list.length];
    };

    return {
        teacher: pick(bank.teacher[grade], "|t"),
        principal: pick(bank.principal[grade], "|p")
    };

}

function createCumulativeReport(student, model) {

    const context = model.context;
    const comments = autoCommentsForCumulative(student);
    const average = student.cumulativeAverage;

    const termsIncluded = ACADEMIC_TERMS
        .filter(function (term, index) { return student.termAverages[index] !== null; })
        .map(function (term) { return term.replace(" Term", ""); })
        .join(", ");

    const subjectRows = student.subjectRows.map(function (row, index) {
        return `
            <tr>
                <td>${index + 1}</td>
                <td>${escapeHTML(row.subject)}</td>
                ${row.terms.map(function (value) {
                    return `<td>${formatCumulativeNumber(value)}</td>`;
                }).join("")}
                <td><strong>${formatCumulativeNumber(row.cumulative)}</strong></td>
                <td>${row.cumulative === null ? "" : getGrade(row.cumulative)}</td>
            </tr>
        `;
    }).join("");

    return `
        <div class="report cumulative-report">

            <div class="school-header">
                ${reportSettings.schoolLogo
                    ? `<div class="school-logo-container">
                           <img src="${reportSettings.schoolLogo}" alt="School Logo" class="school-logo">
                       </div>`
                    : ""}
                <h1>${escapeHTML(reportSettings.schoolName)}</h1>
                <p>${escapeHTML(reportSettings.schoolAddress)}</p>
                <h2>CUMULATIVE (ANNUAL) REPORT SHEET</h2>
            </div>

            <div class="student-info">
                <div><strong>Admission No:</strong> ${escapeHTML(student.admission_no || "")}</div>
                <div><strong>Student Name:</strong> ${escapeHTML(student.student_name || "")}</div>
                <div><strong>Gender:</strong> ${escapeHTML(student.gender || "")}</div>
                <div><strong>Class:</strong> ${escapeHTML(context.className)}</div>
                <div><strong>House:</strong> ${escapeHTML(student.house || "")}</div>
                <div><strong>Session:</strong> ${escapeHTML(context.session)}</div>
                <div><strong>Terms Included:</strong> ${escapeHTML(termsIncluded)}</div>
                <div><strong>Class Size:</strong> ${model.students.length}</div>
            </div>

            <table class="result-table">
                <thead>
                    <tr>
                        <th>No.</th>
                        <th>Subject</th>
                        <th>First<br>Term</th>
                        <th>Second<br>Term</th>
                        <th>Third<br>Term</th>
                        <th>Cumulative</th>
                        <th>Grade</th>
                    </tr>
                </thead>
                <tbody>
                    ${subjectRows}
                </tbody>
                <tfoot>
                    <tr>
                        <th colspan="2">TERM AVERAGE</th>
                        ${student.termAverages.map(function (value) {
                            return `<th>${formatCumulativeNumber(value)}</th>`;
                        }).join("")}
                        <th>${formatCumulativeNumber(average)}</th>
                        <th>${average === null ? "" : getGrade(average)}</th>
                    </tr>
                </tfoot>
            </table>

            <p style="font-size:0.85em; margin:6px 0;">
                Cumulative is the average of the terms with recorded scores.
            </p>

            <div class="summary">
                <p><strong>Cumulative Average</strong> ${formatCumulativeNumber(average)}%</p>
                <p><strong>Class Position</strong>
                    <span class="position-value">${formatPosition(student.position)}</span>
                </p>
                <p><strong>Overall Grade</strong> ${average === null ? "" : getGrade(average)}</p>
            </div>

            <div class="comments">
                <p><strong>Class Teacher's Comment &amp; Signature:</strong></p>
                <div class="comment-box">${escapeHTML(comments.teacher)}</div>
                <p><strong>Principal's Comment &amp; Signature:</strong></p>
                <div class="comment-box">${escapeHTML(comments.principal)}</div>
            </div>

        </div>
    `;

}

function getCumulativeReportFingerprint(student, model) {

    const payload = {
        kind: "cumulative",
        class_name: model.context.className,
        session: model.context.session,
        admission_no: student.admission_no || "",
        student_name: cleanStudentName(student.student_name),
        subjects: student.subjectRows.map(function (row) {
            return [row.subject, row.terms];
        }),
        settings: stableValue(reportSettingsForFingerprint()),
        website: WEBSITE_ID
    };

    return simpleHash(JSON.stringify(payload));

}

/* mode "one": the student chosen in the dropdown; mode "all": the whole class.
   Each NEW cumulative report uses one report from the allowance, exactly like a
   term report. Regenerating the same report (same scores) is free. */
async function generateCumulativeReports(mode) {

    const context = getWorkflowContext(false);

    if (!context.className || !context.session) {
        alert("Please select the Academic Session and Class in Step 1A first.");
        return;
    }

    if (!currentUserId) {
        alert("Please sign in first.");
        return;
    }

    if (!elementExists(reportContainer)) {
        alert("The report area was not found on this page.");
        return;
    }

    let chosenName = "";

    if (mode === "one") {

        if (
            !cumulativeModel ||
            !elementExists(cumulativeStudentSelect) ||
            cumulativeStudentSelect.value === ""
        ) {
            alert("Click \"Show Cumulative Performance\" and choose a student from the list first.");
            return;
        }

        const chosen = cumulativeModel.students[Number(cumulativeStudentSelect.value)];
        chosenName = chosen ? chosen.student_name : "";

    }

    const setStatus = function (message) {
        if (elementExists(cumulativeStatus)) cumulativeStatus.textContent = message;
    };

    setStatus("⏳ Preparing cumulative report(s)…");

    try {

        /* Rebuilt from the database so the sheets always show the latest scores. */
        const model = await buildCumulativeModel(context);

        if (model.students.length === 0) {
            setStatus(
                "❌ No saved scores found for " + contextLabel(context, false) +
                ". Subject teachers must upload their Step 1B templates first."
            );
            return;
        }

        cumulativeModel = model;

        /* Register (class-list) order for the printed batch. */
        let list = model.students.slice();

        if (mode === "one") {
            list = list.filter(function (student) {
                return student.student_name === chosenName;
            });
        }

        if (list.length === 0) {
            setStatus("❌ That student has no saved scores.");
            return;
        }

        /* Same allowance ledger as the term reports: a report costs one
           allowance the first time it is generated, and nothing when the
           same report (same scores) is generated again. */
        const items = list.map(function (student) {
            const fingerprint = getCumulativeReportFingerprint(student, model);
            return {
                student: student,
                fingerprint: fingerprint,
                alreadyGenerated: hasReportBeenGenerated(fingerprint)
            };
        });

        const newItems = items.filter(function (item) { return !item.alreadyGenerated; });

        let toRender = items;
        let toCharge = [];
        let blockedNew = false;

        if (newItems.length > 0) {

            if (mode === "one") {

                if (!canGenerateReports(1)) {
                    setStatus("");
                    return;
                }

                toCharge = newItems;

            } else {

                const limit = getReportLimit();

                if (!limit) {
                    alert("❌ Your subscription plan could not be determined.");
                    setStatus("");
                    return;
                }

                const carriedOver = getCarriedOverReports();
                const totalAvailable = limit + carriedOver;
                const remaining = Math.max(totalAvailable - reportsGenerated, 0);

                if (remaining <= 0) {
                    alert(
                        "⚠️ REPORT GENERATION LIMIT REACHED\n\n" +
                        "Subscription: " + getPlanDisplayName() + "\n" +
                        "Reports generated: " + reportsGenerated + " / " + totalAvailable +
                        "\n\nPlease renew or upgrade your subscription to generate more reports."
                    );
                    updateReportStatus();
                    setStatus("");
                    return;
                }

                toCharge = newItems.slice(0, remaining);
                blockedNew = newItems.length > toCharge.length;

                const ok = confirm(
                    "Generate cumulative reports for " + list.length + " student(s)?\n\n" +
                    "Subscription: " + getPlanDisplayName() + "\n" +
                    "Reports generated: " + reportsGenerated + " / " + formatReportCount(totalAvailable) + "\n" +
                    "Carried-over reports: " + carriedOver + "\n" +
                    "Reports remaining: " + formatReportCount(remaining) +
                    "\n\nNew reports to be charged: " + toCharge.length +
                    "\nAlready-generated reports will not use allowance again." +
                    (blockedNew
                        ? "\n\n⚠️ Only " + toCharge.length +
                          " new report(s) fit in the remaining allowance."
                        : "")
                );

                if (!ok) {
                    setStatus("");
                    return;
                }

            }

            const chargeSet = new Set(toCharge.map(function (item) { return item.fingerprint; }));

            /* Reports that cannot be afforded are left out, exactly as in Generate All. */
            toRender = items.filter(function (item) {
                return item.alreadyGenerated || chargeSet.has(item.fingerprint);
            });

        }

        /* Build first, charge second - nothing is shown until the server confirms. */
        const html = toRender.map(function (item) {
            return createCumulativeReport(item.student, model);
        });

        if (toCharge.length > 0) {

            const claimed = await incrementReportCount(toCharge.length);

            if (!claimed) {
                alert(
                    "⚠️ No new reports were charged because the server could not confirm the allowance claim.\n\n" +
                    "Please refresh and try again."
                );
                updateReportStatus();
                setStatus("");
                return;
            }

            markReportsAsGenerated(toCharge.map(function (item) { return item.fingerprint; }));

        }

        reportContainer.innerHTML = html.join("");
        saveGeneratedReports();
        reportContainer.scrollIntoView({ behavior: "smooth" });

        for (let i = 0; i < toCharge.length; i++) {
            await logReportGenerated({
                "Admission No": toCharge[i].student.admission_no,
                "Student Name": toCharge[i].student.student_name,
                "Session": context.session,
                "Term": "Cumulative"
            });
        }

        updateReportStatus();

        setStatus(
            "✅ " + toRender.length + " cumulative report(s) generated for " +
            contextLabel(context, false) + " (" + toCharge.length +
            " new report(s) charged). Use Print Report below to print or save as PDF."
        );

        showRosterNotification(
            "✅ " + toRender.length + " cumulative report(s) generated.",
            false
        );

        if (blockedNew) {
            alert(
                "⚠️ Generation stopped at your available report limit.\n\n" +
                "New reports charged: " + toCharge.length + "\n" +
                "Reports generated: " + reportsGenerated +
                "\n\nRenew or upgrade to generate the remaining reports."
            );
        }

    } catch (error) {

        console.error("Cumulative report error:", error);
        setStatus("❌ " + (error.message || "Could not generate the cumulative reports."));

    }

}

/* A cumulative report is identified by the student and the scores on it,
   so regenerating the same sheet is free but new scores make a new report. */
function getCumulativeReportFingerprint(student, model) {

    const payload = {
        type: "cumulative",
        website: WEBSITE_ID,
        class_name: model.context.className,
        session: model.context.session,
        admission_no: String(student.admission_no || "").trim(),
        student_name: cleanStudentName(student.student_name),
        rows: student.subjectRows.map(function (row) {
            return [row.subject, row.terms];
        }),
        settings: reportSettingsForFingerprint()
    };

    return simpleHash(JSON.stringify(stableValue(payload)));

}


/* =========================================================
   CLASS-TAGGED SUBJECT SCORES (SUPABASE)

   Lets a subject teacher download just ONE subject's sheet,
   fill it in, and upload it from any device. The upload is
   saved to Supabase tagged by website_id + class_name + subject.
   When the class teacher later downloads the combined ("general")
   template, on any device, previously saved subject scores for
   that class are fetched back and pre-filled into the workbook.
   ========================================================= */

const SUBJECT_SCORES_TABLE = "subject_scores";

/* Every downloaded workbook (single-subject or general) carries a
   hidden "Meta" sheet identifying which class (and, for a
   single-subject file, which subject) it belongs to. This is what
   lets an upload know its own class/subject without asking the
   teacher to re-type it. */
function buildMetaSheet(className, subject, session, term) {

    const metaData = [
        ["KEY", "VALUE"],
        ["website_id", WEBSITE_ID],
        ["class_name", className || ""],
        ["subject", subject || ""],
        ["session", session || ""],
        ["term", term || ""],
        ["generated_at", new Date().toISOString()]
    ];

    const metaSheet = XLSX.utils.aoa_to_sheet(metaData);
    metaSheet["!cols"] = [{ wch: 14 }, { wch: 24 }];

    return metaSheet;
}

function appendMetaSheet(workbook, className, subject, session, term) {

    const metaSheet = buildMetaSheet(className, subject, session, term);

    XLSX.utils.book_append_sheet(workbook, metaSheet, "Meta");

    /* Hidden: this is bookkeeping, not something teachers should edit. */
    const metaIndex = workbook.SheetNames.indexOf("Meta");
    if (!workbook.Workbook) workbook.Workbook = {};
    if (!workbook.Workbook.Sheets) workbook.Workbook.Sheets = [];
    workbook.Workbook.Sheets[metaIndex] = { Hidden: 1 };

}

function readMetaFromWorkbook(workbook) {

    const result = { website_id: "", class_name: "", subject: "", session: "", term: "" };

    if (!workbook || !workbook.Sheets || !workbook.Sheets["Meta"]) {
        return result;
    }

    const rows = XLSX.utils.sheet_to_json(
        workbook.Sheets["Meta"],
        { header: 1, defval: "" }
    );

    rows.forEach(function (row) {
        const key = String(row[0] || "").trim();
        const value = row[1];

        if (key === "website_id") result.website_id = String(value || "").trim();
        if (key === "class_name") result.class_name = String(value || "").trim();
        if (key === "subject") result.subject = String(value || "").trim();
        if (key === "session") result.session = String(value || "").trim();
        if (key === "term") result.term = String(value || "").trim();
    });

    return result;

}

function getActiveClassName(required) {

    const value = elementExists(classNameInput)
        ? String(classNameInput.value || "").trim()
        : "";

    if (required && !value) {
        alert("Please add a class in Step 0, then select it above.");
    }

    return value;

}

/* Same normalized composite key used on the Excel "Match Key"
   column, so DB rows and spreadsheet rows always agree on identity
   even when a student's name is typed with stray/extra spaces. */
function computeMatchKey(admissionNo, studentName) {
    return (
        String(admissionNo || "").trim() +
        "|" +
        normalizeStudentName(studentName)
    );
}

/* =========================================================
   SAVE ONE SUBJECT'S SCORES TO SUPABASE
   ========================================================= */
async function saveSubjectScoresToDatabase(className, subject, rows, session, term) {

    if (!currentUserId) {
        throw new Error("You must be signed in to upload a subject template.");
    }

    const payloadRows = rows
        .map(function (row) {

            const admissionNo = String(row["Adm No"] || "").trim();
            const studentName = cleanStudentName(row["Student Name"]);

            if (!admissionNo && !studentName) return null;

            return {
                user_id: currentUserId,
                website_id: WEBSITE_ID,
                class_name: className,
                session: session || "",
                term: term || "",
                subject: subject,
                admission_no: admissionNo,
                student_name: studentName,
                match_key: computeMatchKey(admissionNo, studentName),
                first_ca: row["1st CA"] === "" ? null : Number(row["1st CA"]),
                second_ca: row["2nd CA"] === "" ? null : Number(row["2nd CA"]),
                exams: row["Exams"] === "" ? null : Number(row["Exams"]),
                updated_at: new Date().toISOString()
            };

        })
        .filter(function (row) { return row !== null; });

    if (payloadRows.length === 0) {
        throw new Error("No student rows were found in that subject sheet.");
    }

    const { error } = await supabaseClient
        .from(SUBJECT_SCORES_TABLE)
        .upsert(payloadRows, {
            onConflict: "user_id,website_id,class_name,session,term,subject,match_key"
        });

    if (error) {
        console.error("Subject score upload error:", error);
        throw new Error(error.message || "Could not save subject scores.");
    }

    return payloadRows.length;

}

/* =========================================================
   FETCH PREVIOUSLY SAVED SUBJECT SCORES FOR A CLASS
   Returns a map: { [subject]: [ {admission_no, student_name,
   first_ca, second_ca, exams}, ... ] }
   ========================================================= */
async function fetchAllSavedSubjectScoresForClass(className, subjects, session, term) {

    const result = {};
    subjects.forEach(function (subject) { result[subject] = []; });

    if (!currentUserId || !className) return result;

    const { data, error } = await withTimeout(
        supabaseClient
            .from(SUBJECT_SCORES_TABLE)
            .select("subject, admission_no, student_name, first_ca, second_ca, exams")
            .eq("user_id", currentUserId)
            .eq("website_id", WEBSITE_ID)
            .eq("class_name", className)
            .eq("session", session || "")
            .eq("term", term || ""),
        NETWORK_TIMEOUT_MS,
        { data: null, error: { message: "Request timed out" } }
    );

    if (error) {
        console.error("Fetch saved subject scores error:", error);
        /* Non-fatal: fall back to a blank template rather than blocking download. */
        return result;
    }

    (data || []).forEach(function (row) {
        if (!result[row.subject]) result[row.subject] = [];
        result[row.subject].push(row);
    });

    return result;

}


/* =========================================================
   DOWNLOAD SINGLE-SUBJECT TEMPLATE

   Lets a subject teacher download JUST their subject's sheet
   (Adm No / Student Name / 1st CA / 2nd CA / Exams), tagged
   with the class and subject in a hidden Meta sheet, pre-filled
   with any scores already saved for that class+subject.
   ========================================================= */
async function downloadSubjectTemplate() {

    try {

        if (!(await ensureXLSX())) {
            alert("Excel library could not be loaded. Please check your internet connection and try again.");
            return;
        }

        const context = getWorkflowContext(true);
        if (!context) return;

        const className = context.className;

        if (!elementExists(subjectTemplateSelect) || !subjectTemplateSelect.value) {
            alert("Please add and select a subject first.");
            return;
        }

        const subject = subjectTemplateSelect.value;

        setFileStatus("⏳ Preparing " + escapeHTML(subject) + " template…");

        const savedBySubject = await fetchAllSavedSubjectScoresForClass(
            className,
            [subject],
            context.session,
            context.term
        );

        const savedRows = savedBySubject[subject] || [];
        const roster = await fetchClassRoster(className, context.session);

        /* The master class list decides who is on the sheet; scores already
           saved for this term stay attached to the right student. */
        const templateRows = mergeRosterWithSavedScores(roster, savedRows);

        const workbook = XLSX.utils.book_new();

        const subjectData = [
            ["Adm No", "Student Name", "1st CA", "2nd CA", "Exams", "Match Key"]
        ];

        const rowCount = Math.max(TEMPLATE_STUDENT_ROWS, templateRows.length);

        for (let i = 0; i < rowCount; i++) {

            const saved = templateRows[i];

            if (saved) {
                subjectData.push([
                    saved.admission_no || "",
                    saved.student_name || "",
                    saved.first_ca ?? "",
                    saved.second_ca ?? "",
                    saved.exams ?? "",
                    ""
                ]);
            } else if (i === 0 && templateRows.length === 0) {
                subjectData.push(["001", "Example Student", "", "", "", ""]);
            } else {
                subjectData.push(["", "", "", "", "", ""]);
            }

        }

        const subjectSheet = XLSX.utils.aoa_to_sheet(subjectData);

        for (let row = 2; row <= rowCount + 1; row++) {
            subjectSheet["F" + row] = {
                t: "str",
                f: `TRIM(A${row})&"|"&TRIM(CLEAN(SUBSTITUTE(B${row},CHAR(160)," ")))`
            };
        }

        subjectSheet["!cols"] = [
            { wch: 7 },
            { wch: 14 },
            { wch: 6 },
            { wch: 6 },
            { wch: 6 },
            { wch: 10, hidden: true }
        ];

        subjectSheet["!freeze"] = { xSplit: 3, ySplit: 1 };

        XLSX.utils.book_append_sheet(
            workbook,
            subjectSheet,
            getSubjectSheetName(subject, workbook)
        );

        appendMetaSheet(workbook, className, subject, context.session, context.term);

        const excelData = XLSX.write(workbook, { bookType: "xlsx", type: "array" });

        const blob = new Blob([excelData], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");

        link.href = url;
        link.download =
            className.replace(/[^a-z0-9]+/gi, "_") + "_" +
            context.session.replace(/[^a-z0-9]+/gi, "_") + "_" +
            context.term.replace(/[^a-z0-9]+/gi, "_") + "_" +
            subject.replace(/[^a-z0-9]+/gi, "_") + "_Template.xlsx";

        document.body.appendChild(link);
        link.click();

        setTimeout(function () {
            URL.revokeObjectURL(url);
            if (link.parentNode) link.parentNode.removeChild(link);
        }, 5000);

        setFileStatus(
            "✅ " + escapeHTML(subject) + " template for " + escapeHTML(contextLabel(context)) +
            " downloaded" +
            (roster.length > 0
                ? " with " + roster.length + " student(s) from the class list."
                : rosterFetchFailed
                    ? ". ⚠ The class list could not be loaded, so names are blank."
                    : ". No class list has been uploaded in Step 1A, so names are blank.")
        );

    } catch (error) {

        console.error("Subject template download error:", error);
        alert("❌ Subject template could not be created.\n\n" + error.message);
        setFileStatus("❌ Subject template generation failed.");

    }

}


/* =========================================================
   UPLOAD A COMPLETED SINGLE-SUBJECT TEMPLATE

   Reads the hidden Meta sheet to learn which class/subject the
   file belongs to (falling back to the Step 1B class/subject
   pickers if a file has no Meta sheet), then saves every row to
   Supabase so it is available on any device that later downloads
   the general template for that class.
   ========================================================= */
function handleSubjectTemplateUpload(event) {

    const file = event.target.files[0];
    if (!file) return;

    if (typeof XLSX === "undefined") {
        if (elementExists(subjectTemplateStatus)) {
            subjectTemplateStatus.textContent = "❌ Excel library has not loaded.";
        }
        return;
    }

    const reader = new FileReader();

    reader.onload = async function (e) {

        try {

            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: "array" });

            const meta = readMetaFromWorkbook(workbook);

            const uploadContext = getWorkflowContext(false);
            const className = meta.class_name || uploadContext.className;
            const uploadSession = meta.session || uploadContext.session;
            const uploadTerm = meta.term || uploadContext.term;

            if (!uploadSession || !uploadTerm) {
                if (elementExists(subjectTemplateStatus)) {
                    subjectTemplateStatus.textContent =
                        "❌ Select the Academic Session and Term in Step 1A first.";
                }
                return;
            }
            const subject =
                meta.subject ||
                (elementExists(subjectTemplateSelect) ? subjectTemplateSelect.value : "");

            if (!className || !subject) {
                if (elementExists(subjectTemplateStatus)) {
                    subjectTemplateStatus.textContent =
                        "❌ Could not tell which class/subject this file is for. " +
                        "Enter the Class Name and select the Subject above, then try again.";
                }
                return;
            }

            /* The subject-only template has exactly one (non-Meta) sheet. */
            const sheetName = workbook.SheetNames.find(function (name) {
                return name !== "Meta";
            });

            if (!sheetName) {
                if (elementExists(subjectTemplateStatus)) {
                    subjectTemplateStatus.textContent =
                        "❌ No subject sheet found in that file.";
                }
                return;
            }

            const rows = XLSX.utils.sheet_to_json(
                workbook.Sheets[sheetName],
                { defval: "" }
            );

            if (elementExists(subjectTemplateStatus)) {
                subjectTemplateStatus.textContent = "⏳ Saving " + subject + " scores…";
            }

            const savedCount = await saveSubjectScoresToDatabase(
                className,
                subject,
                rows,
                uploadSession,
                uploadTerm
            );

            const uploadRoster = await fetchClassRoster(className, uploadSession);
            const rosterWarning = describeRosterMismatch(uploadRoster, rows);

            if (elementExists(subjectTemplateStatus)) {
                subjectTemplateStatus.textContent =
                    "✅ Saved " + savedCount + " " + subject + " record(s) for " +
                    className + " | " + uploadSession + " | " + uploadTerm +
                    ". They will appear automatically in Step 1C for this term, on any device." +
                    rosterWarning;
            }

        } catch (error) {

            console.error("Subject template upload error:", error);

            if (elementExists(subjectTemplateStatus)) {
                subjectTemplateStatus.textContent =
                    "❌ " + (error.message || "Could not save that subject template.");
            }

        }

    };

    reader.readAsArrayBuffer(file);

}


/* =========================================================
   DOWNLOAD EXCEL TEMPLATE
   ========================================================= */

async function downloadExcelTemplate() {
    try {
        if (!(await ensureXLSX())) {
            alert("Excel library could not be loaded. Please check your internet connection and try again.");
            return;
        }

        schoolSubjects = schoolSubjects
            .map(function (subject) { return String(subject).trim(); })
            .filter(function (subject) { return subject !== ""; });

        if (schoolSubjects.length === 0) {
            alert("Please add at least one subject.");
            return;
        }

        const workbook = XLSX.utils.book_new();

        const templateContext = getWorkflowContext(true);
        if (!templateContext) return;

        const activeClassName = templateContext.className;


        /* =================================================
           SCORES SHEET

           Behavioral traits and comments are now entered directly
           on the Scores sheet, immediately after Position:

           Position
           Class Teacher's Comment
           Principal's Comment
           Attendance
           Punctuality
           Class Participation
           Neatness
           Honesty

           A separate Behavioral Traits sheet is no longer created.
           ================================================= */
        const scoresHeaders = [
            "Admission No",
            "Student Name",
            "Gender",
            "Class",
            "Term",
            "Session",
            "House"
        ];

        schoolSubjects.forEach(function (subject) {
            scoresHeaders.push(subject + " 1st CA");
            scoresHeaders.push(subject + " 2nd CA");
            scoresHeaders.push(subject + " Exams");
            scoresHeaders.push(subject + " Total");
        });

        scoresHeaders.push("Overall Total");
        scoresHeaders.push("Average");
        setFileStatus(
            "⏳ Checking for previously saved subject scores for " +
            escapeHTML(activeClassName) + "…"
        );

        const savedScoresBySubject =
            await fetchAllSavedSubjectScoresForClass(
                activeClassName,
                schoolSubjects,
                templateContext.session,
                templateContext.term
            );

        const masterRoster = await fetchClassRoster(activeClassName, templateContext.session);

        if (masterRoster.length === 0) {
            setRosterStatus(
                "⚠️ No saved student list found. Upload the class list in Step 1A first.",
                true
            );
        }


        scoresHeaders.push("Position");
        scoresHeaders.push("Class Teacher's Comment");
        scoresHeaders.push("Principal's Comment");

        behavioralTraits.forEach(function (trait) {
            scoresHeaders.push(trait);
        });

        const scoresData = [scoresHeaders];

        for (let i = 1; i <= TEMPLATE_STUDENT_ROWS; i++) {
            const rosterStudent = masterRoster[i - 1];

            const row = [
                rosterStudent ? rosterStudent.admission_no : (i === 1 && masterRoster.length === 0 ? "001" : ""),
                rosterStudent ? rosterStudent.student_name : (i === 1 && masterRoster.length === 0 ? "Example Student" : ""),
                rosterStudent ? rosterStudent.gender : (i === 1 && masterRoster.length === 0 ? "Male" : ""),
                activeClassName,
                rosterStudent ? templateContext.term : (i === 1 && masterRoster.length === 0 ? templateContext.term : ""),
                rosterStudent ? templateContext.session : (i === 1 && masterRoster.length === 0 ? templateContext.session : ""),
                rosterStudent ? rosterStudent.house : (i === 1 && masterRoster.length === 0 ? "Example House" : "")
            ];

            schoolSubjects.forEach(function () {
                row.push("");
                row.push("");
                row.push("");
                row.push("");
            });

            /* Overall Total, Average and Position. */
            row.push("");
            row.push("");
            row.push("");

            /* Comments. */
            row.push("");
            row.push("");

            /* Behavioral traits. */
            behavioralTraits.forEach(function () {
                row.push("");
            });

            scoresData.push(row);
        }

        const scoresSheet = XLSX.utils.aoa_to_sheet(scoresData);

        /* =================================================
           COLUMN WIDTHS
           ================================================= */
        scoresSheet["!cols"] = [
            { wch: 7 },
            { wch: 18 },
            { wch: 9 },
            { wch: 9 },
            { wch: 11 },
            { wch: 11 },
            { wch: 12 }
        ];

        schoolSubjects.forEach(function () {
            scoresSheet["!cols"].push(
                { wch: 9 },
                { wch: 9 },
                { wch: 9 },
                { wch: 9 }
            );
        });

        scoresSheet["!cols"].push(
            { wch: 12 },
            { wch: 10 },
            { wch: 10 }
        );

        scoresSheet["!cols"].push(
            { wch: 18 },
            { wch: 18 }
        );

        behavioralTraits.forEach(function () {
            scoresSheet["!cols"].push({ wch: 10 });
        });

        scoresSheet["!freeze"] = {
            xSplit: 3,
            ySplit: 1
        };

        XLSX.utils.book_append_sheet(workbook, scoresSheet, "Scores");

        /* =================================================
           SETTINGS SHEET
           ================================================= */
        const settingsData = [
            ["SETTING", "VALUE"],
            ["School Name", reportSettings.schoolName],
            ["School Address", reportSettings.schoolAddress],
            ["1st CA Maximum", reportSettings.firstCAMaximum],
            ["2nd CA Maximum", reportSettings.secondCAMaximum],
            ["Exams Maximum", reportSettings.examsMaximum],
            ["Grade A Minimum", reportSettings.gradeA],
            ["Grade B Minimum", reportSettings.gradeB],
            ["Grade C Minimum", reportSettings.gradeC],
            ["Grade D Minimum", reportSettings.gradeD],
            ["Grade E Minimum", reportSettings.gradeE],
            ["Grade F Minimum", reportSettings.gradeF],
            ["Subjects", schoolSubjects.join(", ")],
            ["Class", activeClassName]
        ];

        const settingsSheet = XLSX.utils.aoa_to_sheet(settingsData);
        settingsSheet["!cols"] = [
            { wch: 14 },
            { wch: 14 }
        ];
        XLSX.utils.book_append_sheet(workbook, settingsSheet, "Settings");

        /* =================================================
           SUBJECT SHEETS
           ================================================= */
        const actualSubjectSheetNames = {};

        schoolSubjects.forEach(function (subject) {
            const sheetName = getSubjectSheetName(subject, workbook);
            actualSubjectSheetNames[subject] = sheetName;

            const subjectData = [[
                "Adm No",
                "Student Name",
                "1st CA",
                "2nd CA",
                "Exams",
                "Match Key"
            ]];

            /* Pre-fill with anything a subject teacher already
               uploaded for this class via the single-subject
               template, on this device or any other. */
            const savedSubjectRows = savedScoresBySubject[subject] || [];
            const rosterSubjectRows = mergeRosterWithSavedScores(masterRoster, savedSubjectRows);

            for (let i = 1; i <= TEMPLATE_STUDENT_ROWS; i++) {
                const saved = rosterSubjectRows[i - 1];

                if (saved) {
                    subjectData.push([
                        saved.admission_no || "",
                        saved.student_name || "",
                        saved.first_ca ?? "",
                        saved.second_ca ?? "",
                        saved.exams ?? "",
                        ""
                    ]);
                } else {
                    subjectData.push([
                        (i === 1 && rosterSubjectRows.length === 0) ? "001" : "",
                        (i === 1 && rosterSubjectRows.length === 0) ? "Example Student" : "",
                        "",
                        "",
                        "",
                        ""
                    ]);
                }
            }

            const subjectSheet = XLSX.utils.aoa_to_sheet(subjectData);
            subjectSheet["!cols"] = [
                { wch: 6 },
                { wch: 14 },
                { wch: 5 },
                { wch: 5 },
                { wch: 5 },
                { wch: 10, hidden: true }
            ];
            subjectSheet["!freeze"] = {
                xSplit: 3,
                ySplit: 1
            };

            // Hidden "Match Key" column (F): normalized Student Name
            // (collapsed spaces, no leading/trailing/non-breaking/invisible
            // characters) so the main Scores sheet's lookups aren't broken
            // by stray spaces typed while entering scores.
            for (let row = 2; row <= TEMPLATE_STUDENT_ROWS + 1; row++) {
                subjectSheet["F" + row] = {
                    t: "str",
                    f: `TRIM(A${row})&"|"&TRIM(CLEAN(SUBSTITUTE(B${row},CHAR(160)," ")))`
                };
            }

            XLSX.utils.book_append_sheet(workbook, subjectSheet, sheetName);
        });

        /* =================================================
           VLOOKUP FORMULAS
           ================================================= */
        const subjectTotalLetters = [];

        schoolSubjects.forEach(function (subject, subjectIndex) {
            const sheetName = actualSubjectSheetNames[subject];
            const safeSheetName = sheetName.replace(/'/g, "''");

            const firstCAColumn = 8 + (subjectIndex * 4);
            const secondCAColumn = firstCAColumn + 1;
            const examsColumn = firstCAColumn + 2;
            const totalColumn = firstCAColumn + 3;

            const firstCALetter = XLSX.utils.encode_col(firstCAColumn - 1);
            const secondCALetter = XLSX.utils.encode_col(secondCAColumn - 1);
            const examsLetter = XLSX.utils.encode_col(examsColumn - 1);
            const totalLetter = XLSX.utils.encode_col(totalColumn - 1);

            subjectTotalLetters.push(totalLetter);

            for (let row = 2; row <= TEMPLATE_STUDENT_ROWS + 1; row++) {
                scoresSheet[firstCALetter + row] = {
                    t: "n",
                    f: `IF($B${row}="","",IFERROR(INDEX('${safeSheetName}'!$C:$C,MATCH(TRIM($A${row})&"|"&TRIM(CLEAN(SUBSTITUTE($B${row},CHAR(160)," "))),'${safeSheetName}'!$F:$F,0)),""))`
                };

                scoresSheet[secondCALetter + row] = {
                    t: "n",
                    f: `IF($B${row}="","",IFERROR(INDEX('${safeSheetName}'!$D:$D,MATCH(TRIM($A${row})&"|"&TRIM(CLEAN(SUBSTITUTE($B${row},CHAR(160)," "))),'${safeSheetName}'!$F:$F,0)),""))`
                };

                scoresSheet[examsLetter + row] = {
                    t: "n",
                    f: `IF($B${row}="","",IFERROR(INDEX('${safeSheetName}'!$E:$E,MATCH(TRIM($A${row})&"|"&TRIM(CLEAN(SUBSTITUTE($B${row},CHAR(160)," "))),'${safeSheetName}'!$F:$F,0)),""))`
                };

                /* Per-subject Total: sum of 1st CA, 2nd CA and Exams
                   for this subject/row. Blank (not "0") when the
                   subject isn't offered, i.e. all three are blank. */
                scoresSheet[totalLetter + row] = {
                    t: "n",
                    f: `IF(AND(${firstCALetter}${row}="",${secondCALetter}${row}="",${examsLetter}${row}=""),"",SUM(${firstCALetter}${row}:${examsLetter}${row}))`
                };
            }
        });

        /* =================================================
           OVERALL TOTAL / AVERAGE / POSITION
           ================================================= */
        const firstSubjectColumn = 8;
        const lastSubjectColumn =
            firstSubjectColumn + (schoolSubjects.length * 4) - 1;
        const overallTotalColumn = lastSubjectColumn + 1;
        const averageColumn = overallTotalColumn + 1;
        const positionColumn = averageColumn + 1;

        const firstSubjectLetter = XLSX.utils.encode_col(firstSubjectColumn - 1);
        const lastSubjectLetter = XLSX.utils.encode_col(lastSubjectColumn - 1);
        const overallTotalLetter = XLSX.utils.encode_col(overallTotalColumn - 1);
        const averageLetter = XLSX.utils.encode_col(averageColumn - 1);
        const positionLetter = XLSX.utils.encode_col(positionColumn - 1);

        for (let row = 2; row <= TEMPLATE_STUDENT_ROWS + 1; row++) {
            /* Sum only each subject's Total column — the raw CA/Exams
               columns are already folded into each subject's Total,
               so summing the whole firstSubjectLetter:lastSubjectLetter
               range here would double-count every score. */
            const overallTotalFormula = subjectTotalLetters
                .map(function (letter) { return letter + row; })
                .join(",");

            scoresSheet[overallTotalLetter + row] = {
                t: "n",
                f: `IF($B${row}="","",SUM(${overallTotalFormula}))`
            };

            scoresSheet[averageLetter + row] = {
                t: "n",
                f: `IF($B${row}="","",IFERROR(${overallTotalLetter}${row}/SUM(${schoolSubjects.map(function(subject) { const sheetName = actualSubjectSheetNames[subject]; const safeSheetName = sheetName.replace(/'/g, "''"); return "COUNTIF('" + safeSheetName + "'!$F:$F,TRIM($A" + row + ")&\"|\"&TRIM(CLEAN(SUBSTITUTE($B" + row + ",CHAR(160),\" \"))))"; }).join(",")}),0))`
            };

            scoresSheet[positionLetter + row] = {
                t: "n",
                f: `IF($B${row}="","",RANK(${averageLetter}${row},$${averageLetter}$2:$${averageLetter}$${TEMPLATE_STUDENT_ROWS + 1},0))`
            };
        }

        /* Tag the whole workbook with the class it belongs to. */
        appendMetaSheet(workbook, activeClassName, "", templateContext.session, templateContext.term);

        /* =================================================
           WRITE FILE
           ================================================= */
        const excelData = XLSX.write(workbook, {
            bookType: "xlsx",
            type: "array"
        });

        const blob = new Blob([excelData], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        });

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download =
            activeClassName.replace(/[^a-z0-9]+/gi, "_") + "_" +
            templateContext.session.replace(/[^a-z0-9]+/gi, "_") + "_" +
            templateContext.term.replace(/[^a-z0-9]+/gi, "_") +
            "_Student_Report_Template.xlsx";
        document.body.appendChild(link);
        link.click();

        setTimeout(function () {
            URL.revokeObjectURL(url);
            if (link.parentNode) {
                link.parentNode.removeChild(link);
            }
        }, 5000);

        const mergedSubjectCount = Object.keys(savedScoresBySubject).filter(function (subject) {
            return (savedScoresBySubject[subject] || []).length > 0;
        }).length;

        setFileStatus(
            "✅ Template created successfully for " + escapeHTML(contextLabel(templateContext)) + " with " +
            (masterRoster.length > 0
                ? masterRoster.length + " student(s) from the class list and "
                : (rosterFetchFailed ? "⚠ (class list could not be loaded) " : "no class list and ")) +
            schoolSubjects.length +
            " subject sheet(s)" +
            (mergedSubjectCount > 0
                ? " (" + mergedSubjectCount + " of them pre-filled with previously saved scores)"
                : "") +
            ". Comments and all Behavioral Traits are now on the Scores sheet after Position."
        );

    } catch (error) {
        console.error("Excel template error:", error);

        alert(
            "❌ Excel template could not be created.\n\n" +
            error.message
        );

        setFileStatus(
            "❌ Excel template generation failed."
        );
    }
}

/* =========================================================
   HANDLE EXCEL UPLOAD
   ========================================================= */

function handleExcelUpload(event) {

    const file =
        event.target.files[0];


    if (!file) {
        return;
    }


    if (
        typeof XLSX ===
        "undefined"
    ) {

        setFileStatus(
            "❌ Excel library has not loaded."
        );

        return;

    }


    const reader =
        new FileReader();


    reader.onload =
        function (e) {

            try {

                const data =
                    new Uint8Array(
                        e.target.result
                    );


                const workbook =
                    XLSX.read(
                        data,
                        {
                            type: "array"
                        }
                    );


                if (
                    !workbook.Sheets[
                        "Scores"
                    ]
                ) {

                    setFileStatus(
                        "❌ The Excel file does not contain a Scores sheet."
                    );

                    return;

                }


                /* =========================
                   SETTINGS
                   ========================= */

                if (
                    workbook.Sheets[
                        "Settings"
                    ]
                ) {

                    readSettings(
                        workbook.Sheets[
                            "Settings"
                        ]
                    );

                }


                /* =========================
                   SCORES
                   ========================= */

                const worksheet =
                    workbook.Sheets[
                        "Scores"
                    ];


                const rows =
                    XLSX.utils.sheet_to_json(
                        worksheet,
                        {
                            defval: ""
                        }
                    );


                const actualRows =
                    rows.filter(
                        function (student) {

                            return (

                                String(
                                    student[
                                        "Admission No"
                                    ] ||
                                    ""
                                ).trim() !==
                                "" ||

                                String(
                                    student[
                                        "Student Name"
                                    ] ||
                                    ""
                                ).trim() !==
                                ""

                            );

                        }
                    );


                if (
                    actualRows.length ===
                    0
                ) {

                    setFileStatus(
                        "❌ No student records found."
                    );

                    return;

                }


                const invalidStudents =
                    actualRows.filter(
                        function (student) {

                            return !String(
                                student[
                                    "Student Name"
                                ] ||
                                ""
                            ).trim();

                        }
                    );


                if (
                    invalidStudents.length >
                    0
                ) {

                    setFileStatus(
                        "❌ One or more student records have no Student Name."
                    );

                    return;

                }


                /* =========================
                   CLEAN STUDENT NAMES
                   ========================= */

                actualRows.forEach(function (student) {
                    student["Student Name"] = cleanStudentName(
                        student["Student Name"]
                    );
                });


                /* =========================
                   SUBJECTS
                   ========================= */

                const detectedSubjects =
                    detectSubjectsFromRows(
                        actualRows
                    );


                if (
                    detectedSubjects.length >
                    0
                ) {

                    schoolSubjects =
                        detectedSubjects;

                    renderSubjectList();

                }


                /* =========================
                   REBUILD SUBJECT SCORES
                   ========================= */

                attachSubjectScores(
                    actualRows,
                    workbook,
                    schoolSubjects
                );


                /* =========================
                   BEHAVIOR / COMMENTS FROM SCORES SHEET

                   New templates store these fields directly in Scores.
                   Keep the old Behavioral Traits sheet as a fallback so
                   older templates already downloaded by users still work.
                   ========================= */

                const behaviorColumns = [
                    "Class Teacher's Comment",
                    "Principal's Comment"
                ].concat(behavioralTraits);

                const scoresContainBehaviorColumns =
                    behaviorColumns.some(function (column) {
                        return Object.prototype.hasOwnProperty.call(
                            actualRows[0] || {},
                            column
                        );
                    });

                if (scoresContainBehaviorColumns) {
                    actualRows.forEach(function (student) {
                        student.__behavior = {};

                        behaviorColumns.forEach(function (column) {
                            student.__behavior[column] =
                                student[column] ?? "";
                        });
                    });
                } else {
                    const behaviorSheet =
                        workbook.Sheets["Behavioral Traits"];

                    if (behaviorSheet) {
                        attachBehaviorData(
                            actualRows,
                            behaviorSheet
                        );
                    } else {
                        actualRows.forEach(function (student) {
                            student.__behavior = {};
                        });
                    }
                }


                /* =========================
                   STORE STUDENTS
                   ========================= */

                students =
                    actualRows;

                /* Fill blank Class Teacher's / Principal's comments from each
                   student's average (typed comments are never replaced). */
                applyAutoCommentsToStudents(students);


                saveAppData();


                /* =========================
                   CLEAR OLD GENERATED
                   REPORTS
                   =========================

                   A newly uploaded Excel file
                   represents a new dataset.

                   Therefore old generated reports
                   must not remain attached to it.
                */

                clearGeneratedReports();


                if (reportContainer) {

                    reportContainer.innerHTML =
                        "";

                }


                /* =========================
                   STATUS
                   ========================= */

                setFileStatus(

                    "✅ Excel file successfully loaded. " +

                    students.length +

                    " student record(s) found. " +

                    schoolSubjects.length +

                    " subject(s) detected."

                );


                loadStudents();


                if (reportSection) {

                    reportSection.style.display =
                        "block";

                }


                updateReportStatus();


            } catch (error) {

                console.error(
                    "Excel upload error:",
                    error
                );


                setFileStatus(
                    "❌ Unable to read this Excel file."
                );

            }

        };


    reader.readAsArrayBuffer(
        file
    );

}


/* =========================================================
   READ SETTINGS
   ========================================================= */

function readSettings(
    settingsSheet
) {

    const rows =
        XLSX.utils.sheet_to_json(
            settingsSheet,
            {
                header: 1,
                defval: ""
            }
        );


    rows.forEach(
        function (row) {

            const setting =
                String(
                    row[0] ||
                    ""
                ).trim();


            const value =
                row[1];


            if (
                setting ===
                "School Name"
            ) {

                reportSettings.schoolName =
                    String(value);

            }


            if (
                setting ===
                "School Address"
            ) {

                reportSettings.schoolAddress =
                    String(value);

            }


            if (
                setting ===
                "1st CA Maximum"
            ) {

                reportSettings.firstCAMaximum =
                    Number(value) ||
                    20;

            }


            if (
                setting ===
                "2nd CA Maximum"
            ) {

                reportSettings.secondCAMaximum =
                    Number(value) ||
                    20;

            }


            if (
                setting ===
                "Exams Maximum"
            ) {

                reportSettings.examsMaximum =
                    Number(value) ||
                    60;

            }


            if (
                setting ===
                "Grade A Minimum"
            ) {

                reportSettings.gradeA =
                    Number(value);

            }


            if (
                setting ===
                "Grade B Minimum"
            ) {

                reportSettings.gradeB =
                    Number(value);

            }


            if (
                setting ===
                "Grade C Minimum"
            ) {

                reportSettings.gradeC =
                    Number(value);

            }


            if (
                setting ===
                "Grade D Minimum"
            ) {

                reportSettings.gradeD =
                    Number(value);

            }


            if (
                setting ===
                "Grade E Minimum"
            ) {

                reportSettings.gradeE =
                    Number(value);

            }


            if (
                setting ===
                "Grade F Minimum"
            ) {

                reportSettings.gradeF =
                    Number(value);

            }


            if (
                setting ===
                "Subjects"
            ) {

                const importedSubjects =
                    String(
                        value || ""
                    )
                        .split(",")
                        .map(
                            function (
                                subject
                            ) {

                                return subject.trim();

                            }
                        )
                        .filter(
                            function (
                                subject
                            ) {

                                return (
                                    subject.length >
                                    0
                                );

                            }
                        );


                if (
                    importedSubjects.length >
                    0
                ) {

                    schoolSubjects =
                        importedSubjects;

                }

            }

        }
    );


    renderSubjectList();

    saveAppData();

}


/* =========================================================
   STUDENT NAME CLEANING / NORMALIZATION

   This applies ONLY to Student Name values.
   It removes leading/trailing spaces, repeated whitespace,
   tabs/line breaks, non-breaking spaces, zero-width characters,
   BOM characters and other invisible/control characters.
   The displayed name keeps its original letter case.
   ========================================================= */
function cleanStudentName(value) {
    if (value === null || value === undefined) return "";

    return String(value)
        .normalize("NFKC")
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
        .replace(/[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeStudentName(value) {
    return cleanStudentName(value)
        .toLowerCase()
        /* Ignore punctuation/symbols for matching only.
           The displayed Student Name remains unchanged. */
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizeStudentAdmissionNo(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim().toLowerCase();
}

/* =========================================================
   FIND AN UPLOADED SUBJECT SHEET
   ========================================================= */
function getUploadedSubjectSheet(subject, workbook) {
    if (!workbook || !workbook.SheetNames) return null;

    const cleanSubject = String(subject || "")
        .replace(/[:\\/?*\[\]]/g, "")
        .trim()
        .substring(0, 31)
        .toLowerCase();

    const exactName = workbook.SheetNames.find(function (name) {
        return String(name).toLowerCase() === cleanSubject;
    });

    if (exactName) return workbook.Sheets[exactName];

    /* Also tolerate harmless extra spaces in the sheet name. */
    const relaxedName = workbook.SheetNames.find(function (name) {
        return cleanStudentName(name).toLowerCase() === cleanSubject;
    });

    return relaxedName ? workbook.Sheets[relaxedName] : null;
}

/* =========================================================
   ATTACH SUBJECT SCORES

   The Excel template normally uses VLOOKUP formulas. However,
   cached Excel formula results can be blank when a teacher entered
   extra/invisible characters in a Student Name. This function reads
   each subject sheet directly and rebuilds the subject score values
   in JavaScript using the cleaned Student Name as a matching key.

   Admission No is preferred when available; Student Name is the
   fallback. This affects Student Name matching only and does not
   alter scores or any other field.
   ========================================================= */
function attachSubjectScores(scoreRows, workbook, subjects) {
    if (!Array.isArray(scoreRows) || !workbook || !Array.isArray(subjects)) {
        return;
    }

    scoreRows.forEach(function (student) {
        subjects.forEach(function (subject) {
            student[subject + " 1st CA"] = "";
            student[subject + " 2nd CA"] = "";
            student[subject + " Exams"] = "";
        });
    });

    subjects.forEach(function (subject) {
        const sheet = getUploadedSubjectSheet(subject, workbook);
        if (!sheet) return;

        const subjectRows = XLSX.utils.sheet_to_json(sheet, {
            defval: ""
        });

        const byAdmission = new Map();
        const byName = new Map();

        subjectRows.forEach(function (row) {
            const admissionNo = normalizeStudentAdmissionNo(row["Adm No"]);
            const name = normalizeStudentName(row["Student Name"]);

            if (admissionNo && !byAdmission.has(admissionNo)) {
                byAdmission.set(admissionNo, row);
            }

            if (name && !byName.has(name)) {
                byName.set(name, row);
            }
        });

        scoreRows.forEach(function (student) {
            const admissionNo = normalizeStudentAdmissionNo(student["Admission No"]);
            const name = normalizeStudentName(student["Student Name"]);

            let subjectRow = null;

            if (admissionNo) {
                subjectRow = byAdmission.get(admissionNo) || null;
            }

            if (!subjectRow && name) {
                subjectRow = byName.get(name) || null;
            }

            if (!subjectRow) return;

            student[subject + " 1st CA"] = subjectRow["1st CA"] ?? "";
            student[subject + " 2nd CA"] = subjectRow["2nd CA"] ?? "";
            student[subject + " Exams"] = subjectRow["Exams"] ?? "";
        });
    });
}

/* =========================================================
   DETECT SUBJECTS
   ========================================================= */

function detectSubjectsFromRows(
    rows
) {

    if (
        !rows ||
        rows.length ===
        0
    ) {

        return [];

    }


    const firstStudent =
        rows[0];


    const subjectSet =
        new Set();


    Object.keys(
        firstStudent
    )
        .forEach(
            function (key) {

                const match =
                    key.match(
                        /^(.+)\s+(1st CA|2nd CA|Exams)$/i
                    );


                if (match) {

                    subjectSet.add(
                        match[1].trim()
                    );

                }

            }
        );


    return Array.from(
        subjectSet
    );

}


/* =========================================================
   ATTACH BEHAVIOR DATA
   ========================================================= */

function attachBehaviorData(
    scoreRows,
    behaviorSheet
) {

    const behaviorRows =
        XLSX.utils.sheet_to_json(
            behaviorSheet,
            {
                defval: ""
            }
        );


    const behaviorMap =
        new Map();


    behaviorRows.forEach(
        function (row) {

            const name =
                normalizeStudentName(
                    row[
                        "Student Name"
                    ]
                );


            if (name) {

                behaviorMap.set(
                    name,
                    {

                        Attendance:
                            row[
                                "Attendance"
                            ] ||
                            "",

                        Punctuality:
                            row[
                                "Punctuality"
                            ] ||
                            "",

                        "Class Participation":
                            row[
                                "Class Participation"
                            ] ||
                            "",

                        Neatness:
                            row[
                                "Neatness"
                            ] ||
                            "",

                        Honesty:
                            row[
                                "Honesty"
                            ] ||
                            "",

                        "Class Teacher's Comment":
                            row[
                                "Class Teacher's Comment"
                            ] ||
                            "",

                        "Principal's Comment":
                            row[
                                "Principal's Comment"
                            ] ||
                            ""

                    }
                );

            }

        }
    );


    scoreRows.forEach(
        function (student) {

            const name =
                normalizeStudentName(
                    student[
                        "Student Name"
                    ]
                );


            const behavior =
                behaviorMap.get(
                    name
                );


            if (behavior) {

                student.__behavior =
                    behavior;

            } else {

                student.__behavior = {

                    Attendance:
                        "",

                    Punctuality:
                        "",

                    "Class Participation":
                        "",

                    Neatness:
                        "",

                    Honesty:
                        "",

                    "Class Teacher's Comment":
                        "",

                    "Principal's Comment":
                        ""

                };

            }


            if (
                setting ===
                "Class"
            ) {

                const uploadedClassName =
                    String(value || "").trim();

                if (uploadedClassName) {

                    const alreadyKnown = schoolClasses.some(
                        function (schoolClass) {
                            return (
                                normalizeClassKey(schoolClass.class_name) ===
                                normalizeClassKey(uploadedClassName)
                            );
                        }
                    );

                    if (alreadyKnown) {

                        if (elementExists(classNameInput)) {
                            classNameInput.value = uploadedClassName;
                        }

                    } else {

                        /* Uploaded file references a class not yet in
                           Step 0's list (e.g. first time on a new
                           device) — add it so it becomes selectable
                           and future downloads/uploads for it line up. */
                        addSchoolClass(uploadedClassName);

                    }

                }

            }

        }
    );

}


/* =========================================================
   LOAD STUDENTS
   ========================================================= */

function loadStudents() {

    if (
        !elementExists(
            studentSelect
        )
    ) {

        return;

    }


    studentSelect.innerHTML =
        "-- Select Student --";


    students.forEach(
        function (
            student,
            index
        ) {

            const option =
                document.createElement(
                    "option"
                );


            option.value =
                index;


            option.textContent =

                (
                    student[
                        "Admission No"
                    ] ||
                    ""
                ) +

                " - " +

                (
                    student[
                        "Student Name"
                    ] ||
                    ""
                );


            studentSelect.appendChild(
                option
            );

        }
    );

    loadPublishStudents();

}


/* =========================================================
   REPORT LIMIT FUNCTIONS
   ========================================================= */

function getReportLimit() {

    const plan =
        String(
            currentSubscriptionPlan ||
            ""
        )
            .trim()
            .toLowerCase();


    return (
        REPORT_LIMITS[plan] ||
        0
    );

}


/* =========================================================
   GET PLAN DISPLAY NAME
   ========================================================= */

function getPlanDisplayName() {

    return getPlanDisplayNameFromPlan(
        currentSubscriptionPlan
    );

}


/* =========================================================
   REPORT BALANCE HELPERS

   A renewal starts a fresh usage counter. Unused reports from the
   previous subscription are stored in carried_over_reports.
   The available balance is therefore:

       NEW PLAN LIMIT + CARRIED-OVER REPORTS - CURRENT USAGE
   ========================================================= */

function getCarriedOverReports(subscription = currentSubscription) {
    return Math.max(Number(subscription?.carried_over_reports) || 0, 0);
}

function getTotalAvailableReports(subscription = currentSubscription) {
    const plan = String(
        subscription?.plan ||
        subscription?.subscription_plan ||
        subscription?.package ||
        currentSubscriptionPlan ||
        ""
    ).trim().toLowerCase();

    return (REPORT_LIMITS[plan] || 0) +
        getCarriedOverReports(subscription);
}

function getReportsRemaining(subscription = currentSubscription) {
    const generated = Math.max(
        Number(subscription?.reports_generated ?? reportsGenerated) || 0,
        0
    );

    return Math.max(
        getTotalAvailableReports(subscription) - generated,
        0
    );
}


/* =========================================================
    UPDATE REPORT STATUS
    ========================================================= */

/*
   Re-reads reports_generated / the subscription row from the server
   and updates the local counters + on-screen status. Used after
   publishing, since the allowance claim for a publish now happens
   inside the publish_student_result SQL function itself rather than
   via a separate client-side call.
*/
async function refreshReportsGeneratedFromServer() {

    try {

        if (!currentUserId) {
            return;
        }

        const subscriptionResult =
            await supabaseClient
                .from("subscriptions")
                .select("*")
                .eq("user_id", currentUserId)
                .eq("website_id", WEBSITE_ID)
                .order("created_at", {
                    ascending: false
                })
                .limit(1)
                .maybeSingle();

        if (subscriptionResult.error || !subscriptionResult.data) {
            return;
        }

        currentSubscription =
            subscriptionResult.data;

        reportsGenerated =
            Number(currentSubscription.reports_generated) || 0;

        updateReportStatus();

    } catch (error) {

        console.error(
            "Unable to refresh report count after publishing:",
            error
        );

    }

}


/*
   Tells the server this student's report was just generated (and
   charged). publish_student_result checks this log before deciding
   whether to charge for publishing the same (student, session, term)
   again. Best-effort: if this call fails, the report was still
   generated and charged correctly — the only side effect is that a
   later publish of the same result would also be charged, which is
   the safe direction to fail in.
*/
async function logReportGenerated(student) {

    try {

        if (!currentUserId || !student) {
            return;
        }

        await supabaseClient.rpc(
            "log_report_generated",
            {
                p_user_id: currentUserId,
                p_website_id: WEBSITE_ID,
                p_admission_no:
                    String(student["Admission No"] || "").trim(),
                p_student_name:
                    String(student["Student Name"] || "").trim(),
                p_session:
                    String(student["Session"] || "").trim(),
                p_term:
                    String(student["Term"] || "").trim()
            }
        );

    } catch (error) {

        console.error(
            "Unable to log report generation:",
            error
        );

    }

}


function updateReportStatus() {

    const limit =
        getReportLimit();


    const plan =
        getPlanDisplayName();


    let statusElement =
        document.getElementById(
            "reportGenerationStatus"
        );


    if (!statusElement) {

        statusElement =
            document.createElement(
                "div"
            );


        statusElement.id =
            "reportGenerationStatus";


        statusElement.style.margin =
            "10px 0";


        statusElement.style.padding =
            "10px";


        statusElement.style.borderRadius =
            "6px";


        statusElement.style.fontWeight =
            "bold";


        statusElement.style.background =
            "#f5f5f5";


        if (reportSection) {

            reportSection.prepend(
                statusElement
            );

        }

    }


    if (!limit) {

        statusElement.innerHTML =
            "⚠️ Subscription plan could not be determined.";

        return;

    }


    /* =====================================================
       CARRIED-OVER REPORTS
       ===================================================== */

    const carriedOverReports =
        Math.max(
            Number(
                currentSubscription?.carried_over_reports
            ) || 0,
            0
        );


    /* =====================================================
       TOTAL AVAILABLE REPORTS
       ===================================================== */

    const totalAvailable =
        limit +
        carriedOverReports;


    /* =====================================================
       REMAINING REPORTS
       ===================================================== */

    const remaining =
        Math.max(
            totalAvailable -
            reportsGenerated,
            0
        );


    /* A free trial stops access when its time or its 10-report allowance
       is exhausted. Paid subscriptions retain their existing behavior. */
    if (isFreeTrial()) {
        const trialExpiry = new Date(
            currentSubscription?.expires_at || ""
        );

        const trialExpired =
            isNaN(trialExpiry.getTime()) ||
            trialExpiry <= new Date();

        if (trialExpired || remaining <= 0) {
            showSubscription();
            return;
        }
    }


    /* =====================================================
       DISPLAY
       ===================================================== */

    statusElement.innerHTML =

        "📊 Subscription: " +
        plan +

        "<br>" +

        "📄 Reports generated: " +
        reportsGenerated +

        " / " +

        formatReportCount(totalAvailable) +

        "<br>" +

        "🎁 Carried-over reports: " +
        carriedOverReports +

        "<br>" +

        "📌 Reports remaining: " +
        formatReportCount(remaining);


    /* =====================================================
       LIMIT REACHED
       ===================================================== */

    if (
        reportsGenerated >=
        totalAvailable
    ) {

        statusElement.innerHTML +=

            "<br><br>" +

            "⚠️ Report generation limit reached. " +

            "Please renew or upgrade your subscription to generate more reports.";

    }

}


/* =========================================================
   CAN GENERATE REPORTS
   ========================================================= */

function canGenerateReports(
    numberOfReports
) {

    const limit =
        getReportLimit();


    if (!limit) {

        alert(
            "❌ Your subscription plan could not be determined."
        );

        return false;

    }


    /* =====================================================
       CARRIED-OVER REPORTS
       ===================================================== */

    const carriedOverReports =
        Math.max(
            Number(
                currentSubscription?.carried_over_reports
            ) || 0,
            0
        );


    /* =====================================================
       TOTAL AVAILABLE
       ===================================================== */

    const totalAvailable =
        limit +
        carriedOverReports;


    /* =====================================================
       REMAINING
       ===================================================== */

    const remaining =
        Math.max(
            totalAvailable -
            reportsGenerated,
            0
        );


    /* =====================================================
       CHECK ZERO
       ===================================================== */

    if (
        remaining <=
        0
    ) {

        alert(

            "⚠️ REPORT GENERATION LIMIT REACHED\n\n" +

            "Subscription: " +
            getPlanDisplayName() +
            "\n" +

            "Reports generated: " +
            reportsGenerated +
            " / " +
            totalAvailable +
            "\n\n" +

            "Please renew or upgrade your subscription to generate more reports."

        );


        updateReportStatus();


        return false;

    }


    /* =====================================================
       CHECK REQUESTED AMOUNT
       ===================================================== */

    if (
        numberOfReports >
        remaining
    ) {

        alert(

            "⚠️ REPORT LIMIT EXCEEDED\n\n" +

            "Subscription: " +
            getPlanDisplayName() +
            "\n" +

            "Reports generated: " +
            reportsGenerated +
            " / " +
            totalAvailable +
            "\n" +

            "Reports remaining: " +
            remaining +
            "\n\n" +

            "You requested " +
            numberOfReports +
            " report(s), but only " +
            remaining +
            " report(s) remain."

        );


        updateReportStatus();


        return false;

    }


    return true;

}
/* =========================================================
   INCREMENT REPORT COUNT SECURELY
   ========================================================= */

async function incrementReportCount(
    amount
) {

    if (!currentUserId) {
        console.error("No authenticated user found.");
        return false;
    }

    const reportAmount = Number(amount);

    if (!Number.isInteger(reportAmount) || reportAmount <= 0) {
        console.error("Invalid report count:", amount);
        return false;
    }

    /*
       IMPORTANT:
       The browser must NEVER directly increment reports_generated.
       The database RPC remains the final authority for both paid
       subscriptions and the free trial.

       This function refreshes the authenticated user and the current
       subscription immediately before claiming. That prevents a newly
       created/updated trial row from being stale in the browser.
    */
    async function refreshAllowanceState() {
        const sessionResult =
            await supabaseClient.auth.getSession();

        if (
            sessionResult.error ||
            !sessionResult.data ||
            !sessionResult.data.session ||
            !sessionResult.data.session.user
        ) {
            throw new Error("Authenticated session could not be confirmed.");
        }

        const user = sessionResult.data.session.user;
        currentUserId = user.id;

        const subscriptionResult =
            await supabaseClient
                .from("subscriptions")
                .select("*")
                .eq("user_id", user.id)
                .eq("website_id", WEBSITE_ID)
                .order("created_at", {
                    ascending: false
                })
                .limit(1)
                .maybeSingle();

        if (subscriptionResult.error) {
            throw subscriptionResult.error;
        }

        if (!subscriptionResult.data) {
            throw new Error(
                "No subscription record was found for this website."
            );
        }

        currentSubscription = subscriptionResult.data;

        currentSubscriptionPlan = String(
            currentSubscription.plan ||
            currentSubscription.subscription_plan ||
            currentSubscription.package ||
            ""
        ).trim().toLowerCase();

        reportsGenerated =
            Number(currentSubscription.reports_generated) || 0;

        return currentSubscription;
    }

    async function claimOnce() {
        const { data, error } =
            await supabaseClient.rpc(
                "claim_report_allowance",
                {
                    p_user_id: currentUserId,
                    p_website_id: WEBSITE_ID,
                    p_amount: reportAmount
                }
            );

        if (error) {
            console.error(
                "Unable to claim report allowance:",
                error
            );

            return {
                ok: false,
                error: error
            };
        }

        const result =
            Array.isArray(data) ? data[0] : data;

        /* Accept a normal boolean as well as a stringified boolean. */
        const success =
            result &&
            (
                result.success === true ||
                String(result.success).toLowerCase() === "true"
            );

        if (!success) {
            console.error(
                "Report allowance claim was rejected by the server:",
                result
            );

            return {
                ok: false,
                result: result
            };
        }

        const claimedAmount =
            Number(result.claimed_amount);

        if (claimedAmount !== reportAmount) {
            console.error(
                "Server did not claim the requested number of reports:",
                {
                    requested: reportAmount,
                    result: result
                }
            );

            return {
                ok: false,
                result: result
            };
        }

        /* The server's count is authoritative. */
        const authoritativeCount =
            Number(result.reports_generated);

        if (Number.isFinite(authoritativeCount)) {
            reportsGenerated = authoritativeCount;
        } else {
            reportsGenerated += reportAmount;
        }

        /* Keep the local subscription object synchronized. */
        if (currentSubscription) {
            currentSubscription = {
                ...currentSubscription,
                reports_generated: reportsGenerated
            };
        }

        updateReportStatus();

        return {
            ok: true,
            result: result
        };
    }

    try {
        /*
           Refresh first. This is especially important for the free trial,
           because the trial subscription can be created by the Supabase
           auth trigger after account creation.
        */
        await refreshAllowanceState();

        /*
           Confirm that the locally visible subscription is actually usable.
           This is only a pre-check; the RPC remains authoritative.
        */
        const plan = String(
            currentSubscription?.plan ||
            currentSubscription?.subscription_plan ||
            currentSubscription?.package ||
            ""
        ).trim().toLowerCase();

        const status = String(
            currentSubscription?.status ||
            ""
        ).trim().toLowerCase();

        const expiry = new Date(
            currentSubscription?.expires_at || ""
        );

        const active =
            Number.isFinite(expiry.getTime()) &&
            expiry > new Date();

        const validPaidStatuses = [
            "paid",
            "active",
            "success",
            "successful",
            "completed"
        ];

        const valid =
            (
                validPaidStatuses.includes(status) ||
                (plan === FREE_TRIAL_PLAN && status === FREE_TRIAL_STATUS)
            ) &&
            active;

        if (!valid) {
            console.error(
                "Allowance claim stopped because the subscription is not active:",
                {
                    plan: plan,
                    status: status,
                    expires_at: currentSubscription?.expires_at
                }
            );
            updateReportStatus();
            return false;
        }

        /* First server-authoritative claim. */
        let claimResult = await claimOnce();

        if (claimResult.ok) {
            return true;
        }

        /*
           One controlled retry after a fresh subscription/session read.
           This handles timing races immediately after a trial row is created
           or after the subscription state changes. It cannot over-charge:
           the RPC itself decides whether the requested amount is claimable.
        */
        await new Promise(function (resolve) {
            setTimeout(resolve, 350);
        });

        await refreshAllowanceState();
        claimResult = await claimOnce();

        if (claimResult.ok) {
            return true;
        }

        console.error(
            "Final report allowance claim failure:",
            claimResult.error || claimResult.result || claimResult
        );

        return false;

    } catch (error) {
        console.error(
            "Report allowance error:",
            error
        );
        return false;
    }
}

/* =========================================================
   ONLINE RESULT PUBLISHING

   These functions work with the Publish Results section added to
   index.html and the public result-checker.html page.

   Publishing is deliberately separate from report-generation allowance:
   generating a report consumes the normal report allowance, while
   publishing stores a copy of the already-loaded result online and lets
   the server generate/control the result PIN.
   ========================================================= */

function setPublishStatus(message, isError) {

    if (!publishResultsStatus) {
        return;
    }

    publishResultsStatus.textContent =
        message || "";

    publishResultsStatus.style.color =
        isError ? "#b00020" : "#0b6b62";

}


function loadPublishStudents() {

    if (!publishStudentSelect) {
        return;
    }

    publishStudentSelect.innerHTML =
        '<option value="">-- Select Student --</option>';

    students.forEach(function (student, index) {

        const option =
            document.createElement("option");

        option.value = String(index);

        option.textContent =
            (student["Admission No"] || "") +
            " - " +
            (student["Student Name"] || "");

        publishStudentSelect.appendChild(option);

    });

}


function getPublishResultData(student) {

    const subjects = [];
    let overallTotal = 0;

    let subjectsToUse = schoolSubjects;

    const detectedSubjects =
        detectSubjectsFromRows([student]);

    if (detectedSubjects.length > 0) {
        subjectsToUse = detectedSubjects;
    }

    function isFilledIn(value) {
        return (
            value !== undefined &&
            value !== null &&
            String(value).trim() !== ""
        );
    }

    subjectsToUse.forEach(function (subjectName) {

        const firstCAKey =
            subjectName + " 1st CA";

        const secondCAKey =
            subjectName + " 2nd CA";

        const examsKey =
            subjectName + " Exams";

        const hasSubject =
            isFilledIn(student[firstCAKey]) ||
            isFilledIn(student[secondCAKey]) ||
            isFilledIn(student[examsKey]);

        if (!hasSubject) {
            return;
        }

        const firstCA =
            Number(student[firstCAKey]) || 0;

        const secondCA =
            Number(student[secondCAKey]) || 0;

        const exams =
            Number(student[examsKey]) || 0;

        const total =
            firstCA + secondCA + exams;

        const subjectPosition =
            student[subjectName + " Position"] ??
            student[subjectName + " position"] ??
            "";

        subjects.push({
            subject_name: subjectName,
            ca1: firstCA,
            ca2: secondCA,
            exam: exams,
            total: total,
            grade: getGrade(total),
            subject_position: subjectPosition
        });

        overallTotal += total;

    });

    const average =
        subjects.length > 0
            ? overallTotal / subjects.length
            : 0;

    const positionValue =
        student["Position"];

    const position =
        String(positionValue ?? "").trim() !== ""
            ? (isNaN(Number(positionValue))
                ? positionValue
                : Number(positionValue))
            : "";

    const classSize =
        students.filter(
            function (s) {
                return String(
                    s["Student Name"] || ""
                ).trim() !== "";
            }
        ).length;

    const behavior =
        student.__behavior || {};

    return {

        school: {
            name: reportSettings.schoolName || "",
            address: reportSettings.schoolAddress || "",
            logo_url: reportSettings.schoolLogo || ""
        },

        student: {
            name: cleanStudentName(
                student["Student Name"] || ""
            ),
            admission_no:
                student["Admission No"] || "",
            gender:
                student["Gender"] || "",
            class_name:
                student["Class"] || ""
        },

        result: {
            session:
                student["Session"] || "",
            term:
                student["Term"] || "",
            average: Number(average.toFixed(2)),
            position: position,
            class_size: classSize,
            attendance:
                behavior["Attendance"] || "",
            teacher_comment:
                getReportComments(student).teacher,
            principal_comment:
                getReportComments(student).principal
        },

        subjects: subjects

    };

}


function extractPublishResponse(data) {

    let response = data;

    if (Array.isArray(response)) {
        response = response[0] || {};
    }

    if (response && response.data && typeof response.data === "object") {
        response = response.data;
    }

    return response || {};

}


function extractPublishedPin(data) {

    const response = extractPublishResponse(data);

    return String(
        response.pin ||
        response.result_pin ||
        response.generated_pin ||
        response.access_pin ||
        ""
    ).trim();

}


function showPublishedResultInfo(items) {

    if (!publishedResultInfo) {
        return;
    }

    if (!Array.isArray(items) || items.length === 0) {
        publishedResultInfo.style.display = "none";
        publishedResultInfo.innerHTML = "";
        return;
    }

    let html =
        "<strong>Published Result PIN(s)</strong>" +
        "<div style=\"margin-top:10px;\">";

    items.forEach(function (item) {

        html +=
            "<div style=\"padding:8px 0; border-bottom:1px solid #ddd;\">" +
            "<strong>" +
            escapeHTML(item.studentName) +
            "</strong> — PIN: <strong>" +
            escapeHTML(item.pin || "Not returned") +
            "</strong>" +
            "</div>";

    });

    html += "</div>";

    publishedResultInfo.innerHTML = html;
    publishedResultInfo.style.display = "block";

}


async function publishOneStudentResult(student) {

    if (!student) {
        return {
            ok: false,
            message: "Student record was not found."
        };
    }

    const studentName =
        cleanStudentName(
            student["Student Name"] || ""
        );

    const session =
        String(student["Session"] || "").trim();

    const term =
        String(student["Term"] || "").trim();

    if (!studentName) {
        return {
            ok: false,
            message: "The selected student has no name."
        };
    }

    if (!session) {
        return {
            ok: false,
            message:
                "The selected student has no session."
        };
    }

    if (!term) {
        return {
            ok: false,
            message:
                "The selected student has no term."
        };
    }

    /*
       NOTE: The report allowance claim used to happen here on the
       client. It has moved into the publish_student_result SQL
       function itself (it now calls claim_report_allowance
       server-side before doing any work), so it cannot be bypassed
       by calling the RPC directly. Do NOT re-add a client-side
       claim here or every publish will be double-charged.
    */

    const resultData =
        getPublishResultData(student);

    try {

        const { data, error } =
            await supabaseClient.rpc(
                "publish_student_result",
                {
                    p_website_id: WEBSITE_ID,
                    p_school_name: resultData.school.name || null,
                    p_school_address: resultData.school.address || null,
                    p_school_logo_url: resultData.school.logo_url || null,
                    p_admission_no:
                        String(resultData.student.admission_no || "").trim() ,
                    p_student_name: studentName,
                    p_gender: resultData.student.gender || null,
                    p_class_name: resultData.student.class_name || null,
                    p_session: session,
                    p_term: term,
                    p_average: Number(resultData.result.average) || 0,
                    p_position:
                        String(resultData.result.position ?? "").trim() === ""
                            ? null
                            : (isNaN(Number(resultData.result.position))
                                ? null
                                : Number(resultData.result.position)),
                    p_class_size:
                        Number(resultData.result.class_size) || null,
                    p_attendance: resultData.result.attendance || null,
                    p_teacher_comment: resultData.result.teacher_comment || null,
                    p_principal_comment: resultData.result.principal_comment || null,
                    p_subjects: (resultData.subjects || []).map(function (subject) {
                        return {
                            subject_name: subject.subject_name || "",
                            ca1: subject.ca1 ?? "",
                            ca2: subject.ca2 ?? "",
                            exam: subject.exam ?? "",
                            total: subject.total ?? "",
                            grade: subject.grade || "",
                            subject_position: subject.position ?? ""
                        };
                    })
                }
            );

        if (error) {
            console.error(
                "Publish result RPC error:",
                error
            );

            return {
                ok: false,
                message:
                    error.message ||
                    "The server could not publish this result."
            };
        }

        const response =
            extractPublishResponse(data);

        const success =
            response.success === true ||
            String(response.success).toLowerCase() === "true";

        if (!success) {
            return {
                ok: false,
                message:
                    response.message ||
                    response.error ||
                    "The result was not published."
            };
        }

        /*
           The RPC claimed one report allowance server-side. Refresh
           the local counters so the on-screen "reports remaining"
           display stays accurate without waiting for a page reload.
        */
        await refreshReportsGeneratedFromServer();

        return {
            ok: true,
            pin: extractPublishedPin(data),
            maxUses:
                Number(response.max_uses) || 5,
            usesRemaining:
                Number.isFinite(Number(response.uses_remaining))
                    ? Number(response.uses_remaining)
                    : 5,
            studentName: studentName,
            message:
                response.message ||
                "Result published successfully."
        };

    } catch (error) {

        console.error(
            "Unexpected publish error:",
            error
        );

        return {
            ok: false,
            message:
                "An unexpected error occurred while publishing the result."
        };

    }

}

/* =========================================================
   VERIFY SUBSCRIPTION ACCESS FOR PUBLISHING

   Publishing must be restricted to users who currently have the
   same active subscription that is required to generate reports
   (paid plan in good standing, or an active free trial). This
   re-checks against the server every time, so a subscription that
   lapses after the app was first opened is caught immediately,
   instead of only being caught once at initial login.

   The publish buttons themselves are intentionally left visible
   and enabled at all times; this check runs on click and, if it
   fails, prompts the user to subscribe/renew instead of silently
   blocking or hiding anything.
   ========================================================= */

async function verifyActiveSubscriptionForPublishing() {

    try {

        const sessionResult =
            await supabaseClient.auth.getSession();

        if (
            sessionResult.error ||
            !sessionResult.data ||
            !sessionResult.data.session ||
            !sessionResult.data.session.user
        ) {
            return {
                valid: false,
                reason:
                    "Your session could not be confirmed. Please log in again."
            };
        }

        const user = sessionResult.data.session.user;
        currentUserId = user.id;

        const subscriptionResult =
            await supabaseClient
                .from("subscriptions")
                .select("*")
                .eq("user_id", user.id)
                .eq("website_id", WEBSITE_ID)
                .order("created_at", {
                    ascending: false
                })
                .limit(1)
                .maybeSingle();

        if (subscriptionResult.error) {
            console.error(
                "Subscription check failed while verifying publish access:",
                subscriptionResult.error
            );

            return {
                valid: false,
                reason:
                    "Could not confirm your subscription status. Please try again."
            };
        }

        if (!subscriptionResult.data) {
            return {
                valid: false,
                reason:
                    "No subscription was found on your account. Please subscribe to publish results."
            };
        }

        const subscription = subscriptionResult.data;

        /* Keep the shared subscription state synchronized with this fresh read. */
        currentSubscription = subscription;

        const plan = String(
            subscription.plan ||
            subscription.subscription_plan ||
            subscription.package ||
            ""
        ).trim().toLowerCase();

        currentSubscriptionPlan = plan;

        const status = String(
            subscription.status ||
            ""
        ).trim().toLowerCase();

        const expiry = new Date(
            subscription.expires_at || ""
        );

        const notExpired =
            Number.isFinite(expiry.getTime()) &&
            expiry > new Date();

        const validPaidStatuses = [
            "paid",
            "active",
            "success",
            "successful",
            "completed"
        ];

        const statusIsValid =
            validPaidStatuses.includes(status) ||
            (plan === FREE_TRIAL_PLAN && status === FREE_TRIAL_STATUS);

        if (!statusIsValid || !notExpired) {
            return {
                valid: false,
                reason:
                    "Your subscription is not active. Please subscribe or renew to publish results."
            };
        }

        return {
            valid: true,
            subscription: subscription
        };

    } catch (error) {

        console.error(
            "Unexpected error while verifying publish access:",
            error
        );

        return {
            valid: false,
            reason:
                "Could not confirm your subscription status. Please try again."
        };

    }

}


function promptSubscriptionRequiredForPublishing(reason) {

    const message =
        reason ||
        "An active subscription is required to publish results.";

    setPublishStatus(
        "❌ " + message,
        true
    );

    const shouldGoToPlans =
        confirm(
            message +
            "\n\nGo to subscription plans now?"
        );

    if (!shouldGoToPlans) {
        return;
    }

    /*
       Deliberately does NOT hide appSection here: the rest of the app
       (including the renew/upgrade button) must stay visible and
       usable. This only reveals the subscription plans and scrolls
       to them.
    */
    if (elementExists(subscriptionPlans)) {

        subscriptionPlans.style.display = "block";

        subscriptionPlans.scrollIntoView({
            behavior: "smooth",
            block: "start"
        });

    }

}


async function publishSelectedResult() {

    if (!publishStudentSelect) {
        return;
    }

    const accessCheck =
        await verifyActiveSubscriptionForPublishing();

    if (!accessCheck.valid) {
        promptSubscriptionRequiredForPublishing(
            accessCheck.reason
        );
        return;
    }

    const index =
        publishStudentSelect.value;

    if (index === "") {
        setPublishStatus(
            "Please select a student to publish.",
            true
        );
        return;
    }

    const student =
        students[Number(index)];

    if (!student) {
        setPublishStatus(
            "The selected student could not be found.",
            true
        );
        return;
    }

    if (publishSingleResultButton) {
        publishSingleResultButton.disabled = true;
    }

    setPublishStatus(
        "Publishing result...",
        false
    );

    showPublishedResultInfo([]);

    const result =
        await publishOneStudentResult(student);

    if (publishSingleResultButton) {
        publishSingleResultButton.disabled = false;
    }

    if (!result.ok) {
        setPublishStatus(
            "❌ " + result.message,
            true
        );
        return;
    }

    setPublishStatus(
        "✅ Result published successfully for " +
        result.studentName +
        ". PIN uses allowed: " +
        result.maxUses +
        ".",
        false
    );

    showPublishedResultInfo([
        result
    ]);

}


async function publishAllResults() {

    const accessCheck =
        await verifyActiveSubscriptionForPublishing();

    if (!accessCheck.valid) {
        promptSubscriptionRequiredForPublishing(
            accessCheck.reason
        );
        return;
    }

    if (!students || students.length === 0) {
        setPublishStatus(
            "Please upload an Excel file containing student records first.",
            true
        );
        return;
    }

    /*
       Friendly pre-check only: publishing consumes the same report
       allowance as report generation, one unit per student. This just
       warns up front if there obviously isn't enough left; the actual
       per-student claim below (inside publishOneStudentResult) remains
       the authoritative check.
    */
    if (!canGenerateReports(students.length)) {
        return;
    }

    const confirmation =
        confirm(
            "Publish results for " +
            students.length +
            " student(s) online?\n\n" +
            "Each published result will use one report from your " +
            "subscription's report allowance, the same allowance used " +
            "for report generation.\n\n" +
            "Each student will receive a separate result PIN."
        );

    if (!confirmation) {
        return;
    }

    if (publishAllResultsButton) {
        publishAllResultsButton.disabled = true;
    }

    if (publishSingleResultButton) {
        publishSingleResultButton.disabled = true;
    }

    setPublishStatus(
        "Publishing results... 0 / " + students.length,
        false
    );

    showPublishedResultInfo([]);

    const successful = [];
    const failed = [];

    for (let i = 0; i < students.length; i++) {

        const student = students[i];

        const studentName =
            cleanStudentName(
                student["Student Name"] || ""
            );

        try {

            const result =
                await publishOneStudentResult(student);

            if (result && result.ok) {

                successful.push(result);

            } else {

                failed.push({
                    studentName: studentName || "(Unnamed student)",
                    message:
                        result && result.message
                            ? result.message
                            : "Unknown publishing error."
                });
            }

        } catch (error) {

            failed.push({
                studentName: studentName || "(Unnamed student)",
                message:
                    error && error.message
                        ? error.message
                        : String(error)
            });
        }

        setPublishStatus(
            "Publishing results... " +
            (i + 1) +
            " / " +
            students.length,
            false
        );
    }

    if (publishAllResultsButton) {
        publishAllResultsButton.disabled = false;
    }

    if (publishSingleResultButton) {
        publishSingleResultButton.disabled = false;
    }

    showPublishedResultInfo(successful);

    let status =
        "✅ Published " +
        successful.length +
        " of " +
        students.length +
        " result(s).";

    if (successful.length > 0) {
        status +=
            " Each generated PIN allows up to 5 result checks.";
    }

    if (failed.length > 0) {
        status +=
            " " +
            failed.length +
            " result(s) failed to publish.";

        console.error(
            "===== RESULT PUBLISHING ERRORS ====="
        );

        console.error(failed);

        /*
         * Display the first few actual errors in the page.
         */
        const errorText =
            failed
                .slice(0, 10)
                .map(function (item, index) {
                    return (
                        (index + 1) +
                        ". " +
                        item.studentName +
                        " — " +
                        item.message
                    );
                })
                .join("\n");

        alert(
            "Some results failed to publish.\n\n" +
            "Here are the errors:\n\n" +
            errorText +
            (
                failed.length > 10
                    ? "\n\n...and " +
                      (failed.length - 10) +
                      " more."
                    : ""
            )
        );
    }

    setPublishStatus(
        status,
        failed.length > 0 && successful.length === 0
    );
}

/* =========================================================
   GENERATE SINGLE REPORT
   ========================================================= */

async function generateSingleReport() {

    if (!elementExists(studentSelect)) {
        return;
    }

    const index = studentSelect.value;

    if (index === "") {
        alert("Please select a student.");
        return;
    }

    const student = students[Number(index)];

    if (!student) {
        return;
    }

    const fingerprint =
        getReportGenerationFingerprint(student);

    /*
       IMPORTANT: The ledger check happens BEFORE the allowance RPC.
       Therefore clicking Generate again for the same report cannot debit
       another report, including after refresh or mode switching.
    */
    const alreadyGenerated =
        hasReportBeenGenerated(fingerprint);

    if (alreadyGenerated) {
        const report = createReport(student);

        if (reportContainer) {
            reportContainer.innerHTML = report;
            saveGeneratedReports();
            reportContainer.scrollIntoView({
                behavior: "smooth"
            });
        }

        updateReportStatus();
        return;
    }

    /* Local check is only a friendly pre-check. The server is authoritative. */
    if (!canGenerateReports(1)) {
        return;
    }

    /* Build the report before claiming so the normal report creation path
       is completed before allowance is consumed. */
    const report = createReport(student);

    /* Claim exactly one new report on the server. */
    const countUpdated =
        await incrementReportCount(1);

    if (!countUpdated) {
        alert(
            "⚠️ This report was not charged because the server could not confirm the allowance claim. Please refresh and try again."
        );
        updateReportStatus();
        return;
    }

    /* Mark only after the server has successfully charged the report. */
    markReportsAsGenerated([fingerprint]);
    await logReportGenerated(student);

    if (reportContainer) {
        reportContainer.innerHTML = report;
        saveGeneratedReports();
        reportContainer.scrollIntoView({
            behavior: "smooth"
        });
    }

    updateReportStatus();
}

/* =========================================================
   GENERATE ALL PROGRESS MESSAGE
   ========================================================= */

function updateTemporaryGenerationMessage(current, total) {

    let progress =
        document.getElementById("generationProgress");

    if (!progress) {
        progress = document.createElement("div");
        progress.id = "generationProgress";
        progress.style.position = "fixed";
        progress.style.top = "20px";
        progress.style.left = "50%";
        progress.style.transform = "translateX(-50%)";
        progress.style.zIndex = "99999";
        progress.style.padding = "12px 18px";
        progress.style.borderRadius = "8px";
        progress.style.background = "#1f2937";
        progress.style.color = "#fff";
        progress.style.fontSize = "14px";
        progress.style.fontWeight = "600";
        progress.style.boxShadow = "0 4px 12px rgba(0,0,0,0.25)";
        progress.style.textAlign = "center";
        document.body.appendChild(progress);
    }

    progress.textContent =
        "Generating reports... " + current + " / " + total;
}


/* =========================================================
   GENERATE ALL REPORTS
   ========================================================= */

async function generateAllReports() {

    if (!students || students.length === 0) {
        alert("❌ Please upload an Excel file containing student records first.");
        return;
    }

    const limit = getReportLimit();

    if (!limit) {
        alert("❌ Your subscription plan could not be determined.");
        return;
    }

    const carriedOver = getCarriedOverReports();
    const totalAvailable = limit + carriedOver;
    const remaining = Math.max(
        totalAvailable - reportsGenerated,
        0
    );

    /* Generate All and Generate Student use the same fingerprint ledger. */
    const reportItems = students.map(function (student) {
        const fingerprint =
            getReportGenerationFingerprint(student);

        return {
            student: student,
            fingerprint: fingerprint,
            alreadyGenerated: hasReportBeenGenerated(fingerprint)
        };
    });

    const newItems = reportItems.filter(function (item) {
        return !item.alreadyGenerated;
    });

    if (newItems.length === 0) {
        /* Everything has already consumed its allowance in this subscription. */
        if (reportContainer) {
            reportContainer.innerHTML = "";

            reportItems.forEach(function (item) {
                reportContainer.insertAdjacentHTML(
                    "beforeend",
                    createReport(item.student)
                );
            });

            saveGeneratedReports();
            reportContainer.scrollIntoView({
                behavior: "smooth"
            });
        }

        updateReportStatus();
        alert(
            "ℹ️ All selected student reports have already been generated for this subscription.\n\nNo allowance was deducted."
        );
        return;
    }

    if (remaining <= 0) {
        alert(
            "⚠️ REPORT GENERATION LIMIT REACHED\n\n" +
            "Subscription: " + getPlanDisplayName() + "\n" +
            "Reports generated: " + reportsGenerated +
            " / " + totalAvailable +
            "\n\nPlease renew or upgrade your subscription to generate more reports."
        );
        updateReportStatus();
        return;
    }

    const newItemsAllowed =
        newItems.slice(0, remaining);

    const blockedNewItems =
        newItems.length > newItemsAllowed.length;

    const confirmation = confirm(
        "Generate reports for " + students.length + " student(s)?\n\n" +
        "Subscription: " + getPlanDisplayName() + "\n" +
        "Current reports generated: " + reportsGenerated +
        " / " + formatReportCount(totalAvailable) + "\n" +
        "Carried-over reports: " + carriedOver + "\n" +
        "Reports remaining: " + formatReportCount(remaining) +
        "\n\nAlready-generated reports will not consume allowance again." +
        (blockedNewItems
            ? "\n\n⚠️ Only " + newItemsAllowed.length +
              " new report(s) can consume the remaining allowance."
            : "")
    );

    if (!confirmation) {
        return;
    }

    const allowedNewFingerprints = new Set(
        newItemsAllowed.map(function (item) {
            return item.fingerprint;
        })
    );

    /*
       Prepare HTML first. Nothing is put into the report container until
       the server has successfully claimed the new allowance.
    */
    const reportsToRender = [];
    const fingerprintsToCharge = [];

    for (let i = 0; i < reportItems.length; i++) {
        const item = reportItems[i];

        if (
            !item.alreadyGenerated &&
            !allowedNewFingerprints.has(item.fingerprint)
        ) {
            continue;
        }

        reportsToRender.push(
            createReport(item.student)
        );

        if (!item.alreadyGenerated) {
            fingerprintsToCharge.push(
                item.fingerprint
            );
        }

        if (reportsToRender.length % 10 === 0) {
            updateTemporaryGenerationMessage(
                reportsToRender.length,
                students.length
            );

            await new Promise(function (resolve) {
                setTimeout(resolve, 0);
            });
        }
    }

    const generationProgress =
        document.getElementById("generationProgress");

    if (generationProgress) {
        generationProgress.remove();
    }

    /* Charge only genuinely new reports. Existing reports cost zero. */
    if (fingerprintsToCharge.length > 0) {
        const countUpdated =
            await incrementReportCount(
                fingerprintsToCharge.length
            );

        if (!countUpdated) {
            alert(
                "⚠️ No new reports were charged because the server could not confirm the allowance claim.\n\nPlease refresh and try again."
            );
            updateReportStatus();
            return;
        }
    }

    /* Server claim succeeded. Now render and commit the ledger entries. */
    if (reportContainer) {
        reportContainer.innerHTML = "";

        reportsToRender.forEach(function (html) {
            reportContainer.insertAdjacentHTML(
                "beforeend",
                html
            );
        });

        saveGeneratedReports();
        reportContainer.scrollIntoView({
            behavior: "smooth"
        });
    }

    if (fingerprintsToCharge.length > 0) {
        markReportsAsGenerated(
            fingerprintsToCharge
        );
        saveGeneratedReports();

        for (let i = 0; i < newItemsAllowed.length; i++) {
            await logReportGenerated(
                newItemsAllowed[i].student
            );
        }
    }

    updateReportStatus();

    if (blockedNewItems) {
        alert(
            "⚠️ Generation stopped at your available report limit.\n\n" +
            "New reports charged this operation: " +
            fingerprintsToCharge.length + "\n" +
            "Reports generated: " + reportsGenerated +
            " / " + totalAvailable +
            "\n\nRenew or upgrade to generate the remaining new reports."
        );
    } else {
        alert(
            "✅ Reports generated successfully.\n\n" +
            "Reports displayed: " + reportsToRender.length + "\n" +
            "New reports charged: " + fingerprintsToCharge.length + "\n" +
            "Total reports generated: " + reportsGenerated +
            " / " + totalAvailable
        );
    }
}


/* Comments shown on a term report: exactly what is stored on the student
   (typed in the Scores sheet, or filled once when the Scores sheet was
   uploaded in Step 2). Nothing is generated here. */
function getReportComments(student) {

    const behavior = (student && student.__behavior) || {};

    return {
        teacher: String(behavior["Class Teacher's Comment"] ?? ""),
        principal: String(behavior["Principal's Comment"] ?? "")
    };

}

/* =========================================================
   CREATE REPORT
   ========================================================= */

function createReport(student) {

    const subjects = [];


    let overallTotal =
        0;


    let subjectsToUse =
        schoolSubjects;


    const detectedSubjects =
        detectSubjectsFromRows(
            [student]
        );


    if (
        detectedSubjects.length >
        0
    ) {

        subjectsToUse =
            detectedSubjects;

    }


    /* =====================================================
       SUBJECT RESULTS
       ===================================================== */

    subjectsToUse.forEach(
        function (subjectName) {

            const firstCAKey =
                subjectName +
                " 1st CA";


            const secondCAKey =
                subjectName +
                " 2nd CA";


            const examsKey =
                subjectName +
                " Exams";


            const firstCA =
                Number(
                    student[
                        firstCAKey
                    ]
                ) || 0;


            const secondCA =
                Number(
                    student[
                        secondCAKey
                    ]
                ) || 0;


            const exams =
                Number(
                    student[
                        examsKey
                    ]
                ) || 0;


            const total =
                firstCA +
                secondCA +
                exams;


            const isFilledIn =
                function (value) {

                    return (
                        value !== undefined &&
                        value !== null &&
                        String(value).trim() !== ""
                    );

                };


            /* A subject only "counts" for a student if they actually
               have a score recorded for it. A column merely existing
               in the data (e.g. blank because the student didn't
               offer that subject) must not be treated as offered. */
            const hasSubject =

                isFilledIn(
                    student[
                        firstCAKey
                    ]
                ) ||

                isFilledIn(
                    student[
                        secondCAKey
                    ]
                ) ||

                isFilledIn(
                    student[
                        examsKey
                    ]
                );


            if (hasSubject) {

                subjects.push({

                    name:
                        subjectName,

                    firstCA:
                        firstCA,

                    secondCA:
                        secondCA,

                    exams:
                        exams,

                    total:
                        total

                });


                overallTotal +=
                    total;

            }

        }
    );


    /* =====================================================
       AVERAGE
       ===================================================== */

    const numberOfSubjects =
        subjects.length;


    const average =

        numberOfSubjects > 0

            ? overallTotal /
              numberOfSubjects

            : 0;


    const grade =
        getGrade(
            average
        );


    /* =====================================================
       POSITION FROM UPLOADED TEMPLATE
       ===================================================== */

    const positionValue =
        student[
            "Position"
        ];


    const hasPosition =
        String(
            positionValue ??
            ""
        ).trim() !== "";


    let position =
        null;


    if (hasPosition) {

        const numericPosition =
            Number(
                positionValue
            );


        if (
            !isNaN(
                numericPosition
            )
        ) {

            position =
                numericPosition;

        }

    }


    /* =====================================================
       NUMBER OF STUDENTS IN CLASS
       ===================================================== */

    const classSize =
        students.filter(
            function (student) {

                return String(
                    student[
                        "Student Name"
                    ] ||
                    ""
                ).trim() !== "";

            }
        ).length;


    /* =====================================================
       SUBJECT ROWS
       ===================================================== */

    let subjectRows =
        "";


    subjects.forEach(
        function (
            subject,
            index
        ) {

            subjectRows += `

                <tr>

                    <td>
                        ${index + 1}
                    </td>

                    <td class="subject-name">
                        ${escapeHTML(
                            subject.name
                        )}
                    </td>

                    <td>
                        ${formatScore(
                            subject.firstCA
                        )}
                    </td>

                    <td>
                        ${formatScore(
                            subject.secondCA
                        )}
                    </td>

                    <td>
                        ${formatScore(
                            subject.exams
                        )}
                    </td>

                    <td class="total-cell">
                        ${formatScore(
                            subject.total
                        )}
                    </td>

                    <td class="grade-cell">
                        ${getGrade(
                            subject.total
                        )}
                    </td>

                </tr>

            `;

        }
    );


    /* =====================================================
       BEHAVIORAL DATA
       ===================================================== */

    const behavior =
        student.__behavior ||
        {};


    /* =====================================================
       TRAIT HEADERS
       ===================================================== */

    let traitHeaders = `

        <th class="trait-title">
            TRAIT
        </th>

    `;


    behavioralTraits.forEach(
        function (trait) {

            traitHeaders += `

                <th>
                    ${escapeHTML(
                        trait
                    )}
                </th>

            `;

        }
    );


    /* =====================================================
       TRAIT RATINGS
       ===================================================== */

    let traitRatings = `

        <td class="trait-title">
            Rating
        </td>

    `;


    behavioralTraits.forEach(
        function (trait) {

            const rating =

                behavior[trait] !==
                undefined

                    ? behavior[trait]

                    : "";


            traitRatings += `

                <td class="trait-rating">

                    ${escapeHTML(
                        rating
                    )}

                </td>

            `;

        }
    );


    /* =====================================================
       COMMENTS
       ===================================================== */

    const reportComments = getReportComments(student);

    const teacherComment =
        reportComments.teacher;

    const principalComment =
        reportComments.principal;


    /* =====================================================
       HOUSE
       ===================================================== */

    const studentHouse =
        student[
            "House"
        ] || "";


    /* =====================================================
       DYNAMIC MARKING SETTINGS
       ===================================================== */

    const firstCAMax =
        Number(
            reportSettings
                .firstCAMaximum
        ) || 20;


    const secondCAMax =
        Number(
            reportSettings
                .secondCAMaximum
        ) || 20;


    const examsMax =
        Number(
            reportSettings
                .examsMaximum
        ) || 60;


    const totalMaximum =
        firstCAMax +
        secondCAMax +
        examsMax;


    /* =====================================================
       REPORT
       ===================================================== */

    return `

        <div class="report">

            <div class="school-header">

                ${
                    reportSettings.schoolLogo
                        ? `
                            <div class="school-logo-container">

                                <img
                                    src="${reportSettings.schoolLogo}"
                                    alt="School Logo"
                                    class="school-logo"
                                >

                            </div>
                          `
                        : ""
                }


                <h1>
                    ${escapeHTML(
                        reportSettings
                            .schoolName
                    )}
                </h1>

                <p>
                    ${escapeHTML(
                        reportSettings
                            .schoolAddress
                    )}
                </p>

                <h2>
                    STUDENT REPORT SHEET
                </h2>

            </div>


            <!-- STUDENT INFORMATION -->

            <div class="student-info">

                <div>

                    <strong>
                        Admission No:
                    </strong>

                    ${escapeHTML(
                        student[
                            "Admission No"
                        ] || ""
                    )}

                </div>


                <div>

                    <strong>
                        Student Name:
                    </strong>

                    ${escapeHTML(
                        student[
                            "Student Name"
                        ] || ""
                    )}

                </div>


                <div>

                    <strong>
                        Gender:
                    </strong>

                    ${escapeHTML(
                        student[
                            "Gender"
                        ] || ""
                    )}

                </div>


                <div>

                    <strong>
                        Class:
                    </strong>

                    ${escapeHTML(
                        student[
                            "Class"
                        ] || ""
                    )}

                </div>


                <div>

                    <strong>
                        House:
                    </strong>

                    ${escapeHTML(
                        studentHouse
                    )}

                </div>


                <div>

                    <strong>
                        Term:
                    </strong>

                    ${escapeHTML(
                        student[
                            "Term"
                        ] || ""
                    )}

                </div>


                <div>

                    <strong>
                        Session:
                    </strong>

                    ${escapeHTML(
                        student[
                            "Session"
                        ] || ""
                    )}

                </div>


                <div>

                    <strong>
                        Class Size:
                    </strong>

                    ${classSize}

                </div>

            </div>


            <!-- SUBJECT RESULTS -->

            <table class="result-table">

                <thead>

                    <tr>

                        <th>
                            No.
                        </th>

                        <th>
                            Subject
                        </th>

                        <th>
                            1st CA<br>
                            (${firstCAMax} mks)
                        </th>

                        <th>
                            2nd CA<br>
                            (${secondCAMax} mks)
                        </th>

                        <th>
                            Exams<br>
                            (${examsMax} mks)
                        </th>

                        <th>
                            Total<br>
                            (${totalMaximum} Mks)
                        </th>

                        <th>
                            Grade
                        </th>

                    </tr>

                </thead>


                <tbody>

                    ${subjectRows}

                </tbody>


                <tfoot>

                    <tr>

                        <th colspan="5">
                            OVERALL TOTAL
                        </th>

                        <th colspan="2">
                            ${overallTotal.toFixed(2)}
                        </th>

                    </tr>

                </tfoot>

            </table>


            <!-- SUMMARY -->

            <div class="summary">

                <p>

                    <strong>
                        Overall Total
                    </strong>

                    ${overallTotal.toFixed(2)}

                </p>


                <p>

                    <strong>
                        Average
                    </strong>

                    ${average.toFixed(2)}%

                </p>


                <p>

                    <strong>
                        Class Position
                    </strong>

                    <span class="position-value">

                        ${
                            hasPosition &&
                            position !== null

                                ? formatPosition(
                                    position
                                )

                                : ""
                        }

                    </span>

                </p>


                <p>

                    <strong>
                        Overall Grade
                    </strong>

                    ${grade}

                </p>

            </div>


            <!-- BEHAVIORAL TRAITS -->

            <div class="behavior-section">

                <h3>
                    BEHAVIORAL TRAITS
                </h3>

                <p>
                    Rating: 1 = Lowest, 5 = Highest
                </p>


                <table class="behavior-table">

                    <thead>

                        <tr>

                            ${traitHeaders}

                        </tr>

                    </thead>


                    <tbody>

                        <tr>

                            ${traitRatings}

                        </tr>

                    </tbody>

                </table>

            </div>


            <!-- COMMENTS -->

            <div class="comments">

                <p>

                    <strong>
                        Class Teacher's Comment & Signature:
                    </strong>

                </p>


                <div class="comment-box">

                    ${escapeHTML(
                        teacherComment
                    )}

                </div>


                <p>

                    <strong>
                        Principal's Comment & Signature:
                    </strong>

                </p>


                <div class="comment-box">

                    ${escapeHTML(
                        principalComment
                    )}

                </div>

            </div>

        </div>

    `;

}


/* =========================================================
   GRADING
   ========================================================= */

function getGrade(
    score
) {

    if (
        score >=
        reportSettings.gradeA
    ) {

        return "A";

    }


    if (
        score >=
        reportSettings.gradeB
    ) {

        return "B";

    }


    if (
        score >=
        reportSettings.gradeC
    ) {

        return "C";

    }


    if (
        score >=
        reportSettings.gradeD
    ) {

        return "D";

    }


    if (
        score >=
        reportSettings.gradeE
    ) {

        return "E";

    }


    return "F";

}


/* =========================================================
   GENERATE MASTER SHEET (BROADSHEET)

   One table per class. Each row shows only what was asked for:
   Student Name, Admission No, each subject's total (1st CA +
   2nd CA + Exams, same rule as createReport/calculateStudentAverage
   for excluding subjects the student doesn't offer), Overall
   Total, Average, and Position — computed per class (ranked
   against classmates only), not read from the "Position" column
   in the uploaded template.
   ========================================================= */

function getStudentSubjectTotals(student) {
    let overallTotal = 0;
    const subjectTotals = {};

    schoolSubjects.forEach(function (subject) {
        const firstCAKey = subject + " 1st CA";
        const secondCAKey = subject + " 2nd CA";
        const examsKey = subject + " Exams";

        const hasSubject =
            String(student[firstCAKey] ?? "").trim() !== "" ||
            String(student[secondCAKey] ?? "").trim() !== "" ||
            String(student[examsKey] ?? "").trim() !== "";

        if (!hasSubject) {
            subjectTotals[subject] = null;
            return;
        }

        const firstCA = Number(student[firstCAKey]) || 0;
        const secondCA = Number(student[secondCAKey]) || 0;
        const exams = Number(student[examsKey]) || 0;
        const total = firstCA + secondCA + exams;

        subjectTotals[subject] = total;
        overallTotal += total;
    });

    const numberOfSubjects = Object.keys(subjectTotals).filter(function (subject) {
        return subjectTotals[subject] !== null;
    }).length;

    const average = numberOfSubjects > 0 ? overallTotal / numberOfSubjects : 0;

    return {
        student: student,
        admissionNo: student["Admission No"] || "",
        studentName: student["Student Name"] || "",
        subjectTotals: subjectTotals,
        overallTotal: overallTotal,
        average: average
    };
}

function assignClassPositions(rows) {
    /* Standard competition ranking: equal averages share a position,
       and the next distinct average skips ahead accordingly
       (e.g. 1, 2, 2, 4). Ranked by average (not overall total) so
       students who offer fewer subjects aren't unfairly penalized. */
    const sorted = rows.slice().sort(function (a, b) {
        return b.average - a.average;
    });

    let lastAverage = null;
    let lastPosition = 0;

    sorted.forEach(function (row, index) {
        if (lastAverage === null || row.average !== lastAverage) {
            lastPosition = index + 1;
            lastAverage = row.average;
        }
        row.position = lastPosition;
    });

    return sorted;
}

function createMasterSheetHTML() {
    if (!students || students.length === 0) {
        return "<p>No student data available. Please upload an Excel file first.</p>";
    }

    /* Group students by class, preserving the order classes first appear in. */
    const classOrder = [];
    const classGroups = {};

    students.forEach(function (student) {
        const studentClass = String(student["Class"] || "").trim() || "Unassigned";

        if (!classGroups[studentClass]) {
            classGroups[studentClass] = [];
            classOrder.push(studentClass);
        }

        classGroups[studentClass].push(student);
    });

    let html = `
        <div class="master-sheet-wrapper">
            <h1 class="master-sheet-title">${escapeHTML(reportSettings.schoolName || "")} — Master Sheet</h1>
    `;

    classOrder.forEach(function (className) {
        const classStudents = classGroups[className];

        /* Only show subject columns actually offered by someone in this class. */
        const classSubjects = schoolSubjects.filter(function (subject) {
            return classStudents.some(function (student) {
                const firstCAKey = subject + " 1st CA";
                const secondCAKey = subject + " 2nd CA";
                const examsKey = subject + " Exams";
                return (
                    String(student[firstCAKey] ?? "").trim() !== "" ||
                    String(student[secondCAKey] ?? "").trim() !== "" ||
                    String(student[examsKey] ?? "").trim() !== ""
                );
            });
        });

        const rows = assignClassPositions(
            classStudents.map(getStudentSubjectTotals)
        );

        let subjectHeaderCells = "";
        classSubjects.forEach(function (subject) {
            subjectHeaderCells += `<th>${escapeHTML(subject)}</th>`;
        });

        let bodyRows = "";
        rows.forEach(function (row, index) {
            let subjectCells = "";
            classSubjects.forEach(function (subject) {
                const value = row.subjectTotals[subject];
                subjectCells += `<td>${value === null ? "-" : formatScore(value)}</td>`;
            });

            bodyRows += `
                <tr>
                    <td class="serial-cell">${index + 1}</td>
                    <td>${escapeHTML(row.admissionNo)}</td>
                    <td class="student-name-cell">${escapeHTML(row.studentName)}</td>
                    ${subjectCells}
                    <td class="total-cell">${formatScore(row.overallTotal)}</td>
                    <td>${row.average.toFixed(2)}%</td>
                    <td>${formatPosition(row.position)}</td>
                </tr>
            `;
        });

        html += `
            <section class="master-sheet-class">
                <h2 class="master-sheet-class-title">Class: ${escapeHTML(className)} (${classStudents.length} student${classStudents.length === 1 ? "" : "s"})</h2>
                <div class="master-sheet-table-scroll">
                    <table class="master-sheet-table">
                        <thead>
                            <tr>
                                <th>No.</th>
                                <th>Adm. No</th>
                                <th>Student Name</th>
                                ${subjectHeaderCells}
                                <th>Total</th>
                                <th>Average</th>
                                <th>Position</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${bodyRows}
                        </tbody>
                    </table>
                </div>
            </section>
        `;
    });

    html += `</div>`;

    return html;
}

async function generateMasterSheet() {

    if (!students || students.length === 0) {
        alert("❌ Please upload an Excel file containing student records first.");
        return;
    }

    const html = createMasterSheetHTML();

    if (reportContainer) {
        reportContainer.innerHTML = html;
        reportContainer.scrollIntoView({ behavior: "smooth" });
    }

    alert("✅ Master sheet generated successfully.");
}


/* =========================================================
   CALCULATE POSITION
   Kept for compatibility.
   The report itself reads Position directly
   from the uploaded Excel template.
   ========================================================= */

function calculatePosition(
    currentStudent,
    allStudents
) {

    const currentAverage =
        calculateStudentAverage(
            currentStudent
        );


    let position =
        1;


    allStudents.forEach(
        function (student) {

            const studentAverage =
                calculateStudentAverage(
                    student
                );


            if (
                studentAverage >
                currentAverage
            ) {

                position++;

            }

        }
    );


    return position;

}


/* =========================================================
   CALCULATE AVERAGE
   ========================================================= */

function calculateStudentAverage(
    student
) {

    let total =
        0;


    let subjectCount =
        0;


    schoolSubjects.forEach(
        function (subject) {

            const firstCA =
                Number(
                    student[
                        subject +
                        " 1st CA"
                    ]
                ) || 0;


            const secondCA =
                Number(
                    student[
                        subject +
                        " 2nd CA"
                    ]
                ) || 0;


            const exams =
                Number(
                    student[
                        subject +
                        " Exams"
                    ]
                ) || 0;


            const isFilledIn =
                function (value) {

                    return (
                        value !== undefined &&
                        value !== null &&
                        String(value).trim() !== ""
                    );

                };


            /* A subject only counts if the student actually has a
               score recorded for it, not merely because the column
               exists (which can be blank when not offered). */
            const hasSubject =

                isFilledIn(
                    student[
                        subject +
                        " 1st CA"
                    ]
                ) ||

                isFilledIn(
                    student[
                        subject +
                        " 2nd CA"
                    ]
                ) ||

                isFilledIn(
                    student[
                        subject +
                        " Exams"
                    ]
                );


            if (hasSubject) {

                total +=

                    firstCA +
                    secondCA +
                    exams;


                subjectCount++;

            }

        }
    );


    if (
        subjectCount ===
        0
    ) {

        return 0;

    }


    return (
        total /
        subjectCount
    );

}


/* =========================================================
   FORMAT POSITION
   ========================================================= */

function formatPosition(
    position
) {

    const lastTwo =
        position %
        100;


    if (
        lastTwo >= 11 &&
        lastTwo <= 13
    ) {

        return (
            position +
            "th"
        );

    }


    switch (
        position %
        10
    ) {

        case 1:

            return (
                position +
                "st"
            );


        case 2:

            return (
                position +
                "nd"
            );


        case 3:

            return (
                position +
                "rd"
            );


        default:

            return (
                position +
                "th"
            );

    }

}


/* =========================================================
   FORMAT SCORE
   ========================================================= */

function formatScore(
    score
) {

    const number =
        Number(score);


    if (
        Number.isInteger(
            number
        )
    ) {

        return String(
            number
        );

    }


    return number.toFixed(2);

}


/* =========================================================
   PAYSTACK BUTTONS
   ========================================================= */

function attachPaystackButtons() {

    const buttons =
        document.querySelectorAll(
            ".subscribe-button"
        );


    buttons.forEach(
        function (button) {

            button.addEventListener(
                "click",
                function () {

                    startPaystackPayment(
                        button
                    );

                }
            );

        }
    );

}


/* =========================================================
   START PAYSTACK
   ========================================================= */

async function startPaystackPayment(
    button
) {

    try {

        const {
            data,
            error
        } =
            await supabaseClient.auth
                .getSession();


        if (
            error ||
            !data.session
        ) {

            alert(
                "Please create an account or sign in before subscribing."
            );

            return;

        }


        const user =
            data.session.user;


        const plan =
            button.dataset.plan;


        const price =
            Number(
                button.dataset.price
            );


        const duration =
            button.dataset.duration ||
            "";

        /* CAPTURE THE UNUSED OLD BALANCE BEFORE RENEWAL */
        /* Never carry unused free-trial reports into a paid plan.
           Existing paid-subscription carry-over behavior is unchanged. */
        const renewalCarryOver = currentSubscription
            ? (isFreeTrial(currentSubscription)
                ? 0
                : getReportsRemaining(currentSubscription))
            : 0;



        if (
            !plan ||
            !price
        ) {

            alert(
                "Invalid subscription plan."
            );

            return;

        }


        if (
            typeof PaystackPop ===
            "undefined"
        ) {

            alert(
                "Paystack has not loaded."
            );

            return;

        }


        const handler =
            PaystackPop.setup({

                key:
                    PAYSTACK_PUBLIC_KEY,

                email:
                    user.email,

                amount:
                    price * 100,

                currency:
                    "NGN",


                /* =================================================
                   PAYSTACK METADATA
                   ================================================= */

                metadata: {

                    user_id:
                        user.id,

                    plan:
                        plan,

                    duration:
                        duration,

                    website_id:
                        WEBSITE_ID,

                    previous_remaining_reports:
                        renewalCarryOver

                },


                /* =================================================
                   PAYMENT CALLBACK
                   ================================================= */

                callback:
                    async function (
                        response
                    ) {

                        alert(
                            "Payment received. Verifying payment..."
                        );


                        await verifyPaystackPayment(
                            response.reference,
                            plan,
                            renewalCarryOver
                        );

                    },


                /* =================================================
                   CLOSE
                   ================================================= */

                onClose:
                    function () {

                        console.log(
                            "Paystack checkout closed."
                        );

                    }

            });


        handler.openIframe();


    } catch (error) {

        console.error(
            "Paystack start error:",
            error
        );


        alert(
            "Unable to start payment."
        );

    }

}


/* =========================================================
   VERIFY PAYSTACK PAYMENT
   ========================================================= */

async function verifyPaystackPayment(
    reference,
    plan,
    previousRemainingReports = 0
) {

    try {

        const {
            data,
            error
        } =
            await supabaseClient
                .functions
                .invoke(
                    "paystack-verification1",
                    {

                        body: {

                            reference:
                                reference,

                            plan:
                                plan,

                            website_id:
                                WEBSITE_ID,

                            previous_remaining_reports:
                                previousRemainingReports

                        }

                    }
                );


        if (error) {

            console.error(
                "Payment verification error:",
                error
            );


            alert(
                "Payment verification failed. Please contact support."
            );


            return;

        }


        if (
            data &&
            data.success
        ) {

            alert(

                "✅ Payment successful!\n\nYour " +

                plan.toUpperCase() +

                " subscription for ReportSheet is now active."

            );


            await checkLogin();


        } else {

            console.error(
                "Payment verification response:",
                data
            );


            alert(

                data &&
                data.error

                    ? data.error

                    : "Payment could not be verified."

            );

        }


    } catch (error) {

        console.error(
            "Payment verification exception:",
            error
        );


        alert(
            "An error occurred while verifying payment."
        );

    }

}


/* =========================================================
   FILE STATUS
   ========================================================= */

function setFileStatus(
    message
) {

    if (
        elementExists(
            fileStatus
        )
    ) {

        fileStatus.innerHTML =
            message;

    }

}





/* =========================================================
   HTML SECURITY
   ========================================================= */

function escapeHTML(
    value
) {

    return String(value)

        .replace(
            /&/g,
            "&amp;"
        )

        .replace(
            /</g,
            "&lt;"
        )

        .replace(
            />/g,
            "&gt;"
        )

        .replace(
            /"/g,
            "&quot;"
        )

        .replace(
            /'/g,
            "&#039;"
        );

}



/* =========================================================
   REPORT-ONLY PRINT / SAVE-TO-PDF PROTECTION

   Prints/saves ONLY the generated reports and forces each
   student report to occupy its own PDF/print page.
   ========================================================= */

let reportPrintLayer = null;
let reportPrintStyle = null;

/* =========================================================
   SHRINK-TO-FIT: force every report onto exactly one printed
   page, no matter how much content it holds. Instead of
   letting overflowing content spill onto a second page, the
   report's content is measured against the real printable
   page area and scaled down (uniformly, so nothing looks
   stretched) just enough to fit.

   This site has two @page margin rules in play (5mm from the
   injected print style below, 8mm from style.css) plus a
   print padding of 5mm vs. an on-screen padding of 10mm, so
   the more conservative (larger margin / larger padding,
   smaller usable area) numbers are used here on purpose: that
   guarantees no overflow no matter which existing rule wins.
   ========================================================= */

const MM_TO_PX = 96 / 25.4;          // CSS-spec fixed conversion (96px = 1in = 25.4mm)
const PAGE_CONTENT_HEIGHT_MM = 281;  // A4 height (297mm) minus the larger 8mm top+bottom @page margin
const REPORT_WIDTH_MM = 194;         // A4 width (210mm) minus the larger 8mm left+right @page margin
const REPORT_PAD_TOP_MM = 10;
const REPORT_PAD_BOTTOM_MM = 10;

function fitReportsToSinglePage() {
    if (!reportPrintLayer) return;

    const reports = reportPrintLayer.querySelectorAll(".report");
    if (!reports.length) return;

    const maxInnerHeightPx =
        (PAGE_CONTENT_HEIGHT_MM - REPORT_PAD_TOP_MM - REPORT_PAD_BOTTOM_MM) * MM_TO_PX;

    /* Lay the layer out for measurement without letting it flash on screen. */
    reportPrintLayer.style.display = "block";
    reportPrintLayer.style.visibility = "hidden";
    reportPrintLayer.style.position = "fixed";
    reportPrintLayer.style.top = "0";
    reportPrintLayer.style.left = "-99999px";

    reports.forEach(function (report) {
        /* Match the exact box the printed page will give this report. */
        report.style.setProperty("width", REPORT_WIDTH_MM + "mm", "important");
        report.style.setProperty("max-width", "none", "important");
        report.style.setProperty("min-height", "0", "important");
        report.style.setProperty(
            "padding",
            REPORT_PAD_TOP_MM + "mm " + REPORT_PAD_TOP_MM + "mm " + REPORT_PAD_BOTTOM_MM + "mm",
            "important"
        );
        report.style.setProperty("border", "0", "important");
        report.style.setProperty("overflow", "hidden", "important");

        /* Move the report's existing content into a scalable wrapper. */
        const inner = document.createElement("div");
        inner.className = "report-scale-wrap";
        while (report.firstChild) {
            inner.appendChild(report.firstChild);
        }
        report.appendChild(inner);

        const naturalHeightPx = inner.scrollHeight;

        if (naturalHeightPx > maxInnerHeightPx && naturalHeightPx > 0) {
            const scale = maxInnerHeightPx / naturalHeightPx;
            inner.style.transformOrigin = "top left";
            inner.style.transform = "scale(" + scale + ")";
            /* Widen before scaling so the shrink is vertical-only visually,
               keeping the report's full page width after the transform. */
            inner.style.width = (100 / scale) + "%";
            report.style.setProperty("height", PAGE_CONTENT_HEIGHT_MM + "mm", "important");
        } else {
            report.style.setProperty("height", "auto", "important");
        }
    });

    /* Hand back to the existing print styling. */
    reportPrintLayer.style.display = "";
    reportPrintLayer.style.visibility = "";
    reportPrintLayer.style.position = "";
    reportPrintLayer.style.top = "";
    reportPrintLayer.style.left = "";
}

function prepareReportsForPrint() {
    if (!reportContainer) return;

    /* Prevent duplicate print layers/styles on mobile browsers. */
    if (reportPrintLayer) {
        reportPrintLayer.remove();
        reportPrintLayer = null;
    }

    if (reportPrintStyle) {
        reportPrintStyle.remove();
        reportPrintStyle = null;
    }

    /* Copy the generated reports into a dedicated print-only layer. */
    reportPrintLayer = document.createElement("div");
    reportPrintLayer.id = "reportPrintLayer";
    reportPrintLayer.innerHTML = reportContainer.innerHTML;
    document.body.appendChild(reportPrintLayer);

    fitReportsToSinglePage();

    /*
       The print rules are injected here so this works even if the
       main stylesheet does not already contain the required rules.
       Each .report starts on a fresh A4 page and cannot be split
       between two pages where the browser supports these rules.
    */
    reportPrintStyle = document.createElement("style");
    reportPrintStyle.id = "reportPrintStyle";
    reportPrintStyle.textContent = `
        @page {
            size: A4 portrait;
            margin: 5mm;
        }

        @media print {
            html,
            body {
                width: 210mm !important;
                min-width: 0 !important;
                margin: 0 !important;
                padding: 0 !important;
                background: #fff !important;
            }

            body > * {
                display: none !important;
            }

            body > #reportPrintLayer {
                display: block !important;
                width: 100% !important;
                margin: 0 !important;
                padding: 0 !important;
                background: #fff !important;
            }

            #reportPrintLayer .report {
                display: block !important;
                width: 100% !important;
                max-width: none !important;
                margin: 0 !important;
                box-sizing: border-box !important;
                break-before: auto;
                break-after: page;
                break-inside: avoid;
                page-break-before: auto;
                page-break-after: always;
                page-break-inside: avoid;
            }

            #reportPrintLayer .report:last-child {
                break-after: auto;
                page-break-after: auto;
            }
        }
    `;

    document.head.appendChild(reportPrintStyle);
    document.documentElement.classList.add("printing-reports");
}

function restoreReportsAfterPrint() {
    document.documentElement.classList.remove("printing-reports");

    if (reportPrintLayer) {
        reportPrintLayer.remove();
        reportPrintLayer = null;
    }

    if (reportPrintStyle) {
        reportPrintStyle.remove();
        reportPrintStyle = null;
    }
}

window.addEventListener("beforeprint", prepareReportsForPrint);
window.addEventListener("afterprint", restoreReportsAfterPrint);

/* Mobile browsers are not always consistent with afterprint. */
window.addEventListener("focus", function () {
    if (document.documentElement.classList.contains("printing-reports")) {
        setTimeout(restoreReportsAfterPrint, 500);
    }
});


/* =========================================================
   END OF SCRIPT
   ========================================================= */
