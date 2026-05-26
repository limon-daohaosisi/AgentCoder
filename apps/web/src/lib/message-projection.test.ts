import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageDto, SessionEventEnvelope } from '@opencode/shared';
import { projectMessages } from './message-projection.js';

test('projectMessages does not append a duplicate tail delta already present in base messages', () => {
  const baseMessages: MessageDto[] = [
    {
      content: [
        {
          createdAt: '2026-05-12T10:00:00.000Z',
          id: 'part-1',
          messageId: 'msg-1',
          order: 0,
          sessionId: 'session-1',
          text: '我先看看 `Deacf_Code` 的目录结构和关键文件，再给你总结它是做什么的。',
          type: 'text',
          updatedAt: '2026-05-12T10:00:01.000Z'
        }
      ],
      createdAt: '2026-05-12T10:00:00.000Z',
      id: 'msg-1',
      kind: 'message',
      role: 'assistant',
      sessionId: 'session-1',
      status: 'running',
      updatedAt: '2026-05-12T10:00:01.000Z'
    }
  ];
  const events: SessionEventEnvelope[] = [
    {
      createdAt: '2026-05-12T10:00:01.000Z',
      event: {
        delta: '的。',
        field: 'text',
        messageId: 'msg-1',
        partId: 'part-1',
        sessionId: 'session-1',
        type: 'message.part.delta'
      },
      sequenceNo: 42
    }
  ];

  const projected = projectMessages(baseMessages, events);
  const textPart = projected[0]?.content[0];

  assert.equal(textPart?.type, 'text');
  assert.equal(
    textPart?.type === 'text' ? textPart.text : undefined,
    '我先看看 `Deacf_Code` 的目录结构和关键文件，再给你总结它是做什么的。'
  );
});

test('projectMessages still applies a fresh text delta when it is not already present in base messages', () => {
  const baseMessages: MessageDto[] = [
    {
      content: [
        {
          createdAt: '2026-05-12T10:00:00.000Z',
          id: 'part-2',
          messageId: 'msg-2',
          order: 0,
          sessionId: 'session-2',
          text: '还有没直接找到这个名字，我改为搜索近似',
          type: 'text',
          updatedAt: '2026-05-12T10:00:01.000Z'
        }
      ],
      createdAt: '2026-05-12T10:00:00.000Z',
      id: 'msg-2',
      kind: 'message',
      role: 'assistant',
      sessionId: 'session-2',
      status: 'running',
      updatedAt: '2026-05-12T10:00:01.000Z'
    }
  ];
  const events: SessionEventEnvelope[] = [
    {
      createdAt: '2026-05-12T10:00:01.000Z',
      event: {
        delta: '名称。',
        field: 'text',
        messageId: 'msg-2',
        partId: 'part-2',
        sessionId: 'session-2',
        type: 'message.part.delta'
      },
      sequenceNo: 43
    }
  ];

  const projected = projectMessages(baseMessages, events);
  const textPart = projected[0]?.content[0];

  assert.equal(textPart?.type, 'text');
  assert.equal(
    textPart?.type === 'text' ? textPart.text : undefined,
    '还有没直接找到这个名字，我改为搜索近似名称。'
  );
});

test('projectMessages does not append a late tail delta when base text already includes a longer final suffix', () => {
  const baseMessages: MessageDto[] = [
    {
      content: [
        {
          createdAt: '2026-05-25T10:00:00.000Z',
          id: 'part-3',
          messageId: 'msg-3',
          order: 0,
          sessionId: 'session-3',
          text: '1. 扩展 apps/web/src/lib/message-projection.ts 的去重逻辑，不只判断 endsWith(delta)，而是识别“base 文本已经包含这段晚到 delta 对应的结果”。',
          type: 'text',
          updatedAt: '2026-05-25T10:00:02.000Z'
        }
      ],
      createdAt: '2026-05-25T10:00:00.000Z',
      id: 'msg-3',
      kind: 'message',
      role: 'assistant',
      sessionId: 'session-3',
      status: 'running',
      updatedAt: '2026-05-25T10:00:02.000Z'
    }
  ];
  const events: SessionEventEnvelope[] = [
    {
      createdAt: '2026-05-25T10:00:01.000Z',
      event: {
        delta: '结果”。',
        field: 'text',
        messageId: 'msg-3',
        partId: 'part-3',
        sessionId: 'session-3',
        type: 'message.part.delta'
      },
      sequenceNo: 99
    }
  ];

  const projected = projectMessages(baseMessages, events);
  const textPart = projected[0]?.content[0];

  assert.equal(textPart?.type, 'text');
  assert.equal(
    textPart?.type === 'text' ? textPart.text : undefined,
    '1. 扩展 apps/web/src/lib/message-projection.ts 的去重逻辑，不只判断 endsWith(delta)，而是识别“base 文本已经包含这段晚到 delta 对应的结果”。'
  );
});

test('projectMessages does not replay same-timestamp tail deltas that are already absorbed into base text', () => {
  const baseMessages: MessageDto[] = [
    {
      content: [
        {
          createdAt: '2026-05-25T10:00:00.000Z',
          id: 'part-4',
          messageId: 'msg-4',
          order: 0,
          sessionId: 'session-4',
          text: '写。',
          type: 'text',
          updatedAt: '2026-05-25T10:00:01.000Z'
        }
      ],
      createdAt: '2026-05-25T10:00:00.000Z',
      id: 'msg-4',
      kind: 'message',
      role: 'assistant',
      sessionId: 'session-4',
      status: 'running',
      updatedAt: '2026-05-25T10:00:01.000Z'
    }
  ];
  const events: SessionEventEnvelope[] = [
    {
      createdAt: '2026-05-25T10:00:01.000Z',
      event: {
        delta: '写',
        field: 'text',
        messageId: 'msg-4',
        partId: 'part-4',
        sessionId: 'session-4',
        type: 'message.part.delta'
      },
      sequenceNo: 100
    },
    {
      createdAt: '2026-05-25T10:00:01.000Z',
      event: {
        delta: '。',
        field: 'text',
        messageId: 'msg-4',
        partId: 'part-4',
        sessionId: 'session-4',
        type: 'message.part.delta'
      },
      sequenceNo: 101
    }
  ];

  const projected = projectMessages(baseMessages, events);
  const textPart = projected[0]?.content[0];

  assert.equal(textPart?.type, 'text');
  assert.equal(textPart?.type === 'text' ? textPart.text : undefined, '写。');
});
