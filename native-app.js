(function () {
  var C = window.Capacitor;
  if (!(C && C.isNativePlatform && C.isNativePlatform())) return;

  function plugin(n) { return C.Plugins && C.Plugins[n]; }

  function toBase64(blob) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onloadend = function () {
        var s = String(r.result || "");
        res(s.slice(s.indexOf(",") + 1));
      };
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }

  function guessName(blob) {
    var t = (blob.type || "").toLowerCase();
    if (t.indexOf("pdf") > -1) return "document.pdf";
    if (t.indexOf("spreadsheetml") > -1) return "spreadsheet.xlsx";
    if (t.indexOf("csv") > -1) return "data.csv";
    if (t.indexOf("html") > -1) return "page.html";
    if (t.indexOf("png") > -1) return "image.png";
    if (t.indexOf("jpeg") > -1) return "image.jpg";
    return "file";
  }

  async function saveNative(href, name) {
    try {
      var FS = plugin("Filesystem"), SH = plugin("Share");
      if (!FS || !SH) {
        alert("Filesystem/Share plugin not found in this app build.");
        return;
      }
      var blob = await (await fetch(href)).blob();
      var fileName = (name || guessName(blob)).replace(/[\\/:*?"<>|]+/g, "_");
      var data = await toBase64(blob);
      var saved = await FS.writeFile({ path: fileName, data: data, directory: "CACHE" });
      await SH.share({ title: fileName, url: saved.uri, dialogTitle: "Save or share " + fileName });
    } catch (e) {
      var m = String((e && e.message) || e);
      if (/cancel/i.test(m)) return;
      alert("Could not save file: " + m);
    }
  }
  window.saveFileNative = saveNative;

  /* programmatic link.click() downloads (templates, Excel, receipts) */
  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.hasAttribute("download") && this.href) {
      saveNative(this.href, this.getAttribute("download"));
      return;
    }
    return origClick.apply(this, arguments);
  };

  /* real taps on download links */
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[download]") : null;
    if (a && a.href) {
      e.preventDefault();
      e.stopPropagation();
      saveNative(a.href, a.getAttribute("download"));
    }
  }, true);

  /* window.open(blob/data) */
  var origOpen = window.open;
  window.open = function (url) {
    if (url && /^(blob:|data:)/i.test(String(url))) {
      saveNative(String(url), "");
      return null;
    }
    return origOpen.apply(window, arguments);
  };

  /* print -> Android print dialog (has "Save as PDF") */
  window.print = function () {
    var P = plugin("AppPrint");
    if (!P) { alert("Print needs the latest app build."); return; }
    P.print({ name: document.title || "School Administrator" })
      .catch(function (e) { alert("Print failed: " + ((e && e.message) || e)); });
  };
})();