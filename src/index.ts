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
  sysoneHome,
} from "./config.ts";
export type {
  LocalBackendConfig,
  RoutingPolicy,
  SettableKey,
  SysoneConfig,
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
  QUALITY_MEMORY_THRESHOLD,
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

export { SYSONE_VERSION, createFetchHandler, startGateway } from "./gateway.ts";
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

export { SCORER_LIMITS, loadScorer } from "./local/scorer.ts";
export type { OptionScorer, ScorerConfig } from "./local/scorer.ts";

export { NEEDLE_LIMITS, NeedleEngineError, runNeedleTurn } from "./local/needle.ts";
export type { NeedleCall, NeedleEngineOptions, NeedleTurn } from "./local/needle.ts";

export {
  SCORER_ADAPT_LIMITS,
  needleAnswers,
  needlePrompt,
  needleTools,
  scorerAnswer,
  scorerInput,
} from "./local/adapt.ts";

export {
  TORCH_LIMITS,
  TorchCheckpointError,
  loadTorchCheckpoint,
} from "./local/torchckpt.ts";
export type { TorchCheckpoint, TorchTensor } from "./local/torchckpt.ts";

export {
  MODEL_KINDS,
  MODEL_LIMITS,
  MODEL_REGISTRY,
  engineFilePath,
  findInstalled,
  findRegistry,
  inspectCactFile,
  inspectGgufFile,
  inspectScorerFile,
  installedModels,
  loadManifest,
  loadManifestChecked,
  manifestPath,
  modelFilePath,
  modelsDir,
  needlePlatformKey,
  pullModel,
  removeModel,
  resolvePullTarget,
  saveManifest,
  storeBytes,
  verifyModel,
} from "./local/store.ts";
export type {
  CactInspection,
  RegistryEngine,
  GgufInspection,
  InstalledModel,
  Manifest,
  ManifestLoadResult,
  ModelKind,
  PullOptions,
  PullResult,
  PullTarget,
  RegistryEntry,
  ScorerInspection,
  VerifyModelResult,
} from "./local/store.ts";
