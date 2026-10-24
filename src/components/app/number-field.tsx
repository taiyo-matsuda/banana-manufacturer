import { cn } from "cn";
import { Input } from "@/components/ui/input";
import { FormField } from "./form-field";

// 数値入力（UX-1）: ラベル＋数値入力＋単位。高さ・幅は Input と同じ（h-12）。
// 整数は inputMode="numeric"、小数は "decimal"（iPhone のキーボードが変わる）。
export function NumberField({
  id,
  label,
  unit,
  hint,
  error,
  errorId,
  errorTestId,
  className,
  inputMode = "numeric",
  ...inputProps
}: Omit<React.ComponentProps<typeof Input>, "type" | "id"> & {
  id: string;
  label: string;
  unit?: string;
  hint?: string;
  error?: string | null;
  errorId?: string;
  errorTestId?: string;
  inputMode?: "numeric" | "decimal";
}) {
  const eid = errorId ?? `${id}-error`;
  return (
    <FormField id={id} label={label} hint={hint} error={error} errorId={eid} errorTestId={errorTestId} className={className}>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode={inputMode}
          className={cn("flex-1", unit && "max-w-48")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? eid : undefined}
          {...inputProps}
        />
        {unit && <span className="shrink-0 text-muted-foreground">{unit}</span>}
      </div>
    </FormField>
  );
}
