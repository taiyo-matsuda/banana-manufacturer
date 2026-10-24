import Link from "next/link";
import { HomeIcon } from "lucide-react";
import { AppScreen } from "@/components/app/app-screen";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// 見つからない画面（404。UX-1）。存在しない id や、別の組織の株・圃場（RLS で見えない）を開いたとき。
// PWA には戻るボタンが無いので、ヘッダのホームと下部タブで行き止まりにしない。
export default function NotFound() {
  return (
    <AppScreen title="見つかりません">
      <Card data-testid="not-found">
        <CardHeader>
          <CardTitle className="text-2xl" role="heading" aria-level={2}>
            404
          </CardTitle>
          <CardDescription>
            開こうとした画面（株・圃場・茎）が見つかりません。削除されたか、この組織からは見られない記録です。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="lg" className="w-full">
            <Link href="/">
              <HomeIcon aria-hidden="true" />
              ホームへ
            </Link>
          </Button>
        </CardContent>
      </Card>
    </AppScreen>
  );
}
