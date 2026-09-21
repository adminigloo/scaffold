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
  createPendingAction,
  getPendingAction,
  confirmPendingAction,
  declinePendingAction,
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
} from "./schema.js";

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
