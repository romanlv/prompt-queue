declare module 'claude-code' {
  interface PluginState {
    'msg-queue': {
      isDraft: boolean
      queue: string[]
      isBusy: boolean
      isPaused: boolean
      held: string[] | null
    }
  }
}
