/**
 * A recording fake {@link ProcessRunner} for tests. Captures each request and
 * returns a scripted result (or invokes a scripted handler). Never spawns a
 * real process.
 */

import { redactString, type ProcessRequest, type ProcessResult, type ProcessRunner } from "./process-runner.js";

export type FakeHandler = (request: ProcessRequest) => Partial<ProcessResult>;

export class FakeRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];
  private handler: FakeHandler;

  constructor(handler?: FakeHandler) {
    this.handler =
      handler ??
      (() => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false, aborted: false }));
  }

  setHandler(handler: FakeHandler): void {
    this.handler = handler;
  }

  run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    const partial = this.handler(request);
    // Emulate the real runner's redaction of captured output.
    const redact = request.redact ?? [];
    const result: ProcessResult = {
      code: partial.code ?? 0,
      signal: partial.signal ?? null,
      stdout: redactString(partial.stdout ?? "", redact),
      stderr: redactString(partial.stderr ?? "", redact),
      timedOut: partial.timedOut ?? false,
      aborted: partial.aborted ?? false,
    };
    return Promise.resolve(result);
  }

  get lastCall(): ProcessRequest {
    const call = this.calls.at(-1);
    if (!call) throw new Error("FakeRunner: no calls recorded");
    return call;
  }
}
