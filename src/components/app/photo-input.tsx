"use client";

import { CameraIcon } from "lucide-react";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";

// 撮影ボタン（UX-1）: <input type="file" accept="image/*" capture="environment"> をボタンの見た目のラベルで包む。
// 生の <input> はここにだけ置く（src/app/ には書かない）。iPhone ではカメラが起動する。
export function PhotoInput({
  label,
  busy = false,
  onChange,
  inputRef,
  className,
  testId = "photo-input",
  statusTestId = "photo-status",
}: {
  label: string;
  busy?: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  className?: string;
  testId?: string;
  statusTestId?: string;
}) {
  return (
    <label
      className={cn(
        buttonVariants({ variant: "default", size: "lg" }),
        "w-full cursor-pointer",
        busy && "pointer-events-none opacity-60",
        className,
      )}
    >
      <CameraIcon aria-hidden="true" />
      <span data-testid={statusTestId}>{label}</span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={onChange}
        disabled={busy}
        className="sr-only"
        data-testid={testId}
      />
    </label>
  );
}
