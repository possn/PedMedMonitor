
/* PedMedMonitor — PK/PD toy-model (1 compartimento) — uso educacional.
   Autor: ChatGPT (código gerado)
*/

const $ = (id) => document.getElementById(id);

const state = {
  chart: null,
  last: null,   // last simulation object
  cl_adj: null, // calibrated clearance multiplier (from measured level)
};

// ---------- Utilities ----------
function num(v, fallback=null){
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : fallback;
}
function clamp(x,a,b){ return Math.min(Math.max(x,a),b); }

function ageYears(){
  const d = num($("age_d").value,0);
  const m = num($("age_m").value,0);
  const y = num($("age_y").value,0);
  return (d/365.25) + (m/12) + y;
}

function format(n, digits=2){
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

// ---------- Renal function ----------
function eGFR_Schwartz_cm_mgdl(height_cm, scr_mgdl){
  // Bedside Schwartz (2009): eGFR (mL/min/1.73m2) = 0.413 * height(cm) / SCr(mg/dL)
  if (!Number.isFinite(height_cm) || !Number.isFinite(scr_mgdl) || scr_mgdl<=0) return null;
  return 0.413 * height_cm / scr_mgdl;
}

function CrCl_CockcroftGault(age_y, wt_kg, scr_mgdl, sex){
  // mL/min (not BSA indexed)
  if (![age_y, wt_kg, scr_mgdl].every(Number.isFinite) || scr_mgdl<=0) return null;
  const sexFactor = (sex==="F") ? 0.85 : 1.0;
  return ((140 - age_y) * wt_kg * sexFactor) / (72 * scr_mgdl);
}

// ---------- Default PK parameters (typical) ----------
function defaultPK(abx, wt){
  // returns {V_L, CL_L_h, k_h, tHalf_h, notes[]}
  const notes = [];
  const scr = num($("scr").value, null);
  const ht = num($("ht").value, null);
  const sex = $("sex").value;
  const age_y = ageYears();

  // renal estimate
  let renal_ml_min = null;
  let renal_label = "—";
  if (age_y < 18){
    const egfr = eGFR_Schwartz_cm_mgdl(ht, scr);
    if (egfr){
      renal_ml_min = egfr; // mL/min/1.73
      renal_label = `eGFR Schwartz ≈ ${format(egfr,0)} mL/min/1.73m²`;
      notes.push("Pediatria: eGFR por Schwartz (2009).");
    } else {
      notes.push("Sem altura/creatinina válidas: usa-se PK típica (menos personalizada).");
    }
  } else {
    const crcl = CrCl_CockcroftGault(age_y, wt, scr, sex);
    if (crcl){
      renal_ml_min = crcl; // mL/min
      renal_label = `CrCl Cockcroft–Gault ≈ ${format(crcl,0)} mL/min`;
      notes.push("Adulto: CrCl por Cockcroft–Gault.");
    } else {
      notes.push("Sem peso/creatinina válidos: usa-se PK típica (menos personalizada).");
    }
  }

  // base V and CL
  let V_L, CL_L_h;

  // convert renal to L/h (rough)
  // 1 mL/min = 0.06 L/h
  const renal_L_h = renal_ml_min ? (renal_ml_min * 0.06) : null;

  if (abx === "vanco_int" || abx === "vanco_ci"){
    // Vancomicina: V ~ 0.7 L/kg; CL ~ 0.75 * CrCl (adult) OR 0.045*eGFR*BSA? too complex
    V_L = 0.70 * wt;
    if (renal_L_h){
      // heuristic mapping
      // adult: CL ~ 0.75 * CrCl(L/h) ; pediatric: slightly higher scaling
      const scale = (age_y < 18) ? 0.85 : 0.75;
      CL_L_h = scale * renal_L_h;
      notes.push(`CL estimada a partir de função renal (heurística, escala=${scale}).`);
    } else {
      // fallback typical: 0.06 L/h/kg
      CL_L_h = 0.06 * wt;
      notes.push("CL típica usada: 0.06 L/h/kg (aprox.).");
    }
  } else {
    // Aminoglicosídeos: V ~ 0.25 L/kg; CL ~ 0.9*CrCl (adult) or higher in children.
    V_L = 0.25 * wt;
    if (renal_L_h){
      const scale = (age_y < 18) ? 1.05 : 0.90;
      CL_L_h = scale * renal_L_h;
      notes.push(`CL estimada a partir de função renal (heurística, escala=${scale}).`);
    } else {
      // fallback typical: 0.07 L/h/kg
      CL_L_h = 0.07 * wt;
      notes.push("CL típica usada: 0.07 L/h/kg (aprox.).");
    }
  }

  // apply calibration multiplier if present
  if (state.cl_adj && Number.isFinite(state.cl_adj) && state.cl_adj>0){
    CL_L_h *= state.cl_adj;
    notes.push(`CL calibrada por doseamento: multiplicador ${format(state.cl_adj,2)}×.`);
  }

  const k = CL_L_h / V_L;
  const tHalf = Math.log(2) / k;

  return { V_L, CL_L_h, k_h: k, tHalf_h: tHalf, renal_label, notes };
}

// ---------- Therapeutic targets ----------
function targetsFor(abx, indication){
  // returns {peak:[min,max] or null, trough:[min,max] or null, css:[min,max] for CI vanco}
  const t = { peak: null, trough: null, css: null, pd: "" };

  // Conservative default targets; allow indication bumps
  if (abx === "vanco_int"){
    // trough proxy for AUC; many protocols 10-15 (standard) 15-20 (severe). CNS often higher.
    if (indication === "std") t.trough = [10, 15];
    if (indication === "severe") t.trough = [15, 20];
    if (indication === "cns") t.trough = [15, 20];
    // peak often 25-40 (not routinely targeted)
    t.peak = [25, 40];
    t.pd = "PD: AUC/MIC (ideal). Aqui: vale como proxy + pico informativo.";
  }
  if (abx === "vanco_ci"){
    // steady-state concentration target often 20-25 (some 15-25) depending on desired AUC.
    if (indication === "std") t.css = [15, 20];
    if (indication === "severe") t.css = [20, 25];
    if (indication === "cns") t.css = [20, 25];
    t.pd = "PD: Css aproxima AUC (AUC≈Css*24). Ajustar com prudência.";
  }
  if (abx === "genta" || abx === "tobra"){
    // once-daily: peak 15-25, trough <1 (or <0.5). We'll use 15-25, trough 0-1.
    if (indication === "cns") t.peak = [20, 30]; else t.peak = [15, 25];
    t.trough = [0, 1];
    t.pd = "PD: Cmax/MIC (concentração-dependente) + toxicidade (vale baixo).";
  }
  if (abx === "amika"){
    if (indication === "cns") t.peak = [30, 45]; else t.peak = [25, 40];
    t.trough = [0, 5]; // trough <5 often targeted
    t.pd = "PD: Cmax/MIC + toxicidade (vale baixo).";
  }
  return t;
}

// ---------- PK equations ----------
function conc_intermittent_1c({dose_mg, t_inf_h, tau_h, k_h, V_L, n_doses, t_grid_h}){
  // multiple dosing at steady-ish state after n_doses.
  // We approximate by summing contributions of each previous dose up to n_doses.
  // For 1-comp infusion: during infusion: (R0/(V*k))*(1-exp(-k*t))
  // after infusion: C_end*exp(-k*(t-tinf))
  const R0 = dose_mg / t_inf_h; // mg/h
  const k = k_h;
  const V = V_L;

  function singleDoseConc(t){
    if (t < 0) return 0;
    if (t <= t_inf_h){
      return (R0/(V*k))*(1 - Math.exp(-k*t));
    } else {
      const Cend = (R0/(V*k))*(1 - Math.exp(-k*t_inf_h));
      return Cend * Math.exp(-k*(t - t_inf_h));
    }
  }

  const C = [];
  for (const t of t_grid_h){
    let sum = 0;
    // doses at times 0, tau, 2tau ... (n_doses-1)*tau
    for (let i=0; i<n_doses; i++){
      const tdose = i * tau_h;
      sum += singleDoseConc(t - tdose);
    }
    C.push(sum);
  }
  return C;
}

function conc_continuous_1c({rate_mg_h, k_h, V_L, t_grid_h}){
  // constant infusion from time 0
  // C(t)= (R0/(V*k))*(1-exp(-k*t))
  const R0 = rate_mg_h;
  const k = k_h;
  const V = V_L;
  return t_grid_h.map(t => (R0/(V*k))*(1 - Math.exp(-k*t)));
}

// ---------- Evaluation ----------
function evalAgainstTargets(sim, targs){
  // Determine peak/trough from last interval of grid
  const {t_grid_h, C, tau_h, t_inf_h, abx} = sim;

  // consider last dosing window: [ (n-1)*tau , n*tau ]
  const t0 = (sim.n_doses - 1) * tau_h;
  const within = t_grid_h.map((t, idx) => ({t, c:C[idx]})).filter(p => p.t >= t0 && p.t <= t0 + tau_h + 1e-9);

  let peak = null, trough = null, t_peak = null, t_trough=null;
  if (abx === "vanco_ci"){
    // steady-state approximated at end of grid
    peak = within[within.length-1]?.c ?? null;
    trough = peak;
    t_peak = within[within.length-1]?.t ?? null;
    t_trough = t_peak;
  } else {
    // peak: at end of infusion for last dose (t0 + t_inf)
    const tpeakTarget = t0 + t_inf_h;
    let bestPeak = within[0];
    for (const p of within){
      if (Math.abs(p.t - tpeakTarget) < Math.abs(bestPeak.t - tpeakTarget)) bestPeak = p;
    }
    peak = bestPeak.c; t_peak = bestPeak.t;

    // trough: right before next dose (t0 + tau)
    const ttroughTarget = t0 + tau_h;
    let bestTrough = within[within.length-1];
    for (const p of within){
      if (Math.abs(p.t - ttroughTarget) < Math.abs(bestTrough.t - ttroughTarget)) bestTrough = p;
    }
    trough = bestTrough.c; t_trough = bestTrough.t;
  }

  // classify
  function classify(val, band){
    if (!band || !Number.isFinite(val)) return {cls:"—", score:null};
    if (val < band[0]) return {cls:"insuficiente", score: val/band[0]};
    if (val > band[1]) return {cls:"excessiva", score: val/band[1]};
    return {cls:"adequada", score: 1};
  }

  let main = null;
  if (abx === "vanco_ci"){
    main = classify(peak, targs.css);
  } else {
    // aminoglycosides: trough toxicity dominates; vanco trough dominates.
    if (abx === "vanco_int"){
      main = classify(trough, targs.trough);
    } else {
      // trough should be low; if trough high -> excessive; else check peak
      const tr = classify(trough, targs.trough);
      if (tr.cls === "excessiva") main = tr;
      else main = classify(peak, targs.peak);
    }
  }

  return {peak, trough, t_peak, t_trough, main};
}

// ---------- Dose suggestion ----------
function suggestAdjustment(sim, targs, evalr){
  const abx = sim.abx;
  const k = sim.k_h;
  const tau = sim.tau_h;
  const t_inf = sim.t_inf_h;

  let suggestion = { newDose_mg: null, newTau_h: null, rationale: [] };

  // base: proportional adjustment to match main target midpoint
  function midpoint(b){ return (b[0]+b[1])/2; }

  if (abx === "vanco_ci"){
    const target = midpoint(targs.css);
    if (!Number.isFinite(evalr.peak) || !Number.isFinite(target)) return suggestion;
    const factor = target / evalr.peak;
    suggestion.rationale.push(`Ajuste proporcional (Css): factor ≈ ${format(factor,2)}×`);
    suggestion.newTau_h = null;
    suggestion.newDose_mg = null;
    suggestion.newRate_mg_h = sim.rate_mg_h * factor;
    return suggestion;
  }

  // for intermittent: adjust dose first
  // For 1-comp linear model, C scales ~ dose; so dose factor ~ target/measured (peak or trough)
  if (abx === "vanco_int"){
    const target = midpoint(targs.trough);
    const measured = evalr.trough;
    if (!Number.isFinite(measured) || !Number.isFinite(target) || measured<=0) return suggestion;
    const factor = target / measured;
    suggestion.newDose_mg = sim.dose_mg * factor;
    suggestion.newTau_h = sim.tau_h; // keep interval
    suggestion.rationale.push(`Tenta igualar vale ao alvo médio (${format(target,1)} mg/L) via dose: factor ≈ ${format(factor,2)}×.`);
    // If trough too high, consider extending interval as alternative
    if (evalr.trough > targs.trough[1]){
      // try interval that achieves target trough with same dose:
      // trough approx Cend*exp(-k*(tau-tinf))
      // Solve tau_new = tinf - (1/k)*ln(target_trough/Cend)
      const Cend = evalr.peak; // approx end-infusion peak for last dose
      const target_tr = target;
      if (Number.isFinite(Cend) && Cend>0 && target_tr>0){
        const tau_new = t_inf - (1/k)*Math.log(target_tr / Cend);
        if (Number.isFinite(tau_new) && tau_new>t_inf){
          suggestion.newTau_h_alt = tau_new;
          suggestion.rationale.push(`Alternativa: aumentar intervalo para τ≈${format(tau_new,1)} h (aprox.).`);
        }
      }
    }
    return suggestion;
  }

  // aminoglycosides: keep trough low; if trough high, extend interval; else adjust dose to peak
  const targetPeak = midpoint(targs.peak);
  const targetTroughMax = targs.trough[1];

  if (Number.isFinite(evalr.trough) && evalr.trough > targetTroughMax){
    // extend interval: trough = Cend*exp(-k*(tau-tinf)) -> tau = tinf - (1/k)*ln(trough/Cend)
    const Cend = evalr.peak;
    const desiredTrough = targetTroughMax;
    if (Number.isFinite(Cend) && Cend>0 && desiredTrough>0){
      const tau_new = t_inf - (1/k)*Math.log(desiredTrough / Cend);
      suggestion.newTau_h = tau_new;
      suggestion.newDose_mg = sim.dose_mg; // keep dose
      suggestion.rationale.push(`Vale elevado: prioriza reduzir toxicidade aumentando intervalo. τ≈${format(tau_new,1)} h (aprox.).`);
      return suggestion;
    }
  }

  if (Number.isFinite(evalr.peak) && evalr.peak>0 && Number.isFinite(targetPeak)){
    const factor = targetPeak / evalr.peak;
    suggestion.newDose_mg = sim.dose_mg * factor;
    suggestion.newTau_h = sim.tau_h;
    suggestion.rationale.push(`Ajuste proporcional para pico alvo médio (${format(targetPeak,1)} mg/L): factor ≈ ${format(factor,2)}×.`);
  }

  return suggestion;
}

// ---------- Calibration (1 measured point) ----------
function calibrateCL(sim, measured, meas_type, t_post_h, t_since_h){
  // adjust CL multiplier so that predicted concentration at the sampling time matches measured.
  // We keep V fixed and multiply k (i.e., CL) by m; solve by 1D search.
  if (!Number.isFinite(measured) || measured<=0) return null;

  // Determine sampling time relative to last dose start
  const t0 = (sim.n_doses - 1) * sim.tau_h;
  let t_sample = null;

  if (meas_type === "trough"){
    t_sample = t0 + sim.tau_h; // just before next dose
  } else if (meas_type === "peak"){
    // hours from end of infusion
    const dt = Number.isFinite(t_post_h) ? t_post_h : 0;
    t_sample = t0 + sim.t_inf_h + dt;
  } else { // random
    // prefer t_since_h (since dose start), else use t_post_h from end infusion
    if (Number.isFinite(t_since_h)){
      t_sample = t0 + t_since_h;
    } else if (Number.isFinite(t_post_h)){
      t_sample = t0 + sim.t_inf_h + t_post_h;
    } else {
      return null;
    }
  }

  // build quick function to predict concentration at t_sample for multiplier m
  const tgrid = [t_sample];

  function predictAt(m){
    const k = sim.k_h * m;
    const pk = {...sim, k_h:k};
    let C1;
    if (sim.abx === "vanco_ci"){
      const C = conc_continuous_1c({rate_mg_h: sim.rate_mg_h, k_h:k, V_L: sim.V_L, t_grid_h:tgrid});
      C1 = C[0];
    } else {
      const C = conc_intermittent_1c({
        dose_mg: sim.dose_mg, t_inf_h: sim.t_inf_h, tau_h: sim.tau_h,
        k_h:k, V_L: sim.V_L, n_doses: sim.n_doses, t_grid_h:tgrid
      });
      C1 = C[0];
    }
    return C1;
  }

  // bracket search m in [0.2, 4]
  let lo=0.2, hi=4.0;
  let f_lo = predictAt(lo) - measured;
  let f_hi = predictAt(hi) - measured;
  if (!Number.isFinite(f_lo) || !Number.isFinite(f_hi)) return null;

  // if not bracketed, still try secant-like clamp
  for (let iter=0; iter<40; iter++){
    const mid = (lo+hi)/2;
    const f_mid = predictAt(mid) - measured;
    if (!Number.isFinite(f_mid)) break;
    if (Math.abs(f_mid) < 1e-3) return mid;
    // bisect toward sign change; if no sign change, move toward smaller abs
    if (f_lo*f_mid <= 0){
      hi = mid; f_hi = f_mid;
    } else if (f_mid*f_hi <= 0){
      lo = mid; f_lo = f_mid;
    } else {
      // no bracket: keep side with smaller abs
      if (Math.abs(f_mid) < Math.abs(f_lo)){ lo = mid; f_lo = f_mid; }
      else { hi = mid; f_hi = f_mid; }
    }
  }
  const best = (Math.abs(f_lo) < Math.abs(f_hi)) ? lo : hi;
  return best;
}

// ---------- Simulation orchestration ----------
function buildSimulation(){
  const abx = $("abx").value;
  const indication = $("indication").value;

  const wt = num($("wt").value, null);
  if (!Number.isFinite(wt) || wt<=0) throw new Error("Peso inválido.");

  const dose_mg = num($("dose_mg").value, 0);
  const tau_h = num($("tau_h").value, 12);
  const t_inf_min = num($("t_inf_min").value, 60);
  const t_inf_h = clamp(t_inf_min/60, 0.25, 6);

  const rate_mg_h = num($("rate_mg_h").value, 0);
  const n_doses = Math.max(1, Math.floor(num($("n_doses").value, 4)));

  const pk = defaultPK(abx, wt);
  const targs = targetsFor(abx, indication);

  // grid: simulate up to n_doses*tau with finer resolution
  const t_end = (abx === "vanco_ci") ? 24 : (n_doses * tau_h);
  const dt = Math.max(0.05, Math.min(0.25, tau_h/80)); // 3–15 min roughly
  const t_grid_h = [];
  for (let t=0; t<=t_end + 1e-9; t+=dt) t_grid_h.push(+t.toFixed(5));

  let C;
  if (abx === "vanco_ci"){
    if (!(rate_mg_h>0)) throw new Error("Para perfusão contínua, preenche mg/h.");
    C = conc_continuous_1c({rate_mg_h, k_h: pk.k_h, V_L: pk.V_L, t_grid_h});
  } else {
    if (!(dose_mg>0)) throw new Error("Dose (mg) inválida.");
    C = conc_intermittent_1c({
      dose_mg, t_inf_h, tau_h, k_h: pk.k_h, V_L: pk.V_L, n_doses, t_grid_h
    });
  }

  const sim = {
    abx, indication,
    wt_kg: wt,
    dose_mg, tau_h, t_inf_h, n_doses, rate_mg_h,
    V_L: pk.V_L, CL_L_h: pk.CL_L_h, k_h: pk.k_h, tHalf_h: pk.tHalf_h,
    renal_label: pk.renal_label,
    notes: pk.notes,
    targs,
    t_grid_h, C
  };

  const evalr = evalAgainstTargets(sim, targs);
  sim.eval = evalr;
  sim.suggestion = suggestAdjustment(sim, targs, evalr);

  return sim;
}

// ---------- Chart ----------
function ensureChart(){
  if (state.chart) return state.chart;
  const ctx = $("pkChart").getContext("2d");
  state.chart = new Chart(ctx, {
    type: "line",
    data: { labels: [], datasets: [
      { label: "Concentração (mg/L)", data: [], borderWidth: 2, pointRadius: 0, tension: 0.25 },
      { label: "Nível medido", data: [], borderWidth: 0, pointRadius: 5, showLine: false },
      { label: "Alvo (mín)", data: [], borderWidth: 1, borderDash: [6,4], pointRadius: 0 },
      { label: "Alvo (máx)", data: [], borderWidth: 1, borderDash: [6,4], pointRadius: 0 },
    ]},
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: "Tempo (h)" }, ticks: { maxTicksLimit: 10 } },
        y: { title: { display: true, text: "mg/L" }, beginAtZero: true }
      },
      plugins: {
        legend: { labels: { color: "#e7eefc" } },
        tooltip: { callbacks: {
          label: (ctx)=> `${ctx.dataset.label}: ${format(ctx.parsed.y,2)}`
        }}
      }
    }
  });
  return state.chart;
}

function updateChart(sim){
  const ch = ensureChart();
  const labels = sim.t_grid_h.map(t => t);
  ch.data.labels = labels;

  ch.data.datasets[0].data = sim.C;

  // target bands: choose main band (trough for vanco_int; css for vanco_ci; peak for AG)
  let band = null;
  if (sim.abx === "vanco_ci") band = sim.targs.css;
  else if (sim.abx === "vanco_int") band = sim.targs.trough;
  else band = sim.targs.peak;

  const ymin = band ? labels.map(_=>band[0]) : labels.map(_=>null);
  const ymax = band ? labels.map(_=>band[1]) : labels.map(_=>null);
  ch.data.datasets[2].data = ymin;
  ch.data.datasets[3].data = ymax;

  // measured point
  const meas = num($("meas").value, null);
  const meas_type = $("meas_type").value;
  if (Number.isFinite(meas)){
    // place at approximate sampling time
    let ts = null;
    const t0 = (sim.n_doses - 1) * sim.tau_h;
    if (meas_type==="trough") ts = t0 + sim.tau_h;
    else if (meas_type==="peak") ts = t0 + sim.t_inf_h + (num($("t_post_h").value,0));
    else {
      ts = Number.isFinite(num($("t_since_h").value,null)) ? (t0 + num($("t_since_h").value,0)) : (t0 + sim.t_inf_h + num($("t_post_h").value,0));
    }
    // dataset uses same x labels positions, so map to nearest index
    let idx=0; let best=1e9;
    for (let i=0;i<labels.length;i++){
      const d = Math.abs(labels[i]-ts);
      if (d<best){best=d; idx=i;}
    }
    const pts = labels.map(_=>null);
    pts[idx]=meas;
    ch.data.datasets[1].data = pts;
  } else {
    ch.data.datasets[1].data = labels.map(_=>null);
  }

  ch.update();
}

// ---------- UI outputs ----------
function setBadge(cls){
  const b = $("statusBadge");
  b.classList.remove("good","warn","bad");
  if (cls==="adequada"){ b.textContent="ADEQUADA"; b.classList.add("good"); }
  else if (cls==="insuficiente"){ b.textContent="INSUFICIENTE"; b.classList.add("warn"); }
  else if (cls==="excessiva"){ b.textContent="EXCESSIVA"; b.classList.add("bad"); }
  else { b.textContent="—"; }
}

function render(sim){
  const ev = sim.eval;
  setBadge(ev.main?.cls ?? "—");

  const lines = [];
  lines.push(`V ≈ ${format(sim.V_L,1)} L`);
  lines.push(`CL ≈ ${format(sim.CL_L_h,2)} L/h`);
  lines.push(`k ≈ ${format(sim.k_h,3)} 1/h`);
  lines.push(`t½ ≈ ${format(sim.tHalf_h,1)} h`);
  lines.push(sim.renal_label);
  if (sim.notes?.length) lines.push("\nNotas:\n- " + sim.notes.join("\n- "));
  $("params").textContent = lines.join("\n");

  const t = sim.targs;
  const out = [];
  out.push(`PD: ${t.pd}`);
  if (t.peak) out.push(`Pico alvo: ${format(t.peak[0],0)}–${format(t.peak[1],0)} mg/L`);
  if (t.trough) out.push(`Vale alvo: ${format(t.trough[0],0)}–${format(t.trough[1],0)} mg/L`);
  if (t.css) out.push(`Css alvo: ${format(t.css[0],0)}–${format(t.css[1],0)} mg/L`);

  out.push("");
  out.push(`Previsto (último intervalo):`);
  out.push(`- Pico ≈ ${format(ev.peak,1)} mg/L (t≈${format(ev.t_peak,1)} h)`);
  out.push(`- Vale ≈ ${format(ev.trough,1)} mg/L (t≈${format(ev.t_trough,1)} h)`);

  const s = sim.suggestion;
  out.push("");
  out.push(`Sugestão matemática:`);
  if (sim.abx==="vanco_ci"){
    out.push(`- Taxa atual: ${format(sim.rate_mg_h,0)} mg/h`);
    out.push(`- Nova taxa (aprox.): ${format(s.newRate_mg_h,0)} mg/h`);
  } else {
    out.push(`- Dose atual: ${format(sim.dose_mg,0)} mg | τ=${format(sim.tau_h,0)} h | t_inf=${format(sim.t_inf_h,2)} h`);
    out.push(`- Nova dose (aprox.): ${format(s.newDose_mg,0)} mg | τ=${Number.isFinite(s.newTau_h)?format(s.newTau_h,1):format(sim.tau_h,0)} h`);
    if (Number.isFinite(s.newTau_h_alt)) out.push(`- Alternativa: manter dose e usar τ≈${format(s.newTau_h_alt,1)} h`);
  }
  if (s.rationale?.length) out.push("\nRacional:\n- " + s.rationale.join("\n- "));
  $("targets").textContent = out.join("\n");

  // status text
  const msg = [];
  msg.push(`Classificação principal: ${ev.main?.cls ?? "—"}.`);
  if (sim.abx==="vanco_ci"){
    msg.push(`Interpretação baseada em Css.`);
  } else if (sim.abx==="vanco_int"){
    msg.push(`Interpretação baseada no vale (proxy de exposição).`);
  } else {
    msg.push(`Interpretação baseada em pico (eficácia) e vale (toxicidade).`);
  }
  $("statusText").textContent = msg.join(" ");

  updateChart(sim);
}

// ---------- PDF ----------
async function exportPDF(){
  if (!state.last) { alert("Nada para exportar. Faz uma simulação primeiro."); return; }
  const sim = state.last;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });

  // header
  doc.setFont("helvetica","bold");
  doc.setFontSize(16);
  doc.text("PedMedMonitor — Relatório (educacional)", 40, 48);

  doc.setFont("helvetica","normal");
  doc.setFontSize(11);
  const id = $("pt_id").value?.trim() || "—";
  doc.text(`Doente ID: ${id}`, 40, 70);
  doc.text(`Antibiótico: ${$("abx").selectedOptions[0].text}`, 40, 88);

  // parameters
  const paramText = $("params").textContent.split("\n");
  doc.setFont("helvetica","bold"); doc.text("Parâmetros estimados", 40, 118);
  doc.setFont("courier","normal");
  doc.setFontSize(9);
  let y = 136;
  for (const line of paramText){
    doc.text(line, 40, y, { maxWidth: 515 });
    y += 12;
    if (y>360) break;
  }

  // targets/suggestion
  doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text("Alvos e sugestão", 40, 382);
  doc.setFont("courier","normal"); doc.setFontSize(9);
  const targText = $("targets").textContent.split("\n");
  y = 400;
  for (const line of targText){
    doc.text(line, 40, y, { maxWidth: 515 });
    y += 12;
    if (y>520) break;
  }

  // chart image
  const canvas = $("pkChart");
  const imgData = canvas.toDataURL("image/png", 1.0);
  doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text("Curva simulada", 40, 548);
  doc.addImage(imgData, "PNG", 40, 560, 515, 230);

  // footer disclaimer
  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text("Uso educacional — não substitui TDM formal, protocolos locais, nem decisão clínica.", 40, 812);

  doc.save("PedMedMonitor_relatorio.pdf");
}

// ---------- Presets ----------
function loadExample(){
  $("pt_id").value = "EX-001";
  $("sex").value = "M";
  $("wt").value = "70";
  $("ht").value = "175";
  $("age_y").value = "45";
  $("age_m").value = "0";
  $("age_d").value = "0";
  $("scr").value = "1.0";

  $("abx").value = "vanco_int";
  $("indication").value = "severe";
  $("dose_mg").value = "1000";
  $("t_inf_min").value = "60";
  $("tau_h").value = "12";
  $("n_doses").value = "4";
  $("mic").value = "1";

  $("meas").value = "17";
  $("meas_type").value = "trough";
  $("t_post_h").value = "1";
  $("t_since_h").value = "6";
  state.cl_adj = null;

  runSim();
}

function resetAll(){
  document.querySelectorAll("input").forEach(i => i.value = "");
  $("sex").value = "M";
  $("tau_h").value = "12";
  $("t_inf_min").value = "60";
  $("n_doses").value = "4";
  $("abx").value = "vanco_int";
  $("indication").value = "std";
  $("aki").value = "no";
  state.cl_adj = null;
  state.last = null;
  setBadge("—");
  $("params").textContent = "";
  $("targets").textContent = "";
  $("statusText").textContent = "Preenche os dados e clica Simular.";
  if (state.chart){
    state.chart.data.labels = [];
    state.chart.data.datasets.forEach(ds => ds.data = []);
    state.chart.update();
  }
}

// ---------- Handlers ----------
function runSim(){
  try{
    const sim = buildSimulation();
    state.last = sim;
    render(sim);
  } catch(e){
    alert(e.message || "Erro na simulação.");
  }
}

function doSuggest(){
  if (!state.last) { runSim(); return; }
  // already computed; re-render ensures visible
  render(state.last);
}

function doCalibrate(){
  try{
    // Need a base sim without calibration applied
    const oldAdj = state.cl_adj;
    state.cl_adj = null;
    const sim0 = buildSimulation();
    const measured = num($("meas").value, null);
    const meas_type = $("meas_type").value;
    const t_post_h = num($("t_post_h").value, null);
    const t_since_h = num($("t_since_h").value, null);

    const m = calibrateCL(sim0, measured, meas_type, t_post_h, t_since_h);
    if (!m) { alert("Não foi possível calibrar (verifica dados)."); state.cl_adj = oldAdj; return; }
    state.cl_adj = m; // apply
    const sim = buildSimulation();
    state.last = sim;
    render(sim);
  } catch(e){
    alert(e.message || "Erro na calibração.");
  }
}

// show/hide rate field depending on abx
function toggleFields(){
  const abx = $("abx").value;
  $("rate_mg_h").disabled = (abx !== "vanco_ci");
  $("dose_mg").disabled = (abx === "vanco_ci");
  $("t_inf_min").disabled = (abx === "vanco_ci");
  $("tau_h").disabled = (abx === "vanco_ci");
}

$("btnSim").addEventListener("click", runSim);
$("btnSuggest").addEventListener("click", doSuggest);
$("btnCal").addEventListener("click", doCalibrate);
$("btnPDF").addEventListener("click", exportPDF);
$("btnExample").addEventListener("click", loadExample);
$("btnReset").addEventListener("click", resetAll);
$("abx").addEventListener("change", ()=>{ toggleFields(); state.cl_adj=null; });

toggleFields();
ensureChart();
