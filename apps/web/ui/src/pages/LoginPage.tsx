import { useEffect, useMemo, useState } from "react";
import { App, Button, Checkbox, Divider, Form, Input, QRCode, Tabs, Typography } from "antd";
import { LockOutlined, QrcodeOutlined, UserOutlined } from "@ant-design/icons";
import { api } from "../api";

type Props = { onEntered: () => void };

const ACCOUNT_KEY = "wb.login.account";

export function LoginPage({ onEntered }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ account: string; password: string; remember: boolean }>();
  const [feishuOk, setFeishuOk] = useState(true);
  const [displayOk, setDisplayOk] = useState(false);
  const [base, setBase] = useState("https://www.jianghua.site");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(() => (window.location.hash === "#qr" ? "qr" : "account"));

  useEffect(() => {
    void api
      .methods()
      .then((m) => {
        setFeishuOk(m.feishu);
        setDisplayOk(m.display_login);
        if (m.public_base) setBase(m.public_base);
      })
      .catch(() => setFeishuOk(false));
    void api.me().then((me) => {
      if (me.logged_in) onEntered();
    });
    const saved = localStorage.getItem(ACCOUNT_KEY);
    if (saved) form.setFieldsValue({ account: saved, remember: true });
  }, [form, onEntered]);

  const qrValue = useMemo(() => `${base.replace(/\/$/, "")}/api/auth/feishu/login`, [base]);

  async function onAccountFinish(values: { account: string; password: string; remember: boolean }) {
    if (values.remember) localStorage.setItem(ACCOUNT_KEY, values.account.trim());
    else localStorage.removeItem(ACCOUNT_KEY);

    if (!displayOk) {
      message.info("账号密码仅作展示。内部请用飞书登录。");
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

  const accountPane = (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      initialValues={{ remember: true }}
      onFinish={(v) => void onAccountFinish(v)}
    >
      <Form.Item name="account" label="账号" rules={[{ required: true, message: "请输入账号" }]}>
        <Input prefix={<UserOutlined />} placeholder="工号或姓名" autoComplete="username" size="large" />
      </Form.Item>
      <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
        <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" size="large" />
      </Form.Item>
      <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 12 }}>
        <Checkbox>记住账号</Checkbox>
      </Form.Item>
      <Form.Item>
        <Button htmlType="submit" block size="large" loading={busy}>
          登录
        </Button>
      </Form.Item>
      <Typography.Paragraph type="secondary" className="login-hint">
        {displayOk ? "本机调试可用显示名。生产请走飞书。" : "账号密码为示意入口，正式身份走飞书。"}
      </Typography.Paragraph>
      <Divider plain>其他登录方式</Divider>
      <Button type="primary" block size="large" href="/api/auth/feishu/login" disabled={!feishuOk}>
        <FeishuMark />
        飞书登录
      </Button>
      {!feishuOk ? (
        <Typography.Paragraph type="warning" className="login-hint">
          飞书还没配好 App Secret。本机可先用上面的账号进入设置。
        </Typography.Paragraph>
      ) : null}
    </Form>
  );

  const qrPane = (
    <div className="login-qr">
      <QRCode
        value={feishuOk ? qrValue : "feishu-not-ready"}
        size={188}
        icon="/brand/logo.png"
        iconSize={36}
        color="#722ED1"
        bgColor="#ffffff"
        bordered
        status={feishuOk ? "active" : "expired"}
        statusRender={() => "飞书未配置"}
      />
      <Typography.Paragraph className="login-qr-cap">打开飞书扫一扫</Typography.Paragraph>
      <Typography.Paragraph type="secondary" className="login-hint">
        扫码后走同一套飞书授权。白名单外进不来。
      </Typography.Paragraph>
      <Button type="primary" block size="large" href="/api/auth/feishu/login" disabled={!feishuOk}>
        <FeishuMark />
        飞书登录
      </Button>
    </div>
  );

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
            未登录看不到任务和文件。
          </Typography.Paragraph>
          <Tabs
            activeKey={tab}
            onChange={setTab}
            centered
            size="large"
            items={[
              { key: "account", label: "账号密码", children: accountPane },
              {
                key: "qr",
                label: (
                  <span>
                    <QrcodeOutlined /> 飞书扫码
                  </span>
                ),
                children: qrPane,
              },
            ]}
          />
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
