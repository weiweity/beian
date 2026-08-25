import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { buildTheme } from "../theme";
import {
  applyAppearance,
  loadAppearance,
  parseAppearance,
  resolveTheme,
  saveAppearance,
  type Appearance,
} from "./appearance";

type Ctx = {
  prefs: Appearance;
  setPrefs: (next: Appearance) => void;
  resolved: "light" | "dark";
  setActor: (openId: string) => void;
};

const AppearanceContext = createContext<Ctx | null>(null);

export function useAppearance(): Ctx {
  const ctx = useContext(AppearanceContext);
  if (!ctx) throw new Error("AppearanceRoot missing");
  return ctx;
}

function readSystemDark() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function AppearanceRoot({ children }: { children: ReactNode }) {
  const [actor, setActorState] = useState("");
  const [prefs, setPrefsState] = useState(() => loadAppearance(""));
  const [systemDark, setSystemDark] = useState(readSystemDark);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    applyAppearance(prefs, systemDark);
  }, [prefs, systemDark]);

  const setActor = useCallback((openId: string) => {
    const id = (openId || "").trim();
    setActorState(id);
    setPrefsState(loadAppearance(id));
  }, []);

  const setPrefs = useCallback((next: Appearance) => {
    const clean = parseAppearance(next);
    saveAppearance(clean, actor);
    setPrefsState(clean);
  }, [actor]);

  const resolved = resolveTheme(prefs.theme, systemDark);
  const theme = useMemo(() => buildTheme(resolved, prefs.fontPx), [resolved, prefs.fontPx]);

  return (
    <AppearanceContext.Provider value={{ prefs, setPrefs, resolved, setActor }}>
      <ConfigProvider locale={zhCN} theme={theme}>
        {children}
      </ConfigProvider>
    </AppearanceContext.Provider>
  );
}
