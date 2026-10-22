// 株コード `圃場記号-3桁ゼロ埋め連番`（例 A-001）の採番。UI・DB に依存しない純粋関数。

const CODE_NUMBER_PATTERN = /-(\d+)$/;

// 株コードの末尾の番号。形式に合わなければ null
export function parseMatCodeNumber(code: string): number | null {
  const m = CODE_NUMBER_PATTERN.exec(code.trim());
  return m ? Number(m[1]) : null;
}

export function formatMatCode(fieldCode: string, n: number): string {
  return `${fieldCode}-${String(n).padStart(3, "0")}`;
}

// その圃場の既存コードの最大番号の次から count 個のコードを返す
export function nextMatCodes(fieldCode: string, existingCodes: string[], count: number): string[] {
  let max = 0;
  for (const c of existingCodes) {
    const n = parseMatCodeNumber(c);
    if (n !== null && n > max) max = n;
  }
  const codes: string[] = [];
  for (let i = 1; i <= count; i++) codes.push(formatMatCode(fieldCode, max + i));
  return codes;
}
