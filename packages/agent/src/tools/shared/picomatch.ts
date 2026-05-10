import { createRequire } from 'node:module';

type PicomatchOptions = {
  dot?: boolean;
  posixSlashes?: boolean;
  strictBrackets?: boolean;
};

type PicomatchMatcher = (input: string) => boolean;

type PicomatchFactory = (
  pattern: string,
  options?: PicomatchOptions
) => PicomatchMatcher;

const require = createRequire(import.meta.url);

export const picomatch = require('picomatch') as PicomatchFactory;
