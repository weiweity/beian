import { useEffect, useState } from "react";
import { Alert, App, Button, Checkbox, Divider, Form, Input, Typography } from "antd";
import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { api } from "../api";

type Props = { onEntered: () => void };

const ACCOUNT_KEY = "wb.login.account";
const HINT = "wb_login_hint";

const ERROR_FALLBACK: Record<string, string> = {
  denied: "已取消飞书授权。",
  expired: "登录已过期，请再点一次飞书登录。",
  forbidden: "这个飞书号不在白名单。",
  failed: "飞书登录失败，请再试一次。",
};

function readHintCookie(): string {
  const raw = document.cookie.split(";").map((s) => s.trim());
  const hit = raw.find((s) => s.startsWith(`${HINT}=`));
  if (!hit) return "";
  const val = decodeURIComponent(hit.slice(HINT.length + 1));
  document.cookie = `${HINT}=; Path=/; Max-Age=0`;
  return val;
}

export function LoginPage({ onEntered }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ account: string; password: string; remember: boolean }>();
  const [feishuOk, setFeishuOk] = useState(true);
  const [displayOk, setDisplayOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get("feishu_error") || "";
    const hint = readHintCookie();
    if (err) {
      setBanner(hint || ERROR_FALLBACK[err] || "飞书登录未完成。");
      const url = new URL(window.location.href);
      url.searchParams.delete("feishu_error");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
    void api
      .methods()
      .then((m) => {
        setFeishuOk(m.feishu);
        setDisplayOk(m.display_login);
      })
      .catch(() => setFeishuOk(false));
    void api.me().then((me) => {
      if (me.logged_in) onEntered();
    });
    const saved = localStorage.getItem(ACCOUNT_KEY);
    if (saved) form.setFieldsValue({ account: saved, remember: true });
  }, [form, onEntered]);

  async function onAccountFinish(values: { account: string; password: string; remember: boolean }) {
    if (values.remember) localStorage.setItem(ACCOUNT_KEY, values.account.trim());
    else localStorage.removeItem(ACCOUNT_KEY);

    if (!displayOk) {
      message.info("账号密码仅作展示。请用飞书登录。");
      return;
    }
    setBusy(true);
    try {
      await api.loginDisplay(values.account.trim());
      onEntered();
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <aside className="login-brand">
        <img className="login-brand-logo" src="/brand/logo.png" alt="" />
        <Typography.Title level={2} className="login-brand-title">
          审稿台
        </Typography.Title>
        <Typography.Paragraph className="login-brand-copy">
          给人签字。对照包装字，人写结论。
        </Typography.Paragraph>
      </aside>
      <main className="login-panel">
        <div className="login-box">
          <Typography.Title level={3} className="login-box-title">
            登录
          </Typography.Title>
          <Typography.Paragraph type="secondary" className="login-box-sub">
            用公司飞书进入。扫码在飞书页完成。
          </Typography.Paragraph>
          {banner ? <Alert type="warning" showIcon message={banner} style={{ marginBottom: 16 }} /> : null}
          <Button type="primary" block size="large" href="/api/auth/feishu/login" disabled={!feishuOk}>
            <FeishuMark />
            飞书登录
          </Button>
          {!feishuOk ? (
            <Typography.Paragraph type="warning" className="login-hint">
              飞书还没配好。本机可用下面的账号进设置。
            </Typography.Paragraph>
          ) : (
            <Typography.Paragraph type="secondary" className="login-hint">
              将跳到飞书官方授权页。白名单外进不来。
            </Typography.Paragraph>
          )}
          <Divider plain>本机调试</Divider>
          <Form
            form={form}
            layout="vertical"
            requiredMark={false}
            initialValues={{ remember: true }}
            onFinish={(v) => void onAccountFinish(v)}
          >
            <Form.Item name="account" label="账号" rules={[{ required: true, message: "请输入账号" }]}>
              <Input prefix={<UserOutlined />} placeholder="本机显示名，不是飞书账号" autoComplete="username" />
            </Form.Item>
            <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="示意，不会发给服务器" autoComplete="current-password" />
            </Form.Item>
            <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 12 }}>
              <Checkbox>记住账号</Checkbox>
            </Form.Item>
            <Button htmlType="submit" block loading={busy} disabled={!displayOk}>
              用显示名进入
            </Button>
          </Form>
        </div>
      </main>
    </div>
  );
}

function FeishuMark() {
  return (
    <svg className="feishu-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect width="16" height="16" rx="4" fill="#3370FF" />
      <path d="M4.2 8.6 7.1 4.4h2.2L6.4 8.6h2.8l-3.2 4.4H3.8L7 8.6H4.2Z" fill="#fff" />
    </svg>
  );
}
