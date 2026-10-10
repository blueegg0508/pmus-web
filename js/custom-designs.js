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
    if (fromPhoto) {
        src = photoToTransparent(src);
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
            ? "사진에서 눈썹 그림을 찾지 못했습니다. 흰 종이에 진하게 그린 눈썹을, 밝은 곳에서 위에서 똑바로 찍어 주세요."
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

    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (flip) {                       // 오른쪽 눈썹을 올린 경우 뒤집어 왼쪽으로 맞춘다
        ctx.translate(outW, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(src, minX, minY, cropW, cropH, 0, 0, outW, outH);

    return { dataUrl: out.toDataURL("image/png"), width: outW, height: outH, fromPhoto };
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
    const k = Math.min(1, 1600 / Math.max(src.width, src.height));
    const W = Math.max(1, Math.round(src.width * k));
    const H = Math.max(1, Math.round(src.height * k));
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, W, H);
    const img = g.getImageData(0, 0, W, H);
    const px = img.data;
    const N = W * H;

    // 밝기
    const L = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        L[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    }

    // 1. 종이 밝기 지도
    const cell = Math.max(8, Math.round(Math.max(W, H) / 40));
    const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
    let grid = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
            let m = 0;
            const x1 = Math.min(W, (gx + 1) * cell), y1 = Math.min(H, (gy + 1) * cell);
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
    for (let r = 0; r < 2; r++) pass((x, y) => Math.max(at(x, y), at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)));
    for (let r = 0; r < 2; r++) pass((x, y) => (at(x - 1, y - 1) + at(x, y - 1) + at(x + 1, y - 1) + at(x - 1, y) + at(x, y) + at(x + 1, y) + at(x - 1, y + 1) + at(x, y + 1) + at(x + 1, y + 1)) / 9);
    const bgAt = (x, y) => {
        const fx = x / cell - 0.5, fy = y / cell - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
        const a = at(x0, y0), b = at(x0 + 1, y0), cc = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
        return (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
    };

    // 2. 진하기
    const A = new Uint8ClampedArray(N);
    const lo = 0.10, hi = 0.55;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const bg = Math.max(40, bgAt(x, y));
            const dk = (bg - L[i]) / bg;
            let t = (dk - lo) / (hi - lo);
            t = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
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
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) cm.edge = true;
            if (x > 0 && !label[i - 1] && A[i - 1] >= 24) { label[i - 1] = id; stack[top++] = i - 1; }
            if (x < W - 1 && !label[i + 1] && A[i + 1] >= 24) { label[i + 1] = id; stack[top++] = i + 1; }
            if (y > 0 && !label[i - W] && A[i - W] >= 24) { label[i - W] = id; stack[top++] = i - W; }
            if (y < H - 1 && !label[i + W] && A[i + W] >= 24) { label[i + W] = id; stack[top++] = i + W; }
        }
        comps[id] = cm;
    }
    // 가장자리에 닿지 않은 가장 큰 덩어리 = 눈썹
    let main = 0;
    for (let j = 1; j <= id; j++) {
        if (comps[j].edge) continue;
        if (!main || comps[j].area > comps[main].area) main = j;
    }
    const keep = new Uint8Array(id + 1);
    if (main) {
        const m = comps[main];
        const padX = (m.x1 - m.x0) * 0.25 + 6, padY = (m.y1 - m.y0) * 0.6 + 6;
        const ex0 = m.x0 - padX, ex1 = m.x1 + padX, ey0 = m.y0 - padY, ey1 = m.y1 + padY;
        const minArea = Math.max(4, m.area * 0.0015);
        for (let j = 1; j <= id; j++) {
            const cm = comps[j];
            if (cm.edge || cm.area < minArea) continue;
            if (cm.x1 < ex0 || cm.x0 > ex1 || cm.y1 < ey0 || cm.y0 > ey1) continue;
            keep[j] = 1;           // 눈썹 근처의 털 한 올 한 올은 남긴다
        }
    }

    // 4. 결과 — 짙은 회갈색 + 진하기
    for (let i = 0; i < N; i++) {
        const a = (label[i] && keep[label[i]]) ? A[i] : 0;
        px[i * 4] = 42; px[i * 4 + 1] = 34; px[i * 4 + 2] = 30; px[i * 4 + 3] = a;
    }
    g.putImageData(img, 0, 0);
    return c;
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
