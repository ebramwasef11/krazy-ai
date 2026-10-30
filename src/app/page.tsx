
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
const USER_ID_KEY = "krazy-ai-user-id-v1";

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
      .filter((item): item is Conversation =>
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
        messages: item.messages.filter((message: unknown): message is Message =>
          message !== null &&
          typeof message === "object" &&
          ["user", "assistant"].includes((message as Message).role) &&
          typeof (message as Message).content === "string"
        ),
      }))
      .sort((a, b) =>
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
  const [historySearch, setHistorySearch] = useState("");
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [userId, setUserId] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      let savedUserId = window.localStorage.getItem(USER_ID_KEY);

      if (!savedUserId) {
        savedUserId = globalThis.crypto?.randomUUID?.() ??
          `user-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        window.localStorage.setItem(USER_ID_KEY, savedUserId);
      }

      setUserId(savedUserId);

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
    bottomRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages, loading]);

  useEffect(() => {
    if (renamingChatId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingChatId]);

  const filteredConversations = useMemo(() => {
    const query = historySearch.trim().toLowerCase();

    if (!query) return conversations;

    return conversations.filter((chat) =>
      chat.title.toLowerCase().includes(query) ||
      chat.messages.some((message) =>
        message.content.toLowerCase().includes(query)
      )
    );
  }, [conversations, historySearch]);

  async function getAnswer(history: Message[]): Promise<string> {
    const controller = new AbortController();

    const timeout = window.setTimeout(
      () => controller.abort(),
      90000
    );

    try {
      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          userId,
          messages: history.map(({ role, content }) => ({
            role,
            content,
          })),
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `Request failed (${response.status}).`
        );
      }

      const answer =
        data.choices?.[0]?.message?.content ??
        data.response ??
        data.result?.response ??
        data.result?.choices?.[0]?.message?.content;

      if (typeof answer !== "string" || !answer.trim()) {
        throw new Error(
          "The AI returned an empty answer. Please try again."
        );
      }

      return answer.trim();
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw new Error(
          "The request took too long. Please try again."
        );
      }

      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function saveConversation(
    chatId: string,
    nextMessages: Message[]
  ) {
    setMessages(nextMessages);

    if (nextMessages.length === 0) return;

    setConversations((previous) => {
      const existing = previous.find(
        (chat) => chat.id === chatId
      );

      const conversation: Conversation = {
        id: chatId,
        title: existing?.title || getTitle(nextMessages),
        messages: nextMessages,
        updatedAt: new Date().toISOString(),
      };

      return [
        conversation,
        ...previous.filter((chat) => chat.id !== chatId),
      ];
    });
  }

  async function sendMessage() {
    const text = input.trim();

    if (!text || loading || !storageReady || !userId) return;

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
    setHistorySearch("");

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

    if (renamingChatId === chatId) {
      setRenamingChatId(null);
    }
  }

  function beginRename(chat: Conversation) {
    setRenamingChatId(chat.id);
    setRenameValue(chat.title);
  }

  function saveRename(chatId: string) {
    const title = renameValue
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);

    if (title) {
      setConversations((previous) =>
        previous.map((chat) =>
          chat.id === chatId
            ? { ...chat, title }
            : chat
        )
      );
    }

    setRenamingChatId(null);
    setRenameValue("");
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

        <div className={styles.headerActions}>
          <button
            className={styles.historyButton}
            onClick={() => setHistoryOpen((open) => !open)}
            disabled={!storageReady}
            type="button"
            aria-expanded={historyOpen}
            aria-controls="chat-history"
          >
            <span aria-hidden="true">◷</span>
            <span>History</span>
            <span className={styles.count}>
              {conversations.length}
            </span>
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
        <>
          <button
            className={styles.backdrop}
            aria-label="Close chat history"
            onClick={() => setHistoryOpen(false)}
            type="button"
          />

          <aside
            className={styles.historyPanel}
            id="chat-history"
            aria-label="Saved conversations"
          >
            <div className={styles.historyHeading}>
              <div>
                <h2>Your chats</h2>
                <p>
                  {conversations.length} saved conversation
                  {conversations.length === 1 ? "" : "s"}
                </p>
              </div>

              <button
                className={styles.iconButton}
                type="button"
                onClick={() => setHistoryOpen(false)}
                aria-label="Close history"
              >
                ×
              </button>
            </div>

            <label className={styles.searchBox}>
              <span aria-hidden="true">⌕</span>

              <input
                value={historySearch}
                onChange={(event) =>
                  setHistorySearch(event.target.value)
                }
                placeholder="Search chats and messages..."
                aria-label="Search chat history"
              />

              {historySearch && (
                <button
                  type="button"
                  onClick={() => setHistorySearch("")}
                  aria-label="Clear search"
                >
                  ×
                </button>
              )}
            </label>

            <button
              className={styles.panelNewChat}
              type="button"
              onClick={startNewChat}
            >
              <span aria-hidden="true">＋</span> Start a new chat
            </button>

            <div className={styles.chatList}>
              {filteredConversations.length === 0 ? (
                <div className={styles.emptyHistory}>
                  <span aria-hidden="true">⌕</span>

                  <strong>
                    {historySearch
                      ? "No matching chats"
                      : "No conversations yet"}
                  </strong>

                  <p>
                    {historySearch
                      ? "Try another search term."
                      : "Your saved conversations will appear here."}
                  </p>
                </div>
              ) : (
                filteredConversations.map((chat) => (
                  <div
                    className={`${styles.chatItem} ${
                      chat.id === activeChatId
                        ? styles.activeChat
                        : ""
                    }`}
                    key={chat.id}
                  >
                    {renamingChatId === chat.id ? (
                      <form
                        className={styles.renameForm}
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveRename(chat.id);
                        }}
                      >
                        <input
                          ref={renameRef}
                          value={renameValue}
                          onChange={(event) =>
                            setRenameValue(event.target.value)
                          }
                          maxLength={60}
                          aria-label="New conversation name"
                        />

                        <button
                          type="submit"
                          aria-label="Save conversation name"
                          title="Save"
                        >
                          ✓
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setRenamingChatId(null)
                          }
                          aria-label="Cancel rename"
                          title="Cancel"
                        >
                          ×
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          className={styles.chatOpen}
                          type="button"
                          onClick={() => openConversation(chat)}
                        >
                          <strong>{chat.title}</strong>

                          <span>
                            {chat.messages.length} messages ·{" "}
                            {new Date(
                              chat.updatedAt
                            ).toLocaleDateString()}
                          </span>
                        </button>

                        <div className={styles.chatTools}>
                          <button
                            className={styles.smallIconButton}
                            type="button"
                            onClick={() => beginRename(chat)}
                            aria-label={`Rename ${chat.title}`}
                            title="Rename"
                          >
                            ✎
                          </button>

                          <button
                            className={styles.smallIconButton}
                            type="button"
                            onClick={() =>
                              deleteConversation(chat.id)
                            }
                            aria-label={`Delete ${chat.title}`}
                            title="Delete"
                          >
                            ×
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

            <p className={styles.storageNote}>
              Chats are saved in this browser on this device.
            </p>
          </aside>
        </>
      )}

      <section
        className={styles.chat}
        aria-label="Chat conversation"
      >
        {messages.length === 0 ? (
          <div className={styles.welcome}>
            <div className={styles.welcomeLogo}>K</div>

            <p className={styles.eyebrow}>
              YOUR AI ASSISTANT
            </p>

            <h1>
              What can I help you <span>explore?</span>
            </h1>

            <p className={styles.subtitle}>
              Ask questions, learn something new, solve problems,
              or bring an idea to life.
            </p>

            <div className={styles.suggestions}>
              {[
                {
                  title: "Learn something new",
                  prompt:
                    "Teach me something interesting and explain why it matters.",
                },
                {
                  title: "Build a project",
                  prompt:
                    "Help me plan and build a website step by step.",
                },
                {
                  title: "Solve a problem",
                  prompt:
                    "Help me solve a problem and explain each step clearly.",
                },
              ].map((item) => (
                <button
                  key={item.title}
                  type="button"
                  className={styles.suggestion}
                  onClick={() => setInput(item.prompt)}
                >
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.prompt}</small>
                  </span>

                  <span
                    className={styles.suggestionArrow}
                    aria-hidden="true"
                  >
                    ↗
                  </span>
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
                    {message.role === "user"
                      ? "You"
                      : "Krazy AI"}
                  </div>

                  <div
                    className={`${styles.messageText} ${
                      message.isError
                        ? styles.errorText
                        : ""
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
                            void copyMessage(
                              message.content,
                              index
                            )
                          }
                          title="Copy response"
                        >
                          {copiedIndex === index
                            ? "✓ Copied"
                            : "Copy"}
                        </button>
                      )}

                      {message.isError && (
                        <button
                          type="button"
                          onClick={() =>
                            void retryMessage(index)
                          }
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
                  <div className={styles.messageLabel}>
                    Krazy AI
                  </div>

                  <div className={styles.thinkingText}>
                    <span />
                    <span />
                    <span />
                    <span className={styles.thinkingLabel}>
                      Thinking
                    </span>
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
            onChange={(event) =>
              setInput(event.target.value)
            }
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey
              ) {
                event.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Message Krazy AI..."
            aria-label="Message Krazy AI"
            rows={1}
            maxLength={2000}
            disabled={loading || !storageReady}
          />

          <button
            className={styles.sendButton}
            type="submit"
            disabled={
              loading ||
              !input.trim() ||
              !storageReady ||
              !userId
            }
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
