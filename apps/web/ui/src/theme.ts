import { theme as antdTheme, type ThemeConfig } from "antd";

const fontFamily =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Noto Sans SC", "Alibaba PuHuiTi", sans-serif';

const lightComponents: ThemeConfig["components"] = {
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
};

/** DESIGN.md：iOS 27 玻璃 + 淡紫点缀。不要默认蓝，不要旧 #722ED1。 */
export function buildTheme(mode: "light" | "dark", fontSize = 16): ThemeConfig {
  if (mode === "dark") {
    return {
      algorithm: antdTheme.darkAlgorithm,
      token: {
        colorPrimary: "#c9a3d6",
        colorSuccess: "#73d13d",
        colorWarning: "#e8a317",
        colorError: "#ff7875",
        colorInfo: "#c9a3d6",
        colorBgLayout: "#141018",
        colorBgContainer: "#2a2232",
        colorText: "#f6f1f8",
        colorTextSecondary: "#c9b8d4",
        colorBorder: "rgba(196, 163, 208, 0.28)",
        borderRadius: 16,
        fontSize,
        fontFamily,
        controlHeight: 40,
        fontWeightStrong: 600,
      },
      components: {
        Menu: {
          itemSelectedColor: "#f0d8f6",
          itemSelectedBg: "rgba(128, 88, 152, 0.38)",
          itemHoverBg: "rgba(255, 255, 255, 0.08)",
          itemColor: "#f6f1f8",
        },
        Tabs: {
          itemSelectedColor: "#f0d8f6",
          inkBarColor: "#c9a3d6",
        },
        Button: {
          borderRadius: 20,
        },
      },
    };
  }
  return {
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
      fontSize,
      fontFamily,
      controlHeight: 40,
    },
    components: lightComponents,
  };
}

export const theme = buildTheme("light", 16);
