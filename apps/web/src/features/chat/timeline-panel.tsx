import type { MockTimelineItem } from '../../lib/mock-data';

type TimelinePanelProps = {
  items: MockTimelineItem[];
};

function statusClassName(status: MockTimelineItem['status']) {
  switch (status) {
    case 'active':
      return 'bg-amber-100 text-amber-800';
    case 'success':
      return 'bg-emerald-100 text-emerald-700';
    case 'warning':
      return 'bg-rose-100 text-rose-700';
    case 'error':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

export function TimelinePanel({ items }: TimelinePanelProps) {
  if (items.length === 0) {
    return (
      <article className="rounded-[24px] border border-sand bg-mist/80 p-4 text-sm leading-6 text-slate-600">
        当前还没有执行事件。发送第一条消息后，这里会显示真实的运行、工具和审批时间线。
      </article>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <article
          key={item.id}
          className="rounded-[24px] border border-sand bg-mist/80 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClassName(item.status)}`}
              >
                {item.label}
              </span>
              <span className="text-xs uppercase tracking-[0.18em] text-slate-500">
                {item.type}
              </span>
            </div>
            <span className="rounded-full border border-white bg-white/80 px-3 py-1 text-xs text-slate-500">
              {item.time}
            </span>
          </div>

          <h3 className="mt-3 text-base font-semibold text-ink">
            {item.title}
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            {item.description}
          </p>
        </article>
      ))}
    </div>
  );
}
