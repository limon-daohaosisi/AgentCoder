import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_CAPTURE_BYTES = 30_000;
const PROCESS_OUTPUT_DIR = path.join(tmpdir(), 'opencode', 'tool-output');

export type CapturedProcessOutput = {
  outputPath?: string;
  text: string;
  totalBytes: number;
  truncated: boolean;
};

export type CapturedProcessResult = {
  exitCode: null | number;
  stderr: CapturedProcessOutput;
  stdout: CapturedProcessOutput;
  timedOut: boolean;
};

class OutputCollector {
  private previewBuffers: Buffer[] = [];
  private previewBytes = 0;
  private spillScheduled = false;
  private spillPath?: string;
  private spillStream?: ReturnType<typeof createWriteStream>;
  private totalBytes = 0;
  private writeChain = Promise.resolve();

  constructor(
    private readonly streamName: 'stderr' | 'stdout',
    private readonly maxCaptureBytes: number
  ) {}

  append(chunk: Buffer | string) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const previewBeforeAppend = !this.spillStream
      ? Buffer.concat(this.previewBuffers)
      : undefined;

    this.totalBytes += buffer.length;

    if (!this.spillStream && this.previewBytes < this.maxCaptureBytes) {
      const remainingBytes = this.maxCaptureBytes - this.previewBytes;

      if (remainingBytes > 0) {
        const previewChunk = buffer.subarray(0, remainingBytes);

        this.previewBuffers.push(previewChunk);
        this.previewBytes += previewChunk.length;
      }
    }

    if (this.totalBytes <= this.maxCaptureBytes) {
      return;
    }

    if (!this.spillScheduled) {
      const initialOutput = Buffer.concat([
        previewBeforeAppend ?? Buffer.alloc(0),
        buffer
      ]);
      this.spillScheduled = true;

      this.writeChain = this.writeChain.then(async () => {
        await this.ensureSpillStream();
        await this.writeBuffer(initialOutput);
      });

      return;
    }

    this.writeChain = this.writeChain.then(() => this.writeBuffer(buffer));
  }

  async finalize(): Promise<CapturedProcessOutput> {
    await this.writeChain;

    if (this.spillStream) {
      await new Promise<void>((resolve, reject) => {
        this.spillStream!.end((error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    return {
      outputPath: this.spillPath,
      text: Buffer.concat(this.previewBuffers).toString('utf8'),
      totalBytes: this.totalBytes,
      truncated: Boolean(this.spillPath)
    };
  }

  private async ensureSpillStream() {
    if (this.spillStream) {
      return;
    }

    await mkdir(PROCESS_OUTPUT_DIR, { recursive: true });

    this.spillPath = path.join(
      PROCESS_OUTPUT_DIR,
      `${this.streamName}-${Date.now()}-${randomUUID()}.log`
    );
    this.spillStream = createWriteStream(this.spillPath);
  }

  private async writeBuffer(buffer: Buffer) {
    if (!this.spillStream) {
      throw new Error('Output spill stream is not initialized.');
    }

    await new Promise<void>((resolve, reject) => {
      this.spillStream!.write(buffer, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

export async function runSpawnedProcess(input: {
  args: string[];
  command: string;
  cwd: string;
  maxCaptureBytes?: number;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<CapturedProcessResult> {
  if (input.signal?.aborted) {
    throw new Error('Run cancelled by user');
  }

  return new Promise<CapturedProcessResult>((resolve, reject) => {
    const maxCaptureBytes = input.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const stdout = new OutputCollector('stdout', maxCaptureBytes);
    const stderr = new OutputCollector('stderr', maxCaptureBytes);
    let settled = false;
    let timedOut = false;

    function killChild(signal: NodeJS.Signals) {
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall back to killing only the direct child process.
        }
      }

      child.kill(signal);
    }

    function cleanup() {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abortHandler);
    }

    function rejectOnce(error: Error) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    async function resolveOnce(inputResult: {
      exitCode: null | number;
      timedOut: boolean;
    }) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      try {
        resolve({
          exitCode: inputResult.exitCode,
          stderr: await stderr.finalize(),
          stdout: await stdout.finalize(),
          timedOut: inputResult.timedOut
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    function abortHandler() {
      killChild('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          killChild('SIGKILL');
        }
      }, 1_000).unref();
      rejectOnce(new Error('Run cancelled by user'));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killChild('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          killChild('SIGKILL');
        }
      }, 1_000).unref();
    }, input.timeoutMs);

    input.signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout.append(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr.append(chunk);
    });

    child.on('error', (error) => {
      rejectOnce(error);
    });

    child.on('close', (exitCode) => {
      void resolveOnce({
        exitCode,
        timedOut
      });
    });
  });
}
