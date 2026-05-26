import type {
  MessageDto,
  MessagePart,
  SessionEventEnvelope
} from '@opencode/shared';

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

function upsertMessage(
  messages: ProjectedMessage[],
  nextMessage: ProjectedMessage
) {
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

function mergeMessage(
  currentMessage: ProjectedMessage,
  incomingMessage: ProjectedMessage,
  marker: EventMarker
) {
  const incomingParts = new Map(
    incomingMessage.content.map((part) => [part.id, part] as const)
  );
  const currentParts = new Map(
    currentMessage.content.map((part) => [part.id, part] as const)
  );
  const mergedContent = currentMessage.content.map((currentPart) => {
    const incomingPart = incomingParts.get(currentPart.id);

    if (!incomingPart) {
      return currentPart;
    }

    const currentPartMarker = currentMessage.__partEventMarks?.[
      currentPart.id
    ] ?? {
      createdAt: currentPart.updatedAt,
      sequenceNo: 0
    };

    return compareMarkers(currentPartMarker, marker) > 0
      ? currentPart
      : incomingPart;
  });

  for (const incomingPart of incomingMessage.content) {
    if (!currentParts.has(incomingPart.id)) {
      mergedContent.push(incomingPart);
    }
  }

  return {
    ...currentMessage,
    ...incomingMessage,
    content: mergedContent.sort((left, right) =>
      left.order === right.order
        ? left.id.localeCompare(right.id)
        : left.order - right.order
    ),
    __partEventMarks: {
      ...(currentMessage.__partEventMarks ?? {}),
      ...(incomingMessage.__partEventMarks ?? {})
    }
  } satisfies ProjectedMessage;
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

function applyDeltaSafely(input: {
  delta: string;
  part: MessagePart;
  partMarker: EventMarker | undefined;
  marker: EventMarker;
}) {
  const { delta, marker, part, partMarker } = input;

  if (delta.length === 0) {
    return part;
  }

  // If the base query already returned the latest persisted text for this part,
  // a late-arriving SSE delta with the same updatedAt timestamp may represent
  // content that is already included in `part.text`. In that case, avoid
  // appending it again and only advance the event marker.
  if (
    partMarker &&
    part.updatedAt === marker.createdAt &&
    partMarker.createdAt === marker.createdAt &&
    partMarker.sequenceNo === 0
  ) {
    if (
      (part.type === 'text' || part.type === 'reasoning') &&
      part.text.endsWith(delta)
    ) {
      return part;
    }
  }

  if (part.type === 'text') {
    return {
      ...part,
      text: part.text + delta,
      updatedAt: marker.createdAt
    };
  }

  if (part.type === 'reasoning') {
    return {
      ...part,
      text: part.text + delta,
      updatedAt: marker.createdAt
    };
  }

  return part;
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
      return upsertMessage(
        messages,
        (() => {
          const event = envelope.event;
          const nextMessage = {
            ...event.message,
            __partEventMarks: Object.fromEntries(
              event.message.content.map((part) => [part.id, marker])
            )
          } satisfies ProjectedMessage;
          const existing = messages.find(
            (message) => message.id === event.message.id
          );

          return existing
            ? mergeMessage(existing, nextMessage, marker)
            : nextMessage;
        })()
      );
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
        const currentPart = existing.content.find(
          (part) => part.id === event.part.id
        );
        const currentPartMarker =
          existing.__partEventMarks?.[event.part.id] ??
          (currentPart
            ? { createdAt: currentPart.updatedAt, sequenceNo: 0 }
            : undefined);

        if (
          currentPartMarker &&
          compareMarkers(currentPartMarker, marker) > 0
        ) {
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

      return upsertMessage(
        messages,
        markPartEvent(
          {
            ...existing,
            content: [...existing.content, event.part].sort((left, right) =>
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
        if (
          (event.field === 'text' && part.type === 'text') ||
          (event.field === 'reasoning.text' && part.type === 'reasoning')
        ) {
          return applyDeltaSafely({
            delta: event.delta,
            marker,
            part,
            partMarker
          });
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
    case 'message.completed': {
      const event = envelope.event;
      return messages.map((message) =>
        message.id === event.messageId
          ? { ...message, status: 'completed', updatedAt: envelope.createdAt }
          : message
      );
    }
    case 'message.cancelled': {
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

function coalesceDeltaEvents(events: SessionEventEnvelope[]) {
  const coalesced: SessionEventEnvelope[] = [];

  for (const envelope of events) {
    const previous = coalesced.at(-1);

    if (
      previous?.event.type === 'message.part.delta' &&
      envelope.event.type === 'message.part.delta' &&
      previous.createdAt === envelope.createdAt &&
      previous.event.messageId === envelope.event.messageId &&
      previous.event.partId === envelope.event.partId &&
      previous.event.field === envelope.event.field
    ) {
      coalesced[coalesced.length - 1] = {
        ...envelope,
        event: {
          ...envelope.event,
          delta: previous.event.delta + envelope.event.delta
        }
      };
      continue;
    }

    coalesced.push(envelope);
  }

  return coalesced;
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

  const projected = coalesceDeltaEvents(events).reduce(
    projectEvent,
    initialMessages
  );

  return sortMessages(projected).map(
    ({ __partEventMarks: _marks, ...message }) => message
  );
}
