// Pure, framework-free. Takes the current DB state and returns a draft round
// (not persisted). Nothing here mutates history — that only happens on publish
// (see lib/db.js: publishRound).
//
// IMPORTANT: this is strictly gender-segregated. Women's doubles and men's
// doubles are two completely separate draws that happen to share a court
// count budget for the round -- a match is never mixed-gender.

const PENALTY = {
  REPEAT_PARTNER: 1_000_000,
  FUTURE_CONFLICT: 1_000_000, // handled as a hard filter, kept here for reference
  REPEAT_OPPONENT: 2_000, // per prior meeting
  GAME_IMBALANCE: 1_000, // per game of difference from the pool average
  BACK_TO_BACK: 500, // played in the immediately preceding round
  WAIT_BONUS: -300, // per round waited since last played (reduces cost -> raises priority)
  LATE_ZERO_GAMES_BONUS: -500,
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

function priorityScore(player, roundNumber) {
  let score = player.games_played * 1000;
  score += PENALTY.WAIT_BONUS * waitRounds(player, roundNumber);
  if (player.games_played === 0) score += PENALTY.LATE_ZERO_GAMES_BONUS;
  return score;
}

function pairingCost(group, byId, roundNumber) {
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
    for (const pid of [t1[0], t1[1], t2[0], t2[1]]) {
      if (byId[pid].last_played_round === roundNumber - 1) cost += PENALTY.BACK_TO_BACK;
    }
    if (best === null || cost < best.cost) best = { cost, pairing: [t1, t2] };
  }
  return best;
}

/** Decides how many of numCourts go to each division this round, using a pacing
 * signal (average games played so far within each division's eligible pool) rather
 * than raw headcount -- so a small division (e.g. 6 women vs 24 men) doesn't grab
 * its one usable court every single round and rocket past the other division's game
 * count. Courts are handed out one at a time to whichever division is currently
 * behind on average games played, capped by how many full foursomes each division
 * can actually supply. */
export function suggestCourtSplit(eligibleFemalePool, eligibleMalePool, numCourts) {
  const avg = (arr) => (arr.length ? arr.reduce((s, p) => s + p.games_played, 0) / arr.length : 0);
  const maxF = Math.floor(eligibleFemalePool.length / 4);
  const maxM = Math.floor(eligibleMalePool.length / 4);
  let female = 0, male = 0;
  let avgF = avg(eligibleFemalePool);
  let avgM = avg(eligibleMalePool);

  for (let i = 0; i < numCourts; i++) {
    const canF = female < maxF;
    const canM = male < maxM;
    if (!canF && !canM) break;
    if (canF && (!canM || avgF <= avgM)) {
      female++;
      avgF += 4 / eligibleFemalePool.length; // rough projection so this division doesn't just keep winning ties every remaining court this round
    } else {
      male++;
      avgM += 4 / eligibleMalePool.length;
    }
  }
  return { female, male };
}

/** Runs the constraint search for ONE gender's pool. Returns matches (without court
 * numbers assigned yet), sitting ids, and whether a partner repeat was unavoidable. */
function draftForPool(pool, courts, roundNumber, byId) {
  const ranked = shuffle(pool).sort((a, b) => priorityScore(a, roundNumber) - priorityScore(b, roundNumber));
  const slots = Math.min(courts * 4, Math.floor(ranked.length / 4) * 4);
  const playing = ranked.slice(0, slots).map((p) => p.id);
  const sitting = pool.filter((p) => !playing.includes(p.id)).map((p) => p.id);

  if (playing.length === 0) return { matches: [], sitting, partnerRepeatForced: false };

  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const shuf = shuffle(playing);
    const groups = [];
    for (let i = 0; i < shuf.length; i += 4) groups.push(shuf.slice(i, i + 4));
    let totalCost = 0;
    const groupResults = groups.map((g) => {
      const r = pairingCost(g, byId, roundNumber);
      totalCost += r.cost;
      return { pairing: r.pairing };
    });
    if (best === null || totalCost < best.cost) best = { cost: totalCost, groups: groupResults };
    if (best.cost === 0) break;
  }

  const matches = best.groups.map((g) => ({
    team_a: g.pairing[0],
    team_b: g.pairing[1],
    score_a: null,
    score_b: null,
    status: "scheduled",
  }));

  return { matches, sitting, partnerRepeatForced: best.cost >= PENALTY.REPEAT_PARTNER };
}

/**
 * @param {Array} allPlayers - every player row for the event
 * @param {number} numCourts
 * @param {number} roundNumber
 * @param {Set<string>} futureReservedIds - hard exclusion, see below
 * @param {Set<string>} justPlayedIds - hard-excluded by default (mandatory rest gap);
 *   relaxed per-gender if it would leave that gender's pool under 4 players.
 * @param {{female:number, male:number}} courtsForGender - how many of numCourts go to
 *   each division this round. Use suggestCourtSplit() for a sensible default, or let
 *   the organizer override it.
 */
export function generateDraft(allPlayers, numCourts, roundNumber, futureReservedIds = new Set(), justPlayedIds = new Set(), courtsForGender = null) {
  const byId = Object.fromEntries(allPlayers.map((p) => [p.id, p]));
  const checkedIn = allPlayers.filter((p) => p.attendance_status === "checked_in" && !futureReservedIds.has(p.id));

  const byGender = { female: [], male: [] };
  checkedIn.forEach((p) => { if (byGender[p.gender]) byGender[p.gender].push(p); });

  const warnings = [];
  const eligibleByGender = {};
  for (const g of ["female", "male"]) {
    let pool = byGender[g].filter((p) => !justPlayedIds.has(p.id));
    if (pool.length < 4 && byGender[g].length >= 4) {
      pool = byGender[g];
      warnings.push(`Not enough rested ${g === "female" ? "women" : "men"} -- some players are back-to-back from the previous round this time.`);
    }
    eligibleByGender[g] = pool;
  }

  const split = courtsForGender || suggestCourtSplit(eligibleByGender.female, eligibleByGender.male, numCourts);

  if (eligibleByGender.female.length < 4 && eligibleByGender.male.length < 4) {
    return { error: `Not enough eligible players in either division (women: ${eligibleByGender.female.length}, men: ${eligibleByGender.male.length}) -- need at least 4 in one division.` };
  }

  const femaleResult = split.female > 0 ? draftForPool(eligibleByGender.female, split.female, roundNumber, byId) : { matches: [], sitting: eligibleByGender.female.map((p) => p.id), partnerRepeatForced: false };
  const maleResult = split.male > 0 ? draftForPool(eligibleByGender.male, split.male, roundNumber, byId) : { matches: [], sitting: eligibleByGender.male.map((p) => p.id), partnerRepeatForced: false };

  if (femaleResult.partnerRepeatForced) warnings.push("Women's partner pool is exhausted -- a repeat partnership was unavoidable this round.");
  if (maleResult.partnerRepeatForced) warnings.push("Men's partner pool is exhausted -- a repeat partnership was unavoidable this round.");

  let courtNum = 1;
  const matches = [
    ...femaleResult.matches.map((m) => ({ ...m, division: "female", court: courtNum++ })),
    ...maleResult.matches.map((m) => ({ ...m, division: "male", court: courtNum++ })),
  ];

  if (matches.length === 0) {
    return { error: "Neither division has enough eligible players to fill a court this round." };
  }

  const sitting = [...femaleResult.sitting, ...maleResult.sitting];
  warnings.push(...buildWarnings(matches, byId, roundNumber));

  return { matches, sitting, roundNumber, courtSplit: split, warnings };
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

/** Swap two players between (or within) matches in a draft round, client-side only.
 * Only allows swapping within the same division -- swapping across women's/men's
 * draws would silently create a mixed match. */
export function swapPlayers(matches, playerIdA, playerIdB) {
  const findDivision = (id) => matches.find((m) => m.team_a.includes(id) || m.team_b.includes(id))?.division;
  if (findDivision(playerIdA) !== findDivision(playerIdB)) return matches; // no-op, caller should validate first
  const map = { [playerIdA]: playerIdB, [playerIdB]: playerIdA };
  const swap = (id) => map[id] || id;
  return matches.map((m) => ({
    ...m,
    team_a: m.team_a.map(swap),
    team_b: m.team_b.map(swap),
  }));
}
