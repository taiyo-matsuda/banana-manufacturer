import { cn } from "cn";
import { Label } from "@/components/ui/label";

// ラベル＋入力＋補足＋エラーの縦並び（UX-1）。入力欄（Input / NativeSelect / Textarea）は children で渡す。
// エラーは role="alert" と id（aria-describedby 用）と data-testid（既定は id と同じ）を持つ。
export function FormField({
  id,
  label,
  hint,
  error,
  errorId,
  errorTestId,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  errorId?: string;
  errorTestId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const eid = errorId ?? `${id}-error`;
  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-slot="form-field">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && !error && <p className="text-sm text-muted-foreground">{hint}</p>}
      {error && (
        <p id={eid} role="alert" data-testid={errorTestId ?? eid} className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
