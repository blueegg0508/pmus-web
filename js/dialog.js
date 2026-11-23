/* ── 앱 안 알림창 (2026-11-24 원장님: "초기화할 때 내 깃허브 주소가 뜨는데 노출 안 되게") ──────────────
 *
 * 휴대폰 기본 알림창(alert · confirm)은 맨 위에 사이트 주소를 붙인다 ("blueegg0508.github.io 내용:").
 * 주소를 숨길 방법이 없어 알림창을 앱 화면 안에 직접 그린다. 앱 화면과 편집 화면(iframe) 양쪽에서 실린다.
 *   - alert(msg)          → 그대로 갈아끼운다 (돌려받는 값이 없으니 기다리지 않아도 된다)
 *   - pmusConfirm(msg)    → Promise<true|false>. confirm() 쓰던 곳은 await pmusConfirm() 으로 바꿨다
 * 글자는 언어팩(i18n.js)이 화면에 붙을 때 번역한다.
 * ------------------------------------------------------------------- */
(function () {
    "use strict";
    if (window.pmusConfirm) return;
    var CSS = ".pmus-dlg{position:fixed;inset:0;z-index:2147483600;display:grid;place-items:center;padding:20px;background:rgba(6,4,8,.62);font-family:inherit}" +
        ".pmus-dlg-box{width:min(360px,100%);background:var(--surface,#1b171d);color:var(--text,#f3ece6);border:1px solid var(--line-2,#443b47);border-radius:16px;padding:20px 18px 14px;box-shadow:0 16px 48px rgba(0,0,0,.55)}" +
        ".pmus-dlg-msg{margin:0;font-size:15px;line-height:1.55;white-space:pre-line;word-break:keep-all}" +
        ".pmus-dlg-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}" +
        ".pmus-dlg-btns button{min-height:42px;min-width:84px;padding:0 16px;border-radius:10px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;border:1px solid var(--line-2,#443b47);background:var(--surface-2,#241f27);color:var(--text,#f3ece6)}" +
        ".pmus-dlg-btns .is-ok{background:var(--accent,#c99a72);border-color:var(--accent,#c99a72);color:var(--on-accent,#241812)}" +
        ".pmus-dlg-btns button:focus-visible{outline:2px solid var(--accent-2,#ebcba9);outline-offset:2px}";
    var styled = false;
    function style() {
        if (styled) return;
        styled = true;
        var s = document.createElement("style");
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
    }
    function show(msg, withCancel) {
        return new Promise(function (resolve) {
            var go = function () {
                style();
                var bg = document.createElement("div");
                bg.className = "pmus-dlg";
                bg.setAttribute("role", "dialog");
                bg.setAttribute("aria-modal", "true");
                var box = document.createElement("div");
                box.className = "pmus-dlg-box";
                var p = document.createElement("p");
                p.className = "pmus-dlg-msg";
                p.textContent = String(msg == null ? "" : msg);
                var row = document.createElement("div");
                row.className = "pmus-dlg-btns";
                var done = function (v) { bg.remove(); document.removeEventListener("keydown", key, true); resolve(v); };
                if (withCancel) {
                    var no = document.createElement("button");
                    no.type = "button"; no.textContent = "취소";
                    no.addEventListener("click", function () { done(false); });
                    row.appendChild(no);
                }
                var ok = document.createElement("button");
                ok.type = "button"; ok.className = "is-ok"; ok.textContent = "확인";
                ok.addEventListener("click", function () { done(true); });
                row.appendChild(ok);
                var key = function (e) {
                    if (e.key === "Escape") { e.preventDefault(); done(!withCancel); }
                    else if (e.key === "Enter") { e.preventDefault(); done(true); }
                };
                document.addEventListener("keydown", key, true);
                box.appendChild(p); box.appendChild(row); bg.appendChild(box);
                document.body.appendChild(bg);
                try { ok.focus(); } catch (e) {}
            };
            if (document.body) go(); else document.addEventListener("DOMContentLoaded", go);
        });
    }
    window.pmusConfirm = function (msg) { return show(msg, true); };
    window.pmusAlert = function (msg) { return show(msg, false); };
    // alert() 는 그대로 갈아끼운다 — 돌려받는 값이 없다
    try { window.alert = function (msg) { show(msg, false); }; } catch (e) { /* 막힌 창 */ }
})();
