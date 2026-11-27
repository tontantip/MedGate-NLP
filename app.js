(function () {
  "use strict";

  const LOADING_DURATION_MS = 3000;
  const URGENCY_ORDER = ["Emergency", "Urgent", "Observation", "Routine"];

  let loadingTimerId = null;
  let loadingRafId = null;
  let allCases = [];
  let visibleCases = [];
  let activeVisibleIndex = 0;
  let currentMode = "curated"; // "curated" | "live"
  let currentRenderedCase = null;
  const tierLangs = { 1: "en", 2: "en", 3: "en", 4: "en", 5: "en" };

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtMs(val) {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "N/A";
    return `${Number(val).toLocaleString("en-US", { maximumFractionDigits: 1 })} ms`;
  }

  function fmtTokens(val) {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "N/A";
    return Number(val).toLocaleString("en-US");
  }

  function fmtCost(val) {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "N/A";
    const num = Number(val);
    if (num === 0) return "$0.000000";
    return `$${num.toFixed(6)}`;
  }

  function fmtPct(val) {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return "N/A";
    return `${(Number(val) * 100).toFixed(1)}%`;
  }

  /* ── Theme Toggle (Following modern-web-guidance: dark-mode-toggle) ── */
  function getSystemScheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function getStoredScheme() {
    try {
      const val = localStorage.getItem("color-scheme");
      return val === "light" || val === "dark" ? val : null;
    } catch {
      return null;
    }
  }

  function applyColorSchemeMeta() {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (!meta) return;
    meta.content = getStoredScheme() ?? "light dark";
  }

  function initThemeToggle() {
    const btn = document.getElementById("btn-theme-toggle");
    if (!btn) return;

    applyColorSchemeMeta();

    btn.addEventListener("click", () => {
      const currentRendered = getStoredScheme() ?? getSystemScheme();
      const target = currentRendered === "dark" ? "light" : "dark";
      const system = getSystemScheme();

      try {
        if (target !== system) {
          localStorage.setItem("color-scheme", target);
        } else {
          localStorage.removeItem("color-scheme");
        }
      } catch {
        // Ignore storage error
      }

      const meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) {
        meta.content = target !== system ? target : "light dark";
      }
    });

    window.addEventListener("storage", (e) => {
      if (e.key === "color-scheme") {
        applyColorSchemeMeta();
      }
    });
  }

  /* ── Language Tabs for Patient Narrative ── */
  function initLangTabs() {
    const tabs = document.querySelectorAll(".lang-tab");
    const cols = document.getElementById("narrative-columns");
    if (!cols) return;

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const lang = tab.getAttribute("data-lang") || "both";
        cols.setAttribute("data-view", lang);
        tabs.forEach((t) => {
          const isSel = t === tab;
          t.classList.toggle("is-active", isSel);
          t.setAttribute("aria-selected", String(isSel));
        });
      });
    });
  }

  /* ── Mode Switcher (Curated 25 Cases vs Live Free-Text) ── */
  function switchToMode(mode) {
    const tabs = document.querySelectorAll(".mode-tab");
    const curatedPanel = document.getElementById("curated-selector-panel");
    const livePanel = document.getElementById("live-input-panel");
    const resultsWorkspace = document.getElementById("results-workspace");

    stopActiveLoading();
    currentMode = mode;

    tabs.forEach((t) => {
      const isSel = (t.getAttribute("data-mode") || "curated") === mode;
      t.classList.toggle("is-active", isSel);
      t.setAttribute("aria-selected", String(isSel));
    });

    if (mode === "live") {
      curatedPanel.hidden = true;
      livePanel.hidden = false;
      document.getElementById("loading-panel").hidden = true;
      resultsWorkspace.hidden = true;
    } else {
      livePanel.hidden = true;
      curatedPanel.hidden = false;
      document.getElementById("loading-panel").hidden = true;
      if (visibleCases[activeVisibleIndex]) {
        renderNarrative(visibleCases[activeVisibleIndex], activeVisibleIndex);
        renderResults(visibleCases[activeVisibleIndex]);
        resultsWorkspace.hidden = false;
      }
    }
  }

  function initModeSwitcher() {
    const tabs = document.querySelectorAll(".mode-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const mode = tab.getAttribute("data-mode") || "curated";
        if (mode === currentMode) return;
        switchToMode(mode);
      });
    });
  }

  /* ── Random 5 from 25 Pool ── */
  function sampleFiveFromPool() {
    const indices = allCases.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices.slice(0, 5).map((i) => allCases[i]);
  }

  /* ── Render Case Selector (5 Visible Prompts Only) ── */
  function renderCaseSelector() {
    const grid = document.getElementById("case-selector-grid");
    if (!grid) return;

    grid.innerHTML = visibleCases
      .map((c, idx) => {
        const previewText = String(c.narrative_th || c.narrative_en || "").split("\n")[0];
        return `
      <button
        type="button"
        class="case-btn ${idx === activeVisibleIndex ? "is-active" : ""}"
        data-case-idx="${idx}"
        role="option"
        aria-selected="${idx === activeVisibleIndex}"
      >
        <div class="case-btn-top">
          <span class="case-num tabular-nums">Prompt #${idx + 1} &bull; ID ${c.id}</span>
        </div>
        <div class="case-btn-preview">${escapeHtml(previewText)}</div>
      </button>`;
      })
      .join("");

    grid.querySelectorAll(".case-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-case-idx"));
        if (!Number.isNaN(idx)) {
          selectCaseWithLoading(idx);
        }
      });
    });
  }

  /* ── Render Patient Narrative ── */
  function renderNarrative(c, promptIdx) {
    document.getElementById("active-case-badge").textContent = `Prompt #${promptIdx + 1} • ID ${c.id}`;
    document.getElementById("narrative-heading").textContent = `Patient Symptom Prompt #${promptIdx + 1} (ID ${c.id})`;
    document.getElementById("narrative-text-en").textContent = c.narrative_en;
    document.getElementById("narrative-text-th").textContent = c.narrative_th;
  }

  /* ── 3-Second Staged Loading Animation (Curated Mode) ── */
  function stopActiveLoading() {
    if (loadingTimerId !== null) {
      clearTimeout(loadingTimerId);
      loadingTimerId = null;
    }
    if (loadingRafId !== null) {
      cancelAnimationFrame(loadingRafId);
      loadingRafId = null;
    }
  }

  function updateCaseButtonsState(activeIdx) {
    document.querySelectorAll(".case-btn").forEach((btn) => {
      const idx = Number(btn.getAttribute("data-case-idx"));
      const isActive = idx === activeIdx;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-selected", String(isActive));
    });
  }

  function selectCaseWithLoading(idx) {
    stopActiveLoading();
    activeVisibleIndex = idx;
    updateCaseButtonsState(idx);

    const c = visibleCases[idx];
    renderNarrative(c, idx);

    const loadingPanel = document.getElementById("loading-panel");
    const resultsWorkspace = document.getElementById("results-workspace");
    const stageText = document.getElementById("loading-stage-text");
    const timerText = document.getElementById("loading-timer-text");
    const progressFill = document.getElementById("loading-progress-fill");
    const progressBar = document.getElementById("loading-progressbar");
    const pill1 = document.getElementById("stage-pill-1");
    const pill2 = document.getElementById("stage-pill-2");
    const pill3 = document.getElementById("stage-pill-3");

    resultsWorkspace.hidden = true;
    loadingPanel.hidden = false;

    const startTime = performance.now();

    function tick(now) {
      const elapsed = Math.min(now - startTime, LOADING_DURATION_MS);
      const pct = (elapsed / LOADING_DURATION_MS) * 100;

      progressFill.style.width = `${pct.toFixed(1)}%`;
      progressBar.setAttribute("aria-valuenow", String(Math.round(pct)));
      timerText.textContent = `${(elapsed / 1000).toFixed(1)}s / 3.0s`;

      if (elapsed < 1000) {
        stageText.textContent = "Running Tier 1 Jev AI Frontline Screening...";
        pill1.className = "stage-pill is-active";
        pill2.className = "stage-pill";
        pill3.className = "stage-pill";
      } else if (elapsed < 2000) {
        stageText.textContent = "Evaluating Asymmetric Safety Gate (θu=0.98, θs=0.80) & Local Qwen2.5-3B...";
        pill1.className = "stage-pill is-done";
        pill2.className = "stage-pill is-active";
        pill3.className = "stage-pill";
      } else {
        stageText.textContent = "Benchmarking Commercial LLMs & Compiling 5-Tier Summary...";
        pill1.className = "stage-pill is-done";
        pill2.className = "stage-pill is-done";
        pill3.className = "stage-pill is-active";
      }

      if (elapsed < LOADING_DURATION_MS) {
        loadingRafId = requestAnimationFrame(tick);
      }
    }

    loadingRafId = requestAnimationFrame(tick);

    loadingTimerId = setTimeout(() => {
      stopActiveLoading();
      loadingPanel.hidden = true;
      renderResults(c);
      resultsWorkspace.hidden = false;
    }, LOADING_DURATION_MS);
  }

  /* ── Live Inference Mode Logic ── */
  function normalizeBackendUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  function isColabEditorUrl(url) {
    const lower = String(url || "").toLowerCase();
    return lower.includes("colab.research.google.com") || lower.includes("drive.google.com");
  }

  function setConnBadge(state, text) {
    const badge = document.getElementById("conn-status-badge");
    if (!badge) return;
    badge.className = `conn-badge ${state}`;
    badge.textContent = text;
  }

  async function runConnectionTest(base, errMsg) {
    if (!base) {
      setConnBadge("is-err", "🔴 Missing Backend URL");
      return false;
    }
    if (isColabEditorUrl(base)) {
      setConnBadge("is-err", "🔴 ลิงก์ไม่ถูกต้อง (นี่คือลิงก์หน้าเว็บ Colab)");
      if (errMsg) {
        errMsg.textContent =
          "⚠️ ลิงก์ที่วางเป็นลิงก์หน้าเว็บแก้ไข Colab (colab.research.google.com) ไม่ใช่ลิงก์ API Server ครับ — กรุณาเปิดไฟล์ Colab_Phase7_Live_Backend_Server.ipynb กด Run All แล้วคัดลอกลิงก์ https://xxxx.trycloudflare.com จากผลลัพธ์ของ Cell ที่ 5 มาวางแทนครับ";
        errMsg.hidden = false;
      }
      return false;
    }
    try {
      localStorage.setItem("medgate_backend_url", base);
    } catch {}

    if (errMsg) errMsg.hidden = true;
    setConnBadge("is-idle", "⏳ Testing...");
    try {
      const resp = await fetch(`${base}/health`, { method: "GET" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      stopConnCountdown();
      const box = document.getElementById("conn-countdown-box");
      if (box) box.hidden = true;
      setConnBadge("is-ok", `🟢 Connected: ${data.model || "Colab Ready"}`);
      return true;
    } catch (e) {
      setConnBadge("is-err", `🔴 Failed (${e.message})`);
      if (errMsg) {
        errMsg.textContent = `ไม่สามารถเชื่อมต่อกับ ${base}/health ได้ (${e.message}) — ตรวจสอบว่า Cell ที่ 5 ใน Colab ยังรันค้างอยู่และใช้ลิงก์ .trycloudflare.com ล่าสุดครับ`;
        errMsg.hidden = false;
      }
      return false;
    }
  }

  const NTFY_POLL_URL = "https://ntfy.sh/medgate_ai_tontantip_dads7203_live/json?poll=1&since=all";
  let connIntervalId = null;

  function stopConnCountdown() {
    if (connIntervalId !== null) {
      clearInterval(connIntervalId);
      connIntervalId = null;
    }
  }

  async function fetchLatestColabBroadcast() {
    try {
      const resp = await fetch(NTFY_POLL_URL, { cache: "no-store" });
      if (!resp.ok) return null;
      const text = await resp.text();
      const lines = text.trim().split("\n").filter(Boolean);
      let latest = null;
      for (const line of lines) {
        try {
          const env = JSON.parse(line);
          if (env.event === "message" && env.message) {
            const payload = JSON.parse(env.message);
            if (payload && typeof payload === "object") {
              latest = payload;
            }
          }
        } catch {}
      }
      return latest;
    } catch {
      return null;
    }
  }

  function startAutoConnectCountdown(urlInput, errMsg) {
    stopConnCountdown();
    if (errMsg) errMsg.hidden = true;

    const box = document.getElementById("conn-countdown-box");
    const stageEl = document.getElementById("conn-stage-title");
    const timerEl = document.getElementById("conn-countdown-timer");
    const fillEl = document.getElementById("conn-progress-fill");
    if (!box || !stageEl || !timerEl || !fillEl) return;

    box.hidden = false;
    setConnBadge("is-idle", "⏳ Auto-Connecting...");

    const totalSec = 90;
    let remainingSec = totalSec;
    let remotePct = 0;
    let remoteMsg = "กำลังค้นหาสัญญาณและดึงลิงก์ Cloudflare Tunnel จาก Colab T4...";
    let isChecking = false;

    function updateUi() {
      const timePct = Math.round(((totalSec - remainingSec) / totalSec) * 90);
      const displayPct = Math.min(99, Math.max(timePct, remotePct));
      stageEl.textContent = remoteMsg;
      timerEl.textContent = `นับถอยหลัง ${remainingSec}s (${displayPct}%)`;
      fillEl.style.width = `${displayPct}%`;
    }

    async function pollOnce() {
      if (isChecking) return;
      isChecking = true;
      try {
        const broadcast = await fetchLatestColabBroadcast();
        if (broadcast) {
          if (broadcast.msg) remoteMsg = broadcast.msg;
          if (typeof broadcast.pct === "number") remotePct = broadcast.pct;
          if (broadcast.url && !isColabEditorUrl(broadcast.url)) {
            urlInput.value = normalizeBackendUrl(broadcast.url);
            try {
              localStorage.setItem("medgate_backend_url", urlInput.value);
            } catch {}
          }
          updateUi();
        }

        const candidate = normalizeBackendUrl(urlInput.value);
        if (candidate && !isColabEditorUrl(candidate)) {
          const ctrl = new AbortController();
          const tId = setTimeout(() => ctrl.abort(), 3000);
          try {
            const hResp = await fetch(`${candidate}/health`, { method: "GET", signal: ctrl.signal });
            clearTimeout(tId);
            if (hResp.ok) {
              const data = await hResp.json();
              stopConnCountdown();
              fillEl.style.width = "100%";
              stageEl.textContent = `✅ เชื่อมต่อ Colab T4 สำเร็จ! (${data.model || "Ready"})`;
              timerEl.textContent = "เชื่อมต่อสำเร็จ (100%)";
              setConnBadge("is-ok", `🟢 Connected: ${data.model || "Colab Ready"}`);
              setTimeout(() => {
                box.hidden = true;
              }, 1800);
              return;
            }
          } catch {
            clearTimeout(tId);
          }
        }
      } finally {
        isChecking = false;
      }
    }

    updateUi();
    pollOnce();

    connIntervalId = setInterval(() => {
      remainingSec = Math.max(0, remainingSec - 1);
      updateUi();
      if (remainingSec % 3 === 0) {
        pollOnce();
      }
      if (remainingSec === 0) {
        stopConnCountdown();
        setConnBadge("is-err", "🔴 Timeout (กรุณากด Run All ใน Colab)");
        stageEl.textContent = "หมดเวลารอ 90 วินาที — กรุณาตรวจสอบว่ากด Run All ใน Colab แล้วลองกด Auto-Connect อีกครั้งครับ";
      }
    }, 1000);
  }

  function initLiveMode() {
    const urlInput = document.getElementById("backend-url-input");
    const testBtn = document.getElementById("btn-test-conn");
    const autoConnBtn = document.getElementById("btn-auto-connect");
    const openColabBtn = document.getElementById("btn-open-colab");
    const runBtn = document.getElementById("btn-run-live");
    const textArea = document.getElementById("live-symptom-input");
    const errMsg = document.getElementById("live-error-msg");

    if (!urlInput || !testBtn || !runBtn || !textArea) return;

    if (autoConnBtn) {
      autoConnBtn.addEventListener("click", () => {
        startAutoConnectCountdown(urlInput, errMsg);
      });
    }

    if (openColabBtn) {
      openColabBtn.addEventListener("click", () => {
        startAutoConnectCountdown(urlInput, errMsg);
      });
    }

    // Support ?backend=https://xxxx.trycloudflare.com magic link from Colab Cell 5
    const params = new URLSearchParams(window.location.search);
    const queryBackend = normalizeBackendUrl(params.get("backend") || "");

    if (queryBackend) {
      urlInput.value = queryBackend;
      try {
        localStorage.setItem("medgate_backend_url", queryBackend);
      } catch {}
      setTimeout(() => {
        switchToMode("live");
        runConnectionTest(queryBackend, errMsg);
      }, 50);
    } else {
      try {
        const savedUrl = localStorage.getItem("medgate_backend_url");
        if (savedUrl && !isColabEditorUrl(savedUrl)) {
          urlInput.value = savedUrl;
        }
      } catch {
        // Ignore storage error
      }
    }

    document.querySelectorAll(".quick-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        textArea.value = chip.getAttribute("data-text") || "";
        errMsg.hidden = true;
      });
    });

    testBtn.addEventListener("click", async () => {
      const base = normalizeBackendUrl(urlInput.value);
      await runConnectionTest(base, errMsg);
    });

    runBtn.addEventListener("click", async () => {
      const base = normalizeBackendUrl(urlInput.value);
      const text = textArea.value.trim();
      errMsg.hidden = true;

      if (!base) {
        errMsg.textContent = "กรุณาวางลิงก์ Tunnel URL (https://....trycloudflare.com) จาก Cell ที่ 5 ใน Colab ก่อนกดวิเคราะห์ครับ";
        errMsg.hidden = false;
        return;
      }
      if (isColabEditorUrl(base)) {
        await runConnectionTest(base, errMsg);
        return;
      }
      if (!text) {
        errMsg.textContent = "กรุณาพิมพ์ข้อความอาการผู้ป่วย (ภาษาไทยหรือภาษาอังกฤษ) ก่อนกดวิเคราะห์ครับ";
        errMsg.hidden = false;
        return;
      }

      try {
        localStorage.setItem("medgate_backend_url", base);
      } catch {}

      stopActiveLoading();
      runBtn.disabled = true;

      const loadingPanel = document.getElementById("loading-panel");
      const resultsWorkspace = document.getElementById("results-workspace");
      const stageText = document.getElementById("loading-stage-text");
      const timerText = document.getElementById("loading-timer-text");
      const progressFill = document.getElementById("loading-progress-fill");
      const pill1 = document.getElementById("stage-pill-1");
      const pill2 = document.getElementById("stage-pill-2");
      const pill3 = document.getElementById("stage-pill-3");

      resultsWorkspace.hidden = true;
      loadingPanel.hidden = false;
      stageText.textContent = "Running Live 5-Tier Pipeline on Colab T4 (Translate → Jev AI → Qwen2.5-3B → Claude 5.5)...";
      pill1.className = "stage-pill is-active";
      pill2.className = "stage-pill is-active";
      pill3.className = "stage-pill is-active";

      const tStart = performance.now();
      function liveTick(now) {
        const sec = (now - tStart) / 1000;
        timerText.textContent = `${sec.toFixed(1)}s (Live)`;
        const fakePct = Math.min(92, (sec / 6.0) * 100);
        progressFill.style.width = `${fakePct.toFixed(1)}%`;
        loadingRafId = requestAnimationFrame(liveTick);
      }
      loadingRafId = requestAnimationFrame(liveTick);

      try {
        const resp = await fetch(`${base}/api/triage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, theta_u: 0.98, theta_s: 0.80 }),
        });
        if (!resp.ok) {
          const detail = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${detail.slice(0, 160)}`);
        }
        const payload = await resp.json();
        stopActiveLoading();
        progressFill.style.width = "100%";
        loadingPanel.hidden = true;

        setConnBadge("is-ok", "🟢 Connected (Live OK)");

        const liveCase = {
          id: "LIVE",
          narrative_en: payload.narrative_en,
          narrative_th: payload.narrative_th,
          was_thai_input: payload.was_thai_input,
          ground_truth: null,
          tiers: payload.tiers,
        };
        renderResults(liveCase);
        resultsWorkspace.hidden = false;
      } catch (e) {
        stopActiveLoading();
        loadingPanel.hidden = true;
        errMsg.textContent = `เกิดข้อผิดพลาดในการเชื่อมต่อ Backend: ${e.message}`;
        errMsg.hidden = false;
        setConnBadge("is-err", "🔴 Connection Error");
      } finally {
        runBtn.disabled = false;
      }
    });
  }

  /* ── Render Probability / Confidence Bars ── */
  function renderProbabilitiesBlock(tier) {
    if (tier.urgency_probs) {
      const rows = URGENCY_ORDER.map((label) => {
        const val = Number(tier.urgency_probs[label] ?? 0);
        const pct = Math.max(0, Math.min(100, val * 100));
        const cls =
          label === "Emergency" ? "is-emerg" :
          label === "Urgent" ? "is-urgent" :
          label === "Observation" ? "is-obs" : "is-routine";
        return `
          <div class="prob-item">
            <span class="prob-name">${label}</span>
            <div class="prob-track"><div class="prob-fill ${cls}" style="width: ${pct.toFixed(1)}%"></div></div>
            <span class="prob-val tabular-nums">${pct.toFixed(1)}%</span>
          </div>`;
      }).join("");

      const specRow = tier.prob_specialty !== null && tier.prob_specialty !== undefined
        ? `
          <div class="prob-item" style="margin-top: 4px; padding-top: 6px; border-top: 1px dashed var(--border-color);">
            <span class="prob-name">Specialty P(s)</span>
            <div class="prob-track"><div class="prob-fill" style="width: ${(tier.prob_specialty * 100).toFixed(1)}%"></div></div>
            <span class="prob-val tabular-nums">${fmtPct(tier.prob_specialty)}</span>
          </div>`
        : "";

      return `<div class="probs-block">${rows}${specRow}</div>`;
    }

    const conf = Number(tier.prob_urgency ?? 0);
    const pct = Math.max(0, Math.min(100, conf * 100));
    return `
      <div class="probs-block">
        <div class="prob-item">
          <span class="prob-name">LLM Conf.</span>
          <div class="prob-track"><div class="prob-fill" style="width: ${pct.toFixed(1)}%"></div></div>
          <span class="prob-val tabular-nums">${pct.toFixed(1)}%</span>
        </div>
      </div>`;
  }

  /* ── Render Routing Badge ── */
  function renderRoutingBadge(tier) {
    if (tier.is_auto_route === true) {
      return `<span class="routing-badge is-auto">&#9889; Auto-Route (System 1: Jev AI)</span>`;
    }
    if (tier.is_auto_route === false) {
      return `<span class="routing-badge is-escalated">&#129504; Escalated (System 2: LLM)</span>`;
    }
    return `<span class="routing-badge is-standalone">Standalone Tier ${tier.tier}</span>`;
  }

  /* ── Attach Per-Tier Rationale Language Toggle Listeners ── */
  function attachPerTierRationaleListeners(c) {
    const stack = document.getElementById("tiers-vertical-stack");
    if (!stack) return;

    stack.querySelectorAll(".tier-rat-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tierNum = Number(btn.getAttribute("data-tier"));
        const lang = btn.getAttribute("data-lang") || "en";
        if (tierLangs[tierNum] === lang) return;

        tierLangs[tierNum] = lang;
        const tierData = c.tiers.find((t) => t.tier === tierNum);
        if (!tierData) return;

        const card = btn.closest(".tier-card");
        if (!card) return;

        card.querySelectorAll(".tier-rat-btn").forEach((b) => {
          const isSel = b.getAttribute("data-lang") === lang;
          b.classList.toggle("is-active", isSel);
          b.setAttribute("aria-selected", String(isSel));
        });

        const titleEl = card.querySelector(".rationale-title");
        const textEl = card.querySelector(".rationale-text");
        if (titleEl) {
          titleEl.textContent = `Model Reasoning (Clinical Rationale • ${lang.toUpperCase()})`;
        }
        if (textEl) {
          textEl.textContent = lang === "th" ? tierData.rationale_th : tierData.rationale_en;
        }
      });
    });
  }

  /* ── Render Vertical 5-Tier Stack & Comparison Table ── */
  function renderResults(c) {
    currentRenderedCase = c;
    const stack = document.getElementById("tiers-vertical-stack");
    const gt = c.ground_truth;

    const liveBannerHtml = !gt
      ? `
        <div class="narrative-card" style="margin-bottom: 4px;">
          <div class="narrative-header">
            <span class="mono-label">LIVE TRANSLATED INPUTS (${c.was_thai_input ? "THAI → CLINICAL ENGLISH" : "ENGLISH → THAI"})</span>
          </div>
          <div class="narrative-columns" data-view="both">
            <div class="narrative-col">
              <span class="lang-badge">Clinical English (Sent to Tiers 1–5)</span>
              <p class="narrative-text">${escapeHtml(c.narrative_en)}</p>
            </div>
            <div class="narrative-col">
              <span class="lang-badge">ภาษาไทย (Thai Display)</span>
              <p class="narrative-text">${escapeHtml(c.narrative_th)}</p>
            </div>
          </div>
        </div>`
      : "";

    stack.innerHTML =
      liveBannerHtml +
      c.tiers
        .map((t) => {
          const isHighlight = t.tier === 4 || t.tier === 5;
          const gateReasonHtml = t.gate_reason
            ? `<div class="gate-reason-bar">${escapeHtml(t.gate_reason)}</div>`
            : "";
          const lang = tierLangs[t.tier] || "en";
          const rationaleText = lang === "th" ? t.rationale_th : t.rationale_en;
          const rationaleLangLabel = lang.toUpperCase();

          return `
          <article class="tier-card ${isHighlight ? "is-highlighted" : ""}" data-tier-card="${t.tier}">
            <div class="tier-card-header">
              <div class="tier-title-group">
                <span class="tier-number-tag">TIER ${t.tier}</span>
                <h3 class="tier-name">${escapeHtml(t.name)}</h3>
                <p class="tier-subtitle">${escapeHtml(t.subtitle)}</p>
              </div>
              <div class="tier-badges-right">
                ${renderRoutingBadge(t)}
              </div>
            </div>

            ${gateReasonHtml}

            <div class="tier-body-grid">
              <div class="prediction-box">
                <div class="pred-row">
                  <span class="pred-label">Predicted Urgency</span>
                  <span class="urgency-pill urg-${escapeHtml(t.urgency)}">${escapeHtml(t.urgency)}</span>
                </div>
                <div class="pred-row">
                  <span class="pred-label">Predicted Specialty</span>
                  <span class="specialty-pill">${escapeHtml(t.specialty)}</span>
                </div>
                ${renderProbabilitiesBlock(t)}
              </div>

              <div class="rationale-box">
                <div class="rationale-header-row">
                  <span class="rationale-title">Model Reasoning (Clinical Rationale &bull; ${rationaleLangLabel})</span>
                  <div class="tier-rat-tabs" role="tablist" aria-label="Tier ${t.tier} Rationale Language">
                    <button type="button" class="tier-rat-btn ${lang === "en" ? "is-active" : ""}" data-tier="${t.tier}" data-lang="en" role="tab" aria-selected="${lang === "en"}">EN</button>
                    <button type="button" class="tier-rat-btn ${lang === "th" ? "is-active" : ""}" data-tier="${t.tier}" data-lang="th" role="tab" aria-selected="${lang === "th"}">TH</button>
                  </div>
                </div>
                <p class="rationale-text ${t.no_rationale_by_design ? "is-muted" : ""}">${escapeHtml(rationaleText)}</p>
              </div>
            </div>

            <div class="metrics-strip">
              <div class="metric-cell">
                <span class="metric-k">Latency</span>
                <span class="metric-v tabular-nums">${fmtMs(t.latency_ms)}</span>
              </div>
              <div class="metric-cell">
                <span class="metric-k">Total Tokens</span>
                <span class="metric-v tabular-nums">${fmtTokens(t.total_tokens)}</span>
                <span class="metric-note">${escapeHtml(t.token_note || "")}</span>
              </div>
              <div class="metric-cell">
                <span class="metric-k">Total Cost (USD)</span>
                <span class="metric-v tabular-nums">${fmtCost(t.cost_usd)}</span>
                <span class="metric-note">${escapeHtml(t.cost_note)}</span>
              </div>
            </div>
          </article>`;
        })
        .join("");

    attachPerTierRationaleListeners(c);

    // Render Ground Truth Card (or Live Mode Info Banner)
    const gtCard = document.getElementById("gt-summary-card");
    if (gt) {
      gtCard.innerHTML = `
        <div class="gt-left">
          <span class="gt-label">PHYSICIAN GROUND TRUTH</span>
          <span class="urgency-pill urg-${escapeHtml(gt.urgency)}">${escapeHtml(gt.urgency)}</span>
          <span class="specialty-pill">${escapeHtml(gt.specialty)}</span>
        </div>
        <span class="meta-pill tabular-nums">Physician Annotation Conf: ${fmtPct(gt.confidence)}</span>
        <p class="gt-reasoning"><strong>Clinical Reference:</strong> ${escapeHtml(gt.clinical_reasoning)}</p>
      `;
    } else {
      gtCard.innerHTML = `
        <div class="gt-left">
          <span class="gt-label">LIVE FREE-TEXT MODE (NO PHYSICIAN GROUND TRUTH)</span>
        </div>
        <span class="meta-pill">Comparing Tier 1–5 Consensus, Latency &amp; Cost</span>
      `;
    }

    // Render Comparison Table
    const tbody = document.getElementById("comparison-table-body");
    tbody.innerHTML = c.tiers
      .map((t) => {
        let urgBadge = "";
        let specBadge = "";
        if (gt) {
          const urgMatch = t.urgency === gt.urgency;
          const specMatch = t.specialty === gt.specialty;
          const isCriticalMiss = gt.urgency === "Emergency" && t.urgency !== "Emergency";

          urgBadge = urgMatch
            ? `<span class="status-badge is-match">&#9989; Match</span>`
            : isCriticalMiss
              ? `<span class="status-badge is-miss">&#128680; Critical Miss</span>`
              : `<span class="status-badge is-miss">&#10060; Miss</span>`;

          specBadge = specMatch
            ? `<span class="status-badge is-match">&#9989; Match</span>`
            : `<span class="status-badge is-miss">&#10060; Miss</span>`;
        }

        const routeBadge =
          t.is_auto_route === true
            ? `<span class="routing-badge is-auto">&#9889; Auto-Route</span>`
            : t.is_auto_route === false
              ? `<span class="routing-badge is-escalated">&#129504; Escalated</span>`
              : `<span class="routing-badge is-standalone">Standalone</span>`;

        return `
          <tr>
            <td><strong>${escapeHtml(t.name)}</strong></td>
            <td>${routeBadge}</td>
            <td>
              <span class="urgency-pill urg-${escapeHtml(t.urgency)}">${escapeHtml(t.urgency)}</span>
              ${urgBadge}
            </td>
            <td>
              <span class="specialty-pill">${escapeHtml(t.specialty)}</span>
              ${specBadge}
            </td>
            <td class="tabular-nums">${fmtPct(t.prob_urgency)}</td>
            <td class="tabular-nums">${fmtMs(t.latency_ms)}</td>
            <td class="tabular-nums">${fmtTokens(t.total_tokens)}</td>
            <td class="tabular-nums">${fmtCost(t.cost_usd)}</td>
          </tr>`;
      })
      .join("");
  }

  /* ── Initialize App ── */
  function init() {
    initThemeToggle();
    initLangTabs();
    initModeSwitcher();
    initLiveMode();

    const data = window.MEDGATE_DEMO_25CASES;
    if (!data || !Array.isArray(data.cases) || data.cases.length === 0) {
      const err = document.getElementById("data-error-banner");
      if (err) err.hidden = false;
      return;
    }

    allCases = data.cases;
    visibleCases = allCases.slice(0, 5);
    activeVisibleIndex = 0;

    renderCaseSelector();
    renderNarrative(visibleCases[0], 0);
    renderResults(visibleCases[0]);

    const rerollBtn = document.getElementById("btn-reroll-cases");
    if (rerollBtn) {
      rerollBtn.addEventListener("click", () => {
        visibleCases = sampleFiveFromPool();
        renderCaseSelector();
        selectCaseWithLoading(0);
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
