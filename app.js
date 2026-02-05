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
      const opts =
