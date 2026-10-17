/**
 * THE SNIPPET'S SCRIPT (0.3): the beacon for a website that is not this app —
 * a company's own site on Wix, WordPress, Squarespace or plain HTML. The
 * company pastes one line:
 *
 *   <script async src="https://app.example.com/api/w/v1/beacon.js" data-site="aws_…"></script>
 *
 * and the public handlers serve this file at that address. It does what
 * `<AnalyticsBeacon>` does, without React: a page view on load and on every
 * in-page navigation, the foreground time as the visitor leaves, and clicks on
 * outbound, mail and phone links and on anything marked `data-track`. It
 * sends to `collect?site=…` beside itself, where the key names the website
 * and the page's address must be one of that website's.
 *
 * What it never does: set a cookie or use storage (beyond reading the opt-out
 * switch), read a form, send a query string past the first page view (the
 * server reads UTM tags from it and drops it), or send the referrer's path.
 * It sends nothing under Global Privacy Control, Do Not Track, automation
 * (`navigator.webdriver`) or the visitor's own opt-out (`?analytics=off`).
 * No Core Web Vitals: the measuring library is not loaded on someone else's
 * site.
 *
 * Plain ES5-safe JavaScript in one string, so it runs on any site.
 */
export const BEACON_SCRIPT = `(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || !script.src) return;
  var key = script.getAttribute("data-site") || "";
  if (!/^aws_[A-Za-z0-9]{24}$/.test(key)) return;
  var endpoint;
  try { endpoint = new URL("collect?site=" + encodeURIComponent(key), script.src).toString(); } catch (e) { return; }
  var OPT_OUT = "adminigloo:analytics-off";
  try {
    var flag = new URLSearchParams(location.search).get("analytics");
    if (flag === "off") localStorage.setItem(OPT_OUT, "1");
    else if (flag === "on") localStorage.removeItem(OPT_OUT);
  } catch (e) {}
  var optedOut = false;
  try { optedOut = localStorage.getItem(OPT_OUT) === "1"; } catch (e) {}
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === "1" || navigator.webdriver || optedOut) return;
  if (window.__aigBeacon) return;
  window.__aigBeacon = true;

  var bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  var doc = "";
  for (var i = 0; i < bytes.length; i++) doc += ("0" + bytes[i].toString(36)).slice(-2);
  doc = doc.slice(0, 20);
  var first = true, lastPath = null, visibleSince = document.visibilityState === "visible" ? Date.now() : null, banked = 0;
  var MAX_MS = 30 * 60 * 1000;

  function takeMs() {
    var ms = banked;
    if (visibleSince !== null) { var now = Date.now(); ms += now - visibleSince; visibleSince = now; }
    banked = 0;
    return Math.max(0, Math.min(Math.round(ms), MAX_MS));
  }
  function send(payload) {
    payload.d = doc;
    var body = JSON.stringify(payload);
    try { if (navigator.sendBeacon && navigator.sendBeacon(endpoint, body)) return; } catch (e) {}
    try { fetch(endpoint, { method: "POST", body: body, keepalive: true, mode: "no-cors", credentials: "omit", headers: { "content-type": "text/plain" } }); } catch (e) {}
  }
  function pageview() {
    var path = location.pathname || "/";
    if (path === lastPath) return;
    var payload = { t: "pageview", p: path };
    var ms = takeMs();
    if (ms > 0) payload.ms = ms;
    if (first) {
      first = false;
      try { if (document.referrer) payload.r = new URL(document.referrer).host; } catch (e) {}
      if (location.search.length > 1) payload.q = location.search.slice(0, 2000);
    }
    lastPath = path;
    send(payload);
  }
  function leave() {
    var ms = takeMs();
    if (ms > 0 && lastPath) send({ t: "leave", p: lastPath, ms: ms });
  }
  function label(text) {
    var value = (text || "").replace(/\\s+/g, " ").trim().slice(0, 200);
    return value ? { l: value } : {};
  }
  function merge(a, b) { for (var k in b) a[k] = b[k]; return a; }
  document.addEventListener("click", function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target || target.closest("input, textarea, select, [contenteditable], [data-analytics-ignore]")) return;
    var tracked = target.closest("[data-track]");
    if (tracked) {
      var name = (tracked.getAttribute("data-track") || "").trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").slice(0, 40);
      if (name && /^[a-z]/.test(name)) send(merge({ t: "event", p: location.pathname, n: name }, label(tracked.getAttribute("data-track-label"))));
      return;
    }
    var link = target.closest("a[href]");
    if (!link) return;
    var href = link.getAttribute("href") || "";
    if (/^mailto:/i.test(href)) return send({ t: "event", p: location.pathname, n: "mailto" });
    if (/^tel:/i.test(href)) return send({ t: "event", p: location.pathname, n: "tel" });
    try {
      var url = new URL(link.href, location.href);
      if (/^https?:$/.test(url.protocol) && url.host !== location.host) send({ t: "event", p: location.pathname, n: "outbound", l: url.hostname.replace(/^www\\./, "") });
    } catch (e) {}
  }, true);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { if (visibleSince !== null) banked += Date.now() - visibleSince; visibleSince = null; leave(); }
    else visibleSince = Date.now();
  });
  addEventListener("pagehide", leave);
  var push = history.pushState, replace = history.replaceState;
  history.pushState = function () { var out = push.apply(this, arguments); setTimeout(pageview, 0); return out; };
  history.replaceState = function () { var out = replace.apply(this, arguments); setTimeout(pageview, 0); return out; };
  addEventListener("popstate", function () { setTimeout(pageview, 0); });
  pageview();
})();
`;

/**
 * The snippet a company pastes before `</head>` on every page of its website:
 * the script above, from this deployment, carrying the website's public key.
 * `scriptUrl` is the script's absolute address (`{app}/api/w/v1/beacon.js`).
 */
export function websiteSnippet(scriptUrl: string, siteKey: string): string {
  const src = scriptUrl.replace(/"/g, "%22");
  const key = siteKey.replace(/[^A-Za-z0-9_]/g, "");
  return `<script async src="${src}" data-site="${key}"></script>`;
}
