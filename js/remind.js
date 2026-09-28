/**
 * remind.js — 리터치 알림
 * =========================================================================
 * 반영구는 한 번으로 끝나지 않는다. 리터치 시기를 놓치면 색이 빠지고,
 * 고객은 '그 집은 금방 지워지더라' 로 기억한다. 원장님 잘못이 아니라
 * 그냥 때를 놓친 것인데도 그렇다.
 *
 * 그래서 예정일이 다가오면 앱이 먼저 알린다. 다섯 단계로 나누지 않고
 * 5일 전 · 3일 전 · 1일 전 셋으로 둔 것은, 한 번은 놓쳐도 두 번째나
 * 세 번째에 걸리게 하되 알림이 잔소리가 되지 않게 하려는 것이다.
 *
 * ── 기기 안에서만 ───────────────────────────────────────────────────
 * 서버에서 밀어 주는 알림(푸시)이 아니라 **기기가 스스로 우는** 방식이다.
 * 계정도, 서버도, 통신도 필요 없다. 고객 이름이 남의 서버를 거치지 않는
 * 것도 이 방식을 고른 이유다.
 *
 * ── 알림 번호를 어떻게 짓나 ─────────────────────────────────────────
 * 안드로이드는 알림을 정수 하나로 가린다. 예정일을 바꾸면 먼저 걸어 둔
 * 것을 취소해야 하는데, 그러려면 같은 이력에서 늘 같은 번호가 나와야 한다.
 * 그래서 이력 id 를 해시해 번호를 만든다 — 저장해 둘 필요가 없다.
 * =========================================================================
 */

/** 예정일 며칠 전에 울릴지 */
export const LEAD_DAYS = [5, 3, 1];

/** 그날 몇 시에 울릴지. 문 열기 전(10시)이 가장 눈에 띈다. */
const HOUR = 10;

function plugin() {
    const C = window.Capacitor;
    return (C && C.Plugins && C.Plugins.LocalNotifications) || null;
}

/** 이 기기에서 알림을 쓸 수 있는지 (브라우저 미리보기에서는 못 쓴다) */
export function available() {
    return !!plugin();
}

/**
 * 알림 번호. 같은 이력 · 같은 단계면 언제 계산해도 같은 값이 나온다.
 * 안드로이드가 32비트 정수를 쓰므로 그 안에 들어오게 접는다.
 */
function notifyId(visitId, lead) {
    let h = 2166136261;
    const s = visitId + "#" + lead;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    // 양수로, 그리고 다른 용도와 겹치지 않게 1000만 위로 올린다
    return 10000000 + (Math.abs(h) % 2000000000);
}

/** 이력 하나가 쓰는 알림 번호 전부 */
export function idsOf(visitId) {
    return LEAD_DAYS.map((d) => notifyId(visitId, d));
}

/** 그날 오전 10시 */
function at(dayTs, minusDays) {
    const d = new Date(dayTs);
    d.setDate(d.getDate() - minusDays);
    d.setHours(HOUR, 0, 0, 0);
    return d;
}

/**
 * 알림을 보내도 되는지 묻는다. 안드로이드 13 부터 허락이 필요하다.
 * @returns {Promise<boolean>}
 */
export async function ensurePermission() {
    const P = plugin();
    if (!P) return false;
    try {
        let s = await P.checkPermissions();
        if (s.display !== "granted") s = await P.requestPermissions();
        return s.display === "granted";
    } catch (e) {
        return false;
    }
}

/**
 * 한 이력의 리터치 알림을 다시 건다. 먼저 걸어 둔 것은 지우고 새로 건다.
 *
 * 이미 지난 시각은 걸지 않는다. 예정일이 사흘 뒤면 5일 전 알림은 버리고
 * 3일 전·1일 전만 남는다.
 *
 * @returns {Promise<number>} 실제로 걸린 개수
 */
export async function schedule(visit, customer) {
    const P = plugin();
    if (!P || !visit) return 0;

    await cancel(visit.id);
    if (!visit.retouchAt) return 0;

    const now = Date.now();
    const where = visit.area === "lip" ? "입술" : "눈썹";
    const who = (customer && customer.name) || "고객";

    const list = [];
    for (const lead of LEAD_DAYS) {
        const when = at(visit.retouchAt, lead);
        if (when.getTime() <= now) continue;          // 이미 지난 때는 걸지 않는다
        list.push({
            id: notifyId(visit.id, lead),
            title: `${who} 님 ${where} 리터치 ${lead}일 전`,
            body: `${fmt(visit.retouchAt)} 예정입니다. 연락 드려 보세요.`,
            schedule: { at: when, allowWhileIdle: true },
            // 눌렀을 때 어느 고객인지 알 수 있게 들려 보낸다
            extra: { customerId: visit.customerId, visitId: visit.id },
        });
    }
    if (!list.length) return 0;

    await P.schedule({ notifications: list });
    return list.length;
}

/** 한 이력에 걸린 알림을 전부 지운다 */
export async function cancel(visitId) {
    const P = plugin();
    if (!P || !visitId) return;
    try {
        await P.cancel({ notifications: idsOf(visitId).map((id) => ({ id })) });
    } catch (e) { /* 안 걸려 있으면 그만 */ }
}

/** 지금 걸려 있는 알림 (확인용) */
export async function pending() {
    const P = plugin();
    if (!P) return [];
    try {
        const r = await P.getPending();
        return (r && r.notifications) || [];
    } catch (e) {
        return [];
    }
}

/** 알림을 누르면 그 고객 카드를 연다 */
export function onTap(fn) {
    const P = plugin();
    if (!P || !P.addListener) return;
    P.addListener("localNotificationActionPerformed", (e) => {
        const x = (e && e.notification && e.notification.extra) || {};
        if (x.customerId) fn(x.customerId, x.visitId);
    });
}

function fmt(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}
