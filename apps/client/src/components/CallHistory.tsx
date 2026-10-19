import { ArrowDownLeft, ArrowUpRight, CheckCircle2, Clock3, PhoneMissed, XCircle } from "lucide-react";
import { CopyNumber } from "./CopyNumber";
import type { CallRecord } from "../api";

const statusLabels: Record<CallRecord["status"], string> = {
  completed: "Завершён",
  missed: "Пропущен",
  rejected: "Отклонён",
  cancelled: "Отменён",
  failed: "Ошибка",
  transferred: "Переведён"
};

function StatusIcon({ status }: { status: CallRecord["status"] }) {
  if (status === "completed" || status === "transferred") return <CheckCircle2 size={16} />;
  if (status === "missed") return <PhoneMissed size={16} />;
  return <XCircle size={16} />;
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const rest = (seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

export function CallHistory({ records, loading, onRedial }: {
  records: CallRecord[];
  loading: boolean;
  onRedial: (remote: string) => void;
}) {
  return (
    <section className="history-panel panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Журнал</span>
          <h2>История вызовов</h2>
        </div>
        <span className="count-badge">{records.length}</span>
      </div>
      <div className="history-list">
        {loading && <div className="empty-state">Загрузка…</div>}
        {!loading && records.length === 0 && <div className="empty-state">Здесь появятся совершённые и принятые звонки.</div>}
        {records.map((record) => (
          <div className="history-item" key={record.id}>
            <span className={`history-icon ${record.status}`}>
              {record.direction === "incoming" ? <ArrowDownLeft size={18} /> : <ArrowUpRight size={18} />}
            </span>
            <span className="history-main">
              <span className="number-with-copy"><button className="history-number" title="Набрать номер" onClick={() => onRedial(record.remote)}>{record.remote}</button><CopyNumber number={record.remote} /></span>
              <span>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" }).format(new Date(record.startedAt))}</span>
            </span>
            <span className="history-meta">
              <span className="status-line"><StatusIcon status={record.status} /> {statusLabels[record.status]}</span>
              <span><Clock3 size={14} /> {formatDuration(record.durationSeconds)}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
