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
import { api, type ProbeResult, type SettingFieldView, type SettingsView } from "../api";

const PROBE_BY_GROUP: Record<string, string[]> = {
  飞书登录: ["feishu"],
  飞书推送: ["lark"],
  "百度 OCR": ["baidu"],
  "MiniMax（可选）": [],
  本机依赖: ["python", "blender"],
};

export function SettingsPage({ canWrite = true }: { canWrite?: boolean }) {
  const { message } = App.useApp();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [group, setGroup] = useState<string>("飞书登录");
  const [probes, setProbes] = useState<Record<string, ProbeResult | { pending: true }>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api
      .settings()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        if (next.groups[0]) setGroup(next.groups[0].title);
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

  const current = view?.groups.find((g) => g.title === group) || view?.groups[0];

  const menuItems = useMemo(
    () =>
      (view?.groups || []).map((g) => ({
        key: g.title,
        label: g.title,
      })),
    [view],
  );

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

  const groupProbes = (PROBE_BY_GROUP[current?.title || ""] || [])
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
            本机配置。密钥不回显、不进 git。换人换机在这里填。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          {(view?.probes || []).map((p) => {
            const r = probes[p.id];
            const done = r && !("pending" in r) ? r : null;
            const color = !done ? "default" : done.ok ? "success" : "error";
            return (
              <Tag key={p.id} color={color} bordered={false}>
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
            selectedKeys={[current?.title || group]}
            items={menuItems}
            onClick={({ key }) => setGroup(String(key))}
          />
        </aside>
        <div className="settings-main">
          <div className="settings-main-head">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {current?.title}
            </Typography.Title>
            {groupProbes.length ? (
              <Button onClick={() => void probeGroup()}>检测连通</Button>
            ) : null}
          </div>
          {groupProbes.map((p) => {
            const r = probes[p.id];
            const done = r && !("pending" in r) ? r : null;
            if (!done) return null;
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
          <Form layout="vertical" requiredMark={false} className="settings-form" disabled={!canWrite}>
            {(current?.fields || []).map((f) => (
              <FieldItem
                key={f.key}
                field={f}
                value={draft[f.key] ?? ""}
                onChange={(v) => setField(f.key, v)}
              />
            ))}
          </Form>
        </div>
      </div>

      <footer className="settings-footer">
        <Typography.Text type="secondary">保存后立即写入本机，部分项需重启。</Typography.Text>
        <Button type="primary" onClick={() => void save()} loading={saving} disabled={!canWrite}>
          保存
        </Button>
      </footer>
    </section>
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
