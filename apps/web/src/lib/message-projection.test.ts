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
