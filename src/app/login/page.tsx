export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;

  return (
    <div style={{ maxWidth: 380, margin: "60px auto" }}>
      <h1>Cold caller dashboard</h1>
      <p className="sub">Enter your password to continue.</p>

      {params.error && <div className="notice bad">Wrong password. Try again.</div>}

      <form action="/api/auth/login" method="post" className="panel">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoFocus required />
        <input type="hidden" name="next" value={params.next ?? "/"} />
        <button type="submit">Log in</button>
      </form>
    </div>
  );
}
