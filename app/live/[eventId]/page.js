"use client";
import { useEffect, useMemo, useState } from "react";
import TopBar from "../../../components/TopBar";
import { fetchFullEvent, subscribeEvent } from "../../../lib/db";

function leaderboardFor(players, gender) {
  const list = gender === "overall" ? players : players.filter((p) => p.gender === gender);
  return [...list].sort((a, b) => b.point_diff - a.point_diff);
}

function classify(roundsWithMatches) {
  const results = roundsWithMatches.filter((r) => r.matches.every((m) => m.status !== "scheduled"));
  const notDone = roundsWithMatches.filter((r) => r.matches.some((m) => m.status === "scheduled"));
  const ongoing = notDone[0] || null;
  const upcoming = notDone.slice(1);
  return { results, ongoing, upcoming };
}

function MatchRow({ byId, m, highlightId }) {
  const name = (id) => byId[id]?.display_name || "?";
  const involves = highlightId && [...m.team_a, ...m.team_b].includes(highlightId);
  return (
    <div className="court" style={{ outline: involves ? "3px solid #c8923e" : "none" }}>
      <div className="label">Court {m.court}{m.division && <span> &middot; {m.division === "female" ? "Women's Doubles" : "Men's Doubles"}</span>}</div>
      <div className="teams">
        <div className="team">{m.team_a.map(name).join(" & ")}</div>
        <div className="vs">VS</div>
        <div className="team" style={{ textAlign: "right" }}>{m.team_b.map(name).join(" & ")}</div>
      </div>
      {m.status === "cancelled" && <p className="note">Cancelled</p>}
      {m.status !== "scheduled" && m.status !== "cancelled" && <p className="note">Final: {m.score_a}-{m.score_b}</p>}
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
  const { results, ongoing, upcoming } = classify(roundsWithMatches);
  const ongoingSitting = ongoing
    ? players.filter((p) => p.attendance_status === "checked_in" && !ongoing.matches.some((m) => [...m.team_a, ...m.team_b].includes(p.id))).map((p) => p.display_name)
    : [];

  return (
    <div>
      <TopBar title={event.name} subtitle={event.ended ? "Event ended" : `Round ${rounds.length} \u00B7 Live board`} />
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
            {ongoing && (
              <>
                <div className="round-title">PLAYING NOW -- ROUND {ongoing.number}</div>
                <div className="courts">{ongoing.matches.map((m) => <MatchRow key={m.id} byId={byId} m={m} highlightId={matched?.id} />)}</div>
                {ongoingSitting.length > 0 && <div className="sitout">Resting: {ongoingSitting.join(", ")}</div>}
              </>
            )}
            {upcoming.map((r) => (
              <div key={r.id}>
                <div className="round-title">UP NEXT -- ROUND {r.number}</div>
                <div className="courts">{r.matches.map((m) => <MatchRow key={m.id} byId={byId} m={m} highlightId={matched?.id} />)}</div>
              </div>
            ))}
            {[...results].reverse().map((r) => (
              <div key={r.id}>
                <div className="round-title">RESULTS -- ROUND {r.number}</div>
                <div className="courts">{r.matches.map((m) => <MatchRow key={m.id} byId={byId} m={m} highlightId={matched?.id} />)}</div>
              </div>
            ))}
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
