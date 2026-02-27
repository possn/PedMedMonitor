
/* PedMedMonitor — PK/PD toy-model (1 compartimento) — uso educacional.
   - Vancomicina: modos Pico/Vale (proxy), AUC/MIC, Perfusão contínua (Css)
   - Aminoglicosídeos: regimes Dose única diária vs Múltiplas doses
   - Calibração opcional por 1 doseamento (ajusta CL)
*/

const $ = (id) => document.getElementById(id);

const state = { chart: null, last: null, cl_adj: null };

// ---------- Utils ----------
function num(v, fallback=null){ const x = parseFloat(v); return Number.isFinite(x) ? x : fallback; }
function clamp(x,a,b){ return Math.min(Math.max(x,a),b); }
function ageYears(){
  const d = num($("age_d").value,0);
  const m = num($("age_m").value,0);
  const y = num($("age_y").value,0);
  return (d/365.25) + (m/12) + y;
}
function fmt(n, digits=2){ return Number.isFinite(n) ? n.toFixed(digits) : "—"; }

// ---------- Renal ----------
function eGFR_Schwartz(height_cm, scr){ if(!Number.isFinite(height_cm)||!Number.isFinite(scr)||scr<=0) return null; return 0.413*height_cm/scr; }
function CrCl_CG(age_y, wt, scr, sex){
  if(![age_y,wt,scr].every(Number.isFinite) || scr<=0) return null;
  const sexFactor = (sex==="F") ? 0.85 : 1.0;
  return ((140-age_y)*wt*sexFactor)/(72*scr);
}

// ---------- PK defaults (heurísticos) ----------
function defaultPK(abx, wt){
  const notes = [];
  const scr = num($("scr").value, null);
  const ht  = num($("ht").value, null);
  const sex = $("sex").value;
  const age_y = ageYears();

  let renal_ml_min = null;
  let renal_label = "Função renal: —";

  if (age_y < 18){
    const egfr = eGFR_Schwartz(ht, scr);
    if (egfr){
      renal_ml_min = egfr;
      renal_label = `eGFR Schwartz ≈ ${fmt(egfr,0)} mL/min/1.73m²`;
      notes.push("Pediatria: eGFR por Schwartz (2009).");
    } else notes.push("Sem altura/creatinina válidas: PK típica.");
  } else {
    const crcl = CrCl_CG(age_y, wt, scr, sex);
    if (crcl){
      renal_ml_min = crcl;
      renal_label = `CrCl Cockcroft–Gault ≈ ${fmt(crcl,0)} mL/min`;
      notes.push("Adulto: CrCl por Cockcroft–Gault.");
    } else notes.push("Sem creatinina/peso válidos: PK típica.");
  }

  const renal_L_h = renal_ml_min ? (renal_ml_min*0.06) : null;

  let V_L, CL_L_h;
  if (abx.startsWith("vanco")){
    V_L = 0.70*wt;
    if (renal_L_h){
      const scale = (age_y<18) ? 0.85 : 0.75;
      CL_L_h = scale*renal_L_h;
      notes.push(`CL por função renal (escala=${scale}).`);
    } else {
      CL_L_h = 0.06*wt;
      notes.push("CL típica: 0.06 L/h/kg.");
    }
  } else {
    V_L = 0.25*wt;
    if (renal_L_h){
      const scale = (age_y<18) ? 1.05 : 0.90;
      CL_L_h = scale*renal_L_h;
      notes.push(`CL por função renal (escala=${scale}).`);
    } else {
      CL_L_h = 0.07*wt;
      notes.push("CL típica: 0.07 L/h/kg.");
    }
  }

  if (state.cl_adj && Number.isFinite(state.cl_adj) && state.cl_adj>0){
    CL_L_h *= state.cl_adj;
    notes.push(`CL calibrada: ×${fmt(state.cl_adj,2)}.`);
  }

  const k = CL_L_h / V_L;
  const tHalf = Math.log(2)/k;
  return {V_L, CL_L_h, k_h:k, tHalf_h:tHalf, renal_label, notes};
}

// ---------- Targets ----------
function vancoTargets(indication){
  const auc = (indication==="std") ? [400,600] : [450,650];   // heurístico
  const trough = (indication==="std") ? [10,15] : [15,20];
  const peak = [25,40];
  const css = (indication==="std") ? [15,20] : [20,25];
  return {auc, trough, peak, css};
}
function agTargets(abx, indication, ag_mode){
  if (abx==="genta" || abx==="tobra"){
    if (ag_mode==="once"){
      const peak = (indication==="cns") ? [25,35] : [18,30];
      const trough = [0,1];
      return {peak, trough};
    } else {
      const peak = (indication==="cns") ? [10,14] : [6,10];
      const trough = [0,2];
      return {peak, trough};
    }
  }
  if (abx==="amika"){
    if (ag_mode==="once"){
      const peak = (indication==="cns") ? [40,55] : [30,45];
      const trough = [0,5];
      return {peak, trough};
    } else {
      const peak = (indication==="cns") ? [20,30] : [15,25];
      const trough = [0,10];
      return {peak, trough};
    }
  }
  return {peak:null, trough:null};
}
function targetsFor(sim){
  if (sim.abx.startsWith("vanco")){
    const t = vancoTargets(sim.indication);
    return {...t, pd:"Vancomicina: exposição (AUC/MIC) e toxicidade; pico/vale é proxy."};
  }
  const t = agTargets(sim.abx, sim.indication, $("ag_mode").value);
  return {...t, pd:"Aminoglicosídeos: Cmax/MIC (eficácia) + vale baixo (toxicidade)."};
}

// ---------- Concentration models ----------
function conc_intermittent_1c({dose_mg, t_inf_h, tau_h, k_h, V_L, n_doses, t_grid_h}){
  const R0 = dose_mg/t_inf_h;
  const k = k_h, V = V_L;

  function single(t){
    if (t<0) return 0;
    if (t<=t_inf_h) return (R0/(V*k))*(1-Math.exp(-k*t));
    const Cend = (R0/(V*k))*(1-Math.exp(-k*t_inf_h));
    return Cend*Math.exp(-k*(t-t_inf_h));
  }

  const C=[];
  for (const t of t_grid_h){
    let sum=0;
    for (let i=0;i<n_doses;i++){
      sum += single(t - i*tau_h);
    }
    C.push(sum);
  }
  return C;
}
function conc_continuous_1c({rate_mg_h, k_h, V_L, t_grid_h}){
  const R0 = rate_mg_h, k = k_h, V = V_L;
  return t_grid_h.map(t => (R0/(V*k))*(1-Math.exp(-k*t)));
}

// ---------- Metrics ----------
function peakTrough(sim){
  const {t_grid_h, C, tau_h, t_inf_h} = sim;

  if (sim.abx==="vanco_ci"){
    const t = t_grid_h[t_grid_h.length-1];
    const c = C[C.length-1];
    return {peak:c, trough:c, t_peak:t, t_trough:t};
  }

  const t0 = (sim.n_doses-1)*tau_h;
  const within = t_grid_h.map((t,i)=>({t,c:C[i]})).filter(p => p.t>=t0 && p.t<=t0+tau_h+1e-9);

  const tpk = t0 + t_inf_h;
  let bestP = within[0];
  for (const p of within) if (Math.abs(p.t-tpk) < Math.abs(bestP.t-tpk)) bestP=p;

  const ttr = t0 + tau_h;
  let bestT = within[within.length-1];
  for (const p of within) if (Math.abs(p.t-ttr) < Math.abs(bestT.t-ttr)) bestT=p;

  return {peak:bestP.c, trough:bestT.c, t_peak:bestP.t, t_trough:bestT.t};
}

function auc24(sim){
  const CL = sim.CL_L_h;
  if (!Number.isFinite(CL) || CL<=0) return null;

  if (sim.abx==="vanco_ci"){
    const R0 = sim.rate_mg_h;
    if (!Number.isFinite(R0) || R0<=0) return null;
    return (R0*24)/CL;
  }

  const dose = sim.dose_mg, tau = sim.tau_h;
  if (!Number.isFinite(dose) || dose<=0 || !Number.isFinite(tau) || tau<=0) return null;

  const dailyDose = dose*(24/tau);
  return dailyDose/CL;
}

function classifyBand(val, band){
  if (!band || !Number.isFinite(val)) return {cls:"—"};
  if (val < band[0]) return {cls:"insuficiente"};
  if (val > band[1]) return {cls:"excessiva"};
  return {cls:"adequada"};
}

function evaluate(sim){
  const pt = peakTrough(sim);
  const AUC = auc24(sim);
  const mic = num($("mic").value, null);
  const mic_eff = (Number.isFinite(mic) && mic>0) ? mic : 1.0;

  let main = {cls:"—", metric:"—", value:null, target:null};

  if (sim.abx==="vanco_ci"){
    const mode = $("vanco_mode").value;
    if (mode==="auc"){
      const aucmic = Number.isFinite(AUC) ? (AUC/mic_eff) : null;
      const band = vancoTargets(sim.indication).auc;
      main = {...classifyBand(aucmic, band), metric:"AUC/MIC", value:aucmic, target:band};
    } else {
      const band = vancoTargets(sim.indication).css;
      main = {...classifyBand(pt.peak, band), metric:"Css", value:pt.peak, target:band};
    }
  } else if (sim.abx==="vanco_int"){
    const mode = $("vanco_mode").value;
    if (mode==="auc"){
      const aucmic = Number.isFinite(AUC) ? (AUC/mic_eff) : null;
      const band = vancoTargets(sim.indication).auc;
      main = {...classifyBand(aucmic, band), metric:"AUC/MIC", value:aucmic, target:band};
    } else {
      const band = vancoTargets(sim.indication).trough;
      main = {...classifyBand(pt.trough, band), metric:"Vale", value:pt.trough, target:band};
    }
  } else {
    // Aminoglicosídeos
    const targs = sim.targs;
    const tr = classifyBand(pt.trough, targs.trough);
    if (tr.cls==="excessiva") main = {cls:"excessiva", metric:"Vale", value:pt.trough, target:targs.trough};
    else {
      const pk = classifyBand(pt.peak, targs.peak);
      main = {cls:pk.cls, metric:"Pico", value:pt.peak, target:targs.peak};
    }
  }

  return {
    ...pt,
    AUC24: AUC,
    MIC: mic_eff,
    AUC_MIC: Number.isFinite(AUC) ? (AUC/mic_eff) : null,
    main
  };
}

function suggest(sim, ev){
  const k = sim.k_h, t_inf = sim.t_inf_h;
  const out = {newDose_mg:null, newTau_h:null, newTau_h_alt:null, newRate_mg_h:null, rationale:[]};

  if (sim.abx==="vanco_ci"){
    if (ev.main.metric==="AUC/MIC"){
      const targetMid = (ev.main.target[0]+ev.main.target[1])/2;
      if (Number.isFinite(ev.AUC_MIC) && ev.AUC_MIC>0){
        const factor = targetMid/ev.AUC_MIC;
        out.newRate_mg_h = sim.rate_mg_h*factor;
        out.rationale.push(`Ajuste proporcional AUC/MIC: factor≈${fmt(factor,2)}×.`);
      }
    } else {
      const band = vancoTargets(sim.indication).css;
      const targetMid = (band[0]+band[1])/2;
      if (Number.isFinite(ev.peak) && ev.peak>0){
        const factor = targetMid/ev.peak;
        out.newRate_mg_h = sim.rate_mg_h*factor;
        out.rationale.push(`Ajuste proporcional Css: factor≈${fmt(factor,2)}×.`);
      }
    }
    return out;
  }

  if (sim.abx==="vanco_int"){
    if (ev.main.metric==="AUC/MIC"){
      const targetMid = (ev.main.target[0]+ev.main.target[1])/2;
      if (Number.isFinite(ev.AUC_MIC) && ev.AUC_MIC>0){
        const factor = targetMid/ev.AUC_MIC;
        out.newDose_mg = sim.dose_mg*factor;
        out.newTau_h = sim.tau_h;
        out.rationale.push(`Ajuste proporcional AUC/MIC: factor≈${fmt(factor,2)}× (dose).`);
      }
      return out;
    }
    const band = vancoTargets(sim.indication).trough;
    const targetMid = (band[0]+band[1])/2;
    if (Number.isFinite(ev.trough) && ev.trough>0){
      const factor = targetMid/ev.trough;
      out.newDose_mg = sim.dose_mg*factor;
      out.newTau_h = sim.tau_h;
      out.rationale.push(`Ajuste proporcional vale: factor≈${fmt(factor,2)}× (dose).`);

      if (ev.trough > band[1] && Number.isFinite(ev.peak) && ev.peak>0){
        const tau_new = t_inf - (1/k)*Math.log(targetMid/ev.peak);
        if (Number.isFinite(tau_new) && tau_new>t_inf){
          out.newTau_h_alt = tau_new;
          out.rationale.push(`Alternativa: aumentar intervalo τ≈${fmt(tau_new,1)} h.`);
        }
      }
    }
    return out;
  }

  // Aminoglicosídeos
  const bandT = sim.targs.trough;
  if (Number.isFinite(ev.trough) && ev.trough > bandT[1] && Number.isFinite(ev.peak) && ev.peak>0){
    const desired = bandT[1];
    const tau_new = t_inf - (1/k)*Math.log(desired/ev.peak);
    if (Number.isFinite(tau_new) && tau_new>t_inf){
      out.newTau_h = tau_new;
      out.newDose_mg = sim.dose_mg;
      out.rationale.push(`Vale elevado: aumentar intervalo τ≈${fmt(tau_new,1)} h.`);
      return out;
    }
  }

  const bandP = sim.targs.peak;
  const targetMid = (bandP[0]+bandP[1])/2;
  if (Number.isFinite(ev.peak) && ev.peak>0){
    const factor = targetMid/ev.peak;
    out.newDose_mg = sim.dose_mg*factor;
    out.newTau_h = sim.tau_h;
    out.rationale.push(`Ajuste proporcional pico: factor≈${fmt(factor,2)}× (dose).`);
  }
  return out;
}

// ---------- Calibration ----------
function calibrateCL(sim0, measured, meas_type, t_post_h, t_since_h){
  if (!Number.isFinite(measured) || measured<=0) return null;

  const t0 = (sim0.n_doses-1)*sim0.tau_h;
  let t_sample=null;
  if (meas_type==="trough") t_sample = t0 + sim0.tau_h;
  else if (meas_type==="peak") t_sample = t0 + sim0.t_inf_h + (Number.isFinite(t_post_h)?t_post_h:0);
  else {
    if (Number.isFinite(t_since_h)) t_sample = t0 + t_since_h;
    else if (Number.isFinite(t_post_h)) t_sample = t0 + sim0.t_inf_h + t_post_h;
    else return null;
  }

  const tgrid=[t_sample];
  function predictAt(m){
    const k = sim0.k_h*m;
    if (sim0.abx==="vanco_ci"){
      return conc_continuous_1c({rate_mg_h:sim0.rate_mg_h, k_h:k, V_L:sim0.V_L, t_grid_h:tgrid})[0];
    }
    return conc_intermittent_1c({dose_mg:sim0.dose_mg, t_inf_h:sim0.t_inf_h, tau_h:sim0.tau_h, k_h:k, V_L:sim0.V_L, n_doses:sim0.n_doses, t_grid_h:tgrid})[0];
  }

  let lo=0.2, hi=4.0;
  let flo = predictAt(lo)-measured;
  let fhi = predictAt(hi)-measured;
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return null;

  for (let iter=0; iter<40; iter++){
    const mid=(lo+hi)/2;
    const fmid=predictAt(mid)-measured;
    if (!Number.isFinite(fmid)) break;
    if (Math.abs(fmid)<1e-3) return mid;

    if (flo*fmid<=0){ hi=mid; fhi=fmid; }
    else if (fmid*fhi<=0){ lo=mid; flo=fmid; }
    else {
      if (Math.abs(fmid)<Math.abs(flo)){ lo=mid; flo=fmid; }
      else { hi=mid; fhi=fmid; }
    }
  }
  return (Math.abs(flo)<Math.abs(fhi)) ? lo : hi;
}

// ---------- Build sim ----------
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

  const t_end = (abx==="vanco_ci") ? 24 : (n_doses*tau_h);
  const dt = Math.max(0.05, Math.min(0.25, tau_h/80));
  const t_grid_h=[];
  for (let t=0;t<=t_end+1e-9;t+=dt) t_grid_h.push(+t.toFixed(5));

  let C;
  if (abx==="vanco_ci"){
    if (!(rate_mg_h>0)) throw new Error("Perfusão contínua: preenche mg/h.");
    C = conc_continuous_1c({rate_mg_h, k_h:pk.k_h, V_L:pk.V_L, t_grid_h});
  } else {
    if (!(dose_mg>0)) throw new Error("Dose (mg) inválida.");
    C = conc_intermittent_1c({dose_mg, t_inf_h, tau_h, k_h:pk.k_h, V_L:pk.V_L, n_doses, t_grid_h});
  }

  const sim = {
    abx, indication,
    wt_kg: wt,
    dose_mg, tau_h, t_inf_h, n_doses, rate_mg_h,
    V_L: pk.V_L, CL_L_h: pk.CL_L_h, k_h: pk.k_h, tHalf_h: pk.tHalf_h,
    renal_label: pk.renal_label, notes: pk.notes,
    t_grid_h, C
  };

  sim.targs = targetsFor(sim);
  sim.eval = evaluate(sim);
  sim.suggestion = suggest(sim, sim.eval);
  return sim;
}

// ---------- Chart ----------
function ensureChart(){
  if (state.chart) return state.chart;
  const ctx = $("pkChart").getContext("2d");
  state.chart = new Chart(ctx, {
    type:"line",
    data:{
      labels:[],
      datasets:[
        { label:"Concentração (mg/L)", data:[], borderWidth:2, pointRadius:0, tension:0.25 },
        { label:"Pico/Vale (marcadores)", data:[], borderWidth:0, pointRadius:5, showLine:false },
        { label:"Doseamento medido", data:[], borderWidth:0, pointRadius:6, showLine:false },
        { label:"Alvo (mín)", data:[], borderWidth:1, borderDash:[6,4], pointRadius:0 },
        { label:"Alvo (máx)", data:[], borderWidth:1, borderDash:[6,4], pointRadius:0 },
      ]
    },
    options:{
      responsive:true,
      maintainAspectRatio:false,
      scales:{
        x:{ title:{display:true,text:"Tempo (h)"}, ticks:{maxTicksLimit:10} },
        y:{ title:{display:true,text:"mg/L"}, beginAtZero:true }
      }
    }
  });
  return state.chart;
}

function updateChart(sim){
  const ch = ensureChart();
  const labels = sim.t_grid_h.slice();
  ch.data.labels = labels;
  ch.data.datasets[0].data = sim.C;

  // band to display (concentration band)
  let band=null;
  if (sim.abx==="vanco_ci"){
    band = ($("vanco_mode").value==="auc") ? null : vancoTargets(sim.indication).css;
  } else if (sim.abx==="vanco_int"){
    band = ($("vanco_mode").value==="auc") ? null : vancoTargets(sim.indication).trough;
  } else {
    band = sim.targs.peak;
  }
  ch.data.datasets[3].data = band ? labels.map(_=>band[0]) : labels.map(_=>null);
  ch.data.datasets[4].data = band ? labels.map(_=>band[1]) : labels.map(_=>null);

  // markers peak/trough
  const pts = labels.map(_=>null);
  function idxFor(t){
    let best=1e9, bi=0;
    for (let i=0;i<labels.length;i++){
      const d=Math.abs(labels[i]-t);
      if (d<best){best=d; bi=i;}
    }
    return bi;
  }
  const ev = sim.eval;
  if (Number.isFinite(ev.t_peak) && Number.isFinite(ev.peak)) pts[idxFor(ev.t_peak)] = ev.peak;
  if (Number.isFinite(ev.t_trough) && Number.isFinite(ev.trough)) pts[idxFor(ev.t_trough)] = ev.trough;
  ch.data.datasets[1].data = pts;

  // measured point
  const meas = num($("meas").value, null);
  const meas_type = $("meas_type").value;
  if (Number.isFinite(meas)){
    const t0 = (sim.n_doses-1)*sim.tau_h;
    let ts=null;
    if (meas_type==="trough") ts = t0 + sim.tau_h;
    else if (meas_type==="peak") ts = t0 + sim.t_inf_h + num($("t_post_h").value,0);
    else ts = Number.isFinite(num($("t_since_h").value,null)) ? (t0 + num($("t_since_h").value,0)) : (t0 + sim.t_inf_h + num($("t_post_h").value,0));
    const mpts = labels.map(_=>null);
    mpts[idxFor(ts)] = meas;
    ch.data.datasets[2].data = mpts;
  } else {
    ch.data.datasets[2].data = labels.map(_=>null);
  }

  ch.update();
}

// ---------- Render ----------
function setBadge(cls){
  const b = $("statusBadge");
  b.classList.remove("good","warn","bad");
  if (cls==="adequada"){ b.textContent="ADEQUADA"; b.classList.add("good"); }
  else if (cls==="insuficiente"){ b.textContent="INSUFICIENTE"; b.classList.add("warn"); }
  else if (cls==="excessiva"){ b.textContent="EXCESSIVA"; b.classList.add("bad"); }
  else b.textContent="—";
}

function render(sim){
  const ev = sim.eval;
  setBadge(ev.main.cls);

  const p=[];
  p.push(`V ≈ ${fmt(sim.V_L,1)} L`);
  p.push(`CL ≈ ${fmt(sim.CL_L_h,2)} L/h`);
  p.push(`k ≈ ${fmt(sim.k_h,3)} 1/h`);
  p.push(`t½ ≈ ${fmt(sim.tHalf_h,1)} h`);
  p.push(sim.renal_label);
  if (sim.notes?.length) p.push("\nNotas:\n- " + sim.notes.join("\n- "));
  $("params").textContent = p.join("\n");

  const out=[];
  out.push(`PD: ${sim.targs.pd}`);

  if (sim.abx.startsWith("vanco")){
    const vt=vancoTargets(sim.indication);
    out.push(`AUC/MIC alvo: ${fmt(vt.auc[0],0)}–${fmt(vt.auc[1],0)}`);
    out.push(`Vale alvo (proxy): ${fmt(vt.trough[0],0)}–${fmt(vt.trough[1],0)} mg/L`);
    out.push(`Css alvo (CI): ${fmt(vt.css[0],0)}–${fmt(vt.css[1],0)} mg/L`);
  } else {
    out.push(`Pico alvo: ${fmt(sim.targs.peak[0],0)}–${fmt(sim.targs.peak[1],0)} mg/L`);
    out.push(`Vale alvo: ${fmt(sim.targs.trough[0],0)}–${fmt(sim.targs.trough[1],0)} mg/L`);
  }

  out.push("");
  out.push(`Previsto (último intervalo):`);
  out.push(`- Pico ≈ ${fmt(ev.peak,1)} mg/L`);
  out.push(`- Vale ≈ ${fmt(ev.trough,1)} mg/L`);

  if (sim.abx.startsWith("vanco")){
    out.push(`- AUC24 ≈ ${fmt(ev.AUC24,0)} mg·h/L`);
    out.push(`- MIC assumida ≈ ${fmt(ev.MIC,1)} mg/L`);
    out.push(`- AUC/MIC ≈ ${fmt(ev.AUC_MIC,0)}`);
  }

  out.push("");
  out.push(`Classificação principal: ${ev.main.cls.toUpperCase()} (${ev.main.metric}).`);

  const s=sim.suggestion;
  out.push("");
  out.push("Sugestão matemática (aprox.):");
  if (sim.abx==="vanco_ci"){
    out.push(`- Taxa atual: ${fmt(sim.rate_mg_h,0)} mg/h`);
    out.push(`- Nova taxa: ${fmt(s.newRate_mg_h,0)} mg/h`);
  } else {
    out.push(`- Dose atual: ${fmt(sim.dose_mg,0)} mg | τ=${fmt(sim.tau_h,0)} h | t_inf=${fmt(sim.t_inf_h,2)} h`);
    out.push(`- Nova dose: ${fmt(s.newDose_mg,0)} mg | τ=${Number.isFinite(s.newTau_h)?fmt(s.newTau_h,1):fmt(sim.tau_h,0)} h`);
    if (Number.isFinite(s.newTau_h_alt)) out.push(`- Alternativa: manter dose e usar τ≈${fmt(s.newTau_h_alt,1)} h`);
  }
  if (s.rationale?.length) out.push("\nRacional:\n- " + s.rationale.join("\n- "));

  $("targets").textContent = out.join("\n");

  const msg=[];
  if (sim.abx.startsWith("vanco")){
    const mode=$("vanco_mode").value;
    if (mode==="auc") msg.push("Interpretação principal baseada em AUC/MIC.");
    else if (sim.abx==="vanco_ci") msg.push("Interpretação principal baseada em Css.");
    else msg.push("Interpretação principal baseada no vale (proxy).");
  } else {
    msg.push("Interpretação baseada em pico (eficácia) e vale (toxicidade).");
    msg.push(`Regime: ${$("ag_mode").selectedOptions[0].text}.`);
  }
  $("statusText").textContent = msg.join(" ");

  updateChart(sim);
}

// ---------- PDF ----------
async function exportPDF(){
  if (!state.last){ alert("Nada para exportar. Faz uma simulação primeiro."); return; }
  const sim = state.last;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit:"pt", format:"a4" });

  doc.setFont("helvetica","bold"); doc.setFontSize(16);
  doc.text("PedMedMonitor — Relatório (educacional)", 40, 52);

  doc.setFont("helvetica","normal"); doc.setFontSize(11);
  const id = ($("pt_id").value||"").trim() || "—";
  doc.text(`ID: ${id}`, 40, 76);
  doc.text(`Antibiótico: ${$("abx").selectedOptions[0].text}`, 40, 94);
  doc.text(`Indicação: ${$("indication").selectedOptions[0].text}`, 40, 112);

  doc.setFont("helvetica","bold"); doc.text("Parâmetros", 40, 144);
  doc.setFont("courier","normal"); doc.setFontSize(9);

  let y=160;
  for (const line of $("params").textContent.split("\n")){
    doc.text(line, 40, y, {maxWidth:515});
    y+=12;
    if (y>320) break;
  }

  doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text("Alvos • Avaliação • Sugestão", 40, 344);
  doc.setFont("courier","normal"); doc.setFontSize(9);

  y=360;
  for (const line of $("targets").textContent.split("\n")){
    doc.text(line, 40, y, {maxWidth:515});
    y+=12;
    if (y>520) break;
  }

  const imgData = $("pkChart").toDataURL("image/png", 1.0);
  doc.setFont("helvetica","bold"); doc.setFontSize(11);
  doc.text("Curva (PK)", 40, 548);
  doc.addImage(imgData, "PNG", 40, 560, 515, 230);

  doc.setFont("helvetica","normal"); doc.setFontSize(9);
  doc.text("Uso educacional — não substitui protocolos locais, TDM formal, nem decisão clínica.", 40, 812);

  doc.save("PedMedMonitor_relatorio.pdf");
}

// ---------- Handlers ----------
function runSim(){
  try{ const sim = buildSimulation(); state.last=sim; render(sim); }
  catch(e){ alert(e.message || "Erro na simulação."); }
}
function doCalibrate(){
  try{
    const old=state.cl_adj;
    state.cl_adj=null;
    const sim0 = buildSimulation();
    const m = calibrateCL(sim0, num($("meas").value,null), $("meas_type").value, num($("t_post_h").value,null), num($("t_since_h").value,null));
    if (!m){ alert("Não foi possível calibrar (verifica dados)."); state.cl_adj=old; return; }
    state.cl_adj=m;
    const sim = buildSimulation();
    state.last=sim;
    render(sim);
  } catch(e){ alert(e.message || "Erro na calibração."); }
}
function doSuggest(){ if(!state.last) return runSim(); render(state.last); }

function resetAll(){
  document.querySelectorAll("input").forEach(i => i.value="");
  $("sex").value="M";
  $("tau_h").value="12";
  $("t_inf_min").value="60";
  $("n_doses").value="4";
  $("abx").value="vanco_int";
  $("indication").value="std";
  $("vanco_mode").value="trough";
  $("ag_mode").value="once";
  state.cl_adj=null; state.last=null;
  setBadge("—");
  $("params").textContent="";
  $("targets").textContent="";
  $("statusText").textContent="Preenche os dados e clica Simular.";
  if (state.chart){ state.chart.data.labels=[]; state.chart.data.datasets.forEach(ds=>ds.data=[]); state.chart.update(); }
}

function loadExample(){
  $("pt_id").value="EX-002";
  $("sex").value="M";
  $("wt").value="70";
  $("ht").value="175";
  $("age_y").value="45";
  $("scr").value="1.0";
  $("abx").value="vanco_int";
  $("indication").value="severe";
  $("vanco_mode").value="auc";
  $("dose_mg").value="1000";
  $("t_inf_min").value="60";
  $("tau_h").value="12";
  $("n_doses").value="4";
  $("mic").value="1";
  $("meas").value="17";
  $("meas_type").value="trough";
  $("t_post_h").value="1";
  $("t_since_h").value="6";
  state.cl_adj=null;
  toggleFields();
  runSim();
}

function toggleFields(){
  const abx=$("abx").value;
  const isVanco = abx.startsWith("vanco");
  const isCI = (abx==="vanco_ci");
  $("vancoModeWrap").style.display = isVanco ? "" : "none";
  $("agModeWrap").style.display = isVanco ? "none" : "";

  // mode coercion
  if (isCI){
    if ($("vanco_mode").value==="trough") $("vanco_mode").value="css";
  } else if (abx==="vanco_int"){
    if ($("vanco_mode").value==="css") $("vanco_mode").value="trough";
  }

  $("rate_mg_h").disabled = !isCI;
  $("dose_mg").disabled = isCI;
  $("t_inf_min").disabled = isCI;
  $("tau_h").disabled = isCI;

  $("rateWrap").style.opacity = isCI ? "1" : ".55";
  $("doseWrap").style.opacity = isCI ? ".55" : "1";
  $("infWrap").style.opacity  = isCI ? ".55" : "1";
  $("tauWrap").style.opacity  = isCI ? ".55" : "1";
}

// init
$("btnSim").addEventListener("click", runSim);
$("btnSuggest").addEventListener("click", doSuggest);
$("btnCal").addEventListener("click", doCalibrate);
$("btnPDF").addEventListener("click", exportPDF);
$("btnReset").addEventListener("click", resetAll);
$("btnExample").addEventListener("click", loadExample);
$("abx").addEventListener("change", ()=>{ state.cl_adj=null; toggleFields(); });
$("vanco_mode").addEventListener("change", ()=>{ if(state.last) render(state.last); });
$("ag_mode").addEventListener("change", ()=>{ if(state.last) runSim(); });

toggleFields();
ensureChart();
