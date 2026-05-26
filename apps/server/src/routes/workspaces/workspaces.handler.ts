import { appFactory } from '../../lib/factory.js';
import { isServiceError } from '../../lib/service-error.js';
import { createValidator } from '../../lib/validator.js';
import { workspaceService } from '../../services/workspace/service.js';
import { WorkspacesSchemas } from './workspaces.schema.js';

export const list = appFactory.createHandlers((c) =>
  c.json({ data: workspaceService.listWorkspaces() })
);

export const browse = appFactory.createHandlers(
  createValidator.query(WorkspacesSchemas.browse.query),
  (c) => {
    const { path } = c.req.valid('query');

    try {
      return c.json({ data: workspaceService.browseDirectory(path) });
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const create = appFactory.createHandlers(
  createValidator.json(WorkspacesSchemas.create.json),
  async (c) => {
    const payload = c.req.valid('json');

    try {
      const workspace = workspaceService.createWorkspace(payload);
      return c.json({ data: workspace }, 201);
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);

export const getTree = appFactory.createHandlers(
  createValidator.param(WorkspacesSchemas.tree.param),
  (c) => {
    const { workspaceId } = c.req.valid('param');

    try {
      return c.json({ data: workspaceService.getTree(workspaceId) });
    } catch (error) {
      if (isServiceError(error)) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  }
);
