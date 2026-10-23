import BillingSuccess from "@/components/billing-success";
export const metadata = { title: "Payment success preview · Timeline Tools" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ minutes?: string | string[] }>;
}) {
  const { minutes } = await searchParams;
  const value =
    typeof minutes === "string" && /^\d{1,6}$/.test(minutes)
      ? Number(minutes)
      : 300;
  return <BillingSuccess minutes={Math.max(1, Math.min(100000, value))} />;
}
