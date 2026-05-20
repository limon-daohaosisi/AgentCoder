import type { PropsWithChildren } from 'react';

export function AppShell({ children }: PropsWithChildren) {
  return <div className="min-h-screen bg-[#1f1f1f] text-white">{children}</div>;
}
