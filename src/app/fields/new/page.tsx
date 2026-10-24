import { AppScreen } from "@/components/app/app-screen";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldForm } from "../field-form";

// 圃場の新規登録（一覧 /fields とは別画面。UX-1 完了条件 3）。登録できたら一覧へ戻る。
// 認証はフォーム送信時（Server Action）と proxy で確認する。
export default function NewFieldPage() {
  return (
    <AppScreen title="圃場を追加" backHref="/fields" backLabel="圃場" current="settings">
      <Card>
        <CardHeader>
          <CardTitle>新しい圃場</CardTitle>
          <CardDescription>名前・圃場記号・代表点（緯度経度）を入れます。株の配置は登録後に地図で行います</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldForm />
        </CardContent>
      </Card>
    </AppScreen>
  );
}
