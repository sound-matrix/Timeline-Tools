import { requireAdmin } from "@/lib/auth";
import Shell from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireAdmin();
  return (
    <Shell admin name={profile.display_name || user.email || ""}>
      {children}
    </Shell>
  );
}
