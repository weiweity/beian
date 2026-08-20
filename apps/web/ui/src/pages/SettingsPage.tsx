import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Menu,
  Space,
  Switch,
  Tag,
  Typography,
} from "antd";
import {
  api,
  type BillingView,
  type ProbeResult,
  type SettingFieldView,
  type SettingsView,
} from "../api";
import { BillingPane } from "../features/billing/BillingPane";
import { AppearancePane } from "../chrome/AppearancePane";

const PROBE_BY_GROUP: Record<string, string[]> = {
  开工板: ["feishu", "baidu", "python", "blender", "lark", "minimax"],
  飞书登录: ["feishu"],
  飞书推送: ["lark"],
  "百度 OCR": ["baidu"],
  "MiniMax（可选）": ["minimax"],
  本机依赖: ["python", "blender"],
};

const VIRTUAL = new Set(["外观", "开工板", "费用账单"]);

type Props = { canWrite?: boolean; openId?: string; displayName?: string | null };

export function SettingsPage({ canWrite = true, openId = "", displayName = "" }: Props) {
  const { message } = App.useApp();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [group, setGroup] = useState<string>("外观");
  const [probes, setProbes] = useState<Record<string, ProbeResult | { pending: true }>>({});
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [billBusy, setBillBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .settings()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        const init: Record<string, string> = {};
        for (const g of next.groups) {
          for (const f of g.fields) init[f.key] = f.kind === "secret" ? "" : f.value;
        }
        setDraft(init);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "读不到设置");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (group !== "费用账单") return;
    let cancelled = false;
    void api
      .billing()
      .then((b) => {
        if (!cancelled) setBilling(b);
      })
      .catch(() => {
        /* 稍后手动刷 */
      });
    const onFocus = () => {
      void api
        .billing()
        .then((b) => {
          if (!cancelled) setBilling(b);
        })
        .catch(() => {
          /* ignore */
        });
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [group]);

  const catalogGroup = view?.groups.find((g) => g.title === group);
  const menuItems = useMemo(() => {
    const extra = [
      { key: "外观", label: "外观" },
      { key: "开工板", label: "开工板" },
      { key: "费用账单", label: "费用账单" },
    ];
    return [...extra, ...(view?.groups || []).map((g) => ({ key: g.title, label: g.title }))];
  }, [view]);

  function setField(key: string, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    if (!view || !canWrite) return;
    const values: Record<string, string> = {};
    for (const g of view.groups) {
      for (const f of g.fields) {
        if (f.kind === "secret") {
          if ((draft[f.key] || "").trim()) values[f.key] = draft[f.key];
        } else {
          values[f.key] = draft[f.key] ?? "";
        }
      }
    }
    setSaving(true);
    setError(null);
    try {
      const next = await api.saveSettings(values);
      setView(next);
      setRestart(Boolean(next.restart));
      const init: Record<string, string> = {};
      for (const g of next.groups) {
        for (const f of g.fields) init[f.key] = f.kind === "secret" ? "" : f.value;
      }
      setDraft(init);
      message.success(next.restart ? "已保存。改了需要重启的项，请重启服务。" : "已保存到本机。");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function probe(id: string) {
    setProbes((prev) => ({ ...prev, [id]: { pending: true } }));
    try {
      const r = await api.probe(id);
      setProbes((prev) => ({ ...prev, [id]: r }));
    } catch (err: unknown) {
      setProbes((prev) => ({
        ...prev,
        [id]: { id, ok: false, message: err instanceof Error ? err.message : "探测失败" },
      }));
    }
  }

  async function probeGroup() {
    const ids = PROBE_BY_GROUP[group] || [];
    for (const id of ids) await probe(id);
  }

  async function refreshBills() {
    setBillBusy(true);
    try {
      setBilling(await api.refreshBilling());
      message.success("已强制刷新厂商余额和月账单");
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : "账单刷新失败");
    } finally {
      setBillBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="settings-page">
        <header className="settings-head">
          <Typography.Title level={3} style={{ margin: 0 }}>
            设置
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0" }}>
            读取本机配置…
          </Typography.Paragraph>
        </header>
      </section>
    );
  }

  const groupProbes = (PROBE_BY_GROUP[group] || [])
    .map((id) => view?.probes.find((p) => p.id === id))
    .filter((p): p is { id: string; label: string } => Boolean(p));

  return (
    <section className="settings-page">
      <header className="settings-head">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            设置
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0" }}>
            开工、费用、密钥都在这里。密钥不回显、不进 git。权限以后再切。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          {(view?.probes || []).map((p) => {
            const r = probes[p.id];
            const done = r && !("pending" in r) ? r : null;
            const color = !done ? "default" : done.ok ? "success" : "error";
            return (
              <Tag key={p.id} color={color} variant="filled">
                {p.label}
                {done ? (done.ok ? " 通" : " 不通") : " 未测"}
              </Tag>
            );
          })}
        </Space>
      </header>

      {error ? <Alert type="error" showIcon message={error} className="settings-alert" /> : null}
      {!canWrite ? (
        <Alert type="info" showIcon message="只读。改配置需要审核员或管理员。" className="settings-alert" />
      ) : null}
      {restart ? (
        <Alert
          type="warning"
          showIcon
          message="数据目录或公网开关改过，需要重启服务后才完全生效。"
          className="settings-alert"
        />
      ) : null}

      <div className="settings-body">
        <aside className="settings-aside">
          <Menu
            mode="inline"
            selectedKeys={[group]}
            items={menuItems}
            onClick={({ key }) => setGroup(String(key))}
          />
        </aside>
        <div className="settings-main">
          <div className="settings-main-head">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {group}
            </Typography.Title>
            {group === "费用账单" ? (
              <Button type="primary" loading={billBusy} onClick={() => void refreshBills()}>
                强制刷新厂商
              </Button>
            ) : groupProbes.length ? (
              <Button onClick={() => void probeGroup()}>{group === "开工板" ? "全部检测" : "检测连通"}</Button>
            ) : null}
          </div>

          {group === "外观" ? <AppearancePane /> : null}

          {group === "开工板" ? (
            <HealthPane
              view={view}
              probes={probes}
              openId={openId}
              displayName={displayName}
              onProbe={(id) => void probe(id)}
            />
          ) : null}

          {group === "费用账单" ? <BillingPane billing={billing} /> : null}

          {groupProbes.map((p) => {
            const r = probes[p.id];
            const done = r && !("pending" in r) ? r : null;
            if (!done || VIRTUAL.has(group)) return null;
            return (
              <Typography.Paragraph
                key={p.id}
                type={done.ok ? "secondary" : "danger"}
                style={{ margin: "0 0 8px" }}
              >
                {p.label}：{done.message}
              </Typography.Paragraph>
            );
          })}

          {group === "飞书推送" ? (
            <Button style={{ marginBottom: 16 }} onClick={() => void probe("lark_send")}>
              给推送对象发一条测试
            </Button>
          ) : null}

          {!VIRTUAL.has(group) ? (
            <Form layout="vertical" requiredMark={false} className="settings-form" disabled={!canWrite}>
              {(catalogGroup?.fields || []).map((f) => (
                <FieldItem
                  key={f.key}
                  field={f}
                  value={draft[f.key] ?? ""}
                  onChange={(v) => setField(f.key, v)}
                />
              ))}
            </Form>
          ) : null}
        </div>
      </div>

      {group === "外观" ? null : (
        <footer className="settings-footer">
          <Typography.Text type="secondary">保存后立即写入本机，部分项需重启。</Typography.Text>
          <Button type="primary" onClick={() => void save()} loading={saving} disabled={!canWrite}>
            保存
          </Button>
        </footer>
      )}
    </section>
  );
}

function HealthPane({
  view,
  probes,
  openId,
  displayName,
  onProbe,
}: {
  view: SettingsView | null;
  probes: Record<string, ProbeResult | { pending: true }>;
  openId: string;
  displayName: string | null;
  onProbe: (id: string) => void;
}) {
  const steps = view?.health
    ? Object.entries(view.health)
    : [];
  return (
    <div className="health-grid">
      {steps.map(([key, step]) => (
        <div key={key} className={step.ok ? "health-card is-ok" : "health-card"}>
          <div className="health-card-kicker">{step.ok ? "可以" : "还缺"}</div>
          <strong>{step.title}</strong>
          <p>{step.detail}</p>
        </div>
      ))}
      <div className="health-meta">
        <Typography.Paragraph type="secondary">
          当前登录：{displayName || "—"}
          {openId ? " · 飞书身份" : ""}
          {openId ? ` · ${openId}` : " · 显示名登录没有 open_id"}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          派生回调：{view?.derived?.redirect_uri || "—"}
        </Typography.Paragraph>
        <Space wrap>
          {(view?.probes || []).map((p) => {
            const r = probes[p.id];
            const done = r && !("pending" in r) ? r : null;
            return (
              <Button key={p.id} size="small" onClick={() => onProbe(p.id)}>
                {p.label}
                {done ? (done.ok ? " · 通" : " · 不通") : ""}
              </Button>
            );
          })}
        </Space>
        {Object.values(probes)
          .filter((r): r is ProbeResult => Boolean(r) && !("pending" in r))
          .map((r) => (
            <Typography.Paragraph key={r.id} type={r.ok ? "secondary" : "danger"} style={{ margin: "8px 0 0" }}>
              {r.message}
            </Typography.Paragraph>
          ))}
      </div>
    </div>
  );
}

function FieldItem({
  field,
  value,
  onChange,
}: {
  field: SettingFieldView;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Form.Item
      label={
        <span>
          {field.label}
          {field.restart ? <Typography.Text type="secondary">（改完重启）</Typography.Text> : null}
        </span>
      }
      extra={field.help}
    >
      {field.kind === "toggle" ? (
        <Switch checked={value === "true"} onChange={(on) => onChange(on ? "true" : "false")} />
      ) : field.kind === "secret" ? (
        <Input.Password
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          placeholder={field.set ? `已填 ${field.last4}，留空不改` : "未填"}
        />
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </Form.Item>
  );
}
