/**
 * hairline-canvas.js — 헤어라인 시뮬레이터 (베타, 2026-10-18)
 * =========================================================================
 * 원장님 결정 (docs/PRD-아이라인-헤어라인.md): 채우는 표현은 **결(헤어 스트로크)**.
 *   · 지금 헤어라인(머리카락 분할 모델) 아래로 새 헤어라인(곡선 + 금색 점 7개)을 정한다.
 *   · 둘 사이를 머리 방향을 따르는 가는 결로 채운다. 경계 쪽은 결이 성기고 가늘어진다.
 *   · 결 색은 지금 머리색을 읽어 살짝 옅게 (직접 고를 수도 있다).
 *
 * 앱 셸(app.js)이 넣어 주는 것 (window.CFG):
 *   bg_b64 · orig_b64 · ui_mode · mount_gen (아이라인과 같다)
 *   hair_json  detectHairline() 결과 — {img_w, img_h, cur:[[x,y]*41], oval, browY, cx, chin, faceW, hair:[r,g,b], guessed}
 *
 * 앱 셸과 주고받는 신호: mui:ready · mui:settings · mui:mode · mui:setMode · mui:capture → mui:captured · mui:save · mui:saveCustomer
 * =========================================================================
 */
(function () {
    "use strict";

    var CFG = window.CFG || {};
    var root = document.documentElement;
    root.classList.add("mui-on", "mui-force");

    var $ = function (id) { return document.getElementById(id); };
    function post(m) { try { window.parent.postMessage(m, "*"); } catch (e) { /* 앱 밖 */ } }
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
    function copy(o) { return JSON.parse(JSON.stringify(o)); }

    // ── 모양 · 색 · 조절바 ────────────────────────────────────────────
    var PRESETS = [
        { key: "lower", label: "이마 축소", hint: "지금 모양 그대로 내리기" },
        { key: "m", label: "M자 보완", hint: "양쪽 모서리 채우기" },
        { key: "round", label: "라운드", hint: "둥근 이마선" },
        { key: "straight", label: "일자", hint: "곧은 이마선" },
    ];
    var COLORS = [["auto", "지금 머리색"], ["#18151a", "흑색"], ["#2a1f1a", "흑갈색"], ["#4a3426", "자연 갈색"]];
    var SLIDERS = {
        lower: { label: "내리기", min: 0, max: 100, unit: "", hint: "새 헤어라인을 얼마나 내릴지" },
        density: { label: "결 밀도", min: 10, max: 100 },
        soft: { label: "경계 부드러움", min: 0, max: 100, hint: "경계 쪽 결이 성기게 흩어지는 정도" },
        len: { label: "결 길이", min: 0, max: 100 },
        thick: { label: "결 굵기", min: 0, max: 100 },
        tilt: { label: "결 방향 (바깥으로 벌어짐)", min: 0, max: 100 },
        flow: { label: "원래 머리결 따라가기", min: 0, max: 100, hint: "사진의 머리 흐르는 방향을 새 결이 얼마나 이어받을지" },
        shade: { label: "바탕 음영", min: 0, max: 100, hint: "결 사이를 살짝 메워 숱이 많아 보이게" },
        opacity: { label: "진하기", min: 20, max: 100, unit: "%" },
    };
    var QUICK_KEYS = ["lower", "density", "soft"];
    var MANUAL_KEYS = ["lower", "density", "len", "thick", "flow", "tilt", "soft", "shade", "opacity"];
    var NCTRL = 7;

    function freshState(preset) {
        return { preset: preset || "lower", lower: 45, density: 55, soft: 55, len: 60, thick: 35, tilt: 40, shade: 22, opacity: 85,
                 flow: 70, color: "auto", offs: [0, 0, 0, 0, 0, 0, 0], seed: 7 };
    }
    var S = freshState("lower");
    var view = "after", crop = "forehead", split = 0.5, guide = true;
    var uiMode = CFG.ui_mode === "manual" ? "manual" : "quick";

    // ── 되돌리기 ──────────────────────────────────────────────────────
    var undoStack = [], redoStack = [], lastSaved = JSON.stringify(S);
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

    // ── 기준선 ────────────────────────────────────────────────────────
    var G = null;      // {cur, xL, xR, cx, yc, H, browY, chin, hair}
    var pan = null;    // {img, orig, canvas}

    function prepare(d, k) {
        var cur = d.cur.map(function (p) { return [p[0] * k, p[1] * k]; });
        var xL = cur[0][0], xR = cur[cur.length - 1][0];
        var cx = d.cx * k, browY = d.browY * k;
        var g = { cur: cur, xL: xL, xR: xR, cx: cx, browY: browY, chin: [d.chin[0] * k, d.chin[1] * k], hair: d.hair, guessed: d.guessed };
        g.yc = curAt(g, cx);
        g.H = browY - g.yc;
        if (!(g.H > d.faceW * k * 0.12)) g.H = d.faceW * k * 0.32;   // 이상하면 얼굴 폭으로
        return g;
    }
    function curAt(g, x) {
        var c = g.cur, n = c.length;
        if (x <= c[0][0]) return c[0][1];
        if (x >= c[n - 1][0]) return c[n - 1][1];
        var f = (x - c[0][0]) / (c[n - 1][0] - c[0][0]) * (n - 1), i = Math.floor(f), t = f - i;
        return c[i][1] + (c[Math.min(n - 1, i + 1)][1] - c[i][1]) * t;
    }
    /** 조절점 자리 (관자놀이 끝은 조금 안쪽부터) */
    function ctrlU(i) { return 0.05 + 0.9 * i / (NCTRL - 1); }
    function xOfU(u) { return G.xL + (G.xR - G.xL) * u; }

    /** 모양 견본이 정한 새 헤어라인 (조절점 옮기기 전) */
    function baseTarget(u) {
        var x = xOfU(u), cur = curAt(G, x), H = G.H;
        var d = S.lower / 100 * 0.5 * H;
        var e = Math.abs(2 * u - 1);
        if (S.preset === "straight") return Math.max(cur, G.yc + d - H * 0.10 * Math.pow(e, 3));
        if (S.preset === "round") return Math.max(cur, G.yc + d + H * 0.16 * e * e - H * 0.03);
        if (S.preset === "m") return Math.max(cur + d * 0.25 * (1 - e), G.yc + d * 0.6 + H * 0.07 * e * e);
        return cur + d * (1 - 0.55 * Math.pow(e, 3));       // 이마 축소: 지금 모양 그대로
    }
    function ctrlPts() {
        var out = [];
        for (var i = 0; i < NCTRL; i++) {
            var u = ctrlU(i);
            out.push([xOfU(u), baseTarget(u) + (S.offs[i] || 0) / 100 * G.H]);
        }
        return out;
    }
    function cr(p0, p1, p2, p3, t) {
        var t2 = t * t, t3 = t2 * t;
        return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
    }
    /** 새 헤어라인을 x 자리마다 (조절점을 매끈하게 이은 것) */
    function targetAt(x, C) {
        var u = (x - G.xL) / (G.xR - G.xL);
        var f = clamp((u - 0.05) / 0.9, 0, 1) * (NCTRL - 1), i = Math.min(NCTRL - 2, Math.floor(f)), t = f - i;
        var y = function (j) { return C[clamp(j, 0, NCTRL - 1)][1]; };
        var v = cr(y(i - 1), y(i), y(i + 1), y(i + 2), t);
        if (u < 0.05 || u > 0.95) {
            // 관자놀이 끝: 새 선을 지금 선 쪽으로 자연스럽게 모은다
            var k = u < 0.05 ? u / 0.05 : (1 - u) / 0.05;
            v = curAt(G, x) + (v - curAt(G, x)) * smooth(0, 1, k);
        }
        return v;
    }

    // ── 결 뿌리기 ─────────────────────────────────────────────────────
    function rng(seed) {
        var a = seed >>> 0;
        return function () {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            var t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    function hexRgb(h) { var n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    function baseColor() {
        if (S.color !== "auto") return hexRgb(S.color);
        var c = G.hair || [42, 31, 26];
        // 결 색은 지금 머리색보다 살짝 옅게 (원장님 견본)
        return [Math.min(255, c[0] * 1.08 + 6), Math.min(255, c[1] * 1.08 + 5), Math.min(255, c[2] * 1.08 + 4)];
    }

    /** 결 목록 (사진 좌표). 같은 값이면 같은 결이 나오도록 씨앗을 고정한다. */
    /**
     * 원래 머리결 방향 읽기 (2026-10-20).
     * 지금 헤어라인 바로 위 머리카락 띠를 구간마다 나눠, 밝기 기울기(구조 텐서)로 머리카락이
     * 흐르는 방향을 잰다. 새 결이 이 방향을 이어받아 원래 머리와 한 덩어리로 보이게 한다.
     * 결과: G.flow = [{u, ang, coh}] — ang 은 '위쪽' 기준 각도(라디안, + 는 오른쪽), coh 는 방향이 또렷한 정도 0~1
     */
    function readFlow(img) {
        var K = 18, flow = [];
        try {
            var H = G.H, k = Math.min(1, 140 / H);              // 이마 높이가 140px 쯤 되게 줄여서 본다
            var top = Math.min.apply(null, G.cur.map(function (p) { return p[1]; })) - H * 0.4;
            var x0 = G.xL, y0 = Math.max(0, top), wImg = G.xR - G.xL, hImg = Math.max(1, G.browY - y0);
            var cw = Math.max(8, Math.round(wImg * k)), ch = Math.max(8, Math.round(hImg * k));
            var c = document.createElement("canvas");
            c.width = cw; c.height = ch;
            var x = c.getContext("2d", { willReadFrequently: true });
            x.drawImage(img, x0, y0, wImg, hImg, 0, 0, cw, ch);
            var d = x.getImageData(0, 0, cw, ch).data;
            c.width = 0;
            var Lm = new Float32Array(cw * ch);
            for (var i = 0; i < cw * ch; i++) Lm[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
            for (var bi = 0; bi < K; bi++) {
                var u0 = bi / K, u1 = (bi + 1) / K, jxx = 0, jyy = 0, jxy = 0;
                var cx0 = Math.max(1, Math.floor(u0 * cw)), cx1 = Math.min(cw - 1, Math.ceil(u1 * cw));
                for (var px = cx0; px < cx1; px++) {
                    var xi = G.xL + (px / k);
                    var cy = (curAt(G, xi) - y0) * k;                  // 이 자리 헤어라인 (줄인 판 기준)
                    var ya = Math.max(1, Math.floor(cy - H * 0.32 * k)), yb = Math.min(ch - 1, Math.floor(cy - H * 0.03 * k));
                    for (var py = ya; py < yb; py++) {
                        var o = py * cw + px;
                        var gx = Lm[o + 1] - Lm[o - 1], gy = Lm[o + cw] - Lm[o - cw];
                        jxx += gx * gx; jyy += gy * gy; jxy += gx * gy;
                    }
                }
                var tr = jxx + jyy;
                if (tr < 1) { flow.push({ u: (u0 + u1) / 2, ang: 0, coh: 0 }); continue; }
                var th = 0.5 * Math.atan2(2 * jxy, jxx - jyy);         // 밝기가 가장 많이 바뀌는 방향
                var lam = Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy);
                var coh = lam / tr;
                var sx = -Math.sin(th), sy = Math.cos(th);            // 머리카락 방향 = 그에 수직
                if (sy > 0) { sx = -sx; sy = -sy; }                    // 위쪽을 향하게
                flow.push({ u: (u0 + u1) / 2, ang: Math.atan2(sx, -sy), coh: Math.min(1, coh * 1.4) });
            }
            // 이웃 구간과 부드럽게
            var sm = flow.map(function (f, i) {
                var a = 0, b2 = 0, wsum = 0;
                for (var j = Math.max(0, i - 1); j <= Math.min(K - 1, i + 1); j++) {
                    var wt = (j === i ? 2 : 1) * (0.2 + flow[j].coh);
                    a += Math.sin(flow[j].ang) * wt; b2 += Math.cos(flow[j].ang) * wt; wsum += wt;
                }
                return { u: f.u, ang: Math.atan2(a, b2), coh: f.coh };
            });
            return sm;
        } catch (e) {
            return null;
        }
    }
    function flowAt(x) {
        if (!G.flow || !G.flow.length) return null;
        var u = clamp((x - G.xL) / (G.xR - G.xL), 0, 1), F = G.flow, K = F.length;
        var f = clamp(u * K - 0.5, 0, K - 1), i = Math.floor(f), t = f - i, a = F[i], b = F[Math.min(K - 1, i + 1)];
        var sx = Math.sin(a.ang) * (1 - t) + Math.sin(b.ang) * t, cy = Math.cos(a.ang) * (1 - t) + Math.cos(b.ang) * t;
        return { ang: Math.atan2(sx, cy), coh: a.coh * (1 - t) + b.coh * t };
    }

    /**
     * 결 목록 (사진 좌표). 같은 값이면 같은 결이 나오도록 씨앗을 고정한다.
     *  · 안쪽(지금 헤어라인 쪽): 길고 촘촘하게 — 원래 머리 속으로 파고들어 한 덩어리로
     *  · 끝선 쪽: 짧고 가늘고 성기게, 끝선 자체도 들쭉날쭉 — 잔머리처럼
     *  · 방향: 원래 머리결(readFlow)을 이어받고, 결 방향 조절바만큼 바깥으로 벌어짐
     */
    function strands() {
        var C = ctrlPts(), H = G.H, R = rng(S.seed * 7919 + 13);
        var sp = H * (0.032 - 0.022 * S.density / 100);
        var feather = H * 0.12, edge = H * (0.02 + 0.08 * S.soft / 100);
        var halfW = (G.xR - G.xL) / 2;
        var follow = (S.flow == null ? 70 : S.flow) / 100;
        // 끝선 들쭉날쭉 (낮은 물결 두세 겹)
        var R2 = rng(S.seed * 31 + 7), ph = [R2() * 6.3, R2() * 6.3, R2() * 6.3];
        var wav = function (x) {
            var u = (x - G.xL) / (G.xR - G.xL) * Math.PI * 2;
            return (Math.sin(u * 3 + ph[0]) * 0.5 + Math.sin(u * 7 + ph[1]) * 0.3 + Math.sin(u * 13 + ph[2]) * 0.2) * H * 0.022 * (0.3 + S.soft / 100);
        };
        var out = [], cols = Math.max(8, Math.round((G.xR - G.xL) / sp));
        for (var ci = 0; ci <= cols; ci++) {
            var x0 = G.xL + (G.xR - G.xL) * ci / cols;
            var cur = curAt(G, x0), tgt = targetAt(x0, C);
            if (tgt - cur < H * 0.01) continue;
            var tgtJ = tgt + wav(x0);
            var y0 = cur - feather, y1 = tgtJ + edge;
            var fl = flowAt(x0);
            for (var y = y0; y < y1; y += sp * (0.7 + R() * 0.5)) {
                var x = x0 + (R() - 0.5) * sp * 1.6, yy = y + (R() - 0.5) * sp;
                var v = (yy - cur) / Math.max(1, tgtJ - cur);       // 0 = 지금 선, 1 = 새 끝선
                var span = Math.max(1, tgtJ - cur);
                var e = v < 0 ? smooth(-feather / span, 0, v) * 0.6
                    : v > 1 ? 1 - smooth(1, 1 + edge / span, v) : 1 - 0.45 * smooth(0.65, 1, v) * (0.4 + S.soft / 100);
                if (R() > e) continue;
                var baby = v > 0.8;                                  // 끝선 쪽 잔머리
                var side = (x - G.cx) / halfW;
                var fan = (S.tilt / 100 * 0.75) * side;
                var base = fl ? fan * (1 - follow * fl.coh) + fl.ang * follow * fl.coh : fan;
                var ang = base + (R() - 0.5) * (baby ? 0.9 : 0.32);
                var L = H * (0.05 + 0.17 * S.len / 100) * (0.6 + R() * 0.7) * (baby ? 0.45 + 0.3 * R() : 1 + 0.5 * (1 - clamp(v, 0, 1)));
                var bend = (R() - 0.5) * (baby ? 0.6 : 0.3) * L + (fl ? Math.sin(fl.ang) * 0.12 * L : 0);
                var w = Math.max(0.55, H * (0.0014 + 0.0045 * S.thick / 100)) * (baby ? 0.55 : 0.8 + 0.4 * (1 - clamp(v, 0, 1))) * (0.8 + R() * 0.4);
                var tone = 0.82 + R() * 0.32, a = (0.4 + R() * 0.45) * (baby ? 0.55 : 0.55 + 0.45 * e);
                out.push([x, yy, x + Math.sin(ang) * L, yy - Math.cos(ang) * L, bend, w, tone, a, ang]);
                if (out.length > 11000) return out;
            }
        }
        return out;
    }

    // ── 그리기 ────────────────────────────────────────────────────────
    var FILTER_OK = (function () {
        try { var c = document.createElement("canvas").getContext("2d"); return typeof c.filter === "string"; } catch (e) { return false; }
    })();
    var layer = document.createElement("canvas"), layer2 = document.createElement("canvas");
    function fit(cv, w, h) { if (cv.width !== w) cv.width = w; if (cv.height !== h) cv.height = h; }

    function paint(ctx, T, after) {
        var w = ctx.canvas.width, h = ctx.canvas.height;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(after ? pan.img : pan.orig, T.ox, T.oy, w / T.s, h / T.s, 0, 0, w, h);
        if (!after) return;

        var X = function (x) { return (x - T.ox) * T.s; }, Y = function (y) { return (y - T.oy) * T.s; };
        var col = baseColor(), C = ctrlPts();
        fit(layer, w, h); fit(layer2, w, h);
        var L = layer.getContext("2d");
        L.setTransform(1, 0, 0, 1, 0, 0);
        L.clearRect(0, 0, w, h);

        // 바탕 음영: 새로 채우는 자리를 머리색으로 아주 옅게
        if (S.shade > 0) {
            var l2 = layer2.getContext("2d");
            l2.setTransform(1, 0, 0, 1, 0, 0);
            l2.clearRect(0, 0, w, h);
            l2.beginPath();
            var n = 60, i, x;
            for (i = 0; i <= n; i++) { x = G.xL + (G.xR - G.xL) * i / n; var yt = curAt(G, x) - G.H * 0.03; if (i) l2.lineTo(X(x), Y(yt)); else l2.moveTo(X(x), Y(yt)); }
            for (i = n; i >= 0; i--) { x = G.xL + (G.xR - G.xL) * i / n; l2.lineTo(X(x), Y(Math.max(curAt(G, x), targetAt(x, C)))); }
            l2.closePath();
            l2.fillStyle = "rgb(" + col.map(Math.round).join(",") + ")";
            l2.fill();
            ctx.save();
            if (FILTER_OK) ctx.filter = "blur(" + (G.H * 0.035 * T.s).toFixed(1) + "px)";
            ctx.globalCompositeOperation = "multiply";
            ctx.globalAlpha = S.shade / 100 * 0.42 * S.opacity / 100;
            ctx.drawImage(layer2, 0, 0);
            ctx.restore();
        }

        // 결
        // 결 하나 = 뿌리는 굵고 끝은 가는 휘어진 면 (2026-10-20)
        strands().forEach(function (st) {
            var mx = (st[0] + st[2]) / 2 + Math.cos(st[8]) * st[4], my = (st[1] + st[3]) / 2 + Math.sin(st[8]) * st[4];
            var c = col.map(function (v) { return Math.round(clamp(v * st[6], 0, 255)); });
            L.fillStyle = "rgba(" + c.join(",") + "," + st[7].toFixed(3) + ")";
            var M = 6, left = [], right = [], wr = st[5] * T.s / 2;
            for (var k = 0; k <= M; k++) {
                var t = k / M, u = 1 - t;
                var px = u * u * X(st[0]) + 2 * u * t * X(mx) + t * t * X(st[2]);
                var py = u * u * Y(st[1]) + 2 * u * t * Y(my) + t * t * Y(st[3]);
                var dx = 2 * u * (X(mx) - X(st[0])) + 2 * t * (X(st[2]) - X(mx));
                var dy = 2 * u * (Y(my) - Y(st[1])) + 2 * t * (Y(st[3]) - Y(my));
                var dl = Math.hypot(dx, dy) || 1, half = Math.max(0.25, wr * (1 - 0.85 * t));
                left.push([px - dy / dl * half, py + dx / dl * half]);
                right.push([px + dy / dl * half, py - dx / dl * half]);
            }
            L.beginPath();
            L.moveTo(left[0][0], left[0][1]);
            for (k = 1; k <= M; k++) L.lineTo(left[k][0], left[k][1]);
            for (k = M; k >= 0; k--) L.lineTo(right[k][0], right[k][1]);
            L.closePath();
            L.fill();
        });
        var op = S.opacity / 100;
        ctx.save();
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = op * 0.75;
        ctx.drawImage(layer, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = op * 0.55;
        ctx.drawImage(layer, 0, 0);
        ctx.restore();
    }

    /** 안내선: 지금 헤어라인(흰 점선) · 새 헤어라인(금색) · 조절점 */
    function paintGuide(ctx, T) {
        var X = function (x) { return (x - T.ox) * T.s; }, Y = function (y) { return (y - T.oy) * T.s; };
        var C = ctrlPts(), px = handlePx();
        ctx.save();
        ctx.lineWidth = Math.max(1.5, px * 0.22);
        ctx.setLineDash([px * 0.6, px * 0.5]);
        ctx.strokeStyle = "rgba(255,255,255,.85)";
        ctx.beginPath();
        G.cur.forEach(function (p, i) { if (i) ctx.lineTo(X(p[0]), Y(p[1])); else ctx.moveTo(X(p[0]), Y(p[1])); });
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = "#E8C65A";
        ctx.lineWidth = Math.max(2, px * 0.3);
        ctx.beginPath();
        for (var i = 0; i <= 60; i++) { var x = G.xL + (G.xR - G.xL) * i / 60, y = targetAt(x, C); if (i) ctx.lineTo(X(x), Y(y)); else ctx.moveTo(X(x), Y(y)); }
        ctx.stroke();
        C.forEach(function (p, k) {
            ctx.beginPath();
            ctx.arc(X(p[0]), Y(p[1]), px * (k === drag ? 1.25 : 1), 0, Math.PI * 2);
            ctx.fillStyle = "#C9A227"; ctx.fill();
            ctx.lineWidth = Math.max(1.5, px * 0.25); ctx.strokeStyle = "#221C33"; ctx.stroke();
        });
        ctx.restore();
    }

    // ── 보기 영역 ─────────────────────────────────────────────────────
    function cropRect(mode) {
        var W = pan.img.naturalWidth, Hh = pan.img.naturalHeight;
        if (mode === "face") return { x: 0, y: 0, w: W, h: Hh };
        var fw = G.xR - G.xL;
        var x0 = clamp(G.xL - fw * 0.12, 0, W), x1 = clamp(G.xR + fw * 0.12, 0, W);
        var top = Math.min.apply(null, G.cur.map(function (p) { return p[1]; }));
        var y0 = clamp(top - G.H * 0.65, 0, Hh), y1 = clamp(G.browY + G.H * 0.35, 0, Hh);
        return { x: x0, y: y0, w: Math.max(8, x1 - x0), h: Math.max(8, y1 - y0) };
    }
    var lastT = null;
    function transformFor(mode) {
        var r = cropRect(mode), long = Math.max(r.w, r.h);
        var s = mode === "face" ? Math.min(1, 1600 / long) : Math.min(2, 1600 / long);
        return { ox: r.x, oy: r.y, s: s, w: Math.round(r.w * s), h: Math.round(r.h * s) };
    }
    /** 조절점 크기 (화면에서 약 9px) — 캔버스 픽셀로 */
    function handlePx() {
        var cv = pan.canvas, r = cv.getBoundingClientRect();
        return 9 * (r.width ? cv.width / r.width : 1);
    }

    function draw() {
        if (!pan) return;
        var T = transformFor(crop);
        lastT = T;
        fit(pan.canvas, T.w, T.h);
        var ctx = pan.canvas.getContext("2d");
        paint(ctx, T, view !== "before");
        if (view === "compare") {
            var cut = Math.round(T.w * split);
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, cut, T.h); ctx.clip();
            ctx.drawImage(pan.orig, T.ox, T.oy, T.w / T.s, T.h / T.s, 0, 0, T.w, T.h);
            ctx.restore();
            var lw = Math.max(2, T.w / 400);
            ctx.fillStyle = "rgba(255,255,255,.92)";
            ctx.fillRect(cut - lw / 2, 0, lw, T.h);
            var r = Math.max(12, T.w / 40);
            ctx.beginPath(); ctx.arc(cut, T.h * 0.82, r, 0, Math.PI * 2);
            ctx.fillStyle = "#C9A227"; ctx.fill();
            ctx.fillStyle = "#221C33"; ctx.font = "bold " + Math.round(r) + "px sans-serif";
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("↔", cut, T.h * 0.82);
        } else if (view === "after" && guide) {
            paintGuide(ctx, T);
        }
        measure();
    }
    var queued = false;
    function schedule() {
        if (queued) return;
        queued = true;
        requestAnimationFrame(function () { queued = false; draw(); });
    }

    /** 상담용 숫자: 이마 높이가 얼굴 길이의 몇 % 인지 (지금 → 새 헤어라인) */
    function measure() {
        var C = ctrlPts();
        var tc = Math.max(G.yc, targetAt(G.cx, C));
        var face0 = G.chin[1] - G.yc, face1 = G.chin[1] - tc;
        if (!(face0 > 0)) { $("hMeasure").hidden = true; return; }
        var a = Math.round((G.browY - G.yc) / face0 * 100), b = Math.round((G.browY - tc) / face1 * 100);
        var down = Math.round((tc - G.yc) / (G.browY - G.yc) * 100);
        $("hMeasure").hidden = view === "before";
        $("hMeasure").innerHTML = "이마 높이 · 얼굴 길이의 <b>" + a + "%</b> → <b>" + b + "%</b>" + (down > 0 ? " (이마 " + down + "% 낮춤)" : "");
    }

    /** 사진 전체에 구운 한 장 (안내선 없이) */
    function bake(after, rect) {
        var r = rect || { x: 0, y: 0, w: pan.img.naturalWidth, h: pan.img.naturalHeight };
        var c = document.createElement("canvas");
        c.width = Math.round(r.w); c.height = Math.round(r.h);
        paint(c.getContext("2d"), { ox: r.x, oy: r.y, s: 1 }, after !== false);
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
    function syncRows() {
        document.querySelectorAll(".ctrl-row[data-key]").forEach(function (row) {
            var key = row.getAttribute("data-key"), d = SLIDERS[key];
            row.querySelector("input").value = S[key];
            row.querySelector("[data-val]").textContent = S[key] + (d.unit || "");
        });
    }
    function setValue(key, v) { var d = SLIDERS[key]; S[key] = clamp(Math.round(v), d.min, d.max); }
    function bindRows(box) {
        box.addEventListener("input", function (e) {
            var row = e.target.closest(".ctrl-row");
            if (!row || e.target.type !== "range") return;
            setValue(row.getAttribute("data-key"), +e.target.value);
            syncRows(); schedule();
        });
        box.addEventListener("change", function (e) { if (e.target.type === "range") commit(); });
        box.addEventListener("click", function (e) {
            var b = e.target.closest(".mui-step-btn");
            if (!b) return;
            e.preventDefault();
            var key = b.closest(".ctrl-row").getAttribute("data-key");
            setValue(key, S[key] + (+b.getAttribute("data-dir")));
            syncRows(); schedule(); commit();
        });
    }
    bindRows($("eQuick")); bindRows($("eManual"));

    /** 모양 카드 견본 그림 */
    function presetThumb(key) {
        var c = document.createElement("canvas");
        c.width = 132; c.height = 60;
        var x = c.getContext("2d");
        x.fillStyle = "#EEDFD3"; x.fillRect(0, 0, 132, 60);
        x.fillStyle = "#3a2a22";
        x.beginPath(); x.moveTo(0, 0); x.lineTo(132, 0);
        for (var i = 0; i <= 40; i++) {
            var u = i / 40, px = 132 - u * 132, e = Math.abs(2 * (1 - u) - 1);
            var y = key === "straight" ? 30 - 10 * Math.pow(e, 3) : key === "round" ? 24 + 16 * e * e
                : key === "m" ? 26 + 6 * e * e : 22 + 4 * e - (e > 0.55 && e < 0.9 ? 12 * Math.sin((e - 0.55) / 0.35 * Math.PI) : 0) + 10;
            x.lineTo(px, y);
        }
        x.closePath(); x.fill();
        return c;
    }
    function presetCards(box) {
        PRESETS.forEach(function (p) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = "eye-style";
            b.setAttribute("data-preset", p.key);
            b.title = p.hint;
            b.appendChild(presetThumb(p.key));
            var em = document.createElement("em"); em.textContent = p.label; b.appendChild(em);
            b.addEventListener("click", function () {
                S.preset = p.key;
                S.offs = [0, 0, 0, 0, 0, 0, 0];
                syncAll(); schedule(); commit();
            });
            box.appendChild(b);
        });
    }
    presetCards($("hPresets")); presetCards($("hPresets2"));

    function colorChips(box) {
        COLORS.forEach(function (c) {
            var b = document.createElement("button");
            b.type = "button";
            b.className = "mui-qcolor";
            b.setAttribute("data-color", c[0]);
            var sw = c[0] === "auto" ? (G && G.hair ? "rgb(" + G.hair.join(",") + ")" : "#2a1f1a") : c[0];
            b.innerHTML = '<i style="background:' + sw + (c[0] === "auto" ? ";outline:2px dashed #C9A227;outline-offset:2px" : "") + '"></i><em>' + c[1] + "</em>";
            b.addEventListener("click", function () { S.color = c[0]; syncAll(); schedule(); commit(); });
            box.appendChild(b);
        });
    }
    $("eColorPick").addEventListener("input", function (e) { S.color = e.target.value; syncAll(); schedule(); });
    $("eColorPick").addEventListener("change", commit);

    function label() {
        var p = PRESETS.filter(function (x) { return x.key === S.preset; })[0];
        return (p ? p.label : "헤어라인") + " · 내리기 " + S.lower;
    }
    function syncAll() {
        document.querySelectorAll("[data-preset]").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-preset") === S.preset); });
        document.querySelectorAll(".mui-qcolor").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-color") === S.color); });
        if (S.color !== "auto") $("eColorPick").value = S.color;
        syncRows(); syncUndo();
    }

    var sheet = $("eSheet");
    function setMode(m, tell) {
        uiMode = m === "manual" ? "manual" : "quick";
        sheet.classList.toggle("is-quick", uiMode === "quick");
        $("eModeQuick").classList.toggle("is-active", uiMode === "quick");
        $("eModeManual").classList.toggle("is-active", uiMode === "manual");
        if (tell) post({ type: "mui:mode", mode: uiMode });
    }
    $("eModeQuick").addEventListener("click", function () { setMode("quick", true); });
    $("eModeManual").addEventListener("click", function () { setMode("manual", true); });
    $("eToManual").addEventListener("click", function () { setMode("manual", true); });
    $("eHandle").addEventListener("click", function () {
        var order = ["half", "full", "peek"], now = sheet.getAttribute("data-snap");
        sheet.setAttribute("data-snap", order[(order.indexOf(now) + 1) % 3]);
    });

    $("eViewSeg").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-view]");
        if (!b) return;
        view = b.getAttribute("data-view");
        document.querySelectorAll("#eViewSeg button").forEach(function (x) { x.classList.toggle("is-active", x === b); });
        $("eHint").textContent = view === "compare" ? "사진 위를 좌우로 끌어 시술 전 · 후를 견주세요"
            : view === "before" ? "시술 전 사진입니다" : "금색 점을 끌어 새 헤어라인을 만드세요";
        schedule();
    });
    $("eChips").addEventListener("click", function (e) {
        var b = e.target.closest("button");
        if (!b) return;
        if (b.hasAttribute("data-crop")) {
            crop = b.getAttribute("data-crop");
            document.querySelectorAll("#eChips [data-crop]").forEach(function (x) { x.classList.toggle("is-active", x === b); });
        } else if (b.id === "hGuide") {
            guide = !guide;
            b.classList.toggle("is-active", guide);
        } else if (b.id === "hReseed") {
            S.seed = (S.seed % 9973) + 1 + Math.floor(Math.random() * 97);
            commit();
        }
        schedule();
    });

    // ── 손으로 끌기: 조절점 (세로) · 비교 선 (가로) ──────────────────
    var drag = -1, splitting = false;
    function toImage(e) {
        var cv = pan.canvas, r = cv.getBoundingClientRect(), T = lastT;
        var cxp = (e.clientX - r.left) * cv.width / r.width, cyp = (e.clientY - r.top) * cv.height / r.height;
        return { cx: cxp, cy: cyp, x: cxp / T.s + T.ox, y: cyp / T.s + T.oy, rx: (e.clientX - r.left) / r.width };
    }
    function nearestHandle(p) {
        var C = ctrlPts(), T = lastT, best = -1, bd = handlePx() * 3;
        C.forEach(function (q, i) {
            var d = Math.hypot((q[0] - T.ox) * T.s - p.cx, (q[1] - T.oy) * T.s - p.cy);
            if (d < bd) { bd = d; best = i; }
        });
        return best;
    }
    function setOffset(i, y) {
        var v = clamp((y - baseTarget(ctrlU(i))) / G.H * 100, -60, 140);
        S.offs[i] = Math.round(v * 10) / 10;
        if ($("hSym").checked) S.offs[NCTRL - 1 - i] = S.offs[i];
    }
    var cv0 = $("hairCanvas");
    cv0.addEventListener("pointerdown", function (e) {
        if (!pan || !lastT) return;
        var p = toImage(e);
        if (view === "compare") { splitting = true; split = clamp(p.rx, 0, 1); }
        else if (view === "after" && guide) {
            drag = nearestHandle(p);
            if (drag < 0) return;
            setOffset(drag, p.y);
        } else return;
        try { cv0.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
        e.preventDefault();
        schedule();
    });
    cv0.addEventListener("pointermove", function (e) {
        if (!splitting && drag < 0) return;
        var p = toImage(e);
        if (splitting) split = clamp(p.rx, 0, 1); else setOffset(drag, p.y);
        e.preventDefault();
        schedule();
    });
    ["pointerup", "pointercancel"].forEach(function (t) {
        cv0.addEventListener(t, function () {
            if (drag >= 0) commit();
            drag = -1; splitting = false;
            schedule();
        });
    });

    $("eUndo").addEventListener("click", function () { if (!undoStack.length) return; redoStack.push(JSON.stringify(S)); restore(undoStack.pop()); syncUndo(); });
    $("eRedo").addEventListener("click", function () { if (!redoStack.length) return; undoStack.push(JSON.stringify(S)); restore(redoStack.pop()); syncUndo(); });
    $("eReset").addEventListener("click", function () { var c = S.color; S = freshState(S.preset); S.color = c; syncAll(); schedule(); commit(); });
    $("eSettings").addEventListener("click", function () { post({ type: "mui:settings" }); });

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
    function compareSheet() {
        var r = cropRect("forehead"), cw = 900, gap = 12, head = 44;
        var hh = Math.round(cw * r.h / r.w), s = cw / r.w;
        var c = document.createElement("canvas");
        c.width = cw * 2 + gap * 3; c.height = head + hh + gap + 34;
        var x = c.getContext("2d");
        x.fillStyle = "#14111c"; x.fillRect(0, 0, c.width, c.height);
        x.fillStyle = "#E8C65A"; x.font = "bold 24px sans-serif"; x.textBaseline = "middle"; x.textAlign = "center";
        x.fillText("시술 전", gap + cw / 2, head / 2 + 4);
        x.fillText("예상 디자인 · " + label(), gap * 2 + cw * 1.5, head / 2 + 4);
        var tmp = document.createElement("canvas");
        tmp.width = cw; tmp.height = hh;
        var tc = tmp.getContext("2d");
        paint(tc, { ox: r.x, oy: r.y, s: s }, false); x.drawImage(tmp, gap, head);
        paint(tc, { ox: r.x, oy: r.y, s: s }, true); x.drawImage(tmp, gap * 2 + cw, head);
        tmp.width = 0;
        x.fillStyle = "#8C82A8"; x.font = "15px sans-serif"; x.textAlign = "right";
        x.fillText("PMUS 시뮬레이션 — 실제 시술 결과와 다를 수 있습니다", c.width - gap, c.height - 16);
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
            if (a === "save") post({ type: "mui:save", filename: "PMUS_헤어라인_비교_" + stamp() + ".jpg", dataUrl: url });
        });
        document.body.appendChild(box);
    }
    document.querySelectorAll("[data-tools]").forEach(function (box) {
        box.innerHTML = '<button type="button" class="mui-histbtn" data-t="compare">🖼️ 비교 보기</button>' +
            '<button type="button" class="mui-histbtn" data-t="save">💾 결과 저장</button>' +
            '<button type="button" class="mui-histbtn" data-t="crm" style="grid-column:1 / -1">📋 고객 이력으로 저장</button>';
        box.addEventListener("click", function (e) {
            var t = e.target.closest("[data-t]");
            if (!t || !pan) return;
            var k = t.getAttribute("data-t");
            if (k === "compare") openCompare();
            if (k === "save") post({ type: "mui:save", filename: "PMUS_헤어라인_" + stamp() + ".jpg", dataUrl: bake(true) });
            if (k === "crm") post({ type: "mui:saveCustomer", part: "hairline", label: label(), dataUrl: bake(true) });
        });
    });

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

    window.addEventListener("message", function (e) {
        var d = e.data;
        if (!d || typeof d !== "object") return;
        if (d.type === "mui:setMode") { setMode(d.mode, false); return; }
        if (d.type === "mui:capture" && pan) {
            post({ type: "mui:captured", part: "hairline", dataUrl: bake(true), label: "헤어라인 · " + label() });
        }
    });

    // ── 시작 ──────────────────────────────────────────────────────────
    function loadImg(src) {
        return new Promise(function (ok, fail) {
            var im = new Image();
            im.onload = function () { ok(im); };
            im.onerror = function () { fail(new Error("사진을 읽지 못했습니다")); };
            im.src = src;
        });
    }
    setMode(uiMode, false);
    var bgSrc = CFG.bg_b64, origSrc = CFG.orig_b64 || CFG.bg_b64;
    Promise.all([loadImg(bgSrc), origSrc === bgSrc ? null : loadImg(origSrc)]).then(function (r) {
        var img = r[0], orig = r[1] || r[0], d = CFG.hair_json;
        if (!d || !d.cur || d.cur.length < 5) {
            toast("얼굴을 찾지 못했습니다. 정면 사진으로 다시 해 주세요.", 5000);
            post({ type: "mui:ready", gen: CFG.mount_gen || 0 });
            return;
        }
        G = prepare(d, d.img_w ? img.naturalWidth / d.img_w : 1);
        pan = { img: img, orig: orig, canvas: cv0 };
        G.flow = readFlow(orig);
        colorChips($("eColors")); colorChips($("eColors2"));
        if (G.guessed) toast("머리카락 경계를 정확히 못 읽어 얼굴 윤곽으로 잡았습니다.\n앞머리를 넘긴 사진이면 더 정확합니다. 금색 점을 끌어 맞춰 주세요.", 5200);
        syncAll();
        schedule();
        requestAnimationFrame(function () { post({ type: "mui:ready", gen: CFG.mount_gen || 0 }); });
    })["catch"](function (err) {
        toast("헤어라인 화면을 열지 못했습니다: " + err.message, 5000);
        if (window.__blReport) window.__blReport("오류", err.message);
    });

    window.__hairState = function () { return copy({ S: S, view: view, crop: crop, mode: uiMode, guessed: G && G.guessed, H: G && G.H }); };
})();
