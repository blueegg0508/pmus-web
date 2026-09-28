/**
 * mobile-ui.js — 시뮬레이터 모바일 재배치 레이어 (눈썹 · 입술 공용)
 * =========================================================================
 * 데스크톱용 3열 레이아웃을 폰에서 쓸 수 있게 다시 구성한다.
 *
 * 핵심 원칙: **컨트롤을 새로 만들지 않는다.**
 * 기존 DOM 요소를 appendChild 로 "이동"만 시키므로 id·이벤트 핸들러가
 * 그대로 살아 있고, brow-canvas.js / lip-canvas.js 의 조절 로직은
 * 한 줄도 건드리지 않는다.
 *
 * 눈썹과 입술은 컨트롤 구성만 다르고 껍데기(상단바 → 무대 → 바텀시트)는
 * 완전히 같다. 아래 KIND 로 갈라지는 부분만 다르게 두고 나머지는 공유한다.
 *
 * 이 스크립트는 캔버스 JS 가 모두 실행된 뒤(끝부분)에서 호출되어야 한다.
 * =========================================================================
 */

(function () {
    "use strict";

    if (!window.matchMedia("(max-width: 820px)").matches) return;   // 폰에서만
    if (document.querySelector(".mui-shell")) return;               // 중복 실행 방지

    var KIND = document.getElementById("dragCanvas") ? "brow"
             : document.getElementById("lipCanvas") ? "lip"
             : null;
    if (!KIND) return;
    var isBrow = (KIND === "brow");

    /** 앱 셸이 알려준 편집 방식. 퀵이면 조절바 몇 개만 크게 보여준다. */
    var uiMode = (window.CFG && window.CFG.ui_mode === "manual") ? "manual" : "quick";

    var $ = function (id) { return document.getElementById(id); };

    // ── 0. 저장(다운로드) 가로채기 ──────────────────────────────────────
    // 안드로이드 WebView 에는 다운로드 매니저가 붙어 있지 않아 <a download> 을
    // 눌러도 조용히 아무 일도 일어나지 않는다. 캔버스 JS 는 결과 저장을 전부
    // link.click() 으로 하므로, 프로토타입을 한 번만 갈아끼우면 모든 저장
    // 경로(결과 저장 · 히스토리 카드 · 미리보기 창)를 한꺼번에 잡을 수 있다.
    // 잡은 데이터는 앱 셸로 넘겨 네이티브 플러그인이 사진첩에 넣는다.
    (function () {
        var origClick = HTMLAnchorElement.prototype.click;

        function asDataUrl(href) {
            if (href.slice(0, 5) === "data:") return Promise.resolve(href);
            return fetch(href).then(function (r) { return r.blob(); }).then(function (b) {
                return new Promise(function (ok, fail) {
                    var fr = new FileReader();
                    fr.onload = function () { ok(fr.result); };
                    fr.onerror = fail;
                    fr.readAsDataURL(b);
                });
            });
        }

        HTMLAnchorElement.prototype.click = function () {
            var self = this;
            var name = self.getAttribute("download");
            var href = self.href || "";
            if (!name || !/^(data:|blob:)/.test(href)) {
                return origClick.apply(self, arguments);   // 평범한 링크는 그대로
            }
            asDataUrl(href).then(function (dataUrl) {
                window.parent.postMessage(
                    { type: "mui:save", filename: name, dataUrl: dataUrl }, "*");
            })["catch"](function () {
                origClick.call(self);                      // 못 읽으면 원래 방식으로
            });
        };
    })();

    /** 요소를 감싸는 조절 행(.ctrl-row)을 찾는다. 없으면 요소 자신. */
    function rowOf(id) {
        var el = $(id);
        if (!el) return null;
        return el.closest(".ctrl-row") || el;
    }

    /** id 요소부터 위로 올라가 parentSel 의 직계 자식이 되는 조상을 찾는다. */
    function blockOf(id, parentSel) {
        var el = $(id);
        if (!el) return null;
        var parent = document.querySelector(parentSel);
        if (!parent) return el;
        while (el && el.parentElement && el.parentElement !== parent) {
            el = el.parentElement;
        }
        return el && el.parentElement === parent ? el : $(id);
    }

    /** 입술 쪽 아코디언 카드: 헤더는 CSS 로 감추고 본문만 펼쳐 둔다. */
    function openCard(id) {
        var card = $(id);
        if (card) card.classList.add("open");
        return card;
    }

    function move(target, node) {
        if (node && target && node !== target && !target.contains(node)) {
            target.appendChild(node);
        }
    }

    function el(tag, cls, html) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html != null) n.innerHTML = html;
        return n;
    }

    /** 버튼 문구를 한글로 바꾼다. text 가 null 이면 원본 문구를 그대로 둔다
     *  (캔버스 JS 가 눌릴 때마다 스스로 문구를 갱신하는 버튼들이 있다). */
    function pick(id, text) {
        var b = $(id);
        if (b && text != null) b.textContent = text;
        return b;
    }

    // ── 1. 껍데기 만들기 ────────────────────────────────────────────────
    var shell = el("div", "mui-shell");

    // 최상단 가로 전체 버튼 — 사진·디자인을 바꾸러 앱 셸로 돌아간다
    var btnSettings = el("button", "mui-settings",
        isBrow ? "사진 · 디자인 변경" : "사진 · 부위 변경");
    btnSettings.addEventListener("click", function () {
        try { window.parent.postMessage({ type: "mui:settings" }, "*"); } catch (e) {}
    });

    // 그 아래 줄: [시술 전 | 예상 디자인 | …] + 되돌리기·초기화
    var topbar = el("div", "mui-topbar");
    var seg = el("div", "mui-seg");
    var actions = el("div", "mui-actions");
    topbar.appendChild(seg); topbar.appendChild(actions);

    var chips = el("div", "mui-chips");

    var stage = el("div", "mui-stage");
    var hint = el("div", "mui-hint", isBrow
        ? "한 손가락: 눈썹 이동 · 두 손가락: 사진 이동/확대"
        : "한 손가락: 입술 이동 · 두 손가락: 사진 이동/확대");

    var sheet = el("div", "mui-sheet");
    sheet.setAttribute("data-snap", "half");
    var handle = el("div", "mui-handle");

    // 퀵 ↔ 메뉴얼. 편집 중에도 언제든 오갈 수 있어야 해서 시트 맨 위에 둔다.
    var modeBar = el("div", "mui-modebar");
    var mbQuick = el("button", null, "⚡ 퀵");
    var mbManual = el("button", null, "🎚️ 메뉴얼");
    mbQuick.type = mbManual.type = "button";
    modeBar.appendChild(mbQuick); modeBar.appendChild(mbManual);

    var tabs = el("div", "mui-tabs");
    var panes = el("div", "mui-panes");
    // 퀵 패널도 .mui-panes 로 두어 조절바·± 버튼 모양 규칙을 그대로 물려받는다
    var quick = el("div", "mui-panes mui-quick");
    sheet.appendChild(handle); sheet.appendChild(modeBar);
    sheet.appendChild(tabs); sheet.appendChild(panes); sheet.appendChild(quick);

    shell.appendChild(btnSettings);
    shell.appendChild(topbar);
    shell.appendChild(chips);
    shell.appendChild(stage);
    shell.appendChild(hint);
    shell.appendChild(sheet);
    document.body.appendChild(shell);
    document.documentElement.classList.add("mui-on");

    // ── 2. 사진 무대 + 보기 전환 ────────────────────────────────────────
    var canvas = isBrow ? $("dragCanvas") : $("lipCanvas");

    if (isBrow) {
        // 눈썹: 시술 전 사진 위에 결과 캔버스를 정확히 포개 둔다.
        // 사진이 상자 크기를 잡고 캔버스가 그 위를 덮는 구조라, '비교' 에서
        // 캔버스만 반쪽으로 잘라내면 좌우 분할이 그대로 만들어진다.
        var beforeImg = document.querySelector(".customer-photo");
        // '시술 전' 은 언제나 편집하지 않은 맨얼굴이어야 한다. 캔버스 배경은
        // 입술 작업이 얹힌 사진일 수 있어서 그걸 쓰면 비교가 되지 않는다.
        if (beforeImg && window.CFG && window.CFG.orig_b64) {
            beforeImg.src = window.CFG.orig_b64;
        }
        var shot = el("div", "mui-shot");
        move(shot, beforeImg);
        move(shot, canvas);
        stage.appendChild(shot);

        // 비교용 가운데 선. 좌우로 끌면 경계가 움직여 사진 전체를
        // 시술 전으로도, 예상 디자인으로도 볼 수 있다.
        var divider = el("div", "mui-split");
        shot.appendChild(divider);

        var splitRatio = 0.5;

        /** 선과 잘라내는 자리를 사진 상자에 맞춰 놓는다.
         *  사진은 무대 가운데에 놓이므로 무대 기준으로 재면 어긋난다. */
        function layoutSplit() {
            if (!shot.classList.contains("is-compare")) return;
            if (!canvas) return;
            var cr = canvas.getBoundingClientRect();
            var sr = shot.getBoundingClientRect();
            if (!cr.width || !cr.height) return;
            canvas.style.setProperty("--split", (splitRatio * 100) + "%");
            divider.style.left = (cr.left - sr.left + splitRatio * cr.width) + "px";
            divider.style.top = (cr.top - sr.top) + "px";
            divider.style.height = cr.height + "px";
        }

        /** 손가락 위치를 사진 안에서의 비율로 바꾼다 */
        function ratioAt(clientX) {
            var cr = canvas.getBoundingClientRect();
            if (!cr.width) return splitRatio;
            return Math.min(1, Math.max(0, (clientX - cr.left) / cr.width));
        }

        var splitting = false;
        shot.addEventListener("pointerdown", function (e) {
            if (!shot.classList.contains("is-compare")) return;
            splitting = true;
            splitRatio = ratioAt(e.clientX);
            layoutSplit();
            try { shot.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        });
        shot.addEventListener("pointermove", function (e) {
            if (!splitting) return;
            splitRatio = ratioAt(e.clientX);
            layoutSplit();
            e.preventDefault();
        });
        ["pointerup", "pointercancel"].forEach(function (t) {
            shot.addEventListener(t, function (e) {
                if (!splitting) return;
                splitting = false;
                try { shot.releasePointerCapture(e.pointerId); } catch (err) {}
            });
        });

        // 사진 크기가 바뀌면(시트 여닫기·화면 회전) 선 자리도 다시 잡는다
        if (typeof ResizeObserver === "function") {
            new ResizeObserver(layoutSplit).observe(shot);
        }
        window.addEventListener("resize", layoutSplit);

        var segBefore = el("button", null, "시술 전");
        var segAfter = el("button", "is-active", "예상 디자인");
        var segComp = el("button", null, "비교");
        seg.appendChild(segBefore); seg.appendChild(segAfter); seg.appendChild(segComp);

        var hintDefault = hint.textContent;

        function setView(which) {
            [segBefore, segAfter, segComp].forEach(function (b) { b.classList.remove("is-active"); });
            shot.classList.remove("is-before", "is-compare");
            if (which === "before") { segBefore.classList.add("is-active"); shot.classList.add("is-before"); }
            else if (which === "compare") { segComp.classList.add("is-active"); shot.classList.add("is-compare"); }
            else segAfter.classList.add("is-active");

            if (which === "compare") {
                hint.textContent = "가운데 선을 좌우로 끌어 비교하세요";
                hint.style.display = "";
                // 레이아웃이 잡힌 뒤에 재야 사진 크기가 제대로 나온다
                requestAnimationFrame(layoutSplit);
            } else {
                hint.textContent = hintDefault;
                hint.style.display = which === "before" ? "none" : "";
            }
        }
        segBefore.addEventListener("click", function () { setView("before"); });
        segAfter.addEventListener("click", function () { setView("after"); });
        segComp.addEventListener("click", function () { setView("compare"); });
    } else {
        // 입술: 캔버스 하나가 before/after/split 을 직접 그린다.
        // 원본 뷰 버튼을 그대로 옮겨오므로 전환 로직은 건드릴 필요가 없다.
        move(stage, canvas);
        if (canvas) canvas.classList.add("is-shown");

        [["btnViewBefore", "시술 전"],
         ["btnViewAfter", "예상 디자인"],
         ["btnViewSplit", "비교"]].forEach(function (p) {
            move(seg, pick(p[0], p[1]));
        });

        // 시술 전 화면에서는 조작 안내를 감춘다.
        // (원본 핸들러가 먼저 등록돼 있어 active 는 이미 갱신된 뒤에 읽힌다)
        var syncHint = function () {
            var before = $("btnViewBefore");
            hint.style.display = (before && before.classList.contains("active")) ? "none" : "";
        };
        ["btnViewBefore", "btnViewAfter", "btnViewSplit"].forEach(function (id) {
            var b = $(id);
            if (b) b.addEventListener("click", syncHint);
        });
        syncHint();
    }

    // ── 3. 상단 액션바 ──────────────────────────────────────────────────
    (isBrow
        ? [["btnUndo", "되돌리기"], ["btnRedo", "다시실행"]]
        : [["btnUndoContour", "되돌리기"]]
    ).forEach(function (p) { move(actions, pick(p[0], p[1])); });

    // 입술 원본 화면에는 '다시실행' 버튼이 없다. 눈썹과 같은 자리에 만들어 준다.
    if (!isBrow) {
        var btnLipRedo = el("button", "mui-redo", "다시실행");
        btnLipRedo.type = "button";
        btnLipRedo.addEventListener("click", function () {
            if (typeof window.__blLipRedo === "function") window.__blLipRedo();
        });
        actions.appendChild(btnLipRedo);
    }

    // 전체 초기화 — 앱을 껐다 켜지 않고 처음 상태로 되돌린다.
    // 저장한 결과물이 쌓이면 그것만으로 메모리를 먹는데, 그걸 비우려고
    // 앱을 껐다 켜야 했다. 지우기 전에 한 번 물어본다.
    var btnWipe = el("button", "mui-wipe", "전체 초기화");
    btnWipe.type = "button";
    btnWipe.addEventListener("click", function () {
        var ok = false;
        try {
            ok = window.confirm([
                "모든 작업을 초기화하고 처음으로 돌아갈까요?",
                "",
                "저장한 결과물과 지금까지의 편집이 모두 지워집니다.",
                "등록해 둔 내 디자인과 라이선스는 그대로 남습니다."
            ].join(String.fromCharCode(10)));
        } catch (e) { ok = false; }
        if (!ok) return;
        try { window.parent.postMessage({ type: "mui:resetAll" }, "*"); } catch (e) {}
    });
    actions.appendChild(btnWipe);

    // ── 4. 칩 줄 (이동 대상 + 입술 표시 토글) ───────────────────────────
    // 조절값만 되돌리는 버튼은 여기로 내렸다. 위 자리는 전체 초기화가 쓴다.
    (isBrow
        ? [["btnBrowMoveBoth", "🔗 함께"], ["btnBrowMoveAuto", "✨ 자동"],
           ["btnBrowMoveLeft", "👈 왼쪽"], ["btnBrowMoveRight", "👉 오른쪽"],
           ["btnReset", "↺ 조절 초기화"]]
        // 뒤의 셋은 눌릴 때마다 스스로 문구를 바꾸므로 이름을 건드리지 않는다
        : [["btnMoveAuto", "✨ 자동"], ["btnMoveBoth", "🔗 함께"],
           ["btnToggleDesignLine", null], ["btnToggleFillTint", null],
           ["btnCycleLineWidth", null], ["btnExtractLips", "🔄 재추출"],
           ["btnResetContour", "↺ 원본복원"]]
    ).forEach(function (p) { move(chips, pick(p[0], p[1])); });

    // ── 5. 탭 정의 & 컨트롤 이동 ────────────────────────────────────────
    var TABS = isBrow ? [
        {
            key: "shape", icon: "📐", label: "형태", title: "눈썹 크기 · 기장 · 꼬리",
            nodes: function () {
                // 원장님이 실제로 만지는 차례대로 (전체 크기 → 자리 → 모양 → 마무리)
                return ["rngScale",     // 전체 크기
                        "rngSpacing",   // 눈썹 간격 (좌우)
                        "rngVert",      // 위아래 위치
                        "rngWidth",     // 눈썹 기장
                        "rngHeight",    // 세로 두께
                        "rngRound",     // 꼬리 상단 두께
                        "rngRot",       // 꼬리 높이
                        "rngOpacity",   // 눈썹 투명도
                        "rngNatBrow"    // 고객의 원래 눈썹 진하기 (진한 눈썹 흐리게)
                       ].map(rowOf);
            }
        },
        {
            key: "color", icon: "🎨", label: "색상", title: "눈썹 색상 선택",
            nodes: function () { return [document.querySelector(".color-preset-card")]; }
        },
        {
            key: "sides", icon: "⚖️", label: "좌우", title: "좌 · 우 개별 미세 조정",
            nodes: function () {
                var out = [rowOf("rngLRot"), rowOf("rngRRot")];
                var sync = $("btnSyncYLevel");
                if (sync) out.push(sync);
                return out;
            }
        },
        {
            key: "guide", icon: "📏", label: "가이드", title: "3등분 가이드선 & 비율",
            nodes: function () { return [blockOf("chkShow3Guides", "#tabContent1")]; }
        },
        {
            key: "photo", icon: "🖼️", label: "사진", title: "고객 사진 보정",
            nodes: function () {
                return ["rngBright", "rngContrast", "rngSaturate",
                        "rngImgZoom", "rngImgPanX", "rngImgPanY"].map(rowOf);
            }
        },
        {
            key: "save", icon: "💾", label: "저장", title: "결과물 저장 & 기록",
            nodes: function () {
                return [$("btnDownloadAfter"), $("btnDownloadComp"),
                        document.querySelector(".history-section")];
            }
        }
    ] : [
        /* 예전에는 맨 앞에 '위치' 탭이 있었다. 거기 있던 조절바는 전부
         * 윗입술·아랫입술 카드에 이미 있는 것과 겹쳤다.
         *
         *   · 전체 상하(Y)·좌우(X) — '이동 대상' 에 따라 윗입술 값이 되었다가
         *     아랫입술 값이 되었다가 하는 대리 조절바였다. 같은 자리에서
         *     같은 손잡이가 다른 뜻을 갖는 셈이라, 지금 무엇을 옮기고 있는지
         *     알기 어려웠다. 각 카드의 '윗입술 위치 / 아랫입술 위치' 가
         *     같은 값을 직접 가리키므로 대리 조절바는 없앴다.
         *     (두 입술을 함께 옮기는 것은 '🔗 함께' 로 화면에서 끌면 된다)
         *   · 입술 전체 가로 길이감 — 윗·아랫 가로 길이감에 곱해지던 값이다.
         *     각 카드의 가로 길이감 범위를 그만큼 넓혀(40~200%) 흡수했다.
         *   · 입꼬리 뾰족 — 윗입술 카드와 아랫입술 카드에 같은 조절바가
         *     하나씩 있었다. 입꼬리는 위·아래가 만나는 한 점이라 값이 하나뿐이라,
         *     둘은 늘 같이 움직였다. 윗입술 쪽 하나만 남긴다.
         *   · 재추출 버튼은 칩 줄로, 검출 상태는 윗입술 맨 위로 옮겼다.
         *
         * 없앤 조절바들은 지우지 않고 원본 화면에 그대로 둔다. 그 화면은
         * html.mui-on 이 감추므로 보이지 않고, 캔버스 코드가 이름으로 찾아
         * 값을 읽고 쓰는 일은 그대로 이어진다. */
        {
            key: "upper", icon: "💖", label: "윗입술", title: "윗입술 정밀 디자인",
            nodes: function () { return [$("detectionBadge"), openCard("cardUpper")]; }
        },
        {
            key: "lower", icon: "🌓", label: "아랫입술", title: "아랫입술 정밀 디자인",
            nodes: function () {
                // 윗입술 카드에 남긴 것과 같은 값이라 여기서는 감춘다
                var dupe = $("gridSharpLower");
                if (dupe) dupe.style.display = "none";
                return [openCard("cardLower")];
            }
        },
        {
            key: "color", icon: "🎨", label: "색상", title: "틴트 컬러 & 시술 기법",
            nodes: function () { return [openCard("cardColor")]; }
        },
        {
            key: "save", icon: "💾", label: "저장", title: "결과물 저장 & 기록",
            nodes: function () {
                return [$("btnDownloadAfter"),
                        document.querySelector(".history-section")];
            }
        }
    ];

    TABS.forEach(function (t, i) {
        var btn = el("button", i === 0 ? "is-active" : null,
                     "<i>" + t.icon + "</i>" + t.label);
        btn.setAttribute("data-tab", t.key);
        tabs.appendChild(btn);

        var pane = el("div", "mui-pane" + (i === 0 ? " is-active" : ""));
        pane.setAttribute("data-pane", t.key);
        pane.appendChild(el("div", "mui-pane-title", t.title));
        panes.appendChild(pane);

        if (t.key === "save") pane.appendChild(buildHistoryTools());
        t.nodes().forEach(function (n) { move(pane, n); });

        btn.addEventListener("click", function () {
            var already = btn.classList.contains("is-active");
            tabs.querySelectorAll("button").forEach(function (b) { b.classList.remove("is-active"); });
            panes.querySelectorAll(".mui-pane").forEach(function (p) { p.classList.remove("is-active"); });
            btn.classList.add("is-active");
            pane.classList.add("is-active");
            panes.scrollTop = 0;
            // 저장 탭에는 조절바가 없으니 오른쪽 스크롤 여백도 필요 없다
            panes.classList.toggle("no-gutter", t.key === "save");
            // 같은 탭을 다시 누르면 시트 높이를 토글
            if (already) {
                setSnap(sheet.getAttribute("data-snap") === "full" ? "half" : "full");
            } else if (sheet.getAttribute("data-snap") === "peek") {
                setSnap("half");
            }
        });
    });

    // ── 5-2. 조절바 ± 미세조정 ──────────────────────────────────────────
    // 손가락으로 끌면 한 눈금씩 맞추기가 어렵다. 숫자 양옆에 버튼을 붙여
    // 한 번 누를 때마다 한 눈금 움직이게 한다.

    /** 조절바를 한 눈금 움직인다.
     *  되돌리기 기록이 '잡았다 놓는' 순서에 걸려 있어서, 손으로 끈 것과
     *  똑같이 pointerdown → input → pointerup 을 차례로 흘려보낸다. */
    function nudge(input, dir) {
        let step = parseFloat(input.step);
        if (!step || isNaN(step)) step = 1;          // range 기본 눈금이 1 이다
        const min = input.min === "" ? -Infinity : parseFloat(input.min);
        const max = input.max === "" ? Infinity : parseFloat(input.max);
        const cur = parseFloat(input.value) || 0;
        const next = Math.min(max, Math.max(min, cur + dir * step));
        if (next === cur) return;

        try { input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); } catch (e) {}
        input.value = next;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        try {
            input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
            window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        } catch (e) {}
    }

    function stepButton(input, dir) {
        const b = el("button", "mui-step-btn", dir < 0 ? "−" : "+");
        b.type = "button";
        b.setAttribute("aria-label", dir < 0 ? "한 눈금 줄이기" : "한 눈금 늘리기");
        b.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();      // 라벨 안이라 조절바로 번지지 않게
            nudge(input, dir);
        });
        return b;
    }

    /** 조절바 하나에 숫자 양옆 버튼을 붙인다. */
    function attachStepper(input) {
        const row = input.closest(".ctrl-row");
        const label = row && row.querySelector("label");
        if (!label || label.querySelector(".mui-step")) return;

        // 값 표시는 rng○○ ↔ val○○ 로 짝이 맞는다 (눈썹 26개·입술 43개 전부)
        const val = document.getElementById("val" + input.id.slice(3));
        if (!val || !label.contains(val)) return;

        const wrap = el("span", "mui-step");
        label.insertBefore(wrap, val);
        wrap.appendChild(stepButton(input, -1));
        wrap.appendChild(val);
        wrap.appendChild(stepButton(input, +1));
    }

    function attachSteppers() {
        panes.querySelectorAll('input[type="range"]').forEach(attachStepper);

        // 입술의 이동 라벨 두 줄은 캔버스 JS 가 라벨 전체를 다시 쓴다.
        // 그때마다 버튼이 날아가므로 지켜보다 다시 붙인다.
        [["lblMoveY", "rngMoveY"], ["lblMoveX", "rngMoveX"]].forEach(function (pair) {
            const label = $(pair[0]), input = $(pair[1]);
            if (!label || !input) return;
            new MutationObserver(function () {
                if (!label.querySelector(".mui-step")) attachStepper(input);
            }).observe(label, { childList: true });
        });
    }

    // ── 5-1. 비교 보기 · 전체 저장 ──────────────────────────────────────
    // 상담할 때 고객에게 시술 전과 예상 디자인, 또는 서로 다른 디자인을
    // 나란히 놓고 보여줘야 한다. 히스토리 카드는 한 줄에 하나씩 나오고
    // 카드마다 버튼이 붙어 있어 비교용으로는 맞지 않다.
    // 그래서 사진만 2열로 크게 까는 별도 화면을 둔다.

    function history() { return window.__blHistory || null; }

    /** 지금 화면을 구워 돌려준다 (맨얼굴 위에 이번 작업만 얹은 한 장) */
    function bakeNow() {
        try {
            if (typeof window.__blCapture === "function") return window.__blCapture();
        } catch (err) {}
        return null;
    }

    /** 목록에서 알아볼 이름 — 눈썹은 디자인 이름, 입술은 색 이름 */
    function bakeLabel() {
        try {
            if (isBrow) return (window.CFG && window.CFG.safe_design_name) || "";
            var on = document.querySelector(".color-chip.active[data-color]");
            return on ? on.textContent.trim() : "";
        } catch (err) { return ""; }
    }

    function buildHistoryTools() {
        var wrap = el("div", "mui-histtools");

        var btnCompare = el("button", "mui-histbtn", "🖼️ 비교 보기");
        btnCompare.type = "button";
        btnCompare.addEventListener("click", openCompare);

        var btnAll = el("button", "mui-histbtn", "📥 전체 저장");
        btnAll.type = "button";
        btnAll.addEventListener("click", saveAll);

        wrap.appendChild(btnCompare);
        wrap.appendChild(btnAll);

        /* 고른 디자인을 고객 이력으로 남긴다.
         *
         * 갤러리 저장과 달리 이건 '누구의 무엇' 인지가 함께 남는다. 다음에
         * 그 고객이 오면 이 그림을 꺼내 시술 결과와 나란히 놓고 이야기한다.
         * 그래서 저장 탭에서 가장 큰 자리를 준다. */
        var btnCrm = el("button", "mui-histbtn mui-histbtn-wide", "👤 고객 이력으로 저장");
        btnCrm.type = "button";
        btnCrm.addEventListener("click", function () {
            try {
                window.parent.postMessage({
                    type: "mui:saveCustomer",
                    part: KIND,
                    dataUrl: bakeNow(),
                    label: bakeLabel(),
                }, "*");
            } catch (err) {}
        });
        wrap.appendChild(btnCrm);
        return wrap;
    }

    /** 비교 화면에 깔 타일: 맨 앞은 시술 전 원본, 그 뒤로 저장된 결과물 */
    /**
     * 비교 화면에 보이는 그대로를 한 장으로 저장한다.
     *
     * 고객에게 보여준 배치(한 줄에 두 장)를 그대로 남겨야 상담 뒤에도
     * 같은 그림으로 이야기할 수 있다. 낱장 저장으로는 이 배치가 남지 않는다.
     *
     * 저장한 그림에 붙어 있던 출력용 안내문구 배너는 화면에서와 똑같이 잘라낸다.
     */
    function saveCompareSheet(tiles, done) {
        if (!tiles || !tiles.length) { if (done) done(); return; }

        // 나중에 갤러리에서 확대해 볼 그림이라 한 장을 너무 작게 잡지 않는다.
        // 다만 저사양 기기에서 큰 캔버스는 그 자체로 메모리 부담이라,
        // 장수가 많으면 폭을 줄여 전체 넓이를 묶어 둔다.
        var TW = tiles.length > 8 ? 560 : (tiles.length > 4 ? 700 : 880);
        var GAP = 14, PAD = 18, LABEL = 34;

        var loaded = 0, imgs = new Array(tiles.length);
        tiles.forEach(function (t, i) {
            var im = new Image();
            im.onload = im.onerror = function () {
                imgs[i] = (im.naturalWidth > 0) ? im : null;
                if (++loaded === tiles.length) compose();
            };
            im.src = t.src;
        });

        /** 이 그림을 폭 TW 로 놓았을 때의 높이. 실제로 읽어온 크기를 쓴다. */
        function tileH(i) {
            var im = imgs[i];
            var t = tiles[i];
            var a = (im && im.naturalWidth) ? (im.naturalWidth / im.naturalHeight)
                                            : (t.aspect || 0.8);
            return Math.max(1, Math.round(TW / a));
        }

        function compose() {
            var cols = tiles.length > 1 ? 2 : 1;
            var rows = Math.ceil(tiles.length / cols);

            // 줄마다 가장 높은 그림에 맞춘다 (2분할 그림은 비율이 다르다)
            var rowH = [];
            for (var r = 0; r < rows; r++) {
                var hMax = 0;
                for (var c = 0; c < cols; c++) {
                    var idx0 = r * cols + c;
                    if (!tiles[idx0]) continue;
                    hMax = Math.max(hMax, tileH(idx0));
                }
                rowH.push(hMax + LABEL);
            }

            var W = PAD * 2 + cols * TW + (cols - 1) * GAP;
            var H = PAD * 2 + rowH.reduce(function (a, b) { return a + b; }, 0)
                    + (rows - 1) * GAP;

            var cv = document.createElement("canvas");
            cv.width = W; cv.height = H;
            var x = cv.getContext("2d");

            x.fillStyle = "#141019";
            x.fillRect(0, 0, W, H);

            var y = PAD;
            for (var r2 = 0; r2 < rows; r2++) {
                var cellH = rowH[r2] - LABEL;
                for (var c2 = 0; c2 < cols; c2++) {
                    var idx = r2 * cols + c2;
                    var tile = tiles[idx];
                    if (!tile) continue;
                    var im2 = imgs[idx];
                    var left = PAD + c2 * (TW + GAP);
                    var drawH = tileH(idx);
                    var top = y + Math.round((cellH - drawH) / 2);

                    x.fillStyle = "#1B1626";
                    x.fillRect(left, top, TW, drawH);

                    // 배너는 이미 떼어낸 그림이다. 통째로 그린다 — 잘라내지 않는다.
                    if (im2) x.drawImage(im2, left, top, TW, drawH);

                    x.fillStyle = "#CFC7E0";
                    x.font = "600 20px system-ui, sans-serif";
                    x.textAlign = "center";
                    x.textBaseline = "middle";
                    x.fillText(tile.label || "", left + TW / 2, y + cellH + LABEL / 2);
                }
                y += rowH[r2] + GAP;
            }

            var url;
            try {
                url = cv.toDataURL("image/jpeg", 0.92);
            } catch (e) {
                url = null;
            }
            cv.width = 0; cv.height = 0;          // 큰 캔버스 즉시 반납

            if (url) {
                var name = (isBrow ? "brow" : "lip") + "_compare_" + stamp() + ".jpg";
                try {
                    window.parent.postMessage(
                        { type: "mui:save", filename: name, dataUrl: url }, "*");
                } catch (e) {}
            } else {
                alert("이 화면을 저장하지 못했습니다.");
            }
            if (done) done();
        }
    }

    /** 파일 이름에 붙일 날짜·시각 */
    function stamp() {
        var d = new Date();
        var p = function (n) { return String(n).padStart(2, "0"); };
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" +
               p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    /**
     * 저장한 그림 아래에 붙은 출력용 안내문구 배너만 잘라낸 그림을 만든다.
     *
     * 상자에 맞춰 잘라내는(cover) 방식은 비율이 조금만 어긋나도 얼굴이
     * 잘려 나가 무엇인지 알아볼 수 없다. 배너만 미리 떼어낸 그림을 만들고
     * 화면에서는 원래 비율 그대로 보여준다.
     *
     * 비율을 모르는 옛 기록은 잘라낼 높이가 원본을 넘지 않게 묶어 두어
     * 최악의 경우에도 배너가 조금 남을 뿐 그림이 잘리지는 않는다.
     */
    function cleanTiles(tiles, done) {
        var left = tiles.length;
        if (!left) { done(); return; }

        tiles.forEach(function (t) {
            var im = new Image();
            im.onload = function () {
                try {
                    var sw = im.naturalWidth, sh = im.naturalHeight;
                    var want = t.aspect ? Math.round(sw / t.aspect) : sh;
                    var cut = Math.max(1, Math.min(sh, want));
                    if (cut < sh - 1) {
                        var c = document.createElement("canvas");
                        c.width = sw; c.height = cut;
                        c.getContext("2d").drawImage(im, 0, 0, sw, cut, 0, 0, sw, cut);
                        t.src = c.toDataURL("image/jpeg", 0.92);
                        c.width = 0; c.height = 0;
                    }
                    t.w = sw; t.h = cut;
                } catch (e) { /* 못 자르면 원래 그림 그대로 쓴다 */ }
                if (--left === 0) done();
            };
            im.onerror = function () { if (--left === 0) done(); };
            im.src = t.src;
        });
    }

    /** 한 화면에 늘어놓을 최대 칸 수. 많이 깔면 한 장이 작아져 알아보기 어렵다. */
    var MAX_COMPARE = 6;

    function compareTiles() {
        var h = history();
        var tiles = [];
        var photo = h && h.photo();
        var base = (window.CFG && window.CFG.img_w && window.CFG.img_h)
            ? window.CFG.img_w / window.CFG.img_h : 0.8;
        // '시술 전' 은 맨얼굴 원본이라 잘라낼 배너가 없다
        if (photo) tiles.push({ src: photo, label: "시술 전", aspect: base, item: null });
        (h ? h.items() : []).slice(0, MAX_COMPARE - 1).forEach(function (it) {
            tiles.push({
                src: it.thumbUrl || it.dataUrl,
                // 눈썹은 고른 디자인 이름, 입술은 고른 색 이름을 단다.
                // 고객에게 보여주는 화면이라 시각은 넣지 않는다.
                label: it.compareLabel || it.tagText || "결과",
                aspect: it.aspect || base,
                item: it
            });
        });
        return tiles;
    }

    var compare = null;      // 열려 있는 비교 화면

    function openCompare() {
        if (!history()) { alert("저장된 결과물이 없습니다."); return; }
        if (compare) { compare.remove(); compare = null; }

        var tiles = compareTiles();
        if (tiles.length < 2) {
            alert("비교하려면 결과물을 먼저 저장해 주세요. (저장 탭의 결과 저장 버튼)");
            return;
        }

        compare = el("div", "mui-compare");

        var bar = el("div", "mui-compare-bar");
        bar.appendChild(el("span", "mui-compare-title", "비교 보기"));
        var hint = el("span", "mui-compare-hint", "두 손가락 확대 · 두 번 눌러 원래대로");
        bar.appendChild(hint);
        var saveAll = el("button", "mui-compare-save", "⬇ 전체 이미지 저장");
        saveAll.type = "button";
        saveAll.addEventListener("click", function () {
            saveAll.disabled = true;
            saveCompareSheet(tiles, function () { saveAll.disabled = false; });
        });
        bar.appendChild(saveAll);

        var close = el("button", "mui-compare-close", "닫기");
        close.type = "button";
        close.addEventListener("click", closeCompare);
        bar.appendChild(close);

        var grid = el("div", "mui-compare-grid");
        // 배너를 뗀 뒤 화면을 채운다. 그 전까지는 빈 자리만 보인다(잠깐이다).
        cleanTiles(tiles, function () {
            tiles.forEach(function (t) {
                var cell = el("figure", "mui-compare-cell");
                var im = document.createElement("img");
                // 크기를 미리 알려준다. 이게 없으면 그림이 도착하기 전까지
                // 칸이 제 높이를 모르고, 그 사이 한 번 찌그러진 채로 그려진다.
                if (t.w && t.h) { im.width = t.w; im.height = t.h; }
                else if (t.aspect) { im.style.aspectRatio = String(t.aspect); }
                im.src = t.src;
                im.alt = "";
                // 가로폭을 채우고 세로는 그 비율만큼. 잘라내지 않는다.
                cell.appendChild(im);
                cell.appendChild(el("figcaption", null, t.label));
                // 목록의 한 장은 작다. 자세히 볼 때는 눌러서 화면 가득 띄운다.
                cell.addEventListener("click", function () { openLightbox(t); });
                grid.appendChild(cell);
            });
        });

        compare.appendChild(bar);
        compare.appendChild(grid);
        document.body.appendChild(compare);

        // 보는 동안 새 결과가 저장되면 화면도 따라 갱신한다
        history().onChange = function () { if (compare) { closeCompare(); openCompare(); } };
    }

    /**
     * 비교 화면의 사진 한 장에 손가락 확대·이동을 붙인다.
     *
     *   두 손가락 오므리기/벌리기 → 확대·축소 (1~6배)
     *   확대된 상태에서 한 손가락  → 사진 이동
     *   두 번 톡톡               → 원래 크기로
     *   한 번 톡                 → 그 사진만 한 줄 전체로 (원래 동작)
     *
     * 확대 전에는 touch-action:pan-y 라 세로로 밀면 목록이 스크롤되고,
     * 확대한 뒤에는 none 으로 바꿔 손가락 이동이 사진에 전달되게 한다.
     */
    function makeZoomable(cell, img, grid) {
        var scale = 1, tx = 0, ty = 0;
        var pinch = null;       // 두 손가락 시작 상태
        var pan = null;         // 한 손가락 이동 시작 상태
        var moved = false;
        var lastTap = 0;

        function dist(a, b) {
            return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        }
        function clampPan() {
            // 확대한 만큼만 움직이게 묶어 둔다 (사진이 밖으로 날아가지 않게)
            var r = img.getBoundingClientRect();
            var maxX = Math.max(0, (r.width * scale - r.width) / 2);
            var maxY = Math.max(0, (r.height * scale - r.height) / 2);
            tx = Math.max(-maxX, Math.min(maxX, tx));
            ty = Math.max(-maxY, Math.min(maxY, ty));
        }
        function apply() {
            clampPan();
            img.style.transform =
                "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
            var zoomed = scale > 1.01;
            cell.style.touchAction = zoomed ? "none" : "pan-y";
            cell.classList.toggle("is-zoomed", zoomed);
        }
        function reset() { scale = 1; tx = 0; ty = 0; apply(); }
        cell.__resetZoom = reset;

        cell.addEventListener("touchstart", function (e) {
            if (e.touches.length === 2) {
                pan = null;
                moved = true;
                pinch = {
                    d: dist(e.touches[0], e.touches[1]),
                    scale: scale,
                    tx: tx, ty: ty,
                    mx: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                    my: (e.touches[0].clientY + e.touches[1].clientY) / 2
                };
                e.preventDefault();
            } else if (e.touches.length === 1) {
                moved = false;
                if (scale > 1.01) {
                    pan = { x: e.touches[0].clientX, y: e.touches[0].clientY, tx: tx, ty: ty };
                }
            }
        }, { passive: false });

        cell.addEventListener("touchmove", function (e) {
            if (pinch && e.touches.length === 2) {
                var d = dist(e.touches[0], e.touches[1]);
                if (pinch.d > 0) {
                    scale = Math.max(1, Math.min(6, pinch.scale * (d / pinch.d)));
                    // 손가락 가운데를 따라 사진도 같이 움직이게
                    var mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                    var my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                    tx = pinch.tx + (mx - pinch.mx);
                    ty = pinch.ty + (my - pinch.my);
                    apply();
                }
                e.preventDefault();
            } else if (pan && e.touches.length === 1) {
                var dx = e.touches[0].clientX - pan.x;
                var dy = e.touches[0].clientY - pan.y;
                if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
                tx = pan.tx + dx;
                ty = pan.ty + dy;
                apply();
                e.preventDefault();
            }
        }, { passive: false });

        cell.addEventListener("touchend", function (e) {
            if (e.touches.length === 0) {
                pinch = null;
                pan = null;
                if (scale < 1.02) reset();          // 거의 원래 크기면 딱 맞춰준다

                if (!moved) {
                    var now = Date.now();
                    if (now - lastTap < 300) {       // 두 번 톡톡 → 원래대로
                        reset();
                        lastTap = 0;
                    } else {
                        lastTap = now;
                        if (scale < 1.01) toggleWide();
                    }
                }
            }
        });

        // 마우스로도 확인할 수 있게 (개발·태블릿 겸용)
        cell.addEventListener("click", function () {
            if (moved || scale > 1.01) return;
            // 터치가 있는 기기에서는 위 touchend 가 이미 처리했다
            if (cell.__touched) { cell.__touched = false; return; }
            toggleWide();
        });
        cell.addEventListener("touchstart", function () { cell.__touched = true; }, { passive: true });

        function toggleWide() {
            var wide = cell.classList.contains("is-wide");
            grid.querySelectorAll(".is-wide").forEach(function (c) {
                c.classList.remove("is-wide");
                if (c.__resetZoom) c.__resetZoom();
            });
            if (!wide) cell.classList.add("is-wide");
        }

        img.addEventListener("dragstart", function (e) { e.preventDefault(); });
    }

    var lightbox = null;

    /** 사진 한 장을 화면 가득 띄운다. 잘리지 않게 통째로 넣고, 손가락으로 확대할 수 있다. */
    function openLightbox(tile) {
        closeLightbox();
        lightbox = el("div", "mui-lightbox");

        var body = el("div", "mui-lightbox-body");
        var im = document.createElement("img");
        im.src = tile.src;
        im.alt = "";
        body.appendChild(im);

        var bar = el("div", "mui-lightbox-bar");
        bar.appendChild(el("span", "mui-lightbox-title", tile.label || ""));
        var close = el("button", "mui-lightbox-close", "닫기");
        close.type = "button";
        close.addEventListener("click", closeLightbox);
        bar.appendChild(close);

        lightbox.appendChild(bar);
        lightbox.appendChild(body);
        document.body.appendChild(lightbox);

        // 두 손가락으로 더 크게 볼 수 있다 (두 번 톡톡 → 원래대로)
        makeZoomable(body, im, body);
    }

    function closeLightbox() {
        if (!lightbox) return;
        lightbox.remove();
        lightbox = null;
    }

    function closeCompare() {
        closeLightbox();
        if (!compare) return;
        compare.remove();
        compare = null;
        if (history()) history().onChange = null;
    }

    /** 저장된 결과물을 한꺼번에 사진첩에 넣는다. */
    function saveAll() {
        var h = history();
        var items = h ? h.items() : [];
        if (items.length === 0) { alert("저장된 결과물이 없습니다."); return; }
        if (!confirm(items.length + "장을 모두 사진첩에 저장할까요?")) return;

        // 한 장씩 순서대로 넘긴다. 앱 셸이 줄을 세워 하나씩 처리한다.
        items.forEach(function (it, i) {
            setTimeout(function () { h.download(it); }, i * 120);
        });
    }

    attachSteppers();

    // ── 5-3. 퀵 모드 ────────────────────────────────────────────────────
    // 고객을 앞에 두고 쓰는 화면. 세부 조절바를 전부 펼쳐 두면 고르는 데만
    // 시간이 걸려 상담이 늘어진다. 실제로 손이 가는 항목만 큼직하게 남긴다.
    //
    // 핵심은 '퀵으로 맞춘 값이 메뉴얼에서 그대로 이어져야' 한다는 점이다.
    // 그래서 새 조절바를 만들지 않고 **원래 조절바 노드를 그대로 옮겨 온다.**
    // (값·이벤트·되돌리기 기록이 전부 원본 노드에 붙어 있다)
    // 옮기기 전 자리를 적어 두었다가 메뉴얼로 돌아갈 때 제자리에 꽂는다.

    /** 빌려 온 노드의 원래 자리와 원래 라벨 */
    var borrowed = [];

    /**
     * @param node       옮겨 올 노드 (.ctrl-row 등)
     * @param quickLabel 퀵에서 쓸 이름. 없으면 원래 이름 그대로.
     */
    /** @param slot 퀵에서 이 행이 들어갈 자리. 없으면 기본 슬롯. */
    function borrow(node, quickLabel, slot) {
        if (!node || !node.parentNode) return;
        var lb = node.querySelector ? node.querySelector("label") : null;
        // 라벨은 "아이콘 이름 <span>값</span>" 꼴이라 첫 글자마디만 갈아 끼운다
        var first = lb && lb.firstChild && lb.firstChild.nodeType === 3 ? lb.firstChild : null;

        // 원래 자리에 표식을 하나 남겨 둔다. '앞뒤 형제'로 기억하면 이웃까지
        // 같이 빌려 갔을 때 돌려놓는 차례에 따라 순서가 뒤집힌다.
        // 표식은 그대로 두고 그 앞에 다시 꽂기만 하면 몇 번을 오가도 제자리다.
        var mark = document.createComment("mui-slot");
        node.parentNode.insertBefore(mark, node);

        borrowed.push({
            node: node, mark: mark, slot: slot || null,
            textNode: first, orig: first ? first.nodeValue : null,
            quick: quickLabel || null
        });
    }

    function giveBack() {
        borrowed.forEach(function (r) {
            if (r.textNode && r.orig != null) r.textNode.nodeValue = r.orig;
            if (r.mark && r.mark.parentNode) r.mark.parentNode.insertBefore(r.node, r.mark);
        });
    }

    /** 퀵 화면의 작은 제목 */
    function qhead(text) { return el("div", "mui-qhead", text); }

    // ── 대표 색상 칩 ────────────────────────────────────────────────────
    // 색상은 원본 컨트롤(눈썹=드롭다운, 입술=칩)을 대신 눌러 주기만 한다.
    // 노드를 옮기지 않으니 메뉴얼 쪽 화면이 그대로 남는다.
    function quickColors() {
        var list = [];
        var current = null;

        if (isBrow) {
            var sel = $("selectColorPreset");
            if (!sel) return null;
            // 퀵은 현장에서 실제로 고르는 네 가지만 둔다.
            // 리얼블랙 · 다크브라운 · 내추럴브라운 · 라이트브라운
            // (나머지는 메뉴얼 색상 탭에 그대로 있다)
            var QUICK_BROW = ["#000000", "#3D2B1F", "#5C4033", "#8B5A2B"];
            Array.prototype.forEach.call(sel.options, function (o) {
                if (o.value === "custom") return;
                if (QUICK_BROW.indexOf(String(o.value).toUpperCase()) < 0) return;
                list.push({
                    hex: o.value, name: o.textContent.trim(),
                    pick: function () {
                        sel.value = o.value;
                        sel.dispatchEvent(new Event("change", { bubbles: true }));
                    }
                });
            });
            current = function () { return sel.value; };
        } else {
            var chips = document.querySelectorAll(".color-chip[data-color]");
            if (!chips.length) return null;
            Array.prototype.forEach.call(chips, function (c) {
                list.push({
                    hex: c.getAttribute("data-color"), name: c.textContent.trim(),
                    pick: function () { c.click(); }
                });
            });
            current = function () {
                var on = document.querySelector(".color-chip.active[data-color]");
                return on ? on.getAttribute("data-color") : null;
            };
        }

        var wrap = el("div", "mui-qcolors");
        var made = [];
        list.forEach(function (c) {
            var b = el("button", "mui-qcolor");
            b.type = "button";
            var dot = el("i");
            dot.style.background = c.hex;
            b.appendChild(dot);
            b.appendChild(el("em", null, c.name));
            b.addEventListener("click", function () {
                c.pick();
                made.forEach(function (o) { o.b.classList.remove("is-active"); });
                b.classList.add("is-active");
            });
            wrap.appendChild(b);
            made.push({ b: b, hex: c.hex });
        });

        wrap.sync = function () {
            var now = current && current();
            made.forEach(function (o) {
                o.b.classList.toggle("is-active",
                    !!now && String(o.hex).toLowerCase() === String(now).toLowerCase());
            });
        };
        return wrap;
    }

    // ── 입술 볼륨 (오버립) ──────────────────────────────────────────────
    // 윗입술은 상부 외곽을, 아랫입술은 하부 외곽을 밀어내면 도톰해진다.
    // 퀵에는 세 줄을 둔다 — 둘을 한 번에 미는 '도톰하게', 그리고 위·아래를
    // 따로 잡는 두 줄. 윗입술만 도톰하게 넣는 시술이 따로 있다.
    //
    // 셋 다 결국 같은 조절바를 움직이는 것이라, 하나를 만지면 나머지 숫자도
    // 따라 맞춘다. 그러지 않으면 한 화면에 서로 다른 숫자가 남는다.
    var overRows = [];
    var overDragging = null;          // 지금 손가락이 잡고 있는 줄

    function syncOverRows() {
        overRows.forEach(function (r) {
            // 잡고 있는 줄은 건드리지 않는다. 끌던 손잡이가 튄다.
            if (r !== overDragging && r.sync) r.sync();
        });
    }

    /**
     * 오버립 한 줄을 만든다.
     * @param text    퀵 화면에 보일 이름
     * @param targets 함께 움직일 원래 조절바 (하나 또는 둘)
     */
    function overRow(text, targets) {
        targets = targets.filter(Boolean);
        if (!targets.length) return null;
        var MAX = 40;

        var row = el("div", "ctrl-row");
        var label = el("label", null, text);
        var step = el("span", "mui-step");
        var val = el("span", null, "0px");
        var rng = document.createElement("input");
        rng.type = "range"; rng.min = "0"; rng.max = String(MAX); rng.step = "1";

        /** phase: "down" 잡음 / "up" 놓음 / 없으면 값 반영 */
        function drive(v, phase) {
            targets.forEach(function (t) {
                if (phase === "down") {
                    try { t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); } catch (e) {}
                    return;
                }
                if (phase === "up") {
                    try { t.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); } catch (e) {}
                    return;
                }
                t.value = v;
                t.dispatchEvent(new Event("input", { bubbles: true }));
                t.dispatchEvent(new Event("change", { bubbles: true }));
            });
            if (phase === "up") {
                try { window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); } catch (e) {}
            }
        }

        function show(v) { val.textContent = String(v) + "px"; }

        function bump(dir) {
            var cur = parseFloat(rng.value) || 0;
            var next = Math.min(MAX, Math.max(0, cur + dir));
            if (next === cur) return;
            rng.value = next;
            show(next);
            drive(null, "down"); drive(next); drive(null, "up");
            syncOverRows();
        }

        var minus = el("button", "mui-step-btn", "\u2212");
        var plus = el("button", "mui-step-btn", "+");
        minus.type = plus.type = "button";
        minus.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); bump(-1); });
        plus.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); bump(+1); });

        step.appendChild(minus); step.appendChild(val); step.appendChild(plus);
        label.appendChild(step);
        row.appendChild(label); row.appendChild(rng);

        function release() {
            drive(null, "up");
            overDragging = null;
            syncOverRows();
        }

        rng.addEventListener("pointerdown", function () {
            overDragging = row;
            drive(null, "down");
        });
        rng.addEventListener("input", function () {
            show(rng.value); drive(rng.value); syncOverRows();
        });
        rng.addEventListener("pointerup", release);
        rng.addEventListener("pointercancel", release);

        // 메뉴얼에서 값을 만지고 돌아왔을 수 있으니 들어올 때마다 맞춘다.
        // 두 조절바를 함께 보는 줄은 큰 쪽을 보여 준다.
        row.sync = function () {
            var v = 0;
            targets.forEach(function (t) { v = Math.max(v, parseFloat(t.value) || 0); });
            rng.value = v; show(v);
        };
        row.sync();

        overRows.push(row);
        return row;
    }

    /** 퀵에 놓을 오버립 세 줄 */
    function fullnessRows() {
        var up = $("rngUpperTopOver"), lo = $("rngLowerBottomOver");
        if (!up || !lo) return [];

        var rows = [
            overRow("\uD83D\uDC8B 도톰하게 ", [up, lo]),
            overRow("\uD83D\uDD3A 윗입술 볼륨 ", [up]),
            overRow("\uD83D\uDD3B 아랫입술 볼륨 ", [lo])
        ].filter(Boolean);

        // 되돌리기·원본복원처럼 캔버스 쪽에서 값을 되돌려 놓는 경우가 있다.
        // 원래 조절바의 숫자 표시가 바뀌는 것을 보고 따라 맞춘다.
        if (typeof MutationObserver === "function") {
            ["valUpperTopOver", "valLowerBottomOver"].forEach(function (id) {
                var mirror = $(id);
                if (!mirror) return;
                new MutationObserver(function () { syncOverRows(); })
                    .observe(mirror, { childList: true, characterData: true, subtree: true });
            });
        }
        return rows;
    }

    // ── 눈썹 디자인 넘겨 고르기 ────────────────────────────────────────
    // 퀵에서도 디자인을 바꿀 수 있어야 한다. 설정 화면까지 되돌아갔다 오면
    // 고객을 앞에 두고 흐름이 끊긴다. 좌우로 넘겨 고르면 그 자리에서 바뀐다.
    function quickDesigns() {
        var list = (window.CFG && window.CFG.designs) || [];
        if (!isBrow || !list.length) return null;

        var strip = el("div", "mui-qdesigns");
        var made = [];

        list.forEach(function (d) {
            var b = el("button", "mui-qdesign");
            b.type = "button";
            b.setAttribute("data-key", d.key);
            var im = document.createElement("img");
            im.src = d.url;
            im.alt = "";
            b.appendChild(im);
            b.appendChild(el("em", null, d.label));
            b.addEventListener("click", function () {
                if (b.classList.contains("is-active")) return;
                made.forEach(function (o) { o.classList.remove("is-active"); });
                b.classList.add("is-active");
                try {
                    window.parent.postMessage({ type: "mui:pickDesign", key: d.key }, "*");
                } catch (e) {}
            });
            strip.appendChild(b);
            made.push(b);
        });

        strip.mark = function (key) {
            made.forEach(function (b) {
                b.classList.toggle("is-active", b.getAttribute("data-key") === key);
            });
            var on = strip.querySelector(".is-active");
            // 지금 고른 것이 화면 밖이면 끌어다 놓는다
            if (on && on.scrollIntoView) {
                try { on.scrollIntoView({ block: "nearest", inline: "center" }); } catch (e) {}
            }
        };
        strip.mark(window.CFG.design_key);
        return strip;
    }

    // ── 퀵 화면 조립 ────────────────────────────────────────────────────
    var qColors = quickColors();
    var qStrip = quickDesigns();
    var qExtra = [];

    if (qStrip) {
        quick.appendChild(qhead("눈썹 디자인 · 좌우로 넘겨 고르기"));
        quick.appendChild(qStrip);
    }

    quick.appendChild(qhead("대표 색상"));
    if (qColors) quick.appendChild(qColors);

    // 색상 바로 아래 자리 — 색을 고르고 이어서 진하기를 맞추는 흐름이다
    var qColorSlot = el("div", "mui-qslot");
    quick.appendChild(qColorSlot);

    quick.appendChild(qhead(isBrow ? "모양 빠른 조절" : "입술 볼륨 · 투명도"));

    // 빌려 온 행이 들어올 자리 (전환 버튼보다 위)
    var qSlot = el("div", "mui-qslot");
    quick.appendChild(qSlot);

    if (isBrow) {
        // 현장에서 실제로 만지는 네 가지. 나머지는 메뉴얼에 그대로 남는다.
        // 원래 눈썹이 진한 고객은 이것부터 낮춰야 디자인이 보인다 — 맨 위에 둔다.
        borrow(rowOf("rngNatBrow"), "🔅 기존 눈썹 진하기 ");
        borrow(rowOf("rngHeight"), "↕️ 굵기 ");
        borrow(rowOf("rngWidth"), "↔️ 길이 ");
        borrow(rowOf("rngSpacing"), "↔️ 눈썹 간격 ");
        borrow(rowOf("rngVert"), "↕️ 위아래 ");
        borrow(rowOf("rngRot"), "↗️ 각도 ");
        // 색상 진하기. 고른 색 바로 아래에 붙인다.
        borrow(rowOf("rngOpacity"), null, qColorSlot);
    } else {
        fullnessRows().forEach(function (r) {
            qSlot.appendChild(r); qExtra.push(r);
        });
        // 입꼬리 오버립 — 윗입술·아랫입술 따로. 현장에서 자주 만지는 값이다.
        borrow(rowOf("rngCornerOverU"), "↗️ 입꼬리 오버립 (윗) ");
        borrow(rowOf("rngCornerOverL"), "↘️ 입꼬리 오버립 (아래) ");
        // 틴트 투명도. 원래 조절바를 그대로 옮겨 와서 메뉴얼과 값이 이어진다.
        // (라벨을 바꾸지 않으므로 두 화면에서 같은 이름으로 보인다)
        borrow(rowOf("rngOpacity"), null);
    }

    var qSwitch = el("button", "mui-qswitch", "🎚️ 메뉴얼로 전환해서 세부 조정");
    qSwitch.type = "button";
    qSwitch.addEventListener("click", function () { setUiMode("manual"); });
    quick.appendChild(qSwitch);

    function lendToQuick() {
        borrowed.forEach(function (r) {
            (r.slot || qSlot).appendChild(r.node);
            if (r.textNode && r.quick) r.textNode.nodeValue = r.quick;
        });
    }

    // ── 모드 전환 ───────────────────────────────────────────────────────
    var modeApplied = null;

    function syncQuick() {
        if (qColors && qColors.sync) qColors.sync();
        qExtra.forEach(function (n) { if (n.sync) n.sync(); });
    }

    /** @param silent 앱 셸이 시킨 전환이면 true (되돌려 알릴 필요가 없다) */
    function setUiMode(mode, silent) {
        mode = mode === "manual" ? "manual" : "quick";
        if (mode === modeApplied) { if (mode === "quick") syncQuick(); return; }
        modeApplied = uiMode = mode;

        if (mode === "quick") { lendToQuick(); syncQuick(); }
        else giveBack();

        sheet.classList.toggle("is-quick", mode === "quick");
        mbQuick.classList.toggle("is-active", mode === "quick");
        mbManual.classList.toggle("is-active", mode === "manual");
        setSnap("half");

        if (!silent) {
            try { window.parent.postMessage({ type: "mui:mode", mode: mode }, "*"); } catch (e) {}
        }
    }

    // 되돌리기·초기화를 누르면 색상도 함께 되돌아간다. 칩 표시를 다시 맞춘다.
    actions.addEventListener("click", function () { setTimeout(syncQuick, 0); });

    mbQuick.addEventListener("click", function () { setUiMode("quick"); });
    mbManual.addEventListener("click", function () { setUiMode("manual"); });

    // 앱 셸(부위 선택 화면)의 퀵/메뉴얼 탭에서 바꿨을 때
    window.addEventListener("message", function (e) {
        var d = e.data;
        if (d && d.type === "mui:setMode") { setUiMode(d.mode, true); return; }
        // 앱 셸이 '지금 작업을 다른 부위로 넘길 그림' 을 달라고 한다
        if (d && d.type === "mui:capture") {
            var url = null;
            try {
                if (typeof window.__blCapture === "function") url = window.__blCapture();
            } catch (err) { url = null; }
            // 목록에서 알아볼 이름 — 눈썹은 디자인 이름, 입술은 색 이름
            var label = "";
            try {
                if (isBrow) {
                    label = (window.CFG && window.CFG.safe_design_name) || "";
                } else {
                    var on = document.querySelector(".color-chip.active[data-color]");
                    label = on ? on.textContent.trim() : "";
                }
            } catch (err) {}
            try {
                window.parent.postMessage(
                    { type: "mui:captured", part: KIND, dataUrl: url, label: label }, "*");
            } catch (err) {}
            return;
        }
        // 앱 셸이 새 디자인을 구워 보냈다 — 밑그림만 갈아 끼운다
        if (d && d.type === "mui:brow") {
            if (typeof window.__blSwapBrow === "function") {
                window.__blSwapBrow(d.l_b64, d.r_b64, d.name);
            }
            if (qStrip && d.key) qStrip.mark(d.key);
        }
    });

    // 색상을 메뉴얼 쪽에서 바꿔도 퀵 칩에 반영되어야 한다
    (function () {
        var sel = isBrow ? $("selectColorPreset") : null;
        if (sel) { sel.addEventListener("change", syncQuick); return; }
        document.querySelectorAll(".color-chip[data-color]").forEach(function (c) {
            c.addEventListener("click", function () { setTimeout(syncQuick, 0); });
        });
    })();

    // 퀵으로 처음 들어올 때 입술은 '결과'를 보여준다.
    // 시술선은 디자인을 잡을 때 필요한 안내선이라, 고객에게 보여주는
    // 화면에서는 걷어내고 색이 채워진 입술만 남긴다.
    // (한 번만 맞춰 준다 — 이후에 원장님이 켜고 끈 것을 되돌리지 않는다)
    if (!isBrow) {
        var line = $("btnToggleDesignLine");
        var fill = $("btnToggleFillTint");
        if (uiMode === "quick") {
            if (line && line.classList.contains("active")) line.click();
            if (fill && !fill.classList.contains("active")) fill.click();
        }
    }

    setUiMode(uiMode, true);


    // ── 6. 바텀시트 드래그 ──────────────────────────────────────────────
    var SNAPS = ["peek", "half", "full"];

    /** 시트가 실제로 가리는 높이만큼 무대 아래에 여백을 줘서, 사진이 '보이는
     *  영역'의 한가운데 오도록 한다. (사진 크기 자체는 건드리지 않는다) */
    function syncStagePadding() {
        var top = sheet.getBoundingClientRect().top;
        var covered = Math.max(0, window.innerHeight - top);
        stage.style.paddingBottom = Math.max(8, Math.round(covered) + 8) + "px";
    }

    function setSnap(s) {
        sheet.setAttribute("data-snap", s);
        requestAnimationFrame(syncStagePadding);
    }

    // 시트 크기가 바뀔 때마다 여백을 다시 잡는다.
    //
    // 예전에는 transitionend 에만 기대고 있었다. 그런데 손으로 끄는 동안에는
    // transition 을 꺼두기 때문에(is-dragging) 그 이벤트가 아예 오지 않는다.
    // 시트를 활짝 폈다가 손으로 끌어내리면 여백이 '활짝 편 상태' 값으로 남아
    // 사진이 손톱만 하게 줄어든 채 돌아오지 않았다.
    // 크기 변화를 직접 지켜보면 어느 경로로 바뀌든 빠짐없이 따라간다.
    if (typeof ResizeObserver === "function") {
        new ResizeObserver(syncStagePadding).observe(sheet);
    }
    sheet.addEventListener("transitionend", syncStagePadding);
    window.addEventListener("resize", syncStagePadding);

    var dragStartY = null, dragStartSnap = null;

    function onDown(e) {
        dragStartY = (e.touches ? e.touches[0].clientY : e.clientY);
        dragStartSnap = sheet.getAttribute("data-snap");
        sheet.classList.add("is-dragging");
    }
    function onMove(e) {
        if (dragStartY == null) return;
        var y = (e.touches ? e.touches[0].clientY : e.clientY);
        var dy = y - dragStartY;
        var base = { peek: 2, half: 1, full: 0 }[dragStartSnap];
        var step = window.innerHeight * 0.18;
        var idx = base + (dy > step ? 1 : dy < -step ? -1 : 0);
        idx = Math.max(0, Math.min(2, idx));
        sheet.setAttribute("data-snap", SNAPS[2 - idx]);
        syncStagePadding();          // 끄는 도중에도 사진 자리를 따라가게
        e.preventDefault();
    }
    function onUp() {
        if (dragStartY == null) return;
        dragStartY = null;
        sheet.classList.remove("is-dragging");
        requestAnimationFrame(syncStagePadding);
    }

    handle.addEventListener("touchstart", onDown, { passive: true });
    handle.addEventListener("touchmove", onMove, { passive: false });
    handle.addEventListener("touchend", onUp);
    handle.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    handle.addEventListener("click", function () {
        setSnap(sheet.getAttribute("data-snap") === "peek" ? "half" : "peek");
    });

    requestAnimationFrame(syncStagePadding);
    setTimeout(syncStagePadding, 350);

    // ── 7. 높이 보고 차단 ───────────────────────────────────────────────
    // 원본 notifyHeight() 는 문서 scrollHeight 를 부모에 보고해 iframe 을 늘린다.
    // 모바일 레이아웃은 시트 높이가 vh 기준이라, 늘어난 iframe → 커진 vh →
    // 더 큰 scrollHeight → 또 늘어남 …으로 되먹임이 걸린다(실제로 44,072px 까지 불어남).
    // 여기서는 한 화면에 고정하므로 그 메시지만 걸러낸다.
    var _post = window.parent.postMessage.bind(window.parent);
    window.parent.postMessage = function (msg) {
        if (msg && msg.type === "streamlit:setFrameHeight") return;
        return _post.apply(null, arguments);
    };

    /* ── 7.5 버튼 줄을 한 줄에 맞춘다 ─────────────────────────────────
     *
     * CSS 가 화면 폭에 따라 글자를 줄여 주지만, 그것만으로는 모자란다.
     * 버튼의 글자 수는 기기가 아니라 상황이 정하기 때문이다 — '다시실행'
     * 이 나타나거나 디자인 이름이 길면 같은 폭에서도 더 넓어진다.
     *
     * 그래서 실제로 재어 본다. 넘치면 --fit 을 한 단계씩 낮춰 다시 잰다.
     * 줄바꿈이나 잘림 대신 조금 작아지는 쪽을 고른 것이다. 상담 중에
     * 버튼이 안 보이는 것보다 작은 편이 낫다.
     */
    /** 자식들이 실제로 차지하는 폭. scrollWidth 는 못 쓴다 —
     *  넘쳐도 overflow 가 잘라 버리면 clientWidth 와 같은 값이 나온다. */
    function needWidth(row) {
        var cs = getComputedStyle(row);
        var gap = parseFloat(cs.columnGap) || parseFloat(cs.gap) || 0;
        var need = 0, n = 0;
        for (var i = 0; i < row.children.length; i++) {
            var k = row.children[i];
            var wpx = k.getBoundingClientRect().width;
            if (wpx <= 0) continue;                    // 숨겨진 버튼은 세지 않는다
            need += wpx;
            n++;
        }
        return need + gap * Math.max(0, n - 1);
    }

    /** 자식이 들어갈 수 있는 폭 (좌우 여백을 뺀 안쪽) */
    function availWidth(row) {
        var cs = getComputedStyle(row);
        return row.getBoundingClientRect().width
             - (parseFloat(cs.paddingLeft) || 0)
             - (parseFloat(cs.paddingRight) || 0);
    }

    /* 좁은 기기에서는 글자를 줄이기 **전에** 이름을 짧게 바꾼다.
     * 6~7px 로 쪼그라든 글자는 상담 중에 읽히지 않는다. 이름이 짧아지는
     * 편이 낫다 — 뜻은 남고 크기는 그대로다.
     *   0단계 원래 이름 · 1단계 말 줄이기 · 2단계 되돌리기/다시실행은 기호로 */
    var SHORT_LABELS = {
        "예상 디자인": ["디자인", "디자인"],
        "전체 초기화": ["초기화", "초기화"],
        "되돌리기":   ["되돌리기", "↶"],
        "다시실행":   ["다시실행", "↷"]
    };

    function tagLabels(row) {
        var bs = row.querySelectorAll("button");
        for (var i = 0; i < bs.length; i++) {
            var b = bs[i];
            if (b.hasAttribute("data-l0")) continue;
            if (b.children.length) continue;          // 아이콘이 든 버튼은 손대지 않는다
            var t = (b.textContent || "").trim();
            if (!t) continue;
            var sh = SHORT_LABELS[t];
            b.setAttribute("data-l0", t);
            b.setAttribute("data-l1", sh ? sh[0] : t);
            b.setAttribute("data-l2", sh ? sh[1] : t);
            // 기호만 남아도 길게 눌러 뜻을 알 수 있게
            if (sh && sh[1] !== t && !b.title) b.title = t;
        }
    }

    function setLabelLevel(row, lv) {
        var bs = row.querySelectorAll("button");
        for (var i = 0; i < bs.length; i++) {
            var b = bs[i];
            var want = b.getAttribute("data-l" + lv);
            if (want !== null && b.textContent !== want) b.textContent = want;
        }
    }

    /**
     * @param floor    한 줄에 담으려고 줄여 볼 수 있는 한계
     * @param giveUp   그래도 못 담을 때 되돌릴 크기 (없으면 floor 에 둔다).
     *                 줄바꿈이 되는 줄에서는 바닥까지 줄여 봐야 읽기만 어려워진다.
     */
    function fitRow(row, floor, giveUp) {
        if (!row || !row.children.length) return;
        tagLabels(row);
        // 딱 맞게 줄이면 글꼴이 늦게 바뀌거나 소수점이 밀릴 때 다시 넘친다.
        // 2px 은 남겨 두고 맞춘다.
        row.style.setProperty("--fit", "1");
        for (var lv = 0; lv <= 2; lv++) {
            setLabelLevel(row, lv);
            if (needWidth(row) <= availWidth(row) - 2) return;
        }
        // 이름을 다 줄여도 모자라는 아주 좁은 기기에서만 글자를 줄인다
        for (var f = 0.96; f >= floor; f -= 0.03) {
            row.style.setProperty("--fit", String(Math.round(f * 100) / 100));
            if (needWidth(row) <= availWidth(row) - 2) return;
        }
        if (giveUp) row.style.setProperty("--fit", String(giveUp));
    }

    var fitJob = 0, fitWatch = null;
    function fitBars() {
        if (fitJob) cancelAnimationFrame(fitJob);
        fitJob = requestAnimationFrame(function () {
            fitJob = 0;
            // 이름을 바꾸면 관찰자가 우리를 다시 부른다. 재는 동안은 떼어 둔다.
            if (fitWatch) fitWatch.disconnect();
            fitRow(topbar, 0.82);
            // 칩 줄은 줄바꿈이 되므로, 조금 줄여 한 줄에 들어가면 그것으로 좋고
            // 안 되면 억지로 더 줄이지 않고 다음 줄로 넘긴다.
            fitRow(chips, 0.80, 0.92);
            if (fitWatch) watchBars();
        });
    }

    fitBars();
    // 웹폰트가 늦게 오면 글자 폭이 달라진다. 몇 번 더 재어 본다.
    [60, 200, 500, 1000].forEach(function (ms) { setTimeout(fitBars, ms); });
    window.addEventListener("resize", fitBars);
    window.addEventListener("orientationchange", function () { setTimeout(fitBars, 250); });

    // 퀵 ↔ 메뉴얼을 오가면 버튼이 드나든다. 그때마다 다시 잰다.
    function watchBars() {
        fitWatch.observe(topbar, { childList: true, subtree: true, characterData: true });
        fitWatch.observe(chips, { childList: true, subtree: true, characterData: true });
    }
    if (window.MutationObserver) {
        fitWatch = new MutationObserver(fitBars);
        watchBars();
    }

    // ── 8. 부모(앱 셸)에 준비 완료 알림 → iframe 높이 고정 ──────────────
    try {
        // 띄울 때 심어 준 번호를 그대로 돌려준다. 앱 셸이 이 번호로
        // '이미 내려간 화면이 뒤늦게 보낸 신호' 를 걸러낸다.
        _post({ type: "mui:ready", gen: (window.CFG && window.CFG.mount_gen) || 0 }, "*");
    } catch (e) { /* 무시 */ }
})();
