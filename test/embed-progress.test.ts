import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { EMBEDDING_MODEL_ID, createStderrDownloadReporter } from '../src/embedding/embedder.js';

interface TestStream extends NodeJS.WriteStream {
  output: string;
}

function makeStream(isTTY: boolean): TestStream {
  let buf = '';
  const w = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  }) as unknown as TestStream;
  Object.defineProperty(w, 'isTTY', { value: isTTY });
  Object.defineProperty(w, 'output', {
    get: () => buf,
  });
  return w;
}

describe('createStderrDownloadReporter', () => {
  it('stays silent on a pure cache hit (initiate/download/done/ready only)', () => {
    const stream = makeStream(true);
    const reporter = createStderrDownloadReporter(stream);
    reporter.onEvent({ status: 'initiate', file: 'tokenizer.json' });
    reporter.onEvent({ status: 'download', file: 'tokenizer.json' });
    reporter.onEvent({ status: 'done', file: 'tokenizer.json' });
    reporter.onEvent({ status: 'ready' });
    expect(stream.output).toBe('');
  });

  it('stays silent when "progress" reports 100% in one shot (cache hit)', () => {
    const stream = makeStream(true);
    const reporter = createStderrDownloadReporter(stream);
    reporter.onEvent({
      status: 'progress',
      file: 'model.onnx',
      loaded: 80 * 1024 * 1024,
      total: 80 * 1024 * 1024,
      progress: 100,
    });
    reporter.onEvent({ status: 'ready' });
    expect(stream.output).toBe('');
  });

  it('announces the download exactly once when partial progress arrives', () => {
    const stream = makeStream(true);
    const reporter = createStderrDownloadReporter(stream);
    reporter.onEvent({
      status: 'progress',
      file: 'model.onnx',
      loaded: 1024 * 1024,
      total: 80 * 1024 * 1024,
      progress: 1.25,
    });
    reporter.onEvent({
      status: 'progress',
      file: 'model.onnx',
      loaded: 40 * 1024 * 1024,
      total: 80 * 1024 * 1024,
      progress: 50,
    });
    const announceLines = stream.output
      .split('\n')
      .filter((l) => l.startsWith('Downloading embedding model'));
    expect(announceLines).toHaveLength(1);
    expect(announceLines[0]).toContain(EMBEDDING_MODEL_ID);
    expect(announceLines[0]).toContain('first time only');
  });

  it('repaints the progress line on TTY', () => {
    const stream = makeStream(true);
    const reporter = createStderrDownloadReporter(stream);
    reporter.onEvent({
      status: 'progress',
      file: 'model.onnx',
      loaded: 40 * 1024 * 1024,
      total: 80 * 1024 * 1024,
      progress: 50,
    });
    expect(stream.output).toContain('model.onnx');
    expect(stream.output).toContain('50%');
    expect(stream.output).toContain('80 MB');
    expect(stream.output).toContain('\r');
  });

  it('does not emit progress lines on non-TTY (no log spam in CI)', () => {
    const stream = makeStream(false);
    const reporter = createStderrDownloadReporter(stream);
    reporter.onEvent({
      status: 'progress',
      file: 'model.onnx',
      loaded: 1024,
      total: 1024 * 1024,
      progress: 0.1,
    });
    reporter.onEvent({
      status: 'progress',
      file: 'model.onnx',
      loaded: 512 * 1024,
      total: 1024 * 1024,
      progress: 50,
    });
    expect(stream.output).toContain('Downloading embedding model');
    expect(stream.output).not.toContain('\r');
    expect(stream.output).not.toMatch(/model\.onnx:/);
  });

  it('falls back to announcement via the grace timer hook (small-files-first scenario)', () => {
    // Real cache misses can start by fetching tiny metadata files (each
    // arriving as a single 100% progress event) before the big ONNX model
    // produces partial events. The grace timer fires announceIfStillLoading
    // after a fixed delay so the user is not left staring at silence.
    const stream = makeStream(true);
    const reporter = createStderrDownloadReporter(stream);
    reporter.onEvent({
      status: 'progress',
      file: 'tokenizer.json',
      loaded: 4096,
      total: 4096,
      progress: 100,
    });
    expect(stream.output).toBe('');
    reporter.announceIfStillLoading();
    expect(stream.output).toContain('Downloading embedding model');
  });

  it('does not double-announce when the grace timer fires after partial progress', () => {
    const stream = makeStream(true);
    const reporter = createStderrDownloadReporter(stream);
    reporter.onEvent({
      status: 'progress',
      file: 'model.onnx',
      loaded: 1024,
      total: 1024 * 1024,
      progress: 0.1,
    });
    reporter.announceIfStillLoading();
    const announceLines = stream.output
      .split('\n')
      .filter((l) => l.startsWith('Downloading embedding model'));
    expect(announceLines).toHaveLength(1);
  });

  it('never writes to stdout (regression guard for "stdout untouched")', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const stream = makeStream(true);
      const reporter = createStderrDownloadReporter(stream);
      reporter.onEvent({ status: 'initiate', file: 'x' });
      reporter.onEvent({
        status: 'progress',
        file: 'x',
        loaded: 1,
        total: 1024,
        progress: 0.1,
      });
      reporter.announceIfStillLoading();
      reporter.onEvent({ status: 'ready' });
      expect(stdoutSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('emits the ready confirmation only when a download was announced', () => {
    const cacheHit = makeStream(true);
    const cacheHitReporter = createStderrDownloadReporter(cacheHit);
    cacheHitReporter.onEvent({ status: 'ready' });
    expect(cacheHit.output).toBe('');

    const downloaded = makeStream(true);
    const downloadedReporter = createStderrDownloadReporter(downloaded);
    downloadedReporter.onEvent({
      status: 'progress',
      file: 'model.onnx',
      loaded: 80 * 1024 * 1024,
      total: 160 * 1024 * 1024,
      progress: 50,
    });
    downloadedReporter.onEvent({ status: 'ready' });
    expect(downloaded.output).toContain('Embedding model ready.');
  });
});
