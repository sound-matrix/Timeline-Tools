import { requireUser } from "@/lib/auth";
import Shell from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireUser();
  return (
    <Shell
      minutes={profile.minutes_balance}
      name={profile.display_name || user.email || ""}
      isAdmin={["admin", "owner"].includes(profile.role)}
    >
      {children}
    </Shell>
  );
}
