/* ── 언어팩 (2026-11-20 원장님 요청: 영어 · 일본어 · 중국어부터 세계 8대 언어) ──────────────
 *
 * 화면 글자는 코드 곳곳에 한국어로 박혀 있다. 그걸 다 고치는 대신, 화면에 한국어 글자가 생기는 순간
 * 사전(i18n/<언어>.json)에서 찾아 바꿔 끼운다. 사전 원본 목록은 tools/i18n-extract.mjs 가 만든다.
 *
 *  - 고른 언어는 이 기기(localStorage "pmus.lang")에만. 한국어("ko")면 아무것도 하지 않는다.
 *  - 찾는 차례: 그대로 → 숫자를 {#} 로 → 앞뒤 기호 · 이모지를 떼고 → 아는 조각으로 전부 바꿀 수 있을 때만 조각째.
 *    조각으로 바꾸다 한글이 남으면(고객 이름 · 메모 같은 원장님이 쓴 글) 손대지 않는다.
 *  - 글자 · placeholder · title · aria-label · alt, 알림창(alert · confirm · prompt), 캔버스에 쓰는 글자(저장 사진의 글씨)까지.
 *  - 언어를 바꾸면 다시 연다 (한국어 원문으로 되돌리는 가장 확실한 길).
 *  - 편집 화면(iframe)에는 app.js 가 이 파일과 사전을 같이 실어 보낸다 (window.__I18N_LANG · __I18N_DICT).
 * ------------------------------------------------------------------- */
(function () {
    "use strict";
    var KEY = "pmus.lang";
    var LANGS = [
        ["ko", "한국어"], ["en", "English"], ["ja", "日本語"], ["zh", "中文(简体)"],
        ["es", "Español"], ["fr", "Français"], ["pt", "Português"], ["ru", "Русский"], ["ar", "العربية"],
    ];
    var lang = window.__I18N_LANG;
    if (!lang) { try { lang = localStorage.getItem(KEY) || "ko"; } catch (e) { lang = "ko"; } }
    if (!LANGS.some(function (l) { return l[0] === lang; })) lang = "ko";

    var HANGUL = /[가-힣]/;
    var NUM = /\d[\d,]*(?:\.\d+)?/g;
    var dict = null, core = null, frag = null;
    var cache = new Map();

    function stripEdge(s) {
        // 앞뒤의 이모지 · 기호 · 괄호를 떼어 낸 가운데 부분과 앞뒤 조각
        var m = /^([^가-힣A-Za-z0-9{}]*)([\s\S]*?)([^가-힣A-Za-z0-9{}]*)$/.exec(s);
        return m ? [m[1], m[2], m[3]] : ["", s, ""];
    }
    function fill(tpl, nums) {
        var i = 0;
        return tpl.replace(/\{#\}/g, function () { return nums && i < nums.length ? nums[i++] : ""; });
    }
    function setDict(d) {
        dict = d || {};
        core = Object.create(null);
        var fr = [];
        Object.keys(dict).forEach(function (k) {
            var p = stripEdge(k);
            if (p[1] && !(p[1] in core)) core[p[1]] = dict[k].trim() === "" ? dict[k] : stripEdge(dict[k])[1] || dict[k];
            if (k.length >= 2 && k.indexOf("{#}") < 0 && HANGUL.test(k)) fr.push(k);
        });
        fr.sort(function (a, b) { return b.length - a.length; });
        frag = fr.length ? new RegExp(fr.map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|"), "g") : null;
        cache.clear();
    }
    function look(t) {
        if (t in dict) return dict[t];
        var nums = t.match(NUM);
        if (nums) { var tn = t.replace(NUM, "{#}"); if (tn in dict) return fill(dict[tn], nums); }
        var p = stripEdge(t);
        if (p[1]) {
            if (p[1] in core) return p[0] + core[p[1]] + p[2];
            if (nums) { var cn = p[1].replace(NUM, "{#}"); if (cn in core) return p[0] + fill(core[cn], p[1].match(NUM)) + p[2]; }
        }
        return null;
    }
    /** 한국어 글자 하나를 고른 언어로. 모르면 그대로 돌려준다. */
    function t(s) {
        if (!dict || typeof s !== "string" || !HANGUL.test(s)) return s;
        if (cache.has(s)) return cache.get(s);
        var lead = /^\s*/.exec(s)[0], trail = /\s*$/.exec(s)[0];
        var body = s.slice(lead.length, s.length - trail.length);
        var flat = body.replace(/\s+/g, " ");
        var out = look(flat);
        if (out == null && frag) {
            // 아는 조각으로 전부 바꿀 수 있을 때만 (원장님이 쓴 이름 · 메모는 한글이 남아 그대로 둔다)
            var tried = flat.replace(frag, function (m) { return " " + dict[m] + " "; }).replace(/ {2,}/g, " ").trim();
            if (!HANGUL.test(tried)) out = tried;
        }
        if (out == null && /\n/.test(s)) {
            // 여러 줄 — 줄마다
            var lines = s.split("\n").map(function (l) { return t(l); });
            out = lines.join("\n");
            cache.set(s, out);
            return out;
        }
        var res = out == null ? s : lead + out + trail;
        if (cache.size > 5000) cache.clear();
        cache.set(s, res);
        return res;
    }

    // ── 화면 ──
    var SKIP_TAG = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, CODE: 1 };
    var ATTRS = ["placeholder", "title", "aria-label", "alt", "data-tip"];
    function skipEl(el) {
        for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
            if (SKIP_TAG[e.tagName] || e.isContentEditable || (e.hasAttribute && e.hasAttribute("data-no-i18n"))) return true;
        }
        return false;
    }
    function doText(n) {
        var v = n.nodeValue;
        if (!v || !HANGUL.test(v) || skipEl(n.parentNode)) return;
        var o = t(v);
        if (o !== v) n.nodeValue = o;
    }
    function doAttrs(el) {
        // 입력칸(textarea) 안의 글은 원장님이 쓴 것이라 두지만, 안내 글자(placeholder)는 바꾼다
        if (el.nodeType !== 1 || (el.tagName === "TEXTAREA" ? skipEl(el.parentNode) : skipEl(el))) return;
        for (var i = 0; i < ATTRS.length; i++) {
            var a = el.getAttribute(ATTRS[i]);
            if (a && HANGUL.test(a)) { var o = t(a); if (o !== a) el.setAttribute(ATTRS[i], o); }
        }
        if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) && HANGUL.test(el.value)) el.value = t(el.value);
        if (el.tagName === "OPTION" && el.label && HANGUL.test(el.getAttribute("label") || "")) el.setAttribute("label", t(el.getAttribute("label")));
    }
    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { doText(root); return; }
        if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
        if (root.nodeType === 1) { doAttrs(root); if (SKIP_TAG[root.tagName]) return; }
        var w = document.createTreeWalker(root, 5 /* 원소 + 글자 */, null);
        var n;
        while ((n = w.nextNode())) {
            if (n.nodeType === 3) doText(n);
            else doAttrs(n);      // 건너뛸 태그 안쪽 글자는 doText 의 skipEl 이 걸러 준다
        }
    }
    var obs = null;
    function start() {
        if (!dict) return;
        walk(document.documentElement);
        if (document.title && HANGUL.test(document.title)) document.title = t(document.title);
        if (obs || !window.MutationObserver) return;
        obs = new MutationObserver(function (list) {
            for (var i = 0; i < list.length; i++) {
                var m = list[i];
                if (m.type === "characterData") doText(m.target);
                else if (m.type === "attributes") doAttrs(m.target);
                else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
            }
        });
        obs.observe(document.documentElement, {
            childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(["value", "label"]),
        });
    }

    // ── 알림창 · 캔버스 글자 ──
    function patch() {
        ["alert", "confirm", "prompt"].forEach(function (fn) {
            var orig = window[fn];
            if (typeof orig !== "function" || orig.__i18n) return;
            var w = function (msg) {
                var args = Array.prototype.slice.call(arguments);
                if (typeof msg === "string") args[0] = t(msg);
                if (fn === "prompt" && typeof args[1] === "string") args[1] = t(args[1]);
                return orig.apply(window, args);
            };
            w.__i18n = true;
            try { window[fn] = w; } catch (e) { /* 막힌 창 */ }
        });
        var C = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
        if (C && !C.__i18n) {
            C.__i18n = true;
            ["fillText", "strokeText", "measureText"].forEach(function (fn) {
                var orig = C[fn];
                if (typeof orig !== "function") return;
                C[fn] = function (text) {
                    if (typeof text === "string" && HANGUL.test(text)) {
                        var args = Array.prototype.slice.call(arguments);
                        args[0] = t(text);
                        return orig.apply(this, args);
                    }
                    return orig.apply(this, arguments);
                };
            });
        }
    }

    var api = {
        lang: lang,
        langs: LANGS,
        t: t,
        ready: null,
        dict: function () { return dict; },
        /** 언어를 바꾸고 다시 연다 */
        set: function (code) {
            try { if (code === "ko") localStorage.removeItem(KEY); else localStorage.setItem(KEY, code); } catch (e) { /* 저장 못 함 */ }
            location.reload();
        },
    };
    window.PMUS_I18N = api;
    if (lang === "ko") { api.ready = Promise.resolve(false); return; }

    document.documentElement.lang = lang;
    document.documentElement.setAttribute("data-lang", lang);
    function go(d) {
        setDict(d);
        patch();
        if (document.readyState === "loading") {
            start();      // 지금까지 그려진 것 + 앞으로 붙는 것
            document.addEventListener("DOMContentLoaded", function () { walk(document.body); });
        } else start();
        document.documentElement.classList.remove("i18n-wait");
        return true;
    }
    if (window.__I18N_DICT) { api.ready = Promise.resolve(go(window.__I18N_DICT)); return; }

    // 사전을 받는 동안 한국어가 잠깐 보였다가 바뀌지 않게 가려 둔다 (못 받으면 1.5초 뒤 한국어로라도)
    document.documentElement.classList.add("i18n-wait");
    var st = document.createElement("style");
    st.textContent = "html.i18n-wait body{visibility:hidden}";
    (document.head || document.documentElement).appendChild(st);
    var giveUp = setTimeout(function () { document.documentElement.classList.remove("i18n-wait"); }, 1500);
    var base = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/js\/i18n\.js.*$/, "") : "";
    var ver = (document.currentScript && /[?&]v=(\d+)/.exec(document.currentScript.src)) || null;
    api.ready = fetch(base + "i18n/" + lang + ".json" + (ver ? "?v=" + ver[1] : ""))
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (d) { clearTimeout(giveUp); return go(d); })
        .catch(function () { clearTimeout(giveUp); document.documentElement.classList.remove("i18n-wait"); return false; });
})();
