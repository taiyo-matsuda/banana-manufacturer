import { LoginForm } from "./login-form";

// ログイン画面。Sign Up やパスワードリセットの導線は置かない（アカウントは管理者が作る）。
export default function LoginPage() {
  return (
    <main className="flex flex-1 flex-col justify-center px-4 py-8">
      <div className="mx-auto w-full max-w-sm">
        <h1 className="mb-6 text-2xl font-semibold">ログイン</h1>
        <LoginForm />
      </div>
    </main>
  );
}
