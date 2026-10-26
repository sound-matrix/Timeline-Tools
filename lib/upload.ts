"use client";
import { browserClient } from "./supabase/client";
export async function uploadFile(
  path: string,
  file: File,
  onProgress: (percent: number) => void,
) {
  const db = browserClient();
  if (file.size <= 6 * 1024 * 1024) {
    const { error } = await db.storage.from("uploads").upload(path, file, {
      upsert: false,
      contentType: file.type || "application/octet-stream",
    });
    if (error) throw error;
    onProgress(100);
    return;
  }
  const { Upload } = await import("tus-js-client");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
  if (endpoint.hostname.endsWith(".supabase.co"))
    endpoint.hostname = endpoint.hostname.replace(
      ".supabase.co",
      ".storage.supabase.co",
    );
  endpoint.pathname = "/storage/v1/upload/resumable";
  await new Promise<void>((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: endpoint.toString(),
      chunkSize: 6 * 1024 * 1024,
      retryDelays: [1000, 2000, 4000],
      onShouldRetry: (error) => {
        const status = error.originalResponse?.getStatus() ?? 0;
        return status === 0 || status >= 500;
      },
      uploadDataDuringCreation: true,
      storeFingerprintForResuming: false,
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "x-upsert": "false",
      },
      metadata: {
        bucketName: "uploads",
        objectName: path,
        contentType: file.type || "application/octet-stream",
        cacheControl: "3600",
      },
      // Only forward the credential; Storage verifies it and enforces RLS.
      onBeforeRequest: async (request) => {
        const {
          data: { session },
        } = await db.auth.getSession();
        if (!session) throw new Error("Please sign in again.");
        request.setHeader("Authorization", "Bearer " + session.access_token);
      },
      onProgress: (sent, total) => onProgress(Math.round((sent / total) * 100)),
      onError: reject,
      onSuccess: () => resolve(),
    });
    upload.start();
  });
}
