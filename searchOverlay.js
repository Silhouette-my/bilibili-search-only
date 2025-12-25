chrome.storage.sync.get('searchMaskEnabled', (data) => {
  if (data.searchMaskEnabled === false) {
    console.log("搜索页遮罩已关闭");
    return; // 禁用时直接退出
  }

  (function () {
    const HEADER_HEIGHT = 64;
    const LEFT_MASK_WIDTH = 240;
    const Z_MASK = 999998;
    const Z_FLOAT = 100000;
    const SHOW_THRESHOLD = 12; // 顶部可见容差

    function detectPageType() {
      const isEntry = !!document.querySelector(".search-entry-page");
      const isResults = !isEntry && !!document.querySelector(".search-layout");
      document.documentElement.classList.toggle("is-entry", isEntry);
      document.documentElement.classList.toggle("is-results", isResults);
      return { isEntry, isResults };
    }

    function hideHeaderAndFooter() {
      const header = document.querySelector("#bili-header-container");
      if (header) {
        header.style.display = "none";
        header.style.visibility = "hidden";
        header.style.height = "0";
        header.style.overflow = "hidden";
      }
      const footer = document.querySelector("#biliMainFooter");
      if (footer) {
        footer.style.display = "none";
        footer.style.visibility = "hidden";
        footer.style.height = "0";
        footer.style.overflow = "hidden";
      }
    }

    // 创建遮罩（只左侧）
    function ensureLeftMask() {
      let mask = document.querySelector("#bili-header-mask-left");
      if (!mask) {
        mask = document.createElement("div");
        mask.id = "bili-header-mask-left";
        document.body.appendChild(mask);
      }
      Object.assign(mask.style, {
        position: "fixed",
        top: "0",
        left: "0",
        width: `${LEFT_MASK_WIDTH}px`,
        height: `${HEADER_HEIGHT}px`,
        background: "#fff",
        zIndex: Z_MASK,
        pointerEvents: "auto",
        display: "none",            // 初始隐藏
        opacity: "0",
        transition: "opacity 120ms ease"
      });
      return mask;
    }

    // 提升搜索相关元素层级，避免被任何遮罩影响
    function floatSearchElements() {
      const selectors = [".search-input-wrap", ".search-center-title", ".search-logo"];
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          el.style.position = "relative";
          el.style.zIndex = Z_FLOAT;
          el.style.pointerEvents = "auto";
        }
      }
    }

    // 遮罩显示条件：仅当页面在顶部且搜索框位于头部带内
    function updateMaskVisibility() {
      const mask = document.querySelector("#bili-header-mask-left");
      if (!mask) return;

      const { isEntry, isResults } = detectPageType();

      // 顶部判定（避免滚动时误显示）
      const atTop = window.scrollY <= SHOW_THRESHOLD;

      // 搜索框是否处于头部带内
      const inputWrap = document.querySelector(".search-input-wrap");
      let inputInHeaderBand = false;
      if (inputWrap) {
        const r = inputWrap.getBoundingClientRect();
        // 顶部带判定：顶部距离接近 0 且高度覆盖在 header 带内
        inputInHeaderBand = r.top >= -SHOW_THRESHOLD && r.top < HEADER_HEIGHT + SHOW_THRESHOLD;
      }

      // 只在入口页或结果页顶部且搜索框在头部带内时显示遮罩
      const shouldShow = atTop && inputInHeaderBand && (isEntry || isResults);

      if (shouldShow) {
        if (mask.style.display !== "block") {
          mask.style.display = "block";
          // 触发过渡
          requestAnimationFrame(() => { mask.style.opacity = "1"; });
        }
      } else {
        if (mask.style.display !== "none" || mask.style.opacity !== "0") {
          mask.style.opacity = "0";
          // 等过渡结束再隐藏
          setTimeout(() => {
            mask.style.display = "none";
          }, 130);
        }
      }
    }

    function normalizeStageHeight() {
      const stage = document.querySelector("#i_cecream");
      if (stage) stage.style.minHeight = "100vh";
    }

    function adjustEntryTitle() {
      const title = document.querySelector(".search-center-title");
      if (title) {
        title.style.marginTop = "0";
        title.style.marginBottom = "16px";
        title.style.position = "relative";
        title.style.zIndex = Z_FLOAT;
      }
    }

    function init() {
      const { isEntry } = detectPageType();
      hideHeaderAndFooter();
      ensureLeftMask();
      floatSearchElements();

      // 初始延迟，等待首屏内容稳定
      setTimeout(() => {
        updateMaskVisibility();
      }, 250);

      if (isEntry) {
        normalizeStageHeight();
        adjustEntryTitle();
      }

      // 监听 DOM 变化（SPA）
      const observer = new MutationObserver(() => {
        hideHeaderAndFooter();
        ensureLeftMask();
        floatSearchElements();
        updateMaskVisibility();
        if (document.documentElement.classList.contains("is-entry")) {
          normalizeStageHeight();
          adjustEntryTitle();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // 滚动/尺寸变化时更新可见性
      let scheduled = false;
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          updateMaskVisibility();
          scheduled = false;
        });
      };
      window.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule);
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    }
  })();
});