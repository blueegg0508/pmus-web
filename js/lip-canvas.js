// 아코디언 토글 전역 함수
    function toggleAcc(id) {
        const el = document.getElementById(id);
        if (el) {
            el.classList.toggle('open');
        }
    }

    (function() {
        const lipData = CFG.lip_json;
        const canvas = document.getElementById('lipCanvas');
        const ctx = canvas.getContext('2d');
        canvas.width = CFG.img_w;
        canvas.height = CFG.img_h;

        // ⚡ 재사용 오프스크린 캔버스 버퍼 & 렌더링 스케줄러 상태 (TDZ 에러 완전 방지)
        let cachedAfterCanvas = null;
        let cachedTintCanvas = null;
        let cachedGlossCanvas = null;
        let renderRequested = false;

        function getBufferCanvas(name, w, h) {
            if (name === 'after') {
                if (!cachedAfterCanvas) cachedAfterCanvas = document.createElement('canvas');
                if (cachedAfterCanvas.width !== w || cachedAfterCanvas.height !== h) {
                    cachedAfterCanvas.width = w;
                    cachedAfterCanvas.height = h;
                }
                const cCtx = cachedAfterCanvas.getContext('2d');
                cCtx.clearRect(0, 0, w, h);
                return { canvas: cachedAfterCanvas, ctx: cCtx };
            } else if (name === 'tint') {
                if (!cachedTintCanvas) cachedTintCanvas = document.createElement('canvas');
                if (cachedTintCanvas.width !== w || cachedTintCanvas.height !== h) {
                    cachedTintCanvas.width = w;
                    cachedTintCanvas.height = h;
                }
                const cCtx = cachedTintCanvas.getContext('2d');
                cCtx.clearRect(0, 0, w, h);
                return { canvas: cachedTintCanvas, ctx: cCtx };
            } else if (name === 'gloss') {
                if (!cachedGlossCanvas) cachedGlossCanvas = document.createElement('canvas');
                if (cachedGlossCanvas.width !== w || cachedGlossCanvas.height !== h) {
                    cachedGlossCanvas.width = w;
                    cachedGlossCanvas.height = h;
                }
                const cCtx = cachedGlossCanvas.getContext('2d');
                cCtx.clearRect(0, 0, w, h);
                return { canvas: cachedGlossCanvas, ctx: cCtx };
            }
        }

        function requestRender() {
            if (!renderRequested) {
                renderRequested = true;
                requestAnimationFrame(() => {
                    renderRequested = false;
                    renderCanvas();
                });
            }
        }

        const bgImg = new Image();
        // 편집하지 않은 맨얼굴. '시술 전'·비교의 왼쪽은 언제나 이 그림이고,
        // 다른 부위로 넘겨줄 그림도 이 위에 굽는다.
        // bg_b64 는 눈썹 작업이 이미 얹힌 사진일 수 있다.
        let origImg = new Image();
        /** 그리는 동안 배경을 잠시 바꿔치기할 때 쓴다 (맨얼굴로 굽기) */
        let captureBg = null;

        // 👁️ 뷰 모드 ('after', 'before', 'split')
        let viewMode = 'after';
        let splitRatio = 0.5;
        let isDraggingSplit = false;

        let isExtracted = true;

        // 원본 좌표 로드 & Left-to-Right 방향 일관성 보장
        function extractLtr(raw) {
            if (!raw || raw.length === 0) return [];
            let pts = JSON.parse(JSON.stringify(raw));
            if (pts[0][0] > pts[pts.length - 1][0]) {
                pts.reverse();
            }
            return pts;
        }

        let upperRawPts = extractLtr(lipData.upper_control_points || lipData.upper_outer || []);
        let lowerRawPts = extractLtr(lipData.lower_control_points || lipData.lower_outer || []);
        let upperInnerRawPts = extractLtr(lipData.upper_inner || []);
        let lowerInnerRawPts = extractLtr(lipData.lower_inner || []);

        // 내측 구순선(Stomion line) 안전 보정 (닫힌 입술에 맞게 중앙선 정렬)
        if (upperRawPts.length >= 2) {
            const pL = upperRawPts[0];
            const pR = upperRawPts[upperRawPts.length - 1];
            const midIdx = Math.floor(upperRawPts.length / 2);
            const uMid = upperRawPts[midIdx];
            const lMid = lowerRawPts[Math.floor(lowerRawPts.length / 2)] || uMid;
            const pMidY = (uMid[1] + lMid[1]) / 2;

            if (upperInnerRawPts.length < 3) {
                upperInnerRawPts = [
                    [pL[0], pL[1]],
                    [pL[0] * 0.72 + pR[0] * 0.28, pMidY],
                    [(pL[0] + pR[0]) / 2, pMidY],
                    [pL[0] * 0.28 + pR[0] * 0.72, pMidY],
                    [pR[0], pR[1]]
                ];
            }
            if (lowerInnerRawPts.length < 3) {
                lowerInnerRawPts = [
                    [pL[0], pL[1]],
                    [pL[0] * 0.72 + pR[0] * 0.28, pMidY],
                    [(pL[0] + pR[0]) / 2, pMidY],
                    [pL[0] * 0.28 + pR[0] * 0.72, pMidY],
                    [pR[0], pR[1]]
                ];
            }
        }
        
        let initialUpperPts = JSON.parse(JSON.stringify(upperRawPts));
        let initialLowerPts = JSON.parse(JSON.stringify(lowerRawPts));
        let initialUpperInnerPts = JSON.parse(JSON.stringify(upperInnerRawPts));
        let initialLowerInnerPts = JSON.parse(JSON.stringify(lowerInnerRawPts));

        // 보관 장수. 카드로 뿌릴 때 한 장이 풀려 수 MB 를 차지해서, 저사양
        // 기기를 생각해 여섯 장으로 줄였다. 썸네일도 720px 로 낮췄다.
        const MAX_HISTORY_ITEMS = 6;

        let undoStack = [];

        /** 되돌리기용 상태 한 장. (캔버스 드래그 · 조절바 모두 이걸 쓴다) */
        function snapshotState() {
            return {
                globalOffsetX, globalOffsetY, globalWidth,
                upperOffsetX, upperOffsetY, upperWidth,
                lowerOffsetX, lowerOffsetY, lowerWidth,
                upperTopOver, upperTopPeakVol, philtrumRound, philtrumDepth, philtrumWidth, upperHeight,
                upperBottomFullRound, upperBottomY, upperBottomCenterVol, upperBottomRound, upperBottomSideVol,
                lowerTopY, lowerTopCenterVol, lowerTopRound, lowerTopSideVol,
                lowerBottomOver, lowerBottomCenterVol, lowerBottomRound, lowerHeight,
                upperLeftCornerY, upperRightCornerY, lowerLeftCornerY, lowerRightCornerY,
                upperLeftVolume, upperRightVolume, lowerLeftVolume, lowerRightVolume,
                cornerSharpL, cornerSharpR,
                cornerOverU, cornerOverL,
                blurVal, density, gloss
            };
        }

        function pushUndo(state) {
            undoStack.push(state || snapshotState());
            if (undoStack.length > 20) undoStack.shift();
            // 새 작업이 생기면 '다시실행' 으로 돌아갈 곳이 없어진다
            if (typeof redoStack !== "undefined") redoStack.length = 0;
        }

        // 🎯 드래그 앤 드롭 상태
        let isDraggingLip = false;
        let selectedLip = null; // 🌟 입술 클릭 선택 상태 (외부 클릭 시 null로 초기화)
        // 🎯 이동 모드 및 오프셋 상태 (기본 'auto': 화면에서 클릭한 윗입술/아랫입술 즉시 자유 이동)
        let moveTarget = 'auto'; // 'auto' | 'both' | 'upper' | 'lower'
        let hoveredLip = null; // 'upper' | 'lower' | 'both' | null
        let globalOffsetX = 0;
        let globalOffsetY = 0;
        let globalWidth = 100;
        let upperOffsetX = 0;
        let upperOffsetY = 0;
        let upperWidth = 100;
        let lowerOffsetX = 0;
        let lowerOffsetY = 0;
        let lowerWidth = 100;
        let activeDragMode = 'both';

        // 🔍 사진 & 입술 동기화 줌/이동 상태
        let curImgZoom = 100;
        let curImgPanX = 0;
        let curImgPanY = 0;

        let startUpperX = 0;
        let startUpperY = 0;
        let startLowerX = 0;
        let startLowerY = 0;

        // 🎛️ 라인 및 렌더 옵션 상태 (기본 틴트 채움 = false)
        let showDesignLine = true;
        let showOrigLine = false;
        let fillTint = false;
        let lineWidth = 2;
        let designLineColor = '#FFD21F';
        let origLineColor = '#FFFFFF';

        // 🔗 연동 옵션
        let linkLR = true;
        let linkUpDown = false;

        // 👄 1. 윗입술 상부 경계 및 볼륨 상태
        let upperTopOver = 0;
        let upperTopPeakVol = 0;
        let philtrumRound = 0;
        let philtrumDepth = 0;
        let philtrumWidth = 0;
        let upperHeight = 100;

        // 👄 2. 윗입술 하부 경계 및 볼륨 상태
        let upperBottomFullRound = 0;
        let upperBottomY = 0;
        let upperBottomCenterVol = 0;
        let upperBottomRound = 0;
        let upperBottomSideVol = 0;

        // 👄 3. 아랫입술 상부 경계 및 볼륨 상태
        let lowerTopY = 0;
        let lowerTopCenterVol = 0;
        let lowerTopRound = 0;
        let lowerTopSideVol = 0;

        // 👄 4. 아랫입술 하부 경계 및 볼륨 상태
        let lowerBottomOver = 0;
        let lowerBottomCenterVol = 0;
        let lowerBottomRound = 0;
        let lowerHeight = 100;

        // ✨ 윗입술 & 아랫입술 입꼬리 상하 조절 및 좌우 볼륨 (윗/아래 독립 분리)
        let upperLeftCornerY = 0;
        let upperRightCornerY = 0;
        let lowerLeftCornerY = 0;
        let lowerRightCornerY = 0;
        // 입꼬리를 바깥으로 당겨 뾰족하게 만드는 정도 (0 = 원래대로)
        /* ── 입꼬리 오버립 ────────────────────────────────────────────────
         * 입술산에서 입꼬리로 이어지는 바깥쪽 구간을 자연스럽게 밀어낸다.
         * 윗입술은 위로, 아랫입술은 아래로 — 입꼬리가 들어올려진 듯 보인다.
         *
         * 입꼬리 그 점은 윗입술·아랫입술이 만나는 한 점이라 움직이지 않는다.
         * 한쪽만 올리면 두 곡선이 입꼬리에서 벌어져 입술선이 끊긴다.
         * 그래서 구간 한가운데가 가장 많이 밀리고 양 끝(입술산·입꼬리)에서
         * 0 이 되는 사인 곡선으로 민다.
         */
        let cornerOverU = 0;
        let cornerOverL = 0;
        /** 입꼬리에서 안쪽으로 이 만큼이 '바깥쪽 구간' 이다 (0~1 파라미터 기준) */
        const CORNER_OVER_REACH = 0.34;

        /** 바깥쪽 구간에서의 밀어내는 세기 (0 = 안 밀림) */
        function cornerOverWeight(t) {
            const R = CORNER_OVER_REACH;
            if (t < R) return Math.sin(Math.PI * (t / R));
            if (t > 1 - R) return Math.sin(Math.PI * ((1 - t) / R));
            return 0;
        }

        let cornerSharpL = 0;
        let cornerSharpR = 0;
        let upperLeftVolume = 0;
        let upperRightVolume = 0;
        let lowerLeftVolume = 0;
        let lowerRightVolume = 0;

        // 🎨 컬러 & 기법 상태
        let currentColor = CFG.default_color;
        let currentTech = CFG.default_tech;
        let density = 100;
        let opacity = 85;
        let gloss = 0;
        let blurVal = 3.5;



        function hexToRgb(hex) {
            const bigint = parseInt(hex.replace('#', ''), 16);
            return {
                r: (bigint >> 16) & 255,
                g: (bigint >> 8) & 255,
                b: bigint & 255
            };
        }

        // Catmull-Rom 열린 곡선 스플라인 생성 함수 (끝단 가상 탄젠트 보간으로 꺾임 방지)
        function computeOpenSpline(pts, numPts = 45) {
            if (!pts || pts.length < 2) return pts || [];
            const n = pts.length;
            if (n === 2) {
                const res = [];
                for (let s = 0; s <= numPts; s++) {
                    const t = s / numPts;
                    res.push([
                        pts[0][0] * (1 - t) + pts[1][0] * t,
                        pts[0][1] * (1 - t) + pts[1][1] * t
                    ]);
                }
                return res;
            }

            const pStart = [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
            const pEnd = [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
            const ext = [pStart, ...pts, pEnd];

            const res = [];
            function catmullRom(p0, p1, p2, p3, t) {
                const t2 = t * t;
                const t3 = t2 * t;
                const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
                const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
                return [x, y];
            }
            const segCount = ext.length - 3;
            const steps = Math.max(2, Math.floor(numPts / segCount));
            for (let i = 1; i <= segCount; i++) {
                const p0 = ext[i - 1];
                const p1 = ext[i];
                const p2 = ext[i + 1];
                const p3 = ext[i + 2];
                for (let s = 0; s < steps; s++) {
                    const t = s / steps;
                    res.push(catmullRom(p0, p1, p2, p3, t));
                }
            }
            res.push(pts[n - 1]);
            return res;
        }

        // 🌟 폐곡선 굴곡 스무딩 필터 (입꼬리 쐐기 각짐 제거 및 매끄러운 볼륨감 유지)
        function smoothClosedLoop(pts, passes = 2) {
            if (!pts || pts.length < 4) return pts || [];
            let curr = pts.map(p => [p[0], p[1]]);
            const n = curr.length;
            for (let p = 0; p < passes; p++) {
                const smoothed = [];
                for (let i = 0; i < n; i++) {
                    const pPrev = curr[(i - 1 + n) % n];
                    const pCurr = curr[i];
                    const pNext = curr[(i + 1) % n];
                    smoothed.push([
                        0.20 * pPrev[0] + 0.60 * pCurr[0] + 0.20 * pNext[0],
                        0.20 * pPrev[1] + 0.60 * pCurr[1] + 0.20 * pNext[1]
                    ]);
                }
                curr = smoothed;
            }
            return curr;
        }

        function showToast(msg) {
            let toast = document.getElementById('appToast');
            if (!toast) {
                toast = document.createElement('div');
                toast.id = 'appToast';
                toast.className = 'toast-msg';
                document.body.appendChild(toast);
            }
            toast.textContent = msg;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2200);
        }

        function isPointInPoly(pt, poly) {
            if (!poly || poly.length < 3) return false;
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const xi = poly[i][0], yi = poly[i][1];
                const xj = poly[j][0], yj = poly[j][1];
                const intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi);
                if (intersect) inside = !inside;
            }
            return inside;
        }

        function getBoxForPoly(pts, pad = 12) {
            if (!pts || pts.length === 0) return null;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            pts.forEach(p => {
                if (p[0] < minX) minX = p[0];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[1] > maxY) maxY = p[1];
            });
            return {
                x: minX - pad,
                y: minY - pad,
                w: (maxX - minX) + pad * 2,
                h: (maxY - minY) + pad * 2
            };
        }

        /**
         * 입꼬리를 바깥으로 당겨 뾰족하게 만든다.
         *
         * 두 가지를 같이 한다.
         *   1) 입꼬리 쪽 점들을 바깥으로 밀어 꼬리를 길게 뺀다
         *   2) 그 구간의 두께를 입꼬리 높이 쪽으로 눌러 끝이 가늘어지게 한다
         * 그냥 옆으로만 늘리면 끝이 뭉툭한 채로 길어지기만 해서 둘 다 필요하다.
         *
         * 윗/아랫 · 바깥/안쪽 네 곡선 모두 같은 값을 쓴다. 입꼬리는 한 점이라
         * 따로 놀면 곡선이 어긋난다.
         *
         * @param {number} t        0 = 왼쪽 입꼬리, 1 = 오른쪽 입꼬리
         * @param {number} anchorY  그 곡선이 입꼬리에서 갖는 높이 (두께를 모을 기준)
         */
        const CORNER_REACH = 0.22;      // 입꼬리에서 안쪽으로 영향이 미치는 범위

        function sharpenCorner(t, x, y, anchorY, h) {
            let amount, dir, w;
            if (t < CORNER_REACH && cornerSharpL !== 0) {
                amount = cornerSharpL; dir = -1; w = 1 - t / CORNER_REACH;
            } else if (t > 1 - CORNER_REACH && cornerSharpR !== 0) {
                amount = cornerSharpR; dir = 1; w = 1 - (1 - t) / CORNER_REACH;
            } else {
                return [x, y];
            }
            const wq = w * w;                       // 입꼬리 끝에 몰리도록
            // 0.45 배: 그냥 amount 만큼 밀면 최대치에서 입이 두 배 가까이
            // 길어져 수염처럼 보인다. 최대에서 입 너비의 절반쯤 늘어나게 맞췄다.
            x += dir * amount * 0.45 * wq * (h / 600);
            const taper = Math.max(-0.5, Math.min(0.7, amount / 60));
            y = anchorY + (y - anchorY) * (1 - taper * wq);
            return [x, y];
        }

        // 👄 1. 윗입술 상단 외곽 (상부 경계 및 볼륨) 변환
        function transformUpperOuter(pt, t) {
            const h = canvas.height;
            const u_cy = (lipData && lipData.upper_cy) ? lipData.upper_cy : (h * 0.65);
            const u_cx = (upperRawPts.length >= 2) ? (upperRawPts[0][0] + upperRawPts[upperRawPts.length - 1][0]) / 2 : (canvas.width * 0.5);
            const u_sy = upperHeight / 100.0;
            const u_sx = (upperWidth / 100.0) * (globalWidth / 100.0);

            let x = u_cx + (pt[0] - u_cx) * u_sx + globalOffsetX + upperOffsetX;
            let y = u_cy + (pt[1] - u_cy) * u_sy + globalOffsetY + upperOffsetY;

            // 인중 폭
            if (philtrumWidth !== 0) {
                const pDist = (t - 0.5);
                const pFactor = Math.sin(t * Math.PI) * Math.sign(pDist);
                x += philtrumWidth * pFactor * (h / 600);
            }

            const peakL = Math.exp(-Math.pow((t - 0.32) / 0.16, 2));
            const peakR = Math.exp(-Math.pow((t - 0.68) / 0.16, 2));
            const dipCenter = Math.exp(-Math.pow((t - 0.5) / 0.14, 2));

            // 인중 라운드 및 골 깊이 (부드러운 벨 곡선)
            if (philtrumRound !== 0) {
                y += (philtrumRound * 0.4) * (peakL + peakR - dipCenter * 0.8) * (h / 600);
            }
            if (philtrumDepth !== 0) {
                const dipWeight = Math.exp(-Math.pow((t - 0.5) / 0.16, 2));
                y += philtrumDepth * dipWeight * (h / 600);
            }
            // 상부 입술산 볼륨 (피크 강조)
            if (upperTopPeakVol !== 0) {
                y -= upperTopPeakVol * (peakL + peakR) * (h / 600);
            }
            // 상부 외곽 오버립 (전체 상단 부드러운 아치 확장)
            if (upperTopOver > 0) {
                y -= upperTopOver * Math.sin(t * Math.PI) * (h / 600);
            }
            // 입꼬리 오버립 — 입술산에서 입꼬리로 가는 구간만 위로
            if (cornerOverU > 0) {
                y -= cornerOverU * cornerOverWeight(t) * (h / 600);
            }
            // 윗입술 좌/우 비대칭 볼륨
            if (t < 0.5 && upperLeftVolume !== 0) {
                y -= upperLeftVolume * Math.sin(t * 2 * Math.PI) * (h / 600);
            } else if (t >= 0.5 && upperRightVolume !== 0) {
                y -= upperRightVolume * Math.sin((t - 0.5) * 2 * Math.PI) * (h / 600);
            }
            // 👄 윗입술 좌/우 입꼬리 위아래 조절 (각지지 않고 유연한 C-커브 롤오프)
            if (upperLeftCornerY !== 0 && t <= 0.45) {
                const w = 0.5 * (1 + Math.cos(Math.PI * (t / 0.45)));
                y -= upperLeftCornerY * w * (h / 600);
            }
            if (upperRightCornerY !== 0 && t >= 0.55) {
                const w = 0.5 * (1 + Math.cos(Math.PI * ((1 - t) / 0.45)));
                y -= upperRightCornerY * w * (h / 600);
            }
            // 입꼬리 뾰족하게 — 두께를 모을 기준은 이 곡선이 입꼬리에서 갖는 높이
            {
                const cr = (t < 0.5) ? upperRawPts[0] : upperRawPts[upperRawPts.length - 1];
                const cyAnchor = u_cy + (cr[1] - u_cy) * u_sy + globalOffsetY + upperOffsetY
                    - ((t < 0.5) ? upperLeftCornerY : upperRightCornerY) * (h / 600);
                const sp = sharpenCorner(t, x, y, cyAnchor, h);
                x = sp[0]; y = sp[1];
            }
            return [x, y];
        }

        // 👄 2. 윗입술 하단 내측선 (하부 경계 및 볼륨) 변환
        function transformUpperInner(pt, t) {
            const h = canvas.height;
            const u_cx = (upperRawPts.length >= 2) ? (upperRawPts[0][0] + upperRawPts[upperRawPts.length - 1][0]) / 2 : (canvas.width * 0.5);
            const u_sx = (upperWidth / 100.0) * (globalWidth / 100.0);

            let x = u_cx + (pt[0] - u_cx) * u_sx + globalOffsetX + upperOffsetX;
            let y = pt[1] + globalOffsetY + upperOffsetY;

            // 1) 🌟 윗입술 하단 전체 자연스러운 라운드 (부드러운 U자 / C-곡선 아치)
            if (upperBottomFullRound !== 0) {
                const w_full = Math.sin(t * Math.PI);
                y += upperBottomFullRound * w_full * (h / 600);
            }
            // 2) 하부 경계선 위치 (상하 이동)
            if (upperBottomY !== 0) {
                y += upperBottomY * Math.sin(t * Math.PI) * (h / 600);
            }
            // 3) 하부 구순결절 볼륨 (중앙 도톰하게 아래로 돌출되는 립 쿠션)
            if (upperBottomCenterVol !== 0) {
                const tuberculum = Math.exp(-Math.pow((t - 0.5) / 0.20, 2));
                y += upperBottomCenterVol * tuberculum * (h / 600);
            }
            // 4) 하부 안쪽 곡률
            if (upperBottomRound !== 0) {
                y += upperBottomRound * Math.sin(t * Math.PI) * (h / 600);
            }
            // 5) 하부 좌우 볼륨
            if (upperBottomSideVol !== 0) {
                if (t < 0.5) y += upperBottomSideVol * Math.sin(t * 2 * Math.PI) * (h / 600);
                else y += upperBottomSideVol * Math.sin((t - 0.5) * 2 * Math.PI) * (h / 600);
            }

            // 👄 윗입술 내측 입꼬리 부드러운 연동 리프팅 (각짐 방지 C-커브)
            if (upperLeftCornerY !== 0 && t <= 0.40) {
                const w = 0.5 * (1 + Math.cos(Math.PI * (t / 0.40)));
                y -= upperLeftCornerY * w * 0.85 * (h / 600);
            }
            if (upperRightCornerY !== 0 && t >= 0.60) {
                const w = 0.5 * (1 + Math.cos(Math.PI * ((1 - t) / 0.40)));
                y -= upperRightCornerY * w * 0.85 * (h / 600);
            }
            {
                const cr = (t < 0.5) ? upperInnerRawPts[0] : upperInnerRawPts[upperInnerRawPts.length - 1];
                const cyAnchor = (cr ? cr[1] : y) + globalOffsetY + upperOffsetY
                    - ((t < 0.5) ? upperLeftCornerY : upperRightCornerY) * 0.85 * (h / 600);
                const sp = sharpenCorner(t, x, y, cyAnchor, h);
                x = sp[0]; y = sp[1];
            }
            return [x, y];
        }

        // 👄 3. 아랫입술 상단 내측선 (상부 경계 및 볼륨) 변환
        function transformLowerInner(pt, t) {
            const h = canvas.height;
            const l_cx = (lowerRawPts.length >= 2) ? (lowerRawPts[0][0] + lowerRawPts[lowerRawPts.length - 1][0]) / 2 : (canvas.width * 0.5);
            const l_sx = (lowerWidth / 100.0) * (globalWidth / 100.0);

            let x = l_cx + (pt[0] - l_cx) * l_sx + globalOffsetX + lowerOffsetX;
            let y = pt[1] + globalOffsetY + lowerOffsetY;

            // 1) 상부 경계선 위치
            if (lowerTopY !== 0) {
                y += lowerTopY * Math.sin(t * Math.PI) * (h / 600);
            }
            // 2) 상부 안쪽 중앙 볼륨
            if (lowerTopCenterVol !== 0) {
                const centerDip = Math.exp(-Math.pow((t - 0.5) / 0.22, 2));
                y += lowerTopCenterVol * centerDip * (h / 600);
            }
            // 3) 상부 안쪽 곡률
            if (lowerTopRound !== 0) {
                y += lowerTopRound * Math.sin(t * Math.PI) * (h / 600);
            }
            // 4) 상부 좌우 볼륨
            if (lowerTopSideVol !== 0) {
                if (t < 0.5) y += lowerTopSideVol * Math.sin(t * 2 * Math.PI) * (h / 600);
                else y += lowerTopSideVol * Math.sin((t - 0.5) * 2 * Math.PI) * (h / 600);
            }

            // 👄 아랫입술 내측 입꼬리 부드러운 연동 리프팅 (각짐 방지 C-커브)
            if (lowerLeftCornerY !== 0 && t <= 0.40) {
                const w = 0.5 * (1 + Math.cos(Math.PI * (t / 0.40)));
                y -= lowerLeftCornerY * w * 0.85 * (h / 600);
            }
            if (lowerRightCornerY !== 0 && t >= 0.60) {
                const w = 0.5 * (1 + Math.cos(Math.PI * ((1 - t) / 0.40)));
                y -= lowerRightCornerY * w * 0.85 * (h / 600);
            }
            {
                const cr = (t < 0.5) ? lowerInnerRawPts[0] : lowerInnerRawPts[lowerInnerRawPts.length - 1];
                const cyAnchor = (cr ? cr[1] : y) + globalOffsetY + lowerOffsetY
                    - ((t < 0.5) ? lowerLeftCornerY : lowerRightCornerY) * 0.85 * (h / 600);
                const sp = sharpenCorner(t, x, y, cyAnchor, h);
                x = sp[0]; y = sp[1];
            }
            return [x, y];
        }

        // 👄 4. 아랫입술 하단 외곽 (하부 경계 및 볼륨) 변환
        function transformLowerOuter(pt, t) {
            const h = canvas.height;
            const l_cy = (lipData && lipData.lower_cy) ? lipData.lower_cy : (h * 0.70);
            const l_cx = (lowerRawPts.length >= 2) ? (lowerRawPts[0][0] + lowerRawPts[lowerRawPts.length - 1][0]) / 2 : (canvas.width * 0.5);
            const l_sy = lowerHeight / 100.0;
            const l_sx = (lowerWidth / 100.0) * (globalWidth / 100.0);

            let x = l_cx + (pt[0] - l_cx) * l_sx + globalOffsetX + lowerOffsetX;
            let y = l_cy + (pt[1] - l_cy) * l_sy + globalOffsetY + lowerOffsetY;

            // 1) 아랫입술 하부 중앙 볼륨 (중앙 도톰함)
            if (lowerBottomCenterVol !== 0) {
                y += lowerBottomCenterVol * Math.sin(t * Math.PI) * (h / 600);
            }
            // 2) 하단 라운드 (U자 / W자 라인 곡률)
            if (lowerBottomRound !== 0) {
                const w_round = Math.exp(-Math.pow((t - 0.5) / 0.30, 2));
                y += lowerBottomRound * w_round * (h / 600);
            }
            // 3) 하부 외곽 오버립 (아래로 확장)
            if (lowerBottomOver > 0) {
                y += lowerBottomOver * Math.sin(t * Math.PI) * (h / 600);
            }
            // 입꼬리 오버립 — 입꼬리로 가는 구간만 아래로
            if (cornerOverL > 0) {
                y += cornerOverL * cornerOverWeight(t) * (h / 600);
            }
            // 4) 아랫입술 좌/우 비대칭 볼륨
            if (t < 0.5 && lowerLeftVolume !== 0) {
                y += lowerLeftVolume * Math.sin(t * 2 * Math.PI) * (h / 600);
            } else if (t >= 0.5 && lowerRightVolume !== 0) {
                y += lowerRightVolume * Math.sin((t - 0.5) * 2 * Math.PI) * (h / 600);
            }
            // 👄 아랫입술 좌/우 입꼬리 위아래 조절 (각지지 않고 유연한 C-커브 롤오프)
            if (lowerLeftCornerY !== 0 && t <= 0.45) {
                const w = 0.5 * (1 + Math.cos(Math.PI * (t / 0.45)));
                y -= lowerLeftCornerY * w * (h / 600);
            }
            if (lowerRightCornerY !== 0 && t >= 0.55) {
                const w = 0.5 * (1 + Math.cos(Math.PI * ((1 - t) / 0.45)));
                y -= lowerRightCornerY * w * (h / 600);
            }
            {
                const cr = (t < 0.5) ? lowerRawPts[0] : lowerRawPts[lowerRawPts.length - 1];
                const cyAnchor = l_cy + (cr[1] - l_cy) * l_sy + globalOffsetY + lowerOffsetY
                    - ((t < 0.5) ? lowerLeftCornerY : lowerRightCornerY) * (h / 600);
                const sp = sharpenCorner(t, x, y, cyAnchor, h);
                x = sp[0]; y = sp[1];
            }
            return [x, y];
        }

        // ✨ 윗입술 / 아랫입술 완전 분리된 독립 폐곡선 산출 (자연스러운 볼륨감 및 C-커브 스무딩)
        function getTransformedCurves() {
            const uo_t = upperRawPts.map((p, i) => transformUpperOuter(p, i / (upperRawPts.length - 1)));
            const ui_t = upperInnerRawPts.map((p, i) => transformUpperInner(p, i / (upperInnerRawPts.length - 1)));
            const lo_t = lowerRawPts.map((p, i) => transformLowerOuter(p, i / (lowerRawPts.length - 1)));
            const li_t = lowerInnerRawPts.map((p, i) => transformLowerInner(p, i / (lowerInnerRawPts.length - 1)));

            const smoothUpperOuter = computeOpenSpline(uo_t, 45);
            const smoothUpperInner = computeOpenSpline(ui_t, 35);
            const smoothLowerOuter = computeOpenSpline(lo_t, 45);
            const smoothLowerInner = computeOpenSpline(li_t, 35);

            // 1. 윗입술 독립 폐곡선 (스무딩 필터로 입꼬리 쐐기 각짐 제거 및 볼륨 유지)
            const rawUpperLoop = smoothUpperOuter.concat(smoothUpperInner.slice().reverse().slice(1, -1));
            const closedUpperLoop = smoothClosedLoop(rawUpperLoop, 2);
            
            // 2. 아랫입술 독립 폐곡선 (스무딩 필터로 부드럽고 도톰한 볼륨감 유지)
            const rawLowerLoop = smoothLowerInner.concat(smoothLowerOuter.slice().reverse().slice(1, -1));
            const closedLowerLoop = smoothClosedLoop(rawLowerLoop, 2);

            return {
                uo_t, ui_t, lo_t, li_t,
                smoothUpperOuter, smoothUpperInner, smoothLowerOuter, smoothLowerInner,
                closedUpperLoop, closedLowerLoop
            };
        }

        // 🌟 첨부 사진 기반 탕후루 유리알 볼륨 광택 (입술 형태 기반 3D 곡률 추론 렌더러)
        function renderIntelligentLipGloss(hCtx, w, h, curves, glossVal) {
            if (!glossVal || glossVal <= 0) return;
            const gFactor = glossVal / 100.0;
            
            const smoothUpperOuter = curves.smoothUpperOuter;
            const smoothUpperInner = curves.smoothUpperInner;
            const smoothLowerOuter = curves.smoothLowerOuter;
            const smoothLowerInner = curves.smoothLowerInner;
            if (!smoothUpperOuter || !smoothLowerOuter) return;

            // 1. 💋 윗입술 (Upper Lip) 능선 유리알 반사광 & 큐피트 봉우리 글린트
            const uLen = Math.min(smoothUpperOuter.length, smoothUpperInner.length);
            if (uLen >= 6) {
                // 1-1. 윗입술 소프트 볼륨 광채 베이스
                hCtx.save();
                hCtx.beginPath();
                let first = true;
                for (let i = 0; i < uLen; i++) {
                    const t = i / (uLen - 1);
                    if (t < 0.15 || t > 0.85) continue;
                    const pO = smoothUpperOuter[i];
                    const pI = smoothUpperInner[i];
                    const x = pO[0] * 0.62 + pI[0] * 0.38;
                    const y = pO[1] * 0.62 + pI[1] * 0.38;
                    if (first) { hCtx.moveTo(x, y); first = false; }
                    else { hCtx.lineTo(x, y); }
                }
                hCtx.strokeStyle = `rgba(255, 255, 255, ${0.42 * gFactor})`;
                hCtx.lineWidth = Math.max(3, w * 0.013);
                hCtx.lineCap = 'round';
                hCtx.lineJoin = 'round';
                hCtx.shadowColor = 'rgba(255, 255, 255, 0.8)';
                hCtx.shadowBlur = Math.max(4, w * 0.012);
                hCtx.stroke();
                hCtx.restore();

                // 1-2. 윗입술 선명한 유리알 엣지 스펙큘러 (M자 큐피트 능선)
                hCtx.save();
                hCtx.beginPath();
                first = true;
                for (let i = 0; i < uLen; i++) {
                    const t = i / (uLen - 1);
                    if (t < 0.20 || t > 0.80) continue;
                    const pO = smoothUpperOuter[i];
                    const pI = smoothUpperInner[i];
                    const x = pO[0] * 0.68 + pI[0] * 0.32;
                    const y = pO[1] * 0.68 + pI[1] * 0.32;
                    if (first) { hCtx.moveTo(x, y); first = false; }
                    else { hCtx.lineTo(x, y); }
                }
                hCtx.strokeStyle = `rgba(255, 255, 255, ${0.85 * gFactor})`;
                hCtx.lineWidth = Math.max(1.5, w * 0.005);
                hCtx.lineCap = 'round';
                hCtx.lineJoin = 'round';
                hCtx.shadowColor = 'rgba(255, 255, 255, 0.95)';
                hCtx.shadowBlur = Math.max(2, w * 0.004);
                hCtx.stroke();
                hCtx.restore();

                // 1-3. 큐피트 봉우리 고광택 포인트 글린트 (좌/우 피크)
                const qLeftIdx = Math.floor(uLen * 0.36);
                const qRightIdx = Math.floor(uLen * 0.64);
                [qLeftIdx, qRightIdx].forEach(idx => {
                    if (idx >= 0 && idx < uLen) {
                        const pO = smoothUpperOuter[idx];
                        const pI = smoothUpperInner[idx];
                        const qx = pO[0] * 0.70 + pI[0] * 0.30;
                        const qy = pO[1] * 0.70 + pI[1] * 0.30;
                        const rad = Math.max(2.5, w * 0.007);
                        hCtx.save();
                        const gRad = hCtx.createRadialGradient(qx, qy, 0, qx, qy, rad * 2.2);
                        gRad.addColorStop(0, `rgba(255, 255, 255, ${0.96 * gFactor})`);
                        gRad.addColorStop(0.45, `rgba(255, 255, 255, ${0.52 * gFactor})`);
                        gRad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                        hCtx.fillStyle = gRad;
                        hCtx.beginPath();
                        hCtx.arc(qx, qy, rad * 2.2, 0, Math.PI * 2);
                        hCtx.fill();
                        hCtx.restore();
                    }
                });
            }

            // 2. 🌓 아랫입술 (Lower Lip) 탕후루 크레센트 링 & 3D 볼륨 앰플 광채
            const lLen = Math.min(smoothLowerOuter.length, smoothLowerInner.length);
            if (lLen >= 6) {
                // 2-1. 아랫입술 중심 3D 볼륨 앰플 소프트 블룸
                const midIdx = Math.floor(lLen * 0.5);
                const lMidO = smoothLowerOuter[midIdx];
                const lMidI = smoothLowerInner[midIdx];
                const lCenterX = (lMidO[0] + lMidI[0]) / 2.0;
                const lCenterY = lMidI[1] * 0.40 + lMidO[1] * 0.60;
                const lLipW = Math.abs(smoothLowerOuter[lLen - 1][0] - smoothLowerOuter[0][0]);
                const lLipH = Math.abs(lMidO[1] - lMidI[1]);

                hCtx.save();
                const bloomGrad = hCtx.createRadialGradient(
                    lCenterX, lCenterY, Math.max(2, lLipH * 0.1),
                    lCenterX, lCenterY, Math.max(10, lLipW * 0.30)
                );
                bloomGrad.addColorStop(0, `rgba(255, 255, 255, ${0.58 * gFactor})`);
                bloomGrad.addColorStop(0.45, `rgba(255, 255, 255, ${0.28 * gFactor})`);
                bloomGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                hCtx.fillStyle = bloomGrad;
                hCtx.beginPath();
                hCtx.ellipse(lCenterX, lCenterY, lLipW * 0.28, Math.max(6, lLipH * 0.42), 0, 0, Math.PI * 2);
                hCtx.fill();
                hCtx.restore();

                // 2-2. 탕후루 크레센트 링
                const ringTopPts = [];
                const ringBotPts = [];
                for (let i = 0; i < lLen; i++) {
                    const t = i / (lLen - 1);
                    if (t < 0.18 || t > 0.82) continue;
                    const pO = smoothLowerOuter[i];
                    const pI = smoothLowerInner[i];
                    
                    const topX = pI[0] * 0.60 + pO[0] * 0.40;
                    const topY = pI[1] * 0.60 + pO[1] * 0.40;
                    const botX = pI[0] * 0.35 + pO[0] * 0.65;
                    const botY = pI[1] * 0.35 + pO[1] * 0.65;
                    
                    ringTopPts.push([topX, topY]);
                    ringBotPts.push([botX, botY]);
                }

                if (ringTopPts.length > 2 && ringBotPts.length > 2) {
                    hCtx.save();
                    hCtx.beginPath();
                    hCtx.moveTo(ringTopPts[0][0], ringTopPts[0][1]);
                    for (let i = 1; i < ringTopPts.length; i++) {
                        hCtx.lineTo(ringTopPts[i][0], ringTopPts[i][1]);
                    }
                    for (let i = ringBotPts.length - 1; i >= 0; i--) {
                        hCtx.lineTo(ringBotPts[i][0], ringBotPts[i][1]);
                    }
                    hCtx.closePath();

                    const ringGrad = hCtx.createLinearGradient(
                        ringTopPts[0][0], ringTopPts[0][1],
                        ringTopPts[ringTopPts.length - 1][0], ringTopPts[ringTopPts.length - 1][1]
                    );
                    ringGrad.addColorStop(0, `rgba(255, 255, 255, ${0.25 * gFactor})`);
                    ringGrad.addColorStop(0.3, `rgba(255, 255, 255, ${0.80 * gFactor})`);
                    ringGrad.addColorStop(0.5, `rgba(255, 255, 255, ${0.94 * gFactor})`);
                    ringGrad.addColorStop(0.7, `rgba(255, 255, 255, ${0.80 * gFactor})`);
                    ringGrad.addColorStop(1, `rgba(255, 255, 255, ${0.25 * gFactor})`);

                    hCtx.fillStyle = ringGrad;
                    hCtx.shadowColor = 'rgba(255, 255, 255, 0.95)';
                    hCtx.shadowBlur = Math.max(3, w * 0.008);
                    hCtx.fill();

                    hCtx.beginPath();
                    hCtx.moveTo(ringBotPts[0][0], ringBotPts[0][1]);
                    for (let i = 1; i < ringBotPts.length; i++) {
                        hCtx.lineTo(ringBotPts[i][0], ringBotPts[i][1]);
                    }
                    hCtx.strokeStyle = `rgba(255, 255, 255, ${0.98 * gFactor})`;
                    hCtx.lineWidth = Math.max(1.8, w * 0.006);
                    hCtx.lineCap = 'round';
                    hCtx.stroke();
                    hCtx.restore();
                }

                // 2-3. 아랫입술 상단 내측 구순선 수분광 엣지
                hCtx.save();
                hCtx.beginPath();
                let firstInner = true;
                for (let i = 0; i < lLen; i++) {
                    const t = i / (lLen - 1);
                    if (t < 0.28 || t > 0.72) continue;
                    const pO = smoothLowerOuter[i];
                    const pI = smoothLowerInner[i];
                    const x = pI[0] * 0.88 + pO[0] * 0.12;
                    const y = pI[1] * 0.88 + pO[1] * 0.12;
                    if (firstInner) { hCtx.moveTo(x, y); firstInner = false; }
                    else { hCtx.lineTo(x, y); }
                }
                hCtx.strokeStyle = `rgba(255, 255, 255, ${0.75 * gFactor})`;
                hCtx.lineWidth = Math.max(1.2, w * 0.004);
                hCtx.lineCap = 'round';
                hCtx.shadowColor = 'rgba(255, 255, 255, 0.7)';
                hCtx.shadowBlur = 2;
                hCtx.stroke();
                hCtx.restore();

                // 2-4. 아랫입술 최고 피크 미세 하이라이트 글린트
                const p1Idx = Math.floor(lLen * 0.38);
                const p2Idx = Math.floor(lLen * 0.62);
                [p1Idx, p2Idx].forEach(idx => {
                    if (idx >= 0 && idx < lLen) {
                        const pO = smoothLowerOuter[idx];
                        const pI = smoothLowerInner[idx];
                        const px = pI[0] * 0.45 + pO[0] * 0.55;
                        const py = pI[1] * 0.45 + pO[1] * 0.55;
                        const rad = Math.max(2.5, w * 0.007);
                        hCtx.save();
                        const gRad = hCtx.createRadialGradient(px, py, 0, px, py, rad * 2.2);
                        gRad.addColorStop(0, `rgba(255, 255, 255, ${0.98 * gFactor})`);
                        gRad.addColorStop(0.45, `rgba(255, 255, 255, ${0.52 * gFactor})`);
                        gRad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                        hCtx.fillStyle = gRad;
                        hCtx.beginPath();
                        hCtx.arc(px, py, rad * 2.2, 0, Math.PI * 2);
                        hCtx.fill();
                        hCtx.restore();
                    }
                });
            }
        }



        // 🎨 윗입술/아랫입술 독립 틴트 시뮬레이션 렌더링
        function renderTintSimulation(targetCtx, w, h, curves) {
            if (!fillTint) return;
            const closedUpper = curves.closedUpperLoop;
            const closedLower = curves.closedLowerLoop;

            const { canvas: offCanvas, ctx: offCtx } = getBufferCanvas('tint', w, h);

            const rgb = hexToRgb(currentColor);
            const alpha = (opacity / 100.0) * (density / 100.0);
            offCtx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;

            // 1. 윗입술 채움
            if (closedUpper && closedUpper.length > 2) {
                offCtx.beginPath();
                offCtx.moveTo(closedUpper[0][0], closedUpper[0][1]);
                for (let i = 1; i < closedUpper.length; i++) {
                    offCtx.lineTo(closedUpper[i][0], closedUpper[i][1]);
                }
                offCtx.closePath();
                offCtx.fill();
            }

            // 2. 아랫입술 채움
            if (closedLower && closedLower.length > 2) {
                offCtx.beginPath();
                offCtx.moveTo(closedLower[0][0], closedLower[0][1]);
                for (let i = 1; i < closedLower.length; i++) {
                    offCtx.lineTo(closedLower[i][0], closedLower[i][1]);
                }
                offCtx.closePath();
                offCtx.fill();
            }

            // 주름 질감 보존 블렌딩
            targetCtx.save();
            if (blurVal > 0) {
                targetCtx.filter = `blur(${blurVal}px)`;
            } else {
                targetCtx.filter = 'none';
            }
            targetCtx.globalCompositeOperation = (currentTech === 'water_color' || currentTech === 'natural') ? "multiply" : "source-over";
            targetCtx.drawImage(offCanvas, 0, 0);
            targetCtx.restore();

            // 3. 탕후루 광택
            if (gloss > 0) {
                const { canvas: hCanvas, ctx: hCtx } = getBufferCanvas('gloss', w, h);
                renderIntelligentLipGloss(hCtx, w, h, curves, gloss);

                targetCtx.save();
                targetCtx.drawImage(hCanvas, 0, 0);
                targetCtx.restore();
            }
        }

        // 캔버스 렌더링
        // ── 실제 입술을 부풀리는 워프 ──────────────────────────────────
        // 오버립으로 곡선만 밀어내면 '색칠한 모양'만 커진다. 사진 속 입술은
        // 그대로 있으니 스티커를 붙인 것처럼 겉돈다.
        //
        // 그래서 사진의 입술 픽셀 자체를 곡선이 움직인 만큼 같이 밀어낸다.
        // 입술 경계에서는 곡선과 똑같이 움직이고, 거기서 멀어질수록 덜 따라와
        // 주변 살결이 자연스럽게 늘어난다. 반경 밖은 손대지 않는다.
        //
        // 곡선과 사진이 같은 변위를 쓰기 때문에 색이 채워질 자리와 실제로
        // 부푼 자리가 어긋나지 않는다.
        //
        // 퀵에서만 켠다. 메뉴얼은 입술을 옮기고 늘리는 조절이 많아,
        // 그 움직임까지 사진에 먹이면 얼굴이 뭉개진다.
        const USE_LIP_WARP = !!(window.CFG && window.CFG.ui_mode === "quick");

        let warpCache = { key: "", canvas: null, x: 0, y: 0 };

        /**
         * 오버립이 곡선을 얼마나 밀었는지 되짚어 [지금자리x, 지금자리y, dx, dy] 목록을 만든다.
         * 윗입술은 y -= over·sin(tπ)·(h/600), 아랫입술은 y += 같은 값이다.
         */
        function overlipControls(curves, h) {
            const out = [];
            // 곡선이 워낙 부드러워 한 점 걸러 써도 결과가 같다.
            // 조절점이 절반이면 변위장을 만드는 시간도 절반이다.
            const add = (pts, sign, amount) => {
                if (!pts) return;
                const n = pts.length;
                for (let i = 0; i < n; i += 2) {
                    const t = n > 1 ? i / (n - 1) : 0;
                    const d = amount ? amount * Math.sin(t * Math.PI) * (h / 600) : 0;
                    out.push([pts[i][0], pts[i][1], 0, sign * d]);
                }
                if (n > 1 && (n - 1) % 2 !== 0) {          // 끝점(입꼬리)은 꼭 넣는다
                    out.push([pts[n - 1][0], pts[n - 1][1], 0, 0]);
                }
            };
            // 바깥 경계는 오버립만큼 밀려난다 (입꼬리는 sin 이 0 이라 저절로 제자리)
            add(curves.uo_t, -1, upperTopOver);
            add(curves.lo_t, +1, lowerBottomOver);
            // 입 다문 선은 못박는다. 이게 없으면 입술이 늘어나지 않고 통째로
            // 밀려 내려가, 결이 뭉개지고 광택 자리도 같이 끌려간다.
            add(curves.ui_t, 0, 0);
            add(curves.li_t, 0, 0);
            return out;
        }

        /**
         * 조절점들이 만드는 변위장으로 사진의 입 주변만 다시 그린다.
         * 픽셀마다 조절점을 전부 훑으면 느려서, 4px 격자에서만 변위를 구하고
         * 그 사이는 이어서 쓴다. 눈에 보이는 차이는 없고 20배쯤 빠르다.
         */
        function buildWarpPatch(w, h, pairs) {
            let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, maxD = 0;
            for (let i = 0; i < pairs.length; i++) {
                const p = pairs[i];
                if (p[0] < minX) minX = p[0];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[1] > maxY) maxY = p[1];
                const d = Math.abs(p[3]);
                if (d > maxD) maxD = d;
            }
            if (maxX < minX || maxD < 0.5) return null;

            // 영향 반경 — 밀려난 거리의 두 배 남짓. 이 밖은 손대지 않는다.
            // 너무 넓게 잡으면 코와 턱까지 따라 움직인다.
            const R = Math.max(maxD * 2.2, 14);

            const x0 = Math.max(0, Math.floor(minX - R));
            const y0 = Math.max(0, Math.floor(minY - R));
            const x1 = Math.min(w, Math.ceil(maxX + R));
            const y1 = Math.min(h, Math.ceil(maxY + R));
            const rw = x1 - x0, rh = y1 - y0;
            if (rw < 4 || rh < 4) return null;

            const src = document.createElement("canvas");
            src.width = rw; src.height = rh;
            const sctx = src.getContext("2d", { willReadFrequently: true });
            sctx.drawImage(captureBg || bgImg, x0, y0, rw, rh, 0, 0, rw, rh);
            const sd = sctx.getImageData(0, 0, rw, rh);
            const S = sd.data;

            // ── 4px 격자에서 변위 구하기 ──
            const STEP = 6;
            const gw = Math.ceil(rw / STEP) + 1;
            const gh = Math.ceil(rh / STEP) + 1;
            const gdx = new Float32Array(gw * gh);
            const gdy = new Float32Array(gw * gh);

            for (let gy = 0; gy < gh; gy++) {
                const py = y0 + gy * STEP;
                for (let gx = 0; gx < gw; gx++) {
                    const px = x0 + gx * STEP;
                    let nx = 0, ny = 0, den = 0, near = R;
                    for (let i = 0; i < pairs.length; i++) {
                        const p = pairs[i];
                        const ax = px - p[0], ay = py - p[1];
                        // 대부분의 조절점은 멀리 있다. 네모로 먼저 걸러야
                        // 제곱근을 백만 번 계산하지 않는다.
                        if (ax >= R || ax <= -R || ay >= R || ay <= -R) continue;
                        const dd = Math.sqrt(ax * ax + ay * ay);
                        if (dd >= R) continue;
                        if (dd < near) near = dd;
                        const u = 1 - dd / R;
                        const wgt = (u * u) / (dd + 2);     // 가까운 점의 말을 더 듣는다
                        nx += wgt * p[2]; ny += wgt * p[3]; den += wgt;
                    }
                    const gi = gy * gw + gx;
                    if (den <= 0) { gdx[gi] = 0; gdy[gi] = 0; continue; }
                    // 가장 가까운 조절점에서 멀어질수록 약해진다 (반경에서 정확히 0)
                    const k = 1 - near / R;
                    const s = k * k * (3 - 2 * k);
                    gdx[gi] = (nx / den) * s;
                    gdy[gi] = (ny / den) * s;
                }
            }

            // ── 픽셀마다 되짚어 읽기 ──
            const out = document.createElement("canvas");
            out.width = rw; out.height = rh;
            const octx = out.getContext("2d");
            const od = octx.createImageData(rw, rh);
            const O = od.data;

            for (let y = 0; y < rh; y++) {
                const fy = y / STEP, iy = fy | 0, ay = fy - iy;
                const r0 = iy * gw, r1 = (iy + 1 < gh ? iy + 1 : iy) * gw;
                for (let x = 0; x < rw; x++) {
                    const fx = x / STEP, ix = fx | 0, ax = fx - ix;
                    const jx = ix + 1 < gw ? ix + 1 : ix;

                    const dx = (gdx[r0 + ix] * (1 - ax) + gdx[r0 + jx] * ax) * (1 - ay)
                             + (gdx[r1 + ix] * (1 - ax) + gdx[r1 + jx] * ax) * ay;
                    const dy = (gdy[r0 + ix] * (1 - ax) + gdy[r0 + jx] * ax) * (1 - ay)
                             + (gdy[r1 + ix] * (1 - ax) + gdy[r1 + jx] * ax) * ay;

                    let sx = x - dx, sy = y - dy;
                    if (sx < 0) sx = 0; else if (sx > rw - 1.001) sx = rw - 1.001;
                    if (sy < 0) sy = 0; else if (sy > rh - 1.001) sy = rh - 1.001;

                    const bx = sx | 0, by = sy | 0;
                    const tx = sx - bx, ty = sy - by;
                    const i00 = (by * rw + bx) * 4;
                    const i10 = i00 + 4;
                    const i01 = i00 + rw * 4;
                    const i11 = i01 + 4;
                    const o = (y * rw + x) * 4;
                    for (let c = 0; c < 3; c++) {
                        O[o + c] =
                            (S[i00 + c] * (1 - tx) + S[i10 + c] * tx) * (1 - ty) +
                            (S[i01 + c] * (1 - tx) + S[i11 + c] * tx) * ty;
                    }
                    O[o + 3] = 255;
                }
            }
            octx.putImageData(od, 0, 0);

            src.width = 0; src.height = 0;          // 저사양 기기에서 바로 반납
            return { canvas: out, x: x0, y: y0 };
        }

        /** 지금 값으로 만든 워프 조각. 값이 그대로면 다시 만들지 않는다. */
        function getWarpPatch(w, h, curves) {
            if (!USE_LIP_WARP) return null;
            if (!(upperTopOver > 0 || lowerBottomOver > 0)) return null;
            if (!bgImg || !(bgImg.complete || bgImg.naturalWidth > 0)) return null;

            const uo = curves.uo_t, lo = curves.lo_t;
            const sig = (pts) => {
                if (!pts || !pts.length) return "0";
                const a = pts[0], b = pts[pts.length - 1], m = pts[pts.length >> 1];
                return [a[0], a[1], m[0], m[1], b[0], b[1]].map(Math.round).join(",");
            };
            const key = Math.round(upperTopOver) + "|" + Math.round(lowerBottomOver)
                      + "|" + sig(uo) + "|" + sig(lo) + "|" + w + "x" + h;
            if (warpCache.key === key && warpCache.canvas) return warpCache;

            let patch = null;
            try {
                patch = buildWarpPatch(w, h, overlipControls(curves, h));
            } catch (e) {
                console.warn("입술 워프 건너뜀", e);
            }
            if (warpCache.canvas && warpCache.canvas !== (patch && patch.canvas)) {
                warpCache.canvas.width = 0; warpCache.canvas.height = 0;
            }
            warpCache = patch ? { key: key, canvas: patch.canvas, x: patch.x, y: patch.y }
                              : { key: key, canvas: null, x: 0, y: 0 };
            return warpCache.canvas ? warpCache : null;
        }

        function renderCanvas() {
            const w = canvas.width || CFG.img_w;
            const h = canvas.height || CFG.img_h;
            ctx.clearRect(0, 0, w, h);

            const zoomF = curImgZoom / 100.0;

            /** @param useOrig 맨얼굴을 그린다 ('시술 전' 과 비교의 왼쪽) */
            function drawPhoto(targetCtx, patch, useOrig) {
                try {
                    const src = useOrig
                        ? (origImg.complete && origImg.naturalWidth > 0 ? origImg : bgImg)
                        : (captureBg || bgImg);
                    if (src && (src.complete || src.naturalWidth > 0)) {
                        targetCtx.drawImage(src, 0, 0, w, h);
                    }
                    // 입 주변만 부풀린 조각을 덮는다. 나머지는 원본 그대로다.
                    if (patch && patch.canvas) {
                        targetCtx.drawImage(patch.canvas, patch.x, patch.y);
                    }
                } catch(e) {
                    console.warn("drawPhoto error:", e);
                }
            }

            if (viewMode === 'before') {
                ctx.save();
                ctx.translate(w / 2.0 + curImgPanX, h / 2.0 + curImgPanY);
                ctx.scale(zoomF, zoomF);
                ctx.translate(-w / 2.0, -h / 2.0);
                drawPhoto(ctx, null, true);       // 시술 전 = 맨얼굴
                ctx.restore();
                return;
            }

            const { canvas: afterCanvas, ctx: aCtx } = getBufferCanvas('after', w, h);

            aCtx.save();
            aCtx.translate(w / 2.0 + curImgPanX, h / 2.0 + curImgPanY);
            aCtx.scale(zoomF, zoomF);
            aCtx.translate(-w / 2.0, -h / 2.0);

            // 곡선을 먼저 구한다. 사진을 얼마나 부풀릴지가 곡선의 변위에서 나온다.
            const curves = getTransformedCurves();
            drawPhoto(aCtx, getWarpPatch(w, h, curves));
            const {
                closedUpperLoop, closedLowerLoop
            } = curves;

            const upperBbox = getBoxForPoly(closedUpperLoop, 10);
            const lowerBbox = getBoxForPoly(closedLowerLoop, 10);
            const totalBbox = getBoxForPoly((closedUpperLoop || []).concat(closedLowerLoop || []), 14);

            // 1. 윗입술 & 아랫입술 틴트 채움 및 지능적 탕후루 유리알 광택 렌더링
            // 색 입히기가 터져도 사진과 시술선은 계속 그린다.
            // 어떤 기기에서 입술색만 안 올라온 적이 있는데, 그때 무엇이
            // 터졌는지 알 길이 없었다. 이제는 남긴다.
            try {
                renderTintSimulation(aCtx, w, h, curves);
            } catch (e) {
                console.warn("입술 색 입히기 실패", e);
                if (window.__blReport) {
                    window.__blReport("입술", "색 입히기 실패: " + ((e && e.message) || e));
                }
            }

            // 2. 🟡 시술 디자인선 (윗입술 + 아랫입술 개별 골드 선)
            if (showDesignLine) {
                aCtx.save();
                aCtx.strokeStyle = designLineColor;
                aCtx.lineWidth = lineWidth;
                aCtx.lineJoin = 'round';
                aCtx.lineCap = 'round';
                aCtx.shadowColor = 'rgba(0, 0, 0, 0.6)';
                aCtx.shadowBlur = 4;

                // 윗입술 외곽 및 내측선
                if (closedUpperLoop && closedUpperLoop.length > 2) {
                    aCtx.beginPath();
                    aCtx.moveTo(closedUpperLoop[0][0], closedUpperLoop[0][1]);
                    for (let i = 1; i < closedUpperLoop.length; i++) aCtx.lineTo(closedUpperLoop[i][0], closedUpperLoop[i][1]);
                    aCtx.closePath();
                    aCtx.stroke();
                }

                // 아랫입술 외곽 및 내측선
                if (closedLowerLoop && closedLowerLoop.length > 2) {
                    aCtx.beginPath();
                    aCtx.moveTo(closedLowerLoop[0][0], closedLowerLoop[0][1]);
                    for (let i = 1; i < closedLowerLoop.length; i++) aCtx.lineTo(closedLowerLoop[i][0], closedLowerLoop[i][1]);
                    aCtx.closePath();
                    aCtx.stroke();
                }
                aCtx.restore();
            }

            // 3. 🔲 드래그 앤 드롭 안내 박스
            const targetLip = isDraggingLip ? activeDragMode : (hoveredLip || selectedLip);
            let curBox = null;
            let curLabel = "";
            let curStroke = "rgba(255, 215, 0, 0.9)";

            if (targetLip === 'upper') {
                curBox = upperBbox;
                curLabel = "💋 윗입술 이동 (드래그)";
                curStroke = "#FFD700";
            } else if (targetLip === 'lower') {
                curBox = lowerBbox;
                curLabel = "🌓 아랫입술 이동 (드래그)";
                curStroke = "#FFD700";
            } else if (targetLip === 'both') {
                curBox = totalBbox;
                curLabel = "🔗 전체 입술 함께 이동";
                curStroke = "#D4AF37";
            }

            if (curBox && (hoveredLip || isDraggingLip || selectedLip)) {
                aCtx.save();
                aCtx.strokeStyle = curStroke;
                aCtx.lineWidth = 3;
                aCtx.setLineDash([8, 6]);
                aCtx.strokeRect(curBox.x, curBox.y, curBox.w, curBox.h);

                const badgeW = 284;
                const badgeH = 42;
                const badgeX = Math.round(curBox.x + curBox.w / 2 - (badgeW / 2));
                const badgeY = Math.round(curBox.y - badgeH - 8);

                aCtx.fillStyle = "rgba(20, 16, 13, 0.95)";
                aCtx.fillRect(badgeX, badgeY, badgeW, badgeH);
                aCtx.strokeStyle = "#D4AF37";
                aCtx.lineWidth = 2;
                aCtx.setLineDash([]);
                aCtx.strokeRect(badgeX, badgeY, badgeW, badgeH);

                aCtx.fillStyle = "#FFE066";
                aCtx.font = "bold 22px 'Pretendard', sans-serif";
                aCtx.textAlign = "center";
                aCtx.textBaseline = "middle";
                aCtx.fillText(curLabel, badgeX + badgeW / 2, badgeY + (badgeH / 2));
                aCtx.restore();
            }

            aCtx.restore();

            // 4. 뷰 모드 합성 (After vs Split)
            if (viewMode === 'after') {
                ctx.drawImage(afterCanvas, 0, 0);
            } else if (viewMode === 'split') {
                const splitX = Math.round(w * splitRatio);
                
                // 좌측: Before
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, 0, splitX, h);
                ctx.clip();
                ctx.save();
                ctx.translate(w / 2.0 + curImgPanX, h / 2.0 + curImgPanY);
                ctx.scale(zoomF, zoomF);
                ctx.translate(-w / 2.0, -h / 2.0);
                drawPhoto(ctx, null, true);       // 비교 왼쪽 = 맨얼굴
                ctx.restore();
                ctx.restore();

                // 우측: After
                ctx.save();
                ctx.beginPath();
                ctx.rect(splitX, 0, w - splitX, h);
                ctx.clip();
                ctx.drawImage(afterCanvas, 0, 0);
                ctx.restore();

                // 중앙 구분선
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(splitX, 0);
                ctx.lineTo(splitX, h);
                // 굵기·손잡이 크기는 '화면에서 보이는 크기' 로 정한다. 캔버스는 사진 원래 해상도라
                // 캔버스 픽셀로 정하면 화면에서 두세 배 두껍게 보였다 (2026-10-07 원장님: 너무 두껍다).
                const px = canvasPxPerCss();
                ctx.strokeStyle = '#D4AF37';
                ctx.lineWidth = 1.5 * px;
                ctx.shadowColor = 'rgba(0,0,0,0.7)';
                ctx.shadowBlur = 4 * px;
                ctx.stroke();

                // 🌟 스플릿 바 원형 핸들 (radius = 38px)
                // 눈썹 비교와 같이 '보이는 사진' 의 아래쪽 20% 자리에 둔다.
                // 가운데에 두면 입술을 가려 설명할 때 거슬렸다 (2026-10-07).
                const hy = splitHandleY(h);
                ctx.beginPath();
                ctx.arc(splitX, hy, 13 * px, 0, Math.PI * 2);   // 지름 26px
                ctx.fillStyle = '#D4AF37';
                ctx.fill();
                ctx.strokeStyle = '#111111';
                ctx.lineWidth = 1.5 * px;
                ctx.stroke();

                // 화살표는 글자(↔) 대신 선으로 그린다 — 글자는 기기 글꼴마다 가운데가 틀어진다
                ctx.shadowBlur = 0;
                ctx.strokeStyle = '#111111';
                ctx.lineWidth = 1.8 * px;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                const a = 6.5 * px, k = 3.5 * px;
                ctx.beginPath();
                ctx.moveTo(splitX - a, hy); ctx.lineTo(splitX + a, hy);
                ctx.moveTo(splitX - a + k, hy - k); ctx.lineTo(splitX - a, hy); ctx.lineTo(splitX - a + k, hy + k);
                ctx.moveTo(splitX + a - k, hy - k); ctx.lineTo(splitX + a, hy); ctx.lineTo(splitX + a - k, hy + k);
                ctx.stroke();
                ctx.restore();
            }
        }

        /** 화면 1px 이 캔버스 몇 px 인지 (캔버스는 사진 해상도, 화면엔 줄여 보인다) */
        function canvasPxPerCss() {
            try {
                const w = canvas.getBoundingClientRect().width;
                if (w > 0) return canvas.width / w;
            } catch (e) {}
            return 1;
        }

        /** 비교 손잡이 높이 (캔버스 좌표). 사진이 화면보다 길어 아래가 시트에 가리면
         *  보이는 부분만 놓고 그 아래쪽 20% 에 둔다. */
        function splitHandleY(h) {
            try {
                const cr = canvas.getBoundingClientRect();
                const stage = canvas.closest('.mui-stage');
                if (stage && cr.height > 0) {
                    const sr = stage.getBoundingClientRect();
                    const pad = parseFloat(getComputedStyle(stage).paddingBottom) || 0;
                    const top = Math.max(cr.top, sr.top);
                    const bot = Math.min(cr.bottom, sr.bottom - pad);
                    if (bot > top) return ((top + (bot - top) * 0.8) - cr.top) / cr.height * h;
                }
            } catch (e) {}
            return h * 0.8;
        }
        // 시트를 여닫거나 화면을 돌리면 보이는 높이가 바뀐다 — 비교 중이면 손잡이를 다시 그린다
        (function () {
            const again = () => { if (viewMode === 'split') requestRender(); };
            window.addEventListener('resize', again);
            if (typeof ResizeObserver === 'function') {
                setTimeout(() => {
                    const stage = canvas.closest('.mui-stage');
                    if (stage) new ResizeObserver(again).observe(stage);
                    const sheet = document.querySelector('.mui-sheet');
                    if (sheet) new ResizeObserver(again).observe(sheet);
                }, 0);
            }
        })();

        function getCanvasRawPos(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            return {
                x: (clientX - rect.left) * (canvas.width / (rect.width || 1)),
                y: (clientY - rect.top) * (canvas.height / (rect.height || 1))
            };
        }

        function getCanvasPos(clientX, clientY) {
            const raw = getCanvasRawPos(clientX, clientY);
            const zoomF = curImgZoom / 100.0;
            return {
                x: (raw.x - canvas.width / 2.0 - curImgPanX) / zoomF + canvas.width / 2.0,
                y: (raw.y - canvas.height / 2.0 - curImgPanY) / zoomF + canvas.height / 2.0
            };
        }

        // 🎯 점과 폴리곤 사이의 거리 계산
        function pointToPolyDistance(pt, poly) {
            if (!poly || poly.length === 0) return Infinity;
            if (isPointInPoly(pt, poly)) return 0;
            let minDist = Infinity;
            for (let i = 0; i < poly.length; i++) {
                const p = poly[i];
                const d = Math.hypot(p[0] - pt.x, p[1] - pt.y);
                if (d < minDist) minDist = d;
            }
            return minDist;
        }

        // 🎯 클릭/호버 위치에서 대상 입술(윗입술 vs 아랫입술) 자동 감지
        function getLipHitTarget(pos, closedUpperLoop, closedLowerLoop) {
            const inUpperPoly = isPointInPoly(pos, closedUpperLoop);
            const inLowerPoly = isPointInPoly(pos, closedLowerLoop);

            const upperBbox = getBoxForPoly(closedUpperLoop, 8);
            const lowerBbox = getBoxForPoly(closedLowerLoop, 8);

            if (inUpperPoly && !inLowerPoly) return 'upper';
            if (inLowerPoly && !inUpperPoly) return 'lower';

            if (inUpperPoly && inLowerPoly) {
                const upperMidY = upperBbox ? (upperBbox.y + upperBbox.h * 0.5) : 0;
                const lowerMidY = lowerBbox ? (lowerBbox.y + lowerBbox.h * 0.5) : 0;
                return Math.abs(pos.y - upperMidY) <= Math.abs(pos.y - lowerMidY) ? 'upper' : 'lower';
            }

            const distUpper = pointToPolyDistance(pos, closedUpperLoop);
            const distLower = pointToPolyDistance(pos, closedLowerLoop);

            if (distUpper <= 28 && distUpper < distLower) return 'upper';
            if (distLower <= 28 && distLower < distUpper) return 'lower';

            const inUpperBox = upperBbox && pos.x >= upperBbox.x && pos.x <= upperBbox.x + upperBbox.w && pos.y >= upperBbox.y && pos.y <= upperBbox.y + upperBbox.h;
            const inLowerBox = lowerBbox && pos.x >= lowerBbox.x && pos.x <= lowerBbox.x + lowerBbox.w && pos.y >= lowerBbox.y && pos.y <= lowerBbox.y + lowerBbox.h;

            if (inUpperBox && !inLowerBox) return 'upper';
            if (inLowerBox && !inUpperBox) return 'lower';

            if (upperBbox && lowerBbox) {
                const upperMidY = upperBbox.y + upperBbox.h * 0.5;
                const lowerMidY = lowerBbox.y + lowerBbox.h * 0.5;
                if (pos.y >= upperBbox.y - 12 && pos.y <= lowerBbox.y + lowerBbox.h + 12 &&
                    pos.x >= Math.min(upperBbox.x, lowerBbox.x) - 15 && pos.x <= Math.max(upperBbox.x + upperBbox.w, lowerBbox.x + lowerBbox.w) + 15) {
                    return Math.abs(pos.y - upperMidY) <= Math.abs(pos.y - lowerMidY) ? 'upper' : 'lower';
                }
            }

            return null;
        }

        // 🎯 캔버스 마우스 & 터치 드래그 앤 드롭 인터랙션
        function handleStart(clientX, clientY) {
            const raw = getCanvasRawPos(clientX, clientY);
            const pos = getCanvasPos(clientX, clientY);

            // 1. 스플릿 바 드래그 (정확한 캔버스 화면 픽셀 기준)
            if (viewMode === 'split') {
                const splitX = canvas.width * splitRatio;
                if (Math.abs(raw.x - splitX) <= 45) {
                    isDraggingSplit = true;
                    return;
                }
            }

            const { closedUpperLoop, closedLowerLoop } = getTransformedCurves();

            // 2. ✨ 화면에서 클릭한 입술 객체 감지
            let detected = getLipHitTarget(pos, closedUpperLoop, closedLowerLoop);

            if (detected) {
                let target = detected;
                if (moveTarget === 'upper') target = 'upper';
                else if (moveTarget === 'lower') target = 'lower';
                else if (moveTarget === 'both') target = 'both';

                isDraggingLip = true;
                selectedLip = target;
                hoveredLip = target;
                activeDragMode = target;
                startDragX = pos.x;
                startDragY = pos.y;
                startGlobalX = globalOffsetX;
                startGlobalY = globalOffsetY;
                startUpperX = upperOffsetX;
                startUpperY = upperOffsetY;
                startLowerX = lowerOffsetX;
                startLowerY = lowerOffsetY;
                canvas.style.cursor = 'move';
                requestRender();
                return;
            } else {
                // 3. 🌟 입술 외 다른 부분(배경, 볼, 이마 등) 클릭 시: 이동 경계선 즉시 해제 및 사라짐
                isDraggingLip = false;
                selectedLip = null;
                hoveredLip = null;
                activeDragMode = null;
                canvas.style.cursor = (viewMode === 'split' && Math.abs(raw.x - canvas.width * splitRatio) <= 45) ? 'ew-resize' : 'default';
                requestRender();
                return;
            }
        }

        function handleMove(clientX, clientY) {
            const raw = getCanvasRawPos(clientX, clientY);
            const pos = getCanvasPos(clientX, clientY);

            // 1. 스플릿 바 드래그 (정확한 캔버스 화면 픽셀 기준)
            if (isDraggingSplit) {
                splitRatio = Math.max(0.02, Math.min(0.98, raw.x / canvas.width));
                requestRender();
                return;
            }

            // 2. 전체 / 윗입술 / 아랫입술 드래그 앤 드롭 이동
            if (isDraggingLip) {
                const deltaX = pos.x - startDragX;
                const deltaY = pos.y - startDragY;

                if (activeDragMode === 'upper') {
                    upperOffsetX = Math.round(startUpperX + deltaX);
                    upperOffsetY = Math.round(startUpperY + deltaY);
                } else if (activeDragMode === 'lower') {
                    lowerOffsetX = Math.round(startLowerX + deltaX);
                    lowerOffsetY = Math.round(startLowerY + deltaY);
                } else if (activeDragMode === 'both') {
                    globalOffsetX = Math.round(startGlobalX + deltaX);
                    globalOffsetY = Math.round(startGlobalY + deltaY);
                }

                syncSliders();
                requestRender();
                return;
            }

            // 3. 호버 상태 감지
            const prevHovered = hoveredLip;
            const { closedUpperLoop, closedLowerLoop } = getTransformedCurves();

            let detected = getLipHitTarget(pos, closedUpperLoop, closedLowerLoop);
            if (detected) {
                let hit = detected;
                if (moveTarget === 'upper') hit = 'upper';
                else if (moveTarget === 'lower') hit = 'lower';
                else if (moveTarget === 'both') hit = 'both';
                hoveredLip = hit;
                canvas.style.cursor = 'move';
            } else {
                hoveredLip = null;
                if (viewMode === 'split' && Math.abs(raw.x - canvas.width * splitRatio) <= 45) {
                    canvas.style.cursor = 'ew-resize';
                } else {
                    canvas.style.cursor = 'default';
                }
            }

            if (prevHovered !== hoveredLip) {
                requestRender();
            }
        }

        function handleEnd() {
            if (isDraggingLip) {
                pushUndo();
            }
            isDraggingSplit = false;
            isDraggingLip = false;
            isPanningPhoto = false;
            requestRender();
        }

        canvas.addEventListener('mouseleave', () => {
            if (!isDraggingLip) {
                hoveredLip = null;
                requestRender();
            }
        });

        // 🔍 PC 마우스 휠 스크롤 줌인 / 줌아웃 기능
        canvas.addEventListener('wheel', function(e) {
            e.preventDefault();
            const step = (e.deltaY < 0) ? 6 : -6;
            curImgZoom = Math.min(300, Math.max(50, Math.round(curImgZoom + step)));
            requestRender();
        }, { passive: false });

        // 📱 모바일/태블릿 멀티 터치 핀치 줌인 / 줌아웃
        let isPinching = false;
        let initialPinchDist = 0;
        let initialPinchZoom = 100;
        let initialPinchMidX = 0;
        let initialPinchMidY = 0;
        let initialPanX = 0;
        let initialPanY = 0;

        function getTouchDist(t1, t2) {
            const dx = t1.clientX - t2.clientX;
            const dy = t1.clientY - t2.clientY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        function getTouchMid(t1, t2) {
            return {
                x: (t1.clientX + t2.clientX) / 2,
                y: (t1.clientY + t2.clientY) / 2
            };
        }

        let isPanningPhoto = false;
        let startPanMouseX = 0;
        let startPanMouseY = 0;
        let startPanX = 0;
        let startPanY = 0;

        canvas.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });

        canvas.addEventListener('mousedown', function(e) {
            if (e.button === 2) {
                // 🖱️ 우클릭 드래그: 사진 자유 이동 (Pan)
                e.preventDefault();
                isPanningPhoto = true;
                startPanMouseX = e.clientX;
                startPanMouseY = e.clientY;
                startPanX = curImgPanX;
                startPanY = curImgPanY;
                canvas.style.cursor = 'grab';
                return;
            } else if (e.button === 0) {
                handleStart(e.clientX, e.clientY);
            }
        });

        window.addEventListener('mousemove', function(e) {
            if (isPanningPhoto) {
                const dx = e.clientX - startPanMouseX;
                const dy = e.clientY - startPanMouseY;
                curImgPanX = Math.min(400, Math.max(-400, Math.round(startPanX + dx)));
                curImgPanY = Math.min(400, Math.max(-400, Math.round(startPanY + dy)));
                requestRender();
                return;
            }
            handleMove(e.clientX, e.clientY);
        });

        window.addEventListener('mouseup', function(e) {
            if (isPanningPhoto) {
                isPanningPhoto = false;
                canvas.style.cursor = 'default';
            }
            handleEnd();
        });

        // 🔄 사진 확대·이동을 원래대로
        function resetPhotoView() {
            curImgZoom = 100;
            curImgPanX = 0;
            curImgPanY = 0;
            syncSliders();
            requestRender();
            showToast('🔍 사진을 원래 크기로 되돌렸습니다.');
        }

        canvas.addEventListener('dblclick', function(e) {
            e.preventDefault();
            resetPhotoView();
        });

        // 폰에서는 dblclick 이 오지 않는다. touchstart 에서 기본 동작을 막기
        // 때문에 브라우저가 마우스 흉내 이벤트를 만들지 않는다.
        // 그래서 '두 번 톡톡' 을 직접 센다.
        (function bindDoubleTap() {
            let lastTap = 0, lastX = 0, lastY = 0;
            canvas.addEventListener('touchend', function(e) {
                if (e.touches.length !== 0 || e.changedTouches.length !== 1) return;
                const t = e.changedTouches[0];
                const now = Date.now();
                const near = Math.abs(t.clientX - lastX) < 30 && Math.abs(t.clientY - lastY) < 30;
                if (now - lastTap < 300 && near) {
                    lastTap = 0;
                    resetPhotoView();
                } else {
                    lastTap = now; lastX = t.clientX; lastY = t.clientY;
                }
            }, { passive: true });
        })();

        canvas.addEventListener('touchstart', e => {
            if (e.touches.length === 1) {
                isPinching = false;
                handleStart(e.touches[0].clientX, e.touches[0].clientY);
                e.preventDefault();
            } else if (e.touches.length === 2) {
                isDraggingLip = false;
                isDraggingSplit = false;
                isPinching = true;
                initialPinchDist = getTouchDist(e.touches[0], e.touches[1]);
                initialPinchZoom = curImgZoom;
                const mid = getTouchMid(e.touches[0], e.touches[1]);
                initialPinchMidX = mid.x;
                initialPinchMidY = mid.y;
                initialPanX = curImgPanX;
                initialPanY = curImgPanY;
                e.preventDefault();
            }
        }, {passive: false});

        window.addEventListener('touchmove', e => {
            if (isPinching && e.touches.length === 2) {
                if (e.cancelable) e.preventDefault();
                const currentDist = getTouchDist(e.touches[0], e.touches[1]);
                if (initialPinchDist > 0) {
                    const factor = currentDist / initialPinchDist;
                    curImgZoom = Math.min(300, Math.max(50, Math.round(initialPinchZoom * factor)));

                    const mid = getTouchMid(e.touches[0], e.touches[1]);
                    const deltaX = mid.x - initialPinchMidX;
                    const deltaY = mid.y - initialPinchMidY;
                    curImgPanX = Math.min(200, Math.max(-200, Math.round(initialPanX + deltaX)));
                    curImgPanY = Math.min(200, Math.max(-200, Math.round(initialPanY + deltaY)));

                    requestRender();
                }
            } else if ((isDraggingLip || isDraggingSplit) && e.touches.length === 1) {
                handleMove(e.touches[0].clientX, e.touches[0].clientY);
                e.preventDefault();
            }
        }, {passive: false});

        window.addEventListener('touchend', e => {
            if (e.touches.length === 0) {
                isPinching = false;
                handleEnd();
            } else if (e.touches.length === 1) {
                isPinching = false;
                handleStart(e.touches[0].clientX, e.touches[0].clientY);
            }
        });

        // 👁️ 뷰 모드 버튼
        function setViewMode(mode) {
            viewMode = mode;
            document.getElementById('btnViewBefore').classList.toggle('active', mode === 'before');
            document.getElementById('btnViewAfter').classList.toggle('active', mode === 'after');
            document.getElementById('btnViewSplit').classList.toggle('active', mode === 'split');
            requestRender();
        }
        document.getElementById('btnViewBefore').addEventListener('click', () => setViewMode('before'));
        document.getElementById('btnViewAfter').addEventListener('click', () => setViewMode('after'));
        document.getElementById('btnViewSplit').addEventListener('click', () => setViewMode('split'));

        // ✨ 입술 가이드 재추출 & 원위치 리셋 버튼
        const btnExtract = document.getElementById('btnExtractLips');
        if (btnExtract) {
            btnExtract.addEventListener('click', function() {
                isExtracted = true;
                this.classList.add('extracted');
                this.innerHTML = '<span>🔄 입술 가이드 재추출 / 원위치</span>';
                const badge = document.getElementById('detectionBadge');
                if (badge) badge.style.display = 'flex';
                const tb = document.getElementById('contourToolbar');
                if (tb) tb.style.display = 'flex';
                const ab = document.getElementById('contourActionsBar');
                if (ab) ab.style.display = 'flex';
                
                // 🎯 전체 위치 및 조절 파라미터를 초기 원본 실측 위치로 완벽 원위치 리셋
                applyPreset('default');
                syncSliders();
                renderCanvas();
                showToast('🔄 입술 가이드가 고객 입술 본래 위치로 원위치되었습니다!');
            });
        }

        function checkAutoExtract() {
            if (!isExtracted) {
                isExtracted = true;
                if (btnExtract) {
                    btnExtract.classList.add('extracted');
                    btnExtract.innerHTML = '<span>🔄 입술 가이드 재추출 / 원위치</span>';
                }
                document.getElementById('detectionBadge').style.display = 'flex';
                document.getElementById('contourToolbar').style.display = 'flex';
                document.getElementById('contourActionsBar').style.display = 'flex';
            }
        }

        // 🎯 이동 모드 버튼 핸들러
        function setMoveTarget(target) {
            moveTarget = target;
            document.querySelectorAll('.move-target-btn').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-target') === target);
            });
            syncSliders();
            renderCanvas();
            if (target === 'auto') showToast('✨ 자동 감지 모드 (화면에서 클릭한 입술 바로 이동)');
            else if (target === 'upper') showToast('💋 윗입술 단독 이동 모드');
            else if (target === 'lower') showToast('🌓 아랫입술 단독 이동 모드');
            else if (target === 'both') showToast('🔗 전체 입술 함께 이동 모드');
        }

        const btnMoveAuto = document.getElementById('btnMoveAuto');
        if (btnMoveAuto) btnMoveAuto.addEventListener('click', () => setMoveTarget('auto'));
        const btnMoveUpper = document.getElementById('btnMoveUpper');
        if (btnMoveUpper) btnMoveUpper.addEventListener('click', () => setMoveTarget('upper'));
        const btnMoveLower = document.getElementById('btnMoveLower');
        if (btnMoveLower) btnMoveLower.addEventListener('click', () => setMoveTarget('lower'));
        const btnMoveBoth = document.getElementById('btnMoveBoth');
        if (btnMoveBoth) btnMoveBoth.addEventListener('click', () => setMoveTarget('both'));

        // ⚡ 기본 실측 / 대칭 리셋 핸들러
        function applyPreset(type) {
            if (type === 'default') {
                globalOffsetX = 0; globalOffsetY = 0; globalWidth = 100;
                upperOffsetX = 0; upperOffsetY = 0; upperWidth = 100;
                lowerOffsetX = 0; lowerOffsetY = 0; lowerWidth = 100;

                upperTopOver = 0; upperTopPeakVol = 0; philtrumRound = 0; philtrumDepth = 0; philtrumWidth = 0; upperHeight = 100;
                upperBottomFullRound = 0; upperBottomY = 0; upperBottomCenterVol = 0; upperBottomRound = 0; upperBottomSideVol = 0;
                lowerTopY = 0; lowerTopCenterVol = 0; lowerTopRound = 0; lowerTopSideVol = 0;
                lowerBottomOver = 0; lowerBottomCenterVol = 0; lowerBottomRound = 0; lowerHeight = 100;
                upperLeftCornerY = 0; upperRightCornerY = 0; lowerLeftCornerY = 0; lowerRightCornerY = 0;
                cornerSharpL = 0; cornerSharpR = 0;
                cornerOverU = 0; cornerOverL = 0;
                upperLeftVolume = 0; upperRightVolume = 0; lowerLeftVolume = 0; lowerRightVolume = 0;
                blurVal = 3.5;
                showToast('🌿 기본 실측 위치 및 형태로 리셋되었습니다.');
            } else if (type === 'symmetry') {
                const avgUpperCorner = (upperLeftCornerY + upperRightCornerY) / 2;
                upperLeftCornerY = avgUpperCorner;
                upperRightCornerY = avgUpperCorner;
                const avgLowerCorner = (lowerLeftCornerY + lowerRightCornerY) / 2;
                lowerLeftCornerY = avgLowerCorner;
                lowerRightCornerY = avgLowerCorner;

                const avgUpperVol = (upperLeftVolume + upperRightVolume) / 2;
                upperLeftVolume = avgUpperVol;
                upperRightVolume = avgUpperVol;

                const avgLowerVol = (lowerLeftVolume + lowerRightVolume) / 2;
                lowerLeftVolume = avgLowerVol;
                lowerRightVolume = avgLowerVol;
                showToast('⚖️ 윗입술 & 아랫입술 입꼬리 및 좌우 볼륨 대칭이 맞춰졌습니다.');
            }
            syncSliders();
            checkAutoExtract();
            renderCanvas();
        }

        function syncSliders() {
            const currentSelected = (moveTarget === 'upper' || (moveTarget === 'auto' && activeDragMode === 'upper')) ? 'upper' :
                                    ((moveTarget === 'lower' || (moveTarget === 'auto' && activeDragMode === 'lower')) ? 'lower' :
                                    (moveTarget === 'both' ? 'both' : 'upper'));

            if (currentSelected === 'upper') {
                document.getElementById('lblMoveY').innerHTML = '📍 윗입술 상하 (Y) <span id="valMoveY">' + Math.round(upperOffsetY) + 'px</span>';
                document.getElementById('lblMoveX').innerHTML = '📍 윗입술 좌우 (X) <span id="valMoveX">' + Math.round(upperOffsetX) + 'px</span>';
                document.getElementById('rngMoveY').value = upperOffsetY;
                document.getElementById('rngMoveX').value = upperOffsetX;
            } else if (currentSelected === 'lower') {
                document.getElementById('lblMoveY').innerHTML = '📍 아랫입술 상하 (Y) <span id="valMoveY">' + Math.round(lowerOffsetY) + 'px</span>';
                document.getElementById('lblMoveX').innerHTML = '📍 아랫입술 좌우 (X) <span id="valMoveX">' + Math.round(lowerOffsetX) + 'px</span>';
                document.getElementById('rngMoveY').value = lowerOffsetY;
                document.getElementById('rngMoveX').value = lowerOffsetX;
            } else {
                document.getElementById('lblMoveY').innerHTML = '📍 전체 상하 (Y) <span id="valMoveY">' + Math.round(globalOffsetY) + 'px</span>';
                document.getElementById('lblMoveX').innerHTML = '📍 전체 좌우 (X) <span id="valMoveX">' + Math.round(globalOffsetX) + 'px</span>';
                document.getElementById('rngMoveY').value = globalOffsetY;
                document.getElementById('rngMoveX').value = globalOffsetX;
            }

            document.getElementById('rngGlobalWidth').value = globalWidth;
            document.getElementById('valGlobalWidth').textContent = Math.round(globalWidth) + '%';

            document.getElementById('rngUpperY').value = upperOffsetY;
            document.getElementById('valUpperY').textContent = Math.round(upperOffsetY) + 'px';
            document.getElementById('rngUpperX').value = upperOffsetX;
            document.getElementById('valUpperX').textContent = Math.round(upperOffsetX) + 'px';
            document.getElementById('rngUpperWidth').value = upperWidth;
            document.getElementById('valUpperWidth').textContent = Math.round(upperWidth) + '%';

            document.getElementById('rngLowerY').value = lowerOffsetY;
            document.getElementById('valLowerY').textContent = Math.round(lowerOffsetY) + 'px';
            document.getElementById('rngLowerX').value = lowerOffsetX;
            document.getElementById('valLowerX').textContent = Math.round(lowerOffsetX) + 'px';
            document.getElementById('rngLowerWidth').value = lowerWidth;
            document.getElementById('valLowerWidth').textContent = Math.round(lowerWidth) + '%';

            // 1. 윗입술 상부
            document.getElementById('rngUpperTopOver').value = upperTopOver;
            document.getElementById('valUpperTopOver').textContent = Math.round(upperTopOver) + 'px';
            document.getElementById('rngCornerOverU').value = cornerOverU;
            document.getElementById('valCornerOverU').textContent = Math.round(cornerOverU) + 'px';
            document.getElementById('rngCornerOverL').value = cornerOverL;
            document.getElementById('valCornerOverL').textContent = Math.round(cornerOverL) + 'px';
            document.getElementById('rngUpperTopPeakVol').value = upperTopPeakVol;
            document.getElementById('valUpperTopPeakVol').textContent = Math.round(upperTopPeakVol) + 'px';
            document.getElementById('rngPhiltrumRound').value = philtrumRound;
            document.getElementById('valPhiltrumRound').textContent = Math.round(philtrumRound) + 'px';
            document.getElementById('rngPhiltrumDepth').value = philtrumDepth;
            document.getElementById('valPhiltrumDepth').textContent = Math.round(philtrumDepth) + 'px';
            document.getElementById('rngPhiltrumWidth').value = philtrumWidth;
            document.getElementById('valPhiltrumWidth').textContent = Math.round(philtrumWidth) + 'px';
            document.getElementById('rngUpperHeight').value = upperHeight;
            document.getElementById('valUpperHeight').textContent = Math.round(upperHeight) + '%';

            // 2. 윗입술 하부
            document.getElementById('rngUpperBottomFullRound').value = upperBottomFullRound;
            document.getElementById('valUpperBottomFullRound').textContent = Math.round(upperBottomFullRound) + 'px';
            document.getElementById('rngUpperBottomY').value = upperBottomY;
            document.getElementById('valUpperBottomY').textContent = Math.round(upperBottomY) + 'px';
            document.getElementById('rngUpperBottomCenterVol').value = upperBottomCenterVol;
            document.getElementById('valUpperBottomCenterVol').textContent = Math.round(upperBottomCenterVol) + 'px';
            document.getElementById('rngUpperBottomRound').value = upperBottomRound;
            document.getElementById('valUpperBottomRound').textContent = Math.round(upperBottomRound) + 'px';
            document.getElementById('rngUpperBottomSideVol').value = upperBottomSideVol;
            document.getElementById('valUpperBottomSideVol').textContent = Math.round(upperBottomSideVol) + 'px';

            // 3. 아랫입술 상부
            document.getElementById('rngLowerTopY').value = lowerTopY;
            document.getElementById('valLowerTopY').textContent = Math.round(lowerTopY) + 'px';
            document.getElementById('rngLowerTopCenterVol').value = lowerTopCenterVol;
            document.getElementById('valLowerTopCenterVol').textContent = Math.round(lowerTopCenterVol) + 'px';
            document.getElementById('rngLowerTopRound').value = lowerTopRound;
            document.getElementById('valLowerTopRound').textContent = Math.round(lowerTopRound) + 'px';
            document.getElementById('rngLowerTopSideVol').value = lowerTopSideVol;
            document.getElementById('valLowerTopSideVol').textContent = Math.round(lowerTopSideVol) + 'px';

            // 4. 아랫입술 하부
            document.getElementById('rngLowerBottomOver').value = lowerBottomOver;
            document.getElementById('valLowerBottomOver').textContent = Math.round(lowerBottomOver) + 'px';
            document.getElementById('rngLowerBottomCenterVol').value = lowerBottomCenterVol;
            document.getElementById('valLowerBottomCenterVol').textContent = Math.round(lowerBottomCenterVol) + 'px';
            document.getElementById('rngLowerBottomRound').value = lowerBottomRound;
            document.getElementById('valLowerBottomRound').textContent = Math.round(lowerBottomRound) + 'px';
            document.getElementById('rngLowerHeight').value = lowerHeight;
            document.getElementById('valLowerHeight').textContent = Math.round(lowerHeight) + '%';

            // 윗입술 입꼬리 상하 조절
            document.getElementById('rngUpperLeftCorner').value = upperLeftCornerY;
            document.getElementById('valUpperLeftCorner').textContent = Math.round(upperLeftCornerY) + 'px';
            document.getElementById('rngUpperRightCorner').value = upperRightCornerY;
            document.getElementById('valUpperRightCorner').textContent = Math.round(upperRightCornerY) + 'px';
            syncSharpSliders();

            // 아랫입술 입꼬리 상하 조절
            document.getElementById('rngLowerLeftCorner').value = lowerLeftCornerY;
            document.getElementById('valLowerLeftCorner').textContent = Math.round(lowerLeftCornerY) + 'px';
            document.getElementById('rngLowerRightCorner').value = lowerRightCornerY;
            document.getElementById('valLowerRightCorner').textContent = Math.round(lowerRightCornerY) + 'px';

            // 윗입술 좌우 볼륨
            document.getElementById('rngUpperLeftVol').value = upperLeftVolume;
            document.getElementById('valUpperLeftVol').textContent = Math.round(upperLeftVolume) + 'px';
            document.getElementById('rngUpperRightVol').value = upperRightVolume;
            document.getElementById('valUpperRightVol').textContent = Math.round(upperRightVolume) + 'px';

            // 아랫입술 좌우 볼륨
            document.getElementById('rngLowerLeftVol').value = lowerLeftVolume;
            document.getElementById('valLowerLeftVol').textContent = Math.round(lowerLeftVolume) + 'px';
            document.getElementById('rngLowerRightVol').value = lowerRightVolume;
            document.getElementById('valLowerRightVol').textContent = Math.round(lowerRightVolume) + 'px';

            // 🎨 틴트 컬러 & 블러
            const elBlur = document.getElementById('rngBlur');
            if (elBlur) {
                elBlur.value = blurVal;
                document.getElementById('valBlur').textContent = blurVal + 'px';
            }
            const elDensity = document.getElementById('rngDensity');
            if (elDensity) {
                elDensity.value = density;
                document.getElementById('valDensity').textContent = Math.round(density) + '%';
            }
            const elOpacity = document.getElementById('rngOpacity');
            if (elOpacity) {
                elOpacity.value = opacity;
                document.getElementById('valOpacity').textContent = Math.round(opacity) + '%';
            }
        }

        // 슬라이더 바인딩 헬퍼
        function bind(id, valId, suffix, callback) {
            const el = document.getElementById(id);
            const valEl = document.getElementById(valId);
            if (!el || !valEl) return;
            el.addEventListener('input', function() {
                const v = parseFloat(this.value);
                valEl.textContent = (suffix === 'px' && id === 'rngBlur' ? v : Math.round(v)) + suffix;
                callback(v);
                checkAutoExtract();
                requestRender();
            });
        }

        document.getElementById('rngMoveY').addEventListener('input', function() {
            const v = parseFloat(this.value);
            const currentSelected = (moveTarget === 'upper' || (moveTarget === 'auto' && activeDragMode === 'upper')) ? 'upper' :
                                    ((moveTarget === 'lower' || (moveTarget === 'auto' && activeDragMode === 'lower')) ? 'lower' :
                                    (moveTarget === 'both' ? 'both' : 'upper'));
            if (currentSelected === 'upper') upperOffsetY = v;
            else if (currentSelected === 'lower') lowerOffsetY = v;
            else globalOffsetY = v;
            syncSliders();
            checkAutoExtract();
            requestRender();
        });
        document.getElementById('rngMoveX').addEventListener('input', function() {
            const v = parseFloat(this.value);
            const currentSelected = (moveTarget === 'upper' || (moveTarget === 'auto' && activeDragMode === 'upper')) ? 'upper' :
                                    ((moveTarget === 'lower' || (moveTarget === 'auto' && activeDragMode === 'lower')) ? 'lower' :
                                    (moveTarget === 'both' ? 'both' : 'upper'));
            if (currentSelected === 'upper') upperOffsetX = v;
            else if (currentSelected === 'lower') lowerOffsetX = v;
            else globalOffsetX = v;
            syncSliders();
            checkAutoExtract();
            requestRender();
        });

        bind('rngGlobalWidth', 'valGlobalWidth', '%', v => globalWidth = v);

        bind('rngUpperY', 'valUpperY', 'px', v => { upperOffsetY = v; syncSliders(); });
        bind('rngUpperX', 'valUpperX', 'px', v => { upperOffsetX = v; syncSliders(); });
        bind('rngUpperWidth', 'valUpperWidth', '%', v => upperWidth = v);

        bind('rngLowerY', 'valLowerY', 'px', v => { lowerOffsetY = v; syncSliders(); });
        bind('rngLowerX', 'valLowerX', 'px', v => { lowerOffsetX = v; syncSliders(); });
        bind('rngLowerWidth', 'valLowerWidth', '%', v => lowerWidth = v);

        // 1. 윗입술 상부 바인딩
        bind('rngUpperTopOver', 'valUpperTopOver', 'px', v => upperTopOver = v);
        bind('rngCornerOverU', 'valCornerOverU', 'px', v => cornerOverU = v);
        bind('rngCornerOverL', 'valCornerOverL', 'px', v => cornerOverL = v);
        bind('rngUpperTopPeakVol', 'valUpperTopPeakVol', 'px', v => upperTopPeakVol = v);
        bind('rngPhiltrumRound', 'valPhiltrumRound', 'px', v => philtrumRound = v);
        bind('rngPhiltrumDepth', 'valPhiltrumDepth', 'px', v => philtrumDepth = v);
        bind('rngPhiltrumWidth', 'valPhiltrumWidth', 'px', v => philtrumWidth = v);
        bind('rngUpperHeight', 'valUpperHeight', '%', v => upperHeight = v);

        // 2. 윗입술 하부 바인딩
        bind('rngUpperBottomFullRound', 'valUpperBottomFullRound', 'px', v => upperBottomFullRound = v);
        bind('rngUpperBottomY', 'valUpperBottomY', 'px', v => upperBottomY = v);
        bind('rngUpperBottomCenterVol', 'valUpperBottomCenterVol', 'px', v => upperBottomCenterVol = v);
        bind('rngUpperBottomRound', 'valUpperBottomRound', 'px', v => upperBottomRound = v);
        bind('rngUpperBottomSideVol', 'valUpperBottomSideVol', 'px', v => upperBottomSideVol = v);

        // 3. 아랫입술 상부 바인딩
        bind('rngLowerTopY', 'valLowerTopY', 'px', v => lowerTopY = v);
        bind('rngLowerTopCenterVol', 'valLowerTopCenterVol', 'px', v => lowerTopCenterVol = v);
        bind('rngLowerTopRound', 'valLowerTopRound', 'px', v => lowerTopRound = v);
        bind('rngLowerTopSideVol', 'valLowerTopSideVol', 'px', v => lowerTopSideVol = v);

        // 4. 아랫입술 하부 바인딩
        bind('rngLowerBottomOver', 'valLowerBottomOver', 'px', v => lowerBottomOver = v);
        bind('rngLowerBottomCenterVol', 'valLowerBottomCenterVol', 'px', v => lowerBottomCenterVol = v);
        bind('rngLowerBottomRound', 'valLowerBottomRound', 'px', v => lowerBottomRound = v);
        bind('rngLowerHeight', 'valLowerHeight', '%', v => lowerHeight = v);

        // 🔗 연동 체크박스 상호 동기화 및 이벤트 바인딩
        function syncAndBindCheckbox(id1, id2, onValChange) {
            const el1 = document.getElementById(id1);
            const el2 = document.getElementById(id2);
            if (el1) {
                el1.addEventListener('change', function() {
                    if (el2) el2.checked = this.checked;
                    onValChange(this.checked);
                });
            }
            if (el2) {
                el2.addEventListener('change', function() {
                    if (el1) el1.checked = this.checked;
                    onValChange(this.checked);
                });
            }
        }
        syncAndBindCheckbox('chkLinkLR', 'chkLinkLR_Lower', v => linkLR = v);
        syncAndBindCheckbox('chkLinkUpDown', 'chkLinkUpDown_Lower', v => linkUpDown = v);

        // 💋 윗입술 입꼬리 상하 조절 바인딩
        bind('rngUpperLeftCorner', 'valUpperLeftCorner', 'px', v => {
            upperLeftCornerY = v;
            if (linkLR) upperRightCornerY = v;
            if (linkUpDown) {
                lowerLeftCornerY = v;
                if (linkLR) lowerRightCornerY = v;
            }
            syncSliders();
        });
        bind('rngUpperRightCorner', 'valUpperRightCorner', 'px', v => {
            upperRightCornerY = v;
            if (linkLR) upperLeftCornerY = v;
            if (linkUpDown) {
                lowerRightCornerY = v;
                if (linkLR) lowerLeftCornerY = v;
            }
            syncSliders();
        });

        // 🌓 아랫입술 입꼬리 상하 조절 바인딩
        bind('rngLowerLeftCorner', 'valLowerLeftCorner', 'px', v => {
            lowerLeftCornerY = v;
            if (linkLR) lowerRightCornerY = v;
            if (linkUpDown) {
                upperLeftCornerY = v;
                if (linkLR) upperRightCornerY = v;
            }
            syncSliders();
        });
        bind('rngLowerRightCorner', 'valLowerRightCorner', 'px', v => {
            lowerRightCornerY = v;
            if (linkLR) lowerLeftCornerY = v;
            if (linkUpDown) {
                upperRightCornerY = v;
                if (linkLR) upperLeftCornerY = v;
            }
            syncSliders();
        });

        // ◀️▶️ 윗입술 좌우 볼륨 바인딩
        bind('rngUpperLeftVol', 'valUpperLeftVol', 'px', v => {
            upperLeftVolume = v;
            if (linkLR) upperRightVolume = v;
            if (linkUpDown) {
                lowerLeftVolume = v;
                if (linkLR) lowerRightVolume = v;
            }
            syncSliders();
        });
        bind('rngUpperRightVol', 'valUpperRightVol', 'px', v => {
            upperRightVolume = v;
            if (linkLR) upperLeftVolume = v;
            if (linkUpDown) {
                lowerRightVolume = v;
                if (linkLR) lowerLeftVolume = v;
            }
            syncSliders();
        });

        // ◀️▶️ 아랫입술 좌우 볼륨 바인딩
        bind('rngLowerLeftVol', 'valLowerLeftVol', 'px', v => {
            lowerLeftVolume = v;
            if (linkLR) lowerRightVolume = v;
            if (linkUpDown) {
                upperLeftVolume = v;
                if (linkLR) upperRightVolume = v;
            }
            syncSliders();
        });
        bind('rngLowerRightVol', 'valLowerRightVol', 'px', v => {
            lowerRightVolume = v;
            if (linkLR) lowerLeftVolume = v;
            if (linkUpDown) {
                upperRightVolume = v;
                if (linkLR) upperLeftVolume = v;
            }
            syncSliders();
        });

        const btnSymUpper = document.getElementById('btnQuickSymmetry');
        if (btnSymUpper) btnSymUpper.addEventListener('click', () => applyPreset('symmetry'));
        const btnSymLower = document.getElementById('btnQuickSymmetry_Lower');
        if (btnSymLower) btnSymLower.addEventListener('click', () => applyPreset('symmetry'));

        // 🎛️ 라인 & 렌더 옵션 3분할 세그먼트 버튼 바인딩
        const btnToggleDesignLine = document.getElementById('btnToggleDesignLine');
        if (btnToggleDesignLine) {
            btnToggleDesignLine.addEventListener('click', function() {
                showDesignLine = !showDesignLine;
                this.classList.toggle('active', showDesignLine);
                this.innerHTML = showDesignLine ? '🟡 시술선 (ON)' : '⚪ 시술선 (OFF)';
                requestRender();
            });
        }

        const btnToggleFillTint = document.getElementById('btnToggleFillTint');
        if (btnToggleFillTint) {
            btnToggleFillTint.addEventListener('click', function() {
                fillTint = !fillTint;
                this.classList.toggle('active', fillTint);
                this.classList.toggle('tint-active', fillTint);
                this.innerHTML = fillTint ? '💄 틴트 채움 (ON)' : '💄 틴트 채움 (OFF)';
                requestRender();
            });
        }

        const btnCycleLineWidth = document.getElementById('btnCycleLineWidth');
        if (btnCycleLineWidth) {
            btnCycleLineWidth.addEventListener('click', function() {
                lineWidth = (lineWidth % 5) + 1;
                this.innerHTML = '📏 선 굵기: ' + lineWidth + 'px';
                requestRender();
            });
        }

        // 컬러 & 기법
        document.querySelectorAll('.tech-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.tech-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                currentTech = this.getAttribute('data-tech');
                if (currentTech === 'full_lip') blurVal = 0.5;
                else if (currentTech === 'gradient_lip') blurVal = 6.0;
                else if (currentTech === 'water_color') blurVal = 4.5;
                else if (currentTech === 'velvet_lip') blurVal = 2.0;
                else blurVal = 3.5;
                syncSliders();
                requestRender();
            });
        });
        document.querySelectorAll('.color-chip').forEach(chip => {
            chip.addEventListener('click', function() {
                document.querySelectorAll('.color-chip').forEach(c => c.classList.remove('active'));
                this.classList.add('active');
                currentColor = this.getAttribute('data-color');
                document.getElementById('customColorPicker').value = currentColor;
                requestRender();
            });
        });
        document.getElementById('customColorPicker').addEventListener('input', function() {
            currentColor = this.value;
            requestRender();
        });

        bind('rngDensity', 'valDensity', '%', v => density = v);
        bind('rngOpacity', 'valOpacity', '%', v => opacity = v);
        bind('rngBlur', 'valBlur', 'px', v => blurVal = v);

        // JSON 및 복원 액션
        /** 되돌리기·다시실행이 공통으로 쓰는 '한 장 되돌려 놓기' */
        function applyLipState(prev) {
            globalOffsetX = prev.globalOffsetX;
            globalOffsetY = prev.globalOffsetY;
            globalWidth = prev.globalWidth || 100;
            upperOffsetX = prev.upperOffsetX || 0;
            upperOffsetY = prev.upperOffsetY || 0;
            upperWidth = prev.upperWidth || 100;
            lowerOffsetX = prev.lowerOffsetX || 0;
            lowerOffsetY = prev.lowerOffsetY || 0;
            lowerWidth = prev.lowerWidth || 100;

            upperTopOver = prev.upperTopOver || 0;
            upperTopPeakVol = prev.upperTopPeakVol || 0;
            philtrumRound = prev.philtrumRound || 0;
            philtrumDepth = prev.philtrumDepth || 0;
            philtrumWidth = prev.philtrumWidth || 0;
            upperHeight = prev.upperHeight || 100;

            upperBottomFullRound = prev.upperBottomFullRound || 0;
            upperBottomY = prev.upperBottomY || 0;
            upperBottomCenterVol = prev.upperBottomCenterVol || 0;
            upperBottomRound = prev.upperBottomRound || 0;
            upperBottomSideVol = prev.upperBottomSideVol || 0;

            lowerTopY = prev.lowerTopY || 0;
            lowerTopCenterVol = prev.lowerTopCenterVol || 0;
            lowerTopRound = prev.lowerTopRound || 0;
            lowerTopSideVol = prev.lowerTopSideVol || 0;

            lowerBottomOver = prev.lowerBottomOver || 0;
            lowerBottomCenterVol = prev.lowerBottomCenterVol || 0;
            lowerBottomRound = prev.lowerBottomRound || 0;
            lowerHeight = prev.lowerHeight || 100;

            upperLeftCornerY = prev.upperLeftCornerY || 0;
            upperRightCornerY = prev.upperRightCornerY || 0;
            lowerLeftCornerY = prev.lowerLeftCornerY || 0;
            lowerRightCornerY = prev.lowerRightCornerY || 0;
            upperLeftVolume = prev.upperLeftVolume !== undefined ? prev.upperLeftVolume : (prev.leftVolume || 0);
            upperRightVolume = prev.upperRightVolume !== undefined ? prev.upperRightVolume : (prev.rightVolume || 0);
            lowerLeftVolume = prev.lowerLeftVolume !== undefined ? prev.lowerLeftVolume : (prev.leftVolume || 0);
            lowerRightVolume = prev.lowerRightVolume !== undefined ? prev.lowerRightVolume : (prev.rightVolume || 0);
            cornerSharpL = prev.cornerSharpL || 0;
            cornerSharpR = prev.cornerSharpR || 0;
            cornerOverU = prev.cornerOverU || 0;
            cornerOverL = prev.cornerOverL || 0;
            blurVal = prev.blurVal !== undefined ? prev.blurVal : 3.5;
            density = prev.density !== undefined ? prev.density : 100;
            gloss = prev.gloss !== undefined ? prev.gloss : 35;

            syncSliders();
            requestRender();
        }

        // 다시실행용. 되돌린 것을 다시 앞으로 돌린다.
        // 새 작업이 생기면(pushUndo) 여기 쌓인 것은 의미가 없어져 비운다.
        let redoStack = [];

        function lipUndo() {
            if (undoStack.length === 0) {
                showToast('⚠️ 실행 취소할 내역이 없습니다.');
                return;
            }
            redoStack.push(snapshotState());
            applyLipState(undoStack.pop());
            showToast('↩️ 이전 위치 및 디자인으로 되돌렸습니다.');
        }

        function lipRedo() {
            if (redoStack.length === 0) {
                showToast('⚠️ 다시 실행할 내역이 없습니다.');
                return;
            }
            undoStack.push(snapshotState());
            applyLipState(redoStack.pop());
            showToast('↪️ 되돌리기 전으로 다시 실행했습니다.');
        }

        document.getElementById('btnUndoContour').addEventListener('click', lipUndo);

        // 모바일 레이어가 '다시실행' 버튼을 만들어 이걸 부른다.
        // 입술 원본 화면에는 그 버튼이 없어 여기서 문을 열어 준다.
        window.__blLipRedo = lipRedo;

        // ── 입꼬리 뾰족하게 ────────────────────────────────────────────────
        // 입꼬리는 윗입술·아랫입술이 만나는 한 점이라 값이 하나여야 한다.
        // 그래서 두 카드에 같은 조절바를 두고 서로 값을 맞춰 준다.
        // var 로 두는 이유: syncSliders() 가 이 줄보다 먼저 불릴 수 있다.
        // const 였다면 아직 값이 없는 구간(TDZ)에서 참조해 오류가 난다.
        var SHARP_PAIRS = [
            { ids: ['rngSharpL', 'rngSharpL2'], vals: ['valSharpL', 'valSharpL2'], get: () => cornerSharpL,
              set: (v) => { cornerSharpL = v; } },
            { ids: ['rngSharpR', 'rngSharpR2'], vals: ['valSharpR', 'valSharpR2'], get: () => cornerSharpR,
              set: (v) => { cornerSharpR = v; } }
        ];

        function syncSharpSliders() {
            if (!SHARP_PAIRS) return;      // 아직 만들어지기 전에 불린 경우
            SHARP_PAIRS.forEach((pair) => {
                const v = pair.get();
                pair.ids.forEach((id) => {
                    const el = document.getElementById(id);
                    if (el) el.value = v;
                });
                pair.vals.forEach((id) => {
                    const el = document.getElementById(id);
                    if (el) el.textContent = Math.round(v) + 'px';
                });
            });
        }

        SHARP_PAIRS.forEach((pair) => {
            pair.ids.forEach((id) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.oninput = function () {
                    pair.set(parseFloat(this.value));
                    syncSharpSliders();
                    requestRender();
                };
            });
        });
        syncSharpSliders();

        document.getElementById('btnResetContour').addEventListener('click', () => applyPreset('default'));

        // ── 조절바 조작도 되돌리기에 남긴다 ──────────────────────────────
        // 원래는 캔버스를 손으로 끌었을 때만 기록해서, 조절바로 바꾼 값은
        // 되돌리기를 눌러도 "실행 취소할 내역이 없습니다" 만 떴다.
        // 잡기 시작할 때 상태를 떠 두고, 놓을 때 값이 달라졌으면 그때 남긴다.
        (function bindSliderUndo() {
            let beforeDrag = null;

            function onDown() {
                if (!beforeDrag) beforeDrag = snapshotState();
            }
            function onUp() {
                if (!beforeDrag) return;
                const prev = beforeDrag;
                beforeDrag = null;
                if (JSON.stringify(prev) !== JSON.stringify(snapshotState())) pushUndo(prev);
            }

            document.querySelectorAll('.control-panel input[type="range"]').forEach(function (el) {
                el.addEventListener('pointerdown', onDown);
                el.addEventListener('touchstart', onDown, { passive: true });
                el.addEventListener('keydown', onDown);      // 키보드 미세 조정
            });
            window.addEventListener('pointerup', onUp);
            window.addEventListener('touchend', onUp);
            window.addEventListener('keyup', onUp);
        })();

        const elBtnDownloadJson = document.getElementById('btnDownloadJson');
        if (elBtnDownloadJson) elBtnDownloadJson.addEventListener('click', function() {
            const { closedUpperLoop, closedLowerLoop } = getTransformedCurves();
            const data = {
                version: "2.5",
                image: { filename: "customer_001.jpg", width: canvas.width, height: canvas.height },
                lip_design: {
                    global_offset_x: globalOffsetX, global_offset_y: globalOffsetY,
                    global_width: globalWidth,
                    color_simulation: {
                        color: currentColor,
                        technique: currentTech,
                        density: density,
                        gloss: gloss,
                        edge_blur: blurVal
                    },
                    upper_lip: {
                        offset_x: upperOffsetX, offset_y: upperOffsetY,
                        width: upperWidth,
                        top_border: {
                            over_lip: upperTopOver, peak_volume: upperTopPeakVol,
                            philtrum_roundness: philtrumRound, philtrum_depth: philtrumDepth, philtrum_width: philtrumWidth,
                            height_scale: upperHeight
                        },
                        bottom_border: {
                            full_roundness: upperBottomFullRound,
                            y_shift: upperBottomY, tuberculum_volume: upperBottomCenterVol,
                            roundness: upperBottomRound, side_volume: upperBottomSideVol
                        },
                        corners: {
                            left_corner: upperLeftCornerY, right_corner: upperRightCornerY
                        },
                        volume_balance: {
                            left: upperLeftVolume, right: upperRightVolume
                        },
                        points: closedUpperLoop
                    },
                    lower_lip: {
                        offset_x: lowerOffsetX, offset_y: lowerOffsetY,
                        width: lowerWidth,
                        top_border: {
                            y_shift: lowerTopY, center_volume: lowerTopCenterVol,
                            roundness: lowerTopRound, side_volume: lowerTopSideVol
                        },
                        bottom_border: {
                            over_lip: lowerBottomOver, center_volume: lowerBottomCenterVol,
                            roundness: lowerBottomRound, height_scale: lowerHeight
                        },
                        corners: {
                            left_corner: lowerLeftCornerY, right_corner: lowerRightCornerY
                        },
                        volume_balance: {
                            left: lowerLeftVolume, right: lowerRightVolume
                        },
                        points: closedLowerLoop
                    },
                    asymmetry: {
                        upper_left_corner: upperLeftCornerY, upper_right_corner: upperRightCornerY,
                        lower_left_corner: lowerLeftCornerY, lower_right_corner: lowerRightCornerY,
                        upper_left_volume: upperLeftVolume, upper_right_volume: upperRightVolume,
                        lower_left_volume: lowerLeftVolume, lower_right_volume: lowerRightVolume
                    }
                },
                upper_contour: closedUpperLoop,
                lower_contour: closedLowerLoop
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `lip_design_v2_5_${Date.now()}.json`;
            link.click();
            showToast('📥 윗/아랫입술 볼륨 독립 v2.5 JSON 다운로드 완료');
        });

        const elBtnCopyJson = document.getElementById('btnCopyJson');
        if (elBtnCopyJson) elBtnCopyJson.addEventListener('click', function() {
            const { closedUpperLoop, closedLowerLoop } = getTransformedCurves();
            const data = {
                version: "2.5",
                lip_design: {
                    global_offset_x: globalOffsetX, global_offset_y: globalOffsetY,
                    global_width: globalWidth,
                    color_simulation: {
                        color: currentColor,
                        technique: currentTech,
                        density: density,
                        gloss: gloss,
                        edge_blur: blurVal
                    },
                    upper_lip: {
                        offset_x: upperOffsetX, offset_y: upperOffsetY,
                        width: upperWidth,
                        top_border: {
                            over_lip: upperTopOver, peak_volume: upperTopPeakVol,
                            philtrum_roundness: philtrumRound, philtrum_depth: philtrumDepth, philtrum_width: philtrumWidth,
                            height_scale: upperHeight
                        },
                        bottom_border: {
                            full_roundness: upperBottomFullRound,
                            y_shift: upperBottomY, tuberculum_volume: upperBottomCenterVol,
                            roundness: upperBottomRound, side_volume: upperBottomSideVol
                        },
                        corners: {
                            left_corner: upperLeftCornerY, right_corner: upperRightCornerY
                        },
                        volume_balance: {
                            left: upperLeftVolume, right: upperRightVolume
                        },
                        points: closedUpperLoop
                    },
                    lower_lip: {
                        offset_x: lowerOffsetX, offset_y: lowerOffsetY,
                        width: lowerWidth,
                        top_border: {
                            y_shift: lowerTopY, center_volume: lowerTopCenterVol,
                            roundness: lowerTopRound, side_volume: lowerTopSideVol
                        },
                        bottom_border: {
                            over_lip: lowerBottomOver, center_volume: lowerBottomCenterVol,
                            roundness: lowerBottomRound, height_scale: lowerHeight
                        },
                        corners: {
                            left_corner: lowerLeftCornerY, right_corner: lowerRightCornerY
                        },
                        volume_balance: {
                            left: lowerLeftVolume, right: lowerRightVolume
                        },
                        points: closedLowerLoop
                    },
                    asymmetry: {
                        upper_left_corner: upperLeftCornerY, upper_right_corner: upperRightCornerY,
                        lower_left_corner: lowerLeftCornerY, lower_right_corner: lowerRightCornerY,
                        upper_left_volume: upperLeftVolume, upper_right_volume: upperRightVolume,
                        lower_left_volume: lowerLeftVolume, lower_right_volume: lowerRightVolume
                    }
                },
                upper_contour: closedUpperLoop,
                lower_contour: closedLowerLoop
            };
            navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => {
                showToast('📋 윗/아랫입술 볼륨 독립 v2.5 JSON 복사 완료');
            });
        });

        // ====================================================================
        // 📜 12개 이상 무제한 누적 보관 글로벌 캐시 & 스토리지 엔진 (Lip Studio)
        // ====================================================================
        const STORAGE_KEY = 'lip_preview_studio_history_v3';

        function getGlobalMemoryCache() {
            try {
                if (window.parent && !window.parent.__lipHistoryGlobalCache) {
                    window.parent.__lipHistoryGlobalCache = [];
                }
                if (window.parent && Array.isArray(window.parent.__lipHistoryGlobalCache)) {
                    return window.parent.__lipHistoryGlobalCache;
                }
            } catch(e) {}
            if (!window.__lipHistoryGlobalCache) {
                window.__lipHistoryGlobalCache = [];
            }
            return window.__lipHistoryGlobalCache;
        }

        function syncGlobalMemoryCache(items) {
            try {
                if (window.parent) {
                    window.parent.__lipHistoryGlobalCache = items;
                }
            } catch(e) {}
            window.__lipHistoryGlobalCache = items;
        }

        function loadHistoryFromStorage() {
            const mem = getGlobalMemoryCache();
            if (mem && mem.length > 0) return mem;

            try {
                const raw = sessionStorage.getItem(STORAGE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        syncGlobalMemoryCache(parsed);
                        return parsed;
                    }
                }
            } catch(e) {}
            return [];
        }

        function saveHistoryToStorage() {
            syncGlobalMemoryCache(historyItems);

            try {
                const lightItems = historyItems.slice(0, MAX_HISTORY_ITEMS).map(item => ({
                    id: item.id,
                    type: item.type,
                    tagText: item.tagText,
                    designName: item.designName,
                    thumbUrl: item.thumbUrl || item.dataUrl,
                    dataUrl: item.dataUrl,
                    color: item.color,
                    upperOver: item.upperOver,
                    lowerOver: item.lowerOver,
                    filename: item.filename,
                    timeStr: item.timeStr
                }));
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify(lightItems));
            } catch(e) {
                try {
                    const ultraLight = historyItems.slice(0, MAX_HISTORY_ITEMS).map(item => ({
                        id: item.id,
                        type: item.type,
                        tagText: item.tagText,
                        designName: item.designName,
                        dataUrl: item.thumbUrl || item.dataUrl,
                        color: item.color,
                        upperOver: item.upperOver,
                        lowerOver: item.lowerOver,
                        filename: item.filename,
                        timeStr: item.timeStr
                    }));
                    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ultraLight));
                } catch(err) {
                    console.warn('Storage quota reached; keeping items in global memory cache.');
                }
            }
        }

        const historyItems = loadHistoryFromStorage();
        let currentModalItem = null;

        function getDownloadFilename(prefix) {
            const now = new Date();
            const pad = function(n) { return String(n).padStart(2, '0'); };
            const dStr = now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate()) + '_' + 
                         pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
            return prefix + '_' + dStr + '.png';
        }

        function createOptimizedThumbnail(sourceCanvas, maxDim) {
            try {
                const tCanvas = document.createElement('canvas');
                const sw = sourceCanvas.width;
                const sh = sourceCanvas.height;
                const scale = Math.min(1.0, (maxDim || 900) / Math.max(sw, sh));
                tCanvas.width = Math.round(sw * scale);
                tCanvas.height = Math.round(sh * scale);
                const tCtx = tCanvas.getContext('2d');
                tCtx.drawImage(sourceCanvas, 0, 0, tCanvas.width, tCanvas.height);
                return tCanvas.toDataURL('image/jpeg', 0.85);
            } catch(e) {
                return null;
            }
        }

        function renderWatermark(ctx, width, startY, height) {
            const line1 = '⚠️ [시술 상담 안내] 본 이미지는 디자인 상담을 위한 가상 시뮬레이션이며';
            const line2 = '실제 시술 후 모양, 색상 및 결과와 차이가 있을 수 있습니다.';

            ctx.fillStyle = '#181614';
            ctx.fillRect(0, startY, width, height);

            ctx.fillStyle = '#D4AF37';
            ctx.fillRect(0, startY, width, 2);

            let fontSize = Math.max(12, Math.min(22, Math.round(width * 0.028)));
            ctx.font = '600 ' + fontSize + 'px Pretendard, "Malgun Gothic", sans-serif';

            while ((ctx.measureText(line1).width > (width - 24) || ctx.measureText(line2).width > (width - 24)) && fontSize > 9) {
                fontSize--;
                ctx.font = '600 ' + fontSize + 'px Pretendard, "Malgun Gothic", sans-serif';
            }

            ctx.fillStyle = '#E8D8C8';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const centerY = startY + (height / 2);
            const lineGap = fontSize * 1.35;
            ctx.fillText(line1, width / 2, centerY - (lineGap * 0.48));
            ctx.fillText(line2, width / 2, centerY + (lineGap * 0.52));
        }

        function notifyHeight() {
            try {
                const h = document.documentElement.scrollHeight || document.body.scrollHeight;
                window.parent.postMessage({ type: 'streamlit:setFrameHeight', height: h + 40 }, '*');
                if (window.frameElement) {
                    window.frameElement.style.height = (h + 40) + 'px';
                }
            } catch(e) {}
        }

        window.addEventListener('resize', notifyHeight);
        setTimeout(notifyHeight, 200);
        setTimeout(notifyHeight, 600);
        setTimeout(notifyHeight, 1200);

        function addHistoryItem(highResDataUrl, fileName, thumbDataUrl) {
            const now = new Date();
            const pad = function(n) { return String(n).padStart(2, '0'); };
            const timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
            
            const TECH_MAP = {
                'natural': '내추럴 틴트립',
                'ombre': '그라데이션 옴브레',
                'full': '풀 립 블렌딩',
                'contour': '입술라인 윤곽교정'
            };
            const techName = TECH_MAP[currentTech] || currentTech || '맞춤 립 디자인';

            // 비교 화면의 이름표는 '고른 색 이름' 으로 단다. 상담할 때 원장님과
            // 고객이 서로 가리키는 말이 색 이름이기 때문이다.
            // 색상표에 없는 직접 고른 색이면 색값을 그대로 쓴다.
            let colorLabel = currentColor;
            try {
                const chips = document.querySelectorAll('.color-chip[data-color]');
                for (let i = 0; i < chips.length; i++) {
                    const c = chips[i].getAttribute('data-color') || '';
                    if (c.toLowerCase() === String(currentColor).toLowerCase()) {
                        colorLabel = chips[i].textContent.trim();
                        break;
                    }
                }
            } catch (e) { /* 이름을 못 찾으면 색값을 쓴다 */ }

            const item = {
                id: 'lip_hist_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                type: 'lip_preview',
                tagText: techName,
                designName: `${techName} (${currentColor})`,
                color: currentColor,
                upperOver: upperTopOver,
                lowerOver: lowerBottomOver,
                dataUrl: highResDataUrl,
                thumbUrl: thumbDataUrl || highResDataUrl,
                filename: fileName || getDownloadFilename('lip_preview'),
                timeStr: timeStr,
                compareLabel: colorLabel,
                // 안내문구 배너를 뺀 '그림만' 의 가로/세로 비 (비교 보기에서 잘라낸다)
                aspect: canvas.width / Math.max(1, canvas.height)
            };

            historyItems.unshift(item);
            if (historyItems.length > MAX_HISTORY_ITEMS) {
                historyItems.pop();
            }

            saveHistoryToStorage();
            renderHistoryCards();
            if (window.__blHistory && window.__blHistory.onChange) window.__blHistory.onChange();
            showToast('📸 상담 히스토리에 2열 카드로 보관되었습니다.');
        }

        /* 모바일 레이어(mobile-ui.js)가 '비교 보기'와 '전체 저장'에 쓰도록
           히스토리를 넘겨준다. 히스토리 자체는 여기서만 관리한다. */
        window.__blHistory = {
            items: function () { return historyItems.slice(); },
            download: function (item) { downloadHistoryItem(item); },
            // 비교의 '시술 전' 은 언제나 처음 불러온 맨얼굴이다.
            // bg_b64 는 눈썹 작업이 얹힌 사진일 수 있다.
            photo: function () { return CFG.orig_b64 || CFG.bg_b64; },
            onChange: null            // 항목이 바뀌면 모바일 레이어가 받는다
        };

        function downloadHistoryItem(item) {
            if (!item) return;
            const src = item.dataUrl || item.thumbUrl;
            if (!src) return;
            const fileName = item.filename || getDownloadFilename('lip_preview');
            
            // 1. Try Blob download
            try {
                const parts = src.split(',');
                if (parts.length === 2) {
                    const mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/png';
                    const bstr = atob(parts[1]);
                    let n = bstr.length;
                    const u8arr = new Uint8Array(n);
                    while (n--) {
                        u8arr[n] = bstr.charCodeAt(n);
                    }
                    const blob = new Blob([u8arr], { type: mime });
                    const blobUrl = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.style.display = 'none';
                    link.href = blobUrl;
                    link.download = fileName;
                    document.body.appendChild(link);
                    link.click();
                    setTimeout(() => {
                        try {
                            document.body.removeChild(link);
                            URL.revokeObjectURL(blobUrl);
                        } catch(e) {}
                    }, 2500);
                    showToast('✅ 이미지가 다운로드되었습니다!');
                    return;
                }
            } catch(e) {}

            // 2. Direct data URL link download
            try {
                const link = document.createElement('a');
                link.download = fileName;
                link.href = src;
                document.body.appendChild(link);
                link.click();
                setTimeout(() => {
                    try { document.body.removeChild(link); } catch(e) {}
                }, 1000);
                showToast('✅ 이미지가 다운로드되었습니다!');
            } catch(err) {
                window.open(src, '_blank');
            }
        }

        function renderHistoryCards() {
            const historyList = document.getElementById('historyList');
            const historyCount = document.getElementById('historyCount');
            if (!historyList || !historyCount) return;

            historyCount.innerText = historyItems.length + '개 저장됨';

            if (historyItems.length === 0) {
                historyList.innerHTML = `
                    <div class="history-empty" id="historyEmpty">
                        <span>✨ [립 결과 다운로드] 버튼을 누르면 이곳에 1행 2열 큰 카드 형태로 최대 16개 이상 결과물이 자동 누적 보관됩니다. (클릭 시 확대 및 재다운로드 가능)</span>
                    </div>
                `;
                notifyHeight();
                return;
            }

            historyList.innerHTML = '';
            historyItems.forEach((item, idx) => {
                const card = document.createElement('div');
                card.className = 'history-card';

                // 1. 세로로 꽉 차는 큰 썸네일 래퍼 (검은 음영 제로)
                const thumbWrap = document.createElement('div');
                thumbWrap.className = 'history-card-thumb-wrap';
                thumbWrap.innerHTML = `
                    <img src="${item.thumbUrl || item.dataUrl}" class="history-card-thumb" loading="lazy" decoding="async" alt="${item.designName || item.tagText}">
                    <div class="history-card-overlay-btn">🔍 클릭하여 고화질 원본 크게 보기</div>
                `;
                thumbWrap.onclick = function(e) {
                    openHistoryModal(item, this);
                };
                card.appendChild(thumbWrap);

                // 2. 카드 정보 바 (선택된 디자인 이름 & 컬러 & 오버립 수치)
                const infoDiv = document.createElement('div');
                infoDiv.className = 'history-card-info';
                infoDiv.innerHTML = `
                    <span class="history-card-tag" style="background:${item.color || '#E25B6F'}22; border-color:${item.color || '#E25B6F'}; color:#FFF;">💋 ${item.designName || item.tagText}</span>
                    <span class="history-card-time">🕒 ${item.timeStr} <strong style="color:#D4AF37; margin-left:4px;">#${historyItems.length - idx}</strong></span>
                `;
                card.appendChild(infoDiv);

                // 3. 카드 하단 액션 버튼 (팝업 확대 / 다운로드)
                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'history-card-actions';

                const btnView = document.createElement('button');
                btnView.type = 'button';
                btnView.className = 'btn-card-action btn-card-view';
                btnView.innerHTML = '🔍 크게 보기';
                btnView.onclick = function(e) {
                    e.stopPropagation();
                    openHistoryModal(item, this);
                };

                const btnDownload = document.createElement('button');
                btnDownload.type = 'button';
                btnDownload.className = 'btn-card-action btn-card-download';
                btnDownload.innerHTML = '📥 다운로드';
                btnDownload.onclick = function(e) {
                    e.stopPropagation();
                    downloadHistoryItem(item);
                };

                actionsDiv.appendChild(btnView);
                actionsDiv.appendChild(btnDownload);
                card.appendChild(actionsDiv);

                historyList.appendChild(card);
            });

            notifyHeight();
        }

        function openHistoryModal(item, triggerElem) {
            currentModalItem = item;
            const modal = document.getElementById('historyModal');
            const modalImg = document.getElementById('modalImg');
            const modalTitle = document.getElementById('modalTitle');
            const modalContent = modal ? modal.querySelector('.history-modal-content') : null;
            if (!modal || !modalImg || !modalTitle) return;

            modalImg.src = item.dataUrl || item.thumbUrl;
            modalTitle.innerHTML = '💋 ' + (item.designName || item.tagText) + 
                                   ' <span style="font-size:0.85rem; color:#A89F91; font-weight:normal; margin-left:8px;">(🕒 ' + item.timeStr + ' / 오버립: 상+' + (item.upperOver||0) + 'px | 하+' + (item.lowerOver||0) + 'px)</span>';
            
            let targetTop = 0;
            if (triggerElem) {
                const rect = triggerElem.getBoundingClientRect();
                targetTop = (window.pageYOffset || document.documentElement.scrollTop || 0) + rect.top - 80;
            } else {
                targetTop = window.pageYOffset || document.documentElement.scrollTop || 0;
            }
            targetTop = Math.max(20, targetTop);

            const fullHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 2500);
            modal.style.height = fullHeight + 'px';
            modal.style.display = 'flex';
            modal.classList.add('active');

            if (modalContent) {
                modalContent.style.marginTop = targetTop + 'px';
                setTimeout(() => {
                    modalContent.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 20);
            }
        }

        function closeHistoryModal() {
            const modal = document.getElementById('historyModal');
            if (modal) {
                modal.style.display = 'none';
                modal.classList.remove('active');
            }
            currentModalItem = null;
        }

        document.getElementById('btnCloseModal').onclick = closeHistoryModal;
        document.getElementById('btnModalClose').onclick = closeHistoryModal;
        document.getElementById('modalOverlay').onclick = closeHistoryModal;
        window.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeHistoryModal();
        });

        document.getElementById('btnModalDownload').onclick = function() {
            if (currentModalItem) {
                downloadHistoryItem(currentModalItem);
            }
        };

        const btnLipModalOpenTab = document.getElementById('btnModalOpenTab');
        if (btnLipModalOpenTab) {
            btnLipModalOpenTab.onclick = function() {
                if (currentModalItem && (currentModalItem.dataUrl || currentModalItem.thumbUrl)) {
                    const w = window.open('', '_blank');
                    if (w) {
                        const imgSrc = currentModalItem.dataUrl || currentModalItem.thumbUrl;
                        w.document.write('<!DOCTYPE html><html><head><title>Lip Preview Studio - ' + (currentModalItem.tagText || '결과물') + '</title><style>body{margin:0;background:#111;display:flex;justify-content:center;align-items:center;min-height:100vh;}img{max-width:100%;height:auto;box-shadow:0 0 30px rgba(0,0,0,0.8);}</style></head><body><img src="' + imgSrc + '"></body></html>');
                        w.document.close();
                    } else {
                        window.open(currentModalItem.dataUrl || currentModalItem.thumbUrl, '_blank');
                    }
                }
            };
        }

        document.getElementById('btnClearHistory').onclick = function() {
            if (historyItems.length === 0) return;
            if (confirm('저장된 립 디자인 히스토리 내역을 모두 비우시겠습니까?')) {
                historyItems.length = 0;
                syncGlobalMemoryCache([]);
                try {
                    sessionStorage.removeItem(STORAGE_KEY);
                } catch(e) {}
                renderHistoryCards();
            }
        };



        // 💾 다운로드 & 히스토리 저장 액션
        function exportAndSaveLip(isDownloadOnly = false) {
            const exportCanvas = document.createElement('canvas');
            const w = canvas.width;
            const h = canvas.height;
            const footerH = Math.max(56, Math.round(h * 0.075));
            exportCanvas.width = w;
            exportCanvas.height = h + footerH;
            const eCtx = exportCanvas.getContext('2d');

            eCtx.fillStyle = '#181614';
            eCtx.fillRect(0, 0, w, h + footerH);
            eCtx.drawImage(canvas, 0, 0, w, h);
            renderWatermark(eCtx, w, h, footerH);

            const fileName = getDownloadFilename('lip_preview');
            const highResDataUrl = exportCanvas.toDataURL('image/png', 1.0);
            const thumbDataUrl = createOptimizedThumbnail(exportCanvas, 720);
                // 히스토리에는 JPEG 으로 담는다. PNG 원본은 한 장에 2.5MB 라
                // 여러 장 쌓이면 그것만으로 수십 MB 다. 내려받는 파일은 PNG 그대로다.
            const histDataUrl = exportCanvas.toDataURL('image/jpeg', 0.92);
            const histFileName = fileName.split('.png').join('.jpg');

            if (isDownloadOnly) {
                const link = document.createElement('a');
                link.download = fileName;
                link.href = highResDataUrl;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            }

            addHistoryItem(histDataUrl, histFileName, thumbDataUrl);
            exportCanvas.width = 0; exportCanvas.height = 0;   // 큰 캔버스 즉시 반납
        }

        const btnDownloadAfter = document.getElementById('btnDownloadAfter');
        if (btnDownloadAfter) {
            btnDownloadAfter.onclick = function() {
                exportAndSaveLip(true);
            };
        }

        function notifyHeight() {
            try {
                const h = document.documentElement.scrollHeight || document.body.scrollHeight;
                window.parent.postMessage({ type: 'streamlit:setFrameHeight', height: h + 40 }, '*');
                if (window.frameElement) {
                    window.frameElement.style.height = (h + 40) + 'px';
                }
            } catch(e) {}
        }
        window.addEventListener('resize', notifyHeight);

        let isLipInitialized = false;
        function initLipCanvas() {
            if (bgImg.naturalWidth && bgImg.naturalHeight) {
                canvas.width = bgImg.naturalWidth;
                canvas.height = bgImg.naturalHeight;
            } else if (!canvas.width || canvas.width < 10) {
                canvas.width = CFG.img_w;
                canvas.height = CFG.img_h;
            }
            if (!isLipInitialized) {
                isLipInitialized = true;
                syncSliders();
            }
            renderCanvas();
            renderHistoryCards();
            notifyHeight();
        }

        function loadHistory() {
            renderHistoryCards();
        }

        bgImg.onload = function() {
            initLipCanvas();
            renderCanvas();
            requestRender();
        };
        bgImg.onerror = function(e) {
            console.error("Failed to load customer image into Lip Studio", e);
        };
        bgImg.src = CFG.bg_b64;
        // 이어 그릴 밑그림이 없으면 맨얼굴과 배경이 같은 사진이다.
        // 그때 두 번 풀어 두면 사진 한 장 분량(수 MB)을 괜히 더 쓴다.
        // (bgImg.onload 는 캔버스 크기를 잡는 일까지 하므로 덮어쓰면 안 된다)
        if (CFG.orig_b64 && CFG.orig_b64 !== CFG.bg_b64) {
            // 맨얼굴이 늦게 도착하면 '시술 전' 이 잠깐 배경으로 그려진다.
            // 도착하는 즉시 캐시를 비우고 다시 그려 그 틈을 없앤다.
            origImg.onload = function () {
                warpCache.key = "";
                requestRender();
            };
            origImg.src = CFG.orig_b64;
        } else {
            origImg = bgImg;
        }

        // ── 다른 부위로 넘겨줄 그림 굽기 ──────────────────────────────
        // 맨얼굴 위에 '지금 이 입술만' 얹은 한 장을 만든다. 눈썹을 편집할 때
        // 이 그림이 배경이 되어 두 시술이 한 화면에 같이 보인다.
        //
        // 사진 확대·이동은 잠시 되돌린다. 그것까지 구워 넣으면 눈썹 쪽 좌표와
        // 어긋나 두 작업이 서로 다른 자리에 놓인다.
        window.__blCapture = function () {
            const pz = curImgZoom, px = curImgPanX, py = curImgPanY;
            const pv = viewMode, pb = captureBg, pk = warpCache.key;
            try {
                if (origImg.complete && (origImg.naturalWidth || origImg.width) > 0) {
                    captureBg = origImg;
                }
                curImgZoom = 100; curImgPanX = 0; curImgPanY = 0;
                viewMode = 'after';
                warpCache.key = '';          // 배경이 바뀌었으니 부풀린 조각도 다시
                renderCanvas();
                // toDataURL 은 실패해도 예외 없이 "data:," 를 주는 기기가 있다.
                // 그대로 넘기면 2차 편집이 백지로 시작한다.
                const url = canvas.toDataURL('image/jpeg', 0.92);
                return (url && url.length > 128) ? url : null;
            } catch (e) {
                console.warn('입술 굽기 실패', e);
                return null;
            } finally {
                captureBg = pb; curImgZoom = pz; curImgPanX = px; curImgPanY = py;
                viewMode = pv; warpCache.key = '';
                renderCanvas();
            }
        };

        if (bgImg.complete && (bgImg.naturalWidth || bgImg.width) > 0) {
            initLipCanvas();
        }

        // 페이지 로드 시 즉시 초기화 실행
        initLipCanvas();
        setTimeout(initLipCanvas, 30);
        setTimeout(initLipCanvas, 120);
        setTimeout(initLipCanvas, 350);
        setTimeout(initLipCanvas, 800);
        setTimeout(notifyHeight, 200);
        setTimeout(notifyHeight, 800);
    })();
