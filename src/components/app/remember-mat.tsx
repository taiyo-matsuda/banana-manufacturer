"use client";

import { useEffect } from "react";
import { LAST_FIELD_KEY } from "@/lib/device-prefs";
import { parseRecentMats, pushRecentMat, RECENT_MATS_KEY } from "@/lib/recent-mats";
import { readItem, writeItem } from "./device-store";

// 株の詳細を開いたことを端末（localStorage）に残す。ホームの「最近開いた株」が読む。
// その株の圃場を「直近の圃場」（下部タブ「地図」の行き先）にもする。画面には何も出さない。
export function RememberMat({
  id,
  code,
  field,
}: {
  id: string;
  code: string;
  field: { id: string; name: string } | null;
}) {
  const fieldId = field?.id ?? null;
  const fieldName = field?.name ?? null;
  useEffect(() => {
    const next = pushRecentMat(parseRecentMats(readItem(RECENT_MATS_KEY)), {
      id,
      code,
      fieldName,
      openedAt: new Date().toISOString(),
    });
    writeItem(RECENT_MATS_KEY, JSON.stringify(next));
    if (fieldId) writeItem(LAST_FIELD_KEY, JSON.stringify({ id: fieldId, name: fieldName ?? "" }));
  }, [id, code, fieldId, fieldName]);
  return null;
}

// 圃場の地図を開いたことを端末に残す（下部タブ「地図」の行き先になる）
export function RememberField({ id, name }: { id: string; name: string }) {
  useEffect(() => {
    writeItem(LAST_FIELD_KEY, JSON.stringify({ id, name }));
  }, [id, name]);
  return null;
}
