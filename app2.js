let LEAGUES = [];
const DAY_CACHE = {};
let lastDiag = "";
let currentLoadToken = 0;
const dayOffset = () => st.tab === "ieri" ? -1 : st.tab === "oggi" ? 0 : 1;

function recalcAllPredictions() {
  LEAGUES.forEach(l => l.matches.forEach(m => { m.prediction = calcPred(m); }));
}

async function fetchScoreboardDay(slug, dp, diag) {
  try {
    const events = await ESPNProvider.fetchScoreboard(slug, dp);
    diag.ok++;
    return events;
  } catch (err) {
    if (err?.status) { diag.httpErr++; diag.lastStatus = err.status; }
    else { diag.netErr++; }
    return [];
  }
}

async function loadDay(offset, force = false) {
  const token = ++currentLoadToken;
  const badge = document.getElementById("modeBadge"), sub = document.getElementById("subStatus");
  const dp = dateParam(offset), dpPrev = dateParam(offset - 1), tKey = targetDateKey(offset);
  const ttl = offset === 0 ? 55 * 1000 : 10 * 60 * 1000;
  const cached = DAY_CACHE[dp];

  if (!force && cached && (Date.now() - cached.ts) < ttl) {
    LEAGUES = cached.leagues;
    lastDiag = "";
    recalcAllPredictions();
    const tot = LEAGUES.reduce((s, l) => s + l.matches.length, 0);
    badge.textContent = "LIVE REALE";
    badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
    sub.textContent = `${tot} partite (${dp.slice(6,8)}/${dp.slice(4,6)}) • Cache veloce`;
    renderSchedule();
    return;
  }

  badge.textContent = "CARICO...";
  badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30";
  const diag = { ok: 0, httpErr: 0, netErr: 0, lastStatus: 0 };

  try {
    let doneBoards = 0;
    sub.textContent = `Scarico tornei 0/${COMPS.length}...`;
    const boards = await mapWithConcurrency(COMPS, 10, async ([slug, name, kind, flag]) => {
      let events = await fetchScoreboardDay(slug, dp, diag);
      if (AM_LEAGUES.has(slug)) {
        const prevEv = await fetchScoreboardDay(slug, dpPrev, diag);
        const evMap = new Map();
        prevEv.concat(events).forEach(ev => evMap.set(ev.id, ev));
        events = Array.from(evMap.values()).filter(ev => localDateKey(new Date(ev.date)) === tKey);
      }
      doneBoards++;
      if (token === currentLoadToken) sub.textContent = `Scarico tornei ${doneBoards}/${COMPS.length}...`;
      return events.length ? { slug, name, kind, flag, events } : null;
    });

    if (token !== currentLoadToken) return;
    if (diag.ok === 0 && diag.netErr > 0) throw new Error("Connessione/CORS non riuscita");

    const active = boards.filter(Boolean);
    const hasClubCup = active.some(b => b.kind === "Coppa");
    const slugsToFetch = active.filter(b => b.slug !== "fifa.friendly").map(b => [b.slug, b.name]);
    if (hasClubCup) {
      COMPS.filter(([, , kind]) => kind === "Campionato").forEach(([slug, name]) => {
        if (!slugsToFetch.some(([s]) => s === slug)) slugsToFetch.push([slug, name]);
      });
    }
    if (slugsToFetch.length) sub.textContent = `Scarico classifiche (${slugsToFetch.length})...`;
    await mapWithConcurrency(slugsToFetch, 10, ([slug, name]) => fetchStandings(slug, name));
    if (token !== currentLoadToken) return;
    persistStandingsCache();

    const hist = getTeamHist();
    LEAGUES = active.map(b => {
      const isLeague = b.kind === "Campionato", stdEntry = standingsCache[b.slug] || {}, tbl = stdEntry.map || {};
      const leagueAvgH = isLeague ? safeNum(stdEntry.avgH, 1.48) : 1.48;
      const leagueAvgA = isLeague ? safeNum(stdEntry.avgA, 1.18) : 1.18;

      const matches = b.events.map(ev => {
        const comp = ev.competitions?.[0] || {};
        const home = (comp.competitors || []).find(c => c.homeAway === "home") || {};
        const away = (comp.competitors || []).find(c => c.homeAway === "away") || {};
        const hs = resolveTeamStats(home.team?.id, tbl, b.kind);
        const as = resolveTeamStats(away.team?.id, tbl, b.kind);
        const ok = Boolean(hs && as && hs.played >= 3 && as.played >= 3);
        const hf = parseForm(home.form), af = parseForm(away.form);
        const dt = new Date(ev.date), startTs = dt.getTime();
        const timeStr = `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;

        const statusObj = ev.status?.type || {}, statusName = statusObj.name || "";
        const shortDet = (statusObj.shortDetail || "").toUpperCase(), isExtra = EXTRA_RE.test(shortDet);
        const isCanceled = statusName === "STATUS_POSTPONED" || statusName === "STATUS_CANCELED" || (statusObj.state === "post" && statusObj.completed === false);
        const stateType = isCanceled ? "canceled" : (statusObj.state || "pre");
        const hasScore = home.score !== undefined && home.score !== "" && away.score !== undefined && away.score !== ""
          && Number.isFinite(Number(home.score)) && Number.isFinite(Number(away.score));
        const hScore = hasScore ? Number(home.score) : 0, aScore = hasScore ? Number(away.score) : 0;

        let statusTxt = "PRE";
        if (stateType === "in") statusTxt = ev.status?.displayClock || "LIVE";
        else if (stateType === "post") statusTxt = isExtra ? (/\b(PEN|PENS|PSO|FT-PENS)\b/.test(shortDet) ? "RIG" : "SUPPL") : "FIN";
        else if (stateType === "canceled") statusTxt = statusName === "STATUS_CANCELED" ? "CANC" : "RINV";

        const gpH = hs ? hs.played : 0, gpA = as ? as.played : 0;
        const hGF = shrink(hs ? (hs.hGfAvg ?? hs.gfAvg * 1.08) : leagueAvgH, gpH, leagueAvgH, 5);
        const hGA = shrink(hs ? (hs.hGaAvg ?? hs.gaAvg * 0.92) : leagueAvgA, gpH, leagueAvgA, 5);
        const aGF = shrink(as ? (as.aGfAvg ?? as.gfAvg * 0.92) : leagueAvgA, gpA, leagueAvgA, 5);
        const aGA = shrink(as ? (as.aGaAvg ?? as.gaAvg * 1.08) : leagueAvgH, gpA, leagueAvgH, 5);

        const hId = home.team?.id, aId = away.team?.id;
        const tierH = (LEAGUE_TIER[hs?.domSlug || b.slug]?.s) ?? 0.88;
        const tierA = (LEAGUE_TIER[as?.domSlug || b.slug]?.s) ?? 0.88;

        const m = {
          id: ev.id, slug: b.slug, leagueId: b.slug, leagueName: b.name, kind: b.kind, flag: b.flag,
          time: timeStr, startTs, stateType, isExtra, hasScore, hScore, aScore,
          scoreStr: ((stateType === "in" || stateType === "post") && hasScore) ? `${hScore} - ${aScore}` : "- : -",
          statusTxt, homeId: hId, awayId: aId,
          home: home.team?.displayName || "Casa", away: away.team?.displayName || "Ospite",
          homeLogo: home.team?.logo || "", awayLogo: away.team?.logo || "", lowData: !ok,
          formH: hf.pills, formA: af.pills,
          statSourceH: hs ? `${hs.source} (${hs.played}g)` : "Default",
          statSourceA: as ? `${as.source} (${as.played}g)` : "Default",
          stats: {
            avgH: leagueAvgH, avgA: leagueAvgA,
            hGF: Number(safeNum(hGF, leagueAvgH).toFixed(2)), hGA: Number(safeNum(hGA, leagueAvgA).toFixed(2)),
            aGF: Number(safeNum(aGF, leagueAvgA).toFixed(2)), aGA: Number(safeNum(aGA, leagueAvgH).toFixed(2)),
            hFF: hf.factor, aFF: af.factor, hL: 1.0, aL: 1.0,
            isCrossLeague: b.kind !== "Campionato", tierH, tierA,
            eloH: hist[hId]?.elo ?? null, eloA: hist[aId]?.elo ?? null,
            comp: ok ? 0.92 : (home.form && away.form ? 0.72 : 0.54), vol: ok ? 0.20 : 0.34
          }
        };
        m.prediction = calcPred(m);
        return m;
      });
      return { id: b.slug, name: b.name, kind: b.kind, flag: b.flag, matches };
    });

    const tot = LEAGUES.reduce((s, l) => s + l.matches.length, 0);
    if (tot > 0 || diag.httpErr === 0) DAY_CACHE[dp] = { ts: Date.now(), leagues: LEAGUES };
    lastDiag = tot === 0
      ? `API OK su ${diag.ok}/${COMPS.length} tornei${diag.httpErr ? ` (HTTP ${diag.lastStatus} su ${diag.httpErr})` : " — nessuna gara in calendario per questa data"}`
      : "";
    const nowStr = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    badge.textContent = "LIVE REALE";
    badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30";
    sub.textContent = `${tot} partite (${dp.slice(6,8)}/${dp.slice(4,6)}) • Agg. ${nowStr}`;
    syncSlipFromLeagues();
    renderSchedule();
  } catch (err) {
    console.error("Errore loadDay:", err);
    if (token !== currentLoadToken) return;
    LEAGUES = [];
    lastDiag = `Impossibile contattare site.api.espn.com (${err?.message || "connessione assente o blocco CORS/rete"}).`;
    badge.textContent = "OFFLINE";
    badge.className = "text-[10px] px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30";
    sub.textContent = "Controlla la connessione e premi ↻";
    renderSchedule();
  }
}

let isScanning = false;
function setScanBusy(busy) {
  isScanning = busy;
  ["btnScan9", "btnScan12", "btnResetHist", "btnExportHist"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = busy;
  });
}

window.scanSeason = async totalDays => {
  if (isScanning) return;
  setScanBusy(true);
  const wrapEl = document.getElementById("histScanWrap"), stEl = document.getElementById("histScanStatus");
  const pWrap = document.getElementById("histProgressWrap"), pBar = document.getElementById("histProgressBar");
  wrapEl.classList.remove("hidden"); pWrap.classList.remove("hidden"); pBar.style.width = "4%";

  try {
    const nowD = new Date(), currentYm = `${nowD.getFullYear()}${String(nowD.getMonth() + 1).padStart(2, "0")}`;
    const endD = new Date(); endD.setDate(endD.getDate() - 1); endD.setHours(23, 59, 59, 999);
    const startD = new Date(); startD.setDate(startD.getDate() - totalDays); startD.setHours(0, 0, 0, 0);
    const minTs = startD.getTime(), maxTs = endD.getTime();
    const months = [], cur = new Date(startD.getFullYear(), startD.getMonth(), 1), lastM = new Date(endD.getFullYear(), endD.getMonth(), 1);
    while (cur <= lastM) {
      months.push({ y: cur.getFullYear(), m: cur.getMonth() + 1, ym: `${cur.getFullYear()}${String(cur.getMonth() + 1).padStart(2, "0")}` });
      cur.setMonth(cur.getMonth() + 1);
    }

    const evMap = new Map();
    for (let mIdx = 0; mIdx < months.length; mIdx++) {
      const { y, m, ym } = months[mIdx], isClosedMonth = ym < currentYm && nowD.getDate() > 2;
      let monthRecords = null;
      if (isClosedMonth) { try { monthRecords = await idbGet(MONTH_PREFIX + ym); } catch {} }

      if (Array.isArray(monthRecords)) {
        stEl.textContent = `Carico mese ${mIdx + 1}/${months.length} da cache (${ym.slice(4)}/${ym.slice(0, 4)})...`;
      } else {
        stEl.textContent = `Scarico mese ${mIdx + 1}/${months.length} (${ym.slice(4)}/${ym.slice(0, 4)})...`;
        const lastDay = String(new Date(y, m, 0).getDate()).padStart(2, "0");
        const ranges = [`${ym}01-${ym}15`, `${ym}16-${ym}${lastDay}`], monthDedup = new Map();
        await mapWithConcurrency(COMPS, 5, async ([slug, compName, kind, flag]) => {
          for (const dr of ranges) {
            try {
              const events = await ESPNProvider.fetchScoreboard(slug, dr, 250);
              events.forEach(ev => {
                if (monthDedup.has(ev.id)) return;
                const stType = ev.status?.type, isExtra = EXTRA_RE.test((stType?.shortDetail || "").toUpperCase());
                const comp = ev.competitions?.[0] || {};
                const home = (comp.competitors || []).find(c => c.homeAway === "home");
                const away = (comp.competitors || []).find(c => c.homeAway === "away");
                const hasScore = home?.score !== undefined && home?.score !== "" && away?.score !== undefined && away?.score !== "";
                if (stType?.state === "post" && stType?.completed !== false && !isExtra && hasScore && home?.team?.id && away?.team?.id) {
                  const ts = new Date(ev.date).getTime();
                  if (Number.isFinite(ts)) {
                    monthDedup.set(ev.id, {
                      id: ev.id, ts, date: ev.date, slug, compName, kind, flag,
                      hId: home.team.id, hName: home.team.displayName || "Casa", hScore: Number(home.score),
                      aId: away.team.id, aName: away.team.displayName || "Ospite", aScore: Number(away.score)
                    });
                  }
                }
              });
            } catch {}
          }
        });
        monthRecords = Array.from(monthDedup.values());
        if (isClosedMonth && monthRecords.length > 0) { try { await idbSet(MONTH_PREFIX + ym, monthRecords); } catch {} }
      }
      monthRecords.forEach(rec => { if (rec.ts >= minTs && rec.ts <= maxTs && !evMap.has(rec.id)) evMap.set(rec.id, rec); });
      pBar.style.width = `${Math.round(((mIdx + 1) / (months.length + 1)) * 100)}%`;
    }

    const allEvents = Array.from(evMap.values()).sort((a, b) => a.ts - b.ts);
    stEl.textContent = `Analizzo ${allEvents.length} match + calcolo rating ELO...`;

    const rolling = {}, leagueRoll = {}, eloMap = {}, teams = {};
    const initRoll = () => ({ played: 0, gf: 0, ga: 0, hP: 0, hGf: 0, hGa: 0, aP: 0, aGf: 0, aGa: 0, pts: [], lastTs: 0 });
    const getRoll = id => rolling[id] || initRoll();
    const getElo = (id, slug) => eloMap[id] ?? (LEAGUE_TIER[slug]?.elo ?? 1470);
    const formFactor = arr => !arr.length ? 1.0 : 0.88 + (arr.slice(-5).reduce((a, b) => a + b, 0) / (Math.min(5, arr.length) * 3)) * 0.24;
    const decayRoll = r => ({
      played: r.played * 0.35, gf: r.gf * 0.35, ga: r.ga * 0.35,
      hP: r.hP * 0.35, hGf: r.hGf * 0.35, hGa: r.hGa * 0.35,
      aP: r.aP * 0.35, aGf: r.aGf * 0.35, aGa: r.aGa * 0.35, pts: r.pts.slice(-2), lastTs: r.lastTs
    });

    allEvents.forEach(rec => {
      const { hId, aId, hName, aName, hScore, aScore, ts: evTs, date, slug, compName, kind, flag } = rec;
      if (!Number.isFinite(hScore) || !Number.isFinite(aScore)) return;

      const lr = leagueRoll[slug] || { m: 0, hGf: 0, aGf: 0 };
      const avgH = Number(clamp((lr.hGf + 1.48 * 10) / (lr.m + 10), 0.90, 2.30).toFixed(3));
      const avgA = Number(clamp((lr.aGf + 1.18 * 10) / (lr.m + 10), 0.70, 2.00).toFixed(3));
      const eloH = getElo(hId, slug), eloA = getElo(aId, slug);

      let hr = getRoll(hId), ar = getRoll(aId);
      if (hr.lastTs && (evTs - hr.lastTs) > 3888000000) hr = decayRoll(hr);
      if (ar.lastTs && (evTs - ar.lastTs) > 3888000000) ar = decayRoll(ar);

      if (hr.played >= 2 && ar.played >= 2) {
        const rawHGF = hr.hP >= 3 ? (hr.hGf / hr.hP) : (hr.gf / hr.played) * 1.08;
        const rawHGA = hr.hP >= 3 ? (hr.hGa / hr.hP) : (hr.ga / hr.played) * 0.92;
        const rawAGF = ar.aP >= 3 ? (ar.aGf / ar.aP) : (ar.gf / ar.played) * 0.92;
        const rawAGA = ar.aP >= 3 ? (ar.aGa / ar.aP) : (ar.ga / ar.played) * 1.08;

        const fake = {
          home: hName, away: aName, slug,
          stats: {
            avgH, avgA,
            hGF: shrink(rawHGF, hr.hP >= 3 ? hr.hP : hr.played, avgH, 5),
            hGA: shrink(rawHGA, hr.hP >= 3 ? hr.hP : hr.played, avgA, 5),
            aGF: shrink(rawAGF, ar.aP >= 3 ? ar.aP : ar.played, avgA, 5),
            aGA: shrink(rawAGA, ar.aP >= 3 ? ar.aP : ar.played, avgH, 5),
            hFF: formFactor(hr.pts), aFF: formFactor(ar.pts), hL: 1.0, aL: 1.0,
            isCrossLeague: kind !== "Campionato", eloH, eloA,
            comp: hr.played >= 5 && ar.played >= 5 ? 0.91 : 0.74, vol: 0.22
          }
        };
        const pred = calcPred(fake, {}, true);
        const ph = isHit(pred.bestPick.code, hScore, aScore) ? 1 : 0;
        const oh = isHit(pred.ouPick.code, hScore, aScore) ? 1 : 0;
        const pr = Number(pred.bestPick.prob.toFixed(3)), cat = pred.bestPick.cat;

        const pushRec = (tid, tName, oppId, opp, isHome) => {
          if (!teams[tid]) teams[tid] = { id: tid, n: tName, elo: 1500, tot: 0, hit: 0, ou: 0, tTot: 0, tHit: 0, eg: 0, rg: 0, gf: 0, ga: 0, egf: 0, ega: 0, m: [] };
          const t = teams[tid], lH = Number(pred.lamH), lA = Number(pred.lamA);
          const myGf = isHome ? hScore : aScore, myGa = isHome ? aScore : hScore;
          const myEgf = isHome ? lH : lA, myEga = isHome ? lA : lH;
          t.tot++; t.hit += ph; t.ou += oh;
          if (pred.confidence >= 75) { t.tTot++; t.tHit += ph; }
          t.eg += lH + lA; t.rg += hScore + aScore;
          t.gf += myGf; t.ga += myGa; t.egf += myEgf; t.ega += myEga;
          t.m.push({
            d: date.slice(0, 10), c: compName, k: kind, f: flag, oid: oppId, h: isHome ? 1 : 0,
            t: isHome ? `${tName} - ${opp}` : `${opp} - ${tName}`, s: `${hScore}-${aScore}`,
            p: pred.bestPick.code, cat, pr, ph, o: pred.ouPick.code, oh, gf: myGf, ga: myGa, egf: myEgf, ega: myEga
          });
        };
        pushRec(hId, hName, aId, aName, true);
        pushRec(aId, aName, hId, hName, false);
      }

      const expH = 1 / (1 + Math.pow(10, (eloA - (eloH + 55)) / 400));
      const actH = hScore > aScore ? 1 : hScore === aScore ? 0.5 : 0;
      const kElo = (kind === "Coppa" ? 26 : 20) * Math.max(1, Math.log(Math.abs(hScore - aScore) + 1) * 1.15);
      eloMap[hId] = eloH + kElo * (actH - expH);
      eloMap[aId] = eloA + kElo * ((1 - actH) - (1 - expH));

      leagueRoll[slug] = { m: lr.m + 1, hGf: lr.hGf + hScore, aGf: lr.aGf + aScore };
      const hp = hScore > aScore ? 3 : hScore === aScore ? 1 : 0;
      const ap = aScore > hScore ? 3 : aScore === hScore ? 1 : 0;
      rolling[hId] = { ...hr, played: hr.played + 1, gf: hr.gf + hScore, ga: hr.ga + aScore, hP: hr.hP + 1, hGf: hr.hGf + hScore, hGa: hr.hGa + aScore, pts: [...hr.pts, hp], lastTs: evTs };
      rolling[aId] = { ...ar, played: ar.played + 1, gf: ar.gf + aScore, ga: ar.ga + hScore, aP: ar.aP + 1, aGf: ar.aGf + aScore, aGa: ar.aGa + hScore, pts: [...ar.pts, ap], lastTs: evTs };
    });

    Object.keys(teams).forEach(tid => { teams[tid].elo = Math.round(eloMap[tid] ?? 1500); });
    await saveTeamHist(teams);
    pBar.style.width = "100%";
    stEl.textContent = `✅ Salvati ${allEvents.length} match + ELO su ${Object.keys(teams).length} squadre!`;
    recalcAllPredictions();
    renderTeamLeaderboard();
    renderSchedule();
  } catch {
    stEl.textContent = "⚠️ Errore durante lo scaricamento. Riprova.";
  } finally {
    setScanBusy(false);
    setTimeout(() => pWrap.classList.add("hidden"), 1200);
  }
};

window.resetHistory = async () => {
  if (isScanning) return;
  await clearTeamHist();
  document.getElementById("histScanWrap").classList.add("hidden");
  recalcAllPredictions(); renderTeamLeaderboard(); renderSchedule();
};

window.exportHistory = () => {
  const data = getTeamHist();
  if (!Object.keys(data).length) return alert("Nessuno storico da esportare.");
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `footpredict-storico-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  URL.revokeObjectURL(url);
};

function renderTeamLeaderboard() {
  const raw = getTeamHist(), q = document.getElementById("teamHistSearch").value.trim().toLowerCase();
  const minM = Number(document.getElementById("minMatchesFilter").value), all = Object.values(raw);
  const tot = all.reduce((s, x) => s + x.tot, 0), hits = all.reduce((s, x) => s + x.hit, 0), ouHits = all.reduce((s, x) => s + x.ou, 0);

  let uniqueM = 0, brierSum = 0;
  const byCat = { "1X2": { n: 0, h: 0 }, "DC": { n: 0, h: 0 }, "GOALS": { n: 0, h: 0 } };
  const bins = [
    { label: "50–60%", min: 0.50, max: 0.60, n: 0, h: 0, pSum: 0 },
    { label: "60–70%", min: 0.60, max: 0.70, n: 0, h: 0, pSum: 0 },
    { label: "70–80%", min: 0.70, max: 0.80, n: 0, h: 0, pSum: 0 },
    { label: "80%+", min: 0.80, max: 1.01, n: 0, h: 0, pSum: 0 }
  ];

  all.forEach(t => {
    (t.m || []).forEach(x => {
      if (x.h !== 1 || !Number.isFinite(x.pr)) return;
      uniqueM++; brierSum += Math.pow(x.pr - x.ph, 2);
      if (byCat[x.cat]) { byCat[x.cat].n++; byCat[x.cat].h += x.ph; }
      const b = bins.find(bn => x.pr >= bn.min && x.pr < bn.max);
      if (b) { b.n++; b.h += x.ph; b.pSum += x.pr; }
    });
  });

  document.getElementById("hTotal").textContent = uniqueM || Math.round(tot / 2);
  document.getElementById("hWinRate").textContent = tot ? `${Math.round(hits / tot * 100)}%` : "-";
  document.getElementById("hBrier").textContent = uniqueM ? (brierSum / uniqueM).toFixed(3) : "-";
  document.getElementById("hOuRate").textContent = tot ? `${Math.round(ouHits / tot * 100)}%` : "-";

  const calBox = document.getElementById("calibSummary");
  if (uniqueM > 0) {
    calBox.classList.remove("hidden");
    const fmtCat = (label, obj) => obj.n ? `<span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-800">${label}: <strong class="text-white">${Math.round(obj.h / obj.n * 100)}%</strong> <span class="text-slate-500">(${obj.n})</span></span>` : "";
    calBox.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-1.5">
        <span class="font-bold text-slate-300">🎯 Resa per Mercato:</span>
        <div class="flex flex-wrap gap-1.5">${fmtCat("1X2", byCat["1X2"])}${fmtCat("Doppia Chance", byCat["DC"])}${fmtCat("Gol/O-U", byCat["GOALS"])}</div>
      </div>
      <div class="grid grid-cols-4 gap-1.5 pt-1 border-t border-slate-800/80 text-center">
        ${bins.map(b => {
          const real = b.n ? Math.round((b.h / b.n) * 100) + "%" : "-";
          const exp = b.n ? Math.round((b.pSum / b.n) * 100) + "%" : "-";
          return `<div class="p-1.5 rounded-lg bg-slate-900/70"><div class="text-[9px] text-slate-400">Prev. ${b.label}</div><div class="font-bold text-emerald-400">${real} <span class="text-[9px] text-slate-500 font-normal">vs ${exp}</span></div></div>`;
        }).join("")}
      </div>`;
  } else {
    calBox.classList.add("hidden");
  }

  const list = all.filter(t => t.tot >= minM && (!q || t.n.toLowerCase().includes(q)))
    .map(t => ({ ...t, rate: t.hit / t.tot })).sort((a, b) => b.rate - a.rate || b.tot - a.tot);

  const box = document.getElementById("teamLeaderboard");
  if (!all.length) {
    box.innerHTML = `<div class="glass rounded-2xl p-6 text-center text-xs text-slate-400">Premi <strong>"📥 9 Mesi"</strong> o <strong>"📥 12 Mesi"</strong> per generare classifica ELO e calibrazione reale!</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="glass rounded-2xl p-6 text-center text-xs text-slate-400">Nessuna squadra trovata.</div>`;
    return;
  }

  box.innerHTML = list.map((t, idx) => {
    const pct = Math.round(t.rate * 100), ouPct = Math.round((t.ou / t.tot) * 100);
    const cls = pct >= 68 ? "border-emerald-500/35 text-emerald-400" : pct >= 52 ? "border-amber-500/35 text-amber-300" : "border-rose-500/35 text-rose-400";
    const barCls = pct >= 68 ? "bg-emerald-500" : pct >= 52 ? "bg-amber-400" : "bg-rose-500";
    return `<div data-tid="${esc(t.id)}" class="team-card glass rounded-2xl p-3 space-y-2 border ${cls.split(' ')[0]} cursor-pointer hover:bg-slate-800/50 transition-colors">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-xs font-bold text-slate-500 w-7 shrink-0">#${idx + 1}</span>
          <div class="min-w-0">
            <div class="text-xs sm:text-sm font-bold text-white truncate">${esc(t.n)} <span class="text-[10px] font-normal text-cyan-300">ELO ${Math.round(t.elo || 1500)}</span></div>
            <div class="text-[10px] text-slate-400">${t.hit}/${t.tot} presi • O/U ${ouPct}%</div>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0"><span class="text-sm font-extrabold ${cls.split(' ')[1]}">${pct}%</span><span class="text-slate-500 text-xs">▸</span></div>
      </div>
      <div class="w-full h-1.5 bg-slate-900 rounded-full overflow-hidden"><div class="h-full ${barCls}" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");
}

function openTeamModal(tid) {
  const t = getTeamHist()[tid];
  if (!t) return;
  const pct = Math.round((t.hit / t.tot) * 100);
  document.getElementById("modalLeague").textContent = `Storico • ${t.hit}/${t.tot} presi (${pct}%) • ELO ${Math.round(t.elo || 1500)}`;
  document.getElementById("modalTitle").textContent = t.n;
  const byComp = {};
  t.m.slice().reverse().forEach(x => {
    const key = `${x.f} ${x.c} (${x.k})`;
    if (!byComp[key]) byComp[key] = [];
    byComp[key].push(x);
  });
  document.getElementById("modalBody").innerHTML = Object.entries(byComp).map(([label, list]) => {
    const cHits = list.filter(x => x.ph).length;
    return `<div class="rounded-xl bg-slate-950 border border-slate-800 overflow-hidden">
      <div class="px-3 py-2 bg-slate-900 border-b border-slate-800 flex justify-between items-center">
        <span class="text-xs font-bold text-white">${esc(label)}</span>
        <span class="text-[11px] font-semibold text-emerald-400">${cHits}/${list.length} (${Math.round(cHits / list.length * 100)}%)</span>
      </div>
      <div class="divide-y divide-slate-800/70">
        ${list.map(x => `<div class="px-3 py-2 flex items-center justify-between gap-2 text-xs">
          <div class="min-w-0"><div class="text-[10px] text-slate-500">${esc(x.d)}</div><div class="text-slate-200 font-medium truncate">${esc(x.t)}</div></div>
          <div class="flex items-center gap-2 shrink-0">
            <span class="px-2 py-0.5 rounded bg-slate-800 font-bold text-white">${esc(x.s)}</span>
            <div class="text-right">
              <div class="text-[11px] font-bold ${x.ph ? 'text-emerald-400' : 'text-rose-400'}">${esc(x.p)} ${x.ph ? '✅' : '❌'}</div>
              <div class="text-[9px] text-slate-400">${esc(x.o)} ${x.oh ? '✅' : '❌'}</div>
            </div>
          </div>
        </div>`).join("")}
      </div>
    </div>`;
  }).join("");
  const mod = document.getElementById("detailModal");
  mod.classList.remove("hidden"); mod.classList.add("flex");
}

function renderDiario() {
  const closed = BET_LOG.filter(b => b.status === "won" || b.status === "lost");
  const won = closed.filter(b => b.status === "won").length;
  const staked = closed.reduce((s, b) => s + b.stake, 0);
  const net = closed.reduce((s, b) => s + (b.status === "won" ? b.stake * (b.odd - 1) : -b.stake), 0);

  document.getElementById("dCount").textContent = `${closed.length}/${BET_LOG.length}`;
  document.getElementById("dWinRate").textContent = closed.length ? `${Math.round(won / closed.length * 100)}%` : "-";
  const netEl = document.getElementById("dNetProfit");
  netEl.textContent = `${net >= 0 ? "+" : ""}${net.toFixed(2)}u`;
  netEl.className = `text-sm font-extrabold ${net >= 0 ? "text-emerald-400" : "text-rose-400"}`;
  document.getElementById("dRoi").textContent = staked > 0 ? `${((net / staked) * 100).toFixed(1)}%` : "-";

  const box = document.getElementById("betLogList");
  if (!BET_LOG.length) {
    box.innerHTML = `<div class="glass rounded-2xl p-6 text-center text-xs text-slate-400">Nessuna giocata registrata. Tocca una partita nel palinsesto, inserisci la quota e premi <strong>"💼 Registra"</strong>!</div>`;
    return;
  }

  box.innerHTML = BET_LOG.slice().reverse().map(b => {
    const stBadge = b.status === "won" ? `<span class="text-emerald-400 font-bold">✅ VINTA (+${(b.stake * (b.odd - 1)).toFixed(2)}u)</span>`
      : b.status === "lost" ? `<span class="text-rose-400 font-bold">❌ PERSA (-${b.stake.toFixed(2)}u)</span>`
      : b.status === "void" ? `<span class="text-slate-400 font-bold">↩️ RIMBORSATA</span>`
      : `<span class="text-amber-300 font-bold">⏳ IN ATTESA</span>`;
    return `<div class="glass rounded-2xl p-3 space-y-2 text-xs">
      <div class="flex justify-between items-start gap-2">
        <div class="min-w-0">
          <div class="text-[10px] text-slate-400">${esc(b.date)} • ${esc(b.league)}</div>
          <div class="font-bold text-white truncate">${esc(b.match)}</div>
          <div class="text-[11px] text-cyan-300 font-semibold">${esc(b.code)} @${b.odd.toFixed(2)} • Puntata: ${b.stake}u</div>
        </div>
        <div class="text-right shrink-0">${stBadge}</div>
      </div>
      <div class="flex flex-wrap gap-1.5 pt-1.5 border-t border-slate-800">
        <button data-bet-set="${esc(b.id)}:won" class="px-2 py-1 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold">✅ Vinta</button>
        <button data-bet-set="${esc(b.id)}:lost" class="px-2 py-1 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[10px] font-bold">❌ Persa</button>
        <button data-bet-set="${esc(b.id)}:void" class="px-2 py-1 rounded bg-slate-800 text-slate-300 text-[10px] font-bold">↩️ Rimb.</button>
        <button data-bet-del="${esc(b.id)}" class="ml-auto px-2 py-1 rounded bg-slate-800 text-rose-300 text-[10px]">🗑️</button>
      </div>
    </div>`;
  }).join("");
}

function syncSlipFromLeagues() {
  if (!SLIP.size) return;
  const byId = new Map();
  LEAGUES.forEach(l => l.matches.forEach(m => byId.set(m.id, m)));
  SLIP.forEach((item, id) => {
    const m = byId.get(id);
    if (m && !item.custom) {
      SLIP.set(id, { id: m.id, leagueId: m.leagueId, leagueName: m.leagueName, home: m.home, away: m.away, code: m.prediction.bestPick.code, prob: m.prediction.bestPick.prob, custom: false });
    }
  });
  renderSlipBar();
}

function toggleSlipMatch(lid, mid, customPick = null) {
  if (!customPick && SLIP.has(mid)) {
    SLIP.delete(mid);
  } else {
    if (!SLIP.has(mid) && SLIP.size >= 8) { alert("Massimo 8 eventi nella schedina."); return; }
    const l = LEAGUES.find(x => x.id === lid), m = l?.matches.find(x => x.id === mid);
    if (!m) return;
    SLIP.set(mid, {
      id: m.id, leagueId: m.leagueId, leagueName: m.leagueName, home: m.home, away: m.away,
      code: customPick ? customPick.code : m.prediction.bestPick.code,
      prob: customPick ? customPick.prob : m.prediction.bestPick.prob,
      custom: Boolean(customPick)
    });
  }
  renderSlipBar(); renderSchedule();
}

function renderSlipBar() {
  const bar = document.getElementById("slipBar");
  if (!SLIP.size) { bar.classList.add("hidden"); return; }
  let combP = 1; SLIP.forEach(x => { combP *= x.prob; });
  bar.classList.remove("hidden");
  document.getElementById("slipCount").textContent = SLIP.size;
  document.getElementById("slipProb").textContent = `${(combP * 100).toFixed(1)}%`;
  document.getElementById("slipOdd").textContent = `@${fairOdd(combP)}`;
}

function openSlipModal() {
  if (!SLIP.size) return;
  let combP = 1; const items = Array.from(SLIP.values());
  items.forEach(x => { combP *= x.prob; });
  document.getElementById("modalLeague").textContent = `Multipla • ${items.length} eventi`;
  document.getElementById("modalTitle").textContent = "🎟️ La tua Schedina";
  document.getElementById("modalBody").innerHTML = `
    <div class="p-3 rounded-xl bg-slate-950 border border-emerald-500/30 flex justify-between items-center">
      <div><div class="text-[11px] text-slate-400">Probabilità combinata</div><div class="text-xl font-extrabold text-emerald-400">${(combP * 100).toFixed(1)}%</div></div>
      <div class="text-right"><div class="text-[11px] text-slate-400">Quota equa stimata</div><div class="text-xl font-extrabold text-cyan-300">@${fairOdd(combP)}</div></div>
    </div>
    <div class="divide-y divide-slate-800 rounded-xl bg-slate-950 border border-slate-800">
      ${items.map(x => `<div class="px-3 py-2.5 flex items-center justify-between gap-2 text-xs">
        <div class="min-w-0"><div class="text-[10px] text-slate-400">${esc(x.leagueName)}</div><div class="font-bold text-white truncate">${esc(x.home)} vs ${esc(x.away)}</div></div>
        <div class="flex items-center gap-2 shrink-0">
          <span class="px-2 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-bold">${esc(x.code)} (${Math.round(x.prob * 100)}% • @${fairOdd(x.prob)})</span>
          <button data-remove-slip="${esc(x.id)}" class="px-1.5 py-0.5 rounded bg-slate-800 text-rose-300 hover:bg-slate-700">✕</button>
        </div>
      </div>`).join("")}
    </div>`;
  document.querySelectorAll("[data-remove-slip]").forEach(btn => {
    btn.onclick = () => { SLIP.delete(btn.dataset.removeSlip); renderSlipBar(); renderSchedule(); if (SLIP.size) openSlipModal(); else closeModal(); };
  });
  const mod = document.getElementById("detailModal");
  mod.classList.remove("hidden"); mod.classList.add("flex");
}

function confStyle(c) {
  if (c >= 75) return { bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/30", bar: "bg-emerald-500" };
  if (c >= 60) return { bg: "bg-amber-500/15", text: "text-amber-300", border: "border-amber-500/30", bar: "bg-amber-400" };
  return { bg: "bg-slate-700/40", text: "text-slate-300", border: "border-slate-600/50", bar: "bg-slate-400" };
}

function logoHtml(url) {
  if (!url) return "";
  return `<img src="${esc(url)}" alt="" loading="lazy" class="w-3.5 h-3.5 object-contain mr-1.5 shrink-0" onerror="this.style.display='none'" />`;
}

function renderMatchRow(m, showLeague = false) {
  const p = m.prediction, cs = confStyle(p.confidence), isCanceled = m.stateType === "canceled";
  const started = (m.stateType === "in" || m.stateType === "post") && m.hasScore, canEval = started && !m.isExtra;
  const isStar = !isCanceled && p.bestPick.prob >= 0.65 && p.confidence >= 76;
  const pickOk = canEval ? isHit(p.bestPick.code, m.hScore, m.aScore) : null;
  const ouOk = canEval ? isHit(p.ouPick.code, m.hScore, m.aScore) : null;
  const sCls = m.stateType === "in" ? "bg-rose-500/15 border-rose-500/40 text-rose-300"
    : m.stateType === "post" ? "bg-slate-800 border-slate-700 text-white"
    : isCanceled ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
    : "bg-slate-900/80 border-slate-800 text-slate-500";
  const ouCls = p.ouPick.isOver ? "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30" : "bg-indigo-500/15 text-indigo-300 border-indigo-500/30";
  const extraBadge = (started && m.isExtra) ? " ⏱️" : "", inSlip = SLIP.has(m.id);

  return `<div data-lid="${esc(m.leagueId)}" data-mid="${esc(m.id)}" class="match-card px-2.5 py-2.5 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-800/50 active:bg-slate-800 transition-colors ${isStar ? 'bg-emerald-500/5 border-l-2 border-l-emerald-400' : ''} ${isCanceled ? 'opacity-60' : ''}">
    <div class="min-w-0 flex-1">
      <div class="text-[10px] text-slate-400 flex items-center gap-1.5">
        <span>${esc(m.time)}</span>
        ${showLeague ? `<span class="truncate text-slate-500">${m.flag} ${esc(m.leagueName)}</span>` : ""}
        ${isStar ? '<span class="text-[9px] font-bold text-emerald-400">⭐ TOP</span>' : ''}
        ${m.lowData ? '<span class="text-[9px] text-amber-400/90" title="Pochi dati statistici">⚠️</span>' : ''}
      </div>
      <div class="text-xs font-semibold text-white flex items-center min-w-0">${logoHtml(m.homeLogo)}<span class="truncate">${esc(m.home)}</span>${renderFormDots(m.formH)}</div>
      <div class="text-xs font-semibold text-slate-300 flex items-center min-w-0">${logoHtml(m.awayLogo)}<span class="truncate">${esc(m.away)}</span>${renderFormDots(m.formA)}</div>
    </div>
    <div class="w-14 shrink-0 py-1 px-1.5 rounded-xl border text-center ${sCls}">
      <div class="text-[9px] font-bold uppercase ${m.stateType === 'in' ? 'animate-pulse text-rose-400' : 'text-slate-400'}">${esc(m.statusTxt)}</div>
      <div class="text-xs font-extrabold">${esc(m.scoreStr)}</div>
    </div>
    <div class="flex flex-col items-end gap-1 shrink-0">
      <span class="px-2 py-0.5 rounded-md text-[11px] font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">${esc(p.bestPick.code)} ${Math.round(p.bestPick.prob * 100)}% <span class="text-[9px] text-cyan-200/75">@${fairOdd(p.bestPick.prob)}</span>${pickOk === null ? extraBadge : pickOk ? " ✅" : " ❌"}</span>
      <span class="px-1.5 py-0.5 rounded-md text-[9px] font-semibold border ${ouCls}">${esc(p.ouPick.code)} ${Math.round(p.ouPick.prob * 100)}%${ouOk === null ? extraBadge : ouOk ? " ✅" : " ❌"}</span>
    </div>
    <div class="w-11 shrink-0 px-1 py-1 rounded-xl border ${cs.bg} ${cs.border}">
      <div class="text-[10px] font-bold text-center ${cs.text}">${p.confidence}%</div>
      <div class="w-full h-1 bg-slate-900 rounded-full mt-0.5 overflow-hidden"><div class="h-full ${cs.bar}" style="width:${p.confidence}%"></div></div>
    </div>
    <button data-slip-lid="${esc(m.leagueId)}" data-slip-mid="${esc(m.id)}" title="Aggiungi/Rimuovi da schedina"
      class="slip-toggle w-6 h-7 shrink-0 rounded-lg border text-xs font-bold flex items-center justify-center ${inSlip ? 'bg-emerald-500 text-slate-950 border-emerald-400' : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-800'}">${inSlip ? '✓' : '+'}</button>
  </div>`;
}

function renderSchedule() {
  const box = document.getElementById("scheduleContainer"), topBox = document.getElementById("topHighlights");
  const q = st.search.trim().toLowerCase();
  let vis = 0, tops = 0, fin = 0, hit = 0, html = "";
  const allFiltered = [];

  const matchPasses = (l, m) =>
    m.prediction.confidence >= st.minConf &&
    (st.market === "all" || m.prediction.bestPick.cat === st.market) &&
    (!st.onlyPlayable || m.stateType === "pre" || m.stateType === "in") &&
    (!q || `${l.name} ${l.kind} ${m.home} ${m.away}`.toLowerCase().includes(q));

  LEAGUES.forEach(l => {
    const list = l.matches.filter(m => matchPasses(l, m));
    if (!list.length) return;
    list.forEach(m => {
      if (m.stateType !== "canceled") {
        allFiltered.push(m); vis++;
        if (m.prediction.confidence >= 75) tops++;
        if (m.stateType === "post" && m.hasScore && !m.isExtra) {
          fin++; if (isHit(m.prediction.bestPick.code, m.hScore, m.aScore)) hit++;
        }
      }
    });
    if (st.sort === "league") {
      const closed = st.collapsed.has(l.id);
      html += `<div class="glass rounded-2xl overflow-hidden">
        <button data-toggle-league="${esc(l.id)}" class="league-toggle w-full px-3 py-2.5 bg-slate-900 hover:bg-slate-800/80 flex items-center justify-between border-b border-slate-800 transition-colors">
          <div class="flex items-center gap-2 text-left"><span>${l.flag}</span><span class="font-bold text-xs text-white">${esc(l.name)}</span><span class="text-[11px] text-slate-400">${esc(l.kind)} (${list.length})</span></div>
          <span class="text-xs text-slate-400">${closed ? "▸" : "▾"}</span>
        </button>
        <div class="${closed ? "hidden" : "divide-y divide-slate-800/70"}">${list.map(m => renderMatchRow(m, false)).join("")}</div>
      </div>`;
    }
  });

  if (st.sort !== "league" && allFiltered.length) {
    const sorted = allFiltered.slice().sort((a, b) => {
      if (st.sort === "time") return a.startTs - b.startTs;
      if (st.sort === "prob") return b.prediction.bestPick.prob - a.prediction.bestPick.prob;
      return b.prediction.confidence - a.prediction.confidence || b.prediction.rankScore - a.prediction.rankScore;
    });
    html = `<div class="glass rounded-2xl overflow-hidden divide-y divide-slate-800/70">${sorted.map(m => renderMatchRow(m, true)).join("")}</div>`;
  }

  const topList = allFiltered.slice().sort((a, b) => b.prediction.rankScore - a.prediction.rankScore).slice(0, 6);
  if (topList.length) {
    topBox.classList.remove("hidden");
    topBox.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="text-xs font-extrabold text-emerald-300 tracking-wide">🔥 PROBABILITÀ PIÙ ALTE (${st.tab.toUpperCase()})</span>
        <span class="text-[10px] text-slate-400">Top ${topList.length} del giorno</span>
      </div>
      <div class="space-y-1.5">
        ${topList.map(m => {
          const p = m.prediction, probPct = Math.round(p.bestPick.prob * 100);
          const started = (m.stateType === "in" || m.stateType === "post") && m.hasScore;
          const hitM = started ? (m.isExtra ? " ⏱️" : (isHit(p.bestPick.code, m.hScore, m.aScore) ? " ✅" : " ❌")) : "";
          return `<div data-lid="${esc(m.leagueId)}" data-mid="${esc(m.id)}" class="match-card px-2.5 py-2 rounded-xl bg-slate-950/75 border border-emerald-500/25 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-800/70 active:bg-slate-800 transition-colors">
            <div class="min-w-0 flex-1">
              <div class="text-[10px] text-slate-400">${m.flag} ${esc(m.leagueName)} • ${esc(m.time)} ${started ? `• <strong class="text-white">${esc(m.scoreStr)}</strong>` : ""}</div>
              <div class="text-xs font-bold text-white truncate">${esc(m.home)} vs ${esc(m.away)}</div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <span class="px-2 py-1 rounded-lg text-[11px] font-extrabold bg-emerald-500 text-slate-950">${esc(p.bestPick.code)} • ${probPct}% (@${fairOdd(p.bestPick.prob)})${hitM}</span>
              <span class="text-[10px] font-bold text-emerald-300 w-9 text-right">Att.${p.confidence}%</span>
            </div>
          </div>`;
        }).join("")}
      </div>`;
  } else {
    topBox.classList.add("hidden");
  }

  box.innerHTML = html || `<div class="glass rounded-2xl p-6 text-center text-xs text-slate-400 space-y-1"><div>Nessuna partita trovata.</div>${lastDiag ? `<div class="text-[11px] text-slate-500">${esc(lastDiag)}</div>` : ""}</div>`;
  document.getElementById("visibleCount").textContent = vis;
  document.getElementById("topPickCount").textContent = tops;
  document.getElementById("hitCount").textContent = fin ? `${hit}/${fin} (${Math.round(hit / fin * 100)}%)` : "-";
}

function openModal(lid, mid) {
  const l = LEAGUES.find(x => x.id === lid), m = l?.matches.find(x => x.id === mid);
  if (!m) return;
  document.getElementById("modalLeague").textContent = `${l.flag} ${l.name} • ${m.time}`;
  document.getElementById("modalTitle").textContent = `${m.home} vs ${m.away}`;
  renderModalStructure(m);
  const mod = document.getElementById("detailModal");
  mod.classList.remove("hidden"); mod.classList.add("flex");
  loadModalSummary(m);
}

async function loadModalSummary(m) {
  const box = document.getElementById("modalSummaryExtra");
  if (!box) return;
  box.innerHTML = `<div class="text-[10px] text-slate-500">🔎 Carico H2H e statistiche ESPN...</div>`;
  try {
    const sum = await ESPNProvider.fetchSummary(m.slug, m.id);
    if (!sum || !document.getElementById("modalSummaryExtra")) return;
    const chunks = [];

    const teamsBox = sum.boxscore?.teams || [];
    if (teamsBox.length === 2 && (teamsBox[0].statistics?.length || teamsBox[1].statistics?.length)) {
      const getStat = (t, names) => {
        const s = (t.statistics || []).find(x => names.includes(x.name));
        return s ? s.displayValue : "-";
      };
      const hT = teamsBox.find(t => t.homeAway === "home") || teamsBox[0];
      const aT = teamsBox.find(t => t.homeAway === "away") || teamsBox[1];
      chunks.push(`<div class="space-y-1">
        <div class="text-[10px] font-bold text-slate-300">📈 Statistiche Match ESPN</div>
        <div class="grid grid-cols-3 gap-1 text-center text-[10px] bg-slate-900/70 rounded-lg p-1.5">
          <div><strong class="text-white">${esc(getStat(hT, ["shotsOnTarget", "onTargetScoringAttempts"]))}</strong><div class="text-slate-500">Tiri Porta</div><strong class="text-white">${esc(getStat(aT, ["shotsOnTarget", "onTargetScoringAttempts"]))}</strong></div>
          <div><strong class="text-white">${esc(getStat(hT, ["totalShots", "shotsSummary"]))}</strong><div class="text-slate-500">Tiri Tot.</div><strong class="text-white">${esc(getStat(aT, ["totalShots", "shotsSummary"]))}</strong></div>
          <div><strong class="text-white">${esc(getStat(hT, ["possessionPct"]))}%</strong><div class="text-slate-500">Possesso</div><strong class="text-white">${esc(getStat(aT, ["possessionPct"]))}%</strong></div>
        </div>
      </div>`);
    }

    const h2hGames = (sum.headToHeadGames || [])[0]?.events || [];
    if (h2hGames.length) {
      chunks.push(`<div class="space-y-1">
        <div class="text-[10px] font-bold text-slate-300">⚔️ Precedenti Reali ESPN</div>
        ${h2hGames.slice(0, 5).map(ev => `<div class="flex justify-between text-[10px] text-slate-300">
          <span class="text-slate-500">${esc((ev.gameDate || "").slice(0, 10))} • ${esc(ev.leagueAbbreviation || "")}</span>
          <span class="font-semibold text-white">${esc(ev.homeTeamName || "")} ${esc(ev.homeTeamScore ?? "-")} - ${esc(ev.awayTeamScore ?? "-")} ${esc(ev.awayTeamName || "")}</span>
        </div>`).join("")}
      </div>`);
    }

    box.innerHTML = chunks.length ? chunks.join(`<div class="border-t border-slate-800 my-1.5"></div>`) : `<div class="text-[10px] text-slate-500">Nessun dato H2H/statistiche live aggiuntive su ESPN per questo evento.</div>`;
  } catch {
    if (document.getElementById("modalSummaryExtra")) box.innerHTML = "";
  }
}

function renderModalStructure(m) {
  let activePick = { code: m.prediction.bestPick.code, prob: m.prediction.bestPick.prob };

  document.getElementById("modalBody").innerHTML = `
    <div id="modalDynamic" class="space-y-3"></div>
    <div id="modalSummaryExtra" class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2"></div>

    <div class="p-3 rounded-xl bg-cyan-950/25 border border-cyan-500/30 space-y-2 text-xs">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="font-bold text-cyan-300">💰 Value &amp; Registra: <strong id="selectedMarketBadge" class="text-white"></strong></span>
        <div class="flex items-center gap-1.5">
          <input id="bookOddInput" type="number" min="1.01" max="50" step="0.01" placeholder="Quota (es. 1.75)"
            class="w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-right" />
          <input id="betStakeInput" type="number" min="0.1" max="100" step="0.5" value="1" title="Unità/Euro puntati"
            class="w-16 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white text-right" />
        </div>
      </div>
      <div id="evResult" class="text-[11px] text-slate-400">Tocca qualsiasi quota sopra per cambiare mercato, calcolare EV% o registrare la giocata.</div>
      <div class="flex gap-2 pt-1">
        <button id="addSlipCustomBtn" class="flex-1 py-1.5 rounded-lg bg-slate-800 text-cyan-300 border border-cyan-500/30 font-bold text-[11px]">🎟️ Metti in Schedina</button>
        <button id="addBetBtn" class="flex-1 py-1.5 rounded-lg bg-amber-500 text-slate-950 font-bold text-[11px]">💼 Registra nel Diario</button>
      </div>
    </div>

    <div class="p-3 rounded-xl bg-emerald-950/25 border border-emerald-500/30 space-y-2 text-xs">
      <div class="flex items-center justify-between">
        <span class="font-bold text-emerald-400">Simula Assenze / Turnover</span>
        <button id="simResetBtn" class="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">Reset 100%</button>
      </div>
      <div><div class="flex justify-between"><span>${esc(m.home)}</span><span id="simHLabel">100%</span></div><input id="simH" type="range" min="70" max="100" value="100" class="w-full accent-emerald-500"/></div>
      <div><div class="flex justify-between"><span>${esc(m.away)}</span><span id="simALabel">100%</span></div><input id="simA" type="range" min="70" max="100" value="100" class="w-full accent-emerald-500"/></div>
    </div>`;

  const simH = document.getElementById("simH"), simA = document.getElementById("simA");
  const bookInput = document.getElementById("bookOddInput"), stakeInput = document.getElementById("betStakeInput");

  const updateEV = () => {
    document.getElementById("selectedMarketBadge").textContent = `${activePick.code} (${Math.round(activePick.prob * 100)}%)`;
    const odd = Number(bookInput.value), evEl = document.getElementById("evResult");
    if (!Number.isFinite(odd) || odd <= 1.0) {
      evEl.innerHTML = `<span class="text-slate-400">Quota equa: <strong class="text-white">@${fairOdd(activePick.prob)}</strong>. Tocca un mercato sopra o inserisci quota book &gt; 1.00.</span>`;
      return;
    }
    const ev = (odd * activePick.prob - 1) * 100, kelly = clamp(((odd * activePick.prob - 1) / (odd - 1)) * 0.25 * 100, 0, 10);
    evEl.innerHTML = ev > 0
      ? `<span class="text-emerald-400 font-bold">✅ VALUE BET: +${ev.toFixed(1)}% EV</span> • Kelly 1/4: <strong class="text-white">${kelly.toFixed(1)}% bankroll</strong>`
      : `<span class="text-rose-400 font-semibold">❌ NO VALUE: ${ev.toFixed(1)}% EV</span> (quota equa @${fairOdd(activePick.prob)})`;
  };

  const refreshSim = () => {
    document.getElementById("simHLabel").textContent = `${simH.value}%`;
    document.getElementById("simALabel").textContent = `${simA.value}%`;
    const p = updateModalDynamic(m, { hL: simH.value / 100, aL: simA.value / 100 }, activePick.code);
    const updatedMap = buildPickMap(p);
    if (updatedMap[activePick.code] !== undefined) activePick.prob = updatedMap[activePick.code];
    else activePick = { code: p.bestPick.code, prob: p.bestPick.prob };
    updateEV();
  };

  document.getElementById("modalDynamic").addEventListener("click", e => {
    const btn = e.target.closest("[data-pick-code]");
    if (!btn) return;
    activePick = { code: btn.dataset.pickCode, prob: Number(btn.dataset.pickProb) };
    refreshSim();
  });

  document.getElementById("addSlipCustomBtn").onclick = () => {
    toggleSlipMatch(m.leagueId, m.id, activePick);
    document.getElementById("addSlipCustomBtn").textContent = "✅ Aggiunta alla Schedina!";
    setTimeout(() => { if (document.getElementById("addSlipCustomBtn")) document.getElementById("addSlipCustomBtn").textContent = "🎟️ Metti in Schedina"; }, 1200);
  };

  document.getElementById("addBetBtn").onclick = async () => {
    const odd = Number(bookInput.value) || Number(fairOdd(activePick.prob));
    const stake = Math.max(0.1, Number(stakeInput.value) || 1);
    let status = "pending";
    if (m.stateType === "post" && m.hasScore && !m.isExtra) {
      status = isHit(activePick.code, m.hScore, m.aScore) ? "won" : "lost";
    }
    BET_LOG.push({
      id: `${m.id}_${Date.now()}`, matchId: m.id,
      date: new Date().toISOString().slice(0, 10),
      league: m.leagueName, match: `${m.home} vs ${m.away}`,
      code: activePick.code, odd, stake, status
    });
    await saveBetLog();
    document.getElementById("addBetBtn").textContent = "✅ Salvata nel Diario!";
    setTimeout(() => { if (document.getElementById("addBetBtn")) document.getElementById("addBetBtn").textContent = "💼 Registra nel Diario"; }, 1200);
  };

  simH.oninput = refreshSim; simA.oninput = refreshSim; bookInput.oninput = updateEV;
  document.getElementById("simResetBtn").onclick = () => { simH.value = 100; simA.value = 100; refreshSim(); };
  refreshSim();
}

function buildPickMap(p) {
  const map = { "1": p.probs.p1, "X": p.probs.px, "2": p.probs.p2, "Over 2.5": p.probs.pO, "Under 2.5": p.probs.pU, "Gol": p.probs.pG, "No Gol": p.probs.pNG };
  map["1X"] = p.probs.p1 + p.probs.px;
  map["X2"] = p.probs.px + p.probs.p2;
  (p.combos || []).forEach(c => { map[c.code] = c.prob; });
  return map;
}

function updateModalDynamic(m, ov = {}, selectedCode = null) {
  const p = calcPred(m, ov), cs = confStyle(p.confidence);
  const overPct = Math.round(p.probs.pO * 100), underPct = 100 - overPct;
  const started = (m.stateType === "in" || m.stateType === "post") && m.hasScore, canEval = started && !m.isExtra;
  const pickOk = canEval ? isHit(p.bestPick.code, m.hScore, m.aScore) : null;
  const th = getTeamHist(), hHist = th[m.homeId], aHist = th[m.awayId];
  const h2h = (hHist?.m || []).filter(x => (x.oid && m.awayId && x.oid === m.awayId) || (!x.oid && x.t.toLowerCase().includes(m.away.toLowerCase()))).slice(-4).reverse();
  const evalBadge = m.isExtra ? `<span class="text-xs font-bold text-amber-300">⏱️ Escluso (90' non disp.)</span>` : `<span class="text-xs font-bold">${pickOk ? '✅ Preso' : '❌ Errato'}</span>`;
  const sel = selectedCode || p.bestPick.code;

  const pillBtn = (k, v) => {
    const active = sel === k;
    return `<button data-pick-code="${esc(k)}" data-pick-prob="${v}" class="p-2 rounded-lg border text-center transition-colors ${active ? 'bg-cyan-500/20 border-cyan-400' : 'bg-slate-950 border-slate-800 hover:border-slate-600'}">
      <div class="text-[10px] ${active ? 'text-cyan-300 font-bold' : 'text-slate-400'}">${esc(k)}</div>
      <div class="font-bold text-white text-xs">${(v * 100).toFixed(0)}%</div>
      <div class="text-[9px] text-slate-500">@${fairOdd(v)}</div>
    </button>`;
  };

  document.getElementById("modalDynamic").innerHTML = `
    ${started ? `<div class="p-3 rounded-xl bg-slate-950 border ${m.isExtra ? 'border-amber-500/40' : (pickOk ? 'border-emerald-500/40' : 'border-rose-500/40')} flex justify-between items-center gap-2">
      <div><div class="text-[10px] text-slate-400">Risultato (${esc(m.statusTxt)}${m.isExtra ? " • mercati validi sui 90'" : ""})</div><div class="text-base font-extrabold text-white">${esc(m.home)} ${esc(m.scoreStr)} ${esc(m.away)}</div></div>
      ${evalBadge}
    </div>` : ""}
    <div class="grid grid-cols-2 gap-2.5">
      <div class="p-3 rounded-xl bg-slate-950 border border-slate-800">
        <div class="text-[11px] text-slate-400">Pronostico Top</div>
        <div class="text-xl font-extrabold text-cyan-400">${esc(p.bestPick.code)} <span class="text-sm text-cyan-200">@${fairOdd(p.bestPick.prob)}</span></div>
        <div class="text-[11px] text-slate-300">${esc(p.bestPick.label)} (${(p.bestPick.prob * 100).toFixed(0)}%)</div>
      </div>
      <div class="p-3 rounded-xl border ${cs.bg} ${cs.border}">
        <div class="text-[11px] text-slate-300">Attendibilità</div>
        <div class="text-xl font-extrabold ${cs.text}">${p.confidence}%</div>
        <div class="text-[11px] text-slate-300">Gol attesi: ${p.lamH} - ${p.lamA}</div>
      </div>
    </div>
    <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5">
      <div class="flex justify-between text-[11px]"><span class="font-bold text-fuchsia-300">Over 2.5 (${overPct}%)</span><span class="px-2 py-0.5 rounded bg-slate-800 text-white font-semibold">${esc(p.ouPick.code)} @${fairOdd(p.ouPick.prob)}</span><span class="font-bold text-indigo-300">Under 2.5 (${underPct}%)</span></div>
      <div class="w-full h-2 rounded-full overflow-hidden flex bg-slate-800"><div class="bg-fuchsia-500" style="width:${overPct}%"></div><div class="bg-indigo-500" style="width:${underPct}%"></div></div>
    </div>
    <div class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2 text-[11px]">
      <div class="flex justify-between items-center gap-2"><span class="text-slate-400 truncate">Forma ${esc(m.home)}</span><div class="flex gap-1 shrink-0">${renderFormBadges(m.formH)}</div></div>
      <div class="flex justify-between items-center gap-2"><span class="text-slate-400 truncate">Forma ${esc(m.away)}</span><div class="flex gap-1 shrink-0">${renderFormBadges(m.formA)}</div></div>
      <div class="pt-1.5 border-t border-slate-800/80 flex justify-between items-center"><span class="text-slate-400">Risultati esatti top:</span><div class="flex gap-1.5">${p.topScores.map(s => `<span class="px-2 py-0.5 rounded bg-slate-800 text-white font-bold">${esc(s.score)} <span class="text-slate-400 font-normal">${Math.round(s.prob * 100)}%</span></span>`).join("")}</div></div>
    </div>
    <div class="px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-[10px] text-slate-400 flex flex-wrap justify-between gap-1">
      <span>Casa: <strong class="text-slate-200">${esc(m.statSourceH)}</strong>${m.stats.eloH ? ` (ELO ${m.stats.eloH})` : ""}</span>
      <span>Ospite: <strong class="text-slate-200">${esc(m.statSourceA)}</strong>${m.stats.eloA ? ` (ELO ${m.stats.eloA})` : ""}</span>
    </div>
    ${h2h.length ? `<div class="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1.5"><div class="text-[11px] font-bold text-slate-300">⚔️ Precedenti (Storico 9M)</div>${h2h.map(x => `<div class="flex justify-between text-[11px] text-slate-300"><span class="text-slate-500">${esc(x.d)} • ${esc(x.c)}</span><span class="font-bold text-white">${esc(x.t)} (${esc(x.s)})</span></div>`).join("")}</div>` : ""}
    <div class="space-y-1.5">
      <div class="text-[10px] font-bold text-slate-400">Mercati Principali (tocca per selezionare)</div>
      <div class="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
        ${[["1", p.probs.p1], ["X", p.probs.px], ["2", p.probs.p2], ["1X", p.probs.p1 + p.probs.px], ["X2", p.probs.px + p.probs.p2], ["Over 2.5", p.probs.pO], ["Under 2.5", p.probs.pU], ["Gol", p.probs.pG], ["No Gol", p.probs.pNG]].map(([k, v]) => pillBtn(k, v)).join("")}
      </div>
    </div>
    <div class="space-y-1.5">
      <div class="text-[10px] font-bold text-emerald-400">⚡ Combo &amp; Multigol (tocca per selezionare)</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        ${p.combos.map(c => pillBtn(c.code, c.prob)).join("")}
      </div>
    </div>`;
  return p;
}

function closeModal() {
  const mod = document.getElementById("detailModal");
  mod.classList.add("hidden"); mod.classList.remove("flex");
}

document.getElementById("viewPalinsesto").addEventListener("click", e => {
  const slipBtn = e.target.closest(".slip-toggle");
  if (slipBtn) { toggleSlipMatch(slipBtn.dataset.slipLid, slipBtn.dataset.slipMid); return; }
  const toggleBtn = e.target.closest(".league-toggle");
  if (toggleBtn) {
    const lid = toggleBtn.dataset.toggleLeague;
    st.collapsed.has(lid) ? st.collapsed.delete(lid) : st.collapsed.add(lid);
    renderSchedule(); return;
  }
  const card = e.target.closest(".match-card");
  if (card) openModal(card.dataset.lid, card.dataset.mid);
});

document.getElementById("teamLeaderboard").addEventListener("click", e => {
  const card = e.target.closest(".team-card");
  if (card) openTeamModal(card.dataset.tid);
});

document.getElementById("betLogList").addEventListener("click", async e => {
  const setBtn = e.target.closest("[data-bet-set]");
  if (setBtn) {
    const [id, status] = setBtn.dataset.betSet.split(":");
    const b = BET_LOG.find(x => x.id === id);
    if (b) { b.status = status; await saveBetLog(); renderDiario(); }
    return;
  }
  const delBtn = e.target.closest("[data-bet-del]");
  if (delBtn) {
    BET_LOG = BET_LOG.filter(x => x.id !== delBtn.dataset.betDel);
    await saveBetLog(); renderDiario();
  }
});

document.getElementById("btnAutoSettle").onclick = async () => {
  const byId = new Map();
  LEAGUES.forEach(l => l.matches.forEach(m => byId.set(m.id, m)));
  let updated = 0;
  BET_LOG.forEach(b => {
    if (b.status !== "pending") return;
    const m = byId.get(b.matchId);
    if (m && m.stateType === "post" && m.hasScore && !m.isExtra) {
      b.status = isHit(b.code, m.hScore, m.aScore) ? "won" : "lost";
      updated++;
    }
  });
  if (updated) { await saveBetLog(); renderDiario(); }
  else alert("Nessuna giocata in attesa trovata tra le partite terminate attualmente caricate.");
};

document.getElementById("btnClearDiario").onclick = async () => {
  if (!BET_LOG.length || !confirm("Svuotare tutto il diario delle giocate?")) return;
  BET_LOG = []; await saveBetLog(); renderDiario();
};

document.querySelectorAll(".tab-btn").forEach(b => b.onclick = () => {
  document.querySelectorAll(".tab-btn").forEach(x => {
    x.className = x.dataset.tab === "storico" ? "tab-btn px-2 py-1 text-xs font-semibold rounded-lg text-cyan-300"
      : x.dataset.tab === "diario" ? "tab-btn px-2 py-1 text-xs font-semibold rounded-lg text-amber-300"
      : "tab-btn px-2 py-1 text-xs font-semibold rounded-lg text-slate-300";
  });
  b.className = "tab-btn px-2 py-1 text-xs font-semibold rounded-lg bg-emerald-500 text-slate-950";
  st.tab = b.dataset.tab;
  document.getElementById("viewPalinsesto").classList.toggle("hidden", st.tab === "storico" || st.tab === "diario");
  document.getElementById("viewStorico").classList.toggle("hidden", st.tab !== "storico");
  document.getElementById("viewDiario").classList.toggle("hidden", st.tab !== "diario");
  if (st.tab === "storico") renderTeamLeaderboard();
  else if (st.tab === "diario") renderDiario();
  else loadDay(dayOffset());
});

document.getElementById("importHistInput").onchange = async e => {
  const file = e.target.files?.[0];
  if (!file || isScanning) return;
  try {
    const clean = sanitizeTeamHist(JSON.parse(await file.text()));
    if (!Object.keys(clean).length) throw new Error("Empty or invalid");
    await saveTeamHist(clean);
    recalcAllPredictions(); renderTeamLeaderboard(); renderSchedule();
    document.getElementById("histScanWrap").classList.remove("hidden");
    document.getElementById("histScanStatus").textContent = `✅ Importate ${Object.keys(clean).length} squadre valide dal backup!`;
  } catch { alert("File JSON non valido o privo di dati squadra validi."); }
  finally { e.target.value = ""; }
};

document.getElementById("autoCalToggle").onchange = e => { st.autoCal = e.target.checked; recalcAllPredictions(); syncSlipFromLeagues(); renderSchedule(); };
document.getElementById("onlyPlayableToggle").onchange = e => { st.onlyPlayable = e.target.checked; renderSchedule(); };
document.getElementById("sortFilter").onchange = e => {
  st.sort = e.target.value;
  document.getElementById("toggleAllBtn").classList.toggle("hidden", st.sort !== "league");
  renderSchedule();
};
document.getElementById("teamHistSearch").oninput = debounce(renderTeamLeaderboard, 150);
document.getElementById("minMatchesFilter").onchange = renderTeamLeaderboard;
document.getElementById("refreshBtn").onclick = () => loadDay(dayOffset(), true);
document.getElementById("searchInput").oninput = debounce(e => { st.search = e.target.value; renderSchedule(); }, 150);
document.getElementById("minConfSlider").oninput = e => { st.minConf = Number(e.target.value); document.getElementById("minConfLabel").textContent = st.minConf + "%"; renderSchedule(); };
document.getElementById("marketFilter").onchange = e => { st.market = e.target.value; renderSchedule(); };
document.getElementById("toggleAllBtn").onclick = e => {
  st.allCollapsed = !st.allCollapsed;
  st.collapsed = st.allCollapsed ? new Set(LEAGUES.map(l => l.id)) : new Set();
  e.target.textContent = st.allCollapsed ? "Espandi" : "Comprimi";
  renderSchedule();
};
document.getElementById("slipOpenBtn").onclick = openSlipModal;
document.getElementById("slipClearBtn").onclick = () => { SLIP.clear(); renderSlipBar(); renderSchedule(); };
document.getElementById("closeModalBtn").onclick = closeModal;
document.getElementById("detailModal").onclick = e => { if (e.target.id === "detailModal") closeModal(); };
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

function shouldAutoRefreshToday() {
  if (!LEAGUES.length) return true;
  const now = Date.now();
  return LEAGUES.some(l => l.matches.some(m =>
    m.stateType === "in" || (m.stateType === "pre" && m.startTs && (m.startTs - now) <= 5 * 60 * 1000 && (now - m.startTs) <= 130 * 60 * 1000)
  ));
}

(async () => {
  const storagePromise = initStorage().then(() => {
    if (LEAGUES.length) { recalcAllPredictions(); renderSchedule(); }
  });
  await Promise.race([storagePromise, new Promise(res => setTimeout(res, 1500))]);
  await loadDay(0);
  setInterval(() => {
    const modalOpen = !document.getElementById("detailModal").classList.contains("hidden");
    if (st.tab === "oggi" && !modalOpen && !document.hidden && shouldAutoRefreshToday()) loadDay(0, true);
  }, 60000);
})();