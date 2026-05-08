import type { MessageDto, MessagePart, SessionEventEnvelope } from '@opencode/shared';

type EventMarker = {
  createdAt: string;
  sequenceNo: number;
};

type ProjectedMessage = MessageDto & {
  __partEventMarks?: Partial<Record<string, EventMarker>>;
};

function compareMarkers(left: EventMarker | undefined, right: EventMarker) {
  if (!left) {
    return -1;
  }

  if (left.createdAt === right.createdAt) {
    return left.sequenceNo - right.sequenceNo;
  }

  return left.createdAt.localeCompare(right.createdAt);
}

function markPartEvent(
  message: ProjectedMessage,
  partId: string,
  marker: EventMarker
): ProjectedMessage {
  return {
    ...message,
    __partEventMarks: {
      ...(message.__partEventMarks ?? {}),
      [partId]: marker
    }
  };
}

function upsertMessage(messages: ProjectedMessage[], nextMessage: ProjectedMessage) {
  const index = messages.findIndex((message) => message.id === nextMessage.id);

  if (index === -1) {
    return [...messages, nextMessage];
  }

  const updated = [...messages];
  updated[index] = {
    ...updated[index],
    ...nextMessage,
    content: nextMessage.content,
    __partEventMarks:
      nextMessage.__partEventMarks ?? updated[index]?.__partEventMarks
  };
  return updated;
}

function sortMessages(messages: ProjectedMessage[]) {
  return [...messages].sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id);
    }

    return left.createdAt.localeCompare(right.createdAt);
  });
}

function updatePartById(
  message: ProjectedMessage,
  partId: string,
  updater: (part: MessagePart) => MessagePart
) {
  const content = message.content.map((part) =>
    part.id === partId ? updater(part) : part
  );

  return {
    ...message,
    content
  };
}

function projectEvent(
  messages: ProjectedMessage[],
  envelope: SessionEventEnvelope
): ProjectedMessage[] {
  const marker = {
    createdAt: envelope.createdAt,
    sequenceNo: envelope.sequenceNo
  };

  switch (envelope.event.type) {
    case 'message.created':
      return upsertMessage(messages, {
        ...envelope.event.message,
        __partEventMarks: Object.fromEntries(
          envelope.event.message.content.map((part) => [part.id, marker])
        )
      });
    case 'message.part.created': {
      const event = envelope.event;
      const existing = messages.find(
        (message) => message.id === event.messageId
      );

      if (!existing) {
        return messages;
      }

      const alreadyExists = existing.content.some(
        (part) => part.id === event.part.id
      );

      if (alreadyExists) {
        return upsertMessage(
          messages,
          markPartEvent(existing, event.part.id, marker)
        );
      }

      return upsertMessage(
        messages,
        markPartEvent(
          {
            ...existing,
            content: [...existing.content, event.part].sort(
              (left, right) =>
                left.order === right.order
                  ? left.id.localeCompare(right.id)
                  : left.order - right.order
            )
          },
          event.part.id,
          marker
        )
      );
    }
    case 'message.part.delta': {
      const event = envelope.event;
      const existing = messages.find(
        (message) => message.id === event.messageId
      );

      if (!existing) {
        return messages;
      }

      const partMarker = existing.__partEventMarks?.[event.partId];

      if (compareMarkers(partMarker, marker) >= 0) {
        return messages;
      }

      const updatedMessage = updatePartById(existing, event.partId, (part) => {
        if (event.field === 'text' && part.type === 'text') {
          return {
            ...part,
            text: part.text + event.delta,
            updatedAt: envelope.createdAt
          };
        }

        if (event.field === 'reasoning.text' && part.type === 'reasoning') {
          return {
            ...part,
            text: part.text + event.delta,
            updatedAt: envelope.createdAt
          };
        }

        return part;
      });

      return upsertMessage(
        messages,
        markPartEvent(updatedMessage, event.partId, marker)
      );
    }
    case 'message.part.updated': {
      const event = envelope.event;
      const existing = messages.find(
        (message) => message.id === event.messageId
      );

      if (!existing) {
        return messages;
      }

      const partMarker = existing.__partEventMarks?.[event.part.id];

      if (compareMarkers(partMarker, marker) >= 0) {
        return messages;
      }

      return upsertMessage(
        messages,
        markPartEvent(
          updatePartById(existing, event.part.id, () => event.part),
          event.part.id,
          marker
        )
      );
    }
    case 'message.completed':
      {
        const event = envelope.event;
        return messages.map((message) =>
          message.id === event.messageId
            ? { ...message, status: 'completed', updatedAt: envelope.createdAt }
            : message
        );
      }
    case 'message.cancelled':
      {
        const event = envelope.event;
        return messages.map((message) =>
          message.id === event.messageId
            ? {
                ...message,
                finishReason: 'cancelled',
                status: 'cancelled',
                updatedAt: envelope.createdAt
              }
            : message
        );
      }
    default:
      return messages;
  }
}

export function projectMessages(
  baseMessages: MessageDto[],
  events: SessionEventEnvelope[]
) {
  const initialMessages = baseMessages.map((message) => ({
    ...message,
    __partEventMarks: Object.fromEntries(
      message.content.map((part) => [
        part.id,
        { createdAt: part.updatedAt, sequenceNo: 0 }
      ])
    )
  })) satisfies ProjectedMessage[];

  const projected = events.reduce(projectEvent, initialMessages);

  return sortMessages(projected).map(({ __partEventMarks: _marks, ...message }) => message);
}
