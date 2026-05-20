import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import type { SessionVariant } from '@opencode/shared';

type ComposerProps = {
  defaultValue: string;
  disabled?: boolean;
  hint: string;
  isSubmitting?: boolean;
  onSubmit: (content: string) => void;
  onVariantChange: (variant: SessionVariant) => void;
  variant: SessionVariant;
};

export function Composer({
  defaultValue,
  disabled = false,
  hint,
  isSubmitting = false,
  onSubmit,
  onVariantChange,
  variant
}: ComposerProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedValue = value.trim();

    if (!normalizedValue || disabled || isSubmitting) {
      return;
    }

    onSubmit(normalizedValue);
    setValue('');
  }

  return (
    <form className="bg-[#242424] px-5 pb-4 pt-0" onSubmit={handleSubmit}>
      <textarea
        className="min-h-20 w-full resize-none rounded-[16px] border border-white/10 bg-[#151515] px-4 py-3 text-sm text-white outline-none ring-0 placeholder:text-white/35"
        disabled={disabled || isSubmitting}
        onChange={(event) => setValue(event.target.value)}
        value={value}
      />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs text-white/40">{hint}</p>
          <div className="inline-flex rounded-full border border-white/10 bg-[#1a1a1a] p-1 text-xs font-semibold text-white/55">
            {(['plan', 'build'] as const).map((item) => {
              const active = item === variant;

              return (
                <button
                  className={
                    active
                      ? 'rounded-full bg-[#d9d9d9] px-3 py-1.5 text-black'
                      : 'rounded-full px-3 py-1.5 text-white/55'
                  }
                  disabled={disabled || isSubmitting}
                  key={item}
                  onClick={() => onVariantChange(item)}
                  type="button"
                >
                  {item === 'plan' ? 'Plan' : 'Build'}
                </button>
              );
            })}
          </div>
        </div>
        <button
          className="rounded-full bg-[#d9d9d9] px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || isSubmitting || value.trim().length === 0}
          type="submit"
        >
          {isSubmitting ? '发送中...' : '发送给 agent'}
        </button>
      </div>
    </form>
  );
}
