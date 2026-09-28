/**
 * crm-ui.js — 고객 장부 화면
 * =========================================================================
 * 상담은 두 갈래로 시작한다.
 *
 *   첫 방문   사진을 찍고 시뮬레이션한 뒤, 그 결과를 새 고객으로 저장한다.
 *   재방문    고객을 먼저 찾아 지난 시술을 확인하고 상담을 시작한다.
 *
 * 그래서 기존 흐름(사진 → 부위 → 디자인 → 편집)은 한 줄도 건드리지 않고,
 * 1단계 맨 위에 '고객 줄' 만 얹었다. 고객을 고르면 그 줄에 붙어 다니다가
 * 저장할 때 이력으로 남는다. 안 고르면 지금까지와 똑같이 동작한다.
 *
 * 화면은 셋이 한 자리를 나눠 쓴다 — 찾기 · 카드 · 수정.
 * 손님 앞에서 여는 화면이라 단계가 깊어지면 곤란하다.
 * =========================================================================
 */

import * as Store from "./crm-store.js?v=81";
import * as Remind from "./remind.js?v=81";

const $ = (id) => document.getElementById(id);

/**
 * 리터치 기본 간격.
 *
 * 눈썹·입술 모두 첫 리터치는 한 달 뒤가 보통이라 그 값을 미리 채워 둔다.
 * 저장할 때마다 달력을 열어 날짜를 고르면 상담이 끊긴다. 다른 주기가
 * 필요한 경우에만 아래 버튼으로 바꾼다.
 */
const RETOUCH_DEFAULT_DAYS = 30;
const RETOUCH_CHOICES = [
    { label: "1개월", days: 30 },
    { label: "3개월", days: 90 },
    { label: "6개월", days: 180 },
    { label: "1년", days: 365 },
];
const DAY = 86400000;

export function defaultRetouch(from) {
    return startOfDay((from || Date.now()) + RETOUCH_DEFAULT_DAYS * DAY);
}

function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** 지금 상담 중인 고객 (없으면 null) */
let current = null;
/** 카드에서 보고 있는 고객 */
let viewing = null;
/** 화면에 걸어 둔 사진 주소. 닫을 때 놓아준다. */
let liveUrls = [];
/** 고객이 정해지거나 풀렸을 때 앱 셸에 알린다 */
let onChange = () => {};
/** '이 고객으로 상담 시작' 을 눌렀을 때 */
let onStart = () => {};

export function getCurrent() { return current; }

export function setCurrent(c) {
    current = c || null;
    paintBar();
    onChange(current);
}

// ── 고객 줄 ─────────────────────────────────────────────────────────────

function paintBar() {
    const has = !!current;
    $("crm-find").hidden = has;
    $("crm-current").hidden = !has;
    if (!has) return;
    $("crm-cur-name").textContent = current.name;
    const bits = [];
    if (current.phone) bits.push(current.phone);
    if (current.visitCount) bits.push("지난 시술 " + current.visitCount + "건");
    $("crm-cur-sub").textContent = bits.join(" · ");
}

// ── 화면 바꾸기 ─────────────────────────────────────────────────────────

function show(which) {
    ["list", "card", "edit", "retouch", "plan"].forEach((v) => {
        $("crm-view-" + v).hidden = v !== which;
    });
}

function open(which) {
    $("crm-sheet").hidden = false;
    show(which);
}

function close() {
    $("crm-sheet").hidden = true;
    releaseUrls();
}

function releaseUrls() {
    liveUrls.forEach(Store.releasePhoto);
    liveUrls = [];
}

// ── 찾기 ────────────────────────────────────────────────────────────────

let findTimer = 0;

async function paintList() {
    const q = $("crm-q").value.trim();
    const list = await Store.findCustomers(q, 60);
    const box = $("crm-list");
    box.innerHTML = "";

    if (!list.length) {
        const p = document.createElement("p");
        p.className = "crm-empty";
        p.textContent = q
            ? "찾는 고객이 없습니다. 아래 '새 고객' 으로 등록하세요."
            : "아직 등록된 고객이 없습니다.";
        box.appendChild(p);
        return;
    }

    for (const c of list) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "crm-row";
        row.innerHTML =
            '<span class="crm-row-name"></span>' +
            '<span class="crm-row-sub"></span>';
        row.querySelector(".crm-row-name").textContent = c.name;
        row.querySelector(".crm-row-sub").textContent =
            [c.phone, when(c.updatedAt)].filter(Boolean).join(" · ");
        row.addEventListener("click", () => {
            if (pendingResult) commitResult(c);
            else openCard(c.id);
        });
        box.appendChild(row);
    }
}

/** 며칠 전인지 — 손님 앞에서 날짜를 세고 있을 수는 없다 */
function when(ts) {
    if (!ts) return "";
    const day = Math.floor((Date.now() - ts) / 86400000);
    if (day <= 0) return "오늘";
    if (day === 1) return "어제";
    if (day < 30) return day + "일 전";
    if (day < 365) return Math.floor(day / 30) + "개월 전";
    return Math.floor(day / 365) + "년 전";
}

/** 며칠 남았는지 */
function until(ts) {
    const day = Math.ceil((startOfDay(ts) - startOfDay(Date.now())) / DAY);
    if (day === 0) return "오늘";
    if (day < 0) return -day + "일 지남";
    if (day === 1) return "내일";
    if (day < 30) return day + "일 뒤";
    return Math.round(day / 30) + "개월 뒤";
}

/** 시술일로부터 얼마나 지나 찍은 사진인지 */
function elapsed(from, at) {
    const day = Math.round((startOfDay(at) - startOfDay(from)) / DAY);
    if (day <= 0) return "직후";
    if (day < 7) return day + "일";
    if (day < 30) return Math.round(day / 7) + "주";
    if (day < 365) return Math.round(day / 30) + "개월";
    return (Math.round(day / 36.5) / 10) + "년";
}

/** 곧 다가오거나 이미 지난 것 — 눈에 띄어야 한다 */
function isSoon(ts) {
    if (!ts) return false;
    return startOfDay(ts) - startOfDay(Date.now()) <= 5 * DAY;
}

function ymd(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate());
}

/**
 * 사진을 찍은 날짜와 시각.
 *
 * '3주 뒤' 만으로는 언제 찍은 것인지 정확히 알 수 없다. 같은 날 오전과
 * 오후에 찍은 두 장이 둘 다 '직후' 로 보이기도 한다. 시기별 기록으로
 * 쓰려면 실제 시각이 붙어야 한다.
 */
function stamp(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate())
         + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/**
 * 썸네일 밑에 넣을 짧은 일시 (자리가 84px 밖에 없다).
 * 시술 직후에 오전·오후로 두 장 찍는 일이 있어 시각까지 적는다 —
 * 날짜만 있으면 둘이 똑같아 보인다.
 */
function shortDay(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return (d.getMonth() + 1) + "." + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

// ── 고객 카드 ───────────────────────────────────────────────────────────

export async function openCard(id) {
    releaseUrls();
    const c = await Store.getCustomer(id);
    if (!c) return;
    viewing = c;

    $("crm-card-name").textContent = c.name;
    const meta = [];
    if (c.phone) meta.push(c.phone);
    meta.push("등록 " + ymd(c.createdAt));
    meta.push(c.consentAt ? "사진 보관 동의 " + ymd(c.consentAt) : "사진 보관 동의 없음");
    $("crm-card-meta").textContent = meta.join(" · ");

    $("crm-card-memo").hidden = !c.memo;
    $("crm-card-memo").textContent = c.memo || "";

    const visits = await Store.getVisits(c.id);
    const box = $("crm-history");
    box.innerHTML = "";

    if (!visits.length) {
        const p = document.createElement("p");
        p.className = "crm-empty";
        p.textContent = "아직 시술 이력이 없습니다.";
        box.appendChild(p);
    }

    for (const v of visits) {
        const item = document.createElement("div");
        item.className = "crm-visit";

        const head = document.createElement("div");
        head.className = "crm-visit-head";
        const what = [v.area === "lip" ? "입술" : "눈썹", v.design, v.color]
            .filter(Boolean).join(" · ");
        head.innerHTML = '<b></b><span></span>';
        head.querySelector("b").textContent = ymd(v.date);
        head.querySelector("span").textContent = what;
        item.appendChild(head);

        if (v.memo) {
            const m = document.createElement("div");
            m.className = "crm-visit-memo";
            m.textContent = v.memo;
            item.appendChild(m);
        }

        /* 상담 당일 두 장 — 이미 찍혀 있는 것이므로 누르면 크게 본다.
         * 여기서 카메라가 뜨면 고객에게 보여 주려다 사진을 덮어쓴다. */
        const strip = document.createElement("div");
        strip.className = "crm-slots";
        for (const slot of Store.SLOTS) {
            const cell = document.createElement("div");
            cell.className = "crm-slot";

            const cap = document.createElement("span");
            cap.className = "crm-slot-cap";
            cap.textContent = Store.SLOT_LABEL[slot];
            cell.appendChild(cap);

            const pid = v.photos[slot];
            if (pid) {
                const url = await Store.photoUrl(pid);
                if (url) {
                    liveUrls.push(url);
                    const info = await Store.getPhotoInfo(pid);
                    const at = info ? info.takenAt : v.date;
                    const im = document.createElement("img");
                    im.src = url;
                    im.alt = Store.SLOT_LABEL[slot];
                    im.loading = "lazy";
                    im.addEventListener("click", () =>
                        zoom(url, Store.SLOT_LABEL[slot], null, at));
                    cell.appendChild(im);

                    const when = document.createElement("span");
                    when.className = "crm-slot-when";
                    when.textContent = stamp(at);
                    cell.appendChild(when);
                }
            } else {
                const add = document.createElement("button");
                add.type = "button";
                add.className = "crm-slot-add";
                add.textContent = "＋";
                add.addEventListener("click", () => shoot(v.id, slot));
                cell.appendChild(add);
            }
            strip.appendChild(cell);
        }
        item.appendChild(strip);

        /* 경과 — 시술 직후부터 재방문마다 쌓인다.
         *
         * 한 장으로는 색이 어떻게 앉았고 얼마나 빠졌는지 알 수 없다.
         * 이 줄이 길어질수록 고객의 변화가 눈에 보이고, 그게 다음 시술을
         * 이야기하는 근거가 된다. */
        const afterCap = document.createElement("div");
        afterCap.className = "crm-after-cap";
        afterCap.innerHTML = "<span>경과 (시술 후)</span><em></em>";
        afterCap.querySelector("em").textContent =
            v.after.length ? v.after.length + "장" : "아직 없음";
        item.appendChild(afterCap);

        const track = document.createElement("div");
        track.className = "crm-after";

        /* 촬영 버튼을 맨 앞에 둔다.
         *
         * 뒤에 두면 경과가 서너 장만 쌓여도 화면 밖으로 밀린다. 재방문 때
         * 가장 먼저 누를 버튼인데 그때마다 옆으로 밀어 찾게 된다. */
        const add = document.createElement("button");
        add.type = "button";
        add.className = "crm-after-add";
        add.innerHTML = "<b>📷</b><span></span>";
        add.querySelector("span").textContent = v.after.length ? "오늘 촬영" : "시술 직후";
        add.addEventListener("click", () => shoot(v.id, "after"));
        track.appendChild(add);

        for (const pid of v.after) {
            const info = await Store.getPhotoInfo(pid);
            const url = await Store.photoUrl(pid);
            if (!url) continue;
            liveUrls.push(url);

            const cell = document.createElement("div");
            cell.className = "crm-after-cell";

            const im = document.createElement("img");
            im.src = url;
            im.alt = "경과";
            im.loading = "lazy";
            const at = info ? info.takenAt : v.date;
            const gap = elapsed(v.date, at);
            im.addEventListener("click", () => zoom(url, "경과 · " + gap, {
                visitId: v.id, photoId: pid,
            }, at));
            cell.appendChild(im);

            const tag = document.createElement("span");
            tag.innerHTML = "<b></b><em></em>";
            tag.querySelector("b").textContent = gap;
            tag.querySelector("em").textContent = shortDay(at);
            cell.appendChild(tag);
            track.appendChild(cell);
        }

        item.appendChild(track);

        // 예상과 실제가 다 있으면 그게 상담거리다
        if (v.photos.sim && v.after.length) {
            const hint = document.createElement("div");
            hint.className = "crm-match";
            hint.textContent = "예상과 경과를 나란히 놓고 상담하세요";
            item.appendChild(hint);
        }

        // ── 리터치 줄 ──
        const re = document.createElement("button");
        re.type = "button";
        re.className = "crm-retouch" + (isSoon(v.retouchAt) ? " is-soon" : "");
        re.textContent = v.retouchAt
            ? "🔔 리터치 " + ymd(v.retouchAt) + " (" + until(v.retouchAt) + ")"
            : "🔔 리터치 예정일 정하기";
        re.addEventListener("click", () => openRetouch(v));
        item.appendChild(re);

        box.appendChild(item);
    }

    // 줄에 붙일 때 쓰도록 건수를 들고 다닌다
    viewing.visitCount = visits.length;
    open("card");
}

// ── 수정 ────────────────────────────────────────────────────────────────

let editing = null;      // null 이면 새 고객

function openEdit(c) {
    editing = c || null;
    $("crm-edit-title").textContent = c ? "고객 정보 수정" : "새 고객";
    $("crm-f-name").value = c ? c.name : "";
    $("crm-f-phone").value = c ? c.phone : "";
    $("crm-f-memo").value = c ? c.memo : "";
    $("crm-f-consent").checked = c ? !!c.consentAt : false;
    $("crm-delete").hidden = !c;
    $("crm-edit-error").hidden = true;
    open("edit");
    setTimeout(() => $("crm-f-name").focus(), 60);
}

async function saveEdit() {
    const name = $("crm-f-name").value.trim();
    if (!name) {
        const e = $("crm-edit-error");
        e.textContent = "고객 이름을 입력해 주세요.";
        e.hidden = false;
        return;
    }
    const want = $("crm-f-consent").checked;
    // 동의는 '언제 받았는지' 가 근거다. 이미 있으면 그 날짜를 지킨다.
    let consentAt = editing ? editing.consentAt : null;
    if (want && !consentAt) consentAt = Date.now();
    if (!want) consentAt = null;

    const saved = await Store.saveCustomer({
        id: editing ? editing.id : undefined,
        name,
        phone: $("crm-f-phone").value,
        memo: $("crm-f-memo").value,
        consentAt,
    });
    editing = null;
    if (pendingResult) { await commitResult(saved); return; }
    openCard(saved.id);
}

async function removeCustomer() {
    if (!editing) return;
    const ok = window.confirm([
        editing.name + " 고객을 지울까요?",
        "",
        "시술 이력과 사진까지 남김없이 지워집니다.",
        "되돌릴 수 없습니다.",
    ].join("\n"));
    if (!ok) return;

    const gone = await Store.deleteCustomer(editing.id);
    if (current && current.id === editing.id) setCurrent(null);
    editing = null;
    viewing = null;
    await paintList();
    open("list");
    return gone;
}

// ── 사진 찍어 자리에 넣기 ───────────────────────────────────────────────

let shootTarget = null;      // { visitId, slot }

/**
 * 사진 한 장을 자리에 넣는다. 카메라가 준 원본은 3~4MB 라 그대로 담으면
 * 고객 몇 십 명 만에 폰 용량을 먹는다. 긴 변 1200px 로 줄여 담는다.
 * 상담 화면에서 보는 크기로는 차이가 없다.
 */
const SHOT_MAX = 1200;

function shoot(visitId, slot) {
    shootTarget = { visitId, slot };
    const f = $("crm-shot-file");
    f.value = "";                       // 같은 사진을 다시 골라도 change 가 오게
    f.click();
}

async function onShotPicked() {
    const f = $("crm-shot-file");
    const file = f.files && f.files[0];
    if (!file || !shootTarget) return;
    const { visitId, slot } = shootTarget;
    shootTarget = null;

    try {
        const dataUrl = await shrink(file);
        if (slot === "after") await Store.addAfterPhoto(visitId, dataUrl);
        else await Store.setVisitPhoto(visitId, slot, dataUrl);
        if (viewing) await openCard(viewing.id);
    } catch (e) {
        window.alert("사진을 넣지 못했습니다 — " + (e.message || e));
    }
}

function shrink(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => {
            try {
                const k = Math.min(1, SHOT_MAX / Math.max(im.naturalWidth, im.naturalHeight));
                const c = document.createElement("canvas");
                c.width = Math.max(1, Math.round(im.naturalWidth * k));
                c.height = Math.max(1, Math.round(im.naturalHeight * k));
                const x = c.getContext("2d");
                x.imageSmoothingQuality = "high";
                x.drawImage(im, 0, 0, c.width, c.height);
                const out = c.toDataURL("image/jpeg", 0.88);
                c.width = 0; c.height = 0;
                URL.revokeObjectURL(url);
                if (!out || out.length < 128) reject(new Error("사진을 읽지 못했습니다"));
                else resolve(out);
            } catch (e) { URL.revokeObjectURL(url); reject(e); }
        };
        im.onerror = () => { URL.revokeObjectURL(url); reject(new Error("사진 형식이 아닙니다")); };
        im.src = url;
    });
}

// ── 크게 보기 ───────────────────────────────────────────────────────────

let zoomed = null;      // 지울 수 있는 경과 사진이면 { visitId, photoId }

/**
 * 사진을 화면 가득 띄운다.
 *
 * 상담 중에 고객과 같이 보는 자리다. 작은 썸네일로는 결을 볼 수 없고,
 * 손가락으로 가리키며 이야기하려면 커야 한다.
 */
function zoom(url, caption, removable, takenAt) {
    zoomed = removable || null;
    $("crm-zoom-img").src = url;
    // 언제 찍은 것인지가 크게 볼 때 가장 궁금하다
    $("crm-zoom-cap").innerHTML = "<b></b><em></em>";
    $("crm-zoom-cap").querySelector("b").textContent = caption || "";
    $("crm-zoom-cap").querySelector("em").textContent = stamp(takenAt);
    $("crm-zoom-del").hidden = !zoomed;
    $("crm-zoom").hidden = false;
    resetZoom();
}

function closeZoom() {
    $("crm-zoom").hidden = true;
    $("crm-zoom-img").removeAttribute("src");
    zoomed = null;
    resetZoom();
}

/* ── 손가락으로 더 당겨 보기 ─────────────────────────────────────────
 *
 * 화면에 꽉 채워 보여 주는 것만으로는 모자란다. 눈썹 결이 어떻게 앉았는지,
 * 색이 어디부터 빠졌는지는 더 당겨야 보인다. 그게 시술 후 사진을 쌓아 두는
 * 이유이기도 하다.
 *
 * 두 손가락으로 벌리고, 커진 뒤에는 끌어서 옮기고, 두 번 두드리면 오간다.
 * 라이브러리를 들이지 않고 변환 한 줄로 처리한다 — 이 화면에 필요한 것은
 * 그게 전부다.
 */
const ZOOM_MAX = 5;
let zScale = 1, zX = 0, zY = 0;
let zStart = null;

function applyZoom() {
    const im = $("crm-zoom-img");
    im.style.transform =
        "translate(" + zX + "px," + zY + "px) scale(" + zScale + ")";
    im.classList.toggle("is-zoomed", zScale > 1.01);
}

function resetZoom() {
    zScale = 1; zX = 0; zY = 0; zStart = null;
    applyZoom();
}

/** 너무 멀리 밀어 사진이 화면 밖으로 사라지지 않게 잡아 둔다 */
function clampPan() {
    const im = $("crm-zoom-img");
    const r = im.getBoundingClientRect();
    const box = $("crm-zoom").getBoundingClientRect();
    const slackX = Math.max(0, (r.width - box.width) / 2 + 20);
    const slackY = Math.max(0, (r.height - box.height) / 2 + 20);
    zX = Math.max(-slackX, Math.min(slackX, zX));
    zY = Math.max(-slackY, Math.min(slackY, zY));
}

function touchMid(t) {
    return {
        x: (t[0].clientX + t[1].clientX) / 2,
        y: (t[0].clientY + t[1].clientY) / 2,
        d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY),
    };
}

function bindZoomGestures() {
    const im = $("crm-zoom-img");

    im.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) {
            const m = touchMid(e.touches);
            zStart = { kind: "pinch", d: m.d, scale: zScale, x: zX, y: zY, mx: m.x, my: m.y };
            e.preventDefault();
        } else if (e.touches.length === 1 && zScale > 1.01) {
            zStart = { kind: "pan", x: zX, y: zY,
                       px: e.touches[0].clientX, py: e.touches[0].clientY };
            e.preventDefault();
        }
    }, { passive: false });

    im.addEventListener("touchmove", (e) => {
        if (!zStart) return;
        if (zStart.kind === "pinch" && e.touches.length === 2) {
            const m = touchMid(e.touches);
            const k = m.d / (zStart.d || 1);
            zScale = Math.max(1, Math.min(ZOOM_MAX, zStart.scale * k));
            // 손가락 사이를 붙잡은 채로 커지게 한다
            zX = zStart.x + (m.x - zStart.mx);
            zY = zStart.y + (m.y - zStart.my);
            clampPan();
            applyZoom();
            e.preventDefault();
        } else if (zStart.kind === "pan" && e.touches.length === 1) {
            zX = zStart.x + (e.touches[0].clientX - zStart.px);
            zY = zStart.y + (e.touches[0].clientY - zStart.py);
            clampPan();
            applyZoom();
            e.preventDefault();
        }
    }, { passive: false });

    im.addEventListener("touchend", () => {
        zStart = null;
        if (zScale <= 1.01) resetZoom();
    });

    // 두 번 두드리면 오간다 (한 손으로 볼 때)
    let lastTap = 0;
    im.addEventListener("click", (e) => {
        const now = Date.now();
        if (now - lastTap < 320) {
            if (zScale > 1.01) resetZoom();
            else { zScale = 2.5; zX = 0; zY = 0; applyZoom(); }
            lastTap = 0;
        } else {
            lastTap = now;
        }
        e.stopPropagation();       // 바깥을 눌러 닫는 것과 섞이지 않게
    });
}

async function removeZoomed() {
    if (!zoomed) return;
    const ok = window.confirm("이 경과 사진을 지울까요?");
    if (!ok) return;
    const { visitId, photoId } = zoomed;
    closeZoom();
    await Store.removeAfterPhoto(visitId, photoId);
    if (viewing) await openCard(viewing.id);
}

// ── 리터치 예정일 ───────────────────────────────────────────────────────

let retouching = null;

function openRetouch(v) {
    retouching = v;
    const what = v.area === "lip" ? "입술" : "눈썹";
    $("crm-retouch-who").textContent =
        ymd(v.date) + " " + what + " 시술 기준으로 언제 다시 볼까요?";

    const box = $("crm-retouch-quick");
    box.innerHTML = "";
    for (const c of RETOUCH_CHOICES) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = c.label;
        // 눈썹·입술 모두 첫 리터치는 한 달이 보통이라 그 버튼을 미리 켜 둔다
        if (c.days === RETOUCH_DEFAULT_DAYS) b.className = "is-active";
        b.addEventListener("click", () => {
            box.querySelectorAll("button").forEach((x) => x.classList.remove("is-active"));
            b.classList.add("is-active");
            $("crm-retouch-date").value = isoDay(startOfDay(v.date + c.days * DAY));
        });
        box.appendChild(b);
    }

    const at = v.retouchAt || startOfDay(v.date + RETOUCH_DEFAULT_DAYS * DAY);
    $("crm-retouch-date").value = isoDay(at);
    open("retouch");
}

function isoDay(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

async function saveRetouch(at) {
    if (!retouching) return;
    const v = await Store.setRetouch(retouching.id, at);
    // 예정일이 바뀌면 먼저 걸어 둔 알림을 지우고 새로 건다
    if (Remind.available()) {
        if (at) await Remind.ensurePermission();
        await Remind.schedule(v, viewing);
    }
    retouching = null;
    if (viewing) await openCard(viewing.id);
    await paintPlanCount();
}

// ── 관리 일정 ───────────────────────────────────────────────────────────

let planSpan = 14;

async function paintPlan() {
    const now = Date.now();
    const opt = planSpan
        ? { from: startOfDay(now) - 30 * DAY, to: startOfDay(now) + planSpan * DAY }
        : {};
    const list = await Store.getSchedule(opt);

    const box = $("crm-plan");
    box.innerHTML = "";
    if (!list.length) {
        const p = document.createElement("p");
        p.className = "crm-empty";
        p.textContent = "이 기간에 예정된 관리가 없습니다.";
        box.appendChild(p);
        return;
    }

    let lastMonth = "";
    for (const it of list) {
        const m = new Date(it.retouchAt);
        const key = m.getFullYear() + "." + (m.getMonth() + 1);
        if (key !== lastMonth) {
            lastMonth = key;
            const h = document.createElement("div");
            h.className = "crm-plan-month";
            h.textContent = m.getFullYear() + "년 " + (m.getMonth() + 1) + "월";
            box.appendChild(h);
        }

        const row = document.createElement("button");
        row.type = "button";
        row.className = "crm-plan-row" + (isSoon(it.retouchAt) ? " is-soon" : "");
        row.innerHTML = '<span class="crm-plan-day"></span>' +
                        '<span class="crm-plan-who"></span>' +
                        '<span class="crm-plan-when"></span>';
        row.querySelector(".crm-plan-day").textContent = new Date(it.retouchAt).getDate() + "일";
        row.querySelector(".crm-plan-who").textContent =
            it.name + " · " + (it.area === "lip" ? "입술" : "눈썹");
        row.querySelector(".crm-plan-when").textContent = until(it.retouchAt);
        row.addEventListener("click", () => openCard(it.customerId));
        box.appendChild(row);
    }
}

/** 고객 줄의 종 옆에 붙는 숫자 — 닷새 안에 챙길 것이 몇 건인지 */
async function paintPlanCount() {
    const now = Date.now();
    const soon = await Store.getSchedule({
        from: startOfDay(now) - 30 * DAY,
        to: startOfDay(now) + 5 * DAY,
    });
    const el = $("crm-plan-count");
    el.textContent = soon.length ? String(soon.length) : "일정";
    $("crm-plan-open").classList.toggle("is-soon", soon.length > 0);
}

/** 앱을 열 때 — 걸려 있어야 할 알림을 다시 맞춘다 */
export async function syncReminders() {
    if (!Remind.available()) return 0;
    const list = await Store.getSchedule({ from: Date.now() });
    let n = 0;
    for (const it of list) {
        const v = await Store.getVisit(it.visitId);
        const c = await Store.getCustomer(it.customerId);
        n += await Remind.schedule(v, c);
    }
    return n;
}

// ── 저장: 시뮬레이션 결과를 이력으로 ────────────────────────────────────

/**
 * 시뮬레이션 결과를 이력으로 남긴다.
 *
 * 상담이 두 갈래로 시작하니 저장도 두 갈래다.
 *   재방문  고객이 이미 정해져 있다 → 바로 남기고 카드를 연다
 *   첫 방문 고객이 없다 → 누구 것인지 먼저 고르게 하고, 고르는 순간 남긴다
 *
 * 두 번째가 중요하다. '고객을 먼저 고르세요' 하고 끝내면 원장님은 결과를
 * 잃고 처음부터 다시 해야 한다. 결과를 손에 쥔 채 고르게 한다.
 *
 * @param {{area:"brow"|"lip", label?:string, before?:string, sim?:string}} r
 */
let pendingResult = null;

export async function saveResult(r) {
    pendingResult = r;
    if (current) return commitResult(current);

    // 누구 것인지부터 고른다. 고르거나 새로 만들면 그때 남는다.
    $("crm-q").value = "";
    await paintList();
    open("list");
    $("crm-list").insertAdjacentHTML("afterbegin",
        '<p class="crm-pending">저장할 고객을 고르세요. 새 손님이면 아래 <b>＋ 새 고객</b>.</p>');
    setTimeout(() => $("crm-q").focus(), 60);
    return null;
}

async function commitResult(customer) {
    const r = pendingResult;
    pendingResult = null;
    if (!r || !customer) return null;

    const now = Date.now();
    const visit = {
        customerId: customer.id,
        date: now,
        area: r.area,
        // 눈썹은 디자인 이름, 입술은 색 이름이 온다
        design: r.area === "brow" ? (r.label || "") : "",
        color: r.area === "lip" ? (r.label || "") : "",
        // 리터치는 눈썹·입술 모두 한 달 뒤가 보통이라 미리 잡아 둔다.
        // 카드에서 버튼 한 번으로 바꿀 수 있다.
        retouchAt: defaultRetouch(now),
    };
    const shots = {};
    if (r.before) shots.before = r.before;
    if (r.sim) shots.sim = r.sim;

    const rec = await Store.saveVisit(visit, shots);

    if (Remind.available()) {
        await Remind.ensurePermission();
        await Remind.schedule(rec, customer);
    }

    const visits = await Store.getVisits(customer.id);
    setCurrent({ ...customer, visitCount: visits.length });
    await openCard(customer.id);
    await paintPlanCount();
    return rec;
}

// ── 연결 ────────────────────────────────────────────────────────────────

export function init(opts = {}) {
    onChange = opts.onChange || (() => {});
    onStart = opts.onStart || (() => {});

    $("crm-find").addEventListener("click", async () => {
        $("crm-q").value = "";
        await paintList();
        open("list");
        setTimeout(() => $("crm-q").focus(), 60);
    });

    $("crm-detach").addEventListener("click", () => setCurrent(null));

    $("crm-q").addEventListener("input", () => {
        // 한 글자마다 훑으면 손이 느려진다. 잠깐 멈추면 그때 찾는다.
        clearTimeout(findTimer);
        findTimer = setTimeout(paintList, 160);
    });

    $("crm-new").addEventListener("click", () => openEdit(null));
    $("crm-close").addEventListener("click", close);
    $("crm-back").addEventListener("click", async () => {
        releaseUrls();
        await paintList();
        open("list");
    });
    $("crm-edit").addEventListener("click", () => openEdit(viewing));
    $("crm-edit-cancel").addEventListener("click", () => {
        if (editing) openCard(editing.id);
        else { paintList(); open("list"); }
    });
    $("crm-save").addEventListener("click", saveEdit);
    $("crm-delete").addEventListener("click", removeCustomer);

    $("crm-start").addEventListener("click", () => {
        if (!viewing) return;
        setCurrent(viewing);
        close();
        onStart(viewing);
    });

    // ── 사진 ──
    $("crm-shot-file").addEventListener("change", onShotPicked);
    $("crm-zoom-close").addEventListener("click", closeZoom);
    bindZoomGestures();
    $("crm-zoom-del").addEventListener("click", removeZoomed);
    $("crm-zoom").addEventListener("click", (e) => {
        // 사진 바깥을 누르면 닫는다
        if (e.target === $("crm-zoom")) closeZoom();
    });

    // ── 리터치 예정일 ──
    $("crm-retouch-cancel").addEventListener("click", () => {
        retouching = null;
        if (viewing) openCard(viewing.id);
    });
    $("crm-retouch-off").addEventListener("click", () => saveRetouch(null));
    $("crm-retouch-save").addEventListener("click", () => {
        const v = $("crm-retouch-date").value;
        if (!v) { saveRetouch(null); return; }
        // 날짜 입력은 '2026-10-14' 로 온다. 그날 0시로 맞춰 담는다.
        const [y, m, d] = v.split("-").map(Number);
        saveRetouch(new Date(y, m - 1, d, 0, 0, 0, 0).getTime());
    });

    // ── 관리 일정 ──
    $("crm-plan-open").addEventListener("click", async () => {
        await paintPlan();
        open("plan");
    });
    $("crm-plan-close").addEventListener("click", close);
    document.querySelectorAll(".crm-plan-tabs button").forEach((b) => {
        b.addEventListener("click", async () => {
            document.querySelectorAll(".crm-plan-tabs button")
                .forEach((x) => x.classList.remove("is-active"));
            b.classList.add("is-active");
            planSpan = Number(b.dataset.span) || 0;
            await paintPlan();
        });
    });

    // 알림을 누르면 그 고객 카드를 연다
    Remind.onTap((customerId) => {
        openCard(customerId);
    });

    paintBar();
}

/** 고객 줄을 보일지 (라이선스로 잠글 수 있게 밖에서 정한다) */
export function setEnabled(on) {
    $("crm-bar").hidden = !on;
    if (!on) { setCurrent(null); return; }
    // 닷새 안에 챙길 것이 몇 건인지 종 옆에 띄운다
    paintPlanCount();
}
