"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

type Message = {
  role: "user" | "assistant";
  content: string;
  isError?: boolean;
};

const WORKER_URL = "https://krazy.ebramw2013.workers.dev";

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function getAnswer(history: Message[]): Promise<string> {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: history.map(({ role, content }) => ({ role, content })),
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status}).`);
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

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const history: Message[] = [
      ...messages,
      { role: "user", content: text },
    ];

    setMessages(history);
    setInput("");
    setLoading(true);

    try {
      const answer = await getAnswer(history);
      setMessages([...history, { role: "assistant", content: answer }]);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "An unexpected error occurred.";

      setMessages([
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
    if (loading) return;

    const history = messages.slice(0, index);
    if (history.at(-1)?.role !== "user") return;

    setMessages(history);
    setLoading(true);

    try {
      const answer = await getAnswer(history);
      setMessages([...history, { role: "assistant", content: answer }]);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "An unexpected error occurred.";

      setMessages([
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
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
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
          <span>Krazy <span className={styles.brandAccent}>AI</span></span>
        </a>

        <button
          className={styles.newChat}
          onClick={startNewChat}
          disabled={loading}
          type="button"
        >
          <span aria-hidden="true">＋</span> New chat
        </button>
      </header>

      <section className={styles.chat} aria-label="Chat conversation">
        {messages.length === 0 ? (
          <div className={styles.welcome}>
            <div className={styles.welcomeLogo}>K</div>
            <p className={styles.eyebrow}>YOUR AI ASSISTANT</p>
            <h1>What can I help you <span>explore?</span></h1>
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
                    {message.content}
                  </div>

                  {message.role === "assistant" && (
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
            disabled={loading || !input.trim()}
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
