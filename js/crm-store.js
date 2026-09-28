/**
 * crm-store.js — 고객 장부 보관소
 * =========================================================================
 * 원장님들은 대부분 수기 장부로 고객을 관리한다. 엑셀을 쓰는 분도 있지만,
 * 둘 다 **손님 앞에서 바로 꺼내 보기가 어렵다.** 그게 이 장부의 존재 이유다.
 * 뒷정리용 대장이 아니라 상담 중에 쓰는 도구로 만든다.
 *
 * ── 왜 별도 DB 인가 ──────────────────────────────────────────────────
 * 등록 디자인(custom-designs.js)은 'browlist' DB 를 쓴다. 여기에 얹지 않고
 * 따로 두는 이유는 담는 것의 성격이 다르기 때문이다.
 *
 *   디자인   원장님의 자산. 앱을 쓰는 내내 남는다.
 *   고객 장부 남의 개인정보. 지워 달라면 바로, 흔적 없이 지워야 한다.
 *
 * 한 DB 에 섞어 두면 '고객 한 명 완전 삭제' 나 '장부 전체 비우기' 가 디자인을
 * 건드릴 위험을 늘 안고 간다. 나눠 두면 그럴 일이 없다.
 *
 * ── 담는 것 ─────────────────────────────────────────────────────────
 *   customers  이름 · 연락처 · 메모 · 사진 보관 동의
 *   visits     시술 이력 (날짜 · 부위 · 디자인 · 색상 · 메모 · 리터치 예정일)
 *   photos     사진 세 장 (Blob)
 *
 * ── 사진을 왜 세 자리로 나눠 담나 ───────────────────────────────────
 * 한 장짜리 비교 그림이면 기록은 되지만 상담이 안 된다. 세 자리로 나눈다.
 *
 *   before  시술 전 최초 촬영    고객이 자기 원래 모습을 기억하게 한다
 *   sim     최종 선택 시뮬레이션  고객이 기대한 모습
 *   after   시술 완료 후 촬영     실제로 나온 모습
 *
 * 원장님은 sim 과 after 를 나란히 놓고 **얼마나 맞았는지** 를 고객과 같이
 * 본다. 거기서 이번 시술의 아쉬운 점과 다음 방향이 나온다. 이 앱이
 * 기록장이 아니라 상담 도구가 되는 자리다.
 *
 * 앞의 둘은 상담 당일에 한 장씩 정해지지만, **시술 후는 한 장이 아니다.**
 * 시술 직후에 한 장 찍고, 그 다음 재방문마다 또 한 장 찍는다. 색이 어떻게
 * 앉고 얼마나 빠지는지는 그 줄을 쭉 봐야 보인다. 그래서 after 는 자리가
 * 아니라 **시간 순으로 쌓이는 목록** 이다.
 *
 *   visit.photos  { before, sim }   상담 당일 한 장씩
 *   visit.after   [id, id, ...]     시술 직후 → 재방문들, 찍은 순서대로
 *
 * 사진은 dataURL 이 아니라 Blob 으로 담는다. base64 는 같은 그림을 33% 더
 * 크게 만들고, 꺼낼 때마다 문자열을 통째로 메모리에 올린다. 저사양 기기에서
 * 그것만으로 터진 적이 있다(갤럭시 S25 엣지).
 *
 * ── 밖으로 내보내지 않는다 ──────────────────────────────────────────
 * 전부 기기 안에만 둔다. 클라우드 동기화는 편하지만 얼굴 사진과 연락처를
 * 남의 서버에 올리는 순간 책임의 크기가 달라진다. 기기를 바꿀 때는
 * 내보내기 파일(exportAll)로 옮긴다.
 * =========================================================================
 */

const DB_NAME = "pmus_crm";
const DB_VERSION = 1;

const C = "customers";
const V = "visits";
const P = "photos";

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(C)) {
                const s = db.createObjectStore(C, { keyPath: "id" });
                // 손님이 앉자마자 찾아야 한다. 이름과 최근 순 둘 다 쓴다.
                s.createIndex("name", "name");
                s.createIndex("updatedAt", "updatedAt");
            }
            if (!db.objectStoreNames.contains(V)) {
                const s = db.createObjectStore(V, { keyPath: "id" });
                s.createIndex("customerId", "customerId");
                s.createIndex("date", "date");
            }
            if (!db.objectStoreNames.contains(P)) {
                const s = db.createObjectStore(P, { keyPath: "id" });
                s.createIndex("visitId", "visitId");
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("고객 장부를 열 수 없습니다"));
    });
    return dbPromise;
}

/** 여러 창고를 한 묶음으로 다룬다. 중간에 실패하면 전부 되돌아간다. */
function tx(stores, mode, run) {
    return openDb().then(
        (db) =>
            new Promise((resolve, reject) => {
                const t = db.transaction(stores, mode);
                let out;
                try {
                    out = run(...stores.map((n) => t.objectStore(n)));
                } catch (e) {
                    reject(e);
                    return;
                }
                t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error || new Error("저장이 중단되었습니다"));
            })
    );
}

const wrap = (req) => new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
});

function newId(prefix) {
    // 시각을 앞에 두면 id 만으로도 만든 순서가 보인다. 뒤는 겹침 방지.
    return prefix + "_" + Date.now().toString(36) + "_"
         + Math.random().toString(36).slice(2, 8);
}

/** 검색용으로 눌러 둔 글자. 띄어쓰기·대소문자·하이픈을 무시하고 찾는다. */
function normalize(s) {
    return String(s || "").toLowerCase().replace(/[\s-]/g, "");
}

// ── 고객 ────────────────────────────────────────────────────────────────

/**
 * 고객을 새로 만들거나 고친다.
 * @param {{id?:string, name:string, phone?:string, memo?:string,
 *          consentAt?:number|null}} c
 */
export async function saveCustomer(c) {
    const now = Date.now();
    const name = String(c.name || "").trim();
    if (!name) throw new Error("고객 이름을 입력해 주세요");

    const prev = c.id ? await getCustomer(c.id) : null;
    const rec = {
        id: c.id || newId("c"),
        name,
        phone: String(c.phone || "").trim(),
        memo: String(c.memo || ""),
        // 사진을 보관해도 좋다고 한 때. 요구가 오면 근거가 된다.
        consentAt: c.consentAt !== undefined ? c.consentAt : (prev ? prev.consentAt : null),
        search: normalize(name) + " " + normalize(c.phone),
        createdAt: prev ? prev.createdAt : now,
        updatedAt: now,
    };
    await tx([C], "readwrite", (s) => s.put(rec));
    return rec;
}

export function getCustomer(id) {
    return tx([C], "readonly", (s) => wrap(s.get(id))).then((r) => r || null);
}

/**
 * 고객을 찾는다. 검색어가 없으면 최근에 다녀간 순서로 돌려준다.
 * 손님이 앉은 뒤 이름을 다 칠 시간이 없다 — 두세 글자나 번호 뒷자리면 된다.
 */
export async function findCustomers(query, limit = 50) {
    const all = await tx([C], "readonly", (s) => wrap(s.getAll()));
    const q = normalize(query);
    const hit = q ? all.filter((c) => (c.search || "").includes(q)) : all;
    hit.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return hit.slice(0, limit);
}

export function countCustomers() {
    return tx([C], "readonly", (s) => wrap(s.count()));
}

/**
 * 고객 한 명을 사진까지 남김없이 지운다.
 *
 * 지워 달라는 요구가 오면 바로 응할 수 있어야 한다. 이력만 지우고 사진이
 * 남는다면 지운 것이 아니다.
 */
export async function deleteCustomer(id) {
    const visits = await getVisits(id);
    const visitIds = visits.map((v) => v.id);
    const photoIds = [];
    for (const v of visits) photoIds.push(...photoIdsOf(v));

    await tx([C, V, P], "readwrite", (cs, vs, ps) => {
        cs.delete(id);
        visitIds.forEach((vid) => vs.delete(vid));
        photoIds.forEach((pid) => ps.delete(pid));
    });
    return { visits: visitIds.length, photos: photoIds.length };
}

// ── 시술 이력 ───────────────────────────────────────────────────────────

/** 상담 당일에 한 장씩 정해지는 자리 */
export const SLOTS = ["before", "sim"];
export const SLOT_LABEL = {
    before: "시술 전",
    sim: "예상 (시뮬레이션)",
};

/**
 * 옛 모양을 새 모양으로 펴 준다.
 *
 * 처음에는 시술 후도 한 장짜리 자리(photos.after)였다. 쌓이는 목록으로
 * 바꾸면서, 이미 그렇게 담긴 것을 목록 맨 앞으로 옮긴다. 시험 중에 넣어
 * 둔 기록이 사라지면 안 된다.
 */
function normalize_(v) {
    if (!v) return v;
    const photos = Object.assign({}, v.photos || {});
    const after = Array.isArray(v.after) ? v.after.slice() : [];
    if (photos.after) {
        if (after.indexOf(photos.after) < 0) after.unshift(photos.after);
        delete photos.after;
    }
    return Object.assign({}, v, { photos, after });
}

/** 이력 하나에 들어 있는 사진 id 를 모은다 */
function photoIdsOf(v) {
    if (!v) return [];
    const n = normalize_(v);
    return SLOTS.map((k) => n.photos[k]).concat(n.after).filter(Boolean);
}

/**
 * 시술 한 건을 남긴다. 사진은 dataURL 로 받아 Blob 으로 바꿔 담는다.
 *
 * @param {{id?:string, customerId:string, date?:number, area:"brow"|"lip",
 *          design?:string, color?:string, memo?:string,
 *          retouchAt?:number|null}} v
 * @param {{before?:string, sim?:string, after?:string}} shots  dataURL
 */
export async function saveVisit(v, shots = {}) {
    if (!v.customerId) throw new Error("고객을 먼저 고르세요");
    const now = Date.now();
    const prev = v.id ? await getVisit(v.id) : null;

    /* 사진을 찍은 때는 '저장한 순간' 이 아니라 '시술한 때' 다.
     * 지난 시술을 나중에 기록하면 둘이 갈라진다 — 6월 시술을 9월에 적으면
     * 사진이 9월에 찍힌 것으로 남는다. 시기별 기록으로 쓸 수 없게 된다. */
    const when = v.date || (prev ? prev.date : now);

    const photos = prev ? Object.assign({}, prev.photos) : {};
    const after = prev ? prev.after.slice() : [];
    const made = [];
    const dropped = [];
    for (const slot of SLOTS) {
        const url = shots[slot];
        if (!url) continue;
        if (photos[slot]) dropped.push(photos[slot]);      // 같은 자리는 갈아 끼운다
        const blob = await dataUrlToBlob(url);
        const p = { id: newId("p"), visitId: v.id || "", slot, blob,
                    createdAt: now, takenAt: when };
        made.push(p);
        photos[slot] = p.id;
    }
    // 시술 후는 자리가 아니라 쌓이는 줄이다. 주면 맨 뒤에 붙인다.
    if (shots.after) {
        const blob = await dataUrlToBlob(shots.after);
        const p = { id: newId("p"), visitId: v.id || "", slot: "after", blob,
                    createdAt: now, takenAt: when };
        made.push(p);
        after.push(p.id);
    }

    const rec = {
        id: v.id || newId("v"),
        customerId: v.customerId,
        date: when,
        area: v.area || "brow",
        design: String(v.design || ""),
        color: String(v.color || ""),
        memo: String(v.memo || ""),
        photos,
        after,
        // 리터치 예정일. 알림은 remind.js 가 이 값을 보고 건다.
        retouchAt: v.retouchAt !== undefined ? v.retouchAt : (prev ? prev.retouchAt : null),
        createdAt: prev ? prev.createdAt : now,
        updatedAt: now,
    };
    made.forEach((p) => { p.visitId = rec.id; });

    await tx([V, P, C], "readwrite", (vs, ps, cs) => {
        vs.put(rec);
        made.forEach((p) => ps.put(p));
        dropped.forEach((pid) => ps.delete(pid));
        // 최근 다녀간 순서로 목록을 띄우므로 고객 쪽 시각도 올린다
        const g = cs.get(rec.customerId);
        g.onsuccess = () => {
            const c = g.result;
            if (c) { c.updatedAt = now; cs.put(c); }
        };
    });
    return rec;
}

/**
 * 상담 당일 자리(시술 전 · 예상)의 사진을 갈아 끼운다.
 *
 * @param {"before"|"sim"} slot
 * @param {string|null} dataUrl  null 이면 그 자리를 비운다
 */
export async function setVisitPhoto(visitId, slot, dataUrl) {
    if (SLOTS.indexOf(slot) < 0) throw new Error("모르는 사진 자리입니다: " + slot);
    const v = await getVisit(visitId);
    if (!v) throw new Error("이력을 찾을 수 없습니다");

    const photos = Object.assign({}, v.photos);
    const old = photos[slot] || null;
    let made = null;

    if (dataUrl) {
        const blob = await dataUrlToBlob(dataUrl);
        made = { id: newId("p"), visitId, slot, blob,
                 createdAt: Date.now(), takenAt: Date.now() };
        photos[slot] = made.id;
    } else {
        delete photos[slot];
    }

    const rec = Object.assign({}, v, { photos, updatedAt: Date.now() });
    await tx([V, P], "readwrite", (vs, ps) => {
        vs.put(rec);
        if (made) ps.put(made);
        if (old) ps.delete(old);
    });
    return rec;
}

/**
 * 경과 사진을 한 장 더 쌓는다.
 *
 * 시술 직후에 한 장, 그 뒤 재방문마다 또 한 장. 이 줄이 길어질수록 고객의
 * 변화가 눈에 보인다 — 색이 어떻게 앉았고 얼마나 빠졌는지는 한 장으로는
 * 알 수 없다. 찍은 때를 함께 담아 나중에 '3주 뒤' 처럼 읽어 준다.
 */
export async function addAfterPhoto(visitId, dataUrl, takenAt) {
    if (!dataUrl) throw new Error("사진이 없습니다");
    const v = await getVisit(visitId);
    if (!v) throw new Error("이력을 찾을 수 없습니다");

    const when = takenAt || Date.now();
    const blob = await dataUrlToBlob(dataUrl);
    const made = { id: newId("p"), visitId, slot: "after", blob,
                   createdAt: Date.now(), takenAt: when };

    const after = v.after.concat([made.id]);
    const rec = Object.assign({}, v, { after, updatedAt: Date.now() });
    await tx([V, P], "readwrite", (vs, ps) => {
        vs.put(rec);
        ps.put(made);
    });
    return rec;
}

/** 경과 사진 한 장을 뺀다 (잘못 찍은 것) */
export async function removeAfterPhoto(visitId, photoId) {
    const v = await getVisit(visitId);
    if (!v) throw new Error("이력을 찾을 수 없습니다");
    const after = v.after.filter((x) => x !== photoId);
    const rec = Object.assign({}, v, { after, updatedAt: Date.now() });
    await tx([V, P], "readwrite", (vs, ps) => {
        vs.put(rec);
        ps.delete(photoId);
    });
    return rec;
}

/** 사진 한 장의 정보 (찍은 때 등). 그림은 photoUrl 로 따로 꺼낸다. */
export async function getPhotoInfo(id) {
    const p = await tx([P], "readonly", (s) => wrap(s.get(id)));
    if (!p) return null;
    return { id: p.id, slot: p.slot, takenAt: p.takenAt || p.createdAt };
}

/** 리터치 예정일만 고친다 (알림 예약은 부르는 쪽에서) */
export async function setRetouch(visitId, at) {
    const v = await getVisit(visitId);
    if (!v) throw new Error("이력을 찾을 수 없습니다");
    const rec = { ...v, retouchAt: at || null, updatedAt: Date.now() };
    await tx([V], "readwrite", (vs) => vs.put(rec));
    return rec;
}

export function getVisit(id) {
    return tx([V], "readonly", (s) => wrap(s.get(id)))
        .then((r) => (r ? normalize_(r) : null));
}

/** 한 고객의 시술 이력. 최근 것이 위로. */
export async function getVisits(customerId) {
    const all = await tx([V], "readonly", (s) =>
        wrap(s.index("customerId").getAll(IDBKeyRange.only(customerId))));
    all.sort((a, b) => (b.date || 0) - (a.date || 0));
    return all.map(normalize_);
}

export async function deleteVisit(id) {
    const v = await getVisit(id);
    if (!v) return;
    await tx([V, P], "readwrite", (vs, ps) => {
        vs.delete(id);
        photoIdsOf(v).forEach((pid) => ps.delete(pid));
    });
}

// ── 일정 ────────────────────────────────────────────────────────────────

/**
 * 리터치 예정을 날짜 순으로 모은다. 캘린더와 '오늘 챙길 것' 이 이걸 쓴다.
 *
 * 고객 이름을 같이 붙여 돌려준다 — 일정만 보고는 누구인지 알 수 없고,
 * 화면에서 고객을 하나하나 다시 찾으면 느려진다.
 *
 * @param {{from?:number, to?:number, includeDone?:boolean}} opt
 */
export async function getSchedule(opt = {}) {
    const from = opt.from !== undefined ? opt.from : 0;
    const to = opt.to !== undefined ? opt.to : Infinity;

    const [visits, customers] = await Promise.all([
        tx([V], "readonly", (s) => wrap(s.getAll())),
        tx([C], "readonly", (s) => wrap(s.getAll())),
    ]);
    const byId = {};
    customers.forEach((c) => { byId[c.id] = c; });

    const out = [];
    for (const v of visits) {
        if (!v.retouchAt) continue;
        if (v.retouchAt < from || v.retouchAt > to) continue;
        const c = byId[v.customerId];
        if (!c) continue;                       // 고객이 지워진 이력은 보이지 않는다
        out.push({
            visitId: v.id,
            customerId: c.id,
            name: c.name,
            phone: c.phone,
            area: v.area,
            design: v.design,
            color: v.color,
            retouchAt: v.retouchAt,
            treatedAt: v.date,
        });
    }
    out.sort((a, b) => a.retouchAt - b.retouchAt);
    return out;
}

// ── 사진 ────────────────────────────────────────────────────────────────

/** 화면에 걸 주소를 만든다. 다 쓰면 releasePhoto 로 놓아줘야 한다. */
export async function photoUrl(id) {
    const p = await tx([P], "readonly", (s) => wrap(s.get(id)));
    if (!p || !p.blob) return null;
    return URL.createObjectURL(p.blob);
}

export function releasePhoto(url) {
    try { if (url) URL.revokeObjectURL(url); } catch (e) { /* 이미 놓았으면 그만 */ }
}

async function dataUrlToBlob(dataUrl) {
    // fetch 가 data: 를 그대로 Blob 으로 바꿔 준다. 손으로 base64 를 풀면
    // 그 문자열이 한 번 더 메모리에 올라간다.
    const res = await fetch(dataUrl);
    return res.blob();
}

// ── 기기를 바꿀 때 ──────────────────────────────────────────────────────

/**
 * 장부 전체를 한 덩어리로 뽑는다.
 *
 * 폰을 바꾸면 장부가 통째로 날아간다 — 수기 장부보다 못한 일이 된다.
 * 사진까지 담으므로 파일이 커진다. 옮긴 뒤에는 지우도록 안내해야 한다.
 */
export async function exportAll() {
    const [customers, visits, photos] = await Promise.all([
        tx([C], "readonly", (s) => wrap(s.getAll())),
        tx([V], "readonly", (s) => wrap(s.getAll())),
        tx([P], "readonly", (s) => wrap(s.getAll())),
    ]);
    const outPhotos = [];
    for (const p of photos) {
        outPhotos.push({
            id: p.id, visitId: p.visitId, kind: p.kind, createdAt: p.createdAt,
            dataUrl: await blobToDataUrl(p.blob),
        });
    }
    return {
        format: "pmus-crm",
        version: 1,
        exportedAt: Date.now(),
        customers, visits, photos: outPhotos,
    };
}

/** 내보낸 덩어리를 되돌린다. 같은 id 는 덮어쓴다. */
export async function importAll(data) {
    if (!data || data.format !== "pmus-crm") {
        throw new Error("이 앱에서 내보낸 파일이 아닙니다");
    }
    const photos = [];
    for (const p of data.photos || []) {
        photos.push({
            id: p.id, visitId: p.visitId, kind: p.kind, createdAt: p.createdAt,
            blob: await dataUrlToBlob(p.dataUrl),
        });
    }
    await tx([C, V, P], "readwrite", (cs, vs, ps) => {
        (data.customers || []).forEach((c) => cs.put(c));
        (data.visits || []).forEach((v) => vs.put(v));
        photos.forEach((p) => ps.put(p));
    });
    return {
        customers: (data.customers || []).length,
        visits: (data.visits || []).length,
        photos: photos.length,
    };
}

/** 장부를 통째로 비운다 (등록 디자인·라이선스는 건드리지 않는다) */
export function wipeAll() {
    return tx([C, V, P], "readwrite", (cs, vs, ps) => {
        cs.clear(); vs.clear(); ps.clear();
    });
}

function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(blob);
    });
}
