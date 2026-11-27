/* ── 튜토리얼 (2026-11-24 원장님 요청: "게임처럼 처음 시작할 때 따라 하는 튜토리얼") ─────────────
 *
 * 처음 켜면 "튜토리얼을 진행하겠습니까?" → 예 / 아니요. 예를 누르면 눈썹부터 입술까지
 * 실제 버튼 위에 빛을 비추고, 원장님이 직접 눌러 따라 하면 다음 단계로 넘어간다.
 *   - 위쪽에 「단계 n / 전체」와 지금 장(시작 · 눈썹 · 입술), 오른쪽 위에 작은 「건너뛰기」
 *   - 사진이 없으면 「예시 사진으로 하기」 (메뉴얼에 쓰는 시연 모델 사진 assets/tutorial/model.jpg)
 *   - 언제든 다시: 버전 화면 「튜토리얼 진행하기」 → window.PMUS_TUTORIAL.start()
 *   - 본 적이 있는지는 이 기기(localStorage "pmus.tutorial")에만 — "done" · "no"
 * 화면을 고치지 않는 덧씌우기라 앱 코드와는 선택자(id · class)로만 이어진다. 선택자가 바뀌면 여기 STEPS 도 고친다.
 * 편집 화면(iframe #sim-frame) 안의 버튼은 "f:" 를 붙여 찾는다.
 * 글자는 언어팩(i18n.js)이 화면에 붙을 때 번역한다 — 새 문장을 넣으면 tools/i18n-extract.mjs 로 사전을 채운다.
 * ------------------------------------------------------------------- */
(function () {
    "use strict";
    var KEY = "pmus.tutorial";
    var Z = 2147483000;

    function $(id) { return document.getElementById(id); }
    /** 글자 틀 — 한국어 문장 틀을 언어팩 사전에서 찾아 {이름} 자리를 채운다 (붙여 만든 문장은 사전에 없어서) */
    function T(ko, v) {
        var I = window.PMUS_I18N, s = ko;
        try {
            var d = I && I.lang !== "ko" && I.dict && I.dict();
            if (d) {
                // 사전 열쇠는 숫자를 {#} 로 적는다 — 숫자는 차례대로 되돌려 넣는다
                var NUM = /\d[\d,]*(?:\.\d+)?/g, nums = ko.match(NUM) || [], k2 = ko.replace(NUM, "{#}"), i = 0;
                if (d[ko]) s = d[ko];
                else if (d[k2]) s = d[k2].replace(/\{#\}/g, function () { return nums[i++] || ""; });
            }
        } catch (e) {}
        return v ? s.replace(/\{([a-z]+)\}/g, function (m, k) { return k in v ? v[k] : m; }) : s;
    }
    function frameDoc() {
        var f = $("sim-frame");
        try { return f && f.contentDocument; } catch (e) { return null; }
    }
    function visible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        var r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        var cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
    }
    /** "#id" · ".cls" 는 앱 화면, "f:…" 는 편집 화면 안 */
    function find(spec) {
        if (!spec) return null;
        if (typeof spec === "function") { var fe = spec(); return fe && visible(fe) ? fe : null; }
        var inFrame = spec.indexOf("f:") === 0, sel = inFrame ? spec.slice(2) : spec;
        var doc = inFrame ? frameDoc() : document;
        if (!doc) return null;
        if (sel.indexOf("row:") === 0) {         // 조절바 한 줄 (이름표 + 막대)
            var inp = doc.querySelector(sel.slice(4));
            var row = inp && (inp.closest(".ctrl-row") || inp);
            return row && visible(row) ? row : null;
        }
        var list = doc.querySelectorAll(sel);
        for (var i = 0; i < list.length; i++) if (visible(list[i])) return list[i];
        return null;
    }
    /** 화면 좌표 (편집 화면 안이면 iframe 자리를 더한다) */
    function rectOf(el) {
        var r = el.getBoundingClientRect(), x = r.left, y = r.top;
        if (el.ownerDocument !== document) {
            var fr = $("sim-frame").getBoundingClientRect();
            x += fr.left; y += fr.top;
        }
        return { x: x, y: y, w: r.width, h: r.height };
    }
    /** 편집 화면이 열렸는지 — kind 를 주면 그 부위(brow · lip) 편집 화면인지까지 */
    function editorOpen(kind) {
        var d = frameDoc();
        // 설정 화면(사진 · 디자인 변경)이 편집 화면 위에 떠 있으면(settings-open) 편집 화면이 안 보이는 것으로 본다
        var b = document.body.classList;
        if (!(b.contains("sim-fullscreen") && !b.contains("settings-open") && d && d.querySelector(".mui-shell"))) return false;
        if (kind === "lip") return !!d.getElementById("lipCanvas");
        if (kind === "brow") return !d.getElementById("lipCanvas");
        return true;
    }
    function clickIf(spec) { var e = find(spec); if (e) e.click(); return !!e; }

    /** 예시 사진 (시연 모델) — 앨범에서 고른 것과 똑같이 넣는다 */
    function useSamplePhoto() {
        var inp = $("file-gallery");
        if (!inp) return;
        fetch("assets/tutorial/model.jpg").then(function (r) { return r.blob(); }).then(function (b) {
            var f = new File([b], "PMUS_sample.jpg", { type: "image/jpeg" });
            var dt = new DataTransfer();
            dt.items.add(f);
            inp.files = dt.files;
            inp.dispatchEvent(new Event("change", { bubbles: true }));
        }).catch(function () { alert("예시 사진을 불러오지 못했습니다. 앨범에서 사진을 골라 주세요."); });
    }

    // ── 단계 ──
    // target: 비출 곳 · act: "click" | "input" (그 동작을 하면 다음으로) · done: 이미 됐으면 건너뜀 · ready: 이것이 참이 될 때까지 '다음' 을 막음
    // optional: 정해진 시간 안에 대상이 안 나오면 건너뜀 · before: 단계를 시작할 때 할 일
    function photoIn() { var p = $("photo-preview"); return !!(p && !p.hidden); }
    // 눈썹 · 입술 코스를 따로 고른다 (2026-11-24 원장님: "눈썹과 입술 각각 나눠서 선택")
    function startSteps(part) {
        var name = part === "lip" ? "입술" : "눈썹";
        return [
            { ch: "시작", title: part === "lip" ? "PMUS 입술 튜토리얼" : "PMUS 눈썹 튜토리얼",
              text: part === "lip"
                ? "고객 사진 한 장으로 입술 시술 후 모습을 만들어 봅니다. 빛나는 곳을 직접 눌러 따라 하세요. 언제든 오른쪽 위 「건너뛰기」로 그만둘 수 있습니다."
                : "고객 사진 한 장으로 디자인 고르기 · 색 · 세부 조절 · 좌우 따로 조절 · 비교 · 저장까지 차례로 해 봅니다. 빛나는 곳을 직접 눌러 따라 하시고, 잘하시면 박수가 나온 뒤 다음 단계로 넘어갑니다. 언제든 오른쪽 위 「건너뛰기」로 그만둘 수 있습니다." },
            { ch: "시작", title: "고객 사진 넣기", target: "#btn-gallery", text: "「앨범에서 선택」이나 「카메라로 촬영」으로 고객 사진을 넣습니다. 연습할 때는 아래 「예시 사진으로 하기」를 눌러도 됩니다.",
              extra: { label: "예시 사진으로 하기", run: useSamplePhoto },
              done: photoIn, ready: photoIn },
            { ch: "시작", title: "얼굴 인식", target: "#detect-status", text: "얼굴을 찾으면 초록색으로 바뀝니다. 빨간색이면 정면 사진으로 다시 넣어 주세요.",
              ready: function () { var m = $("step-mode"); return !!(m && !m.hidden); } },
        ];
    }
    /** 부위 고르기 → 「퀵」 (부위를 먼저 골라야 「퀵」을 눌렀을 때 그 부위 편집 화면이 열린다) */
    function partSteps(part) {
        var name = part === "lip" ? "입술" : "눈썹", ch = name;
        var open = function () { return editorOpen(part); };
        return [
            { ch: ch, title: part === "lip" ? "입술 고르기" : "눈썹 고르기", target: '[data-mode="' + part + '"]', act: "click",
              text: part === "lip" ? "시술 부위에서 「입술」을 눌러 보세요." : "시술 부위에서 「눈썹」을 눌러 보세요.",
              before: function () { if (editorOpen() && !open()) clickIf("f:.mui-settings"); },
              done: open },
            // 앞 작업이 있으면 어느 사진 위에서 이어갈지 고르는 칸이 먼저 나온다 (없으면 건너뜀)
            { ch: ch, title: "이어서 편집", target: "#carry-go", act: "click", optional: 3500, text: "앞 작업이 얹힌 사진으로 이어서 편집합니다. 위에서 사진을 고르고 「이 사진으로 편집하기」를 눌러 주세요.",
              done: open },
            { ch: ch, title: "편집 방식 고르기", target: '[data-edit="quick"]', act: "click", text: "「퀵」은 고객님 앞에서 바로 조절할 때 씁니다. 「퀵」을 누르면 편집 화면이 열립니다.",
              done: open },
        ];
    }
    /** 저장 · 마무리 (두 코스 같음) */
    function saveSteps(ch) {
        return [
            { ch: ch, title: "메뉴얼로 전환", target: "f:.mui-qswitch", act: "click", text: "세부 조절과 저장은 「메뉴얼」에서 합니다. 「메뉴얼로 전환」을 눌러 보세요." },
            { ch: ch, title: "저장 탭", target: 'f:.mui-tabs button[data-tab="save"]', act: "click", text: "💾 저장 탭을 눌러 보세요." },
            { ch: ch, title: "결과 저장", target: "f:#btnDownloadAfter", act: "click", text: "누르면 지금 화면 그대로 폰 사진첩에 저장됩니다. 눌러 보세요." },
        ];
    }

    /* ── 눈썹 코스 (2026-11-27 원장님 26단계 · 수치) ─────────────────────────
     * clap: 잘하셨습니다 박수를 3초 보여 주고 다음 단계로 (없으면 짧게 ✓ 만)
     * check: 이것이 참이 되면 해낸 것 · slider: { id, to } 조절바를 그 값까지 (「여기까지」 표시)
     * ------------------------------------------------------------------- */
    function fwin() { var f = $("sim-frame"); try { return f && f.contentWindow; } catch (e) { return null; } }
    function fq(sel) { var d = frameDoc(); return d ? d.querySelector(sel) : null; }
    function fval(id) { var d = frameDoc(), e = d && d.getElementById(id); return e ? parseFloat(e.value) : NaN; }
    function designKey() { var w = fwin(); try { return (w && w.CFG && w.CFG.design_key) || ""; } catch (e) { return ""; } }
    function sheetMode() {
        var sh = fq(".mui-sheet");
        if (!sh) return "";
        return sh.classList.contains("is-quick") ? "quick" : sh.classList.contains("is-fav") ? "fav" : "manual";
    }
    function browColor() { var e = fq("#selectColorPreset"); return e ? String(e.value).toUpperCase() : ""; }
    function splitPct() {
        var e = fq('[style*="--split"]');
        if (!e) return NaN;
        return parseFloat(e.style.getPropertyValue("--split"));
    }
    /** 퀵 디자인 — 보이면 그 디자인, 다른 탭이 열려 있으면 그 디자인의 탭 */
    function qDesign(key, tab) {
        return function () {
            var c = fq('.mui-qdesign[data-key="' + key + '"]');
            if (c && visible(c)) return c;
            return fq('.mui-idx-tabs [data-tab="' + tab + '"]') || fq(".mui-qdesigns");
        };
    }
    function lockBtn(id) {
        return function () {
            var d = frameDoc(), inp = d && d.getElementById(id);
            var row = inp && (inp.closest(".ctrl-row") || inp.parentNode);
            return row ? row.querySelector(".mui-lock") : null;
        };
    }
    function histCompareBtn() {
        var d = frameDoc();
        if (!d) return null;
        var l = d.querySelectorAll(".mui-histbtn");
        for (var i = 0; i < l.length; i++) if (/비교/.test(l[i].textContent) || l[i].textContent.indexOf(T("비교 보기")) >= 0) return l[i];
        return null;
    }
    var B = "눈썹";
    /** 조절바를 값까지 */
    function sl(id, to, title, text, clap) {
        return { ch: B, title: title, target: "f:row:#" + id, slider: { id: id, to: to }, text: text, clap: !!clap };
    }
    /** 메뉴얼 → 저장 탭 → 고화질 저장 */
    function saveHQ(clap, title) {
        return [
            { ch: B, title: "메뉴얼로 가기", target: "f:.mui-modebar button:nth-child(2)", act: "click", text: "시트 맨 위 「메뉴얼」을 눌러 보세요.",
              done: function () { return sheetMode() === "manual"; } },
            { ch: B, title: "저장 탭", target: 'f:.mui-tabs button[data-tab="save"]', act: "click", text: "「저장」 탭을 눌러 보세요." },
            { ch: B, title: title || "고화질 저장", target: "f:#btnDownloadAfter", act: "click", clap: clap,
              text: "「예상 디자인 고화질 저장」을 눌러 지금 디자인을 사진첩에 저장해 보세요." },
        ];
    }
    function toQuick() {
        return { ch: B, title: "퀵으로 가기", target: "f:.mui-modebar button:nth-child(1)", act: "click", text: "시트 맨 위 「퀵」을 눌러 보세요.",
                 done: function () { return sheetMode() === "quick"; } };
    }
    function browSteps() {
        var seenTabs = {}, seenColors = {};
        return [
            // 2. 디자인 둘러보기 — 자연결 · 그라데이션 · 콤보 · 남성 탭을 눌러 보고 디자인 하나 고르기
            { ch: B, title: "디자인 탭 둘러보기", target: "f:.mui-idx-tabs", wait: "편집 화면을 여는 중입니다…",
              text: "디자인 줄 위의 「자연결」 · 「그라데이션」 · 「콤보」 · 「남성」 탭을 하나씩 눌러 디자인을 둘러보세요.",
              before: function () { seenTabs = {}; },
              check: function () {
                  var on = fq(".mui-idx-tabs .mui-idx-tab.is-on");
                  if (on) seenTabs[on.getAttribute("data-tab")] = 1;
                  return !!(seenTabs.natural && seenTabs.gradation && seenTabs.combo && seenTabs.male);
              } },
            { ch: B, title: "디자인 눌러 보기", target: "f:.mui-qdesigns", act: "click",
              text: "마음에 드는 디자인을 하나 눌러 보세요. 얼굴 위에 바로 입혀집니다." },
            // 3. 오른쪽 점선 — 세로 두께까지 내렸다가 다시 올라오기
            { ch: B, title: "오른쪽 점선으로 내리기", target: "f:.mui-quick", text: "조절 칸 오른쪽의 점선을 따라 손가락으로 쓸어 「세로 두께」가 보일 때까지 내려 보세요.",
              wait: "편집 화면을 여는 중입니다…",
              check: function () {
                  var p = fq(".mui-quick"), h = fq("#rngHeight");
                  if (!p || !h) return false;
                  var pr = p.getBoundingClientRect(), hr = h.getBoundingClientRect();
                  return p.scrollTop > 20 && hr.top < pr.bottom - 10 && hr.bottom > pr.top;
              } },
            { ch: B, title: "다시 맨 위로", target: "f:.mui-quick", clap: true, text: "이번에는 점선을 따라 맨 위까지 다시 올라와 보세요.",
              check: function () { var p = fq(".mui-quick"); return !!p && p.scrollTop < 8; } },
            // 4. 그라데이션 · 세미아치
            { ch: B, title: "그라데이션 · 세미아치", target: qDesign("female_semiarch_gradation.png", "gradation"), clap: true,
              text: "위 디자인 줄에서 「그라데이션」 탭 → 「세미아치」를 눌러 보세요.",
              check: function () { return designKey() === "female_semiarch_gradation.png"; } },
            // 5 · 6. 대표 색상
            { ch: B, title: "대표 색상 둘러보기", target: "f:.mui-qcolors", text: "대표 색상 네 가지를 한 번씩 눌러 색을 비교해 보세요.",
              before: function () { seenColors = {}; },
              check: function () {
                  var c = browColor(); if (c) seenColors[c] = 1;
                  return Object.keys(seenColors).length >= 4;
              } },
            { ch: B, title: "다크브라운", target: "f:.mui-qcolors", clap: true, text: "「다크브라운」을 눌러 보세요.",
              check: function () { return browColor() === "#3D2B1F"; } },
            // 7. 투명도 60% · 8. 잠금
            sl("rngOpacity", 60, "눈썹 투명도 60%", "「눈썹 투명도」를 60%까지 내려 보세요. 옆의 − + 로 한 칸씩 맞출 수도 있습니다.", true),
            { ch: B, title: "잠금으로 고정", target: lockBtn("rngOpacity"), clap: true,
              text: "「눈썹 투명도」 옆 「잠금」을 눌러 고정해 보세요. 잠그면 다른 조절이나 디자인을 바꿔도 이 값이 그대로 있습니다.",
              check: function () { var d = frameDoc(), i = d && d.getElementById("rngOpacity"); return !!i && i.dataset.locked === "1"; } },
            // 9 ~ 14
            sl("rngNatBrow", 10, "기존 눈썹 지우기 10%", "「기존 눈썹 진하기」를 10%까지 내려 고객님의 원래 눈썹을 지워 보세요.", true),
            sl("rngSpacing", 40, "눈썹 간격 40", "「눈썹 간격」을 40까지 움직여 보세요.", true),
            sl("rngWidth", 120, "눈썹 기장 120%", "「눈썹 기장」을 120%까지 늘려 보세요."),
            sl("rngWidth", 100, "다시 100%", "이번에는 「눈썹 기장」을 다시 100%까지 줄여 보세요.", true),
            sl("rngHeight", 110, "세로 두께 110%", "「세로 두께」를 110%까지 올려 보세요.", true),
            sl("rngRot", 4, "꼬리 높이 4°", "「꼬리 높이」를 4°까지 올려 보세요."),
            sl("rngRot", -2.5, "꼬리 높이 −2.5°", "이번에는 「꼬리 높이」를 −2.5°까지 내려 보세요.", true),
            sl("rngTail", -8, "꼬리 내리기 −8%", "「꼬리 내리기」를 −8%까지 움직여 보세요."),
            sl("rngTail", 0, "다시 0%", "이번에는 「꼬리 내리기」를 다시 0%까지 가 보세요.", true),
            // 15. 오른쪽 눈썹만
            { ch: B, title: "오른쪽 눈썹만", target: "f:#btnBrowMoveRight", act: "click", text: "「오른쪽」을 눌러 보세요. 이제 조절바가 오른쪽 눈썹만 바꿉니다." },
            sl("rngTail", 2, "오른쪽 꼬리 내리기 2%", "오른쪽 눈썹의 「꼬리 내리기」를 2%까지 가 보세요."),
            sl("rngSpacing", -55, "오른쪽 간격 −55", "「눈썹 간격」을 −55까지 가 보세요."),
            sl("rngHeight", 105, "오른쪽 세로 두께 105%", "「세로 두께」를 105%까지 가 보세요."),
            sl("rngPeak", 2, "오른쪽 눈썹산 위치 2%", "「눈썹산 위치」를 뒤로 2%까지 가 보세요.", true),
            // 16. 함께
            { ch: B, title: "다시 함께", target: "f:#btnBrowMoveBoth", act: "click", text: "「함께」를 눌러 두 눈썹을 다시 같이 조절하도록 돌려 놓으세요." },
            // 17. 비교 — 오른쪽으로 갔다가 가운데로
            { ch: B, title: "비교 보기", target: "f:.mui-seg button:nth-child(3)", act: "click", text: "위쪽 「비교」를 눌러 보세요. 시술 전과 디자인이 반반 나옵니다." },
            { ch: B, title: "오른쪽으로 밀기", target: "f:.mui-split", text: "가운데 세로 선을 오른쪽 끝 쪽으로 밀어 보세요.",
              check: function () { return splitPct() >= 80; } },
            { ch: B, title: "다시 가운데로", target: "f:.mui-split", clap: true, text: "이번에는 세로 선을 다시 가운데로 가져와 보세요.",
              check: function () { var v = splitPct(); return v >= 40 && v <= 60; } },
            // 18. 디자인 → 메뉴얼 → 저장 → 고화질 저장
            { ch: B, title: "디자인 보기", target: "f:.mui-seg button:nth-child(2)", act: "click", text: "위쪽 「예상 디자인」을 다시 눌러 보세요." },
        ].concat(saveHQ(true)).concat([
            // 19. 퀵 → 자연결 · 일자
            toQuick(),
            { ch: B, title: "자연결 · 일자", target: qDesign("female_straight_natural.png", "natural"), clap: true,
              text: "디자인 줄에서 「자연결」 탭 → 「일자」를 눌러 보세요.",
              check: function () { return designKey() === "female_straight_natural.png"; } },
            // 20 ~ 22
            { ch: B, title: "리얼블랙", target: "f:.mui-qcolors", text: "색을 「리얼블랙」으로 바꿔 보세요.",
              check: function () { return browColor() === "#000000"; } },
            sl("rngTail", -4, "꼬리 내리기 −4%", "「꼬리 내리기」를 −4%까지 가 보세요."),
            sl("rngHead", 65, "앞머리 진하기 65%", "「앞머리 진하기」를 65%까지 내려 보세요."),
        ]).concat(saveHQ(false, "고화질 저장 (두 번째)")).concat([
            // 24. 퀵 → 그라데이션 · 아치 → 저장
            toQuick(),
            { ch: B, title: "그라데이션 · 아치", target: qDesign("female_arch_gradation.png", "gradation"),
              text: "디자인 줄에서 「그라데이션」 탭 → 「아치」를 눌러 보세요.",
              check: function () { return designKey() === "female_arch_gradation.png"; } },
        ]).concat(saveHQ(true, "고화질 저장 (세 번째)")).concat([
            // 25 · 26. 비교 보기 → 전체 이미지 저장
            { ch: B, title: "비교 보기", target: histCompareBtn, act: "click", text: "저장 탭의 「비교 보기」를 눌러 보세요. 저장한 디자인 세 가지가 나란히 나옵니다." },
            { ch: B, title: "전체 이미지 저장", target: "f:.mui-compare-save", act: "click", clap: true, final: true,
              text: "「전체 이미지 저장」을 눌러 세 디자인을 한 장으로 저장해 보세요." },
            { ch: "마무리", title: "눈썹 튜토리얼 완료!", text: "수고하셨습니다! 디자인 고르기부터 좌우 조절 · 비교 · 저장까지 모두 해 보셨습니다. 맨 위 「사진 · 디자인 변경」을 누르면 처음 화면으로 돌아갑니다. 다시 보기는 [버전] → 「튜토리얼 진행하기」에서 고르실 수 있습니다." },
        ]);
    }
    var COURSES = {
        brow: function () {
            return startSteps("brow").concat(partSteps("brow")).concat(browSteps());
        },
        lip: function () {
            return startSteps("lip").concat(partSteps("lip")).concat([
                { ch: "입술", title: "입술 색", target: "f:.mui-qcolors", act: "click", wait: "입술 편집 화면을 여는 중입니다…", text: "입술 색을 하나 골라 보세요." },
                { ch: "입술", title: "틴트 조절", goal: -1, target: "f:#rngOpacity", act: "input", text: "조절바로 틴트 투명도를 맞춰 보세요." },
                { ch: "입술", title: "시술 기법", target: "f:.mui-qtech", act: "click", text: "「내추럴」 · 「풀립」 · 「틴트립」 중 하나를 눌러 시술 기법에 따라 달라지는 모습을 보세요." },
                { ch: "입술", title: "기존 입술 흐리기", goal: -1, target: "f:row:#rngNatLip", act: "input", text: "원래 입술색이 진하면 「기존 입술 진하기」를 낮춥니다. 조절바를 왼쪽으로 움직여 보세요." },
                { ch: "입술", title: "입꼬리 오버립", goal: 1, target: "f:row:#rngCornerOverU", act: "input", text: "「윗입술 입꼬리 오버립」으로 입꼬리 쪽만 살짝 넓혀 보세요." },
                { ch: "입술", title: "좌우 대칭", target: "f:.mui-qsym", act: "click", text: "「좌우 대칭 맞추기」를 누르면 짝이 안 맞는 입술선을 한 번에 맞춥니다. 눌러 보세요." },
                { ch: "입술", title: "시술선 보기", target: "f:#btnToggleDesignLine", act: "click", text: "「시술선」을 누르면 시술할 경계선이 보입니다. 고객님께 선을 설명할 때 씁니다. 눌러 보세요." },
                { ch: "입술", title: "전후 비교", target: "f:.mui-seg", act: "click", text: "「시술 전」 · 「예상 디자인」으로 입술 전후를 비교해 보세요." },
            ]).concat(saveSteps("입술")).concat([
                { ch: "마무리", title: "입술 튜토리얼 완료!", text: "입술 결과물을 만들어 저장해 보셨습니다. 맨 위 「사진 · 부위 변경」을 누르면 처음 화면으로 돌아갑니다. 눈썹 튜토리얼과 다시 보기는 [버전] → 「튜토리얼 진행하기」에서 고르실 수 있습니다." },
            ]);
        },
    };
    var STEPS = COURSES.brow(), PART = "brow";

    // ── 화면 ──
    var ui = null, idx = 0, timer = null, unbind = null, runId = 0, minimized = false;
    function make(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
    function chapterCount(name) { return STEPS.filter(function (s) { return s.ch === name; }).length; }

    function build() {
        var root = make("div", "tut-root");
        root.style.zIndex = Z;
        // 비출 곳 둘레를 덮는 네 장 (구멍 안은 눌린다)
        var shades = ["t", "r", "b", "l"].map(function () { var s = make("div", "tut-shade"); root.appendChild(s); return s; });
        var ring = make("div", "tut-ring");
        var card = make("div", "tut-card");
        var skip = make("button", "tut-skip", "건너뛰기");
        skip.type = "button";
        skip.addEventListener("click", function () { finish("no"); });
        root.appendChild(ring); root.appendChild(card); root.appendChild(skip);
        document.body.appendChild(root);
        return { root: root, shades: shades, ring: ring, card: card };
    }

    function place(el) {
        var W = window.innerWidth, H = window.innerHeight, pad = 8;
        var s = ui.shades;
        if (!el) {
            s[0].style.cssText = "left:0;top:0;width:100%;height:100%";
            s[1].style.cssText = s[2].style.cssText = s[3].style.cssText = "display:none";
            ui.ring.style.display = "none";
            ui.card.classList.add("is-center");
            ui.card.style.top = ""; ui.card.style.bottom = "";
            return;
        }
        var r = rectOf(el);
        var x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad), w = Math.min(W - x, r.w + pad * 2), h = Math.min(H - y, r.h + pad * 2);
        s[0].style.cssText = "left:0;top:0;width:100%;height:" + y + "px";
        s[2].style.cssText = "left:0;top:" + (y + h) + "px;width:100%;height:" + Math.max(0, H - y - h) + "px";
        s[3].style.cssText = "left:0;top:" + y + "px;width:" + x + "px;height:" + h + "px";
        s[1].style.cssText = "left:" + (x + w) + "px;top:" + y + "px;width:" + Math.max(0, W - x - w) + "px;height:" + h + "px";
        ui.ring.style.cssText = "display:block;left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px";
        ui.card.classList.remove("is-center");
        // 눕힌 화면의 편집 단계 — 왼쪽은 사진, 오른쪽은 조절 패널. 안내 창은 사진 아래쪽 귀퉁이에 (눈썹 · 눈이 있는 위쪽을 가리지 않게)
        if (ui.root.classList.contains("is-editor") && W > H) {
            // 눈썹은 사진 위쪽, 입술은 아래쪽이 중요하다 — 눈썹 코스는 아래 귀퉁이, 입술 코스는 위 귀퉁이
            if (PART === "lip") { ui.card.style.top = "calc(env(safe-area-inset-top, 0px) + 6px)"; ui.card.style.bottom = ""; }
            else { ui.card.style.top = ""; ui.card.style.bottom = "calc(env(safe-area-inset-bottom, 0px) + 8px)"; }
            ui.card.style.width = Math.max(240, Math.min(400, Math.round(W * 0.52) - 16)) + "px";
            return;
        }
        ui.card.style.width = "";
        // 카드는 비춘 곳의 반대쪽 (위가 넓으면 위, 아니면 아래)
        if (y + h / 2 > H / 2) { ui.card.style.top = ui.root.classList.contains("is-editor") ? "calc(env(safe-area-inset-top, 0px) + 6px)" : "calc(env(safe-area-inset-top, 0px) + 46px)"; ui.card.style.bottom = ""; }
        else { ui.card.style.bottom = "max(12px, env(safe-area-inset-bottom))"; ui.card.style.top = ""; }
    }

    /** 「여기까지」 표시 — 조절바 위, 목표 값 자리 */
    function placeGoal() {
        var g = goalInfo, m = ui.goal;
        if (!g || !g.sl.isConnected) { if (m) m.style.display = "none"; return; }
        if (!m) {
            m = ui.goal = make("div", "tut-goal");
            m.appendChild(make("span", null, "여기까지"));
            m.appendChild(make("i"));
            ui.root.appendChild(m);
        }
        var r = rectOf(g.sl), f = (g.to - g.min) / (g.max - g.min);
        var thumb = 11;                                   // 손잡이 반지름만큼 양끝이 안쪽
        var x = r.x + thumb + f * (r.w - thumb * 2);
        m.style.display = "block";
        m.style.left = Math.round(x) + "px";
        m.style.top = Math.round(r.y - 30) + "px";
        m.classList.toggle("is-left", g.dir < 0);
    }

    function render(step, el, waiting) {
        var c = ui.card;
        c.classList.toggle("is-min", minimized && !!step.target);
        // 편집 화면 안을 비출 때는 얼굴 사진이 보여야 한다 — 안내 창을 작게, 덮는 막을 옅게 (2026-11-24 원장님)
        var inEditor = !!(step.target && (typeof step.target === "function" || step.target.indexOf("f:") === 0));
        ui.root.classList.toggle("is-editor", inEditor);
        c.innerHTML = "";
        var n = idx + 1, total = STEPS.length;
        var head = make("div", "tut-head");
        head.appendChild(make("span", "tut-ch", step.ch));
        head.appendChild(make("span", "tut-count", T("단계 {n} / {total}", { n: n, total: total })));
        // 안내 창 접기 — 사진을 넓게 보고 싶을 때 한 줄로 (다음 단계에서도 접힌 채)
        var fold = make("button", "tut-fold", minimized ? "펼치기" : "접기");
        fold.type = "button";
        fold.addEventListener("click", function () {
            minimized = !minimized;
            c.classList.toggle("is-min", minimized);
            fold.textContent = T(minimized ? "펼치기" : "접기");
        });
        head.appendChild(fold);
        c.appendChild(head);
        var bar = make("div", "tut-bar"); var fill = make("i"); fill.style.width = Math.round(n / total * 100) + "%"; bar.appendChild(fill);
        c.appendChild(bar);
        c.appendChild(make("h4", "tut-title", step.title));
        c.appendChild(make("p", "tut-text", waiting ? (step.wait || "잠시만 기다려 주세요…") : step.text));
        if (idx === 0) {
            var main = PART === "lip" ? "입술" : "눈썹";
            c.appendChild(make("p", "tut-plan", T(main === "입술" ? "시작 {a}단계 · 입술 {b}단계 · 마무리 — 모두 {total}단계, 3분 정도 걸립니다." : "시작 {a}단계 · 눈썹 {b}단계 · 마무리 — 모두 {total}단계, 10분 정도 걸립니다.",
                { a: chapterCount("시작"), b: chapterCount(main), total: total })));
        }
        if (step.slider && el && !waiting) c.appendChild(make("p", "tut-hint", T("👉 조절바를 「여기까지」 표시({v})까지 움직여 보세요 — 옆의 − + 로 한 칸씩 맞출 수 있습니다", { v: step.slider.to })));
        else if (step.check && el && !waiting && !step.act) c.appendChild(make("p", "tut-hint", "👆 빛나는 곳에서 해 보세요"));
        if (step.act && el && !waiting) c.appendChild(make("p", "tut-hint", step.goal
            ? (step.goal > 0 ? "👉 조절바를 오른쪽 「여기까지」 표시까지 밀어 보세요" : "👈 조절바를 왼쪽 「여기까지」 표시까지 밀어 보세요")
            : step.act === "input" ? "👆 빛나는 조절바를 움직여 보세요" : "👆 빛나는 곳을 눌러 보세요"));
        var row = make("div", "tut-btns");
        if (step.extra && !waiting) {
            var ex = make("button", "tut-btn tut-extra", step.extra.label); ex.type = "button";
            ex.addEventListener("click", step.extra.run); row.appendChild(ex);
        }
        if (idx > 0 && !step.act && !step.slider && !step.check) {
            var back = make("button", "tut-btn tut-back", "이전"); back.type = "button";
            back.addEventListener("click", function () { go(idx - 1); }); row.appendChild(back);
        }
        var last = idx === total - 1;
        var doing = !!(step.act || step.slider || step.check);
        var nx = make("button", "tut-btn tut-next" + (doing ? " is-quiet" : ""), last ? "완료" : idx === 0 ? "시작하기" : doing ? "넘어가기" : "다음");
        nx.type = "button";
        var okNow = !step.ready || step.ready();
        nx.disabled = !okNow;
        nx.addEventListener("click", function () { if (last) finish("done"); else go(idx + 1); });
        row.appendChild(nx);
        c.appendChild(row);
    }

    function clearTimers() {
        if (timer) { clearInterval(timer); timer = null; }
        if (unbind) { try { unbind(); } catch (e) {} unbind = null; }
    }

    /** 조절바 목표 — 지금 값에서 한쪽으로 범위의 1/4 쯤 (끝에 너무 붙으면 반대쪽으로) */
    var goalInfo = null;
    function sliderOf(el) { return el && (el.matches && el.matches('input[type="range"]') ? el : el.querySelector && el.querySelector('input[type="range"]')); }
    function makeGoal(step, el) {
        var sl = sliderOf(el);
        if (!sl || !step.goal) return null;
        var min = parseFloat(sl.min) || 0, max = parseFloat(sl.max), v = parseFloat(sl.value);
        if (!(max > min)) return null;
        var span = max - min, dir = step.goal, to = v + dir * span * 0.25;
        if (to > max - span * 0.04 || to < min + span * 0.04) { dir = -dir; to = v + dir * span * 0.25; }
        to = Math.max(min + span * 0.04, Math.min(max - span * 0.04, to));
        return { sl: sl, min: min, max: max, dir: dir, to: to, tol: span * 0.04 };
    }
    function reached(g) {
        var v = parseFloat(g.sl.value);
        return g.dir > 0 ? v >= g.to - g.tol : v <= g.to + g.tol;
    }
    /** 잘하셨습니다! — 2초 보여 주고 다음 단계로 */
    var celebrating = false;
    function success() {
        if (celebrating) return;
        celebrating = true;
        var my = runId;
        clearTimers();
        if (ui.goal) ui.goal.style.display = "none";
        ui.ring.classList.add("is-done");
        var c = ui.card;
        c.classList.remove("is-min");
        c.innerHTML = "";
        var st = STEPS[idx], clap = !!st.clap;
        var box = make("div", "tut-yay" + (clap ? " is-clap" : ""));
        box.appendChild(make("b", null, clap ? (st.final ? "잘하셨습니다! 👏👏👏 수고하셨습니다" : "잘하셨습니다! 👏👏👏") : "좋아요 ✓"));
        box.appendChild(make("span", null, st.title));
        c.appendChild(box);
        // 박수는 3초 보여 주고 (2026-11-27 원장님), 표시 없는 단계는 짧게 확인만
        setTimeout(function () {
            celebrating = false;
            if (ui) ui.ring.classList.remove("is-done");
            if (my === runId) go(idx + 1);
        }, clap ? 3000 : 900);
    }
    /** 대상에 동작을 걸어 두고, 하면 다음 단계로 */
    function bindAction(step, el) {
        var doc = el.ownerDocument, type = step.act === "input" ? "input" : "click";
        goalInfo = type === "input" ? makeGoal(step, el) : null;
        var h = function (ev) {
            if (!el.contains(ev.target) && ev.target !== el) return;
            if (goalInfo && !reached(goalInfo)) return;          // 아직 「여기까지」 표시에 못 갔다
            unbind && unbind(); unbind = null;
            // 그 사이 이 단계가 저절로 넘어갔으면(done) 박수를 다음 단계에 잘못 붙이지 않는다
            var at = idx, rid = runId;
            setTimeout(function () { if (idx === at && rid === runId) success(); }, type === "input" ? 250 : 350);
        };
        doc.addEventListener(type, h, true);
        unbind = function () { doc.removeEventListener(type, h, true); };
    }

    function go(i) {
        clearTimers();
        runId++;
        if (i >= STEPS.length) { finish("done"); return; }
        idx = Math.max(0, i);
        var step = STEPS[idx], my = runId, started = Date.now();
        if (step.before) { try { step.before(); } catch (e) {} }
        if (step.done && step.done() && idx < STEPS.length - 1) { go(idx + 1); return; }
        var el = step.target ? find(step.target) : null, bound = false, lastWaiting = null, lastScroll = 0;
        goalInfo = null;
        if (ui.goal) ui.goal.style.display = "none";
        var tick = function () {
            if (my !== runId || celebrating) return;
            // 해야 할 일이 이미 됐으면 (사진을 넣었다 · 편집 화면이 열렸다) 저절로 다음 단계로
            if (step.done && step.done()) { go(idx + 1); return; }
            if (step.target) {
                var cur = find(step.target);
                if (cur && cur !== el) { el = cur; bound = false; }
                if (!cur) el = null;
                if (!el && step.optional && Date.now() - started > step.optional) { go(idx + 1); return; }
                if (el && step.act && !bound) {
                    if (unbind) { try { unbind(); } catch (e) {} unbind = null; }
                    bindAction(step, el); bound = true;
                    if (el.scrollIntoView) try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
                }
            }
            var waiting = !!(step.target && !el);
            // 비출 곳이 화면 밖(아래 시트 속 등)이면 가운데로 끌어온다 — 1초에 한 번만
            if (el && Date.now() - (lastScroll || 0) > 1000) {
                var rr = rectOf(el);
                if (rr.y < 0 || rr.y + rr.h > window.innerHeight - 8) {
                    lastScroll = Date.now();
                    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { el.scrollIntoView(); }
                }
            }
            // 정해진 값까지 (slider) — 「여기까지」 표시를 그 값 자리에
            if (step.slider && el) {
                var sl0 = sliderOf(el);
                if (sl0) {
                    var mn = parseFloat(sl0.min) || 0, mx = parseFloat(sl0.max), stp = parseFloat(sl0.step) || 1;
                    var cur = parseFloat(sl0.value), to = step.slider.to;
                    goalInfo = { sl: sl0, min: mn, max: mx, to: to, dir: to >= cur ? 1 : -1 };
                    var tol = Math.max(stp / 2, (mx - mn) * 0.015);
                    if (Math.abs(cur - to) <= tol) { place(el); success(); return; }
                }
            }
            if (step.check && !step.slider) {
                var okc = false;
                try { okc = step.check(); } catch (e) {}
                if (okc) { place(el); success(); return; }
            }
            place(el);
            placeGoal();
            if (waiting !== lastWaiting) { render(step, el, waiting); lastWaiting = waiting; }
            if (step.ready) {
                var nx = ui.card.querySelector(".tut-next");
                if (nx) nx.disabled = !step.ready();
            }
        };
        tick();
        timer = setInterval(tick, 250);
    }

    function finish(how) {
        celebrating = false;
        clearTimers();
        runId++;
        try { if (how === "done") localStorage.setItem(KEY + "." + PART, "done"); if (!localStorage.getItem(KEY)) localStorage.setItem(KEY, how === "done" ? "done" : "no"); } catch (e) {}
        if (ui) { ui.root.remove(); ui = null; }
    }

    function start(part) {
        if (ui) return;
        PART = part === "lip" ? "lip" : "brow";
        STEPS = COURSES[PART]();
        // 편집 화면이 열려 있으면 처음 화면으로 돌아간 뒤 시작한다 — 다 닫힐 때까지 기다린다
        // (닫히는 중에 시작하면 '편집 화면이 열렸다' 로 보고 눈썹 · 입술 고르기 단계를 건너뛴다)
        ui = build();
        if (editorOpen()) {
            clickIf("f:.mui-settings");
            var waited = 0, my = ++runId;
            var t = setInterval(function () {
                waited += 100;
                if (my !== runId) { clearInterval(t); return; }
                if (!editorOpen() || waited > 4000) { clearInterval(t); go(0); }
            }, 100);
            place(null);
            return;
        }
        go(0);
    }

    // ── 튜토리얼 고르기 — 처음 켰을 때(아니요 있음) · 버전 화면에서(닫기) ──
    function ask(fromMenu) {
        if (document.querySelector(".tut-ask") || ui) return;      // 튜토리얼을 하는 중에는 묻지 않는다
        var box = make("div", "tut-ask");
        box.style.zIndex = Z;
        var card = make("div", "tut-ask-card");
        card.appendChild(make("div", "tut-ask-badge", "🎓 TUTORIAL"));
        card.appendChild(make("h3", null, fromMenu ? "어떤 튜토리얼을 진행할까요?" : "튜토리얼을 진행하겠습니까?"));
        card.appendChild(make("p", null, "처음 쓰시는 분을 위해 결과물을 만드는 과정을 직접 따라 해 봅니다. 눈썹과 입술 중 하나를 고르세요."));
        var pick = make("div", "tut-ask-pick");
        [["brow", "눈썹 튜토리얼", COURSES.brow().length, "10"], ["lip", "입술 튜토리얼", COURSES.lip().length, "3"]].forEach(function (c) {
            var b = make("button", "tut-course"); b.type = "button";
            b.appendChild(make("b", null, c[1]));
            var done = false; try { done = localStorage.getItem(KEY + "." + c[0]) === "done"; } catch (e) {}
            b.appendChild(make("span", null, T(done ? "{n}단계 · 약 {m}분 · 완료함" : "{n}단계 · 약 {m}분", { n: c[2], m: c[3] })));
            b.addEventListener("click", function () { box.remove(); start(c[0]); });
            pick.appendChild(b);
        });
        card.appendChild(pick);
        var row = make("div", "tut-ask-btns");
        var no = make("button", "tut-btn tut-back", fromMenu ? "닫기" : "아니요"); no.type = "button";
        no.addEventListener("click", function () { box.remove(); if (!fromMenu) try { localStorage.setItem(KEY, "no"); } catch (e) {} });
        row.appendChild(no);
        card.appendChild(row);
        if (!fromMenu) card.appendChild(make("p", "tut-ask-foot", "나중에 [버전] → 「튜토리얼 진행하기」로 언제든 볼 수 있습니다."));
        box.appendChild(card);
        document.body.appendChild(box);
    }
    /** 앱을 쓸 수 있는 상태(등록 · 체험 중, 첫 화면, 다른 창이 안 떠 있음)가 되면 한 번 묻는다 */
    function firstRun() {
        var seen = null;
        try { seen = localStorage.getItem(KEY); } catch (e) { return; }
        if (seen) return;
        var tries = 0;
        var t = setInterval(function () {
            if (++tries > 240) { clearInterval(t); return; }            // 2분 안에 안 되면 다음에
            if (ui) { clearInterval(t); return; }                         // 이미 튜토리얼을 시작했다
            var ph = $("step-photo");
            if (!ph || ph.hidden || !visible(ph)) return;
            var sheets = document.querySelectorAll(".lic-sheet, .pwa-sheet, #cam");
            for (var i = 0; i < sheets.length; i++) if (!sheets[i].hidden && visible(sheets[i])) return;
            if (document.body.classList.contains("sim-fullscreen")) return;
            clearInterval(t);
            ask();
        }, 500);
    }

    // 버전 화면 「튜토리얼 진행하기」 — 버전 창을 닫고 고르기 창을 띄운다
    function bindMenu() {
        var b = $("ver-tutorial");
        if (!b || b.__tut) return;
        b.__tut = true;
        b.addEventListener("click", function () {
            var sh = $("diag-sheet");
            if (sh) sh.hidden = true;
            ask(true);
        });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bindMenu); else bindMenu();

    window.PMUS_TUTORIAL = { start: start, ask: ask, courses: COURSES };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", firstRun);
    else firstRun();
})();
