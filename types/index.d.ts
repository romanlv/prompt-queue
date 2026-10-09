declare module 'claude-code' {
  interface PluginState {
    'prompt-queue': {
      isDraft: boolean
      queue: string[]
      isBusy: boolean
      isPaused: boolean
      held: string[] | null
    }
  }
}
