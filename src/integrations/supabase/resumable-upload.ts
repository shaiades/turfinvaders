// Resumable (TUS) uploads for large proof videos.
//
// The plain `supabase.storage.from(bucket).upload()` sends the whole file in
// one request — fine for photos, but reps submit role-play / testimonial
// clips straight off an iPhone, where a single 200MB+ POST over cellular
// reliably stalls or times out. Supabase exposes a TUS endpoint for exactly
// this; it chunks the upload (6MB chunks, which Supabase mandates) and resumes
// after a dropped connection instead of restarting from zero.
//
// RLS still applies: we send the signed-in rep's access token as the bearer so
// the "Reps upload own contest proofs" storage policy sees their auth.uid().
import * as tus from "tus-js-client";
import { supabase } from "./client";

// Supabase requires TUS chunks to be exactly 6MB (except the final chunk).
const CHUNK_SIZE = 6 * 1024 * 1024;

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

export interface ResumableUploadOptions {
  bucket: string;
  path: string;
  file: Blob;
  contentType?: string;
  /** 0–100, fired as bytes land. */
  onProgress?: (percent: number) => void;
}

export async function uploadResumable({
  bucket,
  path,
  file,
  contentType,
  onProgress,
}: ResumableUploadOptions): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Upload isn't configured — Supabase env vars are missing.");
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("You're signed out — sign in and try again.");

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "x-upsert": "true",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: CHUNK_SIZE,
      metadata: {
        bucketName: bucket,
        objectName: path,
        contentType: contentType || "application/octet-stream",
        cacheControl: "3600",
      },
      onError: (error) => reject(error),
      onProgress: (bytesUploaded, bytesTotal) => {
        if (onProgress && bytesTotal > 0) {
          onProgress(Math.round((bytesUploaded / bytesTotal) * 100));
        }
      },
      onSuccess: () => resolve(),
    });

    // Resume an interrupted upload of the same file if one is pending.
    upload.findPreviousUploads().then((previous) => {
      if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    });
  });
}
