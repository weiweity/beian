import { Table, Tag, Typography } from "antd";
import type { BillingView, VendorBill } from "../../api";

function vendorTag(v: VendorBill): { color: string; text: string } {
  if (v.status === "partial") return { color: "warning", text: "部分成功" };
  if (v.status === "skip") return { color: "default", text: "无按次账单" };
  if (v.status === "fail" || !v.ok) return { color: "warning", text: "未取全" };
  return { color: "success", text: "已取到" };
}

export function BillingPane({ billing }: { billing: BillingView | null }) {
  if (!billing) {
    return <Typography.Paragraph type="secondary">正在读取本机记录和上次厂商快照…</Typography.Paragraph>;
  }
  return (
    <div>
      <Typography.Paragraph type="secondary">
        {billing.cached_at ? `厂商快照时间：${billing.cached_at}` : "尚未拉取厂商。进入本页会冷拉一次；手动按钮才强制刷新。"}
        厂商余额/月账单不是实时流水。本页不会每十几秒去打厂商。
      </Typography.Paragraph>
      {(billing.vendors || []).map((v) => {
        const tag = vendorTag(v);
        return (
          <div key={v.vendor} className="bill-vendor">
            <div className="bill-vendor-head">
              <strong>{v.label}</strong>
              <Tag color={tag.color} variant="filled">
                {tag.text}
              </Tag>
            </div>
            <p>{v.message}</p>
            {v.vendor === "minimax" && v.remains ? (
              <p>
                余量不是账单。
                {v.remains.usage_percent != null ? ` 剩余约 ${v.remains.usage_percent}%` : ""}
                {v.remains.remains_time != null ? ` · remains_time ${v.remains.remains_time}` : ""}
                {v.remains.model_count != null ? ` · ${v.remains.model_count} 个模型窗口` : ""}
              </p>
            ) : null}
            {v.balance != null ? <p>余额：{String(v.balance)}</p> : null}
            {v.bills_truncated ? (
              <p>月账单未取全（已显示 {v.bills.length} / {v.bills_total ?? "?"} 条），不是完整月账单。</p>
            ) : null}
            {v.bills.length ? (
              <Table
                size="small"
                pagination={false}
                rowKey={(_, i) => `${v.vendor}-${i}`}
                dataSource={v.bills}
                columns={[
                  { title: "月份", dataIndex: "month", width: 100 },
                  { title: "产品", dataIndex: "service" },
                  { title: "计费项", dataIndex: "product" },
                  { title: "金额", dataIndex: "cash", width: 100 },
                  { title: "用量", render: (_, row) => [row.amount, row.unit].filter(Boolean).join(" ") },
                ]}
              />
            ) : null}
          </div>
        );
      })}
      <Typography.Title level={5}>{billing.ledger_label || "本机任务调用记录"}</Typography.Title>
      <Typography.Paragraph type="secondary">
        这是本机对照尝试记录，不是厂商已扣费。计费状态一律未知。
        {Object.entries(billing.totals || {})
          .map(([k, v]) => `${k} ×${v.count}`)
          .join("；") || "还没有记过调用"}
      </Typography.Paragraph>
      <Table
        size="small"
        pagination={{ pageSize: 8 }}
        rowKey={(r) => `${r.at}-${r.kind}-${r.task_id || ""}-${r.attempt || ""}`}
        dataSource={billing.ledger}
        columns={[
          { title: "时间", dataIndex: "at", width: 200 },
          { title: "厂商", dataIndex: "vendor", width: 90 },
          { title: "种类", dataIndex: "kind", width: 110 },
          { title: "尝试", dataIndex: "attempt", width: 70 },
          { title: "计费", dataIndex: "charge_status", width: 90, render: (v: string) => (v === "unknown" ? "未知" : v || "—") },
          { title: "任务", dataIndex: "task_id" },
          { title: "谁", dataIndex: "actor", width: 90 },
          { title: "备注", dataIndex: "note" },
        ]}
      />
    </div>
  );
}
