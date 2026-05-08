import type { MessageDto, MessagePart } from '@opencode/shared';

type MessageListProps = {
  messages: MessageDto[];
};

function formatMessageTime(timestamp: string) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit'
  });
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function statusBadge(status: MessageDto['status']) {
  switch (status) {
    case 'running':
      return 'bg-amber-100 text-amber-800';
    case 'completed':
      return 'bg-emerald-100 text-emerald-700';
    case 'failed':
      return 'bg-red-100 text-red-700';
    case 'cancelled':
      return 'bg-rose-100 text-rose-700';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

function PartBanner({
  children,
  tone
}: {
  children: string;
  tone: 'amber' | 'slate';
}) {
  const className =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-slate-200 bg-slate-50 text-slate-700';

  return (
    <div
      className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${className}`}
    >
      {children}
    </div>
  );
}

function ToolPartCard({
  part
}: {
  part: Extract<MessagePart, { type: 'tool' }>;
}) {
  const statusClassName =
    part.state.status === 'pending'
      ? 'bg-amber-100 text-amber-800'
      : part.state.status === 'running'
        ? 'bg-sky-100 text-sky-800'
        : part.state.status === 'completed'
          ? 'bg-emerald-100 text-emerald-700'
          : 'bg-red-100 text-red-700';

  return (
    <article className="rounded-[24px] border border-sand bg-mist/80 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
            Tool
          </p>
          <h4 className="mt-1 text-sm font-semibold text-ink">
            {part.toolName}
          </h4>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${statusClassName}`}
        >
          {part.state.status}
        </span>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl bg-white/80 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Input
          </p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">
            {formatJson(part.state.input)}
          </pre>
        </div>

        <div className="rounded-2xl bg-white/80 p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            Result
          </p>
          {part.state.status === 'completed' ? (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-6 text-slate-700">
              {part.state.outputText}
            </pre>
          ) : part.state.status === 'error' ? (
            <p className="mt-2 text-xs leading-6 text-red-700">
              {part.state.errorText}
            </p>
          ) : (
            <p className="mt-2 text-xs leading-6 text-slate-500">
              {part.state.status === 'running'
                ? '工具正在执行。'
                : '等待工具开始执行。'}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}

function FilePartCard({
  part
}: {
  part: Extract<MessagePart, { type: 'file' }>;
}) {
  return (
    <article className="rounded-[24px] border border-sand bg-mist/80 p-4 text-sm text-slate-700">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
        Attachment
      </p>
      <h4 className="mt-1 font-semibold text-ink">
        {part.filename ?? part.url.split('/').at(-1) ?? '附件'}
      </h4>
      <p className="mt-2 text-xs text-slate-500">{part.mime}</p>
      <a
        className="mt-3 inline-flex text-sm font-medium text-ember"
        href={part.url}
      >
        {part.url}
      </a>
    </article>
  );
}

function PatchPartCard({
  part
}: {
  part: Extract<MessagePart, { type: 'patch' }>;
}) {
  return (
    <article className="rounded-[24px] border border-sand bg-mist/80 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
        Patch
      </p>
      <div className="mt-3 space-y-2">
        {part.files.map((file) => (
          <div
            key={`${file.change}:${file.path}`}
            className="rounded-2xl bg-white/80 px-4 py-3 text-sm text-slate-700"
          >
            <span className="font-semibold text-ink">{file.change}</span>
            <span className="ml-2 break-all">{file.path}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function MessagePartRenderer({ part }: { part: MessagePart }) {
  switch (part.type) {
    case 'text':
      return <p className="text-sm leading-7 text-slate-800">{part.text}</p>;
    case 'reasoning':
      return (
        <section className="rounded-[24px] border border-amber-200 bg-amber-50/80 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-700">
            Reasoning
          </p>
          <p className="mt-2 text-sm leading-7 text-amber-950">{part.text}</p>
        </section>
      );
    case 'tool':
      return <ToolPartCard part={part} />;
    case 'file':
      return <FilePartCard part={part} />;
    case 'patch':
      return <PatchPartCard part={part} />;
    case 'summary':
      return <PartBanner tone="amber">{part.text}</PartBanner>;
    case 'compaction':
      return (
        <PartBanner tone="slate">{`上下文已压缩：${part.reason}`}</PartBanner>
      );
    default:
      return null;
  }
}

function MessageCard({ message }: { message: MessageDto }) {
  const roleLabel = message.role === 'assistant' ? 'Assistant' : 'User';
  const isAssistant = message.role === 'assistant';

  return (
    <article
      className={
        isAssistant
          ? 'rounded-[28px] border border-white/60 bg-white/90 p-5 shadow-panel'
          : 'rounded-[28px] border border-sand bg-mist/80 p-5'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadge(message.status)}`}
          >
            {roleLabel}
          </span>
          <span className="text-xs uppercase tracking-[0.18em] text-slate-500">
            {message.status}
          </span>
        </div>
        <span className="rounded-full border border-white bg-white/80 px-3 py-1 text-xs text-slate-500">
          {formatMessageTime(message.createdAt)}
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {message.content.length > 0 ? (
          message.content.map((part) => (
            <MessagePartRenderer key={part.id} part={part} />
          ))
        ) : (
          <p className="text-sm leading-7 text-slate-500">
            {message.status === 'running' ? '等待模型输出...' : '无消息内容'}
          </p>
        )}
      </div>
    </article>
  );
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="rounded-[24px] border border-dashed border-sand bg-mist/60 p-5 text-sm leading-6 text-slate-600">
        还没有消息。提交一个 prompt 之后，assistant 的文本、推理、工具和附件
        part 会在这里实时显示。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((message) => (
        <MessageCard key={message.id} message={message} />
      ))}
    </div>
  );
}
