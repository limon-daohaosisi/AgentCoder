import { buildToolExecutionContext, readToolDefinition } from '@opencode/agent';
import { appFactory } from '../../lib/factory.js';
import { createValidator } from '../../lib/validator.js';
import { FilesSchemas } from './files.schema.js';

export const content = appFactory.createHandlers(
  createValidator.query(FilesSchemas.content.query),
  async (c) => {
    const { path, workspaceRoot } = c.req.valid('query');
    const data = await readToolDefinition.execute({
      context: buildToolExecutionContext({
        sessionId: 'route-preview',
        toolCallId: 'route-preview',
        workspaceRoot: workspaceRoot ?? process.cwd()
      }),
      input: { filePath: path }
    });

    return c.json({ data });
  }
);

export const search = appFactory.createHandlers(
  createValidator.query(FilesSchemas.search.query),
  (c) => {
    const { q } = c.req.valid('query');

    return c.json({
      data: [],
      query: q ?? ''
    });
  }
);
