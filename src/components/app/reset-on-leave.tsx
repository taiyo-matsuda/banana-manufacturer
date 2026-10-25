"use client";

import { Fragment, useLayoutEffect, useState } from "react";

// 画面を離れたら children を作り直す（UX-2 の編集フォーム）。
// cacheComponents の Next.js は離れた画面を <Activity hidden> で残すので、useState・入力値・Action の結果（エラー表示）が
// 次に開いたときもそのまま出る（next/dist/docs の preserving-ui-state）。編集フォームは開くたびに DB の値から始めたいので、
// 隠れるとき（useLayoutEffect の cleanup）に key を変えて作り直す。
// resetKey（DB の値など）が変わったときも作り直す（保存後にもう一度開いたとき、新しい値で始まる）。
export function ResetOnLeave({ resetKey, children }: { resetKey: string; children: React.ReactNode }) {
  const [generation, setGeneration] = useState(0);
  useLayoutEffect(() => {
    return () => setGeneration((g) => g + 1);
  }, []);
  return <Fragment key={`${generation}:${resetKey}`}>{children}</Fragment>;
}
