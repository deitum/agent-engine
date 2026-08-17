/** Role of a chat message, matching the OpenAI chat-completions schema. */
export enum ChatRole {
  System = 'system',
  User = 'user',
  Assistant = 'assistant',
  /** Carries the result of a tool call back to the model. */
  Tool = 'tool',
}
