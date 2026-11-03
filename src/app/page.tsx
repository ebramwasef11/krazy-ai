
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const REQUEST_TIMEOUT = 90000;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_CONVERSATIONS = 100;

function createId(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function getTitle(messages: Message[]): string {
  const first = messages.find((message) => message.role === "user");
  if (!first) return "New chat";

  const title = first.content.replace(/\s+/g, " ").trim();
  return title.length > 42 ? `${title.slice(0, 42)}…` : title;
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
            ["user", "assistant"].includes((message as Message).role) &&
            typeof (message as Message).content === "string"
        ),
      }))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() -
          new Date(a.updatedAt).getTime()
      )
      .slice(0, MAX_CONVERSATIONS);
  } catch {
    return [];
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred. Please try again.";
}

function extractChunk(parsed: Record<string, unknown>): string {
  const choices = parsed.choices as
    | Array<Record<string, unknown>>
    | undefined;

  const choice = choices?.[0];
  const delta = choice?.delta as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;

  const candidates = [
    delta?.content,
    message?.content,
    choice?.text,
    parsed.response,
    parsed.output_text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;

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

      if (combined) return combined;
    }
  }

  return "";
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [hasReceivedFirstChunk, setHasReceivedFirstChunk] = useState(false);

  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [historySearch, setHistorySearch] = useState("");

  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [storageReady, setStorageReady] = useState(false);
  const [userId, setUserId] = useState("");

  const requestInProgress = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  // Load conversations and the persistent browser user ID.
  useEffect(() => {
    try {
      let savedUserId = window.localStorage.getItem(USER_ID_KEY);

      if (!savedUserId) {
        savedUserId = createId("user");
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

  // Save chat history locally.
  useEffect(() => {
    if (!storageReady) return;

    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(conversations.slice(0, MAX_CONVERSATIONS))
      );
    } catch (error) {
      console.error("Could not save Krazy AI chats:", error);
    }
  }, [conversations, storageReady]);

  // Keep the newest message visible.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: streaming ? "auto" : "smooth",
      block: "end",
    });
  }, [messages, loading, streaming]);

  // Focus the rename field.
  useEffect(() => {
    if (renamingChatId) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renamingChatId]);

  // Automatically resize the composer.
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  // Search titles and message contents.
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

  // Update the current conversation and its saved history.
  const saveConversation = useCallback(
    (chatId: string, nextMessages: Message[]) => {
      setMessages(nextMessages);

      if (nextMessages.length === 0) return;

      setConversations((previous) => {
        const existing = previous.find((chat) => chat.id === chatId);

        const conversation: Conversation = {
          id: chatId,
          title: existing?.title || getTitle(nextMessages),
          messages: nextMessages,
          updatedAt: new Date().toISOString(),
        };

        return [
          conversation,
          ...previous.filter((chat) => chat.id !== chatId),
        ].slice(0, MAX_CONVERSATIONS);
      });
    },
    []
  );

  // Read the response stream from the Cloudflare Worker.
  async function getAnswer(
    history: Message[],
    onChunk: (fullText: string) => void
  ): Promise<string> {
    const controller = new AbortController();

    const timeout = window.setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT
    );

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          userId,
          stream: true,
          messages: history
            .slice(-MAX_HISTORY_MESSAGES)
            .map(({ role, content }) => ({ role, content })),
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));

        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `The server returned error ${response.status}.`
        );
      }

      if (!response.body) {
        throw new Error("The server did not provide a response stream.");
      }

      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";

      function processEvent(event: string) {
        const dataLines = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        for (const dataLine of dataLines) {
          if (!dataLine || dataLine === "[DONE]") continue;

          let parsed: Record<string, unknown>;

          try {
            parsed = JSON.parse(dataLine);
          } catch {
            continue;
          }

          if (parsed.error) {
            throw new Error(
              typeof parsed.error === "string"
                ? parsed.error
                : "The AI stream returned an error."
            );
          }

          const chunk = extractChunk(parsed);

          if (chunk) {
            answer += chunk;
            onChunk(answer);
          }
        }
      }

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";

        for (const event of events) {
          processEvent(event);
        }
      }

      buffer += decoder.decode();

      if (buffer.trim()) {
        processEvent(buffer);
      }

      if (!answer.trim()) {
        throw new Error(
          "Krazy AI returned an empty response. Please try again."
        );
      }

      return answer.trim();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("The request took too long. Please try again.");
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
      if (reader) {
        void reader.cancel().catch(() => undefined);
      }

      window.clearTimeout(timeout);
    }
  }

  // Reset the response status.
  function resetRequestState() {
    requestInProgress.current = false;
    setLoading(false);
    setStreaming(false);
    setHasReceivedFirstChunk(false);
    inputRef.current?.focus();
  }

  // Send a new message.
  async function sendMessage() {
    const text = input.trim();

    if (
      !text ||
      text.length > MAX_MESSAGE_LENGTH ||
      requestInProgress.current ||
      !storageReady ||
      !userId
    ) {
      return;
    }

    requestInProgress.current = true;

    const chatId = activeChatId ?? createId("chat");

    const history: Message[] = [
      ...messages,
      { role: "user", content: text },
    ];

    setActiveChatId(chatId);
    setInput("");
    setLoading(true);
    setStreaming(false);
    setHasReceivedFirstChunk(false);

    saveConversation(chatId, [
      ...history,
      { role: "assistant", content: "" },
    ]);

    try {
      const answer = await getAnswer(history, (fullText) => {
        if (!requestInProgress.current) return;

        setStreaming(true);
        setHasReceivedFirstChunk(true);

        saveConversation(chatId, [
          ...history,
          { role: "assistant", content: fullText },
        ]);
      });

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
      resetRequestState();
    }
  }

  // Retry a failed assistant response.
  async function retryMessage(index: number) {
    if (requestInProgress.current || !activeChatId) return;

    const history = messages.slice(0, index);

    if (history.at(-1)?.role !== "user") return;

    requestInProgress.current = true;

    const chatId = activeChatId;

    setLoading(true);
    setStreaming(false);
    setHasReceivedFirstChunk(false);

    saveConversation(chatId, [
      ...history,
      { role: "assistant", content: "" },
    ]);

    try {
      const answer = await getAnswer(history, (fullText) => {
        if (!requestInProgress.current) return;

        setStreaming(true);
        setHasReceivedFirstChunk(true);

        saveConversation(chatId, [
          ...history,
          { role: "assistant", content: fullText },
        ]);
      });

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
      resetRequestState();
    }
  }

  // Copy a response.
  async function copyMessage(content: string, index: number) {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);

      window.setTimeout(() => {
        setCopiedIndex((current) => current === index ? null : current);
      }, 1500);
    } catch {
      console.error("Clipboard access was blocked.");
    }
  }

  // Start a fresh conversation.
  function startNewChat() {
    if (requestInProgress.current) return;

    setActiveChatId(null);
    setMessages([]);
    setInput("");
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
    setRenamingChatId(null);
    inputRef.current?.focus();
  }

  // Delete a conversation.
  function deleteConversation(chatId: string) {
    if (requestInProgress.current) return;

    setConversations((previous) =>
      previous.filter((chat) => chat.id !== chatId)
    );

    if (activeChatId === chatId) {
      setActiveChatId(null);
      setMessages([]);
    }

    if (renamingChatId === chatId) {
      setRenamingChatId(null);
    }
  }

  // Rename a conversation.
  function beginRename(chat: Conversation) {
    if (requestInProgress.current) return;

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
          chat.id === chatId ? { ...chat, title } : chat
        )
      );
    }

    setRenamingChatId(null);
    setRenameValue("");
  }

  // Use a suggested prompt.
  function useSuggestion(prompt: string) {
    if (loading) return;

    setInput(prompt);
    inputRef.current?.focus();
  }

  // Enter sends; Shift+Enter creates a new line.
  function handleComposerKeyDown(
    event: React.KeyboardEvent<HTMLTextAreaElement>
  ) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const canSend =
    input.trim().length > 0 &&
    input.length <= MAX_MESSAGE_LENGTH &&
    !loading &&
    storageReady &&
    Boolean(userId);

  return (
    <main className={styles.app}>
      <aside className={styles.sidebar} aria-label="Main sidebar">
        <a
          className={styles.sidebarBrand}
          href="/"
          onClick={(event) => {
            event.preventDefault();
            startNewChat();
          }}
          aria-label="Krazy AI home"
        >
          <span className={styles.sidebarLogo}>K</span>
          <span>
            Krazy <span className={styles.sidebarBrandAccent}>AI</span>
          </span>
        </a>

        <button
          className={styles.sidebarNewChat}
          type="button"
          onClick={startNewChat}
          disabled={loading || !storageReady}
        >
          <span aria-hidden="true">＋</span>
          New Chat
        </button>

        <input
          className={styles.sidebarSearch}
          type="search"
          value={historySearch}
          onChange={(event) => setHistorySearch(event.target.value)}
          placeholder="Search chats..."
          aria-label="Search conversations"
        />

        <h2 className={styles.sidebarSectionTitle}>Your Chats</h2>

        <div className={styles.sidebarHistory}>
          {!storageReady ? (
            <p className={styles.emptyHistory}>Loading chats...</p>
          ) : filteredConversations.length === 0 ? (
            <p className={styles.emptyHistory}>
              {historySearch
                ? "No matching chats."
                : "Your conversations will appear here."}
            </p>
          ) : (
            filteredConversations.map((chat) => (
              <div
                className={`${styles.sidebarChat} ${
                  chat.id === activeChatId ? styles.active : ""
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
                      onChange={(event) => setRenameValue(event.target.value)}
                      maxLength={60}
                      aria-label="New conversation name"
                    />

                    <button type="submit" title="Save" aria-label="Save name">
                      ✓
                    </button>

                    <button
                      type="button"
                      title="Cancel"
                      aria-label="Cancel rename"
                      onClick={() => {
                        setRenamingChatId(null);
                        setRenameValue("");
                      }}
                    >
                      ×
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className={styles.sidebarChatOpen}
                      type="button"
                      onClick={() => openConversation(chat)}
                      title={chat.title}
                    >
                      <strong>{chat.title}</strong>
                    </button>

                    <div className={styles.sidebarChatTools}>
                      <button
                        type="button"
                        onClick={() => beginRename(chat)}
                        disabled={loading}
                        title="Rename chat"
                        aria-label={`Rename ${chat.title}`}
                      >
                        ✎
                      </button>

                      <button
                        type="button"
                        onClick={() => deleteConversation(chat.id)}
                        disabled={loading}
                        title="Delete chat"
                        aria-label={`Delete ${chat.title}`}
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

        <div className={styles.sidebarBottom}>
          <p className={styles.sidebarStorage}>
            Chats are saved in this browser on this device.
          </p>
        </div>
      </aside>

      <div className={styles.mainContent}>
        <section className={styles.chat} aria-label="Chat conversation">
          {messages.length === 0 ? (
            <div className={styles.welcome}>
              <div className={styles.welcomeLogo}>K</div>

              <p className={styles.eyebrow}>WELCOME TO KRAZY AI</p>

              <h1 className={styles.welcomeTitle}>
                THINK BIGGER.
                <br />
                <span>GO KRAZY.</span>
              </h1>

              <p className={styles.subtitle}>
                Your ideas have no limits. Let's make something happen.
              </p>

              <button
                type="button"
                className={styles.welcomePrompt}
                onClick={() => inputRef.current?.focus()}
              >
                <span>Ask Krazy AI anything...</span>
                <span className={styles.promptArrow}>↓</span>
              </button>

              <p className={styles.suggestionHeading}>GET STARTED WITH</p>

              <div className={styles.suggestions}>
                {[
                  {
                    title: "Build something",
                    prompt: "Help me plan and build something awesome.",
                    symbol: "＋",
                  },
                  {
                    title: "Brainstorm ideas",
                    prompt: "Help me brainstorm creative and original ideas.",
                    symbol: "✳",
                  },
                  {
                    title: "Learn something",
                    prompt: "Teach me something interesting and explain it clearly.",
                    symbol: "⌘",
                  },
                  {
                    title: "Create something",
                    prompt: "Help me create something from scratch.",
                    symbol: "✦",
                  },
                ].map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    className={styles.suggestion}
                    onClick={() => useSuggestion(item.prompt)}
                  >
                    <span className={styles.suggestionIcon}>{item.symbol}</span>
                    <span className={styles.suggestionText}>
                      <strong>{item.title}</strong>
                    </span>
                    <span className={styles.suggestionArrow} aria-hidden="true">
                      ↗
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.messages}>
              {messages.map((message, index) => {
                if (
                  message.role === "assistant" &&
                  !message.content &&
                  loading
                ) {
                  return null;
                }

                return (
                <article
                  key={`${index}-${message.role}`}
                  className={`${styles.message} ${
                    message.role === "user"
                      ? styles.userMessage
                      : styles.assistantMessage
                  }`}
                >
                  {message.role === "assistant" && (
                    <div className={styles.avatar}>
                      <img src="/icon.png" alt="KRAZY AI" />
                    </div>
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
                      {message.content ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </ReactMarkdown>
                      ) : loading && index === messages.length - 1 ? (
                        <span className={styles.thinkingText}>
                          Preparing your response...
                        </span>
                      ) : null}

                      {streaming &&
                        message.role === "assistant" &&
                        index === messages.length - 1 && (
                          <span className={styles.streamingCursor}>▍</span>
                        )}
                    </div>

                    {message.role === "assistant" && message.content && (
                      <div className={styles.messageActions}>
                        {!message.isError && (
                          <button
                            type="button"
                            onClick={() => void copyMessage(message.content, index)}
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
              );
              })}

              {loading && !hasReceivedFirstChunk && (
                <div className={styles.thinking}>
                  <div className={styles.avatar}>
                    <img src="/icon.png" alt="KRAZY AI" />
                  </div>

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
              onKeyDown={handleComposerKeyDown}
              placeholder="Message KRAZY AI..."
              aria-label="Message Krazy AI"
              rows={1}
              maxLength={MAX_MESSAGE_LENGTH}
              disabled={loading || !storageReady}
            />

            <button
              className={styles.sendButton}
              type="submit"
              disabled={!canSend}
              aria-label="Send message"
              title="Send message"
            >
              {loading ? "…" : "↑"}
            </button>
          </form>

          <div className={styles.disclaimer}>
            <span>
              {input.length}/{MAX_MESSAGE_LENGTH}
            </span>
            <span>Enter to send · Shift + Enter for a new line</span>
            <span>Krazy AI can make mistakes. Check important information.</span>
          </div>
        </footer>
      </div>
    </main>
  );
}
