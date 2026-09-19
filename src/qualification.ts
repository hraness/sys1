import type { LocalBackendConfig } from "./config.ts";
import { extractBackendCapabilities, extractModelIds } from "./backends.ts";
import { systemOneResponseSchema, type SystemOneRequest } from "./protocol.ts";

export type BackendQualificationStatus = "pass" | "warn" | "fail";

export interface BackendQualificationCheck {
  id: "models" | "limits" | "systemone";
  status: BackendQualificationStatus;
  summary: string;
  detail?: string;
}

export interface BackendQualificationReport {
  version: 1;
  backend: string;
  base_url: string;
  model: string;
  ok: boolean;
  checks: BackendQualificationCheck[];
}

export interface BackendQualificationOptions {
  probeTimeoutMs: number;
  requestTimeoutMs: number;
  fetchFn?: typeof fetch;
}

const QUALIFICATION_BODY_LIMIT = 4_194_304;

async function boundedText(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > QUALIFICATION_BODY_LIMIT) {
        await reader.cancel();
        throw new Error("response exceeds 4 MiB");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size));
}

async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<{ ok: true; body: unknown } | { ok: false; detail: string }> {
  try {
    const response = await fetchFn(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await boundedText(response);
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, detail: "response is not valid JSON" };
    }
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 256) : "request failed",
    };
  }
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function distributionTotal(probabilities: Record<string, number>): number {
  return Object.values(probabilities).reduce((sum, probability) => sum + probability, 0);
}

function responseContract(body: unknown): string | null {
  const parsed = systemOneResponseSchema.safeParse(body);
  if (!parsed.success) return "response does not match the System One schema";
  const refund = parsed.data.answers["refund"];
  const department = parsed.data.answers["department"];
  const urgency = parsed.data.answers["urgency"];
  if (refund?.type !== "noul" || department?.type !== "choice" || urgency?.type !== "score") {
    return "response does not preserve the requested answer types";
  }
  if (Object.keys(parsed.data.answers).length !== 3) {
    return "response answer keys differ from the request";
  }
  if (Object.keys(department.probabilities).sort().join(",") !== "billing,technical") {
    return "choice probability keys differ from the request";
  }
  if (
    Object.keys(urgency.legend).join(",") !== "0,1,2" ||
    Object.keys(urgency.probabilities).join(",") !== "0,1,2"
  ) {
    return "score keys differ from the request";
  }
  if (Math.abs(distributionTotal(department.probabilities) - 1) > 0.02) {
    return "choice probabilities are not normalized";
  }
  if (Math.abs(distributionTotal(urgency.probabilities) - 1) > 0.02) {
    return "score probabilities are not normalized";
  }
  const expected = Object.entries(urgency.probabilities).reduce(
    (sum, [level, probability]) => sum + Number(level) * probability,
    0,
  );
  if (Math.abs(expected - urgency.score) > 0.02) {
    return "score does not match its probability-weighted levels";
  }
  return null;
}

const QUALIFICATION_REQUEST: Omit<SystemOneRequest, "model"> = {
  state: "The customer was charged twice, requests a refund, and can still use checkout.",
  questions: {
    refund: {
      type: "noul",
      instructions: "Does the customer explicitly request a refund?",
    },
    department: {
      type: "choice",
      instructions: "Which team should handle this request?",
      criteria: {
        billing: "Charges, payments, and refunds",
        technical: "Software defects and unavailable features",
      },
    },
    urgency: {
      type: "score",
      instructions: "Rate current operational urgency.",
      criteria: ["no active impact", "limited impact", "critical outage"],
    },
  },
};

export async function qualifyBackend(
  backend: LocalBackendConfig,
  options: BackendQualificationOptions,
): Promise<BackendQualificationReport> {
  const fetchFn = options.fetchFn ?? fetch;
  const base = withoutTrailingSlashes(backend.base_url);
  const checks: BackendQualificationCheck[] = [];

  const modelsResponse = await requestJson(
    `${base}/v1/models`,
    { method: "GET", headers: { accept: "application/json" } },
    options.probeTimeoutMs,
    fetchFn,
  );
  if (!modelsResponse.ok) {
    checks.push({ id: "models", status: "fail", summary: "model discovery failed", detail: modelsResponse.detail });
  } else {
    const models = extractModelIds(modelsResponse.body);
    checks.push(
      models.includes(backend.model)
        ? { id: "models", status: "pass", summary: `backend serves ${backend.model}` }
        : {
            id: "models",
            status: "fail",
            summary: `backend does not advertise ${backend.model}`,
            detail: models.length === 0 ? "no valid model ids returned" : `advertised: ${models.slice(0, 8).join(", ")}`,
          },
    );
  }

  const limitsResponse = await requestJson(
    `${base}/v1/limits`,
    { method: "GET", headers: { accept: "application/json" } },
    options.probeTimeoutMs,
    fetchFn,
  );
  if (!limitsResponse.ok) {
    checks.push(
      backend.capabilities === undefined
        ? { id: "limits", status: "warn", summary: "backend does not publish limits", detail: limitsResponse.detail }
        : { id: "limits", status: "fail", summary: "configured capabilities could not be verified", detail: limitsResponse.detail },
    );
  } else {
    const capabilities = extractBackendCapabilities(limitsResponse.body);
    if (capabilities === null) {
      checks.push({ id: "limits", status: "fail", summary: "limits response is invalid" });
    } else {
      const configured = backend.capabilities;
      const tooSmall =
        (configured?.max_options !== undefined &&
          (capabilities.maxOptions === undefined || capabilities.maxOptions < configured.max_options)) ||
        (configured?.max_questions !== undefined &&
          (capabilities.maxQuestions === undefined || capabilities.maxQuestions < configured.max_questions));
      checks.push(
        tooSmall
          ? { id: "limits", status: "fail", summary: "published limits are below the configured capabilities" }
          : {
              id: "limits",
              status: "pass",
              summary: `limits published${capabilities.maxOptions === undefined ? "" : ` · ${capabilities.maxOptions} options`}${capabilities.maxQuestions === undefined ? "" : ` · ${capabilities.maxQuestions} questions`}`,
            },
      );
    }
  }

  const decisionResponse = await requestJson(
    `${base}/v1/systemone`,
    {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ...QUALIFICATION_REQUEST, model: backend.model }),
    },
    options.requestTimeoutMs,
    fetchFn,
  );
  if (!decisionResponse.ok) {
    checks.push({ id: "systemone", status: "fail", summary: "System One qualification request failed", detail: decisionResponse.detail });
  } else {
    const issue = responseContract(decisionResponse.body);
    checks.push(
      issue === null
        ? { id: "systemone", status: "pass", summary: "noul, choice, and score response is conformant" }
        : { id: "systemone", status: "fail", summary: issue },
    );
  }

  return {
    version: 1,
    backend: backend.name,
    base_url: base,
    model: backend.model,
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}
