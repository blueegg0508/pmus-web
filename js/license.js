/**
 * license.js — 라이선스 검증 · 저장 · 기능 잠금
 * =========================================================================
 * 서명된 토큰을 앱 안에서 직접 검증합니다. 서버는 토큰을 "찍어주는 곳"일 뿐이고,
 * 평소 실행에는 인터넷이 전혀 필요 없습니다. 시술실에서 신호가 끊겨도
 * 상담이 멈추지 않게 하기 위한 설계입니다.
 *
 * 토큰 형식 (JWS 계열):  base64url(헤더).base64url(내용).base64url(서명)
 * 서명 알고리즘: ECDSA P-256 / SHA-256
 *   → Ed25519 가 더 짧지만 Chrome 137+ 에서만 지원돼 구형 WebView 에서 실패합니다.
 *
 * 여기 들어 있는 것은 공개키뿐이라 유출돼도 무해합니다.
 * 개인키로만 토큰을 만들 수 있고, 개인키는 앱에 들어오지 않습니다.
 * =========================================================================
 */

// ── 저장소 · 기기 어댑터 ─────────────────────────────────────────────────
// 이 프로젝트는 번들러를 쓰지 않으므로 "@capacitor/preferences" 같은 bare import 를
// 쓸 수 없다. Capacitor 는 네이티브 브리지를 통해 window.Capacitor.Plugins 에
// 플러그인을 실어주므로 그걸 직접 쓰고, 브라우저 미리보기에서는 localStorage 로 대체한다.

const CapPlugins = () => (globalThis.Capacitor && globalThis.Capacitor.Plugins) || {};

const Preferences = {
    async get({ key }) {
        const p = CapPlugins().Preferences;
        if (p) return p.get({ key });
        return { value: localStorage.getItem(key) };
    },
    async set({ key, value }) {
        const p = CapPlugins().Preferences;
        if (p) return p.set({ key, value });
        localStorage.setItem(key, value);
    },
    async remove({ key }) {
        const p = CapPlugins().Preferences;
        if (p) return p.remove({ key });
        localStorage.removeItem(key);
    },
};

const Device = {
    async getId() {
        const d = CapPlugins().Device;
        if (d) return d.getId();
        return { identifier: null };     // 브라우저에서는 아래 난수 대체 경로로
    },
};

/** license/keygen.mjs 가 출력한 공개키 */
const PUBLIC_KEY = {
    kty: "EC",
    crv: "P-256",
    x: "bBspzEcikouXFMo7DEbovlV8MXfyvjvYFHPS9Ir3f44",
    y: "v2oN3gXWxBXfHusBZcxUzyvMrTYEMM1PHsfGdWYfD7s",
};

const KEY_TOKEN = "blic.token";
const KEY_SEEN = "blic.lastSeen";     // 시계 되돌리기 감지용
const KEY_EDU_START = "blic.eduStart";   // 교육용 무료판을 처음 연 시각
const KEY_REVOKED = "blic.revoked";       // 공식 주소에서 받아 둔 사용 중지 목록 (lic → 사유)
const KEY_LAST_CHECK = "blic.lastCheck";  // 사용 중지 목록을 마지막으로 확인한 시각
/** 사용 중지 목록 — 라이선스 관리의 [환불 · 사용 중지] 가 공식 주소에 올린다. 라이선스 번호만 담긴다. */
const REVOKE_URL = "https://blueegg0508.github.io/pmus/revoked.json";
/** 이 기간 넘게 목록을 확인하지 못하면 인터넷 연결을 요청한다 */
const OFFLINE_GRACE_DAYS = 7;
const KEY_TRIAL_START = "blic.trialStart"; // 정식 웹앱 7일 무료 체험을 시작한 시각
/** 정식 웹앱을 처음 열면 주는 무료 체험 기간 (2026-10-12 원장님) */
const TRIAL_DAYS = 7;
/** 앱(APK) 이 아닌 웹앱인가 */
const isWebApp = () => !(globalThis.Capacitor && (globalThis.Capacitor.isNativePlatform
    ? globalThis.Capacitor.isNativePlatform() : globalThis.Capacitor.Plugins));

/**
 * 판매 가능한 기능 목록.
 * 새 기능을 만들면 여기에 한 줄만 추가하고, 화면 쪽에서 grants() 로 확인하면 된다.
 * 토큰에 모르는 기능 ID 가 들어 있어도 무시되므로 구버전 앱과도 호환된다.
 */
export const FEATURES = {
    brow: { label: "눈썹 시뮬레이터", ready: true },
    lip:  { label: "입술 시뮬레이터", ready: true },
    sns:  { label: "SNS 카드 생성",   ready: false },   // 예정 (AI 아님 — 기존 PIL 로직 이식)
    crm:  { label: "고객 관리",       ready: false },   // 실험판에서 만드는 중
};

const PLAN_LABEL = { year: "1년 이용권", perpetual: "영구 이용권", trial: "체험판" };

/**
 * 라이선스가 해당 기능을 허용하는지.
 *
 * "*" 는 **앞으로 추가될 기능까지 포함**하는 전체 이용권이다.
 * 개별 기능만 산 고객은 새 기능이 나오면 잠긴 채로 보이고(구매 유도),
 * 전체 이용권 고객은 앱만 업데이트하면 바로 쓸 수 있다.
 */
export function grants(licFeatures, f) {
    if (!Array.isArray(licFeatures)) return false;
    return licFeatures.includes("*") || licFeatures.includes(f);
}

// ── 인코딩 유틸 ──────────────────────────────────────────────────────────

function b64urlToBytes(s) {
    const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function b64urlToJson(s) {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

// ── 기기 코드 ────────────────────────────────────────────────────────────

let _deviceCode = null;

/**
 * 고객에게 보여줄 12자리 기기 코드.
 * 안드로이드 기기 ID 를 해시해 만듭니다 — 원본 ID 를 그대로 노출하지 않고,
 * 앱을 지웠다 다시 깔아도 같은 값이 나옵니다.
 */
export async function getDeviceCode() {
    if (_deviceCode) return _deviceCode;

    let raw;
    try {
        raw = (await Device.getId()).identifier;
    } catch {
        raw = null;
    }
    if (!raw) {
        // 기기 ID 를 못 얻으면 최초 1회 난수를 만들어 저장해 대체한다.
        const stored = (await Preferences.get({ key: "blic.fallbackId" })).value;
        if (stored) {
            raw = stored;
        } else {
            raw = crypto.randomUUID();
            await Preferences.set({ key: "blic.fallbackId", value: raw });
        }
    }

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("blic:" + raw));
    _deviceCode = [...new Uint8Array(digest)]
        .slice(0, 6)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return _deviceCode;
}

// ── 검증 ─────────────────────────────────────────────────────────────────

let _pubKeyPromise = null;
function publicKey() {
    if (!_pubKeyPromise) {
        _pubKeyPromise = crypto.subtle.importKey(
            "jwk", PUBLIC_KEY, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
        );
    }
    return _pubKeyPromise;
}

/**
 * 토큰을 검증하고 내용을 돌려줍니다.
 * @returns {{ok:true, payload:object} | {ok:false, reason:string, detail?:string}}
 */
export async function verifyToken(token, deviceCode) {
    const parts = String(token || "").trim().replace(/\s+/g, "").split(".");
    if (parts.length !== 3) return { ok: false, reason: "형식이 올바르지 않습니다" };

    let header, payload;
    try {
        header = b64urlToJson(parts[0]);
        payload = b64urlToJson(parts[1]);
    } catch {
        return { ok: false, reason: "토큰을 읽을 수 없습니다" };
    }

    if (header.typ !== "BLIC" || header.alg !== "ES256") {
        return { ok: false, reason: "지원하지 않는 라이선스 형식입니다" };
    }

    // 서명 검증 — 이게 통과해야 나머지 값을 믿을 수 있다
    let valid = false;
    try {
        valid = await crypto.subtle.verify(
            { name: "ECDSA", hash: "SHA-256" },
            await publicKey(),
            b64urlToBytes(parts[2]),
            new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
        );
    } catch {
        valid = false;
    }
    if (!valid) return { ok: false, reason: "정품 라이선스가 아닙니다", detail: "서명 불일치" };

    // 기기 확인
    if (payload.dev && deviceCode && payload.dev !== deviceCode) {
        return {
            ok: false,
            reason: "다른 기기에 발급된 라이선스입니다",
            detail: `이 기기 코드: ${deviceCode}`,
        };
    }

    return { ok: true, payload };
}

// ── 만료 · 시계 되돌리기 ─────────────────────────────────────────────────

async function checkClock() {
    const now = Math.floor(Date.now() / 1000);
    const seen = parseInt((await Preferences.get({ key: KEY_SEEN })).value || "0", 10);

    // 하루 이상 과거로 돌아갔으면 시계 조작으로 본다
    if (seen && now < seen - 86400) return false;
    if (now > seen) await Preferences.set({ key: KEY_SEEN, value: String(now) });
    return true;
}

// ── 상태 조회 ────────────────────────────────────────────────────────────

/**
 * 현재 라이선스 상태.
 * @returns {{
 *   active: boolean, reason?: string, payload?: object,
 *   features: string[], daysLeft: number|null, deviceCode: string
 * }}
 */
/* ── 교육용 무료판 ─────────────────────────────────────────────────────
 *
 * 교육에서 나눠 주는 판이다. 등록 없이 그 자리에서 바로 쓰고, 하루가 지나면
 * 멈춘다. 설치 ID 가 .edu 로 달라서 정식판과 한 폰에 같이 깔리고, 원장님이
 * 쓰던 앱과 그 안의 작업은 건드리지 않는다.
 *
 * 하루를 어디서부터 세는지는 '처음 연 때' 로 잡았다. 날짜로 끊으면 저녁
 * 교육에 받은 분은 몇 시간밖에 못 쓴다.
 *
 * 앱 자료를 지우면 다시 하루가 생긴다. 막을 수야 있지만, 그러자고 기기에
 * 흔적을 남기는 것은 나눠 주는 판에 어울리지 않는다. 대신 그렇게까지 해서
 * 늘려 쓸 만큼 불편하지 않도록 정식판 안내를 잘 보이게 뒀다.
 * ------------------------------------------------------------------- */

/** 교육용 무료판이 하루로 치는 시간 */
const EDU_HOURS = 24;

let _edition = null;

/** 이 앱이 어느 판인지. 네이티브가 알려 주는 설치 ID 로 가른다. */
async function edition() {
    if (_edition) return _edition;
    let pkg = "";
    try {
        const U = CapPlugins().Updater;
        if (U && U.appInfo) pkg = (await U.appInfo()).packageName || "";
    } catch (e) { /* 브라우저 미리보기 등 */ }
    _edition = {
        pkg,
        // 설치 이름 끝으로 가른다.
        //   .edu  — 교육용 무료판. 하루만 쓰고 멈춘다.
        //   .beta — 테스트판. 기한이 없다. 손에 들고 계속 만져 봐야 하므로
        //           하루마다 다시 깔게 만들 수 없다.
        beta: /\.beta$/.test(pkg),
        free: /\.(edu|beta)$/.test(pkg),
        // 직원용(판매 · 교육) — pmus.io/app. 실험판에서는 쓰지 않지만 정식판 코드와 맞춰 둔다.
        staff: typeof window !== "undefined" && window.PMUS_EDITION === "staff",
    };
    return _edition;
}

/** 등록 없이 쓰는 판인가 (브라우저 미리보기에서는 아니다) */
export async function isFree() {
    return (await edition()).free;
}

/** 기한 없는 테스트판인가 */
export async function isBeta() {
    return (await edition()).beta;
}

/* -------------------------------------------------------------------
 * 직원용 (판매 · 직원 교육) — https://pmus.io/app
 * 라이선스를 묻지 않는다. 대신 같은 주소(pmus.io)의 웹 관리자에 로그인한
 * '승인된 아이디' 인지 열 때마다 인터넷으로 확인한다.
 *   · 로그인 정보는 웹 관리자(supabase-js)가 저장해 둔 것을 함께 쓴다 (같은 주소라 공유된다).
 *   · 인터넷이 안 되면 열리지 않는다 — 전국 어디서든 인터넷만 되면 된다.
 *   · 관리자 승인을 취소하면 다음에 열 때(또는 30분 안에) 막힌다.
 * ------------------------------------------------------------------- */
const SB_URL = "https://qkdpzsmipwtlzabsfagi.supabase.co";
const SB_KEY = "sb_publishable_bCCohNIlpyFaCOL0MFn-ow_SAs8-YpX";        // 공개 키 (웹페이지에 들어가도 되는 키)
const SB_STORE = "sb-qkdpzsmipwtlzabsfagi-auth-token";                  // supabase-js 가 로그인 정보를 두는 이름

/** 서버(pmus.io/app 잠금)가 보는 쿠키에 로그인 표를 넣는다. 없으면 지운다. */
function staffCookie(sess) {
    try {
        const left = sess && sess.expires_at ? sess.expires_at - Math.floor(Date.now() / 1000) : 0;
        document.cookie = sess && sess.access_token && left > 0
            ? "pmus_at=" + sess.access_token + "; path=/; max-age=" + left + "; secure; samesite=lax"
            : "pmus_at=; path=/; max-age=0; secure; samesite=lax";
    } catch (e) { /* 미리보기 */ }
}

async function staffLicense(deviceCode) {
    const deny = (reason, detail, extra) => Object.assign({
        active: false, staff: true, reason, detail, features: [], daysLeft: null, deviceCode,
    }, extra || {});
    let sess = null;
    try { sess = JSON.parse(localStorage.getItem(SB_STORE) || "null"); } catch (e) { /* 깨진 값 */ }
    if (!sess || !sess.refresh_token) {
        staffCookie(null);
        return deny("직원 로그인이 필요합니다", "pmus.io/admin 에서 승인된 아이디로 로그인해 주세요", { needsLogin: true });
    }
    try {
        // 로그인 표(access token, 1시간짜리)가 35분 안에 끝나면 새로 받는다. 30분마다 다시 보므로
        // 표가 늘 30분 넘게 남아, 쓰는 도중 서버 잠금(쿠키)에 걸리지 않는다.
        // 받은 것은 웹 관리자와 함께 쓰도록 같은 자리에 둔다.
        if (!sess.access_token || !sess.expires_at || sess.expires_at < Date.now() / 1000 + 35 * 60) {
            const r = await fetch(SB_URL + "/auth/v1/token?grant_type=refresh_token", {
                method: "POST", headers: { apikey: SB_KEY, "content-type": "application/json" },
                body: JSON.stringify({ refresh_token: sess.refresh_token }), cache: "no-store",
            });
            if (r.status === 400 || r.status === 401) {
                localStorage.removeItem(SB_STORE);
                staffCookie(null);
                return deny("직원 로그인이 필요합니다", "로그인이 끝났습니다. pmus.io/admin 에서 다시 로그인해 주세요", { needsLogin: true });
            }
            if (!r.ok) throw new Error("token " + r.status);
            const j = await r.json();
            if (!j.expires_at) j.expires_at = Math.floor(Date.now() / 1000) + (j.expires_in || 3600);
            localStorage.setItem(SB_STORE, JSON.stringify(j));
            sess = j;
        }
        const r2 = await fetch(SB_URL + "/rest/v1/admins?select=email", {
            headers: { apikey: SB_KEY, authorization: "Bearer " + sess.access_token }, cache: "no-store",
        });
        if (!r2.ok) throw new Error("admins " + r2.status);
        staffCookie(sess);
        const list = await r2.json();
        if (!list.length) {
            return deny("승인되지 않은 아이디입니다", "개발자에게 승인을 요청해 주세요", { needsLogin: true });
        }
        const email = (sess.user && sess.user.email) || "";
        return {
            active: true, staff: true, features: ["*"],
            payload: { shop: "PMUS 직원용 (판매 · 교육)", plan: "perpetual", feat: ["*"], staff: email },
            daysLeft: null, deviceCode,
        };
    } catch (e) {
        return deny("인터넷 연결이 필요합니다", "직원용은 인터넷에 연결된 곳에서만 열립니다", { staffOffline: true });
    }
}

/** 직원용인가 */
export async function isStaff() {
    return (await edition()).staff;
}

/** 무료판의 남은 시간을 잰다. 처음이면 그때부터 세기 시작한다. */
async function freeLicense(deviceCode) {
    const now = Date.now();

    // 테스트판은 기한을 두지 않는다. 시간을 재지도 않는다.
    if ((await edition()).beta) {
        return {
            active: true,
            free: true,
            beta: true,
            features: ["*"],
            payload: { shop: "테스트판", plan: "beta", feat: ["*"] },
            daysLeft: null, hoursLeft: null, endsAt: null,
            deviceCode,
        };
    }

    let start = parseInt((await Preferences.get({ key: KEY_EDU_START })).value, 10);

    if (!isFinite(start) || start <= 0) {
        start = now;
        await Preferences.set({ key: KEY_EDU_START, value: String(start) });
    } else if (start > now + 60000) {
        // 기기 시각을 앞으로 돌렸다가 되돌린 경우. 시작을 지금으로 다시 잡는다.
        start = now;
        await Preferences.set({ key: KEY_EDU_START, value: String(start) });
    }

    const endsAt = start + EDU_HOURS * 3600 * 1000;
    const msLeft = endsAt - now;

    if (msLeft <= 0) {
        return {
            active: false,
            free: true,
            reason: "교육용 무료 체험이 끝났습니다",
            detail: "계속 쓰시려면 정식 라이선스를 등록해 주세요",
            features: [], daysLeft: 0, hoursLeft: 0, endsAt, deviceCode,
        };
    }

    return {
        active: true,
        free: true,
        features: ["*"],                       // 무료판은 기능을 잠그지 않는다
        payload: { shop: "교육용 무료판", plan: "trial", feat: ["*"] },
        daysLeft: 1,
        hoursLeft: Math.ceil(msLeft / 3600000),
        endsAt,
        deviceCode,
    };
}

/**
 * 정식 웹앱 7일 무료 체험. 처음 연 때부터 센다.
 * 끝나면 라이선스 등록 화면으로 바뀐다 (reason 을 남겨 등록 화면이 알려 준다).
 * 체험 중에도 등록 키를 넣으면 바로 정식으로 바뀐다.
 */
/* -------------------------------------------------------------------
 * 7일 체험을 서버에 기록한다 — 카카오 로그인 (2026-10-16)
 * 예전에는 시작일을 브라우저에만 적어 두어, 브라우저를 바꾸거나 다시 깔면
 * 7일이 새로 시작됐다. 이제 카카오 계정 하나에 체험 한 번, 시작일은 서버
 * (수파베이스 trials 표, start_trial 함수 — license/supabase-trial.sql) 가 정한다.
 *   · 같은 기기 코드로 다른 카카오 계정을 써도 그 기기의 첫 시작일을 따른다.
 *   · 수파베이스에서 카카오 로그인을 켜기 전에는 예전처럼 브라우저 기록으로 돈다
 *     (켜는 순간 저절로 서버 방식으로 바뀐다 — kakaoReady()).
 * ------------------------------------------------------------------- */
const KEY_TRIAL_SESS = "pmus.trialSess";     // 카카오 로그인 정보 (수파베이스 로그인 표)
const KEY_TRIAL_SRV = "blic.trialServer";    // 서버가 정한 체험 시작 시각 (ms)
let _kakaoOn = null;

async function kakaoReady() {
    if (_kakaoOn !== null) return _kakaoOn;
    try {
        const r = await fetch(SB_URL + "/auth/v1/settings", { headers: { apikey: SB_KEY }, cache: "no-store" });
        const j = await r.json();
        _kakaoOn = !!(j.external && j.external.kakao);
        localStorage.setItem("pmus.kakaoOn", _kakaoOn ? "1" : "0");
    } catch (e) {
        _kakaoOn = localStorage.getItem("pmus.kakaoOn") === "1";    // 인터넷이 안 되면 지난번 값
    }
    return _kakaoOn;
}

/** 카카오 로그인 주소 — 로그인하면 지금 화면으로 돌아온다 */
export function kakaoLoginUrl() {
    const back = location.origin + location.pathname;
    return SB_URL + "/auth/v1/authorize?provider=kakao&redirect_to=" + encodeURIComponent(back);
}

/** 카카오 로그인에서 돌아왔으면 주소 끝(#)의 로그인 정보를 저장하고 주소를 깨끗이 한다 */
export function takeLoginFromUrl() {
    if (!/access_token=/.test(location.hash)) return false;
    const q = new URLSearchParams(location.hash.slice(1));
    const sess = {
        access_token: q.get("access_token"),
        refresh_token: q.get("refresh_token"),
        expires_at: Number(q.get("expires_at")) || Math.floor(Date.now() / 1000) + Number(q.get("expires_in") || 3600),
    };
    if (sess.access_token && sess.refresh_token) localStorage.setItem(KEY_TRIAL_SESS, JSON.stringify(sess));
    history.replaceState(null, "", location.pathname + location.search);
    try { sessionStorage.setItem("pmus.trialJustStarted", "1"); } catch (e) { /* 개인 모드 */ }
    return true;
}

/** 로그인 표가 2분 안에 끝나면 새로 받는다. 로그인이 끝났으면 null, 인터넷이 안 되면 오류 */
async function trialSession() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY_TRIAL_SESS) || "null"); } catch (e) { /* 깨진 값 */ }
    if (!s || !s.refresh_token) return null;
    if (s.expires_at && s.expires_at > Date.now() / 1000 + 120) return s;
    const r = await fetch(SB_URL + "/auth/v1/token?grant_type=refresh_token", {
        method: "POST", headers: { apikey: SB_KEY, "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: s.refresh_token }), cache: "no-store",
    });
    if (r.status === 400 || r.status === 401) { localStorage.removeItem(KEY_TRIAL_SESS); return null; }
    if (!r.ok) throw new Error("token " + r.status);
    const j = await r.json();
    s = { access_token: j.access_token, refresh_token: j.refresh_token,
          expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600) };
    localStorage.setItem(KEY_TRIAL_SESS, JSON.stringify(s));
    return s;
}

/**
 * 서버에 체험 시작일을 묻는다 (처음이면 서버가 정한다).
 * 이 브라우저에 예전 방식 시작일이 있으면 넘긴다 — 서버는 그보다 늦추지 않는다.
 */
export async function syncTrial() {
    let s;
    try { s = await trialSession(); } catch (e) { return null; }
    if (!s) return null;
    const local = parseInt((await Preferences.get({ key: KEY_TRIAL_START })).value, 10);
    try {
        const r = await fetch(SB_URL + "/rest/v1/rpc/start_trial", {
            method: "POST",
            headers: { apikey: SB_KEY, authorization: "Bearer " + s.access_token, "content-type": "application/json" },
            body: JSON.stringify({
                hint: isFinite(local) && local > 0 ? new Date(local).toISOString() : null,
                device: await getDeviceCode(),
            }),
            cache: "no-store",
        });
        if (!r.ok) return null;
        const ms = Date.parse(await r.json());
        if (!isFinite(ms)) return null;
        await Preferences.set({ key: KEY_TRIAL_SRV, value: String(ms) });
        await Preferences.set({ key: KEY_TRIAL_START, value: String(ms) });
        return ms;
    } catch (e) {
        return null;
    }
}

/** 시작 시각으로 체험 상태를 만든다 */
function trialFrom(start, deviceCode, fresh) {
    const now = Date.now();
    const endsAt = start + TRIAL_DAYS * 86400 * 1000;
    const msLeft = endsAt - now;
    if (msLeft <= 0) {
        return {
            active: false, trial: true, trialEnded: true,
            reason: TRIAL_DAYS + "일 무료 체험이 끝났습니다",
            detail: "계속 쓰시려면 라이선스를 구매해 등록해 주세요",
            features: [], daysLeft: 0, endsAt, deviceCode,
        };
    }
    return {
        active: true, trial: true, trialFresh: fresh,
        features: ["*"],
        payload: { shop: TRIAL_DAYS + "일 무료 체험", plan: "trial", feat: ["*"] },
        daysLeft: Math.ceil(msLeft / 86400000),
        hoursLeft: Math.ceil(msLeft / 3600000),
        endsAt, deviceCode,
    };
}

async function trialLicense(deviceCode) {
    // 카카오 로그인이 켜져 있으면 서버 기록으로 — 로그인 정보와 서버 시작일이 함께 있어야 한다
    if (await kakaoReady()) {
        let sess = null;
        try { sess = JSON.parse(localStorage.getItem(KEY_TRIAL_SESS) || "null"); } catch (e) { /* 깨진 값 */ }
        let srv = parseInt((await Preferences.get({ key: KEY_TRIAL_SRV })).value, 10);
        if (sess && !isFinite(srv)) srv = await syncTrial();
        if (!sess || !isFinite(srv) || !srv) {
            return {
                active: false, trial: true, needsTrialLogin: true,
                reason: "카카오 로그인으로 7일 무료 체험을 시작합니다",
                features: [], daysLeft: null, deviceCode,
            };
        }
        let fresh = false;
        try { fresh = sessionStorage.getItem("pmus.trialJustStarted") === "1"; sessionStorage.removeItem("pmus.trialJustStarted"); } catch (e) { /* 개인 모드 */ }
        // '체험 시작' 안내는 정말 처음 시작한 때만 (다른 기기에서 다시 로그인한 경우는 안내하지 않는다)
        return trialFrom(srv, deviceCode, fresh && Date.now() - srv < 10 * 60 * 1000);
    }

    // (카카오를 켜기 전) 예전처럼 이 브라우저 기록으로
    const now = Date.now();
    let start = parseInt((await Preferences.get({ key: KEY_TRIAL_START })).value, 10);
    let fresh = false;
    if (!isFinite(start) || start <= 0 || start > now + 60000) {
        start = now;
        fresh = true;
        await Preferences.set({ key: KEY_TRIAL_START, value: String(start) });
    }
    const endsAt = start + TRIAL_DAYS * 86400 * 1000;
    const msLeft = endsAt - now;
    if (msLeft <= 0) {
        return {
            active: false, trial: true, trialEnded: true,
            reason: TRIAL_DAYS + "일 무료 체험이 끝났습니다",
            detail: "계속 쓰시려면 라이선스를 구매해 등록해 주세요",
            features: [], daysLeft: 0, endsAt, deviceCode,
        };
    }
    return {
        active: true, trial: true, trialFresh: fresh,
        features: ["*"],
        payload: { shop: TRIAL_DAYS + "일 무료 체험", plan: "trial", feat: ["*"] },
        daysLeft: Math.ceil(msLeft / 86400000),
        hoursLeft: Math.ceil(msLeft / 3600000),
        endsAt, deviceCode,
    };
}

export async function getLicense() {
    const deviceCode = await getDeviceCode();

    // 직원용은 라이선스 대신 승인된 아이디를 본다
    if ((await edition()).staff) return staffLicense(deviceCode);

    // 무료판은 토큰을 보지 않는다. 등록이라는 절차 자체가 없다.
    if ((await edition()).free) return freeLicense(deviceCode);

    const token = (await Preferences.get({ key: KEY_TOKEN })).value;

    // 정식 웹앱: 아직 등록하지 않았으면 7일 무료 체험
    if (!token && isWebApp()) return trialLicense(deviceCode);

    if (!token) return { active: false, reason: "미등록", features: [], daysLeft: null, deviceCode };

    const res = await verifyToken(token, deviceCode);
    if (!res.ok) {
        return { active: false, reason: res.reason, detail: res.detail, features: [], daysLeft: null, deviceCode };
    }

    if (!(await checkClock())) {
        return {
            active: false,
            reason: "기기 시각이 되돌려졌습니다",
            detail: "설정에서 날짜·시간을 자동으로 맞춘 뒤 다시 실행해 주세요",
            features: [], daysLeft: null, deviceCode,
        };
    }

    const p = res.payload;
    const now = Math.floor(Date.now() / 1000);

    // 원격 사용 중지 (환불 등)
    const revoked = await revokedInfo(p.lic);
    if (revoked) {
        return {
            active: false, revoked: true, revokeReason: revoked.reason || "",
            reason: "이용이 종료되었습니다",
            payload: p, features: [], daysLeft: null, deviceCode,
        };
    }
    // 오래 확인하지 못했으면 인터넷 연결을 요청한다
    const last = parseInt((await Preferences.get({ key: KEY_LAST_CHECK })).value || "0", 10);
    if (!last) {
        await Preferences.set({ key: KEY_LAST_CHECK, value: String(Date.now()) });
    } else if (Date.now() - last > OFFLINE_GRACE_DAYS * 86400000) {
        return {
            active: false, needsOnline: true,
            reason: "라이선스 확인이 필요합니다",
            detail: OFFLINE_GRACE_DAYS + "일 넘게 인터넷에 연결되지 않았습니다. 인터넷에 연결한 뒤 앱을 다시 열어 주세요.",
            payload: p, features: [], daysLeft: null, deviceCode,
        };
    }

    if (p.exp && now > p.exp) {
        return {
            active: false,
            reason: "이용 기간이 만료되었습니다",
            detail: `만료일 ${fmtDate(p.exp)}`,
            payload: p, features: [], daysLeft: 0, deviceCode,
        };
    }

    return {
        active: true,
        payload: p,
        features: p.feat || [],
        daysLeft: p.exp ? Math.ceil((p.exp - now) / 86400) : null,
        deviceCode,
    };
}

/** 받아 둔 사용 중지 목록에 이 라이선스가 있으면 { reason } */
async function revokedInfo(lic) {
    if (!lic) return null;
    try {
        const list = JSON.parse((await Preferences.get({ key: KEY_REVOKED })).value || "{}");
        return list[lic] || null;
    } catch (e) { return null; }
}

/**
 * 공식 주소에서 사용 중지 목록을 받아 둔다. 인터넷이 없으면 그대로 둔다.
 * 깃허브 서버가 파일을 10분쯤 들고 있으므로 주소 끝에 매번 다른 값을 붙인다.
 * @returns 목록을 새로 받았으면 true
 */
export async function syncRevocations() {
    // 직원용은 사용 중지 목록 대신 열 때마다 승인을 다시 본다 — 그대로 getLicense 로 넘긴다
    if ((await edition()).staff) return true;
    // 체험 중인 웹앱은 서버 시작일도 다시 받아 둔다 (브라우저 기록을 고쳐 늘리는 것 막기)
    if (isWebApp() && !(await Preferences.get({ key: KEY_TOKEN })).value && localStorage.getItem(KEY_TRIAL_SESS)) {
        await syncTrial();
    }
    try {
        const ctrl = typeof AbortController === "function" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 5000) : 0;
        const r = await fetch(REVOKE_URL + "?fresh=" + Date.now(), { cache: "no-store", signal: ctrl ? ctrl.signal : undefined });
        if (timer) clearTimeout(timer);
        if (!r.ok) return false;
        const data = await r.json();
        const map = {};
        (data.revoked || []).forEach((x) => { if (x && x.lic) map[x.lic] = { reason: x.reason || "", at: x.at || "" }; });
        await Preferences.set({ key: KEY_REVOKED, value: JSON.stringify(map) });
        await Preferences.set({ key: KEY_LAST_CHECK, value: String(Date.now()) });
        return true;
    } catch (e) {
        return false;
    }
}

/** 토큰을 저장(활성화)합니다. 검증에 실패하면 저장하지 않습니다. */
export async function activate(token) {
    const deviceCode = await getDeviceCode();
    const res = await verifyToken(token, deviceCode);
    if (!res.ok) return res;
    await syncRevocations();
    if (await revokedInfo(res.payload.lic)) {
        return { ok: false, reason: "이용이 종료된 라이선스입니다", detail: "새 라이선스를 등록해 주세요" };
    }

    const now = Math.floor(Date.now() / 1000);
    if (res.payload.exp && now > res.payload.exp) {
        return { ok: false, reason: "이미 만료된 라이선스입니다", detail: `만료일 ${fmtDate(res.payload.exp)}` };
    }

    await Preferences.set({ key: KEY_TOKEN, value: String(token).trim().replace(/\s+/g, "") });
    await Preferences.set({ key: KEY_SEEN, value: String(now) });
    return { ok: true, payload: res.payload };
}

export async function deactivate() {
    await Preferences.remove({ key: KEY_TOKEN });
}

// ── 표시용 헬퍼 ──────────────────────────────────────────────────────────

export function fmtDate(ts) {
    if (!ts) return "무기한";
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}

export function featureLabel(f) {
    if (f === "*") return "전체 기능 (향후 추가분 포함)";
    return (FEATURES[f] && FEATURES[f].label) || f;
}
export function planLabel(p) { return PLAN_LABEL[p] || p; }
