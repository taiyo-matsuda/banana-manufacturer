"use client";

import { useRef, useState, useTransition } from "react";
import exifr from "exifr";
import {
  fitWithinLongEdge,
  INITIAL_PHOTO_RECORD_STATE,
  latLngFromExif,
  parseExifDateTime,
  PHOTO_KIND_LABELS,
  PHOTO_KINDS,
  type PhotoKind,
  type PhotoRecordState,
  resolveTakenAt,
  DEFAULT_PHOTO_KIND,
} from "@/lib/photos";
import { createClient } from "@/lib/supabase/client";
import { preparePhotoUpload, recordPhoto } from "./actions";

const selectClass =
  "h-12 rounded-lg border border-zinc-300 bg-white px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";

// 茎の写真（1-7、画面 4）。<input type="file" capture> で撮影 → EXIF（撮影日時・GPS）を読む →
// 長辺 2048px に縮小（JPEG）→ Storage に直接アップロード → Server Action で photos に追記。
// 1-9 までは オンライン前提（圏外ではエラーになる）。
export function PhotoCapture({ stemId }: { stemId: string }) {
  const [kind, setKind] = useState<PhotoKind>(DEFAULT_PHOTO_KIND);
  const [state, setState] = useState<PhotoRecordState>(INITIAL_PHOTO_RECORD_STATE);
  const [phase, setPhase] = useState<"idle" | "reading" | "uploading" | "recording">("idle");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = pending || phase !== "idle";

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    startTransition(async () => {
      try {
        setPhase("reading");
        const [meta, image] = await Promise.all([readExif(file), shrinkToJpeg(file)]);
        const { takenAt } = resolveTakenAt(meta.exifDate, new Date());

        const prepared = await preparePhotoUpload(stemId);
        if (!prepared.ok) throw new Error(prepared.error);

        setPhase("uploading");
        const supabase = createClient();
        const { error: uploadError } = await supabase.storage
          .from("photos")
          .upload(prepared.storagePath, image.blob, { contentType: image.contentType, upsert: false });
        if (uploadError) {
          console.error("photo upload failed", uploadError);
          throw new Error("写真をアップロードできませんでした。電波の届く場所で再度お試しください");
        }

        setPhase("recording");
        const next = await recordPhoto(state, {
          stemId,
          photoId: prepared.photoId,
          takenAt: takenAt.toISOString(),
          kind,
          lat: meta.latLng ? String(meta.latLng.lat) : "",
          lng: meta.latLng ? String(meta.latLng.lng) : "",
        });
        setState(next);
      } catch (err) {
        setState((prev) => ({ error: err instanceof Error ? err.message : "写真の保存に失敗しました", succeeded: prev.succeeded }));
      } finally {
        setPhase("idle");
        if (inputRef.current) inputRef.current.value = "";
      }
    });
  };

  return (
    <section className="flex flex-col gap-3" aria-label="写真">
      <h2 className="text-base font-semibold">写真</h2>
      <div className="flex items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>種類</span>
          <select
            name="kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as PhotoKind)}
            disabled={busy}
            className={selectClass}
            data-testid="photo-kind"
          >
            {PHOTO_KINDS.map((k) => (
              <option key={k} value={k}>
                {PHOTO_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label
          className={`flex h-12 flex-1 cursor-pointer items-center justify-center rounded-lg bg-green-700 px-4 text-base font-medium text-white ${busy ? "opacity-60" : "active:bg-green-800"}`}
        >
          <span data-testid="photo-status">{phaseLabel(phase, pending)}</span>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onChange}
            disabled={busy}
            className="sr-only"
            data-testid="photo-input"
          />
        </label>
      </div>
      {state.error && (
        <p role="alert" data-testid="photo-error" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
    </section>
  );
}

function phaseLabel(phase: "idle" | "reading" | "uploading" | "recording", pending: boolean) {
  switch (phase) {
    case "reading":
      return "画像を準備中…";
    case "uploading":
      return "アップロード中…";
    case "recording":
      return "記録中…";
    default:
      return pending ? "処理中…" : "撮影する";
  }
}

// --- EXIF ---------------------------------------------------------------------

type ExifMeta = { exifDate: Date | null; latLng: { lat: number; lng: number } | null };

// 撮影日時（DateTimeOriginal、あれば OffsetTimeOriginal）と GPS を読む。読めなければ null（撮影日時は現在時刻になる）
async function readExif(file: File): Promise<ExifMeta> {
  try {
    const raw = (await exifr.parse(file, {
      pick: [
        "DateTimeOriginal",
        "OffsetTimeOriginal",
        "GPSLatitude",
        "GPSLatitudeRef",
        "GPSLongitude",
        "GPSLongitudeRef",
      ],
      reviveValues: false,
    })) as Record<string, unknown> | undefined;
    if (!raw) return { exifDate: null, latLng: null };
    return {
      exifDate: parseExifDateTime(raw.DateTimeOriginal, raw.OffsetTimeOriginal),
      latLng: latLngFromExif(raw),
    };
  } catch (err) {
    console.warn("EXIF を読めませんでした", err);
    return { exifDate: null, latLng: null };
  }
}

// --- 縮小 ---------------------------------------------------------------------

type Shrunk = { blob: Blob; contentType: string };

// 長辺 2048px の JPEG にする。HEIC など canvas で扱えないときは元ファイルをそのまま送る
async function shrinkToJpeg(file: File): Promise<Shrunk> {
  try {
    const bitmap = await decode(file);
    try {
      const size = fitWithinLongEdge({ width: bitmap.width, height: bitmap.height });
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas を使えません");
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (!blob) throw new Error("JPEG に変換できません");
      return { blob, contentType: "image/jpeg" };
    } finally {
      if ("close" in bitmap) bitmap.close();
    }
  } catch (err) {
    console.warn("画像を縮小できなかったので元のファイルを送ります", err);
    return { blob: file, contentType: file.type || "application/octet-stream" };
  }
}

// createImageBitmap（EXIF の回転を適用して向きを正す）。使えないブラウザは <img> で読む
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // 下の <img> にフォールバック
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("画像を読み込めません"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
