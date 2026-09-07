"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface ExistingPhoto {
  id: string;
  caption: string | null;
}

/**
 * Take a picture at the door.
 *
 * Three things here are deliberate, and all three come from the same place --
 * this runs on a phone, one-handed, on cell data, at a loading dock:
 *
 *  1. `capture="environment"` opens the rear camera directly instead of a file
 *     picker. `multiple` is NOT set alongside it: iOS ignores capture when
 *     multiple is present and falls back to the photo library, which is the
 *     opposite of what a driver wants.
 *
 *  2. The image is downscaled to 1600px and re-encoded as JPEG before it is
 *     sent. A modern phone camera produces 4-8MB; this produces ~300KB. That is
 *     the difference between an upload that finishes before he is back in the
 *     cab and one that does not, and it is what keeps the request inside the
 *     serverless body limit.
 *
 *  3. Each photo uploads and is recorded the moment it is taken, not on form
 *     submit. A photo that exists only in a form that was never submitted is a
 *     photo that does not exist, and this one is evidence.
 */
export function PhotoCapture({
  stopId,
  existing,
  canDelete,
}: {
  stopId: string;
  existing: ExistingPhoto[];
  canDelete: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clear immediately so picking the same shot twice still fires a change.
    e.target.value = "";
    if (!file) return;

    setError(null);
    setBusy(true);
    setProgress("Shrinking…");
    try {
      const { blob, width, height } = await downscale(file);
      setProgress("Uploading…");

      const body = new FormData();
      body.set("stopId", stopId);
      body.set("file", new File([blob], "delivery.jpg", { type: "image/jpeg" }));
      body.set("width", String(width));
      body.set("height", String(height));

      const res = await fetch("/api/delivery/photos", { method: "POST", body });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Upload failed (${res.status})`);
      }
      setProgress(null);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that photo.");
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/delivery/photos/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? "Could not remove it.");
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {existing.length > 0 ? (
        <div className="dv-shots">
          {existing.map((p) => (
            <figure className="dv-shot" key={p.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/api/delivery/photos/${p.id}`} alt={p.caption ?? "Delivery photo"} loading="lazy" />
              {canDelete ? (
                <button type="button" onClick={() => onDelete(p.id)} disabled={busy} aria-label="Remove photo">
                  ✕
                </button>
              ) : null}
            </figure>
          ))}
        </div>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onPick}
        hidden
      />
      <button
        type="button"
        className="dv-btn"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        {busy ? (progress ?? "Working…") : existing.length ? "Take another photo" : "Take a photo"}
      </button>

      {error ? (
        <p className="sm" style={{ color: "var(--serious-ink)", marginBottom: 0 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Downscale to a 1600px longest edge and re-encode as JPEG.
 *
 * Uses createImageBitmap where available so the decode happens off the main
 * thread and the UI does not freeze on an 8MB HEIC. Falls back to an <img>
 * decode, and if even that fails, sends the original rather than losing the
 * photo -- the server's size limit is the backstop.
 */
async function downscale(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const MAX_EDGE = 1600;
  try {
    const bitmap = await loadBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);
    if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8),
    );
    if (!blob) throw new Error("encode failed");
    return { blob, width, height };
  } catch {
    return { blob: file, width: 0, height: 0 };
  }
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
