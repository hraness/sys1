export {
  PROTOCOL_LIMITS,
  answerSchema,
  choiceAnswerSchema,
  choiceQuestionSchema,
  entrySchema,
  errorBody,
  noulAnswerSchema,
  noulQuestionSchema,
  questionSchema,
  scoreAnswerSchema,
  scoreQuestionSchema,
  serializedBytes,
  systemOneRequestSchema,
  systemOneResponseSchema,
} from "./protocol.ts";
export type {
  Answer,
  ChoiceAnswer,
  ChoiceQuestion,
  EntryType,
  GatewayError,
  JsonValue,
  NoulAnswer,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResponse,
} from "./protocol.ts";

export {
  DEFAULT_CONFIG,
  ROUTING_POLICIES,
  SETTABLE_KEYS,
  configSchema,
  isLoopbackHost,
  loadConfig,
  localBackendSchema,
  loopbackHostSchema,
  routingPolicySchema,
  saveConfig,
  setConfigValue,
  sys1Home,
} from "./config.ts";
export type {
  LocalBackendConfig,
  RoutingPolicy,
  SettableKey,
  Sys1Config,
} from "./config.ts";

export { chooseBackend, requestNeeds } from "./router.ts";
export type {
  BackendCandidate,
  BackendCapabilities,
  BackendKind,
  RequestNeeds,
  RouteChoice,
} from "./router.ts";

export {
  HOSTED_BACKEND_NAME,
  extractBackendCapabilities,
  extractModelIds,
  forwardToBackend,
  probeAll,
  probeBackend,
  runtimeBackends,
} from "./backends.ts";
export type { ForwardResult, ProbeResult, RuntimeBackend } from "./backends.ts";

export {
  DEFAULT_LOCAL_MODELS,
  LOCAL_MODEL_TIERS,
  platformRecommendation,
} from "./defaults.ts";
export type { LocalModelTier, PlatformRecommendation } from "./defaults.ts";

export { qualifyBackend } from "./qualification.ts";
export type {
  BackendQualificationCheck,
  BackendQualificationOptions,
  BackendQualificationReport,
  BackendQualificationStatus,
} from "./qualification.ts";

export { SYS1_VERSION, createFetchHandler, startGateway } from "./gateway.ts";
export type { GatewayDeps, RunningGateway } from "./gateway.ts";

export { runDoctor } from "./doctor.ts";
export type {
  DoctorCheck,
  DoctorOptions,
  DoctorReport,
  DoctorStatus,
} from "./doctor.ts";

export {
  clearPidFile,
  daemonDown,
  daemonStatus,
  daemonUp,
  healthz,
  processAlive,
  readPidFile,
  writePidFile,
} from "./daemon.ts";
export type { DaemonState, DownResult, PidFile, UpResult } from "./daemon.ts";

export {
  DECIDE_LIMITS,
  DECISION_LABELS,
  aggregateMass,
  answerLabels,
  confidenceOf,
  decisionPrompt,
  outcomeFromMass,
  toLocalAnswer,
  toLocalResponse,
} from "./local/decide.ts";
export type {
  LabelMass,
  LocalAnswer,
  LocalResponse,
  QuestionOutcome,
} from "./local/decide.ts";

export {
  EngineUnavailableError,
  LlamaEngine,
  probeNativeRuntime,
} from "./local/engine.ts";
export type {
  DecisionEngine,
  FirstTokenDistribution,
  LlamaEngineOptions,
  NativeRuntimeProbe,
} from "./local/engine.ts";

export {
  BUILTIN_PREFIX,
  LocalRunner,
  builtinCandidates,
  builtinName,
  defaultEngineFactory,
} from "./local/runner.ts";
export type {
  BuiltinCandidate,
  DecideResult,
  EngineFactory,
  LocalAdapter,
  LocalQuestionDiagnostic,
  RunnerOptions,
} from "./local/runner.ts";

export {
  MODEL_KINDS,
  MODEL_LIMITS,
  MODEL_REGISTRY,
  ModelStoreError,
  findInstalled,
  findRegistry,
  inspectGgufFile,
  installedModels,
  loadManifest,
  loadManifestChecked,
  manifestPath,
  modelFilePath,
  modelsDir,
  pullModel,
  removeModel,
  resolvePullTarget,
  saveManifest,
  storeBytes,
  verifyModel,
} from "./local/store.ts";
export type {
  GgufInspection,
  InstalledModel,
  Manifest,
  ManifestLoadResult,
  ModelKind,
  PullOptions,
  PullResult,
  PullTarget,
  RegistryEntry,
  VerifyModelResult,
} from "./local/store.ts";

export { createClient, DEFAULT_BASE_URL, Sys1ClientError } from "./client.ts";
export type {
  ClientErrorCode, ClientOptions, EvaluationOptions, EvaluationResult,
  RouteMetadata, Sys1Client,
} from "./client.ts";
export { createRouter } from "./runtime.ts";
export type { RouterOptions, EmbeddedRouter } from "./runtime.ts";
export { createProfile, Sys1ProfileError } from "./profile.ts";
export type {
  DecisionProfile, ProfileDefinition, ReadonlyProfileDefinition, ProfileErrorCode,
} from "./profile.ts";
