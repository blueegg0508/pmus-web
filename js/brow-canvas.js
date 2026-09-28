(function() {
        const canvas = document.getElementById('dragCanvas');
        const ctx = canvas.getContext('2d');

        const rawLImg = new Image();
        const rawRImg = new Image();
        const bgImg = new Image();
        // 편집하지 않은 맨얼굴. '시술 전' 비교와, 다른 부위로 넘겨줄 그림을
        // 만들 때 쓴다. bg_b64 는 입술 작업이 이미 얹힌 사진일 수 있다.
        let origImg = new Image();
        /** 그리는 동안 배경을 잠시 바꿔치기할 때 쓴다 (맨얼굴로 굽기) */
        let captureBg = null;

        function onAnyImageLoaded() {
            invalidateBgFilter();
            if (bgImg.naturalWidth && bgImg.naturalHeight) {
                if (canvas.width !== bgImg.naturalWidth || canvas.height !== bgImg.naturalHeight) {
                    canvas.width = bgImg.naturalWidth;
                    canvas.height = bgImg.naturalHeight;
                }
            }
            updateFilteredBg();
            updateGuideRatios();
            requestDraw();
        }

        /**
         * 가이드선 슬라이더를 현재 값에 맞춘다.
         *
         * 원래 setupControls() 안에 있어서 바깥 스코프인 applyStateSnapshot()
         * 에서는 보이지 않았다. 되돌리기/다시실행을 누르면 여기서
         * ReferenceError 가 나 바로 다음 줄의 draw() 까지 가지 못했고,
         * 그래서 슬라이더 값만 되돌아가고 사진은 그대로였다.
         * (초기화 버튼은 setupControls() 안에 있어 정상 동작했다)
         */
        /* 저장 파일 이름. downloadHistoryItem() 이 바깥 스코프라 여기 둔다.
           (setupControls() 안에 있으면 히스토리 카드 저장에서 보이지 않는다) */
        /* 안내 문구. downloadHistoryItem() 이 바깥 스코프에서 부르는데
           setupControls() 안에 있어 ReferenceError 가 났다. 그 예외를
           빈 catch 가 삼키면서 두 번째 저장 경로까지 실행돼, 히스토리
           카드에서 저장할 때마다 같은 사진이 두 장씩 들어갔다. */
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

        function getDownloadFilename(prefix) {
            const now = new Date();
            const pad = function(n) { return String(n).padStart(2, '0'); };
            const dStr = now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate()) + '_' + 
                         pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
            return prefix + '_' + dStr + '.png';
        }

        function syncGuideSliders() {
            const elL1 = document.getElementById('rngGuideL1');
            const elL2 = document.getElementById('rngGuideL2');
            const elL3 = document.getElementById('rngGuideL3');
            const elR1 = document.getElementById('rngGuideR1');
            const elR2 = document.getElementById('rngGuideR2');
            const elR3 = document.getElementById('rngGuideR3');
            const elH1 = document.getElementById('rngGuideH1');
            const elH2 = document.getElementById('rngGuideH2');
            const elH3 = document.getElementById('rngGuideH3');
            const elLW = document.getElementById('rngGuideLineWidth');
            const elLO = document.getElementById('rngGuideLineOpacity');

            if (elL1) { elL1.value = guideL1; document.getElementById('valGuideL1').innerText = (guideL1 > 0 ? '+' : '') + Math.round(guideL1) + '%'; }
            if (elL2) { elL2.value = guideL2; document.getElementById('valGuideL2').innerText = (guideL2 > 0 ? '+' : '') + Math.round(guideL2) + '%'; }
            if (elL3) { elL3.value = guideL3; document.getElementById('valGuideL3').innerText = (guideL3 > 0 ? '+' : '') + Math.round(guideL3) + '%'; }
            if (elR1) { elR1.value = guideR1; document.getElementById('valGuideR1').innerText = (guideR1 > 0 ? '+' : '') + Math.round(guideR1) + '%'; }
            if (elR2) { elR2.value = guideR2; document.getElementById('valGuideR2').innerText = (guideR2 > 0 ? '+' : '') + Math.round(guideR2) + '%'; }
            if (elR3) { elR3.value = guideR3; document.getElementById('valGuideR3').innerText = (guideR3 > 0 ? '+' : '') + Math.round(guideR3) + '%'; }
            if (elH1) { elH1.value = guideH1; document.getElementById('valGuideH1').innerText = (guideH1 > 0 ? '+' : '') + Math.round(guideH1) + '%'; }
            if (elH2) { elH2.value = guideH2; document.getElementById('valGuideH2').innerText = (guideH2 > 0 ? '+' : '') + Math.round(guideH2) + '%'; }
            if (elH3) { elH3.value = guideH3; document.getElementById('valGuideH3').innerText = (guideH3 > 0 ? '+' : '') + Math.round(guideH3) + '%'; }
            if (elLW) { elLW.value = guideLineWidth; document.getElementById('valGuideLineWidth').innerText = guideLineWidth.toFixed(1) + 'px'; }
            if (elLO) { elLO.value = guideLineOpacity; document.getElementById('valGuideLineOpacity').innerText = Math.round(guideLineOpacity) + '%'; }
        }

        function updateGuideRatios() {
            const scaleFactor = (curScale / 100.0);
            const wFactor = (curWidth / 100.0);
            const hFactor = (curHeight / 100.0);
            const targetW = rawLImg.width * scaleFactor * wFactor;
            const targetH = rawLImg.height * scaleFactor * hFactor;

            // 좌측 세로선
            const lDist1 = Math.abs(guideL2 - guideL1) * (targetW / 100.0);
            const lDist2 = Math.abs(guideL3 - guideL2) * (targetW / 100.0);
            const lTotal = lDist1 + lDist2;
            if (lTotal > 0) {
                const lPct1 = (lDist1 / lTotal) * 100;
                const lPct2 = (lDist2 / lTotal) * 100;
                const lRatio = (lDist1 > 0 && lDist2 > 0) ? (lDist2 / lDist1).toFixed(2) : '1.00';
                const elBadgeL = document.getElementById('badgeRatioLeft');
                const elInfoL = document.getElementById('infoDistLeft');
                if (elBadgeL) elBadgeL.textContent = `비율 ${Math.round(lPct1)}% : ${Math.round(lPct2)}% (1:${lRatio})`;
                if (elInfoL) elInfoL.textContent = `구간1: ${Math.round(lDist1)}px (${lPct1.toFixed(1)}%) | 구간2: ${Math.round(lDist2)}px (${Math.round(lPct2)}%)`;
            }

            // 우측 세로선
            const rDist1 = Math.abs(guideR2 - guideR1) * (targetW / 100.0);
            const rDist2 = Math.abs(guideR3 - guideR2) * (targetW / 100.0);
            const rTotal = rDist1 + rDist2;
            if (rTotal > 0) {
                const rPct1 = (rDist1 / rTotal) * 100;
                const rPct2 = (rDist2 / rTotal) * 100;
                const rRatio = (rDist1 > 0 && rDist2 > 0) ? (rDist2 / rDist1).toFixed(2) : '1.00';
                const elBadgeR = document.getElementById('badgeRatioRight');
                const elInfoR = document.getElementById('infoDistRight');
                if (elBadgeR) elBadgeR.textContent = `비율 ${Math.round(rPct1)}% : ${Math.round(rPct2)}% (1:${rRatio})`;
                if (elInfoR) elInfoR.textContent = `구간1: ${Math.round(rDist1)}px (${Math.round(rPct1)}%) | 구간2: ${Math.round(rDist2)}px (${Math.round(rPct2)}%)`;
            }

            // 가로선 (높이 구간)
            const hDist1 = Math.abs(guideH2 - guideH1) * (targetH / 100.0);
            const hDist2 = Math.abs(guideH3 - guideH2) * (targetH / 100.0);
            const hTotal = hDist1 + hDist2;
            if (hTotal > 0) {
                const hPct1 = (hDist1 / hTotal) * 100;
                const hPct2 = (hDist2 / hTotal) * 100;
                const hRatio = (hDist1 > 0 && hDist2 > 0) ? (hDist2 / hDist1).toFixed(2) : '1.00';
                const elBadgeH = document.getElementById('badgeRatioH');
                const elInfoH = document.getElementById('infoDistH');
                if (elBadgeH) elBadgeH.textContent = `비율 ${Math.round(hPct1)}% : ${Math.round(hPct2)}% (1:${hRatio})`;
                if (elInfoH) elInfoH.textContent = `상단: ${Math.round(hDist1)}px (${Math.round(hPct1)}%) | 하단: ${Math.round(hDist2)}px (${Math.round(hPct2)}%)`;
            }
        }
        // ⬆ [모바일 이식 수정] 원본에서는 setupControls() 내부에 정의돼 있어
        //   형제 함수 onAnyImageLoaded() 가 호출할 때 ReferenceError 가 났고,
        //   그 여파로 바로 다음의 requestDraw() 까지 실행되지 않았습니다.
        //   의존성이 전부 IIFE 최상위 변수라 이 위치로 올려 해결했습니다.


        bgImg.onload = onAnyImageLoaded;
        rawLImg.onload = onAnyImageLoaded;
        rawRImg.onload = onAnyImageLoaded;

        bgImg.src = CFG.bg_b64;
        // 이어 그릴 밑그림이 없으면 맨얼굴과 배경이 같은 사진이다.
        // 그때 두 번 풀어 두면 사진 한 장 분량(수 MB)을 괜히 더 쓴다.
        if (CFG.orig_b64 && CFG.orig_b64 !== CFG.bg_b64) {
            origImg.onload = onAnyImageLoaded;
            origImg.src = CFG.orig_b64;
        } else {
            origImg = bgImg;
        }

        // ── 다른 부위로 넘겨줄 그림 굽기 ──────────────────────────────
        // 맨얼굴 위에 '지금 이 눈썹만' 얹은 한 장을 만든다. 입술을 편집할 때
        // 이 그림이 배경이 되어 두 시술이 한 화면에 같이 보인다.
        //
        // 사진 확대·이동은 잠시 되돌린다. 그것까지 구워 넣으면 입술 쪽 좌표와
        // 어긋나 두 작업이 서로 다른 자리에 놓인다.
        window.__blCapture = function () {
            const pz = curImgZoom, px = curImgPanX, py = curImgPanY, pb = captureBg;
            try {
                if (origImg.complete && (origImg.naturalWidth || origImg.width) > 0) {
                    captureBg = origImg;
                }
                curImgZoom = 100; curImgPanX = 0; curImgPanY = 0;
                bgFilterDirty = true;
                draw();
                // toDataURL 은 실패해도 예외 없이 "data:," 를 주는 기기가 있다.
                // 그대로 넘기면 2차 편집이 백지로 시작한다.
                const url = canvas.toDataURL('image/jpeg', 0.92);
                return (url && url.length > 128) ? url : null;
            } catch (e) {
                console.warn('눈썹 굽기 실패', e);
                return null;
            } finally {
                captureBg = pb; curImgZoom = pz; curImgPanX = px; curImgPanY = py;
                bgFilterDirty = true;
                draw();
            }
        };
        // new Image() 는 문서에 붙어 있지 않아 실패해도 창까지 안 올라온다.
        // 그대로 두면 눈썹만 안 보이고 아무 흔적이 없다. 직접 알린다.
        rawLImg.onerror = function () {
            if (window.__blReport) window.__blReport("그림", "왼쪽 눈썹 그림을 못 읽었습니다");
        };
        rawRImg.onerror = function () {
            if (window.__blReport) window.__blReport("그림", "오른쪽 눈썹 그림을 못 읽었습니다");
        };
        rawLImg.src = CFG.l_b64;
        rawRImg.src = CFG.r_b64;

        // ── 편집 중 디자인 갈아 끼우기 ────────────────────────────────
        // 퀵에서 다른 눈썹을 고르면 앱 셸이 지금 설정 그대로 새 디자인을
        // 구워서 보낸다. 여기서는 밑그림만 바꿔 끼운다.
        // 자리·크기·기울기·색은 전부 이 아래 변수들이 들고 있으므로
        // 다시 그리기만 하면 지금까지 맞춘 값이 그대로 이어진다.
        window.__blSwapBrow = function (lSrc, rSrc, name) {
            if (!lSrc || !rSrc) return;
            // 색·꼬리두께를 미리 구워 둔 판은 이전 디자인 것이라 버린다
            for (const k in tintCache) delete tintCache[k];
            if (name) CFG.safe_design_name = name;
            rawLImg.onload = onAnyImageLoaded;
            rawRImg.onload = onAnyImageLoaded;
            rawLImg.src = lSrc;
            rawRImg.src = rSrc;
        };

        // 초기 위치
        const initLX = CFG.left_center_x;
        const initLY = CFG.left_center_y;
        const initRX = CFG.right_center_x;
        const initRY = CFG.right_center_y;

        let leftPos = { x: initLX, y: initLY };
        let rightPos = { x: initRX, y: initRY };

        let isDragging = false;
        let startX, startY;
        let browMoveTarget = 'both'; // 'both' | 'auto' | 'left' | 'right'
        let activeBrowDrag = 'both'; // 'both' | 'left' | 'right'

        function determineActiveBrowDrag(pos) {
            if (browMoveTarget === 'both') return 'both';
            if (browMoveTarget === 'left') return 'left';
            if (browMoveTarget === 'right') return 'right';
            if (browMoveTarget === 'auto') {
                const lx = leftPos.x - (curSpacing / 2.0);
                const rx = rightPos.x + (curSpacing / 2.0);
                const distL = Math.hypot(pos.x - lx, pos.y - leftPos.y);
                const distR = Math.hypot(pos.x - rx, pos.y - rightPos.y);
                return (distL <= distR) ? 'left' : 'right';
            }
            return 'both';
        }

        // 조절 파라미터 상태
        let curScale = 100;
        let curWidth = 100;
        let curHeight = 100;
        let curRot = 0;
        let curSpacing = 0;
        /** 눈썹을 위아래로 옮긴 양. 값 자체가 아니라 '지금까지 옮긴 만큼' 이라,
         *  손으로 끌어 옮겨도 이 값과 어긋나지 않는다. */
        let curVert = 0;
        let curOpacity = 85;
        /** 고객의 원래 눈썹 진하기. 100 = 사진 그대로, 0 = 눈썹 자리를 피부로 덮음.
         *  원래 눈썹이 진하면 디자인 눈썹이 묻혀 상담이 어려워 흐리게 한다. */
        let curNatBrow = 100;
        let curLRot = 0;
        let curRRot = 0;
        let curRound = 0;

        // 📐 눈썹 가이드선 상태 (세로선 + 가로선, 모두 흰색 실선) - 초기 비활성화, 체크 시에만 표시
        let show3Guides = false;  // 세로 3등분선 표시 여부 (선택 시에만 표시)
        let showHGuides = false;  // 가로 3등분선 표시 여부 (선택 시에만 표시)
        let liveMirror = false;
        let guideL1 = -48; // % from eyebrow center (Tail)
        let guideL2 = 12;  // % from eyebrow center (Peak/Arch)
        let guideL3 = 48;  // % from eyebrow center (Head)
        let guideR1 = -48; // % from eyebrow center (Head)
        let guideR2 = -12; // % from eyebrow center (Peak/Arch)
        let guideR3 = 48;  // % from eyebrow center (Tail)

        let guideH1 = -48; // % from eyebrow center (Top line)
        let guideH2 = 0;   // % from eyebrow center (Center line)
        let guideH3 = 48;  // % from eyebrow center (Bottom line)

        let guideLineWidth = 1.0;   // 가이드선 굵기 (px)
        let guideLineOpacity = 80;  // 가이드선 투명도 (%)

        let activeGuideDrag = null; // 'L1'|'L2'|'L3'|'R1'|'R2'|'R3'|'H1'|'H2'|'H3'|null

        // 고객 사진 편집 파라미터 (밝기, 대비, 채도, 확대, 이동)
        let curBright = 100;
        let curContrast = 100;
        let curSaturate = 100;
        let curImgZoom = 100;
        let curImgPanX = 0;
        let curImgPanY = 0;

        // 🚀 고성능 GPU 가속 오프스크린 배경 캐시 (120fps 부드러운 드래그)
        let filteredBgCanvas = null;
        let bgFilterDirty = true;

        function updateFilteredBg() {
            if (!bgImg.complete || !(bgImg.naturalWidth || bgImg.width)) {
                bgFilterDirty = true;
                return;
            }
            if (!filteredBgCanvas) {
                filteredBgCanvas = document.createElement('canvas');
            }
            const w = bgImg.naturalWidth || bgImg.width || canvas.width || CFG.img_w;
            const h = bgImg.naturalHeight || bgImg.height || canvas.height || CFG.img_h;
            if (filteredBgCanvas.width !== w || filteredBgCanvas.height !== h) {
                filteredBgCanvas.width = w;
                filteredBgCanvas.height = h;
            }
            const bCtx = filteredBgCanvas.getContext('2d');
            bCtx.clearRect(0, 0, w, h);
            bCtx.save();
            bCtx.filter = "brightness(" + curBright + "%) contrast(" + curContrast + "%) saturate(" + curSaturate + "%)";
            const src = captureBg || bgImg;
            bCtx.drawImage(src, 0, 0, w, h);
            // 원래 눈썹 흐리게: 미리 만든 '피부 조각'을 진하기만큼 비쳐 보이게 덮는다.
            // 같은 필터 아래에서 그려야 밝기·대비를 바꿔도 조각이 튀지 않는다.
            if (curNatBrow < 100) {
                const pieces = natBrowPieces(src, w);
                if (pieces.length) {
                    bCtx.globalAlpha = 1 - curNatBrow / 100;
                    pieces.forEach(function (p) { bCtx.drawImage(p.canvas, p.x, p.y); });
                    bCtx.globalAlpha = 1;
                }
            }
            bCtx.restore();
            bgFilterDirty = false;
        }

        // 사진마다 한 번만 만든다 (맨얼굴·이어 그린 밑그림 각각). 조절바를 끌 때는
        // 투명도만 바뀌므로 다시 계산하지 않는다.
        const natBrowCache = new Map();
        function natBrowPieces(src, w) {
            const nb = CFG.nat_brows;
            if (!nb || !window.BrowErase) return [];
            let pieces = natBrowCache.get(src);
            if (!pieces) {
                pieces = window.BrowErase.build(src, nb, nb.w ? w / nb.w : 1);
                natBrowCache.set(src, pieces);
            }
            return pieces;
        }

        function invalidateBgFilter() {
            bgFilterDirty = true;
        }

        // ⚡ requestAnimationFrame 렌더링 스케줄러 (버벅거림 완전 제거)
        let drawRequested = false;
        function requestDraw() {
            if (!drawRequested) {
                drawRequested = true;
                requestAnimationFrame(() => {
                    drawRequested = false;
                    draw();
                });
            }
        }

        // ↩️ 실행 취소(Ctrl+Z) / ↪️ 다시 실행(Ctrl+Y) 초고속 즉시 반응 히스토리 엔진
        const undoStack = [];
        const redoStack = [];
        const MAX_HISTORY = 50;
        let isApplyingHistory = false;
        let interactionInitialState = null;
        let sliderHistoryTimer = null;

        function captureStateSnapshot() {
            return {
                leftPos: { x: leftPos.x, y: leftPos.y },
                rightPos: { x: rightPos.x, y: rightPos.y },
                curScale: curScale,
                curWidth: curWidth,
                curHeight: curHeight,
                curRot: curRot,
                curSpacing: curSpacing,
                curVert: curVert,
                curOpacity: curOpacity,
                curNatBrow: curNatBrow,
                curRound: curRound,
                curLRot: curLRot,
                curRRot: curRRot,
                curHex: curHex,
                curBright: curBright,
                curContrast: curContrast,
                curSaturate: curSaturate,
                curImgZoom: curImgZoom,
                curImgPanX: curImgPanX,
                curImgPanY: curImgPanY,
                show3Guides: show3Guides,
                showHGuides: showHGuides,
                liveMirror: liveMirror,
                guideL1: guideL1,
                guideL2: guideL2,
                guideL3: guideL3,
                guideR1: guideR1,
                guideR2: guideR2,
                guideR3: guideR3,
                guideH1: guideH1,
                guideH2: guideH2,
                guideH3: guideH3,
                guideLineWidth: guideLineWidth,
                guideLineOpacity: guideLineOpacity,
                browMoveTarget: browMoveTarget
            };
        }

        function isStateDifferent(s1, s2) {
            if (!s1 || !s2) return true;
            return JSON.stringify(s1) !== JSON.stringify(s2);
        }

        function recordHistory(priorState) {
            if (isApplyingHistory) return;
            const stateToSave = priorState || captureStateSnapshot();
            undoStack.push(JSON.parse(JSON.stringify(stateToSave)));
            if (undoStack.length > MAX_HISTORY) undoStack.shift();
            redoStack.length = 0; // 새 작업 발생 시 Redo 스택 초기화
            updateUndoRedoButtons();
        }

        function flushPendingInteraction() {
            if (sliderHistoryTimer) {
                clearTimeout(sliderHistoryTimer);
                sliderHistoryTimer = null;
            }
            if (interactionInitialState) {
                const cur = captureStateSnapshot();
                if (isStateDifferent(interactionInitialState, cur)) {
                    recordHistory(interactionInitialState);
                }
                interactionInitialState = null;
            }
        }

        function onSliderInputStart() {
            if (isApplyingHistory) return;
            if (!interactionInitialState) {
                interactionInitialState = captureStateSnapshot();
            }
            if (sliderHistoryTimer) clearTimeout(sliderHistoryTimer);
            sliderHistoryTimer = setTimeout(() => {
                flushPendingInteraction();
            }, 500);
        }

        function applyStateSnapshot(st) {
            if (!st) return;
            isApplyingHistory = true;
            try {
                leftPos = { x: st.leftPos.x, y: st.leftPos.y };
                rightPos = { x: st.rightPos.x, y: st.rightPos.y };
                curVert = st.curVert || 0;
                curScale = st.curScale;
                curWidth = st.curWidth;
                curHeight = st.curHeight;
                curRot = st.curRot;
                curSpacing = st.curSpacing;
                curOpacity = st.curOpacity;
                curNatBrow = (st.curNatBrow !== undefined) ? st.curNatBrow : 100;
                curRound = st.curRound;
                curLRot = st.curLRot;
                curRRot = st.curRRot;
                curHex = st.curHex;
                curBright = st.curBright;
                curContrast = st.curContrast;
                curSaturate = st.curSaturate;
                curImgZoom = st.curImgZoom;
                curImgPanX = st.curImgPanX;
                curImgPanY = st.curImgPanY;
                show3Guides = st.show3Guides;
                showHGuides = st.showHGuides;
                liveMirror = st.liveMirror;
                guideL1 = st.guideL1;
                guideL2 = st.guideL2;
                guideL3 = st.guideL3;
                guideR1 = st.guideR1;
                guideR2 = st.guideR2;
                guideR3 = st.guideR3;
                guideH1 = st.guideH1;
                guideH2 = st.guideH2;
                guideH3 = st.guideH3;
                guideLineWidth = (st.guideLineWidth !== undefined) ? st.guideLineWidth : 1.0;
                guideLineOpacity = (st.guideLineOpacity !== undefined) ? st.guideLineOpacity : 80;
                browMoveTarget = st.browMoveTarget || 'both';

                syncAllControlsFromState();
                invalidateBgFilter();
                syncGuideSliders();
                updateGuideRatios();
                draw(); // 즉각적인 100% 동기 반영
            } finally {
                isApplyingHistory = false;
                updateUndoRedoButtons();
            }
        }

        function undoAction() {
            flushPendingInteraction();
            if (undoStack.length === 0) return;
            const curState = captureStateSnapshot();
            redoStack.push(JSON.parse(JSON.stringify(curState)));
            const prevState = undoStack.pop();
            applyStateSnapshot(prevState);
        }

        function redoAction() {
            flushPendingInteraction();
            if (redoStack.length === 0) return;
            const curState = captureStateSnapshot();
            undoStack.push(JSON.parse(JSON.stringify(curState)));
            const nextState = redoStack.pop();
            applyStateSnapshot(nextState);
        }

        function updateUndoRedoButtons() {
            const btnU = document.getElementById('btnUndo');
            const btnR = document.getElementById('btnRedo');
            if (btnU) btnU.disabled = (undoStack.length === 0 && !interactionInitialState);
            if (btnR) btnR.disabled = (redoStack.length === 0);
        }

        function syncAllControlsFromState() {
            const setVal = (id, val, suffix) => {
                const el = document.getElementById(id);
                if (el) el.value = val;
                const vEl = document.getElementById('val' + id.replace('rng', ''));
                if (vEl) vEl.innerText = val + (suffix || '');
            };

            setVal('rngScale', curScale, '%');
            setVal('rngWidth', curWidth, '%');
            setVal('rngHeight', curHeight, '%');
            setVal('rngRot', curRot, '°');
            setVal('rngSpacing', curSpacing, 'px');
            setVal('rngVert', curVert, 'px');
            setVal('rngOpacity', curOpacity, '%');
            setVal('rngNatBrow', curNatBrow, '%');
            setVal('rngRound', curRound, '%');
            setVal('rngLRot', curLRot, '°');
            setVal('rngRRot', curRRot, '°');
            setVal('rngBright', curBright, '%');
            setVal('rngContrast', curContrast, '%');
            setVal('rngSaturate', curSaturate, '%');
            setVal('rngImgZoom', curImgZoom, '%');
            setVal('rngImgPanX', curImgPanX, 'px');
            setVal('rngImgPanY', curImgPanY, 'px');
            setVal('rngGuideLineWidth', guideLineWidth.toFixed(1), 'px');
            setVal('rngGuideLineOpacity', Math.round(guideLineOpacity), '%');

            const chkG = document.getElementById('chkShow3Guides');
            if (chkG) chkG.checked = show3Guides;
            const chkHG = document.getElementById('chkShowHGuides');
            if (chkHG) chkHG.checked = showHGuides;
            const chkLM = document.getElementById('chkLiveMirror');
            if (chkLM) chkLM.checked = liveMirror;

            const inputColorPicker = document.getElementById('inputColorPicker');
            const selectColorPreset = document.getElementById('selectColorPreset');
            if (inputColorPicker) inputColorPicker.value = curHex;
            if (selectColorPreset) {
                if (["#000000", "#262626", "#3D2B1F", "#5C4033", "#4E4B46", "#8B5A2B"].includes(curHex.toUpperCase())) {
                    selectColorPreset.value = curHex.toUpperCase();
                } else {
                    selectColorPreset.value = "custom";
                }
            }
            updateColorDisplay();

            document.querySelectorAll('.brow-move-target-btn').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-target') === browMoveTarget);
            });
        }

        // 색상 상태 및 틴팅 캐시
        let curHex = CFG.cur_hex;
        const tintCache = {};

        function parseHex(hex) {
            if (!hex || typeof hex !== 'string' || !hex.startsWith('#') || hex.length < 7) {
                return { r: 0, g: 0, b: 0 };
            }
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return {
                r: isNaN(r) ? 0 : r,
                g: isNaN(g) ? 0 : g,
                b: isNaN(b) ? 0 : b
            };
        }

        function updateColorDisplay() {
            const colorChip = document.getElementById('colorChip');
            const colorHexText = document.getElementById('colorHexText');
            const colorRgbText = document.getElementById('colorRgbText');
            if (colorChip) colorChip.style.backgroundColor = curHex;
            if (colorHexText) colorHexText.innerText = curHex;
            const rgb = parseHex(curHex);
            if (colorRgbText) colorRgbText.innerText = "RGB(" + rgb.r + ", " + rgb.g + ", " + rgb.b + ")";
        }

        function getTintedEyebrow(img, hexColor) {
            if (!img || !img.width || !img.height) return img;
            if (!hexColor || hexColor.toUpperCase() === CFG.cur_hex.toUpperCase()) return img;
            const key = hexColor + '_' + (img === rawLImg ? 'L' : 'R');
            if (tintCache[key]) return tintCache[key];

            try {
                const rgb = parseHex(hexColor);
                const tCanvas = document.createElement('canvas');
                tCanvas.width = img.width;
                tCanvas.height = img.height;
                const tCtx = tCanvas.getContext('2d', { willReadFrequently: true });
                tCtx.drawImage(img, 0, 0);

                const imgData = tCtx.getImageData(0, 0, tCanvas.width, tCanvas.height);
                const data = imgData.data;

                for (let i = 0; i < data.length; i += 4) {
                    const a = data[i + 3];
                    if (a === 0) continue;
                    const luma = (0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]) / 255.0;
                    data[i] = Math.min(255, Math.max(0, Math.round(rgb.r * (1.0 - 0.4 * luma))));
                    data[i+1] = Math.min(255, Math.max(0, Math.round(rgb.g * (1.0 - 0.4 * luma))));
                    data[i+2] = Math.min(255, Math.max(0, Math.round(rgb.b * (1.0 - 0.4 * luma))));
                }
                tCtx.putImageData(imgData, 0, 0);
                tintCache[key] = tCanvas;
                return tCanvas;
            } catch(e) {
                return img;
            }
        }

        // 🌙 화살표 시작점(산 아래)과 끝점(꼬리 꼭짓점) 사이를 자연스럽게 이어주는 에르미트(Hermite) 스무스 브릿지 알고리즘
        function getProcessedEyebrow(img, hexColor, roundVal) {
            if (!img || !img.width || !img.height) return img;
            const isLeft = (img === rawLImg);
            const roundKey = hexColor + '_HBRG_' + roundVal + '_' + (isLeft ? 'L' : 'R');
            if (tintCache[roundKey]) return tintCache[roundKey];

            const baseTint = getTintedEyebrow(img, hexColor);
            if (!roundVal || roundVal <= 0) {
                tintCache[roundKey] = baseTint;
                return baseTint;
            }

            try {
                const w = baseTint.width;
                const h = baseTint.height;
                const rgb = parseHex(hexColor);

                const rCanvas = document.createElement('canvas');
                rCanvas.width = w;
                rCanvas.height = h;
                const rCtx = rCanvas.getContext('2d', { willReadFrequently: true });
                rCtx.drawImage(baseTint, 0, 0);

                const imgData = rCtx.getImageData(0, 0, w, h);
                const data = imgData.data;

                // 1. 눈썹의 가로 경계(xMin ~ xMax) 및 각 열별 상단 경계선(yTop) 추출
                let xMin = w, xMax = 0;
                const yTop = new Array(w).fill(-1);
                const bodyAlpha = new Array(w).fill(210);

                for (let x = 0; x < w; x++) {
                    let aSum = 0, aCount = 0;
                    for (let y = 0; y < h; y++) {
                        const idx = (y * w + x) * 4;
                        const a = data[idx + 3];
                        if (a > 25) {
                            if (x < xMin) xMin = x;
                            if (x > xMax) xMax = x;
                            if (yTop[x] === -1) yTop[x] = y;
                            aSum += a;
                            aCount++;
                        }
                    }
                    if (aCount > 0) {
                        bodyAlpha[x] = Math.round(aSum / aCount);
                    }
                }

                if (xMin >= xMax) {
                    tintCache[roundKey] = baseTint;
                    return baseTint;
                }

                const totalLen = xMax - xMin;

                /* 눈썹산(윗선이 가장 높은 자리)을 찾는다.
                 *
                 * 꼬리 두께는 '꼬리가 날렵하냐 둥그냐' 를 보여주는 메뉴다.
                 * 그런데 부푸는 자리가 산을 넘어서면 산의 위치 자체가 옮겨져
                 * 같은 디자인이 다른 디자인이 되어 버린다. 그래서 산을
                 * 기준선으로 삼는다 — 여기까지만 채우고, 넘지 않는다. */
                let yArch = h, xArch = -1;
                for (let x = xMin; x <= xMax; x++) {
                    if (yTop[x] !== -1 && yTop[x] < yArch) { yArch = yTop[x]; xArch = x; }
                }

                // 2. 볼륨이 생길 구간: 꼬리 끝 ~ 눈썹산
                let xStart, xEnd;

                if (isLeft) {
                    xEnd = xMin;                       // 꼬리 끝
                    xStart = xArch;                    // 눈썹산
                } else {
                    xEnd = xMax;
                    xStart = xArch;
                }
                /* 산이 꼬리에 너무 붙어 있거나 반대쪽으로 치우친 디자인도 있다.
                 * 그럴 때는 예전처럼 꼬리에서 40% 지점을 쓴다. */
                const spanLen = Math.abs(xStart - xEnd);
                const wrongSide = isLeft ? (xStart <= xEnd) : (xStart >= xEnd);
                if (xArch === -1 || wrongSide
                    || spanLen < totalLen * 0.2 || spanLen > totalLen * 0.65) {
                    const bridgeRatio = 0.40;
                    xStart = isLeft
                        ? Math.min(w - 1, Math.round(xMin + bridgeRatio * totalLen))
                        : Math.max(0, Math.round(xMax - bridgeRatio * totalLen));
                }

                const yStart = yTop[xStart];
                const yEnd = yTop[xEnd];
                const dx = Math.abs(xEnd - xStart);

                if (dx <= 0 || yStart === -1 || yEnd === -1) {
                    tintCache[roundKey] = baseTint;
                    return baseTint;
                }

                // 시작점(산에서 내려오는 기울기)과 끝점(꼬리 기울기)의 연속 접선 미분값
                let mStart, mEnd;
                if (isLeft) {
                    const sampleX = Math.min(w - 1, xStart + 6);
                    mStart = (yTop[xStart] - (yTop[sampleX] !== -1 ? yTop[sampleX] : yStart)) / 6.0;
                    const sampleEnd = Math.min(w - 1, xEnd + 6);
                    mEnd = ((yTop[sampleEnd] !== -1 ? yTop[sampleEnd] : yEnd) - yTop[xEnd]) / -6.0;
                } else {
                    const sampleX = Math.max(0, xStart - 6);
                    mStart = (yTop[xStart] - (yTop[sampleX] !== -1 ? yTop[sampleX] : yStart)) / 6.0;
                    const sampleEnd = Math.max(0, xEnd - 6);
                    mEnd = ((yTop[sampleEnd] !== -1 ? yTop[sampleEnd] : yEnd) - yTop[xEnd]) / -6.0;
                }

                const pct = roundVal / 100.0;
                const minX = Math.min(xStart, xEnd);
                const maxX = Math.max(xStart, xEnd);

                /* 꼬리가 산 높이까지 차오르면 윗선이 평평해져서, 산이 어디인지
                 * 알 수 없게 된다. 산은 끝까지 뚜렷한 한 점으로 남아야 한다.
                 * 이 구간에서 가장 많이 내려간 깊이의 15% 만큼은 늘 비워 둔다. */
                let maxAvail = 0;
                for (let x = minX; x <= maxX; x++) {
                    if (yTop[x] === -1) continue;
                    const a = yTop[x] - yArch;
                    if (a > maxAvail) maxAvail = a;
                }
                const archGuard = yArch + Math.max(2, maxAvail * 0.15);

                // 3. 시작점과 끝점을 자연스러운 3차 에르미트 스플라인 브릿지로 매끄럽게 연결
                for (let x = minX; x <= maxX; x++) {
                    if (yTop[x] === -1) continue;

                    // xStart(t=0)부터 xEnd(t=1)까지의 정규화 진행률 t
                    const t = isLeft ? ((xStart - x) / dx) : ((x - xStart) / dx);
                    const clampedT = Math.max(0, Math.min(1, t));

                    // 에르미트 기저 함수
                    const h00 = 2 * clampedT * clampedT * clampedT - 3 * clampedT * clampedT + 1;
                    const h10 = clampedT * clampedT * clampedT - 2 * clampedT * clampedT + clampedT;
                    const h01 = -2 * clampedT * clampedT * clampedT + 3 * clampedT * clampedT;
                    const h11 = clampedT * clampedT * clampedT - clampedT * clampedT;

                    const yBridge = (h00 * yStart) + (h10 * dx * mStart * 0.7) + (h01 * yEnd) + (h11 * dx * mEnd * 0.7);

                    /* 볼륨의 크기를 '이 자리에서 눈썹산까지 남은 높이' 로 잰다.
                     *
                     * 예전에는 캔버스 높이의 16% 까지 sin 곡선으로 들어올렸다.
                     * 그 봉우리가 꼬리 한가운데에 생기면서 산보다 높아졌고,
                     * 결과적으로 산의 자리가 옮겨져 디자인이 통째로 달라졌다.
                     *
                     * 남은 높이로 재면 두 가지가 저절로 해결된다.
                     *   · 산에 가까워질수록 남은 높이가 0 → 볼륨도 0 이라
                     *     새 봉우리 없이 산으로 매끄럽게 이어진다
                     *   · 꼬리 쪽은 남은 높이가 크므로 그만큼 도톰해진다
                     *     — 꼬리 끝에서 산까지 고르게 볼륨이 붙는다 */
                    const avail = Math.max(0, yTop[x] - yArch);

                    // 꼬리 끝은 뾰족하게 남긴다. 끝까지 채우면 뭉툭해진다.
                    const TIP = 0.88;
                    let taper = 1.0;
                    if (clampedT > TIP) {
                        const u = (1.0 - clampedT) / (1.0 - TIP);
                        taper = u * u * (3 - 2 * u);
                    }

                    const FILL = 0.70;              // 최대치에서 산까지 70% 를 채운다
                    const camber = pct * FILL * avail * taper;

                    const baseBridgeY = (1.0 - pct) * yTop[x] + pct * Math.min(yTop[x], yBridge);
                    let yTarget = Math.min(yTop[x], baseBridgeY - camber);
                    // 마지막 방어선 — 산보다 높아지지도, 산에 닿지도 않는다
                    if (yTarget < archGuard) yTarget = archGuard;
                    if (yTarget > yTop[x]) yTarget = yTop[x];

                    const origTop = yTop[x];
                    const targetAlpha = bodyAlpha[x] || 210;

                    for (let y = Math.max(0, Math.floor(yTarget - 2)); y <= origTop; y++) {
                        const idx = (y * w + x) * 4;

                        if (y < yTarget - 1.5) {
                            data[idx + 3] = 0;
                        } else if (y < yTarget + 1.5) {
                            const edgeFactor = (y - (yTarget - 1.5)) / 3.0;
                            data[idx] = rgb.r;
                            data[idx + 1] = rgb.g;
                            data[idx + 2] = rgb.b;
                            data[idx + 3] = Math.max(data[idx + 3], Math.round(targetAlpha * edgeFactor * 0.9));
                        } else {
                            data[idx] = rgb.r;
                            data[idx + 1] = rgb.g;
                            data[idx + 2] = rgb.b;
                            data[idx + 3] = Math.max(data[idx + 3], Math.round(targetAlpha * 0.92));
                        }
                    }
                }

                rCtx.putImageData(imgData, 0, 0);
                tintCache[roundKey] = rCanvas;
                return rCanvas;
            } catch(e) {
                return baseTint;
            }
        }

        function initCanvas() {
            if (bgImg.naturalWidth && bgImg.naturalHeight) {
                canvas.width = bgImg.naturalWidth;
                canvas.height = bgImg.naturalHeight;
            } else if (!canvas.width || canvas.width < 10) {
                canvas.width = CFG.img_w;
                canvas.height = CFG.img_h;
            }
            updateFilteredBg();
            setupControls();
            syncAllControlsFromState();
            updateGuideRatios();
            renderHistoryCards();
            draw();
            notifyHeight();
        }

        function notifyHeight() {
            try {
                const h = document.documentElement.scrollHeight || document.body.scrollHeight;
                window.parent.postMessage({ type: 'streamlit:setFrameHeight', height: h + 20 }, '*');
                if (window.frameElement) {
                    window.frameElement.style.height = (h + 20) + 'px';
                }
            } catch(e) {}
        }

        window.addEventListener('resize', notifyHeight);
        setTimeout(notifyHeight, 200);
        setTimeout(notifyHeight, 800);

        function draw() {
            try {
                if (canvas.width === 0 || canvas.height === 0) {
                    canvas.width = bgImg.naturalWidth || bgImg.width || CFG.img_w;
                    canvas.height = bgImg.naturalHeight || bgImg.height || CFG.img_h;
                }
                ctx.clearRect(0, 0, canvas.width, canvas.height);

                ctx.save();
                const zoomF = curImgZoom / 100.0;
                ctx.translate(canvas.width / 2.0 + curImgPanX, canvas.height / 2.0 + curImgPanY);
                ctx.scale(zoomF, zoomF);
                ctx.translate(-canvas.width / 2.0, -canvas.height / 2.0);

                // 1. 고객 얼굴 배경 (캐시된 초고속 오프스크린 캔버스 렌더링 또는 bgImg 직접 렌더링)
                if (bgFilterDirty || !filteredBgCanvas) {
                    updateFilteredBg();
                }
                if (filteredBgCanvas && !bgFilterDirty) {
                    ctx.drawImage(filteredBgCanvas, 0, 0, canvas.width, canvas.height);
                } else {
                    const src = captureBg || bgImg;
                    if (src.complete && (src.naturalWidth || src.width) > 0) {
                        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
                    }
                }

                // 실시간 눈썹 변형 계산 (사진 줌과 완벽 1:1 동기화)
                const scaleFactor = (curScale / 100.0);
                const wFactor = (curWidth / 100.0);
                const hFactor = (curHeight / 100.0);

                const baseW = (rawLImg.naturalWidth || rawLImg.width || 500);
                const baseH = (rawLImg.naturalHeight || rawLImg.height || 140);
                const targetW = baseW * scaleFactor * wFactor;
                const targetH = baseH * scaleFactor * hFactor;

                const alphaVal = curOpacity / 100.0;

                // 2. 실시간 눈썹 렌더링
                const isLReady = rawLImg.complete && (rawLImg.naturalWidth || rawLImg.width) > 0;
                const isRReady = rawRImg.complete && (rawRImg.naturalWidth || rawRImg.width) > 0;

                if (isLReady && isRReady) {
                    const drawLImg = getProcessedEyebrow(rawLImg, curHex, curRound);
                    const drawRImg = getProcessedEyebrow(rawRImg, curHex, curRound);

                    // 왼쪽 눈썹
                    ctx.save();
                    ctx.translate(leftPos.x - (curSpacing / 2.0), leftPos.y);
                    ctx.rotate((curRot + curLRot) * Math.PI / 180.0);
                    ctx.globalAlpha = alphaVal;
                    ctx.drawImage(drawLImg, -targetW / 2.0, -targetH / 2.0, targetW, targetH);
                    ctx.restore();

                    // 오른쪽 눈썹
                    ctx.save();
                    ctx.translate(rightPos.x + (curSpacing / 2.0), rightPos.y);
                    ctx.rotate((-curRot + curRRot) * Math.PI / 180.0);
                    ctx.globalAlpha = alphaVal;
                    ctx.drawImage(drawRImg, -targetW / 2.0, -targetH / 2.0, targetW, targetH);
                    ctx.restore();
                }

                // 4. 마우스 드래그 중 정렬 가이드 라인 및 대상 눈썹 박스
                if (isDragging) {
                    ctx.strokeStyle = '#D4AF37';
                    ctx.setLineDash([6, 6]);
                    ctx.lineWidth = Math.max(1, 2 / zoomF);
                    
                    const lx = leftPos.x - (curSpacing / 2.0);
                    const rx = rightPos.x + (curSpacing / 2.0);

                    if (activeBrowDrag === 'left' || activeBrowDrag === 'both') {
                        ctx.strokeRect(lx - targetW/2 - 4, leftPos.y - targetH/2 - 4, targetW + 8, targetH + 8);
                    }
                    if (activeBrowDrag === 'right' || activeBrowDrag === 'both') {
                        ctx.strokeRect(rx - targetW/2 - 4, rightPos.y - targetH/2 - 4, targetW + 8, targetH + 8);
                    }
                    
                    if (activeBrowDrag === 'both') {
                        ctx.beginPath();
                        ctx.moveTo(lx, leftPos.y);
                        ctx.lineTo(rx, rightPos.y);
                        ctx.stroke();
                    }
                }

                // 5. 📐 눈썹 가이드선 그리기 (선 굵기 & 투명도 사용자 조절 적용)
                const lxCenter = leftPos.x - (curSpacing / 2.0);
                const rxCenter = rightPos.x + (curSpacing / 2.0);
                const yFaceCenter = (leftPos.y + rightPos.y) / 2.0;

                const guideStrokeW = Math.max(0.4, guideLineWidth / zoomF);
                const guideAlpha = guideLineOpacity / 100.0;
                const handleR = Math.max(2, (2.8 * Math.min(1.8, Math.max(0.8, guideLineWidth))) / zoomF);

                // 좌측 3선 X 좌표
                const l1_X = lxCenter + (targetW * guideL1 / 100.0);
                const l2_X = lxCenter + (targetW * guideL2 / 100.0);
                const l3_X = lxCenter + (targetW * guideL3 / 100.0);

                // 우측 3선 X 좌표
                const r1_X = rxCenter + (targetW * guideR1 / 100.0);
                const r2_X = rxCenter + (targetW * guideR2 / 100.0);
                const r3_X = rxCenter + (targetW * guideR3 / 100.0);

                if (show3Guides) {
                    function renderBrow3Lines(x1, x2, x3, yCenter, isLeft) {
                        const topY = yCenter - targetH * 0.95;
                        const botY = yCenter + targetH * 0.95;
                        const dimY = topY - 32;
                        const badgeY = dimY - 54;

                        const lines = [
                            { x: x1, name: isLeft ? '①꼬리' : '①앞머리' },
                            { x: x2, name: '②산' },
                            { x: x3, name: isLeft ? '③앞머리' : '③꼬리' }
                        ];

                        lines.forEach(l => {
                            ctx.save();
                            ctx.globalAlpha = guideAlpha;
                            // 흰색 실선
                            ctx.beginPath();
                            ctx.strokeStyle = '#FFFFFF';
                            ctx.lineWidth = guideStrokeW;
                            ctx.setLineDash([]);
                            ctx.moveTo(l.x, topY);
                            ctx.lineTo(l.x, botY);
                            ctx.stroke();

                            // 상/하단 원형 핸들
                            ctx.fillStyle = '#FFFFFF';
                            ctx.beginPath();
                            ctx.arc(l.x, topY, handleR, 0, Math.PI * 2);
                            ctx.arc(l.x, botY, handleR, 0, Math.PI * 2);
                            ctx.fill();

                            // 상단 캡션 라벨 (2배 확대)
                            ctx.font = 'bold ' + Math.max(18, Math.round(22 / zoomF)) + 'px Pretendard, sans-serif';
                            ctx.textAlign = 'center';
                            ctx.fillStyle = '#FFFFFF';
                            ctx.fillText(l.name, l.x, topY - 8);
                            ctx.restore();
                        });

                        // 구간 폭 계산
                        const minX = Math.min(x1, x2, x3);
                        const maxX = Math.max(x1, x2, x3);
                        const midX = (x1 + x2 + x3) - minX - maxX;

                        const dist1 = Math.abs(midX - minX);
                        const dist2 = Math.abs(maxX - midX);
                        const totalDist = dist1 + dist2;

                        if (totalDist > 0) {
                            const ratio1 = (dist1 / totalDist) * 100;
                            const ratio2 = (dist2 / totalDist) * 100;
                            const ratioStr = (dist1 > 0 && dist2 > 0) ? (dist2 / dist1).toFixed(2) : '1.00';

                            // 1) 구간 1 치수선 (흰색)
                            drawDimensionLine(minX, midX, dimY, `${Math.round(dist1)}px (${ratio1.toFixed(0)}%)`, '#FFFFFF');
                            // 2) 구간 2 치수선 (흰색)
                            drawDimensionLine(midX, maxX, dimY, `${Math.round(dist2)}px (${ratio2.toFixed(0)}%)`, '#FFFFFF');

                            // 3) 상단 비율 배지 (흰색 테두리 & 2배 텍스트)
                            ctx.save();
                            ctx.globalAlpha = Math.min(1.0, guideAlpha + 0.15);
                            const summaryText = `📐 ${ratio1.toFixed(0)}% : ${ratio2.toFixed(0)}% (1:${ratioStr})`;
                            ctx.font = 'bold ' + Math.max(20, Math.round(23 / zoomF)) + 'px Pretendard, sans-serif';
                            const textW = ctx.measureText(summaryText).width;
                            const badgeX = (minX + maxX) / 2.0;

                            ctx.fillStyle = 'rgba(20, 20, 20, 0.90)';
                            ctx.strokeStyle = '#FFFFFF';
                            ctx.lineWidth = Math.max(1.5, guideStrokeW);
                            const padX = 14, bh = Math.max(30, 36 / zoomF);
                            ctx.beginPath();
                            ctx.roundRect(badgeX - textW/2 - padX, badgeY - bh/2, textW + padX*2, bh, 6);
                            ctx.fill();
                            ctx.stroke();

                            ctx.fillStyle = '#FFFFFF';
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'middle';
                            ctx.fillText(summaryText, badgeX, badgeY);
                            ctx.restore();
                        }
                    }

                    renderBrow3Lines(l1_X, l2_X, l3_X, leftPos.y, true);
                    renderBrow3Lines(r1_X, r2_X, r3_X, rightPos.y, false);
                }

                // 6. 📏 눈썹 3등분 가로선 가이드 (흰색 실선 & 높이 비율 표시, 미러링 없음)
                if (showHGuides) {
                    const h1_Y = yFaceCenter + (targetH * guideH1 / 100.0);
                    const h2_Y = yFaceCenter + (targetH * guideH2 / 100.0);
                    const h3_Y = yFaceCenter + (targetH * guideH3 / 100.0);

                    const allXs = [l1_X, l2_X, l3_X, r1_X, r2_X, r3_X, lxCenter - targetW/2, rxCenter + targetW/2];
                    const minSpanX = Math.min(...allXs) - 20;
                    const maxSpanX = Math.max(...allXs) + 20;

                    const hLines = [
                        { y: h1_Y, name: '①상단' },
                        { y: h2_Y, name: '②중심' },
                        { y: h3_Y, name: '③하단' }
                    ];

                    hLines.forEach(hl => {
                        ctx.save();
                        ctx.globalAlpha = guideAlpha;
                        // 흰색 실선
                        ctx.beginPath();
                        ctx.strokeStyle = '#FFFFFF';
                        ctx.lineWidth = guideStrokeW;
                        ctx.setLineDash([]);
                        ctx.moveTo(minSpanX, hl.y);
                        ctx.lineTo(maxSpanX, hl.y);
                        ctx.stroke();

                        // 좌/우 끝 원형 핸들
                        ctx.fillStyle = '#FFFFFF';
                        ctx.beginPath();
                        ctx.arc(minSpanX, hl.y, handleR, 0, Math.PI * 2);
                        ctx.arc(maxSpanX, hl.y, handleR, 0, Math.PI * 2);
                        ctx.fill();

                        // 좌측 캡션 라벨 (2배 확대)
                        ctx.font = 'bold ' + Math.max(18, Math.round(22 / zoomF)) + 'px Pretendard, sans-serif';
                        ctx.textAlign = 'right';
                        ctx.textBaseline = 'middle';
                        ctx.fillStyle = '#FFFFFF';
                        ctx.fillText(hl.name, minSpanX - 10, hl.y);
                        ctx.restore();
                    });

                    // 세로 구간 높이 계산
                    const minY = Math.min(h1_Y, h2_Y, h3_Y);
                    const maxY = Math.max(h1_Y, h2_Y, h3_Y);
                    const midY = (h1_Y + h2_Y + h3_Y) - minY - maxY;

                    const hDist1 = Math.abs(midY - minY);
                    const hDist2 = Math.abs(maxY - midY);
                    const hTotalDist = hDist1 + hDist2;

                    if (hTotalDist > 0) {
                        const hRatio1 = (hDist1 / hTotalDist) * 100;
                        const hRatio2 = (hDist2 / hTotalDist) * 100;
                        const hRatioStr = (hDist1 > 0 && hDist2 > 0) ? (hDist2 / hDist1).toFixed(2) : '1.00';
                        const dimX = maxSpanX + 24;
                        const badgeX = dimX + 60;
                        const badgeY = (minY + maxY) / 2.0;

                        // 세로 구간 치수선 그리기
                        drawVerticalDimensionLine(minY, midY, dimX, `${Math.round(hDist1)}px (${hRatio1.toFixed(0)}%)`, '#FFFFFF');
                        drawVerticalDimensionLine(midY, maxY, dimX, `${Math.round(hDist2)}px (${hRatio2.toFixed(0)}%)`, '#FFFFFF');

                        // 우측 높이 비율 요약 배지 (2배 확대)
                        ctx.save();
                        ctx.globalAlpha = Math.min(1.0, guideAlpha + 0.15);
                        const hSummaryText = `📐 높이 ${hRatio1.toFixed(0)}% : ${hRatio2.toFixed(0)}% (1:${hRatioStr})`;
                        ctx.font = 'bold ' + Math.max(20, Math.round(23 / zoomF)) + 'px Pretendard, sans-serif';
                        const textW = ctx.measureText(hSummaryText).width;

                        ctx.fillStyle = 'rgba(20, 20, 20, 0.90)';
                        ctx.strokeStyle = '#FFFFFF';
                        ctx.lineWidth = Math.max(1.5, guideStrokeW);
                        const padX = 14, bh = Math.max(30, 36 / zoomF);
                        ctx.beginPath();
                        ctx.roundRect(badgeX - padX, badgeY - bh/2, textW + padX*2, bh, 6);
                        ctx.fill();
                        ctx.stroke();

                        ctx.fillStyle = '#FFFFFF';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(hSummaryText, badgeX, badgeY);
                        ctx.restore();
                    }
                }

                function drawDimensionLine(xStart, xEnd, y, text, color) {
                    if (Math.abs(xEnd - xStart) < 8) return;
                    ctx.save();
                    ctx.globalAlpha = guideAlpha;
                    ctx.strokeStyle = color;
                    ctx.fillStyle = color;
                    ctx.lineWidth = guideStrokeW;
                    ctx.setLineDash([]);

                    ctx.beginPath();
                    ctx.moveTo(xStart + 2, y);
                    ctx.lineTo(xEnd - 2, y);
                    ctx.stroke();

                    const arrowSize = Math.max(4.5, 6.5 / zoomF);
                    ctx.beginPath();
                    ctx.moveTo(xStart + 2, y);
                    ctx.lineTo(xStart + 2 + arrowSize, y - arrowSize * 0.7);
                    ctx.lineTo(xStart + 2 + arrowSize, y + arrowSize * 0.7);
                    ctx.fill();

                    ctx.beginPath();
                    ctx.moveTo(xEnd - 2, y);
                    ctx.lineTo(xEnd - 2 - arrowSize, y - arrowSize * 0.7);
                    ctx.lineTo(xEnd - 2 - arrowSize, y + arrowSize * 0.7);
                    ctx.fill();

                    // 치수 텍스트 2배 확대
                    ctx.font = 'bold ' + Math.max(18, Math.round(21 / zoomF)) + 'px Pretendard, sans-serif';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillText(text, (xStart + xEnd) / 2.0, y - 5);
                    ctx.restore();
                }

                function drawVerticalDimensionLine(yStart, yEnd, x, text, color) {
                    if (Math.abs(yEnd - yStart) < 8) return;
                    ctx.save();
                    ctx.globalAlpha = guideAlpha;
                    ctx.strokeStyle = color;
                    ctx.fillStyle = color;
                    ctx.lineWidth = guideStrokeW;
                    ctx.setLineDash([]);

                    ctx.beginPath();
                    ctx.moveTo(x, yStart + 2);
                    ctx.lineTo(x, yEnd - 2);
                    ctx.stroke();

                    const arrowSize = Math.max(4.5, 6.5 / zoomF);
                    ctx.beginPath();
                    ctx.moveTo(x, yStart + 2);
                    ctx.lineTo(x - arrowSize * 0.7, yStart + 2 + arrowSize);
                    ctx.lineTo(x + arrowSize * 0.7, yStart + 2 + arrowSize);
                    ctx.fill();

                    ctx.beginPath();
                    ctx.moveTo(x, yEnd - 2);
                    ctx.lineTo(x - arrowSize * 0.7, yEnd - 2 - arrowSize);
                    ctx.lineTo(x + arrowSize * 0.7, yEnd - 2 - arrowSize);
                    ctx.fill();

                    // 세로 치수 텍스트 2배 확대
                    ctx.font = 'bold ' + Math.max(18, Math.round(21 / zoomF)) + 'px Pretendard, sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(text, x + 10, (yStart + yEnd) / 2.0);
                    ctx.restore();
                }

                ctx.restore();
            } catch(e) {
                console.error("Draw error:", e);
            }
        }

        function setupControls() {
            const rngScale = document.getElementById('rngScale');
            const rngWidth = document.getElementById('rngWidth');
            const rngHeight = document.getElementById('rngHeight');
            const rngRot = document.getElementById('rngRot');
            const rngSpacing = document.getElementById('rngSpacing');
            const rngVert = document.getElementById('rngVert');
            const rngOpacity = document.getElementById('rngOpacity');
            const rngNatBrow = document.getElementById('rngNatBrow');
            const rngRound = document.getElementById('rngRound');
            const rngLRot = document.getElementById('rngLRot');
            const rngRRot = document.getElementById('rngRRot');

            const rngBright = document.getElementById('rngBright');
            const rngContrast = document.getElementById('rngContrast');
            const rngSaturate = document.getElementById('rngSaturate');
            const rngImgZoom = document.getElementById('rngImgZoom');
            const rngImgPanX = document.getElementById('rngImgPanX');
            const rngImgPanY = document.getElementById('rngImgPanY');

            const selectColorPreset = document.getElementById('selectColorPreset');
            const inputColorPicker = document.getElementById('inputColorPicker');
            const colorChip = document.getElementById('colorChip');
            const colorHexText = document.getElementById('colorHexText');
            const colorRgbText = document.getElementById('colorRgbText');

            // ↩️ 실행 취소 & 다시 실행 버튼 바인딩 (즉각 반응)
            const btnUndo = document.getElementById('btnUndo');
            const btnRedo = document.getElementById('btnRedo');
            if (btnUndo) {
                btnUndo.onclick = function(e) {
                    e.preventDefault();
                    undoAction();
                };
            }
            if (btnRedo) {
                btnRedo.onclick = function(e) {
                    e.preventDefault();
                    redoAction();
                };
            }
            updateUndoRedoButtons();

            // ⌨️ 단축키 바인딩 (Ctrl+Z: 실행취소, Ctrl+Y / Ctrl+Shift+Z: 다시실행)
            window.addEventListener('keydown', function(e) {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                    if (e.shiftKey) {
                        redoAction();
                    } else {
                        undoAction();
                    }
                    e.preventDefault();
                } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
                    redoAction();
                    e.preventDefault();
                }
            });

            // 🎚️ 모든 슬라이더 공통 히스토리 연동
            function bindSliderHistory(sliderEl) {
                if (!sliderEl) return;
                sliderEl.addEventListener('pointerdown', onSliderInputStart);
                sliderEl.addEventListener('touchstart', onSliderInputStart);
                sliderEl.addEventListener('change', flushPendingInteraction);
            }

            const allSliders = [
                rngScale, rngWidth, rngHeight, rngRot, rngSpacing, rngVert, rngOpacity, rngNatBrow, rngRound, rngLRot, rngRRot,
                rngBright, rngContrast, rngSaturate, rngImgZoom, rngImgPanX, rngImgPanY,
                document.getElementById('rngGuideLineWidth'), document.getElementById('rngGuideLineOpacity'),
                document.getElementById('rngGuideL1'), document.getElementById('rngGuideL2'), document.getElementById('rngGuideL3'),
                document.getElementById('rngGuideR1'), document.getElementById('rngGuideR2'), document.getElementById('rngGuideR3'),
                document.getElementById('rngGuideH1'), document.getElementById('rngGuideH2'), document.getElementById('rngGuideH3')
            ];
            allSliders.forEach(bindSliderHistory);

            if (selectColorPreset) {
                if (["#000000", "#262626", "#3D2B1F", "#5C4033", "#4E4B46", "#8B5A2B"].includes(curHex.toUpperCase())) {
                    selectColorPreset.value = curHex.toUpperCase();
                } else {
                    selectColorPreset.value = "custom";
                }
                selectColorPreset.onchange = function() {
                    if (this.value !== 'custom') {
                        recordHistory();
                        curHex = this.value;
                        if (inputColorPicker) inputColorPicker.value = curHex;
                        updateColorDisplay();
                        requestDraw();
                    }
                };
            }

            if (inputColorPicker) {
                inputColorPicker.oninput = function() {
                    onSliderInputStart();
                    curHex = this.value.toUpperCase();
                    if (selectColorPreset) selectColorPreset.value = 'custom';
                    updateColorDisplay();
                    requestDraw();
                };
                inputColorPicker.addEventListener('change', flushPendingInteraction);
            }
            updateColorDisplay();

            // 탭 전환
            const tabBtn1 = document.getElementById('tabBtn1');
            const tabBtn2 = document.getElementById('tabBtn2');
            const tabContent1 = document.getElementById('tabContent1');
            const tabContent2 = document.getElementById('tabContent2');

            tabBtn1.onclick = function() {
                tabBtn1.classList.add('active');
                tabBtn2.classList.remove('active');
                tabContent1.style.display = 'block';
                tabContent2.style.display = 'none';
                notifyHeight();
            };

            tabBtn2.onclick = function() {
                tabBtn2.classList.add('active');
                tabBtn1.classList.remove('active');
                tabContent2.style.display = 'block';
                tabContent1.style.display = 'none';
                notifyHeight();
            };

            rngScale.oninput = function() {
                onSliderInputStart();
                curScale = parseFloat(this.value);
                document.getElementById('valScale').innerText = curScale + '%';
                updateGuideRatios();
                requestDraw();
            };

            rngWidth.oninput = function() {
                onSliderInputStart();
                curWidth = parseFloat(this.value);
                document.getElementById('valWidth').innerText = curWidth + '%';
                updateGuideRatios();
                requestDraw();
            };

            rngHeight.oninput = function() {
                onSliderInputStart();
                curHeight = parseFloat(this.value);
                document.getElementById('valHeight').innerText = curHeight + '%';
                updateGuideRatios();
                requestDraw();
            };

            rngRot.oninput = function() {
                onSliderInputStart();
                curRot = parseFloat(this.value);
                document.getElementById('valRot').innerText = curRot + '°';
                requestDraw();
            };

            rngSpacing.oninput = function() {
                onSliderInputStart();
                curSpacing = parseFloat(this.value);
                document.getElementById('valSpacing').innerText = curSpacing + 'px';
                requestDraw();
            };

            // 위아래 위치 — 옮긴 '차이' 만큼 두 눈썹을 같이 움직인다.
            // 절대 위치로 두면 손으로 끌어 옮겼을 때 조절바와 어긋난다.
            if (rngVert) {
                rngVert.oninput = function() {
                    onSliderInputStart();
                    const v = parseFloat(this.value);
                    const d = v - curVert;
                    curVert = v;
                    leftPos.y += d;
                    rightPos.y += d;
                    document.getElementById('valVert').innerText = Math.round(v) + 'px';
                    requestDraw();
                };
            }

            rngOpacity.oninput = function() {
                onSliderInputStart();
                curOpacity = parseFloat(this.value);
                document.getElementById('valOpacity').innerText = curOpacity + '%';
                requestDraw();
            };

            if (rngNatBrow) {
                if (!CFG.nat_brows || !window.BrowErase) {
                    // 얼굴 인식이 눈썹을 못 잰 사진 — 덮을 자리를 모른다
                    rngNatBrow.disabled = true;
                    const v = document.getElementById('valNatBrow');
                    if (v) v.innerText = '눈썹 인식 안 됨';
                }
                rngNatBrow.oninput = function() {
                    onSliderInputStart();
                    curNatBrow = parseFloat(this.value);
                    document.getElementById('valNatBrow').innerText = curNatBrow + '%';
                    invalidateBgFilter();
                    requestDraw();
                };
            }

            rngRound.oninput = function() {
                onSliderInputStart();
                curRound = parseFloat(this.value);
                document.getElementById('valRound').innerText = curRound + '%';
                requestDraw();
            };

            rngLRot.oninput = function() {
                onSliderInputStart();
                curLRot = parseFloat(this.value);
                document.getElementById('valLRot').innerText = curLRot + '°';
                requestDraw();
            };

            rngRRot.oninput = function() {
                onSliderInputStart();
                curRRot = parseFloat(this.value);
                document.getElementById('valRRot').innerText = curRRot + '°';
                requestDraw();
            };

            // 이미지 편집 이벤트 (필터 변경 시 오프스크린 배경 갱신)
            rngBright.oninput = function() {
                onSliderInputStart();
                curBright = parseFloat(this.value);
                document.getElementById('valBright').innerText = curBright + '%';
                invalidateBgFilter();
                requestDraw();
            };

            rngContrast.oninput = function() {
                onSliderInputStart();
                curContrast = parseFloat(this.value);
                document.getElementById('valContrast').innerText = curContrast + '%';
                invalidateBgFilter();
                requestDraw();
            };

            rngSaturate.oninput = function() {
                onSliderInputStart();
                curSaturate = parseFloat(this.value);
                document.getElementById('valSaturate').innerText = curSaturate + '%';
                invalidateBgFilter();
                requestDraw();
            };

            rngImgZoom.oninput = function() {
                onSliderInputStart();
                curImgZoom = parseFloat(this.value);
                document.getElementById('valImgZoom').innerText = curImgZoom + '%';
                requestDraw();
            };

            rngImgPanX.oninput = function() {
                onSliderInputStart();
                curImgPanX = parseFloat(this.value);
                document.getElementById('valImgPanX').innerText = curImgPanX + 'px';
                requestDraw();
            };

            rngImgPanY.oninput = function() {
                onSliderInputStart();
                curImgPanY = parseFloat(this.value);
                document.getElementById('valImgPanY').innerText = curImgPanY + 'px';
                requestDraw();
            };

            document.getElementById('btnReset').onclick = function() {
                recordHistory();
                leftPos = { x: initLX, y: initLY };
                rightPos = { x: initRX, y: initRY };
                curScale = 100; curWidth = 100; curHeight = 100;
                curRot = 0; curSpacing = 0; curVert = 0; curOpacity = 85; curNatBrow = 100;
                curRound = 0; curLRot = 0; curRRot = 0;

                curBright = 100; curContrast = 100; curSaturate = 100;
                curImgZoom = 100; curImgPanX = 0; curImgPanY = 0;

                curHex = CFG.cur_hex;
                browMoveTarget = 'both';
                guideL1 = -48; guideL2 = 12; guideL3 = 48;
                guideR1 = -48; guideR2 = -12; guideR3 = 48;
                guideH1 = -48; guideH2 = 0; guideH3 = 48;
                guideLineWidth = 1.0;
                guideLineOpacity = 80;
                show3Guides = false;
                showHGuides = false;
                liveMirror = false;

                syncAllControlsFromState();
                invalidateBgFilter();
                syncGuideSliders();
                updateGuideRatios();
                draw();
            };

            function setBrowMoveTarget(target) {
                if (browMoveTarget !== target) {
                    recordHistory();
                    browMoveTarget = target;
                    document.querySelectorAll('.brow-move-target-btn').forEach(b => {
                        b.classList.toggle('active', b.getAttribute('data-target') === target);
                    });
                    requestDraw();
                }
            }

            const btnBrowMoveBoth = document.getElementById('btnBrowMoveBoth');
            if (btnBrowMoveBoth) btnBrowMoveBoth.addEventListener('click', () => setBrowMoveTarget('both'));
            const btnBrowMoveAuto = document.getElementById('btnBrowMoveAuto');
            if (btnBrowMoveAuto) btnBrowMoveAuto.addEventListener('click', () => setBrowMoveTarget('auto'));
            const btnBrowMoveLeft = document.getElementById('btnBrowMoveLeft');
            if (btnBrowMoveLeft) btnBrowMoveLeft.addEventListener('click', () => setBrowMoveTarget('left'));
            const btnBrowMoveRight = document.getElementById('btnBrowMoveRight');
            if (btnBrowMoveRight) btnBrowMoveRight.addEventListener('click', () => setBrowMoveTarget('right'));

            const btnSyncYLevel = document.getElementById('btnSyncYLevel');
            if (btnSyncYLevel) {
                btnSyncYLevel.addEventListener('click', function() {
                    recordHistory();
                    const avgY = (leftPos.y + rightPos.y) / 2.0;
                    leftPos.y = avgY;
                    rightPos.y = avgY;
                    requestDraw();
                });
            }

            // 📐 3등분선 가이드 컨트롤 & 미러링 바인딩
            const chkShow3Guides = document.getElementById('chkShow3Guides');
            if (chkShow3Guides) {
                chkShow3Guides.onchange = function() {
                    recordHistory();
                    show3Guides = this.checked;
                    requestDraw();
                };
            }

            const chkShowHGuides = document.getElementById('chkShowHGuides');
            if (chkShowHGuides) {
                chkShowHGuides.onchange = function() {
                    recordHistory();
                    showHGuides = this.checked;
                    requestDraw();
                };
            }

            const chkLiveMirror = document.getElementById('chkLiveMirror');
            if (chkLiveMirror) {
                chkLiveMirror.onchange = function() {
                    recordHistory();
                    liveMirror = this.checked;
                };
            }

            // 🎚️ 선 굵기 & 투명도 바인딩
            const elGuideLineWidth = document.getElementById('rngGuideLineWidth');
            if (elGuideLineWidth) {
                elGuideLineWidth.oninput = function() {
                    onSliderInputStart();
                    guideLineWidth = parseFloat(this.value);
                    document.getElementById('valGuideLineWidth').innerText = guideLineWidth.toFixed(1) + 'px';
                    requestDraw();
                };
            }

            const elGuideLineOpacity = document.getElementById('rngGuideLineOpacity');
            if (elGuideLineOpacity) {
                elGuideLineOpacity.oninput = function() {
                    onSliderInputStart();
                    guideLineOpacity = parseFloat(this.value);
                    document.getElementById('valGuideLineOpacity').innerText = Math.round(guideLineOpacity) + '%';
                    requestDraw();
                };
            }



            // 좌측 세로선 슬라이더
            const elGuideL1 = document.getElementById('rngGuideL1');
            if (elGuideL1) elGuideL1.oninput = function() {
                onSliderInputStart();
                guideL1 = parseFloat(this.value);
                if (liveMirror) guideR3 = -guideL1;
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };
            const elGuideL2 = document.getElementById('rngGuideL2');
            if (elGuideL2) elGuideL2.oninput = function() {
                onSliderInputStart();
                guideL2 = parseFloat(this.value);
                if (liveMirror) guideR2 = -guideL2;
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };
            const elGuideL3 = document.getElementById('rngGuideL3');
            if (elGuideL3) elGuideL3.oninput = function() {
                onSliderInputStart();
                guideL3 = parseFloat(this.value);
                if (liveMirror) guideR1 = -guideL3;
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };

            // 우측 세로선 슬라이더 (자유 조절)
            const elGuideR1 = document.getElementById('rngGuideR1');
            if (elGuideR1) elGuideR1.oninput = function() {
                onSliderInputStart();
                guideR1 = parseFloat(this.value);
                if (liveMirror) guideL3 = -guideR1;
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };
            const elGuideR2 = document.getElementById('rngGuideR2');
            if (elGuideR2) elGuideR2.oninput = function() {
                onSliderInputStart();
                guideR2 = parseFloat(this.value);
                if (liveMirror) guideL2 = -guideR2;
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };
            const elGuideR3 = document.getElementById('rngGuideR3');
            if (elGuideR3) elGuideR3.oninput = function() {
                onSliderInputStart();
                guideR3 = parseFloat(this.value);
                if (liveMirror) guideL1 = -guideR3;
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };

            // 가로선 슬라이더 (미러링 없음)
            const elGuideH1 = document.getElementById('rngGuideH1');
            if (elGuideH1) elGuideH1.oninput = function() {
                onSliderInputStart();
                guideH1 = parseFloat(this.value);
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };
            const elGuideH2 = document.getElementById('rngGuideH2');
            if (elGuideH2) elGuideH2.oninput = function() {
                onSliderInputStart();
                guideH2 = parseFloat(this.value);
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };
            const elGuideH3 = document.getElementById('rngGuideH3');
            if (elGuideH3) elGuideH3.oninput = function() {
                onSliderInputStart();
                guideH3 = parseFloat(this.value);
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
            };

            // 🪞 세로선 미러링 버튼 클릭
            const btnMirror = document.getElementById('btnMirrorLeftToRight');
            if (btnMirror) {
                btnMirror.onclick = function() {
                    recordHistory();
                    guideR1 = -guideL3;
                    guideR2 = -guideL2;
                    guideR3 = -guideL1;
                    syncGuideSliders();
                    updateGuideRatios();
                    draw();
                };
            }

            // 🔄 세로선 가이드 초기화 버튼 클릭
            const btnResetGuides = document.getElementById('btnResetGuides');
            if (btnResetGuides) {
                btnResetGuides.onclick = function() {
                    recordHistory();
                    guideL1 = -48; guideL2 = 12; guideL3 = 48;
                    guideR1 = -48; guideR2 = -12; guideR3 = 48;
                    syncGuideSliders();
                    updateGuideRatios();
                    draw();
                };
            }

            // 🔄 가로선 가이드 초기화 버튼 클릭
            const btnResetHGuides = document.getElementById('btnResetHGuides');
            if (btnResetHGuides) {
                btnResetHGuides.onclick = function() {
                    recordHistory();
                    guideH1 = -48; guideH2 = 0; guideH3 = 48;
                    syncGuideSliders();
                    updateGuideRatios();
                    draw();
                };
            }




            function renderWatermark(ctx, width, startY, height) {
                const line1 = '⚠️ [시술 상담 안내] 본 이미지는 디자인 상담을 위한 가상 시뮬레이션이며';
                const line2 = '실제 시술 후 모양, 색상 및 결과와 차이가 있을 수 있습니다.';

                // 배너 배경 및 상단 골드 라인
                ctx.fillStyle = '#181614';
                ctx.fillRect(0, startY, width, height);

                ctx.fillStyle = '#D4AF37';
                ctx.fillRect(0, startY, width, 2);

                // 반응형 폰트 크기 계산 (화면 폭에 맞춰 짤리지 않게 자동 축소)
                let fontSize = Math.max(12, Math.min(22, Math.round(width * 0.028)));
                ctx.font = '600 ' + fontSize + 'px Pretendard, "Malgun Gothic", sans-serif';
                ctx.fillStyle = '#C8C4BE';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                const lineHeight = Math.round(fontSize * 1.35);
                const centerY = startY + (height / 2);
                ctx.fillText(line1, width / 2, centerY - (lineHeight / 2));
                ctx.fillText(line2, width / 2, centerY + (lineHeight / 2));
            }

            function createOptimizedThumbnail(srcCanvas, maxDim = 1000) {
                const sw = srcCanvas.width;
                const sh = srcCanvas.height;
                let tw = sw;
                let th = sh;
                if (sw > maxDim || sh > maxDim) {
                    if (sw > sh) {
                        tw = maxDim;
                        th = Math.round((sh * maxDim) / sw);
                    } else {
                        th = maxDim;
                        tw = Math.round((sw * maxDim) / sh);
                    }
                }
                const tc = document.createElement('canvas');
                tc.width = tw;
                tc.height = th;
                const tCtx = tc.getContext('2d');
                tCtx.drawImage(srcCanvas, 0, 0, tw, th);
                return tc.toDataURL('image/jpeg', 0.85);
            }

            // 💾 1. 변형된 예상 디자인 고화질 PNG 다운로드 & 하단 히스토리 자동 보관
            document.getElementById('btnDownloadAfter').onclick = function() {
                const wasDragging = isDragging;
                isDragging = false;
                draw();

                const exportCanvas = document.createElement('canvas');
                const w = canvas.width;
                const h = canvas.height;
                const footerH = Math.max(56, Math.round(h * 0.075));
                exportCanvas.width = w;
                exportCanvas.height = h + footerH;
                const expCtx = exportCanvas.getContext('2d');

                // 1) 배경 단색 채움 후 렌더링된 메인 디자인 캔버스 100% 꽉 채워 복사 (우측 여백줄 완전 방지)
                expCtx.fillStyle = '#181614';
                expCtx.fillRect(0, 0, w, h + footerH);
                expCtx.drawImage(canvas, 0, 0, w, h);

                // 2) 하단 2줄 법적 안내문 워터마크 배너
                renderWatermark(expCtx, w, h, footerH);

                const fileName = getDownloadFilename('eyebrow_preview_after');
                const highResDataUrl = exportCanvas.toDataURL('image/png', 1.0);
                const thumbDataUrl = createOptimizedThumbnail(exportCanvas, 720);
                // 히스토리에는 JPEG 으로 담는다. PNG 원본은 한 장에 2.5MB 라
                // 여러 장 쌓이면 그것만으로 수십 MB 다. 내려받는 파일은 PNG 그대로다.
                const histDataUrl = exportCanvas.toDataURL('image/jpeg', 0.92);
                const histFileName = fileName.split('.png').join('.jpg');

                const link = document.createElement('a');
                link.download = fileName;
                link.href = highResDataUrl;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                // 3. 자동으로 하단 히스토리에 보관 (12개 이상 무제한 누적)
                addHistoryItem('after', '✨ 예상 디자인', histDataUrl, histFileName, thumbDataUrl, w / h);
                exportCanvas.width = 0; exportCanvas.height = 0;   // 큰 캔버스 즉시 반납

                if (wasDragging) {
                    isDragging = true;
                    requestDraw();
                }
            };

            document.getElementById('btnDownloadComp').onclick = function() {
                const wasDragging = isDragging;
                isDragging = false;
                draw();

                const compCanvas = document.createElement('canvas');
                const w = canvas.width || bgImg.naturalWidth || bgImg.width;
                const h = canvas.height || bgImg.naturalHeight || bgImg.height;
                const footerH = Math.max(56, Math.round(h * 0.075));
                compCanvas.width = w * 2 + 24;
                compCanvas.height = h + 80 + footerH;
                const cCtx = compCanvas.getContext('2d');

                // 배경
                cCtx.fillStyle = '#181818';
                cCtx.fillRect(0, 0, compCanvas.width, compCanvas.height);

                // 상단 타이틀
                cCtx.fillStyle = '#D4AF37';
                cCtx.font = 'bold ' + Math.max(20, Math.round(w * 0.045)) + 'px Pretendard, "Malgun Gothic", sans-serif';
                cCtx.textAlign = 'center';
                cCtx.textBaseline = 'middle';
                cCtx.fillText('✨ Brow Preview Studio — 시술 상담 Before / After 비교', compCanvas.width / 2, 40);

                // 좌측: 시술 전 원본
                cCtx.drawImage(bgImg, 0, 75, w, h);
                
                // 우측: 실시간 변형된 캔버스
                cCtx.drawImage(canvas, w + 24, 75, w, h);

                // 하단 2줄 워터마크 안내 배너
                renderWatermark(cCtx, compCanvas.width, h + 80, footerH);

                const fileName = getDownloadFilename('eyebrow_before_after');
                const highResDataUrl = compCanvas.toDataURL('image/png', 1.0);
                const thumbDataUrl = createOptimizedThumbnail(compCanvas, 720);
                // 히스토리에는 JPEG 으로 담는다. PNG 원본은 한 장에 2.5MB 라
                // 여러 장 쌓이면 그것만으로 수십 MB 다. 내려받는 파일은 PNG 그대로다.
                const histDataUrl = compCanvas.toDataURL('image/jpeg', 0.92);
                const histFileName = fileName.split('.png').join('.jpg');

                const link = document.createElement('a');
                link.download = fileName;
                link.href = highResDataUrl;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                // 3. 자동으로 하단 히스토리에 보관 (12개 이상 무제한 누적)
                // 2분할 그림은 가로 두 장 + 위 머리글 80px 이 붙어 비율이 다르다
                addHistoryItem('comp', '🖼️ 2분할 비교', histDataUrl, histFileName, thumbDataUrl,
                               compCanvas.width / (h + 80));
                compCanvas.width = 0; compCanvas.height = 0;

                if (wasDragging) {
                    isDragging = true;
                    requestDraw();
                }
            };
        }

        // ====================================================================
        // 🗂️ 상담 디자인 생성 히스토리 & 팝업 모달 & 2열 종합 비교표 엔진
        // ====================================================================
        const STORAGE_KEY = 'brow_preview_studio_history_v2';
        // 보관 장수. 카드로 뿌릴 때 한 장이 풀려 수 MB 를 차지해서, 저사양
        // 기기를 생각해 여섯 장으로 줄였다. 썸네일도 720px 로 낮췄다.
        // 16장 × PNG 2.5MB(=40MB) 로 들고 있던 것이 메모리 부족의 주된 원인이었다.
        const MAX_HISTORY_ITEMS = 6;

        function syncGlobalMemoryCache(items) {
            try {
                if (window.top && window.top !== window) {
                    window.top.__BROW_STUDIO_HISTORY_CACHE__ = items;
                }
            } catch(e) {}
            window.__BROW_STUDIO_HISTORY_CACHE__ = items;
        }

        function getGlobalMemoryCache() {
            try {
                if (window.top && window.top !== window && window.top.__BROW_STUDIO_HISTORY_CACHE__) {
                    return window.top.__BROW_STUDIO_HISTORY_CACHE__;
                }
            } catch(e) {}
            return window.__BROW_STUDIO_HISTORY_CACHE__ || null;
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

        /** @param aspect 안내문구 배너를 뺀 '그림만' 의 가로/세로 비.
         *               비교 보기에서 배너를 잘라낼 때 쓴다. */
        function addHistoryItem(type, tagText, highResDataUrl, fileName, thumbDataUrl, aspect) {
            const now = new Date();
            const pad = function(n) { return String(n).padStart(2, '0'); };
            const timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
            
            const currentDesignName = CFG.safe_design_name;
            const labelText = tagText || (type === 'comp' ? '🖼️ 2분할 비교' : '✨ 예상 디자인');

            const item = {
                id: 'brow_hist_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
                type: type || 'after',
                tagText: labelText,
                designName: `${currentDesignName} (${curHex})`,
                color: curHex,
                dataUrl: highResDataUrl,
                thumbUrl: thumbDataUrl || highResDataUrl,
                filename: fileName || getDownloadFilename('eyebrow_preview'),
                timeStr: timeStr,
                // 비교 화면의 이름표는 '고른 디자인 이름' 으로 단다.
                // 상담할 때 원장님과 고객이 서로 가리키는 말이 디자인 이름이다.
                compareLabel: currentDesignName + (type === 'comp' ? ' · 2분할' : ''),
                aspect: aspect || (canvas.width / Math.max(1, canvas.height))
            };

            historyItems.unshift(item);
            if (historyItems.length > MAX_HISTORY_ITEMS) {
                historyItems.pop();
            }

            saveHistoryToStorage();
            renderHistoryCards();
            if (window.__blHistory && window.__blHistory.onChange) window.__blHistory.onChange();
        }

        function renderHistoryCards() {
            const historyList = document.getElementById('historyList');
            const historyCount = document.getElementById('historyCount');
            if (!historyList || !historyCount) return;

            historyCount.innerText = historyItems.length + '개 저장됨';

            if (historyItems.length === 0) {
                historyList.innerHTML = `
                    <div class="history-empty" id="historyEmpty">
                        <span>✨ [Before/After 2분할 비교 저장] 또는 [변형된 예상 디자인 고화질 저장] 버튼을 누르면 이곳에 1행 2열 큰 카드 형태로 결과물이 자동 보관됩니다. (클릭 시 확대 및 재다운로드 가능)</span>
                    </div>
                `;
                notifyHeight();
                return;
            }

            historyList.innerHTML = '';
            historyItems.forEach((item, idx) => {
                const card = document.createElement('div');
                card.className = 'history-card';

                // 1. 세로로 꽉 차는 큰 썸네일 래퍼
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

                // 2. 카드 정보 바
                const infoDiv = document.createElement('div');
                infoDiv.className = 'history-card-info';
                const tagClass = item.type === 'comp' ? 'tag-comp' : 'tag-after';
                infoDiv.innerHTML = `
                    <span class="history-card-tag ${tagClass}">${item.tagText || '✨ 눈썹 디자인'}</span>
                    <span class="history-card-time">🕒 ${item.timeStr} <strong style="color:#D4AF37; margin-left:4px;">#${historyItems.length - idx}</strong></span>
                `;
                card.appendChild(infoDiv);

                // 3. 카드 하단 액션 버튼
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

        /* 모바일 레이어(mobile-ui.js)가 '비교 보기'와 '전체 저장'에 쓰도록
           히스토리를 넘겨준다. 히스토리 자체는 여기서만 관리한다. */
        window.__blHistory = {
            items: function () { return historyItems.slice(); },
            download: function (item) { downloadHistoryItem(item); },
            // 비교의 '시술 전' 은 언제나 처음 불러온 맨얼굴이다.
            // bg_b64 는 입술 작업이 얹힌 사진일 수 있다.
            photo: function () { return CFG.orig_b64 || CFG.bg_b64; },
            onChange: null            // 항목이 바뀌면 모바일 레이어가 받는다
        };

        function downloadHistoryItem(item) {
            if (!item) return;
            const src = item.dataUrl || item.thumbUrl;
            if (!src) return;
            const fileName = item.filename || getDownloadFilename('eyebrow_preview');
            
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

        function openHistoryModal(item, triggerElem) {
            currentModalItem = item;
            const modal = document.getElementById('historyModal');
            const modalImg = document.getElementById('modalImg');
            const modalTitle = document.getElementById('modalTitle');
            const modalContent = modal ? modal.querySelector('.history-modal-content') : null;
            if (!modal || !modalImg || !modalTitle) return;

            modalImg.src = item.dataUrl || item.thumbUrl;
            modalTitle.innerHTML = '✨ ' + (item.designName || item.tagText) + 
                                   ' <span style="font-size:0.85rem; color:#A89F91; font-weight:normal; margin-left:8px;">(🕒 ' + item.timeStr + ' / 색상: ' + (item.color || curHex) + ')</span>';
            
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

        const btnCloseModal = document.getElementById('btnCloseModal');
        if (btnCloseModal) btnCloseModal.onclick = closeHistoryModal;
        const btnModalCloseSecondary = document.getElementById('btnModalCloseSecondary');
        if (btnModalCloseSecondary) btnModalCloseSecondary.onclick = closeHistoryModal;
        const modalOverlay = document.getElementById('modalOverlay');
        if (modalOverlay) modalOverlay.onclick = closeHistoryModal;
        window.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeHistoryModal();
        });

        const btnModalDownload = document.getElementById('btnModalDownload');
        if (btnModalDownload) {
            btnModalDownload.onclick = function() {
                if (currentModalItem) {
                    downloadHistoryItem(currentModalItem);
                }
            };
        }

        const btnModalOpenTab = document.getElementById('btnModalOpenTab');
        if (btnModalOpenTab) {
            btnModalOpenTab.onclick = function() {
                if (currentModalItem && (currentModalItem.dataUrl || currentModalItem.thumbUrl)) {
                    const w = window.open('', '_blank');
                    if (w) {
                        const imgSrc = currentModalItem.dataUrl || currentModalItem.thumbUrl;
                        w.document.write('<!DOCTYPE html><html><head><title>Brow Preview Studio - ' + (currentModalItem.tagText || '결과물') + '</title><style>body{margin:0;background:#111;display:flex;justify-content:center;align-items:center;min-height:100vh;}img{max-width:100%;height:auto;box-shadow:0 0 30px rgba(0,0,0,0.8);}</style></head><body><img src="' + imgSrc + '"></body></html>');
                        w.document.close();
                    } else {
                        window.open(currentModalItem.dataUrl || currentModalItem.thumbUrl, '_blank');
                    }
                }
            };
        }

        const btnClearHistory = document.getElementById('btnClearHistory');
        if (btnClearHistory) {
            btnClearHistory.onclick = function() {
                if (historyItems.length === 0) return;
                if (confirm('저장된 눈썹 디자인 상담 히스토리 내역을 모두 비우시겠습니까?')) {
                    historyItems.length = 0;
                    syncGlobalMemoryCache([]);
                    try {
                        sessionStorage.removeItem(STORAGE_KEY);
                    } catch(e) {}
                    renderHistoryCards();
                }
            };
        }



        function getMousePos(e) {
            const rect = canvas.getBoundingClientRect();
            const rawX = (e.clientX - rect.left) * (canvas.width / rect.width);
            const rawY = (e.clientY - rect.top) * (canvas.height / rect.height);
            const zoomF = curImgZoom / 100.0;
            return {
                x: (rawX - canvas.width / 2.0 - curImgPanX) / zoomF + canvas.width / 2.0,
                y: (rawY - canvas.height / 2.0 - curImgPanY) / zoomF + canvas.height / 2.0
            };
        }

        let isPanningPhoto = false;
        let startPanMouseX = 0;
        let startPanMouseY = 0;
        let startPanX = 0;
        let startPanY = 0;

        function findHoveredGuideLine(pos) {
            const scaleFactor = (curScale / 100.0);
            const wFactor = (curWidth / 100.0);
            const hFactor = (curHeight / 100.0);
            const targetW = rawLImg.width * scaleFactor * wFactor;
            const targetH = rawLImg.height * scaleFactor * hFactor;

            const lxCenter = leftPos.x - (curSpacing / 2.0);
            const rxCenter = rightPos.x + (curSpacing / 2.0);
            const yFaceCenter = (leftPos.y + rightPos.y) / 2.0;

            const tol = Math.max(10, 14 / (curImgZoom / 100.0));

            // 1. 세로선 감지
            if (show3Guides) {
                if (Math.abs(pos.y - leftPos.y) <= targetH * 1.5) {
                    const l1_X = lxCenter + (targetW * guideL1 / 100.0);
                    const l2_X = lxCenter + (targetW * guideL2 / 100.0);
                    const l3_X = lxCenter + (targetW * guideL3 / 100.0);
                    if (Math.abs(pos.x - l1_X) <= tol) return 'L1';
                    if (Math.abs(pos.x - l2_X) <= tol) return 'L2';
                    if (Math.abs(pos.x - l3_X) <= tol) return 'L3';
                }

                if (Math.abs(pos.y - rightPos.y) <= targetH * 1.5) {
                    const r1_X = rxCenter + (targetW * guideR1 / 100.0);
                    const r2_X = rxCenter + (targetW * guideR2 / 100.0);
                    const r3_X = rxCenter + (targetW * guideR3 / 100.0);
                    if (Math.abs(pos.x - r1_X) <= tol) return 'R1';
                    if (Math.abs(pos.x - r2_X) <= tol) return 'R2';
                    if (Math.abs(pos.x - r3_X) <= tol) return 'R3';
                }
            }

            // 2. 가로선 감지
            if (showHGuides) {
                const h1_Y = yFaceCenter + (targetH * guideH1 / 100.0);
                const h2_Y = yFaceCenter + (targetH * guideH2 / 100.0);
                const h3_Y = yFaceCenter + (targetH * guideH3 / 100.0);

                const minX = lxCenter - targetW * 0.7;
                const maxX = rxCenter + targetW * 0.7;

                if (pos.x >= minX && pos.x <= maxX) {
                    if (Math.abs(pos.y - h1_Y) <= tol) return 'H1';
                    if (Math.abs(pos.y - h2_Y) <= tol) return 'H2';
                    if (Math.abs(pos.y - h3_Y) <= tol) return 'H3';
                }
            }

            return null;
        }

        canvas.addEventListener('contextmenu', function(e) {
            e.preventDefault();
        });

        canvas.addEventListener('mousedown', function(e) {
            interactionInitialState = captureStateSnapshot();

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
                const pos = getMousePos(e);
                const hLine = findHoveredGuideLine(pos);
                if (hLine) {
                    activeGuideDrag = hLine;
                    isDragging = false;
                    startX = pos.x;
                    startY = pos.y;
                    requestDraw();
                    return;
                }

                // 🖱️ 좌클릭: 눈썹 위치 이동
                activeBrowDrag = determineActiveBrowDrag(pos);
                isDragging = true;
                startX = pos.x;
                startY = pos.y;
                requestDraw();
            }
        });

        canvas.addEventListener('mousemove', function(e) {
            if (!isDragging && !activeGuideDrag && !isPanningPhoto) {
                const pos = getMousePos(e);
                const hLine = findHoveredGuideLine(pos);
                if (hLine) {
                    canvas.style.cursor = (hLine.startsWith('H')) ? 'ns-resize' : 'ew-resize';
                } else {
                    canvas.style.cursor = 'grab';
                }
            }
        });

        window.addEventListener('mousemove', function(e) {
            if (isPanningPhoto) {
                const dx = e.clientX - startPanMouseX;
                const dy = e.clientY - startPanMouseY;
                curImgPanX = Math.min(400, Math.max(-400, Math.round(startPanX + dx)));
                curImgPanY = Math.min(400, Math.max(-400, Math.round(startPanY + dy)));

                const rngPanX = document.getElementById('rngImgPanX');
                const rngPanY = document.getElementById('rngImgPanY');
                const valPanX = document.getElementById('valImgPanX');
                const valPanY = document.getElementById('valImgPanY');
                if (rngPanX) rngPanX.value = curImgPanX;
                if (rngPanY) rngPanY.value = curImgPanY;
                if (valPanX) valPanX.innerText = curImgPanX + 'px';
                if (valPanY) valPanY.innerText = curImgPanY + 'px';

                requestDraw();
                return;
            }

            if (activeGuideDrag) {
                const pos = getMousePos(e);
                const scaleFactor = (curScale / 100.0);
                const wFactor = (curWidth / 100.0);
                const hFactor = (curHeight / 100.0);
                const targetW = rawLImg.width * scaleFactor * wFactor;
                const targetH = rawLImg.height * scaleFactor * hFactor;
                const lxCenter = leftPos.x - (curSpacing / 2.0);
                const rxCenter = rightPos.x + (curSpacing / 2.0);
                const yFaceCenter = (leftPos.y + rightPos.y) / 2.0;

                if (activeGuideDrag === 'L1') {
                    guideL1 = Math.min(0, Math.max(-70, ((pos.x - lxCenter) / targetW) * 100));
                    if (liveMirror) guideR3 = -guideL1;
                } else if (activeGuideDrag === 'L2') {
                    guideL2 = Math.min(40, Math.max(-40, ((pos.x - lxCenter) / targetW) * 100));
                    if (liveMirror) guideR2 = -guideL2;
                } else if (activeGuideDrag === 'L3') {
                    guideL3 = Math.min(70, Math.max(0, ((pos.x - lxCenter) / targetW) * 100));
                    if (liveMirror) guideR1 = -guideL3;
                } else if (activeGuideDrag === 'R1') {
                    guideR1 = Math.min(0, Math.max(-70, ((pos.x - rxCenter) / targetW) * 100));
                    if (liveMirror) guideL3 = -guideR1;
                } else if (activeGuideDrag === 'R2') {
                    guideR2 = Math.min(40, Math.max(-40, ((pos.x - rxCenter) / targetW) * 100));
                    if (liveMirror) guideL2 = -guideR2;
                } else if (activeGuideDrag === 'R3') {
                    guideR3 = Math.min(70, Math.max(0, ((pos.x - rxCenter) / targetW) * 100));
                    if (liveMirror) guideL1 = -guideR3;
                } else if (activeGuideDrag === 'H1') {
                    guideH1 = Math.min(0, Math.max(-80, ((pos.y - yFaceCenter) / targetH) * 100));
                } else if (activeGuideDrag === 'H2') {
                    guideH2 = Math.min(40, Math.max(-40, ((pos.y - yFaceCenter) / targetH) * 100));
                } else if (activeGuideDrag === 'H3') {
                    guideH3 = Math.min(80, Math.max(0, ((pos.y - yFaceCenter) / targetH) * 100));
                }
                syncGuideSliders();
                updateGuideRatios();
                requestDraw();
                return;
            }

            if (!isDragging) return;
            const pos = getMousePos(e);
            const dx = pos.x - startX;
            const dy = pos.y - startY;

            if (activeBrowDrag === 'both') {
                leftPos.x += dx;
                leftPos.y += dy;
                rightPos.x += dx;
                rightPos.y += dy;
            } else if (activeBrowDrag === 'left') {
                leftPos.x += dx;
                leftPos.y += dy;
            } else if (activeBrowDrag === 'right') {
                rightPos.x += dx;
                rightPos.y += dy;
            }

            startX = pos.x;
            startY = pos.y;
            requestDraw();
        });

        window.addEventListener('mouseup', function(e) {
            if (interactionInitialState) {
                if (isStateDifferent(interactionInitialState, captureStateSnapshot())) {
                    recordHistory(interactionInitialState);
                }
                interactionInitialState = null;
            }

            if (isPanningPhoto) {
                isPanningPhoto = false;
                canvas.style.cursor = 'default';
            }
            if (activeGuideDrag) {
                activeGuideDrag = null;
                requestDraw();
            }
            if (isDragging) {
                isDragging = false;
                requestDraw();
            }
        });

        // 🔄 더블클릭 시 원본 이미지 비율(100%) 및 위치로 즉시 복원
        /** 사진 확대·이동을 원래대로 (더블클릭과 두 번 톡톡이 함께 쓴다) */
        function resetPhotoView() {
            recordHistory();
            curImgZoom = 100;
            curImgPanX = 0;
            curImgPanY = 0;

            const rngZoom = document.getElementById('rngImgZoom');
            const valZoom = document.getElementById('valImgZoom');
            const rngPanX = document.getElementById('rngImgPanX');
            const rngPanY = document.getElementById('rngImgPanY');
            const valPanX = document.getElementById('valImgPanX');
            const valPanY = document.getElementById('valImgPanY');
            if (rngZoom) rngZoom.value = 100;
            if (valZoom) valZoom.innerText = '100%';
            if (rngPanX) rngPanX.value = 0;
            if (rngPanY) rngPanY.value = 0;
            if (valPanX) valPanX.innerText = '0px';
            if (valPanY) valPanY.innerText = '0px';

            requestDraw();
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
                    showToast('🔍 사진을 원래 크기로 되돌렸습니다.');
                } else {
                    lastTap = now; lastX = t.clientX; lastY = t.clientY;
                }
            }, { passive: true });
        })();

        // 🔍 PC 마우스 휠 스크롤 줌인 / 줌아웃 기능
        canvas.addEventListener('wheel', function(e) {
            e.preventDefault();
            const step = (e.deltaY < 0) ? 6 : -6;
            const newZoom = Math.min(300, Math.max(50, Math.round(curImgZoom + step)));
            if (newZoom !== curImgZoom) {
                curImgZoom = newZoom;
                const rngZoom = document.getElementById('rngImgZoom');
                const valZoom = document.getElementById('valImgZoom');
                if (rngZoom) rngZoom.value = curImgZoom;
                if (valZoom) valZoom.innerText = curImgZoom + '%';
                requestDraw();
            }
        }, { passive: false });

        // 📱 모바일/태블릿 터치 & 핀치 줌인/줌아웃 기능
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

        canvas.addEventListener('touchstart', function(e) {
            if (!interactionInitialState) interactionInitialState = captureStateSnapshot();

            if (e.touches.length === 1) {
                isPinching = false;
                const touch = e.touches[0];
                const rect = canvas.getBoundingClientRect();
                const rawX = (touch.clientX - rect.left) * (canvas.width / rect.width);
                const rawY = (touch.clientY - rect.top) * (canvas.height / rect.height);
                const zoomF = curImgZoom / 100.0;
                startX = (rawX - canvas.width / 2.0 - curImgPanX) / zoomF + canvas.width / 2.0;
                startY = (rawY - canvas.height / 2.0 - curImgPanY) / zoomF + canvas.height / 2.0;
                activeBrowDrag = determineActiveBrowDrag({ x: startX, y: startY });
                isDragging = true;
                requestDraw();
            } else if (e.touches.length === 2) {
                isDragging = false;
                isPinching = true;
                initialPinchDist = getTouchDist(e.touches[0], e.touches[1]);
                initialPinchZoom = curImgZoom;
                const mid = getTouchMid(e.touches[0], e.touches[1]);
                initialPinchMidX = mid.x;
                initialPinchMidY = mid.y;
                initialPanX = curImgPanX;
                initialPanY = curImgPanY;
            }
        }, { passive: false });

        canvas.addEventListener('touchmove', function(e) {
            if (isPinching && e.touches.length === 2) {
                if (e.cancelable) e.preventDefault();
                const currentDist = getTouchDist(e.touches[0], e.touches[1]);
                if (initialPinchDist > 0) {
                    const factor = currentDist / initialPinchDist;
                    curImgZoom = Math.min(300, Math.max(50, Math.round(initialPinchZoom * factor)));
                    
                    const rngZoom = document.getElementById('rngImgZoom');
                    const valZoom = document.getElementById('valImgZoom');
                    if (rngZoom) rngZoom.value = curImgZoom;
                    if (valZoom) valZoom.innerText = curImgZoom + '%';

                    // 2손가락 이동 시 사진 위치(Pan)도 부드럽게 연동
                    const mid = getTouchMid(e.touches[0], e.touches[1]);
                    const deltaX = mid.x - initialPinchMidX;
                    const deltaY = mid.y - initialPinchMidY;
                    curImgPanX = Math.min(200, Math.max(-200, Math.round(initialPanX + deltaX)));
                    curImgPanY = Math.min(200, Math.max(-200, Math.round(initialPanY + deltaY)));
                    
                    const rngPanX = document.getElementById('rngImgPanX');
                    const rngPanY = document.getElementById('rngImgPanY');
                    const valPanX = document.getElementById('valImgPanX');
                    const valPanY = document.getElementById('valImgPanY');
                    if (rngPanX) rngPanX.value = curImgPanX;
                    if (rngPanY) rngPanY.value = curImgPanY;
                    if (valPanX) valPanX.innerText = curImgPanX + 'px';
                    if (valPanY) valPanY.innerText = curImgPanY + 'px';

                    requestDraw();
                }
            } else if (isDragging && e.touches.length === 1) {
                if (e.cancelable) e.preventDefault();
                const touch = e.touches[0];
                const rect = canvas.getBoundingClientRect();
                const rawX = (touch.clientX - rect.left) * (canvas.width / rect.width);
                const rawY = (touch.clientY - rect.top) * (canvas.height / rect.height);
                const zoomF = curImgZoom / 100.0;
                const mx = (rawX - canvas.width / 2.0 - curImgPanX) / zoomF + canvas.width / 2.0;
                const my = (rawY - canvas.height / 2.0 - curImgPanY) / zoomF + canvas.height / 2.0;
                
                const dx = mx - startX;
                const dy = my - startY;

                if (activeBrowDrag === 'both') {
                    leftPos.x += dx;
                    leftPos.y += dy;
                    rightPos.x += dx;
                    rightPos.y += dy;
                } else if (activeBrowDrag === 'left') {
                    leftPos.x += dx;
                    leftPos.y += dy;
                } else if (activeBrowDrag === 'right') {
                    rightPos.x += dx;
                    rightPos.y += dy;
                }

                startX = mx;
                startY = my;
                requestDraw();
            }
        }, { passive: false });

        canvas.addEventListener('touchend', function(e) {
            if (interactionInitialState) {
                if (isStateDifferent(interactionInitialState, captureStateSnapshot())) {
                    recordHistory(interactionInitialState);
                }
                interactionInitialState = null;
            }

            if (e.touches.length === 0) {
                isDragging = false;
                isPinching = false;
                requestDraw();
            } else if (e.touches.length === 1) {
                isPinching = false;
                const touch = e.touches[0];
                const rect = canvas.getBoundingClientRect();
                const rawX = (touch.clientX - rect.left) * (canvas.width / rect.width);
                const rawY = (touch.clientY - rect.top) * (canvas.height / rect.height);
                const zoomF = curImgZoom / 100.0;
                startX = (rawX - canvas.width / 2.0 - curImgPanX) / zoomF + canvas.width / 2.0;
                startY = (rawY - canvas.height / 2.0 - curImgPanY) / zoomF + canvas.height / 2.0;
                isDragging = true;
            }
        });

        // 즉각 시작 및 다단계 강제 렌더링 스케줄링 (0초 즉각 렌더링 보장)
        initCanvas();
        onAnyImageLoaded();
        [15, 40, 90, 180, 350, 700, 1200].forEach(ms => setTimeout(onAnyImageLoaded, ms));

    })();
