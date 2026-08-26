import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Form, Input, Menu, Segmented, Switch, Typography } from "antd";
import {
  api,
  type BillingView,
  type ProbeResult,
  type SettingFieldView,
  type SettingsView,
} from "../api";
import { BillingPane } from "../features/billing/BillingPane";
import { AppearancePane } from "../chrome/AppearancePane";
import {
  BOARD_ROWS,
  HOST_INTRO,
  PROBE_BY_GROUP,
  SETUP_RETURN,
  VIRTUAL,
  WIZARD,
  feishuAppReady,
  feishuLoginHref,
  firstBadRow,
  foldCatalogReason,
  isPending,
  probeErrorMessage,
  progressSpoken,
  rowDetail,
  setupHeadline,
  shortGroupLabel,
  statusWord,
  type WizardGuide,
} from "./setupBoard";

type ScanHit = { kind: string; label: string; path: string };

type Props = {
  canAdmin?: boolean;
  openId?: string;
  displayName?: string | null;
};

function readGroupParam(): string {
  try {
    return new URLSearchParams(window.location.search).get("group") || "";
  } catch {
    return "";
  }
}

export function SettingsPage({
  canAdmin = false,
  openId = "",
  displayName = "",
}: Props) {
  const { message } = App.useApp();
  const canWrite = canAdmin;
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [group, setGroup] = useState<string>(() => readGroupParam() || "外观");
  const [probes, setProbes] = useState<Record<string, ProbeResult | { pending: true }>>({});
  const [probeBusy, setProbeBusy] = useState("");
  const [scanHits, setScanHits] = useState<ScanHit[]>([]);
  const [scanMsg, setScanMsg] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [billing, setBilling] = useState<BillingView | null>(null);
  const [billBusy, setBillBusy] = useState(false);
  const [openSecrets, setOpenSecrets] = useState<Record<string, boolean>>({});

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
      let bounce = "";
      try {
        bounce = sessionStorage.getItem(SETUP_RETURN) || "";
        sessionStorage.removeItem(SETUP_RETURN);
      } catch {
        bounce = "";
      }
      if (bounce) {
        setGroup("开工板");
        void probe(bounce);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function probe(id: string) {
    const rowId = id === "lark_send" ? "lark" : id;
    setProbes((prev) => ({ ...prev, [id]: { pending: true }, [rowId]: { pending: true } }));
    try {
      const r = await api.probe(id);
      setProbes((prev) => {
        const next = { ...prev, [id]: r };
        if (r.id) next[r.id] = r;
        if (rowId !== id) next[rowId] = { ...r, id: rowId };
        return next;
      });
      return r;
    } catch (err: unknown) {
      const fail = { id: rowId, ok: false as const, message: probeErrorMessage(err) };
      setProbes((prev) => ({ ...prev, [id]: fail, [rowId]: fail }));
      return fail;
    }
  }

  async function sendPushTest() {
    const back = group === "飞书推送" ? "飞书推送" : "开工板";
    if (!openId) {
      if (feishuAppReady(view?.groups)) {
        message.loading("没有飞书身份。正在带你去授权…", 1.2);
        window.location.assign(feishuLoginHref(back));
        return;
      }
      message.warning("还没填飞书 App ID / Secret。先走登录向导，再授权。");
      setGroup("飞书登录");
      return;
    }
    const hide = message.loading("正在发给你的飞书…", 0);
    try {
      const r = await probe("lark_send");
      if (r.ok) {
        message.success(r.message);
        try {
          const next = await api.settings();
          setView(next);
        } catch {
          /* 发送结果已经在行上 */
        }
      } else {
        message.error(r.message);
        if (/App ID|Secret|凭证/.test(r.message)) setGroup("飞书登录");
      }
    } finally {
      hide();
    }
  }

  async function probeRow(id: string) {
    const r = await probe(id);
    if (r.ok) message.success(r.message);
    else message.error(r.message);
    return r;
  }

  async function probeGroup() {
    const ids = PROBE_BY_GROUP[group] || [];
    setProbeBusy(`检测中 0/${ids.length}`);
    for (let i = 0; i < ids.length; i++) {
      setProbeBusy(`检测中 ${i + 1}/${ids.length}`);
      await probe(ids[i]);
    }
    setProbeBusy("");
  }

  async function scanPc() {
    if (!canAdmin) {
      message.error("扫描这台电脑需要管理员魏炜。刷新页面后再试。");
      return;
    }
    setScanBusy(true);
    setScanMsg("扫描中，白名单目录，最多 8 秒。");
    try {
      const r = await api.scanLocal();
      setScanHits(r.hits);
      setScanMsg(
        r.timedOut && r.roots?.length
          ? `${r.message} 搜过：${r.roots.join("、")}`
          : r.message,
      );
      const next: Record<string, string> = {};
      for (const h of r.hits) {
        if (!next[h.kind]) next[h.kind] = h.path;
      }
      setPick(next);
    } catch (err: unknown) {
      setScanMsg(err instanceof Error ? err.message : "扫描失败");
    } finally {
      setScanBusy(false);
    }
  }

  async function adopt(kind: string, path: string) {
    const key =
      kind === "blender"
        ? "BLENDER_EXECUTABLE"
        : kind === "illustrator"
          ? "ILLUSTRATOR_EXECUTABLE"
          : kind === "python"
            ? "WB_PYTHON"
            : "";
    if (!key) return;
    try {
      const next = await api.saveSettings({ [key]: path });
      setView(next);
      setDraft((prev) => ({ ...prev, [key]: path }));
      message.success("已采用路径");
      await probe(kind === "python" ? "python" : kind);
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : "保存失败");
    }
  }

  function openWizard(row: (typeof BOARD_ROWS)[number]) {
    try {
      sessionStorage.setItem(SETUP_RETURN, row.id);
    } catch {
      /* ignore */
    }
    setGroup(row.group);
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
          <h1 className="settings-title">设置</h1>
          <p className="settings-lead">读取本机配置…</p>
        </header>
      </section>
    );
  }

  const groupProbes = (PROBE_BY_GROUP[group] || [])
    .map((id) => view?.probes.find((p) => p.id === id))
    .filter((p): p is { id: string; label: string } => Boolean(p));
  const wizard = WIZARD[group];
  const showBack = Boolean(wizard) || group === "飞书推送" || group === "本机依赖";
  const foldReason = catalogGroup
    ? foldCatalogReason(group, catalogGroup.fields, probes[PROBE_BY_GROUP[group]?.[0] || ""])
    : null;
  const hideWizard = Boolean(foldReason && group !== "飞书推送");
  const sendingPush = isPending(probes.lark_send);

  return (
    <section className="settings-page">
      <header className="settings-head">
        <h1 className="settings-title">设置</h1>
        <p className="settings-lead">
          {group === "开工板" ? setupHeadline(probes) : "密钥不回显、不进 git。籽烨不用进这页。"}
        </p>
      </header>

      {error ? <Alert type="error" showIcon title={error} className="settings-alert" /> : null}
      {!canWrite ? (
        <Alert
          type="info"
          showIcon
          title="系统配置只允许管理员修改；你仍可检测连通，并给当前登录发送测试消息。"
          className="settings-alert"
        />
      ) : null}
      {restart ? (
        <Alert
          type="warning"
          showIcon
          title="数据目录或公网开关改过，需要重启服务后才完全生效。"
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
          <div className="settings-pills" role="navigation" aria-label="设置分组">
            <Segmented
              value={group}
              options={menuItems.map((it) => ({
                label: shortGroupLabel(String(it.key)),
                value: it.key,
              }))}
              onChange={(v) => setGroup(String(v))}
            />
          </div>
          <div className="settings-main-head">
            <h2 className="settings-group-title">{group}</h2>
            {group === "费用账单" ? (
              <Button type="primary" loading={billBusy} onClick={() => void refreshBills()}>
                强制刷新厂商
              </Button>
            ) : group === "开工板" ? (
              <div className="setup-actions">
                <Button onClick={() => void scanPc()} loading={scanBusy} disabled={!canAdmin}>
                  {canAdmin ? "扫描这台电脑" : "扫描需管理员"}
                </Button>
                <Button type="primary" onClick={() => void probeGroup()} loading={Boolean(probeBusy)}>
                  {probeBusy || "全部检测"}
                </Button>
              </div>
            ) : groupProbes.length ? (
              <Button onClick={() => void probeGroup()} loading={Boolean(probeBusy)}>
                {probeBusy || "检测连通"}
              </Button>
            ) : null}
          </div>

          {group === "外观" ? <AppearancePane /> : null}

          {group === "开工板" ? (
            <SetupBoard
              probes={probes}
              probeBusy={probeBusy}
              scanHits={scanHits}
              scanMsg={scanMsg}
              pick={pick}
              onPick={(kind, path) => setPick((p) => ({ ...p, [kind]: path }))}
              onAdopt={(kind, path) => void adopt(kind, path)}
              onProbe={(id) => void probeRow(id)}
              onWizard={(row) => openWizard(row)}
              onScan={() => void scanPc()}
              onPush={() => void sendPushTest()}
              scanBusy={scanBusy}
              displayName={displayName}
              openId={openId}
              canAdmin={canAdmin}
            />
          ) : null}

          {group === "费用账单" ? <BillingPane billing={billing} /> : null}

          {wizard && !hideWizard ? <WizardSteps guide={wizard} /> : null}
          {group === "本机依赖" ? <p className="wizard-intro">{HOST_INTRO}</p> : null}

          {groupProbes.map((p) => {
            const r = probes[p.id];
            const done = r && !("pending" in r) ? r : null;
            if (!done || VIRTUAL.has(group)) return null;
            return (
              <p key={p.id} className={done.ok ? "probe-line is-ok" : "probe-line is-bad"}>
                {p.label}：{done.message}
              </p>
            );
          })}

          {group === "飞书登录" ? (
            <Button className="wizard-cta" onClick={() => window.location.assign(feishuLoginHref("开工板"))}>
              用飞书走一遍授权
            </Button>
          ) : null}
          {group === "飞书推送" ? (
            <Button type="primary" className="wizard-cta" loading={sendingPush} onClick={() => void sendPushTest()}>
              {openId ? "给当前登录发一条测试" : feishuAppReady(view?.groups) ? "先用飞书授权，再发测试" : "先填飞书登录凭证"}
            </Button>
          ) : null}
          {showBack ? (
            <Button className="wizard-back" onClick={() => setGroup("开工板")}>
              回开工板
            </Button>
          ) : null}

          {!VIRTUAL.has(group) ? (
            <CatalogFields
              group={group}
              fields={catalogGroup?.fields || []}
              draft={draft}
              canWrite={canWrite}
              canAdmin={canAdmin}
              probe={probes[PROBE_BY_GROUP[group]?.[0] || ""]}
              opened={Boolean(openSecrets[group])}
              onToggle={() => setOpenSecrets((p) => ({ ...p, [group]: !p[group] }))}
              onChange={setField}
            />
          ) : null}
        </div>
      </div>

      {group === "外观" || group === "开工板" ? null : (
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

function WizardSteps({ guide }: { guide: WizardGuide }) {
  return (
    <div className="wizard">
      <p className="wizard-intro">{guide.intro}</p>
      <ol className="wizard-steps">
        {guide.steps.map((step, i) => (
          <li key={step}>
            <span className="wizard-n" aria-hidden="true">
              {i + 1}
            </span>
            <p>{step}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function SetupBoard({
  probes,
  probeBusy,
  scanHits,
  scanMsg,
  pick,
  onPick,
  onAdopt,
  onProbe,
  onWizard,
  onScan,
  onPush,
  displayName,
  openId,
  canAdmin,
  scanBusy,
}: {
  probes: Record<string, ProbeResult | { pending: true }>;
  probeBusy: string;
  scanHits: ScanHit[];
  scanMsg: string;
  pick: Record<string, string>;
  onPick: (kind: string, path: string) => void;
  onAdopt: (kind: string, path: string) => void;
  onProbe: (id: string) => void;
  onWizard: (row: (typeof BOARD_ROWS)[number]) => void;
  onScan: () => void;
  onPush: () => void;
  displayName: string | null;
  openId: string;
  canAdmin: boolean;
  scanBusy: boolean;
}) {
  const done = BOARD_ROWS.map((row) => probes[row.id]).filter(
    (r): r is ProbeResult => Boolean(r) && !("pending" in r),
  );
  const ok = done.filter((r) => r.ok).length;
  const firstBad = firstBadRow(probes);
  const who = displayName || "当前登录";
  const sending = isPending(probes.lark_send);
  return (
    <div className="setup-board">
      <p className="setup-hint">测的是杭州这台 Windows，不是你眼前这台 Mac。</p>
      <div className="setup-progress" role="status" aria-live="polite">
        <span className="sr-only">{progressSpoken(probes, probeBusy)}</span>
        <div className="setup-progress-meta" aria-hidden="true">
          <strong>{done.length ? `${ok} / ${BOARD_ROWS.length} 可用` : `0 / ${BOARD_ROWS.length} 未测`}</strong>
          <span>
            {probeBusy ||
              (firstBad
                ? `下一步：${firstBad.title}`
                : ok === BOARD_ROWS.length && done.length
                  ? "七条探测通过"
                  : "")}
          </span>
        </div>
        <div className="setup-bar" aria-hidden="true">
          <i style={{ width: `${(ok / BOARD_ROWS.length) * 100}%` }} />
        </div>
      </div>
      <div className="setup-group">
        {BOARD_ROWS.map((row) => {
          const r = probes[row.id];
          const pending = isPending(r);
          const st = statusWord(r, row.kind === "push" && sending ? "send" : undefined);
          const msg = rowDetail(row, r, who, sending);
          const busy = pending || (row.kind === "scan" && scanBusy) || (row.kind === "push" && sending);
          return (
            <div key={row.id} className={`setup-row ${st.cls}`} role="group" aria-label={`${row.title} ${st.text}`}>
              <div className="setup-status">{st.text}</div>
              <div>
                <h3>{row.title}</h3>
                <p aria-live="polite">{msg}</p>
              </div>
              {row.kind === "wizard" ? (
                <button
                  type="button"
                  className={st.cls === "is-bad" ? "setup-btn danger" : "setup-btn ghost"}
                  disabled={busy}
                  aria-busy={busy}
                  onClick={() => (st.cls === "is-ok" ? onProbe(row.id) : onWizard(row))}
                >
                  {busy ? (
                    "检测中…"
                  ) : st.cls === "is-ok" ? (
                    <>
                      <span className="setup-btn-full">再测一次</span>
                      <span className="setup-btn-short">再测</span>
                    </>
                  ) : (
                    "打开向导"
                  )}
                </button>
              ) : null}
              {row.kind === "push" ? (
                <button type="button" className="setup-btn" onClick={onPush} disabled={busy} aria-busy={busy}>
                  {sending ? "发送中…" : pending ? "检测中…" : "发一条测试"}
                </button>
              ) : null}
              {row.kind === "scan" ? (
                <button
                  type="button"
                  className="setup-btn"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={st.cls === "is-ok" ? () => onProbe(row.id) : onScan}
                >
                  {busy ? (
                    scanBusy && !pending ? "扫描中…" : "检测中…"
                  ) : st.cls === "is-ok" ? (
                    <>
                      <span className="setup-btn-full">再测一次</span>
                      <span className="setup-btn-short">再测</span>
                    </>
                  ) : canAdmin ? (
                    "扫描这台电脑"
                  ) : (
                    "需管理员"
                  )}
                </button>
              ) : null}
              {row.kind === "retry" ? (
                <button type="button" className="setup-btn ghost" disabled={busy} aria-busy={busy} onClick={() => onProbe(row.id)}>
                  {busy ? (
                    "检测中…"
                  ) : (
                    <>
                      <span className="setup-btn-full">再测一次</span>
                      <span className="setup-btn-short">再测</span>
                    </>
                  )}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="setup-meta">
        当前登录：{displayName || "—"}
        {openId ? ` · 飞书身份 · ${openId}` : " · 显示名登录没有 open_id"}
      </p>
      {scanHits.length || scanMsg ? (
        <div className="setup-cands">
          <h3>扫描结果 · 杭州这台 Windows</h3>
          <p>{scanMsg || "候选不是结论。点采用才写入。"}</p>
          {scanHits.map((h) => (
            <label key={h.path} className="setup-cand">
              <input
                type="radio"
                name={`scan-${h.kind}`}
                checked={pick[h.kind] === h.path}
                onChange={() => onPick(h.kind, h.path)}
              />
              <span>
                <em>{h.label}</em>
                <code>{h.path}</code>
              </span>
              <button type="button" className="setup-btn" onClick={() => onAdopt(h.kind, h.path)}>
                采用
              </button>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CatalogFields({
  group,
  fields,
  draft,
  canWrite,
  canAdmin,
  probe,
  opened,
  onToggle,
  onChange,
}: {
  group: string;
  fields: SettingFieldView[];
  draft: Record<string, string>;
  canWrite: boolean;
  canAdmin: boolean;
  probe?: ProbeResult | { pending: true };
  opened: boolean;
  onToggle: () => void;
  onChange: (key: string, value: string) => void;
}) {
  const reason = foldCatalogReason(group, fields, probe);
  const folded = Boolean(reason) && !opened;
  return (
    <div className="settings-catalog">
      {reason ? (
        <div className="secrets-fold">
          <p>{reason}</p>
          <Button onClick={onToggle}>{folded ? (group === "飞书推送" ? "点开改接收人" : "点开改密钥") : "收起"}</Button>
        </div>
      ) : null}
      {folded ? null : (
        <Form layout="vertical" requiredMark={false} className="settings-form" disabled={!canWrite}>
          {fields.map((f) => (
            <FieldItem
              key={f.key}
              field={f}
              value={draft[f.key] ?? ""}
              onChange={(v) => onChange(f.key, v)}
              locked={Boolean(f.adminOnly) && !canAdmin}
            />
          ))}
        </Form>
      )}
    </div>
  );
}

function FieldItem({
  field,
  value,
  onChange,
  locked,
}: {
  field: SettingFieldView;
  value: string;
  onChange: (v: string) => void;
  locked?: boolean;
}) {
  return (
    <Form.Item
      label={
        <span>
          {field.label}
          {field.restart ? <Typography.Text type="secondary">（改完重启）</Typography.Text> : null}
        </span>
      }
      extra={locked ? `${field.help} 需要管理员。` : field.help}
    >
      {field.kind === "toggle" ? (
        <Switch checked={value === "true"} onChange={(on) => onChange(on ? "true" : "false")} disabled={locked} />
      ) : field.kind === "secret" ? (
        <Input.Password
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          placeholder={field.set ? `已填 ${field.last4}，留空不改` : "未填"}
          disabled={locked}
        />
      ) : (
        <Input value={value} onChange={(e) => onChange(e.target.value)} disabled={locked} />
      )}
    </Form.Item>
  );
}
