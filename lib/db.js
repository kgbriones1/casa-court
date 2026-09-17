import { supabase } from "./supabase";
import { matchTypeLabel, reverseMatchHistory } from "./scheduler";

export async function logEvent(eventId, message) {
  await supabase.from("logs").insert({ event_id: eventId, message });
}

export async function createEvent(fields) {
  // fields: {name, courts, targetParticipants, eventDate, startTime, endTime, roundMinutes, venue}
  const { data, error } = await supabase
    .from("events")
    .insert({
      name: fields.name,
      courts: fields.courts,
      target_participants: fields.targetParticipants || null,
      event_date: fields.eventDate || null,
      start_time: fields.startTime || null,
      end_time: fields.endTime || null,
      round_minutes: fields.roundMinutes || 20,
      venue: fields.venue || "",
    })
    .select()
    .single();
  if (error) throw error;
  await logEvent(data.id, `Event created: ${data.name}`);
  return data;
}

export async function listEvents() {
  const { data, error } = await supabase.from("events").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function fetchFullEvent(eventId) {
  // No `rounds` fetch -- a round is now a derived, display-only label computed
  // from matches.sequence (see lib/scheduler.js's groupIntoRounds), not a real
  // table every match belongs to.
  const [{ data: event }, { data: players }, { data: matches }, { data: logs }] = await Promise.all([
    supabase.from("events").select("*").eq("id", eventId).single(),
    supabase.from("players").select("*").eq("event_id", eventId).order("created_at"),
    supabase.from("matches").select("*").eq("event_id", eventId).order("sequence").order("court"),
    supabase.from("logs").select("*").eq("event_id", eventId).order("created_at", { ascending: false }).limit(200),
  ]);
  return { event, players: players || [], matches: matches || [], logs: logs || [] };
}

export function subscribeEvent(eventId, onChange) {
  const channel = supabase
    .channel(`event-${eventId}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "events", filter: `id=eq.${eventId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `event_id=eq.${eventId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "matches", filter: `event_id=eq.${eventId}` }, onChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "logs", filter: `event_id=eq.${eventId}` }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export async function importRoster(eventId, rows) {
  // rows: [{firstName, lastName, nickname, gender, level}]
  const records = rows
    .filter((r) => r.firstName?.trim())
    .map((r) => ({
      event_id: eventId,
      first_name: r.firstName.trim(),
      last_name: (r.lastName || "").trim(),
      nickname: (r.nickname || "").trim(),
      display_name: (r.nickname || "").trim() || r.firstName.trim(),
      gender: r.gender === "M" || r.gender === "male" ? "male" : "female",
      level: r.level ? parseFloat(r.level) : null,
      registration_status: "registered",
    }));
  if (!records.length) return [];
  const { data, error } = await supabase.from("players").insert(records).select();
  if (error) throw error;
  await logEvent(eventId, `Imported ${data.length} registrant(s)`);
  return data;
}

export async function addWalkIn(eventId, { firstName, lastName, nickname, gender, level, note }) {
  const { data, error } = await supabase
    .from("players")
    .insert({
      event_id: eventId,
      first_name: firstName.trim(),
      last_name: (lastName || "").trim(),
      nickname: (nickname || "").trim(),
      display_name: (nickname || "").trim() || firstName.trim(),
      gender: gender === "M" || gender === "male" ? "male" : "female",
      level: level ? parseFloat(level) : null,
      registration_status: "walk_in",
      attendance_status: "checked_in",
      organizer_note: note || "",
    })
    .select()
    .single();
  if (error) throw error;
  await logEvent(eventId, `Added walk-in: ${data.display_name}`);
  return data;
}

export async function setAttendance(eventId, playerId, playerName, attendance_status, etaNote = "") {
  const patch = { attendance_status };
  if (attendance_status === "late") patch.eta_note = etaNote;
  const { error } = await supabase.from("players").update(patch).eq("id", playerId);
  if (error) throw error;
  await logEvent(eventId, `${playerName}: ${attendance_status.replace("_", " ")}${etaNote ? ` (${etaNote})` : ""}`);
}

/** Bulk check-in for the "Check in all" button -- only touches players still
 * sitting in not_arrived/late, leaving temporarily_unavailable/no_show/withdrawn
 * alone since those are deliberate organizer calls, not a default state to skip past.
 * Logged once so the Event Log doesn't get flooded with one line per player. */
export async function checkInAll(eventId, players) {
  const ids = players.filter((p) => p.attendance_status === "not_arrived" || p.attendance_status === "late").map((p) => p.id);
  if (!ids.length) return;
  const { error } = await supabase.from("players").update({ attendance_status: "checked_in" }).in("id", ids);
  if (error) throw error;
  await logEvent(eventId, `Checked in all (${ids.length} player${ids.length === 1 ? "" : "s"})`);
}

/** Cancels a published-but-unscored match and reverses its effect on the 4 players'
 * assignment history in one write -- a cancelled match never happened, so it
 * shouldn't keep counting against future repeat-partner/opponent avoidance or
 * back-to-back/break timing. Only those 4 players are touched; nothing else is
 * affected. `players` and `allMatches` are the caller's already-loaded state,
 * passed straight through to lib/scheduler.js's reverseMatchHistory to compute
 * the new values. */
export async function cancelMatch(eventId, match, players, allMatches, reason = "") {
  const { error: matchErr } = await supabase.from("matches").update({ status: "cancelled" }).eq("id", match.id);
  if (matchErr) throw matchErr;

  const reversed = reverseMatchHistory(match, players, allMatches);
  await Promise.all(
    reversed.map((p) =>
      supabase.from("players").update({
        partner_ids: p.partner_ids,
        opponent_counts: p.opponent_counts,
        last_played_sequence: p.last_played_sequence,
      }).eq("id", p.id)
    )
  );

  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  await logEvent(
    eventId,
    `Court ${match.court} (${matchTypeLabel(match, byId)}) cancelled${reason ? ` -- ${reason}` : ""} -- assignment history reversed for ${reversed.map((p) => p.display_name).join(", ")}`
  );
}

/** Fully reverses an already-scored match -- both its result stats (games/wins/
 * losses/points, as if it had never been scored) and its assignment history
 * (same reversal as cancelMatch), then marks it cancelled. This is a heavier,
 * rarer operation than cancelMatch (which only ever applies to a match that
 * hasn't been scored yet) -- callers should put real confirmation friction in
 * front of it, since it retroactively changes standings. */
export async function invalidateMatch(eventId, match, players, allMatches, reason = "") {
  if (match.status !== "completed" && match.status !== "time_expired") {
    throw new Error("Only a scored match can be invalidated -- use Cancel match for one that hasn't been scored yet.");
  }

  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const diff = match.score_a - match.score_b;
  const statReversal = (id, scoreFor, scoreAgainst, teamDiff) => {
    const p = byId[id];
    return {
      id,
      games_played: p.games_played - 1,
      wins: p.wins - (teamDiff > 0 ? 1 : 0),
      losses: p.losses - (teamDiff < 0 ? 1 : 0),
      points_for: p.points_for - scoreFor,
      points_against: p.points_against - scoreAgainst,
      point_diff: p.point_diff - teamDiff,
    };
  };
  const statReversals = [
    ...match.team_a.map((id) => statReversal(id, match.score_a, match.score_b, diff)),
    ...match.team_b.map((id) => statReversal(id, match.score_b, match.score_a, -diff)),
  ];

  const historyById = Object.fromEntries(reverseMatchHistory(match, players, allMatches).map((p) => [p.id, p]));

  const { error: matchErr } = await supabase.from("matches").update({ status: "cancelled" }).eq("id", match.id);
  if (matchErr) throw matchErr;

  await Promise.all(
    statReversals.map((s) => {
      const h = historyById[s.id];
      return supabase.from("players").update({
        games_played: s.games_played,
        wins: s.wins,
        losses: s.losses,
        points_for: s.points_for,
        points_against: s.points_against,
        point_diff: s.point_diff,
        partner_ids: h.partner_ids,
        opponent_counts: h.opponent_counts,
        last_played_sequence: h.last_played_sequence,
      }).eq("id", s.id);
    })
  );

  const names = [...match.team_a, ...match.team_b].map((id) => byId[id]?.display_name).join(", ");
  await logEvent(
    eventId,
    `Court ${match.court} INVALIDATED (was ${match.score_a}-${match.score_b})${reason ? ` -- ${reason}` : ""} -- result stats and assignment history fully reversed for ${names}`
  );
}

/** "Check out" -- a player leaving before the event ends. Sets attendance to withdrawn
 * (so the match generator excludes them from every future draft -- it already only
 * pulls from attendance_status === 'checked_in', so this alone is enough going
 * forward) and, if they're currently sitting in a published-but-unscored match,
 * cancels that specific match (reversing its assignment history) so it doesn't sit
 * forever in "pending scores" waiting for a game that's never going to finish. Past,
 * already-scored results are untouched. */
export async function checkOutPlayer(eventId, player, matches, players) {
  const pendingMatch = matches.find(
    (m) => m.status === "scheduled" && [...m.team_a, ...m.team_b].includes(player.id)
  );

  if (pendingMatch) {
    await cancelMatch(eventId, pendingMatch, players, matches, `${player.display_name} checked out mid-match`);
  }

  const { error } = await supabase.from("players").update({ attendance_status: "withdrawn" }).eq("id", player.id);
  if (error) throw error;
  await logEvent(eventId, `${player.display_name}: checked out${pendingMatch ? " (pending match on their court was cancelled)" : ""}`);
}

export async function startEvent(eventId) {
  const { error } = await supabase.from("events").update({ started_at: new Date().toISOString() }).eq("id", eventId);
  if (error) throw error;
  await logEvent(eventId, "Event started");
}

export async function endEvent(eventId) {
  const { error } = await supabase.from("events").update({ ended: true }).eq("id", eventId);
  if (error) throw error;
  await logEvent(eventId, "Event ended");
}

/** Deletes an event and everything under it (players, rounds, matches, logs cascade
 * via the foreign keys in the schema). Irreversible -- callers should confirm first. */
export async function deleteEvent(eventId) {
  const { error } = await supabase.from("events").delete().eq("id", eventId);
  if (error) throw error;
}

/** Commits one match's effect onto a working {id: player} map: pushes the
 * partnership onto both partner_ids, increments opponent_counts for every
 * team-A/team-B pair, and sets last_played_sequence to this match's sequence.
 * Mutates `byId` in place -- callers own the copying (see publishMatches and
 * editMatchPlayers, which both need this same commit on top of different
 * starting state). */
function applyMatchHistory(byId, match) {
  const [a1, a2] = match.team_a, [b1, b2] = match.team_b;
  byId[a1].partner_ids.push(a2); byId[a2].partner_ids.push(a1);
  byId[b1].partner_ids.push(b2); byId[b2].partner_ids.push(b1);
  [a1, a2, b1, b2].forEach((id) => { byId[id].last_played_sequence = match.sequence; });
  match.team_a.forEach((a) => match.team_b.forEach((b) => {
    byId[a].opponent_counts[b] = (byId[a].opponent_counts[b] || 0) + 1;
    byId[b].opponent_counts[a] = (byId[b].opponent_counts[a] || 0) + 1;
  }));
}

/** Publish a draft batch of matches (one or more -- see lib/scheduler.js's
 * generateDraft, which no longer generates a whole fixed round at a time):
 * creates the match rows and commits partner/opponent/last_played_sequence
 * history on the players table. This is the single commit point -- nothing
 * before this touches history, so drafting ahead of time is always safe.
 * Matches don't belong to a `rounds` row anymore (a round is now a derived
 * display label, not a real container -- see lib/scheduler.js), and each gets
 * a predicted court from its position in the sequence, cycling 1..courts;
 * organizers can move it with reassignCourt before it's actually played. */
export async function publishMatches(eventId, draftMatches, players, courts) {
  const matchRows = draftMatches.map((m) => ({
    ...m,
    event_id: eventId,
    court: ((m.sequence - 1) % courts) + 1,
  }));
  const { data: inserted, error: matchErr } = await supabase.from("matches").insert(matchRows).select();
  if (matchErr) throw matchErr;

  const byId = Object.fromEntries(players.map((p) => [p.id, { ...p, partner_ids: [...p.partner_ids], opponent_counts: { ...p.opponent_counts } }]));
  draftMatches.forEach((m) => applyMatchHistory(byId, m));

  const touchedIds = new Set(draftMatches.flatMap((m) => [...m.team_a, ...m.team_b]));
  await Promise.all(
    [...touchedIds].map((id) =>
      supabase.from("players").update({
        partner_ids: byId[id].partner_ids,
        opponent_counts: byId[id].opponent_counts,
        last_played_sequence: byId[id].last_played_sequence,
      }).eq("id", id)
    )
  );
  await logEvent(eventId, `Published ${draftMatches.length} match${draftMatches.length === 1 ? "" : "es"} (sequence ${draftMatches[0].sequence}-${draftMatches[draftMatches.length - 1].sequence})`);
  return inserted;
}

/** Replaces the 4 players on an unscored match -- e.g. swapping in a walk-in or
 * correcting a mistaken pairing before it's played. Reverses the old match's
 * effect on assignment history, then re-commits it for the new roster at the
 * same sequence (so the slot's position in the queue doesn't change, only who
 * fills it). Doesn't touch result stats -- there are none yet, since this only
 * applies to a match that hasn't been scored (see invalidateMatch for a scored
 * one). */
export async function editMatchPlayers(eventId, match, newTeamA, newTeamB, players, allMatches) {
  if (match.status !== "scheduled") throw new Error("Only an unscored match's players can be edited.");

  const byId = Object.fromEntries(players.map((p) => [p.id, { ...p, partner_ids: [...p.partner_ids], opponent_counts: { ...p.opponent_counts } }]));
  reverseMatchHistory(match, players, allMatches).forEach((r) => { byId[r.id] = { ...byId[r.id], ...r }; });

  const newMatch = { ...match, team_a: newTeamA, team_b: newTeamB };
  applyMatchHistory(byId, newMatch);

  const { error: matchErr } = await supabase.from("matches").update({ team_a: newTeamA, team_b: newTeamB }).eq("id", match.id);
  if (matchErr) throw matchErr;

  const touchedIds = new Set([...match.team_a, ...match.team_b, ...newTeamA, ...newTeamB]);
  await Promise.all(
    [...touchedIds].map((id) =>
      supabase.from("players").update({
        partner_ids: byId[id].partner_ids,
        opponent_counts: byId[id].opponent_counts,
        last_played_sequence: byId[id].last_played_sequence,
      }).eq("id", id)
    )
  );

  const origById = Object.fromEntries(players.map((p) => [p.id, p]));
  const oldNames = [...match.team_a, ...match.team_b].map((id) => origById[id]?.display_name).join(", ");
  const newNames = [...newTeamA, ...newTeamB].map((id) => byId[id]?.display_name).join(", ");
  await logEvent(eventId, `Court ${match.court} players edited: ${oldNames} → ${newNames}`);
}

/** Moves a match to a different court, swapping with whatever unscored match
 * currently holds that court (if any) so nothing ends up sharing or losing its
 * court -- a true swap, not an overwrite. Matches that are already scored keep
 * their historical court untouched even if their number gets reused. */
export async function reassignCourt(eventId, matches, players, matchId, newCourt) {
  const match = matches.find((m) => m.id === matchId);
  if (!match) throw new Error("Match not found.");
  const displaced = matches.find((m) => m.id !== matchId && m.court === newCourt && m.status === "scheduled");

  const updates = [supabase.from("matches").update({ court: newCourt }).eq("id", matchId)];
  if (displaced) updates.push(supabase.from("matches").update({ court: match.court }).eq("id", displaced.id));
  const results = await Promise.all(updates);
  results.forEach(({ error }) => { if (error) throw error; });

  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const name = (id) => byId[id]?.display_name || "?";
  const matchNames = [...match.team_a, ...match.team_b].map(name).join(", ");
  await logEvent(
    eventId,
    `Court reassignment: ${matchNames} moved to Court ${newCourt}` +
      (displaced ? `, swapped with ${[...displaced.team_a, ...displaced.team_b].map(name).join(", ")} (now Court ${match.court})` : "")
  );
}

/** Submit a score: updates the match row and the four players' result stats.
 * Result stats (games/wins/losses/points) are separate from assignment history,
 * which was already committed at publish. */
export async function submitScore(match, scoreA, scoreB, players, status = "completed") {
  const { error: matchErr } = await supabase
    .from("matches")
    .update({ score_a: scoreA, score_b: scoreB, status, completed_at: new Date().toISOString() })
    .eq("id", match.id);
  if (matchErr) throw matchErr;

  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const diff = scoreA - scoreB;
  const updates = [];
  match.team_a.forEach((id) => {
    const p = byId[id];
    updates.push({ id, games_played: p.games_played + 1, wins: p.wins + (diff > 0 ? 1 : 0), losses: p.losses + (diff < 0 ? 1 : 0), points_for: p.points_for + scoreA, points_against: p.points_against + scoreB, point_diff: p.point_diff + diff });
  });
  match.team_b.forEach((id) => {
    const p = byId[id];
    updates.push({ id, games_played: p.games_played + 1, wins: p.wins + (diff < 0 ? 1 : 0), losses: p.losses + (diff > 0 ? 1 : 0), points_for: p.points_for + scoreB, points_against: p.points_against + scoreA, point_diff: p.point_diff - diff });
  });
  await Promise.all(updates.map((u) => supabase.from("players").update(u).eq("id", u.id)));
  const teamAName = match.team_a.map((id) => byId[id]?.display_name || "?").join(" & ");
  const teamBName = match.team_b.map((id) => byId[id]?.display_name || "?").join(" & ");
  await logEvent(
    match.event_id,
    `Court ${match.court} (${matchTypeLabel(match, byId)}): ${teamAName} vs ${teamBName} \u2014 ${scoreA}-${scoreB}`
  );
}

/** Correct an already-completed score: reverses the old stat impact, applies the new one. */
export async function correctScore(match, oldScoreA, oldScoreB, newScoreA, newScoreB, players) {
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const oldDiff = oldScoreA - oldScoreB;
  const newDiff = newScoreA - newScoreB;
  const { error } = await supabase.from("matches").update({ score_a: newScoreA, score_b: newScoreB }).eq("id", match.id);
  if (error) throw error;

  const apply = (id, oldPF, oldPA, oldD, newPF, newPA, newD, oldWin, newWin) => {
    const p = byId[id];
    return {
      id,
      points_for: p.points_for - oldPF + newPF,
      points_against: p.points_against - oldPA + newPA,
      point_diff: p.point_diff - oldD + newD,
      wins: p.wins - (oldWin ? 1 : 0) + (newWin ? 1 : 0),
      losses: p.losses - (oldWin === false ? 1 : 0) + (newWin === false ? 1 : 0),
    };
  };
  const updates = [
    ...match.team_a.map((id) => apply(id, oldScoreA, oldScoreB, oldDiff, newScoreA, newScoreB, newDiff, oldDiff > 0, newDiff > 0)),
    ...match.team_b.map((id) => apply(id, oldScoreB, oldScoreA, -oldDiff, newScoreB, newScoreA, -newDiff, oldDiff < 0, newDiff < 0)),
  ];
  await Promise.all(updates.map((u) => supabase.from("players").update(u).eq("id", u.id)));
  const teamAName = match.team_a.map((id) => byId[id]?.display_name || "?").join(" & ");
  const teamBName = match.team_b.map((id) => byId[id]?.display_name || "?").join(" & ");
  await logEvent(
    match.event_id,
    `Court ${match.court}: ${teamAName} vs ${teamBName} corrected \u2014 ${oldScoreA}-${oldScoreB} \u2192 ${newScoreA}-${newScoreB}`
  );
}
