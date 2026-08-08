// Pure, framework-free. Takes the current DB state and returns a draft round
// (not persisted). Nothing here mutates history -- that only happens on publish
// (see lib/db.js: publishRound).
//
// Matchmaking is gender-blind: any two eligible players can be partnered or
// matched up against each other, regardless of gender. Gender only matters for
// scoring/ranking (King/Queen leaderboards stay split by gender), never for who
// gets grouped with whom. The resulting match composition (women's doubles,
// men's doubles, mixed, or an uneven pairing) is whatever falls out of that --
// labeled for display, but never planned for or penalized.

const PENALTY = {
  REPEAT_PARTNER: 1_000_000,
  FUTURE_CONFLICT: 1_000_000, // handled as a hard filter, kept here for reference
  REPEAT_OPPONENT: 2_000, // per prior meeting
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

/** Cost of the 3 possible 2v2 splits of a fixed foursome. Purely about IDs -- never
 * looks at gender, since matchmaking doesn't consider it. */
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
    for (const pid of group) {
      if (byId[pid].last_played_round === roundNumber - 1) cost += PENALTY.BACK_TO_BACK;
    }
    if (best === null || cost < best.cost) best = { cost, pairing: [t1, t2] };
  }
  return best;
}

/** Combines checked-in players (minus any hard-reserved ids), applying the rest-gap
 * relaxation: excluded by default, but relaxed back to the full checked-in pool
 * (with a warning) if strict exclusion would leave fewer than 4 players available
 * at all. One combined pool, gender-blind -- a player resting is a property of the
 * player, not of a division. */
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

/** Search over random groupings of the selected players into foursomes, picking
 * whichever grouping+split combo has the lowest total cost (never repeat partner,
 * minimize repeat opponents, avoid back-to-back). Gender never enters this search. */
function bestGrouping(selected, byId, roundNumber) {
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const shuf = shuffle(selected);
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
  return best.groups.map((g) => ({ team_a: g.pairing[0], team_b: g.pairing[1], score_a: null, score_b: null, status: "scheduled" }));
}

/** Coarse category for a match's actual composition, computed after the fact from
 * who ended up on which team -- descriptive only, never used to plan or constrain
 * matchmaking. Stored on `division` for filtering/audit purposes. */
function classify(match, byId) {
  const gA = match.team_a.map((id) => byId[id]?.gender);
  const gB = match.team_b.map((id) => byId[id]?.gender);
  const all = [...gA, ...gB];
  if (all.every((g) => g === "female")) return "women";
  if (all.every((g) => g === "male")) return "men";
  if (gA[0] !== gA[1] && gB[0] !== gB[1]) return "mixed";
  return "edge"; // one team mixed + one same-gender, or a same-gender-pair vs same-gender-pair
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

  const slots = Math.min(numCourts * 4, Math.floor(pool.length / 4) * 4);
  const ranked = shuffle(pool).sort((a, b) => priorityScore(a, roundNumber) - priorityScore(b, roundNumber));
  const playingIds = ranked.slice(0, slots).map((p) => p.id);
  const sitting = pool.filter((p) => !playingIds.includes(p.id)).map((p) => p.id);

  if (playingIds.length === 0) {
    return { error: "Not enough eligible players to fill a court this round." };
  }

  const matches = bestGrouping(playingIds, byId, roundNumber).map((m, i) => ({ ...m, division: classify(m, byId), court: i + 1 }));

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

/** Derives the display label straight from actual team composition. */
export function matchTypeLabel(match, byId) {
  const gA = match.team_a.map((id) => byId[id]?.gender);
  const gB = match.team_b.map((id) => byId[id]?.gender);
  const category = classify(match, byId);
  if (category === "women") return "Women's Doubles";
  if (category === "men") return "Men's Doubles";
  if (category === "mixed") return "Mixed Doubles";
  const teamAMixed = gA[0] !== gA[1];
  const teamBMixed = gB[0] !== gB[1];
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
