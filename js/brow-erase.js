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

    function eraseOne(img, W, H, pts, scale) {
        // 눈썹 두께: 윗줄과 아랫줄 짝의 거리 평균. 둘레 높이는 눈썹이 기울면
        // 부풀어서 쓰지 않는다 — 너무 넓게 덮으면 번진 띠처럼 보인다.
        let th = 0;
        for (let i = 0; i < 5; i++) {
            th += Math.hypot(pts[i][0] - pts[5 + i][0], pts[i][1] - pts[5 + i][1]) * scale;
        }
        th = Math.max(4, th / 5);
        const poly = outline(pts, scale, th);
        const b = bounds(poly);
        const grow = Math.max(3, th * 0.36);               // 털 끝까지 덮을 여유
        const pad = Math.ceil(grow * 2 + th * 0.6);         // 메울 때 참고할 둘레 피부
        // 피부 결은 바로 위 이마에서 빌려 온다. 그만큼 위로 더 잘라 둔다.
        const lift = Math.ceil(th + grow * 2);
        const x = Math.max(0, Math.floor(b.x0 - pad)), y = Math.max(0, Math.floor(b.y0 - pad - lift));
        const w = Math.min(W, Math.ceil(b.x1 + pad)) - x, h = Math.min(H, Math.ceil(b.y1 + pad)) - y;
        if (w < 8 || h < 8) return null;

        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        const c = cv.getContext("2d", { willReadFrequently: true });
        c.drawImage(img, x, y, w, h, 0, 0, w, h);
        const src = c.getImageData(0, 0, w, h);

        // 메울 자리 (딱딱한 판)
        const mk = document.createElement("canvas");
        mk.width = w; mk.height = h;
        const m = mk.getContext("2d", { willReadFrequently: true });
        drawMask(m, poly, x, y, grow, 0);
        const hole = m.getImageData(0, 0, w, h).data;
        // 겹칠 때 쓸 가장자리 (부드러운 판) — 메운 자리보다 조금 넓게 번진다
        m.clearRect(0, 0, w, h);
        drawMask(m, poly, x, y, grow * 1.1, Math.max(2, grow * 0.45));
        const soft = m.getImageData(0, 0, w, h).data;

        const n = w * h;
        const rgb = new Float32Array(n * 3), known = new Float32Array(n);
        let sum = 0, sum2 = 0, cnt = 0;
        for (let i = 0; i < n; i++) {
            const r = src.data[i * 4], g = src.data[i * 4 + 1], bl = src.data[i * 4 + 2];
            rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = bl;
            const k = hole[i * 4 + 3] > 8 ? 0 : 1;
            known[i] = k;
            if (k) { const l = 0.299 * r + 0.587 * g + 0.114 * bl; sum += l; sum2 += l * l; cnt++; }
        }
        // pushPull 은 받은 배열을 고쳐 쓴다. known 은 아래에서 다시 봐야 해서 사본을 넘긴다.
        const filled = pushPull(rgb, known.slice(), w, h);

        // 피부 결(모공·잔주름)을 바로 위 이마에서 옮겨 온다. 메운 색만 두면
        // 너무 매끈해서 '지운 티'가 난다. 결 = 원래 픽셀 − 흐리게 한 픽셀.
        const bl = document.createElement("canvas");
        bl.width = w; bl.height = h;
        const bc = bl.getContext("2d", { willReadFrequently: true });
        bc.filter = "blur(" + Math.max(1.5, th * 0.12).toFixed(1) + "px)";
        bc.drawImage(cv, 0, 0);
        const blur = bc.getImageData(0, 0, w, h).data;
        const mean = cnt ? sum / cnt : 0;
        const sd = cnt ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) : 0;
        const grain = Math.min(4, Math.max(1, sd * 0.15));

        const out = c.createImageData(w, h);
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                const i = yy * w + xx;
                let tr, tg, tb;
                const sy = yy - lift, j = sy * w + xx;
                if (sy >= 0 && known[j]) {
                    // 결을 빌려 올 자리가 피부일 때만. 너무 센 결(머리카락 등)은 깎는다.
                    tr = src.data[j * 4] - blur[j * 4];
                    tg = src.data[j * 4 + 1] - blur[j * 4 + 1];
                    tb = src.data[j * 4 + 2] - blur[j * 4 + 2];
                    const mag = Math.max(Math.abs(tr), Math.abs(tg), Math.abs(tb));
                    if (mag > 18) { const s = 18 / mag; tr *= s; tg *= s; tb *= s; }
                } else {
                    tr = tg = tb = noise(i + x * 7 + y * 13) * grain * 2;
                }
                out.data[i * 4]     = filled[i * 3] + tr;
                out.data[i * 4 + 1] = filled[i * 3 + 1] + tg;
                out.data[i * 4 + 2] = filled[i * 3 + 2] + tb;
                out.data[i * 4 + 3] = soft[i * 4 + 3];
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
                const piece = eraseOne(img, W, H, pts, scale || 1);
                if (piece) res.push(piece);
            } catch (e) {
                console.warn("눈썹 지우기 실패", side, e);
            }
        });
        return res;
    }

    window.BrowErase = { build: build };
})();
