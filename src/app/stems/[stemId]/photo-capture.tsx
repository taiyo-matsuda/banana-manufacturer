"use client";

import { useRef, useState } from "react";
import exifr from "exifr";
import { FormField } from "@/components/app/form-field";
import { PhotoInput } from "@/components/app/photo-input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  fitWithinLongEdge,
  latLngFromExif,
  parseExifDateTime,
  PHOTO_KIND_LABELS,
  PHOTO_KINDS,
  type PhotoKind,
  photoStoragePath,
  resolveTakenAt,
  DEFAULT_PHOTO_KIND,
} from "@/lib/photos";
import { enqueuePhoto } from "@/lib/offline/enqueue";

// 茎の写真（1-7、画面 4）。PhotoInput（file 入力、capture="environment"）で撮影 → EXIF（撮影日時・GPS）を読む →
// 長辺 2048px に縮小（JPEG）→ 端末の pendingPhotos（Blob）と outbox に保存（1-9）。
// 同期ワーカーが Storage にアップロード（同じパスに upsert）→ photos に追記する。圏外でも撮影・記録できる。
// 写真の id と Storage のパスは端末で採番する（organization_id はサーバーから props で受け取る）。
export function PhotoCapture({ stemId, userId, organizationId }: { stemId: string; userId: string; organizationId: string }) {
  const [kind, setKind] = useState<PhotoKind>(DEFAULT_PHOTO_KIND);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "reading" | "saving">("idle");
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase !== "idle";

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    void (async () => {
      try {
        setPhase("reading");
        const [meta, image] = await Promise.all([readExif(file), shrinkToJpeg(file)]);
        const { takenAt } = resolveTakenAt(meta.exifDate, new Date());

        setPhase("saving");
        const photoId = crypto.randomUUID();
        await enqueuePhoto({
          id: photoId,
          stemId,
          storagePath: photoStoragePath({ organizationId, targetType: "stem", targetId: stemId, photoId }),
          blob: image.blob,
          contentType: image.contentType,
          takenAt,
          userId,
          lat: meta.latLng?.lat ?? null,
          lng: meta.latLng?.lng ?? null,
          kind,
        });
        setError(null);
      } catch (err) {
        console.error("photo save failed", err);
        setError(err instanceof Error && err.message ? err.message : "写真を端末に保存できませんでした");
      } finally {
        setPhase("idle");
        if (inputRef.current) inputRef.current.value = "";
      }
    })();
  };

  return (
    <Card aria-label="写真">
      <CardHeader>
        <CardTitle>写真</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-end gap-3">
          <FormField id="photo-kind" label="種類" className="w-36 shrink-0">
            <NativeSelect
              id="photo-kind"
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as PhotoKind)}
              disabled={busy}
              data-testid="photo-kind"
            >
              {PHOTO_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {PHOTO_KIND_LABELS[k]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
          <PhotoInput label={phaseLabel(phase)} busy={busy} onChange={onChange} inputRef={inputRef} className="h-12 flex-1" />
        </div>
        {error && (
          <Alert variant="destructive" data-testid="photo-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function phaseLabel(phase: "idle" | "reading" | "saving") {
  switch (phase) {
    case "reading":
      return "画像を準備中…";
    case "saving":
      return "保存中…";
    default:
      return "撮影する";
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
