import { useMemo, useState } from 'react';
import type {
  ApprovalDto,
  MessageDto,
  MessagePart,
  SessionPlanFileDto
} from '@opencode/shared';
import { MarkdownContent } from '../../components/markdown-content';

type MessageListProps = {
  approvals?: ApprovalDto[];
  messages: MessageDto[];
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  onRevert?: (messageId: string) => void;
  planFile?: SessionPlanFileDto;
};

function formatMessageTime(timestamp: string) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit'
  });
}

function toolStatusLabel(
  status: Extract<MessagePart, { type: 'tool' }>['state']['status']
) {
  switch (status) {
    case 'pending':
      return '等待中';
    case 'running':
      return '执行中';
    case 'completed':
      return '已完成';
    case 'error':
      return '失败';
    default:
      return status;
  }
}

function toolStatusClassName(
  status: Extract<MessagePart, { type: 'tool' }>['state']['status']
) {
  switch (status) {
    case 'pending':
      return 'bg-white/8 text-white/60';
    case 'running':
      return 'bg-sky-400/10 text-sky-200';
    case 'completed':
      return 'bg-emerald-400/10 text-emerald-200';
    case 'error':
      return 'bg-rose-400/10 text-rose-200';
    default:
      return 'bg-white/8 text-white/60';
  }
}

function isDiffTool(part: Extract<MessagePart, { type: 'tool' }>) {
  return (
    part.toolName === 'apply_patch' ||
    part.toolName === 'edit' ||
    part.toolName === 'write'
  );
}

function extractMetadata(
  part: Extract<MessagePart, { type: 'tool' }>
): Record<string, unknown> | undefined {
  return 'metadata' in part.state && part.state.metadata
    ? part.state.metadata
    : undefined;
}

function extractPayload(
  part: Extract<MessagePart, { type: 'tool' }>
): Record<string, unknown> | undefined {
  return 'payload' in part.state && part.state.payload
    ? part.state.payload
    : undefined;
}

function extractDiff(part: Extract<MessagePart, { type: 'tool' }>) {
  const metadata = extractMetadata(part);
  const payload = extractPayload(part);
  const metadataDiff = typeof metadata?.diff === 'string' ? metadata.diff : '';
  const payloadDiff = typeof payload?.diff === 'string' ? payload.diff : '';

  return metadataDiff || payloadDiff || '';
}

function extractToolFilePath(part: Extract<MessagePart, { type: 'tool' }>) {
  const metadata = extractMetadata(part);
  const payload = extractPayload(part);
  const metadataPath =
    typeof metadata?.filePath === 'string' ? metadata.filePath : '';
  const payloadPath =
    typeof payload?.filePath === 'string' ? payload.filePath : '';

  return metadataPath || payloadPath || '';
}

function simplifyDiff(diff: string) {
  return diff
    .split('\n')
    .filter(
      (line) =>
        !line.startsWith('Index:') &&
        !line.startsWith('===') &&
        !line.startsWith('---') &&
        !line.startsWith('+++')
    )
    .join('\n')
    .trim();
}

function renderToolActivityText(part: Extract<MessagePart, { type: 'tool' }>) {
  const filePath = extractToolFilePath(part);

  if (part.state.status === 'error') {
    return filePath
      ? `${part.toolName} ${filePath} 失败：${part.state.errorText}`
      : `${part.toolName} 失败：${part.state.errorText}`;
  }

  if (part.state.status === 'running') {
    return filePath
      ? `${part.toolName} ${filePath} 执行中`
      : `${part.toolName} 执行中`;
  }

  if (part.state.status === 'pending') {
    return filePath
      ? `${part.toolName} ${filePath} 等待中`
      : `${part.toolName} 等待中`;
  }

  if (part.state.status === 'completed') {
    if (filePath) {
      return `${part.toolName} ${filePath}`;
    }

    return part.state.outputText || `${part.toolName} 已完成`;
  }

  return part.toolName;
}

function ToolDiffBlock({
  diff,
  filePath
}: {
  diff: string;
  filePath?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const normalizedDiff = simplifyDiff(diff);
  const preview = useMemo(() => {
    const lines = normalizedDiff.split('\n');
    return lines.slice(0, 18).join('\n');
  }, [normalizedDiff]);
  const hasMore = normalizedDiff.split('\n').length > 18;

  return (
    <div className="mt-3 rounded-[14px] bg-[#111111] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45">
            Diff
          </p>
          {filePath ? (
            <p className="mt-1 text-xs text-white/38">{filePath}</p>
          ) : null}
        </div>
        {hasMore ? (
          <button
            className="text-[11px] font-medium text-white/55 transition hover:text-white"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            {expanded ? '收起' : '展开'}
          </button>
        ) : null}
      </div>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs leading-6 text-white/78">
        {expanded ? normalizedDiff : preview}
      </pre>
    </div>
  );
}

function PlanPreviewBlock({ planContent }: { planContent: string }) {
  return (
    <div className="mt-3 rounded-[14px] bg-[#111111] px-4 py-4">
      <MarkdownContent>{planContent}</MarkdownContent>
    </div>
  );
}

function ApprovalActions({
  approval,
  onApprove,
  onReject
}: {
  approval?: ApprovalDto;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
}) {
  if (!approval || approval.status !== 'pending') {
    return null;
  }

  return (
    <div className="mt-3 rounded-[14px] border border-violet-300/20 bg-violet-300/10 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-violet-200">
        Approval Required
      </p>
      <p className="mt-2 text-sm text-violet-100">{approval.kind}</p>
      <div className="mt-3 flex gap-2">
        <button
          className="rounded-full bg-[#d9d9d9] px-4 py-2 text-xs font-semibold text-black"
          onClick={() => onApprove?.(approval.id)}
          type="button"
        >
          批准
        </button>
        <button
          className="rounded-full border border-violet-200/30 px-4 py-2 text-xs font-semibold text-violet-100"
          onClick={() => onReject?.(approval.id)}
          type="button"
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

function ToolPartCard({
  approval,
  onApprove,
  onReject,
  part,
  planFile
}: {
  approval?: ApprovalDto;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  part: Extract<MessagePart, { type: 'tool' }>;
  planFile?: SessionPlanFileDto;
}) {
  const [expanded, setExpanded] = useState(false);
  const diff = extractDiff(part);
  const filePath = extractToolFilePath(part);
  const isPlanFileTool =
    Boolean(planFile?.filePath) && filePath === planFile?.filePath;
  const showCard = isDiffTool(part) || approval?.status === 'pending';

  return (
    <article
      className={
        showCard
          ? 'rounded-[16px] bg-[#252525] px-4 py-4'
          : 'px-0 py-0 text-sm leading-7 text-white/72'
      }
    >
      {showCard ? (
        <>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/35">
                Tool
              </p>
              <h4 className="mt-1 text-sm font-semibold text-white">
                {part.toolName}
              </h4>
              {filePath ? (
                <p className="mt-1 text-xs text-white/38">{filePath}</p>
              ) : null}
            </div>
            <span
              className={`rounded-full px-3 py-1 text-[11px] font-semibold ${toolStatusClassName(part.state.status)}`}
            >
              {toolStatusLabel(part.state.status)}
            </span>
          </div>

          {part.state.status === 'completed' && part.state.outputText ? (
            <p className="mt-3 text-sm leading-6 text-white/70">
              {part.state.outputText}
            </p>
          ) : null}

          {part.state.status === 'error' ? (
            <p className="mt-3 text-sm leading-6 text-rose-200">
              {part.state.errorText}
            </p>
          ) : null}

          <ApprovalActions
            approval={approval}
            onApprove={onApprove}
            onReject={onReject}
          />

          {isPlanFileTool && planFile?.content ? (
            <PlanPreviewBlock planContent={planFile.content} />
          ) : diff ? (
            <ToolDiffBlock diff={diff} filePath={filePath} />
          ) : null}

          {'input' in part.state ? (
            <>
              <div className="mt-3">
                <button
                  className="text-[11px] font-medium text-white/45 transition hover:text-white"
                  onClick={() => setExpanded((current) => !current)}
                  type="button"
                >
                  {expanded ? '隐藏输入' : '查看输入'}
                </button>
              </div>

              {expanded ? (
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-[14px] bg-[#111111] px-4 py-3 text-xs leading-6 text-white/75">
                  {JSON.stringify(part.state.input, null, 2)}
                </pre>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        renderToolActivityText(part)
      )}
    </article>
  );
}

function FilePartCard({
  part
}: {
  part: Extract<MessagePart, { type: 'file' }>;
}) {
  return (
    <div className="text-sm leading-7 text-white/72">
      {part.filename ?? part.url.split('/').at(-1) ?? '附件'}
    </div>
  );
}

function PatchPartCard({
  part
}: {
  part: Extract<MessagePart, { type: 'patch' }>;
}) {
  return (
    <div className="text-sm leading-7 text-white/72">
      patch {part.files.map((file) => file.path).join(', ')}
    </div>
  );
}

function MessagePartRenderer({
  approval,
  onApprove,
  onReject,
  part,
  planFile
}: {
  approval?: ApprovalDto;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  part: MessagePart;
  planFile?: SessionPlanFileDto;
}) {
  switch (part.type) {
    case 'text':
      return <MarkdownContent>{part.text}</MarkdownContent>;
    case 'reasoning':
      return (
        <section className="rounded-[16px] bg-amber-300/8 px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-200">
            Reasoning
          </p>
          <p className="mt-2 text-sm leading-7 text-amber-50/90">{part.text}</p>
        </section>
      );
    case 'tool':
      return (
        <ToolPartCard
          approval={approval}
          onApprove={onApprove}
          onReject={onReject}
          part={part}
          planFile={planFile}
        />
      );
    case 'file':
      return <FilePartCard part={part} />;
    case 'patch':
      return <PatchPartCard part={part} />;
    case 'summary':
      return (
        <div className="rounded-[16px] bg-amber-300/8 px-4 py-3 text-sm leading-6 text-amber-50/90">
          {part.text}
        </div>
      );
    case 'compaction':
      return (
        <div className="rounded-[16px] bg-[#252525] px-4 py-3 text-sm leading-6 text-white/60">
          上下文已压缩：{part.reason}
        </div>
      );
    default:
      return null;
  }
}

function MessageCard({
  approvalsByToolCallId,
  message,
  onApprove,
  onReject,
  onRevert,
  planFile
}: {
  approvalsByToolCallId: Map<string, ApprovalDto>;
  message: MessageDto;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  onRevert?: (messageId: string) => void;
  planFile?: SessionPlanFileDto;
}) {
  const isAssistant = message.role === 'assistant';

  return (
    <div className={isAssistant ? 'group mr-10' : 'group ml-10'}>
      <article
        className={
          isAssistant
            ? 'rounded-[18px] bg-[#252525] px-4 py-4 text-left'
            : 'rounded-[18px] bg-[#4b4b4b] px-4 py-4 text-left text-white'
        }
      >
        {!isAssistant ? (
          <div className="mb-3 flex justify-end">
            <button
              className="rounded-full border border-white/15 px-3 py-1 text-[11px] font-semibold text-white/70 transition hover:border-white/30 hover:text-white"
              onClick={() => onRevert?.(message.id)}
              type="button"
            >
              回退到这里
            </button>
          </div>
        ) : null}
        <div className="space-y-3">
          {message.content.length > 0 ? (
            message.content.map((part) => (
              <MessagePartRenderer
                approval={
                  part.type === 'tool'
                    ? approvalsByToolCallId.get(part.toolCallId)
                    : undefined
                }
                key={part.id}
                onApprove={onApprove}
                onReject={onReject}
                part={part}
                planFile={planFile}
              />
            ))
          ) : (
            <p
              className={
                isAssistant
                  ? 'text-sm leading-7 text-white/45'
                  : 'text-sm leading-7 text-white/60'
              }
            >
              {message.status === 'running' ? '等待模型输出...' : '无消息内容'}
            </p>
          )}
        </div>
      </article>
      <div className="px-1 pt-1 text-left text-[11px] text-white/28 opacity-0 transition-opacity group-hover:opacity-100">
        {formatMessageTime(message.createdAt)}
      </div>
    </div>
  );
}

export function MessageList({
  approvals = [],
  messages,
  onApprove,
  onReject,
  onRevert,
  planFile
}: MessageListProps) {
  const approvalsByToolCallId = useMemo(() => {
    return new Map(
      approvals.map((approval) => [approval.toolCallId, approval] as const)
    );
  }, [approvals]);

  if (messages.length === 0) {
    return (
      <div className="rounded-[18px] border border-dashed border-white/10 bg-[#252525] p-5 text-sm leading-6 text-white/45">
        还没有消息。提交一个 prompt 之后，用户消息、agent
        回复和工具变更会在这里持续更新。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((message) => (
        <MessageCard
          approvalsByToolCallId={approvalsByToolCallId}
          key={message.id}
          message={message}
          onApprove={onApprove}
          onReject={onReject}
          onRevert={onRevert}
          planFile={planFile}
        />
      ))}
    </div>
  );
}
