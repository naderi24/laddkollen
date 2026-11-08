/* Laddkollen – ladda eller tanka i natt? */
"use strict";

// ---------- Inställningar ----------
const DEF = {
  elPerMil: 2.5,      // kWh/mil (Volvo-appen, rena el-turer i november ≈ 25 kWh/100 km)
  bensinPerMil: 0.72, // l/mil när batteriet är tomt (5,3 l + 5,8 kWh per 100 km över 16 146 km)
  forlust: 12,        // % laddförluster vägg → batteri
  batteri: 14.7,      // kWh användbart batteri
  effekt: 6.4,        // kW laddeffekt (bilens ombordladdare)
  paslag: 0.12,       // Tibber: påslag + rörliga avgifter, kr/kWh inkl. moms
  nat: 0.32,          // E.ON Energidistribution: överföringsavgift, kr/kWh inkl. moms
  skatt: 0.45,        // energiskatt 2026: 36 öre + moms
  start: 21,          // laddfönster
  slut: 7,
  bensinManuell: "",
};
const KEY = "laddkollen-v1";
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
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const H = 3600e3, Q = 900e3;
const total = (spot) => spot * 1.25 + S.paslag + S.nat + S.skatt;
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
  if (m > 0) return { pris: m, kalla: "eget pris" };
  if (fuel && fuel.snitt) return { pris: fuel.snitt, kalla: "auto" };
  return { pris: 16.0, kalla: "uppskattat" };
}

// Kvartspriser till timmar
function hourly(slots) {
  const map = new Map();
  for (const s of slots) {
    const h = new Date(s.t); h.setMinutes(0, 0, 0);
    const k = +h;
    if (!map.has(k)) map.set(k, { t: h, list: [] });
    map.get(k).list.push(s);
  }
  return [...map.values()].map((h) => ({ t: h.t, list: h.list, pris: h.list.reduce((a, s) => a + total(s.spot), 0) / h.list.length }));
}

// ---------- Nattens laddfönster ----------
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
    if (!p) { // morgondagens priser inte släppta än → använd dagens som uppskattning
      const prev = await dayPrices(addDays(d, -1));
      if (!prev) continue;
      prelim = true;
      p = prev.map((s) => ({ t: new Date(+s.t + 24 * H), e: new Date(+s.e + 24 * H), spot: s.spot }));
    }
    for (const s of p) if (s.t >= win.from && s.t < win.to) slots.push(s);
  }
  return { slots, prelim };
}

function ranges(picked) {
  const sorted = [...picked].sort((a, b) => a.t - b.t);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && +s.t === +last.e) last.e = s.e;
    else out.push({ t: s.t, e: s.e });
  }
  return out;
}

// ---------- Rendering ----------
const ICON_EL = `<svg viewBox="0 0 64 64"><path d="M24 10v12M40 10v12"/><path d="M18 22h28v10a14 14 0 0 1-28 0z"/><path d="M32 46v10"/><path d="M34 26l-5 8h6l-5 8" /></svg>`;
const ICON_FUEL = `<svg viewBox="0 0 64 64"><rect x="14" y="10" width="24" height="44" rx="3"/><path d="M14 54h24M19 18h14v10H19z"/><path d="M38 24h5a3 3 0 0 1 3 3v17a3 3 0 0 0 6 0V22l-6-6"/></svg>`;

function chart(el, axisEl, hours, opts = {}) {
  if (!hours.length) { el.innerHTML = `<div class="skeleton" style="align-self:center;width:100%;text-align:center">Inga priser ännu</div>`; axisEl.innerHTML = ""; return; }
  const max = Math.max(...hours.map((h) => h.pris), opts.limit && opts.limit < Math.max(...hours.map((h) => h.pris)) * 1.6 ? opts.limit : 0) * 1.08;
  const now = Date.now();
  el.innerHTML = hours.map((h) => {
    const nPick = opts.picked ? h.list.filter((s) => opts.picked.has(+s.t)).length : 0;
    const cls = nPick === h.list.length && nPick ? "pick" : nPick ? "part" : "";
    const isNow = now >= +h.t && now < +h.t + H ? " now" : "";
    return `<div class="bar ${cls}${isNow}" style="height:${Math.max(3, (h.pris / max) * 100)}%" title="${pad(h.t.getHours())}:00 · ${kr(h.pris)} kr/kWh"></div>`;
  }).join("") + (opts.limit && opts.limit < max ? `<div class="limit" style="bottom:${(opts.limit / max) * (el.clientHeight - 26)}px"><span>bensin billigare</span></div>` : "");
  const every = hours.length > 12 ? 3 : 1;
  axisEl.innerHTML = hours.map((h, i) => `<span>${i % every === 0 ? pad(h.t.getHours()) : ""}</span>`).join("");
}

async function renderHome() {
  const now = new Date();
  const win = nightWindow(now);
  const { slots, prelim } = await nightSlots(win);
  const f = fuelPrice();

  const wallKWh = S.batteri * (1 + S.forlust / 100);
  // Zaptec väljer nattens billigaste timmar – välj lika många hela timmar som laddningen tar
  const hrs = hourly(slots);
  const nh = Math.min(hrs.length, Math.ceil(wallKWh / S.effekt));
  const picked = [...hrs].sort((a, b) => a.pris - b.pris).slice(0, nh).flatMap((h) => h.list);
  const pickSet = new Set(picked.map((s) => +s.t));

  if (!slots.length) {
    $("verdict").textContent = "Inga elpriser";
    $("verdictSub").textContent = "Kunde inte hämta elpriset just nu. Försök igen om en stund.";
    return;
  }

  const elKWh = picked.reduce((a, s) => a + total(s.spot), 0) / picked.length;
  const elMil = S.elPerMil * (1 + S.forlust / 100) * elKWh;
  const bMil = S.bensinPerMil * f.pris;
  const limit = bMil / (S.elPerMil * (1 + S.forlust / 100));
  const ladda = elMil <= bMil;
  const diff = Math.abs(bMil - elMil);
  const pct = Math.round((diff / Math.max(bMil, elMil)) * 100);

  document.documentElement.style.setProperty("--accent", ladda ? "var(--el)" : "var(--fuel)");
  $("emblem").innerHTML = ladda ? ICON_EL : ICON_FUEL;
  const inProgress = now >= win.from;
  $("eyebrow").textContent = `${inProgress ? "Nu i natt" : "I natt"} · ${pad(S.start)}–${pad(S.slut)}`;
  $("verdict").textContent = ladda ? "Ladda bilen" : "Kör på bensin";
  $("verdictSub").innerHTML = pct < 5
    ? `Ungefär lika dyrt – <b>${kr(diff)} kr</b> skillnad per mil`
    : ladda
      ? `El är <b>${pct} % billigare</b> än bensin i natt`
      : `Bensin är <b>${pct} % billigare</b> än el i natt.<br>Du kan hoppa över laddningen.`;

  // Jämförelse
  const m = Math.max(elMil, bMil);
  $("cmp").innerHTML = `
    <div class="line"><span class="lbl">El</span><div class="track"><div class="fill" style="width:${(elMil / m) * 100}%;background:var(--el)"></div></div><span class="amt">${kr(elMil)} kr</span></div>
    <div class="line"><span class="lbl">Bensin</span><div class="track"><div class="fill" style="width:${(bMil / m) * 100}%;background:var(--fuel)"></div></div><span class="amt">${kr(bMil)} kr</span></div>`;
  $("perMil").innerHTML =
    row(ladda ? "Du sparar" : "El kostar mer", `<span class="${ladda ? "good" : "warn"}">${kr(diff)} kr</span><small>/mil</small>`, "big") +
    row("På en vanlig dag (3 mil)", `${kr(diff * 3, 0)} kr`) +
    row("På en månad (≈ 70 mil)", `${kr(diff * 70, 0)} kr`);

  // Natten
  const hh = (d, end) => (end && d.getHours() === 0 ? "24" : pad(d.getHours()));
  const r = ranges(picked).map((x) => `${hh(x.t)}–${hh(x.e, true)}`);
  $("nightSub").textContent = prelim
    ? "Preliminärt – morgondagens priser släpps runt kl. 13"
    : "Allt inräknat – nät, skatt och moms";
  chart($("nightChart"), $("nightAxis"), hrs, { picked: pickSet, limit });
  $("nightRows").innerHTML =
    row("Billigaste timmarna", "kl. " + (r.length > 3 ? `${r.slice(0, 3).join(", ")} …` : r.join(", ").replace(/, ([^,]*)$/, " och $1"))) +
    row("Snittpris när bilen laddar", `${kr(elKWh)}<small>kr/kWh</small>`) +
    row("Bensin lönar sig först över", `<span class="warn">${kr(limit)}</span><small>kr/kWh</small>`) +
    `<div class="note">Zaptec-boxen laddar automatiskt under nattens billigaste timmar. Grafen visar elpriset med Tibbers påslag, E.ON:s nätavgift, energiskatt och moms.</div>`;

  // Full laddning
  const mil = S.batteri / S.elPerMil;
  const fullEl = wallKWh * elKWh;
  const fullB = mil * bMil;
  $("fullRows").innerHTML =
    row("Räcker till", `ca ${kr(mil, 1)} mil`) +
    row("Laddningen kostar", `${kr(fullEl, 0)} kr`) +
    row("Samma sträcka på bensin", `${kr(fullB, 0)} kr`) +
    row("Tar ungefär", `${kr(wallKWh / S.effekt, 1)} timmar`);

  // Bensin
  let fr = row("Pris per liter", `${kr(f.pris)} kr`, "big");
  if (f.kalla === "eget pris") fr += row("Källa", "Ditt eget pris");
  else if (fuel) {
    const l = fuel.lagst;
    fr += row("Billigast", `${l.kedja} ${kr(l.pris)} kr<small>${l.adress.split(",")[0]}</small>`);
    const d = new Date(fuel.uppdaterad);
    fr += row("Uppdaterat", d.toLocaleDateString("sv-SE", { day: "numeric", month: "long" }) + ` kl. ${hm(d)}`);
    fr += row("Underlag", `${fuel.antal} stationer`);
  } else fr += `<div class="err">Kunde inte hämta bensinpriset – visar uppskattning. Ange eget pris under Inställningar.</div>`;
  $("fuelRows").innerHTML = fr;
}

async function renderEl() {
  const today = startOfDay(new Date());
  const [a, b] = await Promise.all([dayPrices(today), dayPrices(addDays(today, 1))]);
  const stats = (p) => {
    const h = hourly(p);
    const lo = h.reduce((x, y) => (y.pris < x.pris ? y : x));
    const hi = h.reduce((x, y) => (y.pris > x.pris ? y : x));
    const avg = h.reduce((s, x) => s + x.pris, 0) / h.length;
    return { h, rows: row("Lägst", `${pad(lo.t.getHours())}:00 · ${kr(lo.pris)}<small>kr</small>`) + row("Högst", `${pad(hi.t.getHours())}:00 · ${kr(hi.pris)}<small>kr</small>`) + row("Snitt", `${kr(avg)}<small>kr/kWh</small>`) };
  };
  if (a) {
    const s = stats(a);
    $("todaySub").textContent = new Date().toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" });
    chart($("todayChart"), $("todayAxis"), s.h);
    $("todayRows").innerHTML = s.rows;
    const cur = a.find((x) => Date.now() >= +x.t && Date.now() < +x.e) || a[0];
    $("breakdown").innerHTML =
      row("Spotpris (Nord Pool)", `${kr(cur.spot)} kr`) +
      row("Moms på spotpriset", `${kr(cur.spot * 0.25)} kr`) +
      row("Tibber påslag", `${kr(S.paslag)} kr`) +
      row("E.ON överföring", `${kr(S.nat)} kr`) +
      row("Energiskatt", `${kr(S.skatt)} kr`) +
      row("Totalt", `${kr(total(cur.spot))}<small>kr/kWh</small>`, "big") +
      `<div class="note">Fasta månadsavgifter räknas inte med – de betalas oavsett om bilen laddas.</div>`;
  } else $("todayRows").innerHTML = `<div class="err">Kunde inte hämta dagens elpris.</div>`;
  if (b) {
    const s = stats(b);
    $("tomSub").textContent = addDays(today, 1).toLocaleDateString("sv-SE", { weekday: "long", day: "numeric", month: "long" });
    chart($("tomChart"), $("tomAxis"), s.h);
    $("tomRows").innerHTML = s.rows;
  } else {
    $("tomSub").textContent = "Släpps runt kl. 13";
    $("tomChart").innerHTML = ""; $("tomAxis").innerHTML = "";
    $("tomRows").innerHTML = `<div class="note">Morgondagens elpriser är inte klara än.</div>`;
  }
}

// ---------- Inställningar ----------
const FIELDS = {
  "f-bil": [
    ["elPerMil", "Elförbrukning", "kWh/mil", "Volvo-appen visar kWh/100 km – dela med 10"],
    ["bensinPerMil", "Bensinförbrukning", "l/mil", "När batteriet är slut"],
    ["batteri", "Batteri", "kWh", "Användbar kapacitet"],
    ["effekt", "Laddeffekt", "kW"],
    ["forlust", "Laddförluster", "%"],
  ],
  "f-el": [
    ["paslag", "Tibber påslag", "kr/kWh", "Inkl. moms"],
    ["nat", "E.ON överföring", "kr/kWh", "Inkl. moms"],
    ["skatt", "Energiskatt", "kr/kWh", "Inkl. moms"],
    ["start", "Laddning börjar", "kl."],
    ["slut", "Bilen ska vara klar", "kl."],
  ],
  "f-bensin": [["bensinManuell", "Eget bensinpris", "kr/l", "T.ex. det som stod på pumpen"]],
};
function renderSettings() {
  for (const [box, list] of Object.entries(FIELDS)) {
    $(box).innerHTML = list.map(([k, label, unit, hint]) => `
      <div class="field"><label for="i-${k}">${label}${hint ? `<small>${hint}</small>` : ""}</label>
      <span class="in"><input id="i-${k}" data-k="${k}" inputmode="decimal" value="${S[k] === "" ? "" : String(S[k]).replace(".", ",")}" placeholder="${k === "bensinManuell" && fuel ? kr(fuel.snitt) : ""}"><span class="u">${unit}</span></span></div>`).join("");
  }
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
$("reset").addEventListener("click", () => { S = Object.assign({}, DEF); save(); renderSettings(); refresh(); });

// ---------- Navigering ----------
document.querySelectorAll(".nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".nav button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === "v-" + b.dataset.v));
  window.scrollTo(0, 0);
  if (b.dataset.v === "el") renderEl();
}));

async function refresh() {
  await renderHome();
  if ($("v-el").classList.contains("on")) renderEl();
}

(async function init() {
  await loadFuel();
  renderSettings();
  await refresh();
  renderEl();
})();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { for (const k in priceCache) if (!priceCache[k]) delete priceCache[k]; loadFuel().then(refresh); }
});
