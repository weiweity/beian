export type NavKey = "review" | "mockup" | "history" | "settings";

export const SIDE_NAV: { key: NavKey; label: string; icon: string }[] = [
  { key: "review", label: "审稿台", icon: "/brand/ui/nav-review.svg" },
  { key: "mockup", label: "打样台", icon: "/brand/ui/nav-mockup.svg" },
  { key: "history", label: "历史记录", icon: "/brand/ui/nav-history.svg" },
  { key: "settings", label: "设置", icon: "/brand/ui/nav-settings.svg" },
];
