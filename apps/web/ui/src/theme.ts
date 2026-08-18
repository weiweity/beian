import type { ThemeConfig } from "antd";

/** DESIGN.md：极客紫 + 大字。不要默认蓝。 */
export const theme: ThemeConfig = {
  token: {
    colorPrimary: "#722ED1",
    colorSuccess: "#389E0D",
    colorWarning: "#D48806",
    colorError: "#F5222D",
    colorInfo: "#722ED1",
    colorBgLayout: "#F5F6F8",
    colorBgContainer: "#FFFFFF",
    colorText: "#1F2329",
    colorTextSecondary: "#646A73",
    colorBorder: "#DEE0E3",
    borderRadius: 8,
    fontSize: 16,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Noto Sans SC", sans-serif',
    controlHeight: 40,
  },
  components: {
    Menu: {
      itemSelectedColor: "#722ED1",
      itemSelectedBg: "#F9F0FF",
      itemHoverBg: "#F9F0FF",
    },
    Tabs: {
      itemSelectedColor: "#722ED1",
      inkBarColor: "#722ED1",
    },
  },
};
