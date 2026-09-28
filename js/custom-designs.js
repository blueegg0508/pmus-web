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
 *   1. PNG 인지 확인          — JPG 는 투명을 담지 못한다
 *   2. 투명 영역이 있는지 확인 — 배경이 흰색으로 꽉 찬 파일을 걸러낸다
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
    if (head.length < 8 || PNG_MAGIC.some((b, i) => head[i] !== b)) {
        throw new Error("PNG 파일만 등록할 수 있습니다. (JPG 는 투명 배경을 담지 못합니다)");
    }

    const img = await loadImage(await readAsDataUrl(file));
    if (img.width < 40 || img.height < 20) {
        throw new Error("이미지가 너무 작습니다. 가로 400px 이상을 권장합니다.");
    }
    if (img.width > 6000 || img.height > 6000) {
        throw new Error("이미지가 너무 큽니다. 가로 2000px 이하로 줄여서 등록해 주세요.");
    }

    const src = document.createElement("canvas");
    src.width = img.width;
    src.height = img.height;
    src.getContext("2d").drawImage(img, 0, 0);

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

    const total = src.width * src.height;
    if (opaque === total) {
        throw new Error(
            "배경이 투명하지 않습니다. 눈썹만 남기고 배경을 지운 PNG 로 저장해 주세요."
        );
    }
    if (maxX < 0) {
        throw new Error("이미지가 전부 투명합니다. 눈썹이 그려진 PNG 를 선택해 주세요.");
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

    return { dataUrl: out.toDataURL("image/png"), width: outW, height: outH };
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
