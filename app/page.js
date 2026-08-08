import Link from "next/link";

export default function Home() {
  return (
    <div className="wrap" style={{ paddingTop: 60 }}>
      <div className="card">
        <h2>Casa Court</h2>
        <p>This app has two links:</p>
        <p><Link href="/admin/">Organizer -- Event Manager</Link> (private, don&apos;t share)</p>
        <p><Link href="/live/">Participant board</Link> (needs an event link like <code>/live/&lt;event-id&gt;</code>, get it from the Event Manager)</p>
      </div>
    </div>
  );
}
