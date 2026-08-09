"use client";
import { useEffect, useState, useMemo, useRef } from "react";
import TopBar from "../../../components/TopBar";
import { fetchFullEvent, subscribeEvent, importRoster, addWalkIn, setAttendance, checkInAll, checkOutPlayer, startEvent, endEvent, deleteEvent, publishRound, submitScore, correctScore, cancelMatch } from "../../../lib/db";
import { generateDraft, swapPlayers, eligiblePlayers, matchTypeLabel } from "../../../lib/scheduler";

const ATT_LABEL = { not_arrived: "Not arrived", late: "Late", checked_in: "Checked in", temporarily_unavailable: "Temp. unavailable", no_show: "No-show", withdrawn: "Checked out" };
const ATT_COLOR = { not_arrived: "#8a8067", late: "#b58a2f", checked_in: "#2c6e3f", temporarily_unavailable: "#4C6E91", no_show: "#a83232", withdrawn: "#5b5142" };
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

function Pill({ children, color, style }) {
  return <span style={{ fontSize: 10, fontFamily: "monospace", background: color, color: "#F4EDE0", padding: "2px 6px", borderRadius: 10, textTransform: "uppercase", ...style }}>{children}</span>;
}

function leaderboardFor(players, gender) {
  const list = players.filter((p) => p.gender === gender);
  const sorted = [...list].sort((a, b) => b.point_diff - a.point_diff);
  const topDiff = sorted[0]?.point_diff;
  const anyPlayed = sorted[0]?.games_played > 0;
  const tied = anyPlayed ? sorted.filter((p) => p.point_diff === topDiff) : [];
  return { sorted, tied: tied.length > 1 ? tied : null };
}

/** Same math as capacityPreview() in app/admin/page.js, but returning numbers instead
 * of a sentence -- used for the Dashboard's capacity tiles, which need the raw figures
 * (planned rounds, planned matches, estimated games/player) to compare against actuals. */
function computeCapacity(event, registeredCount) {
  if (!event.start_time || !event.end_time) return null;
  const [sh, sm] = event.start_time.split(":").map(Number);
  const [eh, em] = event.end_time.split(":").map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  const roundMinutes = event.round_minutes || 20;
  const plannedRounds = Math.floor(mins / roundMinutes);
  const plannedMatches = plannedRounds * event.courts;
  const base = event.target_participants || registeredCount;
  const estGamesPerPlayer = base ? (plannedMatches * 4) / base : null;
  return { mins, roundMinutes, plannedRounds, plannedMatches, estGamesPerPlayer };
}

/** Audits the event's actual published/scored data (not a simulation) against the same
 * rules lib/scheduler.test.js checks against a synthetic run. History integrity and the
 * checked_in-only eligibility rule aren't included here -- attendance status is mutable
 * after the fact, so re-checking it retroactively would be misleading; those two are
 * covered by the automated suite (npm test) instead, which controls for that. */
function auditReport(players, roundsWithMatches) {
  const activeRounds = roundsWithMatches
    .map((r) => ({ ...r, matches: r.matches.filter((m) => m.status !== "cancelled") }))
    .filter((r) => r.matches.length > 0)
    .sort((a, b) => a.number - b.number);

  if (activeRounds.length === 0) return [];

  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const rows = [];

  // Partnerships and opponent-meetings are tracked per player-pair regardless of
  // match type (mirrors partner_ids/opponent_counts, which are flat, not split by
  // division) -- two people either partnered/faced each other or they didn't.
  const partnerPairs = new Map();
  activeRounds.forEach((r) => r.matches.forEach((m) => {
    [m.team_a, m.team_b].forEach(([p1, p2]) => {
      const key = [p1, p2].sort().join("|");
      partnerPairs.set(key, (partnerPairs.get(key) || 0) + 1);
    });
  }));
  const totalPartnerships = [...partnerPairs.values()].reduce((a, b) => a + b, 0);
  const repeatedPartnerships = [...partnerPairs.values()].filter((c) => c > 1).length;
  rows.push({
    rule: "No repeat partners",
    result: repeatedPartnerships === 0 ? "pass" : "warn",
    finding: repeatedPartnerships === 0
      ? `0 repeated partnerships across ${totalPartnerships} pairings.`
      : `${repeatedPartnerships} repeated partnership(s) across ${totalPartnerships} pairings -- expected only once the partner pool is exhausted (check the Event Log for that warning).`,
  });

  let backToBack = 0;
  for (let i = 1; i < activeRounds.length; i++) {
    const prevIds = new Set(activeRounds[i - 1].matches.flatMap((m) => [...m.team_a, ...m.team_b]));
    new Set(activeRounds[i].matches.flatMap((m) => [...m.team_a, ...m.team_b])).forEach((id) => { if (prevIds.has(id)) backToBack++; });
  }
  rows.push({
    rule: "Avoid back-to-back rounds",
    result: backToBack === 0 ? "pass" : "warn",
    finding: backToBack === 0 ? "No player appeared in two consecutive rounds." : `${backToBack} player-appearance(s) were back-to-back -- expected only when resting would drop the eligible pool below 4.`,
  });

  const played = players.filter((p) => p.games_played > 0);
  const counts = played.map((p) => p.games_played);
  // "Typical" = the most common games_played count, not min/max -- with attendance
  // changes (late arrivals, early checkouts) in the mix, mode is a much more honest
  // baseline than the raw spread for "what a fully-present player should have."
  const typical = counts.length
    ? [...counts.reduce((m, v) => m.set(v, (m.get(v) || 0) + 1), new Map()).entries()].sort((a, b) => b[1] - a[1])[0][0]
    : null;
  const outliers = typical == null ? [] : played.filter((p) => Math.abs(p.games_played - typical) > 1);
  // Currently checked_in players have no attendance-based excuse to be off-pace --
  // that's a real balance problem worth failing on. Anyone else (late, withdrawn,
  // temporarily_unavailable, no_show) plausibly missed rounds for a legitimate
  // reason, so it's downgraded to a warning naming them, not a failure.
  const unexplained = outliers.filter((p) => p.attendance_status === "checked_in");
  const explained = outliers.filter((p) => p.attendance_status !== "checked_in");
  const describe = (p) => `${p.display_name} (${p.games_played}, ${ATT_LABEL[p.attendance_status]})`;
  const findingParts = [];
  if (unexplained.length) findingParts.push(`${unexplained.length} currently checked-in player(s) more than 1 game off the typical ${typical} with no attendance explanation: ${unexplained.map(describe).join(", ")}`);
  if (explained.length) findingParts.push(`${explained.length} more off-pace but explained by attendance status: ${explained.map(describe).join(", ")}`);
  rows.push({
    rule: "Balance games played",
    result: !counts.length ? "n/a" : unexplained.length ? "fail" : explained.length ? "warn" : "pass",
    finding: !counts.length ? "No scored games yet." : findingParts.length ? findingParts.join(" -- ") : `All ${played.length} players who've played are within 1 game of the typical ${typical}.`,
  });

  // Opponent-meetings are global too, for the same reason as partnerships above --
  // and mixed doubles gives everyone a bigger pool of possible opponents to draw
  // from than strict segregation did, so this isn't split by division anymore.
  let totalOpponentPairs = 0;
  const opponentSeen = new Map();
  activeRounds.forEach((r) => r.matches.forEach((m) => {
    m.team_a.forEach((a) => m.team_b.forEach((b) => {
      totalOpponentPairs++;
      const key = [a, b].sort().join("|");
      opponentSeen.set(key, (opponentSeen.get(key) || 0) + 1);
    }));
  }));
  const repeatedOpponents = [...opponentSeen.values()].filter((c) => c > 1).length;
  rows.push({
    rule: "Minimize repeat opponents",
    result: totalOpponentPairs === 0 ? "n/a" : repeatedOpponents / totalOpponentPairs < 0.2 ? "pass" : "warn",
    finding: totalOpponentPairs === 0 ? "No matches yet." : `${repeatedOpponents} repeated opponent pairing(s) out of ${totalOpponentPairs}.`,
  });

  const avg = (arr) => (arr.length ? arr.reduce((s, p) => s + p.games_played, 0) / arr.length : 0);
  const womenPlayed = played.filter((p) => p.gender === "female");
  const menPlayed = played.filter((p) => p.gender === "male");
  rows.push({
    rule: "Pacing between genders",
    result: !womenPlayed.length || !menPlayed.length ? "n/a" : Math.abs(avg(womenPlayed) - avg(menPlayed)) < 1 ? "pass" : "warn",
    finding: !womenPlayed.length || !menPlayed.length ? "Need games for both genders to compare pacing." : `Average games played: ${avg(womenPlayed).toFixed(1)} (women) vs ${avg(menPlayed).toFixed(1)} (men).`,
  });

  return rows;
}

const AUDIT_BADGE = { pass: "green", warn: "amber", fail: "red", "n/a": "gray" };

function AdminInner({ eventId }) {
  const [state, setState] = useState(null); // {event, players, rounds, matches}
  const [tab, setTab] = useState("dashboard");
  const [draft, setDraft] = useState(null); // {matches, sitting, warnings, roundNumber}
  const [genError, setGenError] = useState("");
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);

  const reload = () => eventId && fetchFullEvent(eventId).then(setState);

  useEffect(() => { reload(); }, [eventId]);
  useEffect(() => {
    if (!eventId) return;
    return subscribeEvent(eventId, reload);
  }, [eventId]);
  useEffect(() => { setOrigin(window.location.origin); }, []);

  if (!eventId) return <div className="wrap"><div className="card">Missing event -- open this page from the Event Manager.</div></div>;
  if (state === null) return <div className="wrap"><div className="card">Loading...</div></div>;
  if (!state.event) return (
    <div className="wrap">
      <div className="card">
        <p>Event not found -- it may have been deleted.</p>
        <button onClick={() => { window.location.href = BASE_PATH + "/admin"; }}>Back to Event Manager</button>
      </div>
    </div>
  );

  const { event, players, rounds, matches } = state;
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const roundsWithMatches = rounds.map((r) => ({ ...r, matches: matches.filter((m) => m.round_id === r.id) }));
  const lastPublished = roundsWithMatches[roundsWithMatches.length - 1];
  const justPlayedIds = lastPublished ? new Set(lastPublished.matches.flatMap((m) => [...m.team_a, ...m.team_b])) : new Set();
  const checkedInCount = players.filter((p) => p.attendance_status === "checked_in").length;
  const completedRoundsCount = roundsWithMatches.filter((r) => r.matches.every((m) => m.status !== "scheduled")).length;
  const capacity = computeCapacity(event, players.length);
  const auditRows = auditReport(players, roundsWithMatches);
  const participantUrl = `${origin}${BASE_PATH}/live/${eventId}`;

  const { pool: eligiblePool } = eligiblePlayers(players, new Set(), justPlayedIds);
  const eligibleFemale = eligiblePool.filter((p) => p.gender === "female").length;
  const eligibleMale = eligiblePool.filter((p) => p.gender === "male").length;

  const generate = async () => {
    setGenError(""); setBusy(true);
    try {
      const roundNumber = rounds.length + 1;
      const res = generateDraft(players, event.courts, roundNumber, new Set(), justPlayedIds);
      if (res.error) { setGenError(res.error); return; }
      setDraft(res);
    } finally {
      setBusy(false);
    }
  };

  // Must not let a Supabase failure (e.g. a schema mismatch) leave busy stuck true
  // forever with no explanation -- that reads as "generation just doesn't work."
  // The draft is left in place on failure so nothing generated is lost; Cancel
  // draft is always available as an escape hatch regardless of busy state.
  const publish = async () => {
    setGenError(""); setBusy(true);
    try {
      await publishRound(eventId, draft.roundNumber, draft.matches, players);
      setDraft(null);
      reload();
    } catch (err) {
      setGenError(`Publish failed: ${err.message || err}. The draft is unchanged -- fix the issue and try again, or cancel the draft.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <TopBar
        title={event.name}
        subtitle={`${event.ended ? "EVENT ENDED" : event.started_at ? `LIVE \u00B7 ROUND ${rounds.length}` : "NOT STARTED"} \u00B7 ${event.courts} courts`}
        linkHome
      />
      <div className="layout">
        <aside>
          <div className="event-card">
            <strong>{event.name}</strong>
            <div className="small">{checkedInCount}/{players.length} checked in</div>
          </div>
          <div className="nav">
            {["dashboard", "registrants", "checkin", "match", "scores", "leaderboard", "log"].map((t) => (
              <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)} style={{ textTransform: "capitalize" }}>
                {t === "checkin" ? "Check-in" : t === "match" ? "Match Control" : t === "log" ? "Event Log" : t}
              </button>
            ))}
          </div>
        </aside>
        <main>

        {tab === "dashboard" && (
          <>
            <div className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div>
                  <p style={{ margin: 0 }}><strong>{checkedInCount}</strong> checked in / {players.length} registered</p>
                  <p className="note">Round {rounds.length} published &middot; {matches.filter((m) => m.status === "scheduled").length} matches awaiting a score</p>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {!event.started_at && !event.ended && <button onClick={() => startEvent(eventId).then(reload)}>Start event</button>}
                  {event.started_at && !event.ended && <button className="secondary" onClick={() => endEvent(eventId).then(reload)}>End event</button>}
                </div>
              </div>
            </div>

            <div className="grid metrics">
              <div className="card"><div className="small">Participant target</div><div className="metric">{event.target_participants ?? "--"}</div></div>
              <div className="card"><div className="small">Registered</div><div className="metric">{players.length}</div></div>
              <div className="card"><div className="small">Checked in</div><div className="metric">{checkedInCount}</div></div>
              <div className="card"><div className="small">Completed rounds</div><div className="metric">{completedRoundsCount}/{capacity ? capacity.plannedRounds : rounds.length}</div></div>
              <div className="card"><div className="small">Event duration</div><div className="metric">{capacity ? `${capacity.mins} min` : "--"}</div></div>
              <div className="card"><div className="small">Courts occupied</div><div className="metric">{event.courts}</div></div>
              <div className="card"><div className="small">{capacity ? `${capacity.roundMinutes}-minute rounds` : "Planned rounds"}</div><div className="metric">{capacity ? capacity.plannedRounds : "--"}</div></div>
              <div className="card"><div className="small">Est. games / player (full event)</div><div className="metric">{capacity?.estGamesPerPlayer != null ? capacity.estGamesPerPlayer.toFixed(1) : "--"}</div></div>
            </div>

            <div className="card">
              <h2>Participant URL</h2>
              <p className="note">Unique read-only link for this event -- no login, no self check-in.</p>
              <div className="row">
                <input readOnly value={participantUrl} onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} />
                <button className="small secondary" onClick={() => { navigator.clipboard.writeText(participantUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied!" : "Copy participant link"}</button>
                <button className="small" onClick={() => window.open(`${BASE_PATH}/live/${eventId}`, "_blank", "noopener,noreferrer")}>Open participant view</button>
              </div>
            </div>

            <div className="card">
              <h2>Leaders (provisional)</h2>
              {["male", "female"].map((g) => {
                const { sorted, tied } = leaderboardFor(players, g);
                const top = sorted[0];
                return (
                  <p key={g}>
                    {g === "male" ? "King" : "Queen"}: {top && top.games_played > 0 ? `${top.display_name} +${top.point_diff}${tied ? " (tied)" : ""}` : "no games played yet"}
                  </p>
                );
              })}
            </div>

            <div className="card">
              <h2>Algorithm audit</h2>
              <p className="note">Checks the actual published/scored matches against the matchmaking rules -- not a simulation.</p>
              {auditRows.length === 0 ? (
                <p className="note">Publish and play at least one round to see an audit.</p>
              ) : (
                <div className="tablewrap">
                  <table>
                    <thead><tr><th>Rule</th><th>Result</th><th>Finding</th></tr></thead>
                    <tbody>
                      {auditRows.map((r, i) => (
                        <tr key={i}>
                          <td>{r.rule}</td>
                          <td><span className={`badge ${AUDIT_BADGE[r.result]}`}>{r.result}</span></td>
                          <td className="small">{r.finding}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="note" style={{ marginTop: 8 }}>History integrity and the checked-in-only eligibility rule are covered separately by the automated regression suite (<code>npm test</code>), not this live audit.</p>
            </div>

            <div className="card" style={{ borderColor: "#efc3c0" }}>
              <h2 style={{ color: "#993d38" }}>Danger zone</h2>
              <p className="note">Deletes this event and everything in it -- players, rounds, matches, scores, logs. Cannot be undone.</p>
              <button className="secondary" style={{ color: "#993d38", borderColor: "#efc3c0" }} onClick={async () => {
                if (!confirm(`Delete "${event.name}" and everything in it? This can't be undone.`)) return;
                await deleteEvent(eventId);
                window.location.href = BASE_PATH + "/admin";
              }}>Delete event</button>
            </div>
          </>
        )}

        {tab === "registrants" && <RegistrantsPanel eventId={eventId} players={players} reload={reload} />}

        {tab === "checkin" && <CheckinPanel eventId={eventId} players={players} matches={matches} roundsWithMatches={roundsWithMatches} reload={reload} />}

        {tab === "match" && (
          <MatchControlPanel
            draft={draft} setDraft={setDraft} genError={genError} busy={busy}
            generate={generate} publish={publish} byId={byId}
            roundsWithMatches={roundsWithMatches} rounds={rounds}
            eligibleFemale={eligibleFemale} eligibleMale={eligibleMale}
            eventId={eventId} players={players} reload={reload}
          />
        )}

        {tab === "scores" && <ScoresPanel roundsWithMatches={roundsWithMatches} byId={byId} players={players} reload={reload} />}

        {tab === "leaderboard" && <LeaderboardPanel players={players} />}

        {tab === "log" && <LogPanel logs={state.logs || []} />}
        </main>
      </div>
    </div>
  );
}

function downloadCsvTemplate() {
  const csv = "First,Surname,Nickname,Gender,Level\nAna,Santos,,F,3.5\nMiguel,Torres,,M,4.0\n";
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "casa-court-registrant-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function parseCsvText(text) {
  const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
  // Skip a header row if it looks like one (starts with "first" case-insensitive)
  const dataLines = lines[0]?.toLowerCase().startsWith("first") ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const [firstName = "", lastName = "", nickname = "", gender = "F", level = ""] = line.split(",").map((s) => s.trim());
    return { firstName, lastName, nickname, gender: gender.toUpperCase().startsWith("M") ? "M" : "F", level };
  });
}

function RegistrantsPanel({ eventId, players, reload }) {
  const [rows, setRows] = useState([{ firstName: "", lastName: "", nickname: "", gender: "F", level: "" }]);
  const [bulk, setBulk] = useState("");
  const fileInputRef = useRef(null);

  const handleFile = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseCsvText(e.target.result);
      setRows([...rows.filter((r) => r.firstName), ...parsed]);
    };
    reader.readAsText(file);
  };

  return (
    <>
      <div className="card">
        <h2>Import roster</h2>
        <p className="note">Paste CSV rows, or upload a CSV file directly -- either way, review below before saving.</p>
        <div className="row">
          <button className="small secondary" onClick={downloadCsvTemplate}>Download CSV template</button>
          <button className="small secondary" onClick={() => fileInputRef.current?.click()}>Upload CSV</button>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ""; }} />
        </div>
        <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder="Or paste rows here: First,Surname,Nickname,Gender,Level" style={{ minHeight: 90, width: "100%", marginTop: 10 }} />
        <div className="row">
          <button className="small secondary" onClick={() => {
            setRows([...rows.filter((r) => r.firstName), ...parseCsvText(bulk)]);
            setBulk("");
          }}>Parse into rows below</button>
        </div>
        <div style={{ display: "grid", gap: 6, marginTop: 10, maxHeight: 260, overflowY: "auto" }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 56px 56px 24px", gap: 6 }}>
              <input placeholder="First" value={r.firstName} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, firstName: e.target.value } : x))} />
              <input placeholder="Surname" value={r.lastName} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, lastName: e.target.value } : x))} />
              <input placeholder="Nickname" value={r.nickname} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, nickname: e.target.value } : x))} />
              <select value={r.gender} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, gender: e.target.value } : x))}><option value="F">F</option><option value="M">M</option></select>
              <input type="number" step="0.5" placeholder="Lvl" value={r.level} onChange={(e) => setRows(rows.map((x, idx) => idx === i ? { ...x, level: e.target.value } : x))} />
              <button onClick={() => setRows(rows.filter((_, idx) => idx !== i))} style={{ background: "none", border: "none", color: "#b74742", cursor: "pointer" }}>&times;</button>
            </div>
          ))}
        </div>
        <div className="row">
          <button className="small secondary" onClick={() => setRows([...rows, { firstName: "", lastName: "", nickname: "", gender: "F", level: "" }])}>Add row</button>
          <button onClick={async () => { await importRoster(eventId, rows); setRows([{ firstName: "", lastName: "", nickname: "", gender: "F", level: "" }]); reload(); }}>Save {rows.filter((r) => r.firstName).length} to roster</button>
        </div>
      </div>

      <div className="card">
        <h2>Registrants ({players.length})</h2>
        <div className="tablewrap">
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Gender</th><th>Level</th><th>Games</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {players.map((p, i) => (
                <tr key={p.id}>
                  <td className="small">KQ-{String(i + 1).padStart(3, "0")}</td>
                  <td><strong>{p.display_name}</strong> <span className="small">({p.first_name} {p.last_name})</span></td>
                  <td>{p.gender === "female" ? "F" : "M"}</td>
                  <td>{p.level ?? "--"}</td>
                  <td>{p.games_played}</td>
                  <td>{p.registration_status === "walk_in" ? "Walk-in" : "Registered"}</td>
                  <td><span className="badge gray">{ATT_LABEL[p.attendance_status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: 8 }}>LEVEL RATING IS ORGANIZER-ONLY -- NEVER SHOWN ON THE LIVE BOARD. Check people in from the Check-in tab once they arrive.</p>
      </div>
    </>
  );
}

function CheckinPanel({ eventId, players, matches, roundsWithMatches, reload }) {
  const [walkIn, setWalkIn] = useState({ firstName: "", lastName: "", nickname: "", gender: "F", level: "" });
  const checkedInCount = players.filter((p) => p.attendance_status === "checked_in").length;
  const pendingCount = players.filter((p) => p.attendance_status === "not_arrived" || p.attendance_status === "late").length;

  return (
    <>
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
          <h2 style={{ flex: 1 }}>Check-in ({checkedInCount}/{players.length})</h2>
          <button className="small" disabled={!pendingCount} onClick={() => checkInAll(eventId, players).then(reload)}>Check in all</button>
        </div>
        <div className="tablewrap">
          <table>
            <thead><tr><th>ID</th><th>Name</th><th>Gender</th><th>Status</th><th>Games</th><th>Actions</th></tr></thead>
            <tbody>
              {players.map((p, i) => (
                <tr key={p.id}>
                  <td className="small">KQ-{String(i + 1).padStart(3, "0")}</td>
                  <td>
                    <strong>{p.display_name}</strong>
                    {p.registration_status === "walk_in" && <Pill color="#c8923e" style={{ marginLeft: 6 }}>Walk-in</Pill>}
                  </td>
                  <td>{p.gender === "female" ? "F" : "M"}</td>
                  <td style={{ color: ATT_COLOR[p.attendance_status], fontWeight: 800 }}>
                    {ATT_LABEL[p.attendance_status]}{p.attendance_status === "late" && p.eta_note ? `: ${p.eta_note}` : ""}
                  </td>
                  <td>{p.games_played}</td>
                  <td>
                    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <button className="small" disabled={p.attendance_status === "checked_in"} onClick={() => setAttendance(eventId, p.id, p.display_name, "checked_in").then(reload)}>Check in</button>
                      <button className="small secondary" disabled={p.attendance_status === "late"} onClick={() => { const note = prompt("ETA for " + p.display_name, p.eta_note) || ""; setAttendance(eventId, p.id, p.display_name, "late", note).then(reload); }}>Late</button>
                      <button className="small secondary" disabled={p.attendance_status === "temporarily_unavailable"} onClick={() => setAttendance(eventId, p.id, p.display_name, "temporarily_unavailable").then(reload)}>Unavailable</button>
                      <button className="small secondary" disabled={p.attendance_status === "no_show"} onClick={() => setAttendance(eventId, p.id, p.display_name, "no_show").then(reload)}>No-show</button>
                      <button className="small secondary" disabled={p.attendance_status === "not_arrived"} onClick={() => setAttendance(eventId, p.id, p.display_name, "not_arrived").then(reload)}>Reset</button>
                      <button className="small secondary" disabled={p.attendance_status === "withdrawn"} onClick={() => {
                        const hasPending = matches.some((m) => m.status === "scheduled" && [...m.team_a, ...m.team_b].includes(p.id));
                        if (hasPending && !confirm(`${p.display_name} has a match in progress on their court. Checking out will cancel that match. Continue?`)) return;
                        checkOutPlayer(eventId, p, matches, players, roundsWithMatches).then(reload);
                      }}>Check out</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 56px 56px auto", gap: 6, alignItems: "center", marginTop: 12 }}>
          <input placeholder="First" value={walkIn.firstName} onChange={(e) => setWalkIn({ ...walkIn, firstName: e.target.value })} />
          <input placeholder="Surname" value={walkIn.lastName} onChange={(e) => setWalkIn({ ...walkIn, lastName: e.target.value })} />
          <input placeholder="Nickname" value={walkIn.nickname} onChange={(e) => setWalkIn({ ...walkIn, nickname: e.target.value })} />
          <select value={walkIn.gender} onChange={(e) => setWalkIn({ ...walkIn, gender: e.target.value })}><option value="F">F</option><option value="M">M</option></select>
          <input type="number" step="0.5" placeholder="Lvl" value={walkIn.level} onChange={(e) => setWalkIn({ ...walkIn, level: e.target.value })} />
          <button className="small secondary" onClick={async () => {
            if (!walkIn.firstName.trim()) return;
            await addWalkIn(eventId, walkIn);
            setWalkIn({ firstName: "", lastName: "", nickname: "", gender: "F", level: "" });
            reload();
          }}>Add walk-in</button>
        </div>
      </div>
    </>
  );
}

function LogPanel({ logs }) {
  return (
    <div className="card">
      <h2>Event log ({logs.length})</h2>
      {logs.length === 0 && <p className="note">Nothing logged yet.</p>}
      {logs.map((l) => (
        <div key={l.id} className="matchrow">
          <strong>{l.message}</strong>
          <div className="small">{new Date(l.created_at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}

function MatchCard({ byId, match, editable, onScore, draft, onCancel }) {
  const [a, setA] = useState(match.score_a ?? "");
  const [b, setB] = useState(match.score_b ?? "");
  const [timeExpired, setTimeExpired] = useState(false);
  const name = (id) => byId[id]?.display_name || "?";
  return (
    <div className="court" style={{ borderLeft: draft ? "4px solid #5d73c7" : "4px solid #c8923e" }}>
      <div className="label">Court {match.court} &middot; {matchTypeLabel(match, byId)}</div>
      <div className="teams">
        <div className="team">{match.team_a.map(name).join(" & ")}</div>
        <div className="vs">VS</div>
        <div className="team" style={{ textAlign: "right" }}>{match.team_b.map(name).join(" & ")}</div>
      </div>
      {editable && match.status === "scheduled" && (
        <>
          <div className="scorerow">
            <input type="number" min={0} value={a} onChange={(e) => setA(e.target.value)} />
            <span className="vs">-</span>
            <input type="number" min={0} value={b} onChange={(e) => setB(e.target.value)} />
            <button className="small" onClick={() => {
              const sa = parseInt(a), sb = parseInt(b);
              if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0 || (sa === 0 && sb === 0)) return;
              onScore(sa, sb, timeExpired ? "time_expired" : "completed");
            }}>Save score</button>
          </div>
          <label className="small" style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 6 }}>
            <input type="checkbox" checked={timeExpired} onChange={(e) => setTimeExpired(e.target.checked)} />
            Time expired mid-game (score stands as entered, not a completed game)
          </label>
        </>
      )}
      {match.status === "scheduled" && onCancel && (
        <button className="small secondary" style={{ marginTop: 8, color: "#993d38" }} onClick={onCancel}>Cancel match</button>
      )}
      {match.status === "cancelled" && <p className="note">Cancelled</p>}
      {match.status !== "scheduled" && match.status !== "cancelled" && <p className="note">Final: {match.score_a}-{match.score_b} ({match.status.replace("_", " ")})</p>}
    </div>
  );
}

/** The oldest published round that still has an unscored match ("ongoing"), plus
 * every published round after it ("upcoming") -- same definition the participant
 * board uses for Playing now / Up next, reused here so Match Control's idea of
 * "current" and "next" per court matches what participants actually see. */
function classifyRounds(roundsWithMatches) {
  const sorted = [...roundsWithMatches].sort((a, b) => a.number - b.number);
  const notDone = sorted.filter((r) => r.matches.some((m) => m.status === "scheduled"));
  return { ongoing: notDone[0] || null, upcoming: notDone.slice(1) };
}

/** Per-court status must be checked per court, not borrowed from whether the round
 * as a whole is done -- a round can have one court already scored while its other
 * courts are still in progress, and that finished court is genuinely free even
 * though its round isn't "done" yet. Walks this court's matches across every
 * published round in order and takes the still-scheduled ones: the earliest is
 * "current," the one after that (if a later round is already published for this
 * court) is "next." */
function courtStatus(roundsWithMatches, courtNum) {
  const sorted = [...roundsWithMatches].sort((a, b) => a.number - b.number);
  const scheduled = sorted
    .flatMap((r) => r.matches.filter((m) => m.court === courtNum && m.status === "scheduled").map((m) => ({ ...m, roundNumber: r.number })));
  return { current: scheduled[0] || null, next: scheduled[1] || null };
}

function CourtStatusBoard({ roundsWithMatches, byId, eventId }) {
  const numCourts = Math.max(0, ...roundsWithMatches.flatMap((r) => r.matches.map((m) => m.court)));
  if (numCourts === 0) return null;
  const name = (id) => byId[id]?.display_name || "?";

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <h2 style={{ flex: 1 }}>Court status</h2>
        <button className="small secondary" onClick={() => window.open(`${BASE_PATH}/live/${eventId}`, "_blank", "noopener,noreferrer")}>Open participant view</button>
      </div>
      <p className="note" style={{ marginBottom: 10 }}>What's on each court right now, and what's already queued up next -- so a court doesn't have to sit idle waiting for the others to finish. Generate and publish the next round early to get it queued here.</p>
      <div className="courts">
        {Array.from({ length: numCourts }, (_, i) => i + 1).map((courtNum) => {
          const { current, next } = courtStatus(roundsWithMatches, courtNum);
          return (
            <div key={courtNum} className="court">
              <div className="label">Court {courtNum}</div>
              {current ? (
                <>
                  <p className="small" style={{ margin: "4px 0" }}>Now &middot; Round {current.roundNumber} &middot; {matchTypeLabel(current, byId)}</p>
                  <div className="teams" style={{ fontSize: 14 }}>
                    <div className="team">{current.team_a.map(name).join(" & ")}</div>
                    <div className="vs">VS</div>
                    <div className="team" style={{ textAlign: "right" }}>{current.team_b.map(name).join(" & ")}</div>
                  </div>
                </>
              ) : <p className="note">Free -- nothing scheduled on this court right now.</p>}
              {next ? (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed var(--line)" }}>
                  <p className="small" style={{ margin: "0 0 4px", color: "var(--gold)", fontWeight: 700 }}>Next &middot; Round {next.roundNumber}</p>
                  <div className="teams" style={{ fontSize: 13 }}>
                    <div className="team">{next.team_a.map(name).join(" & ")}</div>
                    <div className="vs">VS</div>
                    <div className="team" style={{ textAlign: "right" }}>{next.team_b.map(name).join(" & ")}</div>
                  </div>
                </div>
              ) : <p className="note" style={{ marginTop: 8 }}>Nothing queued yet for this court.</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MatchControlPanel({ draft, setDraft, genError, busy, generate, publish, byId, roundsWithMatches, rounds, eligibleFemale, eligibleMale, eventId, players, reload }) {
  const cancelMatchWithConfirm = (m) => {
    const names = [...m.team_a, ...m.team_b].map((id) => byId[id]?.display_name).join(", ");
    const reason = prompt(`Cancel Court ${m.court} (${names})? This can't be undone from the app.\n\nOptional reason (shown in the Event Log):`, "");
    if (reason === null) return; // cancelled the prompt itself
    cancelMatch(eventId, m, players, roundsWithMatches, reason).then(reload);
  };
  const { ongoing, upcoming } = classifyRounds(roundsWithMatches);
  const ongoingPendingCount = ongoing ? ongoing.matches.filter((m) => m.status === "scheduled").length : 0;
  const showGenerateAheadNudge = ongoingPendingCount > 0 && upcoming.length === 0;
  return (
    <>
      <CourtStatusBoard roundsWithMatches={roundsWithMatches} byId={byId} eventId={eventId} />

      <div className="card">
        <h2>Round generation</h2>
        {!draft && showGenerateAheadNudge && (
          <div className="warn-box">
            Round {ongoing.number} still has {ongoingPendingCount} match{ongoingPendingCount === 1 ? "" : "es"} in progress -- you can generate and publish the next round now so courts don't sit idle when they finish. It'll show up in Court status above as each court's "Next."
          </div>
        )}
        {!draft && <p className="note" style={{ marginBottom: 10 }}>{eligibleFemale} women, {eligibleMale} men eligible this round ({eligibleFemale + eligibleMale} total). Matchmaking is gender-blind -- anyone can be partnered with or matched against anyone, based on balance, rest, and never repeating a partner.</p>}
        {draft ? (
          <>
            <p className="note" style={{ fontFamily: "monospace", color: "#4C6E91" }}>DRAFT -- ROUND {draft.roundNumber} -- NOT PUBLISHED</p>
            {draft.warnings.map((w, i) => <div key={i} className="warn-box">{w}</div>)}
            <div className="courts">
              {draft.matches.map((m) => <MatchCard key={m.court} byId={byId} match={m} draft editable={false} />)}
            </div>
            {draft.sitting.length > 0 && <div className="sitout">Sitting: {draft.sitting.map((id) => byId[id]?.display_name).join(", ")}</div>}
            <div className="row">
              <button className="secondary" onClick={generate} disabled={busy}>Regenerate</button>
              <button onClick={publish} disabled={busy}>Publish round {draft.roundNumber}</button>
              <button className="secondary" onClick={() => setDraft(null)}>Cancel draft</button>
            </div>
            <p className="note">Manual swap: not built into this UI yet -- regenerate re-runs the optimizer if a draft looks off.</p>
          </>
        ) : (
          <button onClick={generate} disabled={busy}>Generate draft round {rounds.length + 1}</button>
        )}
        {genError && <div className="error-box">{genError}</div>}
      </div>

      {[...roundsWithMatches].reverse().map((r) => (
        <div key={r.id}>
          <div className="round-title">PUBLISHED -- ROUND {r.number}</div>
          <div className="courts">{r.matches.map((m) => <MatchCard key={m.id} byId={byId} match={m} editable={false} onCancel={() => cancelMatchWithConfirm(m)} />)}</div>
        </div>
      ))}
    </>
  );
}

function CorrectableMatchCard({ byId, match, players, reload }) {
  const [editing, setEditing] = useState(false);
  const [a, setA] = useState(match.score_a);
  const [b, setB] = useState(match.score_b);
  const name = (id) => byId[id]?.display_name || "?";
  const save = () => {
    const sa = parseInt(a), sb = parseInt(b);
    if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0 || (sa === 0 && sb === 0)) return;
    if (sa === match.score_a && sb === match.score_b) { setEditing(false); return; }
    correctScore(match, match.score_a, match.score_b, sa, sb, players).then(() => { setEditing(false); reload(); });
  };
  return (
    <div className="court">
      <div className="label">Court {match.court} &middot; {matchTypeLabel(match, byId)}</div>
      <div className="teams">
        <div className="team">{match.team_a.map(name).join(" & ")}</div>
        <div className="vs">VS</div>
        <div className="team" style={{ textAlign: "right" }}>{match.team_b.map(name).join(" & ")}</div>
      </div>
      {!editing ? (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "nowrap" }}>
          <p className="match-score" style={{ margin: 0 }}>{match.score_a}-{match.score_b}{match.status === "time_expired" ? " (time expired)" : ""}</p>
          <button className="small secondary" onClick={() => { setA(match.score_a); setB(match.score_b); setEditing(true); }}>Edit score</button>
        </div>
      ) : (
        <div className="scorerow">
          <input type="number" min={0} value={a} onChange={(e) => setA(e.target.value)} />
          <span className="vs">-</span>
          <input type="number" min={0} value={b} onChange={(e) => setB(e.target.value)} />
          <button className="small" onClick={save}>Save correction</button>
          <button className="small secondary" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function ScoresPanel({ roundsWithMatches, byId, players, reload }) {
  const pending = roundsWithMatches.flatMap((r) => r.matches.filter((m) => m.status === "scheduled").map((m) => ({ ...m, roundNumber: r.number })));
  const scoredRounds = [...roundsWithMatches]
    .map((r) => ({ ...r, matches: r.matches.filter((m) => m.status !== "scheduled" && m.status !== "cancelled") }))
    .filter((r) => r.matches.length > 0)
    .reverse();

  // What's already queued for this same court in a later published round, if any --
  // so scoring this match and freeing the court doesn't mean checking Match Control
  // separately to know who's up next on it.
  const nextOnCourt = (m) => {
    const later = roundsWithMatches.filter((r) => r.number > m.roundNumber).sort((a, b) => a.number - b.number);
    for (const r of later) {
      const nm = r.matches.find((mm) => mm.court === m.court);
      if (nm) return { match: nm, roundNumber: r.number };
    }
    return null;
  };
  const name = (id) => byId[id]?.display_name || "?";

  return (
    <>
      <div className="card">
        <h2>Pending scores ({pending.length})</h2>
        {pending.length === 0 && <p className="note">All caught up.</p>}
        <div className="courts">
          {pending.map((m) => {
            const next = nextOnCourt(m);
            return (
              <div key={m.id}>
                <p className="note" style={{ marginBottom: 2 }}>Round {m.roundNumber}</p>
                <MatchCard byId={byId} match={m} editable onScore={(a, b, status) => submitScore(m, a, b, players, status).then(reload)} />
                {next && (
                  <p className="note" style={{ marginTop: 4 }}>
                    Once scored, Court {m.court} is next up for Round {next.roundNumber}: {next.match.team_a.map(name).join(" & ")} vs {next.match.team_b.map(name).join(" & ")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h2>Completed matches ({scoredRounds.reduce((n, r) => n + r.matches.length, 0)})</h2>
        <p className="note" style={{ marginBottom: 10 }}>Wrong score entered? Click "Edit score" -- stats are reversed and reapplied, and it's logged.</p>
        {scoredRounds.length === 0 && <p className="note">No scored matches yet.</p>}
        {scoredRounds.map((r) => (
          <div key={r.id}>
            <div className="round-title">ROUND {r.number}</div>
            <div className="courts">{r.matches.map((m) => <CorrectableMatchCard key={m.id} byId={byId} match={m} players={players} reload={reload} />)}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function LeaderboardPanel({ players }) {
  const [g, setG] = useState("female");
  const { sorted, tied } = leaderboardFor(players, g);
  return (
    <div className="card">
      <div className="tabs">
        <button className={g === "female" ? "active" : ""} onClick={() => setG("female")}>Queen (F)</button>
        <button className={g === "male" ? "active" : ""} onClick={() => setG("male")}>King (M)</button>
      </div>
      {tied && <div className="warn-box">Tied for the top: {tied.map((p) => p.display_name).join(", ")} -- resolve with a singles tiebreaker at event close.</div>}
      <table>
        <thead><tr><th>#</th><th>Player</th><th>W-L</th><th>+/-</th></tr></thead>
        <tbody>
          {sorted.map((p, i) => (
            <tr key={p.id}>
              <td>{i + 1}</td><td>{p.display_name}</td><td>{p.wins}-{p.losses}</td>
              <td className={p.point_diff > 0 ? "diffpos" : p.point_diff < 0 ? "diffneg" : ""}>{p.point_diff > 0 ? "+" : ""}{p.point_diff}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminEventPage({ params }) {
  return <AdminInner eventId={params.eventId} />;
}
