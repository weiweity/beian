import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Input, Space, Switch, Typography } from "antd";
import { api, type ProbeResult, type SettingFieldView, type SettingsView } from "../api";

export function SettingsPage() {
  const { message } = App.useApp();
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeResult | { pending: true }>>({});

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

  function setField(key: string, value: string) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    if (!view) return;
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

  if (loading) {
    return (
      <section>
        <Typography.Title level={3}>设置</Typography.Title>
        <Typography.Paragraph type="secondary">读取本机配置…</Typography.Paragraph>
      </section>
    );
  }

  return (
    <section className="settings">
      <Typography.Title level={3} style={{ marginBottom: 4 }}>
        设置
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        换人用时在这里填。密钥只存在这台电脑，界面不会回显。不要改代码、不要提交到 git。
      </Typography.Paragraph>
      {error ? <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} /> : null}
      {restart ? (
        <Alert
          type="warning"
          showIcon
          message="数据目录或公网开关改过，需要重启服务后才完全生效。"
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {view ? (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Typography.Text strong>连通探测</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ margin: "4px 0 12px" }}>
            测的是这台机器现在的配置，不会把密钥带回页面。
          </Typography.Paragraph>
          <Space wrap>
            {view.probes.map((p) => {
              const r = probes[p.id];
              const pending = r && "pending" in r;
              const done = r && !("pending" in r) ? r : null;
              return (
                <Button key={p.id} onClick={() => void probe(p.id)} loading={Boolean(pending)}>
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
                {view.probes.find((p) => p.id === r.id)?.label}：{r.message}
              </Typography.Paragraph>
            ))}
        </Card>
      ) : null}

      {(view?.groups || []).map((g) => (
        <Card key={g.title} title={g.title} size="small" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            {g.fields.map((f) => (
              <FieldRow key={f.key} field={f} value={draft[f.key] ?? ""} onChange={(v) => setField(f.key, v)} />
            ))}
          </Space>
        </Card>
      ))}

      <Button type="primary" onClick={() => void save()} loading={saving}>
        保存到本机
      </Button>
    </section>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: SettingFieldView;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Typography.Text>{field.label}</Typography.Text>
      {field.restart ? (
        <Typography.Text type="secondary"> · 改完要重启</Typography.Text>
      ) : null}
      <div style={{ marginTop: 6 }}>
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
          <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.help} />
        )}
      </div>
      <Typography.Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 13 }}>
        {field.help}
      </Typography.Paragraph>
    </div>
  );
}
