import { workspaces } from '@opencode/orm';
import type { NewWorkspace, WorkspaceRow } from '@opencode/orm';
import type { WorkspaceDto } from '@opencode/shared';
import { desc, eq } from 'drizzle-orm';
import { Database } from '../db/runtime.js';

function mapWorkspaceRow(row: WorkspaceRow): WorkspaceDto {
  return {
    createdAt: row.createdAt,
    id: row.id,
    lastOpenedAt: row.lastOpenedAt,
    name: row.name,
    rootPath: row.rootPath,
    updatedAt: row.updatedAt
  };
}

export const workspaceRepository = {
  create(input: NewWorkspace): WorkspaceDto {
    const row = Database.use((db) =>
      db.insert(workspaces).values(input).returning().get()
    );
    return mapWorkspaceRow(row);
  },

  getById(id: string): WorkspaceDto | null {
    const row = Database.use((db) =>
      db.select().from(workspaces).where(eq(workspaces.id, id)).get()
    );
    return row ? mapWorkspaceRow(row) : null;
  },

  getByRootPath(rootPath: string): WorkspaceDto | null {
    const row = Database.use((db) =>
      db
        .select()
        .from(workspaces)
        .where(eq(workspaces.rootPath, rootPath))
        .get()
    );

    return row ? mapWorkspaceRow(row) : null;
  },

  list(): WorkspaceDto[] {
    return Database.use((db) =>
      db
        .select()
        .from(workspaces)
        .orderBy(desc(workspaces.lastOpenedAt))
        .all()
        .map(mapWorkspaceRow)
    );
  },

  touchLastOpenedAt(id: string, now: string): WorkspaceDto | null {
    const row = Database.use((db) =>
      db
        .update(workspaces)
        .set({
          lastOpenedAt: now,
          updatedAt: now
        })
        .where(eq(workspaces.id, id))
        .returning()
        .get()
    );

    return row ? mapWorkspaceRow(row) : null;
  }
};
