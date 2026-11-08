/* Laddkollen – ladda eller tanka i natt? */
"use strict";

// ---------- Inställningar ----------
const DEF = {
  elPerMil: 2.5,      // kWh/mil (Volvo-appen, rena el-turer i november ≈ 25 kWh/100 km)
  bensinPerMil: 0.72, // l/mil när batteriet är tomt (5,3 l + 5,8 kWh per 100 km över 16 146 km)
  forlust: 12,        // % laddförluster vägg → batteri
  batteri: 14.7,      // kWh användbart batteri
  effekt: 6.4,        // kW laddeffekt (bilens ombordladdare)
  paslag: 0.119,      // Tibber: 7,5 öre påslag + 4,4 öre rörliga kostnader (okt 2026), inkl. moms
  nat: 0.9175,        // E.ON Syd & Mellersta, 16 A villa: 91,75 öre/kWh inkl. moms (okt 2026)
  skatt: 0.45,        // energiskatt 2026 (Skatteverket): 36 öre + moms
  start: 21,          // laddfönster
  slut: 7,
  milPerDag: 3,
  bensinManuell: "",
};
const KEY = "laddkollen-v2";
let S = load();
function load() {
  try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || "{}")); }
  catch { return Object.assign({}, DEF); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }

// ---------- Hjälpare ----------
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const kr = (n, d = 2) => n.toLocaleString("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d });
const H = 3600e3;
const total = (spot) => spot * 1.25 + S.paslag + S.nat + S.skatt;
const factor = () => 1 + S.forlust / 100;
const row = (k, v, cls = "") => `<div class="row ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
const dayKey = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

// ---------- Data ----------
const priceCache = {};
async function dayPrices(d) {
  const k = dayKey(d);
  if (k in priceCache) return priceCache[k];
  try {
    const r = await fetch(`https://www.elprisetjustnu.se/api/v1/prices/${k}_SE3.json`);
    if (!r.ok) throw 0;
    const j = await r.json();
    priceCache[k] = j.map((p) => ({ t: new Date(p.time_start), e: new Date(p.time_end), spot: p.SEK_per_kWh }));
  } catch { priceCache[k] = null; }
  return priceCache[k];
}
let fuel = null;
async function loadFuel() {
  try {
    const r = await fetch(`data/bensin.json?${Date.now()}`, { cache: "no-store" });
    if (r.ok) fuel = await r.json();
  } catch {}
}
function fuelPrice() {
  const m = parseFloat(String(S.bensinManuell).replace(",", "."));
  if (m > 0) return { pris: m, kalla: "eget" };
  if (fuel && fuel.snitt) return { pris: fuel.snitt, kalla: "auto" };
  return { pris: 16.0, kalla: "uppskattat" };
}
function hourly(slots) {
  const map = new Map();
  for (const s of slots) {
    const h = new Date(s.t); h.setMinutes(0, 0, 0);
    if (!map.has(+h)) map.set(+h, { t: h, list: [] });
    map.get(+h).list.push(s);
  }
  return [...map.values()].map((h) => ({ ...h, pris: h.list.reduce((a, s) => a + total(s.spot), 0) / h.list.length }));
}
function nightWindow(now) {
  const dur = (((S.slut - S.start) % 24) + 24) % 24 || 24;
  let s = startOfDay(now); s.setHours(S.start);
  if (now < +s - 24 * H + dur * H) s = new Date(+s - 24 * H);
  else if (now >= +s + dur * H) s = new Date(+s + 24 * H);
  return { from: s, to: new Date(+s + dur * H) };
}
async function nightSlots(win) {
  let prelim = false;
  const slots = [];
  for (let d = startOfDay(win.from); d < win.to; d = addDays(d, 1)) {
    let p = await dayPrices(d);
    if (!p) { // morgondagens priser släpps runt kl. 13 – använd dagens som uppskattning
      const prev = await dayPrices(addDays(d, -1));
      if (!prev) continue;
      prelim = true;
      p = prev.map((s) => ({ t: new Date(+s.t + 24 * H), e: new Date(+s.e + 24 * H), spot: s.spot }));
    }
    for (const s of p) if (s.t >= win.from && s.t < win.to) slots.push(s);
  }
  return { slots, prelim };
}

// ---------- Beräkning ----------
let R = null;
async function compute() {
  const now = new Date();
  const win = nightWindow(now);
  const { slots, prelim } = await nightSlots(win);
  if (!slots.length) return null;
  const f = fuelPrice();
  const wallKWh = S.batteri * factor();
  const hrs = hourly(slots);
  const nh = Math.min(hrs.length, Math.ceil(wallKWh / S.effekt));
  const pickedH = [...hrs].sort((a, b) => a.pris - b.pris).slice(0, nh);
  const picked = new Set(pickedH.map((h) => +h.t));
  const elKWh = pickedH.reduce((a, h) => a + h.pris, 0) / pickedH.length;
  const elMil = S.elPerMil * factor() * elKWh;
  const bMil = S.bensinPerMil * f.pris;
  return { now, win, prelim, f, wallKWh, hrs, picked, pickedH, elKWh, elMil, bMil,
    limit: bMil / (S.elPerMil * factor()), ladda: elMil <= bMil };
}

// ---------- Bensinstationer ----------
const inArea = (s) => s.lat > 58.3 && s.lat < 59.1 && s.lng > 15.4 && s.lng < 16.9; // bort med felaktiga koordinater
const priced = (ort) => (fuel ? fuel.stationer.filter((s) => s.pris && (!ort || s.ort === ort)) : []).sort((a, b) => a.pris - b.pris);
const PUMP = `<svg class="ic" viewBox="0 0 24 24"><path d="M4 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M3 21h13M7 8h5"/><path d="M15 10h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0V8l-3-3"/></svg>`;
const PIN_SVG = `<svg class="ic" viewBox="0 0 24 24"><path d="M5 20V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14M4 20h12M8 9h4"/><path d="M15 11h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1 1 0 0 0 2 0V9l-2-2"/></svg>`;

function tiles() {
  const esri = (n) => `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${n}/MapServer/tile/{z}/{y}/{x}`;
  return [
    L.tileLayer(esri("World_Dark_Gray_Base"), { maxZoom: 16, attribution: "Esri, HERE, Garmin, © OpenStreetMap" }),
    L.tileLayer(esri("World_Dark_Gray_Reference"), { maxZoom: 16 }),
  ];
}
function pinIcon(s, best, label = true) {
  return L.divIcon({ className: "", iconSize: [0, 0],
    html: `<div class="pin${best ? " best" : ""}"><b>${PIN_SVG}</b>${label ? `<span>${kr(s.pris)}</span>` : ""}</div>` });
}

let mini = null;
function renderMini() {
  if (!window.L || !fuel) return;
  const list = priced();
  if (!list.length) return;
  const best = list[0];
  if (!mini) {
    mini = L.map("miniMap", { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
    tiles().forEach((t) => t.addTo(mini));
    mini._lk = L.layerGroup().addTo(mini);
  }
  mini.invalidateSize();
  mini._lk.clearLayers();
  L.marker([best.lat, best.lng], { icon: pinIcon(best, true, false) }).addTo(mini._lk);
  mini.setView([best.lat - 0.0025, best.lng], 13);
  const same = list.filter((x) => x.pris === best.pris).length;
  $("miniCap").hidden = false;
  $("miniCap").innerHTML = `<span class="t"><span class="eyebrow">Billigast bensin</span><b>${best.kedja}, ${best.ort}${same > 1 ? ` <span style="color:var(--muted);font-weight:400">+${same - 1}</span>` : ""}</b></span><span class="p">${kr(best.pris)}</span>`;
}

let map = null, layer = null, ortFilter = "";
function renderMap() {
  if (!window.L || !fuel || $("v-karta").hidden) return;
  if (!map) {
    map = L.map("map", { zoomControl: true, scrollWheelZoom: false });
    tiles().forEach((t) => t.addTo(map));
    layer = L.layerGroup().addTo(map);
  }
  map.invalidateSize();
  layer.clearLayers();
  const all = fuel.stationer.filter((s) => (!ortFilter || s.ort === ortFilter) && inArea(s));
  const list = priced(ortFilter);
  const bestPris = list.length ? list[0].pris : null;
  const pts = [];
  for (const s of all) {
    pts.push([s.lat, s.lng]);
    if (!s.pris) {
      L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: `<div class="pdot"></div>`, iconSize: [0, 0] }), zIndexOffset: -100 })
        .bindPopup(`<b>${s.kedja}</b><br>${s.adress}<br><span style="color:#9B9B9B">Inget aktuellt pris</span>`).addTo(layer);
      continue;
    }
    const best = s.pris === bestPris;
    L.marker([s.lat, s.lng], { icon: pinIcon(s, best), zIndexOffset: best ? 1000 : 500 })
      .bindPopup(`<b>${s.kedja}</b> · ${kr(s.pris)} kr/l<br>${s.adress}, ${s.ort}<br><span style="color:#9B9B9B">Rapporterat ${s.datum}</span>`).addTo(layer);
  }
  if (pts.length) map.fitBounds(pts, { padding: [36, 36], maxZoom: 13 });
}
function renderFuelList() {
  const f = fuelPrice();
  let html = "";
  if (f.kalla === "eget") html += `<div class="st"><span class="t"><b>Ditt eget pris</b><span>Ändras under Mer information → Inställningar</span></span><span class="p">${kr(f.pris)}<small>kr/l</small></span></div>`;
  if (fuel) {
    const list = priced(ortFilter);
    html += list.slice(0, 8).map((s) => `
      <div class="st${s.pris === list[0].pris ? " top" : ""}"><span class="chipi">${PUMP}</span>
        <span class="t"><b>${s.kedja}, ${s.ort}</b><span>${s.adress.split(",")[0]} · ${s.datum}</span></span>
        <span class="p">${kr(s.pris)}<small>kr</small></span></div>`).join("")
      || `<div class="st"><span class="t"><b>Inga aktuella priser</b><span>Ingen har rapporterat ett pris de senaste dagarna</span></span></div>`;
  } else if (!html) html = `<div class="st"><span class="t"><b>Kunde inte hämta priser</b><span>Ange eget pris under Inställningar</span></span></div>`;
  $("fuelList").innerHTML = html;
}

// ---------- Hem ----------
function hourRanges(pickedH) {
  const s = [...pickedH].sort((a, b) => a.t - b.t);
  const out = [];
  for (const h of s) {
    const last = out[out.length - 1];
    if (last && +h.t === +last.e) last.e = new Date(+h.t + H);
    else out.push({ t: h.t, e: new Date(+h.t + H) });
  }
  return out.map((r) => `${pad(r.t.getHours())}–${r.e.getHours() === 0 ? "24" : pad(r.e.getHours())}`);
}
function renderHem() {
  $("eyebrow").textContent = `I natt · ${pad(S.start)}–${pad(S.slut)}`;
  if (!R) {
    $("verdict").innerHTML = `<span class="dot"></span><span class="w">—</span>`;
    $("why").textContent = "Elpriset kunde inte hämtas just nu.";
    $("dock").innerHTML = "";
    return;
  }
  document.documentElement.dataset.c = R.ladda ? "el" : "fuel";
  const word = R.ladda ? "Ladda" : "Tanka";
  $("verdict").innerHTML = `<span class="dot"></span><span class="w">` + [...word].map((c, i) => `<span class="ch" style="--i:${i}">${c}</span>`).join("") + `</span>`;
  const diffMil = Math.abs(R.bMil - R.elMil);
  const pct = Math.round((diffMil / Math.max(R.bMil, R.elMil)) * 100);
  $("why").textContent = pct < 5 ? "Ungefär lika dyrt i natt." : R.ladda ? `El är ${pct} % billigare än bensin i natt.` : `Bensin är ${pct} % billigare än el i natt.`;

  const r = hourRanges(R.pickedH);
  const stat = (k, color, v, unit, win) => `<div class="stat${win ? " win" : ""}"><span class="eyebrow k">${color ? `<i style="background:${color}"></i>` : ""}${k}</span><span class="v num" data-to="${v}">${v}<small>${unit}</small></span></div>`;
  const daily = diffMil * S.milPerDag;
  const bolt = `<svg class="ic" viewBox="0 0 24 24"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></svg>`;
  $("dock").innerHTML = `<div class="stats">
      ${stat("El", "var(--el)", kr(R.elMil), "kr/mil", R.ladda)}
      ${stat("Bensin", "var(--fuel)", kr(R.bMil), "kr/mil", !R.ladda)}
      ${stat(R.ladda ? "Laddar" : "Elpris", "", R.ladda ? r[0] : kr(R.elKWh), R.ladda ? "" : "kr", false)}
    </div>
    <div class="hint">${bolt}<span>${R.ladda ? `Du sparar <b>${kr(daily, 0)} kr</b> på en vanlig dag` : `El kostar <b>${kr(daily, 0)} kr</b> mer per dag – hoppa över laddningen`}</span></div>`;

  $("tEl").textContent = `${kr(R.elKWh)} kr/kWh i natt`;
  const list = priced();
  const f = fuelPrice();
  $("tFuel").textContent = f.kalla === "eget" ? `${kr(f.pris)} kr/l (eget)` : `${kr(list.length ? list[0].pris : f.pris)} kr/l`;
}

// ---------- Mer info ----------
function bars(el, axisEl, hours, { picked, limit } = {}) {
  if (!hours || !hours.length) { el.innerHTML = `<p class="fine" style="align-self:center;width:100%;text-align:center;padding:0">Priserna släpps runt kl. 13</p>`; axisEl.innerHTML = ""; return; }
  const pmax = Math.max(...hours.map((h) => h.pris));
  const showLim = limit && limit < pmax * 1.5;
  const max = Math.max(pmax, showLim ? limit : 0) * 1.12;
  const now = Date.now();
  el.innerHTML = hours.map((h, i) => {
    const cls = [picked && picked.has(+h.t) ? "pick" : "", now >= +h.t && now < +h.t + H ? "now" : ""].join(" ");
    return `<i class="${cls}" style="height:${Math.max(2, (h.pris / max) * 100)}%;--d:${i * 30}ms" title="${pad(h.t.getHours())}:00 · ${kr(h.pris)} kr/kWh"></i>`;
  }).join("") + (showLim ? `<div class="lim" style="bottom:${(limit / max) * 100}%"><span>Bensin billigare</span></div>` : "");
  const every = hours.length > 12 ? 3 : 1;
  axisEl.innerHTML = hours.map((h, i) => `<span>${i % every === 0 ? pad(h.t.getHours()) : ""}</span>`).join("");
}
let dayIdx = 0;
async function renderInfo() {
  if (R) {
    const cell = (k, v, unit, em) => `<div class="cell"><span>${k}</span><b class="num">${v}<small>${unit}</small></b>${em ? `<em>${em}</em>` : ""}</div>`;
    $("perMil").innerHTML = cell("El per mil", kr(R.elMil), "kr", `${kr(S.elPerMil * factor(), 1)} kWh från väggen`) +
      cell("Bensin per mil", kr(R.bMil), "kr", `${kr(S.bensinPerMil, 2)} l à ${kr(R.f.pris)} kr`);
    $("nightSmall").textContent = R.prelim ? "Preliminärt – morgondagens priser släpps kl. 13" : `${pad(S.start)}–${pad(S.slut)}, allt inräknat`;
    bars($("nightBars"), $("nightAxis"), R.hrs, { picked: R.picked, limit: R.limit });
    const r = hourRanges(R.pickedH);
    $("nightRows").innerHTML =
      row("Billigaste timmarna", "kl. " + (r.length > 3 ? r.slice(0, 3).join(", ") + " …" : r.join(", ").replace(/, ([^,]*)$/, " och $1"))) +
      row("Elpris när bilen laddar", `${kr(R.elKWh)}<small>kr/kWh</small>`) +
      row("Bensin blir billigare över", `${kr(R.limit)}<small>kr/kWh</small>`);
    const mil = S.batteri / S.elPerMil;
    const c2 = (k, v, unit, em) => `<div class="cell"><span>${k}</span><b class="num">${v}<small>${unit}</small></b><em>${em}</em></div>`;
    $("fullTiles").innerHTML =
      c2("Kostar med el", kr(R.wallKWh * R.elKWh, 0), "kr", `${kr(R.wallKWh, 1)} kWh`) +
      c2("Samma på bensin", kr(mil * R.bMil, 0), "kr", `${kr(mil * S.bensinPerMil, 1)} liter`) +
      c2("Räcker till", kr(mil, 1), "mil", `${kr(S.elPerMil * 10, 0)} kWh/100 km`) +
      c2("Laddtid", kr(R.wallKWh / S.effekt, 1), "tim", `vid ${kr(S.effekt, 1)} kW`);
  }
  const today = startOfDay(new Date());
  const p = await dayPrices(addDays(today, dayIdx));
  const h = p ? hourly(p) : null;
  bars($("dayBars"), $("dayAxis"), h);
  if (h) {
    const lo = h.reduce((x, y) => (y.pris < x.pris ? y : x));
    const hi = h.reduce((x, y) => (y.pris > x.pris ? y : x));
    $("dayRows").innerHTML =
      row("Billigast", `kl. ${pad(lo.t.getHours())} · ${kr(lo.pris)}<small>kr</small>`) +
      row("Dyrast", `kl. ${pad(hi.t.getHours())} · ${kr(hi.pris)}<small>kr</small>`) +
      row("Snitt", `${kr(h.reduce((s, x) => s + x.pris, 0) / h.length)}<small>kr/kWh</small>`);
  } else $("dayRows").innerHTML = "";
  const tp = await dayPrices(today);
  if (tp) {
    const cur = tp.find((x) => Date.now() >= +x.t && Date.now() < +x.e) || tp[0];
    $("breakdown").innerHTML =
      row("Spotpris", `${kr(cur.spot)}<small>kr</small>`) +
      row("Moms på spotpriset", `${kr(cur.spot * 0.25)}<small>kr</small>`) +
      row("Tibber påslag", `${kr(S.paslag, 3)}<small>kr</small>`) +
      row("E.ON nätavgift", `${kr(S.nat, 3)}<small>kr</small>`) +
      row("Energiskatt", `${kr(S.skatt)}<small>kr</small>`) +
      row("Totalt", `${kr(total(cur.spot))}<small>kr/kWh</small>`, "total");
  }
}

// ---------- Inställningar ----------
const FIELDS = [
  ["Bilen"],
  ["elPerMil", "Elförbrukning", "kWh/mil", "Volvo-appen: kWh/100 km ÷ 10"],
  ["bensinPerMil", "Bensinförbrukning", "l/mil", "När batteriet är slut"],
  ["batteri", "Batteri", "kWh", "Användbar kapacitet"],
  ["effekt", "Laddeffekt", "kW"],
  ["forlust", "Laddförluster", "%"],
  ["milPerDag", "Körning per dag", "mil"],
  ["Elen"],
  ["paslag", "Tibber påslag", "kr/kWh", "Påslag + rörliga kostnader, inkl. moms"],
  ["nat", "E.ON nätavgift", "kr/kWh", "16 A villa, inkl. moms"],
  ["skatt", "Energiskatt", "kr/kWh", "Inkl. moms"],
  ["start", "Laddning börjar", "kl."],
  ["slut", "Klar senast", "kl."],
  ["Bensinen"],
  ["bensinManuell", "Eget bensinpris", "kr/l", "Tomt = hämtas automatiskt"],
];
function renderFields() {
  $("fields").innerHTML = FIELDS.map(([k, label, unit, hint]) => !label
    ? `<div class="fgrp">${k}</div>`
    : `<div class="field"><label for="i-${k}">${label}${hint ? `<small>${hint}</small>` : ""}</label>
       <span class="in"><input id="i-${k}" data-k="${k}" inputmode="decimal" value="${S[k] === "" ? "" : String(S[k]).replace(".", ",")}" placeholder="${k === "bensinManuell" && fuel ? kr(fuel.snitt) : ""}"><span class="u">${unit}</span></span></div>`
  ).join("") + `<button class="ghost" id="reset">Återställ standardvärden</button>`;
  $("reset").addEventListener("click", () => { S = Object.assign({}, DEF); save(); renderFields(); refresh(); });
}
document.addEventListener("change", (e) => {
  const k = e.target.dataset && e.target.dataset.k;
  if (!k) return;
  const raw = e.target.value.trim().replace(",", ".");
  if (k === "bensinManuell") S[k] = raw === "" ? "" : parseFloat(raw) || "";
  else { const v = parseFloat(raw); if (isFinite(v) && v >= 0) S[k] = v; else e.target.value = String(S[k]).replace(".", ","); }
  if (k === "start" || k === "slut") S[k] = Math.round(Math.min(23, S[k]));
  save(); refresh();
});

// ---------- Navigering ----------
const VIEWS = ["hem", "karta", "info"];
function go(view) {
  document.querySelectorAll(".nav button").forEach((t) => (t.dataset.go === view ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current")));
  $("navInd").style.transform = `translateX(${VIEWS.indexOf(view) * 100}%)`;
  for (const v of VIEWS) {
    const el = $("v-" + v);
    el.hidden = v !== view;
    el.classList.remove("enter");
    if (v === view) { void el.offsetWidth; el.classList.add("enter"); }
  }
  document.querySelector(".topbar .round").style.visibility = view === "info" ? "hidden" : "visible";
  window.scrollTo(0, 0);
  if (view === "karta") setTimeout(renderMap, 30);
  if (view === "hem") setTimeout(renderMini, 30);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) go(b.dataset.go);
  const o = e.target.closest("#ortSeg button");
  if (o) {
    ortFilter = o.dataset.o;
    document.querySelectorAll("#ortSeg button").forEach((x) => x.setAttribute("aria-pressed", x === o));
    renderFuelList(); renderMap();
  }
  const d = e.target.closest("#daySeg button");
  if (d) {
    dayIdx = +d.dataset.d;
    document.querySelectorAll("#daySeg button").forEach((x) => x.setAttribute("aria-pressed", x === d));
    renderInfo();
  }
});

async function refresh() {
  R = await compute();
  renderHem();
  renderMini();
  renderFuelList();
  renderMap();
  renderInfo();
}
(async function init() {
  await loadFuel();
  renderFields();
  await refresh();
})();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  for (const k in priceCache) if (!priceCache[k]) delete priceCache[k];
  loadFuel().then(refresh);
});
