
"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Message = {
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
};

const WORKER_URL = "https://krazy.ebramw2013.workers.dev";
const STORAGE_KEY = "krazy-ai-conversations-v1";

function createChatId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getTitle(messages: Message[]): string {
  const firstMessage = messages.find((message) => message.role === "user");
  if (!firstMessage) return "New chat";

  const text = firstMessage.content.replace(/\s+/g, " ").trim();
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

function readConversations(value: string | null): Conversation[] {
  if (!value) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is Conversation =>
          item !== null &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          typeof item.updatedAt === "string" &&
          Array.isArray(item.messages)
      )
      .map((item) => ({
        id: item.id,
        title: item.title,
        updatedAt: item.updatedAt,
        messages: item.messages.filter(
          (message: unknown): message is Message =>
            message !== null &&
            typeof message === "object" &&
            ["user", "assistant"].includes(
              (message as Message).role
            ) &&
            typeof (message as Message).content === "string"
        ),
      }))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() -
          new Date(a.updatedAt).getTime()
      );
  } catch {
    return [];
  }
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [storageReady, setStorageReady] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      const saved = readConversations(
        window.localStorage.getItem(STORAGE_KEY)
      );

      setConversations(saved);

      if (saved.length > 0) {
        setActiveChatId(saved[0].id);
        setMessages(saved[0].messages);
      }
    } catch (error) {
      console.error("Could not load saved Krazy AI chats:", error);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;

    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(conversations)
      );
    } catch (error) {
      console.error("Could not save Krazy AI chats:", error);
    }
  }, [conversations, storageReady]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function getAnswer(history: Message[]): Promise<string> {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: history.map(({ role, content }) => ({
          role,
          content,
        })),
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error || `Request failed (${response.status}).`
      );
    }

    const answer =
      data.choices?.[0]?.message?.content ??
      data.response ??
      data.result?.response ??
      data.result?.choices?.[0]?.message?.content;

    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("The AI returned an empty answer. Please try again.");
    }

    return answer.trim();
  }

  function saveConversation(chatId: string, nextMessages: Message[]) {
    setMessages(nextMessages);

    if (nextMessages.length === 0) return;

    const conversation: Conversation = {
      id: chatId,
      title: getTitle(nextMessages),
      messages: nextMessages,
      updatedAt: new Date().toISOString(),
    };

    setConversations((previous) => [
      conversation,
      ...previous.filter((chat) => chat.id !== chatId),
    ]);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading || !storageReady) return;

    const chatId = activeChatId ?? createChatId();
    const history: Message[] = [
      ...messages,
      { role: "user", content: text },
    ];

    setActiveChatId(chatId);
    setInput("");
    setLoading(true);
    setHistoryOpen(false);
    saveConversation(chatId, history);

    try {
      const answer = await getAnswer(history);

      saveConversation(chatId, [
        ...history,
        { role: "assistant", content: answer },
      ]);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.";

      saveConversation(chatId, [
        ...history,
        {
          role: "assistant",
          content: `I couldn't complete that request. ${reason}`,
          isError: true,
        },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  async function retryMessage(index: number) {
    if (loading || !activeChatId) return;

    const history = messages.slice(0, index);
    if (history.at(-1)?.role !== "user") return;

    setLoading(true);
    saveConversation(activeChatId, history);

    try {
      const answer = await getAnswer(history);

      saveConversation(activeChatId, [
        ...history,
        { role: "assistant", content: answer },
      ]);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.";

      saveConversation(activeChatId, [
        ...history,
        {
          role: "assistant",
          content: `I couldn't complete that request. ${reason}`,
          isError: true,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  async function copyMessage(content: string, index: number) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 1500);
    } catch {
      // Clipboard access may be blocked by browser permissions.
    }
  }

  function startNewChat() {
    if (loading) return;

    setActiveChatId(null);
    setMessages([]);
    setInput("");
    setHistoryOpen(false);
    inputRef.current?.focus();
  }

  function openConversation(chat: Conversation) {
    if (loading) return;

    setActiveChatId(chat.id);
    setMessages(chat.messages);
    setInput("");
    setHistoryOpen(false);
    inputRef.current?.focus();
  }

  function deleteConversation(chatId: string) {
    if (loading) return;

    const remaining = conversations.filter(
      (chat) => chat.id !== chatId
    );

    setConversations(remaining);

    if (activeChatId === chatId) {
      setActiveChatId(null);
      setMessages([]);
    }
  }

  return (
    <main className={styles.app}>
      <header className={styles.header}>
        <a
          className={styles.brand}
          href="/"
          aria-label="Krazy AI home"
          onClick={(event) => {
            event.preventDefault();
            startNewChat();
          }}
        >
          <span className={styles.logo}>K</span>
          <span>
            Krazy <span className={styles.brandAccent}>AI</span>
          </span>
        </a>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            className={styles.newChat}
            onClick={() => setHistoryOpen((open) => !open)}
            disabled={loading || !storageReady}
            type="button"
          >
            History ({conversations.length})
          </button>

          <button
            className={styles.newChat}
            onClick={startNewChat}
            disabled={loading}
            type="button"
          >
            <span aria-hidden="true">＋</span> New chat
          </button>
        </div>
      </header>

      {historyOpen && (
        <aside
          aria-label="Saved conversations"
          style={{
            position: "fixed",
            zIndex: 20,
            top: 76,
            right: 16,
            width: "min(360px, calc(100vw - 32px))",
            maxHeight: "65vh",
            overflowY: "auto",
            padding: 16,
            border: "1px solid var(--border, #333)",
            borderRadius: 14,
            background: "var(--background, #151515)",
            color: "var(--foreground, #fff)",
            boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <strong>Saved chats</strong>
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              aria-label="Close chat history"
            >
              ✕
            </button>
          </div>

          {conversations.length === 0 ? (
            <p style={{ opacity: 0.7, fontSize: 14 }}>
              Your conversations will appear here when you start chatting.
            </p>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {conversations.map((chat) => (
                <div
                  key={chat.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "stretch",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => openConversation(chat)}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      padding: 10,
                      textAlign: "left",
                      borderRadius: 8,
                      border: "1px solid #555",
                      background:
                        chat.id === activeChatId
                          ? "rgba(128,128,128,0.2)"
                          : "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 14,
                      }}
                    >
                      {chat.title}
                    </span>
                    <span style={{ opacity: 0.65, fontSize: 12 }}>
                      {chat.messages.length} messages ·{" "}
                      {new Date(chat.updatedAt).toLocaleDateString()}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => deleteConversation(chat.id)}
                    disabled={loading}
                    aria-label={`Delete ${chat.title}`}
                    title="Delete conversation"
                    style={{
                      padding: "0 10px",
                      borderRadius: 8,
                      border: "1px solid #555",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <p style={{ fontSize: 12, opacity: 0.6, marginTop: 14 }}>
            Saved in this browser on this device.
          </p>
        </aside>
      )}

      <section className={styles.chat} aria-label="Chat conversation">
        {messages.length === 0 ? (
          <div className={styles.welcome}>
            <div className={styles.welcomeLogo}>K</div>
            <p className={styles.eyebrow}>YOUR AI ASSISTANT</p>
            <h1>
              What can I help you <span>explore?</span>
            </h1>
            <p className={styles.subtitle}>
              Ask questions, learn something new, solve problems, or bring an
              idea to life.
            </p>

            <div className={styles.suggestions}>
              {[
                "Explain how AI works",
                "Help me build a website",
                "Teach me something interesting",
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className={styles.suggestion}
                  onClick={() => setInput(suggestion)}
                >
                  <span>{suggestion}</span>
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.messages}>
            {messages.map((message, index) => (
              <article
                key={`${index}-${message.role}`}
                className={`${styles.message} ${
                  message.role === "user"
                    ? styles.userMessage
                    : styles.assistantMessage
                }`}
              >
                {message.role === "assistant" && (
                  <div className={styles.avatar}>K</div>
                )}

                <div className={styles.messageBody}>
                  <div className={styles.messageLabel}>
                    {message.role === "user" ? "You" : "Krazy AI"}
                  </div>

                  <div
                    className={`${styles.messageText} ${
                      message.isError ? styles.errorText : ""
                    }`}
                  >
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {message.content}
                    </ReactMarkdown>
                  </div>

                  {message.role === "assistant" && (
                    <div className={styles.messageActions}>
                      {!message.isError && (
                        <button
                          type="button"
                          onClick={() =>
                            void copyMessage(message.content, index)
                          }
                          title="Copy response"
                        >
                          {copiedIndex === index ? "✓ Copied" : "Copy"}
                        </button>
                      )}

                      {message.isError && (
                        <button
                          type="button"
                          onClick={() => void retryMessage(index)}
                          disabled={loading}
                        >
                          ↻ Try again
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </article>
            ))}

            {loading && (
              <div className={styles.thinking}>
                <div className={styles.avatar}>K</div>
                <div>
                  <div className={styles.messageLabel}>Krazy AI</div>
                  <div className={styles.thinkingText}>
                    <span />
                    <span />
                    <span />
                    <span className={styles.thinkingLabel}>Thinking</span>
                  </div>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </section>

      <footer className={styles.composerArea}>
        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Message Krazy AI..."
            aria-label="Message Krazy AI"
            rows={1}
            maxLength={2000}
            disabled={loading}
          />

          <button
            className={styles.sendButton}
            type="submit"
            disabled={loading || !input.trim() || !storageReady}
            aria-label="Send message"
            title="Send message"
          >
            ↑
          </button>
        </form>

        <p className={styles.disclaimer}>
          Krazy AI can make mistakes. Check important information.
        </p>
      </footer>
    </main>
  );
}
