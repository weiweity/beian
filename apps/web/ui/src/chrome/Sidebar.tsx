import { Dropdown } from "antd";
import { SIDE_NAV, type NavKey } from "./nav";

export type { NavKey };

type Props = {
  collapsed: boolean;
  active: NavKey;
  displayName: string;
  avatarUrl?: string | null;
  onNavigate: (key: NavKey) => void;
  onToggle: () => void;
  onLogout: () => void;
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
}: Props) {
  return (
    <aside className={collapsed ? "sidebar is-collapsed" : "sidebar"} aria-label="审稿室">
      {collapsed ? (
        <button type="button" className="brand-hit" onClick={onToggle} aria-label="展开侧栏">
          <img className="brand-hit-logo" src="/brand/logo-mark.png" alt="" width={32} height={32} />
          <img
            className="brand-hit-expand"
            src="/brand/ui/sidebar-expand.svg"
            alt=""
            width={22}
            height={22}
          />
        </button>
      ) : (
        <div className="brand-row">
          <img className="brand-mark" src="/brand/logo-mark.png" alt="" width={36} height={36} />
          <span className="brand-word">SHINE MAGE</span>
          <button type="button" className="brand-collapse" onClick={onToggle} aria-label="折叠侧栏">
            <img src="/brand/ui/sidebar-collapse.svg" alt="" width={22} height={22} />
          </button>
        </div>
      )}

      <nav className="side-nav">
        {SIDE_NAV.map((item) => {
          const on = item.key === active;
          return (
            <button
              key={item.key}
              type="button"
              className={on ? "side-item is-on" : "side-item"}
              aria-current={on ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              onClick={() => onNavigate(item.key)}
            >
              <img className="side-icon" src={item.icon} alt="" width={24} height={24} />
              {collapsed ? null : <span className="side-label">{item.label}</span>}
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
          {collapsed ? null : <span className="account-name">{displayName}</span>}
        </button>
      </Dropdown>
    </aside>
  );
}
