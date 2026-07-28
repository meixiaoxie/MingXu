export interface ModelCapabilities {
  supportsTools: boolean;
  supportsStreaming: boolean;
  supportsImages: boolean;
  supportsStructuredOutput: boolean;
  supportsRefusal: boolean;
  supportsFallback: boolean;
  supportsEffort: boolean;
  supportsPromptCaching: boolean;
  supportsMidConversationSystem: boolean;
  maxContext: number;
  maxOutput: number;
}

export const defaultModelCapabilities: ModelCapabilities = {
  supportsTools: true,
  supportsStreaming: true,
  supportsImages: false,
  supportsStructuredOutput: false,
  supportsRefusal: false,
  supportsFallback: false,
  supportsEffort: false,
  supportsPromptCaching: false,
  supportsMidConversationSystem: false,
  maxContext: 128000,
  maxOutput: 8192,
};
