const CONFIG_URL = "config/career_flow.json";

const $app = document.getElementById("app");
const $compass = document.getElementById("compass");
const $confidencePill = document.getElementById("confidencePill");
const $systemHearing = document.getElementById("systemHearing");
const $progressText = document.getElementById("progressText");

let CONFIG = null;

const state = {
  phase: "loading",
  profile: {},
  diagnostic: { index: 0, answers: {} },
  refinement: { index: 0, answers: {} },
  decisionLog: [],
  signals: {
    depth: 0, scope: 0, breadth: 0, recalibration: 0,
    execution: 0, decisionMaking: 0, people: 0, learning: 0
  },
  scales: { ambiguity: null, change: null, readiness: null },
  pathScores: {},
  confidence: { band: "early", delta: 0, top: null, runnerUp: null, label: "Early signal" },
  pathIntent: { primaryPath: null, secondaryPath: null, chosenBy: null, versionOfPath: {} },
  focusStatement: "",
  openQuestion: "What would you recommend as the best next step to test and build this direction?",
  plan: { experimentsSelected: [] },
  summaries: { employee: "", leader: "" },
  summaryTab: "employee"
};

/* ------------------ helpers ------------------ */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"
  }[s]));
}

function getPathById(id) {
  return CONFIG.paths.find(p => p.id === id);
}

function initScores() {
  state.pathScores = {};
  CONFIG.paths.forEach(p => state.pathScores[p.id] = 0);
}

function addSignals(signalsObj) {
  if (!signalsObj) return;

  for (const key of Object.keys(state.signals)) {
    if (typeof signalsObj[key] === "number") state.signals[key] += signalsObj[key];
  }
  if (signalsObj.ambiguity) state.scales.ambiguity = signalsObj.ambiguity;
  if (signalsObj.change) state.scales.change = signalsObj.change;
  if (signalsObj.readiness) state.scales.readiness = signalsObj.readiness;
}

function addPathScore(deltaObj) {
  if (!deltaObj) return;
  for (const [pathId, delta] of Object.entries(deltaObj)) {
    if (typeof delta === "number") state.pathScores[pathId] = (state.pathScores[pathId] || 0) + delta;
  }
}

function dominantSignal() {
  const core = ["depth","scope","breadth","recalibration"];
  let best = { id: core[0], val: state.signals[core[0]] };
  for (const id of core) if (state.signals[id] > best.val) best = { id, val: state.signals[id] };
  return best.id;
}

function computeTopTwo() {
  const entries = Object.entries(state.pathScores).sort((a,b)=>b[1]-a[1]);
  const top = entries[0] ? { id: entries[0][0], score: entries[0][1] } : null;
  const runner = entries[1] ? { id: entries[1][0], score: entries[1][1] } : null;
  const delta = (top && runner) ? (top.score - runner.score) : 0;
  return { top, runner, delta, entries };
}

function computeConfidence() {
  const { top, runner, delta } = computeTopTwo();
  const bands = CONFIG.diagnostic.confidence.bands.slice().sort((a,b)=>b.minDelta-a.minDelta);

  let band = "early";
  for (const b of bands) if (delta >= b.minDelta) { band = b.id; break; }

  const label = (CONFIG.templates?.uiStrings?.confidenceLabels?.[band]) || band;
  state.confidence = {
    band,
    delta,
    top: top?.id || null,
    runnerUp: runner?.id || null,
    label
  };
}

function applyRoutingOverridesIfNeeded() {
  const domSig = dominantSignal();
  for (const rule of CONFIG.flow.routingRules) {
    const w = rule.when || {};
    const matchesPhase = (w.phase === "diagnosticComplete");
    const matchesBand = (!w.confidenceBand || w.confidenceBand === state.confidence.band);
    const matchesDomSig = (!w.dominantSignal || w.dominantSignal === domSig);

    if (matchesPhase && matchesBand && matchesDomSig) {
      state.pathIntent.primaryPath = rule.then.primaryPath;
      state.pathIntent.secondaryPath = rule.then.secondaryPath || state.confidence.runnerUp;
      state.pathIntent.chosenBy = "routingRule";
      return true;
    }
  }
  return false;
}

function listWhyBullets() {
  const templates = CONFIG.summaryLogic.whyEvidence.templates;
  const core = ["depth","scope","breadth","recalibration"];
  const sorted = core.map(id => ({ id, val: state.signals[id] })).sort((a,b)=>b.val-a.val);

  const bullets = [];
  for (const item of sorted) {
    if (item.val <= 0) continue;
    const t = templates[item.id];
    if (t && bullets.length < CONFIG.summaryLogic.whyEvidence.maxBullets) bullets.push(`• ${t}`);
  }

  if (state.confidence.band === "early") {
    bullets.unshift("• Your answers are still mixed — which is normal. The next step is creating evidence, not forcing certainty.");
    return bullets.slice(0, CONFIG.summaryLogic.whyEvidence.maxBullets).join("\n");
  }

  return (bullets.length ? bullets : ["• Your answers suggest you’re still clarifying what kind of progress you want next."]).join("\n");
}

function evidenceBulletsFromDecisionLog(max=4) {
  const picks = state.decisionLog.slice(0).reverse().slice(0, max).reverse();
  if (!picks.length) return "• (No evidence captured yet.)";
  return picks.map(e => `• ${e.prompt} → “${e.answerLabel}”`).join("\n");
}

function pickDefaultExperimentsForPath(pathId) {
  const ids = CONFIG.experiments.selectionRules.suggestionsByPath[pathId] || [];
  const library = CONFIG.experiments.library;
  const exps = ids.map(id => library.find(x => x.id === id)).filter(Boolean);
  return exps.slice(0, CONFIG.experiments.selectionRules.defaultPickCount);
}

function setDeep(obj, dottedKey, value) {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i=0; i<parts.length-1; i++) {
    const p = parts[i];
    if (!(p in cur)) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length-1]] = value;
}

function getDeep(obj, dottedKey) {
  const parts = dottedKey.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function computeIntentTranslation(primaryPath) {
  const rules = CONFIG.summaryLogic.intentTranslationRules || [];
  const v = state.pathIntent.versionOfPath[primaryPath] || {};
  for (const rule of rules) {
    const when = rule.when || {};
    if (when.primaryPath && when.primaryPath !== primaryPath) continue;

    let ok = true;
    for (const [k,val] of Object.entries(when)) {
      if (k === "primaryPath") continue;
      const actual = getDeep({ versionOfPath: v }, k);
      if (actual !== val) { ok = false; break; }
    }
    if (ok) return rule.then;
  }
  return CONFIG.summaryLogic.fallbackIntentTranslation;
}

function buildFocusStatement(primaryPath) {
  const tmpl = CONFIG.focusStatement.builder.defaultTemplates[primaryPath] || "";
  const v = state.pathIntent.versionOfPath[primaryPath] || {};
  const maps = CONFIG.focusStatement.builder.descriptorMaps || {};

  let descriptor = "";
  if (primaryPath === "levelUp") {
    descriptor = maps.levelUp?.byLevelUpType?.[v.levelUpType] || "greater responsibility and impact";
  } else if (primaryPath === "thrive") {
    descriptor = maps.thrive?.byThriveFocus?.[v.thriveFocus] || "my effectiveness and impact";
  } else if (primaryPath === "moveAcross") {
    descriptor = maps.moveAcross?.byAcrossPurpose?.[v.acrossPurpose] || "broader perspective";
  } else if (primaryPath === "expandView") {
    descriptor = maps.expandView?.byExploreMode?.[v.exploreMode] || "a short-term experience";
  } else if (primaryPath === "reset") {
    descriptor = maps.reset?.byResetDriver?.[v.resetDriver] || "sustainability and clarity";
  }

  const exp1 = state.plan.experimentsSelected[0]?.label || "one meaningful stretch experiment";

  return tmpl
    .replace("{levelUpDescriptor}", descriptor)
    .replace("{thriveDescriptor}", descriptor)
    .replace("{acrossDescriptor}", descriptor)
    .replace("{exploreDescriptor}", descriptor)
    .replace("{resetDescriptor}", descriptor)
    .replace("{experiment1}", exp1);
}

/* ------------------ sidebar ------------------ */

function renderCompass() {
  if (!CONFIG) return;

  const { top, runner, entries } = computeTopTwo();
  const maxScore = Math.max(...entries.map(e=>e[1]), 1);

  const makeRow = (rank, item) => {
    if (!item) return "";
    const p = getPathById(item.id);
    const pct = Math.round((item.score / maxScore) * 100);
    return `
      <div class="compassRow">
        <div class="rank">${rank}</div>
        <div class="pathCard">
          <strong>${escapeHtml(p.label)}</strong>
          <div class="meta">${escapeHtml(p.short)}</div>
          <div class="bar"><div style="width:${pct}%"></div></div>
          <div class="meta">Signal: ${pct}%</div>
        </div>
      </div>
    `;
  };

  $compass.innerHTML = `${makeRow(1, top)}${makeRow(2, runner)}`;
  $confidencePill.textContent = `Confidence: ${state.confidence.label}`;

  const dom = dominantSignal();
  const domTextMap = {
    depth: "Depth / mastery is showing up most strongly.",
    scope: "Scope / responsibility is showing up most strongly.",
    breadth: "Breadth / perspective is showing up most strongly.",
    recalibration: "Recalibration / sustainability is showing up most strongly."
  };

  const line2 =
    state.confidence.band === "strong" ? "This is a clear signal — we can refine it with specifics." :
    state.confidence.band === "emerging" ? "This is forming — we’ll sharpen it with a few more choices." :
    "This is early — we’ll treat the next steps as evidence-building, not certainty.";

  $systemHearing.textContent = `${domTextMap[dom] || "We’re forming a signal."} ${line2}`;

  let progress = "—";
  if (state.phase === "diagnostic") {
    const total = CONFIG.diagnostic.questions.length;
    progress = `Diagnostic: question ${state.diagnostic.index + 1} of ${total}`;
  } else if (state.phase === "refinement") {
    const set = CONFIG.refinement.questionSets[state.pathIntent.primaryPath] || [];
    progress = `Refinement: question ${state.refinement.index + 1} of ${set.length}`;
  } else {
    progress = `Phase: ${state.phase}`;
  }
  $progressText.textContent = progress;
}

/* ------------------ screens ------------------ */

function renderIntro() {
  state.phase = "intro";
  $app.innerHTML = `
    <div class="screenTitle">Welcome</div>
    <h2 class="prompt">Pick a direction for your next chapter — without locking yourself in.</h2>
    <p class="subcopy">
      This is not a test. It’s a structured thinking partner. Answer a few questions, and the system will suggest a path,
      explain why, and help you translate it into something your People Leader can coach against.
    </p>
    <div class="controls">
      <span class="muted">Takes ~3–5 minutes.</span>
      <button class="primary" id="startBtn">${escapeHtml(CONFIG.templates.uiStrings.buttons.start)}</button>
    </div>
  `;
  document.getElementById("startBtn").onclick = () => {
    if (CONFIG.profile?.enabled) renderProfile();
    else startDiagnostic();
  };
  renderCompass();
}

function renderProfile() {
  state.phase = "profile";

  const fields = CONFIG.profile.fields || [];
  const fieldHtml = fields.map(f => {
    if (f.type === "select") {
      const opts = f.options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
      return `
        <div class="pathPick">
          <h3>${escapeHtml(f.label)}</h3>
          <select id="pf_${escapeHtml(f.id)}" style="width:100%; padding:10px 12px; border-radius:14px; border:1px solid var(--line); background:rgba(0,0,0,.25); color:var(--text)">
            <option value="">—</option>
            ${opts}
          </select>
        </div>
      `;
    }
    return "";
  }).join("");

  $app.innerHTML = `
    <div class="screenTitle">Optional</div>
    <h2 class="prompt">A tiny bit of context (optional)</h2>
    <p class="subcopy">Skip anything you don’t want to answer. This just helps wording and examples later.</p>

    <div class="grid2">${fieldHtml}</div>

    <div class="controls">
      <button id="skipBtn">Skip</button>
      <button class="primary" id="continueBtn">Continue</button>
    </div>
  `;

  document.getElementById("skipBtn").onclick = () => startDiagnostic();
  document.getElementById("continueBtn").onclick = () => {
    fields.forEach(f => {
      const el = document.getElementById(`pf_${f.id}`);
      if (el && el.value) state.profile[f.id] = el.value;
    });
    startDiagnostic();
  };

  renderCompass();
}

function startDiagnostic() {
  state.phase = "diagnostic";
  state.diagnostic.index = 0;
  state.diagnostic.answers = {};
  state.decisionLog = [];
  for (const k of Object.keys(state.signals)) state.signals[k] = 0;
  state.scales.ambiguity = null; state.scales.change = null; state.scales.readiness = null;
  initScores();
  computeConfidence();
  renderDiagnosticQuestion();
}

function renderDiagnosticQuestion() {
  renderCompass();
  const queue = CONFIG.diagnostic.questions;
  const q = queue[state.diagnostic.index];
  if (!q) return finishDiagnostic();

  const selected = state.diagnostic.answers[q.id] || (q.type === "multi" ? [] : null);

  const optionsHtml = q.options.map(opt => {
    const isSelected = q.type === "multi"
      ? Array.isArray(selected) && selected.includes(opt.id)
      : selected === opt.id;

    return `<button class="option ${isSelected ? "selected" : ""}" data-opt="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</button>`;
  }).join("");

  $app.innerHTML = `
    <div class="screenTitle">${escapeHtml(q.screenTitle || "Diagnostic")}</div>
    <h2 class="prompt">${escapeHtml(q.prompt)}</h2>
    <p class="subcopy">Go with your first honest answer.</p>

    <div class="options" id="options">${optionsHtml}</div>

    <div class="controls">
      <button id="backBtn" ${state.diagnostic.index === 0 ? "disabled" : ""}>Back</button>
      <button class="primary" id="nextBtn" disabled>${escapeHtml(CONFIG.templates.uiStrings.buttons.next)}</button>
    </div>
  `;

  const $options = document.getElementById("options");
  const $nextBtn = document.getElementById("nextBtn");

  function nextEnabled() {
    const ans = state.diagnostic.answers[q.id];
    if (q.type === "multi") return Array.isArray(ans) && ans.length > 0;
    return !!ans;
  }

  $options.querySelectorAll(".option").forEach(btn => {
    btn.onclick = () => {
      const optId = btn.getAttribute("data-opt");
      if (q.type === "multi") {
        const current = state.diagnostic.answers[q.id] || [];
        const next = current.includes(optId)
          ? current.filter(x => x !== optId)
          : (current.length < (q.maxSelections || 2) ? [...current, optId] : current);
        state.diagnostic.answers[q.id] = next;
      } else {
        state.diagnostic.answers[q.id] = optId;
      }
      renderDiagnosticQuestion();
    };
  });

  document.getElementById("backBtn").onclick = () => {
    state.diagnostic.index = Math.max(0, state.diagnostic.index - 1);
    recomputeFromDiagnosticAnswers(state.diagnostic.index);
    renderDiagnosticQuestion();
  };

  $nextBtn.onclick = () => {
    // confirm current answer, then move forward
    recomputeFromDiagnosticAnswers(state.diagnostic.index + 1);
    state.diagnostic.index += 1;
    renderDiagnosticQuestion();
  };

  $nextBtn.disabled = !nextEnabled();
}

function recomputeFromDiagnosticAnswers(upToExclusiveIndex) {
  // full recompute = correct back button behavior
  for (const k of Object.keys(state.signals)) state.signals[k] = 0;
  state.scales.ambiguity = null; state.scales.change = null; state.scales.readiness = null;
  initScores();
  state.decisionLog = [];

  const queue = CONFIG.diagnostic.questions;
  for (let i = 0; i < upToExclusiveIndex; i++) {
    const q = queue[i];
    if (!q) continue;
    const ans = state.diagnostic.answers[q.id];
    if (!ans) continue;

    const applyOption = (opt) => {
      addSignals(opt.signals);
      addPathScore(opt.pathScore);
      state.decisionLog.push({
        phase: "diagnostic",
        questionId: q.id,
        optionId: opt.id,
        prompt: q.prompt,
        answerLabel: opt.label,
        inferredSignals: opt.signals || {},
        scoreDeltas: opt.pathScore || {}
      });
    };

    if (q.type === "multi") {
      const picks = Array.isArray(ans) ? ans : [];
      q.options.filter(o => picks.includes(o.id)).forEach(applyOption);
    } else {
      const opt = q.options.find(o => o.id === ans);
      if (opt) applyOption(opt);
    }
  }

  computeConfidence();
  renderCompass();
}

function finishDiagnostic() {
  const { top, runner } = computeTopTwo();
  state.pathIntent.primaryPath = top?.id || "expandView";
  state.pathIntent.secondaryPath = runner?.id || "moveAcross";
  state.pathIntent.chosenBy = "recommendation";

  applyRoutingOverridesIfNeeded();

  state.phase = "recommendation";
  renderRecommendation();
}

function renderRecommendation() {
  renderCompass();

  const primary = getPathById(state.pathIntent.primaryPath);
  const secondary = getPathById(state.pathIntent.secondaryPath);

  $app.innerHTML = `
    <div class="screenTitle">Recommendation</div>
    <h2 class="prompt">You’re leaning toward: ${escapeHtml(primary.label)}</h2>
    <p class="subcopy">${escapeHtml(primary.short)}</p>

    <div class="grid2">
      <div class="pathPick">
        <h3>Why this fits</h3>
        <div class="summaryBox">${escapeHtml(listWhyBullets())}</div>
      </div>

      <div class="pathPick">
        <h3>Close second</h3>
        <p><strong>${escapeHtml(secondary.label)}</strong></p>
        <p class="muted" style="margin-top:8px">${escapeHtml(secondary.short)}</p>
        <p class="muted" style="margin-top:8px">Confidence: <strong>${escapeHtml(state.confidence.label)}</strong></p>
      </div>
    </div>

    <div class="controls" style="margin-top:14px">
      <button id="chooseDifferentBtn">${escapeHtml(CONFIG.templates.uiStrings.buttons.chooseDifferent)}</button>
      <div style="display:flex; gap:10px">
        <button id="compareBtn">${escapeHtml(CONFIG.templates.uiStrings.buttons.compare)}</button>
        <button class="primary" id="exploreBtn">${escapeHtml(CONFIG.templates.uiStrings.buttons.explorePrimary)}</button>
      </div>
    </div>
  `;

  document.getElementById("exploreBtn").onclick = () => startRefinement(state.pathIntent.primaryPath);
  document.getElementById("compareBtn").onclick = () => renderCompare(primary.id, secondary.id);
  document.getElementById("chooseDifferentBtn").onclick = () => renderChooseDifferent();
}

function renderCompare(aId, bId) {
  const a = getPathById(aId);
  const b = getPathById(bId);

  $app.innerHTML = `
    <div class="screenTitle">Compare</div>
    <h2 class="prompt">Pressure-test your direction</h2>
    <p class="subcopy">Pick the path that feels more like the next honest move — not the “should.”</p>

    <div class="grid2">
      <div class="pathPick">
        <h3>${escapeHtml(a.label)}</h3>
        <p>${escapeHtml(a.short)}</p>
        <button class="primary" style="margin-top:12px" id="pickA">Go with ${escapeHtml(a.label)}</button>
      </div>

      <div class="pathPick">
        <h3>${escapeHtml(b.label)}</h3>
        <p>${escapeHtml(b.short)}</p>
        <button class="primary" style="margin-top:12px" id="pickB">Go with ${escapeHtml(b.label)}</button>
      </div>
    </div>

    <div class="controls">
      <button id="backBtn">Back</button>
      <button id="notSureBtn">I’m still not sure</button>
    </div>
  `;

  document.getElementById("pickA").onclick = () => {
    state.pathIntent.primaryPath = aId;
    state.pathIntent.secondaryPath = bId;
    state.pathIntent.chosenBy = "userOverride";
    startRefinement(aId);
  };
  document.getElementById("pickB").onclick = () => {
    state.pathIntent.primaryPath = bId;
    state.pathIntent.secondaryPath = aId;
    state.pathIntent.chosenBy = "userOverride";
    startRefinement(bId);
  };
  document.getElementById("backBtn").onclick = () => renderRecommendation();
  document.getElementById("notSureBtn").onclick = () => {
    state.pathIntent.primaryPath = "expandView";
    state.pathIntent.chosenBy = "userOverride";
    startRefinement("expandView");
  };
}

function renderChooseDifferent() {
  const cards = CONFIG.paths.map(p => `
    <div class="pathPick">
      <h3>${escapeHtml(p.label)}</h3>
      <p>${escapeHtml(p.short)}</p>
      <button class="primary" data-pick="${escapeHtml(p.id)}" style="margin-top:12px">Choose ${escapeHtml(p.label)}</button>
    </div>
  `).join("");

  $app.innerHTML = `
    <div class="screenTitle">Choose</div>
    <h2 class="prompt">Pick a different path</h2>
    <p class="subcopy">No penalty for overriding. Sometimes your gut knows before the math does.</p>
    <div class="grid2">${cards}</div>
    <div class="controls">
      <button id="backBtn">Back</button>
    </div>
  `;

  $app.querySelectorAll("button[data-pick]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-pick");
      state.pathIntent.primaryPath = id;
      state.pathIntent.chosenBy = "userOverride";
      startRefinement(id);
    };
  });

  document.getElementById("backBtn").onclick = () => renderRecommendation();
}

function startRefinement(pathId) {
  state.phase = "refinement";
  state.refinement.index = 0;
  state.refinement.answers = {};
  state.pathIntent.primaryPath = pathId;
  if (!state.pathIntent.versionOfPath[pathId]) state.pathIntent.versionOfPath[pathId] = {};
  renderRefinementQuestion();
}

function renderRefinementQuestion() {
  renderCompass();

  const pathId = state.pathIntent.primaryPath;
  const set = CONFIG.refinement.questionSets[pathId] || [];
  const q = set[state.refinement.index];

  if (!q) return startPlan();

  const selected = state.refinement.answers[q.id] || (q.type === "multi" ? [] : null);

  const optionsHtml = q.options.map(opt => {
    const isSelected = q.type === "multi"
      ? Array.isArray(selected) && selected.includes(opt.id)
      : selected === opt.id;
    return `<button class="option ${isSelected ? "selected" : ""}" data-opt="${escapeHtml(opt.id)}">${escapeHtml(opt.label)}</button>`;
  }).join("");

  $app.innerHTML = `
    <div class="screenTitle">${escapeHtml(q.screenTitle || "Refinement")}</div>
    <h2 class="prompt">${escapeHtml(q.prompt)}</h2>
    <p class="subcopy">This is where we make the path specific enough to coach.</p>

    <div class="options" id="options">${optionsHtml}</div>

    <div class="controls">
      <button id="backBtn" ${state.refinement.index === 0 ? "disabled" : ""}>Back</button>
      <button class="primary" id="nextBtn" disabled>${escapeHtml(CONFIG.templates.uiStrings.buttons.next)}</button>
    </div>
  `;

  const $options = document.getElementById("options");
  const $nextBtn = document.getElementById("nextBtn");

  function nextEnabled() {
    const ans = state.refinement.answers[q.id];
    if (q.type === "multi") return Array.isArray(ans) && ans.length > 0;
    return !!ans;
  }

  $options.querySelectorAll(".option").forEach(btn => {
    btn.onclick = () => {
      const optId = btn.getAttribute("data-opt");
      if (q.type === "multi") {
        const current = state.refinement.answers[q.id] || [];
        const next = current.includes(optId)
          ? current.filter(x => x !== optId)
          : (current.length < (q.maxSelections || 2) ? [...current, optId] : current);
        state.refinement.answers[q.id] = next;
      } else {
        state.refinement.answers[q.id] = optId;
      }
      renderRefinementQuestion();
    };
  });

  document.getElementById("backBtn").onclick = () => {
    state.refinement.index = Math.max(0, state.refinement.index - 1);
    renderRefinementQuestion();
  };

  $nextBtn.onclick = () => {
    applyRefinementAnswerToState(q);
    state.refinement.index += 1;
    renderRefinementQuestion();
  };

  $nextBtn.disabled = !nextEnabled();
}

function applyRefinementAnswerToState(q) {
  const pathId = state.pathIntent.primaryPath;
  const v = state.pathIntent.versionOfPath[pathId] || (state.pathIntent.versionOfPath[pathId] = {});
  const ans = state.refinement.answers[q.id];
  if (!ans) return;

  const applyOption = (opt) => {
    if (opt.sets) {
      for (const [k,val] of Object.entries(opt.sets)) {
        const key = k.startsWith("versionOfPath.") ? k.replace("versionOfPath.", "") : k;
        setDeep(v, key, val);
      }
    }
    addSignals(opt.signals);
    state.decisionLog.push({
      phase: "refinement",
      pathId,
      questionId: q.id,
      optionId: opt.id,
      prompt: q.prompt,
      answerLabel: opt.label,
      sets: opt.sets || {}
    });
  };

  if (q.type === "multi") {
    const picks = Array.isArray(ans) ? ans : [];
    q.options.filter(o => picks.includes(o.id)).forEach(applyOption);
  } else {
    const opt = q.options.find(o => o.id === ans);
    if (opt) applyOption(opt);
  }
}

function startPlan() {
  state.phase = "plan";
  state.plan.experimentsSelected = pickDefaultExperimentsForPath(state.pathIntent.primaryPath);
  state.focusStatement = buildFocusStatement(state.pathIntent.primaryPath);
  renderPlan();
}

function renderPlan() {
  renderCompass();

  const pathId = state.pathIntent.primaryPath;
  const library = CONFIG.experiments.library.filter(e => e.path === pathId);
  const max = CONFIG.experiments.selectionRules.maxPickCount || 3;

  const isSelected = (id) => state.plan.experimentsSelected.some(x => x.id === id);

  const cards = library.map(e => `
    <button class="option ${isSelected(e.id) ? "selected" : ""}" data-exp="${escapeHtml(e.id)}">
      ${escapeHtml(e.label)}
      <small>${escapeHtml(e.timeframeDays)} days (suggested)</small>
    </button>
  `).join("");

  const selectedList = state.plan.experimentsSelected.map(e => `• ${e.label}`).join("\n") || "• (none yet)";

  $app.innerHTML = `
    <div class="screenTitle">Plan</div>
    <h2 class="prompt">Choose 1–3 experiments</h2>
    <p class="subcopy">These are practical moves that create evidence. Pick what feels both realistic and meaningful.</p>

    <div class="grid2">
      <div>
        <div class="sectionTitle">Suggestions for ${escapeHtml(getPathById(pathId).label)}</div>
        <div class="options" id="expOptions">${cards}</div>
        <div class="smallNote">Tip: start with two. If you choose three, make one lightweight.</div>
      </div>

      <div>
        <div class="sectionTitle">Your focus statement</div>
        <textarea id="focusText">${escapeHtml(state.focusStatement)}</textarea>

        <div class="sectionTitle">What to discuss with your People Leader</div>
        <textarea id="openQuestion">${escapeHtml(state.openQuestion)}</textarea>

        <div class="sectionTitle">Selected experiments</div>
        <div class="summaryBox" id="selectedList">${escapeHtml(selectedList)}</div>
      </div>
    </div>

    <div class="controls">
      <button id="backBtn">Back</button>
      <button class="primary" id="nextBtn">Generate summaries</button>
    </div>
  `;

  const $expOptions = document.getElementById("expOptions");

  $expOptions.querySelectorAll("button[data-exp]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute("data-exp");
      const e = CONFIG.experiments.library.find(x => x.id === id);
      if (!e) return;

      if (isSelected(id)) {
        state.plan.experimentsSelected = state.plan.experimentsSelected.filter(x => x.id !== id);
      } else if (state.plan.experimentsSelected.length < max) {
        state.plan.experimentsSelected = [...state.plan.experimentsSelected, e];
      }

      renderPlan();
    };
  });

  document.getElementById("backBtn").onclick = () => {
    // go back to refinement last question
    startRefinement(state.pathIntent.primaryPath);
    const set = CONFIG.refinement.questionSets[state.pathIntent.primaryPath] || [];
    state.refinement.index = Math.max(0, set.length - 1);
    renderRefinementQuestion();
  };

  document.getElementById("nextBtn").onclick = () => {
    state.focusStatement = document.getElementById("focusText").value.trim() || state.focusStatement;
    state.openQuestion = document.getElementById("openQuestion").value.trim() || state.openQuestion;

    // refresh focus statement to reflect selected experiment #1 if they left it default
    if (!state.focusStatement || state.focusStatement.length < 10) {
      state.focusStatement = buildFocusStatement(state.pathIntent.primaryPath);
    }

    generateSummaries();
    renderSummary();
  };
}

function generateSummaries() {
  const primaryPath = state.pathIntent.primaryPath;
  const secondaryPath = state.pathIntent.secondaryPath || state.confidence.runnerUp || "expandView";

  const primary = getPathById(primaryPath);
  const secondary = getPathById(secondaryPath);

  const whyBullets = listWhyBullets();
  const experimentBullets = state.plan.experimentsSelected.length
    ? state.plan.experimentsSelected.map(e => `• ${e.label}`).join("\n")
    : "• (No experiments selected.)";

  const evidenceBullets = evidenceBulletsFromDecisionLog(4);

  const translation = computeIntentTranslation(primaryPath);

  const coachingBullets = (translation.coachingFocus || []).map(x => `• ${x}`).join("\n") || "• (Coaching focus not set.)";
  const watchoutBullets = (translation.watchOuts || []).map(x => `• ${x}`).join("\n") || "• (No watch-outs.)";

  // NEW coaching-plan fields
  const leaderAsk = translation.leaderAsk || "Ask not captured yet — agree on what support would matter most.";
  const pressureTestQuestion = translation.pressureTestQuestion || "What would make this successful in a way we can observe together?";
  const successBullets = (translation.successLooksLike || []).map(x => `• ${x}`).join("\n") || "• Define 2–3 observable outcomes together.";
  const checkpointDays = translation.checkpointDays || 60;

  // Employee summary
  const employee =
`${CONFIG.templates.employeeSummary.title}

You’re leaning toward **${primary.label}** (with **${secondary.label}** as a close second). Confidence: **${state.confidence.label}**.

${CONFIG.templates.employeeSummary.sections.find(s=>s.id==="why").label}
${whyBullets}

${CONFIG.templates.employeeSummary.sections.find(s=>s.id==="meaning").label}
${state.focusStatement}

${CONFIG.templates.employeeSummary.sections.find(s=>s.id==="next").label}
${experimentBullets}

${CONFIG.templates.employeeSummary.sections.find(s=>s.id==="open").label}
${state.openQuestion}
`;

  // People Leader coaching plan
  const leader =
`${CONFIG.templates.leaderSummary.title}

What the employee means
**${primary.label}** — ${translation.intentTranslation || ""}

Evidence from their choices
${evidenceBullets}

Coaching focus
${coachingBullets}

What they need from you
${leaderAsk}

One question to ask (verbatim)
${pressureTestQuestion}

How we’ll know this is working
${successBullets}

Checkpoint
Revisit this in ${checkpointDays} days.

Recommended experiments
${experimentBullets}

Watch-outs / pressure tests
${watchoutBullets}
`;

  state.summaries.employee = employee.trim();
  state.summaries.leader = leader.trim();
}

function renderSummary() {
  state.phase = "summary";
  renderCompass();

  const tab = state.summaryTab;
  const employee = state.summaries.employee;
  const leader = state.summaries.leader;

  $app.innerHTML = `
    <div class="screenTitle">Summary</div>
    <h2 class="prompt">Preview what you’ll share</h2>
    <p class="subcopy">Two versions. Same truth. Different audience.</p>

    <div class="tabs">
      <div class="tab ${tab==="employee" ? "on" : ""}" id="tabEmployee">For You</div>
      <div class="tab ${tab==="leader" ? "on" : ""}" id="tabLeader">For Your People Leader</div>
    </div>

    <div class="summaryBox" id="summaryText">${escapeHtml(tab==="employee" ? employee : leader)}</div>

    <div class="controls">
      <button id="backBtn">Back</button>
      <div style="display:flex; gap:10px">
        <button id="copyBtn">${escapeHtml(tab==="employee" ? CONFIG.templates.uiStrings.buttons.copyEmployee : CONFIG.templates.uiStrings.buttons.copyLeader)}</button>
        <button class="primary" id="shareBtn">Share options</button>
      </div>
    </div>
  `;

  document.getElementById("tabEmployee").onclick = () => { state.summaryTab = "employee"; renderSummary(); };
  document.getElementById("tabLeader").onclick = () => { state.summaryTab = "leader"; renderSummary(); };

  document.getElementById("backBtn").onclick = () => renderPlan();

  document.getElementById("copyBtn").onclick = async () => {
    const txt = (state.summaryTab === "employee") ? state.summaries.employee : state.summaries.leader;
    try {
      await navigator.clipboard.writeText(txt);
      alert("Copied to clipboard.");
    } catch {
      alert("Copy failed in this browser. You can manually select and copy the text.");
    }
  };

  document.getElementById("shareBtn").onclick = () => renderShare();
}

function renderShare() {
  state.phase = "share";
  renderCompass();

  $app.innerHTML = `
    <div class="screenTitle">Share</div>
    <h2 class="prompt">Bring this into your conversation</h2>
    <p class="subcopy">Simple, practical options (no saving in this prototype).</p>

    <div class="grid2">
      <div class="pathPick">
        <h3>Recommended</h3>
        <p>Copy the <strong>People Leader</strong> brief and paste it into your 1:1 notes or an email.</p>
        <button class="primary" id="copyLeaderBtn" style="margin-top:12px">Copy People Leader brief</button>
      </div>

      <div class="pathPick">
        <h3>Also useful</h3>
        <p>Copy your own version for reference. Or re-run the diagnostic if you want to test a different direction.</p>
        <div style="display:flex; gap:10px; margin-top:12px; flex-wrap:wrap">
          <button id="copyEmpBtn">Copy my summary</button>
          <button id="restartBtn">Start over</button>
        </div>
      </div>
    </div>

    <div class="sectionTitle">How to use this in the 1:1</div>
    <div class="summaryBox">• Start with the focus statement.\n• Ask your People Leader to help choose one experiment.\n• Agree on a check-in date to evaluate what you learned.</div>

    <div class="controls">
      <button id="backBtn">Back</button>
      <button class="primary" id="doneBtn">Done</button>
    </div>
  `;

  document.getElementById("copyLeaderBtn").onclick = async () => {
    try { await navigator.clipboard.writeText(state.summaries.leader); alert("Copied."); }
    catch { alert("Copy failed. Select and copy manually."); }
  };
  document.getElementById("copyEmpBtn").onclick = async () => {
    try { await navigator.clipboard.writeText(state.summaries.employee); alert("Copied."); }
    catch { alert("Copy failed. Select and copy manually."); }
  };
  document.getElementById("restartBtn").onclick = () => startDiagnostic();
  document.getElementById("backBtn").onclick = () => renderSummary();
  document.getElementById("doneBtn").onclick = () => renderIntro();
}

/* ------------------ boot ------------------ */

async function boot() {
  state.phase = "loading";
  $app.innerHTML = `<div class="screenTitle">Loading</div><h2 class="prompt">Loading configuration…</h2><p class="subcopy muted">If you’re running locally, you may need to use GitHub Pages or a local server (not file://).</p>`;

  const res = await fetch(CONFIG_URL, { cache: "no-store" });
  CONFIG = await res.json();

  initScores();
  computeConfidence();
  renderIntro();
}

boot().catch(err => {
  console.error(err);
  $app.innerHTML = `<div class="screenTitle">Error</div><h2 class="prompt">Could not load config.</h2><p class="subcopy">Make sure <code>${CONFIG_URL}</code> exists and your JSON is valid.</p>`;
});
