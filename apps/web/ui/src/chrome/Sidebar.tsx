import { Dropdown } from "antd";
import { formatVersionLabel, SIDE_NAV, type NavKey } from "./nav";

export type { NavKey };

type Props = {
  collapsed: boolean;
  active: NavKey;
  displayName: string;
  avatarUrl?: string | null;
  onNavigate: (key: NavKey) => void;
  onToggle: () => void;
  onLogout: () => void;
  livePulse?: { review?: boolean; mockup?: boolean };
  version?: string | null;
};

function initial(name: string) {
  const t = name.trim();
  return t ? t.slice(0, 1) : "飞";
}

export function Sidebar({
  collapsed,
  active,
  displayName,
  avatarUrl,
  onNavigate,
  onToggle,
  onLogout,
  livePulse,
  version,
}: Props) {
  const versionLabel = formatVersionLabel(version);
  return (
    <aside
      className={collapsed ? "sidebar is-collapsed" : "sidebar"}
      aria-label="审稿室"
      aria-expanded={!collapsed}
    >
      <div className="sidebar-glass" aria-hidden="true" />
      <div className="brand-row">
        <button
          type="button"
          className="brand-hit"
          onClick={onToggle}
          tabIndex={collapsed ? 0 : -1}
          aria-hidden={!collapsed}
          aria-label="展开侧栏"
          aria-expanded={false}
        >
          <img className="brand-hit-logo" src="/brand/logo-mark.png" alt="" width={32} height={32} />
          <img
            className="brand-hit-expand"
            src="/brand/ui/sidebar-expand.svg"
            alt=""
            width={22}
            height={22}
          />
        </button>
        <img className="brand-mark" src="/brand/logo-mark.png" alt="" width={36} height={36} />
        <span className="brand-word">SHINE MAGE</span>
        <button
          type="button"
          className="brand-collapse"
          onClick={onToggle}
          tabIndex={collapsed ? -1 : 0}
          aria-hidden={collapsed}
          aria-label="折叠侧栏"
          aria-expanded={true}
        >
          <img src="/brand/ui/sidebar-collapse.svg" alt="" width={22} height={22} />
        </button>
      </div>

      <nav className="side-nav">
        {SIDE_NAV.map((item) => {
          const on = item.key === active;
          const live = (item.key === "review" && livePulse?.review) || (item.key === "mockup" && livePulse?.mockup);
          return (
            <button
              key={item.key}
              type="button"
              className={on ? "side-item is-on" : "side-item"}
              aria-current={on ? "page" : undefined}
              aria-label={live ? `${item.label}，进行中` : undefined}
              title={collapsed ? (live ? `${item.label} · 进行中` : item.label) : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <img className="side-icon" src={item.icon} alt="" width={24} height={24} />
              <span className="side-label">{item.label}</span>
              {live ? <span className="side-item-pulse" aria-hidden /> : null}
            </button>
          );
        })}
      </nav>

      <div className="side-spacer" />

      <Dropdown
        trigger={["click"]}
        placement="topLeft"
        menu={{
          items: [{ key: "logout", label: "退出", danger: true }],
          onClick: ({ key }) => {
            if (key === "logout") onLogout();
          },
        }}
      >
        <button type="button" className="account-row" aria-haspopup="menu" title={displayName}>
          {avatarUrl ? (
            <img className="account-avatar" src={avatarUrl} alt="" width={36} height={36} />
          ) : (
            <span className="account-fallback">{initial(displayName)}</span>
          )}
          <span className="account-copy">
            <span className="account-name">{displayName}</span>
            {versionLabel ? (
              <span className="sidebar-version" title={`当前版本 ${versionLabel}`}>
                {versionLabel}
              </span>
            ) : null}
          </span>
        </button>
      </Dropdown>
    </aside>
  );
}
