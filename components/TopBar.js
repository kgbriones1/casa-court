import Image from "next/image";
import Link from "next/link";

export default function TopBar({ title, subtitle }) {
  return (
    <header className="top">
      <Link href="/admin" className="brand">
        <Image src="/casa-logo.png" alt="Casa" width={32} height={32} />
        CASA <span>COURT</span>
      </Link>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{title}</div>
        <div className="small">{subtitle}</div>
      </div>
    </header>
  );
}
