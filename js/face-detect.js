/**
 * face-detect.js
 * =========================================================================
 * app.py 의 파이썬 얼굴/입술 인식 로직을 브라우저용으로 1:1 포팅한 모듈.
 *
 *   Python                          →  JavaScript
 *   ---------------------------------------------------------------
 *   mediapipe.solutions.face_mesh   →  @mediapipe/tasks-vision FaceLandmarker
 *   detect_face_landmarks()         →  detectEyeCenters()
 *   detect_lip_landmarks()          →  detectLipLandmarks()
 *   smooth_closed_contour()         →  smoothClosedContour()
 *   smooth_landmark_curve()         →  smoothLandmarkCurve()
 *
 * 랜드마크 인덱스는 FaceMesh 478점 표준으로 데스크톱판과 완전히 동일합니다.
 * 모델·WASM 모두 로컬 번들이라 인터넷 없이 동작합니다.
 * =========================================================================
 */

import { FaceLandmarker, FilesetResolver } from "../vendor/vision_bundle.mjs";

// ── 랜드마크 인덱스 (app.py 와 동일) ──────────────────────────────────────
const LEFT_EYE_PTS  = [33, 133, 159, 145];
const RIGHT_EYE_PTS = [362, 263, 386, 374];

// 눈썹 (위·아래 줄을 합쳐 한 쪽당 10점). 화면 기준 왼쪽/오른쪽이다.
const BROW_L_IDX = [70, 63, 105, 66, 107, 46, 53, 52, 65, 55];
const BROW_R_IDX = [300, 293, 334, 296, 336, 276, 283, 282, 295, 285];
// 눈썹 앞머리 기준 — 앞눈꼬리(눈 안쪽 끝). 화면 기준 왼쪽/오른쪽.
// 처음엔 콧등 옆면(193/417)으로 했다가 원장님이 "보통 앞눈꼬리에서 시작한다"고 해서 바꿨다.
const HEAD_ANCHOR_L = 133;
const HEAD_ANCHOR_R = 362;

const UPPER_OUTER_IDX = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291];
const LOWER_OUTER_IDX = [291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61];
const UPPER_INNER_IDX = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const LOWER_INNER_IDX = [308, 324, 318, 402, 317, 14, 87, 178, 88, 95, 78];

let _landmarker = null;
let _loadingPromise = null;
let _delegate = null;        // 실제로 쓰이고 있는 가속 방식 ("GPU" | "CPU")
let _engineError = null;     // 엔진을 아예 못 세운 경우의 사유

/** 지금 인식 엔진이 어떤 상태인지. (기기별 문제를 확인할 때 쓴다) */
export function engineStatus() {
    return { ready: !!_landmarker, delegate: _delegate, error: _engineError };
}

async function createLandmarker(delegate) {
    const fileset = await FilesetResolver.forVisionTasks("./vendor/wasm");
    return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
            modelAssetPath: "./models/face_landmarker.task",
            delegate: delegate,
        },
        runningMode: "IMAGE",
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
    });
}

/**
 * FaceLandmarker 를 1회만 로드하고 재사용합니다.
 *
 * GPU 가속은 기기·드라이버를 많이 탄다. 같은 안드로이드라도 어떤 폰은
 * GPU 경로가 통째로 실패해서 얼굴이 하나도 안 잡힌다. 그래서 GPU 가
 * 안 되면 CPU(XNNPACK)로 한 번 더 세운다. CPU 는 조금 느릴 뿐
 * 거의 모든 기기에서 동작한다.
 */
export async function initFaceLandmarker(onProgress) {
    if (_landmarker) return _landmarker;
    if (_loadingPromise) return _loadingPromise;

    _loadingPromise = (async () => {
        if (onProgress) onProgress("얼굴 인식 엔진 로딩 중...");
        try {
            _landmarker = await createLandmarker("GPU");
            _delegate = "GPU";
        } catch (gpuErr) {
            console.warn("GPU 가속 실패 — CPU 로 다시 시도합니다.", gpuErr);
            if (onProgress) onProgress("얼굴 인식 엔진 준비 중 (CPU)...");
            _landmarker = await createLandmarker("CPU");
            _delegate = "CPU";
        }
        _engineError = null;
        if (onProgress) onProgress("준비 완료");
        return _landmarker;
    })();

    try {
        return await _loadingPromise;
    } catch (e) {
        _loadingPromise = null;
        _engineError = e && e.message ? e.message : String(e);
        throw e;
    }
}

let _cpuRetried = false;

/**
 * 내부 공용: 이미지에서 478개 랜드마크를 뽑습니다.
 *
 * 얼굴이 없어도, 엔진이 이 기기에서 안 돌아가도 **예외를 던지지 않고**
 * null 을 돌려준다. 부르는 쪽은 그때 기본 모양으로 넘어가면 된다.
 * 예전에는 여기서 던진 예외가 그대로 올라가 시뮬레이터가 아예 안 열렸다.
 */
/**
 * 인식 결과가 말이 되는 좌표인지 본다.
 *
 * 갤럭시 S25 엣지에서 인식은 '성공' 하는데 좌표가 0~1 이 아니라 x≈219,
 * y≈-54 로 나왔다. 그 값으로 눈썹 자리를 잡으니 사진 밖 23만 픽셀
 * 지점에 그려져서, 오류 한 줄 없이 눈썹만 안 보였다. 입술도 같은 이유로
 * 색이 화면 밖에 칠해지고 있었다.
 *
 * 정규화 좌표는 얼굴이 화면 밖으로 조금 나가도 -0.5~1.5 안에 있다.
 * 그 밖이면 얼굴을 못 찾은 것보다 나쁘다 — 못 찾으면 기본 자리로
 * 넘어가기라도 하는데, 이상한 값은 그대로 믿고 쓰기 때문이다.
 */
function _looksSane(marks) {
    if (!marks || marks.length < 100) return false;
    // 478 점을 다 보면 느리다. 고르게 흩어진 스물 몇 점이면 충분하다.
    const step = Math.max(1, Math.floor(marks.length / 24));
    for (let i = 0; i < marks.length; i += step) {
        const m = marks[i];
        if (!m || !isFinite(m.x) || !isFinite(m.y)) return false;
        if (m.x < -0.5 || m.x > 1.5 || m.y < -0.5 || m.y > 1.5) return false;
    }
    return true;
}

/** 이상한 좌표를 진단 화면에 남길 수 있게 한 줄로 요약한다. */
function _describe(marks) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < marks.length; i += 17) {
        const m = marks[i];
        if (!m) continue;
        if (m.x < x0) x0 = m.x;
        if (m.x > x1) x1 = m.x;
        if (m.y < y0) y0 = m.y;
        if (m.y > y1) y1 = m.y;
    }
    const r = (v) => (isFinite(v) ? Math.round(v * 100) / 100 : "?");
    return "x " + r(x0) + "~" + r(x1) + " · y " + r(y0) + "~" + r(y1) + " (0~1 이어야 함)";
}

/** 세워 둔 엔진을 내리고 CPU 로 다시 세운다. */
async function _rebuildOnCpu() {
    if (_landmarker && _landmarker.close) { try { _landmarker.close(); } catch (x) {} }
    _landmarker = null;
    _loadingPromise = null;
    _landmarker = await createLandmarker("CPU");
    _delegate = "CPU";
}

/** 넣어 준 그림 한 장으로 한 번만 본다. 못 찾으면 null. */
async function _detectOnce(imgEl) {
    // 빈 문자열이면 '얼굴이 없었다', 채워져 있으면 '엔진이 이상하다'.
    // 뒤쪽만 CPU 로 다시 본다.
    let trouble = "";
    try {
        const lm = await initFaceLandmarker();
        const res = lm.detect(imgEl);
        if (!res || !res.faceLandmarks || res.faceLandmarks.length === 0) return null;
        const marks = res.faceLandmarks[0];
        if (_looksSane(marks)) return marks;
        trouble = "좌표가 이상함 — " + _describe(marks);
        console.warn("얼굴 인식", trouble);
    } catch (e) {
        console.warn("얼굴 인식 실패", e);
        trouble = (e && e.message) ? e.message : String(e);
    }

    // GPU 로 세운 엔진이 정작 인식할 때 터지거나, 터지지는 않고 엉뚱한
    // 좌표를 돌려주는 기기가 있다. 딱 한 번 CPU 로 다시 세워 본다.
    if (!_cpuRetried && _delegate !== "CPU") {
        _cpuRetried = true;
        _engineError = "GPU: " + trouble + " → CPU 로 다시 세움";
        try {
            await _rebuildOnCpu();
            const res = _landmarker.detect(imgEl);
            if (!res || !res.faceLandmarks || res.faceLandmarks.length === 0) return null;
            const marks = res.faceLandmarks[0];
            if (_looksSane(marks)) return marks;
            _engineError = "GPU·CPU 모두 좌표가 이상함 — " + _describe(marks);
            console.warn("CPU 로도", _engineError);
        } catch (e2) {
            console.warn("CPU 재시도도 실패", e2);
            _engineError = "GPU: " + trouble + " / CPU: "
                         + ((e2 && e2.message) ? e2.message : String(e2));
        }
    } else if (trouble) {
        _engineError = (_delegate || "엔진") + ": " + trouble;
    }
    return null;
}

/** 그림을 다른 모양으로 다시 그려 준다. 실패하면 null (메모리가 모자란 경우 등). */
function _redraw(imgEl, w, h, drawer) {
    try {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        drawer(c.getContext("2d"), c.width, c.height);
        return c;
    } catch (e) {
        return null;
    }
}

/**
 * 얼굴 찾기. 한 번에 못 찾으면 그림을 바꿔 가며 몇 번 더 본다.
 *
 * 같은 사진인데 기기에 따라 되고 안 되는 일이 있었다. 인식 모델은 넣어 준
 * 그림을 정해진 크기로 줄여 보는데, 그 줄이는 방식이 기기마다 달라 얼굴이
 * 화면을 꽉 채우거나 아주 클 때 놓치는 경우가 있다.
 *
 *   1) 받은 그대로
 *   2) 긴 변 640px 로 줄여서 — 너무 큰 그림에서 놓치는 경우
 *   3) 80% 로 줄여 여백을 두르고 — 얼굴이 화면을 꽉 채워 놓치는 경우
 *
 * 2·3 은 좌표계가 달라지므로 원본 기준으로 되돌려 돌려준다.
 * 한 번에 찾으면 2·3 은 아예 하지 않는다 (평소에는 느려지지 않는다).
 */
async function _detect(imgEl) {
    const first = await _detectOnce(imgEl);
    if (first) return first;

    const w = imgEl.naturalWidth || imgEl.width;
    const h = imgEl.naturalHeight || imgEl.height;
    if (!w || !h) return null;

    // ── 2) 작게 줄여서 ──
    const long = Math.max(w, h);
    if (long > 720) {
        const k = 640 / long;
        const small = _redraw(imgEl, w * k, h * k, (x, cw, ch) => {
            x.drawImage(imgEl, 0, 0, cw, ch);
        });
        if (small) {
            const got = await _detectOnce(small);
            small.width = 0; small.height = 0;
            if (got) {
                console.info("얼굴 인식: 축소본에서 찾음");
                return got;          // 정규화 좌표라 그대로 쓸 수 있다
            }
        }
    }

    // ── 3) 여백을 둘러서 ──
    const PAD = 0.8;                 // 그림을 80% 로 넣고 둘레를 비운다
    const padded = _redraw(imgEl, w, h, (x, cw, ch) => {
        x.fillStyle = "#7a7a7a";     // 검정·흰색보다 살빛에 덜 간섭한다
        x.fillRect(0, 0, cw, ch);
        x.drawImage(imgEl, cw * (1 - PAD) / 2, ch * (1 - PAD) / 2, cw * PAD, ch * PAD);
    });
    if (padded) {
        const got = await _detectOnce(padded);
        padded.width = 0; padded.height = 0;
        if (got) {
            console.info("얼굴 인식: 여백을 두른 뒤 찾음");
            const off = (1 - PAD) / 2;
            return got.map((m) => ({
                x: (m.x - off) / PAD,
                y: (m.y - off) / PAD,
                z: m.z,
            }));
        }
    }

    return null;
}

/**
 * 얼굴만 잘라 한 번 더 인식한다.
 *
 * 인식 모델은 넣어 준 그림을 정해진 크기로 줄여서 본다. 상반신까지 나온
 * 사진에서는 입이 그 안에서 얼마 안 되는 자리를 차지해, 인중선(입술산)처럼
 * 작은 굴곡이 뭉개진 채로 나온다.
 * 1차로 얼굴 자리를 잡고, 그 얼굴만 잘라 다시 넣으면 같은 크기를 얼굴에만
 * 쓰게 되어 훨씬 촘촘한 좌표가 나온다.
 *
 * 얼굴이 이미 사진을 거의 채우고 있으면 두 번 볼 이유가 없어 그대로 쓴다.
 * 2차가 실패해도 1차 결과를 돌려준다 — 정밀도는 '있으면 좋은 것'이다.
 *
 * @returns 원본 사진 기준으로 정규화된 랜드마크 배열 (0~1)
 */
async function _detectFine(imgEl) {
    const first = await _detect(imgEl);
    if (!first) return null;

    const w = imgEl.naturalWidth || imgEl.width;
    const h = imgEl.naturalHeight || imgEl.height;

    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (let i = 0; i < first.length; i++) {
        const m = first[i];
        if (m.x < minX) minX = m.x;
        if (m.x > maxX) maxX = m.x;
        if (m.y < minY) minY = m.y;
        if (m.y > maxY) maxY = m.y;
    }

    const padX = (maxX - minX) * 0.14, padY = (maxY - minY) * 0.14;
    const x0 = Math.max(0, Math.floor((minX - padX) * w));
    const y0 = Math.max(0, Math.floor((minY - padY) * h));
    const x1 = Math.min(w, Math.ceil((maxX + padX) * w));
    const y1 = Math.min(h, Math.ceil((maxY + padY) * h));
    const cw = x1 - x0, ch = y1 - y0;

    // 얼굴이 이미 크게 잡혀 있거나 잘라낼 것이 없으면 그대로
    if (cw < 64 || ch < 64 || (cw > w * 0.85 && ch > h * 0.85)) return first;

    let second = null;
    const c = document.createElement("canvas");
    try {
        c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(imgEl, x0, y0, cw, ch, 0, 0, cw, ch);
        second = await _detect(c);
    } catch (e) {
        console.warn("2차 인식 건너뜀", e);
    } finally {
        c.width = 0; c.height = 0;              // 저사양 기기에서 바로 반납
    }
    if (!second || second.length !== first.length) return first;

    // 잘라낸 좌표계 → 원본 사진 좌표계
    return second.map((m) => ({
        x: (x0 + m.x * cw) / w,
        y: (y0 + m.y * ch) / h,
        z: m.z,
    }));
}

const r1 = (v) => Math.round(v * 10) / 10;   // 파이썬 round(x, 1) 과 동일
const r4 = (v) => Math.round(v * 10000) / 10000;

/**
 * 좌/우 눈 중심 좌표 검출.
 * Python detect_face_landmarks() 대응.
 * @returns {{left:{x,y}, right:{x,y}} | null}
 */
export async function detectEyeCenters(imgEl) {
    const geo = await detectFaceGeometry(imgEl);
    return geo ? geo.eyes : null;
}

/**
 * 눈 중심과 **실제 눈썹의 자리·길이·기울기**를 한 번의 인식으로 같이 얻는다.
 *
 * 눈썹을 따로 재는 이유: 눈 위치만으로 잡으면 '눈에서 얼마쯤 위'라는 평균값에
 * 기대게 되어, 눈썹이 원래 높거나 낮은 사람, 길거나 짧은 사람에게서 어긋난다.
 * 퀵은 얹자마자 그럴듯해야 하므로 눈썹 자체를 보고 맞춘다.
 *
 * 모델을 두 번 돌리지 않는 것도 중요하다. 저사양 기기에서는 인식 한 번이
 * 그대로 메모리 부담이라, 눈과 눈썹을 한 번에 뽑는다.
 */
export async function detectFaceGeometry(imgEl) {
    const marks = await _detect(imgEl);
    if (!marks) return null;

    const w = imgEl.naturalWidth || imgEl.width;
    const h = imgEl.naturalHeight || imgEl.height;

    const avg = (idxs, key, size) =>
        idxs.reduce((s, i) => s + marks[i][key], 0) / idxs.length * size;

    /** 한쪽 눈썹의 중심·길이·기울기. 길이는 머리를 기울여도 같게 나오도록
     *  양 끝점 사이의 실제 거리로 잰다. */
    const browOf = (idxs) => {
        const pts = idxs.map((i) => [marks[i].x * w, marks[i].y * h]);
        let head = pts[0], tail = pts[0];
        pts.forEach((p) => {
            if (p[0] < head[0]) head = p;
            if (p[0] > tail[0]) tail = p;
        });
        const ys = pts.map((p) => p[1]);
        return {
            cx: pts.reduce((a, p) => a + p[0], 0) / pts.length,
            cy: pts.reduce((a, p) => a + p[1], 0) / pts.length,
            width: Math.hypot(tail[0] - head[0], tail[1] - head[1]),
            height: Math.max(1, Math.max.apply(null, ys) - Math.min.apply(null, ys)),
            angle: (Math.atan2(tail[1] - head[1], tail[0] - head[0]) * 180) / Math.PI,
            // 원래 눈썹을 흐리게 할 때 그 자리를 덮는 데 쓴다 (brow-erase.js).
            // 윗줄 5점 → 아랫줄 5점, 각 줄은 꼬리에서 머리 쪽으로.
            pts: pts.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]),
        };
    };

    const geo = {
        eyes: {
            left:  { x: avg(LEFT_EYE_PTS,  "x", w), y: avg(LEFT_EYE_PTS,  "y", h) },
            right: { x: avg(RIGHT_EYE_PTS, "x", w), y: avg(RIGHT_EYE_PTS, "y", h) },
        },
        brows: { left: browOf(BROW_L_IDX), right: browOf(BROW_R_IDX) },
    };
    // 눈썹 앞머리가 시작할 자리 = 앞눈꼬리 세로선. 원래 눈썹 앞머리 점(107/336)은
    // 실제 털과 어긋나는 일이 많아 기준으로 쓰지 않는다.
    // (이름이 nose 인 것은 처음에 콧등 옆면을 썼던 흔적이다. 쓰는 곳: prepare-eyebrow.js)
    const at = (i) => ({ x: marks[i].x * w, y: marks[i].y * h });
    geo.brows.left.nose = at(HEAD_ANCHOR_L);
    geo.brows.right.nose = at(HEAD_ANCHOR_R);

    // 마지막으로 한 번 더 본다. 여기서 내보낸 값은 눈썹 자리·크기와
    // 입술선의 기준이 되므로, 사진 밖의 값이 새어 나가면 아무것도 안 보인다.
    // 그럴 바에는 '못 찾았다'고 하는 편이 낫다 — 기본 자리로 넘어가서
    // 손으로 옮길 수라도 있다.
    const inFrame = (p) => p && isFinite(p.x) && isFinite(p.y)
        && p.x > -w * 0.2 && p.x < w * 1.2
        && p.y > -h * 0.2 && p.y < h * 1.2;
    const eyeDist = Math.hypot(geo.eyes.right.x - geo.eyes.left.x,
                               geo.eyes.right.y - geo.eyes.left.y);
    if (!inFrame(geo.eyes.left) || !inFrame(geo.eyes.right)
        || !(eyeDist > w * 0.04 && eyeDist < w * 0.95)) {
        _engineError = "눈 자리가 사진 밖 (" + Math.round(geo.eyes.left.x) + ","
                     + Math.round(geo.eyes.left.y) + " / 눈 사이 " + Math.round(eyeDist) + "px)";
        console.warn("얼굴 인식", _engineError);
        return null;
    }
    return geo;
}

// ── 스무딩 (Catmull-Rom) ─────────────────────────────────────────────────

function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    const x = 0.5 * ((2 * p1[0]) +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
    const y = 0.5 * ((2 * p1[1]) +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
    return [r1(x), r1(y)];
}

/** Python smooth_closed_contour() 대응 (주기 스플라인). */
export function smoothClosedContour(pts, numOutputPts = 80) {
    if (pts.length < 4) return pts;
    const n = pts.length;
    const result = [];
    const steps = Math.max(2, Math.floor(numOutputPts / n));

    for (let i = 0; i < n; i++) {
        const p0 = pts[(i - 1 + n) % n];
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        const p3 = pts[(i + 2) % n];
        for (let s = 0; s < steps; s++) {
            result.push(catmullRom(p0, p1, p2, p3, s / steps));
        }
    }
    if (result.length > 0) result.push(result[0]);
    return result;
}

/** Python smooth_landmark_curve() 대응 (가중 스무딩 + 스플라인). */
export function smoothLandmarkCurve(pts, numOutputPts = 25) {
    if (pts.length < 3) return pts;

    // 1) 이동 가중치 스무딩
    const n = pts.length;
    const smoothed = [];
    for (let i = 0; i < n; i++) {
        if (i === 0 || i === n - 1) {
            smoothed.push(pts[i]);
        } else {
            const a = pts[i - 1], b = pts[i], c = pts[i + 1];
            smoothed.push([
                r1(0.25 * a[0] + 0.5 * b[0] + 0.25 * c[0]),
                r1(0.25 * a[1] + 0.5 * b[1] + 0.25 * c[1]),
            ]);
        }
    }

    // 2) Catmull-Rom 고밀도 곡선
    const m = smoothed.length;
    const result = [];
    const steps = Math.max(2, Math.floor(numOutputPts / (m - 1)));
    for (let i = 0; i < m - 1; i++) {
        const p0 = smoothed[Math.max(0, i - 1)];
        const p1 = smoothed[i];
        const p2 = smoothed[i + 1];
        const p3 = smoothed[Math.min(m - 1, i + 2)];
        for (let s = 0; s < steps; s++) {
            result.push(catmullRom(p0, p1, p2, p3, s / steps));
        }
    }
    result.push(smoothed[m - 1]);
    return result;
}

/**
 * 입술 랜드마크 정밀 검출.
 * Python detect_lip_landmarks() 대응 — lip_json 과 동일한 구조를 돌려줍니다.
 * 얼굴을 못 찾으면 null (호출부에서 모델 템플릿으로 대체).
 */
/**
 * 검출한 입술선을 다듬는다.
 *
 * 실제 입술은 좌우가 조금씩 다르고 가장자리가 울퉁불퉁하다. 그대로 쓰면
 * 오버립을 줄 때 그 울퉁불퉁함까지 같이 커진다.
 * 사람의 생김새는 남기고 삐뚤어짐만 줄인다 — 완전한 대칭으로 만들지 않는 이유다.
 *
 * @param curves [윗바깥, 아랫바깥, 윗안쪽, 아랫안쪽] 각 11점
 * @param sym    좌우를 얼마나 맞출지 (0 = 그대로, 1 = 완전 대칭)
 */
function refineLipRaw(curves, sym, keep) {
    const uo = curves[0];
    if (!uo || uo.length < 3) return curves;

    // 입꼬리 두 점으로 좌표계를 세운다. 고개가 기울어도 같게 다뤄진다.
    const L = uo[0], R = uo[uo.length - 1];
    const ax = R[0] - L[0], ay = R[1] - L[1];
    const len = Math.hypot(ax, ay) || 1;
    const ux = ax / len, uy = ay / len;      // 입꼬리를 잇는 방향
    const vx = -uy, vy = ux;                 // 그 수직 (입술 두께 방향)
    const cx = (L[0] + R[0]) / 2, cy = (L[1] + R[1]) / 2;

    return curves.map((pts, ci) => {
        const n = pts && pts.length;
        if (!n || n < 3) return pts;

        const q = pts.map((p) => {
            const dx = p[0] - cx, dy = p[1] - cy;
            return [dx * ux + dy * uy, dx * vx + dy * vy];
        });

        // 1) 좌우를 서로에게 조금씩 맞춘다
        const s = q.map((p, i) => {
            const m = q[n - 1 - i];
            const tx = (p[0] - m[0]) / 2, ty = (p[1] + m[1]) / 2;
            return [p[0] + (tx - p[0]) * sym, p[1] + (ty - p[1]) * sym];
        });

        // 2) 두께 방향의 잔울퉁만 고른다.
        //    입꼬리 두 점과 keep 에 적힌 자리는 건드리지 않는다.
        //    윗입술 가운데 세 점이 인중선(입술산)이라, 여기를 고르면
        //    산과 골이 뭉개져 입술이 일자로 보인다.
        const skip = keep && keep[ci];
        const out = s.map((p) => [p[0], p[1]]);
        for (let i = 1; i < n - 1; i++) {
            if (skip && skip.indexOf(i) >= 0) continue;
            out[i][1] = (s[i - 1][1] + s[i][1] * 4 + s[i + 1][1]) / 6;
        }

        return out.map((p) => [r1(cx + p[0] * ux + p[1] * vx),
                               r1(cy + p[0] * uy + p[1] * vy)]);
    });
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.refine] 검출선을 다듬어서 돌려줄지 (퀵에서 쓴다)
 */
export async function detectLipLandmarks(imgEl, opts) {
    // 입술은 인중선처럼 작은 굴곡이 결과를 좌우해서 얼굴을 잘라 다시 본다.
    // (fine: false 로 끄면 한 번만 본다 — 비교·측정용)
    const marks = (opts && opts.fine === false)
        ? await _detect(imgEl)
        : await _detectFine(imgEl);
    const w = imgEl.naturalWidth || imgEl.width;
    const h = imgEl.naturalHeight || imgEl.height;
    if (!marks) return null;

    // 1) 얼굴 BBox
    const fxs = marks.map((m) => m.x * w);
    const fys = marks.map((m) => m.y * h);
    const faceBbox = {
        x: Math.round(Math.min(...fxs)),
        y: Math.round(Math.min(...fys)),
        width:  Math.round(Math.max(...fxs) - Math.min(...fxs)),
        height: Math.round(Math.max(...fys) - Math.min(...fys)),
    };

    // 2) 입술 원본 앵커 (비대칭 보존)
    const pick = (idxs) => idxs.map((i) => [r1(marks[i].x * w), r1(marks[i].y * h)]);
    let uoRaw = pick(UPPER_OUTER_IDX);
    let loRaw = pick(LOWER_OUTER_IDX);
    let uiRaw = pick(UPPER_INNER_IDX);
    let liRaw = pick(LOWER_INNER_IDX);

    if (opts && opts.refine) {
        // 윗입술 바깥선의 4·5·6 번은 왼쪽 산 · 인중 골 · 오른쪽 산이다.
        const fixed = refineLipRaw([uoRaw, loRaw, uiRaw, liRaw], 0.6,
                                   [[4, 5, 6], null, null, null]);
        uoRaw = fixed[0]; loRaw = fixed[1]; uiRaw = fixed[2]; liRaw = fixed[3];
    }

    // 3) 폐곡선 Control Points
    const controlPoints = uoRaw.concat(loRaw.slice(1, -1));

    // 4) 폐곡선 스무딩
    const closedContourPts = smoothClosedContour(controlPoints, 80);
    const normContourPts = closedContourPts.map((p) => [r4(p[0] / w), r4(p[1] / h)]);

    // 5) 분리형 스플라인
    const uo = smoothLandmarkCurve(uoRaw, 25);
    const ui = smoothLandmarkCurve(uiRaw, 21);
    const lo = smoothLandmarkCurve(loRaw, 25);
    const li = smoothLandmarkCurve(liRaw, 21);

    const stats = (pts, minW, minH) => {
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        return {
            cx: xs.reduce((a, b) => a + b, 0) / xs.length,
            cy: ys.reduce((a, b) => a + b, 0) / ys.length,
            bw: Math.max(minW, Math.max(...xs) - Math.min(...xs)),
            bh: Math.max(minH, Math.max(...ys) - Math.min(...ys)),
            minX: Math.min(...xs), minY: Math.min(...ys),
        };
    };

    const uStat = stats(uo.concat(ui), 20.0, 8.0);
    const lStat = stats(lo.concat(li), 20.0, 8.0);
    const aStat = stats(uo.concat(ui, lo, li), 20.0, 15.0);

    const mouthBbox = {
        x: Math.round(aStat.minX),
        y: Math.round(aStat.minY),
        width: Math.round(aStat.bw),
        height: Math.round(aStat.bh),
    };

    // 6) 표준 랜드마크 포인트
    const landmarksDict = {
        left_corner:  uoRaw[0],
        right_corner: uoRaw[uoRaw.length - 1],
        cupid_left:   uoRaw.length > 4 ? uoRaw[4] : uoRaw[0],
        cupid_center: uoRaw.length > 5 ? uoRaw[5] : uoRaw[0],
        cupid_right:  uoRaw.length > 6 ? uoRaw[6] : uoRaw[uoRaw.length - 1],
        upper_center: uoRaw.length > 5 ? uoRaw[5] : uoRaw[0],
        lower_center: loRaw.length > 5 ? loRaw[5] : loRaw[0],
    };

    const originalContourDict = {
        upper_lip: { points: uo, control_points: uoRaw },
        lower_lip: { points: lo, control_points: loRaw },
    };

    const lipAnalysis = {
        detected: true,
        confidence: 0.96,
        mouth_bbox: mouthBbox,
        landmarks: landmarksDict,
        original_contour: originalContourDict,
        outer_contour: {
            points: closedContourPts,
            normalized_points: normContourPts,
            closed: true,
        },
        control_points: controlPoints,
        upper_outer: uo,
        upper_inner: ui,
        lower_outer: lo,
        lower_inner: li,
    };

    return {
        version: "2.0",
        has_landmarks: true,
        image: { filename: "customer_001.jpg", width: w, height: h },
        face: { detected: true, bbox: faceBbox },
        lip_analysis: lipAnalysis,

        // 캔버스 렌더링 호환 파라미터 (데스크톱판과 동일 키)
        control_points: controlPoints,
        upper_control_points: uoRaw,
        lower_control_points: loRaw,
        outer_closed_points: closedContourPts,
        upper_outer: uo,
        upper_inner: ui,
        upper_cx: uStat.cx,
        upper_cy: uStat.cy,
        upper_bw: uStat.bw,
        upper_bh: uStat.bh,
        lower_outer: lo,
        lower_inner: li,
        lower_cx: lStat.cx,
        lower_cy: lStat.cy,
        lower_bw: lStat.bw,
        lower_bh: lStat.bh,
        center_x: aStat.cx,
        center_y: aStat.cy,
        width: aStat.bw,
        height: aStat.bh,
        img_w: w,
        img_h: h,
    };
}

/**
 * 표준 입술 모양 만들기.
 * =========================================================================
 * 시뮬레이션은 고객의 실제 입술선을 따라 그리지 않고, 늘 좌우 대칭인
 * 정방향 표준 입술에서 시작한다. 실제 입술선은 비대칭이거나 번져 있어
 * 그걸 그대로 물려받으면 디자인을 잡기 전에 먼저 펴야 하기 때문이다.
 *
 * 얼굴이 인식되면 '입꼬리 두 점'만 받아 위치와 크기를 맞추고, 모양 자체는
 * 아래 고정 비율로 만든다. 머리가 기울어 있어도 기울기는 따라가지 않는다
 * (정방향). 인식이 안 되면 사진 기준 평균 위치에 얹어놓고 손으로 옮긴다.
 *
 * 반환 형태는 detectLipLandmarks() 와 완전히 같아서 이후 경로는 동일하다.
 *
 * @param {object|null} measured  detectLipLandmarks() 결과. 위치·크기만 쓴다.
 * =========================================================================
 */
/**
 * @param measured detectLipLandmarks() 결과 (없어도 된다)
 * @param eyes     detectFaceGeometry().eyes — 입술은 못 찾고 얼굴만 찾았을 때 쓴다
 */
export function standardLipLandmarks(w, h, measured, eyes) {
    // 아래 비율은 모델 사진 11장에서 실제로 검출된 입술을 재서 잡은 값이다.
    //   가로 중심 0.498 · 세로 중심 0.539 · 입 너비 0.134
    //   윗입술 두께 0.143 · 아랫입술 두께 0.229  (뒤 둘은 입 너비 기준)
    let cx = w * 0.50;
    let cy = h * 0.56;
    let mouthW = w * 0.16;   // 못 찾았을 땐 조금 크게 — 작아서 못 보는 것보다 낫다

    // 얼굴이 잡혔으면 입꼬리 두 점으로 위치와 폭만 가져온다.
    const corners = measured && measured.upper_control_points;
    if (corners && corners.length >= 2) {
        const L = corners[0], R = corners[corners.length - 1];
        cx = (L[0] + R[0]) / 2;
        cy = (L[1] + R[1]) / 2;              // 입꼬리를 잇는 선 = 입 다문 선
        mouthW = Math.max(20, Math.hypot(R[0] - L[0], R[1] - L[1]));
    } else if (eyes && eyes.left && eyes.right) {
        // 입술은 못 찾았지만 눈은 찾은 경우. 사진 한가운데에 놓으면 코 위에
        // 올라앉는다. 눈 위치에서 입 자리를 셈해 얼굴 위에 얹는다.
        // 비율은 모델 사진 10장에서 실제로 재어 잡았다.
        //   입 중심 = 눈 중심 + 눈 사이 거리 × 1.05 (아래로)
        //   입 너비 = 눈 사이 거리 × 0.89
        const EL = eyes.left, ER = eyes.right;
        const ed = Math.hypot(ER.x - EL.x, ER.y - EL.y);
        cx = (EL.x + ER.x) / 2;
        cy = (EL.y + ER.y) / 2 + ed * 1.05;
        mouthW = Math.max(20, ed * 0.89);
    }

    const upperH = mouthW * 0.15;     // 윗입술 도톰한 정도
    const lowerH = mouthW * 0.23;     // 아랫입술 도톰한 정도

    // 11점씩, 실제 랜드마크 배열과 같은 개수·같은 진행 방향으로 만든다.
    // (윗줄은 왼→오른쪽, 아랫줄은 오른→왼쪽 — FaceMesh 인덱스 순서와 동일)
    const LTR = (i) => cx + (i / 10 - 0.5) * mouthW;
    const RTL = (i) => cx + (0.5 - i / 10) * mouthW;

    // 윗입술 바깥선: 가운데가 살짝 파인 큐피드 활 모양
    const UPPER = [0, 0.30, 0.62, 0.86, 1.00, 0.80, 1.00, 0.86, 0.62, 0.30, 0];
    // 아랫입술 바깥선: 완만한 종 모양
    const LOWER = [0, 0.34, 0.64, 0.86, 0.97, 1.00, 0.97, 0.86, 0.64, 0.34, 0];
    // 입술 안쪽선(입 다문 선). 바깥선보다 좁고 낮게 둔다.
    const INNER = [0, 0.22, 0.42, 0.56, 0.64, 0.66, 0.64, 0.56, 0.42, 0.22, 0];
    const innerNarrow = 0.86;
    const iLTR = (i) => cx + (i / 10 - 0.5) * mouthW * innerNarrow;
    const iRTL = (i) => cx + (0.5 - i / 10) * mouthW * innerNarrow;

    const uoRaw = UPPER.map((k, i) => [r1(LTR(i)), r1(cy - upperH * k)]);
    const loRaw = LOWER.map((k, i) => [r1(RTL(i)), r1(cy + lowerH * k)]);
    const uiRaw = INNER.map((k, i) => [r1(iLTR(i)), r1(cy - upperH * 0.18 * k)]);
    const liRaw = INNER.map((k, i) => [r1(iRTL(i)), r1(cy + lowerH * 0.18 * k)]);

    const uo = smoothLandmarkCurve(uoRaw, 25);
    const ui = smoothLandmarkCurve(uiRaw, 21);
    const lo = smoothLandmarkCurve(loRaw, 25);
    const li = smoothLandmarkCurve(liRaw, 21);

    const controlPoints = uoRaw.concat(loRaw.slice(1, -1));
    const closedContourPts = smoothClosedContour(controlPoints, 80);
    const normContourPts = closedContourPts.map((p) => [r4(p[0] / w), r4(p[1] / h)]);

    const stats = (pts, minW, minH) => {
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        return {
            cx: xs.reduce((a, b) => a + b, 0) / xs.length,
            cy: ys.reduce((a, b) => a + b, 0) / ys.length,
            bw: Math.max(minW, Math.max(...xs) - Math.min(...xs)),
            bh: Math.max(minH, Math.max(...ys) - Math.min(...ys)),
            minX: Math.min(...xs), minY: Math.min(...ys),
        };
    };
    const uStat = stats(uo.concat(ui), 20.0, 8.0);
    const lStat = stats(lo.concat(li), 20.0, 8.0);
    const aStat = stats(uo.concat(ui, lo, li), 20.0, 15.0);

    return {
        version: "2.0",
        has_landmarks: !!(corners || (eyes && eyes.left)),   // 위치를 실측에서 가져왔는지
        is_standard: true,               // 모양은 언제나 표준 입술
        image: { filename: "customer_001.jpg", width: w, height: h },
        face: { detected: !!corners, bbox: (measured && measured.face) ? measured.face.bbox : null },
        lip_analysis: {
            detected: !!corners,
            confidence: corners ? 1 : 0,
            mouth_bbox: {
                x: Math.round(aStat.minX), y: Math.round(aStat.minY),
                width: Math.round(aStat.bw), height: Math.round(aStat.bh),
            },
            landmarks: {
                left_corner: uoRaw[0],
                right_corner: uoRaw[uoRaw.length - 1],
                cupid_left: uoRaw[4],
                cupid_center: uoRaw[5],
                cupid_right: uoRaw[6],
                upper_center: uoRaw[5],
                lower_center: loRaw[5],
            },
            original_contour: {
                upper_lip: { points: uo, control_points: uoRaw },
                lower_lip: { points: lo, control_points: loRaw },
            },
            outer_contour: {
                points: closedContourPts,
                normalized_points: normContourPts,
                closed: true,
            },
            control_points: controlPoints,
            upper_outer: uo, upper_inner: ui,
            lower_outer: lo, lower_inner: li,
        },

        // 캔버스 렌더링 호환 파라미터 (실측 경로와 동일한 키)
        control_points: controlPoints,
        upper_control_points: uoRaw,
        lower_control_points: loRaw,
        outer_closed_points: closedContourPts,
        upper_outer: uo,
        upper_inner: ui,
        upper_cx: uStat.cx, upper_cy: uStat.cy,
        upper_bw: uStat.bw, upper_bh: uStat.bh,
        lower_outer: lo,
        lower_inner: li,
        lower_cx: lStat.cx, lower_cy: lStat.cy,
        lower_bw: lStat.bw, lower_bh: lStat.bh,
        center_x: aStat.cx, center_y: aStat.cy,
        width: aStat.bw, height: aStat.bh,
        img_w: w,
        img_h: h,
    };
}
