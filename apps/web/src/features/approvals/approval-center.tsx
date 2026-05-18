import type { ApprovalDto, PlanExitApprovalPayload } from '@opencode/shared';
import { approveApproval, rejectApproval } from '../../lib/api';

type ApprovalCenterProps = {
  approvals: ApprovalDto[];
  onResolved?: (approvalId: string) => void;
};

export function ApprovalCenter({ approvals, onResolved }: ApprovalCenterProps) {
  return (
    <section className="rounded-[28px] border border-white/60 bg-white/80 p-5 shadow-panel backdrop-blur">
      <div className="mb-4">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-ember">
          Approval Center
        </p>
        <h2 className="text-lg font-semibold text-ink">Pending Actions</h2>
      </div>

      <div className="space-y-3">
        {approvals.map((approval) => (
          <article
            key={approval.id}
            className="rounded-2xl border border-amber-200 bg-amber-50 p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-amber-900">{approval.kind}</p>
                <p className="mt-1 text-xs uppercase tracking-[0.2em] text-amber-700">
                  {approval.status}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-white"
                  onClick={() => {
                    void approveApproval(approval.id).then(() => {
                      onResolved?.(approval.id);
                    });
                  }}
                  type="button"
                >
                  Approve
                </button>
                <button
                  className="rounded-full border border-amber-300 px-3 py-1.5 text-xs font-semibold text-amber-900"
                  onClick={() => {
                    void rejectApproval(approval.id).then(() => {
                      onResolved?.(approval.id);
                    });
                  }}
                  type="button"
                >
                  Reject
                </button>
              </div>
            </div>
            {approval.kind === 'plan_exit' ? (
              <PlanExitApprovalBody
                payload={approval.payload as PlanExitApprovalPayload}
              />
            ) : (
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words font-sans text-xs leading-6 text-amber-950">
                {JSON.stringify(approval.payload, null, 2)}
              </pre>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function PlanExitApprovalBody({
  payload
}: {
  payload: PlanExitApprovalPayload;
}) {
  return (
    <div className="mt-3 space-y-3">
      <div className="rounded-2xl bg-white/70 px-3 py-2 text-xs text-amber-950">
        <p className="font-semibold uppercase tracking-[0.18em] text-amber-700">
          Plan File Path
        </p>
        <p className="mt-2 break-all">{payload.planFilePath}</p>
      </div>
      {payload.summary ? (
        <div className="rounded-2xl bg-white/70 px-3 py-2 text-sm text-amber-950">
          <p className="font-semibold uppercase tracking-[0.18em] text-amber-700">
            Summary
          </p>
          <p className="mt-2 leading-6">{payload.summary}</p>
        </div>
      ) : null}
      <div className="rounded-2xl bg-white/70 px-3 py-2 text-sm text-amber-950">
        <p className="font-semibold uppercase tracking-[0.18em] text-amber-700">
          Plan Content
        </p>
        <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words font-sans text-xs leading-6 text-amber-950">
          {payload.planContent}
        </pre>
      </div>
    </div>
  );
}
