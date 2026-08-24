import Link from "next/link";

/** Layout for every logged-in page. The login page deliberately has no nav. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <span className="brand">Cold caller</span>
        <nav>
          <Link href="/">Calling</Link>
          <Link href="/find-leads">Find leads</Link>
          <Link href="/leads">Leads</Link>
          <Link href="/calls">Call log</Link>
          <Link href="/meetings">Meetings</Link>
          <Link href="/conversion">Conversion</Link>
          <Link href="/finance">Finance</Link>
          <Link href="/learning">Learning</Link>
          <Link href="/costs">Costs</Link>
        </nav>
        <form action="/api/auth/logout" method="post">
          <button className="secondary" type="submit">
            Log out
          </button>
        </form>
      </header>
      <main>{children}</main>
    </>
  );
}
