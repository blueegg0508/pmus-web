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
    // 뒤에서 확인한다. 받으면 — 작업 중이 아니면 바로, 작업 중이면 끝난 뒤에 적용한다.
    watchForUpdate();
    checkUpdate().then(applyIfIdle).catch(() => {});
}

/**
 * 지금 새 버전을 적용해도 되는가 — 사진을 고르기 전 첫 화면(또는 라이선스 화면)일 때만.
 * 사진을 골랐거나 편집 중이면 화면이 새로 뜨면서 작업이 날아가므로 기다린다.
 */
function isIdle() {
    if (document.visibilityState !== "visible") return false;
    if (document.body.classList.contains("sim-fullscreen")) return false;    // 편집 중
    const drop = $("drop-zone");
    const preview = $("photo-preview");
    const gate = $("license-gate");
    if (gate && !gate.hidden) return true;                                   // 라이선스 등록 화면
    return !!(drop && !drop.hidden && (!preview || preview.hidden));         // 사진 고르기 전
}

/** 받아 둔 새 버전이 있고 작업 중이 아니면 바로 적용한다 */
function applyIfIdle() {
    if (registration && registration.waiting && navigator.serviceWorker.controller && isIdle()) {
        applyUpdate();
    }
}

let watching = false;
function watchForUpdate() {
    if (watching || !registration) return;
    watching = true;
    // 새 버전을 다 받으면
    registration.addEventListener("updatefound", () => {
        const w = registration.installing;
        if (!w) return;
        w.addEventListener("statechange", () => {
            if (w.state === "installed") applyIfIdle();
        });
    });
    // 안드로이드는 앱을 닫아도 뒤에 살아 있다가 그대로 돌아온다 — 돌아올 때마다 다시 확인
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        applyIfIdle();
        checkUpdate().then(applyIfIdle).catch(() => {});
    });
    // 편집을 마치고 첫 화면으로 돌아오면 그때 적용 (30초마다 살핀다)
    setInterval(applyIfIdle, 30000);
    // 오래 켜 둔 채 쓰는 경우를 위해 30분마다 새 버전 확인
    setInterval(() => { if (document.visibilityState === "visible") registration.update().catch(() => {}); }, 30 * 60 * 1000);
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
/** 지금 이 화면의 판 번호 (스크립트 주소의 ?v=NN) */
function currentBuild() {
    const s = document.querySelector('script[src*="app.js?v="]');
    const m = s && s.getAttribute("src").match(/v=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

/**
 * 서버에 올라간 최신 판 번호.
 * 깃허브 페이지 서버는 sw.js 를 최대 10분 들고 있다가 내준다. 그래서 올린 직후에
 * registration.update() 만 하면 예전 sw.js 를 받아 '최신 버전입니다' 가 나왔다 (2026-10-11).
 * 주소 끝에 매번 다른 값을 붙이면 서버가 들고 있던 것을 건너뛰고 새로 준다.
 */
async function serverBuild() {
    try {
        const r = await fetch("sw.js?fresh=" + Date.now(), { cache: "no-store" });
        const m = (await r.text()).match(/const VERSION = "[a-z]+-(\d+)"/);
        return m ? parseInt(m[1], 10) : 0;
    } catch (e) { return 0; }
}

async function checkUpdate() {
    if (!registration) return "unsupported";
    const latest = await serverBuild();
    try {
        if (latest > currentBuild()) {
            // 서버에 새 판이 있다 — 매번 다른 주소로 다시 등록해 그 판을 확실히 받는다
            registration = await navigator.serviceWorker.register("sw.js?v=" + latest);
        } else {
            await registration.update();
        }
    } catch (e) { /* 인터넷이 없으면 그대로 */ }
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

// ── 앱 설치 화면 (2026-10-27 원장님) ────────────────────────────────────
// 폰 · 태블릿을 브라우저 탭으로 열면 앱을 쓰지 않고 설치 화면만 보여 준다.
// 홈 화면 앱은 주소창 · 탭 없이 전체 화면으로 열린다.
// 버튼 하나를 누르면 지금 운영체제 · 브라우저에 맞는 방법으로 설치한다:
//   · 안드로이드 크롬 · 엣지      → 설치 창을 바로 띄운다 (beforeinstallprompt)
//   · 안드로이드 삼성 인터넷 · 다른 앱 안 → 크롬으로 이 주소를 연다 (거기서 다시 버튼)
//   · 카카오톡 안 (아이폰 · 안드로이드) → 바깥 브라우저로 연다
//   · 아이폰 · 아이패드          → 웹으로는 설치 창을 띄울 수 없어(애플 제한),
//                                  공유 버튼 자리를 화살표로 가리킨다

const isIPad = isIOS && !/iPhone|iPod/.test(ua);
const inKakao = /KAKAOTALK/i.test(ua);
const inOtherApp = /NAVER\(inapp|; ?NAVER|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp|BAND\/|; wv\)/i.test(ua);
const isSamsung = /SamsungBrowser/i.test(ua);
const isIOSChrome = isIOS && /CriOS|EdgiOS|FxiOS/i.test(ua);
// iOS 26 사파리(아이폰)는 공유 버튼이 아래 ⋯ 메뉴 안으로 들어갔다 (Version/26)
const safariVer = parseInt((ua.match(/Version\/(\d+)/) || [])[1] || "0", 10);

let installEvent = null;

function gateSay(html) {
    const sub = $("pwa-gate-sub");
    if (!sub) return;
    sub.innerHTML = html;
    sub.hidden = !html;
}

function openInChrome() {
    location.href = "intent://" + location.host + location.pathname + location.search
        + "#Intent;scheme=https;package=com.android.chrome;end";
}

function pointAt(where, text) {
    const arrow = $("pwa-point-arrow");
    arrow.className = "pwa-point-arrow " + where;
    if (text) $("pwa-point-1").innerHTML = text;
    $("pwa-point").hidden = false;
}

const SHARE = '<span class="pwa-k">공유 <span class="pwa-share" aria-hidden="true"></span></span>';

async function onInstallClick() {
    // 1) 카카오톡 안 — 아이폰 · 안드로이드 모두 바깥 브라우저로
    if (inKakao) {
        location.href = "kakaotalk://web/openExternal?url=" + encodeURIComponent(location.href);
        gateSay("브라우저가 열리면 거기서 <b>PMUS 앱 설치하기</b>를 한 번 더 눌러 주세요.");
        return;
    }
    if (isAndroid) {
        // 2) 크롬 · 엣지: 설치 창을 바로
        if (installEvent) {
            installEvent.prompt();
            let ok = false;
            try { ok = (await installEvent.userChoice).outcome === "accepted"; } catch (e) {}
            installEvent = null;
            if (ok) gateSay("설치하고 있습니다. 끝나면 <b>홈 화면의 PMUS 아이콘</b>으로 여세요.");
            return;
        }
        // 3) 삼성 인터넷 · 네이버 · 인스타 등 앱 안: 크롬으로 연다 (삼성 인터넷 설치 앱은 앨범이 바로 안 열린다)
        if (isSamsung || inOtherApp || !/Chrome\//.test(ua)) {
            openInChrome();
            gateSay("<b>크롬</b>이 열리면 거기서 <b>PMUS 앱 설치하기</b>를 한 번 더 눌러 주세요.");
            return;
        }
        // 4) 크롬인데 설치 창이 안 온다 — 이미 설치했거나, 크롬이 아직 준비 중
        if (await alreadyInstalled()) {
            gateSay("이미 설치되어 있습니다. <b>홈 화면의 PMUS 아이콘</b>을 눌러 여세요.");
            return;
        }
        pointAt("up right", '오른쪽 위 <span class="pwa-k">⋮</span> 를 누르고 <span class="pwa-k">앱 설치</span> (또는 홈 화면에 추가 → <b>설치</b>)');
        return;
    }
    if (isIOS) {
        // 5) 네이버 · 인스타 등 앱 안에서는 홈 화면에 추가가 없다 → 사파리로 바로 연다 (iOS 17+)
        if (inOtherApp) {
            location.href = "x-safari-" + location.href;
            gateSay("사파리가 열리지 않으면 화면 아래나 위의 메뉴(<b>⋯</b>)에서 <b>Safari로 열기</b>를 눌러 주세요.");
            return;
        }
        // 6) 사파리 · 크롬: 공유 버튼 자리를 가리킨다
        if (isIPad || isIOSChrome) pointAt("up right", "화살표가 가리키는 " + SHARE + " 버튼을 누르세요");
        else pointAt("down center", "화면 아래 " + SHARE + " 버튼을 누르세요<br><small>(안 보이면 아래 <b>⋯</b> 버튼 → 공유)</small>");
    }
}

/** 크롬: 이 앱이 이미 설치되어 있나 (manifest 의 related_applications) */
async function alreadyInstalled() {
    try {
        if (!navigator.getInstalledRelatedApps) return false;
        return (await navigator.getInstalledRelatedApps()).length > 0;
    } catch (e) { return false; }
}

/**
 * 아이폰 · 아이패드: 버튼을 누를 것 없이 바로 3단계 그림 + 공유 버튼을 가리키는 화살표.
 * 공유 버튼 자리는 기기 · 브라우저마다 다르다.
 */
function showIOSSteps() {
    $("pwa-install-go").hidden = true;
    $("pwa-install-title").textContent = "홈 화면에 추가하면 끝";
    $("pwa-gate-desc").innerHTML = "세 번만 누르면 PMUS 아이콘이 생기고,<br>주소창 없이 전체 화면 앱으로 열립니다.";
    const arrow = $("pwa-point-arrow");
    const one = $("pwa-ios-1");
    const SH = '<span class="pwa-k">공유 <span class="pwa-share" aria-hidden="true"></span></span>';
    if (isIPad || isIOSChrome) {
        arrow.className = "pwa-point-arrow up right";
        one.innerHTML = (isIOSChrome ? "주소창 오른쪽 " : "오른쪽 위 ") + SH + " 버튼을 누르세요 (화살표)";
    } else if (safariVer >= 26) {
        arrow.className = "pwa-point-arrow down right";
        one.innerHTML = '화면 아래 오른쪽 <span class="pwa-k">⋯</span> 을 누르고 ' + SH + " 를 누르세요";
    } else {
        arrow.className = "pwa-point-arrow down center";
        one.innerHTML = "화면 아래 가운데 " + SH + " 버튼을 누르세요 (화살표)";
    }
    // 화살표만 설치 화면 위에 띄운다 (안내 카드는 설치 화면 안에 있다)
    $("pwa-install").appendChild(arrow);
    $("pwa-ios").hidden = false;
    $("pwa-install").classList.add("is-ios");
}

function showInstallGuide() {
    const el = $("pwa-install");
    if (el) el.hidden = false;
}

function bindInstallGuide() {
    if (isAndroid) {
        window.addEventListener("beforeinstallprompt", (e) => {
            e.preventDefault();
            installEvent = e;
        });
        window.addEventListener("appinstalled", () => {
            gateSay("설치가 끝났습니다. 이 창은 닫고 <b>홈 화면의 PMUS 아이콘</b>으로 여세요.");
        });
    }
    const go = $("pwa-install-go");
    if (go) go.addEventListener("click", onInstallClick);
    const pc = $("pwa-point-close");
    if (pc) pc.addEventListener("click", () => { $("pwa-point").hidden = true; });

    // 폰 · 태블릿을 브라우저 탭으로 열었으면 설치 화면만 보여 준다 (PC 는 그대로 쓴다)
    if ((isIOS || isAndroid) && !isStandalone()) {
        showInstallGuide();
        if (inKakao || (isIOS && inOtherApp)) {
            $("pwa-gate-desc").innerHTML = "지금은 다른 앱 안에서 열렸습니다.<br>버튼을 누르면 브라우저로 옮겨 설치를 이어 갑니다.";
        } else if (isIOS) {
            showIOSSteps();
        }
    }
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
    showInstallGuide: () => showInstallGuide(),
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
