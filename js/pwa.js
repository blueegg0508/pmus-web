/**
 * pwa.js — 웹앱(아이폰·아이패드·안드로이드 크롬, 홈 화면에 추가)으로 열렸을 때만 하는 일
 * =========================================================================
 * 아이폰은 앱스토어 밖에서 앱을 깔 수 없다. 그래서 같은 앱을 인터넷 주소로
 * 열어 '홈 화면에 추가' 해서 쓴다. 안드로이드 앱(Capacitor) 안에서는
 * window.Capacitor 가 있으므로 여기 있는 것은 하나도 돌지 않는다.
 *
 *   · 서비스 워커를 올려 한 번 연 뒤로는 인터넷 없이도 열리게 한다 (sw.js)
 *   · 새 버전은 뒤에서 받아 두고, 앱을 새로 열 때 적용한다
 *     (상담 도중에 화면이 바뀌면 안 된다)
 *   · 사파리로 열었는데 아직 홈 화면에 없으면 추가하는 법을 보여 준다
 *   · 사진 저장: 아이폰은 웹에서 사진첩에 바로 못 쓴다. 공유 창을 띄워
 *     '이미지 저장' 을 누르게 한다
 *
 * app.js 는 window.PMUSWeb 로 부른다.
 * =========================================================================
 */

const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform
    ? window.Capacitor.isNativePlatform()
    : window.Capacitor);

const ua = navigator.userAgent || "";
// 아이패드는 데스크톱 사파리처럼 자신을 밝힌다 — 터치 지점 수로 가린다
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(ua);
const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

const $ = (id) => document.getElementById(id);

let registration = null;

// ── 서비스 워커 ──────────────────────────────────────────────────────────

async function registerWorker() {
    if (!("serviceWorker" in navigator)) return;
    // http 로는 서비스 워커가 안 된다 (내 PC 에서 시험할 때 127.0.0.1 은 예외)
    if (location.protocol !== "https:" && location.hostname !== "127.0.0.1"
        && location.hostname !== "localhost") return;
    try {
        registration = await navigator.serviceWorker.register("sw.js");
    } catch (e) {
        console.warn("서비스 워커를 올리지 못했습니다", e);
        return;
    }

    // 앱을 새로 열었는데 이미 받아 둔 새 버전이 있으면 지금 적용한다.
    // 아직 아무것도 시작하지 않았을 때라 화면이 한 번 새로 떠도 괜찮다.
    if (registration.waiting && navigator.serviceWorker.controller) {
        applyUpdate();
        return;
    }
    // 뒤에서 확인만 해 둔다. 받으면 다음에 열 때 적용된다.
    registration.update().catch(() => {});
}

// 새 버전을 적용하면(SKIP_WAITING) 화면을 한 번 새로 띄운다.
// 처음 연 날에는 sw.js 가 clients.claim 을 하지 않으므로 이 일이 생기지 않는다.
let reloading = false;
if (!isNative && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloading) return;
        reloading = true;
        location.reload();
    });
}

/** 받아 둔 새 버전을 적용한다 (화면이 한 번 새로 뜬다) */
function applyUpdate() {
    const w = registration && registration.waiting;
    if (!w) return false;
    w.postMessage({ type: "SKIP_WAITING" });
    return true;
}

/**
 * 새 버전이 있는지 본다.
 * @returns {Promise<"latest"|"ready"|"unsupported">}
 *   ready = 새 버전을 받아 두었다. applyUpdate() 를 부르면 적용된다.
 */
async function checkUpdate() {
    if (!registration) return "unsupported";
    try { await registration.update(); } catch (e) { /* 인터넷이 없으면 그대로 */ }
    // 받는 중이면 끝날 때까지 잠깐 기다린다
    const installing = registration.installing;
    if (installing) {
        await new Promise((ok) => {
            const done = () => { if (installing.state !== "installing") ok(); };
            installing.addEventListener("statechange", done);
            setTimeout(ok, 20000);
        });
    }
    return registration.waiting ? "ready" : "latest";
}

// ── 홈 화면에 추가 안내 ──────────────────────────────────────────────────

function showInstallGuide(force) {
    const el = $("pwa-install");
    if (!el) return;
    if (!force) {
        try { if (sessionStorage.getItem("pwa.guideSeen")) return; } catch (e) {}
    }
    el.hidden = false;
    try { sessionStorage.setItem("pwa.guideSeen", "1"); } catch (e) {}
}

// 안드로이드 크롬은 설치 창을 직접 띄울 수 있다 (beforeinstallprompt).
// 그 기회를 잡아 두었다가 [PMUS 앱 설치] 버튼으로 연다.
let installEvent = null;

function bindInstallGuide() {
    const close = $("pwa-install-close");
    if (close) close.addEventListener("click", () => { $("pwa-install").hidden = true; });

    if (isAndroid) {
        $("pwa-guide-ios").hidden = true;
        $("pwa-guide-android").hidden = false;
        window.addEventListener("beforeinstallprompt", (e) => {
            e.preventDefault();
            installEvent = e;
            $("pwa-install-go").hidden = false;
            $("pwa-install-or").hidden = false;
        });
        $("pwa-install-go").addEventListener("click", async () => {
            if (!installEvent) return;
            installEvent.prompt();
            try { await installEvent.userChoice; } catch (e) {}
            installEvent = null;
            $("pwa-install-go").hidden = true;
        });
        window.addEventListener("appinstalled", () => { $("pwa-install").hidden = true; });
    }

    // 브라우저로 열었고 아직 홈 화면 앱이 아니면 안내한다
    if ((isIOS || isAndroid) && !isStandalone()) showInstallGuide(false);
}

// ── 사진 저장 (공유 창) ──────────────────────────────────────────────────

/** 공유 창으로 그림 파일을 넘길 수 있는 브라우저인지 */
function canShareImages() {
    if (!navigator.canShare || !window.File) return false;
    try {
        const f = new File([new Uint8Array([137, 80, 78, 71])], "t.png", { type: "image/png" });
        return navigator.canShare({ files: [f] });
    } catch (e) {
        return false;
    }
}

async function dataUrlToFile(dataUrl, filename) {
    const blob = await (await fetch(dataUrl)).blob();
    return new File([blob], filename, { type: blob.type || "image/png" });
}

let pending = [];

/**
 * 저장할 그림들을 받아 '사진 앱에 저장' 창을 띄운다.
 *
 * 공유 창은 **사람이 방금 누른 뒤에만** 열린다. 시뮬레이터 안의 저장 버튼을
 * 누르고 그림을 만드는 사이에 그 '방금' 이 지나 버리므로, 여기서 한 번 더
 * 누르게 한다. 그 누름으로 공유 창을 연다.
 */
function saveImages(jobs) {
    pending = pending.concat(jobs);
    const sheet = $("pwa-save");
    if (!sheet) return;
    $("pwa-save-count").textContent = pending.length === 1 ? "사진 1장" : "사진 " + pending.length + "장";
    sheet.hidden = false;
}

async function shareNow() {
    const jobs = pending;
    pending = [];
    $("pwa-save").hidden = true;
    if (!jobs.length) return;
    try {
        const files = await Promise.all(jobs.map((j) => dataUrlToFile(j.dataUrl, j.filename)));
        await navigator.share({ files });
    } catch (e) {
        if (e && e.name === "AbortError") return;   // 사람이 닫았다
        // 공유가 막히면 내려받기로라도
        jobs.forEach((j) => {
            const a = document.createElement("a");
            a.href = j.dataUrl;
            a.download = j.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
        });
    }
}

function bindSaveSheet() {
    const go = $("pwa-save-go");
    const cancel = $("pwa-save-cancel");
    if (go) go.addEventListener("click", shareNow);
    if (cancel) cancel.addEventListener("click", () => { pending = []; $("pwa-save").hidden = true; });
}

// ── 시작 ────────────────────────────────────────────────────────────────

window.PMUSWeb = {
    isWeb: !isNative,
    isIOS,
    isAndroid,
    isStandalone,
    canShareImages,
    saveImages,
    checkUpdate,
    applyUpdate,
    showInstallGuide: () => showInstallGuide(true),
};

if (!isNative) {
    bindInstallGuide();
    bindSaveSheet();
    registerWorker();
    // 아이폰은 오래 안 쓴 웹앱의 저장소를 비울 수 있다. 남겨 달라고 부탁해 둔다.
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
    }
}
