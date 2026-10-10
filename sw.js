/* 자동 생성 — tools/build-web.mjs. 직접 고치지 말 것. */
/**
 * 아이폰 웹앱이 인터넷 없이도 열리게 한다.
 *
 * 처음 열 때 아래 목록을 전부 받아 폰에 둔다. 판 번호(VERSION)가 바뀐 sw.js 가
 * 올라오면 새 목록을 받아 두고 '기다림' 상태로 있다가, 앱이 SKIP_WAITING 을
 * 보내면(앱을 새로 열 때 · 버전 화면에서 적용을 누를 때) 넘어간다.
 * 상담 도중에 화면이 바뀌지 않게 하려는 것이다.
 *
 * clients.claim() 은 하지 않는다. 처음 연 날 화면이 한 번 더 새로 뜨는 것을 막는다.
 */
const VERSION = "pmuslab-89";
const PRECACHE = ["assets/eyebrow_refs/female_arch_combo.png","assets/eyebrow_refs/female_arch_gradation.png","assets/eyebrow_refs/female_arch_natural.png","assets/eyebrow_refs/female_semiarch_combo.png","assets/eyebrow_refs/female_semiarch_gradation.png","assets/eyebrow_refs/female_semiarch_natural.png","assets/eyebrow_refs/female_straight_combo.png","assets/eyebrow_refs/female_straight_gradation.png","assets/eyebrow_refs/female_straight_natural.png","assets/eyebrow_refs/male_straight_combo.png","assets/eyebrow_refs/male_straight_gradation.png","assets/eyebrow_refs/male_straight_natural.png","assets/icons/icon-180.png","assets/icons/icon-192.png","assets/icons/icon-512.png","assets/icons/icon-maskable-512.png","assets/logo-full.png","assets/logo.png","assets/models/female_20s.jpg","assets/models/female_30s.jpg","assets/models/female_40s.jpg","assets/models/female_50s.jpg","assets/models/female_60s.jpg","assets/models/male_20s.jpg","assets/models/male_30s.jpg","assets/models/male_40s.jpg","assets/models/male_50s.jpg","assets/models/male_60s.jpg","changelog.json","css/app.css","css/brow.css","css/lip.css","css/mobile-ui.css","index.html","js/app.js","js/brow-canvas.js","js/brow-erase.js","js/brow-markup.html","js/crm-store.js","js/crm-ui.js","js/custom-designs.js","js/face-detect.js","js/license.js","js/lip-canvas.js","js/lip-markup.html","js/mobile-ui.js","js/prepare-eyebrow.js","js/pwa.js","js/remind.js","js/update.js","manifest.webmanifest","models/face_landmarker.task","vendor/vision_bundle.mjs","vendor/wasm/vision_wasm_internal.js","vendor/wasm/vision_wasm_internal.wasm"];

self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE.map((f) => "./" + f))));
});

self.addEventListener("activate", (e) => {
    e.waitUntil(caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("pmuslab-") && k !== VERSION).map((k) => caches.delete(k)))));
});

self.addEventListener("message", (e) => {
    if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;       // 다른 곳(드라이브 등)은 그대로

    e.respondWith((async () => {
        const cache = await caches.open(VERSION);
        // 주소 뒤의 ?v=NN 은 캐시 무효화용이라 무시하고 찾는다
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === "navigate") {
            const index = await cache.match("./index.html");
            if (index) return index;
        }
        try {
            const res = await fetch(req);
            // 메뉴얼 영상·그림처럼 목록에 없던 것은 한 번 받으면 넣어 둔다
            if (res.ok && res.type === "basic") cache.put(req, res.clone());
            return res;
        } catch (err) {
            return new Response("인터넷에 연결되어 있지 않습니다.", {
                status: 503, headers: { "content-type": "text/plain; charset=utf-8" },
            });
        }
    })());
});
