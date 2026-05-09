# RFC: 工具系统重构与 7 个核心工具落地

## 1. 背景

当前项目的上下文循环、`RunLoop`、`Lifecycle`、`SessionProcessor`、approval pause/resume、`ToolPart/tool_call` 持久化链路已经基本成型，但工具系统仍然处于非常早期的实现阶段。

当前工具实现的主要特征是：

1. 只有 `read_file`、`write_file`、`run_command` 3 个内置工具。
2. `ToolDefinition` 很薄，只承载 `name`、`description`、`inputSchema`。
3. 工具执行逻辑集中在 `tool-executor.ts` 的多个 `switch(toolName)` 分支中。
4. approval policy 通过全局函数 `toolRequiresApproval()` 判断，而不是由工具定义自己声明。
5. result mapping 通过 `formatToolOutput()` 这种中心化分支函数完成。
6. Zod schema 与手写 JSON schema 双写，模型看到的 schema 和执行期真正 parse 的 schema 可能漂移。
7. 大结果截断、artifact 持久化、read-before-edit/write、路径安全、diagnostics 等关键能力都还未成体系。

这导致当前工具层虽然能跑通最简单的 demo，但还不足以支撑真实 coding agent 的稳定循环。

本 RFC 的目标，是在不重写现有运行时主链路的前提下，对工具层做一次完整重构，并优先落地 7 个最常用的核心工具：

1. `bash`
2. `read`
3. `edit`
4. `write`
5. `grep`
6. `glob`
7. `apply_patch`

## 2. 设计输入

本 RFC 综合了三类输入：

1. 当前项目已有运行时架构和持久化链路。
2. `../opencode` 中的工具接口、截断策略、`FileTime`、`ripgrep` 封装、diagnostics 拼接方式。
3. `../claude-code` 中的厚工具接口、结果映射与执行结果分离、大输出持久化、read-before-edit/write 约束、路径安全策略。

最终目标不是照搬任一实现，而是提炼一个最适合本项目当前阶段的方案。

## 3. 目标

本次工具重构的目标如下：

1. 保留现有 `RunLoop`、`Lifecycle`、approval pause/resume、`ToolPart/tool_call`、SSE 事件链路，不重写核心 runtime。
2. 将工具系统重构为“厚 `ToolDefinition` + 统一执行 wrapper”的结构。
3. 让 Zod 成为工具参数 schema 的单一真相，消除手写 JSON schema 双写问题。
4. 将 approval policy 放回工具定义。
5. 将 result mapping 放回工具定义。
6. 为工具结果增加统一截断层，并预留 large output artifact 持久化扩展点。
7. 严格收紧 workspace 路径安全边界。
8. 引入 read-before-edit/write 和 stale write 防护。
9. 为 edit/write 预留 diagnostics 接口，并在模型可见结果中支持 diagnostics 文本。
10. 首批落地 `bash/read/edit/write/grep/glob/apply_patch` 7 个工具，并为后续 `task`、`webfetch` 等工具扩展提供稳定骨架。

## 4. 非目标

本 RFC 明确不包含以下内容：

1. 不在本次实现中引入 MCP/plugin/dynamic tool。
2. 不在本次实现中重做 context compaction 或 tool result pruning 算法。
3. 不在本次实现中接入完整 IDE/MCP diagnostics 双通道。
4. 不在本次实现中照搬 Claude Code 级别的 Bash AST 审批、classifier 或 sandbox 体系。
5. 不在本次实现中新增独立的 file snapshot 专用表或单独 durable store；首版复用现有 `artifacts` 表中的 `kind='file_snapshot'` 作为 durable truth。

## 5. 当前问题

### 5.1 `ToolDefinition` 过薄

当前 `ToolDefinition` 仅包含：

1. `name`
2. `description`
3. `inputSchema`

这会导致真正的工具行为散落在多个中心化函数中：

1. `toolRequiresApproval()`
2. `prepareToolExecution()`
3. `executeApprovedTool()`
4. `formatToolOutput()`

问题在于：

1. 每新增一个工具，都要同时修改多个分支点。
2. 工具逻辑无法局部封装。
3. 工具特有行为无法自然表达。
4. approval、execution、presentation、validation 无法形成一个完整单元。

### 5.2 Zod schema 与手写 JSON schema 双写

当前每个工具通常同时维护：

1. Zod schema，用于执行期 parse。
2. 手写 JSON schema，用于暴露给模型。

这种双写会带来以下风险：

1. `required` 字段漂移。
2. `optional/nullable` 约束漂移。
3. 描述文案漂移。
4. 枚举值漂移。
5. 模型看到的 schema 与执行期真实 parse 的 schema 不一致。

本质上，这是“模型输入契约”和“执行期输入契约”分裂。

### 5.3 approval policy 未内聚到工具定义

当前 approval 由中心化逻辑决定：

1. `read_file` 自动执行。
2. `write_file` 和 `run_command` 需要 approval。

这虽然简单，但不利于扩展：

1. 后续新增 `edit` 后，必须再改全局分支。
2. 工具自身无法表达“我需要 approval”的语义。
3. 无法按工具定义自然生成 approval UI payload。

### 5.4 result mapping 仍在中心化 `switch`

不同工具的模型可见结果其实差异很大：

1. `read` 需要输出带行号文本。
2. `grep` 需要输出文件、行号、命中行。
3. `glob` 需要输出路径列表。
4. `bash` 需要输出 exit code、stdout、stderr。
5. `edit/write` 需要输出成功消息和 diagnostics 文本，而不是整段 diff。

当前继续依赖 `formatToolOutput()` 这种中心化映射，会让工具之间的语义差异被抹平，也会继续加重 `switch` 链。

### 5.5 缺少统一截断层

真实 coding agent 里，tool result 极易失控：

1. 读大文件。
2. `rg` 返回过多命中。
3. `glob` 返回过多路径。
4. `bash` 返回过长 stdout/stderr。

如果没有统一预算控制，现有上下文循环会被大工具结果拖垮。

### 5.6 路径安全过于原始

当前路径判断依赖 `startsWith(root)` 风格的边界判断，这存在多个问题：

1. `/workspace` 与 `/workspace2` 前缀误判。
2. symlink 逃逸 workspace 的情况无法可靠识别。
3. 不存在文件的 parent directory 也需要安全判定。
4. 路径应该统一以 workspace 相对路径对模型展示，而不是泄露服务端绝对路径。

### 5.7 缺少 read-before-edit/write 和 stale write 防护

真实写代码时，模型最危险的行为之一是基于旧内容覆盖文件。没有 read snapshot 机制时：

1. 模型可能修改从未读过的文件。
2. 模型可能覆盖用户刚刚改过的文件。
3. approval pause/resume 期间文件被用户修改，也可能导致 stale write。

## 6. 总体设计

### 6.1 总原则

本次重构遵循以下原则：

1. 保持运行时主链路最小修改。
2. 将“工具的所有行为”尽可能收敛回工具定义本身。
3. 将“通用能力”收敛为统一 wrapper，而不是继续写中心化 `switch`。
4. 将“模型可见结果”和“内部结构化结果”分离。
5. 让工具目录结构天然支持后续扩展。

### 6.2 目录结构

新的工具目录结构建议如下：

```text
packages/agent/src/tools/
├── index.ts
├── core.ts
├── types.ts
├── shared/
│   ├── diagnostics.ts
│   ├── file-snapshot.ts
│   ├── path.ts
│   ├── result.ts
│   ├── shell.ts
│   └── truncation.ts
├── bash/
│   ├── index.ts
│   └── prompt.ts
├── read/
│   ├── index.ts
│   └── prompt.ts
├── edit/
│   ├── index.ts
│   └── prompt.ts
├── write/
│   ├── index.ts
│   └── prompt.ts
├── grep/
│   ├── index.ts
│   └── prompt.ts
└── glob/
    ├── index.ts
    └── prompt.ts
```

### 6.3 各文件职责

#### `prompt.ts`

每个工具目录下的 `prompt.ts`：

1. 只承载模型可见工具描述文案。
2. 不承载执行逻辑。
3. 不承载 schema。
4. 不承载 result mapping。

#### `工具目录/index.ts`

每个工具目录下的 `index.ts`：

1. 定义 Zod input schema。
2. 定义 `ToolDefinition`。
3. 实现 `validate`、`buildApproval`、`execute`、`present`。
4. 导出该工具对象。

#### `tools/index.ts`

根 `tools/index.ts`：

1. 负责注册并导出全部工具。
2. 提供 `toolRegistry`。
3. 提供 `toolByName` lookup。
4. 不承担具体工具实现。

#### `tools/shared/*`

共享目录负责跨工具复用逻辑：

1. 路径安全。
2. 工具结果截断。
3. 大结果 artifact 持久化接口。
4. shell 命令执行基础设施。
5. file snapshot store。
6. diagnostics provider 抽象。

## 7. 厚 `ToolDefinition`

### 7.1 目标接口

新的工具定义接口建议如下：

```ts
type ToolDefinition<TInput, TResult> = {
  name: ToolName;
  description: string;
  inputSchema: z.ZodType<TInput>;
  approval: 'never' | 'required';
  readOnly: boolean;
  concurrencySafe: boolean;
  validate?: (input: TInput, context: ToolContext) => Promise<void> | void;
  buildApproval?: (
    input: TInput,
    context: ToolContext
  ) => Promise<Record<string, unknown>>;
  execute: (input: TInput, context: ToolContext) => Promise<TResult>;
  present: (
    result: TResult,
    context: ToolContext
  ) => ToolPresentation | Promise<ToolPresentation>;
};
```

### 7.2 `ToolContext`

建议为所有工具统一注入 `ToolContext`：

```ts
type ToolContext = {
  sessionId: string;
  runId?: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  now(): string;
  diagnostics: DiagnosticsProvider;
  fileSnapshots: FileSnapshotStore;
  writeArtifact?: (input: ToolArtifactInput) => Promise<ToolArtifactRef>;
};
```

首版不必一次把所有实现接满，但接口应先定下来。

### 7.3 `ToolPresentation`

建议统一呈现结构：

```ts
type ToolPresentation = {
  title?: string;
  outputText: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  attachments?: FileAttachment[];
  exposePayload?: boolean;
};
```

设计目标：

1. `outputText` 是模型默认可见结果。
2. `payload` 是结构化内部结果。
3. `metadata` 是 UI/调试/后续逻辑使用。
4. `attachments` 用于未来图片/PDF/二进制附件扩展。
5. `exposePayload` 控制是否允许 JSON payload 直接进入模型上下文。

## 8. Zod 作为 schema 单一真相

### 8.1 原则

每个工具参数 schema 只定义一次，使用 Zod：

1. 运行期 parse 用它。
2. TypeScript input 类型由 `z.infer` 推导。
3. 暴露给 AI SDK 的 schema 从该 Zod schema 派生。

### 8.2 迁移目标

工具定义不再保存手写 `Record<string, unknown>` JSON schema，而是直接保存：

```ts
inputSchema: z.object({ ... })
```

AI SDK adapter 负责：

1. 如果 AI SDK 可直接接 Zod，则直接使用。
2. 如果需要 JSON schema，则由 adapter 统一转换。
3. 转换逻辑集中在 `context/ai-sdk-tool-adapter.ts` 或其下游 helper。

### 8.3 预期收益

1. 消除 schema 漂移。
2. 减少维护成本。
3. 保证模型输入契约和执行期输入契约一致。
4. 让工具目录的 `index.ts` 同时成为参数定义唯一来源。

## 9. approval policy 回归工具定义

approval policy 不再由中心化 `toolRequiresApproval()` 决定，而由每个工具定义自己声明：

| 工具          | approval   |
| ------------- | ---------- |
| `read`        | `never`    |
| `glob`        | `never`    |
| `grep`        | `never`    |
| `apply_patch` | `required` |
| `bash`        | `required` |
| `edit`        | `required` |
| `write`       | `required` |

运行时只关心：

1. 工具存在与否。
2. schema 是否 parse 成功。
3. `tool.approval` 是否为 `required`。

这会让 approval 判断自然从“按工具名写规则”迁移到“按工具定义读声明”。

## 10. result mapping 回归工具定义

模型看到的工具结果不应由统一的 `formatToolOutput()` 决定，而应由每个工具自己定义 `present()`。

### 10.1 设计原则

1. `execute()` 返回结构化原始结果。
2. `present()` 将原始结果转成模型和 UI 友好的表达。
3. 对模型有价值的内容进入 `outputText`。
4. 仅对确有必要的工具启用 `payload` 直接暴露。

### 10.2 各工具的模型可见结果

| 工具          | 模型可见结果                    |
| ------------- | ------------------------------- |
| `read`        | 带行号的文件片段或目录 entries  |
| `glob`        | 相对路径列表                    |
| `grep`        | 文件 + 行号 + 命中行            |
| `apply_patch` | 成功文件列表 + diagnostics      |
| `bash`        | exit code + stdout/stderr       |
| `edit`        | 成功消息 + 当前文件 diagnostics |
| `write`       | 成功消息 + 当前文件 diagnostics |

### 10.3 各工具不应该默认暴露给模型的内容

| 工具          | 不应直接进模型的内容               |
| ------------- | ---------------------------------- |
| `edit`        | 完整 diff metadata                 |
| `write`       | 完整下一版文件内容                 |
| `apply_patch` | 完整 patch 文本和全量 before/after |
| `bash`        | 过长原始 stdout/stderr 全量        |
| `grep`        | 全量命中集合超过预算时的完整列表   |

## 11. 统一截断层

### 11.1 设计目标

为所有工具结果提供一层统一预算控制，避免大工具结果直接拖垮上下文和 SSE。

### 11.2 首版预算建议

| 维度                  | 建议预算   |
| --------------------- | ---------- |
| 默认单工具输出上限    | 50KB       |
| 默认行数上限          | 2000 行    |
| 默认单行上限          | 2000 字符  |
| Grep matches 上限     | 100 条     |
| Glob paths 上限       | 100 条     |
| Bash preview metadata | 30KB       |
| Artifact preview      | 2KB 到 4KB |

### 11.3 工具分层策略

#### 自行截断的工具

这些工具有强语义，应自行控制截断：

1. `read`
2. `grep`
3. `glob`

#### approval-required 的工具

这些工具都需要 approval，且仍受“单个审批工具/轮”约束：

1. `apply_patch`
2. `bash`
3. `edit`
4. `write`

#### 统一兜底截断的工具

这些工具一般输出较短，统一层兜底即可：

1. `apply_patch`
2. `bash`
3. `edit`
4. `write`

### 11.4 大结果 artifact

首版可以只实现统一字符串截断，但 RFC 预留如下扩展：

1. 大输出写入 session-scoped artifact。
2. `ToolPart.state.metadata` 中保存 artifact 引用。
3. `outputText` 中只保留 preview 和继续操作提示。
4. UI DetailPane 可查看完整 artifact。
5. `read` 工具产生的 durable file snapshot 也复用 artifact 机制，而不是引入单独 snapshot store。

建议的后续展示形式：

```text
The output was truncated. Full result stored as artifact <id>.
Preview:
...
```

## 12. 路径安全

### 12.1 原则

本项目首版采取严格 workspace 内沙箱策略：

1. 允许相对路径和绝对路径输入。
2. 最终所有路径都必须严格落在 workspace root 内。
3. 不做 `external_directory` approval 模式，workspace 外路径直接拒绝。
4. 模型和 UI 侧优先展示 workspace 相对路径。

### 12.2 共享路径工具

建议在 `tools/shared/path.ts` 提供如下 helper：

1. `assertNoNullByte()`
2. `assertInsideWorkspace()`
3. `resolveWorkspacePath()`
4. `resolveExistingWorkspacePath()`
5. `resolveWritableWorkspacePath()`
6. `toWorkspaceRelativePath()`

### 12.3 判定规则

1. 使用 `path.relative(root, target)` 判断 containment，而不是 `startsWith(root)`。
2. 对已存在路径，使用 `realpath()` 后再判断 containment。
3. 对写入不存在的路径，使用 parent directory 的 `realpath()` 判断 containment。
4. 拒绝 null byte。
5. 未来如需 Windows 支持，应额外处理大小写与 UNC path。

### 12.4 输出路径格式

统一规则：

1. 服务端内部使用 absolute path。
2. 模型可见结果和 approval payload 使用 workspace 相对路径。
3. 仅在必要 metadata 中保留 absolute path，避免泄露不必要的宿主路径细节。

## 13. Read Snapshot 与 stale write 防护

### 13.1 目标

已有文件在 `edit/write` 前必须先被完整 `read`，并且从读取到写入期间没有发生 stale 变化。

### 13.2 共享状态结构

本 RFC 采用如下存储策略：

1. file snapshot 的 durable truth 存储在 `artifacts` 表中，`kind='file_snapshot'`。
2. snapshot 与具体一次 `read` tool call 关联，复用 `artifacts.toolCallId`。
3. `ToolPart.state.metadata` 中只保存轻量引用，例如 `snapshotArtifactId`，不保存 snapshot 主体。
4. 不新增独立的 `file_read_snapshots` 表。

建议在 `tools/shared/file-snapshot.ts` 中定义 artifact payload：

```ts
type FileSnapshotArtifact = {
  version: 1;
  path: string;
  truncated: boolean;
  mtimeMs: number;
  size: number;
  sha256: string;
  fullRead: boolean;
  readAt: string;
  lineCount?: number;
  previewOffset?: number;
  previewLimit?: number;
};
```

同时定义 runtime 侧查询接口：

```ts
type FileSnapshotStore = {
  createFromRead(input: {
    sessionId: string;
    toolCallId: string;
    snapshot: FileSnapshotArtifact;
  }): Promise<{ artifactId: string }>;
  getLatestForPath(input: {
    sessionId: string;
    path: string;
    requireFullRead?: boolean;
  }): Promise<{
    artifactId: string;
    snapshot: FileSnapshotArtifact;
  } | null>;
};
```

这意味着：

1. artifact 是 snapshot 的 durable truth。
2. metadata 是 pointer。
3. `edit/write` 的 preflight 校验通过 artifact 查询完成，而不是依赖进程内存。

### 13.3 read 行为

`read` 成功后：

1. 创建一个 `file_snapshot` artifact，并与本次 `read` 的 `toolCallId` 绑定。
2. `ToolPart.state.metadata` 中保存 `snapshotArtifactId`。
3. 如果是完整文件读取，artifact 中记录 `fullRead=true`。
4. 如果使用了 `offset/limit`，artifact 中记录 `fullRead=false`，不能作为 `edit/write` 的合法前置条件。
5. 如果读取过程中因预算只生成了 preview，则是否记为 `fullRead=true` 取决于 read 实现是否真的完成了全文件扫描；无论哪种情况，校验真相都以 artifact payload 为准。

### 13.4 edit/write 行为

编辑或覆盖已有文件前，必须检查：

1. 是否存在该 path 最近一次合法 snapshot artifact。
2. snapshot 是否为 `fullRead=true`。
3. 当前文件 `mtime/size` 是否与 snapshot 一致。
4. 如引入 `sha256`，则内容哈希是否一致。

失败时应明确报错：

1. 未读取过文件。
2. 只做了 partial read。
3. 文件自 read 之后被修改。

### 13.5 写后更新 snapshot

`edit/write` 成功后：

1. 重新计算文件状态。
2. 追加新的 `file_snapshot` artifact，而不是原地修改旧 snapshot。
3. 更新最新 `ToolPart.state.metadata.snapshotArtifactId` 指向新 artifact。
4. 避免“刚写完又被视为 stale”。

## 14. Diagnostics Provider

### 14.1 目标

为 `edit/write` 成功结果提供可选 diagnostics 文本，而不把 diagnostics 实现硬编码到工具本身。

### 14.2 首版接口

建议在 `tools/shared/diagnostics.ts` 中定义：

```ts
type ToolDiagnostic = {
  filePath: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  column: number;
  message: string;
};

type DiagnosticsProvider = {
  collectForFiles(paths: string[]): Promise<ToolDiagnostic[]>;
};
```

### 14.3 首版实现

首版 server wiring 可以先注入 no-op：

```ts
collectForFiles: async () => [];
```

这样可以先把接口形态定下来，而不阻塞工具本体落地。

### 14.4 模型可见输出策略

#### `edit`

1. 基础输出：`Edit applied successfully.`
2. 如果当前文件有 error diagnostics，则在成功消息后拼接 diagnostics 块。
3. 首版不额外拼接其他文件 diagnostics。

#### `write`

1. 基础输出：`Wrote file successfully.`
2. 如果当前文件有 error diagnostics，则拼接 diagnostics 块。
3. 首版可选拼接最多 5 个其他文件 diagnostics，若实现复杂可延后到第二阶段。

## 15. 提示词分层与 system-reminder

### 15.1 目标

本项目需要把“长期有效的工具选择策略”和“当前运行态/模式切换提醒”分层表达，而不是全部堆进同一段 system text。

### 15.2 三层职责

#### A. `SYSTEM_PROMPT`

放长期有效的工具使用策略，包括：

1. 先读后改的基本原则。
2. 新文件优先 `write`。
3. 小文件优先全文 `read` 后使用 `edit/write`。
4. 大文件避免整文件替换，优先局部 `read` 后使用 `apply_patch`。
5. `apply_patch` 是已有文件局部修改的主编辑原语。
6. 单个审批工具/轮约束。
7. workspace 边界约束。

#### B. `system-reminder` runtime block

放当前运行态信息，例如 mode 切换、当前是否只读、当前是否允许写或执行命令。

建议使用如下形式：

```xml
<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.
</system-reminder>
```

该 block 可以在 `buildSystemContext()` 中作为额外的 system block 注入。

#### C. `tools/<tool>/prompt.ts`

放每个工具的局部使用细节，例如：

1. `read` 的行号格式与 `offset/limit` 语义。
2. `edit` 的 `oldString/newString` 唯一匹配要求。
3. `write` 的整文件替换适用场景。
4. `apply_patch` 的 patch 格式、Add/Update/Delete 语法与局部修改语义。

### 15.3 大小文件编辑策略

本 RFC 采用如下工具选择策略：

1. 小文件：全文 `read` + `edit/write`
2. 大文件：局部 `read` + `apply_patch`
3. 新文件：`write`

这里的关键点不是“全文 read 永远更好”，而是：

1. 小文件全文 read 能给模型更多结构性上下文，通常能提高修改质量。
2. 大文件如果强制全文 read，容易触发上下文预算和不可编辑问题。
3. `apply_patch` 通过基于当前文件内容的 hunk/context 匹配来保证局部修改正确性，不要求模型先完整读完整个大文件。

### 15.4 `apply_patch` 与 `edit` 的角色区分

本 RFC 明确：

1. `apply_patch` 是已有文件局部修改的主原语，尤其面向大文件。
2. `edit` 是模型更易调用的高层替换工具，更适合小文件或小范围精确字符串替换。
3. 后续如有需要，可以把 `edit` 的底层执行逐步收敛到统一 patch engine，但这不作为本次首版的强制要求。

## 16. 七个核心工具详细方案

### 16.1 `read`

#### 输入

```ts
{
  filePath: string
  offset?: number
  limit?: number
}
```

#### approval

`never`

#### 行为

1. 支持读取文本文件。
2. 可选支持读取目录并返回目录 entries。
3. 不支持将任意二进制文件原样塞入模型上下文。
4. 默认 `offset=1`。
5. 默认 `limit=2000`。
6. 每行前加行号。
7. 单行过长时截断。
8. 达到字节或行数预算时停止，并提示如何继续读取。
9. 成功读取后创建 `file_snapshot` artifact。
10. `ToolPart.state.metadata` 中保存 `snapshotArtifactId`。
11. 只有 artifact 中 `fullRead=true` 的 snapshot 才能作为 `edit/write` 的合法前置条件。

#### 模型可见输出建议

```xml
<path>src/index.ts</path>
<type>file</type>
<content>
1: import ...
2: ...
</content>
(End of file - total 120 lines)
```

如被截断：

```text
(File truncated. Use offset=2001 to continue.)
```

#### metadata

1. `path`
2. `offset`
3. `limit`
4. `truncated`
5. `totalLines`
6. `bytesRead`
7. `fullRead`

### 16.2 `glob`

#### 输入

```ts
{
  pattern: string
  path?: string
}
```

#### approval

`never`

#### 行为

1. 基于 `rg --files --glob` 实现。
2. 默认搜索 workspace root。
3. 返回 workspace 相对路径。
4. 按 mtime 近到远排序。
5. 默认最多返回 100 条。

#### 模型可见输出

相对路径列表，每行一条。

#### metadata

1. `count`
2. `truncated`
3. `pattern`
4. `path`

### 16.3 `grep`

#### 输入

```ts
{
  pattern: string
  path?: string
  include?: string
}
```

#### approval

`never`

#### 行为

1. 基于 `rg` 实现。
2. 默认搜索 workspace root。
3. 支持 `include` 过滤文件模式。
4. 返回文件、行号、命中行文本。
5. 单行过长时截断。
6. 默认最多返回 100 条 matches。
7. 最终按文件 mtime 近到远排序。

#### 模型可见输出示例

```text
Found 24 matches (showing first 100)

src/foo.ts:
  Line 12: const value = ...
  Line 18: function ...
```

#### metadata

1. `matches`
2. `truncated`
3. `pattern`
4. `path`
5. `include`

### 16.4 `bash`

#### 输入

```ts
{
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
}
```

#### approval

`required`

#### 行为

1. 命令在 workspace root 或其子目录中执行。
2. 支持 `workdir`，但仍必须落在 workspace root 内。
3. 默认 timeout 120s。
4. 支持通过 AbortSignal 中断，并 kill process group。
5. `stdout` 和 `stderr` 结构化保存。
6. 非 0 exit code 不应被当作工具执行失败，而应作为已完成结果返回给模型。
7. 只有真正的 spawn/validation/path safety 错误才进入 `tool.failed`。

#### approval payload

1. `command`
2. `description`
3. `workdir`
4. `timeoutMs`

#### 模型可见输出建议

```text
Exit code: 1

STDOUT:
...

STDERR:
...
```

#### metadata

1. `command`
2. `description`
3. `workdir`
4. `exitCode`
5. `timedOut`
6. `durationMs`
7. `truncated`

### 16.5 `apply_patch`

#### 输入

```ts
{
  patchText: string;
}
```

#### approval

`required`

#### 行为

1. `apply_patch` 是已有文件局部修改的主编辑原语，尤其用于大文件。
2. 输入是一段完整 patch text，采用简化的文件级 patch 语法。
3. patch 支持 `Add File`、`Update File`、`Delete File`，可选 `Move to`。
4. 执行时按 patch hunk/context 在当前文件内容中进行验证匹配。
5. 不要求模型事先完整 read 整个文件，但要求模型至少读过相关局部并生成正确 patch。
6. 如果 hunk/context 无法在当前文件中匹配，则直接失败，提示重新读取相关片段。
7. approval payload 中展示聚合 diff 和逐文件变更摘要。
8. 成功后为非删除文件追加新的 `file_snapshot` artifact。
9. 可选收集当前变更文件的 diagnostics。

#### approval payload

1. `summary`
2. `diff`
3. `files`
4. `additions`
5. `deletions`

#### 模型可见输出

1. 成功更新的文件列表。
2. 追加当前变更文件 diagnostics。

#### metadata

1. `diff`
2. `files`
3. `diagnostics`
4. `snapshotArtifactIds`

### 16.6 `write`

#### 输入

```ts
{
  filePath: string;
  content: string;
}
```

#### approval

`required`

#### 行为

1. 写入新文件时允许直接创建，不要求 read。
2. 覆盖已有文件时必须先找到最近一次 `fullRead=true` 的 snapshot artifact，且文件必须未 stale。
3. 允许创建 parent directory。
4. approval payload 中展示 diff。
5. 不自动做 formatter，以避免 approval diff 与最终落盘内容不一致。
6. 写入成功后追加新的 `file_snapshot` artifact。
7. 可选收集 diagnostics。

#### approval payload

1. `path`
2. `summary`
3. `diff`
4. `bytes`
5. `exists`

#### 模型可见输出

1. 基础成功消息。
2. 追加 diagnostics 文本。

#### metadata

1. `path`
2. `exists`
3. `bytesWritten`
4. `diagnostics`
5. `staleChecked`

### 16.7 `edit`

#### 输入

```ts
{
  filePath: string
  oldString: string
  newString: string
  replaceAll?: boolean
}
```

#### approval

`required`

#### 行为

1. 仅用于修改已有文件。
2. 必须先找到最近一次 `fullRead=true` 的 snapshot artifact。
3. 文件自 snapshot 对应 read 后若 stale，则拒绝继续修改。
4. 默认要求 `oldString` 唯一匹配。
5. `replaceAll=true` 时替换所有匹配。
6. 保持原文件换行风格。
7. approval payload 中展示 diff。
8. 成功后追加新的 `file_snapshot` artifact。
9. 可选收集 diagnostics。

#### 首版替换策略

首版先只做保守语义：

1. exact match
2. unique occurrence check
3. `replaceAll`
4. CRLF/LF 归一

本阶段不实现复杂 fuzzy replacement、indentation-flexible replacement、context-aware replacement。

#### approval payload

1. `path`
2. `summary`
3. `diff`
4. `replaceAll`

#### 模型可见输出

1. 基础成功消息：`Edit applied successfully.`
2. 追加当前文件 diagnostics。

#### metadata

1. `path`
2. `diff`
3. `diagnostics`
4. `matches`
5. `replaceAll`

## 17. 工具注册与命名

### 17.1 新工具名

首批工具统一使用更标准的名称：

| 新名          | 旧名          |
| ------------- | ------------- |
| `bash`        | `run_command` |
| `read`        | `read_file`   |
| `write`       | `write_file`  |
| `edit`        | 新增          |
| `grep`        | 新增          |
| `glob`        | 新增          |
| `apply_patch` | 新增          |

### 17.2 兼容策略

本 RFC 采用一次性 DB/schema migration，并直接切换到新工具名，不提供旧工具名兼容层。

理由：

1. 当前项目仍处于 MVP 早期。
2. 工具系统尚未成为稳定对外协议。
3. 尽早统一为标准命名有利于后续扩展。
4. 当前仓库可以接受通过重开本地数据库和 session 的方式完成切换。

本次迁移的明确约束如下：

1. 需要同步修改 ORM schema、shared DTO、agent tool types、approval kind、测试用例、system prompt 文案。
2. 不考虑对已有本地历史数据做兼容读取或在线迁移。
3. 旧 session、旧 tool_call、旧 approval 数据视为可丢弃，迁移后通过新建数据库或重开本地开发环境生效。
4. 因此本次迁移目标是“代码与 schema 一次性切换”，而不是“新旧工具名并存”。

## 18. 运行时改造点

### 18.1 `tools/index.ts`

负责：

1. 导出 `toolRegistry`。
2. 导出 `toolByName`。
3. 暴露全部标准工具。

### 18.2 `context/tool-registry.ts`

负责：

1. 从注册中心读取工具列表。
2. 叠加 `runtime.toolOverrides`。
3. 输出最终启用工具集合。

不再负责：

1. 推导 approval policy。
2. 编码工具专属行为。

### 18.3 `context/ai-sdk-tool-adapter.ts`

负责：

1. 从 `ToolDefinition.inputSchema` 生成 AI SDK 可用 schema。
2. 生成 tool policy map。

### 18.4 `tool-executor.ts`

需要从中心化分支迁移为通用 wrapper：

1. 依据工具名 lookup `ToolDefinition`。
2. `inputSchema.parse()`。
3. `validate()`。
4. 若需要 approval，则执行 `buildApproval()`。
5. approval 通过后执行 `execute()`。
6. 调用 `present()` 生成 `ToolPresentation`。
7. 进入统一截断层。
8. 写回 `ToolPart/tool_call`。

### 18.5 `shared dto/context schema`

可能需要微调：

1. `ToolName` 类型。
2. `ApprovalDto.kind`。
3. `ToolPart.state.metadata` 的结构使用方式。
4. 大结果 artifact 引用字段。

### 18.6 file snapshot artifact 基础设施

需要补充：

1. artifact repository / service 的最小读写接口，支持 `kind='file_snapshot'`。
2. `read` 工具在完成后写入 snapshot artifact。
3. `edit/write/apply_patch` 在需要时按 `sessionId + path` 查询最近一次合法 snapshot artifact。
4. `ToolPart.state.metadata.snapshotArtifactId` 的写入与回放约定。

### 18.7 单个审批工具/轮约束

当前运行时只支持同一轮中最多一个 approval-required tool call。

本 RFC 明确保留这一约束，不在本次重构中引入 approval queue 或多审批并行恢复机制。

具体要求：

1. `SessionProcessor` 中“单个审批工具/轮”的失败语义保持不变。
2. `apply_patch`、`bash`、`edit`、`write` 都属于 approval-required 工具，因此同一轮模型最多只能调用其中一个。
3. system prompt 和工具描述文案需要显式提醒模型：若需要多个审批工具，应分多轮串行调用。
4. 测试中需要覆盖“同一轮多个审批工具调用直接失败”的场景，确保该约束在工具扩容后仍然稳定。

## 19. 分阶段实施计划

### Phase 1: 工具框架重构

目标：建立厚 `ToolDefinition` 和共享工具基础设施。

任务：

1. 新建 `tools/core.ts`、`tools/types.ts`。
2. 定义厚版 `ToolDefinition`、`ToolContext`、`ToolPresentation`。
3. 建立 `tools/shared/*` 目录。
4. 让根 `tools/index.ts` 只做注册。
5. 明确保留“单个审批工具/轮”约束，并将该约束补充进 prompt / 文档 / 测试基线。

### Phase 1.5: 一次性工具命名迁移

目标：把旧工具名和 approval kind 一次性切换为新名称。

任务：

1. 修改 ORM schema 中 `tool_calls.tool_name` 和 `approvals.kind` 的约束枚举。
2. 修改 shared DTO 中 `ToolName` 相关类型和 `ApprovalDto.kind`。
3. 修改 agent runtime、context adapter、tool registry、system prompt 中的旧工具名引用。
4. 修改测试和 fixtures 中的旧工具名引用。
5. 明确本次迁移不保留历史数据兼容，开发环境通过重建本地数据库生效。

### Phase 2: Zod 单一真相

目标：消除手写 JSON schema 双写。

任务：

1. 每个工具只保留 Zod schema。
2. AI SDK adapter 从 Zod 派生 schema。
3. 工具输入类型改为 `z.infer`。

### Phase 3: 路径安全与统一截断基础设施

目标：优先补齐所有工具共享的底层安全能力。

任务：

1. 实现 `shared/path.ts`。
2. 实现 `shared/truncation.ts`。
3. 接入 artifact writer / reader 接口，并支持 `kind='file_snapshot'` 的最小读写。
4. 接入 diagnostics no-op provider。
5. 定义 `ToolPart.state.metadata.snapshotArtifactId` 的约定。

### Phase 4: 落地只读工具

目标：先完成低风险工具。

任务：

1. `read`
2. `glob`
3. `grep`

完成标准：

1. Zod schema 正常暴露给模型。
2. 输出格式符合本 RFC。
3. 路径安全与截断生效。
4. `read` 能写入 durable `file_snapshot` artifact。
5. `read` 的 `ToolPart.state.metadata` 能保存 `snapshotArtifactId`。

### Phase 5: 落地 `apply_patch`

目标：优先补齐已有文件局部修改的 patch 原语，并作为大文件编辑主路径。

任务：

1. 设计 `patchText` 输入格式与 parser/validator。
2. 实现按 hunk/context 匹配当前文件的 patch apply 流程。
3. approval payload 展示聚合 diff 和逐文件变更摘要。
4. 变更成功后为受影响文件追加 snapshot artifact。
5. diagnostics 文本输出。

### Phase 6: 落地 `bash`

目标：将现有 `run_command` 升级为真正的 `bash` 工具。

任务：

1. 保留现有 abort/kill process group 能力。
2. 改为 `bash` 命名与输入结构。
3. 非 0 exit code 返回 completed result，不再直接失败。
4. 输出纳入统一截断层。

### Phase 7: 落地 `write`

目标：先支持整文件写入和新建文件。

任务：

1. 新建文件允许直接写。
2. 覆盖已有文件必须完整 read。
3. stale write 拒绝。
4. approval payload 展示 diff。
5. 写前通过 snapshot artifact 做 preflight。
6. 写后追加新的 snapshot artifact。

### Phase 8: 落地 `edit`

目标：支持基于 `oldString/newString` 的安全精确编辑。

任务：

1. 必须完整 read。
2. 唯一匹配检查。
3. `replaceAll` 支持。
4. 换行风格保持。
5. approval payload 展示 diff。
6. 写前通过 snapshot artifact 做 preflight。
7. 写后追加新的 snapshot artifact。

### Phase 9: 测试和收尾

目标：补齐测试和必要的 DTO/事件适配。

任务：

1. 补单元测试。
2. 补集成测试。
3. 校验 approval/resume 正常。
4. 校验 tool result 正常回灌上下文。
5. 校验“同一轮多个审批工具调用直接失败”的约束未被破坏。

## 20. 测试计划

### 20.1 `read`

1. 普通文本读取。
2. 行号输出。
3. `offset/limit`。
4. 大文件截断。
5. 长行截断。
6. 目录读取。
7. workspace 外路径拒绝。
8. 创建 durable `file_snapshot` artifact。
9. `ToolPart.state.metadata.snapshotArtifactId` 正确回写。
10. 完整 read 记录 `fullRead=true`。
11. partial read 不可作为 edit/write 前置。

### 20.2 `glob`

1. pattern 匹配。
2. 指定 `path`。
3. mtime 排序。
4. 结果上限截断。
5. workspace 外路径拒绝。

### 20.3 `grep`

1. regex 搜索。
2. `include` 过滤。
3. 命中结果格式。
4. 长行截断。
5. 结果数量截断。
6. 无结果场景。
7. workspace 外路径拒绝。

### 20.4 `apply_patch`

1. patchText 格式校验。
2. add/update/delete/move。
3. hunk/context 匹配失败时拒绝。
4. approval payload 正确。
5. 成功文件列表输出。
6. 写后追加新的 snapshot artifact。
7. diagnostics 文本输出。
8. 与 `bash/edit/write` 同轮出现时，维持单审批工具失败语义。

### 20.5 `bash`

1. approval payload 正确。
2. 正常命令执行。
3. 非 0 exit code 返回 completed result。
4. timeout 正确处理。
5. abort 杀进程组。
6. `workdir` 安全限制。
7. 大输出统一截断。
8. 与 `apply_patch/edit/write` 同轮出现时，维持单审批工具失败语义。

### 20.6 `write`

1. 新建文件。
2. 覆盖已有文件前未 read 被拒绝。
3. partial read 后覆盖被拒绝。
4. stale write 被拒绝。
5. parent directory 创建。
6. approval diff 正确。
7. 写前从 artifact 查询 snapshot。
8. 写后追加新的 snapshot artifact。
9. diagnostics 文本输出。
10. 与 `apply_patch/bash/edit` 同轮出现时，维持单审批工具失败语义。

### 20.7 `edit`

1. 未 read 被拒绝。
2. partial read 被拒绝。
3. stale write 被拒绝。
4. 唯一匹配成功。
5. 多匹配且未 `replaceAll` 时失败。
6. `replaceAll=true` 成功。
7. CRLF/LF 保持。
8. approval diff 正确。
9. 写前从 artifact 查询 snapshot。
10. 写后追加新的 snapshot artifact。
11. diagnostics 文本输出。
12. 与 `apply_patch/bash/write` 同轮出现时，维持单审批工具失败语义。

## 21. 风险与权衡

### 21.1 不自动 format 的权衡

优点：

1. approval 看到的 diff 与最终落盘内容一致。
2. 减少隐藏副作用。

缺点：

1. 模型可能需要额外调用 `bash` 去运行 formatter。

本 RFC 选择优先保证可预期性，不在首版自动 format。

### 21.2 不实现 fuzzy edit 的权衡

优点：

1. 避免“模型以为改了 A，工具实际改了 B”。
2. 首版行为更确定。

缺点：

1. 模型在空白差异、缩进差异下更容易 edit 失败。

本 RFC 选择首版保守，后续再讨论更强的 replacer 策略。

### 21.3 引入 `apply_patch` 的权衡

优点：

1. 适合大文件局部修改。
2. approval diff 更自然。
3. 不要求模型先完整读取整个大文件。
4. 更符合最小修改原则。

缺点：

1. patch 语法对模型更严格。
2. patch parser/validator 的实现复杂度高于简单 edit。
3. hunk/context 校验失败时，模型需要重新读取局部内容后重试。

本 RFC 选择将 `apply_patch` 纳入首批核心工具，以避免“大文件必须全文 read 才能修改”的硬边界。

### 21.4 不做 workspace 外 approval 的权衡

优点：

1. 安全边界清晰。
2. MVP 复杂度更低。

缺点：

1. 少数高级使用场景受限。

本 RFC 选择首版硬限制 workspace 内，后续如有明确需求再评估 `external_directory` 模式。

## 22. 后续扩展点

本 RFC 完成后，可自然扩展：

1. 更强的 `edit` replacer
2. `edit` 底层逐步收敛到 patch engine
3. tool output artifact viewer
4. workspace 外目录审批
5. LSP/TypeScript diagnostics 真正接入
6. 只读工具并发执行优化
7. tool-level output policy
8. 按 provider/model 能力过滤工具
9. 如果 artifact 方案后续不足，再评估独立 snapshot 表

## 23. 最终决策摘要

本 RFC 的最终决策如下：

1. 保留现有 runtime 主链路，重构工具层而不是重写运行时。
2. 工具目录采用 `tools/<tool>/index.ts + prompt.ts` 结构。
3. `prompt.ts` 只放工具描述文案，不承载执行逻辑。
4. `ToolDefinition` 升级为厚接口，承载 schema、approval、execute、present 等完整行为。
5. Zod 成为 schema 单一真相。
6. approval policy 回归工具定义。
7. result mapping 回归工具定义。
8. 引入统一截断层，并预留 artifact 扩展。
9. 路径安全升级为严格 workspace 内沙箱。
10. 引入 read snapshot 和 stale write 防护。
11. `apply_patch`/edit/write 支持成功结果和 diagnostics 文本。
12. 工具命名采用一次性 DB/schema migration，不考虑历史数据兼容，迁移后通过重开本地数据库生效。
13. 继续保留“单个审批工具/轮”约束，不在本次重构中实现多审批工具同轮恢复。
14. file snapshot 的 durable truth 复用 `artifacts(kind='file_snapshot')`，`ToolPart.state.metadata` 只保存轻量指针 `snapshotArtifactId`。
15. 提示词分层为：`SYSTEM_PROMPT` 承载长期工具策略，`system-reminder` 承载 mode/runtime 状态，`tools/<tool>/prompt.ts` 承载工具局部规则。
16. 采用大小文件分流策略：小文件优先全文 `read` 后 `edit/write`，大文件优先局部 `read` 后 `apply_patch`，新文件使用 `write`。
17. `apply_patch` 纳入首批 7 个核心工具，并作为已有文件局部修改的主原语。
18. 首批工具按 `read -> glob -> grep -> apply_patch -> bash -> write -> edit` 顺序落地。
