// Client-side compression for oversized proof videos.
//
// Supabase Free caps every Storage upload at 50MB, and a camera-roll iPhone
// clip runs ~60MB/min at 1080p (~170MB/min at 4K) — so most testimonial
// videos bounced off the cap. Instead of asking reps to trim in Photos, we
// re-encode in the browser with WebCodecs (via mediabunny): long side capped
// at 720p-class resolution, H.264, bitrate sized to the clip so the result
// fits the cap. Audio (AAC on iPhones) is copied through untouched.
//
// Returns null when this browser/clip can't be compressed (no WebCodecs
// encoder, undecodable codec, tracks that would be silently dropped) — the
// caller falls back to the plain size error rather than uploading a broken
// file.

/** Matches MAX_PROOF_MB in KombatMonth.tsx and the contest-proofs bucket. */
const TARGET_LONG_SIDE = 1280;
const MAX_VIDEO_BITRATE = 2_500_000; // ~19MB/min + audio; plenty for a phone testimonial
const MIN_VIDEO_BITRATE = 1_000_000; // below this, faces/text smear — let the cap error win
const AUDIO_BITRATE_ALLOWANCE = 160_000; // copied AAC is ≤~128kbps; headroom for container

export interface CompressVideoOptions {
  /** Hard ceiling the result must fit under (bytes). */
  maxBytes: number;
  /** 0–100 as frames are transcoded. */
  onProgress?: (percent: number) => void;
}

export async function compressProofVideo(
  file: Blob,
  { maxBytes, onProgress }: CompressVideoOptions,
): Promise<Blob | null> {
  try {
    // Loaded on demand: only reps submitting an oversized video pay for it.
    const {
      Input,
      Output,
      Conversion,
      BlobSource,
      BufferTarget,
      Mp4OutputFormat,
      Quality,
      ALL_FORMATS,
      canEncodeVideo,
    } = await import("mediabunny");

    if (!(await canEncodeVideo("avc"))) return null; // no WebCodecs H.264 here

    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;

    // Scale the long side down to 1280 (never up), keeping aspect ratio.
    // displayWidth/Height already account for iPhone rotation metadata.
    const scale = Math.min(
      1,
      TARGET_LONG_SIDE / Math.max(videoTrack.displayWidth, videoTrack.displayHeight),
    );
    const width = Math.max(2, 2 * Math.round((videoTrack.displayWidth * scale) / 2));

    // Size the bitrate so the whole clip fits the cap (with 10% container
    // headroom), clamped to a watchable floor — a clip too long even for the
    // floor still compresses, and the caller's size check reports it.
    const duration = await input.computeDuration();
    const videoBudget =
      duration > 0
        ? Math.floor((maxBytes * 8 * 0.9) / duration) - AUDIO_BITRATE_ALLOWANCE
        : MAX_VIDEO_BITRATE;
    const bitrate = Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, videoBudget));

    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        width,
        codec: "avc",
        quality: new Quality({ bitrate }),
        // Without this, a clip that needs no resize would be copied through
        // at its original bitrate and stay over the cap.
        forceTranscode: true,
      },
      // Audio stays on the default copy path (AAC passes straight into mp4).
    });

    // A dropped track means a video with no picture or no sound — worse than
    // the plain size error, so bail instead.
    if (!conversion.isValid || conversion.discardedTracks.length > 0) {
      await conversion.cancel();
      return null;
    }

    if (onProgress) {
      conversion.onProgress = (p) => onProgress(Math.round(p * 100));
    }
    await conversion.execute();

    const buffer = output.target.buffer;
    if (!buffer) return null;
    return new Blob([buffer], { type: "video/mp4" });
  } catch {
    // Treat any decode/encode failure as "can't compress on this device".
    return null;
  }
}
