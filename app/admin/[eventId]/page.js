"use client";
import { useEffect, useState, useMemo, useRef } from "react";
import TopBar from "../../../components/TopBar";
import { fetchFullEvent, subscribeEvent, importRoster, addWalkIn, setAttendance, checkInAll, checkOutPlayer, startEvent, endEvent, deleteEvent, publishRound, submitScore, correctScore } from "../../../lib/db";
import { generateDraft, swapPlayers, suggestCourtSplit } from "../../../lib/scheduler";

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

function AdminInner({ eventId }) {
  const [state, setState] = useState(null); // {event, players, rounds, matches}
  const [tab, setTab] = useState("dashboard");
  const [draft, setDraft] = useState(null); // {matches, sitting, warnings, roundNumber}
  const [genError, setGenError] = useState("");
  const [busy, setBusy] = useState(false);
  const [courtSplit, setCourtSplit] = useState(null); // organizer override of the suggested women/men court split; null = use suggestion

  const reload = () => eventId && fetchFullEvent(eventId).then(setState);

  useEffect(() => { reload(); }, [eventId]);
  useEffect(() => {
    if (!eventId) return;
    return subscribeEvent(eventId, reload);
  }, [eventId]);

  if (!eventId) return <div className="wrap"><div className="card">Missing event -- open this page from the Event Manager.</div></div>;
  if (!state?.event) return <div className="wrap"><div className="card">Loading...</div></div>;

  const { event, players, rounds, matches } = state;
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const roundsWithMatches = rounds.map((r) => ({ ...r, matches: matches.filter((m) => m.round_id === r.id) }));
  const lastPublished = roundsWithMatches[roundsWithMatches.length - 1];
  const justPlayedIds = lastPublished ? new Set(lastPublished.matches.flatMap((m) => [...m.team_a, ...m.team_b])) : new Set();
  const checkedInCount = players.filter((p) => p.attendance_status === "checked_in").length;

  const eligibleFemalePlayers = players.filter((p) => p.attendance_status === "checked_in" && p.gender === "female" && !justPlayedIds.has(p.id));
  const eligibleMalePlayers = players.filter((p) => p.attendance_status === "checked_in" && p.gender === "male" && !justPlayedIds.has(p.id));
  const eligibleFemale = eligibleFemalePlayers.length;
  const eligibleMale = eligibleMalePlayers.length;
  const suggestedSplit = suggestCourtSplit(eligibleFemalePlayers, eligibleMalePlayers, event.courts);

  const generate = async () => {
    setGenError(""); setBusy(true);
    const roundNumber = rounds.length + 1;
    const split = courtSplit || suggestedSplit;
    const res = generateDraft(players, event.courts, roundNumber, new Set(), justPlayedIds, split);
    setBusy(false);
    if (res.error) return setGenError(res.error);
    setDraft(res);
  };

  const publish = async () => {
    setBusy(true);
    await publishRound(eventId, draft.roundNumber, draft.matches, players);
    setDraft(null);
    setBusy(false);
    reload();
  };

  return (
    <div>
      <TopBar
        title={event.name}
        subtitle={`${event.ended ? "EVENT ENDED" : event.started_at ? `LIVE \u00B7 ROUND ${rounds.length}` : "NOT STARTED"} \u00B7 ${event.courts} courts`}
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

        {tab === "checkin" && <CheckinPanel eventId={eventId} players={players} matches={matches} reload={reload} />}

        {tab === "match" && (
          <MatchControlPanel
            draft={draft} setDraft={setDraft} genError={genError} busy={busy}
            generate={generate} publish={publish} byId={byId}
            roundsWithMatches={roundsWithMatches} rounds={rounds}
            courtSplit={courtSplit} setCourtSplit={setCourtSplit} suggestedSplit={suggestedSplit}
            eligibleFemale={eligibleFemale} eligibleMale={eligibleMale} numCourts={event.courts}
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

function CheckinPanel({ eventId, players, matches, reload }) {
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
                        checkOutPlayer(eventId, p, matches).then(reload);
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

function MatchCard({ byId, match, editable, onScore, draft }) {
  const [a, setA] = useState(match.score_a ?? "");
  const [b, setB] = useState(match.score_b ?? "");
  const name = (id) => byId[id]?.display_name || "?";
  return (
    <div className="court" style={{ borderLeft: draft ? "4px solid #5d73c7" : "4px solid #c8923e" }}>
      <div className="label">Court {match.court}{match.division && <span> &middot; {match.division === "female" ? "Women's Doubles" : "Men's Doubles"}</span>}</div>
      <div className="teams">
        <div className="team">{match.team_a.map(name).join(" & ")}</div>
        <div className="vs">VS</div>
        <div className="team" style={{ textAlign: "right" }}>{match.team_b.map(name).join(" & ")}</div>
      </div>
      {editable && match.status === "scheduled" && (
        <div className="scorerow">
          <input type="number" value={a} onChange={(e) => setA(e.target.value)} />
          <span className="vs">-</span>
          <input type="number" value={b} onChange={(e) => setB(e.target.value)} />
          <button className="small" onClick={() => { if (a !== "" && b !== "") onScore(parseInt(a), parseInt(b)); }}>Save score</button>
        </div>
      )}
      {match.status === "cancelled" && <p className="note">Cancelled</p>}
      {match.status !== "scheduled" && match.status !== "cancelled" && <p className="note">Final: {match.score_a}-{match.score_b} ({match.status})</p>}
    </div>
  );
}

function MatchControlPanel({ draft, setDraft, genError, busy, generate, publish, byId, roundsWithMatches, rounds, courtSplit, setCourtSplit, suggestedSplit, eligibleFemale, eligibleMale, numCourts }) {
  const active = courtSplit || suggestedSplit;
  return (
    <>
      <div className="card">
        <h2>Round generation</h2>
        {!draft && (
          <div className="row" style={{ marginBottom: 10 }}>
            <label className="small">Courts for women ({eligibleFemale} eligible)
              <input type="number" min={0} max={numCourts} value={active.female} style={{ width: 50, marginLeft: 6 }}
                onChange={(e) => { const f = Math.max(0, parseInt(e.target.value) || 0); setCourtSplit({ female: f, male: Math.max(0, numCourts - f) }); }} />
            </label>
            <label className="small">Courts for men ({eligibleMale} eligible)
              <input type="number" min={0} max={numCourts} value={active.male} style={{ width: 50, marginLeft: 6 }}
                onChange={(e) => { const m = Math.max(0, parseInt(e.target.value) || 0); setCourtSplit({ female: Math.max(0, numCourts - m), male: m }); }} />
            </label>
            {courtSplit && <button className="small secondary" onClick={() => setCourtSplit(null)}>Reset to suggested</button>}
          </div>
        )}
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
        {genError && <p className="note">{genError}</p>}
      </div>

      {[...roundsWithMatches].reverse().map((r) => (
        <div key={r.id}>
          <div className="round-title">PUBLISHED -- ROUND {r.number}</div>
          <div className="courts">{r.matches.map((m) => <MatchCard key={m.id} byId={byId} match={m} editable={false} />)}</div>
        </div>
      ))}
    </>
  );
}

function ScoresPanel({ roundsWithMatches, byId, players, reload }) {
  const pending = roundsWithMatches.flatMap((r) => r.matches.filter((m) => m.status === "scheduled").map((m) => ({ ...m, roundNumber: r.number })));
  return (
    <div className="card">
      <h2>Pending scores ({pending.length})</h2>
      {pending.length === 0 && <p className="note">All caught up.</p>}
      <div className="courts">
        {pending.map((m) => (
          <div key={m.id}>
            <p className="note" style={{ marginBottom: 2 }}>Round {m.roundNumber}</p>
            <MatchCard byId={byId} match={m} editable onScore={(a, b) => submitScore(m, a, b, players).then(reload)} />
          </div>
        ))}
      </div>
    </div>
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
