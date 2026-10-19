/* =========================================================
   GOOGLE DRIVE BACKUP & RESTORE  (completed sessions only)

   Load this file AFTER script.js / scripttt.js:
       <script src="drive-backup.js"></script>

   - Backs up whole completed sessions (all terms inside them).
     You choose sessions, never terms. The current session and
     future sessions can't be selected.
   - Data saved: class lists, subject scores, attendance, the
     class names, and passport photos of the students involved.
   - Backups are JSON files in a Google Drive folder called
     "Schools Manager Backups", created by this app.
   - Restore is a safe merge: it adds / overwrites the records of
     the chosen sessions and never deletes anything. Photos are
     only restored when the student has no photo now.
   - School owner only (teachers/staff accounts don't see it).

   SETUP (once): put your Google OAuth Web Client ID below.
   ========================================================= */

(function () {
    "use strict";

    const GOOGLE_CLIENT_ID = "524818245848-j0p4gvd5f2glm4psqq8rgcn3ds7hce3c.apps.googleusercontent.com";

    const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
    const DRIVE_FOLDER_NAME = "Schools manager Backups";
    const BACKUP_APP_TAG = "student-report-backup";
    const BACKUP_VERSION = 1;
    const PAGE = 1000;
    const CHUNK = 500;

    /* table -> column holding the owner's id, and the upsert conflict key */
    const TABLES = {
        class_students: { owner: "owner_user_id", conflict: "owner_user_id,website_id,class_name,session,match_key" },
        subject_scores: { owner: "user_id", conflict: "user_id,website_id,class_name,session,term,subject,match_key" },
        class_attendance: { owner: "owner_user_id", conflict: "owner_user_id,website_id,class_name,session,term,match_key" }
    };

    let accessToken = "";
    let tokenExpiry = 0;
    let tokenClient = null;
    let busy = false;
    let modal = null;
    let driveBackups = [];     /* list shown in the Restore tab */
    let loadedBackup = null;   /* { file, data } picked for restore */

    /* ------------------------------------------------------
       Small helpers
       ------------------------------------------------------ */
    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function isOwner() { return typeof staffContext === "undefined" || !staffContext; }
    function inAndroidApp() { return typeof IS_ANDROID_APP !== "undefined" && IS_ANDROID_APP; }

    function currentStartYear() {
        const now = new Date();
        return now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    }

    /* "2024/2025" is completed when it started before the current session. */
    function isCompletedSession(session) {
        const m = /^(\d{4})\/(\d{4})$/.exec(String(session || "").trim());
        if (!m) return false;
        const start = Number(m[1]);
        return Number(m[2]) === start + 1 && start < currentStartYear();
    }

    function completedSessionList() {
        const first = typeof SESSION_LIST_START_YEAR !== "undefined" ? SESSION_LIST_START_YEAR : 2020;
        const list = [];
        for (let y = currentStartYear() - 1; y >= first; y--) list.push(y + "/" + (y + 1));
        return list;
    }

    function chunks(rows, size) {
        const out = [];
        for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
        return out;
    }

    /* ------------------------------------------------------
       Google sign-in (Google Identity Services, token flow)
       ------------------------------------------------------ */
    function loadGoogleScript() {
        if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
        return new Promise(function (resolve, reject) {
            const existing = document.getElementById("gsi-client-script");
            if (existing) { existing.addEventListener("load", resolve); existing.addEventListener("error", reject); return; }
            const s = document.createElement("script");
            s.id = "gsi-client-script";
            s.src = "https://accounts.google.com/gsi/client";
            s.async = true;
            s.onload = resolve;
            s.onerror = function () { reject(new Error("Could not load Google sign-in. Check your internet connection.")); };
            document.head.appendChild(s);
        });
    }

    /* Must run straight from a click (before other awaits) so the popup isn't blocked. */
    function getAccessToken() {
        if (accessToken && Date.now() < tokenExpiry - 60000) return Promise.resolve(accessToken);
        if (!(window.google && google.accounts && google.accounts.oauth2)) {
            return Promise.reject(new Error("Google sign-in is still loading. Try again in a moment."));
        }
        return new Promise(function (resolve, reject) {
            if (!tokenClient) {
                tokenClient = google.accounts.oauth2.initTokenClient({
                    client_id: GOOGLE_CLIENT_ID,
                    scope: DRIVE_SCOPE,
                    callback: function () { }
                });
            }
            tokenClient.callback = function (resp) {
                if (resp && resp.access_token) {
                    accessToken = resp.access_token;
                    tokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
                    resolve(accessToken);
                } else {
                    reject(new Error((resp && resp.error_description) || "Google sign-in was not completed."));
                }
            };
            tokenClient.error_callback = function (err) {
                reject(new Error(err && err.type === "popup_closed" ? "Google sign-in was closed." : "Google sign-in failed."));
            };
            tokenClient.requestAccessToken({ prompt: accessToken ? "" : "select_account" });
        });
    }

    /* ------------------------------------------------------
       Google Drive calls
       ------------------------------------------------------ */
    async function driveFetch(url, options) {
        const res = await fetch(url, Object.assign({}, options, {
            headers: Object.assign({ Authorization: "Bearer " + accessToken }, (options && options.headers) || {})
        }));
        if (res.status === 401) { accessToken = ""; throw new Error("Google session expired. Please try again."); }
        if (!res.ok) {
            let detail = "";
            try { detail = (await res.json()).error.message; } catch (e) { /* ignore */ }
            throw new Error("Google Drive error (" + res.status + ")" + (detail ? ": " + detail : ""));
        }
        return res;
    }

    async function findOrCreateFolder(createIfMissing) {
        const q = encodeURIComponent("name='" + DRIVE_FOLDER_NAME + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
        const found = await (await driveFetch("https://www.googleapis.com/drive/v3/files?fields=files(id)&q=" + q)).json();
        if (found.files && found.files.length) return found.files[0].id;
        if (!createIfMissing) return null;
        const created = await (await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
        })).json();
        return created.id;
    }

    async function uploadBackupFile(folderId, name, json, sessions, counts) {
        const boundary = "bk" + Date.now();
        const metadata = {
            name: name, parents: [folderId], mimeType: "application/json",
            appProperties: {
                app: BACKUP_APP_TAG,
                website: String(WEBSITE_ID),
                sessions: sessions.join(","),
                students: String(counts.students || 0)
            }
        };
        const body =
            "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(metadata) +
            "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + json +
            "\r\n--" + boundary + "--";
        return (await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name", {
            method: "POST",
            headers: { "Content-Type": "multipart/related; boundary=" + boundary },
            body: body
        })).json();
    }

    async function listBackupFiles() {
        const folderId = await findOrCreateFolder(false);
        if (!folderId) return [];
        const q = encodeURIComponent("'" + folderId + "' in parents and trashed=false");
        const url = "https://www.googleapis.com/drive/v3/files?pageSize=50&orderBy=createdTime desc" +
            "&fields=files(id,name,createdTime,size,appProperties)&q=" + q;
        const data = await (await driveFetch(url)).json();
        return (data.files || []).filter(function (f) {
            return f.appProperties && f.appProperties.app === BACKUP_APP_TAG;
        });
    }

    async function downloadBackupFile(fileId) {
        const res = await driveFetch("https://www.googleapis.com/drive/v3/files/" + fileId + "?alt=media");
        return res.json();
    }

    /* ------------------------------------------------------
       Reading from / writing to Supabase
       ------------------------------------------------------ */
    async function fetchAll(table, ownerColumn, sessions) {
        const rows = [];
        for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabaseClient
                .from(table).select("*")
                .eq(ownerColumn, currentUserId)
                .eq("website_id", WEBSITE_ID)
                .in("session", sessions)
                .order("session", { ascending: true })
                .range(from, from + PAGE - 1);
            if (error) throw new Error("Could not read " + table + ": " + error.message);
            (data || []).forEach(function (r) { rows.push(r); });
            if (!data || data.length < PAGE) break;
        }
        return rows;
    }

    async function countRows(table, ownerColumn, session) {
        const { count, error } = await supabaseClient
            .from(table).select("*", { count: "exact", head: true })
            .eq(ownerColumn, currentUserId)
            .eq("website_id", WEBSITE_ID)
            .eq("session", session);
        return error ? 0 : (count || 0);
    }

    async function fetchPhotos(keys) {
        const wanted = new Set(keys);
        const out = [];
        if (!wanted.size) return out;
        for (let from = 0; ; from += 100) {
            const { data, error } = await supabaseClient
                .from("student_photos").select("photo_key, photo_data")
                .eq("owner_user_id", currentUserId).eq("website_id", WEBSITE_ID)
                .order("photo_key", { ascending: true }).range(from, from + 99);
            if (error) return out;   /* photos are optional */
            (data || []).forEach(function (r) {
                if (r.photo_data && wanted.has(String(r.photo_key))) out.push({ photo_key: r.photo_key, photo_data: r.photo_data });
            });
            if (!data || data.length < 100) break;
        }
        return out;
    }

    function photoKeyFor(row) {
        if (typeof studentPhotoKey !== "function") return "";
        return studentPhotoKey(row.admission_no, row.student_name);
    }

    async function buildBackup(sessions, onProgress) {
        const tables = {};
        for (const table of Object.keys(TABLES)) {
            onProgress("Reading " + table.replace("_", " ") + "…");
            tables[table] = await fetchAll(table, TABLES[table].owner, sessions);
        }

        const classNames = new Set();
        Object.keys(tables).forEach(function (t) {
            tables[t].forEach(function (r) { if (r.class_name) classNames.add(r.class_name); });
        });

        onProgress("Reading student photos…");
        const photoKeys = new Set();
        ["class_students", "subject_scores", "class_attendance"].forEach(function (t) {
            tables[t].forEach(function (r) { const k = photoKeyFor(r); if (k) photoKeys.add(k); });
        });
        const photos = await fetchPhotos(Array.from(photoKeys));

        return {
            app: BACKUP_APP_TAG,
            version: BACKUP_VERSION,
            website_id: WEBSITE_ID,
            created_at: new Date().toISOString(),
            sessions: sessions,
            class_names: Array.from(classNames),
            tables: tables,
            student_photos: photos
        };
    }

    function prepareRows(table, rows, sessionsAllowed) {
        const ownerColumn = TABLES[table].owner;
        return rows
            .filter(function (r) { return r && sessionsAllowed.has(r.session) && isCompletedSession(r.session); })
            .map(function (r) {
                const copy = Object.assign({}, r);
                delete copy.id;
                copy[ownerColumn] = currentUserId;
                copy.website_id = WEBSITE_ID;
                return copy;
            });
    }

    async function restoreBackup(data, sessions, onProgress) {
        const allowed = new Set(sessions.filter(isCompletedSession));
        const summary = { rows: 0, photos: 0, classes: 0 };

        /* 1. make sure the class names exist in the school's class list */
        const have = new Set((typeof schoolClasses !== "undefined" ? schoolClasses : [])
            .map(function (c) { return typeof normalizeClassKey === "function" ? normalizeClassKey(c.class_name) : c.class_name; }));
        const used = new Set();
        Object.keys(TABLES).forEach(function (t) {
            ((data.tables && data.tables[t]) || []).forEach(function (r) { if (allowed.has(r.session) && r.class_name) used.add(r.class_name); });
        });
        const missing = [];
        used.forEach(function (name) {
            const key = typeof normalizeClassKey === "function" ? normalizeClassKey(name) : name;
            if (!have.has(key)) { have.add(key); missing.push({ user_id: currentUserId, website_id: WEBSITE_ID, class_name: name }); }
        });
        if (missing.length) {
            onProgress("Restoring class names…");
            const { error } = await supabaseClient.from("school_classes").insert(missing);
            if (error) throw new Error("Could not restore class names: " + error.message);
            summary.classes = missing.length;
        }

        /* 2. the session records, class list first */
        for (const table of ["class_students", "subject_scores", "class_attendance"]) {
            const rows = prepareRows(table, (data.tables && data.tables[table]) || [], allowed);
            let done = 0;
            for (const part of chunks(rows, CHUNK)) {
                onProgress("Restoring " + table.replace("_", " ") + " (" + done + "/" + rows.length + ")…");
                const { error } = await supabaseClient.from(table).upsert(part, { onConflict: TABLES[table].conflict });
                if (error) throw new Error("Restore stopped at " + table + ": " + error.message);
                done += part.length;
            }
            summary.rows += rows.length;
        }

        /* 3. photos only for students who have none now */
        const photos = Array.isArray(data.student_photos) ? data.student_photos : [];
        if (photos.length) {
            onProgress("Restoring student photos…");
            const existing = new Set();
            for (let from = 0; ; from += 1000) {
                const { data: keys, error } = await supabaseClient
                    .from("student_photos").select("photo_key")
                    .eq("owner_user_id", currentUserId).eq("website_id", WEBSITE_ID)
                    .order("photo_key", { ascending: true }).range(from, from + 999);
                if (error) break;
                (keys || []).forEach(function (r) { existing.add(String(r.photo_key)); });
                if (!keys || keys.length < 1000) break;
            }
            const now = new Date().toISOString();
            const toAdd = photos.filter(function (p) { return p.photo_key && p.photo_data && !existing.has(String(p.photo_key)); })
                .map(function (p) {
                    return {
                        owner_user_id: currentUserId, website_id: WEBSITE_ID,
                        photo_key: p.photo_key, photo_data: p.photo_data,
                        updated_by: currentUserId, updated_at: now
                    };
                });
            for (const part of chunks(toAdd, 50)) {
                const { error } = await supabaseClient.from("student_photos")
                    .upsert(part, { onConflict: "owner_user_id,website_id,photo_key" });
                if (error) break;
                summary.photos += part.length;
            }
        }
        return summary;
    }

    /* ------------------------------------------------------
       Screen
       ------------------------------------------------------ */
    function injectStyles() {
        if (document.getElementById("drive-backup-styles")) return;
        const style = document.createElement("style");
        style.id = "drive-backup-styles";
        style.textContent =
            "#driveBackupButton{position:fixed!important;right:10px!important;left:auto!important;bottom:14px;width:auto!important;min-width:0!important;max-width:none!important;display:inline-block!important;margin:0!important;z-index:9998;padding:6px 10px;border:0;border-radius:20px;" +
            "background:#1a73e8;color:#fff;font:600 12px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer}" +
            "#driveBackupOverlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:12px}" +
            "#driveBackupBox{background:#fff;color:#222;width:100%;max-width:480px;max-height:90vh;overflow:auto;border-radius:12px;padding:16px;font:14px system-ui,sans-serif}" +
            "#driveBackupBox h3{margin:0 0 4px;font-size:18px}#driveBackupBox .db-sub{color:#555;margin:0 0 12px}" +
            "#driveBackupBox .db-tabs{display:flex;gap:8px;margin-bottom:12px}" +
            "#driveBackupBox .db-tab{flex:1;padding:8px;border:1px solid #1a73e8;border-radius:8px;background:#fff;color:#1a73e8;font-weight:600;cursor:pointer}" +
            "#driveBackupBox .db-tab.on{background:#1a73e8;color:#fff}" +
            "#driveBackupBox label.db-row{display:flex;gap:8px;align-items:center;padding:8px;border:1px solid #ddd;border-radius:8px;margin-bottom:6px}" +
            "#driveBackupBox label.db-row.off{opacity:.5}#driveBackupBox .db-meta{color:#666;font-size:12px}" +
            "#driveBackupBox .db-go{width:100%;padding:12px;border:0;border-radius:8px;background:#1a73e8;color:#fff;font-weight:700;margin-top:8px;cursor:pointer}" +
            "#driveBackupBox .db-go.db-alt{background:#fff;color:#1a73e8;border:1px solid #1a73e8}#driveBackupBox .db-go.db-alt:disabled{background:#fff;color:#9ab;border-color:#9ab}" +
            "#driveBackupBox .db-go:disabled{background:#9ab}#driveBackupBox .db-close{width:100%;padding:10px;border:0;background:none;color:#555;cursor:pointer;margin-top:4px}" +
            "#driveBackupBox .db-status{margin-top:10px;padding:8px;border-radius:8px;background:#f1f3f4;white-space:pre-wrap}" +
            "#driveBackupBox .db-status.err{background:#fde8e8;color:#a00}#driveBackupBox .db-status.ok{background:#e6f4ea;color:#0a5}";
        document.head.appendChild(style);
    }

    function setStatus(text, kind) {
        const el = modal && modal.querySelector(".db-status");
        if (!el) return;
        el.textContent = text || "";
        el.className = "db-status" + (kind ? " " + kind : "");
        el.style.display = text ? "block" : "none";
    }

    function close() { if (modal) { modal.remove(); modal = null; } loadedBackup = null; }

    function open() {
        if (!isOwner()) { alert("Only the school owner can back up or restore data."); return; }
        if (typeof currentUserId === "undefined" || !currentUserId) { alert("Please sign in first."); return; }
        if (inAndroidApp()) {
            alert("Google sign-in is blocked inside the Android app. Please use the website to back up or restore.");
            return;
        }
        if (GOOGLE_CLIENT_ID.indexOf("PASTE_") === 0) { alert("Google Drive backup is not set up yet (missing Google Client ID)."); return; }

        injectStyles();
        close();
        modal = document.createElement("div");
        modal.id = "driveBackupOverlay";
        modal.innerHTML =
            '<div id="driveBackupBox"><h3>☁ Google Drive Backup</h3>' +
            '<p class="db-sub">Completed sessions only. Each session includes all its terms.</p>' +
            '<div class="db-tabs"><button class="db-tab on" data-tab="backup">Backup</button>' +
            '<button class="db-tab" data-tab="restore">Restore</button></div>' +
            '<div id="dbBody"></div><div class="db-status" style="display:none"></div>' +
            '<button class="db-close">Close</button></div>';
        document.body.appendChild(modal);
        modal.querySelector(".db-close").onclick = close;
        modal.addEventListener("click", function (e) { if (e.target === modal && !busy) close(); });
        modal.querySelectorAll(".db-tab").forEach(function (b) {
            b.onclick = function () {
                if (busy) return;
                modal.querySelectorAll(".db-tab").forEach(function (x) { x.classList.toggle("on", x === b); });
                setStatus("");
                loadedBackup = null;
                b.dataset.tab === "backup" ? showBackupTab() : showRestoreTab();
            };
        });
        loadGoogleScript().catch(function (e) { setStatus(e.message, "err"); }); /* preload so the popup isn't blocked */
        showBackupTab();
    }

    /* ---- Backup tab ---- */
    async function showBackupTab() {
        const body = modal.querySelector("#dbBody");
        body.innerHTML = '<p class="db-meta">Checking your completed sessions…</p>';
        const sessions = completedSessionList();
        if (!sessions.length) { body.innerHTML = '<p>No completed session yet. The current session can be backed up once it ends.</p>'; return; }

        const info = await Promise.all(sessions.map(async function (s) {
            const counts = await Promise.all(Object.keys(TABLES).map(function (t) { return countRows(t, TABLES[t].owner, s); }));
            return { session: s, students: counts[0], scores: counts[1], attendance: counts[2] };
        }));
        if (!modal) return;

        const withData = info.filter(function (i) { return i.students + i.scores + i.attendance > 0; });
        if (!withData.length) { body.innerHTML = '<p>No saved records were found in completed sessions.</p>'; return; }

        body.innerHTML = withData.map(function (i) {
            return '<label class="db-row"><input type="checkbox" class="db-s" value="' + esc(i.session) + '" checked>' +
                '<div><strong>' + esc(i.session) + '</strong><div class="db-meta">' + i.students + ' students · ' +
                i.scores + ' score rows · ' + i.attendance + ' attendance rows</div></div></label>';
        }).join("") + '<button class="db-go" id="dbBackupGo">Back up to Google Drive</button>';

        modal.querySelector("#dbBackupGo").onclick = runBackup;
    }

    async function runBackup() {
        if (busy) return;
        const picked = Array.from(modal.querySelectorAll(".db-s:checked")).map(function (c) { return c.value; }).filter(isCompletedSession);
        if (!picked.length) { setStatus("Select at least one session.", "err"); return; }

        busy = true;
        const btn = modal.querySelector("#dbBackupGo");
        btn.disabled = true;
        try {
            setStatus("Signing in to Google…");
            await getAccessToken();                       /* first await: still inside the click */
            const data = await buildBackup(picked, setStatus);
            const students = (data.tables.class_students || []).length;
            const total = Object.keys(data.tables).reduce(function (n, t) { return n + data.tables[t].length; }, 0);
            if (!total) throw new Error("Nothing to back up for the chosen sessions.");

            setStatus("Uploading to Google Drive…");
            const folderId = await findOrCreateFolder(true);
            const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
            const name = "backup_" + WEBSITE_ID + "_" + picked.map(function (s) { return s.replace("/", "-"); }).join("_") + "_" + stamp + ".json";
            await uploadBackupFile(folderId, name, JSON.stringify(data), picked, { students: students });
            setStatus("✔ Backup saved to Google Drive\n" + name + "\n" + total + " records, " + data.student_photos.length + " photos.", "ok");
        } catch (e) {
            setStatus("✖ " + (e && e.message ? e.message : "Backup failed."), "err");
        } finally {
            busy = false;
            if (btn) btn.disabled = false;
        }
    }

    /* ---- Restore tab ---- */
    async function showRestoreTab() {
        const body = modal.querySelector("#dbBody");
        body.innerHTML = '<button class="db-go" id="dbListGo">Sign in to Google and list my backups</button>';
        modal.querySelector("#dbListGo").onclick = async function () {
            if (busy) return;
            busy = true;
            try {
                setStatus("Signing in to Google…");
                await getAccessToken();
                setStatus("Finding your backups…");
                driveBackups = await listBackupFiles();
                setStatus("");
                renderBackupList();
            } catch (e) {
                setStatus("✖ " + (e && e.message ? e.message : "Could not list backups."), "err");
            } finally { busy = false; }
        };
    }

    function renderBackupList() {
        const body = modal.querySelector("#dbBody");
        if (!driveBackups.length) { body.innerHTML = '<p>No backups were found in your Google Drive.</p>'; return; }
        body.innerHTML = driveBackups.map(function (f, i) {
            const p = f.appProperties || {};
            const when = f.createdTime ? new Date(f.createdTime).toLocaleString() : "";
            return '<label class="db-row"><input type="radio" name="dbFile" value="' + i + '">' +
                '<div><strong>' + esc((p.sessions || "").split(",").join(", ")) + '</strong>' +
                '<div class="db-meta">' + esc(when) + ' · ' + esc(p.students || "?") + ' students' +
                (p.website && p.website !== String(WEBSITE_ID) ? ' · from ' + esc(p.website) : '') + '</div></div></label>';
        }).join("") + '<button class="db-go" id="dbLoadGo">Open selected backup</button>';
        modal.querySelector("#dbLoadGo").onclick = loadSelectedBackup;
    }

    async function loadSelectedBackup() {
        if (busy) return;
        const radio = modal.querySelector('input[name="dbFile"]:checked');
        if (!radio) { setStatus("Choose a backup first.", "err"); return; }
        busy = true;
        try {
            setStatus("Downloading backup…");
            await getAccessToken();
            const file = driveBackups[Number(radio.value)];
            const data = await downloadBackupFile(file.id);
            if (!data || data.app !== BACKUP_APP_TAG || !data.tables) throw new Error("This is not a valid backup file.");
            const sessions = (data.sessions || []).filter(isCompletedSession);
            if (!sessions.length) throw new Error("This backup has no completed sessions to restore.");
            loadedBackup = { file: file, data: data, sessions: sessions };
            setStatus("");
            renderRestoreChoice();
        } catch (e) {
            setStatus("✖ " + (e && e.message ? e.message : "Could not open the backup."), "err");
        } finally { busy = false; }
    }

    function renderRestoreChoice() {
        const body = modal.querySelector("#dbBody");
        const d = loadedBackup.data;
        body.innerHTML = '<p class="db-meta">Choose which sessions to restore:</p>' +
            loadedBackup.sessions.map(function (s) {
                const n = Object.keys(TABLES).reduce(function (sum, t) {
                    return sum + ((d.tables[t] || []).filter(function (r) { return r.session === s; }).length);
                }, 0);
                return '<label class="db-row"><input type="checkbox" class="db-r" value="' + esc(s) + '" checked>' +
                    '<div><strong>' + esc(s) + '</strong><div class="db-meta">' + n + ' records</div></div></label>';
            }).join("") +
            '<button class="db-go db-alt" id="dbExcelGo">View as Excel (readable copy)</button>' +
            '<button class="db-go" id="dbRestoreGo">Restore selected sessions</button>';
        modal.querySelector("#dbExcelGo").onclick = downloadReadableCopy;
        modal.querySelector("#dbRestoreGo").onclick = runRestore;
    }

    /* ---- Readable Excel copy of a backup (viewing only) ---- */
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

    function buildReadableWorkbook(data, sessions) {
        const keep = new Set(sessions);
        const rows = function (t) {
            return ((data.tables && data.tables[t]) || []).filter(function (r) { return keep.has(r.session); });
        };
        const text = function (a, b) {
            return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
        };
        const termRank = function (t) {
            const i = ["First Term", "Second Term", "Third Term"].indexOf(t);
            return i === -1 ? 9 : i;
        };
        const num = function (v) { return v === null || v === undefined || v === "" ? "" : Number(v); };

        const students = rows("class_students").sort(function (a, b) {
            return text(a.session, b.session) || text(a.class_name, b.class_name) ||
                ((a.sort_order || 0) - (b.sort_order || 0)) || text(a.student_name, b.student_name);
        });
        const scores = rows("subject_scores").sort(function (a, b) {
            return text(a.session, b.session) || text(a.class_name, b.class_name) ||
                (termRank(a.term) - termRank(b.term)) || text(a.subject, b.subject) || text(a.student_name, b.student_name);
        });
        const attendance = rows("class_attendance").sort(function (a, b) {
            return text(a.session, b.session) || text(a.class_name, b.class_name) ||
                (termRank(a.term) - termRank(b.term)) || text(a.student_name, b.student_name);
        });

        /* Summary: one line per session + class */
        const groups = {};
        const group = function (r) {
            const key = r.session + "|" + r.class_name;
            return groups[key] || (groups[key] = { session: r.session, className: r.class_name, students: 0, subjects: new Set(), terms: new Set() });
        };
        students.forEach(function (r) { group(r).students++; });
        scores.forEach(function (r) { const g = group(r); if (r.subject) g.subjects.add(r.subject); if (r.term) g.terms.add(r.term); });
        attendance.forEach(function (r) { group(r); });

        const summary = [
            ["Schools Manager backup - readable copy"],
            ["This file is for viewing only. To restore data, use the backup in Google Drive."],
            [],
            ["Backup created", data.created_at ? new Date(data.created_at).toLocaleString() : ""],
            ["Sessions", sessions.join(", ")],
            [],
            ["Session", "Class", "Students", "Subjects", "Terms with scores"]
        ];
        Object.keys(groups).sort().forEach(function (k) {
            const g = groups[k];
            summary.push([g.session, g.className, g.students, g.subjects.size,
                Array.from(g.terms).sort(function (a, b) { return termRank(a) - termRank(b); }).join(", ")]);
        });

        const classLists = [["Session", "Class", "Admission No", "Student Name", "Gender", "House"]].concat(
            students.map(function (r) { return [r.session, r.class_name, r.admission_no || "", r.student_name || "", r.gender || "", r.house || ""]; }));

        const scoreSheet = [["Session", "Term", "Class", "Subject", "Admission No", "Student Name", "1st CA", "2nd CA", "Exams", "Total"]].concat(
            scores.map(function (r) {
                const parts = [num(r.first_ca), num(r.second_ca), num(r.exams)].filter(function (v) { return v !== ""; });
                const total = parts.length ? parts.reduce(function (a, b) { return a + b; }, 0) : "";
                return [r.session, r.term || "", r.class_name, r.subject || "", r.admission_no || "", r.student_name || "",
                    num(r.first_ca), num(r.second_ca), num(r.exams), total];
            }));

        const attendanceSheet = [["Session", "Term", "Class", "Admission No", "Student Name", "Days Present", "Days Opened"]].concat(
            attendance.map(function (r) {
                return [r.session, r.term || "", r.class_name, r.admission_no || "", r.student_name || "", num(r.days_present), num(r.days_opened)];
            }));

        const wb = XLSX.utils.book_new();
        const add = function (name, aoa, widths) {
            const ws = XLSX.utils.aoa_to_sheet(aoa);
            ws["!cols"] = widths.map(function (w) { return { wch: w }; });
            XLSX.utils.book_append_sheet(wb, ws, name);
        };
        add("Summary", summary, [16, 22, 12, 12, 34]);
        add("Class Lists", classLists, [12, 20, 16, 32, 10, 14]);
        add("Scores", scoreSheet, [12, 12, 20, 22, 16, 32, 8, 8, 8, 8]);
        add("Attendance", attendanceSheet, [12, 12, 20, 16, 32, 14, 12]);
        return wb;
    }

    async function downloadReadableCopy() {
        if (busy || !loadedBackup) return;
        const picked = Array.from(modal.querySelectorAll(".db-r:checked")).map(function (c) { return c.value; }).filter(isCompletedSession);
        if (!picked.length) { setStatus("Select at least one session.", "err"); return; }

        busy = true;
        const btn = modal.querySelector("#dbExcelGo");
        btn.disabled = true;
        try {
            setStatus("Preparing Excel file…");
            await loadXlsxLibrary();
            const wb = buildReadableWorkbook(loadedBackup.data, picked);
            const bytes = XLSX.write(wb, { bookType: "xlsx", type: "array" });
            const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
            const name = "Backup_" + picked.map(function (s) { return s.replace("/", "-"); }).join("_") + ".xlsx";
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = name;
            document.body.appendChild(link);
            link.click();
            setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 2000);
            setStatus("✔ Excel file downloaded\n" + name + "\nNothing was restored.", "ok");
        } catch (e) {
            setStatus("✖ " + (e && e.message ? e.message : "Could not create the Excel file."), "err");
        } finally {
            busy = false;
            if (btn) btn.disabled = false;
        }
    }

    async function runRestore() {
        if (busy || !loadedBackup) return;
        const picked = Array.from(modal.querySelectorAll(".db-r:checked")).map(function (c) { return c.value; }).filter(isCompletedSession);
        if (!picked.length) { setStatus("Select at least one session.", "err"); return; }
        if (!confirm("Restore " + picked.join(", ") + "?\n\nRecords in these sessions that are also in the backup will be replaced by the backup's version. Nothing is deleted.")) return;

        busy = true;
        const btn = modal.querySelector("#dbRestoreGo");
        btn.disabled = true;
        try {
            const summary = await restoreBackup(loadedBackup.data, picked, setStatus);
            if (typeof fetchSchoolClasses === "function") { try { await fetchSchoolClasses(); } catch (e) { /* ignore */ } }
            setStatus("✔ Restore complete\n" + summary.rows + " records restored" +
                (summary.classes ? ", " + summary.classes + " class name(s) re-added" : "") +
                (summary.photos ? ", " + summary.photos + " photo(s) added" : "") +
                ".\nReload the page to see the data.", "ok");
        } catch (e) {
            setStatus("✖ " + (e && e.message ? e.message : "Restore failed."), "err");
        } finally {
            busy = false;
            if (btn) btn.disabled = false;
        }
    }

    /* ------------------------------------------------------
       Floating button (hidden for staff accounts)
       ------------------------------------------------------ */
    function addButton() {
        if (document.getElementById("driveBackupButton")) return;
        injectStyles();
        const b = document.createElement("button");
        b.id = "driveBackupButton";
        b.type = "button";
        b.textContent = "☁ Drive Backup";
        b.onclick = open;
        document.body.appendChild(b);
        setInterval(function () { b.style.display = isOwner() ? "" : "none"; }, 1500);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButton);
    else addButton();

    /* Call DriveBackup.open() from your own button if you prefer. */
    window.DriveBackup = { open: open, isCompletedSession: isCompletedSession };
})();
