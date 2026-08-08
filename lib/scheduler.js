// Pure, framework-free. Takes the current DB state and returns a draft round
// (not persisted). Nothing here mutates history -- that only happens on publish
// (see lib/db.js: publishRound).
//
// Mixed doubles are allowed: a match can be women's doubles, men's doubles, mixed
// (each team is one woman + one man), or -- only when supply doesn't divide cleanly
// -- an "edge" composition (an uneven 3-1 gender split, or a same-gender-pair-vs-
// same-gender-pair fallback). Edge compositions are always available as a last
// resort so a court doesn't go empty just because the remaining players don't form
// a clean group, but they're penalized in the cost function so the search only
// reaches for them when nothing cleaner works.

const PENALTY = {
  REPEAT_PARTNER: 1_000_000,
  FUTURE_CONFLICT: 1_000_000, // handled as a hard filter, kept here for reference
  EDGE_SPLIT: 50_000, // choosing a same-gender-pair-vs-same-gender-pair split over proper mixed pairs
  REPEAT_OPPONENT: 2_000, // per prior meeting
  BACK_TO_BACK: 500, // played in the immediately preceding round
  WAIT_BONUS: -300, // per round waited since last played (reduces cost -> raises priority)
  LATE_ZERO_GAMES_BONUS: -500,
  NEEDS_COVERAGE_BONUS: -3_000, // hasn't had this type of match yet -- outranks ordinary pacing
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function waitRounds(player, roundNumber) {
  if (player.last_played_round == null) return roundNumber;
  return Math.max(0, roundNumber - 1 - player.last_played_round);
}

/** How many of a player's past partnerships were with their own gender vs the
 * opposite gender -- derived from partner_ids + gender lookups, not a separate
 * counter, so nothing new needs to be persisted. Used both to decide who still
 * needs a first experience of a type, and for the Dashboard's live audit. */
export function typeCoverage(player, byId) {
  let own = 0, mixed = 0;
  player.partner_ids.forEach((pid) => {
    const partner = byId[pid];
    if (!partner) return;
    if (partner.gender === player.gender) own++; else mixed++;
  });
  return { own, mixed };
}

function priorityScore(player, roundNumber, needsCoverage) {
  let score = player.games_played * 1000;
  score += PENALTY.WAIT_BONUS * waitRounds(player, roundNumber);
  if (player.games_played === 0) score += PENALTY.LATE_ZERO_GAMES_BONUS;
  if (needsCoverage) score += PENALTY.NEEDS_COVERAGE_BONUS;
  return score;
}

/** Cost of the 3 possible 2v2 splits of a fixed foursome. Gender-agnostic except for
 * the optional edge-split penalty, so the same function handles women's, men's,
 * mixed, and edge foursomes alike -- only mixed foursomes (2 women + 2 men) pass
 * penalizeSameGenderSplit=true, since that's the only composition where one of the
 * 3 splits produces a same-gender-pair-vs-same-gender-pair fallback instead of
 * proper mixed pairs. */
function pairingCost(group, byId, roundNumber, penalizeSameGenderSplit) {
  const [a, b, c, d] = group;
  const options = [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
  let best = null;
  for (const [t1, t2] of options) {
    let cost = 0;
    const p1 = byId[t1[0]], p3 = byId[t2[0]];
    if (p1.partner_ids.includes(t1[1])) cost += PENALTY.REPEAT_PARTNER;
    if (p3.partner_ids.includes(t2[1])) cost += PENALTY.REPEAT_PARTNER;
    for (const x of t1) {
      for (const y of t2) {
        cost += (byId[x].opponent_counts?.[y] || 0) * PENALTY.REPEAT_OPPONENT;
      }
    }
    for (const pid of group) {
      if (byId[pid].last_played_round === roundNumber - 1) cost += PENALTY.BACK_TO_BACK;
    }
    if (penalizeSameGenderSplit) {
      const teamAMixed = byId[t1[0]].gender !== byId[t1[1]].gender;
      const teamBMixed = byId[t2[0]].gender !== byId[t2[1]].gender;
      if (!teamAMixed && !teamBMixed) cost += PENALTY.EDGE_SPLIT;
    }
    if (best === null || cost < best.cost) best = { cost, pairing: [t1, t2] };
  }
  return best;
}

/** Combines checked-in players (minus any hard-reserved ids), applying the rest-gap
 * relaxation: excluded by default, but relaxed back to the full checked-in pool
 * (with a warning) if strict exclusion would leave fewer than 4 players available
 * at all. Mixed doubles collapses what used to be two separate per-gender pools
 * (and their separate relaxation thresholds) into one -- a player resting is a
 * property of the player, not of a division. */
export function eligiblePlayers(allPlayers, futureReservedIds = new Set(), justPlayedIds = new Set()) {
  const checkedIn = allPlayers.filter((p) => p.attendance_status === "checked_in" && !futureReservedIds.has(p.id));
  const warnings = [];
  let pool = checkedIn.filter((p) => !justPlayedIds.has(p.id));
  if (pool.length < 4 && checkedIn.length >= 4) {
    pool = checkedIn;
    warnings.push("Not enough rested players -- some players are back-to-back from the previous round this time.");
  }
  return { pool, warnings };
}

/** Greedily decides how many of numCourts go to women's, men's, and mixed doubles
 * this round, plus at most one "edge" court absorbing a leftover uneven group that
 * doesn't cleanly fit any of the three. Each slot goes to whichever feasible type
 * currently has the most players still missing their first experience of it; once
 * everyone's covered, pacing (lower average games played in that type's relevant
 * pool) breaks the tie. Mutates nothing -- women/men here are running counts of
 * how much of the eligible pool is still unclaimed by an earlier slot this round. */
function planCourts(eligibleWomen, eligibleMen, numCourts, byId) {
  let remW = [...eligibleWomen], remM = [...eligibleMen];
  const plan = [];
  const avg = (arr) => (arr.length ? arr.reduce((s, p) => s + p.games_played, 0) / arr.length : 0);
  const scoreType = (type) => {
    if (type === "women") return remW.filter((p) => typeCoverage(p, byId).own === 0).length * 1000 - avg(remW);
    if (type === "men") return remM.filter((p) => typeCoverage(p, byId).own === 0).length * 1000 - avg(remM);
    return (
      remW.filter((p) => typeCoverage(p, byId).mixed === 0).length +
      remM.filter((p) => typeCoverage(p, byId).mixed === 0).length
    ) * 1000 - (avg(remW) + avg(remM)) / 2;
  };
  for (let i = 0; i < numCourts; i++) {
    const candidates = [];
    if (remW.length >= 4) candidates.push("women");
    if (remM.length >= 4) candidates.push("men");
    if (remW.length >= 2 && remM.length >= 2) candidates.push("mixed");
    if (!candidates.length) break;
    const type = candidates.sort((a, b) => scoreType(b) - scoreType(a))[0];
    plan.push(type);
    if (type === "women") remW = remW.slice(4);
    else if (type === "men") remM = remM.slice(4);
    else { remW = remW.slice(2); remM = remM.slice(2); }
  }
  if (plan.length < numCourts && remW.length + remM.length === 4 && remW.length > 0 && remM.length > 0) {
    plan.push("edge");
  }
  return { plan, leftoverWomen: remW, leftoverMen: remM };
}

/** Ranks a pool by priority (lowest score plays first), shuffling ties for fairness,
 * favoring anyone who still needs their first experience of `coverageKey`
 * ("own" or "mixed"). Returns the top `count` -- the players actually selected to
 * fill this round's courts of one type. */
function selectTop(pool, count, byId, roundNumber, coverageKey) {
  const ranked = shuffle(pool).sort(
    (a, b) => priorityScore(a, roundNumber, typeCoverage(a, byId)[coverageKey] === 0) - priorityScore(b, roundNumber, typeCoverage(b, byId)[coverageKey] === 0)
  );
  return ranked.slice(0, count);
}

/** Search over random groupings of a same-gender (or edge) selection into foursomes,
 * picking whichever grouping+split combo has the lowest total cost. Mirrors the
 * original single-division algorithm exactly -- gender never entered its math. */
function bestGrouping(selected, byId, roundNumber, penalizeSameGenderSplit) {
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const shuf = shuffle(selected);
    const groups = [];
    for (let i = 0; i < shuf.length; i += 4) groups.push(shuf.slice(i, i + 4));
    let totalCost = 0;
    const groupResults = groups.map((g) => {
      const r = pairingCost(g, byId, roundNumber, penalizeSameGenderSplit);
      totalCost += r.cost;
      return { pairing: r.pairing };
    });
    if (best === null || totalCost < best.cost) best = { cost: totalCost, groups: groupResults };
    if (best.cost === 0) break;
  }
  return best.groups.map((g) => ({ team_a: g.pairing[0], team_b: g.pairing[1], score_a: null, score_b: null, status: "scheduled" }));
}

/** Search over random pairings of a mixed selection (equal-sized women/men lists)
 * into 2-women-2-men foursomes, same random-attempt approach as bestGrouping. */
function bestMixedGrouping(selectedWomen, selectedMen, byId, roundNumber) {
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const shufW = shuffle(selectedWomen), shufM = shuffle(selectedMen);
    const groups = [];
    for (let i = 0; i < shufW.length; i += 2) groups.push([...shufW.slice(i, i + 2), ...shufM.slice(i, i + 2)]);
    let totalCost = 0;
    const groupResults = groups.map((g) => {
      const r = pairingCost(g, byId, roundNumber, true);
      totalCost += r.cost;
      return { pairing: r.pairing };
    });
    if (best === null || totalCost < best.cost) best = { cost: totalCost, groups: groupResults };
    if (best.cost === 0) break;
  }
  return best.groups.map((g) => ({ team_a: g.pairing[0], team_b: g.pairing[1], score_a: null, score_b: null, status: "scheduled" }));
}

/**
 * @param {Array} allPlayers - every player row for the event
 * @param {number} numCourts
 * @param {number} roundNumber
 * @param {Set<string>} futureReservedIds - hard exclusion, see below
 * @param {Set<string>} justPlayedIds - hard-excluded by default (mandatory rest gap);
 *   relaxed if it would leave fewer than 4 eligible players overall.
 */
export function generateDraft(allPlayers, numCourts, roundNumber, futureReservedIds = new Set(), justPlayedIds = new Set()) {
  const byId = Object.fromEntries(allPlayers.map((p) => [p.id, p]));
  const { pool, warnings } = eligiblePlayers(allPlayers, futureReservedIds, justPlayedIds);

  if (pool.length < 4) {
    return { error: `Not enough eligible players (${pool.length}) -- need at least 4.` };
  }

  const eligibleWomen = pool.filter((p) => p.gender === "female");
  const eligibleMen = pool.filter((p) => p.gender === "male");
  const { plan, leftoverWomen, leftoverMen } = planCourts(eligibleWomen, eligibleMen, numCourts, byId);

  if (plan.length === 0) {
    return { error: "Not enough eligible players of either gender to fill a court this round." };
  }

  const claimedWomen = new Set(), claimedMen = new Set();
  const matches = [];
  let courtNum = 1;

  const womenCourts = plan.filter((t) => t === "women").length;
  if (womenCourts) {
    const selected = selectTop(eligibleWomen.filter((p) => !claimedWomen.has(p.id)), womenCourts * 4, byId, roundNumber, "own");
    selected.forEach((p) => claimedWomen.add(p.id));
    bestGrouping(selected.map((p) => p.id), byId, roundNumber, false).forEach((m) => matches.push({ ...m, division: "women", court: courtNum++ }));
  }
  const menCourts = plan.filter((t) => t === "men").length;
  if (menCourts) {
    const selected = selectTop(eligibleMen.filter((p) => !claimedMen.has(p.id)), menCourts * 4, byId, roundNumber, "own");
    selected.forEach((p) => claimedMen.add(p.id));
    bestGrouping(selected.map((p) => p.id), byId, roundNumber, false).forEach((m) => matches.push({ ...m, division: "men", court: courtNum++ }));
  }
  const mixedCourts = plan.filter((t) => t === "mixed").length;
  if (mixedCourts) {
    const selectedW = selectTop(eligibleWomen.filter((p) => !claimedWomen.has(p.id)), mixedCourts * 2, byId, roundNumber, "mixed");
    const selectedM = selectTop(eligibleMen.filter((p) => !claimedMen.has(p.id)), mixedCourts * 2, byId, roundNumber, "mixed");
    selectedW.forEach((p) => claimedWomen.add(p.id));
    selectedM.forEach((p) => claimedMen.add(p.id));
    bestMixedGrouping(selectedW.map((p) => p.id), selectedM.map((p) => p.id), byId, roundNumber)
      .forEach((m) => matches.push({ ...m, division: "mixed", court: courtNum++ }));
  }
  if (plan.includes("edge")) {
    const group = [...leftoverWomen, ...leftoverMen].map((p) => p.id);
    const r = pairingCost(group, byId, roundNumber, false);
    matches.push({ team_a: r.pairing[0], team_b: r.pairing[1], score_a: null, score_b: null, status: "scheduled", division: "edge", court: courtNum++ });
    warnings.push(`Court ${courtNum - 1} used an uneven mixed grouping this round because the remaining players didn't divide evenly into women's, men's, or mixed doubles.`);
  }

  if (matches.length === 0) {
    return { error: "Not enough eligible players to fill a court this round." };
  }

  matches.forEach((m) => {
    if (m.division !== "mixed") return;
    const teamAMixed = byId[m.team_a[0]].gender !== byId[m.team_a[1]].gender;
    const teamBMixed = byId[m.team_b[0]].gender !== byId[m.team_b[1]].gender;
    if (!teamAMixed && !teamBMixed) warnings.push(`Court ${m.court} paired as a women's-pair vs men's-pair instead of proper mixed doubles, to avoid a repeat partnership.`);
  });

  const claimedIds = new Set([...claimedWomen, ...claimedMen, ...(plan.includes("edge") ? [...leftoverWomen, ...leftoverMen].map((p) => p.id) : [])]);
  const sitting = pool.filter((p) => !claimedIds.has(p.id)).map((p) => p.id);

  warnings.push(...buildWarnings(matches, byId, roundNumber));

  return { matches, sitting, roundNumber, warnings };
}

function buildWarnings(matches, byId, roundNumber) {
  const warnings = [];
  const gameCounts = matches.flatMap((m) => [...m.team_a, ...m.team_b]).map((id) => byId[id].games_played);
  if (gameCounts.length && Math.max(...gameCounts) - Math.min(...gameCounts) > 1) {
    warnings.push("Uneven game counts among this round's players (spread > 1).");
  }
  matches.forEach((m) => {
    [...m.team_a, ...m.team_b].forEach((id) => {
      if (byId[id].last_played_round === roundNumber - 1) warnings.push(`${byId[id].display_name} is back-to-back from the previous round.`);
    });
  });
  return warnings;
}

/** Derives the display label straight from actual team composition rather than the
 * coarse `division` tag persisted on the match, so an "edge" match always shows the
 * specific composition that actually happened (e.g. "Mixed vs Men's Doubles"). */
export function matchTypeLabel(match, byId) {
  const gA = match.team_a.map((id) => byId[id]?.gender);
  const gB = match.team_b.map((id) => byId[id]?.gender);
  const all = [...gA, ...gB];
  if (all.every((g) => g === "female")) return "Women's Doubles";
  if (all.every((g) => g === "male")) return "Men's Doubles";
  const teamAMixed = gA[0] !== gA[1];
  const teamBMixed = gB[0] !== gB[1];
  if (teamAMixed && teamBMixed) return "Mixed Doubles";
  if (teamAMixed || teamBMixed) {
    const sameGenderTeamGender = teamAMixed ? gB[0] : gA[0];
    return `Mixed vs ${sameGenderTeamGender === "female" ? "Women's" : "Men's"} Doubles`;
  }
  return "Women's Pair vs Men's Pair";
}

/** Swap two players between (or within) matches in a draft round, client-side only. */
export function swapPlayers(matches, playerIdA, playerIdB) {
  const map = { [playerIdA]: playerIdB, [playerIdB]: playerIdA };
  const swap = (id) => map[id] || id;
  return matches.map((m) => ({
    ...m,
    team_a: m.team_a.map(swap),
    team_b: m.team_b.map(swap),
  }));
}
