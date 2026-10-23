import Link from "next/link";
export default function Page() {
  return (
    <main className="wrap card">
      <h1>This link is invalid or expired</h1>
      <Link href="/forgot-password">Request a new reset link</Link> ·{" "}
      <Link href="/signin">Sign in</Link>
    </main>
  );
}
