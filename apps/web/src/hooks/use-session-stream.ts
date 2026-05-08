import { useEffect, useState } from 'react';
import type { SessionEventEnvelope } from '@opencode/shared';
import { useQueryClient } from '@tanstack/react-query';

type StreamStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

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

export function useSessionStream(sessionId?: string, workspaceId?: string) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<SessionEventEnvelope[]>([]);
  const [status, setStatus] = useState<StreamStatus>('disconnected');

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setStatus('disconnected');
      return;
    }

    setEvents([]);
    setStatus('connecting');

    const eventSource = new EventSource(`/api/sessions/${sessionId}/stream`);
    const handleEnvelope = (messageEvent: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(messageEvent.data) as SessionEventEnvelope;

        setEvents((currentEvents) => {
          if (
            currentEvents.some(
              (currentEvent) => currentEvent.sequenceNo === envelope.sequenceNo
            )
          ) {
            return currentEvents;
          }

          return [...currentEvents, envelope];
        });
        setStatus('connected');

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
      } catch {
        setStatus('error');
      }
    };

    const handleError = () => {
      setStatus(
        eventSource.readyState === EventSource.CLOSED ? 'disconnected' : 'error'
      );
    };

    eventSource.onopen = () => {
      setStatus('connected');
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
      setStatus('disconnected');
    };
  }, [queryClient, sessionId, workspaceId]);

  return {
    events,
    status
  } as const;
}
