/**
 * app.js — 브로우리스트 모바일 앱 셸
 * =========================================================================
 * Streamlit 이 하던 역할(사진 업로드, 디자인 선택, 파이썬 전처리, 컴포넌트
 * 마운트)을 순수 브라우저 코드로 대체합니다.
 *
 * 캔버스 JS 두 벌은 전역 변수명이 겹치므로(canvas, ctx, targetW ...) 데스크톱판
 * 과 동일하게 iframe 으로 격리해 띄웁니다. 원본 코드를 한 줄도 고치지 않고
 * 그대로 쓸 수 있는 방식입니다.
 * =========================================================================
 */

import { initFaceLandmarker, detectFaceGeometry, detectLipLandmarks, standardLipLandmarks, engineStatus } from "./face-detect.js?v=84";
import { buildEyebrowConfig, lastCanvasRequest } from "./prepare-eyebrow.js?v=84";
import * as License from "./license.js?v=84";
import * as Custom from "./custom-designs.js?v=84";
import * as Update from "./update.js?v=84";
import * as Crm from "./crm-ui.js?v=84";

const BUILD = "84";                   // 에셋 캐시 무효화용 (수정 시 올릴 것)
/**
 * 작업용 사진의 최대 변 길이.
 *
 * 사진 한 장이 메모리를 얼마나 먹는지는 픽셀 수에 비례한다.
 * 1500px 짜리 세로 사진이면 픽셀 250만, ImageData 로 펴면 10MB 다.
 * 여기에 원본 캔버스·합성 캔버스·눈썹 레이어·내보내기 캔버스가 겹치면
 * 저사양 기기에서는 금방 한계에 부딪힌다.
 * 기기가 알려주는 메모리 크기에 맞춰 낮춰 잡는다. (모르면 보수적으로)
 */
const MAX_SIZE = (() => {
    const gb = navigator.deviceMemory;          // 크롬 계열만 알려준다
    if (typeof gb !== "number") return 1400;    // 모르면 중간값
    if (gb <= 2) return 1000;
    if (gb <= 4) return 1200;
    return 1500;
})();
const DEFAULT_BROW_COLOR = "#3D2B1F";
const DEFAULT_LIP_COLOR  = "#E25B6F";

const EYEBROW_DESIGNS = [
    { file: "female_arch_natural.png",       label: "아치 · 내추럴" },
    { file: "female_arch_gradation.png",     label: "아치 · 그라데이션" },
    { file: "female_arch_combo.png",         label: "아치 · 콤보" },
    { file: "female_semiarch_natural.png",   label: "세미아치 · 내추럴" },
    { file: "female_semiarch_gradation.png", label: "세미아치 · 그라데이션" },
    { file: "female_semiarch_combo.png",     label: "세미아치 · 콤보" },
    { file: "female_straight_natural.png",   label: "일자 · 내추럴" },
    { file: "female_straight_gradation.png", label: "일자 · 그라데이션" },
    { file: "female_straight_combo.png",     label: "일자 · 콤보" },
    { file: "male_straight_natural.png",     label: "남성 일자 · 내추럴" },
    { file: "male_straight_gradation.png",   label: "남성 일자 · 그라데이션" },
    { file: "male_straight_combo.png",       label: "남성 일자 · 콤보" },
];

/** 직접 등록한 디자인은 state.design 에 "custom:<id>" 로 들어간다. */
const CUSTOM_PREFIX = "custom:";

/** 이어서 쓸 밑그림을 몇 장까지 들고 있을지. 많이 쌓으면 그것만으로 메모리를 먹는다. */
const MAX_BASES = 6;
let customDesigns = [];          // 화면에 뿌린 등록 디자인 목록 (buildDesignGrid 가 채운다)

/** 얼굴 인식을 건너뛰고 기본 입술선으로 시작할지. 기기별 설정이라 저장해 둔다. */
const STANDARD_LIP_KEY = "bl.standardLipOnly";
function loadStandardLipOnly() {
    try { return localStorage.getItem(STANDARD_LIP_KEY) === "1"; } catch (e) { return false; }
}
function saveStandardLipOnly(v) {
    try { localStorage.setItem(STANDARD_LIP_KEY, v ? "1" : "0"); } catch (e) {}
}

/** 편집 방식. 퀵은 바로 조절, 메뉴얼은 디자인 선택 + 세부 조정. */
/** 앱을 켜면 언제나 퀵으로 시작한다.
 *  현장에서는 대부분 퀵으로 쓰고, 세부 작업이 필요할 때만 메뉴얼로 넘어간다.
 *  지난번에 메뉴얼로 끝냈다고 다음 손님까지 메뉴얼로 시작할 이유는 없다. */
function loadEditMode() {
    return "quick";
}
function saveEditMode() { /* 켤 때마다 퀵으로 시작하므로 남겨둘 것이 없다 */ }

const state = {
    photo: null,          // HTMLImageElement (리사이즈 완료)
    photoDataUrl: null,
    // '맨얼굴 위에 그 부위만 얹은 그림' 들. 다른 부위를 편집할 때 배경으로
    // 깔아 두 시술을 한 화면에 같이 보여준다. 여러 장이 쌓이면 그중에서
    // 이어서 쓸 것을 고른다.
    // 자기 부위는 절대 배경에 굽지 않으므로, 눈썹↔입술을 몇 번 오가도
    // 같은 시술이 두 번 겹쳐 그려지지 않는다.
    bases: [],
    baseChoice: null,     // 고른 밑그림의 id ("orig" 면 맨얼굴)

    eyes: null,           // detectFaceGeometry().eyes
    brows: null,          // detectFaceGeometry().brows — 실제로 잰 눈썹 자리
    lipInfo: null,        // detectLipLandmarks 결과
    mode: "brow",
    design: EYEBROW_DESIGNS[0].file,
    lic: null,          // License.getLicense() 결과
    mountedKind: null,  // 지금 iframe 에 떠 있는 시뮬레이터 ("brow" | "lip" | null)
    standardLipOnly: loadStandardLipOnly(),   // 인식 건너뛰고 기본 입술선으로
    editMode: loadEditMode(),                 // "quick" | "manual"
};

const $ = (id) => document.getElementById(id);

// ── 유틸 ────────────────────────────────────────────────────────────────

function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/**
 * 네이티브 스플래시(브로우리스트 로고)를 내린다.
 * launchAutoHide:false 로 띄워두었기 때문에 여기서 직접 내려야 하고,
 * 초기화 중 예외가 나도 화면이 갇히지 않도록 안전 타이머를 함께 건다.
 */
let splashHidden = false;
const SPLASH_MIN_MS = 1000;          // 로고를 최소 1초는 보여준다
const splashShownAt = Date.now();

function hideSplash() {
    if (splashHidden) return;
    // 준비가 1초보다 빨리 끝나면 남은 시간만큼 로고를 더 띄워 둔다.
    const left = SPLASH_MIN_MS - (Date.now() - splashShownAt);
    if (left > 0) { setTimeout(hideSplash, left); return; }

    splashHidden = true;
    const p = globalThis.Capacitor && globalThis.Capacitor.Plugins;
    if (p && p.SplashScreen) p.SplashScreen.hide({ fadeOutDuration: 260 }).catch(() => {});
}
setTimeout(hideSplash, 8000);   // 어떤 이유로든 준비가 안 끝나면 8초 뒤 강제로 내린다

function showLoading(text) {
    $("loading-text").textContent = text;
    $("canvas-loading").hidden = false;
}
function hideLoading() { $("canvas-loading").hidden = true; }

/**
 * 파일 → 작업용으로 줄인 이미지 + dataURL
 *
 * 메모리를 아끼려고 두 가지를 지킨다.
 *   · 원본 파일을 base64 로 통째로 들고 있지 않는다. FileReader 로 읽으면
 *     4000×3000 사진이 8MB 짜리 문자열(자바스크립트 안에서는 그 두 배)로
 *     남는다. objectURL 로 넘기고 다 쓰면 바로 놓아준다.
 *   · 결과를 PNG 가 아니라 JPEG 로 만든다. 사진을 PNG 로 담으면
 *     실측 2256KB, JPEG 로는 296KB — 7.6배 차이다. 이 문자열은 앱 셸과
 *     시뮬레이터 양쪽에 여러 벌 복사되므로 차이가 그대로 누적된다.
 *     (눈썹·입술 레이어는 투명이 필요하므로 그대로 PNG 를 쓴다)
 */
function loadCustomerImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();

        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이미지 형식이 아닙니다")); };
        img.onload = () => {
            let { naturalWidth: w, naturalHeight: h } = img;
            const scale = Math.min(1, MAX_SIZE / Math.max(w, h));
            w = Math.round(w * scale);
            h = Math.round(h * scale);

            const c = document.createElement("canvas");
            c.width = w; c.height = h;
            const ctx = c.getContext("2d");
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, 0, 0, w, h);

            const dataUrl = c.toDataURL("image/jpeg", 0.9);
            c.width = 0; c.height = 0;          // 작업용 캔버스 즉시 반납
            // objectURL 을 놓아주면 원본 비트맵도 함께 회수된다.
            // (img.src 를 비우면 로드를 다시 걸어 onerror 가 난다 — 건드리지 않는다)
            URL.revokeObjectURL(url);

            const out = new Image();
            out.onerror = () => reject(new Error("이미지를 준비하지 못했습니다"));
            out.onload = () => resolve({ img: out, dataUrl });
            out.src = dataUrl;
        };

        img.src = url;
    });
}

/** 사용자가 지은 디자인 이름을 그대로 HTML 에 넣지 않도록 막는다. */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("이미지 로드 실패: " + src));
        i.src = src;
    });
}

async function fetchText(url) {
    const r = await fetch(url + (url.includes("?") ? "&" : "?") + "v=" + BUILD);
    if (!r.ok) throw new Error(`${url} 로드 실패 (${r.status})`);
    return r.text();
}

/**
 * 안드로이드 시스템 바(상태표시줄·네비게이션 바) 높이를 잰다.
 * targetSdk 35+ 부터 앱이 화면 끝까지 그려지므로, 그대로 두면 시뮬레이터 상단 버튼과
 * 하단 시트가 시스템 바에 가려진다. iframe 안에서는 env(safe-area-inset-*) 가
 * 0 으로 나오기 때문에 바깥(앱 셸)에서 재서 넘겨준다.
 */
function safeAreaInsets() {
    const probe = document.createElement("div");
    probe.style.cssText =
        "position:fixed;visibility:hidden;pointer-events:none;" +
        "top:0;left:0;" +
        "padding-top:env(safe-area-inset-top);" +
        "padding-bottom:env(safe-area-inset-bottom);" +
        "padding-left:env(safe-area-inset-left);" +
        "padding-right:env(safe-area-inset-right);";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const px = (v) => Math.round(parseFloat(v) || 0);
    const out = {
        top: px(cs.paddingTop), bottom: px(cs.paddingBottom),
        left: px(cs.paddingLeft), right: px(cs.paddingRight),
    };
    probe.remove();
    return out;
}

/** {{key}} 치환 */
function fillTemplate(tpl, cfg) {
    return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (cfg[k] !== undefined ? String(cfg[k]) : ""));
}

// ── 시뮬레이터 마운트 ───────────────────────────────────────────────────

/**
 * 추출한 css + 마크업 + CFG + 캔버스 JS 를 한 장의 문서로 조립해 iframe 에 띄웁니다.
 * Streamlit components.html 이 만들던 환경과 동일합니다.
 */
// ── 암전(먹통) 방지 ─────────────────────────────────────────────────────
// 편집 화면은 body.sim-fullscreen 으로 위쪽 단계를 전부 숨긴다. 그래서
// '전체화면인데 정작 캔버스는 안 보이는' 상태가 되면 화면에 아무것도 남지
// 않고, 빠져나올 버튼조차 없다. 여기서 그 상태가 생길 길을 막는다.
//
//   renderToken  화면을 벗어났는데 뒤늦게 끝난 렌더가 편집 화면을 띄우는 것
//   mountGen     이미 내려간 iframe 이 뒤늦게 보내는 준비 완료 신호
//   watchdog     어떤 이유로든 준비 완료가 오지 않을 때의 탈출구
let renderToken = 0;
let mountGen = 0;
let readyWatchdog = null;

/** 진행 중인 렌더를 버린다 (화면을 벗어날 때 부른다) */
function cancelRender() {
    renderToken++;
    if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
}

/** 편집 화면을 접고 설정 화면으로 돌아간다. 막힌 상태에서 빠져나오는 길이다. */
function bailToSettings(msg) {
    frameHeightLocked = false;
    document.body.classList.remove("sim-fullscreen");
    $("sim-frame").srcdoc = "";
    $("sim-frame").style.height = "";
    state.mountedKind = null;
    $("step-canvas").hidden = true;
    openSettings(true);
    if (msg) toast(msg, 4000);
}

async function mountSimulator(kind, cfg) {
    // 파일을 받아오는 동안에도 화면을 벗어날 수 있다. 받아온 뒤 한 번 더 본다.
    const my = renderToken;
    const [css, markup, js, muiCss, muiJs, helperJs] = await Promise.all([
        fetchText(`css/${kind}.css`),
        fetchText(`js/${kind}-markup.html`),
        fetchText(`js/${kind}-canvas.js`),
        fetchText("css/mobile-ui.css"),
        fetchText("js/mobile-ui.js"),
        // 원래 눈썹을 흐리게 하는 계산. 캔버스 JS 가 바로 쓰므로 그보다 먼저 싣는다.
        kind === "brow" ? fetchText("js/brow-erase.js") : Promise.resolve(""),
    ]);

    // 이번 마운트의 번호. **문서 문자열을 만들기 전에** 넣어야 한다.
    // CFG 는 아래에서 JSON 으로 굳어 iframe 안에 박히므로, 그 뒤에 넣으면
    // 시뮬레이터는 번호를 모른 채 뜨고 준비 완료 신호가 전부 걸러진다.
    cfg.mount_gen = ++mountGen;

    // 모바일 재배치 레이어는 캔버스 JS 가 전부 실행된 뒤에 붙여야
    // 기존 컨트롤의 이벤트 핸들러가 살아 있는 상태로 이동시킬 수 있다.
    const sa = safeAreaInsets();
    let doc = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<style>:root{--sa-top:${sa.top}px;--sa-bottom:${sa.bottom}px;--sa-left:${sa.left}px;--sa-right:${sa.right}px}</style>
<script>(function(){
function s(k,m){try{window.parent.postMessage({type:"mui:err",kind:k,msg:String(m).slice(0,240)},"*")}catch(e){}}
window.addEventListener("error",function(e){var t=e.target;
if(t&&t!==window&&t.tagName){var u=String(t.src||t.href||"");if(!u||u===location.href||u===document.baseURI)return;s("그림","<"+t.tagName.toLowerCase()+"> 못 읽음 "+u.slice(0,40));return}
s("오류",(e.message||"")+" @"+(e.lineno||0))},true);
window.addEventListener("unhandledrejection",function(e){var r=e.reason;s("미처리",(r&&r.message)||r)});
window.__blReport=s;})();<\/script>
<style>${css}</style>
<style>${muiCss}</style></head>
<body>
${fillTemplate(markup, cfg)}
<script>window.CFG = ${JSON.stringify(cfg)};<\/script>
<script>${helperJs}<\/script>
<script>${js}<\/script>
<script>${muiJs}<\/script>
</body></html>`;

    if (my !== renderToken) return;

    // 재마운트 시 이전 상태 해제 (눈썹 ↔ 입술 전환 등)
    frameHeightLocked = false;
    document.body.classList.remove("sim-fullscreen");

    const frame = $("sim-frame");
    frame.style.height = "";
    frame.srcdoc = doc;
    // doc 은 사진과 캔버스 JS 를 합친 수 MB 짜리 문자열이다.
    // srcdoc 에 넘긴 뒤에는 붙들고 있을 이유가 없다.
    doc = null;
    state.mountedKind = kind;
    $("step-canvas").hidden = false;

    // 준비 완료가 끝내 오지 않으면(스크립트 오류·메모리 부족 등) 갇히지 않게
    // 설정 화면으로 되돌린다.
    const gen = cfg.mount_gen;
    if (readyWatchdog) clearTimeout(readyWatchdog);
    readyWatchdog = setTimeout(() => {
        readyWatchdog = null;
        if (gen !== mountGen) return;                       // 이미 다시 띄웠다
        if (document.body.classList.contains("sim-fullscreen")) return;   // 잘 떴다
        bailToSettings("편집 화면을 열지 못했습니다. 다시 시도해 주세요.");
    }, 12000);   // 저사양 기기에서 캔버스가 늦게 뜨는 것을 실패로 보지 않게 넉넉히
}

/**
 * 결과 사진을 기기 사진첩에 저장한다.
 *
 * 안드로이드 WebView 는 <a download> 를 처리하지 않아 눌러도 아무 일이
 * 일어나지 않는다. 그래서 시뮬레이터 안에서 저장 요청을 가로채 여기로 넘기고,
 * 네이티브 플러그인이 MediaStore 를 통해 갤러리에 넣는다.
 * 앱이 아닌 브라우저에서 열었을 때는 원래대로 링크 내려받기로 떨어진다.
 */
const saveQueue = [];
let saveRunning = false;

function saveToGallery(dataUrl, filename) {
    // '전체 저장' 은 여러 장이 한꺼번에 몰려온다. 동시에 쓰면 사진첩에
    // 뒤엉키므로 줄을 세워 한 장씩 처리하고, 끝나면 몇 장인지 알린다.
    saveQueue.push({ dataUrl, filename });
    if (!saveRunning) runSaveQueue();
}

async function runSaveQueue() {
    // 아이폰 웹앱: 사진첩에 바로 못 쓴다. 모아서 '사진 앱에 저장' 창으로 넘긴다
    // (공유 창 → 이미지 저장). pwa.js 참고.
    // 안드로이드 크롬은 공유 창에 '저장' 이 없으니 아래 내려받기로 바로 저장한다
    // (갤러리의 Download 앨범에 들어간다).
    const web = window.PMUSWeb;
    if (web && web.isWeb && web.isIOS && web.canShareImages()) {
        const jobs = saveQueue.splice(0);
        if (jobs.length) web.saveImages(jobs);
        return;
    }
    saveRunning = true;
    const plugins = globalThis.Capacitor && globalThis.Capacitor.Plugins;
    let ok = 0, failed = 0;

    while (saveQueue.length > 0) {
        const job = saveQueue.shift();
        const left = saveQueue.length;

        if (plugins && plugins.GallerySaver) {
            if (left > 0 || ok + failed > 0) toast(`사진첩에 저장 중... ${ok + failed + 1}/${ok + failed + 1 + left}`, 1500);
            try {
                await plugins.GallerySaver.save(job);
                ok++;
            } catch (err) {
                failed++;
                console.error(err);
            }
        } else {
            // 앱이 아닌 브라우저에서는 원래대로 링크 내려받기
            const a = document.createElement("a");
            a.href = job.dataUrl;
            a.download = job.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            ok++;
        }
    }

    saveRunning = false;
    if (!plugins || !plugins.GallerySaver) return;
    if (failed === 0) toast(ok === 1 ? "사진첩에 저장했습니다" : `${ok}장을 사진첩에 저장했습니다`);
    else if (ok === 0) toast("저장에 실패했습니다");
    else toast(`${ok}장 저장, ${failed}장 실패`);
}

/** 띄워둔 시뮬레이터를 내린다. (라이선스가 바뀌어 권한이 사라졌을 때) */
function unmountSimulator() {
    cancelRender();
    const frame = $("sim-frame");
    // 아래에서 mountedKind 를 비우므로, 늦게 오는 mui:ready 는 무시된다
    frame.srcdoc = "";
    frame.style.height = "";
    state.mountedKind = null;
    frameHeightLocked = false;
    document.body.classList.remove("sim-fullscreen", "settings-open");
    $("step-canvas").hidden = true;
}

// 모바일 재배치가 켜지면 iframe 은 한 화면에 고정되므로 높이 신호를 무시한다.
let frameHeightLocked = false;

/**
 * 이 메시지가 편집 화면(sim-frame)에서 왔는지.
 *
 * 사파리(WebKit)는 srcdoc iframe 이 window.parent.postMessage 로 보낸 신호의
 * e.source 를 **앱 본체 창(window)** 으로 알려 준다. 크롬처럼 iframe 창과
 * 비교하면 늘 '다른 창' 이 된다. 그래서 본체 창으로 찍힌 것도 받는다 —
 * 이전 iframe 의 늦은 신호는 mount 번호(gen)로 따로 걸러낸다.
 */
function fromSimFrame(e) {
    const frame = $("sim-frame");
    if (!e.source || e.source === window) return true;
    if (e.source === frame.contentWindow) return true;
    try { return e.source.frameElement === frame; } catch (err) { return false; }
}

window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d) return;

    if (d.type === "mui:ready") {
        // 이미 내려간 시뮬레이터가 뒤늦게 보내온 신호는 버린다.
        //
        // 시뮬레이터를 띄우는 도중에 부위 탭을 누르면 화면은 내려가는데,
        // 로딩이 끝난 iframe 이 그제서야 이 신호를 보낸다. 그대로 받아들이면
        // 전체화면 모드가 켜져 위쪽 단계가 전부 숨겨지고, 정작 캔버스는
        // 이미 숨겨진 뒤라 화면에 아무것도 남지 않았다(암전).
        if (!state.mountedKind) return;
        // 보낸 창이 지금 편집 화면인지 본다. 사파리(아이폰)는 e.source 가 iframe 창이
        // 아니라 본체 창으로 나와서, 예전 비교로는 준비 완료가 늘 버려지고 편집 화면이
        // 영영 안 열렸다(2026-09-29). fromSimFrame 참고. 이전 iframe 은 아래 번호가 거른다.
        if (!fromSimFrame(e)) return;
        // srcdoc 을 갈아 끼워도 창 객체는 그대로라 위 검사만으로는 이전
        // iframe 의 신호를 걸러내지 못한다. 띄울 때 심어 둔 번호로 확인한다.
        if (d.gen !== mountGen) return;

        if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
        frameHeightLocked = true;
        document.body.classList.add("sim-fullscreen");
        $("sim-frame").style.height = "";   // CSS(100dvh !important)가 맡는다
        $("step-canvas").hidden = false;
        $("step-canvas").scrollIntoView({ block: "start" });
        return;
    }

    if (d.type === "mui:err") {
        // 편집 화면 안에서 터진 것. 그대로 두면 아무 흔적 없이 사라진다.
        diagAdd("[편집화면] " + (d.kind || "") + ": " + (d.msg || ""));
        return;
    }

    if (d.type === "mui:settings") {
        // 나가기 직전에 지금 작업을 구워 둔다. 다른 부위를 고르면 이 그림이
        // 배경이 되어 눈썹과 입술이 한 화면에 같이 보인다.
        requestCapture();
        openSettings(true);
        return;
    }

    if (d.type === "mui:resetAll") {
        resetEverything();
        return;
    }

    if (d.type === "mui:saveCustomer") {
        /* 편집 화면에서 '고객 이력으로 저장' 을 눌렀다.
         *
         * 시술 전 자리에는 시뮬레이션에 쓴 원본 사진(얼굴 전체)을 넣는다.
         * 고객이 자기 원래 모습을 기억하는 것이 상담의 출발점이다.
         * 예상 자리에는 방금 구운 화면이 들어간다. */
        if (!hasFeature("crm")) { toast("고객 관리 기능이 없습니다"); return; }
        if (!d.dataUrl) { toast("결과를 굽지 못했습니다. 다시 시도해 주세요", 3200); return; }
        Crm.saveResult({
            area: d.part === "lip" ? "lip" : "brow",
            label: d.label || "",
            before: state.photoDataUrl || null,
            sim: d.dataUrl,
        }).then((rec) => {
            if (rec) toast("고객 이력에 저장했습니다", 2600);
        }).catch((err) => {
            toast("저장하지 못했습니다 — " + err.message, 3600);
        });
        return;
    }

    if (d.type === "mui:captured") {
        if (d.dataUrl && (d.part === "brow" || d.part === "lip")) {
            addBase(d.part, d.dataUrl, d.label);
        }
        return;
    }

    if (d.type === "mui:pickDesign") {
        swapBrowDesign(d.key);
        return;
    }

    if (d.type === "mui:mode") {
        applyEditMode(d.mode === "manual" ? "manual" : "quick", true);
        return;
    }

    if (d.type === "mui:save") {
        saveToGallery(d.dataUrl, d.filename);
        return;
    }

    if (d.type === "streamlit:setFrameHeight" && typeof d.height === "number") {
        if (frameHeightLocked) return;
        $("sim-frame").style.height = Math.max(600, d.height) + "px";
    }
});

/** 전체화면 편집 중에 위쪽 설정 단계(사진·부위·디자인)를 펴거나 접는다. */
/**
 * 부위·편집 방식에 따라 어떤 단계를 보여줄지 한 곳에서 정한다.
 * 눈썹 디자인 고르기는 메뉴얼에서만 쓴다. 퀵은 바로 편집으로 들어간다.
 */
function updateStepVisibility() {
    // 디자인 그리드는 퀵에서도 열어 둔다 — 다른 것은 '흐름'뿐이다.
    // 메뉴얼은 디자인을 고르는 화면에서 한 번 멈추고, 퀵은 바로 편집으로 간다.
    // 사진을 고르기 전에는 디자인을 보여줄 이유가 없다 (고를 대상이 없다)
    $("step-design").hidden = !(state.mode === "brow" && state.photo);
    $("opt-standard-lip").hidden = state.mode !== "lip";
    document.querySelectorAll(".edit-tab").forEach((t) =>
        t.classList.toggle("is-active", t.dataset.edit === state.editMode));
    updateCarryUI();
}

function openSettings(open) {
    if (open) cancelRender();          // 설정으로 돌아가면 진행 중인 렌더는 버린다
    document.body.classList.toggle("settings-open", open);
    $("settings-toggle").textContent = open ? "✕ 편집으로 돌아가기" : "⚙️ 사진 · 디자인 변경";
    window.scrollTo(0, 0);
}


// ── 라이선스 ────────────────────────────────────────────────────────────

function hasFeature(f) {
    return !!(state.lic && state.lic.active && License.grants(state.lic.features, f));
}

/** 라이선스 상태를 다시 읽어 화면(게이트·배지·탭 잠금)에 반영한다. */
async function refreshLicense() {
    state.lic = await License.getLicense();
    const lic = state.lic;

    $("lic-device-code").textContent = lic.deviceCode;

    // 아무 기능도 못 쓰면 등록 화면만 보여준다
    const locked = !lic.active;
    $("license-gate").hidden = !locked;
    ["step-photo", "step-mode", "step-design", "step-canvas"].forEach((id) => {
        if (locked) $(id).hidden = true;
    });
    if (locked) {
        $("lic-badge").hidden = true;
        // 무료판은 등록이라는 절차가 없다. 기기 코드를 보내 키를 받으라는
        // 안내를 그대로 두면, 무료로 나눠 준 판에서 엉뚱한 길을 알려 주게 된다.
        document.body.classList.toggle("is-free", !!lic.free);
        if (lic.free) {
            document.querySelector(".lic-title").textContent = "교육용 무료 체험 종료";
            $("lic-message").innerHTML =
                "교육용 무료 체험 시간이 끝났습니다.<br>" +
                "계속 쓰시려면 <strong>정식판</strong>을 판매처에 문의해 주세요.";
        }
        if (lic.reason && lic.reason !== "미등록") {
            showLicError(lic.reason, lic.detail);
        }
        return;
    }
    document.body.classList.toggle("is-free", !!lic.free);

    // 사용 가능 → 사진 단계부터 다시 노출
    $("step-photo").hidden = false;

    // 상단 배지
    const badge = $("lic-badge");
    badge.hidden = false;
    if (lic.free) {
        // 무료로 쓰고 있다는 것이 늘 보여야 한다.
        // 남은 시간까지 늘 붙이면 상단 자리를 먹어 '버전' 이 두 줄로 접힌다.
        // 테스트판은 기한이 없다. 남은 시간을 보여 줄 것이 없다.
        if (lic.beta) {
            badge.textContent = "베타";
            badge.className = "lic-badge is-free";
        } else {
            // 평소에는 '무료' 만, 끝이 가까워지면 그때 시간을 같이 보여 준다.
            const soon = lic.hoursLeft <= 6;
            badge.textContent = soon ? ("무료 " + lic.hoursLeft + "시간") : "무료";
            badge.className = "lic-badge is-free" + (soon ? " is-soon" : "");
        }
    } else if (lic.daysLeft === null) {
        badge.textContent = "영구";
        badge.className = "lic-badge";
    } else if (lic.daysLeft <= 30) {
        badge.textContent = `D-${lic.daysLeft}`;
        badge.className = "lic-badge is-warn";
    } else {
        badge.textContent = `D-${lic.daysLeft}`;
        badge.className = "lic-badge";
    }

    // 고객 장부는 따로 파는 기능이다
    Crm.setEnabled(hasFeature("crm"));

    // 구매하지 않은 부위 탭 잠금
    document.querySelectorAll(".mode-tab").forEach((tab) => {
        const f = tab.dataset.feat;
        const ok = hasFeature(f);
        tab.classList.toggle("is-locked", !ok);
        tab.textContent = (f === "brow" ? "눈썹" : "입술") + (ok ? "" : " 🔒");
    });

    // 잠긴 부위를 보고 있었다면 사용 가능한 쪽으로 되돌린다
    if (!hasFeature(state.mode)) {
        // "*"(전체 이용권)은 부위 이름이 아니므로 실제 부위 중에서 고른다
        const first = ["brow", "lip"].find((f) => hasFeature(f));
        if (first) {
            state.mode = first;
            document.querySelectorAll(".mode-tab").forEach((t) =>
                t.classList.toggle("is-active", t.dataset.mode === first));
        }
    }

    // 이미 띄워둔 시뮬레이터가 이제 권한 밖이면 즉시 내린다.
    // (라이선스를 바꾸기 전에 열어둔 화면이 그대로 남아 제한이 안 걸린 것처럼 보였다)
    if (state.mountedKind && !hasFeature(state.mountedKind)) {
        unmountSimulator();
    }
    // 사진이 그대로 있으면 허용된 부위로 다시 띄워준다
    if (!state.mountedKind && state.photo && hasFeature(state.mode)) {
        await rerender();
    }
}

function showLicError(msg, detail) {
    const box = $("lic-error");
    box.innerHTML = `<strong>${msg}</strong>` + (detail ? `<br><span>${detail}</span>` : "");
    box.hidden = false;
}

function bindLicenseUI() {
    $("lic-copy-device").addEventListener("click", async () => {
        const code = $("lic-device-code").textContent;
        try {
            await navigator.clipboard.writeText(code);
            toast("기기 코드를 복사했습니다");
        } catch {
            toast("복사에 실패했습니다. 화면의 코드를 직접 적어 보내주세요.");
        }
    });

    $("lic-activate").addEventListener("click", async () => {
        const token = $("lic-token").value;
        if (!token.trim()) return showLicError("등록 키를 입력해 주세요");

        const res = await License.activate(token);
        if (!res.ok) return showLicError(res.reason, res.detail);

        $("lic-error").hidden = true;
        $("lic-token").value = "";
        await refreshLicense();
        toast(`등록 완료 — ${res.payload.shop}`);
    });

    $("lic-badge").addEventListener("click", () => {
        if (state.lic && state.lic.beta) {
            toast("테스트판입니다 — 기한 없이 쓰실 수 있습니다", 3000);
        } else if (state.lic && state.lic.free) {
            const h = state.lic.hoursLeft;
            toast("교육용 무료판입니다 — " + h + "시간 뒤에 끝납니다", 3600);
            return;
        }
        const p = state.lic && state.lic.payload;
        if (!p) return;
        const rows = [
            ["상호", p.shop],
            ["라이선스", p.lic],
            ["요금제", License.planLabel(p.plan)],
            ["사용 기능", (p.feat || []).map(License.featureLabel).join(", ")],
            ["이용 기한", License.fmtDate(p.exp)],
            ["업데이트 보장", License.fmtDate(p.upd)],
            ["기기 코드", state.lic.deviceCode],
        ];
        $("lic-detail").innerHTML = rows
            .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
        $("lic-sheet").hidden = false;
    });

    $("lic-close").addEventListener("click", () => { $("lic-sheet").hidden = true; });
    $("lic-change").addEventListener("click", async () => {
        $("lic-sheet").hidden = true;
        unmountSimulator();
        await License.deactivate();
        await refreshLicense();
    });
}

// ── 렌더 파이프라인 ─────────────────────────────────────────────────────

/** state.design 이 가리키는 눈썹 레퍼런스의 실제 주소를 돌려준다.
 *  기본 제공 디자인은 파일명, 직접 등록한 디자인은 "custom:<id>" 형태다. */
async function designSource(key) {
    // 디자인 그림을 갈아 끼웠을 때 예전 것이 캐시로 남지 않게 버전을 붙인다
    if (!String(key).startsWith(CUSTOM_PREFIX)) return `assets/eyebrow_refs/${key}?v=${BUILD}`;
    const row = await Custom.get(String(key).slice(CUSTOM_PREFIX.length));
    if (!row) throw new Error("등록한 디자인을 찾지 못했습니다");
    return row.dataUrl;
}

/** 퀵 편집 화면 안에서 좌우로 넘겨 고를 디자인 목록.
 *
 *  시뮬레이터는 srcdoc iframe 이라 상대 주소를 풀지 못한다. 기본 디자인은
 *  절대 주소로 바꿔 넘기고(파일은 시뮬레이터가 직접 읽는다), 직접 등록한
 *  디자인만 작은 미리보기로 구워서 넘긴다. 등록 원본은 최대 1200px 라
 *  그대로 넣으면 iframe 문서가 통째로 무거워진다. */
let quickDesignCache = { sig: "", list: null };

async function designListForQuick() {
    const sig = customDesigns.map((c) => c.id).join(",");
    if (quickDesignCache.list && quickDesignCache.sig === sig) return quickDesignCache.list;

    const abs = (u) => {
        try { return new URL(u, location.href).href; } catch (e) { return u; }
    };

    const list = EYEBROW_DESIGNS.map((d) => ({
        key: d.file, label: d.label, url: abs(`assets/eyebrow_refs/${d.file}?v=${BUILD}`),
    }));

    for (const c of customDesigns) {
        let url = c.dataUrl;
        try {
            const img = await loadImage(c.dataUrl);
            const W = 160, H = 56;
            const cv = document.createElement("canvas");
            cv.width = W; cv.height = H;
            const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
            const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
            cv.getContext("2d").drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
            url = cv.toDataURL("image/png");
            cv.width = 0; cv.height = 0;
        } catch (e) { /* 원본을 그대로 쓴다 */ }
        list.push({ key: CUSTOM_PREFIX + c.id, label: c.label, url: url });
    }

    quickDesignCache = { sig: sig, list: list };
    return list;
}

/** 편집 중에 눈썹 디자인만 갈아 끼운다.
 *  자리·크기·색 같은 조절값은 시뮬레이터 안에 있으므로 그대로 남는다.
 *  여기서는 지금 설정 그대로 새 디자인을 구워 밑그림만 보낸다. */
async function swapBrowDesign(key) {
    if (state.mode !== "brow" || !state.photo || !key) return;
    if (key === state.design) return;

    const prev = state.design;
    state.design = key;
    try {
        const browImg = await loadImage(await designSource(key));
        const cfg = buildEyebrowConfig(
            browImg,
            state.photo.naturalWidth,
            state.photo.naturalHeight,
            state.eyes,
            {
                color_hex: DEFAULT_BROW_COLOR,
                design_name: currentDesignLabel(),
                brows: state.brows,
            }
        );
        const frame = $("sim-frame");
        if (frame.contentWindow) {
            frame.contentWindow.postMessage({
                type: "mui:brow", l_b64: cfg.l_b64, r_b64: cfg.r_b64,
                name: cfg.safe_design_name, key: key,
            }, "*");
        }
        // 설정 화면의 디자인 그리드도 같은 것을 고른 상태로 맞춘다
        document.querySelectorAll(".design-card").forEach((b) => {
            b.classList.toggle("is-active", b.dataset.file === key);
        });
    } catch (err) {
        state.design = prev;
        toast("디자인을 바꾸지 못했습니다: " + err.message);
        console.error(err);
    }
}

/** 이어서 작업할 밑그림을 고른다.
 *
 *  자기 부위가 이미 구워진 그림 위에 또 얹으면 같은 시술이 두 번 그려진다.
 *  그래서 지금 고른 부위와 **다른 부위** 로 구운 것만 후보가 된다.
 *  고른 것이 없거나 후보에서 빠졌으면 가장 최근 것을, 그것도 없으면 맨얼굴을 쓴다.
 */
/**
 * 앱을 껐다 켜지 않고 처음 상태로 되돌린다.
 *
 * 저장한 결과물이 쌓이면 그것만으로 메모리를 먹는데, 지금까지는 그걸 비우려면
 * 앱을 껐다 켜야 했다. 손님이 바뀔 때마다 그러기는 번거롭다.
 *
 * 지우는 것 : 고른 사진 · 편집 중인 화면 · 저장한 결과물 · 이어서 쓸 밑그림
 * 남기는 것 : 등록해 둔 내 디자인 · 라이선스 · 기본 입술선 설정
 *
 * 결과물은 시뮬레이터가 sessionStorage 에 넣어 둔다. srcdoc iframe 은 출처를
 * 물려받으므로 같은 저장소다 — 여기서 지울 수 있다.
 */
const SIM_HISTORY_KEYS = [
    "brow_preview_studio_history_v2",
    "lip_preview_studio_history_v3",
];

function resetEverything() {
    unmountSimulator();

    SIM_HISTORY_KEYS.forEach((k) => {
        try { sessionStorage.removeItem(k); } catch (e) { /* 없으면 그만 */ }
    });

    state.photo = null;
    state.photoDataUrl = null;
    state.eyes = null;
    state.brows = null;
    state.lipInfo = null;
    state.bases = [];
    state.baseChoice = null;
    state.design = EYEBROW_DESIGNS[0].file;
    state.mode = "brow";
    state.editMode = "quick";

    // 1단계(사진 고르기)로 되돌린다
    $("drop-zone").hidden = false;
    $("photo-preview").hidden = true;
    $("preview-img").removeAttribute("src");
    $("step-mode").hidden = true;
    // 같은 사진을 다시 고를 수 있게 파일 입력을 비운다 (안 비우면 change 가 안 온다)
    ["file-camera", "file-gallery"].forEach((id) => {
        const f = $(id);
        if (f) f.value = "";
    });

    document.querySelectorAll(".mode-tab").forEach((t) =>
        t.classList.toggle("is-active", t.dataset.mode === state.mode));
    document.querySelectorAll(".design-card").forEach((b) =>
        b.classList.toggle("is-active", b.dataset.file === state.design));

    updateStepVisibility();
    openSettings(false);
    window.scrollTo(0, 0);
    toast("모든 작업을 초기화했습니다");
}

/* ── 메모리 ────────────────────────────────────────────────────────────
 *
 * 어떤 기기에서 '눈썹 합성 실패: Out of memory at ImageData creation' 이 났다.
 * 그런데 그때 만들려던 판은 눈썹 디자인 한 장(500×140, 280KB)이다.
 * 그만한 것도 못 잡는다는 건 **그 앞에서 이미 바닥났다** 는 뜻이다.
 * 사진을 작게 줄여 올려도 같은 오류가 났다는 것이 그 증거다.
 *
 * 바닥나는 자리는 셋이다.
 *   1) 앞서 띄운 편집 화면(iframe)이 아직 살아 있다. 그 안에는 사진만
 *      두 장(배경·맨얼굴) + 합성용 판 여럿이 잡혀 있다. 새 편집 화면을
 *      만들기 전에 먼저 내려놓는다.
 *   2) 편집 화면에 사진을 두 번 실어 보냈다. 이어 그릴 밑그림이 없으면
 *      배경과 맨얼굴이 같은 사진인데도 문자열을 두 벌 만들었다.
 *   3) 그래도 모자라면 사진을 줄여 한 번 더 해본다.
 * ------------------------------------------------------------------- */

/** 편집 화면을 내려 그 안의 판을 모두 놓아준다. (진행 중인 렌더는 건드리지 않는다) */
function releaseFrame() {
    const frame = $("sim-frame");
    if (!frame) return;
    if (frame.srcdoc) frame.srcdoc = "";
    frame.style.height = "";
    state.mountedKind = null;
    frameHeightLocked = false;
    document.body.classList.remove("sim-fullscreen");
}

/** 지금 무엇을 얼마나 들고 있는지 한 줄로. 오류가 났을 때 같이 보여준다. */
function memReport() {
    const bits = [];
    if (state.photo) {
        const w = state.photo.naturalWidth, h = state.photo.naturalHeight;
        bits.push(`사진 ${w}×${h}(${Math.round(w * h * 4 / 1048576)}MB)`);
    }
    if (state.photoDataUrl) {
        bits.push(`원본문자열 ${Math.round(state.photoDataUrl.length / 1024)}KB`);
    }
    if (state.bases.length) {
        const kb = state.bases.reduce((s, b) => s + b.dataUrl.length + b.thumb.length, 0) / 1024;
        bits.push(`밑그림 ${state.bases.length}장(${Math.round(kb)}KB)`);
    }
    bits.push(`상한 ${MAX_SIZE}px`);
    // 무엇을 만들다 실패했는지가 가장 중요한 단서다
    try {
        const c = lastCanvasRequest;
        if (c && c.w) {
            bits.push(`마지막 판 ${c.w}×${c.h}(${(c.w * c.h * 4 / 1048576).toFixed(1)}MB)`);
        }
    } catch (e) { /* 무시 */ }
    try {
        const m = performance.memory;
        if (m) {
            bits.push(`JS ${Math.round(m.usedJSHeapSize / 1048576)}/` +
                      `${Math.round(m.jsHeapSizeLimit / 1048576)}MB`);
        }
    } catch (e) { /* 크롬 계열만 알려준다 */ }
    return bits.join(" · ");
}

/**
 * 사진을 더 작게 줄여 다시 시도할 수 있게 한다.
 * 눈·눈썹 좌표는 사진 픽셀 기준이라, 줄인 뒤에는 다시 재야 한다.
 * @returns 줄였으면 true
 */
async function shrinkPhotoForRetry(maxEdge) {
    if (!state.photo) return false;
    const w = state.photo.naturalWidth, h = state.photo.naturalHeight;
    const k = Math.min(1, maxEdge / Math.max(w, h));
    if (k >= 0.999) return false;

    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.drawImage(state.photo, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.88);
    c.width = 0; c.height = 0;

    const img = await loadImage(url);
    state.photo = img;
    state.photoDataUrl = url;
    state.lipInfo = null;
    // 이어 그릴 밑그림은 크기가 달라져 못 쓴다
    state.bases = [];
    state.baseChoice = null;

    const geo = await detectFaceGeometry(img);
    state.eyes = geo ? geo.eyes : null;
    state.brows = geo ? geo.brows : null;

    $("preview-img").src = url;
    $("photo-size").textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    updateCarryUI();
    console.info("메모리가 모자라 사진을 줄였습니다:", w + "×" + h, "→",
                 img.naturalWidth + "×" + img.naturalHeight);
    return true;
}

/** 메모리가 모자라 실패한 것인지 */
function looksLikeOutOfMemory(err) {
    const m = String((err && err.message) || err || "");
    return /out of memory|allocation|메모리/i.test(m);
}

function baseCandidates(part) {
    return state.bases.filter((b) => b.part !== part);
}

function baseFor(part) {
    const list = baseCandidates(part);
    if (!list.length) return state.photoDataUrl;
    if (state.baseChoice === "orig") return state.photoDataUrl;
    const picked = list.find((b) => b.id === state.baseChoice);
    return (picked || list[0]).dataUrl;
}

/** 편집 화면에 지금 작업을 구워서 달라고 한다 (설정으로 나갈 때 한 번) */
function requestCapture() {
    const frame = $("sim-frame");
    if (!state.mountedKind || !frame.contentWindow) return;
    try {
        frame.contentWindow.postMessage({ type: "mui:capture" }, "*");
    } catch (e) { /* 못 받으면 이번 작업은 안 넘어갈 뿐이다 */ }
}

/** 목록에 뿌릴 작은 그림. 원본을 그대로 걸면 한 장에 수 MB 라 6장이면 버겁다. */
function makeThumb(dataUrl) {
    return new Promise((resolve) => {
        const im = new Image();
        im.onload = () => {
            try {
                const W = 220;
                const c = document.createElement("canvas");
                c.width = W;
                c.height = Math.max(1, Math.round(W * im.naturalHeight / im.naturalWidth));
                c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
                const url = c.toDataURL("image/jpeg", 0.8);
                c.width = 0; c.height = 0;
                resolve(url);
            } catch (e) { resolve(dataUrl); }
        };
        im.onerror = () => resolve(dataUrl);
        im.src = dataUrl;
    });
}

/** 구워 온 작업물을 후보 목록에 넣는다 (오래된 것부터 밀려난다) */
async function addBase(part, dataUrl, label) {
    const thumb = await makeThumb(dataUrl);
    state.bases.unshift({
        id: "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        part: part,
        label: label || (part === "brow" ? "눈썹 작업" : "입술 작업"),
        dataUrl: dataUrl,
        thumb: thumb,
    });
    // 너무 많이 쌓으면 그것만으로 메모리를 먹는다
    while (state.bases.length > MAX_BASES) state.bases.pop();
    updateCarryUI();
}

/** 부위 탭 아래 — 무엇이 반영되는지와, 이어서 쓸 사진 고르기 */
function updateCarryUI() {
    const note = $("carry-note");
    const picker = $("carry-picker");
    if (!note || !picker) return;

    const list = state.photo ? baseCandidates(state.mode) : [];
    if (!list.length) {
        note.hidden = true;
        picker.hidden = true;
        picker.innerHTML = "";
        const goOff = $("carry-go");
        if (goOff) goOff.hidden = true;
        return;
    }

    const other = state.mode === "brow" ? "입술" : "눈썹";
    note.hidden = false;
    note.textContent = `${other} 작업을 이어서 편집합니다 — 아래에서 사진을 고르세요`;

    // 고른 것이 후보에서 빠졌으면 가장 최근 것으로 되돌린다
    if (state.baseChoice !== "orig" && !list.some((b) => b.id === state.baseChoice)) {
        state.baseChoice = list[0].id;
    }

    picker.hidden = false;
    picker.innerHTML = "";

    const add = (id, label, src) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "carry-item" + (state.baseChoice === id ? " is-active" : "");
        b.innerHTML =
            `<img src="${src}" alt="" loading="lazy">` +
            `<span>${escapeHtml(label)}</span>`;
        b.addEventListener("click", () => pickBase(id));
        picker.appendChild(b);
    };

    list.forEach((x) => add(x.id, x.label, x.thumb));
    add("orig", "맨얼굴", state.photoDataUrl);

    const go = $("carry-go");
    if (go) go.hidden = false;
}

/**
 * 이어서 쓸 사진을 골라야 하는 상황인가.
 *
 * 앞 작업이 있으면 어느 사진 위에서 이어갈지가 갈린다. 그때 부위만 누르고
 * 곧장 편집으로 넘어가면 원장님은 무엇 위에서 그리고 있는지 모른 채
 * 시작하게 된다. 그래서 이때는 반드시 고르고 '편집하기' 를 누르게 한다.
 * 맨 처음(앞 작업이 없을 때)은 고를 것이 없으므로 바로 넘어간다.
 */
function needsBasePick() {
    return !!(state.photo && baseCandidates(state.mode).length);
}

/** 밑그림을 바꾼다. 편집은 '편집하기' 를 눌러야 시작한다. */
function pickBase(id) {
    if (state.baseChoice === id) return;
    state.baseChoice = id;
    state.lipInfo = null;             // 입술 기준선도 새 사진에서 다시 잡는다
    // 지금 떠 있는 편집 화면은 다른 사진 위의 작업이라 이어붙일 수 없다
    if (state.mountedKind) {
        unmountSimulator();
        openSettings(true);
    }
    updateCarryUI();
}

/** 고른 사진으로 편집을 시작한다 */
async function startEditing() {
    if (!state.photo) { toast("먼저 사진을 선택해 주세요"); return; }
    openSettings(false);
    await rerender();
}

async function renderBrow(retried) {
    const my = ++renderToken;
    showLoading("눈썹을 합성하는 중...");
    // 앞서 띄운 편집 화면이 살아 있으면 그 안의 판이 그대로 메모리를 잡고 있다.
    // 새로 만들기 전에 먼저 놓아준다.
    releaseFrame();
    try {
        const browImg = await loadImage(await designSource(state.design));
        const cfg = buildEyebrowConfig(
            browImg,
            state.photo.naturalWidth,
            state.photo.naturalHeight,
            state.eyes,
            {
                color_hex: DEFAULT_BROW_COLOR,
                design_name: currentDesignLabel(),
                // 실제 눈썹을 재어 그 자리에 그 길이로 얹는다.
                // 눈 위치만으로 잡으면 '눈에서 얼마쯤 위' 라는 평균값에 기대게 되어
                // 눈썹이 원래 높거나 짧은 사람에게서 어긋난다. 퀵이든 메뉴얼이든
                // 시작 자리가 정확할수록 손이 덜 간다.
                brows: state.brows,
            }
        );
        cfg.bg_b64 = baseFor("brow");
        // 이어 그릴 밑그림이 없으면 배경과 맨얼굴이 같은 사진이다.
        // 같은 문자열을 두 벌 실어 보내면 그만큼 메모리를 두 배로 쓴다.
        if (cfg.bg_b64 !== state.photoDataUrl) cfg.orig_b64 = state.photoDataUrl;
        // 원래 눈썹 자리 — '기존 눈썹 진하기' 로 흐리게 할 때 덮을 곳.
        // 잰 사진 크기를 같이 보내 배경 크기가 달라도 맞춰 쓴다.
        if (state.brows && state.brows.left && state.brows.left.pts && state.brows.right && state.brows.right.pts) {
            cfg.nat_brows = {
                left: state.brows.left.pts,
                right: state.brows.right.pts,
                w: state.photo.naturalWidth,
            };
        }
        cfg.ui_mode = state.editMode;
        // 퀵에서는 편집 화면 안에서 바로 디자인을 넘겨 고를 수 있어야 한다
        cfg.designs = await designListForQuick();
        cfg.design_key = state.design;
        if (my !== renderToken) return;      // 그 사이에 화면을 벗어났다
        await mountSimulator("brow", cfg);
    } catch (err) {
        console.error(err, memReport());
        // 메모리가 모자라면 사진을 줄여 딱 한 번 다시 해본다
        if (!retried && looksLikeOutOfMemory(err) && await shrinkPhotoForRetry(1000)) {
            hideLoading();
            toast("메모리가 모자라 사진을 줄여 다시 합성합니다", 3000);
            return renderBrow(true);
        }
        toast("눈썹 합성 실패: " + err.message + "\n" + memReport(), 7000);
    } finally {
        hideLoading();
    }
}

async function renderLip(retried) {
    const my = ++renderToken;
    showLoading("입술을 분석하는 중...");
    releaseFrame();
    try {
        if (!state.lipInfo) {
            // 인식은 기기를 탄다. 어떤 폰은 되고 어떤 폰은 안 된다.
            // 그래서 인식은 '있으면 좋은 것'으로만 두고, 무슨 일이 있어도
            // 입술은 반드시 올라가게 한다.
            // 퀵은 '실제 입술을 따라간다' 가 전부라, 기본 입술선 설정과 상관없이
            // 인식을 먼저 시도한다. 그 설정은 메뉴얼용 탈출구다.
            const wantDetect = (state.editMode === "quick") || !state.standardLipOnly;
            let measured = null;
            if (wantDetect) {
                try {
                    // refine: 검출선의 삐뚤어짐과 잔울퉁을 다듬어서 받는다.
                    // 그대로 쓰면 오버립을 줄 때 그 울퉁불퉁함까지 같이 커진다.
                    measured = await detectLipLandmarks(state.photo, { refine: true });
                } catch (e) {
                    console.warn("입술 인식 건너뜀", e);
                }
            }

            // 퀵은 고객의 실제 입술을 그대로 쓴다. '도톰하게'는 지금 이 입술에서
            // 얼마나 도톰해지는지를 보여주는 화면이라, 표준 입술로 갈아 끼우면
            // 정작 그 사람의 입술이 아니게 된다.
            //
            // 메뉴얼은 반대다. 실제 입술은 비대칭이거나 번져 있어, 디자인을
            // 처음부터 잡을 때는 그걸 먼저 펴야 한다. 그래서 인식에서는
            // 입꼬리 위치와 폭만 받아 좌우 대칭 표준 입술로 시작한다.
            const useMeasured = !!measured && state.editMode === "quick";
            state.lipInfo = useMeasured
                ? measured
                : standardLipLandmarks(
                    state.photo.naturalWidth, state.photo.naturalHeight,
                    measured, state.eyes);

            if (!measured && wantDetect) {
                toast(state.eyes
                    ? "입술선을 못 읽어 눈 위치로 입 자리를 잡았습니다. 끌어서 맞춰주세요."
                    : "얼굴 미검출 — 사진 가운데에 놓았습니다. 끌어서 맞춰주세요.", 4200);
            }
        }
        const cfg = {
            bg_b64: baseFor("lip"),
            img_w: state.photo.naturalWidth,
            img_h: state.photo.naturalHeight,
            // lip-canvas.js 는 CFG.lip_json 을 객체로 읽는다(lipData.upper_control_points …).
            // 문자열로 넘기면 모든 좌표가 undefined 가 되어 틴트·시술선이 통째로 안 그려진다.
            lip_json: state.lipInfo,
            default_color: DEFAULT_LIP_COLOR,
            default_tech: "natural",
            ui_mode: state.editMode,
        };
        // 같은 사진이면 두 번 싣지 않는다 (시뮬레이터는 없으면 bg_b64 를 쓴다)
        if (cfg.bg_b64 !== state.photoDataUrl) cfg.orig_b64 = state.photoDataUrl;
        if (my !== renderToken) return;      // 그 사이에 화면을 벗어났다
        await mountSimulator("lip", cfg);
    } catch (err) {
        console.error(err, memReport());
        if (!retried && looksLikeOutOfMemory(err) && await shrinkPhotoForRetry(1000)) {
            hideLoading();
            toast("메모리가 모자라 사진을 줄여 다시 시작합니다", 3000);
            return renderLip(true);
        }
        toast("입술 분석 실패: " + err.message + "\n" + memReport(), 7000);
    } finally {
        hideLoading();
    }
}

function currentDesignLabel() {
    const d = EYEBROW_DESIGNS.find((x) => x.file === state.design);
    if (d) return d.label;
    const c = customDesigns.find((x) => CUSTOM_PREFIX + x.id === state.design);
    return c ? c.label : "눈썹 디자인";
}

async function rerender() {
    if (!hasFeature(state.mode)) {
        toast("사용 권한이 없는 기능입니다");
        return;
    }
    if (state.mode === "brow") await renderBrow();
    else await renderLip();
}

// ── 사진 처리 ───────────────────────────────────────────────────────────

async function handlePhoto(file) {
    if (!file) return;
    showLoading("사진을 불러오는 중...");
    try {
        const { img, dataUrl } = await loadCustomerImage(file);
        await usePhoto(img, dataUrl);
    } catch (err) {
        toast(err.message);
        console.error(err);
    } finally {
        hideLoading();
    }
}

/**
 * 준비된 사진 하나를 화면에 앉히고 얼굴을 찾는다.
 * 앨범에서 고른 것과 앱 안에서 찍은 것이 같은 길을 타도록 따로 뺐다.
 */
async function usePhoto(img, dataUrl) {
    showLoading("사진을 불러오는 중...");
    try {
        state.photo = img;
        state.photoDataUrl = dataUrl;
        state.lipInfo = null;
        state.brows = null;
        state.bases = [];                 // 남의 사진 작업이 남으면 안 된다
        state.baseChoice = null;

        $("preview-img").src = dataUrl;
        $("photo-size").textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
        $("drop-zone").hidden = true;
        $("photo-preview").hidden = false;
        $("step-mode").hidden = false;

        // 얼굴 인식
        const badge = $("detect-status");
        badge.textContent = "얼굴 인식 중...";
        badge.className = "badge";
        showLoading("얼굴을 인식하는 중...");

        const geo = await detectFaceGeometry(img);
        state.eyes = geo ? geo.eyes : null;
        state.brows = geo ? geo.brows : null;
        if (state.eyes) {
            badge.textContent = "얼굴 인식 완료";
            badge.className = "badge badge-ok";
        } else {
            // 얼굴이 안 보이는 것과, 이 기기에서 인식 엔진이 아예 못 도는 것은
            // 다른 문제다. 문의가 왔을 때 구분할 수 있게 다르게 적는다.
            const eng = engineStatus();
            badge.textContent = eng.ready
                ? "얼굴 미검출 — 수동 배치"
                : "인식 엔진 사용 불가 — 수동 배치";
            badge.className = "badge badge-warn";
        }

        // 사진만 올렸다고 바로 편집으로 넘기지 않는다.
        // 눈썹은 디자인을 고르는 순간, 입술은 부위를 고르는 순간 편집으로 들어간다.
        updateStepVisibility();
    } catch (err) {
        toast(err.message);
        console.error(err);
    } finally {
        hideLoading();
    }
}

// ── 초기화 ──────────────────────────────────────────────────────────────

async function buildDesignGrid() {
    const grid = $("design-grid");
    grid.innerHTML = "";

    try {
        customDesigns = await Custom.list();
    } catch (err) {
        customDesigns = [];
        console.error(err);
    }

    const cards = EYEBROW_DESIGNS.map((d) => ({
        key: d.file, label: d.label,
        src: `assets/eyebrow_refs/${d.file}?v=${BUILD}`, custom: false,
    })).concat(customDesigns.map((c) => ({
        key: CUSTOM_PREFIX + c.id, label: c.label,
        src: c.dataUrl, custom: true, id: c.id,
    })));

    cards.forEach((d) => {
        const btn = document.createElement("button");
        btn.className = "design-card" + (d.key === state.design ? " is-active" : "");
        btn.dataset.file = d.key;
        btn.innerHTML =
            `<img src="${d.src}" alt="" loading="lazy">` +
            `<span>${escapeHtml(d.label)}</span>` +
            (d.custom ? `<b class="design-mine">내 디자인</b>` : "");

        if (d.custom) {
            const del = document.createElement("i");
            del.className = "design-del";
            del.textContent = "×";
            del.title = "삭제";
            del.addEventListener("click", async (e) => {
                e.stopPropagation();      // 카드 선택으로 번지지 않게
                if (!confirm(`'${d.label}' 디자인을 삭제할까요?`)) return;
                await Custom.remove(d.id);
                if (state.design === d.key) state.design = EYEBROW_DESIGNS[0].file;
                await buildDesignGrid();
                toast("삭제했습니다");
            });
            btn.appendChild(del);
        }

        btn.addEventListener("click", async () => {
            grid.querySelectorAll(".design-card").forEach((b) => b.classList.remove("is-active"));
            btn.classList.add("is-active");
            state.design = d.key;
            if (!state.photo) return;
            // 앞 작업이 있으면 밑그림을 고르고 '편집하기' 를 눌러야 넘어간다
            if (needsBasePick()) {
                $("carry-picker").scrollIntoView({ behavior: "smooth", block: "center" });
                return;
            }
            openSettings(false);          // 설정을 열어둔 상태였다면 편집으로 돌아간다
            await renderBrow();
        });
        grid.appendChild(btn);
    });

    // 맨 끝에 '내 디자인 등록' 카드
    const add = document.createElement("button");
    add.className = "design-card design-add";
    add.type = "button";
    add.innerHTML = `<i>＋</i><span>내 디자인 등록</span>`;
    add.addEventListener("click", () => $("design-file").click());
    grid.appendChild(add);
}

// ── 내 디자인 등록 ──────────────────────────────────────────────────────

/** 등록 화면에 올라와 있는 파일과 미리보기 상태 */
const pending = { file: null, flip: false, prepared: null };

async function refreshPendingPreview() {
    const err = $("design-dlg-error");
    err.hidden = true;
    try {
        pending.prepared = await Custom.prepare(pending.file, { flip: pending.flip });
        $("design-dlg-preview").src = pending.prepared.dataUrl;
        $("design-dlg-size").textContent =
            `${pending.prepared.width} × ${pending.prepared.height}px (여백 잘라냄)`;
        $("design-dlg-save").disabled = false;
    } catch (e) {
        pending.prepared = null;
        $("design-dlg-preview").removeAttribute("src");
        $("design-dlg-size").textContent = "";
        err.textContent = e.message;
        err.hidden = false;
        $("design-dlg-save").disabled = true;
    }
}

async function openDesignDialog(file) {
    pending.file = file;
    pending.flip = false;
    $("design-dlg-name").value = Custom.labelFromFilename(file.name);
    $("design-dlg-flip").classList.remove("is-active");
    $("design-dialog").hidden = false;
    await refreshPendingPreview();
}

function closeDesignDialog() {
    $("design-dialog").hidden = true;
    pending.file = null;
    pending.prepared = null;
    $("design-file").value = "";     // 같은 파일을 다시 골라도 change 가 뜨도록
}

function bindDesignRegister() {
    $("design-file").addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) openDesignDialog(f);
    });

    $("design-dlg-flip").addEventListener("click", async () => {
        pending.flip = !pending.flip;
        $("design-dlg-flip").classList.toggle("is-active", pending.flip);
        await refreshPendingPreview();
    });

    $("design-dlg-cancel").addEventListener("click", closeDesignDialog);

    $("design-dlg-save").addEventListener("click", async () => {
        if (!pending.prepared) return;
        try {
            const saved = await Custom.add($("design-dlg-name").value, pending.prepared);
            state.design = CUSTOM_PREFIX + saved.id;
            closeDesignDialog();
            await buildDesignGrid();
            toast("디자인을 등록했습니다");
            if (state.photo) {
                openSettings(false);
                await renderBrow();
            }
        } catch (e) {
            $("design-dlg-error").textContent = "저장하지 못했습니다: " + e.message;
            $("design-dlg-error").hidden = false;
        }
    });
}

/** '기본 입술선으로 시작' 체크박스 */
function bindStandardLipOption() {
    const chk = $("chk-standard-lip");
    chk.checked = state.standardLipOnly;
    $("opt-standard-lip").hidden = state.mode !== "lip";

    chk.addEventListener("change", async () => {
        state.standardLipOnly = chk.checked;
        saveStandardLipOnly(chk.checked);
        state.lipInfo = null;                 // 다음 렌더에서 새로 만든다
        toast(chk.checked
            ? "기본 입술선으로 시작합니다"
            : "얼굴 인식을 다시 사용합니다");
        if (state.photo && state.mode === "lip") {
            openSettings(false);
            await renderLip();
        }
    });
}


// ── 촬영 화면 (가이드 점선) ─────────────────────────────────────────────
//
// 기본 카메라 앱을 부르면(capture="user") 그 화면 위에는 아무것도 그릴 수
// 없다. 그래서 앱 안에서 카메라를 직접 열고 점선을 얹는다.
// 카메라를 못 열면 예전처럼 기본 카메라 앱으로 넘어간다.

/**
 * 기준 사진에서 잰 구도. 가이드 점선과 잘라내기 비율을 여기서 정한다.
 * 원장님마다 찍는 거리가 달라 편집 값이 모자라는 일을 막으려는 것이라,
 * 이 숫자가 곧 '표준 구도' 다. 기준 사진이 바뀌면 여기만 고치면 된다.
 */
const FRAME_GUIDE = {
    // ── 기준사진.png (1122×1402) 을 얼굴 인식으로 잰 값 ──────────────
    //   비율 0.8003 · 눈높이 0.4388 · 턱끝 0.8769
    //   얼굴 폭(볼) 0.6708 · 눈사이 거리 0.3218 · 이마 랜드마크 상단 0.2189
    //
    // 머리 타원은 이마 랜드마크 위로 머리통·머리카락 몫(얼굴 높이의 28%)을
    // 얹어 잡았다. 가로 중심만은 기준사진(0.468) 대신 정가운데로 둔다.
    // 가이드는 '이렇게 찍으세요' 이므로 치우친 원본을 따를 이유가 없다.
    aspect: 1122 / 1402,                                 // 0.8003
    head: { cx: 0.500, cy: 0.456, rx: 0.360, ry: 0.421 },
    // 격자 '선' 개수 (가로·세로 각각). 홀수여야 정가운데 선이 생긴다.
    // 5줄이면 1/6 · 2/6 · 3/6 · 4/6 · 5/6 자리에 놓이고 3/6 이 정중앙이다.
    gridLines: 5,
};

const cam = { stream: null, facing: "environment" };

function applyGuideGeometry() {
    const g = FRAME_GUIDE;
    // 좌표계를 가로 100 으로 두고 세로는 비율에서 뽑는다.
    // 틀의 CSS 비율도 같은 값에서 나오므로 둘이 어긋날 수 없다.
    const W = 100, H = +(W / g.aspect).toFixed(2);
    $("cam-frame").style.aspectRatio = String(g.aspect);
    $("cam-guide").setAttribute("viewBox", `0 0 ${W} ${H}`);

    const head = $("g-head");
    head.setAttribute("cx", (g.head.cx * W).toFixed(2));
    head.setAttribute("cy", (g.head.cy * H).toFixed(2));
    head.setAttribute("rx", (g.head.rx * W).toFixed(2));
    head.setAttribute("ry", (g.head.ry * H).toFixed(2));

    // 격자 — 선을 n 줄 놓으려면 화면을 n+1 로 나눈다.
    // n 이 홀수면 한가운데 줄이 정확히 0.5 에 떨어진다.
    const NS = "http://www.w3.org/2000/svg";
    const grid = $("g-grid");
    grid.textContent = "";
    const n = g.gridLines, mid = (n + 1) / 2;
    for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        const center = i === mid;          // 정가운데 줄은 조금 진하게

        const v = document.createElementNS(NS, "line");
        v.setAttribute("x1", (t * W).toFixed(2)); v.setAttribute("y1", 0);
        v.setAttribute("x2", (t * W).toFixed(2)); v.setAttribute("y2", H);
        if (center) v.setAttribute("class", "is-center");
        grid.appendChild(v);

        const h = document.createElementNS(NS, "line");
        h.setAttribute("x1", 0); h.setAttribute("y1", (t * H).toFixed(2));
        h.setAttribute("x2", W); h.setAttribute("y2", (t * H).toFixed(2));
        if (center) h.setAttribute("class", "is-center");
        grid.appendChild(h);
    }
}

async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        $("file-camera").click();               // 카메라를 못 여는 환경
        return;
    }
    applyGuideGeometry();
    $("cam-error").hidden = true;
    $("cam").hidden = false;
    await startStream();
}

async function startStream() {
    stopStream();
    const video = $("cam-video");
    try {
        cam.stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: cam.facing,
                width:  { ideal: 1920 },
                height: { ideal: 1920 },
            },
            audio: false,
        });
        video.srcObject = cam.stream;
        $("cam-frame").classList.toggle("is-mirrored", cam.facing === "user");
        $("cam-shoot").disabled = false;
        await video.play().catch(() => {});
    } catch (err) {
        $("cam-shoot").disabled = true;
        $("cam-error").hidden = false;
        $("cam-error").innerHTML =
            "카메라를 열지 못했습니다. 이 기기에서는 기본 카메라로 촬영해 주세요.<br>" +
            "<span style='opacity:.8'>" + escapeHtml(err && err.message ? err.message : String(err)) + "</span>" +
            "<button type='button' id='cam-fallback' class='btn btn-ghost btn-sm' " +
            "style='margin-top:10px'>기본 카메라로 촬영</button>";
        $("cam-fallback").addEventListener("click", () => {
            closeCamera();
            $("file-camera").click();
        });
        console.error(err);
    }
}

function stopStream() {
    if (cam.stream) {
        cam.stream.getTracks().forEach((t) => t.stop());
        cam.stream = null;
    }
    $("cam-video").srcObject = null;
}

function closeCamera() {
    stopStream();
    $("cam").hidden = true;
}

/** 미리보기에서 '틀 안에 보이던 그대로' 잘라 담는다 (object-fit: cover 와 같은 계산) */
function shoot() {
    const video = $("cam-video");
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) { toast("카메라가 아직 준비되지 않았습니다"); return; }

    const want = FRAME_GUIDE.aspect;
    let sw = vw, sh = vh;
    if (vw / vh > want) sw = Math.round(vh * want);   // 좌우가 남으면 잘라낸다
    else sh = Math.round(vw / want);                  // 위아래가 남으면 잘라낸다
    const sx = Math.round((vw - sw) / 2);
    const sy = Math.round((vh - sh) / 2);

    const scale = Math.min(1, MAX_SIZE / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);

    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    if (cam.facing === "user") {          // 앞 카메라는 좌우가 뒤집혀 보이므로 되돌린다
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);

    const dataUrl = c.toDataURL("image/jpeg", 0.9);
    c.width = 0; c.height = 0;
    closeCamera();

    const img = new Image();
    img.onload = () => usePhoto(img, dataUrl);
    img.onerror = () => toast("사진을 준비하지 못했습니다");
    img.src = dataUrl;
}

function bindCamera() {
    $("cam-close").addEventListener("click", closeCamera);
    $("cam-shoot").addEventListener("click", shoot);
    $("cam-flip").addEventListener("click", async () => {
        cam.facing = cam.facing === "user" ? "environment" : "user";
        await startStream();
    });
}

/** 퀵 / 메뉴얼 탭 */
function bindEditModeTabs() {
    updateStepVisibility();                    // 지난번에 쓰던 방식을 탭에 표시
    document.querySelectorAll(".edit-tab").forEach((tab) => {
        tab.addEventListener("click", async () => {
            if (state.editMode === tab.dataset.edit) return;
            await applyEditMode(tab.dataset.edit);
        });
    });
}

/** 편집 방식을 바꾼다. 시뮬레이터가 떠 있으면 그 안의 화면만 갈아끼운다.
 *  (같은 조절값을 쓰므로 다시 띄우지 않아도 되고, 지금까지 만진 값이 그대로 남는다) */
async function applyEditMode(mode, fromSim) {
    state.editMode = mode;
    saveEditMode(mode);
    updateStepVisibility();

    if (fromSim) return;                       // 시뮬레이터가 스스로 바꾼 경우

    // 아직 편집에 들어가지 않았다면 시작 기준이 방식마다 다르므로 다시 잡는다.
    // (편집 중이라면 아래에서 화면만 바꾸고 값은 건드리지 않는다)
    if (!state.mountedKind) state.lipInfo = null;

    const frame = $("sim-frame");
    if (state.mountedKind && frame.contentWindow) {
        try {
            frame.contentWindow.postMessage({ type: "mui:setMode", mode }, "*");
            return;
        } catch (e) { /* 아래로 떨어져 다시 띄운다 */ }
    }
    // 퀵은 고를 것 없이 바로 편집으로 들어간다 (입술은 원래부터 그렇다).
    // 앞 작업이 있으면 밑그림부터 고르게 두고 여기서 넘기지 않는다.
    if (state.photo && !state.mountedKind && !needsBasePick()
        && (mode === "quick" || state.mode === "lip")) {
        openSettings(false);
        await rerender();
    }
}

function bindEvents() {
    $("btn-camera").addEventListener("click", openCamera);
    $("btn-gallery").addEventListener("click", () => $("file-gallery").click());
    $("file-camera").addEventListener("change", (e) => handlePhoto(e.target.files[0]));
    $("file-gallery").addEventListener("change", (e) => handlePhoto(e.target.files[0]));

    $("btn-rephoto").addEventListener("click", () => {
        // 사진이 바뀌면 지금 띄워 둔 편집 화면은 남의 사진이다. 같이 내린다.
        // (내리지 않으면 전체화면 상태만 남아 화면이 까맣게 보인다)
        unmountSimulator();
        $("drop-zone").hidden = false;
        $("photo-preview").hidden = true;
        $("step-canvas").hidden = true;
        $("step-design").hidden = true;
        $("step-mode").hidden = true;
        state.photo = null;
        state.eyes = null;
        state.brows = null;
        state.lipInfo = null;
        state.bases = [];
        state.baseChoice = null;
        updateCarryUI();
    });

    $("settings-toggle").addEventListener("click", async () => {
        const open = !document.body.classList.contains("settings-open");

        // 편집으로 돌아가려는데 시뮬레이터가 내려가 있으면 다시 띄운다.
        //
        // 부위 탭(눈썹)을 누르면 '디자인부터 고르게' 하려고 시뮬레이터를
        // 내린다. 그 상태에서 편집으로 돌아가기를 누르면 화면 요소가 전부
        // 감춰진 채 빈 iframe 만 남아 까맣게 보였다.
        if (!open) {
            if (!state.photo) { toast("먼저 사진을 선택해 주세요"); return; }
            if (!state.mountedKind) await rerender();
            if (!state.mountedKind) return;      // 못 띄웠으면 설정 화면에 머문다
        }

        openSettings(open);
    });

    document.querySelectorAll(".mode-tab").forEach((tab) => {
        tab.addEventListener("click", async () => {
            if (!hasFeature(tab.dataset.feat)) {
                toast(`${License.featureLabel(tab.dataset.feat)}는 별도 구매가 필요합니다`);
                return;
            }
            document.querySelectorAll(".mode-tab").forEach((t) => t.classList.remove("is-active"));
            tab.classList.add("is-active");
            state.mode = tab.dataset.mode;
            updateStepVisibility();
            $("opt-standard-lip").hidden = state.mode !== "lip";
            if (!state.photo) return;
            // 앞 작업이 있으면 어느 사진 위에서 이어갈지부터 고르게 한다
            if (needsBasePick()) {
                unmountSimulator();
                openSettings(true);
                $("carry-picker").scrollIntoView({ behavior: "smooth", block: "center" });
                return;
            }
            // 퀵은 고를 것 없이 바로 편집으로. 메뉴얼 눈썹만 디자인부터 고르게 한다.
            if (state.mode === "lip" || state.editMode === "quick") {
                openSettings(false);
                await rerender();
            } else {
                unmountSimulator();
                $("step-design").scrollIntoView({ behavior: "smooth", block: "start" });
            }
        });
    });
}


/* ── 진단 ──────────────────────────────────────────────────────────────
 *
 * 어떤 기기에서는 오류 한 줄 없이 눈썹이 안 보이고 입술색도 안 올라간다.
 * 손에 없는 폰이라 여기서는 재현이 안 된다. 그러면 폰이 직접 말하게
 * 만드는 수밖에 없다.
 *
 * 모으는 것
 *   · 편집 화면(iframe) 안에서 터진 오류 — 원래는 바깥 창에 안 들린다
 *   · 그림을 못 읽은 일 — img 는 오류 없이 조용히 실패한다
 *   · 이 기기가 판을 되읽을 수 있는지 (getImageData)
 *   · 눈썹 한 벌을 실제로 구워 보고, 그 결과에 화소가 남아 있는지
 * ------------------------------------------------------------------- */

const diagLog = [];
let diagToasted = 0;

function diagAdd(line) {
    const t = new Date();
    const p = (n) => String(n).padStart(2, "0");
    diagLog.push(p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds()) + "  " + line);
    if (diagLog.length > 60) diagLog.shift();
    console.warn("[진단]", line);
    // 처음 두 번만 알린다. 그 뒤로는 진단 화면에 쌓아만 둔다.
    if (diagToasted < 2) {
        diagToasted++;
        toast("문제가 기록되었습니다 — 위쪽 '진단' 을 눌러 확인", 3400);
    }
}

/** 이 기기가 판을 되읽을 수 있는지 실제로 해본다. */
function diagReadback(size) {
    try {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const x = c.getContext("2d", { willReadFrequently: true });
        x.fillStyle = "#ff8000";
        x.fillRect(0, 0, size, size);
        const d = x.getImageData(0, 0, size, size).data;
        c.width = 0; c.height = 0;
        return (d[0] === 255 && d[1] === 128 && d[2] === 0)
            ? "정상"
            : "값이 다름 (" + d[0] + "," + d[1] + "," + d[2] + "," + d[3] + ")";
    } catch (e) {
        return "실패 — " + ((e && e.message) || e);
    }
}

/** 구워 낸 그림 한 장을 도로 풀어, 실제로 남은 화소를 센다. */
function diagCountPixels(dataUrl) {
    return new Promise((resolve) => {
        const kb = Math.round((dataUrl || "").length / 1024);
        if (!dataUrl || dataUrl.length < 128) {
            resolve("빈 문자열 (" + (dataUrl || "").length + "자)");
            return;
        }
        const im = new Image();
        im.onload = () => {
            try {
                const c = document.createElement("canvas");
                c.width = im.naturalWidth;
                c.height = im.naturalHeight;
                const x = c.getContext("2d", { willReadFrequently: true });
                x.drawImage(im, 0, 0);
                const d = x.getImageData(0, 0, c.width, c.height).data;
                let n = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
                c.width = 0; c.height = 0;
                resolve(im.naturalWidth + "×" + im.naturalHeight
                        + " · 남은 화소 " + n + " · " + kb + "KB"
                        + (n === 0 ? "  ← 비었음!" : ""));
            } catch (e) {
                resolve("되읽기 실패 — " + ((e && e.message) || e));
            }
        };
        im.onerror = () => resolve("그림으로 못 읽음 · " + kb + "KB · 머리 "
                                   + String(dataUrl).slice(0, 24));
        im.src = dataUrl;
    });
}

async function runSelfTest() {
    const out = $("diag-out");
    out.textContent = "진단하는 중...";
    const L = [];
    L.push("Build " + BUILD + " · 사진 상한 " + MAX_SIZE + "px");
    L.push("기기 " + navigator.userAgent.replace(/^Mozilla\/5\.0\s*/, ""));
    L.push("메모리표시 " + (navigator.deviceMemory || "모름") + "GB · 코어 "
           + (navigator.hardwareConcurrency || "모름"));
    L.push(memReport());
    L.push("");
    L.push("캔버스 되읽기 64px  : " + diagReadback(64));
    L.push("캔버스 되읽기 1024px: " + diagReadback(1024));
    try {
        const es = engineStatus();
        L.push("얼굴 엔진      : " + (es.ready ? "준비됨" : "안 됨")
               + " · " + (es.delegate || "미정")
               + (es.error ? " · " + es.error : ""));
    } catch (e) { /* 없으면 그만 */ }
    L.push("");

    if (!state.photo) {
        L.push("사진이 없어 눈썹 굽기는 건너뜁니다.");
    } else {
        try {
            const browImg = await loadImage(await designSource(state.design));
            L.push("디자인 원본 : " + browImg.naturalWidth + "×" + browImg.naturalHeight);
            const cfg = buildEyebrowConfig(
                browImg,
                state.photo.naturalWidth, state.photo.naturalHeight,
                state.eyes,
                { color_hex: DEFAULT_BROW_COLOR, brows: state.brows });
            const pt = (p) => (p ? Math.round(p.x) + "," + Math.round(p.y) : "없음");
            L.push("잰 눈 자리  : 왼 " + pt(state.eyes && state.eyes.left)
                   + " / 오 " + pt(state.eyes && state.eyes.right));
            L.push("잰 눈썹     : " + (state.brows
                   ? "왼 " + pt(state.brows.left) + "(폭 " + Math.round(state.brows.left.width) + ")"
                     + " / 오 " + pt(state.brows.right) + "(폭 " + Math.round(state.brows.right.width) + ")"
                   : "없음"));
            L.push("마지막 캔버스 : " + lastCanvasRequest.w + "×" + lastCanvasRequest.h);
            L.push("왼쪽 눈썹  : " + (await diagCountPixels(cfg.l_b64)));
            L.push("오른쪽 눈썹: " + (await diagCountPixels(cfg.r_b64)));
            L.push("놓을 자리  : 왼 " + Math.round(cfg.left_center_x) + "," + Math.round(cfg.left_center_y)
                   + " / 오 " + Math.round(cfg.right_center_x) + "," + Math.round(cfg.right_center_y));
        } catch (e) {
            L.push("눈썹 굽기 실패 — " + ((e && e.message) || e));
        }
    }

    L.push("");
    L.push(diagLog.length ? "── 기록된 문제 ──" : "기록된 문제 없음");
    diagLog.forEach((s) => L.push(s));
    out.textContent = L.join("\n");
}

/* ── 새 판 확인 · 받기 ─────────────────────────────────────────────────
 *
 * 지금까지는 새 판이 나오면 APK 를 손으로 보내야 했다. 받는 쪽도 파일을
 * 찾아 눌러야 했고, 누가 아직 옛 판을 쓰는지 알 수 없었다.
 *
 * 앱을 열 때 조용히 한 번 확인하고, 새 판이 있을 때만 알린다. 없으면
 * 아무 말도 하지 않는다 — 상담 중에 뜨는 알림만큼 방해되는 것이 없다.
 */
let pendingUpdate = null;          // 확인해 둔 새 판 정보

function verSay(text, kind) {
    const el = $("ver-state");
    el.textContent = text;
    el.classList.toggle("is-new", kind === "new");
    el.classList.toggle("is-bad", kind === "bad");
}

function verBar(percent) {
    const bar = $("ver-bar");
    if (percent === null) { bar.hidden = true; return; }
    bar.hidden = false;
    $("ver-bar-fill").style.width = Math.max(0, Math.min(100, percent)) + "%";
}

/**
 * @param quiet 조용히 확인한다 (앱을 열 때). 새 판이 없거나 실패해도 말하지 않는다.
 */
/** 아이폰 웹앱의 새 버전 확인. 서비스 워커가 받아 두고, 적용은 사람이 누를 때만. */
async function checkWebUpdate(quiet) {
    if (quiet) return;          // 앱을 열 때는 pwa.js 가 알아서 받아 둔다
    verSay("확인하는 중...");
    const r = await window.PMUSWeb.checkUpdate();
    if (r === "ready") {
        pendingUpdate = { web: true };
        $("ver-get").hidden = false;
        $("ver-get").textContent = "새 버전 적용하기";
        verSay("새 버전을 받아 두었습니다. 아래 버튼을 누르면 화면이 한 번 새로 뜨면서 적용됩니다.", "new");
    } else if (r === "latest") {
        verSay("최신 버전입니다.\n웹앱은 새 버전을 저절로 받아 두었다가, 다음에 열 때 적용합니다.");
    } else {
        verSay("홈 화면에 추가한 앱에서만 새 버전을 저절로 받습니다.");
    }
}

async function checkUpdate(quiet) {
    if (window.PMUSWeb && window.PMUSWeb.isWeb) return checkWebUpdate(quiet);
    // 무료판은 설치 ID 가 달라, 정식판 APK 를 받아 봐야 '업데이트' 가 아니라
    // 정식판이 따로 깔린다. 받게 두면 라이선스 화면에서 막혀 더 헷갈린다.
    if (state.lic && state.lic.free) {
        if (!quiet) verSay(state.lic.beta
            ? "테스트판은 자동 업데이트를 쓰지 않습니다."
            : "교육용 무료판은 자동 업데이트를 쓰지 않습니다.");
        return;
    }
    if (!Update.configured()) {
        if (!quiet) verSay("업데이트 주소가 아직 설정되지 않았습니다.", "bad");
        return;
    }
    if (!quiet) verSay("확인하는 중...");
    try {
        const info = await Update.check(parseInt(BUILD, 10));
        if (!info) {
            pendingUpdate = null;
            $("ver-get").hidden = true;
            if (!quiet) verSay("최신 버전입니다.");
            return;
        }
        pendingUpdate = info;
        $("ver-get").hidden = false;
        const head = "새 버전 " + info.name + " 이(가) 나왔습니다.";
        verSay(info.notes ? [head, "", info.notes].join("\n") : head, "new");
        if (quiet) toast("새 버전이 나왔습니다 — 위쪽 '버전' 에서 받으세요", 4200);
    } catch (err) {
        pendingUpdate = null;
        $("ver-get").hidden = true;
        if (!quiet) verSay("확인하지 못했습니다 — " + err.message, "bad");
        else console.warn("새 버전 확인 실패", err);
    }
}

async function getUpdate() {
    if (!pendingUpdate) return;
    if (pendingUpdate.web) {
        verSay("적용하는 중...");
        if (!window.PMUSWeb.applyUpdate()) verSay("적용할 새 버전이 없습니다. 다시 확인해 보세요.", "bad");
        return;
    }
    const btn = $("ver-get");
    btn.disabled = true;
    $("ver-check").disabled = true;
    verSay("받는 중입니다. 화면을 끄지 말아 주세요.");
    verBar(0);

    const stop = Update.onProgress((p) => verBar(p));
    try {
        const path = await Update.download(pendingUpdate);
        verBar(100);
        verSay("다 받았습니다. 설치를 시작합니다.");
        const started = await Update.install(path);
        if (!started) {
            // 이 앱에 '출처를 알 수 없는 앱 설치' 가 아직 허용되지 않았다.
            // 설정 화면은 열어 줬으니, 허용한 뒤 다시 누르면 된다.
            verSay([
                "설치 권한을 켜 주세요.",
                "",
                "방금 열린 설정에서 이 앱을 허용한 뒤,",
                "돌아와 다시 눌러 주세요.",
            ].join("\n"), "new");
        }
    } catch (err) {
        verSay("받지 못했습니다 — " + err.message, "bad");
        diagAdd("업데이트 실패: " + err.message);
    } finally {
        stop();
        verBar(null);
        btn.disabled = false;
        $("ver-check").disabled = false;
    }
}

/** 업데이트 내역 — www/changelog.json (빌드 업데이트 내역.md 에서 만든 것) 을 펼쳐 보인다.
 *  못 읽으면 칸을 통째로 감춘다. 빈 상자를 보여 줄 이유가 없다. */
let changelogDone = false;
async function renderChangelog() {
    if (changelogDone) return;
    const box = $("ver-log-box"), list = $("ver-log");
    try {
        const items = await fetch("changelog.json?v=" + BUILD, { cache: "no-cache" }).then((r) => {
            if (!r.ok) throw new Error(r.status);
            return r.json();
        });
        if (!Array.isArray(items) || !items.length) throw new Error("empty");
        list.textContent = "";
        let marked = false;
        for (const it of items) {
            const li = document.createElement("li");
            // 같은 번호가 두 줄이면(안드로이드 먼저, 웹앱 나중) 가장 최근 줄에만 표시한다
            if (!marked && String(it.build) === String(BUILD)) { li.className = "is-now"; marked = true; }
            const b = document.createElement("span"); b.className = "b"; b.textContent = it.build;
            const t = document.createElement("span"); t.className = "t"; t.textContent = String(it.at).replace(/-/g, ".");
            const x = document.createElement("span"); x.className = "x"; x.textContent = it.text;
            li.append(b, t, x);
            list.appendChild(li);
        }
        changelogDone = true;
    } catch (err) {
        box.hidden = true;
    }
}

function bindDiag() {
    $("diag-btn").addEventListener("click", () => {
        $("diag-sheet").hidden = false;
        const free = state.lic && state.lic.free;
        const webTag = window.PMUSWeb && window.PMUSWeb.isWeb ? "웹앱 · " : "";
        $("ver-current").textContent = webTag + (free ? "무료 교육용 · " : "") + "Build " + BUILD;
        if (free) {
            verSay("교육용 무료판입니다. " + state.lic.hoursLeft + "시간 뒤에 끝납니다.", "new");
        }
        if (!pendingUpdate) verSay("새 버전이 있는지 확인해 보세요.");
        runSelfTest();
        renderChangelog();
    });
    $("ver-check").addEventListener("click", () => checkUpdate(false));
    $("ver-get").addEventListener("click", getUpdate);
    $("diag-run").addEventListener("click", runSelfTest);
    $("diag-close").addEventListener("click", () => { $("diag-sheet").hidden = true; });
    $("diag-copy").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText($("diag-out").textContent);
            toast("복사했습니다");
        } catch (e) {
            toast("복사가 안 되는 기기입니다 — 화면을 캡처해 주세요", 3200);
        }
    });

    // 앱 셸 쪽에서 터진 것도 같이 모은다.
    window.addEventListener("error", (e) => {
        const t = e.target;
        if (t && t !== window && t.tagName) {
            diagAdd("파일 못 읽음: " + String(t.src || t.href || "").slice(-60));
            return;
        }
        diagAdd("앱 오류: " + e.message + " @" + (e.lineno || 0));
    }, true);
    window.addEventListener("unhandledrejection", (e) => {
        const r = e.reason;
        diagAdd("앱 미처리: " + ((r && r.message) || r));
    });
}

(async function init() {
    await buildDesignGrid();
    bindEvents();
    bindLicenseUI();
    bindDesignRegister();
    bindStandardLipOption();
    bindCamera();
    bindEditModeTabs();
    bindDiag();
    /* 고객 장부.
     *
     * 첫 방문은 사진부터, 재방문은 고객부터 시작한다. 기존 흐름은 그대로
     * 두고 1단계 맨 위에 고객 줄만 얹었다. 고객을 안 고르면 지금까지와
     * 똑같이 동작한다. */
    Crm.init({
        onStart: () => {
            // 카드에서 '이 고객으로 상담 시작' — 사진 고르는 자리로 돌려보낸다
            openSettings(false);
            $("step-photo").scrollIntoView({ block: "start" });
            toast("사진을 찍거나 앨범에서 고르세요", 2600);
        },
    });
    $("carry-go").addEventListener("click", startEditing);
    await refreshLicense();
    if (!state.lic.active) {            // 등록 전에는 무거운 초기화를 하지 않는다
        hideSplash();
        return;
    }
    try {
        showLoading("얼굴 인식 엔진을 준비하는 중...");
        await initFaceLandmarker((m) => { $("loading-text").textContent = m; });
    } catch (err) {
        toast("얼굴 인식 엔진 로드 실패 — 수동 배치로 사용 가능합니다");
        console.error(err);
    } finally {
        hideLoading();
        hideSplash();
    }

    // 화면이 다 뜬 뒤에 조용히 확인한다. 새 판이 있을 때만 알린다.
    setTimeout(() => { checkUpdate(true); }, 2500);

    /* 걸려 있어야 할 리터치 알림을 다시 맞춘다.
     *
     * 안드로이드는 앱을 지웠다 깔거나, 기기를 바꾸거나, 알림 권한을 껐다
     * 켜면 예약이 날아간다. 장부에는 예정일이 남아 있는데 알림만 없는
     * 상태가 된다 — 원장님은 알림이 오는 줄 알고 기다린다.
     * 앱을 열 때마다 장부를 기준으로 다시 걸어 두면 그 틈이 없다. */
    setTimeout(() => {
        if (!hasFeature("crm")) return;
        Crm.syncReminders().catch((e) => console.warn("알림 재예약 실패", e));
    }, 3200);
})();
