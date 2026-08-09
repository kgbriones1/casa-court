"use client";
import { useEffect, useMemo, useState } from "react";
import TopBar from "../../../components/TopBar";
import { fetchFullEvent, subscribeEvent } from "../../../lib/db";
import { matchTypeLabel } from "../../../lib/scheduler";

function leaderboardFor(players, gender) {
  const list = gender === "overall" ? players : players.filter((p) => p.gender === gender);
  return [...list].sort((a, b) => b.point_diff - a.point_diff);
}

/** A court's own current/next match, independent of whether its round as a whole
 * has finished -- mirrors the organizer's Match Control "Court status" exactly, so
 * a court that's already moved on to a later round (because the organizer
 * generated ahead) shows that immediately instead of still being bucketed under
 * its old, already-scored round just because some other court hasn't finished. */
function courtStatus(roundsWithMatches, courtNum) {
  const sorted = [...roundsWithMatches].sort((a, b) => a.number - b.number);
  const scheduled = sorted.flatMap((r) => r.matches.filter((m) => m.court === courtNum && m.status === "scheduled").map((m) => ({ ...m, roundNumber: r.number })));
  return { current: scheduled[0] || null, next: scheduled[1] || null };
}

function classify(roundsWithMatches) {
  const numCourts = Math.max(0, ...roundsWithMatches.flatMap((r) => r.matches.map((m) => m.court)));
  const courts = Array.from({ length: numCourts }, (_, i) => i + 1).map((courtNum) => ({ courtNum, ...courtStatus(roundsWithMatches, courtNum) }));
  const results = roundsWithMatches.filter((r) => r.matches.length > 0 && r.matches.every((m) => m.status !== "scheduled"));
  return { courts, results };
}

/** Estimated clock time for a round, from the event's start time and round length --
 * a planned slot (like the Match Control tab's), not a live elapsed-time stamp, since
 * real events run ahead of or behind schedule. Returns null if the event has no
 * start time or round length set. */
function roundTimeRange(event, roundNumber) {
  if (!event.start_time || !event.round_minutes) return null;
  const [sh, sm] = event.start_time.split(":").map(Number);
  const startMins = sh * 60 + sm + (roundNumber - 1) * event.round_minutes;
  const endMins = startMins + event.round_minutes;
  const fmt = (mins) => {
    const h24 = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${h24 >= 12 ? "PM" : "AM"}`;
  };
  return `${fmt(startMins)} – ${fmt(endMins)}`;
}

function MatchRow({ byId, m, highlightId }) {
  const name = (id) => byId[id]?.display_name || "?";
  const involves = highlightId && [...m.team_a, ...m.team_b].includes(highlightId);
  return (
    <div className="court" style={{ outline: involves ? "3px solid #c8923e" : "none" }}>
      <div className="label">Court {m.court} &middot; {matchTypeLabel(m, byId)}</div>
      <div className="teams">
        <div className="team">{m.team_a.map(name).join(" & ")}</div>
        <div className="vs">VS</div>
        <div className="team" style={{ textAlign: "right" }}>{m.team_b.map(name).join(" & ")}</div>
      </div>
      {m.status === "cancelled" && <p className="note">Cancelled</p>}
      {m.status !== "scheduled" && m.status !== "cancelled" && <p className="match-score">{m.score_a}–{m.score_b}</p>}
    </div>
  );
}

function RoundCard({ round, event, byId, highlightId, badge }) {
  const timeRange = roundTimeRange(event, round.number);
  return (
    <div className="card round-card">
      <div className="round-card-head">
        <div>
          <div className="round-card-title">Round {round.number}</div>
          {timeRange && <div className="round-card-time">{timeRange}</div>}
        </div>
        <span className={`badge ${badge.color}`}>{badge.label}</span>
      </div>
      <div className="courts">{round.matches.map((m) => <MatchRow key={m.id} byId={byId} m={m} highlightId={highlightId} />)}</div>
    </div>
  );
}

/** One court's current or next match for the Playing now / Up next sections --
 * each court gets its own card since courts can legitimately be on different
 * round numbers once the organizer starts generating ahead (see courtStatus). */
function CourtMatchCard({ courtNum, match, event, byId, highlightId, badge }) {
  const name = (id) => byId[id]?.display_name || "?";
  if (!match) {
    return (
      <div className="court">
        <div className="label">Court {courtNum}</div>
        <p className="note">Free -- waiting for the next match.</p>
      </div>
    );
  }
  const involves = highlightId && [...match.team_a, ...match.team_b].includes(highlightId);
  const timeRange = roundTimeRange(event, match.roundNumber);
  return (
    <div className="court" style={{ outline: involves ? "3px solid #c8923e" : "none" }}>
      <div className="round-card-head" style={{ marginBottom: 6 }}>
        <div>
          <div className="label" style={{ marginBottom: 0 }}>Court {courtNum} &middot; Round {match.roundNumber}</div>
          {timeRange && <div className="round-card-time">{timeRange}</div>}
        </div>
        <span className={`badge ${badge.color}`}>{badge.label}</span>
      </div>
      <p className="note" style={{ margin: "0 0 6px" }}>{matchTypeLabel(match, byId)}</p>
      <div className="teams">
        <div className="team">{match.team_a.map(name).join(" & ")}</div>
        <div className="vs">VS</div>
        <div className="team" style={{ textAlign: "right" }}>{match.team_b.map(name).join(" & ")}</div>
      </div>
    </div>
  );
}

function LiveInner({ eventId }) {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("matches");
  const [lbTab, setLbTab] = useState("overall");
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!eventId) return;
    const reload = () => fetchFullEvent(eventId).then(setState);
    reload();
    return subscribeEvent(eventId, reload);
  }, [eventId]);

  // Must run before the early returns below -- calling useMemo after a conditional
  // return means it's skipped on the first (loading) render and called on the next
  // one, which violates the Rules of Hooks and crashes React with a hook-count
  // mismatch once real data arrives (minified error #310).
  const matched = useMemo(() => {
    if (!search.trim() || !state?.players) return null;
    return state.players.find((p) => p.display_name.toLowerCase().includes(search.trim().toLowerCase()));
  }, [search, state]);

  if (!eventId) return <div className="wrap"><div className="card">No event link -- ask the organizer for the QR code or link.</div></div>;
  if (state === null) return <div className="wrap"><div className="card">Loading...</div></div>;
  if (!state.event) return <div className="wrap"><div className="card">Event not found -- this link may be outdated. Ask the organizer for the current QR code or link.</div></div>;

  const { event, players, rounds, matches } = state;
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const roundsWithMatches = rounds.map((r) => ({ ...r, matches: matches.filter((m) => m.round_id === r.id) }));
  const { results, courts } = classify(roundsWithMatches);
  const activeIds = new Set(courts.flatMap((c) => (c.current ? [...c.current.team_a, ...c.current.team_b] : [])));
  const bench = players.filter((p) => p.attendance_status === "checked_in" && !activeIds.has(p.id)).map((p) => p.display_name);
  const courtsWithNext = courts.filter((c) => c.next);

  return (
    <div>
      <TopBar title={event.name} subtitle={event.ended ? "Event ended" : `Round ${rounds.length} \u00B7 Live board`} large />
      <div className="wrap participant">
        <div className="tabs" style={{ marginTop: 14 }}>
          <button className={tab === "matches" ? "active" : ""} onClick={() => setTab("matches")}>Matches</button>
          <button className={tab === "leaderboard" ? "active" : ""} onClick={() => setTab("leaderboard")}>Leaderboard</button>
          <button className={tab === "rules" ? "active" : ""} onClick={() => setTab("rules")}>Rules</button>
        </div>

        {tab === "matches" && (
          <>
            <div className="card">
              <input placeholder="Find your name..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "100%" }} />
              {matched && <p className="note">{matched.display_name} &middot; {matched.games_played} games &middot; {matched.point_diff > 0 ? "+" : ""}{matched.point_diff} pt diff</p>}
            </div>
            {courts.length > 0 && (
              <>
                <div className="section-title">Playing now</div>
                <div className="courts">
                  {courts.map((c) => (
                    <CourtMatchCard key={c.courtNum} courtNum={c.courtNum} match={c.current} event={event} byId={byId} highlightId={matched?.id} badge={{ label: "Live", color: "red" }} />
                  ))}
                </div>
                {bench.length > 0 && <div className="sitout">Resting: {bench.join(", ")}</div>}
              </>
            )}
            {courtsWithNext.length > 0 && (
              <>
                <div className="section-title">Up next</div>
                <div className="courts">
                  {courtsWithNext.map((c) => (
                    <CourtMatchCard key={c.courtNum} courtNum={c.courtNum} match={c.next} event={event} byId={byId} highlightId={matched?.id} badge={{ label: "Upcoming", color: "gray" }} />
                  ))}
                </div>
              </>
            )}
            {results.length > 0 && (
              <>
                <div className="section-title">Results</div>
                {[...results].reverse().map((r) => <RoundCard key={r.id} round={r} event={event} byId={byId} highlightId={matched?.id} badge={{ label: "Completed", color: "blue" }} />)}
              </>
            )}
          </>
        )}

        {tab === "leaderboard" && (
          <div className="card">
            <div className="tabs">
              <button className={lbTab === "female" ? "active" : ""} onClick={() => setLbTab("female")}>Queen</button>
              <button className={lbTab === "male" ? "active" : ""} onClick={() => setLbTab("male")}>King</button>
              <button className={lbTab === "overall" ? "active" : ""} onClick={() => setLbTab("overall")}>Overall</button>
            </div>
            <p className="note">Rankings are determined only by cumulative point differential. Wins and losses are shown for reference.</p>
            <table>
              <thead><tr><th>#</th><th>Player</th><th>W-L</th><th>+/-</th></tr></thead>
              <tbody>
                {leaderboardFor(players, lbTab).map((p, i) => (
                  <tr key={p.id}>
                    <td>{i + 1}</td><td>{p.display_name}{i === 0 && p.games_played > 0 && lbTab !== "overall" ? " \uD83D\uDC51" : ""}</td>
                    <td>{p.wins}-{p.losses}</td>
                    <td className={p.point_diff > 0 ? "diffpos" : p.point_diff < 0 ? "diffneg" : ""}>{p.point_diff > 0 ? "+" : ""}{p.point_diff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === "rules" && (
          <div className="card">
            <h2>How ranking works</h2>
            <p>Your point differential from every match is added together. Win 11-7: +4. Lose 8-11: -4. It all adds up across the event.</p>
            <h2>Awards</h2>
            <p>Highest male differential wins King of the Court. Highest female differential wins Queen of the Court. A first-place tie is settled by a singles tiebreaker.</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LivePage({ params }) {
  return <LiveInner eventId={params.eventId} />;
}
