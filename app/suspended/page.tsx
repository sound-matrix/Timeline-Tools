import { signOut } from "@/app/auth/actions";
export default function Page() {
  return (
    <main className="wrap card">
      <h1>Account suspended</h1>
      <p>Contact your administrator for help.</p>
      <form action={signOut}>
        <button className="btn">Sign out</button>
      </form>
    </main>
  );
}
