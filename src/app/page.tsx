
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

type WorkerResponse = {
  error?: unknown;
  response?: unknown;
  result?: {
    response?: unknown;
    choices?: Array<{
      message?: { content?: unknown };
      text?: unknown;
    }>;
  };
  choices?: Array<{
    message?: { content?: unknown };
    text?: unknown;
  }>;
  output_text?: unknown;
};

const WORKER_URL = "https://krazy.ebramw2013.workers.dev";
const STORAGE_KEY = "krazy-ai-conversations-v1";
const USER_ID_KEY = "krazy-ai-user-id-v1";

const REQUEST_TIMEOUT = 90000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 20;

function createId(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createChatId(): string {
  return createId("chat");
}

function createUserId(): string {
  return createId("user");
}

function getTitle(messages: Message[]): string {
  const firstMessage = messages.find(
    (message) => message.role === "user"
  );

  if (!firstMessage) return "New chat";

  const text = firstMessage.content.replace(/\s+/g, " ").trim();

  return text.length > 42
    ? `${text.slice(0, 42)}…`
    : text;
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

function extractAnswer(data: WorkerResponse): string | null {
  const candidates = [
    data.choices?.[0]?.message?.content,
    data.choices?.[0]?.text,
    data.response,
    data.result?.response,
    data.result?.choices?.[0]?.message?.content,
    data.result?.choices?.[0]?.text,
    data.output_text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }

    if (Array.isArray(candidate)) {
      const combined = candidate
        .map((part) => {
          if (typeof part === "string") return part;

          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof part.text === "string"
          ) {
            return part.text;
          }

          return "";
        })
        .join("");

      if (combined.trim()) return combined.trim();
    }
  }

  return null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  return "An unexpected error occurred. Please try again.";
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

  const requestInProgress = useRef(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Load saved chats and the browser's existing memory ID.
  useEffect(() => {
    try {
      let savedUserId = window.localStorage.getItem(USER_ID_KEY);

      if (!savedUserId) {
        savedUserId = createUserId();
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

  // Save conversations whenever they change.
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

  // Keep the latest message visible.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages, loading]);

  // Focus the rename field when editing a chat title.
  useEffect(() => {
    if (renamingChatId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingChatId]);

  const filteredConversations = useMemo(() => {
    const query = historySearch.trim().toLowerCase();

    if (!query) return conversations;

    return conversations.filter(
      (chat) =>
        chat.title.toLowerCase().includes(query) ||
        chat.messages.some((message) =>
          message.content.toLowerCase().includes(query)
        )
    );
  }, [conversations, historySearch]);

  // Send the conversation to the existing Cloudflare Worker.
  async function getAnswer(history: Message[]): Promise<string> {
    const controller = new AbortController();

    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT
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
          messages: history
            .slice(-MAX_HISTORY_MESSAGES)
            .map(({ role, content }) => ({
              role,
              content,
            })),
        }),
      });

      const data = await response.json().catch(
        () => ({}) as WorkerResponse
      );

      if (!response.ok) {
        const serverError =
          typeof data.error === "string"
            ? data.error
            : `The server returned error ${response.status}.`;

        throw new Error(serverError);
      }

      const answer = extractAnswer(data);

      if (!answer) {
        throw new Error(
          "Krazy AI received an empty response. Please try again."
        );
      }

      return answer;
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw new Error(
          "The request took too long. Please try again."
        );
      }

      if (
        error instanceof TypeError &&
        error.message.toLowerCase().includes("fetch")
      ) {
        throw new Error(
          "Could not connect to Krazy AI. Check your internet connection and try again."
        );
      }

      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  // Update the active chat and save it in history.
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

  // Send a new user message.
  async function sendMessage() {
    const text = input.trim();

    if (
      !text ||
      requestInProgress.current ||
      !storageReady ||
      !userId
    ) {
      return;
    }

    requestInProgress.current = true;

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
      saveConversation(chatId, [
        ...history,
        {
          role: "assistant",
          content: `I couldn't complete that request. ${getErrorMessage(error)}`,
          isError: true,
        },
      ]);
    } finally {
      requestInProgress.current = false;
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  // Retry a failed assistant response.
  async function retryMessage(index: number) {
    if (
      requestInProgress.current ||
      !activeChatId
    ) {
      return;
    }

    const history = messages.slice(0, index);

    if (history.at(-1)?.role !== "user") return;

    requestInProgress.current = true;

    setLoading(true);
    saveConversation(activeChatId, history);

    try {
      const answer = await getAnswer(history);

      saveConversation(activeChatId, [
        ...history,
        { role: "assistant", content: answer },
      ]);
    } catch (error) {
      saveConversation(activeChatId, [
        ...history,
        {
          role: "assistant",
          content: `I couldn't complete that request. ${getErrorMessage(error)}`,
          isError: true,
        },
      ]);
    } finally {
      requestInProgress.current = false;
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  // Copy an assistant response.
  async function copyMessage(content: string, index: number) {
    try {
      await navigator.clipboard.writeText(content);

      setCopiedIndex(index);

      window.setTimeout(() => {
        setCopiedIndex((current) =>
          current === index ? null : current
        );
      }, 1500);
    } catch {
      console.error("Clipboard access was blocked.");
    }
  }

  // Start a blank conversation.
  function startNewChat() {
    if (requestInProgress.current) return;

    setActiveChatId(null);
    setMessages([]);
    setInput("");
    setHistoryOpen(false);
    setHistorySearch("");
    setRenamingChatId(null);

    inputRef.current?.focus();
  }

  // Open a saved conversation.
  function openConversation(chat: Conversation) {
    if (requestInProgress.current) return;

    setActiveChatId(chat.id);
    setMessages(chat.messages);
    setInput("");
    setHistoryOpen(false);
    setRenamingChatId(null);

    inputRef.current?.focus();
  }

  // Delete a saved conversation.
  function deleteConversation(chatId: string) {
    if (requestInProgress.current) return;

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

  // Begin editing a conversation title.
  function beginRename(chat: Conversation) {
    if (requestInProgress.current) return;

    setRenamingChatId(chat.id);
    setRenameValue(chat.title);
  }

  // Save an edited conversation title.
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
              disabled={loading}
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
                          onClick={() => {
                            setRenamingChatId(null);
                            setRenameValue("");
                          }}
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
                            disabled={loading}
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
                            disabled={loading}
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
            maxLength={MAX_MESSAGE_LENGTH}
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
