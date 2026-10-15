/**
 * Long conversations for the model picker. VS Code re-sends the whole
 * transcript on every request and gives no chat id, so a chat is recognised by
 * the start of its transcript: if the new request begins with what the previous
 * one ended on, it continues the BizChat conversation (same `ConversationId`,
 * `isStartOfSession` off) and only the new messages need to go out.
 * Anything that does not line up — an edited message, a retry, another chat
 * with the same opening — starts a conversation of its own, as before.
 */
import { createHash } from "node:crypto";
import type * as vscode from "vscode";
import { createCopilotConversation, type CopilotConversation } from "./client";

const MAX_SESSIONS = 20;
const SESSION_TTL_MS = 30 * 60_000;

interface ChatSession {
  conversation: CopilotConversation;
  /** Number of messages the service has seen, counting its own reply. */
  seen: number;
  /** Fingerprint of the last message of the previous request. */
  tail: string;
  /** Tools the service was told about. */
  toolsKey: string;
  usedAt: number;
}

export interface ChatSessionPlan {
  conversation: CopilotConversation;
  /** First message index to send; 0 for a conversation that starts here. */
  from: number;
  continued: boolean;
  /** The tool instructions must be (re)sent: first turn or changed tool set. */
  instructions: boolean;
  /** Call once the turn went through. */
  commit(): void;
  /** Call when the turn failed: the service's state is no longer known. */
  discard(): void;
}

function fingerprint(message: vscode.LanguageModelChatRequestMessage): string {
  const parts = message.content.map((part) => {
    const value = part as Record<string, unknown>;
    return JSON.stringify([value.constructor?.name, value.value ?? value.callId ?? value.name ?? ""]);
  });
  return `${message.role}:${parts.join("|")}`;
}

export class ChatSessions {
  private readonly sessions = new Map<string, ChatSession>();

  plan(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    toolsKey: string,
  ): ChatSessionPlan {
    const head = messages.slice(0, 2).map(fingerprint).join("\n");
    const key = createHash("sha1").update(`${modelId}\n${head}`).digest("hex");
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.usedAt > SESSION_TTL_MS) this.sessions.delete(id);
    }

    const previous = this.sessions.get(key);
    // The new request must extend the old one: its own reply plus at least one new message.
    const continued =
      previous !== undefined &&
      messages.length > previous.seen &&
      fingerprint(messages[previous.seen - 2] ?? messages[0]!) === previous.tail;

    const conversation = continued ? previous.conversation : createCopilotConversation();
    const plan: ChatSessionPlan = {
      conversation,
      from: continued ? previous.seen - 1 : 0,
      continued,
      instructions: !continued || previous.toolsKey !== toolsKey,
      commit: () => {
        conversation.isStartOfSession = false;
        const last = messages[messages.length - 1];
        this.sessions.delete(key);
        this.sessions.set(key, {
          conversation,
          seen: messages.length + 1,
          tail: last ? fingerprint(last) : "",
          toolsKey,
          usedAt: Date.now(),
        });
        while (this.sessions.size > MAX_SESSIONS) {
          const oldest = this.sessions.keys().next().value;
          if (oldest === undefined) break;
          this.sessions.delete(oldest);
        }
      },
      discard: () => {
        this.sessions.delete(key);
      },
    };
    return plan;
  }
}
