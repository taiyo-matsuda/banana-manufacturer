import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoginForm } from "./login-form";

// ログイン画面。Sign Up やパスワードリセットの導線は置かない（アカウントは管理者が作る）。
// 下部タブ・ヘッダは出さない（ログイン前）。
export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col justify-center px-4 py-8">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
          <p className="text-sm text-muted-foreground">バナナ生育記録</p>
          <h1 className="text-2xl font-semibold">ログイン</h1>
        </div>
        <Card>
          <CardHeader className="sr-only">
            <CardTitle>メールアドレスとパスワード</CardTitle>
          </CardHeader>
          <CardContent>
            <LoginForm />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
