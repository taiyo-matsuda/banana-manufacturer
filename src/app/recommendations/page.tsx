import { Suspense } from "react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { RecommendationList } from "../recommendation-list";
import { fetchOpenRecommendations } from "./data";

// 提案の全件（3-4、画面 1 の「提案」の「すべて見る」）。ホームと同じ一覧（src/app/recommendation-list.tsx）で、open の提案を期限順に全件。
export default function RecommendationsPage() {
  return (
    <AppScreen title="提案" backHref="/" backLabel="ホーム" current="home">
      <Suspense fallback={<LoadingText />}>
        <RecommendationsAll />
      </Suspense>
    </AppScreen>
  );
}

async function RecommendationsAll() {
  const { rows, error } = await fetchOpenRecommendations();
  if (error) {
    return (
      <p role="alert" className="text-destructive">
        提案を取得できませんでした（{error}）
      </p>
    );
  }
  return <RecommendationList rows={rows} />;
}
