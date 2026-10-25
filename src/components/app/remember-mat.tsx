"use client";

import { useEffect } from "react";
import { LAST_FIELD_KEY, parseLastField } from "@/lib/device-prefs";
import { parseRecentMats, pushRecentMat, RECENT_MATS_KEY, renameFieldInRecentMats } from "@/lib/recent-mats";
import { readItem, writeItem } from "./device-store";

// 株の詳細を開いたことを端末（localStorage）に残す。ホームの「最近開いた株」が読む。
// その株の圃場を「直近の圃場」（下部タブ「地図」の行き先）にもする。画面には何も出さない。
// 株コードを編集した後は株の詳細に戻るので、ここで新しいコードに置き換わる（UX-2。同じ株は 1 つにまとまる）。
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
      fieldId,
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
    syncStoredFieldName(id, name);
  }, [id, name]);
  return null;
}

// 圃場の詳細を開いたとき（圃場の名前を編集した後もここに戻る。UX-2）: 端末に残っている
// その圃場の名前（最近開いた株の圃場名・直近の圃場）を新しい名前にする。直近の圃場の行き先は変えない。
export function SyncFieldName({ id, name }: { id: string; name: string }) {
  useEffect(() => {
    syncStoredFieldName(id, name);
  }, [id, name]);
  return null;
}

function syncStoredFieldName(id: string, name: string) {
  const mats = parseRecentMats(readItem(RECENT_MATS_KEY));
  const renamed = renameFieldInRecentMats(mats, id, name);
  if (renamed !== mats) writeItem(RECENT_MATS_KEY, JSON.stringify(renamed));
  const last = parseLastField(readItem(LAST_FIELD_KEY));
  if (last && last.id === id && last.name !== name) writeItem(LAST_FIELD_KEY, JSON.stringify({ id, name }));
}
