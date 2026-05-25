import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WorkspaceDirectoryBrowseDto } from '@opencode/shared';
import { browseWorkspaceDirectory } from '../../lib/api';
import {
  applyDirectoryBrowseFailure,
  applyDirectoryBrowseSuccess
} from './directory-picker-state';

type DirectoryPickerModalProps = {
  initialPath?: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (path: string) => void;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '目录读取失败';
}

export function DirectoryPickerModal({
  initialPath,
  isOpen,
  onClose,
  onConfirm
}: DirectoryPickerModalProps) {
  const [browseResult, setBrowseResult] =
    useState<WorkspaceDirectoryBrowseDto | null>(null);
  const [currentPath, setCurrentPath] = useState<string | undefined>(
    initialPath
  );
  const [selectedPath, setSelectedPath] = useState<string | undefined>(
    initialPath
  );
  const [errorMessage, setErrorMessage] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setCurrentPath(initialPath);
    setSelectedPath(initialPath);
  }, [initialPath, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;

    async function load(path?: string) {
      setIsLoading(true);
      setErrorMessage(undefined);

      try {
        const nextResult = await browseWorkspaceDirectory(path);

        if (cancelled) {
          return;
        }

        const nextState = applyDirectoryBrowseSuccess(
          {
            browseResult,
            currentPath,
            errorMessage,
            isLoading: true,
            selectedPath
          },
          nextResult
        );

        setBrowseResult(nextState.browseResult);
        setCurrentPath(nextState.currentPath);
        setSelectedPath(nextState.selectedPath);
        setErrorMessage(nextState.errorMessage);
      } catch (error) {
        if (cancelled) {
          return;
        }

        const nextState = applyDirectoryBrowseFailure(
          {
            browseResult,
            currentPath,
            errorMessage,
            isLoading: true,
            selectedPath
          },
          getErrorMessage(error)
        );

        setErrorMessage(nextState.errorMessage);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void load(currentPath);

    return () => {
      cancelled = true;
    };
  }, [currentPath, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8 backdrop-blur-sm">
      <div className="flex h-[min(88vh,860px)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#090b0e] text-white shadow-[0_32px_120px_rgba(0,0,0,0.55)]">
        <div className="shrink-0 border-b border-white/10 bg-[linear-gradient(180deg,#141820,#0d1016)] px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-white/40">
                Workspace Picker
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-white">
                选择一个本地目录
              </h2>
              <p className="mt-2 text-sm leading-6 text-white/55">
                默认从当前仓库开始浏览，也可以继续切换到机器上的任意目录。
              </p>
            </div>
            <button
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
              onClick={onClose}
              type="button"
            >
              关闭
            </button>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              className="rounded-full border border-white/10 bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-white/90"
              onClick={() => setCurrentPath(undefined)}
              type="button"
            >
              当前仓库
            </button>
            {browseResult?.parentPath ? (
              <button
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
                onClick={() => setCurrentPath(browseResult.parentPath)}
                type="button"
              >
                返回上级
              </button>
            ) : null}
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-xs text-white/55">
            {browseResult?.segments.map((segment) => (
              <button
                className="rounded-full border border-white/10 bg-[#11161d] px-3 py-1.5 transition hover:border-white/20 hover:bg-[#171d25] hover:text-white"
                key={segment.path}
                onClick={() => setCurrentPath(segment.path)}
                type="button"
              >
                {segment.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-h-0 flex-1 flex-col border-b border-white/10 bg-[#0b0d10] md:border-b-0 md:border-r">
            <div className="border-b border-white/10 px-6 py-4 text-xs uppercase tracking-[0.24em] text-white/35">
              Directories
            </div>
            <div className="console-scroll flex-1 min-h-0 overflow-y-auto px-4 py-4">
              {isLoading ? (
                <div className="px-2 py-2 text-sm text-white/55">
                  正在读取目录...
                </div>
              ) : null}
              {errorMessage ? (
                <div className="px-2 py-2">
                  <div className="rounded-[18px] border border-red-400/20 bg-red-500/10 px-4 py-4 text-sm leading-6 text-red-200">
                    {errorMessage}
                  </div>
                </div>
              ) : null}
              {!isLoading &&
              !errorMessage &&
              (browseResult?.directories.length ?? 0) === 0 ? (
                <div className="px-2 py-2 text-sm leading-6 text-white/50">
                  当前目录下没有可浏览的子目录。
                </div>
              ) : null}
              {browseResult?.directories.map((directory) => {
                const isSelected = selectedPath === directory.path;

                return (
                  <button
                    className={
                      isSelected
                        ? 'mb-2 block w-full rounded-[18px] border border-white/15 bg-[#171d25] px-4 py-4 text-left text-white transition'
                        : 'mb-2 block w-full rounded-[18px] border border-transparent bg-transparent px-4 py-4 text-left text-white/72 transition hover:border-white/10 hover:bg-[#12161d] hover:text-white'
                    }
                    key={directory.path}
                    onClick={() => setCurrentPath(directory.path)}
                    type="button"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-sm font-semibold">
                          {directory.name}
                        </div>
                        <div className="mt-1 text-xs text-white/45">
                          {directory.path}
                        </div>
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] text-white/45">
                        Open
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex shrink-0 flex-col bg-[#10141a] md:min-h-0">
            <div className="border-b border-white/10 px-6 py-4 text-xs uppercase tracking-[0.24em] text-white/35">
              Selected Path
            </div>
            <div className="flex-1 px-6 py-6">
              <div className="break-all font-mono text-sm leading-7 text-white/85">
                {selectedPath ?? '还没有选择目录'}
              </div>
              <p className="mt-4 text-sm leading-6 text-white/45">
                目录确认后，首页会使用这个绝对路径调用现有 workspace 创建接口。
              </p>
            </div>
            <div className="mt-auto flex gap-3 border-t border-white/10 px-6 py-5">
              <button
                className="flex-1 rounded-full border border-white/10 bg-white/5 px-4 py-3 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
              <button
                className="flex-1 rounded-full bg-white px-4 py-3 text-sm font-semibold text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!selectedPath}
                onClick={() => {
                  if (!selectedPath) {
                    return;
                  }

                  onConfirm(selectedPath);
                }}
                type="button"
              >
                Use This Directory
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
