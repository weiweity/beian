import type { ThemeConfig } from "antd";

/** DESIGN.md：iOS 27 玻璃 + 淡紫点缀。不要默认蓝，不要旧 #722ED1。 */
export const theme: ThemeConfig = {
  token: {
    colorPrimary: "#805898",
    colorSuccess: "#389E0D",
    colorWarning: "#D48806",
    colorError: "#F5222D",
    colorInfo: "#805898",
    colorBgLayout: "#F8F5FA",
    colorBgContainer: "#FFFFFF",
    colorText: "#1C1A1F",
    colorTextSecondary: "#6B6572",
    colorBorder: "#E7E2EC",
    borderRadius: 16,
    fontSize: 16,
    fontFamily:
      '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Noto Sans SC", "Alibaba PuHuiTi", sans-serif',
    controlHeight: 40,
  },
  components: {
    Menu: {
      itemSelectedColor: "#805898",
      itemSelectedBg: "#F6F1F8",
      itemHoverBg: "#F6F1F8",
    },
    Tabs: {
      itemSelectedColor: "#805898",
      inkBarColor: "#805898",
    },
    Button: {
      borderRadius: 20,
    },
  },
};
