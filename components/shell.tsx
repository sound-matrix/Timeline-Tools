import Link from "next/link";
import Sidebar from "./sidebar";
import { signOut } from "@/app/auth/actions";
const userLinks = [
  ["/dashboard", "Dashboard"],
  ["/cleanup", "Clean-up"],
  ["/master", "Master"],
  ["/subs", "Subs"],
  ["/studio", "Audio Studio"],
  ["/podcast", "Podcast"],
  ["/editor", "Editor Studio"],
  ["/plans", "Plans & billing"],
];
const adminLinks = [
  ["/admin", "Overview"],
  ["/admin/plans", "Plans & pricing"],
  ["/admin/topup_packs", "Top-up packs"],
  ["/admin/limits", "Usage limits"],
  ["/admin/coupons", "Coupons"],
  ["/admin/users", "Users"],
  ["/admin/jobs", "Jobs queue"],
  ["/admin/audit_log", "Audit log"],
];
export default function Shell({
  children,
  admin = false,
  isAdmin = false,
  name,
  minutes,
}: {
  children: React.ReactNode;
  admin?: boolean;
  isAdmin?: boolean;
  name: string;
  minutes?: number;
}) {
  return (
    <>
      <header className="top">
        <Link className="logo" href="/dashboard">
          Timeline Tools{admin ? " · Admin CMS" : ""}
        </Link>
        <nav />
        {admin ? (
          <Link href="/dashboard">User site →</Link>
        ) : (
          isAdmin && <Link href="/admin">Admin CMS</Link>
        )}
        <span className="muted">{name}</span>
        <form action={signOut}>
          <button className="btn sm ghost">Sign out</button>
        </form>
      </header>
      <div className="layout">
        <Sidebar
          minutes={minutes}
          name={name}
          items={admin ? adminLinks : userLinks}
        />
        <main className="main">{children}</main>
      </div>
    </>
  );
}
