import { useEffect, useState } from 'react';
import type { SessionEventEnvelope } from '@opencode/shared';
import { useQueryClient } from '@tanstack/react-query';

type StreamStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

type StreamState = {
  events: SessionEventEnvelope[];
  sessionId?: string;
  status: StreamStatus;
};

const SESSION_EVENT_NAMES = [
  'run.created',
  'run.completed',
  'run.cancelled',
  'run.blocked',
  'run.failed',
  'message.created',
  'message.part.created',
  'message.part.delta',
  'message.part.updated',
  'message.completed',
  'message.cancelled',
  'tool.pending',
  'approval.created',
  'approval.resolved',
  'tool.running',
  'tool.completed',
  'tool.failed',
  'session.recovered',
  'session.resumable',
  'session.updated'
] as const;

function isCacheRelevantEvent(event: SessionEventEnvelope['event']) {
  return !event.type.startsWith('message.');
}

function isPlanBoardRelevantEvent(event: SessionEventEnvelope['event']) {
  return (
    event.type === 'session.updated' ||
    event.type === 'tool.pending' ||
    event.type === 'tool.running' ||
    event.type === 'tool.completed' ||
    event.type === 'tool.failed' ||
    event.type === 'approval.created' ||
    event.type === 'approval.resolved'
  );
}

function isMessageCacheRelevantEvent(event: SessionEventEnvelope['event']) {
  return (
    event.type === 'message.created' ||
    event.type === 'message.part.created' ||
    event.type === 'message.part.updated' ||
    event.type === 'message.completed' ||
    event.type === 'message.cancelled' ||
    event.type === 'tool.pending' ||
    event.type === 'approval.created' ||
    event.type === 'approval.resolved' ||
    event.type === 'tool.running' ||
    event.type === 'tool.completed' ||
    event.type === 'tool.failed'
  );
}

export function useSessionStream(sessionId?: string, workspaceId?: string) {
  const queryClient = useQueryClient();
  const [streamState, setStreamState] = useState<StreamState>({
    events: [],
    sessionId: undefined,
    status: 'disconnected'
  });

  useEffect(() => {
    if (!sessionId) {
      setStreamState({
        events: [],
        sessionId: undefined,
        status: 'disconnected'
      });
      return;
    }

    setStreamState({
      events: [],
      sessionId,
      status: 'connecting'
    });

    const eventSource = new EventSource(`/api/sessions/${sessionId}/stream`);
    const handleEnvelope = (messageEvent: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(messageEvent.data) as SessionEventEnvelope;

        if (envelope.event.sessionId !== sessionId) {
          return;
        }

        setStreamState((currentState) => {
          if (currentState.sessionId !== sessionId) {
            return currentState;
          }

          if (
            currentState.events.some(
              (currentEvent) => currentEvent.sequenceNo === envelope.sequenceNo
            )
          ) {
            return {
              ...currentState,
              status: 'connected'
            };
          }

          return {
            ...currentState,
            events: [...currentState.events, envelope],
            status: 'connected'
          };
        });

        if (isCacheRelevantEvent(envelope.event)) {
          void queryClient.invalidateQueries({
            queryKey: ['resume-session', sessionId]
          });
          void queryClient.invalidateQueries({
            queryKey: ['session', sessionId]
          });

          if (workspaceId) {
            void queryClient.invalidateQueries({
              queryKey: ['sessions', workspaceId]
            });
          }
        }

        if (isMessageCacheRelevantEvent(envelope.event)) {
          void queryClient.invalidateQueries({
            queryKey: ['messages', sessionId]
          });
        }

        if (isPlanBoardRelevantEvent(envelope.event)) {
          void queryClient.invalidateQueries({
            queryKey: ['session-plan-board', sessionId]
          });
          void queryClient.invalidateQueries({
            queryKey: ['session-plan-file', sessionId]
          });
        }
      } catch {
        setStreamState((currentState) =>
          currentState.sessionId === sessionId
            ? { ...currentState, status: 'error' }
            : currentState
        );
      }
    };

    const handleError = () => {
      setStreamState((currentState) =>
        currentState.sessionId === sessionId
          ? {
              ...currentState,
              status:
                eventSource.readyState === EventSource.CLOSED
                  ? 'disconnected'
                  : 'error'
            }
          : currentState
      );
    };

    eventSource.onopen = () => {
      setStreamState((currentState) =>
        currentState.sessionId === sessionId
          ? { ...currentState, status: 'connected' }
          : currentState
      );
    };
    eventSource.onerror = handleError;

    for (const eventName of SESSION_EVENT_NAMES) {
      eventSource.addEventListener(eventName, handleEnvelope as EventListener);
    }

    return () => {
      for (const eventName of SESSION_EVENT_NAMES) {
        eventSource.removeEventListener(
          eventName,
          handleEnvelope as EventListener
        );
      }

      eventSource.close();
    };
  }, [queryClient, sessionId, workspaceId]);

  const events = streamState.sessionId === sessionId ? streamState.events : [];
  const status =
    streamState.sessionId === sessionId
      ? streamState.status
      : sessionId
        ? 'connecting'
        : 'disconnected';

  return {
    events,
    status
  } as const;
}
