import { z } from "zod";
import { choiceAnswerSchema, noulAnswerSchema, scoreAnswerSchema, systemOneRequestSchema, systemOneResponseSchema, type SystemOneRequest, type SystemOneResponse } from "./protocol.ts";
import { validateResponseForRequest } from "./response.ts";
import { IMAGE_LIMITS as CLEF_IMAGE_LIMITS } from "./images.ts";

export const CLEF_MODELS = ["clef", "clef-flash"] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];
export { IMAGE_LIMITS as CLEF_IMAGE_LIMITS, imageSchema as clefImageSchema, imageDecodedBytes } from "./images.ts";
export type { ImageInput as ClefImage } from "./images.ts";

export function cloudflareCredentials(env: Record<string, string | undefined>): { accountId: string; token: string } | null {
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"];
  const token = env["CLOUDFLARE_API_TOKEN"] || env["CLOUDFLARE_AUTH_TOKEN"];
  if (accountId === undefined || !/^[a-fA-F0-9]{32}$/.test(accountId) || token === undefined || !/^[\x21-\x7e]{1,8192}$/.test(token)) return null;
  return { accountId, token };
}

export const clefRequestSchema = systemOneRequestSchema.extend({
  model: z.enum(CLEF_MODELS),
}).superRefine((request, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > CLEF_IMAGE_LIMITS.maxBodyBytes) {
    ctx.addIssue({ code: "custom", message: "Clef request exceeds 13 MiB" });
  }
  for (const [id, question] of Object.entries(request.questions)) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(id)) {
      ctx.addIssue({ code: "custom", message: "invalid Clef question ID", path: ["questions", id] });
    }
    if (question.instructions === undefined || question.instructions === null || (typeof question.instructions === "string" ? question.instructions.trim().length === 0 : Object.keys(question.instructions).length === 0)) {
      ctx.addIssue({ code: "custom", message: "Clef questions require instructions", path: ["questions", id] });
    }
    if (question.type === "choice" && Object.keys(question.criteria).length < 2) {
      ctx.addIssue({ code: "custom", message: "Clef choice requires at least two options", path: ["questions", id] });
    }
  }
});
export type ClefRequest = z.infer<typeof clefRequestSchema>;

export function clefEndpoint(accountId: string, model: ClefModel): string {
  if (!/^[a-fA-F0-9]{32}$/.test(accountId) || !CLEF_MODELS.includes(model)) {
    throw new Error("Invalid Cloudflare Clef account or model");
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;
}

const envelopeSchema = z.object({
  success: z.literal(true),
  result: z.unknown(),
  errors: z.array(z.unknown()).max(0).optional(),
  messages: z.array(z.unknown()).max(512).optional(),
}).strict();
const clefResponseSchema = systemOneResponseSchema.strict().extend({
  model: z.enum(CLEF_MODELS),
  answers: z.record(z.string(), z.union([
    noulAnswerSchema.strict(), choiceAnswerSchema.strict(), scoreAnswerSchema.strict(),
  ])),
  usage: systemOneResponseSchema.shape.usage.strict(),
});

export function unwrapClefResponse(request: SystemOneRequest, value: unknown): SystemOneResponse {
  try {
    const wrapped = typeof value === "object" && value !== null && "success" in value;
    const result = wrapped ? envelopeSchema.parse(value).result : value;
    const response = validateResponseForRequest(request, clefResponseSchema.parse(result));
    if (response.model !== (request.model ?? "clef")) throw new Error();
    return response;
  } catch {
    throw new Error("Invalid Cloudflare Clef response");
  }
}
