(function () {
  "use strict";

  const LOADING_DURATION_MS = 3000;
  const URGENCY_ORDER = ["Emergency", "Urgent", "Observation", "Routine"];

  let loadingTimerId = null;
  let loadingRafId = null;
  let allCases = [];
  let visibleCases = [];
  let activeVisibleIndex = 0;
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

  /* ── Random 5 from 25 Pool ── */
  function sampleFiveFromPool() {
    const indices = allCases.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices.slice(0, 5).map((i) => allCases[i]);
  }

  /* ── Render Case Selector (5 Visible Prompts Only — No Urgency/Category Spoilers) ── */
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

  /* ── Render Patient Narrative (Clean Input Only — No Highlights/Spoilers) ── */
  function renderNarrative(c, promptIdx) {
    document.getElementById("active-case-badge").textContent = `Prompt #${promptIdx + 1} • ID ${c.id}`;
    document.getElementById("narrative-heading").textContent = `Patient Symptom Prompt #${promptIdx + 1} (ID ${c.id})`;
    document.getElementById("narrative-text-en").textContent = c.narrative_en;
    document.getElementById("narrative-text-th").textContent = c.narrative_th;
  }

  /* ── 3-Second Staged Loading Animation ── */
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

        // Update button active states on this card only
        card.querySelectorAll(".tier-rat-btn").forEach((b) => {
          const isSel = b.getAttribute("data-lang") === lang;
          b.classList.toggle("is-active", isSel);
          b.setAttribute("aria-selected", String(isSel));
        });

        // Update title & rationale text on this card only
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
    const stack = document.getElementById("tiers-vertical-stack");
    const gt = c.ground_truth;

    stack.innerHTML = c.tiers
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

    // Render Ground Truth Card
    const gtCard = document.getElementById("gt-summary-card");
    gtCard.innerHTML = `
      <div class="gt-left">
        <span class="gt-label">PHYSICIAN GROUND TRUTH</span>
        <span class="urgency-pill urg-${escapeHtml(gt.urgency)}">${escapeHtml(gt.urgency)}</span>
        <span class="specialty-pill">${escapeHtml(gt.specialty)}</span>
      </div>
      <span class="meta-pill tabular-nums">Physician Annotation Conf: ${fmtPct(gt.confidence)}</span>
      <p class="gt-reasoning"><strong>Clinical Reference:</strong> ${escapeHtml(gt.clinical_reasoning)}</p>
    `;

    // Render Comparison Table
    const tbody = document.getElementById("comparison-table-body");
    tbody.innerHTML = c.tiers
      .map((t) => {
        const urgMatch = t.urgency === gt.urgency;
        const specMatch = t.specialty === gt.specialty;
        const isCriticalMiss = gt.urgency === "Emergency" && t.urgency !== "Emergency";

        const urgBadge = urgMatch
          ? `<span class="status-badge is-match">&#9989; Match</span>`
          : isCriticalMiss
            ? `<span class="status-badge is-miss">&#128680; Critical Miss</span>`
            : `<span class="status-badge is-miss">&#10060; Miss</span>`;

        const specBadge = specMatch
          ? `<span class="status-badge is-match">&#9989; Match</span>`
          : `<span class="status-badge is-miss">&#10060; Miss</span>`;

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
