import { z } from "zod";
const name = z.string().trim().min(1).max(100),
  money = z.coerce.number().min(0).max(10000000),
  positive = z.coerce.number().int().min(1).max(10000000);
export const adminSchemas = {
  plans: z
    .object({
      name,
      price_inr: money,
      monthly_minutes: z.coerce.number().int().min(0).max(10000000),
      max_file_mb: z.coerce.number().int().min(1).max(10000),
      features: z.string().max(2000),
      active: z.boolean(),
    })
    .strict(),
  topup_packs: z
    .object({ name, minutes: positive, price_inr: money, active: z.boolean() })
    .strict(),
  coupons: z
    .object({
      code: z.string().regex(/^[A-Z0-9_-]{2,40}$/),
      type: z.enum(["percent", "flat"]),
      value: z.coerce.number().positive().max(10000000),
      expires_at: z.string().min(10),
      usage_cap: positive,
      active: z.boolean(),
    })
    .strict()
    .refine(
      (v) => v.type !== "percent" || v.value <= 100,
      "Percent cannot exceed 100",
    ),
  users: z
    .object({
      minutes_balance: money,
      plan_id: z.string().regex(/^[a-z0-9_-]+$/),
      suspended: z.boolean(),
    })
    .strict(),
};
export type AdminEntity = keyof typeof adminSchemas;
