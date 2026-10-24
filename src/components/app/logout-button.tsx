"use client";

import { LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logout } from "@/app/login/actions";
import { clearDeviceStore } from "./device-store";

// ログアウト（設定 /fields）。送信の前に端末に残した「最近開いた株」「直近の圃場」を消す
// （次に別のユーザーでログインしたとき、見えない株・圃場に案内しないように）。ログアウト自体の挙動は従来どおり。
export function LogoutButton() {
  return (
    <form action={logout} onSubmit={() => clearDeviceStore()}>
      <Button type="submit" variant="outline" className="w-full" data-testid="logout">
        <LogOutIcon aria-hidden="true" />
        ログアウト
      </Button>
    </form>
  );
}
