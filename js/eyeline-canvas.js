/**
 * eyeline-canvas.js — 아이라인 시뮬레이터 (베타, 2026-10-18)
 * =========================================================================
 * 원장님 결정 (docs/PRD-아이라인-헤어라인.md):
 *   · 눈꺼풀 선(속눈썹이 나는 선)을 따라 계산해서 그린다 — 그림을 얹지 않는다.
 *   · 라인은 속눈썹 '아래'에 깐다 — 사진의 속눈썹을 찾아 라인 위로 다시 올린다.
 *   · 눈 감은 사진을 넣으면 같은 디자인을 감은 눈에도 그려 나란히 보여 준다.
 *
 * 앱 셸(app.js)이 넣어 주는 것 (window.CFG):
 *   bg_b64     밑그림 (눈썹 · 입술 작업이 얹힌 사진일 수 있다)
 *   orig_b64   맨얼굴 (없으면 bg_b64 와 같다)
 *   eye_json   detectEyeLandmarks() 결과 — {img_w, img_h, eyes:[{side, inner, outer, upper, lower, iris, open}]}
 *   eye_centers 인식이 안 됐을 때 쓰는 눈 중심 (state.eyes)
 *   closed     {b64, eye_json} — 눈 감은 사진 (있을 때만)
 *   ui_mode    "quick" | "manual"
 *   mount_gen  준비 완료 신호에 실어 보내는 번호
 *
 * 앱 셸과 주고받는 신호: mui:ready · mui:settings · mui:mode · mui:setMode · mui:capture → mui:captured
 *   mui:save · mui:saveCustomer · eye:pickClosed → eye:closedInfo / eye:closedFail
 * =========================================================================
 */
(function () {
    "use strict";

    var CFG = window.CFG || {};
    var root = document.documentElement;
    // 눈썹 · 입술과 같은 껍데기 모양(mobile-ui.css)을 쓴다. PC 에서도 같은 화면이다.
    root.classList.add("mui-on", "mui-force");

    var $ = function (id) { return document.getElementById(id); };
    function post(m) { try { window.parent.postMessage(m, "*"); } catch (e) { /* 앱 밖 */ } }
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

    // ── 디자인 · 색 · 조절바 정의 ──────────────────────────────────────
    var STYLES = [
        { key: "natural", label: "점막 채우기", p: { thick: 16, tail: 0, angle: 0, wing: 20, start: 12, front: 60, tip: 30, dy: 0, soft: 45, under: 0, ext: 0, join: 55 } },
        { key: "basic", label: "기본 라인", p: { thick: 28, tail: 16, angle: 3, wing: 25, start: 16, front: 30, tip: 10, dy: 0, soft: 35, under: 0, ext: 0, join: 55 } },
        { key: "wing", label: "윙 라인", p: { thick: 32, tail: 52, angle: 6, wing: 42, start: 10, front: 18, tip: 4, dy: 0, soft: 38, under: 0, ext: 0, join: 55 } },
        { key: "under", label: "꼬리 + 언더", p: { thick: 28, tail: 18, angle: 3, wing: 28, start: 18, front: 30, tip: 10, dy: 0, soft: 35, under: 55, ext: 0, join: 55 } },
    ];
    var COLORS = [["#15110f", "블랙"], ["#2a1b14", "브라운 블랙"], ["#3d281c", "다크 브라운"], ["#38383d", "그레이"]];

    // side: true 면 왼쪽 · 오른쪽 따로 바꿀 수 있는 값, false 면 두 눈 공통
    var SLIDERS = {
        opacity: { label: "진하기", min: 20, max: 100, side: false, unit: "%" },
        thick: { label: "두께", min: 0, max: 100, side: true },
        tail: { label: "꼬리 길이", min: 0, max: 100, side: true },
        angle: { label: "꼬리 들림 각도", min: -30, max: 30, side: true, unit: "°", hint: "0 = 아래 속눈썹 선을 그대로 연장 · + 위로 · − 아래로" },
        wing: { label: "날개 시작 위치", min: 0, max: 100, side: true, hint: "꼬리 윗선이 눈 위 어디서 떨어져 나올지 — 클수록 앞에서부터 두툼한 날개" },
        join: { label: "꼬리 연결 곡선 (R)", min: 0, max: 100, side: true, hint: "기존 라인에서 꼬리로 넘어가는 곡선 — 클수록 완만하게 이어짐" },
        start: { label: "시작 위치", min: 0, max: 100, side: true, hint: "눈 앞머리 쪽에서 어디부터 그릴지" },
        front: { label: "앞쪽 두께", min: 0, max: 100, side: true, unit: "%", hint: "앞은 가늘게 · 뒤로 갈수록 두껍게" },
        ext: { label: "바깥 연장 (라인 길이)", min: 0, max: 100, side: true, hint: "꼬리와 따로, 라인 자체를 눈꼬리 밖으로 길게" },
        tip: { label: "꼬리 끝 둥글기", min: 0, max: 100, side: true },
        dy: { label: "위아래 위치", min: -50, max: 50, side: true, hint: "인식한 속눈썹 선과 어긋나면 맞추기" },
        soft: { label: "번짐 (부드러움)", min: 0, max: 100, side: true },
        under: { label: "언더 라인 (아래 꼬리)", min: 0, max: 100, side: true },
        lash: { label: "속눈썹 살리기", min: 0, max: 100, side: false, unit: "%", hint: "속눈썹이 라인 위로 지나가게 보이는 정도" },
    };
    var QUICK_KEYS = ["opacity", "thick", "tail", "angle", "wing", "join"];
    var MANUAL_KEYS = ["thick", "tail", "angle", "wing", "join", "ext", "start", "front", "tip", "dy", "soft", "under", "opacity", "lash"];

    function styleOf(key) { for (var i = 0; i < STYLES.length; i++) if (STYLES[i].key === key) return STYLES[i]; return STYLES[1]; }
    function copy(o) { return JSON.parse(JSON.stringify(o)); }

    function freshState(styleKey) {
        var s = styleOf(styleKey || "basic");
        return { style: s.key, color: COLORS[0][0], opacity: 85, lash: 70, L: copy(s.p), R: copy(s.p) };
    }
    var S = freshState("basic");
    var side = "both";          // 메뉴얼에서 조절할 눈
    var view = "after";         // before | after | compare
    var crop = "both";          // both | L | R | face
    var split = 0.5;
    var uiMode = CFG.ui_mode === "manual" ? "manual" : "quick";

    // ── 되돌리기 ──────────────────────────────────────────────────────
    var undoStack = [], redoStack = [];
    var lastSaved = JSON.stringify(S);
    function commit() {
        var now = JSON.stringify(S);
        if (now === lastSaved) return;
        undoStack.push(lastSaved);
        if (undoStack.length > 60) undoStack.shift();
        redoStack = [];
        lastSaved = now;
        syncUndo();
    }
    function restore(json) { S = JSON.parse(json); lastSaved = json; syncAll(); schedule(); }
    function syncUndo() { $("eUndo").disabled = !undoStack.length; $("eRedo").disabled = !redoStack.length; }

    // ── 사진 · 눈 자리 ────────────────────────────────────────────────
    function loadImg(src) {
        return new Promise(function (ok, fail) {
            var im = new Image();
            im.onload = function () { ok(im); };
            im.onerror = function () { fail(new Error("사진을 읽지 못했습니다")); };
            im.src = src;
        });
    }

    /** 인식이 안 됐을 때: 눈 중심 두 점으로 아몬드 모양 눈을 만든다 (끌어 맞출 수 있게 위아래 조절로) */
    function synthEyes(c, w, h) {
        var l = c.left, r = c.right;
        var a = l.x <= r.x ? [l, r] : [r, l];
        var d = Math.hypot(a[1].x - a[0].x, a[1].y - a[0].y) || w * 0.25;
        var half = d * 0.21;
        function eye(ctr, sideKey, outSign) {
            var inner = [ctr.x - outSign * half, ctr.y], outer = [ctr.x + outSign * half, ctr.y - half * 0.06];
            var up = [], lo = [];
            for (var i = 0; i <= 8; i++) {
                var u = i / 8, x = inner[0] + (outer[0] - inner[0]) * u, y = inner[1] + (outer[1] - inner[1]) * u;
                up.push([x, y - Math.sin(Math.PI * u) * half * 0.62]);
                lo.push([x, y + Math.sin(Math.PI * u) * half * 0.34]);
            }
            return { side: sideKey, inner: inner, outer: outer, upper: up, lower: lo, iris: null, open: 0.3 };
        }
        return { img_w: w, img_h: h, guessed: true, eyes: [eye(a[0], "L", -1), eye(a[1], "R", 1)] };
    }

    var panels = { open: null, closed: null };   // {img, orig, data, canvas}

    // ── 곡선 ──────────────────────────────────────────────────────────
    function cr(p0, p1, p2, p3, t) {
        var t2 = t * t, t3 = t2 * t;
        return [
            0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
            0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ];
    }
    /** 점 몇 개를 매끈한 곡선으로 이어 같은 간격 n 점으로 */
    function smoothOpen(pts, n) {
        var m = pts.length, ext = [[2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]]].concat(pts,
            [[2 * pts[m - 1][0] - pts[m - 2][0], 2 * pts[m - 1][1] - pts[m - 2][1]]]);
        var dense = [];
        for (var i = 1; i < ext.length - 2; i++) for (var k = 0; k < 10; k++) dense.push(cr(ext[i - 1], ext[i], ext[i + 1], ext[i + 2], k / 10));
        dense.push(pts[m - 1]);
        var acc = [0];
        for (i = 1; i < dense.length; i++) acc.push(acc[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
        var total = acc[acc.length - 1] || 1, out = [], j = 1;
        for (i = 0; i < n; i++) {
            var want = total * i / (n - 1);
            while (j < acc.length - 1 && acc[j] < want) j++;
            var seg = (acc[j] - acc[j - 1]) || 1, f = clamp((want - acc[j - 1]) / seg, 0, 1);
            out.push([dense[j - 1][0] + (dense[j][0] - dense[j - 1][0]) * f, dense[j - 1][1] + (dense[j][1] - dense[j - 1][1]) * f]);
        }
        return out;
    }
    function cubic(a, c1, c2, b, n) {
        var out = [];
        for (var i = 1; i <= n; i++) {
            var t = i / n, u = 1 - t;
            out.push([u * u * u * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b[0],
                      u * u * u * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b[1]]);
        }
        return out;
    }
    function quad(a, c, b, n) {
        var out = [];
        for (var i = 1; i <= n; i++) {
            var t = i / n, u = 1 - t;
            out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
        }
        return out;
    }

    /**
     * 한 눈의 아이라인 모양 (사진 좌표).
     * 윗 속눈썹 선을 따라 위쪽으로 두께를 주고, 눈꼬리에서 꼬리를 뺀다.
     * 아래쪽은 선보다 아주 조금 내려 속눈썹 뿌리 사이까지 메운다.
     */
    function linerShape(eye, p) {
        var inner = eye.inner, outer = eye.outer;
        var len = Math.hypot(outer[0] - inner[0], outer[1] - inner[1]) || 1;
        var ax = [(outer[0] - inner[0]) / len, (outer[1] - inner[1]) / len];
        var up = [ax[1], -ax[0]];
        if (up[1] > 0) up = [-up[0], -up[1]];               // 사진에서 위쪽을 향하게

        var shift = p.dy / 50 * 0.12 * len;
        var N = 48;
        var P = smoothOpen(eye.upper, N).map(function (q) { return [q[0] + up[0] * shift, q[1] + up[1] * shift]; });
        var nor = P.map(function (q, i) {
            var a = P[Math.max(0, i - 1)], b = P[Math.min(N - 1, i + 1)];
            var tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
            var n = [ty / tl, -tx / tl];
            if (n[0] * up[0] + n[1] * up[1] < 0) n = [-n[0], -n[1]];
            return n;
        });

        var T = len * (0.008 + p.thick / 100 * 0.11);
        var s0 = p.start / 100 * 0.6;
        var front = p.front / 100;
        var hasTail = p.tail > 0.5;
        function th(u) {
            if (u < s0) return 0;
            var g = smooth(0, 1, (u - s0) / Math.max(0.05, 1 - s0));
            var v = T * (front + (1 - front) * g);
            v *= smooth(0, 0.12, u - s0);                         // 앞머리는 가늘게 시작
            if (!hasTail) v *= 1 - 0.55 * smooth(0.82, 1, u);     // 꼬리 없으면 눈꼬리에서 가늘게 끝
            return v;
        }
        var baseDrop = Math.min(0.3 * T, 0.016 * len);

        var unit = function (a, b) { var dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
        // 바깥 연장 (2026-10-19 원장님 요청): 꼬리와 따로, 라인 자체를 눈꼬리 밖으로 길게.
        // 눈꺼풀 끝 기울기에서 시작해 눈매 끝 방향으로 서서히 돌며 이어진다.
        var NL = N;
        var extLen = (p.ext || 0) / 100 * 0.3 * len;
        if (extLen > 0.5) {
            var Lw0 = smoothOpen(eye.lower, N);
            var tUp0 = unit(P[N - 5], P[N - 1]), tLo0 = unit(Lw0[N - 5], Lw0[N - 1]);
            var nat0 = unit([0, 0], [tUp0[0] + tLo0[0] + ax[0] * 0.3, tUp0[1] + tLo0[1] + ax[1] * 0.3]);
            var q = P[N - 1], nExt = 14;
            for (var ke = 1; ke <= nExt; ke++) {
                var te = ke / nExt;
                var de = unit([0, 0], [tUp0[0] * (1 - te) + nat0[0] * te, tUp0[1] * (1 - te) + nat0[1] * te]);
                q = [q[0] + de[0] * extLen / nExt, q[1] + de[1] * extLen / nExt];
                P.push(q);
            }
            N = P.length;
        }
        var O = P[N - 1];

        var poly, i;
        if (hasTail) {
            // ── 날개(윙) 꼬리 (2026-10-19 원장님 참고 사진 기준) ──────────────
            //  · 꼬리 방향 = 아래 속눈썹 선을 바깥으로 그대로 이어 그은 선 (+ 들림 각도)
            //  · 꼬리 아랫선 = 눈꼬리에서 그 선을 따라 곧게 → 끝은 뾰족하게
            //  · 꼬리 윗선 = 윗 라인 중간쯤(날개 시작 위치)에서 떨어져 나와 꼬리 끝까지 거의 곧게
            //  → 눈꼬리 위가 삼각형으로 채워지고, 꼬리가 나오는 자리는 R 만큼 둥글게 이어진다
            var Lw = smoothOpen(eye.lower, NL);
            var tLo = unit(Lw[Math.round((NL - 1) * 0.7)], Lw[NL - 1]);
            var ang = p.angle * Math.PI / 180;
            var cA = Math.cos(ang), sA = Math.sin(ang);
            var r1 = [tLo[0] * cA - tLo[1] * sA, tLo[0] * sA + tLo[1] * cA];
            var r2 = [tLo[0] * cA + tLo[1] * sA, -tLo[0] * sA + tLo[1] * cA];
            var lift = ang >= 0 ? 1 : -1;
            var dirW = ((r1[0] * up[0] + r1[1] * up[1]) - (r2[0] * up[0] + r2[1] * up[1])) * lift > 0 ? r1 : r2;
            var C = P[NL - 1];
            var tl = (p.tail / 100 * 0.5 + (p.ext || 0) / 100 * 0.2) * len;
            var tip = [C[0] + dirW[0] * tl, C[1] + dirW[1] * tl];
            var R = (p.join == null ? 55 : p.join) / 100;
            var wingU = Math.max(s0 + 0.1, 1 - (0.1 + 0.45 * (p.wing == null ? 40 : p.wing) / 100));

            var top = [], base = [];
            for (i = 0; i < NL; i++) {
                var u = i / (NL - 1);
                if (u < s0) continue;
                var tw0 = th(u), bd = baseDrop * smooth(0, 0.1, u - s0);
                if (u <= wingU) top.push([P[i][0] + nor[i][0] * tw0, P[i][1] + nor[i][1] * tw0]);
                base.push([P[i][0] - nor[i][0] * bd, P[i][1] - nor[i][1] * bd]);
            }
            if (top.length < 3 || base.length < 3) return null;
            var Tw = top[top.length - 1], tTw = unit(top[top.length - 3], Tw);
            var tipR = Math.max(0.003 * len, p.tip / 100 * T * 0.3);
            var tipTop = [tip[0] + up[0] * tipR * 0.5, tip[1] + up[1] * tipR * 0.5];
            var tipBot = [tip[0] - up[0] * tipR * 0.5, tip[1] - up[1] * tipR * 0.5];
            // 윗선: 윗 라인의 기울기로 떨어져 나와(R) 꼬리 끝으로 곧게, 살짝 오목하게
            var dT = Math.hypot(tipTop[0] - Tw[0], tipTop[1] - Tw[1]), dTop = unit(Tw, tipTop);
            // 윗 라인을 따라 조금 더 붙어 가다가(오목하게) 꼬리 끝으로 — 참고 사진처럼 삼각형이 무겁지 않게
            var cc = 0.06 + 0.08 * R;
            var topWing = cubic(Tw, [Tw[0] + tTw[0] * dT * (0.28 + 0.3 * R), Tw[1] + tTw[1] * dT * (0.28 + 0.3 * R)],
                [tipTop[0] - dTop[0] * dT * 0.42 - up[0] * dT * cc, tipTop[1] - dTop[1] * dT * 0.42 - up[1] * dT * cc], tipTop, 28);
            var cap = quad(tipTop, [tip[0] + dirW[0] * tipR * 1.2, tip[1] + dirW[1] * tipR * 1.2], tipBot, 5);
            // 아랫선: 꼬리 끝에서 아래 속눈썹 선 방향 그대로 눈꼬리로 (눈꼬리 모서리도 R 만큼 둥글게)
            var bi = Math.max(1, base.length - 1 - Math.round(R * 3));
            var B = base[bi], tB0 = unit(base[Math.max(0, bi - 2)], B);
            var tB = unit([0, 0], [tB0[0] * (1 - R) + tLo[0] * (0.4 + R), tB0[1] * (1 - R) + tLo[1] * (0.4 + R)]);
            var dB = Math.hypot(tipBot[0] - B[0], tipBot[1] - B[1]);
            var botWing = cubic(tipBot, [tipBot[0] - dirW[0] * dB * 0.4, tipBot[1] - dirW[1] * dB * 0.4],
                [B[0] + tB[0] * dB * (0.15 + 0.25 * R), B[1] + tB[1] * dB * (0.15 + 0.25 * R)], B, 24);
            poly = top.concat(topWing, cap, botWing, base.slice(0, bi).reverse());
        } else {
            // 꼬리 없음: 윗 라인만 (바깥 연장이 있으면 그만큼 길게, 끝으로 가늘게)
            var spine = [], wTop = [], wBot = [];
            var wFull = th(0.9);
            for (i = 0; i < N; i++) {
                var u2 = Math.min(1, i / (NL - 1));
                if (u2 < s0) continue;
                spine.push(P[i]);
                if (i >= NL) wTop.push(wFull * (1 - 0.75 * (i - NL + 1) / (N - NL)));
                else wTop.push(i > NL * 0.9 && extLen > 0.5 ? Math.max(th(u2), wFull) : th(u2));
                wBot.push(baseDrop * smooth(0, 0.1, u2 - s0));
            }
            if (spine.length < 2) return null;
            var n2 = spine.length, topS = [], baseS = [];
            for (i = 0; i < n2; i++) {
                var tg = unit(spine[Math.max(0, i - 1)], spine[Math.min(n2 - 1, i + 1)]), nn = [tg[1], -tg[0]];
                if (nn[0] * up[0] + nn[1] * up[1] < 0) nn = [-nn[0], -nn[1]];
                topS.push([spine[i][0] + nn[0] * wTop[i], spine[i][1] + nn[1] * wTop[i]]);
                baseS.push([spine[i][0] - nn[0] * wBot[i], spine[i][1] - nn[1] * wBot[i]]);
            }
            poly = topS.concat([[O[0] + ax[0] * 0.02 * len, O[1] + ax[1] * 0.02 * len]], baseS.reverse());
        }

        // 언더 라인: 아래 속눈썹 선의 눈꼬리 쪽만
        var under = null;
        if (p.under > 0.5) {
            var L = smoothOpen(eye.lower, N);
            var v0 = 1 - p.under / 100 * 0.55;
            var Tu = Math.max(T * 0.42, 0.012 * len);
            var ut = [], ub = [];
            for (i = 0; i < N; i++) {
                var v = i / (N - 1);
                if (v < v0) continue;
                var a = L[Math.max(0, i - 1)], b = L[Math.min(N - 1, i + 1)];
                var tx = b[0] - a[0], ty = b[1] - a[1], tq = Math.hypot(tx, ty) || 1;
                var n = [ty / tq, -tx / tq];
                if (n[0] * up[0] + n[1] * up[1] > 0) n = [-n[0], -n[1]];   // 아래쪽
                var w = Tu * smooth(v0, v0 + 0.3, v);
                ut.push([L[i][0] + n[0] * w, L[i][1] + n[1] * w]);
                ub.push([L[i][0] - n[0] * w * 0.15, L[i][1] - n[1] * w * 0.15]);
            }
            if (ut.length > 1) under = ut.concat(ub.reverse());
        }

        var xs = poly.map(function (q) { return q[0]; }), ys = poly.map(function (q) { return q[1]; });
        if (under) { under.forEach(function (q) { xs.push(q[0]); ys.push(q[1]); }); }
        var pad = T * 2 + 0.06 * len;
        return {
            main: poly, under: under, T: T, len: len,
            box: [Math.min.apply(null, xs) - pad, Math.min.apply(null, ys) - pad - 0.12 * len,
                  Math.max.apply(null, xs) + pad, Math.max.apply(null, ys) + pad],
        };
    }

    // ── 그리기 ────────────────────────────────────────────────────────
    var FILTER_OK = (function () {
        try { var c = document.createElement("canvas").getContext("2d"); return typeof c.filter === "string"; } catch (e) { return false; }
    })();
    var layerA = document.createElement("canvas"), layerB = document.createElement("canvas");

    function fit(cv, w, h) { if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h; }

    function pathOf(ctx, pts, T) {
        ctx.beginPath();
        ctx.moveTo((pts[0][0] - T.ox) * T.s, (pts[0][1] - T.oy) * T.s);
        for (var i = 1; i < pts.length; i++) ctx.lineTo((pts[i][0] - T.ox) * T.s, (pts[i][1] - T.oy) * T.s);
        ctx.closePath();
    }

    /** 흐림 — 캔버스 필터가 없는 옛 사파리는 조금씩 비껴 여러 번 찍는다 */
    function blurInto(dst, src, px) {
        var c = dst.getContext("2d");
        c.clearRect(0, 0, dst.width, dst.height);
        if (px < 0.4) { c.drawImage(src, 0, 0); return; }
        if (FILTER_OK) {
            c.filter = "blur(" + px.toFixed(2) + "px)";
            c.drawImage(src, 0, 0);
            c.filter = "none";
            return;
        }
        c.globalAlpha = 0.28;
        c.drawImage(src, 0, 0);
        for (var k = 0; k < 8; k++) {
            var a = k / 8 * Math.PI * 2;
            c.drawImage(src, Math.cos(a) * px * 0.7, Math.sin(a) * px * 0.7);
        }
        c.globalAlpha = 1;
    }

    /** 속눈썹 찾기: 둘레보다 확 어두운 가는 결. 맨얼굴 픽셀 기준으로 잰다 */
    function lashMask(before, w, h, radius) {
        var n = w * h, L = new Float32Array(n), d = before.data;
        for (var i = 0; i < n; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
        // 적분 영상으로 둘레 평균
        var W = w + 1, I = new Float64Array(W * (h + 1));
        for (var y = 0; y < h; y++) {
            var row = 0;
            for (var x = 0; x < w; x++) { row += L[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; }
        }
        var m = new Float32Array(n);
        for (y = 0; y < h; y++) {
            var y0 = Math.max(0, y - radius), y1 = Math.min(h, y + radius + 1);
            for (x = 0; x < w; x++) {
                var x0 = Math.max(0, x - radius), x1 = Math.min(w, x + radius + 1);
                var sum = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
                var mean = sum / ((x1 - x0) * (y1 - y0));
                m[y * w + x] = clamp((mean - L[y * w + x] - 9) / 26, 0, 1);
            }
        }
        return m;
    }

    /**
     * 한 장 그리기.
     * @param ctx   그릴 곳 (크기 = 잘라낸 영역 × s)
     * @param pan   panels.open / closed
     * @param T     {ox, oy, s} 사진 좌표 → 캔버스 좌표
     * @param after false 면 시술 전만
     * @param useOrig 시술 전을 맨얼굴로 (비교 · 저장용)
     */
    function paint(ctx, pan, T, after) {
        var w = ctx.canvas.width, h = ctx.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, w, h);
        drawSrc(ctx, after ? pan.img : pan.orig, T, w, h);
        if (!after) return;

        pan.data.eyes.forEach(function (eye) {
            var p = S[eye.side] || S.L;
            var sh = linerShape(eye, p);
            if (!sh) return;
            // 이 눈 둘레만 다룬다 (캔버스 좌표)
            var bx0 = clamp(Math.floor((sh.box[0] - T.ox) * T.s), 0, w), by0 = clamp(Math.floor((sh.box[1] - T.oy) * T.s), 0, h);
            var bx1 = clamp(Math.ceil((sh.box[2] - T.ox) * T.s), 0, w), by1 = clamp(Math.ceil((sh.box[3] - T.oy) * T.s), 0, h);
            var bw = bx1 - bx0, bh = by1 - by0;
            if (bw < 2 || bh < 2) return;
            var before = ctx.getImageData(bx0, by0, bw, bh);

            fit(layerA, bw, bh); fit(layerB, bw, bh);
            var la = layerA.getContext("2d");
            la.setTransform(1, 0, 0, 1, 0, 0);
            la.clearRect(0, 0, bw, bh);
            la.fillStyle = S.color;
            var TT = { ox: T.ox + bx0 / T.s, oy: T.oy + by0 / T.s, s: T.s };
            pathOf(la, sh.main, TT); la.fill();
            if (sh.under) { la.globalAlpha = 0.85; pathOf(la, sh.under, TT); la.fill(); la.globalAlpha = 1; }
            var px = (0.35 + p.soft / 100 * 0.32 * sh.T) * T.s;
            blurInto(layerB, layerA, px);

            var op = S.opacity / 100;
            ctx.save();
            ctx.globalCompositeOperation = "multiply";
            ctx.globalAlpha = op * 0.9;
            ctx.drawImage(layerB, bx0, by0);
            ctx.globalCompositeOperation = "source-over";
            ctx.globalAlpha = op * 0.6;
            ctx.drawImage(layerB, bx0, by0);
            ctx.restore();

            // 속눈썹을 라인 위로 다시 올린다
            if (S.lash > 0) {
                var now = ctx.getImageData(bx0, by0, bw, bh);
                var rad = Math.max(2, Math.round(0.05 * sh.len * T.s));
                var m = lashMask(before, bw, bh, rad), k = S.lash / 100;
                var nd = now.data, od = before.data;
                for (var i = 0, n = bw * bh; i < n; i++) {
                    var a = m[i] * k;
                    if (a <= 0) continue;
                    var j = i * 4;
                    nd[j] += (od[j] - nd[j]) * a;
                    nd[j + 1] += (od[j + 1] - nd[j + 1]) * a;
                    nd[j + 2] += (od[j + 2] - nd[j + 2]) * a;
                }
                ctx.putImageData(now, bx0, by0);
            }
        });
    }

    // ── 보기 영역 ─────────────────────────────────────────────────────
    function cropRect(pan, mode) {
        var W = pan.img.naturalWidth, H = pan.img.naturalHeight;
        if (mode === "face") return { x: 0, y: 0, w: W, h: H };
        var eyes = pan.data.eyes.filter(function (e) { return mode === "both" || e.side === mode; });
        if (!eyes.length) eyes = pan.data.eyes;
        var xs = [], ys = [], len = 0;
        eyes.forEach(function (e) {
            e.upper.concat(e.lower).forEach(function (q) { xs.push(q[0]); ys.push(q[1]); });
            len = Math.max(len, Math.hypot(e.outer[0] - e.inner[0], e.outer[1] - e.inner[1]));
        });
        if (mode === "upper") {
            // 얼굴 상부: 이마 · 눈썹 · 눈 · 콧등까지 (눈 길이 기준)
            var ux0 = clamp(Math.min.apply(null, xs) - len * 1.1, 0, W), ux1 = clamp(Math.max.apply(null, xs) + len * 1.1, 0, W);
            var uy0 = clamp(Math.min.apply(null, ys) - len * 2.4, 0, H), uy1 = clamp(Math.max.apply(null, ys) + len * 1.4, 0, H);
            return { x: ux0, y: uy0, w: Math.max(8, ux1 - ux0), h: Math.max(8, uy1 - uy0) };
        }
        var one = mode !== "both";
        var x0 = Math.min.apply(null, xs) - len * (one ? 0.5 : 0.6), x1 = Math.max.apply(null, xs) + len * (one ? 0.5 : 0.6);
        var y0 = Math.min.apply(null, ys) - len * (one ? 0.7 : 0.85), y1 = Math.max.apply(null, ys) + len * (one ? 0.45 : 0.5);
        x0 = clamp(x0, 0, W); x1 = clamp(x1, 0, W); y0 = clamp(y0, 0, H); y1 = clamp(y1, 0, H);
        return { x: x0, y: y0, w: Math.max(8, x1 - x0), h: Math.max(8, y1 - y0) };
    }

    function transformFor(pan, mode) {
        var r = cropRect(pan, mode);
        var long = Math.max(r.w, r.h);
        var s = mode === "face" ? Math.min(1, 1600 / long) : Math.min(2, 1600 / long);
        return { ox: r.x, oy: r.y, s: s, w: Math.round(r.w * s), h: Math.round(r.h * s) };
    }

    /** 사진의 (ox, oy) 부터 잘라 캔버스에 — 사진 밖으로 나가는 부분은 어둡게 둔다 (옛 사파리 대비) */
    function drawSrc(ctx, img, T, w, h) {
        var W = img.naturalWidth, H = img.naturalHeight;
        var sx0 = Math.max(0, T.ox), sy0 = Math.max(0, T.oy);
        var sx1 = Math.min(W, T.ox + w / T.s), sy1 = Math.min(H, T.oy + h / T.s);
        if (sx0 > T.ox || sy0 > T.oy || sx1 < T.ox + w / T.s || sy1 < T.oy + h / T.s) {
            ctx.fillStyle = "#0F0D16"; ctx.fillRect(0, 0, w, h);
        }
        if (sx1 <= sx0 || sy1 <= sy0) return;
        ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0,
            (sx0 - T.ox) * T.s, (sy0 - T.oy) * T.s, (sx1 - sx0) * T.s, (sy1 - sy0) * T.s);
    }

    /** 두 눈의 가운데와 눈꼬리 사이 거리 — 눈 뜬 · 감은 사진을 같은 크기로 맞추는 기준 */
    function eyeFrame(pan) {
        var e = pan.data.eyes, a = e[0], b = e[1];
        return {
            mx: (a.inner[0] + b.inner[0] + a.outer[0] + b.outer[0]) / 4,
            my: (a.inner[1] + b.inner[1] + a.outer[1] + b.outer[1]) / 4,
            span: Math.hypot(a.outer[0] - b.outer[0], a.outer[1] - b.outer[1]) || 1,
        };
    }

    /** 감은 사진은 눈 뜬 사진과 가로 · 세로 크기와 눈 자리를 똑같이 맞춘다 (2026-10-19 원장님 요청) */
    function transformMatched(pan) {
        var To = transformFor(panels.open, crop);
        var fo = eyeFrame(panels.open), fc = eyeFrame(pan), k = fc.span / fo.span;
        var wImg = To.w / To.s * k;                  // 감은 사진에서 잘라낼 너비 (사진 픽셀)
        return {
            ox: fc.mx + (To.ox - fo.mx) * k,
            oy: fc.my + (To.oy - fo.my) * k,
            s: To.w / wImg, w: To.w, h: To.h,
        };
    }

    function drawPanel(pan) {
        if (!pan) return;
        var T = (pan === panels.closed && panels.open) ? transformMatched(pan) : transformFor(pan, crop);
        fit(pan.canvas, T.w, T.h);
        var ctx = pan.canvas.getContext("2d", { willReadFrequently: true });
        paint(ctx, pan, T, view !== "before");
        if (view === "compare") {
            // 왼쪽은 시술 전, 오른쪽은 예상 디자인. 가운데 선을 끌어 옮긴다.
            var cut = Math.round(T.w * split);
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, cut, T.h); ctx.clip();
            drawSrc(ctx, pan.orig, T, T.w, T.h);
            ctx.restore();
            var lw = Math.max(2, T.w / 400);
            ctx.fillStyle = "rgba(255,255,255,.92)";
            ctx.fillRect(cut - lw / 2, 0, lw, T.h);
            var r = Math.max(12, T.w / 40);
            ctx.beginPath(); ctx.arc(cut, T.h * 0.82, r, 0, Math.PI * 2);
            ctx.fillStyle = "#C9A227"; ctx.fill();
            ctx.fillStyle = "#221C33";
            ctx.font = "bold " + Math.round(r) + "px sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("↔", cut, T.h * 0.82);
        }
    }

    var queued = false;
    function schedule() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(function () {
            queued = false;
            drawPanel(panels.open);
            drawPanel(panels.closed);
        });
    }

    /** 사진 전체에 구운 한 장 (저장 · 고객 이력 · 다른 부위로 이어 편집) */
    function bake(pan, after, rect) {
        pan = pan || panels.open;
        var r = rect || { x: 0, y: 0, w: pan.img.naturalWidth, h: pan.img.naturalHeight };
        var c = document.createElement("canvas");
        c.width = Math.round(r.w); c.height = Math.round(r.h);
        paint(c.getContext("2d", { willReadFrequently: true }), pan, { ox: r.x, oy: r.y, s: 1 }, after !== false);
        var url = c.toDataURL("image/jpeg", 0.92);
        c.width = 0; c.height = 0;
        return url;
    }

    // ── 화면 만들기 ───────────────────────────────────────────────────
    function rowHtml(key) {
        var d = SLIDERS[key];
        return '<div class="ctrl-row" data-key="' + key + '"><label><span>' + d.label + '</span>' +
            '<span class="mui-step"><button type="button" class="mui-step-btn" data-dir="-1" aria-label="한 눈금 줄이기">−</button>' +
            '<span data-val></span><button type="button" class="mui-step-btn" data-dir="1" aria-label="한 눈금 늘리기">+</button></span></label>' +
            (d.hint ? "<small>" + d.hint + "</small>" : "") +
            '<input type="range" min="' + d.min + '" max="' + d.max + '" step="1"></div>';
    }
    $("eQuickRows").innerHTML = QUICK_KEYS.map(rowHtml).join("");
    $("eManualRows").innerHTML = MANUAL_KEYS.map(rowHtml).join("");

    function valueOf(key) {
        var d = SLIDERS[key];
        if (!d.side) return S[key];
        return side === "R" ? S.R[key] : S.L[key];
    }
    function setValue(key, v) {
        var d = SLIDERS[key];
        v = clamp(Math.round(v), d.min, d.max);
        if (!d.side) S[key] = v;
        else if (side === "both") { S.L[key] = v; S.R[key] = v; }
        else S[side][key] = v;
    }
    function syncRows() {
        document.querySelectorAll(".ctrl-row[data-key]").forEach(function (row) {
            var key = row.getAttribute("data-key"), d = SLIDERS[key];
            // 퀵은 늘 두 눈 함께. 메뉴얼에서 한쪽을 골랐으면 그쪽 값.
            var inQuick = !!row.closest("#eQuick");
            var v = inQuick && d.side ? S.L[key] : valueOf(key);
            row.querySelector("input").value = v;
            row.querySelector("[data-val]").textContent = v + (d.unit || "");
        });
    }
    function bindRows(box, quick) {
        box.addEventListener("input", function (e) {
            var row = e.target.closest(".ctrl-row");
            if (!row || e.target.type !== "range") return;
            var key = row.getAttribute("data-key");
            var keep = side;
            if (quick) side = "both";
            setValue(key, +e.target.value);
            side = keep;
            syncRows(); schedule();
        });
        box.addEventListener("change", function (e) { if (e.target.type === "range") commit(); });
        box.addEventListener("click", function (e) {
            var b = e.target.closest(".mui-step-btn");
            if (!b) return;
            e.preventDefault();
            var key = b.closest(".ctrl-row").getAttribute("data-key");
            var keep = side;
            if (quick) side = "both";
            setValue(key, valueOf(key) + (+b.getAttribute("data-dir")));
            side = keep;
            syncRows(); schedule(); commit();
        });
    }
    bindRows($("eQuick"), true);
    bindRows($("eManual"), false);

    // 디자인 카드 — 견본 눈에 실제 계산식으로 그린 그림
    function styleThumb(st) {
        var c = document.createElement("canvas");
        c.width = 132; c.height = 60;
        var x = c.getContext("2d");
        x.fillStyle = "#EEDFD3"; x.fillRect(0, 0, 132, 60);
        var inner = [26, 34], outer = [96, 30], up = [], lo = [];
        for (var i = 0; i <= 8; i++) {
            var u = i / 8, px = inner[0] + (outer[0] - inner[0]) * u, py = inner[1] + (outer[1] - inner[1]) * u;
            up.push([px, py - Math.sin(Math.PI * Math.pow(u, 0.85)) * 15]);
            lo.push([px, py + Math.sin(Math.PI * u) * 8]);
        }
        x.beginPath(); x.moveTo(inner[0], inner[1]);
        up.forEach(function (q) { x.lineTo(q[0], q[1]); });
        lo.slice().reverse().forEach(function (q) { x.lineTo(q[0], q[1]); });
        x.fillStyle = "#FBFAF7"; x.fill();
        x.beginPath(); x.arc(60, 32, 9, 0, Math.PI * 2); x.fillStyle = "#5A3E2E"; x.fill();
        var sh = linerShape({ inner: inner, outer: outer, upper: up, lower: lo }, st.p);
        x.fillStyle = "#1B1512";
        if (sh) {
            pathOf(x, sh.main, { ox: 0, oy: 0, s: 1 }); x.fill();
            if (sh.under) { pathOf(x, sh.under, { ox: 0, oy: 0, s: 1 }); x.fill(); }
        }
        return c;
    }
    STYLES.forEach(function (st) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "eye-style";
        b.setAttribute("data-style", st.key);
        b.appendChild(styleThumb(st));
        var em = document.createElement("em"); em.textContent = st.label; b.appendChild(em);
        b.addEventListener("click", function () {
            var keep = { color: S.color, opacity: S.opacity, lash: S.lash };
            S = freshState(st.key);
            S.color = keep.color; S.opacity = keep.opacity; S.lash = keep.lash;
            syncAll(); schedule(); commit();
        });
        $("eStyles").appendChild(b);
    });

    function colorChips(box) {
        COLORS.forEach(function (c) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = "mui-qcolor";
            b.setAttribute("data-color", c[0]);
            b.innerHTML = '<i style="background:' + c[0] + '"></i><em>' + c[1] + "</em>";
            b.addEventListener("click", function () { S.color = c[0]; syncAll(); schedule(); commit(); });
            box.appendChild(b);
        });
    }
    colorChips($("eColors")); colorChips($("eColors2"));
    $("eColorPick").addEventListener("input", function (e) { S.color = e.target.value; syncAll(); schedule(); });
    $("eColorPick").addEventListener("change", commit);

    function colorLabel() {
        for (var i = 0; i < COLORS.length; i++) if (COLORS[i][0] === S.color) return COLORS[i][1];
        return "직접 고른 색";
    }
    function label() { return styleOf(S.style).label + " · " + colorLabel(); }

    function syncAll() {
        document.querySelectorAll(".eye-style").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-style") === S.style); });
        document.querySelectorAll(".mui-qcolor").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-color") === S.color); });
        $("eColorPick").value = S.color;
        document.querySelectorAll("#eSides button").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-side") === side); });
        var note = $("eSideNote");
        if (uiMode === "manual" && side !== "both") {
            note.hidden = false;
            note.className = "mui-sidenote is-" + (side === "L" ? "left" : "right");
            note.innerHTML = side === "L" ? "👈 <b>사진 왼쪽 눈만</b> 조절 중 · 같이 바꾸려면 <b>[두 눈 함께]</b>"
                : "<b>사진 오른쪽 눈만</b> 조절 중 👉 · 같이 바꾸려면 <b>[두 눈 함께]</b>";
        } else note.hidden = true;
        syncRows();
        syncUndo();
    }

    $("eSides").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-side]");
        if (!b) return;
        side = b.getAttribute("data-side");
        syncAll();
    });

    // 퀵 ↔ 메뉴얼
    var sheet = $("eSheet");
    function setMode(m, tell) {
        uiMode = m === "manual" ? "manual" : "quick";
        sheet.classList.toggle("is-quick", uiMode === "quick");
        $("eModeQuick").classList.toggle("is-active", uiMode === "quick");
        $("eModeManual").classList.toggle("is-active", uiMode === "manual");
        if (uiMode === "quick") side = "both";
        syncAll();
        if (tell) post({ type: "mui:mode", mode: uiMode });
    }
    $("eModeQuick").addEventListener("click", function () { setMode("quick", true); });
    $("eModeManual").addEventListener("click", function () { setMode("manual", true); });
    $("eToManual").addEventListener("click", function () { setMode("manual", true); });

    // 시트 높이: 손잡이를 누를 때마다 반 → 크게 → 작게
    $("eHandle").addEventListener("click", function () {
        var order = ["half", "full", "peek"];
        var now = sheet.getAttribute("data-snap");
        sheet.setAttribute("data-snap", order[(order.indexOf(now) + 1) % 3]);
    });

    // 보기 전환
    $("eViewSeg").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-view]");
        if (!b) return;
        view = b.getAttribute("data-view");
        document.querySelectorAll("#eViewSeg button").forEach(function (x) { x.classList.toggle("is-active", x === b); });
        $("eHint").textContent = view === "compare" ? "사진 위를 좌우로 끌어 시술 전 · 후를 견주세요"
            : view === "before" ? "시술 전 사진입니다" : "아래 조절바로 두께 · 꼬리를 맞추세요";
        schedule();
    });
    $("eChips").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-crop]");
        if (!b) return;
        crop = b.getAttribute("data-crop");
        document.querySelectorAll("#eChips [data-crop]").forEach(function (x) { x.classList.toggle("is-active", x === b); });
        schedule();
    });

    // 비교 선 끌기 (두 사진 모두 같은 비율)
    function bindSplit(cv) {
        var on = false;
        function at(e) { var r = cv.getBoundingClientRect(); if (r.width) { split = clamp((e.clientX - r.left) / r.width, 0, 1); schedule(); } }
        cv.addEventListener("pointerdown", function (e) {
            if (view !== "compare") return;
            on = true; at(e);
            try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
            e.preventDefault();
        });
        cv.addEventListener("pointermove", function (e) { if (on) { at(e); e.preventDefault(); } });
        ["pointerup", "pointercancel"].forEach(function (t) { cv.addEventListener(t, function () { on = false; }); });
    }
    bindSplit($("eyeCanvas")); bindSplit($("eyeCanvasClosed"));

    $("eUndo").addEventListener("click", function () {
        if (!undoStack.length) return;
        redoStack.push(JSON.stringify(S));
        restore(undoStack.pop()); syncUndo();
    });
    $("eRedo").addEventListener("click", function () {
        if (!redoStack.length) return;
        undoStack.push(JSON.stringify(S));
        restore(redoStack.pop()); syncUndo();
    });
    $("eReset").addEventListener("click", function () {
        var keepColor = S.color;
        S = freshState(S.style);
        S.color = keepColor;
        syncAll(); schedule(); commit();
    });

    $("eSettings").addEventListener("click", function () { post({ type: "mui:settings" }); });
    function pickClosed() { post({ type: "eye:pickClosed" }); }
    $("eClosedBtn").addEventListener("click", function () {
        if (!panels.closed) { pickClosed(); return; }
        // 이미 있으면 나란히 보기를 켜고 끈다
        var fig = $("eFigClosed");
        fig.hidden = !fig.hidden;
        $("eClosedBtn").classList.toggle("is-active", !fig.hidden);
        $("ePair").classList.toggle("has-closed", !fig.hidden);
        schedule();
    });
    $("eClosedSwap").addEventListener("click", pickClosed);

    // 알림
    var toastTimer = null;
    function toast(msg, ms) {
        var t = document.querySelector(".eye-toast");
        if (!t) { t = document.createElement("div"); t.className = "eye-toast"; document.body.appendChild(t); }
        t.textContent = msg; t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2400);
    }

    // ── 저장 ──────────────────────────────────────────────────────────
    function stamp() {
        var d = new Date(), z = function (n) { return (n < 10 ? "0" : "") + n; };
        return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "_" + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
    }

    /** 상담용 한 장: [시술 전 | 예상 디자인] (감은 사진이 있으면 한 줄 더) */
    function compareSheet() {
        var rows = [panels.open];
        if (panels.closed) rows.push(panels.closed);
        var cells = rows.map(function (pan) {
            var r = cropRect(pan, crop === "face" ? "both" : crop);
            if (pan === panels.closed) {
                // 눈 뜬 사진과 같은 비율 · 같은 눈 자리로
                var ro = cropRect(panels.open, crop === "face" ? "both" : crop);
                var fo = eyeFrame(panels.open), fc = eyeFrame(pan), k = fc.span / fo.span;
                r = { x: fc.mx + (ro.x - fo.mx) * k, y: fc.my + (ro.y - fo.my) * k, w: ro.w * k, h: ro.h * k };
            }
            return { pan: pan, r: r };
        });
        var cw = 900, gap = 12, head = 44;
        var hs = cells.map(function (c) { return Math.round(cw * c.r.h / c.r.w); });
        var H = head + hs.reduce(function (a, b) { return a + b + gap; }, 0) + 30;
        var c = document.createElement("canvas");
        c.width = cw * 2 + gap * 3; c.height = H;
        var x = c.getContext("2d");
        x.fillStyle = "#14111c"; x.fillRect(0, 0, c.width, c.height);
        x.fillStyle = "#E8C65A"; x.font = "bold 24px sans-serif"; x.textBaseline = "middle";
        x.textAlign = "center";
        x.fillText("시술 전", gap + cw / 2, head / 2 + 4);
        x.fillText("예상 디자인 · " + label(), gap * 2 + cw * 1.5, head / 2 + 4);
        var y = head;
        cells.forEach(function (cell, i) {
            var r = cell.r, s = cw / r.w;
            var tmp = document.createElement("canvas");
            tmp.width = cw; tmp.height = hs[i];
            var tc = tmp.getContext("2d", { willReadFrequently: true });
            paint(tc, cell.pan, { ox: r.x, oy: r.y, s: s }, false);
            x.drawImage(tmp, gap, y);
            paint(tc, cell.pan, { ox: r.x, oy: r.y, s: s }, true);
            x.drawImage(tmp, gap * 2 + cw, y);
            if (rows.length > 1) {
                x.fillStyle = "rgba(20,17,28,.75)"; x.fillRect(gap, y + hs[i] - 34, 150, 34);
                x.fillStyle = "#F2EEFB"; x.font = "bold 18px sans-serif"; x.textAlign = "left";
                x.fillText(i === 0 ? "눈 뜬 모습" : "눈 감은 모습", gap + 12, y + hs[i] - 17);
                x.textAlign = "center";
            }
            tmp.width = 0;
            y += hs[i] + gap;
        });
        x.fillStyle = "#8C82A8"; x.font = "15px sans-serif"; x.textAlign = "right";
        x.fillText("PMUS 시뮬레이션 — 실제 시술 결과와 다를 수 있습니다", c.width - gap, H - 16);
        var url = c.toDataURL("image/jpeg", 0.9);
        c.width = 0;
        return url;
    }

    function openCompare() {
        var url = compareSheet();
        var box = document.createElement("div");
        box.className = "eye-compare";
        box.innerHTML = '<div class="eye-compare-bar"><span>비교 보기</span><button type="button" data-a="save">💾 이 그림 저장</button>' +
            '<button type="button" data-a="close">닫기</button></div><div class="eye-compare-body"><img alt="시술 전 · 예상 디자인 비교"></div>';
        box.querySelector("img").src = url;
        box.addEventListener("click", function (e) {
            var a = e.target.getAttribute && e.target.getAttribute("data-a");
            if (a === "close") box.remove();
            if (a === "save") post({ type: "mui:save", filename: "PMUS_아이라인_비교_" + stamp() + ".jpg", dataUrl: url });
        });
        document.body.appendChild(box);
    }

    function toolsHtml() {
        return '<button type="button" class="mui-histbtn" data-t="compare">🖼️ 비교 보기</button>' +
            '<button type="button" class="mui-histbtn" data-t="save">💾 결과 저장</button>' +
            '<button type="button" class="mui-histbtn" data-t="crm" style="grid-column:1 / -1">📋 고객 이력으로 저장</button>';
    }
    document.querySelectorAll("[data-tools]").forEach(function (box) {
        box.innerHTML = toolsHtml();
        box.addEventListener("click", function (e) {
            var t = e.target.closest("[data-t]");
            if (!t || !panels.open) return;
            var k = t.getAttribute("data-t");
            if (k === "compare") openCompare();
            if (k === "save") post({ type: "mui:save", filename: "PMUS_아이라인_" + stamp() + ".jpg", dataUrl: bake(panels.open, true) });
            if (k === "crm") post({ type: "mui:saveCustomer", part: "eyeline", label: label(), dataUrl: bake(panels.open, true) });
        });
    });

    // ── 넓은 화면 · 가로 화면 ─────────────────────────────────────────
    function layout() {
        root.classList.toggle("mui-wide", window.innerWidth >= 600);
        root.classList.toggle("mui-land", window.innerWidth > window.innerHeight && window.innerWidth >= 900);
    }
    layout();
    window.addEventListener("resize", function () { layout(); schedule(); });

    // 아래 조절판이 가리는 만큼 사진 자리 아래에 여백을 둔다 — '얼굴 전체' 에서 턱까지 보이게
    // (눈썹 · 입술 화면 mobile-ui.js syncStagePadding 과 같은 방식, 2026-10-19)
    (function () {
        var stage = $("eStage"), sh = $("eSheet");
        function pad() {
            if (root.classList.contains("mui-land")) { stage.style.paddingBottom = "8px"; return; }
            var covered = Math.max(0, window.innerHeight - sh.getBoundingClientRect().top);
            stage.style.paddingBottom = Math.max(8, Math.round(covered) + 8) + "px";
            schedule();
        }
        if (typeof ResizeObserver === "function") new ResizeObserver(pad).observe(sh);
        sh.addEventListener("transitionend", pad);
        window.addEventListener("resize", pad);
        requestAnimationFrame(pad);
    })();

    // ── 앱 셸에서 오는 신호 ───────────────────────────────────────────
    window.addEventListener("message", function (e) {
        var d = e.data;
        if (!d || typeof d !== "object") return;
        if (d.type === "mui:setMode") { setMode(d.mode, false); return; }
        if (d.type === "mui:capture") {
            if (!panels.open) return;
            post({ type: "mui:captured", part: "eyeline", dataUrl: bake(panels.open, true), label: "아이라인 · " + label() });
            return;
        }
        if (d.type === "eye:closedInfo") { setClosed(d.dataUrl, d.eye_json, true); return; }
        if (d.type === "eye:closedFail") { toast(d.msg || "눈 감은 사진에서 눈을 찾지 못했습니다", 3600); return; }
    });

    function setClosed(src, data, announce) {
        if (!src || !data || !data.eyes) return Promise.resolve();
        return loadImg(src).then(function (im) {
            panels.closed = { img: im, orig: im, data: data, canvas: $("eyeCanvasClosed") };
            $("eFigClosed").hidden = false;
            $("ePair").classList.add("has-closed");
            $("eClosedBtn").textContent = "😌 감은 눈 나란히";
            $("eClosedBtn").classList.add("is-active");
            $("eClosedSwap").hidden = false;
            schedule();
            if (announce) toast("눈 감은 사진에도 같은 디자인을 그렸습니다");
        });
    }

    // ── 시작 ──────────────────────────────────────────────────────────
    setMode(uiMode, false);
    var bgSrc = CFG.bg_b64, origSrc = CFG.orig_b64 || CFG.bg_b64;
    Promise.all([loadImg(bgSrc), origSrc === bgSrc ? null : loadImg(origSrc)]).then(function (r) {
        var img = r[0], orig = r[1] || r[0];
        var data = CFG.eye_json;
        if (!data || !data.eyes || data.eyes.length < 2) {
            if (CFG.eye_centers) {
                data = synthEyes(CFG.eye_centers, img.naturalWidth, img.naturalHeight);
                toast("눈꺼풀 선을 정확히 못 읽어 눈 위치로 잡았습니다.\n메뉴얼의 '위아래 위치'로 맞춰 주세요.", 4200);
            } else {
                toast("얼굴을 찾지 못했습니다. 정면 사진으로 다시 해 주세요.", 5000);
                post({ type: "mui:ready", gen: CFG.mount_gen || 0 });
                return;
            }
        } else if (img.naturalWidth !== data.img_w && data.img_w) {
            // 밑그림 크기가 인식한 사진과 다르면 비율을 맞춘다
            var k = img.naturalWidth / data.img_w;
            data = JSON.parse(JSON.stringify(data));
            data.eyes.forEach(function (e) {
                ["inner", "outer"].forEach(function (q) { e[q] = [e[q][0] * k, e[q][1] * k]; });
                e.upper = e.upper.map(function (q) { return [q[0] * k, q[1] * k]; });
                e.lower = e.lower.map(function (q) { return [q[0] * k, q[1] * k]; });
            });
        }
        panels.open = { img: img, orig: orig, data: data, canvas: $("eyeCanvas") };
        syncAll();
        schedule();
        var closed = CFG.closed && CFG.closed.b64 ? setClosed(CFG.closed.b64, CFG.closed.eye_json, false) : Promise.resolve();
        return closed.then(function () {
            requestAnimationFrame(function () { post({ type: "mui:ready", gen: CFG.mount_gen || 0 }); });
        });
    })["catch"](function (err) {
        toast("아이라인 화면을 열지 못했습니다: " + err.message, 5000);
        if (window.__blReport) window.__blReport("오류", err.message);
    });

    // 시험용 (자동 점검 도구가 읽는다)
    window.__eyeState = function () { return JSON.parse(JSON.stringify({ S: S, side: side, view: view, crop: crop, mode: uiMode, closed: !!panels.closed })); };
})();
