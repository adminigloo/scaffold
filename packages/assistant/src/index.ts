export {
  ASSISTANT_PROTOCOL_VERSION,
  encodeSse,
  type AssistantStreamEvent,
  type LoopUsage,
} from "./events.js";
export { replayMessages } from "./provider.js";
export type {
  ContentBlock,
  NeutralMessage,
  ProviderAdapter,
  ProviderErrorClass,
  ProviderEvent,
  ProviderRequest,
  StepUsage,
} from "./provider.js";
export {
  runAssistantLoop,
  type LoopResult,
  type ProposedWrite,
  type RunLoopOptions,
  type ToolRun,
} from "./loop.js";

export { estimateTokens, withinBudget } from "./tokens.js";

export {
  createGlossaryTerm,
  createGlossaryTermSchema,
  createSection,
  createSectionSchema,
  createTenantRule,
  createTenantRuleSchema,
  deactivateGlossaryTerm,
  deactivateSection,
  deactivateTenantRule,
  listSectionVersions,
  listSections,
  listSectionsForEditor,
  publishSection,
  publishSectionSchema,
  rollbackSection,
  sectionKeySchema,
  SectionBudgetError,
  type AssistantDb,
  type CreateSectionInput,
  type DeactivateResult,
  type EditorSectionRow,
  type PublishResult,
  type SectionRow,
  type VersionRow,
} from "./brain.js";

export { assemblePrompt, type AssembledPrompt, type PromptMeta } from "./assemble.js";

export { DEFAULT_SECTIONS, seedDefaultSections } from "./seed.js";

export {
  createConversation,
  appendMessage,
  listConversations,
  getConversation,
  upsertPageDoc,
  getPageDoc,
  listPageDocs,
  retrievePageDocs,
  reindexPageDoc,
  rrfFuse,
  type Embedder,
  createPendingAction,
  getPendingAction,
  confirmPendingAction,
  declinePendingAction,
  sweepConversations,
  sweepExpiredPendingActions,
  deleteUserData,
  nextSeq,
  isActionExpired,
  type AppendMessageInput,
  type ConfirmResult,
  type ConversationDetail,
  type ConversationRow,
  type MessageRow,
  type PageDocRow,
  type PendingActionRow,
  type RetrievedDoc,
} from "./engine.js";
export {
  assistantConversations,
  assistantMessages,
  assistantPageDocs,
  assistantPageDocVersions,
  assistantPendingActions,
  assistantGoldens,
  assistantEvalRuns,
  assistantEvalResults,
} from "./schema.js";

export {
  scoreAnswer,
  createGolden,
  listGoldens,
  deactivateGolden,
  recordEvalRun,
  listEvalRuns,
  getEvalRunResults,
  type AnswerScore,
  type EvalResultInput,
  type EvalRunRow,
  type EvalResultRow,
  type GoldenRow,
} from "./evals.js";

export {
  createToolRegistry,
  type AssistantTool,
  type ProviderToolSpec,
  type ToolContext,
  type ToolRegistry,
} from "./registry.js";
export {
  createAssistantChatHandler,
  createAssistantConfirmHandler,
  type AssistantChatDeps,
  type AssistantConfirmDeps,
  type BudgetVerdict,
  type ChatPrincipal,
} from "./handler.js";
export {
  budgetHistory,
  estimateTurnTokens,
  type HistoryBudget,
} from "./history.js";
