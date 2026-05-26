import type { WorkspaceDirectoryBrowseDto } from '@opencode/shared';

export type DirectoryPickerState = {
  browseResult: WorkspaceDirectoryBrowseDto | null;
  currentPath?: string;
  errorMessage?: string;
  isLoading: boolean;
  selectedPath?: string;
};

export function applyDirectoryBrowseSuccess(
  state: DirectoryPickerState,
  browseResult: WorkspaceDirectoryBrowseDto
): DirectoryPickerState {
  return {
    ...state,
    browseResult,
    currentPath: browseResult.currentPath,
    errorMessage: undefined,
    isLoading: false,
    selectedPath: browseResult.currentPath
  };
}

export function applyDirectoryBrowseFailure(
  state: DirectoryPickerState,
  errorMessage: string
): DirectoryPickerState {
  return {
    ...state,
    errorMessage,
    isLoading: false
  };
}
