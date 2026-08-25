import { useState } from "react";
import { Button, Empty, Modal, Table, Tag } from "antd";
import { deskClock, deskShortId, type DeskCardRow } from "./deskBoard";

type Props = {
  title: string;
  hint: string;
  rows: DeskCardRow[];
  onOpen: (id: string) => void;
};

export function DeskCol({ title, hint, rows, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="review-col">
      <div className="review-col-head">
        <strong>{title}</strong>
        <div className="review-col-head-right">
          <span>{rows.length}</span>
          <Button type="text" size="small" className="review-col-all" onClick={() => setOpen(true)}>
            全部
          </Button>
        </div>
      </div>
      <p className="review-col-hint">{hint}</p>
      <div className="review-col-list">
        {rows.length === 0 ? <div className="review-col-empty">没有单</div> : null}
        {rows.map((row) => (
          <button key={row.id} type="button" className="review-card" onClick={() => onOpen(row.id)}>
            <div className="review-card-top">
              <span className="review-card-id">{deskShortId(row.id)}</span>
              <span className="review-card-actor">{row.actor || "—"}</span>
            </div>
            <div className="review-card-name">{row.title}</div>
            {row.live ? (
              <>
                <div className="review-card-live">{row.live}</div>
                <div className="review-card-bar" aria-hidden>
                  <span />
                </div>
              </>
            ) : null}
            {row.error ? <div className="review-card-err">{row.error}</div> : null}
            <div className="review-card-meta">
              <Tag color={row.statusColor}>{row.statusText}</Tag>
            </div>
            <div className="review-card-time">{deskClock(row.at)}</div>
          </button>
        ))}
      </div>
      <Modal
        title={title}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={720}
        destroyOnClose
      >
        <Table<DeskCardRow>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={rows}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有单" /> }}
          onRow={(row) => ({
            onClick: () => {
              setOpen(false);
              onOpen(row.id);
            },
            style: { cursor: "pointer" },
          })}
          columns={[
            { title: "ID", dataIndex: "id", width: 120, render: (v: string) => deskShortId(v) },
            { title: "品名", dataIndex: "title" },
            {
              title: "状态",
              width: 120,
              render: (_, row) => <Tag color={row.statusColor}>{row.statusText}</Tag>,
            },
            { title: "使用人", dataIndex: "actor", width: 100, render: (v: string) => v || "—" },
            {
              title: "工作时间",
              dataIndex: "at",
              width: 160,
              render: (v: string) => deskClock(v),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
