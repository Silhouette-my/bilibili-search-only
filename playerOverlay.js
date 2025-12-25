chrome.storage.sync.get('playerMaskEnabled', (data) => {
  if (data.playerMaskEnabled === false) {
    console.log("播放页遮罩已关闭");
    return;
  }

  (function () {
    // ====== Styles ======
    const style = document.createElement('style');
    style.textContent = `
      .bili-strip {
        position: fixed;
        z-index: 999999;
        background: rgba(0,0,0,0.22);
        backdrop-filter: grayscale(70%) contrast(80%) brightness(99%); /* 无模糊 */
        pointer-events: auto; /* 外侧拦截交互 */
      }

      /* 角帽：只作视觉（透明命中），用遮罩绘制四分之一圆 */
      .bili-corner {
        position: fixed;
        z-index: 1000000;
        width: 12px; height: 12px; /* 会在运行时同步为 RADIUS */
        background: rgba(0,0,0,0.22);
        backdrop-filter: grayscale(70%) contrast(80%) brightness(99%);
        pointer-events: none; /* 不拦截，开孔内保持可点击 */
      }
      .corner-tl { 
        -webkit-mask: radial-gradient(circle at 100% 100%, #000 0px, #000 100%, transparent 100%);
        mask: radial-gradient(circle at 100% 100%, #000 0px, #000 100%, transparent 100%);
      }
      .corner-tr { 
        -webkit-mask: radial-gradient(circle at 0% 100%, #000 0px, #000 100%, transparent 100%);
        mask: radial-gradient(circle at 0% 100%, #000 0px, #000 100%, transparent 100%);
      }
      .corner-bl { 
        -webkit-mask: radial-gradient(circle at 100% 0%, #000 0px, #000 100%, transparent 100%);
        mask: radial-gradient(circle at 100% 0%, #000 0px, #000 100%, transparent 100%);
      }
      .corner-br { 
        -webkit-mask: radial-gradient(circle at 0% 0%, #000 0px, #000 100%, transparent 100%);
        mask: radial-gradient(circle at 0% 0%, #000 0px, #000 100%, transparent 100%);
      }

      /* 聚焦光晕，仅装饰 */
      .bili-focus-ring {
        position: fixed;
        z-index: 1000001;
        pointer-events: none;
        box-shadow:
          0 0 0 2px rgba(255,255,255,0.14),
          0 18px 54px rgba(0,0,0,0.42);
        border-radius: 12px; /* 会在运行时同步为 RADIUS */
        transition: top .2s ease, left .2s ease, width .2s ease, height .2s ease;
      }
    `;
    document.head.appendChild(style);

    // ====== Elements ======
    const topStrip = document.createElement('div');    topStrip.className = 'bili-strip';
    const bottomStrip = document.createElement('div'); bottomStrip.className = 'bili-strip';
    const leftStrip = document.createElement('div');   leftStrip.className = 'bili-strip';
    const rightStrip = document.createElement('div');  rightStrip.className = 'bili-strip';

    const cornerTL = document.createElement('div'); cornerTL.className = 'bili-corner corner-tl';
    const cornerTR = document.createElement('div'); cornerTR.className = 'bili-corner corner-tr';
    const cornerBL = document.createElement('div'); cornerBL.className = 'bili-corner corner-bl';
    const cornerBR = document.createElement('div'); cornerBR.className = 'bili-corner corner-br';

    const ring = document.createElement('div'); ring.className = 'bili-focus-ring';

    document.body.appendChild(topStrip);
    document.body.appendChild(bottomStrip);
    document.body.appendChild(leftStrip);
    document.body.appendChild(rightStrip);
    document.body.appendChild(cornerTL);
    document.body.appendChild(cornerTR);
    document.body.appendChild(cornerBL);
    document.body.appendChild(cornerBR);
    document.body.appendChild(ring);

    // 拦截遮罩区域交互（条带）
    const block = e => { e.stopPropagation(); e.preventDefault(); };
    ['click','mousedown','mouseup','dblclick','contextmenu','wheel','touchstart','touchmove','touchend','pointerdown','pointerup']
      .forEach(evt => {
        [topStrip, bottomStrip, leftStrip, rightStrip]
          .forEach(el => el.addEventListener(evt, block, { passive: false }));
      });

    // ====== Layout constants ======
    const GAP = 12;       // 开孔四周留白
    let RADIUS = 12;      // 默认圆角半径（会尝试读取播放器真实圆角）

    function getPlayer() {
      return (
        document.querySelector('.bpx-player-container') ||
        document.querySelector('.bpx-player-video-wrap') ||
        document.querySelector('.bpx-player')
      );
    }

    function parseRadius(str) {
      if (!str) return NaN;
      const m = str.match(/(\d+(\.\d+)?)px/);
      return m ? parseFloat(m[1]) : NaN;
    }

    function getPlayerRectAndRadius() {
      const player = getPlayer();
      if (!player) return null;
      const r = player.getBoundingClientRect();

      // 尝试匹配播放器自身圆角
      const cs = getComputedStyle(player);
      const radCandidates = [
        parseRadius(cs.borderTopLeftRadius),
        parseRadius(cs.borderTopRightRadius),
        parseRadius(cs.borderBottomLeftRadius),
        parseRadius(cs.borderBottomRightRadius),
      ].filter(x => !Number.isNaN(x));
      if (radCandidates.length) {
        RADIUS = Math.round(radCandidates.reduce((a,b)=>a+b,0) / radCandidates.length);
      }

      return {
        top: Math.max(0, r.top - GAP),
        left: Math.max(0, r.left - GAP),
        right: Math.min(window.innerWidth, r.right + GAP),
        bottom: Math.min(window.innerHeight, r.bottom + GAP),
        width: r.width,
        height: r.height
      };
    }

    function updateOverlay() {
      const rect = getPlayerRectAndRadius();
      if (!rect) return;

      const { top, left, right, bottom } = rect;

      // 同步角帽尺寸与聚焦环圆角
      [cornerTL, cornerTR, cornerBL, cornerBR].forEach(c => {
        c.style.width = `${RADIUS}px`;
        c.style.height = `${RADIUS}px`;
      });
      ring.style.borderRadius = `${RADIUS}px`;

      // 四条直角遮罩（不覆盖开孔矩形）
      topStrip.style.top = '0px';
      topStrip.style.left = '0px';
      topStrip.style.width = '100vw';
      topStrip.style.height = `${top}px`;

      bottomStrip.style.top = `${bottom}px`;
      bottomStrip.style.left = '0px';
      bottomStrip.style.width = '100vw';
      bottomStrip.style.height = `${window.innerHeight - bottom}px`;

      leftStrip.style.top = `${top}px`;
      leftStrip.style.left = '0px';
      leftStrip.style.width = `${left}px`;
      leftStrip.style.height = `${bottom - top}px`;

      rightStrip.style.top = `${top}px`;
      rightStrip.style.left = `${right}px`;
      rightStrip.style.width = `${window.innerWidth - right}px`;
      rightStrip.style.height = `${bottom - top}px`;

      // 四个角帽：贴在开孔四角边界上，颜色一致；只作视觉，不拦截
      cornerTL.style.top = `${top}px`;
      cornerTL.style.left = `${left}px`;

      cornerTR.style.top = `${top}px`;
      cornerTR.style.left = `${right - RADIUS}px`;

      cornerBL.style.top = `${bottom - RADIUS}px`;
      cornerBL.style.left = `${left}px`;

      cornerBR.style.top = `${bottom - RADIUS}px`;
      cornerBR.style.left = `${right - RADIUS}px`;

      // 聚焦光晕包围开孔
      ring.style.top = `${top}px`;
      ring.style.left = `${left}px`;
      ring.style.width = `${right - left}px`;
      ring.style.height = `${bottom - top}px`;
    }

    updateOverlay();
    window.addEventListener('resize', updateOverlay);
    window.addEventListener('scroll', updateOverlay, { passive: true });
    const mo = new MutationObserver(updateOverlay);
    mo.observe(document.body, { childList: true, subtree: true });
  })();
});