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

export async function getLicense() {
    const deviceCode = await getDeviceCode();

    // 무료판은 토큰을 보지 않는다. 등록이라는 절차 자체가 없다.
    if ((await edition()).free) return freeLicense(deviceCode);

    const token = (await Preferences.get({ key: KEY_TOKEN })).value;

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

/** 토큰을 저장(활성화)합니다. 검증에 실패하면 저장하지 않습니다. */
export async function activate(token) {
    const deviceCode = await getDeviceCode();
    const res = await verifyToken(token, deviceCode);
    if (!res.ok) return res;

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
