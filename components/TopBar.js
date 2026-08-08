import Image from "next/image";
import Link from "next/link";

/** linkHome defaults to false -- the participant board renders this component too,
 * and a participant clicking the logo has no business landing on the Event Manager,
 * which lists every event the organizer runs. Only the organizer console opts in. */
export default function TopBar({ title, subtitle, large, linkHome = false }) {
  const brandContent = (
    <>
      <Image src="/casa-logo.png" alt="Casa" width={32} height={32} />
      CASA <span>COURT</span>
    </>
  );
  return (
    <header className="top">
      {linkHome ? <Link href="/admin" className="brand">{brandContent}</Link> : <div className="brand">{brandContent}</div>}
      <div className="topbar-info">
        <div className={`topbar-title${large ? " large" : ""}`}>{title}</div>
        <div className={`small topbar-subtitle${large ? " large" : ""}`}>{subtitle}</div>
      </div>
    </header>
  );
}
