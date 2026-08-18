import { useEffect, useState } from "react";
import { Button, Card, Flex, Input, Typography } from "antd";
import { api } from "../api";

type Props = { onEntered: () => void };

export function LoginPage({ onEntered }: Props) {
  const [ready, setReady] = useState(true);
  const [displayOk, setDisplayOk] = useState(false);
  const [base, setBase] = useState("https://www.jianghua.site");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api
      .methods()
      .then((m) => {
        setReady(m.feishu);
        setDisplayOk(m.display_login);
        if (m.public_base) setBase(m.public_base);
      })
      .catch(() => setReady(false));
    void api.me().then((me) => {
      if (me.logged_in) onEntered();
    });
  }, [onEntered]);

  async function displayLogin() {
    setBusy(true);
    setErr(null);
    try {
      await api.loginDisplay(name.trim());
      onEntered();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <Card className="login-card">
        <img className="login-logo" src="/brand/logo.png" alt="" />
        <Typography.Title level={3}>审稿台</Typography.Title>
        <Typography.Paragraph type="secondary">
          未登录看不到任务和文件。请用公司飞书进入。白名单外看不到稿。
        </Typography.Paragraph>
        <Flex vertical gap={12}>
          <Button type="primary" block size="large" href="/api/auth/feishu/login" disabled={!ready}>
            用飞书进入
          </Button>
          {!ready ? (
            <Typography.Text type="warning">飞书还没配好。本机可先打开设置页配，或用显示名进入。</Typography.Text>
          ) : (
            <Typography.Text type="secondary">入口：{base}</Typography.Text>
          )}
          {displayOk ? (
            <>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="本机显示名（须在 users.json）"
                onPressEnter={() => void displayLogin()}
              />
              <Button block onClick={() => void displayLogin()} loading={busy}>
                用显示名进入（仅本机）
              </Button>
            </>
          ) : null}
          {err ? <Typography.Text type="danger">{err}</Typography.Text> : null}
        </Flex>
      </Card>
    </div>
  );
}
