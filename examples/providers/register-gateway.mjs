export function register(registry) {
  registry.register({
    provider: "gateway",
    capabilities: {
      supportsTools: true,
      supportsStreaming: false,
      supportsImages: false,
      supportsStructuredOutput: true,
      supportsRefusal: true,
      supportsFallback: false,
      supportsEffort: false,
      supportsPromptCaching: false,
      supportsMidConversationSystem: false,
      maxContext: 128000,
      maxOutput: 8192
    },
    create(config) {
      return {
        provider: "gateway",
        capabilities: this.capabilities,
        async generate(request) {
          return {
            text: `custom:${config.model}:${request.modelId}`,
            toolCalls: []
          }
        }
      }
    }
  })
}
