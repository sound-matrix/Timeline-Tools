import { z } from "zod";

export const jobStatusSchema = z.object({
  status: z.enum(["queued", "processing", "done", "failed"]),
  error: z.string().nullable(),
  errorCode: z.string().nullable().optional(),
  errorDetail: z
    .object({
      script_lang: z.string(),
      clips: z.array(
        z.object({ name: z.string(), lang: z.string(), prob: z.number() }),
      ),
    })
    .nullable()
    .optional(),
  durationSec: z.number().finite().positive().nullable(),
  downloads: z.array(z.object({ label: z.string(), href: z.string() })),
});
export type JobSnapshot = z.infer<typeof jobStatusSchema>;
export type ProcessingState = Omit<JobSnapshot, "status"> & {
  id?: string;
  fileName: string;
  status: JobSnapshot["status"] | "uploading" | "starting";
  uploadPercent?: number;
};

// Return application download routes only, never private storage keys or signed URLs.
export function jobDownloads(id: string, userId: string, paths: unknown) {
  if (!Array.isArray(paths)) return [];
  return paths.flatMap((path, index) => {
    if (typeof path !== "string" || !path.startsWith(userId + "/")) return [];
    if (/\/(stems|peaks)\//.test(path)) return [];
    const extension = path.split(".").pop()?.toUpperCase() ?? "";
    const label =
      extension === "JSON"
        ? path.endsWith("/alignment-report.json")
          ? "Download alignment report (JSON)"
          : /\/arrangement-r\d+\.json$/.test(path)
            ? "Download arrangement (JSON)"
            : path === `${userId}/${id}/report.json`
              ? "Download match report (JSON)"
              : "Download measured report (JSON)"
        : `Download ${/^[A-Z0-9]{1,8}$/.test(extension) ? extension : "file"}`;
    return [{ label, href: `/api/jobs/${id}/download?index=${index}` }];
  });
}
