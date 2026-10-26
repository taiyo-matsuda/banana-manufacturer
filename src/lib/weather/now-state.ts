// 圃場の詳細の「今すぐ取り込む」（Server Action）の結果の形（"use server" のファイルは型を export しないのでここに置く）
export type WeatherNowState = {
  done: number; // 実行した回数
  message: string | null;
  error: string | null;
};

export const INITIAL_WEATHER_NOW_STATE: WeatherNowState = { done: 0, message: null, error: null };
