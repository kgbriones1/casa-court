"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import TopBar from "../../components/TopBar";
import { createEvent, listEvents, deleteEvent } from "../../lib/db";

// Only needed for window.location.href assignments and displayed link text below --
// next/link and next/image pick up next.config's basePath automatically, but raw
// strings don't, so this has to match NEXT_PUBLIC_BASE_PATH manually.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

function capacityPreview(participants, courts, startTime, endTime, roundMinutes) {
  if (!startTime || !endTime) return "Set a start and end time to calculate capacity.";
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  if (!Number.isFinite(mins) || mins <= 0) return "End time must be later than start time.";
  const rounds = Math.floor(mins / roundMinutes);
  const matches = rounds * courts;
  const slots = matches * 4;
  const avg = participants ? (slots / participants).toFixed(1) : "0";
  const unused = mins - rounds * roundMinutes;
  return `${mins} minutes across ${courts} court${courts === 1 ? "" : "s"} allows ${rounds} rounds and ${matches} matches. Approximately ${avg} games per participant${unused ? `, with ${unused} minutes outside complete round slots` : ""}.`;
}

export default function EventManager() {
  const [events, setEvents] = useState(null);
  const [origin, setOrigin] = useState("");
  const [form, setForm] = useState({
    name: "Casa King & Queen of the Court",
    targetParticipants: 30,
    courts: 3,
    eventDate: "",
    startTime: "08:00",
    endTime: "13:00",
    roundMinutes: 20,
    venue: "",
  });
  const [error, setError] = useState("");

  useEffect(() => {
    setOrigin(window.location.origin);
    listEvents().then(setEvents).catch((e) => { console.error(e); setEvents([]); });
  }, []);

  const set = (patch) => setForm({ ...form, ...patch });

  return (
    <div>
      <TopBar title="Event Manager" subtitle="Organizer only -- do not share" />
      <div className="wrap">
        <div className="head">
          <div>
            <h1>Events</h1>
            <div className="sub">Create and manage Casa Court events.</div>
          </div>
        </div>

        <div className="card">
          <h2>Create new event</h2>
          <div className="row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ gridColumn: "1/-1" }}><input placeholder="Event name" value={form.name} onChange={(e) => set({ name: e.target.value })} style={{ width: "100%" }} /></div>
            <div>
              <label className="small">Number of participants</label>
              <input type="number" min={4} value={form.targetParticipants} onChange={(e) => set({ targetParticipants: parseInt(e.target.value) || 0 })} style={{ width: "100%" }} />
            </div>
            <div>
              <label className="small">Number of courts</label>
              <input type="number" min={1} value={form.courts} onChange={(e) => set({ courts: parseInt(e.target.value) || 1 })} style={{ width: "100%" }} />
            </div>
            <div>
              <label className="small">Date</label>
              <input type="date" value={form.eventDate} onChange={(e) => set({ eventDate: e.target.value })} style={{ width: "100%" }} />
            </div>
            <div>
              <label className="small">Round length (min)</label>
              <input type="number" min={5} value={form.roundMinutes} onChange={(e) => set({ roundMinutes: parseInt(e.target.value) || 20 })} style={{ width: "100%" }} />
            </div>
            <div>
              <label className="small">Start time</label>
              <input type="time" value={form.startTime} onChange={(e) => set({ startTime: e.target.value })} style={{ width: "100%" }} />
            </div>
            <div>
              <label className="small">End time</label>
              <input type="time" value={form.endTime} onChange={(e) => set({ endTime: e.target.value })} style={{ width: "100%" }} />
            </div>
            <div style={{ gridColumn: "1/-1" }}>
              <label className="small">Venue</label>
              <input placeholder="Venue name and location" value={form.venue} onChange={(e) => set({ venue: e.target.value })} style={{ width: "100%" }} />
            </div>
          </div>
          <div className="warn-box" style={{ marginTop: 12 }}>
            {capacityPreview(form.targetParticipants, form.courts, form.startTime, form.endTime, form.roundMinutes)}
          </div>
          {error && <div className="error-box">{error}</div>}
          <button onClick={async () => {
            if (!form.name.trim() || !form.venue.trim() || !form.eventDate) { setError("Name, venue, and date are required."); return; }
            setError("");
            const ev = await createEvent(form);
            window.location.href = `${BASE_PATH}/admin/${ev.id}`;
          }}>Create event</button>
        </div>

        {events === null && <p className="note">Loading...</p>}
        {events?.length === 0 && <div className="card empty"><h2>No events yet</h2><p className="sub">Create your first King and Queen of the Court event above.</p></div>}
        {events?.length > 0 && (
          <div className="event-list">
            {events.map((ev) => (
              <Link key={ev.id} href={`/admin/${ev.id}`} className="card event-tile">
                <div className="small">King and Queen of the Court</div>
                <h3>{ev.name}</h3>
                <div className="event-meta">
                  {ev.event_date && <div>&#128197; {ev.event_date} &middot; {ev.start_time}&ndash;{ev.end_time}</div>}
                  {ev.venue && <div>&#128205; {ev.venue}</div>}
                  <div>&#127934; {ev.courts} court{ev.courts === 1 ? "" : "s"}</div>
                </div>
                <span className={`badge ${ev.ended ? "green" : "amber"}`}>{ev.ended ? "Completed" : "Setup / Live"}</span>
                {origin && <div className="note" style={{ marginTop: 8 }}>{origin}{BASE_PATH}/live/{ev.id}</div>}
                <button
                  className="small secondary"
                  style={{ marginTop: 10 }}
                  onClick={async (e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (!confirm(`Delete "${ev.name}" and everything in it (players, rounds, scores, logs)? This can't be undone.`)) return;
                    await deleteEvent(ev.id);
                    setEvents(events.filter((x) => x.id !== ev.id));
                  }}
                >Delete</button>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
