export default function LiveNoEvent() {
  return (
    <div className="wrap" style={{ paddingTop: 60 }}>
      <div className="card">
        <h2>No event selected</h2>
        <p>Scan the QR code or open the link the organizer shared -- it looks like <code>/live/&lt;event-id&gt;</code>.</p>
      </div>
    </div>
  );
}
