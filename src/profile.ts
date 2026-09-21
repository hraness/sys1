import { z } from "zod";
import {
  PROTOCOL_LIMITS,
  choiceQuestionSchema,
  noulQuestionSchema,
  scoreQuestionSchema,
  serializedBytes,
  systemOneRequestSchema,
  type SystemOneRequest,
} from "./protocol.ts";

const identifier = z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine((value) => value === value.trim());
const profileQuestionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema.extend({
    criteria: noulQuestionSchema.shape.criteria.unwrap().unwrap().strict().nullable().optional(),
  }).strict(),
  choiceQuestionSchema.strict(),
  scoreQuestionSchema.strict(),
]);
const profileDefinitionSchema = z.object({
  version: z.literal(1),
  id: identifier,
  revision: identifier,
  // This is an exact Sys1 route, not a claim about the endpoint's weights.
  model: systemOneRequestSchema.shape.model.unwrap().regex(/^[a-z0-9][a-z0-9.-]*\/\S+$/)
    .refine((value) => value === value.trim()),
  questions: z.record(
    z.string().min(1).max(PROTOCOL_LIMITS.maxQuestionNameChars),
    profileQuestionSchema,
  ).refine((questions) => {
    const count = Object.keys(questions).length;
    return count >= 1 && count <= PROTOCOL_LIMITS.maxQuestions;
  }),
}).strict();

export type ProfileDefinition = z.infer<typeof profileDefinitionSchema>;
// Explicit recursive types keep ordinary property access finite for TypeScript.
// A recursive mapped DeepReadonly<JsonValue> can exceed its instantiation limit.
export type ReadonlyJsonValue =
  | string | number | boolean | null
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };
export type ReadonlyEntryType =
  | string | null
  | readonly ReadonlyJsonValue[]
  | { readonly [key: string]: ReadonlyJsonValue };

export type ReadonlyProfileQuestion =
  | {
      readonly type: "noul";
      readonly instructions?: ReadonlyEntryType | undefined;
      readonly criteria?: {
        readonly true?: ReadonlyEntryType | undefined;
        readonly false?: ReadonlyEntryType | undefined;
      } | null | undefined;
    }
  | {
      readonly type: "choice";
      readonly instructions?: ReadonlyEntryType | undefined;
      readonly criteria: { readonly [key: string]: ReadonlyEntryType };
    }
  | {
      readonly type: "score";
      readonly instructions?: ReadonlyEntryType | undefined;
      readonly criteria: readonly ReadonlyEntryType[];
    };

export interface ReadonlyProfileDefinition {
  readonly version: 1;
  readonly id: string;
  readonly revision: string;
  readonly model: string;
  readonly questions: { readonly [key: string]: ReadonlyProfileQuestion };
}

export interface DecisionProfile {
  /** Frozen local identity and decision recipe. Never sent on the wire. */
  readonly definition: ReadonlyProfileDefinition;
  /** Compose a fresh ordinary request; no interpolation, overrides, or I/O. */
  request(state: unknown): SystemOneRequest;
}

export type ProfileErrorCode = "invalid_profile" | "invalid_request";

/** Contains no supplied identifiers, instructions, states, or validation details. */
export class Sys1ProfileError extends Error {
  readonly code: ProfileErrorCode;

  constructor(code: ProfileErrorCode) {
    super(code === "invalid_profile" ? "Invalid Sys1 profile" : "Invalid Sys1 profile request");
    this.name = "Sys1ProfileError";
    this.code = code;
  }
}

/**
 * Copy plain JSON without invoking getters/toJSON or silently dropping values.
 * Account for encoded bytes while copying, before constructing a full string.
 */
function snapshotJson(input: unknown, maxBytes: number): unknown {
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  let bytes = 0;
  const account = (count: number): void => {
    bytes += count;
    if (bytes > maxBytes) throw new Error();
  };
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error();
      // An unescaped string cannot fit if its character count already exceeds the byte budget.
      if (typeof value === "string" && value.length > maxBytes - bytes) throw new Error();
      account(encoder.encode(JSON.stringify(value)).byteLength);
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) throw new Error();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) throw new Error();
    ancestors.add(value);
    account(2);
    let result: unknown;
    if (array) {
      if (keys.length !== value.length + 1) throw new Error();
      const items: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
        if (index > 0) account(1);
        items.push(copy(descriptor.value as unknown));
      }
      result = items;
    } else {
      const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index] as string;
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
        if (index > 0) account(1);
        account(encoder.encode(JSON.stringify(key)).byteLength + 1);
        object[key] = copy(descriptor.value as unknown);
      }
      result = object;
    }
    ancestors.delete(value);
    return result;
  };
  return copy(input);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * A named, revisioned decision recipe for a gateway or embedded router.
 * The exact backend/model pin keeps the router from silently switching routes;
 * operators remain responsible for verifying the model served at that endpoint.
 */
export function createProfile(input: unknown): DecisionProfile {
  let definition: ReadonlyProfileDefinition;
  try {
    definition = freezeDeep(profileDefinitionSchema.parse(snapshotJson(input, PROTOCOL_LIMITS.maxBodyBytes)));
  } catch {
    throw new Sys1ProfileError("invalid_profile");
  }
  return Object.freeze({
    definition,
    request(state: unknown): SystemOneRequest {
      try {
        const request = systemOneRequestSchema.parse(snapshotJson({
          model: definition.model,
          state,
          questions: definition.questions,
        }, PROTOCOL_LIMITS.maxBodyBytes));
        // Match the gateway's serialized-state bound, including JSON escaping.
        if (serializedBytes(request.state) > PROTOCOL_LIMITS.maxStateBytes) throw new Error();
        return request;
      } catch {
        throw new Sys1ProfileError("invalid_request");
      }
    },
  });
}
