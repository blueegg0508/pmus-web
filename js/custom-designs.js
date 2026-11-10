/**
 * custom-designs.js — 원장님이 직접 등록한 눈썹 디자인 보관소
 * =========================================================================
 * 기본 제공 디자인(assets/eyebrow_refs/*.png) 말고 각자 쓰던 고유 디자인을
 * 등록해서 쓸 수 있게 한다.
 *
 * 저장은 IndexedDB 를 쓴다. 디자인 한 장이 수백 KB 라 localStorage(5MB,
 * 동기 방식)로는 금방 막히고, Preferences 플러그인도 이런 크기를 담는
 * 자리가 아니다. IndexedDB 는 앱을 지우기 전까지 남는다.
 *
 * 등록 전에 하는 일:
 *   1. 투명 PNG 면 그대로 쓴다
 *   2. 종이에 그린 디자인을 찍은 사진(JPG, 배경이 꽉 찬 PNG)이면 종이를 지워
 *      투명 이미지로 바꾼다 — photoToTransparent() (2026-10-10 원장님 요청)
 *   3. 투명 여백 잘라내기      — 기본 디자인처럼 딱 맞게 잘라야 같은 크기로 얹힌다
 *
 * 기본 디자인은 '왼쪽 눈썹' 한 장이고 오른쪽은 좌우 반전해서 만든다.
 * 등록 화면에서 미리보기와 좌우 뒤집기를 두는 이유다.
 * =========================================================================
 */

import { resizeTo } from "./prepare-eyebrow.js?v=162";

const DB_NAME = "browlist";
const DB_VERSION = 1;
const STORE = "customDesigns";

/** 잘라낸 뒤 저장할 최대 크기 (긴 변 기준). 기본 디자인이 500px 라 넉넉하다. */
const MAX_EDGE = 1200;

/** 알파가 이 값보다 크면 '그림이 있다'고 본다. (JPG→PNG 변환 잡티 무시) */
const ALPHA_FLOOR = 8;

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: "id" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("저장소를 열 수 없습니다"));
    });
    return dbPromise;
}

function tx(mode, run) {
    return openDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const t = db.transaction(STORE, mode);
                const store = t.objectStore(STORE);
                let out;
                try {
                    out = run(store);
                } catch (e) {
                    reject(e);
                    return;
                }
                t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
                t.onerror = () => reject(t.error || new Error("저장소 오류"));
                t.onabort = () => reject(t.error || new Error("저장이 취소되었습니다"));
            })
    );
}

/** 등록된 디자인 전체. 등록한 순서대로 돌려준다. */
export async function list() {
    const rows = await tx("readonly", (s) => s.getAll());
    return (rows || []).sort((a, b) => a.createdAt - b.createdAt);
}

export function get(id) {
    return tx("readonly", (s) => s.get(id));
}

export function remove(id) {
    return tx("readwrite", (s) => s.delete(id));
}

export function save(design) {
    return tx("readwrite", (s) => s.put(design));
}

/** 화면에 보여줄 만한 기본 이름을 파일명에서 뽑는다. */
export function labelFromFilename(name) {
    return String(name || "")
        .replace(/\.[^.]+$/, "")
        .replace(/[_-]+/g, " ")
        .trim()
        .slice(0, 24) || "내 디자인";
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("이미지를 읽지 못했습니다"));
        img.src = src;
    });
}

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error("파일을 읽지 못했습니다"));
        fr.readAsDataURL(file);
    });
}

/**
 * 고른 파일이 쓸 수 있는 디자인인지 확인하고, 투명 여백을 잘라 돌려준다.
 *
 * @returns {{dataUrl:string, width:number, height:number}}
 * @throws  사용자에게 그대로 보여줄 수 있는 한글 메시지를 담은 Error
 */
export async function prepare(file, { flip = false } = {}) {
    if (!file) throw new Error("파일을 선택해 주세요.");

    // ── 1. PNG 인지 (확장자가 아니라 실제 파일 머리글로 판단) ──
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const isPng = head.length >= 8 && PNG_MAGIC.every((b, i) => head[i] === b);

    const img = await loadImage(await readAsDataUrl(file));
    if (img.width < 40 || img.height < 20) {
        throw new Error("이미지가 너무 작습니다. 가로 400px 이상을 권장합니다.");
    }
    if (img.width > 6000 || img.height > 6000) {
        throw new Error("이미지가 너무 큽니다. 가로 2000px 이하로 줄여서 등록해 주세요.");
    }

    let src = document.createElement("canvas");
    src.width = img.width;
    src.height = img.height;
    src.getContext("2d").drawImage(img, 0, 0);

    // 사진이면(또는 배경이 꽉 찬 PNG 면) 종이를 지워 투명하게 만든다
    let fromPhoto = !isPng || isFullyOpaque(src);
    let fromSkin = false;
    if (fromPhoto) {
        src = photoToTransparent(src);
        fromSkin = !!src.fromSkin;
    }

    let data;
    try {
        data = src.getContext("2d").getImageData(0, 0, src.width, src.height).data;
    } catch (e) {
        throw new Error("이미지를 분석하지 못했습니다.");
    }

    // ── 2. 투명 영역이 있는지 + 그림이 들어 있는 범위 찾기 ──
    let minX = src.width, minY = src.height, maxX = -1, maxY = -1;
    let opaque = 0;
    for (let y = 0; y < src.height; y++) {
        for (let x = 0; x < src.width; x++) {
            const a = data[(y * src.width + x) * 4 + 3];
            if (a === 255) opaque++;
            if (a > ALPHA_FLOOR) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < 0) {
        throw new Error(fromPhoto
            ? "사진에서 눈썹을 찾지 못했습니다. 흰 종이에 진하게 그린 눈썹이나, 시술을 마친 눈썹을 밝은 곳에서 정면으로 가까이 찍어 주세요."
            : "이미지가 전부 투명합니다. 눈썹이 그려진 PNG 를 선택해 주세요.");
    }

    // ── 3. 투명 여백 잘라내기 (기본 디자인처럼 딱 맞게) ──
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    let outW = cropW, outH = cropH;
    const longest = Math.max(cropW, cropH);
    if (longest > MAX_EDGE) {
        const k = MAX_EDGE / longest;
        outW = Math.max(1, Math.round(cropW * k));
        outH = Math.max(1, Math.round(cropH * k));
    }

    // 먼저 원래 크기로 잘라 낸 뒤, 줄이기는 직접 한다 — 일부 아이패드의 고품질 축소가
    // 투명한 그림을 세로 줄무늬로 만들었다 (prepare-eyebrow.js resizeTo 참고, 2026-10-19).
    const crop = document.createElement("canvas");
    crop.width = cropW; crop.height = cropH;
    crop.getContext("2d").drawImage(src, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
    const small = (outW !== cropW || outH !== cropH) ? resizeTo(crop, outW, outH) : crop;
    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    if (flip) {                       // 오른쪽 눈썹을 올린 경우 뒤집어 왼쪽으로 맞춘다 (크기는 그대로라 다시 줄이지 않는다)
        ctx.translate(outW, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(small, 0, 0);
    if (small !== crop) { small.width = 0; small.height = 0; }
    crop.width = 0; crop.height = 0;

    return { dataUrl: out.toDataURL("image/png"), width: outW, height: outH, fromPhoto, fromSkin };
}

/** 모든 점이 불투명한가 (배경을 지우지 않은 PNG) — 크게 보지 않고 듬성듬성 살핀다 */
function isFullyOpaque(canvas) {
    const g = canvas.getContext("2d");
    const step = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 60));
    let d;
    try { d = g.getImageData(0, 0, canvas.width, canvas.height).data; } catch (e) { return false; }
    for (let y = 0; y < canvas.height; y += step) {
        for (let x = 0; x < canvas.width; x += step) {
            if (d[(y * canvas.width + x) * 4 + 3] < 250) return false;
        }
    }
    return true;
}

/**
 * 종이에 그린 눈썹 사진 → 투명 배경 이미지.
 *
 *   1. 종이 밝기 지도 — 칸마다 가장 밝은 값을 종이로 보고 부드럽게 잇는다.
 *      그림자·조명 얼룩이 있어도 그 자리 종이보다 어두운 것만 그림이 된다.
 *   2. 종이보다 어두운 정도 = 진하기(알파). 연필의 농담이 그대로 남는다.
 *   3. 잡티 지우기 — 가장 큰 덩어리(눈썹) 근처에 있는 것만 남기고,
 *      사진 가장자리에 닿은 덩어리(종이 끝·책상)는 버린다.
 *   4. 색은 짙은 회갈색으로 통일 — 편집 화면에서 고른 색으로 다시 입힌다.
 */
function photoToTransparent(src) {
    // 피부 사진은 작게 받은 캡처가 많다 (600px 안팎) — 털 한 올이 1~2px 이라 그대로 다루면
    // 결이 뭉개진다. 긴 쪽 1200px 까지 키워 다룬다 (종이인지는 아래에서 다시 본다).
    const skinGuess = looksLikeSkin(src);
    const k = skinGuess
        ? Math.min(2, 1200 / Math.max(src.width, src.height), 1600 / Math.max(src.width, src.height))
        : Math.min(1, 1600 / Math.max(src.width, src.height));
    const W = Math.max(1, Math.round(src.width * k));
    const H = Math.max(1, Math.round(src.height * k));
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = skinGuess ? "high" : "medium";
    g.drawImage(src, 0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    const px = img.data;
    const N = W * H;

    // 밝기
    const L0 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        L0[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    }
    // 종이 결(오돌토돌한 질감 · 점)을 누그러뜨린다 — 가로 · 세로로 한 번씩 고르게 편다.
    // 결이 그대로 남으면 잡티 점이 사진 전체에 깔려 눈썹 무리가 가장자리까지 이어지고,
    // 그 바람에 눈썹이 통째로 빠져 엉뚱한 점 하나만 남았다 (2026-10-15, 원장님 연필 그림).
    const br = Math.max(1, Math.round(Math.max(W, H) / 800));
    const L = new Float32Array(N), tmp = new Float32Array(N);
    for (let y = 0; y < H; y++) {
        let acc = 0, cnt = 0;
        for (let x = -br; x < W; x++) {
            const xa = x + br, xr = x - br - 1;
            if (xa < W) { acc += L0[y * W + xa]; cnt++; }
            if (xr >= 0) { acc -= L0[y * W + xr]; cnt--; }
            if (x >= 0) tmp[y * W + x] = acc / cnt;
        }
    }
    for (let x = 0; x < W; x++) {
        let acc = 0, cnt = 0;
        for (let y = -br; y < H; y++) {
            const ya = y + br, yr = y - br - 1;
            if (ya < H) { acc += tmp[ya * W + x]; cnt++; }
            if (yr >= 0) { acc -= tmp[yr * W + x]; cnt--; }
            if (y >= 0) L[y * W + x] = acc / cnt;
        }
    }

    // 0. 종이인가, 피부인가 (2026-11-02 — 시술을 마친 눈썹 사진으로도 등록하고 싶다는 원장님 요청)
    //    밝은 쪽 점들의 붉은기(R − B)로 본다. 흰 종이는 거의 0, 피부는 뚜렷하게 붉다.
    //    피부 사진은 눈썹이 사진 가장자리까지 차 있고, 바탕(피부)이 종이보다 어둡고 얼룩져 있다.
    const skin = skinGuess;

    // 1. 종이(피부) 밝기 지도
    //    피부는 눈썹이 칸을 통째로 덮을 만큼 굵게 찍히므로 칸을 크게 잡고, 번들거리는
    //    점에 끌려가지 않게 칸에서 가장 밝은 값 대신 상위 10% 밝기를 쓴다.
    const cell = skin ? Math.max(12, Math.round(Math.max(W, H) / 12)) : Math.max(8, Math.round(Math.max(W, H) / 40));
    const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
    let grid = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
            const x1 = Math.min(W, (gx + 1) * cell), y1 = Math.min(H, (gy + 1) * cell);
            if (skin) {
                const vals = [];
                for (let y = gy * cell; y < y1; y++) for (let x = gx * cell; x < x1; x++) vals.push(L[y * W + x]);
                vals.sort((a, b) => a - b);
                grid[gy * gw + gx] = vals.length ? vals[Math.floor((vals.length - 1) * 0.9)] : 0;
                continue;
            }
            let m = 0;
            for (let y = gy * cell; y < y1; y++) {
                for (let x = gx * cell; x < x1; x++) { const v = L[y * W + x]; if (v > m) m = v; }
            }
            grid[gy * gw + gx] = m;
        }
    }
    // 진한 그림이 칸을 다 덮어도 종이 밝기를 잃지 않게: 이웃 칸 중 밝은 값으로 메우고, 고르게 편다
    const pass = (fn) => {
        const out = new Float32Array(gw * gh);
        for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) out[gy * gw + gx] = fn(gx, gy);
        grid = out;
    };
    const at = (gx, gy) => grid[Math.min(gh - 1, Math.max(0, gy)) * gw + Math.min(gw - 1, Math.max(0, gx))];
    for (let r = 0; r < (skin ? 3 : 2); r++) pass((x, y) => Math.max(at(x, y), at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)));
    for (let r = 0; r < (skin ? 3 : 2); r++) pass((x, y) => (at(x - 1, y - 1) + at(x, y - 1) + at(x + 1, y - 1) + at(x - 1, y) + at(x, y) + at(x + 1, y) + at(x - 1, y + 1) + at(x, y + 1) + at(x + 1, y + 1)) / 9);
    const bgAt = (x, y) => {
        const fx = x / cell - 0.5, fy = y / cell - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const a = at(x0, y0), b = at(x0 + 1, y0), cc = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
        return (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
    };

    // 2. 진하기
    const A = new Uint8ClampedArray(N);
    // 종이: 옅은 연필 획도 놓치지 않게. 피부: 모공 · 잡티 · 얼룩은 빼고, 진한 곳이 뭉개진
    // 검은 덩어리가 되지 않게 진하기 폭을 넓힌다 (털 한 올의 농담이 남게).
    const lo = skin ? 0.12 : 0.07, hi = skin ? 0.72 : 0.42;
    // 피부: 결 지도 — 털은 한 올 한 올 밝고 어두움이 번갈아 '결' 이 있고, 눈썹 아래 그늘 ·
    // 피부 얼룩은 매끈하다. 옅은 곳은 결이 있을 때만 남겨, 그늘이 회색 자국으로 묻어 나오지 않게 한다.
    let tex = null;
    if (skin) {
        const box = (srcA, r) => {
            const o = new Float32Array(N), t2 = new Float32Array(N);
            for (let y = 0; y < H; y++) {
                let acc = 0, cnt = 0;
                for (let x = -r; x < W; x++) {
                    const xa = x + r, xr = x - r - 1;
                    if (xa < W) { acc += srcA[y * W + xa]; cnt++; }
                    if (xr >= 0) { acc -= srcA[y * W + xr]; cnt--; }
                    if (x >= 0) t2[y * W + x] = acc / cnt;
                }
            }
            for (let x = 0; x < W; x++) {
                let acc = 0, cnt = 0;
                for (let y = -r; y < H; y++) {
                    const ya = y + r, yr = y - r - 1;
                    if (ya < H) { acc += t2[ya * W + x]; cnt++; }
                    if (yr >= 0) { acc -= t2[yr * W + x]; cnt--; }
                    if (y >= 0) o[y * W + x] = acc / cnt;
                }
            }
            return o;
        };
        const r1 = Math.max(2, Math.round(Math.max(W, H) / 300));
        const m1 = box(L0, r1);
        const d = new Float32Array(N);
        for (let i = 0; i < N; i++) d[i] = Math.abs(L0[i] - m1[i]);
        tex = box(d, r1 * 3);
        // 털 한 올을 살린다 (2026-11-02 — 시술 사진이 뭉개진 덩어리로 나온다는 원장님 의견):
        // 밝기에서 털과 털 사이 차이를 키워 쓴다.
        // 털은 더 진하게, 털 사이 틈은 더 밝게 → 덩어리 대신 결이 남는다.
        for (let i = 0; i < N; i++) L[i] = L[i] + 1.6 * (L[i] - m1[i]);   // 살짝 편 L 을 써서 사진 자글거림은 키우지 않는다
    }
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const bg = Math.max(40, bgAt(x, y));
            const dk = (bg - L[i]) / bg;
            let t = (dk - lo) / (hi - lo);
            t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
            if (tex && t < 0.55) {
                // 진하지 않은 곳: 결(털)이 있으면 남기고, 매끈하면(그늘 · 얼룩) 지운다
                let w = (tex[i] - 1.5) / 4;
                w = w <= 0 ? 0 : w >= 1 ? 1 : w;
                const keepDark = (t - 0.3) / 0.25;          // 꽤 진하면 결이 없어도 조금씩 남긴다
                t *= Math.max(w, keepDark <= 0 ? 0 : keepDark >= 1 ? 1 : keepDark);
            }
            A[i] = Math.round(t * 255);
        }
    }

    // 3. 잡티 지우기 — 덩어리 나누기
    const label = new Int32Array(N);
    const comps = [];          // {area, x0,y0,x1,y1, edge}
    const stack = new Int32Array(N);
    let id = 0;
    for (let s = 0; s < N; s++) {
        if (A[s] < 24 || label[s]) continue;
        id++;
        let top = 0; stack[top++] = s; label[s] = id;
        const cm = { area: 0, x0: W, y0: H, x1: 0, y1: 0, edge: false };
        while (top) {
            const i = stack[--top];
            const x = i % W, y = (i / W) | 0;
            cm.area++;
            if (x < cm.x0) cm.x0 = x; if (x > cm.x1) cm.x1 = x;
            if (y < cm.y0) cm.y0 = y; if (y > cm.y1) cm.y1 = y;
            // 피부 사진은 눈썹 털끝이 사진 가장자리까지 닿는 게 보통이라 가장자리를 따지지 않는다.
            // (종이처럼 따지면 눈썹이 통째로 빠지고 작은 얼룩만 남았다)
            if (!skin && (x === 0 || y === 0 || x === W - 1 || y === H - 1)) cm.edge = true;
            if (x > 0 && !label[i - 1] && A[i - 1] >= 24) { label[i - 1] = id; stack[top++] = i - 1; }
            if (x < W - 1 && !label[i + 1] && A[i + 1] >= 24) { label[i + 1] = id; stack[top++] = i + 1; }
            if (y > 0 && !label[i - W] && A[i - W] >= 24) { label[i - W] = id; stack[top++] = i - W; }
            if (y < H - 1 && !label[i + W] && A[i + W] >= 24) { label[i + W] = id; stack[top++] = i + W; }
        }
        comps[id] = cm;
    }
    // 털 한 올 한 올이 떨어져 있어도 한 눈썹이다 — 가까운 획끼리 묶은 '무리' 를 만든다.
    // 작게 줄인 격자(칸 = 묶는 거리)에서 이웃 칸을 이어 무리를 나눈다.
    const gs = Math.max(4, Math.round(Math.max(W, H) * 0.012));
    const GW = Math.ceil(W / gs), GH = Math.ceil(H / gs);
    // 무리를 이을 때는 '획' 만 쓴다 — 종이 결의 작은 점은 다리 노릇을 못 하게 뺀다.
    // 사진 가장자리에 닿은 덩어리(종이 끝 · 그림자)도 빼서, 눈썹이 그것과 이어져 함께 빠지지 않게 한다.
    let bigArea = 0;
    for (let j = 1; j <= id; j++) if (!comps[j].edge && comps[j].area > bigArea) bigArea = comps[j].area;
    const seedMin = Math.max(12, bigArea * 0.01);
    const occ = new Uint8Array(GW * GH);
    for (let i = 0; i < N; i++) {
        const cm = label[i] ? comps[label[i]] : null;
        if (cm && !cm.edge && cm.area >= seedMin) occ[((i / W | 0) / gs | 0) * GW + ((i % W) / gs | 0)] = 1;
    }
    const grp = new Int32Array(GW * GH);
    const gEdge = [false], gInk = [0];
    let gid = 0;
    const q = new Int32Array(GW * GH);
    for (let s0 = 0; s0 < GW * GH; s0++) {
        if (!occ[s0] || grp[s0]) continue;
        gid++; gEdge[gid] = false; gInk[gid] = 0;
        let h = 0, tl = 0; q[tl++] = s0; grp[s0] = gid;
        while (h < tl) {
            const c0 = q[h++], cx = c0 % GW, cy = (c0 / GW) | 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx, ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
                const nb = ny * GW + nx;
                if (occ[nb] && !grp[nb]) { grp[nb] = gid; q[tl++] = nb; }
            }
        }
    }
    // 무리마다: 진하기 합, 사진 가장자리에 닿은 덩어리가 들었는지
    for (let j = 1; j <= id; j++) comps[j].grp = 0;
    for (let i = 0; i < N; i++) {
        const lb = label[i];
        if (!lb) continue;
        const g2 = grp[((i / W | 0) / gs | 0) * GW + ((i % W) / gs | 0)];
        comps[lb].grp = g2;
        gInk[g2] += A[i];
    }
    for (let j = 1; j <= id; j++) if (comps[j].edge) gEdge[comps[j].grp] = true;
    // 가장자리에 닿지 않은 가장 진한 무리 = 눈썹
    let main = 0;
    for (let g2 = 1; g2 <= gid; g2++) {
        if (gEdge[g2]) continue;
        if (!main || gInk[g2] > gInk[main]) main = g2;
    }
    let maxArea = 0;
    for (let j = 1; j <= id; j++) if (comps[j].grp === main && comps[j].area > maxArea) maxArea = comps[j].area;
    const keep = new Uint8Array(id + 1);
    if (main) {
        const minArea = Math.max(8, maxArea * 0.004);
        for (let j = 1; j <= id; j++) {
            const cm = comps[j];
            if (cm.grp === main && !cm.edge && cm.area >= minArea) keep[j] = 1;   // 무리 안의 작은 점은 뺀다
        }
    }

    // 4. 결과 — 짙은 회갈색 + 진하기
    for (let i = 0; i < N; i++) {
        const a = (label[i] && keep[label[i]]) ? A[i] : 0;
        px[i * 4] = 42; px[i * 4 + 1] = 34; px[i * 4 + 2] = 30; px[i * 4 + 3] = a;
    }
    g.putImageData(img, 0, 0);
    c.fromSkin = skin;
    return c;
}

/** 종이인가, 피부인가 — 밝은 쪽 40% 점들의 붉은기(R − B) 평균으로 본다. 흰 종이는 거의 0, 피부는 뚜렷하게 붉다. */
function looksLikeSkin(src) {
    const k = Math.min(1, 400 / Math.max(src.width, src.height));
    const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(src, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    c.width = 0; c.height = 0;
    const n0 = w * h, Ls = new Uint8Array(n0), hist = new Uint32Array(256);
    for (let i = 0; i < n0; i++) { Ls[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) | 0; hist[Ls[i]]++; }
    let cut = 255, acc = 0;
    while (cut > 0 && acc < n0 * 0.4) acc += hist[cut--];
    let rb = 0, n = 0;
    for (let i = 0; i < n0; i++) if (Ls[i] >= cut) { rb += px[i * 4] - px[i * 4 + 2]; n++; }
    return n > 0 && rb / n > 18;
}

/** 준비한 이미지를 이름과 함께 보관한다. */
export async function add(label, prepared) {
    const design = {
        id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        label: String(label || "").trim().slice(0, 24) || "내 디자인",
        dataUrl: prepared.dataUrl,
        width: prepared.width,
        height: prepared.height,
        createdAt: Date.now(),
    };
    await save(design);
    return design;
}
