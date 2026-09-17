import type { SetupDraft, SetupStep } from "./compiler";

export type RunArguments = Record<string, string | number>;

export type Recording = {
  id: string;
  status: "recording" | "stopped" | "expired";
  liveViewUrl: string | null;
  steps: SetupStep[];
  expiresAt: string;
  blockedReason: string | null;
};

export type TestRun = {
  status: "running" | "succeeded" | "failed";
  error?: string;
  files?: Array<{ name: string; url: string }>;
};

type RequestMap = {
  ready: { params: Record<string, never>; result: { schedule: boolean } };
  startRecording: { params: { url: string }; result: Recording };
  getRecording: { params: { id: string }; result: Recording };
  stopRecording: { params: { id: string }; result: Recording };
  cancelRecording: { params: { id: string }; result: undefined };
  saveAgent: { params: { draft: SetupDraft; config: unknown; agentId?: string }; result: { id: string } };
  testAgent: { params: { agentId: string; arguments: RunArguments }; result: { id: string } };
  getTestRun: { params: { agentId: string; runId: string }; result: TestRun };
  scheduleAgent: { params: { agentId: string; runId: string; arguments: RunArguments; cron: string }; result: undefined };
  close: { params: { agentId?: string }; result: undefined };
};

type Method = keyof RequestMap;
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
  onLateResult?: (result: unknown) => void;
};

type RequestOptions = {
  onLateResult?: (result: unknown) => void;
};

export type HostBridge = {
  request<M extends Method>(
    method: M,
    params: RequestMap[M]["params"],
    options?: RequestOptions,
  ): Promise<RequestMap[M]["result"]>;
  destroy(): void;
};

const requestTimeoutMs = 45_000;

export function createHostBridge(): HostBridge | null {
  const parentOrigin = parentOriginFromLocation();
  if (parentOrigin === null || window.parent === window) {
    return null;
  }

  const pending = new Map<string, PendingRequest>();
  const timedOut = new Map<string, RequestOptions["onLateResult"]>();
  const sessionId = window.crypto.randomUUID();
  let counter = 0;

  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.origin !== parentOrigin || event.source !== window.parent) {
      return;
    }
    const response = parseResponse(event.data);
    if (response === null) {
      return;
    }

    const request = pending.get(response.id);
    if (request === undefined) {
      const onLateResult = timedOut.get(response.id);
      if (onLateResult !== undefined && response.error === undefined) {
        timedOut.delete(response.id);
        onLateResult(response.result);
      }
      return;
    }
    pending.delete(response.id);
    window.clearTimeout(request.timeout);
    if (response.error !== undefined) {
      request.reject(new Error(response.error));
      return;
    }
    request.resolve(response.result);
  };
  window.addEventListener("message", onMessage);

  return {
    request<M extends Method>(
      method: M,
      params: RequestMap[M]["params"],
      options?: RequestOptions,
    ): Promise<RequestMap[M]["result"]> {
      counter += 1;
      const id = `${sessionId}:${method}-${counter}`;
      return new Promise<RequestMap[M]["result"]>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          const request = pending.get(id);
          pending.delete(id);
          if (request === undefined) {
            return;
          }
          if (request.onLateResult !== undefined) {
            timedOut.set(id, request.onLateResult);
          }
          request.reject(new Error("The request timed out. Retry to continue."));
        }, requestTimeoutMs);
        pending.set(id, {
          resolve: (result) => resolve(result as RequestMap[M]["result"]),
          reject,
          timeout,
          onLateResult: options?.onLateResult,
        });
        window.parent.postMessage(
          { type: "workflow-use:request", version: 1, id, method, params },
          parentOrigin,
        );
      });
    },
    destroy(): void {
      window.removeEventListener("message", onMessage);
      for (const request of pending.values()) {
        window.clearTimeout(request.timeout);
        request.reject(new Error("The setup page closed."));
      }
      pending.clear();
      timedOut.clear();
    },
  };
}

function parentOriginFromLocation(): string | null {
  const value = new URLSearchParams(window.location.search).get("parentOrigin");
  if (value === null) {
    return null;
  }
  try {
    const origin = new URL(value);
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.origin !== value) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

function parseResponse(data: unknown): { id: string; result?: unknown; error?: string } | null {
  if (!isRecord(data) || data.type !== "workflow-use:response" || data.version !== 1 || typeof data.id !== "string") {
    return null;
  }
  if (data.error !== undefined && typeof data.error !== "string") {
    return null;
  }
  return { id: data.id, result: data.result, error: data.error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function browserbaseLiveViewUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const url = new URL(value);
    const isBrowserbase = url.hostname === "browserbase.com" || url.hostname.endsWith(".browserbase.com");
    return url.protocol === "https:" && isBrowserbase ? url.toString() : null;
  } catch {
    return null;
  }
}
