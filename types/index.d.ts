declare module 'claude-code' {
  interface PluginState {
    'msg-queue': {
      isQqDraft: boolean
      queue: string[]
      isBusy: boolean
      isPaused: boolean
    }
  }
}
