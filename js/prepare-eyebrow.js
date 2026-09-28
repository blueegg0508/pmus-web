/**
 * prepare-eyebrow.js
 * =========================================================================
 * app.py 가 파이썬(PIL/numpy)으로 하던 눈썹 전처리를 Canvas 로 1:1 재현합니다.
 *
 *   tint_eyebrow_image()  →  tintEyebrow()      (luma 계수까지 동일)
 *   Image.resize()        →  resizeTo()
 *   Image.rotate(expand)  →  rotateExpand()     (PIL 은 CCW, Canvas 는 CW → 부호 반전)
 *   ImageOps.mirror()     →  mirror()
 *   apply_opacity()       →  applyOpacity()
 *
 * brow-canvas.js 는 회전/불투명도 델타를 0에서 시작하고 크기를 받은 이미지
 * 기준으로 재므로, 여기서 데스크톱판과 똑같이 미리 구워서 넘겨야 합니다.
 * =========================================================================
 */

/**
 * 다 쓴 캔버스의 뒤쪽 버퍼를 바로 반납한다.
 * 그냥 참조를 놓아도 언젠가는 회수되지만, 저사양 기기에서는 그 '언젠가' 를
 * 기다리다 다음 할당이 먼저 터진다. 크기를 0 으로 만들면 즉시 풀린다.
 */
function releaseCanvas(c) {
    if (c && c.width) { c.width = 0; c.height = 0; }
}

/** 마지막으로 만들려 한 판의 크기. 실패했을 때 무엇이 문제였는지 알려준다. */
export let lastCanvasRequest = { w: 0, h: 0 };

function newCanvas(w, h) {
    lastCanvasRequest = { w: Math.round(w) || 0, h: Math.round(h) || 0 };
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w) || 1);
    c.height = Math.max(1, Math.round(h) || 1);
    // willReadFrequently: 이 판들은 곧 픽셀을 되읽는다. 이 표시가 없으면
    // 브라우저가 판을 GPU 에 두고, 되읽을 때마다 GPU→CPU 로 옮겨 온다.
    // 얼굴 인식이 GPU 를 쓰고 있는 기기(갤럭시 S25 엣지)에서 바로 그 옮기기가
    // 실패해 'Out of memory at ImageData creation' 이 났다.
    // CPU 쪽에 두면 옮길 일이 없다.
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return { c, ctx };
}

export function hexToRgb(hex) {
    const s = String(hex || "").replace("#", "");
    if (s.length !== 6) return { r: 61, g: 43, b: 31 };   // 파이썬 기본값과 동일
    return {
        r: parseInt(s.slice(0, 2), 16),
        g: parseInt(s.slice(2, 4), 16),
        b: parseInt(s.slice(4, 6), 16),
    };
}

/* ── 결이 살아나게 색 입히기 ────────────────────────────────────────────
 *
 * 디자인 원본은 **밝기로 획과 톤을 구분한다.** 어두운 획, 그보다 밝은 음영.
 * (실제로 재어 보면 세미아치 콤보는 밝기 0.09~0.69 로 넓게 퍼져 있다)
 *
 * 예전에는 밝기를 색의 진하기로만 옮기고(0.6~1.0 배) 투명도는 원본 그대로
 * 두었다. 그래서 획이든 음영이든 같은 진하기로 얹혀 한 덩어리가 되고
 * 결이 뭉개졌다.
 *
 * 이제 밝기를 **투명도로도** 옮긴다. 어두운 획은 진하게 남고, 밝은 음영은
 * 옅어진다. 결이 음영 위로 떠올라 선이 또렷해진다.
 * ------------------------------------------------------------------- */

/** 톤(음영)이 최소한 남을 진하기. 0 이면 음영이 아예 사라져 획만 남는다.
 *  0.16 이었을 때 원장님이 "에셋 눈썹이 너무 옅다"고 해서 올렸다 (2026-09-25). */
const TONE_FLOOR = 0.5;
/** 클수록 음영이 더 옅어지고 획만 도드라진다. 1 이면 밝기 그대로 옅어진다. */
const TONE_GAMMA = 1.0;
/** 획 전체를 한 번 더 진하게. 내추럴처럼 털이 가는 디자인은 원본 자체가 반투명이라
 *  위 두 값만으로는 얼굴 위에서 거의 안 보였다. 1 이면 원본 그대로. */
const INK_GAIN = 1.3;
/** 색 자체의 진하기 차이. 투명도가 일을 하므로 예전(0.4)보다 약하게 둔다. */
const COLOR_DEPTH = 0.22;

/** Python tint_eyebrow_image() 대응. 알파와 질감은 보존하고 색만 입힙니다. */
export function tintEyebrow(src, hexColor, intensity = 1.0) {
    const { c, ctx } = newCanvas(src.width, src.height);
    ctx.drawImage(src, 0, 0);

    const { r: tr, g: tg, b: tb } = hexToRgb(hexColor);
    let imgData;
    try {
        imgData = ctx.getImageData(0, 0, c.width, c.height);
    } catch (e) {
        // 이 기기에서 판을 읽지 못한다. 픽셀을 안 만지는 방식으로 색을 입힌다.
        // 밝기에 따른 결 살리기는 못 하지만, 고른 색은 그대로 나온다.
        console.warn("눈썹 색을 합성 방식으로 입힙니다", c.width + "×" + c.height, e);
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = hexColor;
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.globalCompositeOperation = "source-over";
        return c;
    }
    const d = imgData.data;

    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const luma = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255.0;
        const ink = 1.0 - luma;                       // 0 = 밝은 음영, 1 = 짙은 획

        const f = (1.0 - COLOR_DEPTH) + COLOR_DEPTH * ink;
        d[i]     = Math.min(255, Math.max(0, tr * f * intensity));
        d[i + 1] = Math.min(255, Math.max(0, tg * f * intensity));
        d[i + 2] = Math.min(255, Math.max(0, tb * f * intensity));

        // 밝을수록 옅게 — 음영은 물러나고 획이 앞으로 나온다
        const keep = TONE_FLOOR + (1.0 - TONE_FLOOR) * Math.pow(ink, TONE_GAMMA);
        d[i + 3] = Math.min(255, Math.round(d[i + 3] * keep * INK_GAIN));
    }
    ctx.putImageData(imgData, 0, 0);
    return c;
}

/**
 * 줄이고 난 뒤 흐려진 획의 날을 세운다 (언샤프 마스크).
 *
 * 디자인 원본은 500px 인데 얼굴 위에서는 300px 안팎으로 줄어든다. 1px 굵기
 * 획은 그 과정에서 이웃 화소로 번져 뭉툭해진다. 번진 만큼을 되돌려 준다.
 * 색이 아니라 **투명도에만** 건다. 색을 건드리면 획 둘레에 테가 생긴다.
 *
 * @param amount 0 이면 그대로, 1 이면 꽤 날카롭게
 */
export function sharpenAlpha(src, amount = 0.55) {
    if (!amount || src.width < 8 || src.height < 8) return src;

    let c, ctx, img;
    try {
        ({ c, ctx } = newCanvas(src.width, src.height));
        ctx.drawImage(src, 0, 0);
        img = ctx.getImageData(0, 0, c.width, c.height);
    } catch (e) {
        // 날을 못 세워도 그림은 그대로 쓴다
        console.warn("획 날 세우기를 건너뜁니다", src.width + "×" + src.height, e);
        if (c) releaseCanvas(c);
        return src;
    }
    const d = img.data;
    const W = c.width, H = c.height;

    // 원본 알파를 따로 떠 둔다 (제자리에서 고치면 옆 화소 계산이 오염된다)
    const a0 = new Uint8ClampedArray(W * H);
    for (let i = 0, p = 3; i < a0.length; i++, p += 4) a0[i] = d[p];

    for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            // 3×3 평균 = 흐린 판
            const blur = (
                a0[i - W - 1] + a0[i - W] + a0[i - W + 1] +
                a0[i - 1]     + a0[i]     + a0[i + 1] +
                a0[i + W - 1] + a0[i + W] + a0[i + W + 1]
            ) / 9;
            const v = a0[i] + (a0[i] - blur) * amount;
            d[i * 4 + 3] = v < 0 ? 0 : (v > 255 ? 255 : v);
        }
    }
    ctx.putImageData(img, 0, 0);
    return c;
}

export function resizeTo(src, w, h) {
    const { c, ctx } = newCanvas(w, h);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
}

export function mirror(src) {
    const { c, ctx } = newCanvas(src.width, src.height);
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(src, 0, 0);
    return c;
}

/**
 * Python Image.rotate(angle, expand=True) 대응.
 * PIL 은 양수 각도가 반시계, Canvas 는 시계 방향이라 부호를 뒤집습니다.
 */
export function rotateExpand(src, angleDeg) {
    if (!angleDeg) return src;
    const rad = (angleDeg * Math.PI) / 180.0;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const nw = src.width * cos + src.height * sin;
    const nh = src.width * sin + src.height * cos;

    const { c, ctx } = newCanvas(nw, nh);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(-rad);                       // ← PIL(CCW) → Canvas(CW) 보정
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
}

/** Python apply_opacity() 대응. 알파 채널만 비례 축소. */
export function applyOpacity(src, opacityPct) {
    const factor = Math.max(0, Math.min(1, opacityPct / 100.0));
    if (factor >= 1.0) return src;

    // 픽셀을 하나하나 고칠 필요가 없다. 그릴 때 globalAlpha 를 걸면 같은 결과다.
    // 되읽기가 없으니 이 단계에서는 메모리가 터질 일도 없다.
    const { c, ctx } = newCanvas(src.width, src.height);
    ctx.globalAlpha = factor;
    ctx.drawImage(src, 0, 0);
    ctx.globalAlpha = 1;
    return c;
}

/**
 * 디자인 그림에서 실제로 칠해진 가로 범위 (0~1). 그림 양옆에는 빈 여백이 있어서
 * 그림 폭을 그대로 눈썹 길이로 보면 앞머리·꼬리 자리가 어긋난다.
 */
function visibleSpan(img) {
    try {
        const W = Math.min(300, img.width), H = Math.max(1, Math.round(img.height * W / img.width));
        const { c, ctx } = newCanvas(W, H);
        ctx.drawImage(img, 0, 0, W, H);
        const d = ctx.getImageData(0, 0, W, H).data;
        let x0 = W, x1 = -1;
        for (let x = 0; x < W; x++) {
            for (let y = 0; y < H; y++) {
                if (d[(y * W + x) * 4 + 3] > 24) { if (x < x0) x0 = x; x1 = x; break; }
            }
        }
        releaseCanvas(c);
        if (x1 <= x0) return { f0: 0, f1: 1 };
        return { f0: x0 / W, f1: (x1 + 1) / W };
    } catch (e) {
        return { f0: 0, f1: 1 };
    }
}

/**
 * 앞머리가 앞눈꼬리 세로선에서 시작하도록 길이와 자리를 다시 잡는다.
 *
 * 꼬리는 '잰 눈썹 자리에 잰 길이로 얹었을 때'의 자리를 그대로 지킨다. 앞머리만
 * 앞눈꼬리(face-detect 의 brows.*.nose, 133/362)까지 당기고, 그 사이에 맞게 폭을 정한다.
 * 좌우는 두 앞눈꼬리의 가운데를 기준으로 대칭이 되게 한다.
 * 디자인 그림은 왼쪽 눈썹 기준이라 앞머리가 그림의 오른쪽 끝이다.
 *
 * @returns {{ w, uL, uR, ux, uy, mx, my }} w = 새 그림 폭, uL·uR = 눈 선 방향으로 잰 중심 자리
 */
function fitHeadToNose(browImg, brows, eyes, w0, gap) {
    const rad = Math.atan2(eyes.right.y - eyes.left.y, eyes.right.x - eyes.left.x);
    const ux = Math.cos(rad), uy = Math.sin(rad);
    const mx = (brows.left.cx + brows.right.cx) / 2.0;
    const my = (brows.left.cy + brows.right.cy) / 2.0;
    const u = (x, y) => (x - mx) * ux + (y - my) * uy;

    const nL = u(brows.left.nose.x, brows.left.nose.y);
    const nR = u(brows.right.nose.x, brows.right.nose.y);
    if (!(nR > nL)) return null;
    const m = (nL + nR) / 2.0;
    const headDist = (nR - nL) / 2.0 + (gap || 0);

    const { f0, f1 } = visibleSpan(browImg);
    const vis = f1 - f0;
    if (!(vis > 0.2)) return null;
    // 지금 방식대로 얹었을 때의 꼬리 자리
    const tailL = u(brows.left.cx, brows.left.cy) - (0.5 - f0) * w0;
    const tailR = u(brows.right.cx, brows.right.cy) + (0.5 - f0) * w0;
    const tailDist = ((m - tailL) + (tailR - m)) / 2.0;

    const len = tailDist - headDist;
    // 앞눈꼬리가 꼬리보다 바깥이면(인식이 어긋남) 손대지 않는다
    if (!(len > w0 * vis * 0.5) || !(len < w0 * vis * 2.0)) return null;
    const w = len / vis;
    return {
        w,
        uL: m - tailDist + (0.5 - f0) * w,
        uR: m + tailDist - (0.5 - f0) * w,
        ux, uy, mx, my,
    };
}

/**
 * 데스크톱판 render_interactive_drag_canvas() 의 파이썬 전처리 전체를 재현해
 * brow-canvas.js 가 기대하는 CFG 값 묶음을 만들어 돌려줍니다.
 *
 * @param {HTMLImageElement} browImg   눈썹 레퍼런스 PNG
 * @param {number} imgW, imgH          고객 사진 크기
 * @param {object|null} eyes           detectEyeCenters() 결과
 * @param {object} settings            데스크톱판 settings 와 동일 키
 */
export function buildEyebrowConfig(browImg, imgW, imgH, eyes, settings = {}) {
    // eyes 는 아래에서 검증한 뒤 다시 담는다 (이상하면 null)
    let brows;   // 아래에서 검증한 뒤 채운다
    const g = (k, d) => (settings[k] !== undefined ? settings[k] : d);

    const colorHex  = g("color_hex", "#3D2B1F");
    const intensity = g("intensity", 1.0);
    const scalePct  = g("overall_scale", 100);
    const widthPct  = g("width_scale", 100);
    const heightPct = g("height_scale", 100);
    const vert      = g("vert_pos", 0);
    const horiz     = g("horiz_pos", 0);
    const spacing   = g("brow_spacing", 0);
    // 투명도는 편집 화면의 조절바 하나가 맡는다. 여기서도 85% 를 미리 입히면
    // 조절바 값과 곱해져 두 번 옅어지고, 조절바를 100 으로 올려도 85% 가 끝이었다.
    const opacity   = g("opacity", 100);
    const baseRot   = g("rotation", 0.0);

    // 실제로 검출한 눈썹 자리. 있으면 여기에 맞춰 얹는다. (퀵 모드)
    brows = g("brows", null);
    // 반영구는 원래 눈썹을 덮으면서 꼬리를 조금 더 빼는 것이 보통이라
    // 검출한 길이보다 살짝 길게 잡는다.
    const browCover = g("brow_cover", 1.1);

    // ── 크기 계산 ──
    // 원본(app.py)은 눈썹 너비를 '이미지 너비 × 0.352' 로 잡는다. 이는 얼굴이
    // 화면을 꽉 채운 크롭 사진을 전제한 값이라, 폰으로 찍은 상반신 사진에서는
    // 눈썹이 얼굴보다 커지고 좌우로 크게 벌어진다.
    // 얼굴이 인식되면 눈 사이 거리(IPD)를 기준으로 잡아 사진 구도와 무관하게
    // 같은 결과가 나오게 한다. 꽉 찬 크롭에서는 두 값이 거의 같아 기존 동작이 유지된다.
    // 눈썹을 직접 재어 두었으면 그 길이가 가장 정확하다. 눈 사이 거리 기준은
    // '눈에서 얼마쯤 위·얼마쯤 길게' 라는 평균값이라, 눈썹이 원래 짧거나 긴
    // 사람에게서는 눈에 띄게 어긋난다.
    /**
     * 잰 값이 말이 되는지 본다.
     * 인식이 어긋나 눈썹 폭이 터무니없이 나오면 그 값으로 판을 만들다
     * 메모리가 터진다. 실제로 'Out of memory at ImageData creation' 이
     * 그렇게 났다 — 힙은 13MB 밖에 안 썼는데 판 하나를 못 만들었다.
     * 눈썹은 사진 폭의 5~60% 안에 있다. 벗어나면 안 믿는다.
     */
    const sane = (v) => typeof v === "number" && isFinite(v) && v > 0;
    const usableBrows = brows
        && sane(brows.left.width) && sane(brows.right.width)
        && sane(brows.left.cx) && sane(brows.right.cx)
        && sane(brows.left.cy) && sane(brows.right.cy)
        && brows.left.width > imgW * 0.05 && brows.left.width < imgW * 0.6
        && brows.right.width > imgW * 0.05 && brows.right.width < imgW * 0.6
        && brows.left.cx > -imgW * 0.2 && brows.left.cx < imgW * 1.2
        && brows.right.cx > -imgW * 0.2 && brows.right.cx < imgW * 1.2
        && brows.left.cy > -imgH * 0.2 && brows.left.cy < imgH * 1.2
        && brows.right.cy > -imgH * 0.2 && brows.right.cy < imgH * 1.2
        ? brows : null;
    if (brows && !usableBrows) {
        console.warn("눈썹 검출값이 이상해 눈 위치로 대신합니다", brows);
    }
    brows = usableBrows;

    /**
     * 눈 좌표도 사진 안에 있을 때만 쓴다.
     *
     * 갤럭시 S25 엣지에서 인식 엔진이 정규화 좌표를 219, -54 같은 값으로
     * 돌려준 적이 있다. 그 눈 자리로 계산하면 눈썹이 사진 밖 23만 픽셀
     * 지점에 놓여, 오류 한 줄 없이 눈썹만 안 보였다.
     */
    const inFrame = (p) => p && typeof p.x === "number" && typeof p.y === "number"
        && isFinite(p.x) && isFinite(p.y)
        && p.x > -imgW * 0.2 && p.x < imgW * 1.2
        && p.y > -imgH * 0.2 && p.y < imgH * 1.2;

    const rawEyeDist = eyes
        ? Math.hypot(eyes.right.x - eyes.left.x, eyes.right.y - eyes.left.y) : 0;
    const usableEyes = eyes && inFrame(eyes.left) && inFrame(eyes.right)
        && rawEyeDist > imgW * 0.04 && rawEyeDist < imgW * 0.95 ? eyes : null;
    if (eyes && !usableEyes) console.warn("눈 좌표가 이상해 무시합니다", eyes);
    eyes = usableEyes;

    const eyeDist = eyes ? rawEyeDist : 0;
    const measuredW = brows ? (brows.left.width + brows.right.width) / 2 * browCover : 0;
    let baseBrowW = measuredW || (eyes ? eyeDist * 1.03 : imgW * 0.352);
    // 굵기는 원래 눈썹 길이 기준 그대로 둔다. 앞머리를 앞눈꼬리에 맞추면 길이가
    // 늘어나는데, 굵기까지 같은 비율로 불면 디자인이 뭉툭해진다.
    let thickBaseW = baseBrowW;

    // ── 앞머리를 앞눈꼬리 세로선에 맞춘다 ──
    // 원래 눈썹 앞머리는 성기거나 멀리 떨어진 사람이 많아, 잰 눈썹 자리를 그대로
    // 따르면 미간이 너무 넓게 시작한다 (2026-09-25 원장님). 꼬리는 지금 자리를
    // 지키고, 앞머리만 앞눈꼬리 세로선에 맞춰 그 사이에 맞게 길이를 정한다.
    const noseFit = brows && eyes && brows.left.nose && brows.right.nose
        ? fitHeadToNose(browImg, brows, eyes, baseBrowW, g("head_gap", 0))
        : null;
    if (noseFit) baseBrowW = noseFit.w;
    // 위쪽에서 걸렀어도 조절바(전체 크기·기장)를 크게 올리면 또 커진다.
    // 눈썹 한쪽이 사진보다 클 수는 없으니 거기서 자른다.
    const rawW = baseBrowW * (scalePct / 100) * (widthPct / 100);
    const targetW = Math.max(10, Math.min(imgW, Math.floor(sane(rawW) ? rawW : imgW * 0.35)));
    const aspect = browImg.width > 0 ? browImg.height / browImg.width : 0.35;
    const rawH = targetW * aspect * (heightPct / 100) * (thickBaseW / baseBrowW);
    const targetH = Math.max(5, Math.min(imgH, Math.floor(sane(rawH) ? rawH : targetW * 0.35)));

    // ── 위치 계산 ──
    let leftX, leftY, rightX, rightY, tiltDeg;
    if (brows) {
        // 기울기는 고개가 돌아간 정도(눈 선)를 쓴다. 눈썹 하나하나의 각도는
        // 디자인이 이미 품고 있어서, 거기에 또 얹으면 꼬리가 과하게 들린다.
        tiltDeg = eyes
            ? (Math.atan2(eyes.right.y - eyes.left.y, eyes.right.x - eyes.left.x) * 180) / Math.PI
            : 0.0;

        // 검출한 눈썹 자리에 얹되 **좌우 높이는 맞춘다.**
        //
        // 사람의 두 눈썹은 원래 높이가 조금씩 다르다. 검출한 높이에 그대로
        // 얹으면 그 차이를 디자인이 그대로 물려받아, 좌우가 거울상이 아니게
        // 보인다. 반영구는 그 어긋남을 잡아 주는 시술이라 시작은 나란해야 한다.
        //
        // 그냥 y 를 평균 내면 고개가 기울어졌을 때 눈썹이 얼굴과 따로 논다.
        // 그래서 눈 선을 가로축으로 삼은 좌표계에서 '높이' 만 평균 낸다.
        // 좌우 자리(가로축 방향)는 검출한 그대로 둔다.
        const rad = (tiltDeg * Math.PI) / 180.0;
        const ux = Math.cos(rad), uy = Math.sin(rad);   // 눈 선 방향
        const vx = -uy, vy = ux;                        // 그 수직 = 높이 방향
        const mx = (brows.left.cx + brows.right.cx) / 2.0;
        const my = (brows.left.cy + brows.right.cy) / 2.0;
        const uOf = (p) => (p.cx - mx) * ux + (p.cy - my) * uy;
        const vOf = (p) => (p.cx - mx) * vx + (p.cy - my) * vy;
        const vAvg = (vOf(brows.left) + vOf(brows.right)) / 2.0;
        const put = (u) => ({ x: mx + u * ux + vAvg * vx, y: my + u * uy + vAvg * vy });

        // 앞머리를 앞눈꼬리에 맞췄으면 그 자리로. 조절바로 크기를 바꿨으면 그만큼
        // 가운데를 기준으로 늘거나 준다 (끌어 옮기면 되니 자리까지 다시 맞추지 않는다).
        const PL = noseFit ? put(noseFit.uL) : put(uOf(brows.left));
        const PR = noseFit ? put(noseFit.uR) : put(uOf(brows.right));
        leftX  = PL.x + horiz - spacing / 2.0;
        leftY  = PL.y + vert + g("left_y_offset", 0);
        rightX = PR.x + horiz + spacing / 2.0;
        rightY = PR.y + vert + g("right_y_offset", 0);
    } else if (eyes) {
        const { left: L, right: R } = eyes;
        const midX = (L.x + R.x) / 2.0;

        // 미간 간격도 눈 사이 거리 기준으로만 잡는다.
        // (원본의 imgW * 0.04 하한은 넓게 찍은 사진에서 미간을 과도하게 벌린다)
        const initialGap = eyeDist * 0.155;
        const baseCenterDist = targetW + initialGap;

        leftX  = midX - baseCenterDist / 2.0 + horiz - spacing / 2.0;
        leftY  = L.y - eyeDist * 0.42 + vert + g("left_y_offset", 0);
        rightX = midX + baseCenterDist / 2.0 + horiz + spacing / 2.0;
        rightY = R.y - eyeDist * 0.42 + vert + g("right_y_offset", 0);
        tiltDeg = (Math.atan2(R.y - L.y, R.x - L.x) * 180) / Math.PI;
    } else {
        const cx = imgW / 2.0 + horiz;
        const cy = imgH * 0.36 + vert;
        const initialGap = imgW * 0.05;
        const baseCenterDist = targetW + initialGap;

        leftX  = cx - baseCenterDist / 2.0 - spacing / 2.0;
        leftY  = cy + g("left_y_offset", 0);
        rightX = cx + baseCenterDist / 2.0 + spacing / 2.0;
        rightY = cy + g("right_y_offset", 0);
        tiltDeg = 0.0;
    }

    /**
     * 마지막 방어선.
     *
     * 위에서 무엇을 걸러 냈든, 여기까지 온 자리가 사진 밖이면 눈썹은
     * 안 보인다. 원장님 눈에는 그냥 '앱이 고장난 것' 이다. 그럴 바에는
     * 가운데에라도 놓는다 — 보이기만 하면 끌어서 맞출 수 있다.
     */
    const num = (v) => typeof v === "number" && isFinite(v);
    const okX = (v) => num(v) && v > -imgW * 0.3 && v < imgW * 1.3;
    const okY = (v) => num(v) && v > -imgH * 0.3 && v < imgH * 1.3;
    if (!okX(leftX) || !okX(rightX) || !okY(leftY) || !okY(rightY)) {
        console.warn("눈썹 자리가 사진 밖이라 가운데로 되돌립니다",
                     { leftX, leftY, rightX, rightY, imgW, imgH });
        const cx = imgW / 2.0 + horiz;
        const cy = imgH * 0.36 + vert;
        const baseCenterDist = targetW + imgW * 0.05;
        leftX  = cx - baseCenterDist / 2.0 - spacing / 2.0;
        leftY  = cy + g("left_y_offset", 0);
        rightX = cx + baseCenterDist / 2.0 + spacing / 2.0;
        rightY = cy + g("right_y_offset", 0);
        tiltDeg = 0.0;
    }

    // ── 이미지 파이프라인 (틴트 → 리사이즈 → 미러/회전 → 불투명도) ──
    const tinted = tintEyebrow(browImg, colorHex, intensity);
    const scaled = resizeTo(tinted, targetW, targetH);
    releaseCanvas(tinted);                 // 색만 입힌 원본 크기 판은 이제 필요 없다
    // 줄이면서 번진 획의 날을 세운다
    const resized = sharpenAlpha(scaled, g("sharpen", 0.55));
    if (resized !== scaled) releaseCanvas(scaled);

    const leftRot  =  baseRot + tiltDeg + g("left_rot_offset", 0.0);
    const rightRot = -baseRot + tiltDeg + g("right_rot_offset", 0.0);

    // 한 쪽씩 만들어 dataURL 로 굽고 바로 반납한다.
    // 좌·우 두 벌을 동시에 들고 있지 않으려는 것이다.
    // rotateExpand·applyOpacity 는 할 일이 없으면 **받은 캔버스를 그대로 돌려준다.**
    // 그래서 '중간 결과' 라고 넘겨짚고 반납하면 아직 쓸 캔버스를 크기 0 으로
    // 만들어 버린다. 얼굴을 못 찾으면 기울기가 0 이라 회전을 건너뛰고,
    // 그 길로 resized 가 반납되어 오른쪽 눈썹을 만들 때 터졌다.
    //   Failed to execute 'drawImage' … width or height of 0
    // 아직 쓸 것(resized)과 같은 캔버스인지 하나하나 확인하고 반납한다.
    const drop = (c) => { if (c && c !== resized) releaseCanvas(c); };

    /**
     * 판을 그림 문자열로 굽는다.
     *
     * toDataURL 은 실패해도 예외를 던지지 않고 "data:," 를 돌려주는 기기가
     * 있다. 그걸 그대로 넘기면 편집 화면에서 img 가 조용히 실패해서,
     * 오류 한 줄 없이 눈썹만 감쪽같이 사라진다. 여기서 붙잡아 제대로 알린다.
     */
    const bake = (c, what) => {
        let url = "";
        try { url = c.toDataURL("image/png"); } catch (e) { url = ""; }
        if (!url || url.length < 128 || url.indexOf("data:image/png") !== 0) {
            throw new Error(what + " 굽기 실패 (판 " + c.width + "×" + c.height
                            + ", 결과 " + (url ? url.length + "자" : "빈 값") + ")");
        }
        return url;
    };

    const leftRotated = rotateExpand(resized, leftRot);
    const leftBrow = applyOpacity(leftRotated, opacity);
    const l_b64 = bake(leftBrow, "왼쪽 눈썹");
    if (leftRotated !== leftBrow) drop(leftRotated);
    drop(leftBrow);

    const mirrored = mirror(resized);
    const rightRotated = rotateExpand(mirrored, rightRot);
    if (rightRotated !== mirrored) drop(mirrored);
    const rightBrow = applyOpacity(rightRotated, opacity);
    const r_b64 = bake(rightBrow, "오른쪽 눈썹");
    if (rightRotated !== rightBrow) drop(rightRotated);
    drop(rightBrow);
    releaseCanvas(resized);

    const { r, g: gg, b } = hexToRgb(colorHex);

    return {
        bg_b64: null,                     // 호출부에서 고객 사진 dataURL 주입
        l_b64,
        r_b64,
        img_w: imgW,
        img_h: imgH,
        left_center_x: leftX,
        left_center_y: leftY,
        right_center_x: rightX,
        right_center_y: rightY,
        cur_hex: colorHex.toUpperCase(),
        cur_r: r,
        cur_g: gg,
        cur_b: b,
        safe_design_name: g("design_name", "눈썹 디자인"),
    };
}
