// Pure, framework-free. Takes the current DB state and returns a draft (one or
// more matches, not persisted). Nothing here mutates history -- that only
// happens on publish (see lib/db.js).
//
// Matchmaking is gender-blind: any two eligible players can be partnered or
// matched up against each other, regardless of gender, EXCEPT for a soft cost
// preference (see COMPOSITION_* below) that nudges away from a same-gender pair
// facing a same-gender pair of the other gender. Gender never gates who plays --
// it only ever adds or removes cost when comparing candidate groupings.
//
// Matches are generated per-match (any count from 1 up), not per fixed round.
// "Round" is a derived, display-only label: every `courts`-many matches, in the
// order they were generated, form one round-equivalent. Courts don't run in
// lockstep -- one match finishing early or a late arrival doesn't block anyone
// else's next match. This file tracks progress purely by a monotonically
// increasing `sequence` assigned to each match at generation time, never by
// wall-clock round number.

const PENALTY = {
  REPEAT_PARTNER: 1_000_000,
  COMPOSITION_HEAVY: 60_000, // same-gender pair vs opposite same-gender pair -- usually avoidable
  COMPOSITION_LIGHT: 5_000, // mixed pair vs same-gender pair -- often forced by an uneven split
  REPEAT_OPPONENT: 2_000, // per prior meeting
  BACK_TO_BACK: 500, // secondary nudge inside the cost function; the real exclusion happens earlier
  WAIT_BONUS: -300, // per round-equivalent waited (fine-grained tiebreak within the normal tier)
  LATE_ZERO_GAMES_BONUS: -500,
};

// A player whose break has reached this many full round-equivalents without
// playing enters the "must-play" protected tier: guaranteed a slot (ahead of
// everyone else, including zero-games latecomers) before slots are handed out
// by ordinary priority. This is what actually prevents a break of 3+ -- a plain
// scoring bonus can't reliably guarantee it once games_played climbs.
const MUST_PLAY_BREAK_THRESHOLD = 2;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Which round-equivalent a given global match sequence number falls in, under
 * the "every courts-many matches, in generation order" definition. Sequence
 * numbers start at 1. */
export function roundOf(sequence, courts) {
  return Math.ceil(sequence / courts);
}

/** Buckets matches into their derived round-equivalents purely from `sequence`
 * and `courts` -- the display-only replacement for the old rounds/round_id
 * table relationship. Matches without a sequence (shouldn't happen once every
 * match is generated through this file) are dropped rather than mis-bucketed.
 * Returns the same [{number, matches}] shape the old rounds-table grouping
 * did, sorted ascending, so existing round-oriented display code needs
 * minimal changes to switch over. */
export function groupIntoRounds(matches, courts) {
  const byRound = new Map();
  matches.forEach((m) => {
    if (m.sequence == null) return;
    const number = roundOf(m.sequence, courts);
    if (!byRound.has(number)) byRound.set(number, []);
    byRound.get(number).push(m);
  });
  return [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([number, ms]) => ({ number, matches: ms }));
}

/** Full round-equivalents a player has been waiting since their last match, as
 * of the given next-match sequence number. A player who has never played
 * returns 0 -- they aren't "on a break," they just haven't had a first game
 * yet, which the zero-games bonus handles on its own. */
export function breakCount(player, nextSequence, courts) {
  if (player.last_played_sequence == null) return 0;
  return Math.max(0, roundOf(nextSequence, courts) - roundOf(player.last_played_sequence, courts) - 1);
}

function isBackToBack(player, nextSequence, courts) {
  return player.last_played_sequence != null && roundOf(nextSequence, courts) <= roundOf(player.last_played_sequence, courts) + 1;
}

function priorityScore(player, nextSequence, courts) {
  let score = player.games_played * 1000;
  score += PENALTY.WAIT_BONUS * breakCount(player, nextSequence, courts);
  if (player.games_played === 0) score += PENALTY.LATE_ZERO_GAMES_BONUS;
  return score;
}

/** Tier 0 (no penalty): Mixed vs Mixed, or Women's vs Women's / Men's vs Men's.
 * Tier 1 (light): Mixed vs a same-gender pair -- often unavoidable from an
 * uneven gender split. Tier 2 (heavy): a same-gender pair vs the other
 * gender's same-gender pair -- usually avoidable, so discouraged hard. */
function compositionPenalty(t1, t2, byId) {
  const team1Mixed = byId[t1[0]].gender !== byId[t1[1]].gender;
  const team2Mixed = byId[t2[0]].gender !== byId[t2[1]].gender;
  if (team1Mixed && team2Mixed) return 0;
  if (!team1Mixed && !team2Mixed) {
    return byId[t1[0]].gender === byId[t2[0]].gender ? 0 : PENALTY.COMPOSITION_HEAVY;
  }
  return PENALTY.COMPOSITION_LIGHT;
}

/** Cost of the 3 possible 2v2 splits of a fixed foursome. */
function pairingCost(group, byId, nextSequence, courts) {
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
    const repeatPartner = p1.partner_ids.includes(t1[1]) || p3.partner_ids.includes(t2[1]);
    if (p1.partner_ids.includes(t1[1])) cost += PENALTY.REPEAT_PARTNER;
    if (p3.partner_ids.includes(t2[1])) cost += PENALTY.REPEAT_PARTNER;
    for (const x of t1) {
      for (const y of t2) {
        cost += (byId[x].opponent_counts?.[y] || 0) * PENALTY.REPEAT_OPPONENT;
      }
    }
    cost += compositionPenalty(t1, t2, byId);
    for (const pid of group) {
      if (isBackToBack(byId[pid], nextSequence, courts)) cost += PENALTY.BACK_TO_BACK;
    }
    if (best === null || cost < best.cost) best = { cost, pairing: [t1, t2], repeatPartner };
  }
  return best;
}

/** Combines checked-in players (minus any hard-reserved ids) who aren't already
 * committed to an unfinished match -- covers both a match currently being
 * played on a court and one that's published but still waiting for a court, no
 * separate tracking needed since both are represented as status "scheduled".
 * Applies the back-to-back relaxation: excluded from the round-equivalent
 * immediately after their last match by default, relaxed back to the full
 * checked-in pool (with a warning) only if strict exclusion would leave fewer
 * than 4 players eligible at all. */
export function eligiblePlayers(allPlayers, matches, nextSequence, courts, futureReservedIds = new Set()) {
  const busyIds = new Set(matches.filter((m) => m.status === "scheduled").flatMap((m) => [...m.team_a, ...m.team_b]));
  const checkedIn = allPlayers.filter((p) => p.attendance_status === "checked_in" && !futureReservedIds.has(p.id) && !busyIds.has(p.id));

  const warnings = [];
  let pool = checkedIn.filter((p) => !isBackToBack(p, nextSequence, courts));
  if (pool.length < 4 && checkedIn.length >= 4) {
    pool = checkedIn;
    warnings.push("Not enough rested players -- some players are back-to-back from their last match this time.");
  }
  return { pool, warnings };
}

/** Two-stage selection: players whose break has reached the must-play
 * threshold are seated first and guaranteed a slot (most severe break first),
 * before remaining slots are filled by ordinary priority (games played, wait
 * bonus, zero-games bonus). This is what stops a fast-arriving, zero-games
 * latecomer from displacing someone who's already overdue -- must-play always
 * wins the slot regardless of how the priority formula would have ranked them. */
export function selectPlaying(pool, matchCount, courts, nextSequence) {
  const slots = matchCount * 4;
  const withBreaks = pool.map((p) => ({ player: p, breakCount: breakCount(p, nextSequence, courts) }));
  const mustPlay = shuffle(withBreaks.filter((x) => x.breakCount >= MUST_PLAY_BREAK_THRESHOLD)).sort((a, b) => b.breakCount - a.breakCount);
  const rest = shuffle(withBreaks.filter((x) => x.breakCount < MUST_PLAY_BREAK_THRESHOLD)).sort(
    (a, b) => priorityScore(a.player, nextSequence, courts) - priorityScore(b.player, nextSequence, courts)
  );

  const ranked = [...mustPlay, ...rest].map((x) => x.player);
  return { playing: ranked.slice(0, slots), sitting: ranked.slice(slots), mustPlayCount: mustPlay.length };
}

/** Search over random groupings of the selected players into foursomes, picking
 * whichever grouping+split combo has the lowest total cost. */
function bestGrouping(selected, byId, nextSequence, courts) {
  let best = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const shuf = shuffle(selected);
    const groups = [];
    for (let i = 0; i < shuf.length; i += 4) groups.push(shuf.slice(i, i + 4));
    let totalCost = 0;
    const groupResults = groups.map((g) => {
      const r = pairingCost(g, byId, nextSequence, courts);
      totalCost += r.cost;
      return { pairing: r.pairing, repeatPartner: r.repeatPartner };
    });
    if (best === null || totalCost < best.cost) best = { cost: totalCost, groups: groupResults };
    if (best.cost === 0) break;
  }
  return best.groups.map((g) => ({
    team_a: g.pairing[0],
    team_b: g.pairing[1],
    score_a: null,
    score_b: null,
    status: "scheduled",
    _repeatPartner: g.repeatPartner,
  }));
}

/** Coarse category for a match's actual composition, computed after the fact --
 * descriptive only, never used to plan or constrain matchmaking. Stored on
 * `division` for filtering/audit purposes. */
export function classify(match, byId) {
  const gA = match.team_a.map((id) => byId[id]?.gender);
  const gB = match.team_b.map((id) => byId[id]?.gender);
  const all = [...gA, ...gB];
  if (all.every((g) => g === "female")) return "women";
  if (all.every((g) => g === "male")) return "men";
  if (gA[0] !== gA[1] && gB[0] !== gB[1]) return "mixed";
  return "edge"; // one team mixed + one same-gender, or a same-gender-pair vs same-gender-pair
}

function buildWarnings(matches, byId) {
  const warnings = [];
  const gameCounts = matches.flatMap((m) => [...m.team_a, ...m.team_b]).map((id) => byId[id].games_played);
  if (gameCounts.length && Math.max(...gameCounts) - Math.min(...gameCounts) > 1) {
    warnings.push("Uneven game counts among these players (spread > 1).");
  }
  matches.forEach((m) => {
    const teamAMixed = byId[m.team_a[0]].gender !== byId[m.team_a[1]].gender;
    const teamBMixed = byId[m.team_b[0]].gender !== byId[m.team_b[1]].gender;
    if (!teamAMixed && !teamBMixed && byId[m.team_a[0]].gender !== byId[m.team_b[0]].gender) {
      warnings.push("A match paired a women's pair against a men's pair (heavily discouraged) -- no cleaner composition was achievable this time.");
    } else if (teamAMixed !== teamBMixed) {
      warnings.push("A match paired mixed vs single-gender (lightly discouraged), likely from an uneven gender split right now.");
    }
  });
  return warnings;
}

/**
 * Generates the next `matchCount` matches (or fewer, if the eligible pool can't
 * fill that many) from the current live state. Self-contained: eligibility,
 * back-to-back, and break tracking are all derived from `matches` and each
 * player's own `last_played_sequence`/`games_played` -- the caller doesn't need
 * to compute who "just played" itself.
 *
 * @param {Array} allPlayers - every player row for the event
 * @param {Array} matches - every match for the event so far (any status), each
 *   with at least {status, team_a, team_b, sequence}
 * @param {number} matchCount - how many matches to try to generate (1+)
 * @param {number} courts - the event's court count, used for round-equivalent math
 * @param {Set<string>} futureReservedIds - hard exclusion (e.g. players already
 *   locked into a manually-built match still being assembled)
 *
 * Returned matches have no `court` yet -- court assignment/prediction is a
 * separate dispatch step, not decided at generation time.
 */
export function generateDraft(allPlayers, matches, matchCount, courts, futureReservedIds = new Set()) {
  const byId = Object.fromEntries(allPlayers.map((p) => [p.id, p]));
  const nextSequence = Math.max(0, ...matches.map((m) => m.sequence || 0)) + 1;
  const { pool, warnings } = eligiblePlayers(allPlayers, matches, nextSequence, courts, futureReservedIds);

  if (pool.length < 4) {
    return { error: `Not enough eligible players (${pool.length}) -- need at least 4.` };
  }

  const maxMatches = Math.floor(pool.length / 4);
  const actualCount = Math.min(matchCount, maxMatches);
  const { playing, sitting, mustPlayCount } = selectPlaying(pool, actualCount, courts, nextSequence);

  if (mustPlayCount > playing.length) {
    warnings.push(`${mustPlayCount - playing.length} player(s) have a break of 2+ rounds and couldn't be seated this time -- not enough slots available.`);
  }

  const groupings = bestGrouping(playing.map((p) => p.id), byId, nextSequence, courts);
  if (groupings.some((m) => m._repeatPartner)) {
    warnings.push("Partner pool is exhausted -- a repeat partnership was unavoidable this time.");
  }
  const newMatches = groupings.map((m, i) => {
    const { _repeatPartner, ...rest } = m;
    return { ...rest, division: classify(m, byId), sequence: nextSequence + i };
  });

  warnings.push(...buildWarnings(newMatches, byId));

  return { matches: newMatches, sitting: sitting.map((p) => p.id), nextSequence, warnings };
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

/** Computes the post-cancellation assignment-history state for a match's 4
 * players -- a cancelled/invalidated match never happened, so it shouldn't keep
 * counting against future repeat-partner/opponent avoidance or break timing.
 * Removes exactly one occurrence of the partnership from partner_ids (not all --
 * they may have legitimately partnered again in a different match), decrements
 * opponent_counts by 1 for each opponent (dropping the key at 0), and recomputes
 * last_played_sequence as the highest sequence among the player's other
 * non-cancelled matches (or null if this was their only one). Pure -- returns
 * plain {id, display_name, partner_ids, opponent_counts, last_played_sequence}
 * objects for exactly the 4 touched players, doesn't mutate its inputs.
 * @param {object} match - the match being reversed ({id, team_a, team_b, ...})
 * @param {Array} players - every player row for the event
 * @param {Array} allMatches - every match for the event, each with at least
 *   {id, status, team_a, team_b, sequence} */
export function reverseMatchHistory(match, players, allMatches) {
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const touched = [...match.team_a, ...match.team_b];

  const removeOne = (arr, val) => {
    const idx = arr.indexOf(val);
    if (idx === -1) return [...arr];
    return [...arr.slice(0, idx), ...arr.slice(idx + 1)];
  };

  return touched.map((id) => {
    const p = byId[id];
    const onTeamA = match.team_a.includes(id);
    const partnerId = (onTeamA ? match.team_a : match.team_b).find((x) => x !== id);
    const opponents = onTeamA ? match.team_b : match.team_a;

    const partner_ids = removeOne(p.partner_ids, partnerId);
    const opponent_counts = { ...p.opponent_counts };
    opponents.forEach((oppId) => {
      if ((opponent_counts[oppId] || 0) > 1) opponent_counts[oppId] -= 1;
      else delete opponent_counts[oppId];
    });

    const otherSequences = allMatches
      .filter((m) => m.id !== match.id && m.status !== "cancelled" && [...m.team_a, ...m.team_b].includes(id))
      .map((m) => m.sequence);
    const last_played_sequence = otherSequences.length ? Math.max(...otherSequences) : null;

    return { id, display_name: p.display_name, partner_ids, opponent_counts, last_played_sequence };
  });
}

/** Swap two players between (or within) matches in a draft, client-side only. */
export function swapPlayers(matches, playerIdA, playerIdB) {
  const map = { [playerIdA]: playerIdB, [playerIdB]: playerIdA };
  const swap = (id) => map[id] || id;
  return matches.map((m) => ({
    ...m,
    team_a: m.team_a.map(swap),
    team_b: m.team_b.map(swap),
  }));
}
