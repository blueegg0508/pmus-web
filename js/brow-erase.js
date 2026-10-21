/**
 * brow-erase.js — 고객의 원래 눈썹을 주변 피부색으로 덮은 판을 만든다.
 * =========================================================================
 * 눈썹이 원래 진한 고객은 디자인 눈썹을 얹어도 제 눈썹에 묻혀 차이가
 * 보이지 않는다. 상담하려면 원래 눈썹을 흐리게 해서 피부가 비치게 해야 한다.
 *
 * 여기서는 눈썹 한 쪽마다 '눈썹이 없었다면 이랬을 피부' 조각을 한 번
 * 만들어 둔다. 시뮬레이터는 그 조각을 원래 사진 위에 투명도만 바꿔
 * 겹친다 — 조절바를 움직일 때마다 다시 계산하지 않으므로 끌어도 가볍다.
 *
 *   BrowErase.build(img, brows, scale)
 *     img    : 고객 사진 (Image 또는 Canvas)
 *     brows  : { left: [[x,y]×10], right: [[x,y]×10] } — 얼굴 인식이 잰 눈썹 점
 *              앞 5개는 윗줄(꼬리→머리), 뒤 5개는 아랫줄(꼬리→머리)
 *     scale  : 점 좌표에 곱할 배율 (사진 크기가 잰 때와 다르면)
 *   → [{ canvas, x, y }] 한 쪽에 하나. 캔버스는 눈썹 자리만 불투명하다.
 *
 * 메우는 방법은 push-pull: 눈썹이 아닌 픽셀만 남겨 반씩 줄여 가며 평균을
 * 내고, 다시 키우면서 빈자리를 거친 단계의 색으로 채운다. 위(이마)와
 * 아래(눈두덩)의 피부색이 자연스럽게 섞인다.
 * =========================================================================
 */
(function () {
    "use strict";

    /**
     * 한 쪽 눈썹 점으로 둘레를 만든다: 윗줄 그대로 → 아랫줄 거꾸로.
     *
     * 인식 점은 털 끝까지 닿지 않는다. 특히 앞머리(콧대 쪽)는 점보다 안쪽까지
     * 털이 나 있고 아랫줄은 눈썹 안쪽에 찍힌다. 그래서 머리·꼬리를 눈썹 결
     * 방향으로 늘이고, 아랫줄을 조금 내린다.
     */
    function outline(pts, scale, th) {
        const p = pts.map(function (q) { return [q[0] * scale, q[1] * scale]; });
        const up = p.slice(0, 5), lo = p.slice(5, 10);
        // 결 방향 (꼬리 → 머리)
        const tail = [(up[0][0] + lo[0][0]) / 2, (up[0][1] + lo[0][1]) / 2];
        const head = [(up[4][0] + lo[4][0]) / 2, (up[4][1] + lo[4][1]) / 2];
        const len = Math.hypot(head[0] - tail[0], head[1] - tail[1]) || 1;
        const ux = (head[0] - tail[0]) / len, uy = (head[1] - tail[1]) / len;
        const push = function (q, d) { return [q[0] + ux * d, q[1] + uy * d]; };
        const headOut = th * 0.45, tailOut = th * 0.3, drop = th * 0.3;
        up[4] = push(up[4], headOut); lo[4] = push(lo[4], headOut);
        up[0] = push(up[0], -tailOut); lo[0] = push(lo[0], -tailOut);
        for (let i = 0; i < 5; i++) lo[i] = [lo[i][0] + (ux >= 0 ? -uy : uy) * drop, lo[i][1] + Math.abs(ux) * drop];  // 결에 수직, 아래쪽
        return up.concat(lo.reverse());
    }

    function bounds(poly) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        poly.forEach(function (p) {
            if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        });
        return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0 };
    }

    /** 둘레를 부풀려 칠한 가림판. 인식 점은 털 끝까지 닿지 않아서 넉넉히 덮는다. */
    function drawMask(ctx, poly, ox, oy, grow, blur) {
        ctx.save();
        if (blur > 0) ctx.filter = "blur(" + blur.toFixed(1) + "px)";
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#fff";
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.lineWidth = grow * 2;
        ctx.beginPath();
        poly.forEach(function (p, i) {
            const x = p[0] - ox, y = p[1] - oy;
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    /**
     * push-pull 로 빈자리를 메운다.
     * rgb: Float32Array(w*h*3), known: Float32Array(w*h) 0~1 (1 = 믿을 수 있는 피부)
     */
    function pushPull(rgb, known, w, h) {
        // 줄여 가며 쌓는다
        const levels = [{ w: w, h: h, c: rgb, a: known }];
        let cw = w, ch = h, c = rgb, a = known;
        while (cw > 2 || ch > 2) {
            const nw = Math.max(1, Math.ceil(cw / 2)), nh = Math.max(1, Math.ceil(ch / 2));
            const nc = new Float32Array(nw * nh * 3), na = new Float32Array(nw * nh);
            for (let y = 0; y < nh; y++) {
                for (let x = 0; x < nw; x++) {
                    let sr = 0, sg = 0, sb = 0, sa = 0;
                    for (let dy = 0; dy < 2; dy++) {
                        const yy = y * 2 + dy; if (yy >= ch) continue;
                        for (let dx = 0; dx < 2; dx++) {
                            const xx = x * 2 + dx; if (xx >= cw) continue;
                            const i = yy * cw + xx, k = a[i];
                            sr += c[i * 3] * k; sg += c[i * 3 + 1] * k; sb += c[i * 3 + 2] * k; sa += k;
                        }
                    }
                    const o = y * nw + x;
                    if (sa > 0) { nc[o * 3] = sr / sa; nc[o * 3 + 1] = sg / sa; nc[o * 3 + 2] = sb / sa; }
                    na[o] = Math.min(1, sa);
                }
            }
            levels.push({ w: nw, h: nh, c: nc, a: na });
            cw = nw; ch = nh; c = nc; a = na;
        }
        // 키우며 채운다 (거친 단계를 부드럽게 늘려 빈자리에 섞는다)
        for (let L = levels.length - 2; L >= 0; L--) {
            const f = levels[L], g = levels[L + 1];
            for (let y = 0; y < f.h; y++) {
                const gy = Math.min(g.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
                const y0 = Math.floor(gy), y1 = Math.min(g.h - 1, y0 + 1), ty = gy - y0;
                for (let x = 0; x < f.w; x++) {
                    const i = y * f.w + x, k = f.a[i];
                    if (k >= 1) continue;
                    const gx = Math.min(g.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
                    const x0 = Math.floor(gx), x1 = Math.min(g.w - 1, x0 + 1), tx = gx - x0;
                    for (let ch3 = 0; ch3 < 3; ch3++) {
                        const v = (g.c[(y0 * g.w + x0) * 3 + ch3] * (1 - tx) + g.c[(y0 * g.w + x1) * 3 + ch3] * tx) * (1 - ty)
                                + (g.c[(y1 * g.w + x0) * 3 + ch3] * (1 - tx) + g.c[(y1 * g.w + x1) * 3 + ch3] * tx) * ty;
                        f.c[i * 3 + ch3] = f.c[i * 3 + ch3] * k + v * (1 - k);
                    }
                    f.a[i] = 1;
                }
            }
        }
        return levels[0].c;
    }

    /** 결정론적 잡음 (다시 그려도 같은 결이 나오게) */
    function noise(i) {
        const s = Math.sin(i * 12.9898) * 43758.5453;
        return s - Math.floor(s) - 0.5;
    }

    /** 상자 흐림 (가로 · 세로) — 캔버스 필터를 못 쓰는 기기에서도 같게 */
    function boxBlur(a, w, h, r) {
        r = Math.max(0, Math.round(r));
        if (!r) return a;
        const t = new Float32Array(w * h), o = new Float32Array(w * h), k = 2 * r + 1;
        for (let y = 0; y < h; y++) {
            let s = 0;
            for (let x = -r; x <= r; x++) s += a[y * w + Math.min(w - 1, Math.max(0, x))];
            for (let x = 0; x < w; x++) {
                t[y * w + x] = s / k;
                s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
            }
        }
        for (let x = 0; x < w; x++) {
            let s = 0;
            for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
            for (let y = 0; y < h; y++) {
                o[y * w + x] = s / k;
                s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
            }
        }
        return o;
    }
    /** 가장 큰 값으로 넓히기 (털 끝의 옅은 부분까지 덮게) */
    function dilate(a, w, h, r) {
        r = Math.max(0, Math.round(r));
        if (!r) return a;
        const t = new Float32Array(w * h), o = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let m = 0;
            for (let d = -r; d <= r; d++) { const v = a[y * w + Math.min(w - 1, Math.max(0, x + d))]; if (v > m) m = v; }
            t[y * w + x] = m;
        }
        for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
            let m = 0;
            for (let d = -r; d <= r; d++) { const v = t[Math.min(h - 1, Math.max(0, y + d)) * w + x]; if (v > m) m = v; }
            o[y * w + x] = m;
        }
        return o;
    }
    const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

    /**
     * 한 쪽 눈썹 지우기 (2026-10-19 개편 — 숱 많은 · 두꺼운 눈썹 대응).
     *
     * 예전에는 인식 점으로 만든 '정해진 모양'만 덮었다. 두꺼운 눈썹은 그 바깥에
     * 털이 남고, 메울 색도 그 남은 털에서 빌려 와 회색 띠가 생겼다.
     *
     * 이제는 실제 털을 찾는다.
     *   1. 인식한 눈썹보다 넉넉한 '찾는 범위'를 잡는다.
     *   2. 범위 바깥 피부만으로 범위 안을 메워 '털이 없었다면 이 밝기' 를 만든다.
     *   3. 그보다 확연히 어두운 곳 = 털. 털 끝까지 조금 넓히고 가장자리를 부드럽게.
     *   4. 털이 아닌 피부만 재료로 다시 메우고, 이마의 피부 결을 얹는다.
     *   5. 덮는 판의 투명도 = 털 판정 — 털이 있는 곳만 덮인다.
     */
    function eraseOne(img, W, H, pts, scale, eye, eyeDist) {
        let th = 0;
        for (let i = 0; i < 5; i++) {
            th += Math.hypot(pts[i][0] - pts[5 + i][0], pts[i][1] - pts[5 + i][1]) * scale;
        }
        th = Math.max(4, th / 5);
        const poly = outline(pts, scale, th);
        const b = bounds(poly);
        // 찾는 범위는 털이 범위 끝까지 이어지면 넓혀 간다 (두꺼운 눈썹)
        const GROWS = [0.55, 0.95, 1.4].map(function (k) { return Math.max(4, th * k); });   // 위아래로 덜 넓게 (2026-10-22 원장님: 흐리는 띠가 넓다)
        const coreGrow = Math.max(2, th * 0.12);
        const maxGrow = GROWS[GROWS.length - 1];
        const pad = Math.ceil(maxGrow + th * 0.9);
        const lift = Math.ceil(th * 1.6 + GROWS[0]);
        const x = Math.max(0, Math.floor(b.x0 - pad)), y = Math.max(0, Math.floor(b.y0 - pad - lift));
        const w = Math.min(W, Math.ceil(b.x1 + pad)) - x, h = Math.min(H, Math.ceil(b.y1 + pad)) - y;
        if (w < 8 || h < 8) return null;
        // 넘지 않을 아래 선: 윗 눈꺼풀보다 조금 위 (눈 중심 − 눈 사이 거리의 15%)
        const limitY = eye && eyeDist ? eye[1] * scale - eyeDist * scale * 0.15 - y : Infinity;

        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const c = cv.getContext("2d", { willReadFrequently: true });
        c.drawImage(img, x, y, w, h, 0, 0, w, h);
        const src = c.getImageData(0, 0, w, h);
        const sd = src.data, n = w * h;
        const L = new Float32Array(n);
        for (let i = 0; i < n; i++) L[i] = lum(sd[i * 4], sd[i * 4 + 1], sd[i * 4 + 2]);
        const rowOk = function (i) { return Math.floor(i / w) <= limitY; };
        // 옆으로는 넓히지 않는다 — 관자놀이 머리카락 · 콧대를 털로 잘못 지우지 않게
        const cx0 = b.x0 - th * 1.2 - x, cx1 = b.x1 + th * 1.2 - x;   // 옆머리 가까운 얼굴에서 머리카락까지 덮지 않게 (2026-10-21)
        const colOk = function (i) { const xx = i % w; return xx >= cx0 && xx <= cx1; };
        // 위로는 거의 넓히지 않는다 — 앞머리가 눈썹 위로 내려온 사진에서 앞머리를 눈썹으로 잘못 지웠다 (2026-10-19)
        const polyTop = b.y0 - y, polyMid = (b.y0 + b.y1) / 2 - y;
        const upLimit = polyTop - Math.max(3, th * 0.45);
        const upOk = function (i) { return Math.floor(i / w) >= upLimit; };

        const mk = document.createElement("canvas");
        mk.width = w; mk.height = h;
        const m = mk.getContext("2d", { willReadFrequently: true });
        const maskOf = function (g) {
            m.clearRect(0, 0, w, h);
            drawMask(m, poly, x, y, g, 0);
            const d = m.getImageData(0, 0, w, h).data, out = new Uint8Array(n);
            for (let i = 0; i < n; i++) out[i] = d[i * 4 + 3] > 8 && rowOk(i) && colOk(i) && upOk(i) ? 1 : 0;
            return out;
        };
        const core = maskOf(coreGrow);

        // 이마 피부 밝기 (위쪽 띠에서, 머리카락처럼 어두운 것은 빼고 가운데값)
        const band = [];
        for (let yy = 0; yy < Math.max(2, Math.floor(lift * 0.7)); yy++) {
            for (let xx = 0; xx < w; xx += 2) band.push(L[yy * w + xx]);
        }
        band.sort(function (p, q) { return p - q; });
        // 앞머리가 이마를 덮어도 피부 밝기를 잡도록 밝은 쪽(85%) 값을 쓴다
        const fore = band.length ? band[Math.floor(band.length * 0.85)] : 170;

        const rgb = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { rgb[i * 3] = sd[i * 4]; rgb[i * 3 + 1] = sd[i * 4 + 1]; rgb[i * 3 + 2] = sd[i * 4 + 2]; }

        let zone = null, hair = null, outside = null, refKeep = null;
        // 가닥 단위 기준: 가닥 굵기보다 조금 넓은 둘레에서 가장 밝은 값(= 그 자리 피부) — 가는 털이 그보다 어둡다
        const rLoc = Math.max(2, Math.round(th * 0.18));
        const localBg = boxBlur(dilate(L, w, h, rLoc), w, h, rLoc);
        for (let gi = 0; gi < GROWS.length; gi++) {
            zone = maskOf(GROWS[gi]);
            // 1) 범위 바깥의 '피부' 만 (이마보다 많이 어두운 것 = 남은 털 · 그림자 · 눈은 뺀다)
            outside = new Float32Array(n);
            // 그늘진 피부(눈썹뼈 아래 · 관자놀이 쪽)도 기준에 넣는다 — 빼면 메운 자리가 혼자 밝아 스티커처럼 보였다 (2026-10-21)
            for (let i = 0; i < n; i++) outside[i] = !zone[i] && rowOk(i) && L[i] > fore * 0.55 ? 1 : 0;
            const ref = pushPull(rgb.slice(), outside.slice(), w, h);   // pushPull 은 받은 배열을 고쳐 쓴다
            refKeep = ref;
            // 2) 털 판정
            hair = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                if (!zone[i]) continue;
                const R = Math.max(1, lum(ref[i * 3], ref[i * 3 + 1], ref[i * 3 + 2]));
                const dGlobal = (R - L[i]) / R;
                const dLocal = (localBg[i] - L[i]) / Math.max(1, localBg[i]);
                const d = Math.max(dGlobal, dLocal);
                // 인식한 눈썹 안: 옅고 가는 털까지 / 바깥: 확실히 진한 털만 — 눈썹 아래 그늘진 피부를 털로 보지 않게 (2026-10-21)
                hair[i] = core[i] ? (d <= 0.035 ? 0 : d >= 0.12 ? 1 : (d - 0.035) / 0.085)
                                  : (d <= 0.12 ? 0 : d >= 0.24 ? 1 : (d - 0.12) / 0.12);
            }
            // 털이 범위 끝(둘레)까지 이어져 있으면 더 넓혀 다시 찾는다
            if (gi === GROWS.length - 1) break;
            const inner = maskOf(Math.max(1, GROWS[gi] - 3));
            let ring = 0, ringHair = 0;
            for (let i = 0; i < n; i++) if (zone[i] && !inner[i] && Math.floor(i / w) > polyMid) { ring++; if (hair[i] > 0.5) ringHair++; }
            if (!ring || ringHair / ring < 0.22) break;
        }

        // 앞머리가 눈썹 위를 덮고 있나: 눈썹 바로 위 띠에 머리카락처럼 어두운 곳이 많으면 그렇다.
        // 그때는 눈썹 털과 앞머리를 밝기로 가를 수 없으므로, 예전처럼 인식한 눈썹 자리만 지운다 (2026-10-19)
        let bandN = 0, bandDark = 0;
        const by0 = Math.max(0, Math.floor(polyTop - th * 1.2)), by1 = Math.max(0, Math.floor(polyTop - th * 0.2));
        for (let yy = by0; yy < by1; yy++) {
            for (let xx = Math.max(0, Math.floor(b.x0 - x)); xx < Math.min(w, Math.ceil(b.x1 - x)); xx++) {
                bandN++; if (L[yy * w + xx] < fore * 0.75) bandDark++;
            }
        }
        const bangs = bandN > 0 && bandDark / bandN > 0.25;
        // 범위 대부분이 '털' 이어도 (그림자 · 어두운 조명) 같은 방식으로
        let zc = 0, zh = 0;
        for (let i = 0; i < n; i++) if (zone[i]) { zc++; if (hair[i] > 0.5) zh++; }
        if (bangs || (zc && zh / zc > 0.75)) {
            const safe = maskOf(Math.max(3, th * 0.36));
            for (let i = 0; i < n; i++) hair[i] = safe[i] ? 1 : 0;
        } else {
            // 눈썹 윗선(인식한 둘레를 조금 부풀린 것)보다 위의 어두운 결은 지우지 않는다 — 곡선을 따라
            const above = maskOf(Math.max(2, th * 0.3));
            for (let i = 0; i < n; i++) {
                if (hair[i] > 0 && !above[i] && Math.floor(i / w) < polyMid) hair[i] = 0;
            }
        }

        // 눈썹 모양만 떼어 낸다 (2026-10-21 원장님): 털로 본 픽셀을 이어진 덩어리로 나누고,
        // 얼굴 인식이 찾은 눈썹(core)과 겹치는 덩어리만 남긴다. 옆머리 · 그림자처럼 따로 떨어진 덩어리는 버린다.
        {
            const lab = new Int32Array(n), keep = [0], stack = [];
            let id = 0;
            for (let i = 0; i < n; i++) {
                if (hair[i] < 0.35 || lab[i]) continue;
                id++; let touch = false; stack.length = 0; stack.push(i); lab[i] = id;
                while (stack.length) {
                    const q = stack.pop();
                    if (core[q]) touch = true;
                    const qx = q % w, qy = (q - qx) / w;
                    if (qx > 0 && !lab[q - 1] && hair[q - 1] >= 0.35) { lab[q - 1] = id; stack.push(q - 1); }
                    if (qx < w - 1 && !lab[q + 1] && hair[q + 1] >= 0.35) { lab[q + 1] = id; stack.push(q + 1); }
                    if (qy > 0 && !lab[q - w] && hair[q - w] >= 0.35) { lab[q - w] = id; stack.push(q - w); }
                    if (qy < h - 1 && !lab[q + w] && hair[q + w] >= 0.35) { lab[q + w] = id; stack.push(q + w); }
                }
                keep.push(touch ? 1 : 0);
            }
            for (let i = 0; i < n; i++) {
                if (lab[i]) { if (!keep[lab[i]]) hair[i] = 0; }
                else if (hair[i] > 0 && !core[i]) hair[i] *= 0.5;      // 덩어리에 못 끼는 옅은 가장자리는 반만
            }
        }
        mk.width = 0; mk.height = 0;

        // 원칙: 머리카락(옆머리 · 앞머리)은 절대 건드리지 않는다 (2026-10-22 원장님).
        //  1) 찾는 범위 바깥의 아주 어두운 곳 = 머리카락 씨앗
        //  2) 씨앗에 이어진 곳은 조금 덜 어두워도(잔머리 · 머리끝) 머리카락으로 넓혀 간다
        //  3) 그 둘레에 여유 폭을 두고, 그 안은 털 판정 · 덮기 모두 하지 않는다
        const headHair = new Uint8Array(n);
        const hairRaw = new Uint8Array(n);
        {
            const seedT = fore * 0.45, growT = fore * 0.78, st = [];
            // 눈썹 둘레(인식 둘레를 넉넉히 부풀린 곳)는 씨앗에서 뺀다 — 진한 눈썹 꼬리를 머리카락으로 잘못 보지 않게
            const near = new Uint8Array(n);
            {
                const nc = document.createElement("canvas"); nc.width = w; nc.height = h;
                const nx = nc.getContext("2d", { willReadFrequently: true });
                drawMask(nx, poly, x, y, Math.max(6, th * 1.1), 0);
                const nd = nx.getImageData(0, 0, w, h).data;
                for (let i = 0; i < n; i++) near[i] = nd[i * 4 + 3] > 8 ? 1 : 0;
                nc.width = 0; nc.height = 0;
            }
            for (let i = 0; i < n; i++) if (L[i] < seedT && !zone[i] && !near[i]) headHair[i] = 1;
            // 머리카락은 잘라 낸 판의 가장자리까지 이어져 있다 — 판 안에 떠 있는 진한 덩어리(눈썹 꼬리 · 앞머리 털 · 점)는 머리카락이 아니다
            {
                const lab = new Int32Array(n);
                let id = 0;
                for (let i = 0; i < n; i++) {
                    if (!headHair[i] || lab[i]) continue;
                    id++; const comp = [i]; lab[i] = id; let edge = false;
                    for (let k = 0; k < comp.length; k++) {
                        const q = comp[k], qx = q % w, qy = (q - qx) / w;
                        if (qx === 0 || qy === 0 || qx === w - 1 || qy === h - 1) edge = true;
                        const nb = [qx > 0 ? q - 1 : -1, qx < w - 1 ? q + 1 : -1, q - w, q + w];
                        for (const j of nb) if (j >= 0 && j < n && headHair[j] && !lab[j]) { lab[j] = id; comp.push(j); }
                    }
                    if (edge) comp.forEach((q) => st.push(q));
                    else comp.forEach((q) => { headHair[q] = 0; });
                }
            }
            while (st.length) {
                const q = st.pop(), qx = q % w;
                const nb = [qx > 0 ? q - 1 : -1, qx < w - 1 ? q + 1 : -1, q - w, q + w];
                for (const j of nb) if (j >= 0 && j < n && !headHair[j] && L[j] < growT && !core[j] && (!near[j] || L[j] < seedT * 0.8)) { headHair[j] = 1; st.push(j); }
            }
            hairRaw.set(headHair);   // 여유 폭을 붙이기 전 — 이 바로 옆 그늘진 피부는 메울 재료로 쓴다
            const grow = dilate(Float32Array.from(headHair), w, h, Math.max(3, Math.round(th * 0.35)));
            for (let i = 0; i < n; i++) if (grow[i] > 0) { hair[i] = 0; headHair[i] = 1; }
        }

        // 가닥만 덮는다 (2026-10-21 원장님: 눈썹 자리 전체가 아니라 눈썹 가닥 자체를 흐리게).
        // 가닥 사이 피부는 원래 사진 그대로 남아 얼굴 곡면의 명암 · 피부 결이 살아 있다.
        for (let i = 0; i < n; i++) if (!rowOk(i)) hair[i] = 0;
        // (옆 · 아래로는 넓히지 않는다 — 넓히면 눈썹 위아래 피부까지 흐려졌다)
        // 위로만 조금: 눈썹 윗선 바로 위의 밝은 띠가 눈썹을 지운 뒤 줄처럼 드러나서 그 띠까지 함께 메운다 (2026-10-22)
        {
            const r = Math.max(2, Math.round(th * 0.22)), up = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                let m = hair[i];
                for (let k = 1; k <= r; k++) { const j = i + k * w; if (j < n && hair[j] > m) m = hair[j] * (1 - 0.35 * k / r); }
                up[i] = m;
            }
            hair = up;
        }
        const alpha = boxBlur(hair, w, h, Math.max(1, th * 0.06));   // 가장자리를 부드럽게 — 경계선이 또렷하면 스티커처럼 보인다
        for (let i = 0; i < n; i++) { const a = Math.min(1, alpha[i] * 1.35); alpha[i] = a * a * (3 - 2 * a); }
        for (let i = 0; i < n; i++) if (headHair[i]) alpha[i] = 0;   // 머리카락 자리는 한 픽셀도 덮지 않는다   // 가장자리는 원래 피부가 더 비치게
        const fadeW = Math.max(3, th * 1.2), fadeH = Math.max(2, th * 0.5);
        for (let i = 0; i < n; i++) {
            const xx = i % w, yy = Math.floor(i / w);
            // 옆 끝 · 아래(눈꺼풀 쪽) 한계선 가까이에서는 서서히 옅어지게 — 곧은 경계선이 생기지 않게
            const f = Math.min(1, Math.max(0, (xx - cx0) / fadeW), Math.max(0, (cx1 - xx) / fadeW), Math.max(0, (limitY - yy) / fadeH));
            alpha[i] *= f * f * (3 - 2 * f);
        }

        // 3) 털이 아닌 피부만 재료로 메운다
        const known = new Float32Array(n);
        // 털이 아닌 피부는 그늘진 곳까지 모두 재료로 — 둘레의 명암이 메운 자리 안으로 그대로 이어진다
        // 머리카락은 밝기가 아니라 머리카락 판(headHair)으로 뺀다 — 관자놀이 쪽 그늘진 피부도 재료로 써야
        // 메운 자리가 얼굴 곡면의 명암을 따라 어두워진다 (밝은 피부만 쓰면 그 자리만 스티커처럼 밝았다, 2026-10-22)
        for (let i = 0; i < n; i++) known[i] = (hair[i] < 0.15 && rowOk(i) && !hairRaw[i] && L[i] > fore * 0.4) ? 1 : 0;
        const filled = pushPull(rgb, known, w, h);

        // 4) 피부 결 — 바로 위 이마에서
        const lumBlur = boxBlur(L, w, h, Math.max(1, th * 0.1));
        let gs = 0, gc = 0;
        for (let i = 0; i < n; i++) if (outside[i]) { const g = L[i] - lumBlur[i]; gs += g * g; gc++; }
        const grain = gc ? Math.min(6, Math.max(1, Math.sqrt(gs / gc))) : 2;
        // 결을 빌려 올 거리: 털이 있는 맨 위보다 위로
        let topHair = h;
        for (let i = 0; i < n; i++) if (hair[i] > 0.3) { topHair = Math.floor(i / w); break; }
        let botHair = 0;
        for (let i = n - 1; i >= 0; i--) if (hair[i] > 0.3) { botHair = Math.floor(i / w); break; }
        const shiftUp = Math.max(lift, botHair - topHair + 4);

        const out = c.createImageData(w, h);
        const od = out.data;
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const i = yy * w + xx;
                let t;
                const sy = yy - shiftUp, j = sy * w + xx;
                if (sy >= 0 && outside[j]) {
                    t = L[j] - lumBlur[j];
                    if (Math.abs(t) > grain * 3) t = Math.sign(t) * grain * 3;
                } else {
                    t = noise(i + x * 7 + y * 13) * grain * 2;
                }
                // 밝기(명암)는 바로 옆 피부에서, 색(피부 톤)은 눈썹 둘레의 깨끗한 피부에서 —
                // 옅은 털이 섞여 메운 색이 회색빛으로 뜨던 것을 막는다
                const Lf = lum(filled[i * 3], filled[i * 3 + 1], filled[i * 3 + 2]);
                const Lr = Math.max(1, lum(refKeep[i * 3], refKeep[i * 3 + 1], refKeep[i * 3 + 2]));
                const k = Lf / Lr;
                od[i * 4]     = refKeep[i * 3] * k * 0.75 + filled[i * 3] * 0.25 + t;
                od[i * 4 + 1] = refKeep[i * 3 + 1] * k * 0.75 + filled[i * 3 + 1] * 0.25 + t;
                od[i * 4 + 2] = refKeep[i * 3 + 2] * k * 0.75 + filled[i * 3 + 2] * 0.25 + t;
                od[i * 4 + 3] = Math.round(Math.min(1, alpha[i]) * 255);
            }
        }
        // 이음새 없애기 (2026-10-22): 덮는 자리 바로 바깥에서 '원래 피부 − 메운 색' 차이를 재고,
        // 그 차이를 안쪽으로 고르게 퍼뜨려 더한다. 경계에서 두 색이 같아져 눈썹 윗선 자리에 줄이 남지 않는다.
        {
            const diff = new Float32Array(n * 3), dk = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                // 피부만 기준으로 — 옆머리 · 그늘처럼 어두운 곳을 맞추면 그 색이 얼굴 쪽으로 번져 들어왔다 (2026-10-22)
                if (alpha[i] < 0.03 && rowOk(i) && !hairRaw[i] && L[i] > fore * 0.4 && hair[i] < 0.1) {
                    dk[i] = 1;
                    diff[i * 3] = sd[i * 4] - od[i * 4];
                    diff[i * 3 + 1] = sd[i * 4 + 1] - od[i * 4 + 1];
                    diff[i * 3 + 2] = sd[i * 4 + 2] - od[i * 4 + 2];
                }
            }
            const corr = pushPull(diff, dk, w, h);
            for (let i = 0; i < n; i++) {
                if (alpha[i] <= 0) continue;
                od[i * 4] += corr[i * 3]; od[i * 4 + 1] += corr[i * 3 + 1]; od[i * 4 + 2] += corr[i * 3 + 2];
            }
        }
        c.putImageData(out, 0, 0);
        return { canvas: cv, x: x, y: y };
    }

    function build(img, brows, scale) {
        const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
        if (!W || !H || !brows) return [];
        const res = [];
        ["left", "right"].forEach(function (side) {
            const pts = brows[side];
            if (!pts || pts.length < 10) return;
            try {
                const e = brows.eyes, el = e && e.left, er = e && e.right;
                const eyeDist = el && er ? Math.hypot(er.x - el.x, er.y - el.y) : 0;
                const eye = e && e[side] ? [e[side].x, e[side].y] : null;
                const piece = eraseOne(img, W, H, pts, scale || 1, eye, eyeDist);
                if (piece) res.push(piece);
            } catch (e) {
                console.warn("눈썹 지우기 실패", side, e);
            }
        });
        return res;
    }

    window.BrowErase = { build: build };
})();
