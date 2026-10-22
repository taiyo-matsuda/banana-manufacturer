// 「1株追加」のフォームで使う品種の既定値: その圃場で最後に登録した株の品種。
// 株がなければ fallback（ドワーフナムワ）。UI・DB に依存しない純粋関数。

export type MatForDefaultCultivar = {
  cultivar_id: string;
  created_at: string; // ISO 8601（DB の timestamptz）
};

export function defaultCultivarId(
  mats: readonly MatForDefaultCultivar[],
  fallback: string,
): string {
  let latest: MatForDefaultCultivar | null = null;
  for (const m of mats) {
    if (!latest || Date.parse(m.created_at) > Date.parse(latest.created_at)) latest = m;
  }
  return latest?.cultivar_id ?? fallback;
}
